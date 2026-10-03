import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOwnedDir, ensureSharedDir } from "../src/core/sandbox/dirs.js";

const tmpDirs: string[] = [];
const SHARED_MODE = 0o2770;
const EXISTING_MODE = 0o755;
/** #706 托管目录权限位: the managed (app-owned, group read-only) mode of the omp state layout. */
const MANAGED = 0o2750;

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "sandbox-dirs-"));
  tmpDirs.push(parent);
  return parent;
}

function existing0755Abc(): { a: string; b: string; c: string } {
  const parent = createParent();
  const a = join(parent, "a");
  const b = join(a, "b");
  const c = join(b, "c");
  mkdirSync(a);
  chmodSync(a, EXISTING_MODE);
  return { a, b, c };
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function expectUnchangedMetadata(path: string, before: Stats): void {
  const after = lstatSync(path);
  expect(after.mode).toBe(before.mode);
  expect(after.uid).toBe(before.uid);
  expect(after.gid).toBe(before.gid);
}

function expectUnchangedSymlink(path: string, before: Stats): void {
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expectUnchangedMetadata(path, before);
}

describe("core/sandbox ensureSharedDir", () => {
  it("creates three missing levels at exact mode 2770 and is unchanged on a second call", () => {
    const parent = createParent();
    const a = join(parent, "a");
    const b = join(a, "b");
    const c = join(b, "c");

    ensureSharedDir(c);

    expect(modeOf(a)).toBe(SHARED_MODE);
    expect(modeOf(b)).toBe(SHARED_MODE);
    expect(modeOf(c)).toBe(SHARED_MODE);

    ensureSharedDir(c);

    expect(modeOf(a)).toBe(SHARED_MODE);
    expect(modeOf(b)).toBe(SHARED_MODE);
    expect(modeOf(c)).toBe(SHARED_MODE);
  });

  it("leaves a pre-existing 0755 ancestor unchanged, does not chown, and does not change umask", () => {
    const { a, b, c } = existing0755Abc();
    const beforeUid = lstatSync(a).uid;
    const beforeGid = lstatSync(a).gid;
    const beforeUmask = process.umask();
    const chownSpy = vi.spyOn(fs, "chownSync");
    syncBuiltinESMExports();

    ensureSharedDir(c);

    expect(chownSpy).not.toHaveBeenCalled();
    expect(process.umask()).toBe(beforeUmask);
    expect(modeOf(a)).toBe(EXISTING_MODE);
    expect(lstatSync(a).uid).toBe(beforeUid);
    expect(lstatSync(a).gid).toBe(beforeGid);
    expect(modeOf(b)).toBe(SHARED_MODE);
    expect(modeOf(c)).toBe(SHARED_MODE);
  });

  it("throws on a regular-file collision and preserves existing file and directory state", () => {
    const { a, b, c } = existing0755Abc();
    writeFileSync(b, "not-a-directory");
    const beforeA = lstatSync(a);
    const beforeB = lstatSync(b);

    expect(() => ensureSharedDir(c)).toThrow();

    expect(modeOf(a)).toBe(EXISTING_MODE);
    expect(lstatSync(a).isDirectory()).toBe(true);
    expect(lstatSync(a).uid).toBe(beforeA.uid);
    expect(lstatSync(a).gid).toBe(beforeA.gid);
    expect(lstatSync(b).isFile()).toBe(true);
    expectUnchangedMetadata(b, beforeB);
    expect(() => lstatSync(c)).toThrow();
  });

  it("throws on a leaf regular-file collision and preserves file bytes, mode, and ownership", () => {
    const parent = createParent();
    const leaf = join(parent, "file");
    writeFileSync(leaf, "sentinel-bytes");
    const beforeLeaf = lstatSync(leaf);
    const beforeParent = lstatSync(parent);

    expect(() => ensureSharedDir(leaf)).toThrow();

    expect(readFileSync(leaf, "utf8")).toBe("sentinel-bytes");
    expect(lstatSync(leaf).isFile()).toBe(true);
    expectUnchangedMetadata(leaf, beforeLeaf);
    expect(lstatSync(parent).isDirectory()).toBe(true);
    expectUnchangedMetadata(parent, beforeParent);
  });

  it("leaves a pre-existing 0755 leaf directory unchanged", () => {
    const parent = createParent();
    const leaf = join(parent, "leaf");
    mkdirSync(leaf);
    chmodSync(leaf, EXISTING_MODE);
    const before = lstatSync(leaf);

    ensureSharedDir(leaf);

    expect(modeOf(leaf)).toBe(EXISTING_MODE);
    expect(lstatSync(leaf).isDirectory()).toBe(true);
    expect(lstatSync(leaf).uid).toBe(before.uid);
    expect(lstatSync(leaf).gid).toBe(before.gid);
  });

  it("rejects a leaf symlink to a regular file and leaves the link unchanged", () => {
    const parent = createParent();
    const target = join(parent, "target");
    const leaf = join(parent, "file-link");
    writeFileSync(target, "payload");
    symlinkSync(target, leaf);
    const beforeLink = lstatSync(leaf);
    const beforeTarget = lstatSync(target);

    expect(() => ensureSharedDir(leaf)).toThrow();

    expectUnchangedSymlink(leaf, beforeLink);
    expect(readFileSync(target, "utf8")).toBe("payload");
    expectUnchangedMetadata(target, beforeTarget);
  });

  it("rejects a dangling leaf symlink and leaves the link unchanged", () => {
    const parent = createParent();
    const leaf = join(parent, "dangling");
    symlinkSync(join(parent, "missing-target"), leaf);
    const before = lstatSync(leaf);

    expect(() => ensureSharedDir(leaf)).toThrow();

    expectUnchangedSymlink(leaf, before);
  });

  it("accepts a symlink to an existing directory without changing the target mode", () => {
    const parent = createParent();
    const target = join(parent, "real-dir");
    const leaf = join(parent, "dir-link");
    mkdirSync(target);
    chmodSync(target, EXISTING_MODE);
    symlinkSync(target, leaf);
    const beforeTarget = lstatSync(target);
    const beforeLink = lstatSync(leaf);

    ensureSharedDir(leaf);

    expectUnchangedSymlink(leaf, beforeLink);
    expect(modeOf(target)).toBe(EXISTING_MODE);
    expect(lstatSync(target).uid).toBe(beforeTarget.uid);
    expect(lstatSync(target).gid).toBe(beforeTarget.gid);
  });

  it("throws on a NAME_MAX leaf mkdir failure and leaves the parent directory unchanged", () => {
    const parent = createParent();
    const leaf = join(parent, "x".repeat(300));
    const beforeParent = lstatSync(parent);
    const beforeEntries = readdirSync(parent);

    expect(() => ensureSharedDir(leaf)).toThrow();

    expect(readdirSync(parent)).toEqual(beforeEntries);
    expect(lstatSync(parent).isDirectory()).toBe(true);
    expectUnchangedMetadata(parent, beforeParent);
    expect(() => lstatSync(leaf)).toThrow();
  });
});

function thrownBy(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("expected ensureOwnedDir to throw");
}

describe("core/sandbox ensureOwnedDir", () => {
  it("creates at the exact mode, corrects a widened mode, and issues no chmod when already exact", () => {
    const dir = join(createParent(), "d");

    ensureOwnedDir(dir, MANAGED);
    expect(modeOf(dir)).toBe(MANAGED);
    expect(lstatSync(dir).uid).toBe(process.geteuid?.());

    chmodSync(dir, 0o2777);
    ensureOwnedDir(dir, MANAGED);
    expect(modeOf(dir)).toBe(MANAGED);

    const chmodSpy = vi.spyOn(fs, "chmodSync");
    const chownSpy = vi.spyOn(fs, "chownSync");
    syncBuiltinESMExports();
    const umaskBefore = process.umask();
    ensureOwnedDir(dir, MANAGED);
    expect(chmodSpy).not.toHaveBeenCalled();
    expect(chownSpy).not.toHaveBeenCalled();
    expect(process.umask()).toBe(umaskBefore);
    expect(modeOf(dir)).toBe(MANAGED);
  });

  it.each([0o2750, 0o2770, 0o3770])("applies mode %o whatever the umask", (mode) => {
    const dir = join(createParent(), "d");
    const previous = process.umask(0o077);
    try {
      ensureOwnedDir(dir, mode);
    } finally {
      process.umask(previous);
    }
    expect(modeOf(dir)).toBe(mode);
  });

  it("narrows a directory that was wider and widens one that was narrower", () => {
    const parent = createParent();
    const wide = join(parent, "wide");
    const narrow = join(parent, "narrow");
    mkdirSync(wide);
    mkdirSync(narrow);
    chmodSync(wide, 0o2770);
    chmodSync(narrow, 0o700);

    ensureOwnedDir(wide, MANAGED);
    ensureOwnedDir(narrow, 0o3770);

    expect(modeOf(wide)).toBe(MANAGED);
    expect(modeOf(narrow)).toBe(0o3770);
  });

  it("rejects a regular file and leaves it untouched", () => {
    const file = join(createParent(), "occupied");
    writeFileSync(file, "not-a-directory");
    chmodSync(file, 0o644);

    const error = thrownBy(() => ensureOwnedDir(file, MANAGED));

    expect(error.message).toContain(file);
    expect(error.message).toContain("0o2750");
    expect(modeOf(file)).toBe(0o644);
    expect(readFileSync(file, "utf8")).toBe("not-a-directory");
  });

  it("rejects a symlink to a directory without following it", () => {
    const parent = createParent();
    const target = join(parent, "target");
    const link = join(parent, "link");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, link);

    const error = thrownBy(() => ensureOwnedDir(link, MANAGED));

    expect(error.message).toContain(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(modeOf(target)).toBe(0o755);
  });

  it("rejects a missing parent and creates nothing", () => {
    const parent = createParent();
    const nested = join(parent, "absent", "d");

    const error = thrownBy(() => ensureOwnedDir(nested, MANAGED));

    expect(error.message).toContain(nested);
    expect(existsSync(join(parent, "absent"))).toBe(false);
  });

  // The directory's current mode is passed, so no chmod is needed: only the owner check rejects it.
  it.skipIf(process.geteuid?.() === 0)("rejects a directory owned by another uid", () => {
    const foreign = "/usr";
    const before = lstatSync(foreign);
    expect(before.uid).toBe(0);

    const error = thrownBy(() => ensureOwnedDir(foreign, before.mode & 0o7777));

    expect(error.message).toContain(foreign);
    expect(lstatSync(foreign).mode).toBe(before.mode);
  });

  it("names the path and the octal mode but no environment value", () => {
    const parent = createParent();
    const file = join(parent, "occupied");
    writeFileSync(file, "x");
    vi.stubEnv("WORKBUDDY_CANARY_SECRET", "owned-dir-canary-value");
    try {
      const error = thrownBy(() => ensureOwnedDir(file, 0o3770));
      expect(error.message).toContain(file);
      expect(error.message).toContain("0o3770");
      expect(error.message).not.toContain("owned-dir-canary-value");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
