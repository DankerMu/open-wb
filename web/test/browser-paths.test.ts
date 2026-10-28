// files-web「地址定位到文件」：地址里的 `path` 在定位之前的写法（`normalizedPath`，纯函数）。
// 期望值按 server/src/core/sandbox/resolve.ts 的逐段规则手写：空段与 `.` 段被跳过，恰为 `..` 的段被拒。

import { describe, expect, it } from "vitest";
import {
  canMoveInto,
  type DirectoryCache,
  loadedDirectoryPaths,
  moveDestination,
  movedCache,
  movedKeys,
  movedPath,
  movedTarget,
  moveTargets,
  normalizedPath,
  parentPath,
  refreshLayers,
  renameTarget,
  revealStep,
} from "../src/features/files/browser-paths.js";

describe("normalizedPath", () => {
  it.each([
    ["readme.md", "readme.md"],
    ["src/deep/app.ts", "src/deep/app.ts"],
    ["./a//b/", "a/b"],
    ["./readme.md", "readme.md"],
    ["/readme.md", "readme.md"],
    ["src/deep/", "src/deep"],
    ["././src/./deep/./app.ts", "src/deep/app.ts"],
    ["a/.", "a"],
    ["", ""],
    ["/", ""],
    ["//", ""],
    [".", ""],
    ["./", ""],
    ["/./.", ""],
  ])("%j 去掉空段与点段后是 %j", (path, expected) => {
    expect(normalizedPath(path)).toBe(expected);
  });

  it.each(["..", "../x", "a/../b", "out/..", "/..", "./..", "a//../", "../.."])(
    "%j 有一段恰为两个点：null",
    (path) => {
      expect(normalizedPath(path)).toBeNull();
    },
  );

  // 只认恰为 `.` / `..` 的段与 `/` 分隔符：不去空格、不解码、不做 Unicode 规范化、不把 `\` 当分隔符，
  // 不删 NUL 等控制字符（含 NUL 的路径由服务端整条拒绝）。末两行是 U+2025（两点省略号）与全角的两个点：
  // 兼容规范化之后才是 `..`，这里不是。
  it.each([
    "...",
    "a/.../b",
    ". ",
    " .",
    ".. ",
    " ../x",
    "..\\x",
    "a\\..\\b",
    ".\\a",
    "%2E%2E",
    "%2E%2E/x",
    "%2e/x",
    "a%2Fb",
    " a ",
    "a /b",
    "..a",
    "a..",
    ".a",
    "café.md",
    "café.md",
    "a\u0000b",
    "\u0000",
    "‥",
    "．．",
  ])("%j 原样返回", (path) => {
    expect(normalizedPath(path)).toBe(path);
  });
});

// files-web「文件操作界面」：重命名发出的 `to` 与改名、删除之后各处路径的写法。期望值手写。
describe("parentPath / renameTarget", () => {
  it.each([
    ["a.md", ""],
    ["out/a.md", "out"],
    ["out/sub/x.md", "out/sub"],
    ["", ""],
  ])("%j 的父目录是 %j", (path, expected) => {
    expect(parentPath(path)).toBe(expected);
  });

  // 名字原样拼在父目录后面：不去空格、不折叠点段、不拦分隔符（拦它的是对话框，裁决越界的是服务端）。
  it.each([
    ["notes.md", "todo.md", "todo.md"],
    ["out/a.md", "b.md", "out/b.md"],
    ["out/sub/x.md", "y.md", "out/sub/y.md"],
    ["out", "dist", "dist"],
    ["a.md", "..", ".."],
    ["a.md", ".", "."],
    ["out/a.md", "..", "out/.."],
    ["out/a.md", " b ", "out/ b "],
    ["out/a.md", "x/y", "out/x/y"],
    ["out/a.md", "../../etc", "out/../../etc"],
    ["out/a.md", "x\\y", "out/x\\y"],
    ["out/a.md", "", "out/"],
  ])("renameTarget(%j, %j) 是 %j", (path, name, expected) => {
    expect(renameTarget(path, name)).toBe(expected);
  });
});

