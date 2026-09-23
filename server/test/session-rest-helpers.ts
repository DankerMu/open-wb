import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { registerAuthGuard } from "../src/http/index.js";
import { registerSessionRoutes, type SessionSupervisorPort } from "../src/sessions/rest.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import { bearerCookie, loginSessionId } from "./auth-lifecycle-helpers.js";
import { PARSER_INPUTS, withStandaloneAuthApp } from "./http-guard-helpers.js";

export const SESSION_NOW = 1_740_000_000_000;
export const MESSAGE_LIMIT = 32_768;
export const EXACT_MULTIBYTE = "😀".repeat(8_192);
export const UNKNOWN_SESSION_ID = "f".repeat(32);
export const SESSION_BUSY_ENVELOPE = {
  error: { code: "session_busy", message: "会话正在生成，请稍候" },
} as const;
export const AGENT_UNAVAILABLE_ENVELOPE = {
  error: { code: "agent_unavailable", message: "Agent 运行时不可用" },
} as const;

const oversizedParserInput = PARSER_INPUTS.find((entry) => entry.name === "oversized body");
if (oversizedParserInput === undefined) {
  throw new Error("PARSER_INPUTS catalog missing oversized body");
}
export const OVERSIZED_PARSER_INPUT = oversizedParserInput;

interface RecordingSupervisor extends SessionSupervisorPort {
  readonly calls: Array<{ sessionId: string; text: string }>;
  readonly cursorCalls: string[];
  cursor: { epoch: number; seq: number | null };
  onPrompt(handler: (sessionId: string, text: string) => Promise<void>): void;
  onStreamCursor(handler: (sessionId: string) => { epoch: number; seq: number | null }): void;
}

export interface SessionRestFixture {
  app: FastifyInstance;
  db: DatabaseSync;
  store: SessionStore;
  supervisor: RecordingSupervisor;
}

export async function withSessionRest<T>(
  action: (fixture: SessionRestFixture) => Promise<T>,
): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SESSION_NOW);
  try {
    return await withStandaloneAuthApp(
      async ({ app, db }) => {
        registerAuthGuard(app);
        const supervisor = createSupervisor();
        const store = createSessionStore(db, {
          onFlushError(failure) {
            throw new Error(`unexpected flush error: ${String(failure.error)}`);
          },
        });
        registerSessionRoutes(app, { store, supervisor });
        try {
          return await action({ app, db, store, supervisor });
        } finally {
          db.setAuthorizer(null);
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
          store.close();
        }
      },
      { now: () => SESSION_NOW },
    );
  } finally {
    vi.useRealTimers();
  }
}

function createSupervisor(): RecordingSupervisor {
  const calls: Array<{ sessionId: string; text: string }> = [];
  const cursorCalls: string[] = [];
  let handler: (sessionId: string, text: string) => Promise<void> = async () => {};
  let cursorHandler: ((sessionId: string) => { epoch: number; seq: number | null }) | undefined;
  const supervisor: RecordingSupervisor = {
    calls,
    cursorCalls,
    cursor: { epoch: 0, seq: null },
    onPrompt(next) {
      handler = next;
    },
    onStreamCursor(next) {
      cursorHandler = next;
    },
    streamCursor(sessionId) {
      cursorCalls.push(sessionId);
      if (cursorHandler !== undefined) {
        return cursorHandler(sessionId);
      }
      return supervisor.cursor;
    },
    async prompt(sessionId, text) {
      calls.push({ sessionId, text });
      await handler(sessionId, text);
    },
  };
  return supervisor;
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export async function cookieFor(app: FastifyInstance, account: string): Promise<string> {
  return bearerCookie(await loginSessionId(app, account));
}

export function getSessionMessages(app: FastifyInstance, sessionId: string, cookie: string) {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/messages`,
    headers: { cookie },
  });
}

export function postPrompt(
  app: FastifyInstance,
  sessionId: string,
  cookie: string,
  payload: string,
  contentType = "application/json",
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/prompt`,
    headers: { "content-type": contentType, cookie },
    payload,
  });
}
