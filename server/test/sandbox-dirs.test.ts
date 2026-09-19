import fs, { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";

const tmpDirs: string[] = [];
const SHARED_MODE = 0o2770;
const EXISTING_MODE = 0o755;

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "sandbox-dirs-"));
  tmpDirs.push(parent);
  return parent;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
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
    const parent = createParent();
    const a = join(parent, "a");
    const b = join(a, "b");
    const c = join(b, "c");
    mkdirSync(a);
    chmodSync(a, EXISTING_MODE);
    const beforeUid = lstatSync(a).uid;
    const beforeGid = lstatSync(a).gid;
    const beforeUmask = process.umask();
    const chownSpy = vi.spyOn(fs, "chownSync");

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
    const parent = createParent();
    const a = join(parent, "a");
    const b = join(a, "b");
    const c = join(b, "c");
    mkdirSync(a);
    chmodSync(a, EXISTING_MODE);
    writeFileSync(b, "not-a-directory");
    const beforeA = lstatSync(a);
    const beforeB = lstatSync(b);

    expect(() => ensureSharedDir(c)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));

    expect(modeOf(a)).toBe(EXISTING_MODE);
    expect(lstatSync(a).isDirectory()).toBe(true);
    expect(lstatSync(a).uid).toBe(beforeA.uid);
    expect(lstatSync(a).gid).toBe(beforeA.gid);
    expect(lstatSync(b).isFile()).toBe(true);
    expect(lstatSync(b).mode).toBe(beforeB.mode);
    expect(lstatSync(b).uid).toBe(beforeB.uid);
    expect(lstatSync(b).gid).toBe(beforeB.gid);
    expect(() => lstatSync(c)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  });
});
