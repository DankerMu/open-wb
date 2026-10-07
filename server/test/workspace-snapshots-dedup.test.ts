/**
 * Issue #939 workspace-snapshots「未变文件的去重」: the second `take` of a workspace hard-links
 * what did not change from the previous snapshot, on real temporary directories. The first
 * snapshot is message 42 (`f.snapshot`), the second is message 43 with 42 as its previous one.
 * Inodes, link counts and contents are read by the tests' own lstat / readFile; expected
 * manifest entries come from the tests' lstat of the workspace.
 */
import fs, {
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  describeTree,
  dirEntry,
  type Fixture,
  fileEntry,
  fixture,
  ioError,
  MESSAGE_ID,
  manifestOf,
  put,
  run,
  W,
} from "./workspace-snapshots-helpers.js";

const SECOND_ID = 43;
const TEN = "0123456789";
const SIXTEEN = "sixteen bytes..\n";
/** From `<base>/state/snapshots/<workspace>/<message>/tree/` to `<base>/o`: 16 characters. */
const OUTSIDE_FROM_TREE = "../../../../../o";
/** A whole second, so setting it again restores `mtimeMs` exactly. */
const PINNED_SECONDS = 1_700_000_000;
/** Longer than any coarse `ctime` clock tick (Linux: at most 10 ms). */
const CTIME_GAP_MS = 60;

type TakeOverrides = Parameters<typeof run>[1];

/** The same fixture seen from the second snapshot: `manifestOf` and `treeFile` read message 43. */
function secondOf(f: Fixture): Fixture {
  return { ...f, snapshot: join(f.snapshots, W, String(SECOND_ID)) };
}

function takeSecond(f: Fixture, overrides: TakeOverrides = {}) {
  return run(f, { userMessageId: SECOND_ID, previousMessageId: MESSAGE_ID, ...overrides });
}

function treeFile(f: Fixture, path: string): string {
  return join(f.snapshot, "tree", path);
}

function inode(path: string): number {
  return lstatSync(path).ino;
}

/** Every `fs.promises.link` of the walk, as `[source, destination]`, before the real call. */
function watchLinks(intercept: (source: string) => void = () => undefined): string[][] {
  const calls: string[][] = [];
  const link = fs.promises.link;
  vi.spyOn(fs.promises, "link").mockImplementation(async (...args: Parameters<typeof link>) => {
    calls.push([String(args[0]), String(args[1])]);
    intercept(String(args[0]));
    return link(...args);
  });
  return calls;
}

/**
 * Reading the content of any of `targets` (workspace-relative) through its handle, or of any
 * workspace file by path, breaks the snapshot with EIO;
 * returns every path the walk opened, creations under a snapshot included.
 */
function refuseReads(f: Fixture, targets: string[]): string[] {
  const opened: string[] = [];
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const full = String(args[0]);
    opened.push(full);
    const handle = await open(...args);
    if (targets.some((target) => full === join(f.workspace, target))) {
      handle.read = () => Promise.reject(ioError("EIO"));
    }
    return handle;
  });
  const readFile = fs.promises.readFile;
  vi.spyOn(fs.promises, "readFile").mockImplementation((async (
    ...args: Parameters<typeof readFile>
  ) => {
    if (String(args[0]).startsWith(`${f.workspace}/`)) {
      throw ioError("EIO");
    }
    return readFile(...args);
  }) as typeof readFile);
  return opened;
}

/** `path` of the second snapshot was copied, not linked: an inode of its own with `bytes`. */
function expectCopied(f: Fixture, path: string, bytes: string): void {
  const copy = treeFile(secondOf(f), path);
  expect(readFileSync(copy, "utf8")).toBe(bytes);
  expect(lstatSync(copy).nlink).toBe(1);
  expect(lstatSync(copy).mode & 0o7777).toBe(0o600);
  expect(inode(copy)).not.toBe(inode(join(f.workspace, path)));
}

