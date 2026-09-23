import { Buffer } from "node:buffer";
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
import type { SessionMessageTree, SessionStore } from "./store.js";
import type { StreamCursor } from "./supervisor.js";

export interface SessionSupervisorPort {
  prompt(sessionId: string, text: string): Promise<void>;
  streamCursor(sessionId: string): StreamCursor;
}

interface SessionRestDependencies {
  store: SessionStore;
  supervisor: SessionSupervisorPort;
}

interface PublicSession {
  id: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface PublicStep {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  status: string;
}

interface PublicMessage {
  id: number;
  role: string;
  content: string;
  status: string;
  createdAt: number;
  steps: PublicStep[];
}

interface OwnedSnapshot {
  tree: SessionMessageTree;
  streamCursor: StreamCursor;
}

interface SessionIdParams {
  id: string;
}

const MESSAGE_LIMIT = 32_768;

const noStoreSessionResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: SessionRestDependencies,
): void {
  const authorizedHistory = new WeakMap<FastifyRequest, OwnedSnapshot>();

  const authorizeOwnedBeforeParse: preParsingHookHandler<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    { Params: SessionIdParams }
  > = (request, _reply, payload, done) => {
    const principal = currentPrincipal(request);
    const tree = dependencies.store.getMessages(request.params.id, principal.id);
    if (tree === null) {
      throw new HttpError("not_found");
    }
    const streamCursor = dependencies.supervisor.streamCursor(request.params.id);
    authorizedHistory.set(request, { tree, streamCursor });
    done(null, payload);
  };

  app.get("/api/sessions", { onRequest: noStoreSessionResponse }, async (request) => {
    const principal = currentPrincipal(request);
    return {
      sessions: dependencies.store.list(principal.id).map(toPublicSession),
    };
  });
  app.post("/api/sessions", { onRequest: noStoreSessionResponse }, async (request, reply) => {
    const principal = currentPrincipal(request);
    return reply.code(201).send(toPublicSession(dependencies.store.create(principal.id)));
  });
  app.get<{ Params: SessionIdParams }>(
    "/api/sessions/:id/messages",
    { onRequest: noStoreSessionResponse, preParsing: authorizeOwnedBeforeParse },
    async (request) => {
      const snapshot = authorizedHistory.get(request);
      if (snapshot === undefined) {
        throw new HttpError("not_found");
      }
      return toPublicHistory(snapshot);
    },
  );
  app.post<{ Params: SessionIdParams }>(
    "/api/sessions/:id/prompt",
    { onRequest: noStoreSessionResponse, preParsing: authorizeOwnedBeforeParse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const text = parsePromptMessage(request.body);
      const accepted = dependencies.store.acceptPrompt(request.params.id, principal.id, text);
      try {
        await dependencies.supervisor.prompt(request.params.id, text);
      } catch (error) {
        dependencies.store.rollbackPrompt(accepted.assistantMessageId);
        throw error;
      }
      return reply.code(202).send({
        userMessageId: accepted.userMessageId,
        assistantMessageId: accepted.assistantMessageId,
      });
    },
  );
}

function currentPrincipal(request: FastifyRequest): { id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

function toPublicSession(session: {
  id: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}): PublicSession {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toPublicHistory(snapshot: OwnedSnapshot): {
  session: PublicSession;
  messages: PublicMessage[];
  streamCursor: StreamCursor;
} {
  return {
    session: toPublicSession(snapshot.tree.session),
    messages: snapshot.tree.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
      steps: message.steps.map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        name: step.name,
        detail: step.detail,
        status: step.status,
      })),
    })),
    streamCursor: snapshot.streamCursor,
  };
}

function parsePromptMessage(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new HttpError("bad_request");
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "message") ||
    typeof record.message !== "string"
  ) {
    throw new HttpError("bad_request");
  }
  const trimmed = record.message.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MESSAGE_LIMIT) {
    throw new HttpError("bad_request");
  }
  return trimmed;
}
