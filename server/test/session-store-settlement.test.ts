/**
 * Issue #474 N1–N5: the store's terminal transactions (finishTurn, close, reconcileOnStartup)
 * settle every pending approval of the message to `deny` together with its session.approval audit
 * row, all-or-nothing. Store-level through the public createSessionStore entry over real SQLite;
 * audit failures are real triggers, `Date.now` is pinned with withFakeClock. Expected rows and
 * audit payloads are fixture literals from the tool-approval and chat-sessions specs.
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import {
  createSessionStore,
  type SessionStore,
  type SettledApproval,
} from "../src/sessions/store.js";
import { approvalAudits, denyAudit } from "./session-settlement-helpers.js";
import {
  persistenceSnapshot,
  seedMessage,
  seedSession,
  seedStep,
  sessionId,
  withFakeClock,
} from "./session-store-helpers.js";

const T = 1_700_000_000_000;
const R = 1_750_000_000_000;
const TITLE = "Allow tool: bash\nCommand: echo workbuddy-smoke";
const BLOCKED = "terminal audit blocked";
const BLOCK_AUDIT = `CREATE TRIGGER block_terminal_audit BEFORE INSERT ON audit_events
  WHEN NEW.kind = 'session.approval' BEGIN SELECT RAISE(ABORT, '${BLOCKED}'); END`;
const STATUSES = ["failed", "stopped", "done"] as const;

interface ApprovalState {
  id: number;
  decision: string | null;
  decided_at: number | null;
}

interface Turn {
  session: string;
  messageId: number;
  r1: number;
  r2: number;
}

interface SettledTurn extends Turn {
  r3: number;
}

function withDb(run: (db: DatabaseSync) => void): void {
  const db = openDb(":memory:");
  try {
    run(db);
  } finally {
    db.close();
  }
}

function audited(db: DatabaseSync): SessionStore {
  return createSessionStore(db, { onFlushError() {}, emit });
}

/** An accepted `u2` turn with pending r1, r2 requested at T. */
function pendingTurn(store: SessionStore): Turn {
  const session = store.create("u2").id;
  const { assistantMessageId: messageId } = store.acceptPrompt(session, "u2", "run the tool");
  const insert = (requestId: string) =>
    store.insertApproval(session, { requestId, tool: "bash", title: TITLE }, T).approvalId;
  return { session, messageId, r1: insert("r1"), r2: insert("r2") };
}

/** N1 input: pending r1, r2 and r3 answered `allow` at T+1 (one audit row already). */
function mixedTurn(store: SessionStore): SettledTurn {
  const turn = pendingTurn(store);
  const r3 = store.insertApproval(
    turn.session,
    { requestId: "r3", tool: "bash", title: TITLE },
    T,
  ).approvalId;
  store.settleApproval(turn.session, r3, "allow", T + 1);
  return { ...turn, r3 };
}

function approvalStates(db: DatabaseSync): ApprovalState[] {
  return db
    .prepare("SELECT id, decision, decided_at FROM chat_approvals ORDER BY id")
    .all() as unknown as ApprovalState[];
}

function statuses(db: DatabaseSync, turn: Pick<Turn, "session" | "messageId">) {
  const read = (sql: string, id: string | number) =>
    (db.prepare(sql).get(id) as { status: string }).status;
  return {
    session: read("SELECT status FROM chat_sessions WHERE id = ?", turn.session),
    assistant: read("SELECT status FROM chat_messages WHERE id = ?", turn.messageId),
  };
}

/** Everything a terminal transaction may write, for "nothing committed" comparisons. */
function everything(db: DatabaseSync) {
  return {
    ...persistenceSnapshot(db),
    approvals: approvalStates(db),
    audits: approvalAudits(db),
  };
}

function expectDeniedAt(db: DatabaseSync, turn: SettledTurn, at: number): void {
  expect(approvalStates(db)).toEqual([
    { id: turn.r1, decision: "deny", decided_at: at },
    { id: turn.r2, decision: "deny", decided_at: at },
    { id: turn.r3, decision: "allow", decided_at: T + 1 },
  ]);
  const deny = denyAudit("u2", turn.session, turn.messageId);
  expect(approvalAudits(db).slice(1)).toEqual([deny, deny]);
}

function settledEntries(turn: Turn): SettledApproval[] {
  return [
    { messageId: turn.messageId, approvalId: turn.r1, decision: "deny" },
    { messageId: turn.messageId, approvalId: turn.r2, decision: "deny" },
  ];
}

