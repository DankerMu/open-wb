/**
 * Session metadata routes (parent D2). `POST /api/sessions` (#523): an optional exact
 * `{workspaceId?, scene?}` body; a named workspace must be the caller's through the injected
 * owner-scoped `workspaceRootOf`; unknown, foreign and malformed ids share one 404, and so does the
 * caller's own temporary workspace (#925, thrown by `createSession`).
 * `PATCH /api/sessions/:id` (#524, #922): a non-empty exact `{title?, scene?, pinned?, archived?}`
 * body, owner checked before parsing; a title write marks the session's in-flight admission so its
 * rollback keeps the new title; `archived: true` is refused whole with 409 `session_busy` while the
 * session runs or its control claim is held. `DELETE /api/sessions/:id` (#525): owner checked
 * before parsing, no body read (not a parser owner), the deletion itself is `session-delete.ts`;
 * 204 with no body. Each of the three tells the list notifier once after its commit, before the
 * reply (#932); a refused or rolled-back write throws before that line.
 * Imports only the supervisor port type from `rest.ts` (it imports this).
 */
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { SessionListNotifier } from "./list-events.js";
import type { SessionSupervisorPort } from "./rest.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import type { SessionDeleter } from "./session-delete.js";
import type { SessionStore } from "./store.js";
import type {
  SessionCreateInput,
  SessionMetadataStore,
  SessionPatch,
  SessionScene,
} from "./store-metadata.js";

interface SessionMetadataRouteDependencies {
  metadata: SessionMetadataStore;
  workspaceRootOf: WorkspaceRootOf;
  store: Pick<SessionStore, "getMessages" | "noteTitleWrite">;
  deleter: Pick<SessionDeleter, "deleteSession">;
  supervisor: Pick<SessionSupervisorPort, "controlHeld">;
  listEvents: Pick<SessionListNotifier, "notify">;
}

interface SessionIdParams {
  id: string;
}

const SESSION_METADATA_BODY_LIMIT = 16 * 1024;
const CREATE_KEYS: ReadonlySet<string> = new Set(["workspaceId", "scene"]);
const PATCH_KEYS: ReadonlySet<string> = new Set(["title", "scene", "pinned", "archived"]);
const SCENES: ReadonlySet<string> = new Set<SessionScene>(["office", "code", "design"]);
const TITLE_MAX_CODE_POINTS = 80;

