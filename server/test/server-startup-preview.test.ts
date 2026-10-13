/**
 * Issue #1070：生产入口接上预览监听器、预览缓存目录与回收目录的清理（http-service-skeleton
 * 「预览监听器的装配与关停」）。每一例都跑真实的 compiled production 入口；次序由 orderTrace 预加载
 * 观察真实的 listener 绑定 / 关闭与 DB close 得出，不替换任何生产模块。
 * 信号窗口各例与「两次绑定之间」两例的证据等级：钩子辅助（预加载推迟原生 listen）、真实编译入口、
 * 真实 SIGTERM。主监听器先绑定（#1337）。
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { connect as connectTcp, type Server } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectFixedFailure, rawAnswer } from "./preview-app-helpers.js";
import {
  createSession,
  expectBindable,
  getJson,
  login,
  prompt,
  reserveWildcardPort,
  waitForFile,
  writeFakeOmpLauncher,
} from "./server-startup-helpers.js";
import {
  applicationStderr,
  expectDbReopens,
  expectLayoutWithoutManagedFiles,
  heldListenHook,
  holdPort,
  openPartialRequest,
  type PartialRequest,
} from "./server-startup-order-helpers.js";
import {
  compileEntry,
  type Entry,
  makeSandboxRoot,
  openWorkspace,
  releaseEntries,
  startEntry,
  ZHANGSAN,
} from "./server-startup-preview-helpers.js";
import { NOT_FOUND_ENVELOPE } from "./session-db-helpers.js";

const STARTUP_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
];
const FORCE_CLOSE_RECORD = `${JSON.stringify({ event: "listener_force_close" })}\n`;
const BIG_FILE_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86_400_000;

beforeAll(compileEntry, 90_000);
afterAll(releaseEntries);

function modeOf(path: string): number {
  return statSync(path).mode & 0o7777;
}

interface HeldDownload {
  status: number | undefined;
  /** 读完其余字节，返回总字节数。 */
  rest(): Promise<number>;
  destroy(): void;
}

/** 发一个 GET，读到第一块正文就停读：响应此刻在途，服务端被 TCP 背压挡住。 */
function startDownload(url: string): Promise<HeldDownload> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.on("error", () => undefined);
      response.once("data", (first: Buffer) => {
        response.pause();
        resolve({
          status: response.statusCode,
          rest: () =>
            new Promise((done, fail) => {
              let bytes = first.length;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
              });
              response.once("end", () => done(bytes));
              response.once("error", fail);
              response.resume();
            }),
          destroy: () => request.destroy(),
        });
      });
    });
    request.once("error", reject);
  });
}

/** 等到 `port` 不再接受新连接：该监听器已经开始关停。只建连接，不发请求。 */
async function waitUntilRefused(port: number): Promise<void> {
  const deadlineAt = performance.now() + 5_000;
  for (;;) {
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connectTcp({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(true);
      });
    });
    if (refused) {
      return;
    }
    if (performance.now() > deadlineAt) {
      throw new Error(`port ${port} still accepts connections`);
    }
    await delay(10);
  }
}

