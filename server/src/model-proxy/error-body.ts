/**
 * Issue #909 (design D8): how much of an upstream ≥500 error body the proxy reads for the excerpt —
 * at most the first 16 KiB and at most 5000 ms from the response headers, whichever comes first;
 * nothing when `content-encoding` is set to anything but `identity`. The upstream response is
 * destroyed in every case. The limits are a parameter so a test can use short ones.
 */
import type { IncomingMessage } from "node:http";

interface ErrorBodyLimits {
  bytes: number;
  ms: number;
}

const ERROR_BODY_LIMITS: ErrorBodyLimits = { bytes: 16 * 1024, ms: 5_000 };

export function readErrorBody(
  response: IncomingMessage,
  limits: ErrorBodyLimits = ERROR_BODY_LIMITS,
): Promise<Buffer> {
  const encoding = response.headers["content-encoding"];
  if (
    encoding !== undefined &&
    encoding.trim() !== "" &&
    encoding.trim().toLowerCase() !== "identity"
  ) {
    response.destroy();
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      response.destroy();
      resolve(Buffer.concat(chunks).subarray(0, limits.bytes));
    };
    const timer = setTimeout(finish, limits.ms);
    response.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limits.bytes) {
        finish();
      }
    });
    response.once("end", finish);
    response.once("error", finish);
    response.once("close", finish);
  });
}