describe("terminal settlement in finishTurn (N1)", () => {
  it.each(STATUSES)(
    "N1 finishTurn(%s) denies every pending approval in the terminal transaction",
    (status) => {
      withDb((db) => {
        const store = audited(db);
        const turn = mixedTurn(store);
        const settled: SettledApproval[] = [];

        expect(withFakeClock(R, () => store.finishTurn(turn.messageId, status, settled))).toBe(
          true,
        );

        expectDeniedAt(db, turn, R);
        expect(approvalAudits(db)).toHaveLength(3);
        expect(settled).toStrictEqual(settledEntries(turn));
        expect(statuses(db, turn)).toEqual({ session: status, assistant: status });
      });
    },
  );

  it("N1 a two-argument finishTurn settles the same way and still returns true", () => {
    withDb((db) => {
      const store = audited(db);
      const turn = mixedTurn(store);

      expect(withFakeClock(R, () => store.finishTurn(turn.messageId, "failed"))).toBe(true);

      expectDeniedAt(db, turn, R);
      expect(approvalAudits(db)).toHaveLength(3);
      expect(statuses(db, turn)).toEqual({ session: "failed", assistant: "failed" });
    });
  });
});

describe("terminal settlement in close (N2)", () => {
  it("N2 close fails the active turn and denies its pending approvals", () => {
    withDb((db) => {
      const store = audited(db);
      const turn = mixedTurn(store);

      withFakeClock(R, () => {
        store.close();
      });

      expectDeniedAt(db, turn, R);
      expect(approvalAudits(db)).toHaveLength(3);
      expect(statuses(db, turn)).toEqual({ session: "failed", assistant: "failed" });
    });
  });
});

describe("audit failure rolls the whole terminal transaction back (N3)", () => {
  it("N3a a blocked audit leaves finishTurn uncommitted and unreported; a retry settles", () => {
    withDb((db) => {
      const store = audited(db);
      const turn = mixedTurn(store);
      store.startStep(turn.messageId, { ordinal: 0, name: "bash", detail: "" });
      db.exec(BLOCK_AUDIT);
      const before = everything(db);
      const settled: SettledApproval[] = [];

      expect(() => store.finishTurn(turn.messageId, "failed", settled)).toThrow(BLOCKED);

      expect(everything(db)).toEqual(before);
      expect(before.steps.map((step) => step.status)).toEqual(["running"]);
      expect(statuses(db, turn)).toEqual({ session: "running", assistant: "running" });
      expect(settled).toEqual([]);

      db.exec("DROP TRIGGER block_terminal_audit");
      expect(withFakeClock(R, () => store.finishTurn(turn.messageId, "failed", settled))).toBe(
        true,
      );
      expectDeniedAt(db, turn, R);
      expect(settled).toStrictEqual(settledEntries(turn));
      expect(statuses(db, turn)).toEqual({ session: "failed", assistant: "failed" });
    });
  });

  it("N3b a blocked audit leaves close uncommitted; a retried close settles", () => {
    withDb((db) => {
      const store = audited(db);
      const turn = mixedTurn(store);
      store.startStep(turn.messageId, { ordinal: 0, name: "bash", detail: "" });
      db.exec(BLOCK_AUDIT);
      const before = everything(db);

      expect(() => {
        store.close();
      }).toThrow(BLOCKED);

      expect(everything(db)).toEqual(before);
      expect(statuses(db, turn)).toEqual({ session: "running", assistant: "running" });

      db.exec("DROP TRIGGER block_terminal_audit");
      withFakeClock(R, () => {
        store.close();
      });
      expectDeniedAt(db, turn, R);
      expect(statuses(db, turn)).toEqual({ session: "failed", assistant: "failed" });
    });
  });
});

describe("a store without an audit emit (N4)", () => {
  it("N4a without approval rows, reconcile, finishTurn and close all still succeed", () => {
    withDb((db) => {
      const bare = createSessionStore(db, { onFlushError() {} });
      bare.reconcileOnStartup();
      const session = bare.create("u1").id;
      const first = bare.acceptPrompt(session, "u1", "first");
      expect(bare.finishTurn(first.assistantMessageId, "done")).toBe(true);
      const second = bare.acceptPrompt(session, "u1", "second");

      bare.close();

      expect(statuses(db, { session, messageId: second.assistantMessageId })).toEqual({
        session: "failed",
        assistant: "failed",
      });
      expect(approvalAudits(db)).toEqual([]);
    });
  });

  it("N4b with a pending row, finishTurn fails closed and commits nothing", () => {
    withDb((db) => {
      const bare = createSessionStore(db, { onFlushError() {} });
      const turn = pendingTurn(bare);
      const before = everything(db);
      const settled: SettledApproval[] = [];

      expect(() => bare.finishTurn(turn.messageId, "failed", settled)).toThrow();

      expect(everything(db)).toEqual(before);
      expect(statuses(db, turn)).toEqual({ session: "running", assistant: "running" });
      expect(approvalStates(db).map((row) => row.decision)).toEqual([null, null]);
      expect(approvalAudits(db)).toEqual([]);
      expect(settled).toEqual([]);
    });
  });
});

