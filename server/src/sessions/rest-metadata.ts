/**
 * `POST /api/sessions` (#523, parent D2): an optional exact `{workspaceId?, scene?}` body. A named
 * workspace must be the caller's through the injected owner-scoped `workspaceRootOf`; unknown,
 * foreign and malformed ids share one 404. Imports nothing from `rest.ts` (it imports this).
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import type { SessionCreateInput, SessionMetadataStore, SessionScene } from "./store-metadata.js";

interface SessionCreateRouteDependencies {
  metadata: SessionMetadataStore;
  workspaceRootOf: WorkspaceRootOf;
}

const SESSION_CREATE_BODY_LIMIT = 16 * 1024;
const CREATE_KEYS: ReadonlySet<string> = new Set(["workspaceId", "scene"]);
const SCENES: ReadonlySet<string> = new Set<SessionScene>(["office", "code", "design"]);

/** Same header as `rest.ts` `noStoreSessionHeaders`, declared before the guard and the parser. */
const noStoreCreateResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export function registerSessionCreateRoute(
  app: FastifyInstance,
  dependencies: SessionCreateRouteDependencies,
): void {
  app.post(
    "/api/sessions",
    { bodyLimit: SESSION_CREATE_BODY_LIMIT, onRequest: noStoreCreateResponse },
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
      return reply.code(201).send(dependencies.metadata.createSession(principal.id, input));
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
