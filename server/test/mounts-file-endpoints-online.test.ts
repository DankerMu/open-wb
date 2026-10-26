/**
 * s1b-workspace-mounts tasks 9.2 / 9.2b (#1696): the online side of workspace-mounts「挂载目录内的文件端点」
 * (the supported operations through the adapter, scenario「挂载内短读即中断」) and of「宿主不同步进入挂载」
 * (scenarios「挂起的挂载不阻塞别处」「闸门排队与期限」at the endpoint layer) — on the whole mount
 * (`mounts-file-endpoints-helpers.ts`). The adapter's file system is the manager's `mountFs` option, a
 * recording pass-through to `fs/promises` (`createSeam`) that can hang a mount for good or report a
 * stale `fstat` size; deadlines run on the world's fake clock. Every `node:fs` / `node:fs/promises` call
 * made through the module objects is recorded too, so "nothing synchronous went into the mount" is a
 * filter on the recorder.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ask,
  createSeam,
  type FileWorld,
  fileAudits,
  isUnder,
  OFFLINE,
  openFileWorld,
  outcome,
  put,
  q,
  type Seam,
} from "./mounts-file-endpoints-helpers.js";
import { alive, disposeWorlds, quiet, W1, W2, waitFor } from "./mounts-manager-helpers.js";
import { CASE_MS, closeApps, mountsUrl, send } from "./mounts-rest-helpers.js";
import { ZIP_THREE_RECORDS, zipArchive } from "./workspaces-archive-helpers.js";

/** Every `node:fs` / `node:fs/promises` call made through the module objects, by first argument. */
const fsCalls = vi.hoisted(() => [] as Array<{ name: string; path: string }>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (prefix: string, source: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(source).map(([name, value]) => [
        name,
        typeof value !== "function"
          ? value
          : new Proxy(value, {
              apply(target, self, args) {
                fsCalls.push({ name: `${prefix}${name}`, path: String(args[0]) });
                return Reflect.apply(target, self, args);
              },
            }),
      ]),
    );
  return {
    ...record("", actual),
    promises: record("promises.", actual.promises as Record<string, unknown>),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value !== "function"
        ? value
        : new Proxy(value, {
            apply(target, self, args) {
              fsCalls.push({ name: `promises.${name}`, path: String(args[0]) });
              return Reflect.apply(target, self, args);
            },
          }),
    ]),
  );
});

const unlocked: string[] = [];

beforeEach(() => {
  fsCalls.length = 0;
});

afterEach(async () => {
  for (const path of unlocked.splice(0)) {
    chmodSync(path, 0o700);
  }
  await closeApps();
  await disposeWorlds();
});

/** Recorded synchronous calls at `point` or below it. */
const syncInto = (point: string) =>
  fsCalls.filter((call) => isUnder(call.path, point) && !call.name.startsWith("promises."));

/** The seam's opens and closes so far (every handle a route opened is closed through it). */
const handles = (seam: Seam, point: string) => {
  const ops = seam.under(point).map((call) => call.op);
  return {
    opened: ops.filter((op) => op === "open").length,
    closed: ops.filter((op) => op === "close").length,
  };
};

/** The mount's status as `GET …/mounts` reports it. */
async function statusOf(fw: FileWorld, name: string): Promise<string> {
  const response = await send(fw.rest, "member", "GET", mountsUrl(W1));
  const views = (response.json() as { mounts: Array<{ name: string; status: string }> }).mounts;
  return String(views.find((view) => view.name === name)?.status);
}

