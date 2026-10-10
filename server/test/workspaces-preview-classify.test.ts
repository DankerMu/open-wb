import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIO_EXTENSIONS,
  classifyPreview,
  DEFAULT_PREVIEW_LIMITS,
  IMAGE_EXTENSIONS,
  NOTEBOOK_EXTENSIONS,
  needsTextSniff,
  openPreviewStream,
  type PreviewLimits,
  sniffText,
  VIDEO_EXTENSIONS,
} from "../src/workspaces/preview.js";
import {
  collectBytes,
  expectCanonicalError,
  expectedTextHeaders,
  spyMetadataIo,
  TEXT_MIME,
  workspaceTempDir,
} from "./workspace-file-helpers.js";

// Boundary values are literals on purpose: taking them from DEFAULT_PREVIEW_LIMITS would let a
// changed default pass its own tests.
const DEFAULTS = { limits: DEFAULT_PREVIEW_LIMITS };
const TEXT_TABLE = [
  ..."md txt log csv tsv json js mjs cjs jsx ts tsx html htm css scss py go rs java c h cpp".split(
    " ",
  ),
  ..."sh sql yaml yml toml ini xml svg env".split(" "),
];
const IMAGE_TABLE = [
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
] as const;
const MEDIA_TABLE = [
  ["mp3", "audio", "audio/mpeg"],
  ["wav", "audio", "audio/wav"],
  ["mp4", "video", "video/mp4"],
  ["webm", "video", "video/webm"],
] as const;
const SNIFFED_NAMES = ["dockerfile", "makefile", "notes.proto", "LICENSE", ".gitignore"];

/** The header set of every non-text class; only the rangeable ones advertise ranges. */
function binaryHeaders(contentType: string, size: number, rangeable: boolean) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Workbuddy-Size": String(size),
    ...(rangeable ? { "Accept-Ranges": "bytes" } : {}),
  };
}

