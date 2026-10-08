/**
 * Issue #937 workspace-snapshots「快照的存放位置」(位置与权限位) and「快照内容规则」(各类条目、
 * 读不了的子目录、失败不留半份): `take` on real temporary directories. Expected manifests are
 * written out from the spec's entry rules and the test's own lstat / readlink of the workspace,
 * not derived from the module under test. The last group is design D9「快照期间可能有写入者」:
 * an entry replaced after it was classified.
 */
import { execFileSync } from "node:child_process";
import fs, {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  describeTree,
  dirEntry,
  type Fixture,
  fileEntry,
  fixture,
  ioError,
  lock,
  MESSAGE_ID,
  manifestOf,
  OUTSIDE_BYTES,
  onCopyCreate,
  put,
  releaseAfterTest,
  run,
  setPast,
  swapAfterLstat,
  W,
  waitForClock,
} from "./workspace-snapshots-helpers.js";

const IS_ROOT = process.geteuid?.() === 0;

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

/** The workspace of scenario「各类条目」. */
function populate(f: Fixture): void {
  put(f.workspace, "a.txt", "alpha\n");
  put(f.workspace, "src/b.ts", "export const b = 1;\n", 0o755);
  mkdirSync(join(f.workspace, "empty"), { mode: 0o755 });
  symlinkSync("a.txt", join(f.workspace, "link"));
  symlinkSync(f.outside, join(f.workspace, "out"));
  execFileSync("mkfifo", [join(f.workspace, "fifo")]);
  put(f.workspace, "node_modules/pkg/index.js", "module.exports = 1;\n");
  put(f.workspace, "docs/node_modules", "a regular file with the excluded name\n");
}

/** Every regular file under the snapshot root, by content. */
function snapshotContents(f: Fixture): string[] {
  return Object.keys(describeTree(f.snapshots))
    .filter((path) => lstatSync(join(f.snapshots, path)).isFile())
    .map((path) => readFileSync(join(f.snapshots, path), "utf8"));
}

