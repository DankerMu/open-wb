/**
 * Issue #1190 (task 10.4b) workspace-snapshots「快照内容规则」(遍历期间有变动的快照不可还原) and
 *「还原」(带 incomplete 标记的旧清单不被还原).
 *
 * Every change happens for real, between two calls of the walk: the hooks of the helpers run it
 * at a named moment. What the workspace must hold afterwards is written out from what the test
 * put there, not read from the module under test. The scenario's last WHEN (a root that is not
 * there before `take` starts) is in workspace-snapshots-take.test.ts.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TakeResult } from "../src/workspaces/snapshots.js";
import {
  afterListing,
  beforeLstat,
  contentsOf,
  dirEntry,
  type Fixture,
  fileEntry,
  fixture,
  MESSAGE_ID,
  manifestOf,
  onCopyCreate,
  PAST_SECONDS,
  put,
  restoreRun,
  run,
  setPast,
  stateOf,
  swapAfterLstat,
  W,
  waitForClock,
} from "./workspace-snapshots-helpers.js";

/** `failed`, and nothing of the snapshot is left: no manifest, no `tree/`, no directory. */
function expectNotRestorable(f: Fixture, result: TakeResult): void {
  expect(result.outcome).toBe("failed");
  expect(existsSync(f.snapshot)).toBe(false);
  expect(readdirSync(join(f.snapshots, W))).toEqual([]);
}

describe("遍历期间有变动的快照不可还原 — a listed entry is gone", () => {
  it("gone.txt removed after the root was listed and before its lstat", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "gone.txt", "gone\n");
    put(f.workspace, "d/x.txt", "x\n");
    afterListing(f.workspace, () => rmSync(join(f.workspace, "gone.txt")));

    expectNotRestorable(f, await run(f));
  });

  it("d/ removed whole after it was judged a directory and before its listing", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "gone.txt", "gone\n");
    put(f.workspace, "d/x.txt", "x\n");
    const d = join(f.workspace, "d");
    swapAfterLstat(d, () => rmSync(d, { recursive: true }));

    expectNotRestorable(f, await run(f));
    expect(existsSync(d)).toBe(false);
  });

  it.each([
    {
      what: "a file removed after its lstat and before its open",
      make: (path: string) => writeFileSync(path, "gone\n"),
    },
    {
      what: "a symbolic link removed after its lstat and before its readlink",
      make: (path: string) => symlinkSync("a.txt", path),
    },
  ])("$what", async (c) => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "z.txt", "zulu\n");
    const gone = join(f.workspace, "gone");
    c.make(gone);
    swapAfterLstat(gone, () => unlinkSync(gone));

    expectNotRestorable(f, await run(f));
  });

  it("a listed directory replaced by a file ahead of its children (ENOTDIR)", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "d/x.txt", "x\n");
    put(f.workspace, "z.txt", "zulu\n");
    const d = join(f.workspace, "d");
    afterListing(d, () => {
      rmSync(d, { recursive: true });
      writeFileSync(d, "a file now\n");
    });

    expectNotRestorable(f, await run(f));
    expect(readFileSync(d, "utf8")).toBe("a file now\n");
  });

  it("a file removed after it was opened: no read fails, the second look at the root tells", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    onCopyCreate((path) => {
      if (path === join(f.snapshot, "tree", "a.txt")) {
        rmSync(join(f.workspace, "a.txt"));
      }
    });

    expectNotRestorable(f, await run(f));
  });
});