// files-web「文件操作界面」：`移动到…` 与拖放共用的两样——能不能移进去、发出的 `to`。期望值手写。
describe("canMoveInto / moveDestination", () => {
  it.each([
    // 自身
    ["out", "out", false],
    ["a.md", "a.md", false],
    // 自身的后代
    ["out", "out/sub", false],
    ["out", "out/sub/deep", false],
    // 当前父目录
    ["a.md", "", false],
    ["out", "", false],
    ["out/b.md", "out", false],
    ["out/sub", "out", false],
    // 根（不是当前父目录时）与别的目录
    ["out/b.md", "", true],
    ["out/sub", "", true],
    ["a.md", "out", true],
    ["out/b.md", "out/sub", true],
    ["out/sub", "docs", true],
    // 名字以它开头的同级不是它的后代，反过来也一样
    ["out", "output", true],
    ["output", "out", true],
    ["out", "output/out", true],
  ])("canMoveInto(%j, %j) 是 %j", (path, directory, expected) => {
    expect(canMoveInto(path, directory)).toBe(expected);
  });

  // 目标目录与名字都原样：不去空格、不折叠点段、不编码也不解码；目标是根时没有前导的分隔符。
  it.each([
    ["a.md", "out", "out/a.md"],
    ["out/b.md", "", "b.md"],
    ["out/sub", "output", "output/sub"],
    ["out/sub/x.md", "out", "out/x.md"],
    [" a%20b#c?.md ", " o%20ut ", " o%20ut / a%20b#c?.md "],
    ["out/..", "", ".."],
    ["a.md", "out/../..", "out/../../a.md"],
  ])("moveDestination(%j, %j) 是 %j", (from, directory, expected) => {
    expect(moveDestination(from, directory)).toBe(expected);
  });
});

describe("movedPath", () => {
  it.each([
    ["out", "out", "dist", "dist"],
    ["out/a.md", "out", "dist", "dist/a.md"],
    ["out/sub/x.md", "out", "dist", "dist/sub/x.md"],
    ["out/sub/x.md", "out/sub", "out/deep", "out/deep/x.md"],
    ["a.md", "a.md", "b.md", "b.md"],
    // 只认整段：名字以 `out` 开头的同级、以它结尾的别处都不算在它之下。
    ["output", "out", "dist", "output"],
    ["output/o.md", "out", "dist", "output/o.md"],
    ["out.md", "out", "dist", "out.md"],
    ["x/out", "out", "dist", "x/out"],
    ["", "out", "dist", ""],
    ["a.md.bak", "a.md", "b.md", "a.md.bak"],
  ])("%j 在 %j 移到 %j 之后是 %j", (path, from, to, expected) => {
    expect(movedPath(path, from, to)).toBe(expected);
  });

  it.each([
    ["out", "out", null],
    ["out/sub/x.md", "out", null],
    ["output", "out", "output"],
    ["", "out", ""],
  ])("%j 在 %j 被删除之后是 %j", (path, from, expected) => {
    expect(movedPath(path, from, null)).toBe(expected);
  });
});

describe("movedTarget", () => {
  const target = (path: string) => ({ path, notify: true });

  it("在 from 之下：路径换到 to 之下，其余字段原样；不在其下：路径不变", () => {
    expect(movedTarget(target("out/a.md"), "out", "dist")).toStrictEqual(target("dist/a.md"));
    expect(movedTarget(target("output/o.md"), "out", "dist")).toStrictEqual(target("output/o.md"));
  });

  it("from 被删除：在它之下的是 null，同级的原样；本来就没有的还是 null", () => {
    expect(movedTarget(target("out/sub/x.md"), "out", null)).toBeNull();
    expect(movedTarget(target("out"), "out", null)).toBeNull();
    expect(movedTarget(target("output/o.md"), "out", null)).toStrictEqual(target("output/o.md"));
    expect(movedTarget(null, "out", "dist")).toBeNull();
    expect(movedTarget(null, "out", null)).toBeNull();
  });
});