describe("快照的存放位置", () => {
  it("位置与权限位: manifest.json and tree/ under <W>/42, directories 0700, files 0600", async () => {
    const f = fixture();
    populate(f);
    put(f.workspace, "deep/er/still/c.bin", "\u0000\u0001\u0002", 0o444);
    const before = describeTree(f.workspace);

    const result = await run(f);

    expect(result.outcome).toBe("ok");
    expect(readdirSync(f.snapshot).sort()).toEqual(["manifest.json", "tree"]);
    expect(lstatSync(join(f.snapshot, "manifest.json")).isFile()).toBe(true);
    expect(lstatSync(join(f.snapshot, "tree")).isDirectory()).toBe(true);
    expect(readdirSync(f.snapshots)).toEqual([W]);
    expect(readdirSync(join(f.snapshots, W))).toEqual([String(MESSAGE_ID)]);

    const dirs = [
      f.snapshots,
      join(f.snapshots, W),
      f.snapshot,
      join(f.snapshot, "tree"),
      join(f.snapshot, "tree", "src"),
      join(f.snapshot, "tree", "empty"),
      join(f.snapshot, "tree", "docs"),
      join(f.snapshot, "tree", "deep"),
      join(f.snapshot, "tree", "deep", "er"),
      join(f.snapshot, "tree", "deep", "er", "still"),
    ];
    for (const dir of dirs) {
      expect(lstatSync(dir).isDirectory(), dir).toBe(true);
      expect(modeOf(dir).toString(8), dir).toBe("700");
    }
    const files = [
      join(f.snapshot, "manifest.json"),
      join(f.snapshot, "tree", "a.txt"),
      join(f.snapshot, "tree", "src", "b.ts"),
      join(f.snapshot, "tree", "docs", "node_modules"),
      join(f.snapshot, "tree", "deep", "er", "still", "c.bin"),
    ];
    for (const file of files) {
      expect(lstatSync(file).isFile(), file).toBe(true);
      expect(modeOf(file).toString(8), file).toBe("600");
    }
    // Nothing else exists under the snapshot: every directory and file was checked above.
    expect(Object.keys(describeTree(f.snapshots)).length).toBe(dirs.length - 1 + files.length);

    // 工作空间根下没有新增任何条目 (and nothing in it was touched).
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("refuses path components that are not a trusted row's ids, before touching the disk", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    const badWorkspaceIds = [
      "",
      "..",
      "0123456789ABCDEF0123456789ABCDEF",
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "0123456789abcdef/123456789abcdef",
      `${W}\n`,
    ];
    for (const workspaceId of badWorkspaceIds) {
      await expect(run(f, { workspaceId }), JSON.stringify(workspaceId)).rejects.toThrow(TypeError);
    }
    const badMessageIds = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];
    for (const userMessageId of badMessageIds) {
      await expect(run(f, { userMessageId }), String(userMessageId)).rejects.toThrow(TypeError);
    }
    await expect(run(f, { userMessageId: "42" as unknown as number })).rejects.toThrow(TypeError);
    expect(readdirSync(f.snapshots)).toEqual([]);
  });

  it("refuses a snapshot root inside the workspace, or equal to it, before touching the disk", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    const inside = join(f.workspace, "snaps");
    mkdirSync(inside, { mode: 0o700 });
    const before = describeTree(f.workspace);

    for (const snapshotsRoot of [inside, f.workspace, join(f.workspace, "sub", "..", "snaps")]) {
      await expect(run(f, { snapshotsRoot }), snapshotsRoot).rejects.toThrow(TypeError);
    }
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("accepts a snapshot root whose name merely starts with the workspace's", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    const sibling = `${f.workspace}..snapshots`;
    mkdirSync(sibling, { mode: 0o700 });

    const result = await run(f, { snapshotsRoot: sibling, userMessageId: 7, excludeNames: [] });

    expect(result.outcome).toBe("ok");
    expect(readFileSync(join(sibling, W, "7", "tree", "a.txt"), "utf8")).toBe("alpha\n");
  });
});

