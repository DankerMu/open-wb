/**
 * Issue #522 workspace ownership of file-change candidates (`ownedChanges` / `ownedPath`,
 * turn-artifacts「文件变更推导与归属」supervisor steps 2–6). Real temp directories and real
 * symlinks, no filesystem double; every root is realpath'd first (macOS tmpdir is /var →
 * /private/var). Expected values are literals from the spec scenarios. The 1024-byte boundary is
 * taken on the pure `ownedPath` (macOS PATH_MAX is 1024, so the path cannot exist on disk).
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileChange } from "../src/sessions/file-changes.js";
import { ownedChanges, ownedPath } from "../src/sessions/file-changes-ownership.js";

interface Space {
  /** Canonical parent of everything below; removed after the test. */
  base: string;
  /** The workspace root: `<base>/ws`, containing `notes.md` and the directory `sub`. */
  root: string;
  /** A directory beside the root holding `secret.txt` and `x.md`. */
  outside: string;
}

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function openSpace(): Space {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-522-own-")));
  bases.push(base);
  const root = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "notes.md"), "a\nb\nd\n");
  writeFileSync(join(outside, "secret.txt"), "secret");
  writeFileSync(join(outside, "x.md"), "outside x");
  return { base, root, outside };
}

function edit(path: string, added: number | null = 1, removed: number | null = 0): FileChange {
  return { path, added, removed, kind: "edit" };
}

function write(path: string): FileChange {
  return { path, added: null, removed: null, kind: "write" };
}

/** No element may carry a host path: neither the space's base nor any absolute path. */
function expectRelative(space: Space, files: readonly FileChange[]): void {
  expect(JSON.stringify(files)).not.toContain(space.base);
  for (const file of files) {
    expect(file.path.startsWith("/")).toBe(false);
  }
}

describe("O1 a candidate inside the workspace root", () => {
  it("O1 an absolute edit path is stored relative, with keys path/added/removed/kind", () => {
    const space = openSpace();
    const files = ownedChanges(space.root, [edit(join(space.root, "notes.md"), 2, 1)]);
    expect(files).toEqual([{ path: "notes.md", added: 2, removed: 1, kind: "edit" }]);
    expect(Object.keys(files[0] ?? {})).toEqual(["path", "added", "removed", "kind"]);
    expectRelative(space, files);
  });

  it("O1 a write keeps null counts and a nested file gets a slash-separated path", () => {
    const space = openSpace();
    mkdirSync(join(space.root, "out", "deep"), { recursive: true });
    writeFileSync(join(space.root, "out", "deep", "report.html"), "<html></html>");
    const files = ownedChanges(space.root, [
      write(join(space.root, "out", "deep", "report.html")),
      edit(join(space.root, "sub", "new.ts"), 3, 0),
    ]);
    expect(files).toEqual([
      { path: "out/deep/report.html", added: null, removed: null, kind: "write" },
      { path: "sub/new.ts", added: 3, removed: 0, kind: "edit" },
    ]);
    expect(Object.keys(files[0] ?? {})).toEqual(["path", "added", "removed", "kind"]);
    expectRelative(space, files);
  });
});

describe("O2 relative candidates and lexical normalization", () => {
  it("O2 a relative path is joined to the root, not to the process cwd", () => {
    const space = openSpace();
    expect(ownedChanges(space.root, [edit("notes.md", 2, 1)])).toEqual([
      { path: "notes.md", added: 2, removed: 1, kind: "edit" },
    ]);
    expect(ownedChanges(space.root, [write("sub/made.txt")])).toEqual([
      { path: "sub/made.txt", added: null, removed: null, kind: "write" },
    ]);
  });

  it("O2 dot segments fold lexically, also across a symlink leaving the workspace", () => {
    const space = openSpace();
    writeFileSync(join(space.root, "b.md"), "b");
    writeFileSync(join(space.root, "x.md"), "inside x");
    symlinkSync(space.outside, join(space.root, "link"));
    expect(ownedChanges(space.root, [edit("./a/../b.md")])).toEqual([
      { path: "b.md", added: 1, removed: 0, kind: "edit" },
    ]);
    // The kernel would follow `link` first and land in <base>/x.md; the lexical fold names x.md.
    expect(ownedChanges(space.root, [edit("link/../x.md")])).toEqual([
      { path: "x.md", added: 1, removed: 0, kind: "edit" },
    ]);
  });

  it.each(["sub/", "sub//", "sub/./", "notes.md/"])(
    "O2 the trailing-separator spelling %s equals the plain one",
    (spelling) => {
      const space = openSpace();
      const plain = spelling.startsWith("sub") ? "sub" : "notes.md";
      expect(ownedChanges(space.root, [edit(spelling)])).toEqual([
        { path: plain, added: 1, removed: 0, kind: "edit" },
      ]);
      expect(ownedChanges(space.root, [edit(join(space.root, spelling))])).toEqual(
        ownedChanges(space.root, [edit(plain)]),
      );
    },
  );
});

