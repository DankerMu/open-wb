import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "../src/core/sandbox/resolve.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Layout {
  parent: string;
  sandbox: string;
  prefixRoot: string;
  canonicalSandbox: string;
}

function createLayout(): Layout {
  const parent = mkdtempSync(join(tmpdir(), "sandbox-resolve-"));
  tmpDirs.push(parent);

  const sandbox = join(parent, "sandbox");
  const prefixRoot = join(parent, "a");
  const prefixSibling = join(parent, "ab");
  mkdirSync(sandbox);
  mkdirSync(join(sandbox, "a"));
  mkdirSync(prefixRoot);
  mkdirSync(prefixSibling);
  writeFileSync(join(prefixSibling, "x"), "sibling-x");
  writeFileSync(join(parent, "outside.txt"), "outside");
  mkdirSync(join(parent, "outside-dir"));
  writeFileSync(join(parent, "outside-dir", "child"), "child");
  symlinkSync(join(parent, "outside.txt"), join(sandbox, "outside-link"));
  symlinkSync(join(parent, "outside-dir"), join(sandbox, "linkdir"));
  symlinkSync(join(sandbox, "missing-target"), join(sandbox, "dangling"));
  symlinkSync(join(sandbox, "a"), join(sandbox, "inside-dirlink"));

  return {
    parent,
    sandbox,
    prefixRoot,
    canonicalSandbox: realpathSync(sandbox),
  };
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];

  const walk = (directory: string, rel: string): void => {
    const names = readdirSync(directory).toSorted();
    for (const name of names) {
      const full = join(directory, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const status = lstatSync(full);
      if (status.isSymbolicLink()) {
        entries.push(`${childRel} -> ${readlinkSync(full)}`);
        continue;
      }
      if (status.isDirectory()) {
        entries.push(`${childRel}/`);
        walk(full, childRel);
        continue;
      }
      entries.push(childRel);
    }
  };

  walk(root, "");
  return entries;
}

function expectRejected(
  root: string,
  relPath: string,
  op: "read" | "list" | "mkdir" = "read",
): void {
  const result = resolve(root, relPath, op);
  expect(result.ok, `${op} ${JSON.stringify(relPath)}`).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.reason.length, `${op} ${JSON.stringify(relPath)} reason`).toBeGreaterThan(0);
}

describe("core/sandbox resolve", () => {
  it("rejects the eight escape vectors without adding filesystem entries", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    expectRejected(layout.sandbox, "../x");
    expectRejected(layout.sandbox, "a/../../x");
    expectRejected(layout.sandbox, "/etc/passwd");
    expectRejected(layout.sandbox, "a\0b");
    expectRejected(layout.sandbox, "outside-link");
    expectRejected(layout.sandbox, "linkdir/child");
    expectRejected(layout.sandbox, "dangling");
    expectRejected(layout.prefixRoot, "../ab/x");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("returns exact canonical paths for empty, a, and missing a/b/c.md", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    expect(resolve(layout.sandbox, "", "read")).toEqual({
      ok: true,
      absPath: layout.canonicalSandbox,
    });
    expect(resolve(layout.sandbox, "a", "list")).toEqual({
      ok: true,
      absPath: `${layout.canonicalSandbox}/a`,
    });
    expect(resolve(layout.sandbox, "a/b/c.md", "read")).toEqual({
      ok: true,
      absPath: `${layout.canonicalSandbox}/a/b/c.md`,
    });

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("mkdir accepts out and a/out without creating them", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    expect(resolve(layout.sandbox, "out", "mkdir")).toEqual({
      ok: true,
      absPath: `${layout.canonicalSandbox}/out`,
    });
    expect(resolve(layout.sandbox, "a/out", "mkdir")).toEqual({
      ok: true,
      absPath: `${layout.canonicalSandbox}/a/out`,
    });

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("mkdir rejects dot, dotdot, backslash, and trailing slash", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    expectRejected(layout.sandbox, "a/.", "mkdir");
    expectRejected(layout.sandbox, "a/..", "mkdir");
    expectRejected(layout.sandbox, "a/b\\c", "mkdir");
    expectRejected(layout.sandbox, "a/", "mkdir");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("rejects in-root symlinks even when a following dot or empty segment would normalize them away", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    expectRejected(layout.sandbox, "inside-dirlink");
    expectRejected(layout.sandbox, "inside-dirlink/.");
    expectRejected(layout.sandbox, "inside-dirlink/");
    expectRejected(layout.sandbox, "inside-dirlink/child");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("rejects unexpected metadata failures instead of authorizing the path", () => {
    const layout = createLayout();
    writeFileSync(join(layout.sandbox, "regular-file"), "not-a-directory");
    const before = snapshotTree(layout.parent);

    expectRejected(layout.sandbox, "regular-file/child", "read");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });
});
