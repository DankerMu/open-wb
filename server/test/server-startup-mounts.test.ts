/**
 * 真实 compiled production 入口，挂载开启（s1b-workspace-mounts tasks 6.2 / 6.4，#1688；http-service-skeleton
 * 「挂载键与启动预检」的启动成功与 SIGTERM 两组、「服务启动与装配」的恢复与关停；workspace-mounts「服务启停与
 * 挂载」）。`RCLONE_BIN` 是假 rclone（`fixtures/fake-rclone.mjs`），PATH 上是假 `fusermount3` / `fusermount`
 * 与 `node`，`MOUNT_HOST_ALLOW=files.intra`、`MOUNT_MAX_PER_WORKSPACE=2`。入口读真实 `/proc/self/mountinfo`，
 * 假 rclone 不会出现在里面：启动恢复的那次尝试一直在等就绪（`@hang`）或立即失败（`@exit1`），所以这里实测的是
 * 「`closeAll` 杀掉还在等就绪的挂载子进程、DB 关闭之前它已退出、挂载行与私有目录仍在、退出码 0」与「恢复失败
 * 不影响 success record 与退出码」。预检要求 `/dev/fuse` 是字符设备：不是（macOS 开发机、没有 FUSE 的
 * runner）即整组明示跳过，由测试主机补跑（#1700）；文件末尾两个账号上限的非法值一组不跑预检、不跳过（#1789）。不需要 root。启动成功一例另以 HTTP 断言 `GET …/mounts` 的 `enabled` 为 true（#1690）。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  getJson,
  login,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { applicationStderr } from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const FAKE_RCLONE = fileURLToPath(new URL("./fixtures/fake-rclone.mjs", import.meta.url));
const FAKE_FUSERMOUNT = fileURLToPath(new URL("./fixtures/fake-fusermount3.mjs", import.meta.url));
const STARTUP_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
  "models",
  "experts",
  "skills",
  "connectors",
];
const OWNER = "u1";
const WORKSPACE = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
const MOUNT_ID = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const SOURCE_ID = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
const CASE_MS = 120_000;

function isCharacterDevice(path: string): boolean {
  try {
    return statSync(path).isCharacterDevice();
  } catch {
    return false;
  }
}

const FUSE = isCharacterDevice("/dev/fuse");

const scratch: string[] = [];
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
});

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Fixture {
  root: string;
  state: string;
  dbPath: string;
  env(port: number): Record<string, string>;
  /** The fake rclone's `mount` calls (it records under `<OMP_STATE_DIR>`, its `HOME` being `mounts/<id>`). */
  mountCalls(): { pid: number; argv: string[] }[];
}

/**
 * Scratch tree in the entry's geometry (`compiledFixtureEnv`): a bin directory with `node`, the fake
 * `fusermount3` and a `fusermount` copy (both preflight lookups), workspace W1 of u1 in the DB and on
 * disk, `<state>/mounts` (0700) and the fake's `<state>/fake-mountinfo`.
 */
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-startup-mounts-")));
  scratch.push(root);
  const state = join(root, "state");
  mkdirSync(join(state, "mounts"), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "fake-mountinfo"), "");
  const bin = join(root, "fakebin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  for (const name of ["fusermount3", "fusermount"]) {
    copyFileSync(FAKE_FUSERMOUNT, join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, "mountinfo.path"), join(state, "fake-mountinfo"));
  mkdirSync(join(root, "sandbox", OWNER, "w1"), { recursive: true });
  const dbPath = join(root, "db", "dev.db");
  mkdirSync(join(root, "db"));
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, 'w1', 'w1', 1)",
  ).run(WORKSPACE, OWNER);
  db.close();
  const calls = join(state, "fake-rclone-calls.jsonl");
  return {
    root,
    state,
    dbPath,
    env: (port) =>
      compiledFixtureEnv(root, port, join(root, "omp-bin", "omp"), {
        PATH: `${bin}:/usr/bin:/bin`,
        RCLONE_BIN: FAKE_RCLONE,
        MOUNT_HOST_ALLOW: "files.intra",
        MOUNT_MAX_PER_WORKSPACE: "2",
      }),
    mountCalls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as { pid: number; argv: string[] })
            .filter((call) => call.argv[1] === "mount")
        : [],
  };
}

/**
 * A `local` mount as an earlier run left it: source row (`<root>/sources/src@<marker>`, outside every
 * protected root; the marker drives the fake), mount row, private directory with its `rclone.conf`.
 */
function seedLocalMount(fx: Fixture, marker: "hang" | "exit1"): string {
  const source = join(fx.root, "sources", `src@${marker}`);
  mkdirSync(source, { recursive: true });
  const db = new DatabaseSync(fx.dbPath);
  db.prepare(
    "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, 'NAS', ?, 0, 1)",
  ).run(SOURCE_ID, source);
  db.prepare(
    "INSERT INTO workspace_mounts(id, workspace_id, owner_id, name, backend, source_id, read_only, created_at) VALUES (?, ?, ?, 'nas', 'local', ?, 0, 2)",
  ).run(MOUNT_ID, WORKSPACE, OWNER, SOURCE_ID);
  db.close();
  const dir = join(fx.state, "mounts", MOUNT_ID);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "rclone.conf"), `[m${MOUNT_ID}]\ntype = local\n`, { mode: 0o600 });
  return dir;
}

