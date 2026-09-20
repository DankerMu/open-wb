/**
 * workspaces/preview — metadata-only classification and bounded raw-byte streams.
 *
 * classifyPreview uses trusted extension/size inputs and never opens the
 * opaque absPath. openPreviewStream streams native bytes up to a nonnegative
 * caller-supplied limit; HTTP status mapping and sandbox resolve remain
 * outside this module.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { HttpError } from "../core/errors/index.js";

const TEXT_LIMIT = 1_048_576;
const IMAGE_LIMIT = 10_485_760;
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const TEXT_EXTENSIONS = new Set(["md", "txt", "log", "csv", "json", "js", "ts", "tsx", "html"]);
const IMAGE_CONTENT_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
]);

export interface PreviewClassification {
  kind: "text" | "image";
  contentType: string;
  truncated: boolean;
  headers: Record<string, string>;
  limit: number;
}

export function classifyPreview(
  _absPath: string,
  ext: string,
  size: number,
): PreviewClassification {
  const normalized = ext.toLowerCase();
  if (TEXT_EXTENSIONS.has(normalized)) {
    const truncated = size > TEXT_LIMIT;
    const limit = truncated ? TEXT_LIMIT : size;
    return classified("text", TEXT_CONTENT_TYPE, truncated, size, limit);
  }

  const imageType = IMAGE_CONTENT_TYPES.get(normalized);
  if (imageType !== undefined) {
    if (size > IMAGE_LIMIT) {
      throw new HttpError("preview_too_large");
    }
    return classified("image", imageType, false, size, size);
  }

  throw new HttpError("preview_unsupported");
}

export function openPreviewStream(absPath: string, limit: number): Readable {
  if (limit === 0) {
    return Readable.from([], { objectMode: false });
  }
  return createReadStream(absPath, { start: 0, end: limit - 1 });
}

function classified(
  kind: "text" | "image",
  contentType: string,
  truncated: boolean,
  size: number,
  limit: number,
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
  return { kind, contentType, truncated, headers, limit };
}
