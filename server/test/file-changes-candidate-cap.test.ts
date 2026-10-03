/**
 * Issue #740 bound on the synchronous filesystem work of one `files.changed` event
 * (`ownedChanges`, turn-artifacts「文件变更推导与归属」supervisor steps 2 and 6): only the first 100
 * raw candidates are judged, and candidates normalizing to the same path are judged once. Real
 * temp directories; `node:fs` is passed through a call recorder (behaviour untouched) so the
 * bound is an observed call count, never a duration. A recorded first argument is the normalized
 * path `resolve(root, raw)`, not the raw spelling of the candidate. Fix pass 1: a normalized path
 * over 4096 bytes or 128 components is dropped before any filesystem call (`realpath` walks a path
 * component by component, so one deep candidate through a self-referring symlink is unbounded).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileChange } from "../src/sessions/file-changes.js";
import { ownedChanges } from "../src/sessions/file-changes-ownership.js";

interface FsCall {
  name: string;
  first: unknown;
}

/** The `node:fs` functions called through a named import with their first argument, in order. */
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

/** Temp directories to remove after the test. */
const bases: string[] = [];

/**
 * A canonical workspace root `<base>/ws` holding `names` as files, beside the directory
 * `<base>/outside` holding `secret.txt`.
 */
function openSpace(names: readonly string[]): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-740-cap-")));
  bases.push(base);
  const space = { root: join(base, "ws"), outside: join(base, "outside") };
  mkdirSync(space.root);
  mkdirSync(space.outside);
  writeFileSync(join(space.outside, "secret.txt"), "secret");
  for (const name of names) {
    writeFileSync(join(space.root, name), name);
  }
  return space;
}

afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function edit(path: string, added: number, removed: number): FileChange {
  return { path, added, removed, kind: "edit" };
}

/** `ownedChanges` with the recorder emptied first: the calls left are the judgment's own. */
function judge(root: string, candidates: readonly FileChange[]): FileChange[] {
  fsCalls.length = 0;
  return ownedChanges(root, candidates);
}

/** How many recorded calls of `name` had the normalized `path` as their first argument. */
function callsOn(name: string, path: string): number {
  return fsCalls.filter((call) => call.name === name && call.first === path).length;
}

function callsOf(name: string): number {
  return fsCalls.filter((call) => call.name === name).length;
}

/** The first arguments of every recorded call, whatever the function. */
function touched(): unknown[] {
  return fsCalls.map((call) => call.first);
}

/** The components of a normalized absolute path; the empty one before the leading separator is none. */
function components(path: string): number {
  return path.split(sep).filter((part) => part !== "").length;
}

/** The 40 distinct paths of the spec scenario: `a.txt`, then `f01.txt` … `f39.txt`. */
const EARLY = Array.from({ length: 40 }, (_unused, index) =>
  index === 0 ? "a.txt" : `f${String(index).padStart(2, "0")}.txt`,
);
/** The 50 other paths carried by candidates 101–150. */
const LATE = Array.from({ length: 50 }, (_unused, index) => `late${index}.txt`);

/**
 * The spec scenario「原始候选上限与同路径只判定一次」: candidates 1–40 name the 40 early paths
 * plainly, 41–80 repeat them as `./<name>` (so `./a.txt` follows `a.txt`), 81–100 repeat the first
 * 20 as absolute paths; 101–150 are the late paths. Every candidate is `+1 −2`.
 */
function scenario(root: string): FileChange[] {
  const early = Array.from({ length: 100 }, (_unused, index) => {
    const name = EARLY[index % 40] ?? "";
    const spelling = index < 40 ? name : index < 80 ? `./${name}` : join(root, name);
    return edit(spelling, 1, 2);
  });
  return [...early, ...LATE.map((name) => edit(name, 7, 7))];
}