/** Same header as `rest.ts` `noStoreSessionHeaders`, declared before the guard and the parser. */
const noStoreMetadataResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export function registerSessionMetadataRoutes(
  app: FastifyInstance,
  dependencies: SessionMetadataRouteDependencies,
): void {
  // Same semantics as `rest.ts` requireOwnedSession: unknown and foreign ids share one 404, before
  // the body is parsed; nothing is cached and no stream cursor is taken.
  const authorizeOwnedBeforeParse: preParsingHookHandler<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    { Params: SessionIdParams }
  > = (request, _reply, payload, done) => {
    const principal = createPrincipal(request);
    if (dependencies.store.getMessages(request.params.id, principal.id) === null) {
      throw new HttpError("not_found");
    }
    done(null, payload);
  };

  app.post(
    "/api/sessions",
    { bodyLimit: SESSION_METADATA_BODY_LIMIT, onRequest: noStoreMetadataResponse },
    async (request, reply) => {
      const principal = createPrincipal(request);
      const input = request.body === undefined ? {} : parseCreateBody(request.body);
      // rootOf throwing (root exists but is not a plain directory) propagates as a generic 5xx.
      if (
        input.workspaceId !== undefined &&
        dependencies.workspaceRootOf(principal.id, input.workspaceId) === null
      ) {
        throw new HttpError("not_found");
      }
      const created = dependencies.metadata.createSession(principal.id, input);
      dependencies.listEvents.notify(principal.id);
      return reply.code(201).send(created);
    },
  );
  app.patch<{ Params: SessionIdParams }>(
    "/api/sessions/:id",
    {
      bodyLimit: SESSION_METADATA_BODY_LIMIT,
      onRequest: noStoreMetadataResponse,
      preParsing: authorizeOwnedBeforeParse,
    },
    async (request, reply) => {
      const principal = createPrincipal(request);
      const patch = parsePatchBody(request.body);
      // Claim check and the conditional UPDATE share one synchronous segment: no await in between.
      if (patch.archived === true && dependencies.supervisor.controlHeld(request.params.id)) {
        throw new HttpError("session_busy");
      }
      const view = dependencies.metadata.patchSession(principal.id, request.params.id, patch);
      if (view === null) {
        // The row vanished between the owner check and the UPDATE (a concurrent delete).
        throw new HttpError("not_found");
      }
      if (view === "busy") {
        // Running: nothing was written, so the title is not noted either.
        throw new HttpError("session_busy");
      }
      // Same synchronous segment as the UPDATE: no rollback can interleave before the mark.
      if (patch.title !== undefined) {
        dependencies.store.noteTitleWrite(request.params.id);
      }
      dependencies.listEvents.notify(principal.id);
      return reply.code(200).send(view);
    },
  );
  // No bodyLimit and no body read: a well-formed body is ignored; a parser failure stays the
  // generic non-owner 500 before this handler runs.
  app.delete<{ Params: SessionIdParams }>(
    "/api/sessions/:id",
    { onRequest: noStoreMetadataResponse, preParsing: authorizeOwnedBeforeParse },
    async (request, reply) => {
      const principal = createPrincipal(request);
      // It rejects only before its commit: resolved means the row is gone.
      await dependencies.deleter.deleteSession(request.params.id, principal.id);
      dependencies.listEvents.notify(principal.id);
      return reply.code(204).send();
    },
  );
}

function createPrincipal(request: FastifyRequest): { id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/** A plain JSON object whose keys ⊆ {workspaceId, scene}; strings (text/plain) are never parsed. */
function parseCreateBody(body: unknown): SessionCreateInput {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) {
    throw new HttpError("bad_request");
  }
  const input: SessionCreateInput = {};
  if (Object.hasOwn(body, "workspaceId")) {
    input.workspaceId = requireWorkspaceId(body.workspaceId);
  }
  if (Object.hasOwn(body, "scene")) {
    input.scene = requireScene(body.scene);
  }
  return input;
}

/**
 * A non-empty plain JSON object whose keys ⊆ {title, scene, pinned, archived}; strings
 * (text/plain) are never parsed. Every field is validated before anything is written.
 */
function parsePatchBody(body: unknown): SessionPatch {
  if (!isPlainObject(body)) {
    throw new HttpError("bad_request");
  }
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !PATCH_KEYS.has(key))) {
    throw new HttpError("bad_request");
  }
  const patch: SessionPatch = {};
  if (Object.hasOwn(body, "title")) {
    patch.title = requireTitle(body.title);
  }
  if (Object.hasOwn(body, "scene")) {
    patch.scene = requireScene(body.scene);
  }
  if (Object.hasOwn(body, "pinned")) {
    patch.pinned = requireBoolean(body.pinned);
  }
  if (Object.hasOwn(body, "archived")) {
    patch.archived = requireBoolean(body.archived);
  }
  return patch;
}

/** Trimmed once; 1..80 Unicode code points (not UTF-16 units). */
function requireTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError("bad_request");
  }
  const trimmed = value.trim();
  const codePoints = [...trimmed].length;
  if (codePoints < 1 || codePoints > TITLE_MAX_CODE_POINTS) {
    throw new HttpError("bad_request");
  }
  return trimmed;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError("bad_request");
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireWorkspaceId(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError("bad_request");
  }
  return value;
}

function requireScene(value: unknown): SessionScene {
  if (typeof value !== "string" || !SCENES.has(value)) {
    throw new HttpError("bad_request");
  }
  return value as SessionScene;
}
