/**
 * Issue #909 (design D8): how much of an upstream ≥500 error body the proxy reads for the excerpt —
 * at most the first 16 KiB and at most 5000 ms from the response headers, whichever comes first;
 * nothing when `content-encoding` is set to anything but `identity`. The upstream response is
 * destroyed in every case. The limits are a parameter so a test can use short ones. `cut` says the
 * body did not end inside the limits (byte cap — reaching it counts —, time cap, error, close): its
 * tail may be the first half of a secret, which `upstreamExcerpt` then drops.
 */
import type { IncomingMessage } from "node:http";

interface ErrorBodyLimits {
  bytes: number;
  ms: number;
}

export interface ErrorBody {
  body: Buffer;
  cut: boolean;
}

const ERROR_BODY_LIMITS: ErrorBodyLimits = { bytes: 16 * 1024, ms: 5_000 };

export function readErrorBody(
  response: IncomingMessage,
  limits: ErrorBodyLimits = ERROR_BODY_LIMITS,
): Promise<ErrorBody> {
  const encoding = response.headers["content-encoding"];
  if (
    encoding !== undefined &&
    encoding.trim() !== "" &&
    encoding.trim().toLowerCase() !== "identity"
  ) {
    response.destroy();
    return Promise.resolve({ body: Buffer.alloc(0), cut: false });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (ended: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      response.destroy();
      resolve({ body: Buffer.concat(chunks).subarray(0, limits.bytes), cut: !ended });
    };
    const timer = setTimeout(() => finish(false), limits.ms);
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limits.bytes) {
        finish(false);
      }
    });
    response.once("end", () => finish(true));
    response.once("error", () => finish(false));
    response.once("close", () => finish(false));
  });
}
