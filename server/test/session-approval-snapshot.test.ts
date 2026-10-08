/**
 * Issue #476 message-snapshot `approvals` projection (parent s1c tasks 5.3), S1–S10. The
 * deterministic layer is `withSessionRest` (real store + SQLite, recording supervisor): rows come
 * from the public `store.insertApproval`, settled decisions and a stray user-message row from
 * inline SQL. The real layer is the production assembly over fake-omp `approval` /
 * `approval-parallel` children. Every element is compared to fixture literals with
 * `toStrictEqual`, so a leaked or `undefined` extra key fails too.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStore } from "../src/sessions/store.js";
import {
  type ApprovalWorld,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  TITLE,
  TITLE_2,
  TTL_MS,
  T as WORLD_T,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import { cookieFor, getSessionMessages, withSessionRest } from "./session-rest-helpers.js";
import { waitForTurn } from "./session-supervisor-helpers.js";

const T = 1_700_000_000_000;
const E = T + 60_000;
const TITLE_U = "Allow tool: bash\nCommand: echo 中文 😀\u0000尾";
const MESSAGE_KEYS = [
  "approvals",
  "content",
  "createdAt",
  "id",
  "role",
  "status",
  "steps",
  "thinking",
  "undo",
];

interface SnapshotApproval {
  id: number;
  tool: string;
  title: string;
  requestedAt: number;
  expiresAt: number;
  decision: "allow" | "deny" | "timeout" | null;
}

interface SnapshotMessage {
  id: number;
  role: "user" | "assistant";
  status: string;
  approvals: SnapshotApproval[];
}

interface SnapshotBody {
  session: { status: string };
  messages: SnapshotMessage[];
}

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(scenario: "approval" | "approval-parallel" = "approval") {
  const world = await openApprovalWorld(scenario);
  worlds.push(world);
  return world;
}

function body(response: LightMyRequestResponse): SnapshotBody {
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return response.json() as SnapshotBody;
}

async function snapshot(app: FastifyInstance, sessionId: string, cookie: string) {
  return body(await getSessionMessages(app, sessionId, cookie));
}

function message(snapshotBody: SnapshotBody, index: number): SnapshotMessage {
  const found = snapshotBody.messages[index];
  if (found === undefined) {
    throw new Error(`missing message ${String(index)}`);
  }
  return found;
}

function setDecision(db: DatabaseSync, approvalId: number, decision: string, decidedAt = T + 1) {
  db.prepare("UPDATE chat_approvals SET decision = ?, decided_at = ? WHERE id = ?").run(
    decision,
    decidedAt,
    approvalId,
  );
}

function request(store: SessionStore, sessionId: string, requestId: string, at = T) {
  return store.insertApproval(sessionId, { requestId, tool: "bash", title: TITLE_U }, at)
    .approvalId;
}

function pending(id: number, requestedAt = T): SnapshotApproval {
  return {
    id,
    tool: "bash",
    title: TITLE_U,
    requestedAt,
    expiresAt: requestedAt + 60_000,
    decision: null,
  };
}

function answer(world: ApprovalWorld, approvalId: number, decision: "allow" | "deny") {
  return world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/approvals/${String(approvalId)}`,
    headers: { "content-type": "application/json", cookie: world.cookie },
    payload: JSON.stringify({ decision }),
  });
}

async function settledAnswer(
  world: ApprovalWorld,
  approvalId: number,
  decision: "allow" | "deny",
): Promise<SnapshotApproval> {
  const response = await answer(world, approvalId, decision);
  expect(response.statusCode).toBe(200);
  return response.json() as SnapshotApproval;
}

function worldSnapshot(world: ApprovalWorld) {
  return snapshot(world.fixture.app, world.session, world.cookie);
}

function worldPending(id: number, title = TITLE): SnapshotApproval {
  return {
    id,
    tool: "bash",
    title,
    requestedAt: WORLD_T,
    expiresAt: WORLD_T + TTL_MS,
    decision: null,
  };
}

describe("message snapshot approvals projection (deterministic store)", () => {
  it("S1 every message carries approvals, [] when no approval rows exist", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "no approvals");
      expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);

      const history = await snapshot(app, session.id, await cookieFor(app, "zhangsan"));

      expect(history.messages.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      for (const entry of history.messages) {
        expect(Object.keys(entry).sort()).toEqual(MESSAGE_KEYS);
        expect(entry.approvals).toStrictEqual([]);
      }
    });
  });

  it("S2 a pending row projects exactly six keys with decision null", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1");
      store.acceptPrompt(session.id, "u1", "one pending");
      const approvalId = request(store, session.id, "r1");

      const history = await snapshot(app, session.id, await cookieFor(app, "zhangsan"));

      expect(message(history, 0).approvals).toStrictEqual([]);
      expect(message(history, 1).approvals).toStrictEqual([
        {
          id: approvalId,
          tool: "bash",
          title: TITLE_U,
          requestedAt: T,
          expiresAt: E,
          decision: null,
        },
      ]);
    });
  });

  it("S3 rows are ordered by id, not requestedAt, and settle independently", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1");
      store.acceptPrompt(session.id, "u1", "two rows");
      const first = request(store, session.id, "r1", T + 5_000);
      const second = request(store, session.id, "r2", T);
      expect(second).toBeGreaterThan(first);
      setDecision(db, second, "deny");

      const history = await snapshot(app, session.id, await cookieFor(app, "zhangsan"));

      expect(message(history, 1).approvals).toStrictEqual([
        pending(first, T + 5_000),
        {
          id: second,
          tool: "bash",
          title: TITLE_U,
          requestedAt: T,
          expiresAt: E,
          decision: "deny",
        },
      ]);
    });
  });

  it("S4 settled decisions stay visible on finished turns", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1");
      const round1 = store.acceptPrompt(session.id, "u1", "first round");
      setDecision(db, request(store, session.id, "r1"), "deny");
      expect(store.finishTurn(round1.assistantMessageId, "done")).toBe(true);
      const round2 = store.acceptPrompt(session.id, "u1", "second round");
      setDecision(db, request(store, session.id, "r1"), "allow");
      setDecision(db, request(store, session.id, "r2"), "timeout");
      expect(store.finishTurn(round2.assistantMessageId, "done")).toBe(true);

      const history = await snapshot(app, session.id, await cookieFor(app, "zhangsan"));

      expect(history.messages.map((entry) => entry.id)).toEqual([
        round1.userMessageId,
        round1.assistantMessageId,
        round2.userMessageId,
        round2.assistantMessageId,
      ]);
      expect(message(history, 1).approvals[0]?.decision).toBe("deny");
      expect(message(history, 1).approvals).toHaveLength(1);
      expect(message(history, 3).approvals.map((entry) => entry.decision)).toEqual([
        "allow",
        "timeout",
      ]);
      expect(message(history, 0).approvals).toStrictEqual([]);
      expect(message(history, 2).approvals).toStrictEqual([]);
    });
  });

  it("S5 only this session's assistant rows are projected; user messages stay []", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const sessionA = store.create("u1");
      const sessionB = store.create("u1");
      const acceptedA = store.acceptPrompt(sessionA.id, "u1", "session A");
      store.acceptPrompt(sessionB.id, "u1", "session B");
      const rowA = request(store, sessionA.id, "r1");
      const rowB = request(store, sessionB.id, "r1", T + 7);
      db.prepare(
        `INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at)
         VALUES (?, 'stray', 'bash', 'stray user row', ?, ?)`,
      ).run(acceptedA.userMessageId, T, E);
      const cookie = await cookieFor(app, "zhangsan");

      const historyA = await snapshot(app, sessionA.id, cookie);
      const historyB = await snapshot(app, sessionB.id, cookie);

      expect(message(historyA, 0).approvals).toStrictEqual([]);
      expect(message(historyA, 1).approvals).toStrictEqual([pending(rowA)]);
      expect(message(historyB, 0).approvals).toStrictEqual([]);
      expect(message(historyB, 1).approvals).toStrictEqual([pending(rowB, T + 7)]);
    });
  });

  it("S6 approvals are captured with the streamCursor in preParsing, not re-read", async () => {
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const session = store.create("u1");
      store.acceptPrompt(session.id, "u1", "captured together");
      const approvalId = request(store, session.id, "r1");
      supervisor.cursor = { epoch: 1, seq: 4 };
      supervisor.onStreamCursor(() => {
        setDecision(db, approvalId, "allow");
        return supervisor.cursor;
      });
      const cookie = await cookieFor(app, "zhangsan");

      const first = await snapshot(app, session.id, cookie);
      expect(message(first, 1).approvals).toStrictEqual([pending(approvalId)]);
      expect(supervisor.cursorCalls).toEqual([session.id]);

      const second = await snapshot(app, session.id, cookie);
      expect(message(second, 1).approvals).toStrictEqual([
        { ...pending(approvalId), decision: "allow" },
      ]);
      expect(supervisor.cursorCalls).toEqual([session.id, session.id]);
    });
  });
});

describe("message snapshot approvals over the real fake-omp approval flow", () => {
  it(
    "S7 a pending approval is restorable and matches the answer body once allowed",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);

      const before = await worldSnapshot(world);
      expect(before.session.status).toBe("running");
      expect(message(before, 0).approvals).toStrictEqual([]);
      expect(message(before, 1).approvals).toStrictEqual([worldPending(row.id)]);

      const answered = await settledAnswer(world, row.id, "allow");
      expect(answered.decision).toBe("allow");
      await waitForTurn(world.fixture, world.session, "done");

      const after = await worldSnapshot(world);
      expect(message(after, 0).approvals).toStrictEqual([]);
      expect(message(after, 1).approvals).toStrictEqual([answered]);
    },
  );

  it("S8 a denied approval stays visible after the turn is done", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);

    const answered = await settledAnswer(world, row.id, "deny");
    await waitForTurn(world.fixture, world.session, "done");

    const after = await worldSnapshot(world);
    expect(answered.decision).toBe("deny");
    expect(message(after, 1).approvals).toStrictEqual([answered]);
    expect(message(after, 1).approvals[0]?.decision).toBe("deny");
  });

  it("S9 a timed-out approval reads decision timeout in the snapshot", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);

    world.clock.advance(TTL_MS);
    await waitForTurn(world.fixture, world.session, "done");

    const after = await worldSnapshot(world);
    expect(message(after, 1).approvals[0]).toStrictEqual({
      ...worldPending(row.id),
      decision: "timeout",
    });
  });

  it("S10 parallel approvals are listed in id order and settle independently", REAL, async () => {
    const world = await open("approval-parallel");
    await prompted(world);
    const [r1, r2] = await waitForRows(world, 2);
    if (r1 === undefined || r2 === undefined) {
      throw new Error("expected two pending approvals");
    }
    await waitForEvent(world, "approval.request", 2);
    expect(r2.id).toBeGreaterThan(r1.id);

    const both = await worldSnapshot(world);
    expect(message(both, 1).approvals).toStrictEqual([
      worldPending(r1.id),
      worldPending(r2.id, TITLE_2),
    ]);

    const second = await settledAnswer(world, r2.id, "allow");
    const afterSecond = await worldSnapshot(world);
    expect(message(afterSecond, 1).approvals).toStrictEqual([worldPending(r1.id), second]);
    expect(message(afterSecond, 1).approvals.map((entry) => entry.decision)).toEqual([
      null,
      "allow",
    ]);

    const first = await settledAnswer(world, r1.id, "deny");
    const afterFirst = await worldSnapshot(world);
    expect(message(afterFirst, 1).approvals).toStrictEqual([first, second]);
    expect(message(afterFirst, 1).approvals.map((entry) => entry.decision)).toEqual([
      "deny",
      "allow",
    ]);
    await waitForTurn(world.fixture, world.session, "done");
    expect(message(await worldSnapshot(world), 1).approvals).toStrictEqual([first, second]);
  });
});