describe("未变文件的去重", () => {
  it("未变文件不重复占用: a.txt is one inode in both snapshots, the rewritten b.txt is two", async () => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "before\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    writeFileSync(join(f.workspace, "b.txt"), "after the first turn\n");

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    const [a1, a2] = [lstatSync(treeFile(f, "a.txt")), lstatSync(treeFile(second, "a.txt"))];
    expect(a2.ino).toBe(a1.ino);
    expect(a2.nlink).toBeGreaterThanOrEqual(2);
    expect(a2.isFile()).toBe(true);
    expect(a2.mode & 0o7777).toBe(0o600);
    expect(readFileSync(treeFile(second, "a.txt"), "utf8")).toBe("alpha\n");

    expect(inode(treeFile(second, "b.txt"))).not.toBe(inode(treeFile(f, "b.txt")));
    expect(lstatSync(treeFile(f, "b.txt")).nlink).toBe(1);
    expect(lstatSync(treeFile(second, "b.txt")).nlink).toBe(1);
    expect(readFileSync(treeFile(f, "b.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(treeFile(second, "b.txt"), "utf8")).toBe("after the first turn\n");

    // Neither snapshot shares an inode with the workspace, and the workspace file is untouched.
    for (const name of ["a.txt", "b.txt"]) {
      const inWorkspace = lstatSync(join(f.workspace, name));
      expect(inWorkspace.nlink, name).toBe(1);
      expect(inode(treeFile(f, name)), name).not.toBe(inWorkspace.ino);
      expect(inode(treeFile(second, name)), name).not.toBe(inWorkspace.ino);
    }
  });

  it("内容变了而 mtime 被改回: same length, same mtime, the second snapshot has the new content", async () => {
    const f = fixture();
    const second = secondOf(f);
    const a = join(f.workspace, "a.txt");
    put(f.workspace, "a.txt", "alpha\n");
    utimesSync(a, PINNED_SECONDS, PINNED_SECONDS);
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    const before = lstatSync(a);

    await sleep(CTIME_GAP_MS);
    writeFileSync(a, "bravo\n");
    utimesSync(a, PINNED_SECONDS, PINNED_SECONDS);
    // Only ctime tells the two apart.
    const after = lstatSync(a);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mtimeMs).toBe(PINNED_SECONDS * 1000);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    expect(readFileSync(treeFile(second, "a.txt"), "utf8")).toBe("bravo\n");
    expect(readFileSync(treeFile(f, "a.txt"), "utf8")).toBe("alpha\n");
    expect(inode(treeFile(second, "a.txt"))).not.toBe(inode(treeFile(f, "a.txt")));
    expect(manifestOf(second).entries).toEqual([fileEntry(f, "a.txt")]);
  });

  it("上一份消失时退为复制: the previous directory is gone, the result is ok and the tree complete", async () => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "src/b.ts", "export const b = 1;\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    rmSync(f.snapshot, { recursive: true });

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    expect(Object.keys(describeTree(join(second.snapshot, "tree")))).toEqual([
      "a.txt",
      "src",
      "src/b.ts",
    ]);
    expectCopied(f, "a.txt", "alpha\n");
    expectCopied(f, "src/b.ts", "export const b = 1;\n");
    expect(manifestOf(second)).toEqual({
      entries: [fileEntry(f, "a.txt"), dirEntry(f, "src"), fileEntry(f, "src/b.ts")],
      skipped: [],
    });
    expect(existsSync(f.snapshot)).toBe(false);
  });

  it("删除较早的一份: the first snapshot directory is deleted, the second's linked file reads whole", async () => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "src/b.ts", "export const b = 1;\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });
    expect(lstatSync(treeFile(second, "a.txt")).nlink).toBe(2);

    rmSync(f.snapshot, { recursive: true });

    expect(readdirSync(join(f.snapshots, W))).toEqual([String(SECOND_ID)]);
    expect(readFileSync(treeFile(second, "a.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(treeFile(second, "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect(lstatSync(treeFile(second, "a.txt")).nlink).toBe(1);
  });
});

describe("命中时只建链接", () => {
  it("an unchanged file is linked from the previous tree and its content is never read", async () => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "src/b.ts", "export const b = 1;\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    const links = watchLinks();
    const opened = refuseReads(f, ["a.txt", "src/b.ts"]);
    const before = describeTree(f.workspace);

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    // The source of a link is the previous snapshot's tree, never the workspace.
    expect(links).toEqual([
      [treeFile(f, "a.txt"), treeFile(second, "a.txt")],
      [treeFile(f, "src/b.ts"), treeFile(second, "src/b.ts")],
    ]);
    // Only the two sources were opened: nothing was created under tree/ by a copy.
    expect(opened).toEqual([join(f.workspace, "a.txt"), join(f.workspace, "src/b.ts")]);
    expect(inode(treeFile(second, "src/b.ts"))).toBe(inode(treeFile(f, "src/b.ts")));
    expect(describeTree(f.workspace)).toEqual(before);
  });

  it("the manifest is the same whether a file was linked or copied", async () => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n", 0o640);
    put(f.workspace, "src/b.ts", "export const b = 1;\n", 0o755);
    put(f.workspace, "node_modules/x.js", "x\n");
    symlinkSync("a.txt", join(f.workspace, "link"));
    expect(await run(f)).toEqual({
      outcome: "ok",
      skipped: [{ path: "node_modules", reason: "excluded" }],
    });
    writeFileSync(join(f.workspace, "src/b.ts"), "export const b = 2; // changed\n");

    const result = await takeSecond(f);
    // A third snapshot of the same workspace without a previous one: everything copied.
    const third = { ...f, snapshot: join(f.snapshots, W, "44") };
    expect(await run(f, { userMessageId: 44 })).toEqual(result);

    const skipped = [{ path: "node_modules", reason: "excluded" }];
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(manifestOf(second)).toEqual({
      entries: [
        fileEntry(f, "a.txt"),
        { path: "link", type: "symlink", target: "a.txt" },
        dirEntry(f, "src"),
        fileEntry(f, "src/b.ts"),
      ],
      skipped,
    });
    expect(manifestOf(second).entries[0]).toMatchObject({ size: 6, mode: 0o640 });
    expect(manifestOf(third)).toEqual(manifestOf(second));
    // a.txt was linked in the second and copied in the third.
    expect(inode(treeFile(second, "a.txt"))).toBe(inode(treeFile(f, "a.txt")));
    expect(inode(treeFile(third, "a.txt"))).not.toBe(inode(treeFile(f, "a.txt")));
    expect(Object.keys(describeTree(join(third.snapshot, "tree")))).toEqual(
      Object.keys(describeTree(join(second.snapshot, "tree"))),
    );
  });

  it("a file that only changed its mode is copied (ctime differs) and the manifest has the new mode", async () => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n", 0o644);
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    await sleep(CTIME_GAP_MS);
    fs.chmodSync(join(f.workspace, "a.txt"), 0o600);

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    expectCopied(f, "a.txt", "alpha\n");
    expect(manifestOf(second).entries).toMatchObject([{ path: "a.txt", mode: 0o600 }]);
  });
});

