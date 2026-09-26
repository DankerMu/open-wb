import { afterAll, describe, expect, it } from "vitest";
import { fileIcon, formatMtime, formatSize } from "../src/features/files/file-meta.js";

// 固定非 UTC 时区（Asia/Shanghai，UTC+8，1991 年后无夏令时）：须在任何 describe 之前设置，
// 否则 it.each 表在收集期按本机时区构造本地分量输入。
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "Asia/Shanghai";

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("fileIcon", () => {
  it.each([
    ["a.png", "image"],
    ["a.JPG", "image"],
    ["a.jpeg", "image"],
    ["a.zip", "archive"],
    ["a.tar", "archive"],
    ["a.tar.gz", "archive"],
    ["a.GZ", "archive"],
    ["a.csv", "table"],
    ["a.md", "file-text"],
    ["a.TXT", "file-text"],
    ["a.log", "file-text"],
    ["a.json", "file-code"],
    ["a.js", "file-code"],
    ["a.ts", "file-code"],
    ["a.tsx", "file-code"],
    ["a.html", "file-code"],
    ["a.pdf", "file"],
    ["Makefile", "file"],
    [".env", "file"],
    ["a.", "file"],
    ["README", "file"],
    [".md", "file-text"],
    ["x.constructor", "file"],
    ["x.Constructor", "file"],
    ["a.__PROTO__", "file"],
    ["a.toString", "file"],
    ["a.hasOwnProperty", "file"],
    [".constructor", "file"],
  ])("%s -> %s", (name, icon) => {
    expect(fileIcon(name)).toBe(icon);
  });
});

describe("formatSize", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [2048, "2.0 KB"],
    [1536, "1.5 KB"],
    [1_048_575, "1.0 MB"],
    [1_048_576, "1.0 MB"],
    [90_492_109, "86.3 MB"],
    [1_073_741_823, "1.0 GB"],
    [1_073_741_824, "1.0 GB"],
    [5 * 1024 ** 4, "5120.0 GB"],
  ])("%d -> %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});

describe("formatMtime", () => {
  it("runs under the pinned Asia/Shanghai zone", () => {
    expect(new Date(0).getHours()).toBe(8);
  });

  it.each([
    [new Date(2026, 0, 5, 7, 3).getTime(), "2026-01-05 07:03"],
    [new Date(2026, 0, 5, 23, 59).getTime(), "2026-01-05 23:59"],
    [new Date(2026, 0, 6, 0, 0).getTime(), "2026-01-06 00:00"],
    [Date.UTC(2026, 8, 25, 8, 31), "2026-09-25 16:31"],
    [0, "1970-01-01 08:00"],
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    [Number.NEGATIVE_INFINITY, "—"],
  ])("%d -> %s", (ms, text) => {
    expect(formatMtime(ms)).toBe(text);
  });
});