describe("O3 several files and repeated paths", () => {
  it("O3 repeated paths merge at their first position with summed counts", () => {
    const space = openSpace();
    const files = ownedChanges(space.root, [
      edit("a.md", 1, 0),
      edit("b.md", 0, 1),
      edit("a.md", 1, 0),
    ]);
    expect(files).toEqual([
      { path: "a.md", added: 2, removed: 0, kind: "edit" },
      { path: "b.md", added: 0, removed: 1, kind: "edit" },
    ]);
  });

  it("O3 an absolute and a relative spelling of one file merge into one element", () => {
    const space = openSpace();
    const files = ownedChanges(space.root, [
      edit("sub/x.ts", 4, 2),
      edit("notes.md", 2, 1),
      edit(join(space.root, "sub", "x.ts"), 1, 3),
      edit(join(space.root, "sub", "..", "notes.md"), 5, 0),
    ]);
    expect(files).toEqual([
      { path: "sub/x.ts", added: 5, removed: 5, kind: "edit" },
      { path: "notes.md", added: 7, removed: 1, kind: "edit" },
    ]);
  });

  it("O3 a null edit count adds as zero and the first kind is kept", () => {
    const space = openSpace();
    expect(
      ownedChanges(space.root, [edit("a.md", 3, 1), edit("a.md", null, null), write("a.md")]),
    ).toEqual([{ path: "a.md", added: 3, removed: 1, kind: "edit" }]);
    expect(ownedChanges(space.root, [edit("b.md", null, null), edit("b.md", 2, 3)])).toEqual([
      { path: "b.md", added: 2, removed: 3, kind: "edit" },
    ]);
  });
});

describe("O4 repeated write candidates", () => {
  it("O4 two writes of one path merge into one element whose counts stay null", () => {
    const space = openSpace();
    const report = join(space.root, "sub", "report.html");
    expect(ownedChanges(space.root, [write(report), write("sub/report.html")])).toEqual([
      { path: "sub/report.html", added: null, removed: null, kind: "write" },
    ]);
    // A later edit of the same path changes neither the kind nor the null counts.
    expect(ownedChanges(space.root, [write(report), edit("sub/report.html", 2, 2)])).toEqual([
      { path: "sub/report.html", added: null, removed: null, kind: "write" },
    ]);
  });
});

describe("O5 the 50-element cap applies after the merge", () => {
  const name = (index: number) => `f${String(index).padStart(2, "0")}.md`;

  it("O5 sixty distinct candidates keep the first fifty in derivation order", () => {
    const space = openSpace();
    const candidates = Array.from({ length: 60 }, (_unused, index) => edit(name(index), index, 0));
    const files = ownedChanges(space.root, candidates);
    expect(files).toHaveLength(50);
    expect(files.map((file) => file.path)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => name(index)),
    );
    expect(files[49]).toEqual({ path: "f49.md", added: 49, removed: 0, kind: "edit" });
  });

  it("O5 a 51st candidate repeating the first is merged before the cut", () => {
    const space = openSpace();
    const candidates = Array.from({ length: 50 }, (_unused, index) => edit(name(index), 1, 1));
    const files = ownedChanges(space.root, [
      ...candidates,
      edit(join(space.root, name(0)), 10, 20),
    ]);
    expect(files).toHaveLength(50);
    expect(files[0]).toEqual({ path: "f00.md", added: 11, removed: 21, kind: "edit" });
    expect(files[49]).toEqual({ path: "f49.md", added: 1, removed: 1, kind: "edit" });
  });
});