describe("退路 — 上一份不可用时当作没有", () => {
  const broken: [string, (f: Fixture) => void][] = [
    ["the manifest is missing", (f) => rmSync(join(f.snapshot, "manifest.json"))],
    ["the manifest is not JSON", (f) => writeFileSync(join(f.snapshot, "manifest.json"), "{not")],
    ["the manifest is null", (f) => writeFileSync(join(f.snapshot, "manifest.json"), "null")],
    [
      "the manifest's entries is not a list",
      (f) => writeFileSync(join(f.snapshot, "manifest.json"), '{"entries":5,"skipped":[]}'),
    ],
    [
      "the manifest's entries are not entries",
      (f) =>
        writeFileSync(
          join(f.snapshot, "manifest.json"),
          JSON.stringify({ entries: [null, 7, "a.txt", { path: "a.txt" }, { type: "file" }] }),
        ),
    ],
    ["the previous tree lacks the file", (f) => rmSync(treeFile(f, "a.txt"))],
    ["the previous tree is gone", (f) => rmSync(join(f.snapshot, "tree"), { recursive: true })],
  ];
  it.each(broken)("%s: every file is copied and the result is ok", async (_name, breakIt) => {
    const f = fixture();
    const second = secondOf(f);
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    breakIt(f);

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    expectCopied(f, "a.txt", "alpha\n");
    expect(readFileSync(treeFile(second, "b.txt"), "utf8")).toBe("bravo\n");
    expect(manifestOf(second)).toEqual({
      entries: [fileEntry(f, "a.txt"), fileEntry(f, "b.txt")],
      skipped: [],
    });
  });

  it("a previous id that has no snapshot directory at all behaves like no previous snapshot", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    expectCopied(f, "a.txt", "alpha\n");
    expect(readdirSync(join(f.snapshots, W))).toEqual([String(SECOND_ID)]);
  });

  it("a manifest entry of another type or another size for the same path is not a match", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    const [a, b] = [fileEntry(f, "a.txt"), fileEntry(f, "b.txt")];
    writeFileSync(
      join(f.snapshot, "manifest.json"),
      JSON.stringify({
        entries: [
          { ...a, type: "dir" },
          { ...b, size: 7 },
        ],
        skipped: [],
      }),
    );
    const links = watchLinks();

    expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

    expect(links).toEqual([]);
    expectCopied(f, "a.txt", "alpha\n");
    expectCopied(f, "b.txt", "bravo\n");
  });
});

