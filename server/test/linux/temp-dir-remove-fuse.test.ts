/**
 * Issue 1493 (sandbox-boundary-closure S3a, #1237): temporary-workspaces 「临时空间目录的删除」, the
 * mount rule — 「目录内有活挂载（trash 路径）」「目录内有活挂载（EXDEV 原地路径）」「非 opt-in 明示跳过」.
 * A real bindfs mount of a test-owned source directory is the only top-level entry (`mnt`) of
 * `tmp-<id>`, and the module boundary `removeTemporaryWorkspaceDir` runs on it with the production
 * `rename`: once with the trash on the account root's file system, once with the trash on
 * WORKBUDDY_FUSE_ALT_FS_DIR so the real rename fails with EXDEV. No HTTP, no omp: the 204 is pinned
 * by session-delete-temp-workspace.test.ts; this file only proves the file-system boundary.
 * Opt-in only (owner B7): Linux and WORKBUDDY_FUSE_TEST=1, run by hand in a disposable container on
 * the test host; skipped everywhere else, CI included. Opted in, a missing prerequisite (bindfs and
 * fusermount3 on PATH, /dev/fuse, WORKBUDDY_FUSE_ALT_FS_DIR a writable directory on another file
 * system) fails the suite instead of skipping it.
 * "Still mounted" is the mount point's path in /proc/self/mountinfo: bindfs shows fstype `fuse`
 * (measured on the test host, design D7 probe (5)), so the mount table is never searched for the
 * tool's name. Each case mounts on a fresh empty `mnt` (bindfs refuses a non-empty mount point,
 * probe (6)). Nothing sits next to `mnt`: `rm` removes siblings in parallel and returns on the
 * first error (design D8), so the fate of a sibling would be a race; none is asserted.
 * Cleanup unmounts with `fusermount3 -u` and fails the test if that fails or a mount is left; only
 * then is the test-owned tree removed, and with fs/promises `rm`, never `rmSync` (probe (2): it
 * crosses a live FUSE mount).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeTemporaryWorkspaceDir } from "../../src/workspaces/temp-dir-remove.js";

const OPT_IN = "WORKBUDDY_FUSE_TEST";
const ALT_FS = "WORKBUDDY_FUSE_ALT_FS_DIR";
const CASE_TIMEOUT_MS = 30_000;
/** `removeDirThroughTrash` names each batch with 16 random bytes in hex. */
const BATCH_NAME = /^[0-9a-f]{32}$/u;
/** The mounted source: test-owned, nested, with a binary file. */
const SOURCE_FILES: ReadonlyArray<readonly [string, Buffer]> = [
  ["notes.md", Buffer.from("# kept\n")],
  ["data.bin", randomBytes(4096)],
  [join("nested", "deep.txt"), Buffer.from("deep\n")],
];

interface World {
  accountRoot: string;
  name: string;
  mnt: string;
  source: string;
  sourceSum: string;
  trash: string;
}

/** Test-owned roots of the current case; `afterEach` unmounts below them, then removes them. */
const owned: string[] = [];

describe.skipIf(process.platform !== "linux" || process.env[OPT_IN] !== "1")(
  `temporary workspace removal over a live FUSE mount (Linux only; opt in with ${OPT_IN}=1)`,
  () => {
    let altFs = "";

    beforeAll(() => {
      altFs = requirePrerequisites();
    });

    afterEach(async () => {
      await unmountAndRemoveOwned();
    });

    it("目录内有活挂载（trash 路径）: resolves, source bytes kept, the mount moved to trash/<batch>/mnt, one EBUSY", {
      timeout: CASE_TIMEOUT_MS,
    }, async () => {
      const base = ownedTempDir(tmpdir());
      const world = seedMounted(base, join(base, "state", "trash"));
      expect(statSync(world.trash).dev).toBe(statSync(world.accountRoot).dev);

      const reports = await removeReporting(world);

      expect(checksum(world.source), "source directory bytes").toBe(world.sourceSum);
      const batches = readdirSync(world.trash);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatch(BATCH_NAME);
      const residue = join(world.trash, String(batches[0]));
      expect(readdirSync(residue)).toEqual(["mnt"]);
      expect(mountPoints()).toContain(join(residue, "mnt"));
      expect(mountPoints()).not.toContain(world.mnt);
      expect(checksum(join(residue, "mnt")), "mnt still shows the source").toBe(world.sourceSum);
      expect(existsSync(join(world.accountRoot, world.name))).toBe(false);
      expectOneEbusy(reports);
    });

    it("目录内有活挂载（EXDEV 原地路径）: resolves, source bytes kept, the mount stays at tmp-<id>/mnt, one EBUSY", {
      timeout: CASE_TIMEOUT_MS,
    }, async () => {
      const base = ownedTempDir(tmpdir());
      const world = seedMounted(base, join(ownedTempDir(altFs), "trash"));
      expect(statSync(world.trash).dev).not.toBe(statSync(world.accountRoot).dev);

      const reports = await removeReporting(world);

      expect(checksum(world.source), "source directory bytes").toBe(world.sourceSum);
      expect(readdirSync(join(world.accountRoot, world.name))).toEqual(["mnt"]);
      expect(mountPoints()).toContain(world.mnt);
      expect(readdirSync(world.trash)).toEqual([]);
      expectOneEbusy(reports);
    });
  },
);

