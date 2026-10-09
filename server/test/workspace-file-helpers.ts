import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { Readable } from "node:stream";
import { afterEach, expect, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";

export const TEXT_MIME = "text/plain; charset=utf-8";

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

export function spyMetadataIo() {
  const spies = [
    ...spyBodyIo(),
    vi.spyOn(fs, "stat"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "lstat"),
    vi.spyOn(fs, "lstatSync"),
    vi.spyOn(fs, "fstat"),
    vi.spyOn(fs, "fstatSync"),
  ];
  syncBuiltinESMExports();
  return spies;
}

export function expectCanonicalError(
  run: () => unknown,
  code: "preview_unsupported" | "preview_too_large",
): void {
  try {
    run();
    expect.fail(`expected canonical HttpError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      name: "HttpError",
      code,
      message: code === "preview_unsupported" ? "该类型不支持预览" : "文件过大，无法预览",
    });
  }
}

export function expectedTextHeaders(size: number, truncated: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": TEXT_MIME,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Workbuddy-Size": String(size),
  };
  if (truncated) {
    headers["X-Workbuddy-Truncated"] = "1";
  }
  return headers;
}

export async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
