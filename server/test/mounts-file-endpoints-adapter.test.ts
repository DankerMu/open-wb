/**
 * s1b-workspace-mounts #1795 review: more of workspace-mounts「挂载目录内的文件端点」and「宿主不同步进入
 * 挂载」at the endpoint layer, on the whole mount (`mounts-file-endpoints-helpers.ts`) with the recording
 * seam as the adapter's file system — the gate's re-check (a request queued, or between two calls, when
 * its mount goes offline gets no further into it), the first read failing before any header, the
 * same-mount move through the adapter, reads on an online read-only mount, and a client that goes away
 * mid-download. Deadlines and probe rounds run on the world's fake clock.
 */
import { existsSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ProbeExec, probeInChild } from "../src/workspaces/mounts/rclone-process.js";
import {
  ask,
  createSeam,
  fileAudits,
  handles,
  listen,
  move,
  OFFLINE,
  openFileWorld,
  outcome,
  put,
  q,
  statusOf,
} from "./mounts-file-endpoints-helpers.js";
import { disposeWorlds, quiet, W1, waitFor } from "./mounts-manager-helpers.js";
import { CASE_MS, closeApps, mountsUrl, send } from "./mounts-rest-helpers.js";

afterEach(async () => {
  await closeApps();
  await disposeWorlds();
});

const GENERIC_500 = { error: { message: "服务器内部错误" } };

/** The probe's `stat` fails; readiness (`readdir`) is the real child probe. */
const failingStat: ProbeExec = (op, path, timeoutMs, signal) =>
  op === "stat" ? Promise.resolve(false) : probeInChild(op, path, timeoutMs, signal);

describe("宿主不同步进入挂载: the gate re-checks the mount's status as it admits each call", () => {
  for (const flip of ["a failed probe", "a detach"] as const) {
    it(`${flip} while one request is between calls and another is queued: both 409 mount_offline, nothing more reaches the mount but the direct close of the opened handle`, {
      timeout: CASE_MS,
    }, async () => {
      const seam = createSeam();
      const fw = await openFileWorld({
        online: [{ name: "远端" }],
        // The adapter deadline stays out of the way of the 30 s probe round.
        overrides: { mountFs: seam.impl, mountFsDeadlineMs: 60_000, probeExec: failingStat },
      });
      const point = fw.point("远端");
      put(fw.root, "远端/a.md", "a\n");
      const file = join(point, "a.md");
      const release = seam.hold(file, ["open"]);

      const reading = ask(fw, "GET", `file?${q("远端/a.md")}`);
      await waitFor(() => seam.under(point).some((call) => call.op === "open"));
      const listing = ask(fw, "GET", `tree?${q("远端")}`);
      await quiet(100);
      expect(seam.under(point)).toEqual([
        { op: "lstat", path: file },
        { op: "open", path: file },
      ]);

      if (flip === "a failed probe") {
        fw.world.clock.advance(30_000);
        await waitFor(() => fw.world.fusermountCalls().length === 1);
        expect(await statusOf(fw, "远端")).toBe("offline");
      } else {
        const detached = await send(fw.rest, "member", "DELETE", mountsUrl(W1, fw.idOf("远端")));
        expect(detached.statusCode).toBe(204);
      }
      release();

      expect(outcome(await reading)).toEqual(OFFLINE);
      expect(outcome(await listing)).toEqual(OFFLINE);
      await waitFor(() => handles(seam, point).closed === 1);
      // The open already in the kernel returns; its handle is closed directly (the adapter refuses).
      expect(seam.under(point)).toEqual([
        { op: "lstat", path: file },
        { op: "open", path: file },
        { op: "close", path: file },
      ]);
      expect(fileAudits(fw)).toEqual([]);
    });
  }
});

describe("挂载目录内的文件端点: the first read fails before any header", () => {
  it("fstat says 1000, the first read is EOF: download and file (Range) answer the generic 500 envelope, not a 200 / 206; every handle closed", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    put(fw.root, "远端/empty.bin", "");
    put(fw.root, "远端/empty.mp4", "");
    seam.staleSize(join(point, "empty.bin"), 1000);
    seam.staleSize(join(point, "empty.mp4"), 1000);
    const { app } = fw.rest;
    const cookie = fw.rest.cookies.member;

    const download = await ask(fw, "GET", `download?${q("远端/empty.bin")}`);
    const ranged = await app.inject({
      method: "GET",
      url: `/api/workspaces/${W1}/file?${q("远端/empty.mp4")}`,
      headers: { cookie, range: "bytes=0-999" },
    });
    for (const response of [download, ranged]) {
      expect([
        response.statusCode,
        response.json(),
        response.headers["content-type"],
        response.headers["content-disposition"],
        response.headers["content-range"],
      ]).toEqual([500, GENERIC_500, "application/json; charset=utf-8", undefined, undefined]);
    }
    // download writes its audit row once opened, before sending; the failure does not withdraw it.
    expect(fileAudits(fw)).toEqual([["file.download", "下载 远端/empty.bin"]]);
    await waitFor(() => handles(seam, point).closed === 2);
    expect(handles(seam, point)).toEqual({ opened: 2, closed: 2 });
    expect(await statusOf(fw, "远端")).toBe("online");
  });
});

