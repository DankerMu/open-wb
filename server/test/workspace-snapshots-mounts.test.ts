/**
 * Issue #1212 workspace-snapshots「挂载点整目录跳过」「挂载点不被还原也不被删除」: a directory on
 * another device than the workspace root takes no part in a snapshot or a restore. No real mount:
 * `mountAt` changes `dev` on what the module's `lstat` of chosen paths returns. Real temporary
 * directories otherwise; "not listed" and "not opened" are read off the recorded calls.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parentsAreReal } from "../src/workspaces/snapshots-restore.js";
import {
  contentsOf,
  describeTree,
  dirEntry,
  type Fixture,
  fileEntry,
  fixture,
  manifestOf,
  mountAt,
  onCopyCreate,
  outsideDir,
  put,
  restoreRun,
  run,
  snapshot,
  stateOf,
  watchListings,
  watchOpens,
} from "./workspace-snapshots-helpers.js";

function at(f: Fixture, path: string): string {
  return join(f.workspace, path);
}

function mount(path: string): { path: string; reason: string } {
  return { path, reason: "mount" };
}

/** The workspace of scenario「挂载点整目录跳过」, `remote` and `docs/vol` on another device. */
function withTwoMounts(): Fixture {
  const f = fixture();
  put(f.workspace, "a.txt", "a\n");
  put(f.workspace, "docs/b.txt", "b\n");
  put(f.workspace, "remote/x.txt", "x\n");
  put(f.workspace, "remote/sub/y.txt", "y\n");
  put(f.workspace, "docs/vol/z.txt", "z\n");
  mountAt(at(f, "remote"), at(f, "docs/vol"));
  return f;
}

describe("挂载点整目录跳过", () => {
  it("a directory on another device is skipped as mount: not listed, nothing below it opened", async () => {
    const f = withTwoMounts();
    const listed = watchListings();
    const opened = watchOpens(f, () => undefined);

    const result = await run(f);

    const skipped = [mount("docs/vol"), mount("remote")];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), dirEntry(f, "docs"), fileEntry(f, "docs/b.txt")],
      skipped,
    });
    expect(Object.keys(describeTree(join(f.snapshot, "tree")))).toEqual([
      "a.txt",
      "docs",
      "docs/b.txt",
    ]);
    expect(listed).toContain(at(f, "docs"));
    expect(listed.filter((dir) => /\/(remote|vol)(\/|$)/.test(dir))).toEqual([]);
    expect(opened).toEqual(["a.txt", "tree/a.txt", "docs/b.txt", "tree/docs/b.txt"]);
  });

  it("a mount point and what is below it count toward no limit: three entries fit a limit of three", async () => {
    const f = withTwoMounts();

    const result = await run(f, { maxEntries: 3 });

    expect(result).toEqual({ outcome: "ok", skipped: [mount("docs/vol"), mount("remote")] });
    expect(manifestOf(f).entries).toHaveLength(3);
  });

  it("an excluded directory on another device is still excluded; one beside it is mount", async () => {
    const f = fixture();
    put(f.workspace, "node_modules/p/index.js", "p\n");
    put(f.workspace, "remote/x.txt", "x\n");
    mountAt(at(f, "node_modules"), at(f, "remote"));

    const result = await run(f);

    const skipped = [{ path: "node_modules", reason: "excluded" }, mount("remote")];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({ entries: [], skipped });
  });
});