describe("快照内容规则", () => {
  it("各类条目: files copied, links recorded only, FIFO and excluded directory skipped", async () => {
    const f = fixture();
    populate(f);
    const before = describeTree(f.workspace);
    const linkTarget = readlinkSync(join(f.workspace, "link"));
    const outTarget = readlinkSync(join(f.workspace, "out"));
    expect(linkTarget).toBe("a.txt");
    expect(outTarget).toBe(f.outside);

    const result = await run(f);

    const skipped = [
      { path: "fifo", reason: "special" },
      { path: "node_modules", reason: "excluded" },
    ];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({
      entries: [
        fileEntry(f, "a.txt"),
        dirEntry(f, "docs"),
        fileEntry(f, "docs/node_modules"),
        dirEntry(f, "empty"),
        { path: "link", type: "symlink", target: "a.txt" },
        { path: "out", type: "symlink", target: f.outside },
        dirEntry(f, "src"),
        fileEntry(f, "src/b.ts"),
      ],
      skipped,
    });

    const tree = join(f.snapshot, "tree");
    expect(Object.keys(describeTree(tree))).toEqual([
      "a.txt",
      "docs",
      "docs/node_modules",
      "empty",
      "src",
      "src/b.ts",
    ]);
    for (const path of ["a.txt", "src/b.ts", "docs/node_modules"]) {
      expect(
        readFileSync(join(tree, path)).equals(readFileSync(join(f.workspace, path))),
        path,
      ).toBe(true);
    }
    expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("alpha\n");
    expect(readdirSync(join(tree, "empty"))).toEqual([]);
    expect(lstatSync(join(tree, "docs", "node_modules")).isFile()).toBe(true);

    // Neither link is followed: no copy of either target, under any name.
    for (const name of ["link", "out", "fifo", "node_modules"]) {
      expect(existsSync(join(tree, name)), name).toBe(false);
      expect(() => lstatSync(join(tree, name)), name).toThrow(/ENOENT/);
    }
    for (const path of Object.keys(describeTree(tree))) {
      const s = lstatSync(join(tree, path));
      expect(s.isSymbolicLink(), path).toBe(false);
      if (s.isFile()) {
        expect(readFileSync(join(tree, path), "utf8"), path).not.toBe(OUTSIDE_BYTES);
        // A copy, never a hard link into the workspace.
        expect(s.nlink, path).toBe(1);
      }
    }

    // 工作空间各文件的 mtime 与内容未变: mode, size, mtime, ctime and inode of every entry.
    expect(describeTree(f.workspace)).toEqual(before);
    expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(f.outside, "utf8")).toBe(OUTSIDE_BYTES);
    expect(readlinkSync(join(f.workspace, "link"))).toBe(linkTarget);
    expect(readlinkSync(join(f.workspace, "out"))).toBe(outTarget);
  });

  it("excludes a directory by name at any depth and nothing when the list is empty", async () => {
    const f = fixture();
    put(f.workspace, "pkg/a/node_modules/x.js", "x\n");
    put(f.workspace, "pkg/a/keep.js", "keep\n");

    expect(await run(f)).toEqual({
      outcome: "ok",
      skipped: [{ path: "pkg/a/node_modules", reason: "excluded" }],
    });
    expect(Object.keys(describeTree(join(f.snapshot, "tree")))).toEqual([
      "pkg",
      "pkg/a",
      "pkg/a/keep.js",
    ]);
    rmSync(f.snapshot, { recursive: true });

    expect(await run(f, { excludeNames: [] })).toEqual({ outcome: "ok", skipped: [] });
    expect(readFileSync(join(f.snapshot, "tree", "pkg", "a", "node_modules", "x.js"), "utf8")).toBe(
      "x\n",
    );
  });

  it.skipIf(IS_ROOT)(
    "读不了的子目录: locked/ is skipped whole, the rest is snapshotted",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "locked/secret.txt", "secret\n");
      put(f.workspace, "z/after.txt", "after\n");
      lock(join(f.workspace, "locked"), 0o000);

      const result = await run(f);

      const skipped = [{ path: "locked", reason: "unreadable" }];
      expect(result).toEqual({ outcome: "ok", skipped });
      expect(manifestOf(f)).toEqual({
        entries: [fileEntry(f, "a.txt"), dirEntry(f, "z"), fileEntry(f, "z/after.txt")],
        skipped,
      });
      expect(Object.keys(describeTree(join(f.snapshot, "tree")))).toEqual([
        "a.txt",
        "z",
        "z/after.txt",
      ]);
      expect(readFileSync(join(f.snapshot, "tree", "z", "after.txt"), "utf8")).toBe("after\n");
      expect(modeOf(join(f.workspace, "locked"))).toBe(0o000);
    },
  );

  it.skipIf(IS_ROOT)(
    "an unreadable file and the children of an unsearchable directory",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "private.key", "key\n", 0o000);
      put(f.workspace, "listed/inner.txt", "inner\n");
      lock(join(f.workspace, "listed"), 0o600);
      const listed = lstatSync(join(f.workspace, "listed")).mode & 0o7777;

      const result = await run(f);

      const skipped = [
        { path: "listed/inner.txt", reason: "unreadable" },
        { path: "private.key", reason: "unreadable" },
      ];
      expect(result).toEqual({ outcome: "ok", skipped });
      expect(manifestOf(f)).toEqual({
        entries: [fileEntry(f, "a.txt"), { path: "listed", type: "dir", mode: listed }],
        skipped,
      });
      expect(Object.keys(describeTree(join(f.snapshot, "tree")))).toEqual(["a.txt", "listed"]);
      expect(modeOf(join(f.workspace, "private.key"))).toBe(0o000);
    },
  );

  it("EPERM on a link's target string is unreadable too; the link is not in entries", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    symlinkSync("a.txt", join(f.workspace, "link"));
    vi.spyOn(fs.promises, "readlink").mockRejectedValue(ioError("EPERM"));

    const result = await run(f);

    const skipped = [{ path: "link", reason: "unreadable" }];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({ entries: [fileEntry(f, "a.txt")], skipped });
  });

  it("失败不留半份: a non-permission IO error in the middle of copying", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    put(f.workspace, "c/d.txt", "delta\n");
    const before = describeTree(f.workspace);
    const landed: boolean[] = [];
    const created: string[] = [];
    onCopyCreate((path) => {
      created.push(path);
      if (created.length === 2) {
        // The first file is already in place: there is a half snapshot to remove.
        landed.push(existsSync(join(f.snapshot, "tree", "a.txt")));
        throw ioError("EIO");
      }
    });

    const result = await run(f);

    expect(landed).toEqual([true]);
    expect(created).toEqual([join(f.snapshot, "tree", "a.txt"), join(f.snapshot, "tree", "b.txt")]);
    expect(result.outcome).toBe("failed");
    expect(result).toMatchObject({ error: { code: "EIO" } });
    expect(existsSync(f.snapshot)).toBe(false);
    expect(readdirSync(join(f.snapshots, W))).toEqual([]);
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("失败不留半份: the workspace root replaced by a regular file", async () => {
    const f = fixture();
    rmSync(f.workspace, { recursive: true });
    writeFileSync(f.workspace, "not a directory\n");

    const result = await run(f);

    expect(result.outcome).toBe("failed");
    expect(existsSync(f.snapshot)).toBe(false);
    expect(readFileSync(f.workspace, "utf8")).toBe("not a directory\n");
  });

  it("fails without following a workspace root that is a symbolic link, or one that is gone", async () => {
    const f = fixture();
    const real = join(f.workspace, "..", "real");
    mkdirSync(real);
    put(real, "a.txt", "alpha\n");
    rmSync(f.workspace, { recursive: true });
    symlinkSync(real, f.workspace);

    expect((await run(f)).outcome).toBe("failed");
    expect(existsSync(f.snapshot)).toBe(false);

    rmSync(f.workspace);
    expect(await run(f)).toMatchObject({ outcome: "failed", error: { code: "ENOENT" } });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("fails on a snapshot directory it did not write, and leaves that one alone", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    expect((await run(f)).outcome).toBe("ok");
    const first = describeTree(f.snapshot);
    put(f.workspace, "a.txt", "changed\n");

    const result = await run(f);

    expect(result).toMatchObject({ outcome: "failed", error: { code: "EEXIST" } });
    expect(describeTree(f.snapshot)).toEqual(first);
    expect(readFileSync(join(f.snapshot, "tree", "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("keeps each message's snapshot of one workspace apart", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "one\n");
    expect((await run(f)).outcome).toBe("ok");
    put(f.workspace, "a.txt", "two\n");

    const second = await run(f, { userMessageId: 43 });

    expect(second.outcome).toBe("ok");
    expect(readdirSync(join(f.snapshots, W)).sort()).toEqual(["42", "43"]);
    expect(readFileSync(join(f.snapshot, "tree", "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(f.snapshots, W, "43", "tree", "a.txt"), "utf8")).toBe("two\n");
  });
});

describe("快照期间可能有写入者", () => {
  it("a file swapped for a link to an outside file is not followed: failed, nothing kept", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    const victim = join(f.workspace, "b.txt");
    swapAfterLstat(victim, () => {
      rmSync(victim);
      symlinkSync(f.outside, victim);
    });

    const result = await run(f);

    expect(snapshotContents(f)).not.toContain(OUTSIDE_BYTES);
    expect(result).toMatchObject({ outcome: "failed", error: { code: "ELOOP" } });
    expect(existsSync(f.snapshot)).toBe(false);
    expect(snapshotContents(f)).toEqual([]);
    expect(readFileSync(f.outside, "utf8")).toBe(OUTSIDE_BYTES);
  });

  it("a file swapped for a FIFO does not hang the snapshot: failed, its directory changed", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    put(f.workspace, "c.txt", "charlie\n");
    const victim = join(f.workspace, "b.txt");
    releaseAfterTest(victim);
    // The names of the root stay what they were: its times are what tells (#1190).
    setPast(f.workspace);
    swapAfterLstat(victim, () => {
      waitForClock(f, f.workspace);
      rmSync(victim);
      execFileSync("mkfifo", [victim]);
    });

    const result = await run(f);

    expect(result.outcome).toBe("failed");
    expect(existsSync(f.snapshot)).toBe(false);
    expect(readdirSync(f.workspace).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(lstatSync(victim).isFIFO()).toBe(true);
  }, 5000);

  it("登记的残余 — a swapped parent directory: the entry itself is still not followed", async () => {
    // Not claimed: that the walk stays inside the workspace once `d` points elsewhere. Had
    // `elsewhere/inner.txt` been a regular file it would have been copied (design D9, task 20.3).
    const f = fixture();
    put(f.workspace, "d/inner.txt", "inner\n");
    const elsewhere = join(f.workspace, "..", "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(f.outside, join(elsewhere, "inner.txt"));
    const parent = join(f.workspace, "d");
    swapAfterLstat(join(parent, "inner.txt"), () => {
      rmSync(parent, { recursive: true });
      symlinkSync(elsewhere, parent);
    });

    const result = await run(f);

    expect(snapshotContents(f)).not.toContain(OUTSIDE_BYTES);
    expect(result).toMatchObject({ outcome: "failed", error: { code: "ELOOP" } });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("the manifest describes the file that was opened, not the one that was classified", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n", 0o644);
    const victim = join(f.workspace, "a.txt");
    swapAfterLstat(victim, () => {
      appendFileSync(victim, "appended after lstat\n");
      chmodSync(victim, 0o640);
    });

    const result = await run(f);

    expect(result).toEqual({ outcome: "ok", skipped: [] });
    const copy = join(f.snapshot, "tree", "a.txt");
    expect(readFileSync(copy, "utf8")).toBe("alpha\nappended after lstat\n");
    expect(lstatSync(copy).size).toBe(27);
    expect(manifestOf(f).entries).toEqual([{ ...fileEntry(f, "a.txt"), size: 27, mode: 0o640 }]);
  });

  it("a file larger than one read is copied whole", async () => {
    const f = fixture();
    const bytes = Buffer.alloc(200 * 1024 + 7);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 31 + (i >> 9)) & 0xff;
    }
    writeFileSync(join(f.workspace, "big.bin"), bytes);

    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });

    expect(readFileSync(join(f.snapshot, "tree", "big.bin")).equals(bytes)).toBe(true);
    expect(manifestOf(f).entries).toEqual([{ ...fileEntry(f, "big.bin"), size: 204807 }]);
  });

  it("a permission error creating the copy is not `unreadable`: failed, nothing kept", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    onCopyCreate((path) => {
      if (path === join(f.snapshot, "tree", "b.txt")) {
        throw ioError("EACCES");
      }
    });

    const result = await run(f);

    expect(result).toMatchObject({ outcome: "failed", error: { code: "EACCES" } });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("a permission error in the middle of reading a file leaves no partial copy of it", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === join(f.workspace, "a.txt")) {
        handle.read = () => Promise.reject(ioError("EACCES"));
      }
      return handle;
    });

    const result = await run(f);

    const skipped = [{ path: "a.txt", reason: "unreadable" }];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({ entries: [fileEntry(f, "b.txt")], skipped });
    expect(Object.keys(describeTree(join(f.snapshot, "tree")))).toEqual(["b.txt"]);
  });
});