describe("O6 containment and the 1024-byte limit on the pure ownedPath", () => {
  it("O6 a relative path of exactly 1024 bytes is kept and 1025 bytes is dropped", () => {
    const exact = "a".repeat(1024);
    expect(ownedPath("/ws", `/ws/${exact}`)).toBe(exact);
    expect(ownedPath("/ws", `/ws/${exact}b`)).toBeUndefined();
    const nested = `${"d".repeat(511)}/${"e".repeat(512)}`;
    expect(Buffer.byteLength(nested, "utf8")).toBe(1024);
    expect(ownedPath("/srv/ws", `/srv/ws/${nested}`)).toBe(nested);
  });

  it("O6 the limit counts UTF-8 bytes, not characters", () => {
    // 342 three-byte characters: 342 UTF-16 units but 1026 bytes.
    expect(ownedPath("/ws", `/ws/${"文".repeat(342)}`)).toBeUndefined();
    // 341 of them and one ASCII letter: exactly 1024 bytes.
    const exact = `${"文".repeat(341)}a`;
    expect(ownedPath("/ws", `/ws/${exact}`)).toBe(exact);
  });

  it("O6 the root itself, an outside path and a sibling sharing the prefix are not owned", () => {
    expect(ownedPath("/ws", "/ws/notes.md")).toBe("notes.md");
    expect(ownedPath("/ws", "/ws/out/report.html")).toBe("out/report.html");
    expect(ownedPath("/ws", "/ws")).toBeUndefined();
    expect(ownedPath("/ws", "/etc/passwd")).toBeUndefined();
    expect(ownedPath("/ws", "/ws2/x.md")).toBeUndefined();
    expect(ownedPath("/ws", "/w")).toBeUndefined();
    expect(ownedPath("/srv/ws", "/srv/ws-old/notes.md")).toBeUndefined();
  });

  it("O6 a real nested path of about 600 bytes survives ownedChanges", () => {
    const space = openSpace();
    const segments = ["p", "q", "r", "s", "t", "u"].map((letter) => letter.repeat(99));
    const relative = [...segments, "f.md"].join("/");
    expect(Buffer.byteLength(relative, "utf8")).toBe(604);
    mkdirSync(join(space.root, ...segments), { recursive: true });
    writeFileSync(join(space.root, relative), "deep");
    expect(ownedChanges(space.root, [write(join(space.root, relative)), edit(relative)])).toEqual([
      { path: relative, added: null, removed: null, kind: "write" },
    ]);
  });
});

describe("O7 paths outside the workspace and symlink escapes", () => {
  /** Every escape the scenario names, as `[label, candidate path]`, over a prepared space. */
  function escapes(space: Space): Array<[string, string]> {
    const { base, root, outside } = space;
    mkdirSync(join(base, "other"));
    writeFileSync(join(base, "other", "x.md"), "sibling");
    mkdirSync(`${root}2`);
    writeFileSync(`${root}2/x.md`, "prefix sibling");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "secret.txt"), join(root, "filelink"));
    symlinkSync(join(outside, "gone.txt"), join(root, "dangling"));
    symlinkSync(join(root, "loop"), join(root, "loop"));
    return [
      ["a system file", "/etc/passwd"],
      ["a sibling directory through ..", "../other/x.md"],
      ["the same sibling, absolute", join(base, "other", "x.md")],
      ["the root itself, absolute", root],
      ["the root itself, as .", "."],
      ["the root itself, with a trailing separator", `${root}/`],
      ["a sibling sharing the root's prefix", `${root}2/x.md`],
      ["an existing file under an outward symlinked directory", "link/x.md"],
      ["a missing file under an outward symlinked directory", "link/missing.md"],
      ["the outward symlinked directory itself", "link"],
      ["a symlink to an existing outside file", "filelink"],
      ["a dangling outward symlink", "dangling"],
      ["a dangling outward symlink with a trailing separator", "dangling/"],
      ["a dangling outward symlink with two trailing separators", "dangling//"],
      ["a dangling outward symlink with a trailing dot segment", "dangling/./"],
      ["a dangling outward symlink, absolute", join(root, "dangling")],
      ["a dangling outward symlink, absolute with a trailing separator", `${root}/dangling/`],
      ["a dangling outward symlink, absolute with two separators", `${root}/dangling//`],
      ["a dangling outward symlink, absolute with a dot segment", `${root}/dangling/./`],
      ["a file under a dangling symlink", "dangling/x.md"],
      ["a symlink loop", "loop"],
      ["a symlink loop, absolute", join(root, "loop")],
      ["a file under a symlink loop", "loop/x.md"],
      ["a path using a regular file as a directory", "notes.md/x.md"],
      ["the same, absolute", join(root, "notes.md", "x.md")],
    ];
  }

  it("O7 each escaping candidate alone yields nothing", () => {
    const space = openSpace();
    const dropped: string[] = [];
    const cases = escapes(space);
    for (const [label, path] of cases) {
      const kept = [
        ...ownedChanges(space.root, [edit(path)]),
        ...ownedChanges(space.root, [write(path)]),
      ];
      if (kept.length === 0) {
        dropped.push(label);
      }
    }
    expect(dropped).toEqual(cases.map(([label]) => label));
  });

  it("O7 in one batch only the legitimate path survives", () => {
    const space = openSpace();
    const cases = escapes(space);
    const batch = [
      ...cases.slice(0, 12).map(([, path]) => edit(path, 9, 9)),
      edit(join(space.root, "notes.md"), 2, 1),
      ...cases.slice(12).map(([, path]) => edit(path, 9, 9)),
    ];
    const files = ownedChanges(space.root, batch);
    expect(files).toEqual([{ path: "notes.md", added: 2, removed: 1, kind: "edit" }]);
    expectRelative(space, files);
  });

  it("O7 judging creates, removes and rewrites nothing", () => {
    const space = openSpace();
    const cases = escapes(space);
    const listing = () => ({
      root: readdirSync(space.root).sort(),
      outside: readdirSync(space.outside).sort(),
      base: readdirSync(space.base).sort(),
    });
    const before = listing();
    ownedChanges(space.root, [
      ...cases.map(([, path]) => write(path)),
      write("sub/absent/deep.md"),
    ]);
    expect(listing()).toEqual(before);
    expect(before.outside).toEqual(["secret.txt", "x.md"]);
  });
});

