/**
 * Issue #940 workspace-snapshots「还原」, the cases a writer in the workspace or a damaged
 * snapshot produces: manifests refused before anything changes, entries replaced while the
 * restore runs (a spy on `fs.promises` plays the writer at a chosen call), deletions that must
 * not follow links, and single entries that fail without stopping the rest. Real temporary
 * directories, snapshots from the real `take`.
 */
import { execFileSync } from "node:child_process";
import fs, {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  contentsOf,
  editManifest,
  type Fixture,
  fixture,
  ioError,
  leftovers,
  lock,
  manifestOf,
  OUTSIDE_BYTES,
  outsideDir,
  put,
  releaseAfterTest,
  restoreRun,
  sameTimes,
  snapshot,
  stateOf,
} from "./workspace-snapshots-helpers.js";

const IS_ROOT = process.geteuid?.() === 0;
const PINNED_SECONDS = 1_700_000_000;
const TEMP_NAME = /^\.restore-[0-9a-f]{32}\.tmp$/;

function at(f: Fixture, path: string): string {
  return join(f.workspace, path);
}

/** What changes when a file is written, replaced or chmod-ed (reading it moves only `atime`). */
function identityOf(path: string): unknown {
  const { ino, size, mode, mtimeMs, ctimeMs } = lstatSync(path);
  return { ino, size, mode, mtimeMs, ctimeMs };
}

/**
 * A writer around the restore's read of a workspace file (the open with numeric flags, not the
 * creation of a temporary file): `before` runs once ahead of the real open, `after` once it has
 * returned.
 */
function aroundRead(path: string, writer: { before?: () => void; after?: () => void }): void {
  const open = fs.promises.open;
  let done = false;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const hit = args[0] === path && typeof args[1] === "number" && !done;
    if (hit) {
      done = true;
      writer.before?.();
    }
    const handle = await open(...args);
    if (hit) {
      writer.after?.();
    }
    return handle;
  });
}

/** A changed workspace with an extra entry, its snapshot taken before the changes. */
async function changedWorkspace(): Promise<Fixture> {
  const f = fixture();
  put(f.workspace, "a.txt", "alpha\n");
  put(f.workspace, "dir/b.txt", "bravo\n");
  await snapshot(f);
  writeFileSync(at(f, "a.txt"), "changed in the turn\n");
  put(f.workspace, "extra/c.txt", "new\n");
  return f;
}

describe("还原 — a manifest that is not one is refused before anything changes", () => {
  it.each(["../x", "/abs", "a//b", "a/./b", "a/../b", "", "dir/", "..", ".", "a\u0000b"])(
    "an entry path %j",
    async (path) => {
      const f = await changedWorkspace();
      editManifest(f, (manifest) => {
        manifest.entries.push({ path, type: "dir", mode: 0o755 });
      });
      const before = stateOf(f.workspace);
      const outside = stateOf(join(f.workspace, ".."));

      await expect(restoreRun(f)).rejects.toThrow("manifest");

      expect(stateOf(f.workspace)).toEqual(before);
      expect(stateOf(join(f.workspace, ".."))).toEqual(outside);
    },
  );

  it.each([
    ["a skipped path that leaves the workspace", { path: "../x", reason: "excluded" }],
    ["a skipped item without a reason", { path: "x" }],
    ["a skipped item that is no object", "x"],
    // Taken as it is, `nowhere/` would be deleted as an extra entry with the skipped path in it.
    ["a skipped path whose parent is not listed", { path: "nowhere/x", reason: "excluded" }],
  ])("%s", async (_name, item) => {
    const f = await changedWorkspace();
    put(f.workspace, "nowhere/x", "skipped by the snapshot\n");
    put(f.workspace, "nowhere/kept.txt", "kept\n");
    editManifest(f, (manifest) => {
      manifest.skipped.push(item as Record<string, unknown>);
    });
    const before = stateOf(f.workspace);

    await expect(restoreRun(f)).rejects.toThrow("manifest");

    expect(stateOf(f.workspace)).toEqual(before);
    expect(contentsOf(f.workspace)).toMatchObject({
      nowhere: "dir",
      "nowhere/kept.txt": "kept\n",
      "nowhere/x": "skipped by the snapshot\n",
    });
  });

  it.each([
    ["an unknown type", { path: "x", type: "fifo" }],
    ["no object", null],
    ["a directory without a mode", { path: "x", type: "dir" }],
    ["a mode with bits above 07777", { path: "x", type: "dir", mode: 0o17777 }],
    ["a file without a size", { path: "x", type: "file", mtimeMs: 1, ctimeMs: 1, ino: 1, mode: 0 }],
    [
      "a file with a negative size",
      { path: "x", type: "file", size: -1, mtimeMs: 1, ctimeMs: 1, ino: 1, mode: 0o644 },
    ],
    [
      "a file whose mtime is text",
      { path: "x", type: "file", size: 1, mtimeMs: "1", ctimeMs: 1, ino: 1, mode: 0o644 },
    ],
    [
      "a file whose inode is text",
      { path: "x", type: "file", size: 1, mtimeMs: 1, ctimeMs: 1, ino: "1", mode: 0o644 },
    ],
    ["a link without a target", { path: "x", type: "symlink" }],
    ["a link with an empty target", { path: "x", type: "symlink", target: "" }],
    ["a path listed twice", { path: "a.txt", type: "dir", mode: 0o755 }],
    ["an entry under a file", { path: "a.txt/x", type: "dir", mode: 0o755 }],
    ["an entry whose parent is not listed", { path: "nowhere/x", type: "dir", mode: 0o755 }],
  ])("an entry that is %s", async (_name, entry) => {
    const f = await changedWorkspace();
    editManifest(f, (manifest) => {
      manifest.entries.push(entry as Record<string, unknown>);
    });
    const before = stateOf(f.workspace);

    await expect(restoreRun(f)).rejects.toThrow("manifest");

    expect(stateOf(f.workspace)).toEqual(before);
  });

  it("entries that are not a list", async () => {
    const f = await changedWorkspace();
    editManifest(f, (manifest) => {
      Object.assign(manifest, { entries: { length: 0 } });
    });
    const before = stateOf(f.workspace);

    await expect(restoreRun(f)).rejects.toThrow("manifest");

    expect(stateOf(f.workspace)).toEqual(before);
  });
});

