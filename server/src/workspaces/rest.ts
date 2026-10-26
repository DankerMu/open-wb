import { closeSync, lstatSync, readSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import type {
  FastifyInstance,
  FastifyRequest,
  onErrorHookHandler,
  onRequestHookHandler,
  preParsingHookHandler,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import { hasRefusedCharacter } from "../core/refused-characters.js";
import type { createSandbox } from "../core/sandbox/index.js";
import { firstSegment } from "../core/sandbox/resolve.js";
import { refuseInMount } from "./mounts/path-rule.js";
import {
  classifyPreview,
  DEFAULT_PREVIEW_LIMITS,
  needsTextSniff,
  openPreviewStream,
  type PreviewLimits,
  sniffText,
} from "./preview.js";
import { sendFileRange } from "./range-send.js";
import { isStructuralAbsence, openRegularFile, type RegularFile } from "./regular-file.js";
import { WorkspaceRootOccupiedError, type WorkspaceStore } from "./store.js";
import type { createTrash } from "./trash.js";
import { listOneLevel } from "./tree.js";
import { storeUpload } from "./upload.js";

export interface WorkspaceRestDependencies {
  store: WorkspaceStore;
  sandbox: ReturnType<typeof createSandbox>;
  audit: Parameters<typeof createSandbox>[0]["audit"];
  /** Session list notifier, injected by the assembly: called after a committed create or promote. */
  listEvents: { notify(ownerId: string): void };
  /** Byte limit of one uploaded file (UPLOAD_MAX_BYTES): a positive safe integer. */
  uploadMaxBytes: number;
  /** Preview limits (text, image, notebook, archive entries); omitted means the specification defaults. */
  limits?: PreviewLimits;
  /** The recycle directory service of the assembly: where a deleted entry is moved. */
  trash: ReturnType<typeof createTrash>;
}

type OwnedPreParsing = preParsingHookHandler<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  { Params: { id: string } }
>;

export const WORKSPACE_BODY_LIMIT = 16 * 1024;
const UPLOADS_DIR = "uploads";
const UPLOAD_MEDIA_TYPE = "application/octet-stream";
const UPLOAD_NAME_MAX_BYTES = 255;
/** Reserved for the temporary files `storeUpload` writes into the same directory. */
const UPLOAD_TEMP_PREFIX = ".upload-";
/** How much of an unknown or extensionless file is read to decide whether it is text. */
const SNIFF_BYTES = 8192;

export const noStoreWorkspaceResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

const clearPreviewHeadersOnError: onErrorHookHandler = (_request, reply, _error, done) => {
  reply.removeHeader("Content-Type");
  reply.removeHeader("X-Workbuddy-Size");
  reply.removeHeader("X-Workbuddy-Truncated");
  reply.removeHeader("Content-Range");
  reply.removeHeader("Accept-Ranges");
  done();
};

/**
 * Every failed upload closes its connection. After an early answer Node would otherwise keep
 * reading the rest of the request body on a kept-alive connection and discard it; closing is
 * also what ends a body nothing has started reading.
 */
const closeUploadConnectionOnError: onErrorHookHandler = (_request, reply, _error, done) => {
  reply.header("Connection", "close");
  done();
};

export function currentPrincipal(request: FastifyRequest): { id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/**
 * The store's owner-scoped `rootOf` for the workspace routes and the preview listener, the only
 * places an occupied root is a 404 (#1244): that one class becomes `not_found` before any path
 * check on every route, and before the body only where the lookup runs in preParsing (`promote`,
 * `move`, `preview-token`, upload) — `dirs` parses its JSON body first. Null and the path come back
 * as the store gave them; any other failure (unsafe owner segment, symbolic link) propagates.
 */
export function ownedRootOf(
  store: Pick<WorkspaceStore, "rootOf">,
  principal: { id: string },
  workspaceId: string,
): string | null {
  try {
    return store.rootOf(principal, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceRootOccupiedError) {
      throw new HttpError("not_found");
    }
    throw error;
  }
}

export function ensureOwnedRoot(
  dependencies: WorkspaceRestDependencies,
  principal: { id: string },
  workspaceId: string,
): void {
  const root = ownedRootOf(dependencies.store, principal, workspaceId);
  if (root === null || !isOrdinaryDirectory(root)) {
    throw new HttpError("not_found");
  }
}

export function parsePathQuery(query: unknown, required: boolean): string {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new HttpError("bad_request");
  }
  const record = query as Record<string, unknown>;
  if (!Object.hasOwn(record, "path")) {
    if (required) {
      throw new HttpError("bad_request");
    }
    return "";
  }
  if (typeof record.path !== "string") {
    throw new HttpError("bad_request");
  }
  return record.path;
}

/** `name` must be in the query exactly once and not empty: twice parses to an array. */
function parseUploadName(query: unknown): string {
  const name =
    typeof query === "object" && query !== null ? (query as Record<string, unknown>).name : null;
  if (typeof name !== "string" || name === "") {
    throw new HttpError("bad_request");
  }
  return name;
}

/**
 * The name rules that come after the sandbox. A `/` the sandbox let through (`sub/a.txt`,
 * `./a.txt`) would put the file somewhere other than directly under `uploads`. The refused code
 * points are those of a prompt's attachment paths (#1257), and only a name uploaded here is held
 * to them: no route that reads, lists, moves or deletes a path calls this.
 */
function assertUploadName(name: string): void {
  if (name.includes("/") || hasRefusedCharacter(name) || name.startsWith(UPLOAD_TEMP_PREFIX)) {
    throw new HttpError("bad_request");
  }
}

/** Makes `dir` when nothing is there (no `dir.create` audit); anything but a directory is 409. */
function ensureUploadsDir(dependencies: WorkspaceRestDependencies, dir: string): void {
  const existing = lstatExisting(dir);
  if (existing === undefined) {
    dependencies.sandbox.ensureSharedDir(dir);
  } else if (!existing.isDirectory()) {
    throw new HttpError("conflict");
  }
}

export function isOrdinaryDirectory(path: string): boolean {
  return lstatExisting(path)?.isDirectory() === true;
}

export function lstatExisting(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (isStructuralAbsence(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether the first SNIFF_BYTES of the file the route has opened read as text: one read through
 * the descriptor the response will stream from, so the file is not opened a second time.
 */
function sniffedAsText(fd: number): boolean {
  const buffer = Buffer.alloc(SNIFF_BYTES);
  const bytesRead = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
  return sniffText(buffer.subarray(0, bytesRead));
}

/** What `classify` gives, or its error once the descriptor is closed: a refused file sends nothing. */
function classifiedOrClosed<T>(file: RegularFile, classify: () => T): T {
  try {
    return classify();
  } catch (error) {
    closeSync(file.fd);
    throw error;
  }
}

export function registerWorkspaceRest(
  app: FastifyInstance,
  dependencies: WorkspaceRestDependencies,
): void {
  const maxBytes = dependencies.uploadMaxBytes;
  const limits = dependencies.limits ?? DEFAULT_PREVIEW_LIMITS;
  // Here and not inside the plugin below: there it would only throw at `ready`.
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("upload max bytes must be a positive safe integer");
  }

  /**
   * Runs before the body is parsed: another owner's id answers 404 whatever the body is, and so
   * does an own workspace whose root path is occupied (`ownedRootOf`). A root that is only missing
   * passes — it does not block `promote` — so this is not `ensureOwnedRoot`.
   */
  const requireOwnedBeforeParse: OwnedPreParsing = (request, _reply, payload, done) => {
    if (ownedRootOf(dependencies.store, currentPrincipal(request), request.params.id) === null) {
      throw new HttpError("not_found");
    }
    done(null, payload);
  };
  /** The whole of upload step 1, before the media type is looked at and before any body byte. */
  const requireOwnedRootBeforeParse: OwnedPreParsing = (request, _reply, payload, done) => {
    ensureOwnedRoot(dependencies, currentPrincipal(request), request.params.id);
    done(null, payload);
  };
  /** Audits an upload refused for its size and returns the error to throw. */
  const rejectOversized = (principal: { id: string }, workspaceId: string, name: string) => {
    dependencies.audit.emit({
      kind: "upload.reject",
      actorId: principal.id,
      workspaceId,
      title: "上传被拒绝：文件超过大小上限",
      detail: { name, limit: maxBytes },
    });
    return new HttpError("upload_too_large");
  };

  app.get("/api/workspaces", { onRequest: noStoreWorkspaceResponse }, async (request) => {
    const principal = currentPrincipal(request);
    return { workspaces: dependencies.store.list(principal.id) };
  });
  app.post(
    "/api/workspaces",
    { bodyLimit: WORKSPACE_BODY_LIMIT, onRequest: noStoreWorkspaceResponse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const created = dependencies.store.create(principal, parseCreateBody(request.body));
      dependencies.listEvents.notify(principal.id);
      return reply.code(201).send(created);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/promote",
    {
      bodyLimit: WORKSPACE_BODY_LIMIT,
      onRequest: noStoreWorkspaceResponse,
      preParsing: requireOwnedBeforeParse,
    },
    async (request) => {
      const principal = currentPrincipal(request);
      const { name } = parsePromoteBody(request.body);
      // `promote` owns its transaction; null = the owner's workspace is not (or no longer) temporary.
      const promoted = dependencies.store.promote(principal, request.params.id, name);
      if (promoted === null) {
        throw new HttpError("bad_request");
      }
      dependencies.listEvents.notify(principal.id);
      return promoted;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/tree",
    { onRequest: noStoreWorkspaceResponse },
    async (request) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      ensureOwnedRoot(dependencies, principal, workspaceId);
      const path = parsePathQuery(request.query, false);
      const absPath = dependencies.sandbox.resolve(principal, workspaceId, path, "list");
      const mountNames = dependencies.sandbox.mountNamesOf(workspaceId);
      // Below the root, a path in a registered mount is refused before anything is looked at (D16).
      refuseInMount(mountNames, path);
      if (!isOrdinaryDirectory(absPath)) {
        throw new HttpError("not_found");
      }
      // The root level leaves the registered mount points out unlooked-at (D21); their rows come
      // from `GET …/mounts`.
      const skip = firstSegment(path) === undefined ? mountNames : undefined;
      return { path, entries: listOneLevel(absPath, skip) };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/dirs",
    { bodyLimit: WORKSPACE_BODY_LIMIT, onRequest: noStoreWorkspaceResponse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      ensureOwnedRoot(dependencies, principal, workspaceId);
      const { path } = parseDirectoryBody(request.body);
      const absPath = dependencies.sandbox.resolve(principal, workspaceId, path, "mkdir");
      refuseInMount(dependencies.sandbox.mountNamesOf(workspaceId), path);
      if (!isOrdinaryDirectory(dirname(absPath))) {
        throw new HttpError("not_found");
      }
      if (lstatExisting(absPath) !== undefined) {
        throw new HttpError("conflict");
      }
      dependencies.sandbox.ensureSharedDir(absPath);
      dependencies.audit.emit({
        kind: "dir.create",
        actorId: principal.id,
        workspaceId,
        title: `新建目录 ${path}`,
        detail: { path },
      });
      return reply.code(201).send({ path });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/file",
    { onError: clearPreviewHeadersOnError, onRequest: noStoreWorkspaceResponse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const workspaceId = request.params.id;
      ensureOwnedRoot(dependencies, principal, workspaceId);
      const path = parsePathQuery(request.query, true);
      const absPath = dependencies.sandbox.resolve(principal, workspaceId, path, "read");
      refuseInMount(dependencies.sandbox.mountNamesOf(workspaceId), path);
      const status = lstatExisting(absPath);
      if (status === undefined || !status.isFile()) {
        throw new HttpError("not_found");
      }
      const name = basename(absPath);
      // The lstat refused what was never a file without opening it; from here on the descriptor
      // and its fstat decide, whatever happens to the path.
      const file = openRegularFile(absPath);
      const preview = classifiedOrClosed(file, () =>
        // Only a name the table does not decide is sniffed: a known extension is not read here.
        classifyPreview(absPath, name, file.size, {
          limits,
          ...(needsTextSniff(name) ? { sniffedText: sniffedAsText(file.fd) } : {}),
        }),
      );
      if (preview.rangeable) {
        // Audio and video only, and only here: after the sandbox, the open and the classifier.
        return sendFileRange(request, reply, {
          fd: file.fd,
          size: file.size,
          headers: preview.headers,
          unsatisfiableHeaders: { "X-Content-Type-Options": "nosniff" },
        });
      }
      for (const [header, value] of Object.entries(preview.headers)) {
        reply.header(header, value);
      }
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- classifier permits text/plain, raster images, audio and video only (html/svg/xml go out as text/plain); nosniff remains set.
      return reply.send(openPreviewStream(file, preview.limit));
    },
  );
  // A scope of its own: the only content type it knows is the one that hands the request stream
  // over untouched, so nothing buffers the body and no framework body limit applies — the limit
  // is enforced below and by `storeUpload` (413; a framework limit would surface as 400).
  app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(UPLOAD_MEDIA_TYPE, (_request, payload, complete) => {
      complete(null, payload);
    });
    scope.post<{ Params: { id: string } }>(
      "/api/workspaces/:id/uploads",
      {
        onError: closeUploadConnectionOnError,
        onRequest: noStoreWorkspaceResponse,
        preParsing: requireOwnedRootBeforeParse,
      },
      async (request, reply) => {
        const principal = currentPrincipal(request);
        const workspaceId = request.params.id;
        // Without a media type and without a body no parser runs and there is no stream.
        const source = request.body;
        if (!(source instanceof Readable)) {
          throw new HttpError("bad_request");
        }
        const name = parseUploadName(request.query);
        if (Number(request.headers["content-length"]) > maxBytes) {
          throw rejectOversized(principal, workspaceId, name);
        }
        // Before the sandbox, the one name rule that is: with `uploads` present the sandbox's
        // lstat of an over-long name fails (ENAMETOOLONG) and it would deny what is only too long.
        if (!name.includes("/") && Buffer.byteLength(name) > UPLOAD_NAME_MAX_BYTES) {
          throw new HttpError("bad_request");
        }
        // The sandbox before the other name rules: an escaping name leaves its audit event.
        const absPath = dependencies.sandbox.resolve(
          principal,
          workspaceId,
          `${UPLOADS_DIR}/${name}`,
          "write",
        );
        assertUploadName(name);
        const dir = dirname(absPath);
        ensureUploadsDir(dependencies, dir);
        // `source` is the request itself: destroying a wrapper around it on the way out of an
        // over-limit upload takes the socket with it, and the 413 would never be sent.
        const stored = await storeUpload({ dir, name, source, maxBytes }).catch((error) => {
          if (error instanceof HttpError && error.code === "upload_too_large") {
            throw rejectOversized(principal, workspaceId, name);
          }
          throw error;
        });
        const path = `${UPLOADS_DIR}/${stored.name}`;
        dependencies.audit.emit({
          kind: "file.upload",
          actorId: principal.id,
          workspaceId,
          title: `上传文件 ${path}`,
          detail: { path, size: stored.size },
        });
        return reply.code(201).send({ path, name: stored.name, size: stored.size });
      },
    );
    done();
  });
}

export function parseBodyRecord(body: unknown): Record<string, unknown> {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new HttpError("bad_request");
  }
  return body as Record<string, unknown>;
}

function parseCreateBody(body: unknown): { name: string; dir?: string } {
  const record = parseBodyRecord(body);
  const hasDir = Object.hasOwn(record, "dir");
  const keys = Object.keys(record);
  if (
    keys.length !== (hasDir ? 2 : 1) ||
    !Object.hasOwn(record, "name") ||
    keys.some((key) => key !== "name" && key !== "dir") ||
    typeof record.name !== "string"
  ) {
    throw new HttpError("bad_request");
  }
  if (!hasDir) {
    return { name: record.name };
  }
  if (typeof record.dir !== "string") {
    throw new HttpError("bad_request");
  }
  return { name: record.name, dir: record.dir };
}

function parseDirectoryBody(body: unknown): { path: string } {
  const record = parseBodyRecord(body);
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "path") ||
    typeof record.path !== "string"
  ) {
    throw new HttpError("bad_request");
  }
  return { path: record.path };
}

function parsePromoteBody(body: unknown): { name: string } {
  const record = parseBodyRecord(body);
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "name") ||
    typeof record.name !== "string"
  ) {
    throw new HttpError("bad_request");
  }
  return { name: record.name };
}
