/**
 * workspaces/preview — metadata-only classification and bounded raw-byte streams.
 *
 * classifyPreview uses the trusted file name, the size and the caller's options
 * (limits, and whether a prefix sniffed as text) and never opens the opaque
 * absPath; sniffText judges only the bytes it is handed. openPreviewStream
 * streams native bytes up to a nonnegative caller-supplied limit; HTTP status
 * mapping and sandbox resolve remain outside this module.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { HttpError } from "../core/errors/index.js";

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
// Lookups go through Set / Map only: a name such as `file.constructor` must not inherit a hit.
// html, htm and svg are text on purpose — the main origin never serves a workspace file as a
// document a browser would render.
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ..."md txt log csv tsv json js mjs cjs jsx ts tsx html htm css scss py go rs java c h cpp".split(
    " ",
  ),
  ..."sh sql yaml yml toml ini xml svg env".split(" "),
]);
/** Exact and case-sensitive: `dockerfile` is an unknown name like any other. */
const TEXT_FILE_NAMES: ReadonlySet<string> = new Set(["Dockerfile", "Makefile"]);
const IMAGE_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
]);
const AUDIO_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
]);
const VIDEO_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
]);
/** Served by the preview origin, the office converter and the archive listing — never from here, sniffed or not. */
const SERVED_ELSEWHERE: ReadonlySet<string> = new Set(
  "pdf docx xlsx pptx zip tar gz tgz".split(" "),
);

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(IMAGE_CONTENT_TYPES.keys());
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(AUDIO_CONTENT_TYPES.keys());
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(VIDEO_CONTENT_TYPES.keys());
export const NOTEBOOK_EXTENSIONS: ReadonlySet<string> = new Set(["ipynb"]);

export interface PreviewLimits {
  /** Text beyond this many bytes is truncated to it. */
  text: number;
  /** An image beyond this many bytes is `preview_too_large`. */
  image: number;
  /** A notebook beyond this many bytes is `preview_too_large`: truncated JSON cannot be parsed. */
  notebook: number;
}

export const DEFAULT_PREVIEW_LIMITS: PreviewLimits = {
  text: 1_048_576,
  image: 20_971_520,
  notebook: 10_485_760,
};

type PreviewKind = "text" | "image" | "audio" | "video" | "notebook";

export interface PreviewClassification {
  kind: PreviewKind;
  contentType: string;
  truncated: boolean;
  headers: Record<string, string>;
  limit: number;
  /** Audio and video only: the body may be requested in byte ranges. */
  rangeable: boolean;
}

export function classifyPreview(
  _absPath: string,
  name: string,
  size: number,
  options: { limits: PreviewLimits; sniffedText?: boolean },
): PreviewClassification {
  const { limits } = options;
  // No dot, or the only dot leading (`.env`, `.gitignore`): no extension.
  const dot = name.lastIndexOf(".");
  const ext = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILE_NAMES.has(name)) {
    return text(size, limits.text);
  }
  const imageType = IMAGE_CONTENT_TYPES.get(ext);
  if (imageType !== undefined) {
    if (size > limits.image) {
      throw new HttpError("preview_too_large");
    }
    return classified("image", imageType, false, size, size, false);
  }
  const audioType = AUDIO_CONTENT_TYPES.get(ext);
  if (audioType !== undefined) {
    return classified("audio", audioType, false, size, size, true);
  }
  const videoType = VIDEO_CONTENT_TYPES.get(ext);
  if (videoType !== undefined) {
    return classified("video", videoType, false, size, size, true);
  }
  if (NOTEBOOK_EXTENSIONS.has(ext)) {
    if (size > limits.notebook) {
      throw new HttpError("preview_too_large");
    }
    return classified("notebook", TEXT_CONTENT_TYPE, false, size, size, false);
  }
  if (SERVED_ELSEWHERE.has(ext)) {
    throw new HttpError("preview_unsupported");
  }
  if (options.sniffedText === true) {
    return text(size, limits.text);
  }
  throw new HttpError("preview_unsupported");
}

/**
 * Whether a prefix of a file reads as text: no NUL byte, and valid UTF-8 once a multibyte
 * sequence cut off by the end of the prefix is set aside (what `stream: true` tolerates).
 */
export function sniffText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

export function openPreviewStream(absPath: string, limit: number): Readable {
  if (limit === 0) {
    return Readable.from([], { objectMode: false });
  }
  return createReadStream(absPath, { start: 0, end: limit - 1 });
}

function text(size: number, textLimit: number): PreviewClassification {
  const truncated = size > textLimit;
  return classified(
    "text",
    TEXT_CONTENT_TYPE,
    truncated,
    size,
    truncated ? textLimit : size,
    false,
  );
}

function classified(
  kind: PreviewKind,
  contentType: string,
  truncated: boolean,
  size: number,
  limit: number,
  rangeable: boolean,
): PreviewClassification {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Workbuddy-Size": String(size),
  };
  if (truncated) {
    headers["X-Workbuddy-Truncated"] = "1";
  }
  if (rangeable) {
    headers["Accept-Ranges"] = "bytes";
  }
  return { kind, contentType, truncated, headers, limit, rangeable };
}
