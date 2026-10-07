/**
 * Issue #706 DELETE /api/sessions/:id, the artifact directory goes through the app-private trash
 * (change session-delete-trash): `lstat` → `rename` into `<state>/trash/<32 hex>` → `lstat` there →
 * recursive removal, or `unlink` plus one report when the entry was swapped before the rename. A
 * rename failing with `EXDEV` is reported and the directory left in place (#929: the in-place
 * removal exists for temporary workspace directories only).
 * The DELETE cases run the production createApp → registerSessions assembly on real files; the two
 * cases that need something to happen between `lstat` and `rename` call `removeSessionFile` with a
 * `rename` that mutates the directory first and then performs the real rename. Oracles: the file
 * system (session dir, trash, the tree outside) and the service error channel.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeSessionFile } from "../src/sessions/session-delete.js";
import {
  deleteNaming,
  deleteWorlds,
  openRealWorld,
  ownedArtifactDir,
  ownedDir,
  ownedFile,
  ownerSessionDir,
  trashDir,
} from "./session-delete-helpers.js";
import { OWNER_ID } from "./session-supervisor-helpers.js";

deleteWorlds();

const REPLACED_BEFORE_MOVE = "session delete: artifact directory was replaced before it was moved";
const TRASH_UNAVAILABLE = "session delete: trash directory is unavailable";
const ARTIFACT_TREE = ["1.bash.log", "local", join("local", "note.txt")];

/** Every entry under `dir` with its type and, for files, its bytes: "unchanged" means equal. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .sort()
    .map((entry) => {
      const stats = lstatSync(join(dir, entry));
      const body = stats.isFile() ? readFileSync(join(dir, entry), "utf8") : "";
      return `${entry} ${stats.isDirectory() ? "dir" : "file"} ${body}`;
    });
}

/** A state dir with the owner session dir, the trash, a session file and its artifact directory. */
function seededState() {
  const stateDir = join(ownedDir(), "state");
  const dir = ownerSessionDir(stateDir);
  const file = ownedFile(dir);
  return { stateDir, dir, file, artifacts: ownedArtifactDir(file), trash: trashDir(stateDir) };
}

/** `removeSessionFile` with `before` run at the rename call site, then the real rename. */
async function removeWithSwap(
  seeded: ReturnType<typeof seededState>,
  before: () => void,
): Promise<{ reports: string[]; renames: number }> {
  const reports: string[] = [];
  let renames = 0;
  await removeSessionFile(
    seeded.file,
    seeded.stateDir,
    OWNER_ID,
    (error) => {
      reports.push((error as Error).message);
    },
    (from, to) => {
      renames += 1;
      before();
      return rename(from, to);
    },
  );
  return { reports, renames };
}

