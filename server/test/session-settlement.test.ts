/**
 * Issue #474 C1–C5: turns that end without the child answering — native crash, graceful
 * shutdown, startup reconciliation — leave no pending approval. The terminal transaction denies
 * every pending row with its audit row; with a ring, approval.resolved{deny} lands after that
 * commit and before the single turn.end; no frame is written to the child and the approval timers
 * are revoked. Production createApp → registerSessions over real fake-omp children, real SQLite
 * and the injected clock; oracles are rows, audit rows, stdin frames, onEvent, a live subscriber
 * and public REST reads.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { createSessionStore } from "../src/sessions/store.js";
import {
  type ApprovalWorld,
  approvalRow,
  approvalRows,
  ofType,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  approvalAudits,
  denyAudit,
  expectDeniedBeforeEnd,
  observed,
  subscribeLive,
} from "./session-settlement-helpers.js";
import { seedMessage, seedSession, sessionId } from "./session-store-helpers.js";
import { OWNER_ID } from "./session-supervisor-helpers.js";
import { waitExited } from "./session-supervisor-pool-helpers.js";

const SETTLED_ENVELOPE = {
  error: { code: "approval_settled", message: "该审批已处理" },
} as const;

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(scenario: "approval" | "approval-parallel"): Promise<ApprovalWorld> {
  const world = await openApprovalWorld(scenario);
  worlds.push(world);
  return world;
}

/** SIGKILLs the first child and waits for the failed turn.end and the child's exit. */
async function crash(world: ApprovalWorld): Promise<void> {
  const { child } = spawnedAt(world, 0);
  child.kill("SIGKILL");
  await waitForEvent(world, "turn.end");
  await waitExited(child, "killed child");
  await settle();
}

/** Both approval-parallel selects persisted pending and both approval.request events published. */
async function parallelPending(world: ApprovalWorld) {
  await prompted(world);
  const rows = await waitForRows(world, 2);
  await waitForEvent(world, "approval.request", 2);
  return rows.map((row) => row.id);
}

/** Rows, audits, events and stdin frames: nothing here may change once the turn is over. */
function sideEffects(world: ApprovalWorld) {
  return {
    rows: approvalRows(world.fixture.db),
    audits: approvalAudits(world.fixture.db),
    events: sessionEvents(world).length,
    stdin: world.spawned.map((spawned) => spawned.stdin.length),
  };
}

function answer(world: ApprovalWorld, approvalId: number) {
  return world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/approvals/${String(approvalId)}`,
    headers: { "content-type": "application/json", cookie: world.cookie },
    payload: JSON.stringify({ decision: "allow" }),
  });
}

async function snapshotApprovals(world: ApprovalWorld, session = world.session) {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${session}/messages`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    session: { status: string };
    messages: Array<{ role: string; approvals: Array<{ id: number; decision: string | null }> }>;
  }>();
}

describe("crash settlement (C1–C3)", () => {
  it(
    "C1 a crash denies the pending approval in the failed turn's transaction, before turn.end",
    REAL,
    async () => {
      const world = await open("approval");
      const row = await pendingApproval(world);
      const live = subscribeLive(world);
      const before = Date.now();

      await crash(world);

      const after = Date.now();
      const settled = approvalRow(world.fixture.db, row.id);
      expect(settled.decision).toBe("deny");
      expect(settled.decided_at).toBeGreaterThanOrEqual(before);
      expect(settled.decided_at).toBeLessThanOrEqual(after);
      expect(approvalAudits(world.fixture.db)).toEqual([
        denyAudit(OWNER_ID, world.session, row.message_id),
      ]);
      expect(responses(spawnedAt(world, 0))).toEqual([]);
      const events = observed(world);
      expectDeniedBeforeEnd(events, row.message_id, [row.id], "failed");
      const error = events.findIndex((event) => event.type === "error");
      expect(error).toBeGreaterThanOrEqual(0);
      expect(error).toBeLessThan(events.findIndex((event) => event.type === "turn.end"));
      expectDeniedBeforeEnd(live, row.message_id, [row.id], "failed");
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);

      const frozen = sideEffects(world);
      world.clock.advance(TTL_MS);
      await settle();
      expect(sideEffects(world)).toEqual(frozen);
      expect(approvalRows(world.fixture.db).map((entry) => entry.decision)).toEqual(["deny"]);
      const snapshot = await snapshotApprovals(world);
      expect(snapshot.messages[1]?.approvals).toEqual([
        expect.objectContaining({ id: row.id, decision: "deny" }),
      ]);
    },
  );

  it(
    "C2 an answer racing a crashed process loses the CAS: 409, the deny stands, nothing sent",
    REAL,
    async () => {
      const world = await open("approval");
      const row = await pendingApproval(world);
      await crash(world);
      const denied = approvalRow(world.fixture.db, row.id);
      const resolved = ofType(sessionEvents(world), "approval.resolved").length;

      const response = await answer(world, row.id);

      expect(response.statusCode).toBe(409);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toStrictEqual(SETTLED_ENVELOPE);
      expect(approvalRow(world.fixture.db, row.id)).toEqual(denied);
      expect(denied.decision).toBe("deny");
      expect(approvalAudits(world.fixture.db)).toEqual([
        denyAudit(OWNER_ID, world.session, row.message_id),
      ]);
      expect(responses(spawnedAt(world, 0))).toEqual([]);
      await settle();
      expect(ofType(sessionEvents(world), "approval.resolved")).toHaveLength(resolved);
    },
  );

  it(
    "C3 a crash with two pending approvals denies both, resolved in id order before turn.end",
    REAL,
    async () => {
      const world = await open("approval-parallel");
      const ids = await parallelPending(world);
      const live = subscribeLive(world);
      const messageId = approvalRow(world.fixture.db, ids[0] as number).message_id;

      await crash(world);

      expect(approvalRows(world.fixture.db).map((row) => row.decision)).toEqual(["deny", "deny"]);
      const deny = denyAudit(OWNER_ID, world.session, messageId);
      expect(approvalAudits(world.fixture.db)).toEqual([deny, deny]);
      expectDeniedBeforeEnd(observed(world), messageId, ids, "failed");
      expectDeniedBeforeEnd(live, messageId, ids, "failed");
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
    },
  );
});

