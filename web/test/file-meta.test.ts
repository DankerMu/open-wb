import { describe, expect, it } from "vitest";
import { fileIcon, formatSize } from "../src/features/files/file-meta.js";

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
