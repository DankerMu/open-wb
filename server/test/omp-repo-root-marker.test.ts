/**
 * Issue #1567 (omp-pin-18-12 task 3.2): `ensureRepoRootMarker`, pure filesystem — omp-runtime
 * 「会话工作目录的仓库根标记」, Scenario「spawn 前建出标记」 at the function's own seam. Real
 * directories under a fresh temporary parent; the fs set is swapped only to act between two of the
 * function's calls (a concurrent `git init`, a symlink swap) or to observe which calls ran. Expected
 * modes are the spec's literal `2770`, under umask `022` and a parent without the setgid bit.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRepoRootMarker, markerFs } from "../src/sessions/omp/repo-root-marker.js";

const MARKER_MODE = 0o2770;
const IS_ROOT = process.getuid?.() === 0;
const temps: string[] = [];
let savedUmask = 0;

beforeEach(() => {
  savedUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(savedUmask);
  for (const dir of temps.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A cwd directory at 0755 whose parent has no setgid bit either. */
function makeCwd(): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "omp-repo-marker-")));
  temps.push(parent);
  chmodSync(parent, 0o755);
  const cwd = join(parent, "proj");
  mkdirSync(cwd, { mode: 0o755 });
  return cwd;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** The fs set with the given calls replaced and every call's name recorded. */