describe("classifyPreview table", () => {
  it("classifies every row of the table from the name alone, without touching absPath", () => {
    const missingPath = join(workspaceTempDir(), "does-not-exist");
    const spies = spyMetadataIo();

    expect(TEXT_TABLE).toHaveLength(32);
    for (const name of [...TEXT_TABLE.map((ext) => `x.${ext}`), "Dockerfile", "Makefile"]) {
      expect(classifyPreview(missingPath, name, 20, DEFAULTS), name).toEqual({
        kind: "text",
        contentType: TEXT_MIME,
        truncated: false,
        limit: 20,
        rangeable: false,
        headers: expectedTextHeaders(20, false),
      });
    }
    for (const [ext, contentType] of IMAGE_TABLE) {
      expect(classifyPreview(missingPath, `x.${ext}`, 8, DEFAULTS), ext).toEqual({
        kind: "image",
        contentType,
        truncated: false,
        limit: 8,
        rangeable: false,
        headers: binaryHeaders(contentType, 8, false),
      });
    }
    for (const [ext, kind, contentType] of MEDIA_TABLE) {
      expect(classifyPreview(missingPath, `x.${ext}`, 8, DEFAULTS), ext).toEqual({
        kind,
        contentType,
        truncated: false,
        limit: 8,
        rangeable: true,
        headers: binaryHeaders(contentType, 8, true),
      });
    }
    expect(classifyPreview(missingPath, "x.ipynb", 8, DEFAULTS)).toEqual({
      kind: "notebook",
      contentType: TEXT_MIME,
      truncated: false,
      limit: 8,
      rangeable: false,
      headers: expectedTextHeaders(8, false),
    });

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("exports the default limits and the four extension sets of the table", () => {
    const limits: PreviewLimits = DEFAULT_PREVIEW_LIMITS;
    expect(limits).toEqual({ text: 1_048_576, image: 20_971_520, notebook: 10_485_760 });
    expect([...IMAGE_EXTENSIONS].sort()).toEqual(IMAGE_TABLE.map(([ext]) => ext).sort());
    expect([...AUDIO_EXTENSIONS].sort()).toEqual(["mp3", "wav"]);
    expect([...VIDEO_EXTENSIONS].sort()).toEqual(["mp4", "webm"]);
    expect([...NOTEBOOK_EXTENSIONS]).toEqual(["ipynb"]);
  });

  it("classifies the added text extensions and the two exact file names as text", () => {
    const names = ["a.py", "A.YAML", "b.tsv", "c.scss", "x.env", "Dockerfile", "Makefile"];
    for (const name of names) {
      const result = classifyPreview(`/opaque/${name}`, name, 12, DEFAULTS);
      expect(result.kind, name).toBe("text");
      expect(result.contentType, name).toBe(TEXT_MIME);
    }
  });

  it("classifies unknown and extensionless names as text only when sniffedText is true", () => {
    const missingPath = join(workspaceTempDir(), "does-not-exist");
    const spies = spyMetadataIo();

    for (const name of SNIFFED_NAMES) {
      const options = { limits: DEFAULT_PREVIEW_LIMITS, sniffedText: true };
      expect(classifyPreview(missingPath, name, 20, options), name).toEqual({
        kind: "text",
        contentType: TEXT_MIME,
        truncated: false,
        limit: 20,
        rangeable: false,
        headers: expectedTextHeaders(20, false),
      });
      const large = classifyPreview(missingPath, name, 1_048_577, options);
      expect(large.limit, name).toBe(1_048_576);
      expect(large.headers, name).toEqual(expectedTextHeaders(1_048_577, true));
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("throws preview_unsupported for unknown and extensionless names when sniffedText is not provided", () => {
    for (const name of SNIFFED_NAMES) {
      expectCanonicalError(
        () => classifyPreview(`/opaque/${name}`, name, 20, DEFAULTS),
        "preview_unsupported",
      );
    }
  });

  it("throws preview_unsupported for unknown and extensionless names when sniffedText is false", () => {
    for (const name of SNIFFED_NAMES) {
      expectCanonicalError(
        () =>
          classifyPreview(`/opaque/${name}`, name, 20, {
            limits: DEFAULT_PREVIEW_LIMITS,
            sniffedText: false,
          }),
        "preview_unsupported",
      );
    }
  });

  it("treats a leading dot as no extension: an unsniffed .env is unsupported while x.env is text", () => {
    expectCanonicalError(
      () => classifyPreview("/opaque/.env", ".env", 20, DEFAULTS),
      "preview_unsupported",
    );
    expect(classifyPreview("/opaque/x.env", "x.env", 20, DEFAULTS).kind).toBe("text");
    expect(classifyPreview("/opaque/.x.env", ".x.env", 20, DEFAULTS).kind).toBe("text");
  });
});

describe("classifyPreview limits", () => {
  it("allows a gif of exactly 20 MiB and rejects 20 MiB + 1", () => {
    expect(classifyPreview("/opaque/exact.gif", "exact.gif", 20_971_520, DEFAULTS)).toEqual({
      kind: "image",
      contentType: "image/gif",
      truncated: false,
      limit: 20_971_520,
      rangeable: false,
      headers: binaryHeaders("image/gif", 20_971_520, false),
    });
    expectCanonicalError(
      () => classifyPreview("/opaque/over.gif", "over.gif", 20_971_521, DEFAULTS),
      "preview_too_large",
    );
  });

  it("classifies webp and ico and rejects zip without opening content", () => {
    const root = workspaceTempDir();
    const spies = spyMetadataIo();

    expect(classifyPreview(join(root, "pic.webp"), "pic.webp", 5, DEFAULTS).contentType).toBe(
      "image/webp",
    );
    expect(classifyPreview(join(root, "fav.ico"), "fav.ico", 5, DEFAULTS).contentType).toBe(
      "image/x-icon",
    );
    expectCanonicalError(
      () => classifyPreview(join(root, "archive.zip"), "archive.zip", 2, DEFAULTS),
      "preview_unsupported",
    );
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("keeps a notebook of exactly 10 MiB whole and never truncated", () => {
    expect(classifyPreview("/opaque/a.ipynb", "a.ipynb", 10_485_760, DEFAULTS)).toEqual({
      kind: "notebook",
      contentType: TEXT_MIME,
      truncated: false,
      limit: 10_485_760,
      rangeable: false,
      headers: expectedTextHeaders(10_485_760, false),
    });
  });

  it("throws preview_too_large for a notebook of 10 MiB + 1", () => {
    expectCanonicalError(
      () => classifyPreview("/opaque/big.ipynb", "big.ipynb", 10_485_761, DEFAULTS),
      "preview_too_large",
    );
  });

  it("classifies a 5 GiB mp4 as rangeable video without a size limit", () => {
    const size = 5 * 1024 * 1024 * 1024;
    expect(classifyPreview("/opaque/film.mp4", "film.mp4", size, DEFAULTS)).toEqual({
      kind: "video",
      contentType: "video/mp4",
      truncated: false,
      limit: 5_368_709_120,
      rangeable: true,
      headers: {
        "Content-Type": "video/mp4",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "X-Workbuddy-Size": "5368709120",
        "Accept-Ranges": "bytes",
      },
    });
  });

  it("classifies a 5 GiB wav as rangeable audio without a size limit", () => {
    const size = 5 * 1024 * 1024 * 1024;
    expect(classifyPreview("/opaque/take.wav", "take.wav", size, DEFAULTS)).toEqual({
      kind: "audio",
      contentType: "audio/wav",
      truncated: false,
      limit: 5_368_709_120,
      rangeable: true,
      headers: {
        "Content-Type": "audio/wav",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "X-Workbuddy-Size": "5368709120",
        "Accept-Ranges": "bytes",
      },
    });
  });

  it("classifies wav as rangeable audio", () => {
    const result = classifyPreview("/opaque/clip.wav", "clip.wav", 44, DEFAULTS);
    expect(result.kind).toBe("audio");
    expect(result.contentType).toBe("audio/wav");
    expect(result.rangeable).toBe(true);
    expect(result.headers["Accept-Ranges"]).toBe("bytes");
  });

  it("applies the limits it is given instead of the defaults", () => {
    const limits = { text: 16, image: 1024, notebook: 32 };
    expectCanonicalError(
      () => classifyPreview("/opaque/small.png", "small.png", 2048, { limits }),
      "preview_too_large",
    );
    expect(classifyPreview("/opaque/small.png", "small.png", 1024, { limits }).limit).toBe(1024);

    const text = classifyPreview("/opaque/t.txt", "t.txt", 20, { limits });
    expect(text.limit).toBe(16);
    expect(text.headers).toEqual(expectedTextHeaders(20, true));
    expect(classifyPreview("/opaque/t.txt", "t.txt", 16, { limits }).truncated).toBe(false);

    expect(classifyPreview("/opaque/n.ipynb", "n.ipynb", 32, { limits }).limit).toBe(32);
    expectCanonicalError(
      () => classifyPreview("/opaque/n.ipynb", "n.ipynb", 33, { limits }),
      "preview_too_large",
    );
  });

  it("rejects the names served elsewhere even with sniffedText true, and an unsniffed unknown binary", () => {
    const missingPath = join(workspaceTempDir(), "does-not-exist");
    const spies = spyMetadataIo();
    const names = [
      "a.pdf",
      "b.docx",
      "c.xlsx",
      "d.pptx",
      "e.zip",
      "f.tar",
      "g.tar.gz",
      "h.tgz",
      "I.PDF",
    ];

    for (const name of names) {
      expectCanonicalError(
        () =>
          classifyPreview(missingPath, name, 20, {
            limits: DEFAULT_PREVIEW_LIMITS,
            sniffedText: true,
          }),
        "preview_unsupported",
      );
    }
    // `exe` is in no set and the route does not sniff yet: once #1056 wires the sniff in, its
    // bytes are what keep it out.
    for (const options of [DEFAULTS, { limits: DEFAULT_PREVIEW_LIMITS, sniffedText: false }]) {
      expectCanonicalError(
        () => classifyPreview(missingPath, "i.exe", 20, options),
        "preview_unsupported",
      );
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("needsTextSniff", () => {
  it("is true only for names outside every row of the table", () => {
    for (const name of [...SNIFFED_NAMES, ".env", "i.exe", "file.constructor", "a.b.unknownext"]) {
      expect(needsTextSniff(name), name).toBe(true);
    }
    const known = [
      ...TEXT_TABLE.map((ext) => `x.${ext}`),
      ...IMAGE_TABLE.map(([ext]) => `x.${ext}`),
      ...MEDIA_TABLE.map(([ext]) => `x.${ext}`),
      "x.ipynb",
      "Dockerfile",
      "Makefile",
      "A.YAML",
      "g.tar.gz",
    ];
    for (const name of known) {
      expect(needsTextSniff(name), name).toBe(false);
    }
  });

  it("is false for the names served elsewhere: their content is never read here", () => {
    for (const ext of "pdf docx xlsx pptx zip tar gz tgz".split(" ")) {
      expect(needsTextSniff(`x.${ext}`), ext).toBe(false);
    }
    expect(needsTextSniff("I.PDF")).toBe(false);
  });
});

describe("classifyPreview never returns a document type", () => {
  it("serves html, htm and svg as text/plain across the truncation point", async () => {
    const body = Buffer.concat([
      Buffer.alloc(1_048_575, 0x61),
      Buffer.from("中"),
      Buffer.from("<script>tail</script>"),
    ]);
    const root = workspaceTempDir();

    for (const name of ["page.html", "page.htm", "logo.svg", "PAGE.HTML", "LOGO.SVG"]) {
      const path = join(root, name);
      writeFileSync(path, body);
      const plan = classifyPreview(path, name, body.length, DEFAULTS);
      expect(plan.kind, name).toBe("text");
      expect(plan.contentType, name).toBe("text/plain; charset=utf-8");
      expect(plan.truncated, name).toBe(true);
      expect(plan.limit, name).toBe(1_048_576);
      expect(plan.headers, name).toEqual(expectedTextHeaders(body.length, true));
      expect(plan.headers["Content-Type"], name).not.toContain("html");
      expect(plan.headers["Content-Type"], name).not.toContain("svg");

      const actual = await collectBytes(openPreviewStream(path, plan.limit));
      expect(actual.equals(body.subarray(0, 1_048_576)), name).toBe(true);
      expect(actual.subarray(1_048_575), name).toEqual(Buffer.from([0xe4]));
    }
  });
});

describe("sniffText", () => {
  const utf8 = Buffer.from("中文");

  it("accepts empty input", () => {
    expect(sniffText(new Uint8Array(0))).toBe(true);
  });

  it("accepts plain ASCII", () => {
    expect(sniffText(Buffer.from("MIT License\n\nCopyright (c)\n"))).toBe(true);
  });

  it("accepts UTF-8 cut at the second byte of a three-byte character", () => {
    expect(utf8.subarray(0, 5)).toEqual(Buffer.from([0xe4, 0xb8, 0xad, 0xe6, 0x96]));
    expect(sniffText(utf8.subarray(0, 5))).toBe(true);
    expect(sniffText(utf8)).toBe(true);
  });

  it("rejects input containing one 0x00 byte", () => {
    expect(sniffText(Buffer.from([0x61, 0x62, 0x00, 0x63, 0x64]))).toBe(false);
  });

  it("rejects GBK-encoded Chinese", () => {
    expect(sniffText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(false);
  });

  it("rejects a PNG file header", () => {
    expect(sniffText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
  });
});
