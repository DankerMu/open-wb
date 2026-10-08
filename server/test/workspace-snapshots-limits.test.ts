/**
 * Issue #938 workspace-snapshots「快照上限与配置」(单文件上限、总量与条目上限、版本库目录进快照):
 * the three numeric limits of `take` on real temporary directories. Sizes and expected entries
 * are literals of what each test wrote; the walk visits names in sorted order, which is what
 * makes "the file that crosses the limit" a fixed one.
 */
import fs, {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentSettings } from "../src/agent-config.js";
import {
  describeTree,
  dirEntry,
  expectTorn,
  type Fixture,
  fileEntry,
  fixture,
  ioError,
  manifestOf,
  put,
  run,
  swapAfterLstat,
  W,
  watchOpens,
  writeAfterFstat,
} from "./workspace-snapshots-helpers.js";

const TEN = "0123456789";
const ELEVEN = "0123456789a";

function treeOf(f: Fixture): string[] {
  return Object.keys(describeTree(join(f.snapshot, "tree")));
}

describe("快照上限与配置", () => {
  it("单文件上限: ok.bin (10 bytes) is in, big.bin (11 bytes) is skipped as too_large, unread", async () => {
    const f = fixture();
    put(f.workspace, "ok.bin", TEN);
    put(f.workspace, "big.bin", ELEVEN);
    const opened = watchOpens(
      f,
      () => undefined,
      (path, handle) => {
        if (path === "big.bin") {
          handle.read = () => Promise.reject(ioError("EIO"));
        }
      },
    );

    const result = await run(f, { maxFileBytes: 10 });

    const skipped = [{ path: "big.bin", reason: "too_large" }];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({ entries: [fileEntry(f, "ok.bin")], skipped });
    expect(treeOf(f)).toEqual(["ok.bin"]);
    expect(readFileSync(join(f.snapshot, "tree", "ok.bin"), "utf8")).toBe(TEN);
    expect(existsSync(join(f.snapshot, "tree", "big.bin"))).toBe(false);
    expect(opened).toEqual(["big.bin", "ok.bin", "tree/ok.bin"]);
  });

  it("单文件上限 is measured on the opened file, not on the one that was classified", async () => {
    const f = fixture();
    put(f.workspace, "grown.bin", TEN);
    const victim = join(f.workspace, "grown.bin");
    swapAfterLstat(victim, () => appendFileSync(victim, "a"));

    const result = await run(f, { maxFileBytes: 10 });

    const skipped = [{ path: "grown.bin", reason: "too_large" }];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({ entries: [], skipped });
    expect(treeOf(f)).toEqual([]);
  });

  it("总量与条目上限: total 20 with three 10-byte files is too_large, nothing kept", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    put(f.workspace, "b.bin", TEN);
    put(f.workspace, "c.bin", TEN);
    const before = describeTree(f.workspace);

    const result = await run(f, { maxTotalBytes: 20 });

    expect(result).toEqual({ outcome: "too_large" });
    expect(existsSync(f.snapshot)).toBe(false);
    expect(readdirSync(join(f.snapshots, W))).toEqual([]);
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("总量与条目上限: entry limit 2 with three files is too_large, nothing kept", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", "a");
    put(f.workspace, "b.bin", "b");
    put(f.workspace, "c.bin", "c");

    const result = await run(f, { maxEntries: 2 });

    expect(result).toEqual({ outcome: "too_large" });
    expect(existsSync(f.snapshot)).toBe(false);
    expect(readdirSync(join(f.snapshots, W))).toEqual([]);
  });

  it("总量与条目上限: a total of exactly 20 bytes in exactly 2 entries is not over either limit", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    put(f.workspace, "b.bin", TEN);

    const result = await run(f, { maxFileBytes: 10, maxTotalBytes: 20, maxEntries: 2 });

    expect(result).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f).entries).toEqual([fileEntry(f, "a.bin"), fileEntry(f, "b.bin")]);
    expect(treeOf(f)).toEqual(["a.bin", "b.bin"]);
  });

  it("版本库目录进快照: with the default configuration .git is copied, node_modules excluded", async () => {
    const f = fixture();
    put(f.workspace, ".git/HEAD", "ref: refs/heads/main\n");
    put(f.workspace, ".git/refs/heads/main", "0123456789abcdef0123456789abcdef01234567\n");
    put(f.workspace, ".git/objects/ab/cdef", "x\u0001\u0002 not really zlib\n");
    put(f.workspace, "node_modules/x.js", "module.exports = 1;\n");
    const defaults = resolveAgentSettings({}, join(f.workspace, ".."));
    expect(defaults.snapshotMaxFileBytes).toBe(20_971_520);
    expect(defaults.snapshotMaxTotalBytes).toBe(524_288_000);
    expect(defaults.snapshotMaxEntries).toBe(50_000);

    const result = await run(f, {
      excludeNames: defaults.snapshotExcludeNames,
      maxFileBytes: defaults.snapshotMaxFileBytes,
      maxTotalBytes: defaults.snapshotMaxTotalBytes,
      maxEntries: defaults.snapshotMaxEntries,
    });

    const skipped = [{ path: "node_modules", reason: "excluded" }];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({
      entries: [
        dirEntry(f, ".git"),
        fileEntry(f, ".git/HEAD"),
        dirEntry(f, ".git/objects"),
        dirEntry(f, ".git/objects/ab"),
        fileEntry(f, ".git/objects/ab/cdef"),
        dirEntry(f, ".git/refs"),
        dirEntry(f, ".git/refs/heads"),
        fileEntry(f, ".git/refs/heads/main"),
      ],
      skipped,
    });
    for (const path of [".git/HEAD", ".git/refs/heads/main", ".git/objects/ab/cdef"]) {
      expect(
        readFileSync(join(f.snapshot, "tree", path)).equals(readFileSync(join(f.workspace, path))),
        path,
      ).toBe(true);
    }
    expect(readFileSync(join(f.snapshot, "tree", ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/main\n",
    );
    expect(existsSync(join(f.snapshot, "tree", "node_modules"))).toBe(false);
  });
});