describe("DELETE removes the artifact directory through the trash (#706)", () => {
  it("moves a non-empty artifact directory out and removes it: the trash ends empty, nothing outside changes", async () => {
    const world = await openRealWorld();
    const { stateDir } = world.rt.runtime;
    const dir = ownerSessionDir(stateDir);
    const file = ownedFile(dir);
    const artifacts = ownedArtifactDir(file);
    const outside = ownedFile();
    const content = readFileSync(outside, "utf8");
    symlinkSync(outside, join(artifacts, "local", "outside-link"));

    await deleteNaming(world, file);

    expect([existsSync(file), existsSync(artifacts)]).toEqual([false, false]);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(trashDir(stateDir))).toEqual([]);
    expect(lstatSync(trashDir(stateDir)).mode & 0o7777).toBe(0o700);
    expect(readFileSync(outside, "utf8")).toBe(content);
    expect(world.errors).toEqual([]);
  });

  it("swapped for a symlink before the rename: only the link is unlinked, its target tree is untouched, one report", async () => {
    const seeded = seededState();
    const target = ownedArtifactDir(join(ownedDir(), "target.jsonl"));
    const before = snapshot(target);

    const { reports, renames } = await removeWithSwap(seeded, () => {
      rmSync(seeded.artifacts, { recursive: true });
      symlinkSync(target, seeded.artifacts);
    });

    expect(renames).toBe(1);
    expect(reports).toEqual([REPLACED_BEFORE_MOVE]);
    expect(snapshot(target)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(ARTIFACT_TREE);
    expect(readdirSync(seeded.dir)).toEqual([]);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("swapped for a regular file before the rename: the file is unlinked, one report", async () => {
    const seeded = seededState();

    const { reports } = await removeWithSwap(seeded, () => {
      rmSync(seeded.artifacts, { recursive: true });
      writeFileSync(seeded.artifacts, "planted");
    });

    expect(reports).toEqual([REPLACED_BEFORE_MOVE]);
    expect(readdirSync(seeded.dir)).toEqual([]);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("gone before the rename (ENOENT, and the source is checked to be absent): nothing reported", async () => {
    const seeded = seededState();

    const { reports, renames } = await removeWithSwap(seeded, () => {
      rmSync(seeded.artifacts, { recursive: true });
    });

    expect(renames).toBe(1);
    expect(reports).toEqual([]);
    expect(readdirSync(seeded.dir)).toEqual([]);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  const unavailable = [
    { what: "a regular file", content: "not-a-directory", code: "ENOTDIR" },
    { what: "missing", content: null, code: "ENOENT" },
  ] as const;

  for (const { what, content, code } of unavailable) {
    it(`the trash is ${what}: 204, the artifact directory stays where it was, one report`, async () => {
      const world = await openRealWorld();
      const { stateDir } = world.rt.runtime;
      const file = ownedFile(ownerSessionDir(stateDir));
      const artifacts = ownedArtifactDir(file);
      const before = snapshot(artifacts);
      rmSync(trashDir(stateDir), { recursive: true });
      if (content !== null) {
        writeFileSync(trashDir(stateDir), content);
      }

      await deleteNaming(world, file);

      expect(existsSync(file)).toBe(false);
      expect(snapshot(artifacts)).toEqual(before);
      expect(before.map((line) => line.split(" ")[0])).toEqual(ARTIFACT_TREE);
      expect(existsSync(trashDir(stateDir))).toBe(content !== null);
      // ENOTDIR is rename's own error; ENOENT is told apart from "source gone" and wrapped.
      const reported = world.errors.map((error) =>
        error.message === TRASH_UNAVAILABLE ? error.cause : error,
      );
      expect(reported.map((error) => (error as NodeJS.ErrnoException).code)).toEqual([code]);
      expect(world.errors.map((error) => error.message === TRASH_UNAVAILABLE)).toEqual([
        code === "ENOENT",
      ]);
    });
  }

  it("a rename failing with EXDEV: the artifact directory is reported and left in place (no in-place removal here)", async () => {
    const seeded = seededState();
    const before = snapshot(seeded.artifacts);
    const reports: unknown[] = [];

    await removeSessionFile(
      seeded.file,
      seeded.stateDir,
      OWNER_ID,
      (error) => reports.push(error),
      () => Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" })),
    );

    expect(reports.map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["EXDEV"]);
    expect(snapshot(seeded.artifacts)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(ARTIFACT_TREE);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("a state dir reached through a symlink still uses the trash under its realpath", async () => {
    const seeded = seededState();
    const link = join(ownedDir(), "state-link");
    symlinkSync(seeded.stateDir, link);
    const moves: string[] = [];
    const reports: unknown[] = [];

    await removeSessionFile(
      join(link, "sessions", OWNER_ID, "owned.jsonl"),
      link,
      OWNER_ID,
      (error) => reports.push(error),
      (from, to) => {
        moves.push(String(to));
        return rename(from, to);
      },
    );

    expect(reports).toEqual([]);
    expect(moves).toHaveLength(1);
    const [parent, name] = [dirname(moves[0] ?? ""), basename(moves[0] ?? "")];
    expect(parent).toBe(join(realpathSync(seeded.stateDir), "trash"));
    expect(name).toMatch(/^[0-9a-f]{32}$/u);
    expect(existsSync(seeded.artifacts)).toBe(false);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });
});