function mountRows(dbPath: string): unknown[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id, name FROM workspace_mounts").all();
  } finally {
    db.close();
  }
}

function startedLine(port: number): string {
  return `${JSON.stringify({ event: "server_started", host: "127.0.0.1", port, modules: STARTUP_MODULES })}\n`;
}

describe.skipIf(!FUSE)(
  "production entry with mounts enabled (skipped unless /dev/fuse is a character device)",
  () => {
    let compiled: CompiledServerEntry;

    beforeAll(async () => {
      compiled = await compileServerEntry();
    }, 90_000);

    it(
      "starts with the fake rclone and fusermount3: the success record as usual, modules unchanged, GET …/mounts enabled",
      async () => {
        const fx = fixture();
        const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
          env: fx.env(port),
        }));
        try {
          await server.waitForStarted();
          expect(server.stdout()).toBe(startedLine(port));
          const mounts = await getJson(
            port,
            `/api/workspaces/${WORKSPACE}/mounts`,
            await login(port),
          );
          expect(mounts.status).toBe(200);
          expect(mounts.body).toEqual({ enabled: true, mounts: [] });
          expect(applicationStderr(server.stderr())).toBe("");
          expect(await server.stop()).toBe(0);
        } finally {
          await server.dispose();
        }
      },
      CASE_MS,
    );

    it(
      "SIGTERM while the restore waits on a hanging rclone: exit 0, rclone gone before the DB closes, row and private dir kept",
      async () => {
        const fx = fixture();
        const dir = seedLocalMount(fx, "hang");
        let trace = "";
        const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => {
          trace = join(fx.root, `order-${port}.log`);
          return { env: fx.env(port), orderTrace: trace };
        });
        try {
          await server.waitForStarted();
          expect(server.stdout()).toBe(startedLine(port));
          // The restore has spawned rclone and it is waiting for readiness when the signal arrives.
          await waitFor(() => fx.mountCalls().length === 1);
          const [call] = fx.mountCalls();
          const pid = call?.pid ?? 0;
          spawned.push(pid);
          expect(call?.argv[3]).toBe(join(fx.root, "sandbox", OWNER, "w1", "nas"));
          expect(alive(pid)).toBe(true);

          expect(await server.stop()).toBe(0);
          expect(alive(pid)).toBe(false);
          const events = readFileSync(trace, "utf8").split("\n");
          expect(events).toContain("runtime-exit");
          expect(events).toContain("db-close");
          expect(events.indexOf("runtime-exit")).toBeLessThan(events.indexOf("db-close"));
          expect(mountRows(fx.dbPath)).toEqual([{ id: MOUNT_ID, name: "nas" }]);
          expect(readFileSync(join(dir, "rclone.conf"), "utf8")).toBe(
            `[m${MOUNT_ID}]\ntype = local\n`,
          );
          expect(fx.mountCalls()).toHaveLength(1);
          expect(applicationStderr(server.stderr())).toBe("");
        } finally {
          await server.dispose();
        }
      },
      CASE_MS,
    );

    it(
      "a failed restore leaves the success record and exit code alone",
      async () => {
        const fx = fixture();
        seedLocalMount(fx, "exit1");
        const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
          env: fx.env(port),
        }));
        try {
          await server.waitForStarted();
          await waitFor(() => fx.mountCalls().length >= 1);
          const pid = fx.mountCalls()[0]?.pid ?? 0;
          spawned.push(pid);
          await waitFor(() => !alive(pid));
          expect(server.stdout()).toBe(startedLine(port));
          expect(applicationStderr(server.stderr())).toBe("");
          expect(await server.stop()).toBe(0);
          expect(server.stdout()).toBe(startedLine(port));
          expect(applicationStderr(server.stderr())).toBe("");
          expect(mountRows(fx.dbPath)).toEqual([{ id: MOUNT_ID, name: "nas" }]);
        } finally {
          await server.dispose();
        }
      },
      CASE_MS,
    );
  },
);

/**
 * #1789 tasks 3.2: the two account limits through the compiled entry, feature off (no `RCLONE_BIN`, so no
 * preflight can fail first) — not gated on `/dev/fuse`. Each invalid value is a config error before any
 * DB, state or listen effect.
 */
describe("production entry refuses an invalid account mount limit", () => {
  const failed = `${JSON.stringify({ event: "server_start_failed", reason: "config" })}\n`;
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it.each([
    ["MOUNT_MAX_PER_ACCOUNT", "0"],
    ["MOUNT_MAX_ATTACHING_PER_ACCOUNT", "016"],
  ])(
    "%s=%s: nonzero, exactly the generic config record, no DB / state / sandbox",
    async (key, value) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-startup-mount-limits-")));
      scratch.push(root);
      const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "omp-bin", "omp"), { [key]: value }),
      }));
      expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(applicationStderr(server.stderr())).toBe(failed);
      for (const owned of ["db", "state", "sandbox"]) {
        expect(existsSync(join(root, owned))).toBe(false);
      }
    },
    CASE_MS,
  );
});