describe("挂载点不被还原也不被删除", () => {
  it("a mount point the snapshot skipped keeps its later changes and is listed once", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "a\n");
    put(f.workspace, "remote/x.txt", "x\n");
    mountAt(at(f, "remote"));
    await snapshot(f);
    expect(manifestOf(f).skipped).toEqual([mount("remote")]);
    writeFileSync(at(f, "remote/x.txt"), "rewritten\n");
    put(f.workspace, "remote/new.txt", "new\n");
    const listed = watchListings();

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 0, skipped: [mount("remote")], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "a\n",
      remote: "dir",
      "remote/new.txt": "new\n",
      "remote/x.txt": "rewritten\n",
    });
    expect(listed).toEqual([f.workspace]);
  });

  it("a directory of the manifest that something was mounted on since is not entered or restored", async () => {
    const f = fixture();
    put(f.workspace, "data/a.txt", "a\n");
    put(f.workspace, "data/sub/c.txt", "c\n");
    put(f.workspace, "top.txt", "top\n");
    await snapshot(f);
    expect(manifestOf(f).entries.map((entry) => (entry as { path: string }).path)).toEqual([
      "data",
      "data/a.txt",
      "data/sub",
      "data/sub/c.txt",
      "top.txt",
    ]);
    mountAt(at(f, "data"));
    writeFileSync(at(f, "data/a.txt"), "rewritten\n");
    put(f.workspace, "data/b.txt", "b\n");
    rmSync(at(f, "data/sub"), { recursive: true });
    writeFileSync(at(f, "top.txt"), "changed\n");
    const listed = watchListings();

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [mount("data")], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      data: "dir",
      "data/a.txt": "rewritten\n",
      "data/b.txt": "b\n",
      "top.txt": "top\n",
    });
    expect(listed).toEqual([f.workspace]);
  });

  it("a new directory on another device is no extra entry: kept and reported", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "a\n");
    await snapshot(f);
    put(f.workspace, "m/r.txt", "r\n");
    mountAt(at(f, "m"));
    const listed = watchListings();

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 0, skipped: [mount("m")], failed: [] });
    expect(readFileSync(at(f, "m/r.txt"), "utf8")).toBe("r\n");
    expect(listed).toEqual([f.workspace]);
  });

  it("deleting an extra directory stops at a mount point below it and keeps the levels above", async () => {
    const f = fixture();
    const outside = outsideDir(f);
    put(f.workspace, "a.txt", "a\n");
    await snapshot(f);
    put(f.workspace, "new/f.txt", "f\n");
    put(f.workspace, "new/deep/g.txt", "g\n");
    put(f.workspace, "new/deep/remote/r.txt", "r\n");
    symlinkSync(outside, at(f, "new/deep/out"));
    mountAt(at(f, "new/deep/remote"));
    const before = stateOf(outside);
    const listed = watchListings();

    const first = await restoreRun(f);
    const second = await restoreRun(f);

    const expected = { restored: 0, removed: 0, skipped: [mount("new/deep/remote")], failed: [] };
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "a\n",
      new: "dir",
      "new/deep": "dir",
      "new/deep/remote": "dir",
      "new/deep/remote/r.txt": "r\n",
    });
    expect(listed).not.toContain(at(f, "new/deep/remote"));
    expect(stateOf(outside)).toEqual(before);
  });

  it("a directory in a manifest file's place that holds a mount point is not replaced: failed", async () => {
    const f = fixture();
    put(f.workspace, "top.txt", "top\n");
    put(f.workspace, "x", "a file\n");
    await snapshot(f);
    writeFileSync(at(f, "top.txt"), "changed\n");
    rmSync(at(f, "x"));
    put(f.workspace, "x/y.txt", "y\n");
    put(f.workspace, "x/remote/r.txt", "r\n");
    mountAt(at(f, "x/remote"));

    const result = await restoreRun(f);

    expect(result).toEqual({
      restored: 1,
      removed: 0,
      skipped: [mount("x/remote")],
      failed: [{ path: "x" }],
    });
    expect(contentsOf(f.workspace)).toEqual({
      "top.txt": "top\n",
      x: "dir",
      "x/remote": "dir",
      "x/remote/r.txt": "r\n",
    });
    expect(readdirSync(f.workspace).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a directory in a manifest link's place that holds a mount point is not replaced: failed", async () => {
    const f = fixture();
    symlinkSync("elsewhere", at(f, "y"));
    await snapshot(f);
    rmSync(at(f, "y"));
    put(f.workspace, "y/z.txt", "z\n");
    put(f.workspace, "y/remote/r.txt", "r\n");
    mountAt(at(f, "y/remote"));

    const result = await restoreRun(f);

    expect(result).toEqual({
      restored: 0,
      removed: 0,
      skipped: [mount("y/remote")],
      failed: [{ path: "y" }],
    });
    expect(contentsOf(f.workspace)).toEqual({
      y: "dir",
      "y/remote": "dir",
      "y/remote/r.txt": "r\n",
    });
  });

  it("a mount point where the manifest has a file or a link is neither replaced nor listed", async () => {
    const f = fixture();
    put(f.workspace, "f", "a file\n");
    symlinkSync("elsewhere", at(f, "l"));
    await snapshot(f);
    rmSync(at(f, "f"));
    rmSync(at(f, "l"));
    put(f.workspace, "f/r.txt", "in f\n");
    put(f.workspace, "l/r.txt", "in l\n");
    mountAt(at(f, "f"), at(f, "l"));
    const listed = watchListings();

    const result = await restoreRun(f);

    expect(result).toEqual({
      restored: 0,
      removed: 0,
      skipped: [mount("f"), mount("l")],
      failed: [],
    });
    expect(contentsOf(f.workspace)).toEqual({
      f: "dir",
      "f/r.txt": "in f\n",
      l: "dir",
      "l/r.txt": "in l\n",
    });
    expect(listed).toEqual([f.workspace]);
  });

  it("the path check refuses a parent level that is a real directory on another device", async () => {
    const f = fixture();
    put(f.workspace, "real/inner/b.txt", "b\n");
    expect(await parentsAreReal(f.workspace, "real/inner/b.txt")).toBe(true);
    const mounted = mountAt(at(f, "real/inner"));

    expect(await parentsAreReal(f.workspace, "real/inner/b.txt")).toBe(false);
    expect(await parentsAreReal(f.workspace, "real/inner/deeper/b.txt")).toBe(false);
    // The last component is the entry itself, not a parent.
    expect(await parentsAreReal(f.workspace, "real/inner")).toBe(true);
    mounted.add(at(f, "real"));
    expect(await parentsAreReal(f.workspace, "real/b.txt")).toBe(false);
  });

  it("a parent mounted on after the extras were looked for: the entry fails, nothing is written through it", async () => {
    const f = fixture();
    put(f.workspace, "d/a.txt", "a\n");
    await snapshot(f);
    writeFileSync(at(f, "d/a.txt"), "changed\n");
    const mounted = mountAt();
    onCopyCreate(() => mounted.add(at(f, "d")));

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 0, skipped: [], failed: [{ path: "d/a.txt" }] });
    expect(contentsOf(f.workspace)).toEqual({ d: "dir", "d/a.txt": "changed\n" });
  });

  it("a mount point that takes a manifest file's place while it is written back is not deleted", async () => {
    const f = fixture();
    put(f.workspace, "f", "a file\n");
    await snapshot(f);
    rmSync(at(f, "f"));
    const mounted = mountAt();
    onCopyCreate(() => {
      mkdirSync(at(f, "f"));
      writeFileSync(at(f, "f/r.txt"), "r\n");
      mounted.add(at(f, "f"));
    });

    const result = await restoreRun(f);

    expect(result).toEqual({
      restored: 0,
      removed: 0,
      skipped: [mount("f")],
      failed: [{ path: "f" }],
    });
    expect(contentsOf(f.workspace)).toEqual({ f: "dir", "f/r.txt": "r\n" });
    expect(existsSync(at(f, "f/r.txt"))).toBe(true);
  });
});
