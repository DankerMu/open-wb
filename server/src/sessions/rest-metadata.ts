/**
 * Session metadata routes (parent D2). `POST /api/sessions` (#523, #1005): an optional exact
 * `{workspaceId?, scene?, approvalMode?, modelId?, reasoningEffort?}` body; a named workspace must
 * be the caller's through the injected owner-scoped `workspaceRootOf`; unknown, foreign and
 * malformed ids share one 404, and so does the caller's own temporary workspace (#925, thrown by
 * `createSession`). The three composer keys only have to be strings here: this route has no
 * configuration, their values are checked by `createSession` (400 `bad_request`, nothing written).
 * `PATCH /api/sessions/:id` (#524, #922, #1006): a non-empty exact `{title?, scene?, pinned?,
 * archived?, approvalMode?, modelId?, reasoningEffort?}` body, owner checked before parsing; a title
 * write marks the session's in-flight admission so its rollback keeps the new title; `archived:
 * true` is refused whole with 409 `session_busy` while the session runs or its control claim is
 * held. The three composer keys are strings here and judged by `patchSession` like a creation's
 * (400, nothing written); they never reach the supervisor: a running turn is not touched. `DELETE /api/sessions/:id` (#525): owner checked
 * before parsing, no body read (not a parser owner), the deletion itself is `session-delete.ts`;
 * 204 with no body. Each of the three tells the list notifier once after its commit, before the
 * reply (#932); a refused or rolled-back write throws before that line.
 * s1d-experts-skills (D7): the create body also takes `expertId` (an expert visible to the caller,
 * checked through the injected `experts` reader) and `disabledSkills` (at most 128 raw items of
 * valid skill names); both are judged before the workspace's 404. POST's body limit is 64 KiB
 * (128 names), PATCH keeps 16 KiB. The owner pre-check, the capability-body parsers and the expert
 * check are exported for `rest-capabilities.ts`.
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
import type { createExpertStore } from "../experts/store.js";
import { MAX_DISABLED_SKILLS, normalizeSkillNames } from "../skills/store.js";
import type { SessionListNotifier } from "./list-events.js";
import type { SessionSupervisorPort } from "./rest.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import type { SessionDeleter } from "./session-delete.js";
import type { SessionStore } from "./store.js";
import type { SessionExpert } from "./store-capabilities.js";
import type {
  SessionCreateInput,
  SessionMetadataStore,
  SessionPatch,
  SessionScene,
} from "./store-metadata.js";

/** The experts store's plain read: built-in experts and the caller's own, else undefined. */
export type ExpertReader = Pick<ReturnType<typeof createExpertStore>, "get">;

type OwnedParams = { Params: SessionIdParams };

interface SessionMetadataRouteDependencies {
  metadata: SessionMetadataStore;
  experts: ExpertReader;
  workspaceRootOf: WorkspaceRootOf;
  store: Pick<SessionStore, "getMessages" | "noteTitleWrite">;
  deleter: Pick<SessionDeleter, "deleteSession">;
  supervisor: Pick<SessionSupervisorPort, "controlHeld">;
  listEvents: Pick<SessionListNotifier, "notify">;
}

interface SessionIdParams {
  id: string;
}

/** 128 skill names of up to 128 bytes, JSON-escaped, need ~33 KB (as `PUT /api/skills/defaults`). */
const SESSION_CREATE_BODY_LIMIT = 64 * 1024;
const SESSION_PATCH_BODY_LIMIT = 16 * 1024;
const COMPOSER_KEYS = ["approvalMode", "modelId", "reasoningEffort"] as const;
const CREATE_KEYS: ReadonlySet<string> = new Set([
  "workspaceId",
  "scene",
  ...COMPOSER_KEYS,
  "expertId",
  "disabledSkills",
]);
const PATCH_KEYS: ReadonlySet<string> = new Set([
  "title",
  "scene",
  "pinned",
  "archived",
  ...COMPOSER_KEYS,
]);
const SCENES: ReadonlySet<string> = new Set<SessionScene>(["office", "code", "design"]);
const TITLE_MAX_CODE_POINTS = 80;

/** Same header as `rest.ts` `noStoreSessionHeaders`, declared before the guard and the parser. */
export const noStoreMetadataResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

/**
 * Same semantics as `rest.ts` requireOwnedSession: unknown and foreign ids share one 404, before
 * the body is parsed; nothing is cached and no stream cursor is taken.
 */