function writeSparse(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

describe("production entry with the preview listener", () => {
  it("binds the main listener first, prepares the cache directories and releases both ports on SIGTERM", async () => {
    const entry = await startEntry({
      prepare: (root) => {
        // 上一次运行的遗留：work 下的作业目录要清掉，pdf 下的缓存留着；mode 故意不对。
        mkdirSync(join(root, "preview-cache", "work", "stale"), { recursive: true });
        writeFileSync(join(root, "preview-cache", "work", "stale", "x"), "stale");
        mkdirSync(join(root, "preview-cache", "pdf"), { recursive: true });
        writeFileSync(join(root, "preview-cache", "pdf", "keep.pdf"), "kept");
      },
    });
    const { server, port, previewPort } = entry;
    try {
      const started = await server.waitForStarted();
      expect(server.stdout()).toBe(
        `${JSON.stringify({ event: "server_started", host: "127.0.0.1", port, modules: STARTUP_MODULES })}\n`,
      );
      expect(Object.keys(started as object)).toEqual(["event", "host", "port", "modules"]);
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\n`,
      );

      const health = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      const previewOrigin = `http://127.0.0.1:${previewPort}`;
      expectFixedFailure(await rawAnswer(previewOrigin, "/"), 404);
      expectFixedFailure(await rawAnswer(previewOrigin, "/api/healthz"), 404);

      const cache = join(entry.root, "preview-cache");
      expect(modeOf(cache)).toBe(0o2750);
      expect(modeOf(join(cache, "work"))).toBe(0o2770);
      expect(modeOf(join(cache, "pdf"))).toBe(0o700);
      expect(readdirSync(join(cache, "work"))).toEqual([]);
      expect(readFileSync(join(cache, "pdf", "keep.pdf"), "utf8")).toBe("kept");

      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
      await expectBindable("127.0.0.1", port);
      await expectBindable("127.0.0.1", previewPort);
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("binds both listeners to the configured HOST when it is the wildcard address", async () => {
    const entry = await startEntry({ env: () => ({ HOST: "0.0.0.0" }) });
    const { server, port, previewPort } = entry;
    try {
      expect(await server.waitForStarted()).toMatchObject({ host: "0.0.0.0", port });
      expect(entry.readTrace()).toBe(
        `listening:0.0.0.0:${port}\nlistening:0.0.0.0:${previewPort}\n`,
      );
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe(
        `listening:0.0.0.0:${port}\nlistening:0.0.0.0:${previewPort}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("serves a workspace file on a system-assigned preview port and audits a traversal through the shared sandbox", async () => {
    const entry = await startEntry({ previewPort: "default", prepare: makeSandboxRoot });
    const { server, port } = entry;
    try {
      const started = await server.waitForStarted();
      expect(Object.keys(started as object)).toEqual(["event", "host", "port", "modules"]);
      expect(started).toMatchObject({ port });
      const workspace = await openWorkspace(entry);
      const base = new URL(workspace.base);
      expect(base.hostname).toBe("127.0.0.1");
      expect(Number(base.port)).toBeGreaterThan(0);
      expect(Number(base.port)).not.toBe(port);
      expect(base.pathname).toMatch(/^\/w\/[0-9a-f]+\/$/u);

      writeFileSync(join(workspace.root, "文件.html"), "<p>来自工作空间</p>");
      const file = await fetch(`${workspace.base}${encodeURIComponent("文件.html")}`);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("<p>来自工作空间</p>");

      // fetch 会把 %2e%2e 段先行折叠；越界必须经真实 socket 原样送达。
      const denied = await rawAnswer(base.origin, `${base.pathname}%2e%2e/%2e%2e/x`);
      expectFixedFailure(denied, 403);
      const audit = await getJson(port, "/api/audit", workspace.cookie);
      const rejects = (
        audit.body as { events: Array<{ kind: string; actorId: string; workspaceId: string }> }
      ).events.filter((event) => event.kind === "sandbox.reject");
      expect(rejects).toEqual([
        expect.objectContaining({
          kind: "sandbox.reject",
          actorId: ZHANGSAN,
          workspaceId: workspace.id,
          detail: expect.objectContaining({ relPath: "../../x", op: "read" }),
        }),
      ]);
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("removes only the expired recycle batches once after startup, by the configured retention", async () => {
    const now = Date.now();
    const workspaceTrash = join(".trash", ZHANGSAN, "a".repeat(32));
    // 未到期批次的名字排在两个到期批次之间（位数少的时间戳排在最后）。
    const expiredFirst = `${now - 2 * DAY_MS}-${"a".repeat(16)}`;
    const fresh = `${now - DAY_MS / 2}-${"b".repeat(16)}`;
    const expiredLast = `9-${"c".repeat(16)}`;
    const entry = await startEntry({
      env: () => ({ TRASH_RETENTION_DAYS: "1" }),
      prepare: (root) => {
        const sandbox = join(root, "sandbox");
        mkdirSync(sandbox);
        let level = sandbox;
        for (const name of workspaceTrash.split("/")) {
          level = join(level, name);
          mkdirSync(level, 0o700);
        }
        for (const batch of [expiredFirst, fresh, expiredLast]) {
          mkdirSync(join(level, batch, "dir"), { recursive: true, mode: 0o700 });
          writeFileSync(join(level, batch, "dir", "f.txt"), batch);
        }
      },
    });
    const { server } = entry;
    const batches = join(entry.root, "sandbox", workspaceTrash);
    try {
      await server.waitForStarted();
      // 首扫在成功记录之后才开始，入口不等它。
      const deadlineAt = performance.now() + 10_000;
      while (existsSync(join(batches, expiredFirst)) || existsSync(join(batches, expiredLast))) {
        if (performance.now() > deadlineAt) {
          throw new Error(`expired batches still present: ${readdirSync(batches).join(",")}`);
        }
        await delay(20);
      }
      await delay(200);
      expect(readdirSync(batches)).toEqual([fresh]);
      expect(readFileSync(join(batches, fresh, "dir", "f.txt"), "utf8")).toBe(fresh);
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);
});

describe("production entry preview bind failure", () => {
  /** 入口自行以 1 退出：无 success record，stderr 恰一行带 `reason` 的失败记录。 */
  async function expectStartFailure(entry: Entry, reason: string): Promise<void> {
    try {
      expect(await entry.server.waitForClose()).toEqual({ code: 1, signal: null });
      expect(entry.server.stdout()).toBe("");
      expect(applicationStderr(entry.server.stderr())).toBe(
        `{"event":"server_start_failed","reason":"${reason}"}\n`,
      );
    } finally {
      await entry.server.dispose();
    }
  }

  async function withHeld(ports: number[], action: () => Promise<void>): Promise<void> {
    const holders: Server[] = [];
    try {
      for (const port of ports) {
        holders.push(await holdPort(port));
      }
      await action();
    } finally {
      await Promise.all(
        holders.map((holder) => new Promise((resolve) => holder.close(() => resolve(undefined)))),
      );
    }
  }

  it("fails with preview_listen and closes the already bound main listener when the preview port is taken", async () => {
    const port = await reserveWildcardPort();
    const previewPort = await reserveWildcardPort();
    let entry: Entry | undefined;
    await withHeld([previewPort], async () => {
      entry = await startEntry({ ports: { port, previewPort } });
      await expectStartFailure(entry, "preview_listen");
    });
    // 主监听器先绑定成功，预览监听器随后绑定失败（从未绑定，记 `-`）；失败清理把主监听器关掉，DB 最后。
    expect(entry?.readTrace()).toBe(
      `listening:127.0.0.1:${port}\nlistener-close:-\nlistener-close:${port}\ndb-close\n`,
    );
    await expectBindable("127.0.0.1", port);
    await expectBindable("127.0.0.1", previewPort);
    expectDbReopens(join(entry?.root ?? "", "db", "dev.db"));
    expectLayoutWithoutManagedFiles(join(entry?.root ?? "", "state"));
  }, 60_000);

  it("fails with state_layout after the main bind, never binds the preview listener and closes the main listener", async () => {
    const entry = await startEntry({
      prepare: (root) => {
        mkdirSync(join(root, "state", "home"), { recursive: true });
        writeFileSync(join(root, "state", "home", ".omp"), "not-a-directory");
      },
    });
    await expectStartFailure(entry, "state_layout");
    // 只有主监听器绑定过；预览监听器的 listen 从未被调用，失败清理把主监听器关掉，DB 最后。
    expect(entry.readTrace()).toBe(
      `listening:127.0.0.1:${entry.port}\nlistener-close:${entry.port}\ndb-close\n`,
    );
    await expectBindable("127.0.0.1", entry.port);
    await expectBindable("127.0.0.1", entry.previewPort);
    expectDbReopens(join(entry.root, "db", "dev.db"));
  }, 60_000);

  it("fails with listen when both ports are taken: the main listener is the first to bind", async () => {
    const port = await reserveWildcardPort();
    const previewPort = await reserveWildcardPort();
    let entry: Entry | undefined;
    await withHeld([previewPort, port], async () => {
      entry = await startEntry({ ports: { port, previewPort } });
      await expectStartFailure(entry, "listen");
    });
    // 主监听器绑定失败，预览监听器的 listen 从未被调用：整个进程里没有任何一个 listener 绑定成功过。
    expect(entry?.readTrace()).toBe("listener-close:-\ndb-close\n");
    expect(existsSync(join(entry?.root ?? "", "state"))).toBe(false);
  }, 60_000);

  it("fails with preview_listen when PREVIEW_PORT equals PORT: the main listener took the port first", async () => {
    const entry = await startEntry({ previewPort: "same-as-main" });
    await expectStartFailure(entry, "preview_listen");
    expect(entry.readTrace()).toBe(
      `listening:127.0.0.1:${entry.port}\nlistener-close:-\nlistener-close:${entry.port}\ndb-close\n`,
    );
    await expectBindable("127.0.0.1", entry.port);
    expectDbReopens(join(entry.root, "db", "dev.db"));
  }, 60_000);
});

describe("production entry shutdown with preview requests in flight", () => {
  it("lets an in-flight preview download finish with every byte and closes the database last", async () => {
    const entry = await startEntry({ prepare: makeSandboxRoot });
    const { server, port, previewPort } = entry;
    let download: HeldDownload | undefined;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeSparse(join(workspace.root, "big.bin"), BIG_FILE_BYTES);
      download = await startDownload(`${workspace.base}big.bin`);
      expect(download.status).toBe(200);
      const stopping = server.stop();
      // SIGTERM 之后不往预览端口发任何新请求：只确认它已停止受理，再把在途的响应读完。
      await waitUntilRefused(previewPort);
      expect(await download.rest()).toBe(BIG_FILE_BYTES);
      expect(await stopping).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      download?.destroy();
      await server.dispose();
    }
  }, 60_000);

  it("writes exactly one listener_force_close when only the preview listener is force-closed", async () => {
    const entry = await startEntry({ prepare: makeSandboxRoot });
    const { server } = entry;
    let download: HeldDownload | undefined;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeSparse(join(workspace.root, "big.bin"), BIG_FILE_BYTES);
      download = await startDownload(`${workspace.base}big.bin`);
      // 停读的客户端自己看不到连接被回收；以进程退出与那一行记录为证。
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe(FORCE_CLOSE_RECORD);
    } finally {
      download?.destroy();
      await server.dispose();
    }
  }, 60_000);

  it("writes exactly one listener_force_close when both listeners are force-closed", async () => {
    const entry = await startEntry({ prepare: makeSandboxRoot });
    const { server, port, previewPort } = entry;
    let download: HeldDownload | undefined;
    let partial: PartialRequest | undefined;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeSparse(join(workspace.root, "big.bin"), BIG_FILE_BYTES);
      download = await startDownload(`${workspace.base}big.bin`);
      partial = await openPartialRequest(port, "/api/auth/login");
      expect(await server.stop()).toBe(0);
      await partial.closed;
      expect(applicationStderr(server.stderr())).toBe(FORCE_CLOSE_RECORD);
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      download?.destroy();
      partial?.destroy();
      await server.dispose();
    }
  }, 60_000);
});

/** 两个标记文件：钩子进入被扣住的 listen 时写前者，见到后者才调原生 listen。 */
function listenGate(root: string): { LISTEN_ENTERED: string; LISTEN_RELEASE: string } {
  return {
    LISTEN_ENTERED: join(root, "listen-entered"),
    LISTEN_RELEASE: join(root, "listen-released"),
  };
}

describe("production entry SIGTERM between the two listens", () => {
  it.each([
    { nth: 1, held: "the main listener's" },
    { nth: 2, held: "the preview listener's" },
  ] as const)(
    "publishes nothing and leaves both ports and the database reusable when SIGTERM lands in $held listen",
    async ({ nth }) => {
      const entry = await startEntry({ hook: heldListenHook(nth), env: listenGate });
      const { server, port, previewPort, root } = entry;
      try {
        await waitForFile(join(root, "listen-entered"), 15_000);
        expect(existsSync(join(root, "listen-released"))).toBe(false);
        const before = entry.readTrace();
        expect(before).toBe(nth === 1 ? "" : `listening:127.0.0.1:${port}\n`);
        await server.stop();
        expect(await server.waitForClose()).toEqual({ code: 0, signal: null });
        expect(existsSync(join(root, "listen-released"))).toBe(true);
        expect(server.stdout()).toBe("");
        expect(applicationStderr(server.stderr())).toBe("");
        // 被扣住的那个 listener 从未绑定（`-`）。主监听器被扣住时预览监听器的 listen 从未被调用；
        // 预览监听器被扣住时，已绑定的主监听器在它之后关，DB 最后。
        expect(entry.readTrace()).toBe(
          nth === 1
            ? "listener-close:-\ndb-close\n"
            : `listening:127.0.0.1:${port}\nlistener-close:-\nlistener-close:${port}\ndb-close\n`,
        );
        await expectBindable("127.0.0.1", port);
        await expectBindable("127.0.0.1", previewPort);
        expectDbReopens(join(root, "db", "dev.db"));
        // 主绑定在途时到达的信号不建托管布局；主绑定成功之后布局已在，两个托管文件没有写出。
        if (nth === 1) {
          expect(existsSync(join(root, "state"))).toBe(false);
        } else {
          expectLayoutWithoutManagedFiles(join(root, "state"));
        }
      } finally {
        await server.dispose();
      }
    },
    60_000,
  );
});

describe("production entry between the main bind and the preview bind", () => {
  it("closes the bound main listener after its runtime and before the database when SIGTERM lands in the preview listener's listen", async () => {
    const entry = await startEntry({
      hook: heldListenHook(2),
      env: (root) => ({ ...listenGate(root), OMP_BIN: writeFakeOmpLauncher(root, "hang-eof") }),
    });
    const { server, port, previewPort, root } = entry;
    try {
      await waitForFile(join(root, "listen-entered"), 15_000);
      expect(entry.readTrace()).toBe(`listening:127.0.0.1:${port}\n`);
      // 窗口期里主监听器已受理请求：起一个真实的 runtime 子进程，关停时它得先退出。
      const cookie = await login(port);
      const session = await createSession(port, cookie);
      await prompt(port, cookie, session, "stay-alive");
      expect(await server.stop()).toBe(0);
      // 没有 success record，也没有 failure record，也没有 `session_fault`：托管布局在主绑定成功之后、
      // 预览绑定之前已经建好，窗口里的 prompt 建得出它的快照目录。
      expect(server.stdout()).toBe("");
      expect(applicationStderr(server.stderr())).toBe("");
      expect(readdirSync(join(root, "state", "snapshots"))).toHaveLength(1);
      // 没有后到的预览绑定（没有第二行 listening）；主监听器的关闭在 runtime 退出之后、DB 之前。
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistener-close:-\nruntime-exit\nlistener-close:${port}\ndb-close\n`,
      );
      await expectBindable("127.0.0.1", port);
      await expectBindable("127.0.0.1", previewPort);
      expectDbReopens(join(root, "db", "dev.db"));
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("answers preview-token with the typed 404 while the preview listener's listen is held, then issues an address on the port it bound", async () => {
    const entry = await startEntry({
      previewPort: "default",
      hook: heldListenHook(2),
      env: listenGate,
      prepare: makeSandboxRoot,
    });
    const { server, port, root } = entry;
    const post = async (path: string, cookie: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    };
    try {
      await waitForFile(join(root, "listen-entered"), 15_000);
      expect(entry.readTrace()).toBe(`listening:127.0.0.1:${port}\n`);
      const cookie = await login(port);
      const created = await post("/api/workspaces", cookie, { name: "window", dir: "window" });
      expect(created.status).toBe(201);
      const tokenPath = `/api/workspaces/${(created.body as { id: string }).id}/preview-token`;
      expect(await post(tokenPath, cookie)).toEqual({ status: 404, body: NOT_FOUND_ENVELOPE });
      expect(server.stdout()).toBe("");

      writeFileSync(join(root, "listen-released"), "");
      expect(await server.waitForStarted()).toMatchObject({ port });
      const bound = /^listening:127\.0\.0\.1:(\d+)$/u.exec(
        entry.readTrace().split("\n")[1] ?? "",
      )?.[1];
      expect(Number(bound)).toBeGreaterThan(0);
      expect(Number(bound)).not.toBe(port);
      const issued = await post(tokenPath, cookie);
      expect(issued.status).toBe(200);
      const { token, base } = issued.body as { token: string; base: string };
      expect(base).toBe(`http://127.0.0.1:${bound}/w/${token}/`);
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);
});