describe("C1 only the first 100 raw candidates are judged", () => {
  it("C1 (a) the 150-candidate scenario keeps exactly the 40 early paths, merged in order", () => {
    const space = openSpace([...EARLY, ...LATE]);
    const candidates = scenario(space.root);
    expect(candidates).toHaveLength(150);
    expect(candidates[40]?.path).toBe("./a.txt");

    const files = judge(space.root, candidates);

    // Paths 1–20 occur three times in the first 100, paths 21–40 twice.
    expect(files).toEqual(
      EARLY.map((path, index) =>
        index < 20
          ? { path, added: 3, removed: 6, kind: "edit" }
          : { path, added: 2, removed: 4, kind: "edit" },
      ),
    );
    expect(files).toHaveLength(40);
    expect(files.map((file) => file.path).filter((path) => path.startsWith("late"))).toEqual([]);
  });

  it("C1 (b) the same input costs one realpath per distinct path and none for 101–150", () => {
    const space = openSpace([...EARLY, ...LATE]);

    judge(space.root, scenario(space.root));

    // `a.txt`, `./a.txt` and `<root>/a.txt` are one normalized path.
    expect(callsOn("realpathSync", resolve(space.root, "a.txt"))).toBe(1);
    // The root once, then each of the 40 distinct normalized paths once; every file exists.
    expect(callsOf("realpathSync")).toBe(41);
    expect(callsOf("lstatSync")).toBe(0);
    expect(fsCalls).toHaveLength(41);
    expect(callsOn("realpathSync", space.root)).toBe(1);
    for (const name of EARLY) {
      expect(callsOn("realpathSync", resolve(space.root, name))).toBe(1);
    }
    const seen = touched();
    for (const name of LATE) {
      expect(seen).not.toContain(resolve(space.root, name));
    }
  });
});

describe("C2 a dropped path is judged once per event", () => {
  it("C2 (c) an outside path repeated three times costs one realpath", () => {
    const space = openSpace(["a.txt"]);
    const secret = join(space.outside, "secret.txt");

    const files = judge(space.root, [
      edit(secret, 1, 1),
      edit("a.txt", 1, 0),
      edit("../outside/secret.txt", 1, 1),
      edit(secret, 1, 1),
    ]);

    expect(files).toEqual([{ path: "a.txt", added: 1, removed: 0, kind: "edit" }]);
    expect(callsOn("realpathSync", resolve(space.root, secret))).toBe(1);
    expect(callsOn("lstatSync", resolve(space.root, secret))).toBe(0);
  });

  it("C2 (c) a dangling symlink repeated three times costs one realpath and one lstat", () => {
    const space = openSpace(["a.txt"]);
    symlinkSync(join(space.outside, "missing"), join(space.root, "dangling"));
    const dangling = resolve(space.root, "dangling");

    const files = judge(space.root, [
      edit("dangling", 1, 1),
      edit("a.txt", 1, 0),
      edit("./dangling", 1, 1),
      edit(dangling, 1, 1),
    ]);

    expect(files).toEqual([{ path: "a.txt", added: 1, removed: 0, kind: "edit" }]);
    expect(callsOn("realpathSync", dangling)).toBe(1);
    expect(callsOn("lstatSync", dangling)).toBe(1);
    expect(callsOf("lstatSync")).toBe(1);
  });
});

describe("C3 the cap counts positions, dropped candidates included", () => {
  it("C3 (d) sixty outside candidates use sixty of the 100 places; the 101st is not judged", () => {
    const space = openSpace([...EARLY, "late.txt"]);
    const hundred = [
      ...Array.from({ length: 60 }, (_unused, index) =>
        edit(join(space.outside, `o${index}.txt`), 9, 9),
      ),
      ...EARLY.map((name) => edit(name, 1, 2)),
    ];
    expect(hundred).toHaveLength(100);
    const expected = EARLY.map((path) => ({ path, added: 1, removed: 2, kind: "edit" }));

    const files = judge(space.root, [...hundred, edit("late.txt", 7, 7)]);

    expect(files).toEqual(expected);
    expect(files).toHaveLength(40);
    expect(touched()).not.toContain(resolve(space.root, "late.txt"));
    // The last of the first 100 is judged: the boundary is at 100, not below it.
    expect(callsOn("realpathSync", resolve(space.root, EARLY[39] ?? ""))).toBe(1);

    expect(judge(space.root, hundred)).toEqual(expected);
  });
});