describe("退路 — 链接不成时经句柄复制", () => {
  it.each(["EMLINK", "ENOENT", "EXDEV", "EPERM", "EACCES"])(
    "link fails with %s: the file is copied, the result is ok, nothing is skipped",
    async (code) => {
      const f = fixture();
      const second = secondOf(f);
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "b.txt", "bravo\n");
      expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
      const links = watchLinks((source) => {
        if (source === treeFile(f, "a.txt")) {
          throw ioError(code);
        }
      });

      expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

      expect(links.map(([source]) => source)).toEqual([treeFile(f, "a.txt"), treeFile(f, "b.txt")]);
      expectCopied(f, "a.txt", "alpha\n");
      expect(inode(treeFile(second, "b.txt"))).toBe(inode(treeFile(f, "b.txt")));
      expect(manifestOf(second)).toEqual({
        entries: [fileEntry(f, "a.txt"), fileEntry(f, "b.txt")],
        skipped: [],
      });
    },
  );

  // The previous tree is written by `take` in a 0700 root; these are damaged ones.
  const damaged: [string, (f: Fixture, copy: string) => void][] = [
    [
      // The link's own lstat size (its target string) and the file it points at are both 16.
      "a symbolic link, as long as the file, to an outside file as long as the file",
      (f, copy) => {
        writeFileSync(join(f.outside, "..", "o"), "OUTER 16 bytes.\n");
        symlinkSync(OUTSIDE_FROM_TREE, copy);
        expect(lstatSync(copy).size).toBe(16);
        expect(readFileSync(copy, "utf8")).toBe("OUTER 16 bytes.\n");
      },
    ],
    ["a hard link to the workspace file", (f, copy) => linkSync(join(f.workspace, "a.txt"), copy)],
    ["a file of another length", (_f, copy) => writeFileSync(copy, "al")],
    ["a directory", (_f, copy) => fs.mkdirSync(copy)],
  ];
  it.each(damaged)(
    "the previous copy is %s: it is not linked, the file is copied",
    async (_n, damage) => {
      const f = fixture();
      put(f.workspace, "a.txt", SIXTEEN);
      expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
      rmSync(treeFile(f, "a.txt"));
      damage(f, treeFile(f, "a.txt"));
      // The manifest still describes the workspace file as it is now (a hard link moved ctime).
      writeFileSync(
        join(f.snapshot, "manifest.json"),
        JSON.stringify({ entries: [fileEntry(f, "a.txt")], skipped: [] }),
      );
      const links = watchLinks();

      expect(await takeSecond(f)).toEqual({ outcome: "ok", skipped: [] });

      expect(links).toEqual([]);
      const copy = treeFile(secondOf(f), "a.txt");
      expect(lstatSync(copy).isFile()).toBe(true);
      expect(readFileSync(copy, "utf8")).toBe(SIXTEEN);
      expect(inode(copy)).not.toBe(inode(join(f.workspace, "a.txt")));
      expect(lstatSync(copy).nlink).toBe(1);
    },
  );
});

