/**
 * Issue #1148 (task 10.4a, the ruling after the review of PR #1189) workspace-snapshots
 *「快照内容规则」(a walk that lost a listed entry writes `incomplete: true`) and「还原」
 * (遍历期间被改名的文件不因还原而丢失: such a snapshot deletes no extra entry).
 *
 * Renames happen for real, between two calls of the walk. What the workspace must hold after a
 * restore is written out from what the test put there, not read from the module under test.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  afterListing,
  contentsOf,
  dirEntry,
  type Fixture,
  fileEntry,
  fixture,
  MESSAGE_ID,
  manifestOf,
  put,
  restoreRun,
  run,
  stateOf,
  swapAfterLstat,
  W,
} from "./workspace-snapshots-helpers.js";

/** The workspace of scenario「遍历期间被改名的文件不因还原而丢失」. */
function populate(f: Fixture): void {
  put(f.workspace, "a.txt", "one\n");
  put(f.workspace, "report.md", "the report\n");
  put(f.workspace, "src/x.ts", "export const x = 1;\n");
}

/** One entry of the root is gone when the walk comes to it: the snapshot is incomplete. */
function loseOne(f: Fixture): void {
  put(f.workspace, "gone.txt", "gone\n");
  afterListing(f.workspace, () => rmSync(join(f.workspace, "gone.txt")));
}

function writeManifest(f: Fixture, manifest: unknown): void {
  writeFileSync(join(f.snapshot, "manifest.json"), JSON.stringify(manifest));
}

describe("遍历期间被改名的文件不因还原而丢失", () => {
  it("a file renamed after the listing: incomplete, and the restore deletes neither it nor c.txt", async () => {
    const f = fixture();
    populate(f);
    afterListing(f.workspace, () =>
      renameSync(join(f.workspace, "report.md"), join(f.workspace, "report-final.md")),
    );

    const taken = await run(f);

    expect(taken).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), dirEntry(f, "src"), fileEntry(f, "src/x.ts")],
      skipped: [],
      incomplete: true,
    });

    put(f.workspace, "a.txt", "changed\n");
    put(f.workspace, "c.txt", "new in this turn\n");
    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "one\n",
      "c.txt": "new in this turn\n",
      "report-final.md": "the report\n",
      src: "dir",
      "src/x.ts": "export const x = 1;\n",
    });
  });

  it("nothing vanished: the manifest has no incomplete key, and the restore deletes c.txt", async () => {
    const f = fixture();
    populate(f);

    const taken = await run(f);

    expect(taken).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).not.toHaveProperty("incomplete");
    expect(Object.keys(manifestOf(f))).toEqual(["entries", "skipped"]);

    put(f.workspace, "c.txt", "new in this turn\n");
    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 1, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "one\n",
      "report.md": "the report\n",
      src: "dir",
      "src/x.ts": "export const x = 1;\n",
    });
  });

  it("a directory renamed while its children are visited: the whole of it survives the restore", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "one\n");
    put(f.workspace, "src/a.ts", "a\n");
    put(f.workspace, "src/b.ts", "b\n");
    put(f.workspace, "src/deep/c.ts", "c\n");
    const src = dirEntry(f, "src");
    const first = fileEntry(f, "src/a.ts");
    // src/a.ts is in the snapshot by then; src/b.ts and src/deep are not reached under `src`.
    swapAfterLstat(join(f.workspace, "src", "b.ts"), () =>
      renameSync(join(f.workspace, "src"), join(f.workspace, "lib")),
    );

    const taken = await run(f);

    expect(taken).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toEqual({
      entries: [fileEntry(f, "a.txt"), src, first],
      skipped: [],
      incomplete: true,
    });

    const result = await restoreRun(f);

    // `src` and the one file the snapshot has of it come back; `lib` is nobody's to delete.
    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "one\n",
      lib: "dir",
      "lib/a.ts": "a\n",
      "lib/b.ts": "b\n",
      "lib/deep": "dir",
      "lib/deep/c.ts": "c\n",
      src: "dir",
      "src/a.ts": "a\n",
    });
  });
});

describe("还原 — an incomplete snapshot", () => {
  it("still writes back content and replaces what is of another type under a manifest path", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "one\n");
    put(f.workspace, "d/x.txt", "x\n");
    put(f.workspace, "file", "a file\n");
    symlinkSync("a.txt", join(f.workspace, "link"));
    loseOne(f);
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toHaveProperty("incomplete", true);

    put(f.workspace, "a.txt", "changed\n");
    rmSync(join(f.workspace, "d"), { recursive: true });
    writeFileSync(join(f.workspace, "d"), "a file where the directory was\n");
    rmSync(join(f.workspace, "file"));
    mkdirSync(join(f.workspace, "file"));
    writeFileSync(join(f.workspace, "file", "inside.txt"), "inside the occupant\n");
    rmSync(join(f.workspace, "link"));
    writeFileSync(join(f.workspace, "link"), "a file where the link was\n");
    put(f.workspace, "extra/kept.txt", "extra\n");

    const result = await restoreRun(f);

    // a.txt, d/x.txt and file written back, link made again; the three occupants do not count.
    expect(result).toEqual({ restored: 4, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "one\n",
      d: "dir",
      "d/x.txt": "x\n",
      extra: "dir",
      "extra/kept.txt": "extra\n",
      file: "a file\n",
      link: "-> a.txt",
    });
    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 0, skipped: [], failed: [] });
  });

  it.each([false, "true", 1, null, 0, {}])(
    "incomplete: %j is no manifest: refused before anything changes",
    async (incomplete) => {
      const f = fixture();
      populate(f);
      expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
      writeManifest(f, { ...manifestOf(f), incomplete });
      put(f.workspace, "a.txt", "changed\n");
      put(f.workspace, "c.txt", "new\n");
      const before = stateOf(f.workspace);

      await expect(restoreRun(f)).rejects.toThrow("malformed incomplete flag");

      expect(stateOf(f.workspace)).toEqual(before);
    },
  );

  it("incomplete: true written by hand on a complete manifest is honoured: nothing is deleted", async () => {
    const f = fixture();
    populate(f);
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    writeManifest(f, { ...manifestOf(f), incomplete: true });
    put(f.workspace, "a.txt", "changed\n");
    put(f.workspace, "c.txt", "new\n");

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(readFileSync(join(f.workspace, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(f.workspace, "c.txt"), "utf8")).toBe("new\n");
  });
});

describe("未变文件的去重 — the previous snapshot is incomplete", () => {
  it("an unchanged file is linked from it, and the next manifest is not incomplete itself", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "one\n");
    put(f.workspace, "d/x.txt", "x\n");
    loseOne(f);
    expect(await run(f)).toEqual({ outcome: "ok", skipped: [] });
    expect(manifestOf(f)).toHaveProperty("incomplete", true);
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
