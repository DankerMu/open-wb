import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstSegment, resolve } from "../src/core/sandbox/resolve.js";

interface FsCall {
  name: string;
  first: unknown;
}

/** `node:fs` 经命名导入的每次调用及其第一个参数；行为原样透传，只记录。 */
const fsCalls = vi.hoisted(() => [] as FsCall[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (name: string, value: unknown): unknown =>
    typeof value !== "function"
      ? value
      : new Proxy(value, {
          apply(target, self, args) {
            fsCalls.push({ name, first: args[0] });
            return Reflect.apply(target, self, args);
          },
        });
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, record(name, value)]),
  );
});

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
  op: "read" | "list" | "mkdir" | "write" | "delete" | "move" = "read",
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

  it("write accepts a.pdf, uploads/a.pdf, and uploads/图 (1).png whether uploads exists or not, without creating them", () => {
    const layout = createLayout();
    const targets = ["a.pdf", "uploads/a.pdf", "uploads/图 (1).png"];

    const beforeMissing = snapshotTree(layout.parent);
    for (const relPath of targets) {
      expect(resolve(layout.sandbox, relPath, "write"), `missing uploads: ${relPath}`).toEqual({
        ok: true,
        absPath: `${layout.canonicalSandbox}/${relPath}`,
      });
    }
    expect(snapshotTree(layout.parent)).toEqual(beforeMissing);

    mkdirSync(join(layout.sandbox, "uploads"));
    const beforeExisting = snapshotTree(layout.parent);
    for (const relPath of targets) {
      expect(resolve(layout.sandbox, relPath, "write"), `existing uploads: ${relPath}`).toEqual({
        ok: true,
        absPath: `${layout.canonicalSandbox}/${relPath}`,
      });
    }
    expect(snapshotTree(layout.parent)).toEqual(beforeExisting);
  });

  it("write rejects dot, dotdot, backslash, and trailing slash whether uploads exists or not", () => {
    const layout = createLayout();

    const rejectAll = (): void => {
      const before = snapshotTree(layout.parent);
      expectRejected(layout.sandbox, "uploads/.", "write");
      expectRejected(layout.sandbox, "uploads/..", "write");
      expectRejected(layout.sandbox, "uploads/a\\b", "write");
      expectRejected(layout.sandbox, "uploads/", "write");
      expect(snapshotTree(layout.parent)).toEqual(before);
    };

    rejectAll();
    mkdirSync(join(layout.sandbox, "uploads"));
    rejectAll();
  });

  it("write rejects traversal, absolute, and NUL escape vectors without adding filesystem entries", () => {
    const layout = createLayout();
    mkdirSync(join(layout.sandbox, "uploads"));
    const before = snapshotTree(layout.parent);

    expectRejected(layout.sandbox, "uploads/../../x", "write");
    expectRejected(layout.sandbox, "../x", "write");
    expectRejected(layout.sandbox, "/etc/passwd", "write");
    expectRejected(layout.sandbox, "uploads/a\0b", "write");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("write does not follow an uploads symlink that points outside the root", () => {
    const layout = createLayout();
    symlinkSync(join(layout.parent, "outside-dir"), join(layout.sandbox, "uploads"));
    const before = snapshotTree(layout.parent);

    expectRejected(layout.sandbox, "uploads/a.pdf", "write");
    expectRejected(layout.sandbox, "uploads/child", "write");

    expect(snapshotTree(layout.parent)).toEqual(before);
    expect(readFileSync(join(layout.parent, "outside-dir", "child"), "utf8")).toBe("child");
  });

  it("write rejects a target that is itself a symlink, pointing inside or outside the root", () => {
    const layout = createLayout();
    const uploads = join(layout.sandbox, "uploads");
    mkdirSync(uploads);
    writeFileSync(join(layout.sandbox, "a", "inside.txt"), "inside");

    for (const [label, target, content] of [
      ["inside", join(layout.sandbox, "a", "inside.txt"), "inside"],
      ["outside", join(layout.parent, "outside.txt"), "outside"],
    ] as const) {
      symlinkSync(target, join(uploads, "a.pdf"));
      const before = snapshotTree(layout.parent);

      const result = resolve(layout.sandbox, "uploads/a.pdf", "write");
      expect(result.ok, `symlink to ${label}`).toBe(false);
      expect(result.ok ? "" : result.reason, `symlink to ${label} reason`).toMatch(/\S/);

      expect(snapshotTree(layout.parent)).toEqual(before);
      expect(readFileSync(target, "utf8")).toBe(content);
      rmSync(join(uploads, "a.pdf"));
    }
  });

  it("delete and move reject the op-independent escape vectors without adding, renaming, or removing entries", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    for (const op of ["delete", "move"] as const) {
      expectRejected(layout.sandbox, "../x", op);
      expectRejected(layout.sandbox, "a/../../x", op);
      expectRejected(layout.sandbox, "/etc/passwd", op);
      expectRejected(layout.sandbox, "a\0b", op);
      expectRejected(layout.sandbox, "outside-link", op);
      expectRejected(layout.sandbox, "linkdir/child", op);
      expectRejected(layout.sandbox, "dangling", op);
      // 规格外的补充行：根内的 `..` 归一化后仍在根内，只有逐分量规则拦得住。
      expectRejected(layout.sandbox, "a/../a", op);
    }

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("the workspace root cannot be deleted, moved, or named as a move target: the empty path is rejected", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    for (const op of ["delete", "move"] as const) {
      expectRejected(layout.sandbox, "", op);
    }

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("delete and move return exact canonical paths for a and missing a/b/c.md", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    for (const op of ["delete", "move"] as const) {
      expect(resolve(layout.sandbox, "a", op), `${op} a`).toEqual({
        ok: true,
        absPath: `${layout.canonicalSandbox}/a`,
      });
      expect(resolve(layout.sandbox, "a/b/c.md", op), `${op} a/b/c.md`).toEqual({
        ok: true,
        absPath: `${layout.canonicalSandbox}/a/b/c.md`,
      });
    }

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("delete and move reject dot, dotdot, backslash, and trailing slash", () => {
    const layout = createLayout();
    const before = snapshotTree(layout.parent);

    for (const op of ["delete", "move"] as const) {
      expectRejected(layout.sandbox, "a/.", op);
      expectRejected(layout.sandbox, "a/..", op);
      expectRejected(layout.sandbox, "a/b\\c", op);
      expectRejected(layout.sandbox, "a/", op);
    }

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

  it("treats descendants below an ordinary file as structural absence while retaining later escape checks", () => {
    const layout = createLayout();
    writeFileSync(join(layout.sandbox, "regular-file"), "not-a-directory");
    const before = snapshotTree(layout.parent);

    expect(resolve(layout.sandbox, "regular-file/child", "read")).toEqual({
      ok: true,
      absPath: join(layout.canonicalSandbox, "regular-file", "child"),
    });
    expect(resolve(layout.sandbox, "regular-file/child", "list")).toEqual({
      ok: true,
      absPath: join(layout.canonicalSandbox, "regular-file", "child"),
    });
    expect(resolve(layout.sandbox, "regular-file/child", "mkdir")).toEqual({
      ok: true,
      absPath: join(layout.canonicalSandbox, "regular-file", "child"),
    });
    expect(resolve(layout.sandbox, "regular-file/child", "write")).toEqual({
      ok: true,
      absPath: join(layout.canonicalSandbox, "regular-file", "child"),
    });
    expectRejected(layout.sandbox, "regular-file/child/..", "read");
    expectRejected(layout.sandbox, "regular-file/child/..", "write");
    for (const op of ["delete", "move"] as const) {
      expect(resolve(layout.sandbox, "regular-file/child", op), op).toEqual({
        ok: true,
        absPath: join(layout.canonicalSandbox, "regular-file", "child"),
      });
    }
    expectRejected(layout.sandbox, "regular-file/child/..", "delete");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("rejects a real unexpected metadata error instead of authorizing the path", () => {
    const layout = createLayout();
    const tooLongName = "x".repeat(256);
    const before = snapshotTree(layout.parent);

    expect(() => lstatSync(join(layout.sandbox, tooLongName))).toThrow(
      expect.objectContaining({ code: "ENAMETOOLONG" }),
    );
    expectRejected(layout.sandbox, tooLongName, "read");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("rejects a missing sandbox root without adding filesystem entries", () => {
    const layout = createLayout();
    const missingRoot = join(layout.parent, "missing-root");
    const before = snapshotTree(layout.parent);

    expectRejected(missingRoot, "");

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("挂载名分量不被检查: the mount segment and everything below it see no filesystem call", () => {
    const layout = createLayout();
    const outsideMount = join(layout.parent, "outside-mount");
    mkdirSync(join(outsideMount, "a"), { recursive: true });
    writeFileSync(join(outsideMount, "a", "b.md"), "remote");
    symlinkSync(outsideMount, join(layout.sandbox, "远端"));
    symlinkSync(outsideMount, join(layout.sandbox, "远端备份"));
    const mountNames: ReadonlySet<string> = new Set(["远端"]);
    const mountDir = `${layout.canonicalSandbox}/远端`;
    const before = snapshotTree(layout.parent);

    for (const [relPath, op, absPath] of [
      ["远端", "read", mountDir],
      ["远端/a/b.md", "read", `${mountDir}/a/b.md`],
      ["./远端/a", "read", `${mountDir}/a`],
      ["远端//a", "read", `${mountDir}/a`],
      ["远端/a", "move", `${mountDir}/a`],
    ] as const) {
      fsCalls.length = 0;
      const result = resolve(layout.sandbox, relPath, op, mountNames);
      const calls = fsCalls.splice(0);
      expect(result, `${op} ${relPath}`).toStrictEqual({ ok: true, absPath, mount: "远端" });
      expect(calls, `${op} ${relPath} fs calls`).toEqual([
        { name: "realpathSync", first: layout.sandbox },
      ]);
    }

    for (const [relPath, op] of [
      ["远端/../x", "read"],
      ["远端/a/", "mkdir"],
      ["远端备份/a", "read"],
    ] as const) {
      const result = resolve(layout.sandbox, relPath, op, mountNames);
      expect(result.ok, `${op} ${relPath}`).toBe(false);
      expect(result.ok ? "" : result.reason, `${op} ${relPath} reason`).toMatch(/\S/);
    }

    const unmounted = resolve(layout.sandbox, "远端/a", "read", new Set());
    expect(unmounted.ok).toBe(false);
    expect(unmounted).not.toHaveProperty("mount");
    expect(resolve(layout.sandbox, "a", "read", mountNames)).toStrictEqual({
      ok: true,
      absPath: `${layout.canonicalSandbox}/a`,
    });

    expect(snapshotTree(layout.parent)).toEqual(before);
  });

  it("firstSegment is the first component after dropping empty and dot segments", () => {
    expect(firstSegment("远端")).toBe("远端");
    expect(firstSegment("远端/a/b.md")).toBe("远端");
    expect(firstSegment("./远端/a")).toBe("远端");
    expect(firstSegment("远端//a")).toBe("远端");
    expect(firstSegment(".//./远端/")).toBe("远端");
    expect(firstSegment("../远端")).toBe("..");
    expect(firstSegment("")).toBeUndefined();
    expect(firstSegment("./")).toBeUndefined();
  });
});
