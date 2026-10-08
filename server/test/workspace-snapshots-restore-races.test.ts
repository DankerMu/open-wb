/**
 * Issue #1214 (task 10.4e) workspace-snapshots「还原」(删除期间的并发改动不中止还原): another
 * writer changes the workspace between two steps of a deletion. Every change is a real one on
 * real temporary directories, made by a spy on `fs.promises` at the stated call (no error code
 * is made up), and every case checks that its change was made exactly once.
 */
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  afterListing,
  beforeLstat,
  beforeRmdir,
  contentsOf,
  type Fixture,
  fixture,
  leftovers,
  put,
  restoreRun,
  snapshot,
  swapAfterLstat,
} from "./workspace-snapshots-helpers.js";

type Hook = (target: string, act: () => void) => void;

function at(f: Fixture, path: string): string {
  return join(f.workspace, path);
}

/** A snapshot of `a.txt`, then `a.txt` rewritten and the extra directory `new/` of the scenario. */
async function withExtraDirectory(): Promise<Fixture> {
  const f = fixture();
  put(f.workspace, "a.txt", "alpha\n");
  await snapshot(f);
  writeFileSync(at(f, "a.txt"), "changed in the turn\n");
  put(f.workspace, "new/a.txt", "a\n");
  put(f.workspace, "new/b.txt", "b\n");
  put(f.workspace, "new/sub/c.txt", "c\n");
  return f;
}

/** The other writer: `change` at the call `hook` names; returns how often it was made. */
function writer(hook: Hook, target: string, change: () => void): () => number {
  let made = 0;
  hook(target, () => {
    made += 1;
    change();
  });
  return () => made;
}

const GONE = { restored: 1, removed: 1, skipped: [], failed: [] };

describe("删除期间的并发改动不中止还原 — what is gone already counts as deleted", () => {
  it.each<[string, Hook, string, (path: string) => void]>([
    [
      "new/b.txt deleted after new was listed, before its lstat",
      beforeLstat,
      "new/b.txt",
      (path) => rmSync(path),
    ],
    [
      "new/b.txt deleted after its lstat, before its unlink",
      swapAfterLstat,
      "new/b.txt",
      (path) => rmSync(path),
    ],
    [
      "new/sub deleted whole after its lstat, before it is listed",
      swapAfterLstat,
      "new/sub",
      (path) => rmSync(path, { recursive: true }),
    ],
    [
      "new/sub removed by the other writer once it is empty, before its rmdir",
      beforeRmdir,
      "new/sub",
      (path) => rmdirSync(path),
    ],
  ])("%s", async (_title, hook, target, change) => {
    const f = await withExtraDirectory();
    const made = writer(hook, at(f, target), () => change(at(f, target)));

    const result = await restoreRun(f);

    expect(made()).toBe(1);
    expect(result).toEqual(GONE);
    expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n" });
  });

  it("new deleted whole after the lstat that classified it, before it is listed", async () => {
    const f = await withExtraDirectory();
    const made = writer(swapAfterLstat, at(f, "new"), () =>
      rmSync(at(f, "new"), { recursive: true }),
    );

    const result = await restoreRun(f);

    expect(made()).toBe(1);
    expect(result).toEqual(GONE);
    expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n" });
  });

  it("an extra file deleted after the lstat that classified it, before its unlink", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "changed in the turn\n");
    put(f.workspace, "extra.txt", "extra\n");
    const made = writer(swapAfterLstat, at(f, "extra.txt"), () => rmSync(at(f, "extra.txt")));

    const result = await restoreRun(f);

    expect(made()).toBe(1);
    expect(result).toEqual(GONE);
    expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n" });
  });
});

describe("删除期间的并发改动不中止还原 — what was added after the listing stays", () => {
  it("new/sub/late.txt added after new/sub was listed: that level is kept and failed, no retry", async () => {
    const f = await withExtraDirectory();
    const made = writer(afterListing, at(f, "new/sub"), () =>
      writeFileSync(at(f, "new/sub/late.txt"), "written late\n"),
    );

    const result = await restoreRun(f);

    expect(made()).toBe(1);
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "alpha\n",
      new: "dir",
      "new/sub": "dir",
      "new/sub/late.txt": "written late\n",
    });
    expect(result).toEqual({
      restored: 1,
      removed: 0,
      skipped: [],
      failed: [{ path: "new/sub" }],
    });

    // No writer this time: the level goes, and the extra directory counts.
    vi.restoreAllMocks();
    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 1, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n" });
    expect(made()).toBe(1);
  });

  it("x/late.txt added before the rmdir of a directory in a manifest file's place: not replaced, failed once", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "x", "a file\n");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "changed in the turn\n");
    rmSync(at(f, "x"));
    mkdirSync(at(f, "x"));
    writeFileSync(at(f, "x/y.txt"), "y\n");
    const made = writer(beforeRmdir, at(f, "x"), () =>
      writeFileSync(at(f, "x/late.txt"), "written late\n"),
    );

    const result = await restoreRun(f);

    expect(made()).toBe(1);
    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "alpha\n",
      x: "dir",
      "x/late.txt": "written late\n",
    });
    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [{ path: "x" }] });
    expect(leftovers(f.workspace)).toEqual([]);
  });
});
