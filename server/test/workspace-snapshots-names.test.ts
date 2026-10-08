/**
 * Issue #1148 (task 10.4a) workspace-snapshots「快照内容规则」(列举后消失的条目不使快照失败、
 * 非 UTF-8 文件名被跳过而不使快照失败) and「还原」(非 UTF-8 文件名的条目不被当作多余条目删除).
 *
 * An entry vanishes for real wherever that can be arranged: the test removes it between two
 * calls of the walk, and the error is the file system's own. A name that is not valid UTF-8
 * exists only on Linux (APFS refuses to create one), so each rule about such names is tested
 * twice: on every platform with the name added to a listing, and on Linux with the entry on disk.
 */
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  type PathLike,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { splitNames } from "../src/workspaces/snapshots.js";
import {
  afterListing,
  contentsOf,
  describeTree,
  dirEntry,
  type Fixture,
  fileEntry,
  fixture,
  ioError,
  manifestOf,
  onCopyCreate,
  onListing,
  put,
  restoreRun,
  run,
  snapshot,
  stateOf,
  swapAfterLstat,
} from "./workspace-snapshots-helpers.js";

// APFS refuses a file name that is not valid UTF-8 (EILSEQ); ext4, xfs, overlayfs take any bytes.
const BYTE_NAMES = process.platform === "linux";

/** 「中文.txt」 in GBK: the name of the spec's scenario. */
const GBK = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]);
const GBK_LOSSY = "����.txt";
const FF_TXT = Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]);
const FE_TXT = Buffer.from([0xfe, 0x2e, 0x74, 0x78, 0x74]);
const BAD_DIR = Buffer.from([0x62, 0xff, 0x64]);

type Listing = (path: PathLike, options: { encoding: "buffer" }) => Promise<Buffer[]>;

/** Every path the calls of these `fs.promises` functions were given, as strings. */
function pathsGivenTo(...names: (keyof typeof fs.promises)[]): () => string[] {
  const spies = names.map((name) => vi.spyOn(fs.promises, name as "lstat"));
  return () => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
}

function treeOf(f: Fixture): string[] {
  return Object.keys(describeTree(join(f.snapshot, "tree")));
}

function bytePath(...parts: (string | Buffer)[]): Buffer {
  return Buffer.from(parts.map((part) => Buffer.from(part).toString("latin1")).join("/"), "latin1");
}

/** Every path under `root`, listed as bytes; each byte is one latin1 character of the result. */
function byteTree(root: string, rel?: Buffer): string[] {
  const seen: string[] = [];
  const dir = rel === undefined ? Buffer.from(root) : bytePath(root, rel);
  for (const name of readdirSync(dir, { encoding: "buffer" })) {
    const path = rel === undefined ? name : bytePath(rel, name);
    seen.push(path.toString("latin1"));
    if (lstatSync(bytePath(root, path)).isDirectory()) {
      seen.push(...byteTree(root, path));
    }
  }
  return seen.sort();
}

function latin1(...parts: (string | Buffer)[]): string {
  return bytePath(...parts).toString("latin1");
}

