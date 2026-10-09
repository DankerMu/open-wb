import fs, { fstatSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyPreview,
  DEFAULT_PREVIEW_LIMITS,
  openPreviewStream,
} from "../src/workspaces/preview.js";
import {
  collectBytes,
  expectCanonicalError,
  expectedTextHeaders,
  spyMetadataIo,
  TEXT_MIME,
  waitForClose,
  waitForOpen,
  workspaceTempDir,
} from "./workspace-file-helpers.js";

const TEXT_LIMIT = 1_048_576;
const IMAGE_LIMIT = 20_971_520;
const DEFAULTS = { limits: DEFAULT_PREVIEW_LIMITS };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);
const TEXT_EXTS = ["md", "txt", "log", "csv", "json", "js", "ts", "tsx", "html"] as const;
const IMAGE_EXTS = [
  { ext: "png", contentType: "image/png" },
  { ext: "jpg", contentType: "image/jpeg" },
  { ext: "jpeg", contentType: "image/jpeg" },
] as const;

function expectedImageHeaders(contentType: string, size: number): Record<string, string> {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Workbuddy-Size": String(size),
  };
}

describe("classifyPreview", () => {
  it("classifies the PREVIEWABLE set with lowercase normalization and production-owned headers", () => {
    const missingPath = join(workspaceTempDir(), "does-not-exist");
    const spies = spyMetadataIo();

    for (const ext of TEXT_EXTS) {
      const result = classifyPreview(missingPath, `x.${ext.toUpperCase()}`, 20, DEFAULTS);
      expect(result).toEqual({
        kind: "text",
        contentType: TEXT_MIME,
        truncated: false,
        limit: 20,
        rangeable: false,
        headers: expectedTextHeaders(20, false),
      });
    }

    for (const { ext, contentType } of IMAGE_EXTS) {
      const result = classifyPreview(missingPath, `x.${ext.toUpperCase()}`, 8, DEFAULTS);
      expect(result).toEqual({
        kind: "image",
        contentType,
        truncated: false,
        limit: 8,
        rangeable: false,
        headers: expectedImageHeaders(contentType, 8),
      });
    }

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("keeps html/json/js as text/plain and never emits text/html", () => {
    const result = classifyPreview("/opaque/page.HTML", "page.HTML", 91, DEFAULTS);
    expect(result.contentType).toBe(TEXT_MIME);
    expect(result.headers["Content-Type"]).toBe(TEXT_MIME);
    expect(result.headers["Content-Type"]).not.toContain("text/html");
    expect(result.kind).toBe("text");
  });

  it("truncates only text larger than 1 MiB and keeps original decimal size headers", () => {
    const cases = [
      { size: 0, truncated: false, limit: 0 },
      { size: TEXT_LIMIT, truncated: false, limit: TEXT_LIMIT },
      { size: TEXT_LIMIT + 1, truncated: true, limit: TEXT_LIMIT },
      { size: 1_572_864, truncated: true, limit: TEXT_LIMIT },
    ];

    for (const { size, truncated, limit } of cases) {
      const result = classifyPreview("/opaque/big.log", "big.log", size, DEFAULTS);
      expect(result.kind).toBe("text");
      expect(result.truncated).toBe(truncated);
      expect(result.limit).toBe(limit);
      expect(result.headers).toEqual(expectedTextHeaders(size, truncated));
      expect(result.headers["X-Workbuddy-Size"]).toBe(String(size));
      if (truncated) {
        expect(result.headers["X-Workbuddy-Truncated"]).toBe("1");
      } else {
        expect(result.headers).not.toHaveProperty("X-Workbuddy-Truncated");
      }
    }
  });

  it("allows exact 20 MiB images and rejects larger images and unsupported names without opening content", () => {
    const root = workspaceTempDir();
    const exactPng = join(root, "exact.png");
    const plusOnePng = join(root, "plus-one.png");
    const hugePng = join(root, "huge.png");
    const archive = join(root, "archive.zip");
    writeFileSync(exactPng, "");
    writeFileSync(plusOnePng, "");
    writeFileSync(hugePng, "");
    writeFileSync(archive, "PK");
    truncateSync(exactPng, IMAGE_LIMIT);
    truncateSync(plusOnePng, IMAGE_LIMIT + 1);
    truncateSync(hugePng, 21 * 1024 * 1024);

    const spies = spyMetadataIo();
    const allowed = classifyPreview(exactPng, "exact.png", IMAGE_LIMIT, DEFAULTS);
    expect(allowed).toEqual({
      kind: "image",
      contentType: "image/png",
      truncated: false,
      limit: IMAGE_LIMIT,
      rangeable: false,
      headers: expectedImageHeaders("image/png", IMAGE_LIMIT),
    });
    expect(allowed.headers).not.toHaveProperty("X-Workbuddy-Truncated");

    expectCanonicalError(
      () => classifyPreview(plusOnePng, "plus-one.png", IMAGE_LIMIT + 1, DEFAULTS),
      "preview_too_large",
    );
    expectCanonicalError(
      () => classifyPreview(hugePng, "huge.PNG", 21 * 1024 * 1024, DEFAULTS),
      "preview_too_large",
    );
    expectCanonicalError(
      () => classifyPreview(archive, "archive.zip", 2, DEFAULTS),
      "preview_unsupported",
    );
    expectCanonicalError(
      () => classifyPreview(join(root, "missing.bin"), "missing.bin", 0, DEFAULTS),
      "preview_unsupported",
    );

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("allows an 11 MiB png now that the image limit is 20 MiB", () => {
    const size = 11 * 1024 * 1024;
    expect(classifyPreview("/opaque/eleven.png", "eleven.png", size, DEFAULTS)).toEqual({
      kind: "image",
      contentType: "image/png",
      truncated: false,
      limit: 11_534_336,
      rangeable: false,
      headers: expectedImageHeaders("image/png", 11_534_336),
    });
  });

  it("rejects Object.prototype names as unsupported instead of inheriting image lookup", () => {
    const spies = spyMetadataIo();
    for (const ext of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expectCanonicalError(
        () => classifyPreview("/opaque/file." + ext, `file.${ext}`, 1, DEFAULTS),
        "preview_unsupported",
      );
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("openPreviewStream", () => {
  it("streams exact original bytes for allowed PNG and JPEG files", async () => {
    const root = workspaceTempDir();
    const pngPath = join(root, "logo.png");
    const jpegPath = join(root, "photo.jpg");
    writeFileSync(pngPath, PNG_BYTES);
    writeFileSync(jpegPath, JPEG_BYTES);

    const pngPlan = classifyPreview(pngPath, "logo.png", PNG_BYTES.length, DEFAULTS);
    const jpegPlan = classifyPreview(jpegPath, "photo.jpeg", JPEG_BYTES.length, DEFAULTS);
    expect(pngPlan.headers).toEqual(expectedImageHeaders("image/png", PNG_BYTES.length));
    expect(jpegPlan.headers).toEqual(expectedImageHeaders("image/jpeg", JPEG_BYTES.length));
    expect(await collectBytes(openPreviewStream(pngPath, pngPlan.limit))).toEqual(PNG_BYTES);
    expect(await collectBytes(openPreviewStream(jpegPath, jpegPlan.limit))).toEqual(JPEG_BYTES);
  });

  it("returns an empty binary Readable for zero-byte text without a negative end", async () => {
    const emptyPath = join(workspaceTempDir(), "empty.txt");
    writeFileSync(emptyPath, "");
    const plan = classifyPreview(emptyPath, "empty.txt", 0, DEFAULTS);
    expect(plan.headers).toEqual(expectedTextHeaders(0, false));

    const nativeCreate = vi.spyOn(fs, "createReadStream");
    syncBuiltinESMExports();
    const stream = openPreviewStream(emptyPath, plan.limit);

    expect(plan.limit).toBe(0);
    expect(stream.readableObjectMode).toBe(false);
    expect(await collectBytes(stream)).toEqual(Buffer.alloc(0));
    for (const call of nativeCreate.mock.calls) {
      const options = call[1] as { end?: number } | undefined;
      if (options !== undefined) {
        expect(options.end).not.toBe(-1);
        expect(options.end === undefined || options.end >= 0).toBe(true);
      }
    }
  });

  it("cuts text at the raw 1 MiB prefix even when a multibyte UTF-8 sequence straddles the cutoff", async () => {
    const body = Buffer.concat([
      Buffer.alloc(TEXT_LIMIT - 1, 0x61),
      Buffer.from("中"),
      Buffer.from("tail"),
    ]);
    expect(body.subarray(TEXT_LIMIT - 1, TEXT_LIMIT + 2)).toEqual(Buffer.from("中"));
    const path = join(workspaceTempDir(), "big.log");
    writeFileSync(path, body);

    const plan = classifyPreview(path, "big.log", body.length, DEFAULTS);
    expect(plan.truncated).toBe(true);
    expect(plan.limit).toBe(TEXT_LIMIT);
    expect(plan.headers["X-Workbuddy-Size"]).toBe(String(body.length));
    expect(plan.headers["X-Workbuddy-Truncated"]).toBe("1");

    const actual = await collectBytes(openPreviewStream(path, plan.limit));
    expect(actual.equals(body.subarray(0, TEXT_LIMIT))).toBe(true);
    expect(actual.length).toBe(TEXT_LIMIT);
    expect(actual.subarray(TEXT_LIMIT - 1)).toEqual(Buffer.from([0xe4]));
  });

  it("releases the captured descriptor after a fully consumed stream closes", async () => {
    const path = join(workspaceTempDir(), "notes.txt");
    writeFileSync(path, "abcdef");
    const stream = openPreviewStream(path, 6);
    const opened = waitForOpen(stream);
    const closed = waitForClose(stream);
    expect(await collectBytes(stream)).toEqual(Buffer.from("abcdef"));
    const fd = await opened;
    await closed;
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("releases the captured descriptor after early destroy", async () => {
    const path = join(workspaceTempDir(), "notes.txt");
    writeFileSync(path, Buffer.alloc(64, 0x61));
    const stream = openPreviewStream(path, 64);
    const opened = waitForOpen(stream);
    const closed = waitForClose(stream);
    const fd = await opened;
    stream.destroy();
    await closed;
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("propagates a missing-file open error without fabricating an empty body", async () => {
    const missing = join(workspaceTempDir(), "gone.txt");
    const stream = openPreviewStream(missing, 4);
    const closed = waitForClose(stream);
    await expect(collectBytes(stream)).rejects.toMatchObject({ code: "ENOENT" });
    await closed;
  });

  it("propagates a real filesystem read error from an existing directory target", async () => {
    const path = join(workspaceTempDir(), "blocked");
    mkdirSync(path);
    const stream = openPreviewStream(path, 6);
    const closed = waitForClose(stream);
    await expect(collectBytes(stream)).rejects.toMatchObject({ code: "EISDIR" });
    await closed;
  });
});

describe("classifier and stream stay sequenced as metadata then bounded bytes", () => {
  it("does not open content while classifying a later-streamed 1.5 MiB log", async () => {
    const body = Buffer.alloc(1_572_864, 0x61);
    const path = join(workspaceTempDir(), "big.log");
    writeFileSync(path, body);
    const spies = spyMetadataIo();

    const plan = classifyPreview(path, "big.LOG", body.length, DEFAULTS);
    expect(plan.kind).toBe("text");
    expect(plan.limit).toBe(TEXT_LIMIT);
    expect(plan.headers).toEqual(expectedTextHeaders(body.length, true));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }

    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(
      (await collectBytes(openPreviewStream(path, plan.limit))).equals(
        body.subarray(0, TEXT_LIMIT),
      ),
    ).toBe(true);
  });
});
