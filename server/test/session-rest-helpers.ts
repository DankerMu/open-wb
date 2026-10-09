import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { registerAuthGuard } from "../src/http/index.js";
import { registerSessionRoutes, type SessionSupervisorPort } from "../src/sessions/rest.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import {
  createSessionMetadataStore,
  type SessionMetadataStore,
} from "../src/sessions/store-metadata.js";
import { createTurnSnapshots } from "../src/sessions/turn-snapshot.js";
import { bearerCookie, loginSessionId } from "./auth-lifecycle-helpers.js";
import { PARSER_INPUTS, withStandaloneAuthApp } from "./http-guard-helpers.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";
import { temporaryWorkspacePort } from "./support/temporary-workspace.js";

export const SESSION_NOW = 1_740_000_000_000;
export const MESSAGE_LIMIT = 32_768;
export const EXACT_MULTIBYTE = "😀".repeat(8_192);
export const UNKNOWN_SESSION_ID = "f".repeat(32);
export const SESSION_BUSY_ENVELOPE = {
  error: { code: "session_busy", message: "会话正在生成，请稍候" },
} as const;
export const SESSION_ARCHIVED_ENVELOPE = {
  error: { code: "session_archived", message: "会话已归档，恢复后才能继续对话" },
} as const;
export const AGENT_UNAVAILABLE_ENVELOPE = {
  error: { code: "agent_unavailable", message: "Agent 运行时不可用" },
} as const;
/**
 * What the view of a user message carries besides its own columns on a session with no workspace
 * and no registration row — every session `store.create` makes here (#946: `undo` is `unbound`).
 */
export const UNBOUND_USER_VIEW = {
  approvals: [],
  undo: "unbound",
  steps: [],
  thinking: null,
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
  /** The very store object the routes hold, so a spy on it observes the route's own calls. */
  metadata: SessionMetadataStore;
  /** Owner ids the routes handed to the list notifier, in call order. */
  listNotified: string[];
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
          emit,
          composer: TEST_COMPOSER,
        });
        // A real directory: a body-less create makes its temporary workspace under it.
        const sandboxRoot = mkdtempSync(join(tmpdir(), "workbuddy-session-rest-"));
        const metadata = createSessionMetadataStore(db, {
          emit,
          sandboxRoot,
          createTemporaryWorkspace: temporaryWorkspacePort(db, sandboxRoot),
          composer: TEST_COMPOSER,
        });
        const listNotified: string[] = [];
        registerSessionRoutes(app, {
          db,
          listEvents: {
            notify(ownerId) {
              listNotified.push(ownerId);
            },
            notifyRewound() {},
          },
          store,
          supervisor,
          metadata,
          workspaceRootOf: () => null,
          agentDir: "/nonexistent/omp-agent",
          sandboxRoot,
          deleter: {
            deleteSession: () =>
              Promise.reject(new Error("session-rest harness does not serve DELETE")),
          },
          // The recording supervisor never runs the pre-dispatch step, so nothing is snapshotted
          // here (#945) and no registration row is written: the real module reads `none` for a
          // bound session and `unbound` for an unbound one (#946). The real step is exercised in
          // prompt-snapshot.test.ts.
          turnSnapshots: createTurnSnapshots({
            db,
            snapshots: {
              take: () => Promise.reject(new Error("session-rest harness takes no snapshot")),
              remove: () => Promise.resolve(),
              removeWorkspace: () => Promise.resolve(),
              restore: () => Promise.reject(new Error("session-rest harness restores nothing")),
            },
            workspaceRootOf: () => null,
            onError: () => undefined,
          }),
        });
        try {
          return await action({ app, db, store, supervisor, metadata, listNotified });
        } finally {
          db.setAuthorizer(null);
          if (db.isTransaction) {
            db.exec("ROLLBACK");
          }
          store.close();
          rmSync(sandboxRoot, { recursive: true, force: true });
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
    decide() {
      return Promise.reject(new Error("unexpected decide call"));
    },
    stop() {
      return Promise.reject(new Error("unexpected stop call"));
    },
    regenerate() {
      return Promise.reject(new Error("unexpected regenerate call"));
    },
    fork() {
      return Promise.reject(new Error("unexpected fork call"));
    },
    undo() {
      return Promise.reject(new Error("unexpected undo call"));
    },
    controlHeld() {
      return false;
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