describe("C4 a candidate too long or too deep reaches no filesystem call", () => {
  it("C4 (e) 200 hops through `l -> .` and a path over 4096 bytes are dropped untouched", () => {
    const space = openSpace(["a.txt"]);
    symlinkSync(".", join(space.root, "l"));
    // 201 components below the root; its realpath is the workspace's own `a.txt`.
    const deep = resolve(space.root, `${"l/".repeat(200)}a.txt`);
    // 1400 three-byte characters: over 4096 bytes although under 4096 UTF-16 units, two components.
    const long = resolve(space.root, `long/${"深".repeat(1400)}`);
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(4096);
    expect(long.length).toBeLessThan(4096);
    expect(components(long)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(deep, "utf8")).toBeLessThanOrEqual(4096);

    const files = judge(space.root, [
      edit(`${"l/".repeat(200)}a.txt`, 5, 5),
      edit(`long/${"深".repeat(1400)}`, 7, 7),
      edit("a.txt", 1, 0),
    ]);

    // Judged, the deep candidate would resolve to `a.txt` and add its counts to it.
    expect(files).toEqual([{ path: "a.txt", added: 1, removed: 0, kind: "edit" }]);
    const seen = touched();
    expect(seen).not.toContain(deep);
    expect(seen).not.toContain(dirname(deep));
    expect(seen).not.toContain(long);
    expect(seen).not.toContain(dirname(long));
    // The root once and the plain `a.txt` once, nothing else.
    expect(fsCalls).toEqual([
      { name: "realpathSync", first: space.root },
      { name: "realpathSync", first: resolve(space.root, "a.txt") },
    ]);
  });

  it("C4 (f) exactly 128 components is judged and kept, 129 is dropped untouched", () => {
    const space = openSpace(["a.txt"]);
    symlinkSync(".", join(space.root, "l"));
    // The temp root has a depth of its own: the hops fill up to the wanted total, `a.txt` is last.
    const depth = components(space.root);
    expect(depth).toBeLessThan(127);
    const through = (total: number): string => `${"l/".repeat(total - depth - 1)}a.txt`;
    const exact = resolve(space.root, through(128));
    const over = resolve(space.root, through(129));
    expect(components(exact)).toBe(128);
    expect(components(over)).toBe(129);
    expect(Buffer.byteLength(over, "utf8")).toBeLessThanOrEqual(4096);

    expect(judge(space.root, [edit(through(128), 2, 3)])).toEqual([
      { path: "a.txt", added: 2, removed: 3, kind: "edit" },
    ]);
    expect(callsOn("realpathSync", exact)).toBe(1);

    expect(judge(space.root, [edit(through(129), 2, 3)])).toEqual([]);
    expect(fsCalls).toEqual([{ name: "realpathSync", first: space.root }]);
  });

  it("C4 (f) exactly 4096 bytes reaches the filesystem, 4097 bytes does not", () => {
    const space = openSpace([]);
    // One component below the root, so only the byte rule can stop it; no such file can exist.
    const fill = 4096 - Buffer.byteLength(space.root, "utf8") - 1;
    expect(fill).toBeGreaterThan(0);
    const exact = resolve(space.root, "x".repeat(fill));
    const over = resolve(space.root, "x".repeat(fill + 1));
    expect(Buffer.byteLength(exact, "utf8")).toBe(4096);
    expect(Buffer.byteLength(over, "utf8")).toBe(4097);

    expect(judge(space.root, [edit("x".repeat(fill), 1, 1)])).toEqual([]);
    expect(callsOn("realpathSync", exact)).toBe(1);

    expect(judge(space.root, [edit("x".repeat(fill + 1), 1, 1)])).toEqual([]);
    expect(fsCalls).toEqual([{ name: "realpathSync", first: space.root }]);
  });
});