describe("还原 — a damaged tree/", () => {
  it.each([
    ["shorter than recorded", (copy: string) => writeFileSync(copy, "alp")],
    ["longer than recorded", (copy: string) => writeFileSync(copy, "alpha and more\n")],
    ["missing", (copy: string) => rmSync(copy)],
    [
      "a symbolic link",
      (copy: string) => {
        renameSync(copy, `${copy}.real`);
        symlinkSync(`${copy}.real`, copy);
      },
    ],
  ])(
    "a copy that is %s: restore throws, the file is not touched, no temporary file stays",
    async (_name, damage) => {
      const f = await changedWorkspace();
      damage(join(f.snapshot, "tree", "a.txt"));
      const changed = identityOf(at(f, "a.txt"));

      await expect(restoreRun(f)).rejects.toThrow();

      expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("changed in the turn\n");
      expect(identityOf(at(f, "a.txt"))).toEqual(changed);
      expect(leftovers(f.workspace)).toEqual([]);
    },
  );

  it("a manifest entry under a skipped path is not touched, whatever tree/ holds", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "node_modules/pkg/index.js", "module.exports = 1;\n");
    await snapshot(f);
    editManifest(f, (manifest) => {
      manifest.entries.push(
        { path: "node_modules/pkg", type: "symlink", target: "elsewhere" },
        { path: "node_modules/gone", type: "dir", mode: 0o755 },
      );
    });
    const before = stateOf(f.workspace);

    expect(await restoreRun(f)).toMatchObject({ restored: 0, removed: 0, failed: [] });

    expect(stateOf(f.workspace)).toEqual(before);
  });
});