describe("graceful shutdown settlement (C4)", () => {
  it(
    "C4 shutdown denies both pending approvals, publishes before turn.end, sends no frame",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval-parallel");
      const { db } = world.fixture;
      let closed = false;
      try {
        const ids = await parallelPending(world);
        const messageId = approvalRow(db, ids[0] as number).message_id;
        closed = true;
        await world.fixture.app.close();

        const rows = approvalRows(db);
        expect(rows.map((row) => row.decision)).toEqual(["deny", "deny"]);
        expect(rows.every((row) => row.decided_at !== null)).toBe(true);
        const deny = denyAudit(OWNER_ID, world.session, messageId);
        expect(approvalAudits(db)).toEqual([deny, deny]);
        expect(responses(spawnedAt(world, 0))).toEqual([]);
        expectDeniedBeforeEnd(observed(world), messageId, ids, "failed");
        expect(world.errors).toEqual([]);

        const frozen = sideEffects(world);
        world.clock.advance(120_000);
        await settle();
        expect(sideEffects(world)).toEqual(frozen);

        const restarted = createSessionStore(db, { onFlushError() {}, emit });
        const tree = restarted.getMessages(world.session, OWNER_ID);
        expect(tree?.messages[1]?.approvals.map((entry) => entry.decision)).toEqual([
          "deny",
          "deny",
        ]);
      } finally {
        if (!closed) {
          await world.fixture.app.close().catch(() => undefined);
        }
        db.close();
      }
    },
  );
});

interface StaleTurn {
  session: string;
  messageId: number;
}

/** A `u1` running session left by a previous process, with pending p and `allow` a. */
function seedStaleTurn(db: DatabaseSync): StaleTurn {
  const session = sessionId("d");
  seedSession(db, {
    id: session,
    ownerId: OWNER_ID,
    title: null,
    status: "running",
    ompSessionFile: null,
    streamEpoch: 0,
    createdAt: T,
    updatedAt: T,
  });
  const messageId = seedMessage(db, {
    sessionId: session,
    role: "assistant",
    content: "",
    status: "running",
    createdAt: T,
  });
  const insert = db.prepare(
    `INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at,
                                decision, decided_at) VALUES (?, ?, 'bash', 'title', ?, ?, ?, ?)`,
  );
  insert.run(messageId, "r1", T, T + TTL_MS, null, null);
  insert.run(messageId, "r2", T, T + TTL_MS, "allow", T + 1);
  return { session, messageId };
}

describe("startup reconciliation settlement (C5)", () => {
  it(
    "C5 reconcile denies a stale pending approval before routes accept, publishing nothing",
    REAL,
    async () => {
      let stale: StaleTurn | undefined;
      const before = Date.now();
      const world = await openApprovalWorld("approval", {
        prepare: (db) => {
          stale = seedStaleTurn(db);
        },
      });
      worlds.push(world);
      const after = Date.now();
      if (stale === undefined) {
        throw new Error("stale turn was not seeded");
      }

      const [p, a] = approvalRows(world.fixture.db, stale.session);
      expect(p?.decision).toBe("deny");
      expect(p?.decided_at).toBeGreaterThanOrEqual(before);
      expect(p?.decided_at).toBeLessThanOrEqual(after);
      expect(a).toMatchObject({ decision: "allow", decided_at: T + 1 });
      expect(approvalAudits(world.fixture.db)).toEqual([
        denyAudit(OWNER_ID, stale.session, stale.messageId),
      ]);
      expect(world.events.filter((entry) => entry.sessionId === stale?.session)).toEqual([]);

      const snapshot = await snapshotApprovals(world, stale.session);
      expect(snapshot.session.status).toBe("failed");
      expect(snapshot.messages[0]?.approvals).toEqual([
        expect.objectContaining({ id: p?.id, decision: "deny" }),
        expect.objectContaining({ id: a?.id, decision: "allow" }),
      ]);
    },
  );
});