describe("被链接的文件照常计入上限", () => {
  /** Four unchanged 10-byte files, all in the first snapshot. */
  async function fourFiles(): Promise<Fixture> {
    const f = fixture();
    for (const name of ["a.bin", "b.bin", "c.bin", "d.bin"]) {
      put(f.workspace, name, TEN);
    }
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    return f;
  }

  it("total 20 with four linked 10-byte files is too_large: no link and no read from c.bin on", async () => {
    const f = await fourFiles();
    const second = secondOf(f);
    const links = watchLinks();
    const opened = refuseReads(f, ["a.bin", "b.bin", "c.bin", "d.bin"]);
    const first = describeTree(f.snapshot);

    expect(await takeSecond(f, { maxTotalBytes: 20 })).toEqual({ outcome: "too_large" });

    expect(links).toEqual([
      [treeFile(f, "a.bin"), treeFile(second, "a.bin")],
      [treeFile(f, "b.bin"), treeFile(second, "b.bin")],
    ]);
    // c.bin is opened to learn its size; d.bin is never reached.
    expect(opened).toEqual(["a.bin", "b.bin", "c.bin"].map((name) => join(f.workspace, name)));
    expect(existsSync(second.snapshot)).toBe(false);
    // The half snapshot's links are gone and the previous snapshot is as it was (ctime aside).
    expect(Object.keys(describeTree(f.snapshot))).toEqual(Object.keys(first));
    expect(lstatSync(treeFile(f, "a.bin")).nlink).toBe(1);
    expect(readFileSync(treeFile(f, "a.bin"), "utf8")).toBe(TEN);
  });

  it("entry limit 1 with linked files is too_large: one link, then nothing", async () => {
    const f = await fourFiles();
    const links = watchLinks();
    const opened = refuseReads(f, ["a.bin", "b.bin", "c.bin", "d.bin"]);

    expect(await takeSecond(f, { maxEntries: 1 })).toEqual({ outcome: "too_large" });

    expect(links.map(([source]) => source)).toEqual([treeFile(f, "a.bin")]);
    expect(opened).toEqual([join(f.workspace, "a.bin"), join(f.workspace, "b.bin")]);
    expect(existsSync(secondOf(f).snapshot)).toBe(false);
  });

  it("four linked files of exactly 40 bytes in exactly 4 entries are within both limits", async () => {
    const f = await fourFiles();
    const second = secondOf(f);

    const result = await takeSecond(f, { maxFileBytes: 10, maxTotalBytes: 40, maxEntries: 4 });

    expect(result).toEqual({ outcome: "ok", skipped: [] });
    for (const name of ["a.bin", "b.bin", "c.bin", "d.bin"]) {
      expect(inode(treeFile(second, name)), name).toBe(inode(treeFile(f, name)));
    }
  });

  it("单文件上限 comes before the comparison: an unchanged file over it is skipped, not linked", async () => {
    const f = await fourFiles();
    const second = secondOf(f);
    const links = watchLinks();

    const result = await takeSecond(f, { maxFileBytes: 9 });

    const skipped = ["a.bin", "b.bin", "c.bin", "d.bin"].map((path) => ({
      path,
      reason: "too_large",
    }));
    expect(result).toEqual({ outcome: "ok", skipped });
    expect(links).toEqual([]);
    expect(describeTree(join(second.snapshot, "tree"))).toEqual({});
    expect(manifestOf(second)).toEqual({ entries: [], skipped });
  });
});

describe("上一份快照的消息 id", () => {
  it("refuses a previous id that is not a positive integer or is this snapshot's own, before touching the disk", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    const links = watchLinks();
    const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, "42", "../42"];
    for (const value of [...bad, SECOND_ID] as number[]) {
      await expect(takeSecond(f, { previousMessageId: value }), String(value)).rejects.toThrow(
        TypeError,
      );
    }
    expect(readdirSync(f.snapshots)).toEqual([]);
    expect(links).toEqual([]);
  });

  it("an absent previous id is no previous snapshot: an existing older snapshot is not linked from", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    const links = watchLinks();

    expect(await run(f, { userMessageId: SECOND_ID })).toEqual({ outcome: "ok", skipped: [] });

    expect(links).toEqual([]);
    expectCopied(f, "a.txt", "alpha\n");
    expect(lstatSync(treeFile(f, "a.txt")).nlink).toBe(1);
  });
});
