/**
 * workspaces/rest-entries — routes on one entry of a workspace beyond the preview: download,
 * delete, and rename / move.
 *
 * The same order as every scoped workspace route: principal, owned root (404 for another
 * owner's and for an unknown id alike), then the query or the body, then the sandbox.
 *
 * Known residual of the move route (design D22 / D-23, #1286 stays open; nothing here closes
 * it): every check is by path and the `rename` resolves both paths again, re-checking nothing.
 * Derived from the code and from bare `renameSync` runs; never reproduced through the route.
 * - Not overwriting is look-then-rename, not atomic. Having no `await` in between keeps other
 *   handlers' JavaScript out, not the filesystem: a call that another request of this process
 *   has already handed to the thread pool (the `link` of an upload, a step of a snapshot
 *   restore) can land between the lstat at `to` and the rename, and so can another process (the
 *   assistant). What appears at `to` in between is replaced by the rename when it is a
 *   non-directory and the source is a file, or an empty directory and the source is a directory:
 *   an upload linked there answers 201 for bytes that are gone, the move 200 with an ordinary
 *   audit row. A hard link to the source appearing there makes the rename succeed and do
 *   nothing: 200 and the audit row, the entry still at `from`. Every other combination makes the
 *   rename fail (500, the source in place).
 * - A component of either path swapped for a symlink after its lstat is followed by the rename:
 *   in `from`, an entry outside the workspace that this process can move is moved in; in `to`
 *   (the parent just checked included), the entry lands in the link's target directory. Swapped
 *   after the lstat at `to`, that directory was never looked at: a same-named non-directory
 *   there (a file source) or empty directory (a directory source) is replaced, in whatever
 *   directory of this filesystem this process can write — another owner's workspace, the
 *   recycle directory and a snapshot included. The last component is not followed: a link
 *   swapped in as `from` is itself moved, one at `to` is the case above. The audit row names
 *   the logical paths either way.
 */
import { renameSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { FastifyInstance, onErrorHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";
import { openPreviewStream } from "./preview.js";
import {
  currentPrincipal,
  ensureOwnedRoot,
  isOrdinaryDirectory,
  lstatExisting,
  noStoreWorkspaceResponse,
  parseBodyRecord,
  parsePathQuery,
  WORKSPACE_BODY_LIMIT,
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

/** What delete and move act on: an ordinary file or a directory; anything else is not there. */
function entryTypeOf(absPath: string): "file" | "dir" {
  const status = lstatExisting(absPath);
  if (status?.isFile() === true) {
    return "file";
  }
  if (status?.isDirectory() === true) {
    return "dir";
  }
  throw new HttpError("not_found");
}

/** Exactly the two keys, both strings; what they name is the sandbox's to judge. */
function parseMoveBody(body: unknown): { from: string; to: string } {
  const record = parseBodyRecord(body);
  if (
    Object.keys(record).length !== 2 ||
    typeof record.from !== "string" ||
    typeof record.to !== "string"
  ) {
    throw new HttpError("bad_request");
  }
  return { from: record.from, to: record.to };
}

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
  // No body semantics and not an owned-parser route: a well-formed body is ignored.
  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id/entries",
    { onRequest: noStoreWorkspaceResponse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      ensureOwnedRoot(dependencies, principal, workspaceId);
      const path = parsePathQuery(request.query, true);
      // `delete` refuses the empty path too: the workspace root itself is not an entry.
      const absPath = dependencies.sandbox.resolve(principal, workspaceId, path, "delete");
      const type = entryTypeOf(absPath);
      // One rename into the recycle directory; it throws with the entry still in place.
      const trashId = dependencies.trash.moveToTrash(principal.id, workspaceId, absPath);
      // After the rename and not rolled back: if this throws, the entry is in batch `trashId`.
      dependencies.audit.emit({
        kind: "file.delete",
        actorId: principal.id,
        workspaceId,
        title: `删除 ${path}`,
        detail: { path, type, trashId },
      });
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/move",
    {
      bodyLimit: WORKSPACE_BODY_LIMIT,
      onRequest: noStoreWorkspaceResponse,
      // Before the body is parsed: another owner's id, an unknown one and a workspace whose root
      // is gone answer the same 404 whatever the body is.
      preParsing: (request, _reply, payload, done) => {
        ensureOwnedRoot(dependencies, currentPrincipal(request), request.params.id);
        done(null, payload);
      },
    },
    // Synchronous from the first resolve to the rename: no `await` may come in between.
    async (request) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      const { from, to } = parseMoveBody(request.body);
      // `from` first: when it is denied, `to` is not looked at and one rejection is audited.
      const fromAbs = dependencies.sandbox.resolve(principal, workspaceId, from, "move");
      const toAbs = dependencies.sandbox.resolve(principal, workspaceId, to, "move");
      // Into its own subtree. On the two resolved paths and before anything is looked up: it
      // holds whether or not either exists.
      if (toAbs.startsWith(`${fromAbs}/`)) {
        throw new HttpError("bad_request");
      }
      const type = entryTypeOf(fromAbs);
      // The parent is never made here.
      if (!isOrdinaryDirectory(dirname(toAbs))) {
        throw new HttpError("not_found");
      }
      // Whatever is there, `from` itself included: nothing is overwritten or merged.
      if (lstatExisting(toAbs) !== undefined) {
        throw new HttpError("conflict");
      }
      // One rename; it throws (500) with the source in place, and there is no fallback.
      renameSync(fromAbs, toAbs);
      // After the rename and not rolled back: if this throws, the entry is at `to`.
      dependencies.audit.emit({
        kind: "file.move",
        actorId: principal.id,
        workspaceId,
        title:
          dirname(fromAbs) === dirname(toAbs)
            ? `重命名 ${from} → ${basename(toAbs)}`
            : `移动 ${from} → ${to}`,
        detail: { from, to, type },
      });
      return { path: to };
    },
  );
}