describe("遍历期间有变动的快照不可还原 — moves", () => {
  it("跨目录移动: src/foo.ts moved to lib/ once lib/ is done and before src/ is looked at", async () => {
    const f = fixture();
    put(f.workspace, "src/foo.ts", "export const foo = 1;\n");
    mkdirSync(join(f.workspace, "lib"));
    const moment: unknown[] = [];
    // `lib` sorts ahead of `src`: by the first lstat of `src`, `lib` was listed and has its
    // directory under tree/. No read of the walk fails after this move.
    beforeLstat(join(f.workspace, "src"), () => {
      moment.push(contentsOf(join(f.snapshot, "tree")));
      renameSync(join(f.workspace, "src", "foo.ts"), join(f.workspace, "lib", "foo.ts"));
    });

    const result = await run(f);

    expect(moment).toEqual([{ lib: "dir" }]);
    expectNotRestorable(f, result);
    expect(contentsOf(f.workspace)).toEqual({
      lib: "dir",
      "lib/foo.ts": "export const foo = 1;\n",
      src: "dir",
    });
  });

  it("改名覆盖已捕获文件: report.md.tmp renamed over report.md after that was copied", async () => {
    const f = fixture();
    put(f.workspace, "report.md", "the old report\n");
    put(f.workspace, "report.md.tmp", "the new report\n");
    const moment: unknown[] = [];
    swapAfterLstat(join(f.workspace, "report.md.tmp"), () => {
      moment.push(contentsOf(join(f.snapshot, "tree")));
      renameSync(join(f.workspace, "report.md.tmp"), join(f.workspace, "report.md"));
    });

    const result = await run(f);

    expect(moment).toEqual([{ "report.md": "the old report\n" }]);
    expectNotRestorable(f, result);
    expect(contentsOf(f.workspace)).toEqual({ "report.md": "the new report\n" });
  });

  it("类型互换: data/ renamed to data.bak and report to data after data/ was copied", async () => {
    const f = fixture();
    put(f.workspace, "data/rows.csv", "1,2\n");
    put(f.workspace, "report", "the report\n");
    const moment: unknown[] = [];
    swapAfterLstat(join(f.workspace, "report"), () => {
      moment.push(contentsOf(join(f.snapshot, "tree")));
      renameSync(join(f.workspace, "data"), join(f.workspace, "data.bak"));
      renameSync(join(f.workspace, "report"), join(f.workspace, "data"));
    });

    const result = await run(f);

    expect(moment).toEqual([{ data: "dir", "data/rows.csv": "1,2\n" }]);
    expectNotRestorable(f, result);
    expect(contentsOf(f.workspace)).toEqual({
      data: "the report\n",
      "data.bak": "dir",
      "data.bak/rows.csv": "1,2\n",
    });
  });
});

describe("遍历期间有变动的快照不可还原 — a directory that was walked changes", () => {
  it("新增: a file appears in the root after the root was listed", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    afterListing(f.workspace, () => put(f.workspace, "new.txt", "new\n"));

    expectNotRestorable(f, await run(f));
  });

  it("新增: a file appears in a subdirectory that was walked already", async () => {
    const f = fixture();
    put(f.workspace, "d/x.txt", "x\n");
    put(f.workspace, "z.txt", "zulu\n");
    const moment: unknown[] = [];
    beforeLstat(join(f.workspace, "z.txt"), () => {
      moment.push(contentsOf(join(f.snapshot, "tree")));
      put(f.workspace, "d/new.txt", "new\n");
    });

    const result = await run(f);

    expect(moment).toEqual([{ d: "dir", "d/x.txt": "x\n" }]);
    expectNotRestorable(f, result);
  });

  it("同名重建: an entry deleted and made again as another type — same names, the times moved", async () => {
    const f = fixture();
    put(f.workspace, "d/x", "a file\n");
    put(f.workspace, "z.txt", "zulu\n");
    const d = join(f.workspace, "d");
    setPast(f.workspace, d);
    beforeLstat(join(f.workspace, "z.txt"), () => {
      waitForClock(f, d);
      rmSync(join(d, "x"));
      mkdirSync(join(d, "x"));
    });

    const result = await run(f);

    expect(readdirSync(d)).toEqual(["x"]);
    expectNotRestorable(f, result);
  });

  it("改名后 utimes 拨回: two names swapped and the mtime set back — only the ctime moved", async () => {
    const f = fixture();
    put(f.workspace, "d/x", "first\n");
    put(f.workspace, "d/y", "second\n");
    put(f.workspace, "z.txt", "zulu\n");
    const d = join(f.workspace, "d");
    setPast(f.workspace, d);
    const before = lstatSync(d, { bigint: true });
    beforeLstat(join(f.workspace, "z.txt"), () => {
      waitForClock(f, d);
      renameSync(join(d, "x"), join(d, "t"));
      renameSync(join(d, "y"), join(d, "x"));
      renameSync(join(d, "t"), join(d, "y"));
      utimesSync(d, PAST_SECONDS, PAST_SECONDS);
    });

    const result = await run(f);

    // What the walk could compare: the same directory, the same names, the same mtime.
    const after = lstatSync(d, { bigint: true });
    expect(readdirSync(d).sort()).toEqual(["x", "y"]);
    expect([after.dev, after.ino, after.mtimeNs]).toEqual([before.dev, before.ino, before.mtimeNs]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(contentsOf(d)).toEqual({ x: "second\n", y: "first\n" });
    expectNotRestorable(f, result);
  });

  it("无变动: ok, the manifest has exactly entries and skipped, and a restore deletes what is new", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "one\n");
    put(f.workspace, "src/x.ts", "export const x = 1;\n");
    mkdirSync(join(f.workspace, "lib"));

    const taken = await run(f);

    expect(taken).toEqual({ outcome: "ok", skipped: [] });
    expect(Object.keys(manifestOf(f))).toEqual(["entries", "skipped"]);
    expect(manifestOf(f).entries).toEqual([
      fileEntry(f, "a.txt"),
      dirEntry(f, "lib"),
      dirEntry(f, "src"),
      fileEntry(f, "src/x.ts"),
    ]);

    put(f.workspace, "c.txt", "new in this turn\n");
    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 1, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "one\n",
      lib: "dir",
      src: "dir",
      "src/x.ts": "export const x = 1;\n",
    });
  });
});