/** The manifest file is UTF-8 without a single invalid byte, and parses. */
function strictManifest(f: Fixture): unknown {
  const bytes = readFileSync(join(f.snapshot, "manifest.json"));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

describe("快照内容规则 — 列举后消失的条目不使快照失败", () => {
  it("a file removed after the root was listed and before its lstat is left out; the rest is there", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "gone.txt", "gone\n");
    put(f.workspace, "d/x.txt", "x\n");
    afterListing(f.workspace, () => rmSync(join(f.workspace, "gone.txt")));

    const result = await run(f);

    expect(result).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), dirEntry(f, "d"), fileEntry(f, "d/x.txt")],
      skipped: [],
      incomplete: true,
    });
    expect(treeOf(f)).toEqual(["a.txt", "d", "d/x.txt"]);
  });

  it.each([
    {
      what: "a file removed after its lstat and before its open",
      make: (f: Fixture) => put(f.workspace, "gone", "gone\n"),
      vanish: (path: string) => rmSync(path),
    },
    {
      what: "a symbolic link removed after its lstat and before its readlink",
      make: (f: Fixture) => symlinkSync("a.txt", join(f.workspace, "gone")),
      vanish: (path: string) => unlinkSync(path),
    },
    {
      what: "a directory removed whole after it was judged a directory and before its listing",
      make: (f: Fixture) => {
        put(f.workspace, "gone/x.txt", "x\n");
        put(f.workspace, "gone/deep/y.txt", "y\n");
      },
      vanish: (path: string) => rmSync(path, { recursive: true }),
    },
  ])("$what: ok, no entry of it or below it, nothing skipped, nothing under tree/", async (c) => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    c.make(f);
    put(f.workspace, "z.txt", "zulu\n");
    const gone = join(f.workspace, "gone");
    swapAfterLstat(gone, () => c.vanish(gone));

    const result = await run(f);

    expect(existsSync(gone)).toBe(false);
    expect(result).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), fileEntry(f, "z.txt")],
      skipped: [],
      incomplete: true,
    });
    expect(treeOf(f)).toEqual(["a.txt", "z.txt"]);
  });

  it("ENOTDIR: a listed directory replaced by a file — its children are left out, the walk goes on", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "d/x.txt", "x\n");
    put(f.workspace, "d/y.txt", "y\n");
    put(f.workspace, "z.txt", "zulu\n");
    const d = join(f.workspace, "d");
    // `d` was a directory when it was classified and listed: that is what the manifest says.
    const listed = dirEntry(f, "d");
    afterListing(d, () => {
      rmSync(d, { recursive: true });
      writeFileSync(d, "a file now\n");
    });
    const lstat = vi.spyOn(fs.promises, "lstat");

    const result = await run(f);

    const refused = await Promise.allSettled(lstat.mock.results.map((call) => call.value));
    expect(
      refused.flatMap((call) => (call.status === "rejected" ? [call.reason.code] : [])),
    ).toEqual(["ENOTDIR", "ENOTDIR"]);
    expect(result).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), listed, fileEntry(f, "z.txt")],
      skipped: [],
      incomplete: true,
    });
    expect(treeOf(f)).toEqual(["a.txt", "d", "z.txt"]);
  });

  it("a file removed after it was opened is still copied from its handle", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    const recorded = fileEntry(f, "a.txt");
    onCopyCreate((path) => {
      if (path === join(f.snapshot, "tree", "a.txt")) {
        rmSync(join(f.workspace, "a.txt"));
      }
    });

    const result = await run(f);

    expect(result).toEqual({ outcome: "ok", skipped: [] });
    // Unlinking moves the change time; the handle was read before that.
    expect(manifestOf(f)).toEqual({ entries: [recorded], skipped: [] });
    expect(readFileSync(join(f.snapshot, "tree", "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("the workspace root removed after it was checked and before it is listed: failed", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    swapAfterLstat(f.workspace, () => rmSync(f.workspace, { recursive: true }));

    const result = await run(f);

    expect(result).toMatchObject({ outcome: "failed", error: { code: "ENOENT" } });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("ENOENT from the snapshot's own side is no vanished entry: failed, nothing kept", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    onCopyCreate((path) => {
      if (path === join(f.snapshot, "tree", "b.txt")) {
        throw ioError("ENOENT");
      }
    });

    const result = await run(f);

    expect(result).toMatchObject({ outcome: "failed", error: { code: "ENOENT" } });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it.each(["lstat", "readdir"] as const)(
    "an error of %s that is not about a missing entry (EIO) still fails the snapshot",
    async (call) => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "d/x.txt", "x\n");
      const real = fs.promises[call] as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, call).mockImplementation(((...args: unknown[]) =>
        args[0] === join(f.workspace, "d")
          ? Promise.reject(ioError("EIO"))
          : real(...args)) as never);

      const result = await run(f);

      expect(result).toMatchObject({ outcome: "failed", error: { code: "EIO" } });
      expect(existsSync(f.snapshot)).toBe(false);
    },
  );
});