interface ReconcileSeed {
  running: string;
  runningMessage: number;
  runningStep: number;
  p: number;
  others: number[];
}

function insertApproval(
  db: DatabaseSync,
  messageId: number,
  requestId: string,
  decision: string | null,
  decidedAt: number | null,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at,
                                    decision, decided_at) VALUES (?, ?, 'bash', ?, ?, ?, ?, ?)`,
      )
      .run(messageId, requestId, TITLE, T, T + 60_000, decision, decidedAt).lastInsertRowid,
  );
}

function seedOwned(db: DatabaseSync, marker: string, ownerId: string, status: string): number {
  const id = sessionId(marker);
  seedSession(db, {
    id,
    ownerId,
    title: null,
    status: "done",
    ompSessionFile: null,
    streamEpoch: 0,
    createdAt: T,
    updatedAt: T,
  });
  const message = seedMessage(db, {
    sessionId: id,
    role: "assistant",
    content: "",
    status: "done",
    createdAt: T,
  });
  db.prepare("UPDATE chat_sessions SET status = ? WHERE id = ?").run(status, id);
  db.prepare("UPDATE chat_messages SET status = ? WHERE id = ?").run(status, message);
  return message;
}

/**
 * A `u2` running turn (session, assistant, step) with pending p and `allow` a; a `stopped`
 * message holding a NULL row q; a `done` message holding a `deny` row.
 */
function seedReconcile(db: DatabaseSync): ReconcileSeed {
  const runningMessage = seedOwned(db, "a", "u2", "running");
  const runningStep = seedStep(db, {
    messageId: runningMessage,
    ordinal: 0,
    name: "bash",
    detail: "",
    status: "running",
    startedAt: T,
    endedAt: null,
  });
  const p = insertApproval(db, runningMessage, "r1", null, null);
  const a = insertApproval(db, runningMessage, "r2", "allow", T + 1);
  const q = insertApproval(db, seedOwned(db, "b", "u1", "stopped"), "r1", null, null);
  const d = insertApproval(db, seedOwned(db, "c", "u1", "done"), "r1", "deny", T + 2);
  return { running: sessionId("a"), runningMessage, runningStep, p, others: [a, q, d] };
}

function fullApprovalRows(db: DatabaseSync, ids: readonly number[]) {
  return ids.map((id) => db.prepare("SELECT * FROM chat_approvals WHERE id = ?").get(id));
}

describe("startup reconciliation (N5)", () => {
  it("N5 denies pending approvals of running messages only, audited, before failing them", () => {
    withDb((db) => {
      const seed = seedReconcile(db);
      const othersBefore = fullApprovalRows(db, seed.others);

      withFakeClock(R, () => {
        audited(db).reconcileOnStartup();
      });

      expect(approvalStates(db).find((row) => row.id === seed.p)).toEqual({
        id: seed.p,
        decision: "deny",
        decided_at: R,
      });
      expect(fullApprovalRows(db, seed.others)).toEqual(othersBefore);
      expect(approvalAudits(db)).toEqual([denyAudit("u2", seed.running, seed.runningMessage)]);
      const after = persistenceSnapshot(db);
      expect(after.sessions.map((row) => [row.id, row.status])).toEqual([
        [seed.running, "failed"],
        [sessionId("b"), "stopped"],
        [sessionId("c"), "done"],
      ]);
      expect(after.messages.map((row) => row.status)).toEqual(["failed", "stopped", "done"]);
      expect(after.steps.find((row) => row.id === seed.runningStep)?.status).toBe("failed");
    });
  });

  it("N5 a blocked audit fails reconciliation and commits no status or decision", () => {
    withDb((db) => {
      seedReconcile(db);
      db.exec(BLOCK_AUDIT);
      const before = everything(db);

      expect(() => {
        audited(db).reconcileOnStartup();
      }).toThrow(BLOCKED);

      expect(everything(db)).toEqual(before);
    });
  });
});