describe("还原 — a writer in the workspace while the restore runs", () => {
  it("a file swapped for a FIFO ahead of its read does not hang: it is replaced", async () => {
    const f = fixture();
    put(f.workspace, "dir/b.txt", "bravo\n");
    await snapshot(f);
    const victim = at(f, "dir/b.txt");
    releaseAfterTest(victim);
    aroundRead(victim, {
      before: () => {
        rmSync(victim);
        execFileSync("mkfifo", [victim]);
      },
    });

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({ dir: "dir", "dir/b.txt": "bravo\n" });
  }, 5000);

  it("a file swapped for a link to an outside file of the same bytes is not read through it", async () => {
    const f = fixture();
    put(f.workspace, "dir/b.txt", OUTSIDE_BYTES);
    await snapshot(f);
    const victim = at(f, "dir/b.txt");
    aroundRead(victim, {
      before: () => {
        rmSync(victim);
        symlinkSync(f.outside, victim);
      },
    });
    const outside = identityOf(f.outside);

    const result = await restoreRun(f);

    // Read through the link, the outside file would have passed for the unchanged one.
    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(lstatSync(victim).isFile()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe(OUTSIDE_BYTES);
    expect(identityOf(f.outside)).toEqual(outside);
    expect(readFileSync(f.outside, "utf8")).toBe(OUTSIDE_BYTES);
  });

  it("the final path swapped for a link right after the rename: nothing is done to that path", async () => {
    const f = fixture();
    put(f.workspace, "run.sh", "#!/bin/sh\n", 0o755);
    utimesSync(at(f, "run.sh"), PINNED_SECONDS, PINNED_SECONDS);
    await snapshot(f);
    writeFileSync(at(f, "run.sh"), "changed in the turn\n");
    const final = at(f, "run.sh");
    const written: fs.Stats[] = [];
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === final) {
        written.push(lstatSync(final));
        rmSync(final);
        symlinkSync(f.outside, final);
      }
    });
    const outside = identityOf(f.outside);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    // Mode and time were already on the file when it got its name.
    expect(written.map((stat) => [stat.mode & 0o7777, stat.mtimeMs])).toEqual([
      [0o775, PINNED_SECONDS * 1000],
    ]);
    expect(identityOf(f.outside)).toEqual(outside);
    expect(readFileSync(f.outside, "utf8")).toBe(OUTSIDE_BYTES);
    expect(lstatSync(final).isSymbolicLink()).toBe(true);
  });

  it("父目录被换成符号链接: a parent swapped for a link after the read sends nothing through it", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "dir/b.txt", "bravo\n");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "changed in the turn\n");
    writeFileSync(at(f, "dir/b.txt"), "changed in the turn\n");
    const outside = outsideDir(f);
    const before = stateOf(outside);
    aroundRead(at(f, "dir/b.txt"), {
      after: () => {
        renameSync(at(f, "dir"), at(f, "moved"));
        symlinkSync(outside, at(f, "dir"));
      },
    });

    const result = await restoreRun(f);

    expect(result).toEqual({
      restored: 1,
      removed: 0,
      skipped: [],
      failed: [{ path: "dir/b.txt" }],
    });
    expect(stateOf(outside)).toEqual(before);
    expect(readFileSync(join(outside, "b.txt"), "utf8")).toBe("outside b\n");
    expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("a parent swapped for a link after the temporary file was made: nothing is renamed through it", async () => {
    const f = fixture();
    put(f.workspace, "dir/b.txt", "bravo\n");
    await snapshot(f);
    writeFileSync(at(f, "dir/b.txt"), "changed in the turn\n");
    const outside = outsideDir(f);
    const before = stateOf(outside);
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        renameSync(at(f, "dir"), at(f, "moved"));
        symlinkSync(outside, at(f, "dir"));
      }
      return handle;
    });

    const result = await restoreRun(f);

    expect(result).toEqual({
      restored: 0,
      removed: 0,
      skipped: [],
      failed: [{ path: "dir/b.txt" }],
    });
    expect(stateOf(outside)).toEqual(before);
    expect(readFileSync(at(f, "moved/b.txt"), "utf8")).toBe("changed in the turn\n");
  });

  it("another file of the same size and times under the same path is not left in place", async () => {
    const f = fixture();
    put(f.workspace, "d1/f", "AAAAAA\n");
    put(f.workspace, "d2/f", "BBBBBB\n");
    await sameTimes(at(f, "d1/f"), at(f, "d2/f"), PINNED_SECONDS);
    renameSync(at(f, "d1"), at(f, "sub"));
    renameSync(at(f, "d2"), join(f.workspace, "..", "d2"));
    await snapshot(f);
    const recorded = manifestOf(f).entries.find(
      (entry) => (entry as { path: string }).path === "sub/f",
    );
    // Renaming the parent leaves the child's ctime alone: only the inode differs.
    renameSync(at(f, "sub"), join(f.workspace, "..", "d1"));
    renameSync(join(f.workspace, "..", "d2"), at(f, "sub"));
    const now = lstatSync(at(f, "sub/f"));
    expect(recorded).toMatchObject({
      size: now.size,
      mtimeMs: now.mtimeMs,
      ctimeMs: now.ctimeMs,
    });
    expect((recorded as { ino: number }).ino).not.toBe(now.ino);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(readFileSync(at(f, "sub/f"), "utf8")).toBe("AAAAAA\n");
  });
});

