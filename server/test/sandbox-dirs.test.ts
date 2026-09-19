import fs, {
  chmodSync,
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
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";

const tmpDirs: string[] = [];
const SHARED_MODE = 0o2770;
const EXISTING_MODE = 0o755;

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
