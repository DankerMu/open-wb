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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { settle } from "./session-approval-helpers.js";
import {
  deleteWorlds,
  expectDeleted,
  openRealWorld,
  ownedArtifactDir,
  ownedDir,
  ownedFile,
  ownerSessionDir,
  presetFile,
  sendDelete,
  sessionFileOf,
  sessionState,
} from "./session-delete-helpers.js";
import { turn } from "./session-fork-helpers.js";
import { QUESTION, regenerate } from "./session-regenerate-helpers.js";
import { createSession, waitForTurn } from "./session-supervisor-helpers.js";

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

/** A fresh never-prompted session whose row names `file`, deleted: 204 and the row is gone. */
async function deleteNaming(world: RealWorld, file: string): Promise<void> {
  const { app, db } = world.fixture;
  const session = await createSession(app, world.cookie);
  presetFile(db, session, file);
  expectDeleted(await sendDelete(app, session, world.cookie));
  expect(sessionState(db, session).row).toBeUndefined();
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

  it("(e) a failing recursive removal is reported once; the DELETE is still 204 and the row gone", async () => {
    const world = await openRealWorld();
    const file = ownedFile(ownerSessionDir(world.rt.runtime.stateDir));
    const artifacts = ownedArtifactDir(file);
    // A read-only (0500) nested directory: its entry cannot be unlinked, so the removal is partial.
    const locked = join(artifacts, "local");
    chmodSync(locked, 0o500);
    try {
      await deleteNaming(world, file);
    } finally {
      chmodSync(locked, 0o700);
    }

    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(locked, "note.txt"))).toBe(true);
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