describe("还原 — what it deletes and what it leaves behind", () => {
  it("deleting never follows a link: the links go, what they point at stays", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    await snapshot(f);
    const outside = outsideDir(f);
    symlinkSync(outside, at(f, "extra-link"));
    mkdirSync(at(f, "extra-dir"));
    symlinkSync(outside, at(f, "extra-dir/inner-link"));
    symlinkSync(f.outside, at(f, "extra-dir/file-link"));
    const before = stateOf(outside);

    const result = await restoreRun(f);

    expect(result).toEqual({ restored: 0, removed: 2, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n" });
    expect(stateOf(outside)).toEqual(before);
    expect(readFileSync(f.outside, "utf8")).toBe(OUTSIDE_BYTES);
  });

  it("a temporary file left by a crashed restore is deleted as an extra entry", async () => {
    const f = fixture();
    put(f.workspace, "dir/b.txt", "bravo\n");
    await snapshot(f);
    put(f.workspace, "dir/.restore-0123456789abcdef0123456789abcdef.tmp", "half a file");

    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 1, skipped: [], failed: [] });

    expect(contentsOf(f.workspace)).toEqual({ dir: "dir", "dir/b.txt": "bravo\n" });
  });

  it("the temporary file has an unpredictable name beside its target and is private until renamed", async () => {
    const f = await changedWorkspace();
    writeFileSync(at(f, "dir/b.txt"), "changed in the turn\n");
    const created: [string, number][] = [];
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        created.push([String(args[0]), lstatSync(String(args[0])).mode & 0o7777]);
      }
      return handle;
    });

    expect(await restoreRun(f)).toMatchObject({ restored: 2, failed: [] });

    const names = created.map(([path]) => path.slice(f.workspace.length + 1));
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(TEMP_NAME);
    expect(names[1]?.startsWith("dir/")).toBe(true);
    expect(names[1]?.slice(4)).toMatch(TEMP_NAME);
    expect(names[1]?.slice(4)).not.toBe(names[0]);
    expect(created.map(([, mode]) => mode)).toEqual([0o600, 0o600]);
    expect(leftovers(f.workspace).concat(leftovers(at(f, "dir")))).toEqual([]);
  });

  it.each([
    ["EIO", "rejects"],
    ["EACCES", "fails that entry"],
  ])("a write-back that fails with %s removes its temporary file", async (code, _outcome) => {
    const f = await changedWorkspace();
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        // The copy is on disk by the time the mode is set.
        handle.chmod = () => Promise.reject(ioError(code));
      }
      return handle;
    });

    if (code === "EIO") {
      await expect(restoreRun(f)).rejects.toMatchObject({ code: "EIO" });
    } else {
      expect(await restoreRun(f)).toMatchObject({ restored: 0, failed: [{ path: "a.txt" }] });
    }

    expect(leftovers(f.workspace)).toEqual([]);
    expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("changed in the turn\n");
  });

  it("a manifest without inode numbers falls to the content comparison and stays idempotent", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    await snapshot(f);
    editManifest(f, (manifest) => {
      for (const entry of manifest.entries) {
        delete entry.ino;
      }
    });
    const untouched = stateOf(f.workspace);
    const reads = vi.spyOn(fs.promises, "open");

    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 0, skipped: [], failed: [] });
    expect(stateOf(f.workspace)).toEqual(untouched);
    // Without an inode number nothing is taken for unchanged unread: both copies were opened.
    expect(reads.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        join(f.snapshot, "tree", "a.txt"),
        join(f.snapshot, "tree", "b.txt"),
      ]),
    );

    writeFileSync(at(f, "b.txt"), "BRAVO\n");
    expect(await restoreRun(f)).toMatchObject({ restored: 1, removed: 0 });
    const written = stateOf(f.workspace);
    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 0, skipped: [], failed: [] });
    expect(stateOf(f.workspace)).toEqual(written);
    expect(readFileSync(at(f, "b.txt"), "utf8")).toBe("bravo\n");
  });

  it("an unchanged file is taken for unchanged without opening its copy in tree/", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    await snapshot(f);
    const reads = vi.spyOn(fs.promises, "open");

    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 0, skipped: [], failed: [] });

    expect(reads.mock.calls.map(([path]) => path)).toEqual([at(f, "a.txt")]);
  });

  it.skipIf(IS_ROOT)(
    "an entry that may not be written or deleted is listed as failed, the others are restored",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "locked/f.txt", "locked\n");
      put(f.workspace, "z.txt", "zulu\n");
      await snapshot(f);
      writeFileSync(at(f, "a.txt"), "changed in the turn\n");
      writeFileSync(at(f, "locked/f.txt"), "changed in the turn\n");
      put(f.workspace, "locked/extra.txt", "new\n");
      rmSync(at(f, "z.txt"));
      lock(at(f, "locked"), 0o500);

      const result = await restoreRun(f);

      expect(result).toEqual({
        restored: 2,
        removed: 0,
        skipped: [],
        failed: [{ path: "locked/extra.txt" }, { path: "locked/f.txt" }],
      });
      expect(contentsOf(f.workspace)).toEqual({
        "a.txt": "alpha\n",
        locked: "dir",
        "locked/extra.txt": "new\n",
        "locked/f.txt": "changed in the turn\n",
        "z.txt": "zulu\n",
      });
    },
  );

  it.skipIf(IS_ROOT)(
    "a directory that may not be listed is failed once, its files too",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "locked/f.txt", "locked\n");
      await snapshot(f);
      writeFileSync(at(f, "a.txt"), "changed in the turn\n");
      lock(at(f, "locked"), 0o000);

      const result = await restoreRun(f);

      expect(result).toEqual({
        restored: 1,
        removed: 0,
        skipped: [],
        failed: [{ path: "locked" }, { path: "locked/f.txt" }],
      });
      expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("alpha\n");
      expect(existsSync(at(f, "locked"))).toBe(true);
    },
  );

  it.skipIf(IS_ROOT)(
    "a directory that may not be made is failed, and so is the file whose parent is then missing",
    async () => {
      const f = fixture();
      put(f.workspace, "a.txt", "alpha\n");
      put(f.workspace, "p/dir/b.txt", "bravo\n");
      await snapshot(f);
      writeFileSync(at(f, "a.txt"), "changed in the turn\n");
      rmSync(at(f, "p/dir"), { recursive: true });
      lock(at(f, "p"), 0o500);

      const result = await restoreRun(f);

      expect(result).toEqual({
        restored: 1,
        removed: 0,
        skipped: [],
        failed: [{ path: "p/dir" }, { path: "p/dir/b.txt" }],
      });
      expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n", p: "dir" });
    },
  );

  it("bytes appended after the size was read are not compared: the file is left, nothing hangs", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    await snapshot(f);
    // No inode number: the file is not taken for the recorded one unread, its bytes are compared.
    editManifest(f, (manifest) => {
      for (const entry of manifest.entries) {
        delete entry.ino;
      }
    });
    const recorded = lstatSync(at(f, "a.txt")).ino;
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] === at(f, "a.txt")) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const size = await stat();
          appendFileSync(at(f, "a.txt"), "appended by a writer\n");
          return size;
        }) as typeof handle.stat;
      }
      return handle;
    });

    expect(await restoreRun(f)).toEqual({ restored: 0, removed: 0, skipped: [], failed: [] });

    expect(readFileSync(at(f, "a.txt"), "utf8")).toBe("alpha\nappended by a writer\n");
    expect(lstatSync(at(f, "a.txt")).ino).toBe(recorded);
    expect(leftovers(f.workspace)).toEqual([]);
  }, 5000);

  it("an error that is not about permission stops the restore; running it again finishes it", async () => {
    const f = fixture();
    put(f.workspace, "a.txt", "alpha\n");
    put(f.workspace, "b.txt", "bravo\n");
    await snapshot(f);
    writeFileSync(at(f, "a.txt"), "changed in the turn\n");
    writeFileSync(at(f, "b.txt"), "changed in the turn\n");
    const rename = fs.promises.rename;
    const failing = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (to === at(f, "b.txt")) {
        throw ioError("EIO");
      }
      await rename(from, to);
    });

    await expect(restoreRun(f)).rejects.toMatchObject({ code: "EIO" });

    expect(contentsOf(f.workspace)).toEqual({
      "a.txt": "alpha\n",
      "b.txt": "changed in the turn\n",
    });
    failing.mockRestore();
    expect(await restoreRun(f)).toEqual({ restored: 1, removed: 0, skipped: [], failed: [] });
    expect(contentsOf(f.workspace)).toEqual({ "a.txt": "alpha\n", "b.txt": "bravo\n" });
  });
});
