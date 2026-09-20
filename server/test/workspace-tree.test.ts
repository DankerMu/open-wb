import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listOneLevel } from "../src/workspaces/tree.js";
import { spyBodyIo, workspaceTempDir } from "./workspace-file-helpers.js";

describe("listOneLevel", () => {
  it("lists only the direct ordinary directory and file, skipping nested entries, FIFO, and every symlink kind", () => {
    const root = workspaceTempDir();
    const nested = join(root, "out");
    mkdirSync(nested);
    writeFileSync(join(nested, "a.md"), "# nested\n");
    writeFileSync(join(root, "b.txt"), "plain");
    symlinkSync(join(root, "b.txt"), join(root, "file-link"));
    symlinkSync(nested, join(root, "dir-link"));
    symlinkSync(join(root, "missing-target"), join(root, "dangling"));
    execFileSync("mkfifo", [join(root, "pipe")]);

    const spies = spyBodyIo();
    const entries = listOneLevel(root);

    expect(entries.map((entry) => [entry.name, entry.type])).toEqual([
      ["out", "dir"],
      ["b.txt", "file"],
    ]);
    expect(listOneLevel(nested).map((entry) => [entry.name, entry.type])).toEqual([
      ["a.md", "file"],
    ]);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("keeps directories first and sorts each group by UTF-8 bytes, including numeric lexical names and U+E000 before U+10000", () => {
    const root = workspaceTempDir();
    const privateUse = "\uE000";
    const supplementary = "\u{10000}";
    for (const name of ["2", "10", "中", privateUse, supplementary]) {
      mkdirSync(join(root, name));
    }
    for (const name of ["2.txt", "10.txt", "b.txt", `${privateUse}.txt`, `${supplementary}.txt`]) {
      writeFileSync(join(root, name), "x");
    }

    expect(listOneLevel(root).map((entry) => entry.name)).toEqual([
      "10",
      "2",
      "中",
      privateUse,
      supplementary,
      "10.txt",
      "2.txt",
      "b.txt",
      `${privateUse}.txt`,
      `${supplementary}.txt`,
    ]);
  });

  it("reports native file byte size and the known epoch-ms mtime without aggregating nested directory contents", () => {
    const root = workspaceTempDir();
    const nestedBytes = Buffer.from("0123456789");
    const fileBytes = Buffer.from([0xe4, 0xb8, 0xad, 0x0a]);
    const mtimeSec = 1_726_000_000;
    const mtimeMs = mtimeSec * 1000;
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "a.md"), nestedBytes);
    writeFileSync(join(root, "notes.txt"), fileBytes);
    utimesSync(join(root, "out"), mtimeSec, mtimeSec);
    utimesSync(join(root, "notes.txt"), mtimeSec, mtimeSec);

    const entries = listOneLevel(root);
    expect(entries).toEqual([
      { name: "out", type: "dir", size: lstatSync(join(root, "out")).size, mtime: mtimeMs },
      { name: "notes.txt", type: "file", size: 4, mtime: mtimeMs },
    ]);
    expect(entries[0]?.size).not.toBe(nestedBytes.length);
    expect(new Date(entries[1]?.mtime ?? 0).toISOString()).toBe(new Date(mtimeMs).toISOString());
  });

  it("propagates filesystem errors instead of returning an empty listing", () => {
    const root = workspaceTempDir();
    writeFileSync(join(root, "file.txt"), "x");

    expect(() => listOneLevel(join(root, "missing"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => listOneLevel(join(root, "file.txt"))).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});