describe("挂载目录内的文件端点: the same-mount move through the adapter", () => {
  it("lstat from, lstat to's parent, lstat to, then one rename; 404 / 404 / 409 short of the rename; a hung mount 409 mount_offline at the deadline", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    put(fw.root, "远端/a.md", "a\n");
    put(fw.root, "远端/b.md", "b\n");
    put(fw.root, "远端/d/keep.txt", "k\n");
    const at = (path: string) => join(point, path);

    const moved = await ask(fw, "POST", "move", move("远端/a.md", "远端/d/a.md"));
    expect([moved.statusCode, moved.json()]).toEqual([200, { path: "远端/d/a.md" }]);
    expect(seam.under(point)).toEqual([
      { op: "lstat", path: at("a.md") },
      { op: "lstat", path: at("d") },
      { op: "lstat", path: at("d/a.md") },
      { op: "rename", path: at("a.md") },
    ]);
    expect(readFileSync(at("d/a.md"), "utf8")).toBe("a\n");
    expect(existsSync(at("a.md"))).toBe(false);

    const before = seam.calls.length;
    for (const [body, expected] of [
      [move("远端/missing.md", "远端/x.md"), [404, "not_found"]],
      [move("远端/b.md", "远端/无/b.md"), [404, "not_found"]],
      [move("远端/b.md", "远端/d/keep.txt"), [409, "conflict"]],
    ] as const) {
      expect([body, ...outcome(await ask(fw, "POST", "move", body))]).toEqual([body, ...expected]);
    }
    expect(
      seam.calls
        .slice(before)
        .filter((call) => call.op === "rename")
        .map((call) => call.path),
    ).toEqual([]);
    expect(readFileSync(at("b.md"), "utf8")).toBe("b\n");
    expect(readFileSync(at("d/keep.txt"), "utf8")).toBe("k\n");
    expect(fileAudits(fw)).toEqual([["file.move", "移动 远端/a.md → 远端/d/a.md"]]);

    seam.hang(point);
    const mark = seam.calls.length;
    const hung = ask(fw, "POST", "move", move("远端/b.md", "远端/c.md"));
    await waitFor(() => seam.calls.length > mark);
    fw.world.clock.advance(10_000);
    expect(outcome(await hung)).toEqual(OFFLINE);
    expect(seam.calls.slice(mark)).toEqual([{ op: "lstat", path: at("b.md") }]);
    expect(existsSync(at("c.md"))).toBe(false);
    expect(fileAudits(fw)).toHaveLength(1);
    expect(await statusOf(fw, "远端")).toBe("offline");
  });
});

describe("workspaces「离线与只读挂载」: reads on an online read-only mount", () => {
  it("参考 (read-only): tree, file and download are 200 through the adapter", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "参考", readOnly: true }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("参考");
    put(fw.root, "参考/a.md", "ref\n");

    const tree = await ask(fw, "GET", `tree?${q("参考")}`);
    expect([
      tree.statusCode,
      (tree.json() as { entries: Array<{ name: string }> }).entries.map((e) => e.name),
    ]).toEqual([200, ["a.md"]]);
    const file = await ask(fw, "GET", `file?${q("参考/a.md")}`);
    expect([file.statusCode, file.body]).toEqual([200, "ref\n"]);
    const download = await ask(fw, "GET", `download?${q("参考/a.md")}`);
    expect([download.statusCode, download.body, download.headers["content-length"]]).toEqual([
      200,
      "ref\n",
      "4",
    ]);
    expect(fileAudits(fw)).toEqual([["file.download", "下载 参考/a.md"]]);
    expect(new Set(seam.under(point).map((call) => call.op))).toEqual(
      new Set(["lstat", "readdir", "open", "fstat", "read", "close"]),
    );
    await waitFor(() => handles(seam, point).closed === 2);
    expect(handles(seam, point)).toEqual({ opened: 2, closed: 2 });
  });
});

/**
 * Starts the request, and on its first body chunk holds the file's further reads, then drops the
 * connection; resolves the status and whether the body arrived whole.
 */
function dropAfterFirstChunk(
  url: string,
  headers: Record<string, string>,
  onFirst: () => void,
): Promise<{ status: number; complete: boolean }> {
  return new Promise((resolve) => {
    const request = httpGet(url, { headers }, (response) => {
      response.once("data", () => {
        onFirst();
        request.destroy();
      });
      response.on("error", () => undefined);
      response.on("close", () =>
        resolve({ status: response.statusCode ?? 0, complete: response.complete }),
      );
    });
    // The drop itself may surface as an error on the request; it is the point of the test.
    request.on("error", () => undefined);
  });
}

describe("挂载目录内的文件端点: the client goes away mid-response", () => {
  it("download and a Range request dropped after the first chunk: the handle is closed, even with a read held in the mount", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const fw = await openFileWorld({
      online: [{ name: "远端" }],
      overrides: { mountFs: seam.impl },
    });
    const point = fw.point("远端");
    const big = 8 * 1024 * 1024;
    put(fw.root, "远端/big.bin", Buffer.alloc(big, 1));
    put(fw.root, "远端/big.mp4", Buffer.alloc(big, 2));
    const origin = await listen(fw.rest.app);
    const cookie = fw.rest.cookies.member;
    const url = (route: string, path: string) =>
      `${origin}/api/workspaces/${W1}/${route}?${q(path)}`;

    let release: () => void = () => undefined;
    const download = await dropAfterFirstChunk(url("download", "远端/big.bin"), { cookie }, () => {
      release = seam.hold(join(point, "big.bin"), ["read"]);
    });
    await quiet(100);
    release();
    const ranged = await dropAfterFirstChunk(
      url("file", "远端/big.mp4"),
      { cookie, range: `bytes=0-${big - 1}` },
      () => {
        release = seam.hold(join(point, "big.mp4"), ["read"]);
      },
    );
    await quiet(100);
    release();

    expect([download.status, download.complete]).toEqual([200, false]);
    expect([ranged.status, ranged.complete]).toEqual([206, false]);
    await waitFor(() => handles(seam, point).closed === 2);
    expect(handles(seam, point)).toEqual({ opened: 2, closed: 2 });
    expect(await statusOf(fw, "远端")).toBe("online");
  });
});
