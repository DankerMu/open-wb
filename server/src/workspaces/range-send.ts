/**
 * workspaces/range-send — answers one request for a file whose body may be asked for in a single
 * byte range: 200 with the whole file, 206 with one interval, or 416.
 *
 * The caller has resolved `absPath` through the sandbox, found a regular file there and read its
 * `size`; nothing here checks either again, and the only header of the request it reads is `Range`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { openPreviewStream, openRangeStream, parseRange } from "./preview.js";

export function sendFileRange(
  request: Pick<FastifyRequest, "method" | "headers">,
  reply: FastifyReply,
  file: {
    absPath: string;
    size: number;
    /** Written on 200 and 206. */
    headers: Readonly<Record<string, string>>;
    /** The only headers of a 416 besides its `Content-Range`. */
    unsatisfiableHeaders: Readonly<Record<string, string>>;
  },
): FastifyReply {
  const { absPath, size } = file;
  const range = parseRange(request.headers.range, size);
  if (range === "unsatisfiable") {
    // Not an error envelope (416 is in no definition map) and no file is opened: an empty body.
    return reply
      .code(416)
      .headers(file.unsatisfiableHeaders)
      .header("Content-Range", `bytes */${size}`)
      .send();
  }
  const partial = range !== "ignore";
  const length = partial ? range.end - range.start + 1 : size;
  reply
    .headers(file.headers)
    .header("Accept-Ranges", "bytes")
    .header("Content-Length", `${length}`);
  if (partial) {
    reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  }
  if (request.method === "HEAD") {
    // The framework's HEAD twin drains whatever stream it is given, so it gets an empty one that
    // opens nothing; sending no payload at all would rewrite Content-Length to 0.
    return reply.send(openPreviewStream(absPath, 0));
  }
  return reply.send(
    partial ? openRangeStream(absPath, range.start, range.end) : openPreviewStream(absPath, size),
  );
}
