/**
 * workspaces/rest-entries — routes on one entry of a workspace beyond the preview: download.
 *
 * The same order as every scoped workspace route: principal, owned root (404 for another
 * owner's and for an unknown id alike), then the query, then the sandbox.
 */
import { basename } from "node:path";
import type { FastifyInstance, onErrorHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";
import { openPreviewStream } from "./preview.js";
import {
  currentPrincipal,
  ensureOwnedRoot,
  lstatExisting,
  noStoreWorkspaceResponse,
  parsePathQuery,
  type WorkspaceRestDependencies,
} from "./rest.js";

/** RFC 5987 attr-char: the bytes `filename*` carries as they are. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/u;

/**
 * The `Content-Disposition` of a download named `name`. `filename` is the ASCII fallback: each
 * code point outside 0x20–0x7E, and each `"` and `\`, becomes one `_` (a surrogate pair is one
 * code point). `filename*` is the UTF-8 bytes percent-encoded per RFC 5987 — not
 * `encodeURIComponent`, which leaves `'()*` bare and throws on a lone surrogate.
 */
export function attachmentDisposition(name: string): string {
  let fallback = "";
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    const printable = codePoint >= 0x20 && codePoint <= 0x7e;
    fallback += printable && character !== '"' && character !== "\\" ? character : "_";
  }
  let encoded = "";
  for (const byte of Buffer.from(name, "utf8")) {
    const character = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** An error after the download headers were set must not go out as an octet-stream attachment. */
const clearDownloadHeadersOnError: onErrorHookHandler = (_request, reply, _error, done) => {
  reply.removeHeader("Content-Type");
  reply.removeHeader("Content-Disposition");
  reply.removeHeader("Content-Length");
  done();
};

export function registerWorkspaceEntries(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/download",
    {
      // No HEAD twin: it would run this handler and audit a download that sent no byte.
      exposeHeadRoute: false,
      onError: clearDownloadHeadersOnError,
      onRequest: noStoreWorkspaceResponse,
    },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      ensureOwnedRoot(dependencies, principal, workspaceId);
      const path = parsePathQuery(request.query, true);
      const absPath = dependencies.sandbox.resolve(principal, workspaceId, path, "read");
      const status = lstatExisting(absPath);
      if (status === undefined || !status.isFile()) {
        throw new HttpError("not_found");
      }
      // Before the stream exists: a download that cannot be audited opens nothing.
      dependencies.audit.emit({
        kind: "file.download",
        actorId: principal.id,
        workspaceId,
        title: `下载 ${path}`,
        detail: { path, size: status.size },
      });
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", attachmentDisposition(basename(absPath)));
      reply.header("Content-Length", String(status.size));
      reply.header("X-Content-Type-Options", "nosniff");
      // Any size and no Range. Bounded by the size just read: a file that grows meanwhile
      // sends no byte beyond the declared length.
      return reply.send(openPreviewStream(absPath, status.size));
    },
  );
}