describe("按字节取名 — which names are valid UTF-8", () => {
  it("a name whose bytes decode and encode back to themselves is kept, decoded", () => {
    const valid = ["a.txt", "中文.txt", "é", "😀.png", "� literal", " lead", "﻿bom"];

    const { names, lossy } = splitNames(valid.map((name) => Buffer.from(name, "utf8")));

    expect(lossy).toEqual([]);
    expect(names).toEqual([...valid].sort());
  });

  it.each([
    { what: "GBK bytes", bytes: [...GBK], lossy: GBK_LOSSY },
    { what: "a lone 0xFF", bytes: [0xff, 0x2e, 0x74, 0x78, 0x74], lossy: "�.txt" },
    { what: "a lone continuation byte", bytes: [0x61, 0x80, 0x62], lossy: "a�b" },
    { what: "a sequence cut short", bytes: [0x61, 0xe4, 0xb8], lossy: "a�" },
    { what: "an overlong encoding of `/`", bytes: [0xc0, 0xaf], lossy: "��" },
    { what: "an encoded surrogate", bytes: [0xed, 0xa0, 0x80], lossy: "���" },
  ])("$what does not round-trip: listed apart, by its lossy decoding", ({ bytes, lossy }) => {
    const split = splitNames([Buffer.from("ok"), Buffer.from(bytes)]);

    expect(split).toEqual({ names: ["ok"], lossy: [lossy] });
  });

  it("valid names keep the order of a string sort, not of their bytes; equal lossy names both stay", () => {
    // U+FF5E is EF BD 9E, the emoji F0 9F 98 80: bytes put the emoji last, strings put it first.
    const raw = ["b", "～", "😀", "Z", "a"].map((name) => Buffer.from(name, "utf8"));

    const split = splitNames([FF_TXT, ...raw, FE_TXT, BAD_DIR]);

    expect(split.names).toEqual(["Z", "a", "b", "😀", "～"]);
    expect(split.lossy).toEqual(["b�d", "�.txt", "�.txt"]);
  });
});

describe("非 UTF-8 文件名 — a listing that names one (every platform)", () => {
  it("take records it as name_encoding under its parent's path and reads nothing of it", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "d/x.txt", "x\n");
    const listing = fs.promises.readdir as unknown as Listing;
    vi.spyOn(fs.promises, "readdir").mockImplementation((async (path, options) => [
      ...(await listing(path, options)),
      ...(path === f.workspace ? [GBK, BAD_DIR] : [FF_TXT, FE_TXT]),
    ]) as Listing as unknown as typeof fs.promises.readdir);
    const given = pathsGivenTo("lstat", "open", "readlink");

    const result = await run(f);

    const skipped = [
      { path: "b�d", reason: "name_encoding" },
      { path: GBK_LOSSY, reason: "name_encoding" },
      { path: "d/�.txt", reason: "name_encoding" },
      { path: "d/�.txt", reason: "name_encoding" },
    ];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(strictManifest(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), dirEntry(f, "d"), fileEntry(f, "d/x.txt")],
      skipped,
    });
    expect(treeOf(f)).toEqual(["a.txt", "d", "d/x.txt"]);
    expect(given().filter((path) => path.includes("�"))).toEqual([]);
    expect(given()).toContain(join(f.workspace, "d", "x.txt"));
  });

  it("restore neither reads, deletes nor counts it, at the root and in a manifest directory", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "d/x.txt", "x\n");
    await snapshot(f);
    put(f.workspace, "extra.txt", "extra\n");
    onListing(f.workspace, (names) => [...names, GBK, BAD_DIR]);
    const given = pathsGivenTo("lstat", "open", "readlink", "unlink", "rm", "rmdir", "rename");

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 1, skipped: [], failed: [] });
    expect(given().filter((path) => path.includes("�"))).toEqual([]);
    expect(given()).toContain(join(f.workspace, "extra.txt"));
    expect(readdirSync(f.workspace).sort()).toEqual(["a.txt", "d"]);
  });
});

