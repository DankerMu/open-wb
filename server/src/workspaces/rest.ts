import { lstatSync } from "node:fs";
import { dirname, extname } from "node:path";
import type {
  FastifyInstance,
  FastifyRequest,
  onErrorHookHandler,
  onRequestHookHandler,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { createSandbox } from "../core/sandbox/index.js";
import { classifyPreview, openPreviewStream } from "./preview.js";
import type { WorkspaceStore } from "./store.js";
import { listOneLevel } from "./tree.js";

export interface WorkspaceRestDependencies {
  store: WorkspaceStore;
  sandbox: ReturnType<typeof createSandbox>;
  audit: Parameters<typeof createSandbox>[0]["audit"];
}

const WORKSPACE_BODY_LIMIT = 16 * 1024;

const noStoreWorkspaceResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

const clearPreviewHeadersOnError: onErrorHookHandler = (_request, reply, _error, done) => {
  reply.removeHeader("Content-Type");
  reply.removeHeader("X-Workbuddy-Size");
  reply.removeHeader("X-Workbuddy-Truncated");
  done();
};

function currentPrincipal(request: FastifyRequest): { id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

function ensureOwnedRoot(
  dependencies: WorkspaceRestDependencies,
  principal: { id: string },
  workspaceId: string,
): void {
  const root = dependencies.store.rootOf(principal, workspaceId);
  if (root === null || !isOrdinaryDirectory(root)) {
    throw new HttpError("not_found");
  }
}

function parsePathQuery(query: unknown, required: boolean): string {
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

function isOrdinaryDirectory(path: string): boolean {
  return lstatExisting(path)?.isDirectory() === true;
}

function lstatExisting(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (isStructuralAbsence(error)) {
      return undefined;
    }
    throw error;
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
  app.get("/api/workspaces", { onRequest: noStoreWorkspaceResponse }, async (request) => {
    const principal = currentPrincipal(request);
    return { workspaces: dependencies.store.list(principal.id) };
  });
  app.post(
    "/api/workspaces",
    { bodyLimit: WORKSPACE_BODY_LIMIT, onRequest: noStoreWorkspaceResponse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      return reply
        .code(201)
        .send(dependencies.store.create(principal, parseCreateBody(request.body)));
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
      const preview = classifyPreview(absPath, extname(absPath).slice(1), status.size);
      for (const [name, value] of Object.entries(preview.headers)) {
        reply.header(name, value);
      }
      return reply.send(openPreviewStream(absPath, preview.limit));
    },
  );
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
