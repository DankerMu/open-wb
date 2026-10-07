/**
 * Issue #940 workspace-snapshots「还原」: `restore` puts a workspace back to what a snapshot's
 * manifest describes, on real temporary directories. Every snapshot is produced by the real
 * `take`. Expected contents are the literals the tests wrote before the snapshot; inodes, times
 * and modes are read by the tests' own lstat. The race and damaged-snapshot cases are in
 * `workspace-snapshots-restore-safety.test.ts`.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parentsAreReal } from "../src/workspaces/snapshots-restore.js";
import {
  contentsOf,
  describeTree,
  type Fixture,
  fixture,
  manifestOf,
  outsideDir,
  put,
  restoreRun,
  snapshot,
  stateOf,
} from "./workspace-snapshots-helpers.js";

/** A whole second, so a time set from the manifest reads back exactly. */
const PINNED_SECONDS = 1_700_000_000;
/** Longer than any coarse `ctime` clock tick (Linux: at most 10 ms). */
const CTIME_GAP_MS = 60;
const UMASK = process.umask();

afterEach(() => {
  process.umask(UMASK);
});

function at(f: Fixture, path: string): string {
  return join(f.workspace, path);
}

function inode(path: string): number {
  return lstatSync(path).ino;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

describe("还原", () => {
  it("还原改动、新增与删除: changed and deleted files come back, new entries go", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "1");
    put(f.workspace, "dir/b.txt", "2");
    put(f.workspace, "keep.txt", "3");
    await snapshot(f);
    const keep = inode(at(f, "keep.txt"));
    writeFileSync(at(f, "a.txt"), "x");
    rmSync(at(f, "dir/b.txt"));
    put(f.workspace, "c.txt", "new");
    put(f.workspace, "new/d.txt", "new too");
    const stored = stateOf(f.snapshot);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 2, removed: 2, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "1",
      dir: "dir",
      "dir/b.txt": "2",
      "keep.txt": "3",
    });
    expect(inode(at(f, "keep.txt"))).toBe(keep);
    expect(stateOf(f.snapshot)).toEqual(stored);
  });

  it("只计内容确有变化的文件: a rewrite of the same bytes and a chmod are left alone", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "same\n");
    put(f.workspace, "b.txt", "before");
    put(f.workspace, "c.txt", "chmod\n");
    await snapshot(f);
    await sleep(CTIME_GAP_MS);
    const recorded = lstatSync(at(f, "a.txt"));
    writeFileSync(at(f, "a.txt"), "same\n");
    writeFileSync(at(f, "b.txt"), "after.");
    chmodSync(at(f, "c.txt"), 0o600);
    expect(lstatSync(at(f, "a.txt")).mtimeMs).not.toBe(recorded.mtimeMs);
    expect(lstatSync(at(f, "a.txt")).ctimeMs).not.toBe(recorded.ctimeMs);
    const before = describeTree(f.workspace);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(readFileSync(at(f, "b.txt"), "utf8")).toBe("before");
    const after = describeTree(f.workspace);
    expect(after["a.txt"]).toBe(before["a.txt"]);
    expect(after["c.txt"]).toBe(before["c.txt"]);
    expect(modeOf(at(f, "c.txt"))).toBe(0o600);
    expect(after["b.txt"]).not.toBe(before["b.txt"]);
  });

  it("跳过项不动并列出: what the snapshot left out keeps its later changes", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "big.bin", "eleven byte");
    put(f.workspace, "node_modules/pkg/index.js", "module.exports = 1;\n");
    await snapshot(f, { maxFileBytes: 10 });
    const skipped = [
      { path: "big.bin", reason: "too_large" },
      { path: "node_modules", reason: "excluded" },
    ];
    expect(manifestOf(f).skipped).toEqual(skipped);
    writeFileSync(at(f, "a.txt"), "changed\n");
    writeFileSync(at(f, "big.bin"), "now much larger than before");
    writeFileSync(at(f, "node_modules/pkg/index.js"), "module.exports = 2;\n");
    put(f.workspace, "node_modules/x/y.js", "added\n");
    const before = describeTree(f.workspace);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped, failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "alpha\n",
      "big.bin": "now much larger than before",
      node_modules: "dir",
      "node_modules/pkg": "dir",
      "node_modules/pkg/index.js": "module.exports = 2;\n",
      "node_modules/x": "dir",
      "node_modules/x/y.js": "added\n",
    });
    const after = describeTree(f.workspace);
    for (const path of Object.keys(before).filter((key) => key !== "a.txt")) {
      expect(after[path], path).toBe(before[path]);
    }
  });

  it("版本库随撤回还原: the ref goes back, the new object goes, .git is not skipped", async () => {
    const f = fixture();
    put(f.workspace, ".git/HEAD", "ref: refs/heads/main\n");
    put(f.workspace, ".git/refs/heads/main", "commit-A\n");
    put(f.workspace, "src/app.ts", "export const app = 1;\n");
    await snapshot(f);
    put(f.workspace, ".git/objects/cd/ef01", "object bytes");
    writeFileSync(at(f, ".git/refs/heads/main"), "commit-B\n");
    writeFileSync(at(f, "src/app.ts"), "export const app = 2; // edited in the turn\n");

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 2, removed: 1, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      ".git": "dir",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs": "dir",
      ".git/refs/heads": "dir",
      ".git/refs/heads/main": "commit-A\n",
      src: "dir",
      "src/app.ts": "export const app = 1;\n",
    });
    expect(existsSync(at(f, ".git/objects"))).toBe(false);
  });

  it("父目录被换成符号链接: the link goes, a real directory comes back, O is not touched", async () => {
    const f = fixture();
    put(f.workspace, "dir/b.txt", "2");
    await snapshot(f);
    const outside = outsideDir(f);
    rmSync(at(f, "dir"), { recursive: true });
    symlinkSync(outside, at(f, "dir"));
    const before = stateOf(outside);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(lstatSync(at(f, "dir")).isDirectory()).toBe(true);
    expect(modeOf(at(f, "dir"))).toBe(0o2770);
    expect(contentsOf(f.workspace)).toEqual({ dir: "dir", "dir/b.txt": "2" });
    expect(stateOf(outside)).toEqual(before);
    expect(readFileSync(join(outside, "b.txt"), "utf8")).toBe("outside b\n");
  });

  it("父目录被换成符号链接: the path check refuses a parent level that is a link or no directory", async () => {
    const f = fixture();
    const outside = outsideDir(f);
    put(f.workspace, "real/inner/b.txt", "2");
    put(f.workspace, "file", "a regular file\n");
    symlinkSync(outside, at(f, "dir"));
    symlinkSync(outside, at(f, "real/link"));
    const before = stateOf(outside);

    expect(await parentsAreReal(f.workspace, "dir/b.txt")).toBe(false);
    expect(await parentsAreReal(f.workspace, "real/link/b.txt")).toBe(false);
    expect(await parentsAreReal(f.workspace, "real/link/deeper/b.txt")).toBe(false);
    expect(await parentsAreReal(f.workspace, "file/b.txt")).toBe(false);
    expect(await parentsAreReal(f.workspace, "missing/b.txt")).toBe(false);
    expect(await parentsAreReal(at(f, "dir"), "b.txt")).toBe(false);
    expect(await parentsAreReal(f.workspace, "real/inner/b.txt")).toBe(true);
    expect(await parentsAreReal(f.workspace, "real/inner/not-there-yet.txt")).toBe(true);
    // The last component is the entry itself, not a parent: it may be a link.
    expect(await parentsAreReal(f.workspace, "dir")).toBe(true);
    expect(stateOf(outside)).toEqual(before);
  });

  it("写回文件的权限位: owner and group read-write added, special bits dropped, umask ignored", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "a\n", 0o644);
    put(f.workspace, "run.sh", "#!/bin/sh\n", 0o755);
    put(f.workspace, "secret", "s\n", 0o600);
    put(f.workspace, "s.bin", "bin\n", 0o4755);
    put(f.workspace, "gone/inner.txt", "inner\n", 0o640);
    await snapshot(f);
    expect(manifestOf(f).entries).toMatchObject([
      { path: "a.txt", mode: 0o644 },
      { path: "gone" },
      { path: "gone/inner.txt", mode: 0o640 },
      { path: "run.sh", mode: 0o755 },
      { path: "s.bin", mode: 0o4755 },
      { path: "secret", mode: 0o600 },
    ]);
    for (const name of ["a.txt", "run.sh", "secret", "s.bin"]) {
      writeFileSync(at(f, name), "changed in the turn\n");
    }
    rmSync(at(f, "gone"), { recursive: true });
    process.umask(0o077);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 5, removed: 0, skipped: [], failed: [] });
    expect(modeOf(at(f, "a.txt"))).toBe(0o664);
    expect(modeOf(at(f, "run.sh"))).toBe(0o775);
    expect(modeOf(at(f, "secret"))).toBe(0o660);
    expect(modeOf(at(f, "s.bin"))).toBe(0o775);
    expect(modeOf(at(f, "gone/inner.txt"))).toBe(0o660);
    expect(modeOf(at(f, "gone"))).toBe(0o2770);
    expect(readFileSync(at(f, "s.bin"), "utf8")).toBe("bin\n");
  });

  it.each([
    ["manifest.json is missing", (f: Fixture) => rmSync(join(f.snapshot, "manifest.json"))],
    [
      "manifest.json is not JSON",
      (f: Fixture) => writeFileSync(join(f.snapshot, "manifest.json"), '{"entries":['),
    ],
    [
      "manifest.json has no skipped list",
      (f: Fixture) => writeFileSync(join(f.snapshot, "manifest.json"), '{"entries":[]}'),
    ],
    ["tree/ is missing", (f: Fixture) => rmSync(join(f.snapshot, "tree"), { recursive: true })],
    [
      "the workspace root is a symbolic link",
      (f: Fixture) => {
        renameSync(f.workspace, `${f.workspace}-real`);
        symlinkSync(`${f.workspace}-real`, f.workspace);
      },
    ],
  ])("结构性失败不动工作空间: %s", async (_name, damage) => {
    const f = fixture();
    put(f.workspace, "a.txt", "1");
    put(f.workspace, "dir/b.txt", "2");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "x");
    rmSync(at(f, "dir/b.txt"));
    put(f.workspace, "c.txt", "new");
    put(f.workspace, "new/d.txt", "new too");
    damage(f);
    const before = stateOf(f.workspace);

    await expect(restoreRun(f)).rejects.toThrow();

    expect(stateOf(f.workspace)).toEqual(before);
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "x",
      "c.txt": "new",
      dir: "dir",
      new: "dir",
      "new/d.txt": "new too",
    });
  });

  it("refuses a snapshot directory inside the workspace before touching anything", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "1");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "x");
    const inside = { ...f, snapshot: at(f, "snap") };
    renameSync(f.snapshot, inside.snapshot);
    const before = stateOf(f.workspace);

    await expect(restoreRun(inside)).rejects.toThrow(TypeError);
    await expect(restoreRun({ ...f, snapshot: f.workspace })).rejects.toThrow(TypeError);

    expect(stateOf(f.workspace)).toEqual(before);
    expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("x");
  });

  it("幂等: the second restore changes nothing and writes nothing again", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    put(f.workspace, "keep.txt", "keep\n");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "rewritten in the turn\n");
    rmSync(at(f, "b.txt"));
    put(f.workspace, "c.txt", "new\n");

    const first = await restoreRun(f);

    expect(first).toEqual({ restored: 2, removed: 1, skipped: [], failed: [] });
    const before = stateOf(f.workspace);
    const written = [inode(at(f, "a.txt")), inode(at(f, "b.txt"))];
    await sleep(CTIME_GAP_MS);

    const second = await restoreRun(f);

    expect(second).toEqual({ restored: 0, removed: 0, skipped: [], failed: [] });
    expect(stateOf(f.workspace)).toEqual(before);
    expect([inode(at(f, "a.txt")), inode(at(f, "b.txt"))]).toEqual(written);
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "alpha\n",
      "b.txt": "bravo\n",
      "keep.txt": "keep\n",
    });
  });

  it("还原后改写工作空间文件，快照内容不变: the written-back file shares nothing with tree/", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "original\n");
    await snapshot(f);
    const stored = join(f.snapshot, "tree", "a.txt");
    writeFileSync(at(f, "a.txt"), "changed in the turn\n");

    expect(await restoreRun(f)).toMatchObject({ restored: 1, failed: [] });
    expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("original\n");
    expect(inode(at(f, "a.txt"))).not.toBe(inode(stored));
    expect(lstatSync(stored).nlink).toBe(1);
    expect(lstatSync(at(f, "a.txt")).nlink).toBe(1);
    const restored = inode(at(f, "a.txt"));
    // In place: the same inode gets new bytes, as an agent's edit of the file would.
    writeFileSync(at(f, "a.txt"), "overwritten in place after the restore\n");

    expect(inode(at(f, "a.txt"))).toBe(restored);
    expect(readFileSync(stored, "utf8")).toBe("original\n");
  });

  it("rebuilds a symbolic link that is gone, retargeted or replaced, and leaves an equal one", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    for (const name of ["gone", "retargeted", "replaced", "equal"]) {
      symlinkSync("a.txt", at(f, name));
    }
    symlinkSync(f.outside, at(f, "out"));
    await snapshot(f);
    const equal = inode(at(f, "equal"));
    rmSync(at(f, "gone"));
    rmSync(at(f, "retargeted"));
    symlinkSync(f.outside, at(f, "retargeted"));
    rmSync(at(f, "replaced"));
    put(f.workspace, "replaced/inner.txt", "a directory now\n");
    const outside = describeTree(join(f.outside, ".."))["outside.txt"];

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 3, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "alpha\n",
      equal: "-> a.txt",
      gone: "-> a.txt",
      out: `-> ${f.outside}`,
      replaced: "-> a.txt",
      retargeted: "-> a.txt",
    });
    expect(inode(at(f, "equal"))).toBe(equal);
    expect(describeTree(join(f.outside, ".."))["outside.txt"]).toBe(outside);
  });

  it("an entry of another type under a manifest path is replaced and not counted as removed", async () => {
    const f = fixture();
    put(f.workspace, "file", "a file\n");
    put(f.workspace, "dir/inner.txt", "inner\n");
    symlinkSync("file", at(f, "link"));
    await snapshot(f);
    rmSync(at(f, "file"));
    put(f.workspace, "file/child.txt", "the file is a directory now\n");
    rmSync(at(f, "dir"), { recursive: true });
    writeFileSync(at(f, "dir"), "the directory is a file now\n");
    rmSync(at(f, "link"));
    writeFileSync(at(f, "link"), "the link is a file now\n");

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 3, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      dir: "dir",
      "dir/inner.txt": "inner\n",
      file: "a file\n",
      link: "-> file",
    });
  });

  it("sets the recorded mtime on a written-back file and leaves an existing directory's mode", async () => {
    const f = fixture();
    put(f.workspace, "dir/b.txt", "bravo\n");
    utimesSync(at(f, "dir/b.txt"), PINNED_SECONDS, PINNED_SECONDS);
    await snapshot(f);
    writeFileSync(at(f, "dir/b.txt"), "changed in the turn\n");
    chmodSync(at(f, "dir"), 0o750);

    expect(await restoreRun(f)).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });

    expect(lstatSync(at(f, "dir/b.txt")).mtimeMs).toBe(PINNED_SECONDS * 1000);
    expect(readFileSync(at(f, "dir/b.txt"), "utf8")).toBe("bravo\n");
    expect(modeOf(at(f, "dir"))).toBe(0o750);
  });
});