// 展开集合与两张目录失败表在改名、删除之后的键：元组进、元组出，值原样。
describe("movedKeys", () => {
  const table = (): [string, number][] => [
    ["", 1],
    ["out", 2],
    ["out/sub", 3],
    ["output", 4],
  ];

  it("改名：from 与它之下的键换到 to 之下，同级的 output 与根不动，次序与值原样", () => {
    expect(movedKeys(table(), "out", "dist")).toStrictEqual([
      ["", 1],
      ["dist", 2],
      ["dist/sub", 3],
      ["output", 4],
    ]);
  });

  it("删除（to 为 null）：from 与它之下的键丢掉，没有名为 null 的键", () => {
    expect(movedKeys(table(), "out", null)).toStrictEqual([
      ["", 1],
      ["output", 4],
    ]);
    expect(movedKeys(table(), "out/sub", null)).toStrictEqual([
      ["", 1],
      ["out", 2],
      ["output", 4],
    ]);
  });

  it("to 与它之下早先留下的键先丢掉，名字以它开头的同级不算", () => {
    const stale: [string, string][] = [
      ["dist", "旧"],
      ["dist/gone", "旧"],
      ["distant", "留"],
      ["out", "新"],
      ["out/sub", "新"],
    ];
    expect(movedKeys(stale, "out", "dist")).toStrictEqual([
      ["distant", "留"],
      ["dist", "新"],
      ["dist/sub", "新"],
    ]);
  });

  it("集合的 entries() 可直接给它：展开集合的写法", () => {
    const expanded = new Set(["", "out", "out/sub", "output"]);
    expect(movedKeys(expanded.entries(), "out", null).map(([path]) => path)).toStrictEqual([
      "",
      "output",
    ]);
    expect(movedKeys(expanded.entries(), "out", "dist").map(([path]) => path)).toStrictEqual([
      "",
      "dist",
      "dist/sub",
      "output",
    ]);
  });

  it("名为 __proto__ 的目录只是一个普通的键", () => {
    expect(movedKeys([["__proto__", 1]], "__proto__", "x")).toStrictEqual([["x", 1]]);
    expect(movedKeys([["a", 1]], "a", "__proto__")).toStrictEqual([["__proto__", 1]]);
  });
});

describe("movedCache", () => {
  const dir = (name: string) => ({ name, type: "dir" as const, size: 0, mtime: 100 });
  const file = (name: string) => ({ name, type: "file" as const, size: 4, mtime: 200 });
  const cache = (): DirectoryCache => ({
    "": { path: "", entries: [dir("out"), dir("output"), file("a.md")] },
    out: { path: "out", entries: [dir("sub"), file("a.md")] },
    "out/sub": { path: "out/sub", entries: [file("x.md")] },
    output: { path: "output", entries: [file("o.md")] },
  });

  it("目录改名：它与它之下的键和 listing.path 换到新名字下，父目录列表里就地改名，同级的 output 不动", () => {
    expect(movedCache(cache(), "out", "dist")).toStrictEqual({
      "": { path: "", entries: [dir("dist"), dir("output"), file("a.md")] },
      dist: { path: "dist", entries: [dir("sub"), file("a.md")] },
      "dist/sub": { path: "dist/sub", entries: [file("x.md")] },
      output: { path: "output", entries: [file("o.md")] },
    });
  });

  it("文件改名：只有父目录的列表变", () => {
    expect(movedCache(cache(), "out/a.md", "out/b.md")).toStrictEqual({
      ...cache(),
      out: { path: "out", entries: [dir("sub"), file("b.md")] },
    });
  });

  it("新路径上早先留下的键与父目录里同名的旧条目被顶掉", () => {
    const stale: DirectoryCache = {
      ...cache(),
      "": { path: "", entries: [dir("out"), dir("dist"), file("a.md")] },
      dist: { path: "dist", entries: [file("old.md")] },
      "dist/gone": { path: "dist/gone", entries: [] },
    };
    expect(movedCache(stale, "out", "dist")).toStrictEqual({
      "": { path: "", entries: [dir("dist"), file("a.md")] },
      dist: { path: "dist", entries: [dir("sub"), file("a.md")] },
      "dist/sub": { path: "dist/sub", entries: [file("x.md")] },
      output: { path: "output", entries: [file("o.md")] },
    });
  });

  it("移到另一个已加载的目录：从原父目录拿掉，放到目标目录列表的末尾；目标没加载过就只拿掉", () => {
    expect(movedCache(cache(), "a.md", "output/a.md")).toStrictEqual({
      ...cache(),
      "": { path: "", entries: [dir("out"), dir("output")] },
      output: { path: "output", entries: [file("o.md"), file("a.md")] },
    });
    expect(movedCache(cache(), "a.md", "output/deep/a.md")[""]).toStrictEqual({
      path: "",
      entries: [dir("out"), dir("output")],
    });
  });

  it("删除（to 为 null）：它与它之下的键都丢掉，父目录列表里拿掉这一条", () => {
    expect(movedCache(cache(), "out", null)).toStrictEqual({
      "": { path: "", entries: [dir("output"), file("a.md")] },
      output: { path: "output", entries: [file("o.md")] },
    });
  });

  it("不改传入的缓存", () => {
    const before = cache();
    movedCache(before, "out", "dist");
    expect(before).toStrictEqual(cache());
  });
});