describe("O8 a missing file is judged by its parent directory", () => {
  it("O8 a missing file in an existing directory is kept; a missing parent drops it", () => {
    const space = openSpace();
    const files = ownedChanges(space.root, [
      edit("sub/deleted.md", 0, 4),
      edit("nodir/x.md", 1, 0),
      edit(join(space.root, "gone.md"), 0, 1),
      edit(join(space.root, "nodir", "deeper", "y.md"), 1, 0),
    ]);
    expect(files).toEqual([
      { path: "sub/deleted.md", added: 0, removed: 4, kind: "edit" },
      { path: "gone.md", added: 0, removed: 1, kind: "edit" },
    ]);
    expect(ownedChanges(space.root, [edit("nodir/x.md")])).toEqual([]);
  });

  it("O8 a missing file under an inward symlinked directory is stored at its real parent", () => {
    const space = openSpace();
    symlinkSync(join(space.root, "sub"), join(space.root, "alias"));
    expect(ownedChanges(space.root, [edit("alias/deleted.md", 0, 2)])).toEqual([
      { path: "sub/deleted.md", added: 0, removed: 2, kind: "edit" },
    ]);
  });
});

describe("O9 the workspace root must be a canonical path", () => {
  it("O9 a root given through a symlink alias yields nothing", () => {
    const space = openSpace();
    const alias = join(space.base, "alias");
    symlinkSync(space.root, alias);
    expect(realpathSync(alias)).toBe(space.root);
    expect(ownedChanges(alias, [edit(join(alias, "notes.md"), 2, 1)])).toEqual([]);
    expect(ownedChanges(alias, [edit("notes.md", 2, 1)])).toEqual([]);
    expect(ownedChanges(alias, [edit(join(space.root, "notes.md"), 2, 1)])).toEqual([]);
    // The same candidates are owned once the root is named canonically.
    expect(ownedChanges(space.root, [edit(join(alias, "notes.md"), 2, 1)])).toEqual([
      { path: "notes.md", added: 2, removed: 1, kind: "edit" },
    ]);
  });

  it("O9 a root moved away and replaced by a symlink to an outside directory yields nothing", () => {
    const space = openSpace();
    renameSync(space.root, join(space.base, "moved"));
    symlinkSync(space.outside, space.root);
    expect(ownedChanges(space.root, [edit(join(space.root, "secret.txt"))])).toEqual([]);
    expect(ownedChanges(space.root, [write("secret.txt"), write("x.md")])).toEqual([]);
    expect(ownedChanges(space.root, [edit(join(space.outside, "secret.txt"))])).toEqual([]);
  });

  it("O9 a root spelled with a trailing separator or a dot segment yields nothing", () => {
    const space = openSpace();
    expect(ownedChanges(`${space.root}/`, [edit("notes.md")])).toEqual([]);
    expect(ownedChanges(`${space.root}/sub/..`, [edit("notes.md")])).toEqual([]);
    expect(ownedChanges(`${space.base}/./ws`, [edit("notes.md")])).toEqual([]);
  });
});

