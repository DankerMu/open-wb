/**
 * Issue #758 DELETE /api/sessions/:id, the session file's artifact directory (change
 * session-delete-sibling-dir tasks 1.3): omp keeps a directory named like the session `.jsonl`
 * without the suffix next to it; a delete removes it after the file, under the same validated owner
 * session dir, without following symlinks and without ever failing the 204. Letters follow the
 * fixture's task list. Production createApp → registerSessions, real SQLite, real files under the
 * runtime's temp state dir; the oracles are the file system and the service error channel.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { settle } from "./session-approval-helpers.js";
import {
  deleteNaming,
  deleteWorlds,
  expectDeleted,
  openRealWorld,
  ownedArtifactDir,
  ownedDir,
  ownedFile,
  ownerSessionDir,
  sendDelete,
  sessionFileOf,
  sessionState,
  track,
  trashDir,
} from "./session-delete-helpers.js";
import { turn } from "./session-fork-helpers.js";
import { QUESTION, regenerate } from "./session-regenerate-helpers.js";
import {
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  waitForTurn,
} from "./session-supervisor-helpers.js";

deleteWorlds();

const OUTSIDE_SESSION_DIR = "session delete: session file outside the owner session dir";
const NOT_REGULAR_FILE = "session delete: session file is not a regular file";
const NO_ARTIFACT_NAME = "session delete: session file name leaves no artifact directory name";
const NOT_A_DIRECTORY = "session delete: artifact directory is not a directory";
const ARTIFACT_TREE = ["1.bash.log", "local", join("local", "note.txt")];

type RealWorld = Awaited<ReturnType<typeof openRealWorld>>;

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

function messages(world: RealWorld): string[] {
  return world.errors.map((error) => error.message);
}

describe("DELETE removes the session file's artifact directory (#758)", () => {
  it("(a) an idle session's fake-omp branch file and its artifact directory are both gone", {
    timeout: 30_000,
  }, async () => {
    const world = await openRealWorld("branch");
    const { app, db } = world.fixture;
    await turn(world, QUESTION);
    await regenerate(world);
    await waitForTurn(world.fixture, world.session, "done");
    await settle();
    const file = sessionFileOf(db, world.session) ?? "";
    const dir = ownerSessionDir(world.rt.runtime.stateDir);
    expect([dirname(file), basename(file).startsWith("branch-")]).toEqual([dir, true]);
    const artifacts = file.slice(0, -".jsonl".length);
    expect(tree(artifacts)).toEqual(ARTIFACT_TREE);

    expectDeleted(await sendDelete(app, world.session, world.cookie));

    expect(sessionState(db, world.session).row).toBeUndefined();
    expect([existsSync(file), existsSync(artifacts)]).toEqual([false, false]);
    expect(existsSync(dir)).toBe(true);
    expect(world.errors).toEqual([]);
  });

  it("(b) no artifact directory: 204 and nothing reported", async () => {
    const world = await openRealWorld();
    const dir = ownerSessionDir(world.rt.runtime.stateDir);
    const file = ownedFile(dir);
    const neighbour = ownedArtifactDir(ownedFile(dir, "other.jsonl"));

    await deleteNaming(world, file);

    expect(existsSync(file)).toBe(false);
    expect(tree(neighbour)).toEqual(ARTIFACT_TREE);
    expect(world.errors).toEqual([]);
  });

  it("(c) a symlink in the directory's place is reported once; link and target are untouched", async () => {
    const world = await openRealWorld();
    const file = ownedFile(ownerSessionDir(world.rt.runtime.stateDir));
    const target = ownedArtifactDir(join(ownedDir(), "target.jsonl"));
    const link = file.slice(0, -".jsonl".length);
    symlinkSync(target, link);

    await deleteNaming(world, file);

    expect(existsSync(file)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(tree(target)).toEqual(ARTIFACT_TREE);
    expect(messages(world)).toEqual([NOT_A_DIRECTORY]);
  });

  it("(d) a session file that fails validation leaves the owner dir's same-named directory alone", async () => {
    const world = await openRealWorld();
    const dir = ownerSessionDir(world.rt.runtime.stateDir);
    // Outside the owner dir, while `<owner dir>/owned/` exists.
    const outside = ownedFile();
    const besideOutside = ownedArtifactDir(join(dir, basename(outside)));
    // A symlink and a directory inside the owner dir, each with its same-named directory.
    const link = join(dir, "link.jsonl");
    symlinkSync(ownedFile(), link);
    const besideLink = ownedArtifactDir(link);
    const folder = join(dir, "folder.jsonl");
    mkdirSync(folder);
    const besideFolder = ownedArtifactDir(folder);

    for (const file of [outside, link, folder]) {
      await deleteNaming(world, file);
    }

    for (const kept of [besideOutside, besideLink, besideFolder]) {
      expect(tree(kept)).toEqual(ARTIFACT_TREE);
    }
    expect(existsSync(outside)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(folder).isDirectory()).toBe(true);
    expect(messages(world)).toEqual([OUTSIDE_SESSION_DIR, NOT_REGULAR_FILE, NOT_REGULAR_FILE]);
  });

  it("(e) a failing recursive removal is reported once and leaves its residue in the trash; still 204 and the row gone", async () => {
    const world = await openRealWorld();
    const { stateDir } = world.rt.runtime;
    const file = ownedFile(ownerSessionDir(stateDir));
    const artifacts = ownedArtifactDir(file);
    const trash = trashDir(stateDir);
    // A read-only (0500) nested directory: its entry cannot be unlinked, so the removal is partial.
    chmodSync(join(artifacts, "local"), 0o500);
    let residue: string[] = [];
    try {
      await deleteNaming(world, file);
      residue = readdirSync(trash);
      expect(residue).toHaveLength(1);
      expect(residue[0]).toMatch(/^[0-9a-f]{32}$/u);
      expect(tree(join(trash, residue[0] ?? ""))).toEqual(["local", join("local", "note.txt")]);
    } finally {
      // Wherever the locked directory ended up, teardown must be able to empty it.
      for (const holder of [artifacts, ...readdirSync(trash).map((name) => join(trash, name))]) {
        if (existsSync(join(holder, "local"))) {
          chmodSync(join(holder, "local"), 0o700);
        }
      }
    }

    expect([existsSync(file), existsSync(artifacts)]).toEqual([false, false]);
    expect(world.errors).toHaveLength(1);
    expect((world.errors[0] as NodeJS.ErrnoException).code).toBe("EACCES");
  });

  it("(f) symlinks inside the artifact directory are removed, never followed", async () => {
    const world = await openRealWorld();
    const file = ownedFile(ownerSessionDir(world.rt.runtime.stateDir));
    const artifacts = ownedArtifactDir(file);
    const outsideFile = ownedFile();
    const content = readFileSync(outsideFile, "utf8");
    const outsideDir = ownedArtifactDir(join(ownedDir(), "kept.jsonl"));
    symlinkSync(outsideFile, join(artifacts, "file-link"));
    symlinkSync(outsideDir, join(artifacts, "local", "dir-link"));

    await deleteNaming(world, file);

    expect([existsSync(file), existsSync(artifacts)]).toEqual([false, false]);
    expect(readFileSync(outsideFile, "utf8")).toBe(content);
    expect(tree(outsideDir)).toEqual(ARTIFACT_TREE);
    expect(world.errors).toEqual([]);
  });

  it("(g) `.jsonl`, `..jsonl` and `...jsonl` are unlinked and reported; no directory is touched", async () => {
    const world = await openRealWorld();
    const { stateDir } = world.rt.runtime;
    const dir = ownerSessionDir(stateDir);
    const bystander = ownedArtifactDir(ownedFile(dir, "bystander.jsonl"));
    const marker = join(dirname(dir), "marker");
    writeFileSync(marker, "sessions-level file\n");

    for (const [index, name] of [".jsonl", "..jsonl", "...jsonl"].entries()) {
      const file = ownedFile(dir, name);

      await deleteNaming(world, file);

      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dirname(dir)).sort()).toEqual(["marker", basename(dir)].sort());
      expect(readdirSync(dir).sort()).toEqual(["bystander", "bystander.jsonl"]);
      expect(tree(bystander)).toEqual(ARTIFACT_TREE);
      expect(messages(world)).toEqual(Array.from({ length: index + 1 }, () => NO_ARTIFACT_NAME));
    }
    expect(existsSync(stateDir)).toBe(true);
  });

  it("(h) the session file is already gone: its artifact directory is still removed, no report", async () => {
    const world = await openRealWorld();
    const dir = ownerSessionDir(world.rt.runtime.stateDir);
    const missing = join(dir, "missing.jsonl");
    const artifacts = ownedArtifactDir(missing);
    expect(existsSync(missing)).toBe(false);

    await deleteNaming(world, missing);

    expect(existsSync(artifacts)).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(world.errors).toEqual([]);
  });
});

/**
 * `sessions` and `sessions/<ownerId>` are writable by the omp group. A symlink standing at either
 * level resolves on both sides of the parent comparison, so only the comparison with
 * `<state realpath>/sessions/<ownerId>` tells it apart (fixture review round 1, F1/F2).
 */