describe("计量口径", () => {
  it("directories and symbolic links are entries: three of them fit a limit of 3, a fourth does not", async () => {
    const f = fixture();
    put(f.workspace, "d/f.txt", "f\n");
    symlinkSync("d/f.txt", join(f.workspace, "link"));

    expect(await run(f, { maxEntries: 3 })).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f).entries).toEqual([
      dirEntry(f, "d"),
      fileEntry(f, "d/f.txt"),
      { path: "link", type: "symlink", target: "d/f.txt" },
    ]);

    put(f.workspace, "z.txt", "z\n");
    expect(await run(f, { maxEntries: 3, userMessageId: 43 })).toEqual({ outcome: "too_large" });
    expect(readdirSync(join(f.snapshots, W))).toEqual(["42"]);
  });

  it("a directory or a symbolic link that would be one entry too many stops the walk too", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "a\n");
    mkdirSync(join(f.workspace, "d"));

    expect(await run(f, { maxEntries: 1 })).toEqual({ outcome: "too_large" });
    expect(existsSync(f.snapshot)).toBe(false);

    fs.rmdirSync(join(f.workspace, "d"));
    symlinkSync("a.txt", join(f.workspace, "link"));
    expect(await run(f, { maxEntries: 1 })).toEqual({ outcome: "too_large" });
    expect(existsSync(f.snapshot)).toBe(false);

    expect(await run(f, { maxEntries: 2 })).toEqual({ outcome: "ok", skipped: [] });
  });

  it("what is skipped counts toward neither limit: an over-limit file, an excluded directory", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    put(f.workspace, "big.bin", ELEVEN);
    put(f.workspace, "c.bin", TEN);
    put(f.workspace, "node_modules/x.js", "x\n");

    const result = await run(f, { maxFileBytes: 10, maxTotalBytes: 20, maxEntries: 2 });

    const skipped = [
      { path: "big.bin", reason: "too_large" },
      { path: "node_modules", reason: "excluded" },
    ];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.bin"), fileEntry(f, "c.bin")],
      skipped,
    });
    expect(treeOf(f)).toEqual(["a.bin", "c.bin"]);
  });

  it("an empty file is an entry of no bytes", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    put(f.workspace, "empty", "");

    expect(await run(f, { maxTotalBytes: 10, maxEntries: 2 })).toEqual({
      outcome: "ok",
      skipped: [],
    });
    expect(readFileSync(join(f.snapshot, "tree", "empty")).length).toBe(0);
    expect(manifestOf(f).entries).toEqual([fileEntry(f, "a.bin"), fileEntry(f, "empty")]);

    expect(await run(f, { maxTotalBytes: 10, maxEntries: 1, userMessageId: 43 })).toEqual({
      outcome: "too_large",
    });
  });

  it("refuses limits that are not positive integers, before touching the disk", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, "10"];
    for (const value of bad as number[]) {
      for (const key of ["maxFileBytes", "maxTotalBytes", "maxEntries"]) {
        await expect(run(f, { [key]: value }), `${key}=${String(value)}`).rejects.toThrow(
          TypeError,
        );
      }
    }
    expect(readdirSync(f.snapshots)).toEqual([]);
  });
});

