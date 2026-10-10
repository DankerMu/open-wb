import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { constants as osConstants } from "node:os";
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
import type { createSandbox } from "../core/sandbox/index.js";
import {
  classifyPreview,
  DEFAULT_PREVIEW_LIMITS,
  needsTextSniff,
  openPreviewStream,
  type PreviewLimits,
  sniffText,
} from "./preview.js";
import { sendFileRange } from "./range-send.js";
import type { WorkspaceStore } from "./store.js";
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
  /** Preview limits (text, image, notebook); omitted means the specification defaults. */
  limits?: PreviewLimits;
}

type OwnedPreParsing = preParsingHookHandler<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  { Params: { id: string } }
>;

const WORKSPACE_BODY_LIMIT = 16 * 1024;
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

export function ensureOwnedRoot(
  dependencies: WorkspaceRestDependencies,
  principal: { id: string },
  workspaceId: string,
): void {
  const root = dependencies.store.rootOf(principal, workspaceId);
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

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * The name rules that come after the sandbox. A `/` the sandbox let through (`sub/a.txt`,
 * `./a.txt`) would put the file somewhere other than directly under `uploads`.
 */
function assertUploadName(name: string): void {
  if (name.includes("/") || hasControlCharacter(name) || name.startsWith(UPLOAD_TEMP_PREFIX)) {
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

function isOrdinaryDirectory(path: string): boolean {
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
 * Reads at most the first SNIFF_BYTES of a file the route has just lstat-ed as regular and says
 * whether they read as text. The path may have been replaced since that lstat, so the open neither
 * follows a final symlink nor waits on a pipe, and what was opened is checked from its descriptor
 * before any read: anything but a regular file is the same `not_found` as in the route. So is an
 * open refused because nothing is there any more (ENOENT, ENOTDIR), because a symlink is (ELOOP),
 * or because a socket is (ENXIO on Linux, EOPNOTSUPP on macOS); any other failure is thrown as is.
 */
function sniffedAsText(absPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const { code, errno } = error instanceof Error ? (error as NodeJS.ErrnoException) : {};
    if (
      isStructuralAbsence(error) ||
      code === "ELOOP" ||
      code === "ENXIO" ||
      // By number: Node has no name for macOS's EOPNOTSUPP and reports "Unknown system error".
      errno === -osConstants.errno.EOPNOTSUPP
    ) {
      throw new HttpError("not_found");
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new HttpError("not_found");
    }
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return sniffText(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

function isStructuralAbsence(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
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

  /** Runs before the body is parsed: another owner's id answers 404 whatever the body is. */
  const requireOwnedBeforeParse: OwnedPreParsing = (request, _reply, payload, done) => {
    if (dependencies.store.rootOf(currentPrincipal(request), request.params.id) === null) {
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
      if (!isOrdinaryDirectory(absPath)) {
        throw new HttpError("not_found");
      }
      return { path, entries: listOneLevel(absPath) };
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
      const status = lstatExisting(absPath);
      if (status === undefined || !status.isFile()) {
        throw new HttpError("not_found");
      }
      const name = basename(absPath);
      // A known extension is never opened here: only a name the table does not decide is sniffed.
      const preview = classifyPreview(absPath, name, status.size, {
        limits,
        ...(needsTextSniff(name) ? { sniffedText: sniffedAsText(absPath) } : {}),
      });
      if (preview.rangeable) {
        // Audio and video only, and only here: after the sandbox, the lstat and the classifier.
        return sendFileRange(request, reply, {
          absPath,
          size: status.size,
          headers: preview.headers,
          unsatisfiableHeaders: { "X-Content-Type-Options": "nosniff" },
        });
      }
      for (const [header, value] of Object.entries(preview.headers)) {
        reply.header(header, value);
      }
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- classifier permits text/plain, raster images, audio and video only (html/svg/xml go out as text/plain); nosniff remains set.
      return reply.send(openPreviewStream(absPath, preview.limit));
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

function parseBodyRecord(body: unknown): Record<string, unknown> {
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
