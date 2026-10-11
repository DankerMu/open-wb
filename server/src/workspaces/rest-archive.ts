/**
 * workspaces/rest-archive — GET /api/workspaces/:id/archive: the member list of a zip / tar /
 * tar.gz, or the single item of a bare .gz (workspaces「压缩包列表」; the parsing is `archive.ts`).
 *
 * The same order as every scoped workspace route: principal, owned root (404 for another owner's
 * and for an unknown id alike), the query, the sandbox (`read`). Then: what is absent or not a
 * regular file is 404 — before the name is looked at, so a missing `gone.md` is 404, not 415 —
 * a name that is no archive name is 415, and only then is the file opened. A listing is not
 * audited. A member name goes from the archive into the JSON answer and nowhere else: this file
 * hands `listArchive` a positional read over one descriptor and passes no name to any fs call.
 *
 * What is not here, on purpose: no time limit for a zip (the specification gives one to tar and
 * tar.gz only; a zip is bounded by the entry limit alone, so a very large configured limit is in
 * effect no limit — derived from `archive.ts`, not measured through this route), no limit on
 * concurrent listings, and no cancellation when the client goes away: a walk runs to the entry
 * limit, the deadline or the end of the archive (derived from the code, not tested).
 *
 * Known residual (design D22 / D-23, #1286 stays open; nothing here closes it): this is one more
 * route that resolves, lstats and then opens by path.
 * - The last component replaced after the lstat — by a symlink, a named pipe, a directory, or by
 *   nothing — answers 404 with nothing read and the descriptor closed. Reproduced through this
 *   handler only with the window held open by a hook around `openSync` that does the swap itself
 *   (`workspaces-archive-route.test.ts`); no natural race was run.
 * - A directory on the way to it replaced by a symlink after the sandbox looked at it is followed
 *   by the open: the member names and sizes (no member content) of a same-named regular file
 *   outside the workspace would be listed. Derived from the code; not tested and not prevented.
 * - After the open everything goes through the descriptor: a file cut short meanwhile reads
 *   short, which the listing treats as damage (derived from the code, not tested).
 */
import { closeSync, fstatSync, read } from "node:fs";
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../core/errors/index.js";
import { archiveFormat, listArchive } from "./archive.js";
import { DEFAULT_PREVIEW_LIMITS } from "./preview.js";
import {
  currentPrincipal,
  ensureOwnedRoot,
  lstatExisting,
  noStoreWorkspaceResponse,
  openRegularFile,
  parsePathQuery,
  type WorkspaceRestDependencies,
} from "./rest.js";

/** One positional read into `buffer` from `filled` on; resolves to the number of bytes it got. */
function readSome(fd: number, buffer: Buffer, filled: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buffer, filled, buffer.length - filled, position + filled, (error, bytesRead) => {
      if (error === null) {
        resolve(bytesRead);
      } else {
        reject(error);
      }
    });
  });
}

/**
 * `length` bytes at `position`, fewer only where the file ends: one read may come back short
 * anywhere, so it is repeated until the buffer is full or a read gets nothing.
 */
async function readAt(fd: number, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const bytesRead = await readSome(fd, buffer, filled, position);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export function registerWorkspaceArchive(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
): void {
  const maxEntries = (dependencies.limits ?? DEFAULT_PREVIEW_LIMITS).archiveEntries;
  // The configuration only yields positive integers; a dependency object built by hand is not
  // checked anywhere else, and with 0 a tar would list nothing while a zip listed one entry.
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("archive entry limit must be a positive safe integer");
  }

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/archive",
    { onRequest: noStoreWorkspaceResponse },
    async (request) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      ensureOwnedRoot(dependencies, principal, workspaceId);
      const path = parsePathQuery(request.query, true);
      const absPath = dependencies.sandbox.resolve(principal, workspaceId, path, "read");
      // Before the name is judged, and so that a directory or a pipe is never opened.
      if (lstatExisting(absPath)?.isFile() !== true) {
        throw new HttpError("not_found");
      }
      // The resolved entry's name, not the last segment of the request: the resolver skips `.`.
      const name = basename(absPath);
      const format = archiveFormat(name);
      if (format === null) {
        throw new HttpError("preview_unsupported");
      }
      const fd = openRegularFile(absPath);
      try {
        // The size of what was opened, not of what the lstat saw; a bare gz reads nothing.
        return await listArchive(format, name, (position, length) => readAt(fd, position, length), {
          maxEntries,
          now: () => performance.now(),
          size: fstatSync(fd).size,
        });
      } finally {
        closeSync(fd);
      }
    },
  );
}