describe("DELETE rejects a symlinked session dir level (#758 F2)", () => {
  /**
   * `level` under the state dir replaced by a symlink to a directory outside it; returns the
   * outside directory that now stands for the owner session dir.
   */
  function symlinkedLevel(stateDir: string, level: "sessions" | "owner"): string {
    const sessions = join(stateDir, "sessions");
    rmSync(sessions, { recursive: true, force: true });
    const outside = ownedDir();
    if (level === "sessions") {
      mkdirSync(stateDir, { recursive: true });
      symlinkSync(outside, sessions);
      mkdirSync(join(outside, OWNER_ID));
      return join(outside, OWNER_ID);
    }
    mkdirSync(sessions, { recursive: true });
    symlinkSync(outside, join(sessions, OWNER_ID));
    return outside;
  }

  const cases = [
    { letter: "(i)", level: "owner", withFile: true, what: "file and directory" },
    { letter: "(j)", level: "owner", withFile: false, what: "directory, the file being absent," },
    { letter: "(k)", level: "sessions", withFile: true, what: "file and directory" },
  ] as const;

  for (const { letter, level, withFile, what } of cases) {
    it(`${letter} a symlinked \`${level}\` level: the outside ${what} are left alone, one report`, async () => {
      const world = await openRealWorld();
      const { stateDir } = world.rt.runtime;
      const outside = symlinkedLevel(stateDir, level);
      const real = join(outside, "owned.jsonl");
      if (withFile) {
        ownedFile(outside);
      }
      const artifacts = ownedArtifactDir(real);

      await deleteNaming(world, join(stateDir, "sessions", OWNER_ID, "owned.jsonl"));

      expect(tree(artifacts)).toEqual(ARTIFACT_TREE);
      expect(existsSync(real)).toBe(withFile);
      expect(messages(world)).toEqual([OUTSIDE_SESSION_DIR]);
    });
  }

  it("(l) a state dir that is itself a symlink to the real state dir deletes normally", async () => {
    const rt = createRealFakeRuntime();
    const link = join(ownedDir(), "state-link");
    mkdirSync(rt.runtime.stateDir, { recursive: true });
    symlinkSync(rt.runtime.stateDir, link);
    const opened = await openRecordingSession({ ...rt.runtime, stateDir: link });
    track(opened.fixture);
    const world = { ...opened, rt };
    const file = ownedFile(ownerSessionDir(link));
    const artifacts = ownedArtifactDir(file);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(rt.runtime.stateDir, "sessions", OWNER_ID, "owned"))).toBe(true);

    await deleteNaming(world, file);

    expect([existsSync(file), existsSync(artifacts)]).toEqual([false, false]);
    expect(world.errors).toEqual([]);
  });
});