/** The prerequisites of an opted-in run; any missing one throws (the suite fails, no skip). */
function requirePrerequisites(): string {
  const missing: string[] = [];
  for (const tool of ["bindfs", "fusermount3"]) {
    if (!onPath(tool)) {
      missing.push(`${tool} is not on PATH`);
    }
  }
  if (!existsSync("/dev/fuse") || !statSync("/dev/fuse").isCharacterDevice()) {
    missing.push("/dev/fuse is not available");
  }
  const alt = process.env[ALT_FS] ?? "";
  if (alt === "") {
    missing.push(`${ALT_FS} is not set`);
  } else if (!isWritableDir(alt)) {
    missing.push(`${ALT_FS} is not a writable directory`);
  } else if (statSync(alt).dev === statSync(tmpdir()).dev) {
    missing.push(`${ALT_FS} is on the same file system as the account root (${tmpdir()})`);
  }
  if (missing.length > 0) {
    throw new Error(`${OPT_IN}=1 but the FUSE prerequisites are missing: ${missing.join("; ")}`);
  }
  return alt;
}

function onPath(tool: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && isExecutableFile(join(dir, tool)));
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isWritableDir(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A fresh realpath'd directory under `parent`, recorded for the cleanup. */
function ownedTempDir(parent: string): string {
  const dir = realpathSync.native(mkdtempSync(join(parent, "wb-fuse-")));
  owned.push(dir);
  return dir;
}

/**
 * `<base>/source` (the files above), `<base>/sandbox/u1/tmp-<id>/mnt` (new, empty, the only entry
 * of `tmp-<id>`) with the source bindfs-mounted on it, and an empty 0700 `trash`.
 */
function seedMounted(base: string, trash: string): World {
  const source = join(base, "source");
  for (const [relative, bytes] of SOURCE_FILES) {
    mkdirSync(dirname(join(source, relative)), { recursive: true });
    writeFileSync(join(source, relative), bytes);
  }
  const accountRoot = join(base, "sandbox", "u1");
  const name = `tmp-${randomBytes(16).toString("hex")}`;
  const mnt = join(accountRoot, name, "mnt");
  mkdirSync(mnt, { recursive: true });
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  const mounted = spawnSync("bindfs", [source, mnt], { encoding: "utf8" });
  if (mounted.status !== 0) {
    throw new Error(`bindfs failed (${String(mounted.status)}): ${mounted.stderr}`);
  }
  expect(mountPoints(), "bindfs mounted mnt").toContain(mnt);
  expect(readdirSync(join(accountRoot, name))).toEqual(["mnt"]);
  return { accountRoot, name, mnt, source, sourceSum: checksum(source), trash };
}

/** The production removal with its real `rename`; resolving (not throwing) is asserted here. */
async function removeReporting(world: World): Promise<unknown[]> {
  const reports: unknown[] = [];
  await expect(
    removeTemporaryWorkspaceDir(
      { accountRoot: world.accountRoot, name: world.name, trash: world.trash },
      (error) => {
        reports.push(error);
      },
    ),
  ).resolves.toBeUndefined();
  return reports;
}

/** The error channel reported exactly once, and that once is the mount point's EBUSY. */
function expectOneEbusy(reports: unknown[]): void {
  const codes = reports.map((error) => (error as NodeJS.ErrnoException).code);
  expect(codes).toEqual(["EBUSY"]);
}

/** Every relative path below `dir` (sorted) with its type, and each file's bytes, as one hash. */
function checksum(dir: string): string {
  const hash = createHash("sha256");
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  for (const relative of entries) {
    const path = join(dir, relative);
    if (lstatSync(path).isFile()) {
      hash.update(`f ${relative}\0`).update(readFileSync(path));
    } else {
      hash.update(`d ${relative}\0`);
    }
  }
  return hash.digest("hex");
}

/** Mount points (field 5 of /proc/self/mountinfo, octal escapes such as `\040` decoded). */
function mountPoints(): string[] {
  return readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) =>
      String(line.split(" ")[4]).replace(/\\([0-7]{3})/gu, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      ),
    );
}

/**
 * `fusermount3 -u` every mount below this case's roots (deepest first); a failed unmount or a mount
 * still listed afterwards fails the test and leaves the tree in place. Then the roots go.
 */
async function unmountAndRemoveOwned(): Promise<void> {
  const roots = owned.splice(0);
  const below = (point: string) => roots.some((root) => point.startsWith(`${root}/`));
  const failures: string[] = [];
  for (const point of mountPoints()
    .filter(below)
    .sort((a, b) => b.length - a.length)) {
    const result = spawnSync("fusermount3", ["-u", point], { encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(`${point}: ${result.stderr || String(result.error)}`);
    }
  }
  const left = mountPoints().filter(below);
  if (failures.length > 0 || left.length > 0) {
    throw new Error(
      `fusermount3 -u failed: ${failures.join("; ")}; still mounted: ${left.join(", ")}`,
    );
  }
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
}