/** The fixture's manifest as an older version wrote it after a walk that lost an entry. */
function markIncomplete(f: Fixture, incomplete: unknown): void {
  const manifest = { ...manifestOf(f), incomplete };
  writeFileSync(join(f.snapshot, "manifest.json"), JSON.stringify(manifest));
  expect(manifestOf(f)).toHaveProperty("incomplete", incomplete);
}

describe("带 incomplete 标记的旧清单不被还原", () => {
  it.each([true, false, "true", 1, 0, null, {}])(
    "incomplete: %j — refused as no manifest, nothing written back, nothing deleted",
    async (incomplete) => {
      const f = fixture();
      put(f.workspace, "a.txt", "one\n");
      put(f.workspace, "src/x.ts", "export const x = 1;\n");
      expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
      markIncomplete(f, incomplete);
      put(f.workspace, "a.txt", "changed\n");
      put(f.workspace, "c.txt", "new\n");
      const before = stateOf(f.workspace);

      await expect(restoreRun(f)).rejects.toThrow("retired incomplete key");

      expect(stateOf(f.workspace)).toEqual(before);
      expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("changed\n");
      expect(readFileSync(join(f.workspace, "c.txt"), "utf8")).toBe("new\n");
    },
  );
});

describe("未变文件的去重 — the previous manifest carries incomplete", () => {
  it("an unchanged file is still linked from it, and the next manifest has no such key", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "one\n");
    put(f.workspace, "d/x.txt", "x\n");
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    markIncomplete(f, true);
    const next = MESSAGE_ID + 1;

    const taken = await run(f, { userMessageId: next, previousMessageId: MESSAGE_ID });

    expect(taken).toEqual({ outcome: "ok", skipped: [] });
    const second = join(f.snapshots, W, String(next));
    for (const path of ["a.txt", "d/x.txt"]) {
      const kept = lstatSync(join(f.snapshot, "tree", path));
      const linked = lstatSync(join(second, "tree", path));
      expect(linked.ino, path).toBe(kept.ino);
      expect(linked.nlink, path).toBe(2);
      expect(linked.ino, path).not.toBe(lstatSync(join(f.workspace, path)).ino);
    }
    expect(JSON.parse(readFileSync(join(second, "manifest.json"), "utf8"))).toEqual({
      entries: [fileEntry(f, "a.txt"), dirEntry(f, "d"), fileEntry(f, "d/x.txt")],
      skipped: [],
    });
  });
});