function recordingFs(overrides: Partial<typeof markerFs> = {}): {
  fs: typeof markerFs;
  calls: string[];
} {
  const calls: string[] = [];
  const fs = { ...markerFs, ...overrides };
  const recorded = Object.fromEntries(
    Object.entries(fs).map(([name, call]) => [
      name,
      (...args: unknown[]) => {
        calls.push(name);
        return (call as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as typeof markerFs;
  return { fs: recorded, calls };
}

describe("ensureRepoRootMarker: a missing marker", () => {
  it("makes an empty directory at exactly 2770, owned by this process, in a 0755 cwd under umask 022", () => {
    const cwd = makeCwd();
    expect(modeOf(cwd)).toBe(0o755);

    ensureRepoRootMarker(cwd);

    const marker = join(cwd, ".git");
    const stats = lstatSync(marker);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o7777).toBe(MARKER_MODE);
    expect(stats.uid).toBe(process.geteuid?.());
    expect(readdirSync(marker)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([".git"]);
    expect(modeOf(cwd)).toBe(0o755);
  });

  it("leaves the marker it made alone on the next call: same inode, same mode, no mkdir", () => {
    const cwd = makeCwd();
    ensureRepoRootMarker(cwd);
    const marker = join(cwd, ".git");
    const inode = lstatSync(marker).ino;
    const { fs, calls } = recordingFs();

    ensureRepoRootMarker(cwd, fs);

    expect(calls).toEqual(["lstatSync"]);
    expect(lstatSync(marker).ino).toBe(inode);
    expect(modeOf(marker)).toBe(MARKER_MODE);
  });
});

describe("ensureRepoRootMarker: an existing entry named .git is left alone", () => {
  it("a real repository directory keeps its HEAD and its mode", () => {
    const cwd = makeCwd();
    const marker = join(cwd, ".git");
    mkdirSync(marker, { mode: 0o755 });
    writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n");
    const { fs, calls } = recordingFs();

    ensureRepoRootMarker(cwd, fs);

    expect(calls).toEqual(["lstatSync"]);
    expect(readFileSync(join(marker, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(modeOf(marker)).toBe(0o755);
  });

  it("a regular file stays a file with its bytes and mode", () => {
    const cwd = makeCwd();
    const marker = join(cwd, ".git");
    writeFileSync(marker, "gitdir: ../elsewhere\n", { mode: 0o644 });

    ensureRepoRootMarker(cwd);

    expect(lstatSync(marker).isFile()).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("gitdir: ../elsewhere\n");
    expect(modeOf(marker)).toBe(0o644);
  });

  it("a symbolic link to a directory stays a link and its target's mode is unchanged", () => {
    const cwd = makeCwd();
    const target = join(cwd, "..", "target");
    mkdirSync(target, { mode: 0o750 });
    chmodSync(target, 0o750);
    const marker = join(cwd, ".git");
    symlinkSync(target, marker, "dir");

    ensureRepoRootMarker(cwd);

    expect(lstatSync(marker).isSymbolicLink()).toBe(true);
    expect(readlinkSync(marker)).toBe(target);
    expect(modeOf(target)).toBe(0o750);
    expect(readdirSync(target)).toEqual([]);
  });

  it("a dangling symbolic link stays dangling", () => {
    const cwd = makeCwd();
    const marker = join(cwd, ".git");
    const nowhere = join(cwd, "..", "nowhere");
    symlinkSync(nowhere, marker);

    ensureRepoRootMarker(cwd);

    expect(lstatSync(marker).isSymbolicLink()).toBe(true);
    expect(readlinkSync(marker)).toBe(nowhere);
    expect(existsSync(nowhere)).toBe(false);
  });

  it("EEXIST from mkdir after lstat saw nothing (a concurrent git init) is success with no chmod", () => {
    const cwd = makeCwd();
    const marker = join(cwd, ".git");
    const { fs, calls } = recordingFs({
      mkdirSync: ((path: string) => {
        // The other process wins the race between lstat and mkdir.
        mkdirSync(path, { mode: 0o755 });
        chmodSync(path, 0o755);
        writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
        return mkdirSync(path);
      }) as typeof markerFs.mkdirSync,
    });

    expect(() => ensureRepoRootMarker(cwd, fs)).not.toThrow();

    expect(calls).toEqual(["lstatSync", "mkdirSync"]);
    expect(modeOf(marker)).toBe(0o755);
    expect(readdirSync(marker)).toEqual(["HEAD"]);
  });
});

describe("ensureRepoRootMarker: failures", () => {
  it("a .git swapped for a symbolic link between mkdir and the mode change fails, the target's mode unchanged", () => {
    const cwd = makeCwd();
    const marker = join(cwd, ".git");
    const target = join(cwd, "..", "agent");
    mkdirSync(target, { mode: 0o750 });
    chmodSync(target, 0o750);
    const { fs, calls } = recordingFs({
      mkdirSync: ((path: string) => {
        mkdirSync(path);
        // The omp uid can write the cwd: it replaces the fresh directory with a link.
        rmdirSync(path);
        symlinkSync(target, path, "dir");
        return undefined;
      }) as typeof markerFs.mkdirSync,
    });

    expect(() => ensureRepoRootMarker(cwd, fs)).toThrow();

    expect(calls).toEqual(["lstatSync", "mkdirSync", "openSync"]);
    expect(modeOf(target)).toBe(0o750);
    expect(lstatSync(marker).isSymbolicLink()).toBe(true);
  });

  it("an open handle that is not a directory fails and is closed, nothing chmodded", () => {
    const cwd = makeCwd();
    const { fs, calls } = recordingFs({
      fstatSync: (() => ({ isDirectory: () => false })) as unknown as typeof markerFs.fstatSync,
    });

    expect(() => ensureRepoRootMarker(cwd, fs)).toThrow("repo-root marker is not a directory");

    expect(calls).toEqual(["lstatSync", "mkdirSync", "openSync", "fstatSync", "closeSync"]);
  });

  it("a missing cwd fails with ENOENT and is not recreated", () => {
    const cwd = makeCwd();
    rmdirSync(cwd);

    expect(() => ensureRepoRootMarker(cwd)).toThrow(expect.objectContaining({ code: "ENOENT" }));

    expect(existsSync(cwd)).toBe(false);
  });

  it.skipIf(IS_ROOT)("an unwritable cwd fails and stays empty", () => {
    const cwd = makeCwd();
    chmodSync(cwd, 0o555);
    try {
      expect(() => ensureRepoRootMarker(cwd)).toThrow(expect.objectContaining({ code: "EACCES" }));
    } finally {
      chmodSync(cwd, 0o755);
    }

    expect(readdirSync(cwd)).toEqual([]);
  });
});