describe("挂载目录内的文件端点: the supported operations on an online mount go through the adapter", () => {
  it("tree, file (sniffed text, Range, 416, HEAD), download and archive: right answers, every call on the seam, nothing synchronous in the mount", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    const clip = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
    put(fw.root, "远端/notes.md", "hello mount\n");
    put(fw.root, "远端/README", "plain words\n");
    put(fw.root, "远端/clip.mp4", clip);
    put(fw.root, "远端/sub/inner.txt", "inner\n");
    put(fw.root, "远端/x.zip", zipArchive(ZIP_THREE_RECORDS));
    fsCalls.length = 0;
    const { app } = fw.rest;
    const cookie = fw.rest.cookies.member;

    const tree = await ask(fw, "GET", `tree?${q("远端")}`);
    expect(tree.statusCode, tree.body).toBe(200);
    expect(
      (tree.json() as { entries: Array<{ name: string; type: string; size: number }> }).entries.map(
        ({ name, type, size }) => [name, type, type === "file" ? size : null],
      ),
    ).toEqual([
      ["sub", "dir", null],
      ["README", "file", 12],
      ["clip.mp4", "file", 100],
      ["notes.md", "file", 12],
      ["x.zip", "file", zipArchive(ZIP_THREE_RECORDS).length],
    ]);
    const sub = await ask(fw, "GET", `tree?${q("./远端/sub")}`);
    expect(sub.json()).toEqual({
      path: "./远端/sub",
      entries: [expect.objectContaining({ name: "inner.txt", type: "file", size: 6 })],
    });

    const notes = await ask(fw, "GET", `file?${q("远端/notes.md")}`);
    expect([notes.statusCode, notes.body, notes.headers["content-type"]]).toEqual([
      200,
      "hello mount\n",
      "text/plain; charset=utf-8",
    ]);
    const readme = await ask(fw, "GET", `file?${q("远端/README")}`);
    expect([readme.statusCode, readme.body]).toEqual([200, "plain words\n"]);
    const ranged = await app.inject({
      method: "GET",
      url: `/api/workspaces/${W1}/file?${q("远端/clip.mp4")}`,
      headers: { cookie, range: "bytes=10-19" },
    });
    expect([
      ranged.statusCode,
      ranged.headers["content-range"],
      ranged.headers["content-length"],
    ]).toEqual([206, "bytes 10-19/100", "10"]);
    expect(ranged.rawPayload).toEqual(clip.subarray(10, 20));
    const unsatisfiable = await app.inject({
      method: "GET",
      url: `/api/workspaces/${W1}/file?${q("远端/clip.mp4")}`,
      headers: { cookie, range: "bytes=200-" },
    });
    expect([unsatisfiable.statusCode, unsatisfiable.headers["content-range"]]).toEqual([
      416,
      "bytes */100",
    ]);
    const head = await app.inject({
      method: "HEAD",
      url: `/api/workspaces/${W1}/file?${q("远端/clip.mp4")}`,
      headers: { cookie },
    });
    expect([head.statusCode, head.headers["content-length"], head.body]).toEqual([200, "100", ""]);

    const download = await ask(fw, "GET", `download?${q("远端/notes.md")}`);
    expect([download.statusCode, download.body, download.headers["content-length"]]).toEqual([
      200,
      "hello mount\n",
      "12",
    ]);
    const listing = await ask(fw, "GET", `archive?${q("远端/x.zip")}`);
    expect([listing.statusCode, listing.json()]).toEqual([
      200,
      {
        format: "zip",
        entries: [
          { path: "a.txt", type: "file", size: 5 },
          { path: "dir/", type: "dir", size: 0 },
          { path: "dir/b.md", type: "file", size: 7 },
        ],
        truncated: false,
      },
    ]);

    for (const [url, expected] of [
      [`file?${q("远端/missing.md")}`, [404, "not_found"]],
      [`file?${q("远端/sub")}`, [404, "not_found"]],
      [`tree?${q("远端/notes.md")}`, [404, "not_found"]],
      [`download?${q("远端/missing.md")}`, [404, "not_found"]],
      [`archive?${q("远端")}`, [404, "not_found"]],
      [`archive?${q("远端/notes.md")}`, [415, "preview_unsupported"]],
    ] as const) {
      expect([url, ...outcome(await ask(fw, "GET", url))]).toEqual([url, ...expected]);
    }

    expect(fileAudits(fw)).toEqual([["file.download", "下载 远端/notes.md"]]);
    await waitFor(() => handles(seam, point).closed === handles(seam, point).opened);
    // notes.md, README, clip.mp4 three times (206, 416, HEAD), the download and x.zip.
    expect(handles(seam, point).opened).toBe(7);
    expect(new Set(seam.under(point).map((call) => call.op))).toEqual(
      new Set(["lstat", "readdir", "open", "fstat", "read", "close"]),
    );
    expect(syncInto(point)).toEqual([]);
  });

  it("dirs makes the one level with exactly one adapter mkdir: no chmod, no ensureSharedDir, nothing synchronous in the mount", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    fsCalls.length = 0;

    const made = await ask(fw, "POST", "dirs", { path: "远端/新" });
    const synchronous = syncInto(point);
    expect([made.statusCode, made.json()]).toEqual([201, { path: "远端/新" }]);
    expect(synchronous).toEqual([]);
    expect(statSync(join(point, "新")).isDirectory()).toBe(true);
    expect(seam.under(point).filter((call) => call.op === "mkdir")).toEqual([
      { op: "mkdir", path: join(point, "新") },
    ]);
    expect(fsCalls.filter((call) => call.name.toLowerCase().includes("chmod"))).toEqual([]);
    expect(fileAudits(fw)).toEqual([["dir.create", "新建目录 远端/新"]]);
    fsCalls.length = 0;

    expect(outcome(await ask(fw, "POST", "dirs", { path: "远端/新" }))).toEqual([409, "conflict"]);
    expect(outcome(await ask(fw, "POST", "dirs", { path: "远端/无/新" }))).toEqual([
      404,
      "not_found",
    ]);
    expect(syncInto(point)).toEqual([]);
    expect(seam.under(point).filter((call) => call.op === "mkdir")).toHaveLength(3);
    expect(existsSync(join(point, "无"))).toBe(false);
    expect(fileAudits(fw)).toEqual([["dir.create", "新建目录 远端/新"]]);
  });
});