// 「移动到…」的目标：期望值按规格「文件操作界面」那一条手写——树上此刻可见且列表已加载的目录（根，
// 以及自身与各级上级都展开着、列表已加载的目录），去掉条目自身、它的后代与它当前的父目录。
describe("moveTargets", () => {
  const dir = (name: string) => ({ name, type: "dir" as const, size: 0, mtime: 100 });
  const file = (name: string) => ({ name, type: "file" as const, size: 4, mtime: 200 });
  const cache = (): DirectoryCache => ({
    "": { path: "", entries: [dir("docs"), dir("out"), dir("output"), file("top.md")] },
    docs: { path: "docs", entries: [] },
    out: { path: "out", entries: [dir("sub"), file("a.md")] },
    "out/sub": { path: "out/sub", entries: [file("x.md")] },
    output: { path: "output", entries: [file("o.md")] },
  });
  const all = new Set(["", "docs", "out", "out/sub", "output"]);

  it("根下的文件：当前父目录（根）不在，其余展开且已加载的目录按树上自上而下的次序", () => {
    expect(moveTargets(cache(), all, "top.md")).toStrictEqual(["docs", "out", "out/sub", "output"]);
  });

  it("目录里的文件：根在首位，它的父目录不在", () => {
    expect(moveTargets(cache(), all, "out/a.md")).toStrictEqual(["", "docs", "out/sub", "output"]);
    expect(moveTargets(cache(), all, "out/sub/x.md")).toStrictEqual(["", "docs", "out", "output"]);
  });

  it("目录：自身、后代与当前父目录都不在；名字以它开头的同级 output 在", () => {
    expect(moveTargets(cache(), all, "out")).toStrictEqual(["docs", "output"]);
    expect(moveTargets(cache(), all, "out/sub")).toStrictEqual(["", "docs", "output"]);
  });

  it("加载过但折叠着的目录不在", () => {
    const expanded = new Set(["", "out", "out/sub", "output"]);
    expect(moveTargets(cache(), expanded, "top.md")).toStrictEqual(["out", "out/sub", "output"]);
  });

  it("上级折叠着的目录不在，即使它自己还在展开集合里", () => {
    const expanded = new Set(["", "docs", "out/sub", "output"]);
    expect(moveTargets(cache(), expanded, "top.md")).toStrictEqual(["docs", "output"]);
  });

  it("展开了而列表还没加载的目录不在", () => {
    const { output: _unloaded, ...loaded } = cache();
    expect(moveTargets(loaded, all, "top.md")).toStrictEqual(["docs", "out", "out/sub"]);
  });

  it("缓存里有列表、展开集合里也有，但上级的列表没列出它的目录不在（地址定位留下的）", () => {
    const withGhost: DirectoryCache = {
      ...cache(),
      ghost: { path: "ghost", entries: [dir("deep")] },
      "ghost/deep": { path: "ghost/deep", entries: [] },
      "out/gone": { path: "out/gone", entries: [] },
    };
    const expanded = new Set([...all, "ghost", "ghost/deep", "out/gone"]);
    expect(moveTargets(withGhost, expanded, "top.md")).toStrictEqual([
      "docs",
      "out",
      "out/sub",
      "output",
    ]);
  });

  it("上级列表里与目录同名的文件不算：只沿列为目录的条目下行", () => {
    const shadowed: DirectoryCache = {
      "": { path: "", entries: [file("docs"), dir("out")] },
      docs: { path: "docs", entries: [] },
      out: { path: "out", entries: [] },
    };
    expect(moveTargets(shadowed, new Set(["", "docs", "out"]), "out/a.md")).toStrictEqual([""]);
  });

  it("根的列表没加载：没有目标；根折叠着：只有根", () => {
    const { "": _root, ...rootless } = cache();
    expect(moveTargets(rootless, all, "out/a.md")).toStrictEqual([]);
    expect(moveTargets(cache(), new Set(["out", "output"]), "out/a.md")).toStrictEqual([""]);
  });

  it("名为 __proto__ 的目录没加载过时不被当成已加载", () => {
    const odd: DirectoryCache = { "": { path: "", entries: [dir("__proto__"), dir("out")] } };
    expect(moveTargets(odd, new Set(["", "__proto__", "out"]), "out/a.md")).toStrictEqual([""]);
  });

  it("没有可选目标时是空数组", () => {
    expect(moveTargets(cache(), new Set(["", "out", "out/sub"]), "out")).toStrictEqual([]);
  });

  // #1823：挂载内的条目从挂载根起列（挂载根不在根的列表里，D21），没有根与挂载外的目录。
  it("给了起点：从起点起列，起点自身算可见，根与起点之外的目录不在；起点仍经同一判定去掉父目录", () => {
    const mounted: DirectoryCache = {
      ...cache(),
      远端: { path: "远端", entries: [dir("d"), dir("e"), file("notes.txt")] },
      "远端/d": { path: "远端/d", entries: [file("a.md")] },
      "远端/e": { path: "远端/e", entries: [] },
    };
    const expanded = new Set([...all, "远端", "远端/d"]);
    expect(moveTargets(mounted, expanded, "远端/d/a.md", "远端")).toStrictEqual(["远端"]);
    expect(moveTargets(mounted, expanded, "远端/notes.txt", "远端")).toStrictEqual(["远端/d"]);
    expect(moveTargets(mounted, expanded, "远端/d", "远端")).toStrictEqual([]);
    expect(moveTargets(mounted, expanded, "top.md")).toStrictEqual([
      "docs",
      "out",
      "out/sub",
      "output",
    ]);
  });
});