export function authorizeOwnedBeforeParse(
  store: Pick<SessionStore, "getMessages">,
): preParsingHookHandler<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  OwnedParams
> {
  return (request, _reply, payload, done) => {
    const principal = createPrincipal(request);
    if (store.getMessages(request.params.id, principal.id) === null) {
      throw new HttpError("not_found");
    }
    done(null, payload);
  };
}

export function registerSessionMetadataRoutes(
  app: FastifyInstance,
  dependencies: SessionMetadataRouteDependencies,
): void {
  const ownedBeforeParse = authorizeOwnedBeforeParse(dependencies.store);

  app.post(
    "/api/sessions",
    { bodyLimit: SESSION_CREATE_BODY_LIMIT, onRequest: noStoreMetadataResponse },
    async (request, reply) => {
      const principal = createPrincipal(request);
      const { expertId, ...body } = request.body === undefined ? {} : parseCreateBody(request.body);
      // Judged before the workspace's 404: an invisible expert is a 400 whatever the workspace.
      const input: SessionCreateInput =
        expertId === undefined
          ? body
          : { ...body, expert: requireVisibleExpert(dependencies.experts, principal.id, expertId) };
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
  app.patch<OwnedParams>(
    "/api/sessions/:id",
    {
      bodyLimit: SESSION_PATCH_BODY_LIMIT,
      onRequest: noStoreMetadataResponse,
      preParsing: ownedBeforeParse,
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
  app.delete<OwnedParams>(
    "/api/sessions/:id",
    { onRequest: noStoreMetadataResponse, preParsing: ownedBeforeParse },
    async (request, reply) => {
      const principal = createPrincipal(request);
      // It rejects only before its commit: resolved means the row is gone.
      await dependencies.deleter.deleteSession(request.params.id, principal.id);
      dependencies.listEvents.notify(principal.id);
      return reply.code(204).send();
    },
  );
}

export function createPrincipal(request: FastifyRequest): { id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

/**
 * A plain JSON object whose keys ⊆ the seven create keys; strings (text/plain) are never parsed.
 * `workspaceId`, `expertId` and the three composer keys are any string: their values are judged
 * later; `disabledSkills` is judged here in full.
 */
function parseCreateBody(body: unknown): SessionCreateInput & { expertId?: string } {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) {
    throw new HttpError("bad_request");
  }
  const input: SessionCreateInput & { expertId?: string } = {};
  if (Object.hasOwn(body, "workspaceId")) {
    input.workspaceId = requireString(body.workspaceId);
  }
  if (Object.hasOwn(body, "scene")) {
    input.scene = requireScene(body.scene);
  }
  if (Object.hasOwn(body, "expertId")) {
    input.expertId = requireString(body.expertId);
  }
  if (Object.hasOwn(body, "disabledSkills")) {
    input.disabledSkills = requireDisabledSkills(body.disabledSkills);
  }
  readComposerKeys(body, input);
  return input;
}

/** An array of at most 128 raw items, each a skill name; returned deduplicated and sorted. */
export function requireDisabledSkills(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_DISABLED_SKILLS) {
    throw new HttpError("bad_request");
  }
  return normalizeSkillNames(value);
}

/** The expert `id` names when the owner can see it (built-in or own); otherwise `bad_request`. */
export function requireVisibleExpert(
  experts: ExpertReader,
  ownerId: string,
  id: string,
): SessionExpert {
  const expert = experts.get(ownerId, id);
  if (expert === undefined) {
    throw new HttpError("bad_request");
  }
  return { id: expert.id, skills: expert.skills };
}

/** Copies the composer keys the body has into `into`; each must be a string (`null` is not). */
function readComposerKeys(
  body: Record<string, unknown>,
  into: SessionCreateInput | SessionPatch,
): void {
  for (const key of COMPOSER_KEYS) {
    if (Object.hasOwn(body, key)) {
      into[key] = requireString(body[key]);
    }
  }
}

/**
 * A non-empty plain JSON object whose keys ⊆ the seven PATCH keys; strings (text/plain) are never
 * parsed. Every field's shape is validated before anything is written; the three composer keys
 * are any string here, their values are judged by `patchSession` before it writes.
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
  readComposerKeys(body, patch);
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireString(value: unknown): string {
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