describe("越限即停", () => {
  it("nothing is read or created once the total would be crossed, and the half snapshot is removed", async () => {
    const f = fixture();
    for (const name of ["a.bin", "b.bin", "c.bin", "d.bin"]) {
      put(f.workspace, name, TEN);
    }
    put(f.workspace, "e/f.bin", TEN);
    const before = describeTree(f.workspace);
    const landed: string[][] = [];
    const listed: string[] = [];
    const readdir = fs.promises.readdir;
    vi.spyOn(fs.promises, "readdir").mockImplementation((async (
      path: string,
      options: { encoding: "buffer" },
    ) => {
      listed.push(path);
      return readdir(path, options);
    }) as typeof readdir);
    // c.bin is the file that would take the total from 20 to 30. It is opened to learn its size;
    // from there on any read, any copy and any other open breaks the snapshot with EIO.
    const opened = watchOpens(
      f,
      (name) => {
        if (name === "c.bin") {
          landed.push(treeOf(f));
        }
        if (name !== "a.bin" && name !== "b.bin" && name !== "c.bin" && !name.startsWith("tree/")) {
          throw ioError("EIO");
        }
        if (name === "tree/c.bin") {
          throw ioError("EIO");
        }
      },
      (path, handle) => {
        if (path === "c.bin") {
          handle.read = () => Promise.reject(ioError("EIO"));
        }
      },
    );

    const result = await run(f, { maxTotalBytes: 20 });

    expect(result).toEqual({ outcome: "too_large" });
    expect(opened).toEqual(["a.bin", "tree/a.bin", "b.bin", "tree/b.bin", "c.bin"]);
    expect(listed).toEqual([f.workspace]);
    // There was a half snapshot to remove.
    expect(landed).toEqual([["a.bin", "b.bin"]]);
    expect(existsSync(f.snapshot)).toBe(false);
    expect(readdirSync(join(f.snapshots, W))).toEqual([]);
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("nothing is read or created once the entry limit would be crossed", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", "a");
    put(f.workspace, "b.bin", "b");
    put(f.workspace, "c.bin", "c");
    const opened = watchOpens(
      f,
      (name) => {
        if (name === "tree/b.bin" || name === "c.bin") {
          throw ioError("EIO");
        }
      },
      (path, handle) => {
        if (path === "b.bin") {
          handle.read = () => Promise.reject(ioError("EIO"));
        }
      },
    );

    const result = await run(f, { maxEntries: 1 });

    expect(result).toEqual({ outcome: "too_large" });
    expect(opened).toEqual(["a.bin", "tree/a.bin", "b.bin"]);
    expect(existsSync(f.snapshot)).toBe(false);
  });
});

// Since #1206 a file that changed while it was copied fails the snapshot, so no copy of another
// length than the one the limits were checked against is ever kept.
describe("快照期间可能有写入者 — 上限仍成立", () => {
  it("bytes appended while a file is copied: failed, no snapshot over the limits is kept", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    put(f.workspace, "b.bin", TEN);
    writeAfterFstat(f, "a.bin", () =>
      appendFileSync(join(f.workspace, "a.bin"), "APPENDED WHILE COPYING"),
    );

    const result = await run(f, { maxFileBytes: 10, maxTotalBytes: 20 });

    expect(readFileSync(join(f.workspace, "a.bin")).length).toBe(32);
    expectTorn(result, "a.bin");
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("a file longer than one read that grows while it is copied: failed too", async () => {
    const f = fixture();
    const bytes = Buffer.alloc(150_000, "x");
    put(f.workspace, "a.bin", bytes.toString("latin1"));
    writeAfterFstat(f, "a.bin", () => appendFileSync(join(f.workspace, "a.bin"), "tail"));

    const result = await run(f, { maxTotalBytes: 150_000 });

    expect(readFileSync(join(f.workspace, "a.bin")).length).toBe(150_004);
    expectTorn(result, "a.bin");
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("a file truncated while it is copied: failed, a shorter copy is not kept", async () => {
    const f = fixture();
    put(f.workspace, "a.bin", TEN);
    put(f.workspace, "b.bin", TEN);
    writeAfterFstat(f, "a.bin", () => truncateSync(join(f.workspace, "a.bin"), 4));

    const result = await run(f, { maxTotalBytes: 20 });

    expect(readFileSync(join(f.workspace, "a.bin"), "utf8")).toBe("0123");
    expectTorn(result, "a.bin");
    expect(existsSync(f.snapshot)).toBe(false);
  });
});
