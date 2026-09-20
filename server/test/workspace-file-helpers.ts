import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, vi } from "vitest";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});

export function workspaceTempDir(): string {
  return tempDir();
}

export function spyBodyIo() {
  const spies = [
    vi.spyOn(fs, "read"),
    vi.spyOn(fs, "readSync"),
    vi.spyOn(fs, "readFile"),
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fs, "open"),
    vi.spyOn(fs, "openSync"),
    vi.spyOn(fs, "createReadStream"),
  ];
  syncBuiltinESMExports();
  return spies;
}
