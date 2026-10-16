/**
 * workspaces/range-send — answers one request for a file whose body may be asked for in a single
 * byte range: 200 with the whole file, 206 with one interval, or 416.
 *
 * The caller has resolved `absPath` through the sandbox, opened it with `openRegularFile` and
 * fstat-ed it: `fd` is a regular file and `size` is that fstat's, so nothing here checks either
 * again, and the only header of the request it reads is `Range`. The descriptor is the caller's
 * no more: it goes to the stream, or is closed here for a 416 and for a HEAD.
 */
import { closeSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openPreviewStream, openRangeStream, parseRange } from "./preview.js";

export function sendFileRange(
  request: Pick<FastifyRequest, "method" | "headers">,
  reply: FastifyReply,
  file: {
    fd: number;
    size: number;
    /** Written on 200 and 206. */
    headers: Readonly<Record<string, string>>;
    /** The only headers of a 416 besides its `Content-Range`. */
    unsatisfiableHeaders: Readonly<Record<string, string>>;
  },
): FastifyReply {
  const { fd, size } = file;
  const range = parseRange(request.headers.range, size);
  if (range === "unsatisfiable") {
    // Not an error envelope (416 is in no definition map); opened for its size, nothing read.
    closeSync(fd);
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
    // closes the descriptor unread; sending no payload at all would rewrite Content-Length to 0.
    return reply.send(openPreviewStream({ fd }, 0));
  }
  return reply.send(
    partial ? openRangeStream({ fd }, range.start, range.end) : openPreviewStream({ fd }, size),
  );
}
