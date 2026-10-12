// files-web「地址定位到文件」：地址里的 `path` 在定位之前的写法（`normalizedPath`，纯函数）。
// 期望值按 server/src/core/sandbox/resolve.ts 的逐段规则手写：空段与 `.` 段被跳过，恰为 `..` 的段被拒。

import { describe, expect, it } from "vitest";
import { normalizedPath } from "../src/features/files/browser-paths.js";

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
