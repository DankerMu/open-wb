/**
 * Issue #517 (parent s1c tasks 5.1) session DTO metadata projection over `app.inject()` and real
 * SQLite: the eleven-key session view on create, list and snapshot (fork 201 is pinned by
 * `session-fork-rest-real.test.ts` via `SESSION_VIEW_KEYS`), stored `scene`/`workspace_id`/
 * `pinned_at` columns read back per value, message `thinking` and step `changes` read from their
 * columns. Oracles: the literal values written by SQL and the key order listed in the spec delta.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStore } from "../src/sessions/store.js";
import { NULL_SESSION_META, SESSION_VIEW_KEYS } from "./session-meta-fixtures.js";
import {
  cookieFor,
  getSessionMessages,
  SESSION_NOW,
  withSessionRest,
} from "./session-rest-helpers.js";
import { HEX32 } from "./session-store-helpers.js";
import { expectWorkspaceResponse, insertWorkspace } from "./workspaces-http-helpers.js";

const WORKSPACE_ID = "a".repeat(32);
const PINNED_AT = 1_700_000_000_000;
const THINKING = "先想一想";
const MESSAGE_KEYS = [
  "id",
  "role",
  "content",
  "thinking",
  "status",
  "createdAt",
  "approvals",
  "steps",
];
const STEP_KEYS = ["id", "ordinal", "name", "detail", "output", "changes", "status"];
const STORED_CHANGES = [
  { path: "src/app.ts", added: 2, removed: 1, kind: "edit" },
  { path: "out/index.html", added: null, removed: null, kind: "write" },
];

interface PublicSessionBody {
  id: string;
  scene: string | null;
  workspaceId: string | null;
  pinnedAt: number | null;
}

interface PublicStepBody {
  id: number;
  changes: unknown;
}

interface PublicMessageBody {
  id: number;
  role: string;
  thinking: string | null;
  steps: PublicStepBody[];
}

interface SnapshotBody {
  session: PublicSessionBody;
  messages: PublicMessageBody[];
}

afterEach(() => {
  vi.useRealTimers();
});

function listSessions(app: FastifyInstance, cookie: string) {
  return app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });
}

async function snapshotOf(app: FastifyInstance, sessionId: string): Promise<SnapshotBody> {
  const response = await getSessionMessages(app, sessionId, await cookieFor(app, "zhangsan"));
  expect(response.statusCode).toBe(200);
  return response.json() as SnapshotBody;
}

function completeTurn(store: SessionStore, sessionId: string, text: string) {
  const turn = store.acceptPrompt(sessionId, "u1", text);
  expect(store.appendDelta(turn.assistantMessageId, `answer to ${text}`)).toBe(true);
  return turn;
}

function writeThinking(db: DatabaseSync, messageId: number, thinking: string): void {
  const receipt = db
    .prepare("UPDATE chat_messages SET thinking = ? WHERE id = ?")
    .run(thinking, messageId);
  expect(receipt.changes).toBe(1);
}

function writeChanges(db: DatabaseSync, stepId: number, changes: string): void {
  const receipt = db.prepare("UPDATE chat_steps SET changes = ? WHERE id = ?").run(changes, stepId);
  expect(receipt.changes).toBe(1);
}

describe("session DTO metadata: eleven-key session view", () => {
  it("returns eleven keys with null metadata from create, list and snapshot", async () => {
    await withSessionRest(async ({ app }) => {
      const cookie = await cookieFor(app, "zhangsan");
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { id: string };
      expect(body.id).toMatch(HEX32);
      expect(Object.keys(body)).toEqual(SESSION_VIEW_KEYS);
      expect(body).toEqual({
        id: body.id,
        title: null,
        status: "idle",
        createdAt: SESSION_NOW,
        updatedAt: SESSION_NOW,
        scene: null,
        workspaceId: null,
        pinnedAt: null,
        archivedAt: null,
        pendingApproval: false,
        temporaryWorkspace: false,
      });

      const listed = await listSessions(app, cookie);
      expectWorkspaceResponse(listed, 200, { sessions: [body] });
      const [listedSession] = (listed.json() as { sessions: object[] }).sessions;
      expect(Object.keys(listedSession ?? {})).toEqual(SESSION_VIEW_KEYS);

      const snapshot = await snapshotOf(app, body.id);
      expect(Object.keys(snapshot.session)).toEqual(SESSION_VIEW_KEYS);
      expect(snapshot.session).toEqual(body);
    });
  });

  it("reads stored scene, workspace and pin columns back in the list and the snapshot", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const stored = store.create("u1");
      const untouched = store.create("u1");
      insertWorkspace(db, WORKSPACE_ID, "u1", "周报空间", "weekly", SESSION_NOW);
      const receipt = db
        .prepare(
          "UPDATE chat_sessions SET scene = 'design', workspace_id = ?, pinned_at = ? WHERE id = ?",
        )
        .run(WORKSPACE_ID, PINNED_AT, stored.id);
      expect(receipt.changes).toBe(1);
      const expected = {
        ...stored,
        scene: "design",
        workspaceId: WORKSPACE_ID,
        pinnedAt: PINNED_AT,
      };

      const listed = await listSessions(app, await cookieFor(app, "zhangsan"));
      const sessions = (listed.json() as { sessions: PublicSessionBody[] }).sessions;
      expect(sessions.find((session) => session.id === stored.id)).toEqual(expected);
      expect(sessions.find((session) => session.id === untouched.id)).toEqual({
        ...untouched,
        ...NULL_SESSION_META,
      });

      const snapshot = await snapshotOf(app, stored.id);
      expect(snapshot.session).toEqual(expected);
      expect(Object.keys(snapshot.session)).toEqual(SESSION_VIEW_KEYS);
    });
  });
});

describe("session DTO metadata: message thinking", () => {
  it("reads the stored thinking column and null for user and unwritten assistant rows", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1");
      const first = completeTurn(store, session.id, "first");
      expect(store.finishTurn(first.assistantMessageId, "done")).toBe(true);
      const second = completeTurn(store, session.id, "second");
      expect(store.finishTurn(second.assistantMessageId, "done")).toBe(true);
      writeThinking(db, first.assistantMessageId, THINKING);

      const snapshot = await snapshotOf(app, session.id);
      expect(
        snapshot.messages.map((message) => [message.id, message.role, message.thinking]),
      ).toEqual([
        [first.userMessageId, "user", null],
        [first.assistantMessageId, "assistant", THINKING],
        [second.userMessageId, "user", null],
        [second.assistantMessageId, "assistant", null],
      ]);
      for (const message of snapshot.messages) {
        expect(Object.keys(message)).toEqual(MESSAGE_KEYS);
      }
    });
  });
});

describe("session DTO metadata: step changes", () => {
  it("reads a stored changes array per value and null for an unwritten step", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1");
      const turn = completeTurn(store, session.id, "edit files");
      const editStep = store.startStep(turn.assistantMessageId, {
        ordinal: 0,
        name: "edit",
        detail: '{"path":"src/app.ts"}',
      });
      const bashStep = store.startStep(turn.assistantMessageId, {
        ordinal: 1,
        name: "bash",
        detail: '{"command":"ls"}',
      });
      expect(store.finishStep(editStep, "done", "edited")).toBe(true);
      expect(store.finishStep(bashStep, "done", "listed")).toBe(true);
      expect(store.finishTurn(turn.assistantMessageId, "done")).toBe(true);
      writeChanges(db, editStep, JSON.stringify(STORED_CHANGES));

      const snapshot = await snapshotOf(app, session.id);
      const steps = snapshot.messages.find(
        (message) => message.id === turn.assistantMessageId,
      )?.steps;
      expect(steps).toEqual([
        {
          id: editStep,
          ordinal: 0,
          name: "edit",
          detail: '{"path":"src/app.ts"}',
          output: "edited",
          changes: STORED_CHANGES,
          status: "done",
        },
        {
          id: bashStep,
          ordinal: 1,
          name: "bash",
          detail: '{"command":"ls"}',
          output: "listed",
          changes: null,
          status: "done",
        },
      ]);
      for (const step of steps ?? []) {
        expect(Object.keys(step)).toEqual(STEP_KEYS);
      }
    });
  });
});
