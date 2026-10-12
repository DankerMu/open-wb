// files-web「地址定位到文件」：地址里的 `path` 在定位之前的写法（`normalizedPath`，纯函数）。
// 期望值按 server/src/core/sandbox/resolve.ts 的逐段规则手写：空段与 `.` 段被跳过，恰为 `..` 的段被拒。

import { describe, expect, it } from "vitest";
import {
  type DirectoryCache,
  movedCache,
  movedPath,
  normalizedPath,
  parentPath,
  renameTarget,
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