interface Fetched {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** Whether the message arrived whole; false when the connection was cut. */
  complete: boolean;
}

/** One request over a real socket; resolves when the response closes, however it ends. */
function fetchRaw(origin: string, path: string, headers: Record<string, string>): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const request = httpGet(`${origin}${path}`, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", () => undefined);
      response.on("close", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
          complete: response.complete,
        }),
      );
    });
    request.on("error", reject);
  });
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("挂载目录内的文件端点「挂载内短读即中断」", () => {
  it("fstat says 1000, EOF comes at 400: download and file (Range) send 1000-byte headers, 400 bytes, then the connection is cut; one file.download row", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    put(fw.root, "远端/a.bin", "a".repeat(400));
    put(fw.root, "远端/a.mp4", Buffer.alloc(400, 7));
    seam.staleSize(join(point, "a.bin"), 1000);
    seam.staleSize(join(point, "a.mp4"), 1000);
    const origin = await listen(fw.rest.app);
    const cookie = fw.rest.cookies.member;
    const url = (route: string, path: string) => `/api/workspaces/${W1}/${route}?${q(path)}`;

    const download = await fetchRaw(origin, url("download", "远端/a.bin"), { cookie });
    const file = await fetchRaw(origin, url("file", "远端/a.bin"), {
      cookie,
      range: "bytes=0-999",
    });
    const video = await fetchRaw(origin, url("file", "远端/a.mp4"), {
      cookie,
      range: "bytes=0-999",
    });

    expect([
      download.status,
      download.headers["content-length"],
      download.body.length,
      download.complete,
    ]).toEqual([200, "1000", 400, false]);
    expect(download.body.toString("latin1")).toBe("a".repeat(400));
    // An unknown extension sniffed as text: no Range, the whole of what fstat reported.
    expect([file.status, file.headers["content-length"], file.body.length, file.complete]).toEqual([
      200,
      "1000",
      400,
      false,
    ]);
    expect([
      video.status,
      video.headers["content-range"],
      video.headers["content-length"],
      video.body.length,
      video.complete,
    ]).toEqual([206, "bytes 0-999/1000", "1000", 400, false]);
    expect(fileAudits(fw)).toEqual([["file.download", "下载 远端/a.bin"]]);
    await waitFor(() => handles(seam, point).closed === 3);
    expect(handles(seam, point)).toEqual({ opened: 3, closed: 3 });
  });
});

describe("挂载目录内的文件端点: a read past the deadline", () => {
  it("download whose read never returns: 409 mount_offline at the deadline, and the handle the adapter can no longer close is closed directly", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    put(fw.root, "远端/big.bin", Buffer.alloc(4096, 1));
    seam.hang(point, ["read"]);

    const pending = ask(fw, "GET", `download?${q("远端/big.bin")}`);
    await waitFor(() => seam.under(point).some((call) => call.op === "read"));
    fw.world.clock.advance(10_000);
    const response = await pending;

    expect(outcome(response)).toEqual(OFFLINE);
    // An error envelope, not an attachment: none of the download's headers survive.
    expect([
      response.headers["content-type"],
      response.headers["content-disposition"],
      response.headers["content-length"],
    ]).toEqual(["application/json; charset=utf-8", undefined, String(response.rawPayload.length)]);
    // Opened, audited, the one read hung; the close never went through the stuck gate.
    await waitFor(() => handles(seam, point).closed === 1);
    expect(seam.under(point).map((call) => call.op)).toEqual([
      "lstat",
      "open",
      "fstat",
      "read",
      "close",
    ]);
    expect(fileAudits(fw)).toEqual([["file.download", "下载 远端/big.bin"]]);
    expect(await statusOf(fw, "远端")).toBe("offline");
  });
});