/** Adds `items` to the `skipped` of the fixture's manifest, as a `take` that met them would. */
function addSkipped(f: Fixture, items: { path: string; reason: string }[]): void {
  const manifest = manifestOf(f);
  manifest.skipped.push(...items);
  writeFileSync(join(f.snapshot, "manifest.json"), JSON.stringify(manifest));
}

describe("还原 — a name_encoding path is for display and protects nothing by its string", () => {
  /** A valid name that is U+FFFD itself, and a directory the snapshot has. */
  function taken(f: Fixture): void {
    put(f.workspace, "\uFFFD.txt", "one\n");
    put(f.workspace, "d/keep.txt", "keep\n");
  }

  /** What a turn did afterwards: the file rewritten, a new file with a valid name in `d/`. */
  function changed(f: Fixture): void {
    put(f.workspace, "\uFFFD.txt", "changed\n");
    put(f.workspace, "d/\uFFFD", "new\n");
  }

  it("an entry and an extra file whose paths equal name_encoding items: written back, removed", async () => {
    const f = fixture();
    taken(f);
    await snapshot(f);
    const skipped = [
      { path: "\uFFFD.txt", reason: "name_encoding" },
      { path: "d/\uFFFD", reason: "name_encoding" },
    ];
    addSkipped(f, skipped);
    changed(f);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 1, skipped, failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      d: "dir",
      "d/keep.txt": "keep\n",
      "\uFFFD.txt": "one\n",
    });
  });

  it("the same two paths skipped as excluded are protected by path: nothing is touched", async () => {
    const f = fixture();
    taken(f);
    await snapshot(f);
    const skipped = [
      { path: "\uFFFD.txt", reason: "excluded" },
      { path: "d/\uFFFD", reason: "excluded" },
    ];
    addSkipped(f, skipped);
    changed(f);
    const before = stateOf(f.workspace);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 0, skipped, failed: [] });
    expect(stateOf(f.workspace)).toEqual(before);
  });

  it("the parent of a name_encoding path must still be a directory of the manifest", async () => {
    const f = fixture();
    taken(f);
    await snapshot(f);
    addSkipped(f, [{ path: "nowhere/\uFFFD", reason: "name_encoding" }]);
    const before = stateOf(f.workspace);

    await expect(restoreRun(f)).rejects.toThrow("parent is not a directory entry");
    expect(stateOf(f.workspace)).toEqual(before);
  });
});