describe("O10 an unresolvable root", () => {
  it("O10 a missing root, a file as root and an empty root yield nothing without throwing", () => {
    const space = openSpace();
    const missing = join(space.base, "never-created");
    expect(ownedChanges(missing, [edit(join(missing, "notes.md")), edit("notes.md")])).toEqual([]);
    const file = join(space.root, "notes.md");
    expect(ownedChanges(file, [edit(join(file, "x.md")), edit("x.md")])).toEqual([]);
    expect(ownedChanges("", [edit(join(space.root, "notes.md"))])).toEqual([]);
    expect(ownedChanges("ws", [edit("notes.md")])).toEqual([]);
  });
});

describe("O11 paths the filesystem cannot take", () => {
  it("O11 a NUL byte and over-long paths are dropped without throwing", () => {
    const space = openSpace();
    const longName = `${"n".repeat(300)}.md`;
    const longPath = `${"y/".repeat(600)}f.md`;
    const files = ownedChanges(space.root, [
      edit("a\0b.md"),
      edit(join(space.root, "sub", "a\0b.md")),
      edit("\0"),
      edit(longName),
      edit(join(space.root, longName)),
      edit(longPath),
      edit(join(space.root, "notes.md"), 2, 1),
      write(`sub/${longName}`),
    ]);
    expect(files).toEqual([{ path: "notes.md", added: 2, removed: 1, kind: "edit" }]);
    for (const path of ["a\0b.md", "\0", longName, longPath]) {
      expect(ownedChanges(space.root, [edit(path)])).toEqual([]);
    }
  });

  it("O11 a path that is not a string is dropped without throwing", () => {
    const space = openSpace();
    const broken = [
      { path: 42, added: 1, removed: 0, kind: "edit" },
      { path: null, added: 1, removed: 0, kind: "edit" },
      { added: 1, removed: 0, kind: "edit" },
      edit("notes.md", 2, 1),
    ] as unknown as FileChange[];
    expect(ownedChanges(space.root, broken)).toEqual([
      { path: "notes.md", added: 2, removed: 1, kind: "edit" },
    ]);
  });
});

describe("O12 a symlink staying inside the workspace", () => {
  it("O12 the real location is stored and merged with the direct spelling", () => {
    const space = openSpace();
    symlinkSync(join(space.root, "notes.md"), join(space.root, "inlink"));
    symlinkSync(join(space.root, "sub"), join(space.root, "dirlink"));
    writeFileSync(join(space.root, "sub", "f.md"), "f");
    expect(ownedChanges(space.root, [edit("inlink", 2, 1)])).toEqual([
      { path: "notes.md", added: 2, removed: 1, kind: "edit" },
    ]);
    expect(
      ownedChanges(space.root, [
        edit(join(space.root, "inlink"), 2, 1),
        edit("dirlink/f.md", 1, 1),
        edit("notes.md", 3, 0),
        edit(join(space.root, "sub", "f.md"), 0, 2),
      ]),
    ).toEqual([
      { path: "notes.md", added: 5, removed: 1, kind: "edit" },
      { path: "sub/f.md", added: 1, removed: 3, kind: "edit" },
    ]);
  });
});

describe("O13 inputs are left alone", () => {
  it("O13 frozen candidates are not mutated and the result holds new objects", () => {
    const space = openSpace();
    const first = edit(join(space.root, "notes.md"), 2, 1);
    const candidates = [first, edit("notes.md", 1, 1), write("sub/out.html"), edit("/etc/passwd")];
    const before = structuredClone(candidates);
    for (const candidate of candidates) {
      Object.freeze(candidate);
    }
    Object.freeze(candidates);

    const files = ownedChanges(space.root, candidates);

    expect(candidates).toEqual(before);
    expect(files).toEqual([
      { path: "notes.md", added: 3, removed: 2, kind: "edit" },
      { path: "sub/out.html", added: null, removed: null, kind: "write" },
    ]);
    for (const file of files) {
      expect(candidates).not.toContain(file);
      expect(Object.isFrozen(file)).toBe(false);
    }
    const again = ownedChanges(space.root, candidates);
    expect(again).toEqual(files);
    expect(again).not.toBe(files);
    expect(again[0]).not.toBe(files[0]);
  });
});