// files-web「目录树与预览」：目录名与对象原型成员同名时与其它目录名同样处理（#1340）。缓存是普通对象，
// 这些名字按方括号读会读到继承来的值；期望值按规格那一句手写——没有登记过即未加载。
describe("与对象原型成员同名的目录（#1340）", () => {
  const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"] as const;
  const dir = (name: string) => ({ name, type: "dir" as const, size: 0, mtime: 100 });
  const file = (name: string) => ({ name, type: "file" as const, size: 4, mtime: 200 });
  // 经 `Object.fromEntries` 组装：对象字面量里的 `__proto__:` 是设原型，不是登记一个键。
  const cacheOf = (...loaded: [string, DirectoryCache[string]["entries"]][]): DirectoryCache =>
    Object.fromEntries([
      ["", { path: "", entries: NAMES.map(dir) }],
      ...loaded.map(([path, entries]) => [path, { path, entries }] as const),
    ]);

  it("loadedDirectoryPaths：根列表里有这五个目录、都没加载过时不抛出，只有根", () => {
    expect(loadedDirectoryPaths(cacheOf())).toStrictEqual([""]);
  });

  it.each(NAMES)("loadedDirectoryPaths：只有 %s 加载过时只多出它", (name) => {
    expect(loadedDirectoryPaths(cacheOf([name, [file("a.md")]]))).toStrictEqual(["", name]);
  });

  it("revealStep：constructor 没加载过时它就是下一个要请求的层", () => {
    expect(revealStep("constructor/a.md", cacheOf())).toStrictEqual({
      entry: null,
      expand: ["", "constructor"],
      unloaded: "constructor",
    });
  });

  it("revealStep：__proto__ 加载过时取到的是它自己列表里的条目", () => {
    expect(revealStep("__proto__/a.md", cacheOf(["__proto__", [file("a.md")]]))).toStrictEqual({
      entry: file("a.md"),
      expand: ["", "__proto__"],
      unloaded: null,
    });
  });

  it("refreshLayers：constructor 没加载过时 constructor/a.md 要重取的层只有根", () => {
    expect([...refreshLayers(cacheOf(), ["constructor/a.md"])]).toStrictEqual([""]);
  });

  it("refreshLayers：constructor 加载过时它也在要重取的层里", () => {
    const layers = refreshLayers(cacheOf(["constructor", [file("a.md")]]), ["constructor/a.md"]);
    expect([...layers]).toStrictEqual(["", "constructor"]);
  });

  it.each(NAMES)("movedCache：移进没加载过的 %s 时只从原父目录拿掉，不读继承来的值", (name) => {
    const cache: DirectoryCache = { "": { path: "", entries: [dir(name), file("a.md")] } };
    expect(movedCache(cache, "a.md", `${name}/a.md`)).toStrictEqual({
      "": { path: "", entries: [dir(name)] },
    });
  });

  it.each(NAMES)("movedCache：%s 没加载过时，其下条目的改名不动缓存", (name) => {
    const cache: DirectoryCache = { "": { path: "", entries: [dir(name)] } };
    expect(movedCache(cache, `${name}/a.md`, `${name}/b.md`)).toStrictEqual(cache);
  });
});