describe("非 UTF-8 文件名 — on disk (Linux)", () => {
  it.skipIf(!BYTE_NAMES)(
    "非 UTF-8 文件名被跳过而不使快照失败: the file and the directory are skipped whole",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      writeFileSync(bytePath(f.workspace, GBK), "gbk name\n");
      mkdirSync(bytePath(f.workspace, BAD_DIR));
      writeFileSync(bytePath(f.workspace, BAD_DIR, "inner.txt"), "inner\n");
      const before = byteTree(f.workspace);

      const result = await run(f);

      const skipped = [
        { path: "b�d", reason: "name_encoding" },
        { path: GBK_LOSSY, reason: "name_encoding" },
      ];
      expect(result).toEqual({ outcome: "ok", skipped });
      expect(strictManifest(f)).toEqual({ entries: [fileEntry(f, "a.txt")], skipped });
      expect(byteTree(join(f.snapshot, "tree"))).toEqual(["a.txt"]);
      expect(byteTree(f.workspace)).toEqual(before);
      expect(before).toEqual(
        ["a.txt", latin1(BAD_DIR), latin1(BAD_DIR, "inner.txt"), latin1(GBK)].sort(),
      );
    },
  );

  it.skipIf(!BYTE_NAMES)(
    "非 UTF-8 文件名的条目不被当作多余条目删除: B and C stay, new/ goes with what is in it",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "one\n");
      mkdirSync(join(f.workspace, "d"));
      const b = bytePath(f.workspace, "d", FF_TXT);
      writeFileSync(b, "B\n");
      await snapshot(f);
      const skipped = [{ path: "d/�.txt", reason: "name_encoding" }];
      expect(manifestOf(f).skipped).toEqual(skipped);

      put(f.workspace, "a.txt", "changed\n");
      const c = bytePath(f.workspace, GBK);
      writeFileSync(c, "C\n");
      mkdirSync(join(f.workspace, "new", "sub"), { recursive: true });
      writeFileSync(bytePath(f.workspace, "new", FE_TXT), "new\n");
      writeFileSync(bytePath(f.workspace, "new", "sub", GBK), "deeper\n");
      mkdirSync(bytePath(f.workspace, "new", BAD_DIR));
      writeFileSync(bytePath(f.workspace, "new", BAD_DIR, "in.txt"), "in\n");
      const kept = [b, c].map((path) => lstatSync(path));

      const result = await restoreRun(f);

      expect(result).toEqual({ restored: 1, removed: 1, skipped, failed: [] });
      expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("one\n");
      expect(byteTree(f.workspace)).toEqual(
        ["a.txt", "d", latin1("d", FF_TXT), latin1(GBK)].sort(),
      );
      expect(readFileSync(b, "utf8")).toBe("B\n");
      expect(readFileSync(c, "utf8")).toBe("C\n");
      // Not rewritten either: the same inodes, never written or renamed over.
      expect(
        [b, c].map((path) => lstatSync(path)).map((s) => [s.ino, s.mtimeMs, s.ctimeMs]),
      ).toEqual(kept.map((s) => [s.ino, s.mtimeMs, s.ctimeMs]));
    },
  );

  it.skipIf(!BYTE_NAMES)(
    "two names of one directory with the same lossy decoding are both skipped and both kept",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      writeFileSync(bytePath(f.workspace, FF_TXT), "ff\n");
      writeFileSync(bytePath(f.workspace, FE_TXT), "fe\n");

      const taken = await run(f);

      const skipped = [
        { path: "�.txt", reason: "name_encoding" },
        { path: "�.txt", reason: "name_encoding" },
      ];
      expect(taken).toEqual({ outcome: "ok", skipped });
      expect(strictManifest(f)).toEqual({ entries: [fileEntry(f, "a.txt")], skipped });

      put(f.workspace, "later.txt", "later\n");
      const result = await restoreRun(f);

      expect(result).toEqual({ restored: 0, removed: 1, skipped, failed: [] });
      expect(byteTree(f.workspace)).toEqual(["a.txt", latin1(FE_TXT), latin1(FF_TXT)].sort());
      expect(readFileSync(bytePath(f.workspace, FF_TXT), "utf8")).toBe("ff\n");
      expect(readFileSync(bytePath(f.workspace, FE_TXT), "utf8")).toBe("fe\n");
    },
  );

  it.skipIf(!BYTE_NAMES)(
    "a valid name equal to the lossy decoding of its sibling is restored; the sibling is not touched",
    async () => {
      const f = fixture();
      put(f.workspace, "\uFFFD.txt", "one\n");
      const bad = bytePath(f.workspace, FF_TXT);
      writeFileSync(bad, "ff\n");

      const taken = await run(f);

      const skipped = [{ path: "\uFFFD.txt", reason: "name_encoding" }];
      expect(taken).toEqual({ outcome: "ok", skipped });
      expect(strictManifest(f)).toEqual({ entries: [fileEntry(f, "\uFFFD.txt")], skipped });

      put(f.workspace, "\uFFFD.txt", "changed\n");
      writeFileSync(bad, "ff, rewritten\n");
      const kept = lstatSync(bad);
      const result = await restoreRun(f);

      expect(result).toEqual({ restored: 1, removed: 0, skipped, failed: [] });
      expect(readFileSync(join(f.workspace, "\uFFFD.txt"), "utf8")).toBe("one\n");
      expect(byteTree(f.workspace)).toEqual([latin1("\uFFFD.txt"), latin1(FF_TXT)].sort());
      expect(readFileSync(bad, "utf8")).toBe("ff, rewritten\n");
      const now = lstatSync(bad);
      expect([now.ino, now.mtimeMs, now.ctimeMs]).toEqual([kept.ino, kept.mtimeMs, kept.ctimeMs]);
    },
  );
});