describe("宿主不同步进入挂载", () => {
  it.skipIf(process.getuid?.() === 0)(
    "挂起的挂载不阻塞别处: a never-answering mount (point mode 0000, 1 s deadline) holds only its own request; then offline, SIGKILL, one -uz, remount on backoff",
    { timeout: CASE_MS },
    async () => {
      const seam = createSeam();
      const fw = await openFileWorld({
        // `@stubborn`: the fake rclone ignores SIGTERM, so its death is the SIGKILL.
        online: [{ name: "远端", remotePath: "/srv/data@stubborn" }],
        overrides: { mountFs: seam.impl, mountFsDeadlineMs: 1000 },
      });
      const { world } = fw;
      const point = fw.point("远端");
      seam.hang(point);
      chmodSync(point, 0o000);
      unlocked.push(point);
      fsCalls.length = 0;

      let settled = false;
      const hung = ask(fw, "GET", `tree?${q("远端/sub")}`).then((response) => {
        settled = true;
        return response;
      });
      await waitFor(() => seam.under(point).length === 1);
      const rootA = await ask(fw, "GET", "tree");
      const rootB = await ask(fw, "GET", "tree", undefined, W2);
      expect([rootA.statusCode, rootB.statusCode, settled]).toEqual([200, 200, false]);
      world.clock.advance(999);
      await quiet(100);
      expect(settled).toBe(false);
      world.clock.advance(1);

      expect(outcome(await hung)).toEqual(OFFLINE);
      expect(await statusOf(fw, "远端")).toBe("offline");
      expect(seam.under(point)).toEqual([{ op: "lstat", path: join(point, "sub") }]);
      expect(syncInto(point)).toEqual([]);
      const [mounted] = world.mountCalls();
      await waitFor(() => world.fusermountCalls().length === 1 && !alive(mounted?.pid ?? 0));
      expect(world.fusermountCalls()).toEqual([{ argv: ["-uz", point], removed: 1 }]);
      await waitFor(() => JSON.stringify(world.clock.pending()) === "[5000]");

      chmodSync(point, 0o700);
      world.clock.advance(5000);
      await waitFor(() => world.mountCalls().length === 2);
      for (let tries = 0; (await statusOf(fw, "远端")) !== "online"; tries += 1) {
        expect(tries).toBeLessThan(200);
        await quiet(50);
      }
    },
  );

  it("闸门排队与期限: two requests queued behind a hung call end 409 mount_offline with it at the 10 s deadline; the seam never has two calls in that mount; another mount answers meanwhile", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }, { name: "共享" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    put(fw.root, "远端/a.md", "a\n");
    put(fw.root, "共享/b.md", "b\n");
    seam.hang(point);

    const answers: Array<[number, string]> = [];
    const pending = [
      ask(fw, "GET", `tree?${q("远端")}`),
      ask(fw, "GET", `file?${q("远端/a.md")}`),
      ask(fw, "GET", `download?${q("远端/a.md")}`),
    ].map((request) => request.then((response) => answers.push(outcome(response))));
    await waitFor(() => seam.under(point).length === 1);
    await quiet(200);
    expect(seam.under(point)).toHaveLength(1);
    const other = await ask(fw, "GET", `tree?${q("共享")}`);
    expect([other.statusCode, other.json().entries.map((e: { name: string }) => e.name)]).toEqual([
      200,
      ["b.md"],
    ]);

    fw.world.clock.advance(9999);
    await quiet(100);
    expect(answers).toEqual([]);
    fw.world.clock.advance(1);
    await Promise.all(pending);

    expect(answers).toEqual([OFFLINE, OFFLINE, OFFLINE]);
    expect(seam.under(point)).toEqual([{ op: "lstat", path: point }]);
    expect(await statusOf(fw, "远端")).toBe("offline");
    expect(await statusOf(fw, "共享")).toBe("online");
    expect(fileAudits(fw)).toEqual([]);
  });
});
