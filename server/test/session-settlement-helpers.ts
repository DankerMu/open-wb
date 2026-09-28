/**
 * Issue #474 non-answer settlement test plumbing, shared by the store-level (N), crash/shutdown/
 * reconcile (C) and stop (B) cases: audit rows read back from SQLite, a live ring subscriber
 * attached through the public `subscribe`, and the "every deny resolution precedes the single
 * turn.end" oracle applied alike to the onEvent stream and the live subscriber.
 */
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { FinishStatus } from "../src/sessions/store.js";
import { type ApprovalWorld, sessionEvents } from "./session-approval-helpers.js";

const AUDIT_TITLE = "工具执行审批";

export interface ApprovalAudit {
  actor_id: string;
  title: string;
  detail: Record<string, unknown>;
}

/** Every `session.approval` audit row, oldest first, with `detail` parsed. */
export function approvalAudits(db: DatabaseSync): ApprovalAudit[] {
  const rows = db
    .prepare(
      "SELECT actor_id, title, detail FROM audit_events WHERE kind = 'session.approval' ORDER BY id",
    )
    .all() as Array<{ actor_id: string; title: string; detail: string }>;
  return rows.map((row) => ({
    actor_id: row.actor_id,
    title: row.title,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));
}

/** The audit row one `deny` settlement of a `bash` approval on `messageId` must write. */
export function denyAudit(actor: string, sessionId: string, messageId: number): ApprovalAudit {
  return {
    actor_id: actor,
    title: AUDIT_TITLE,
    detail: { sessionId, messageId, tool: "bash", decision: "deny" },
  };
}

/**
 * A live SSE-style subscriber on the world's session. Only events pushed into an unsealed
 * generation ring are fanned out to it, so what it records is ring evidence.
 */
export function subscribeLive(world: ApprovalWorld): ChatEvent<number>[] {
  const received: ChatEvent<number>[] = [];
  world.fixture.supervisor.subscribe(world.session, null, (retained) => {
    const { id: _id, ...event } = retained;
    received.push(event as ChatEvent<number>);
  });
  return received;
}

/** The session's onEvent stream, events only. */
export function observed(world: ApprovalWorld): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

/**
 * Exactly one turn.end (`status`), and the approval.resolved events are exactly `deny` for
 * `approvalIds` in that order, each one before that turn.end.
 */
export function expectDeniedBeforeEnd(
  events: readonly ChatEvent<number>[],
  messageId: number,
  approvalIds: readonly number[],
  status: FinishStatus,
): void {
  expect(events.filter((event) => event.type === "turn.end")).toEqual([
    { type: "turn.end", data: { messageId, status } },
  ]);
  const end = events.findIndex((event) => event.type === "turn.end");
  const resolved = events.flatMap((event, index) =>
    event.type === "approval.resolved" ? [{ event, index }] : [],
  );
  expect(resolved.map((entry) => entry.event)).toEqual(
    approvalIds.map((approvalId) => ({
      type: "approval.resolved",
      data: { messageId, approvalId, decision: "deny" },
    })),
  );
  for (const entry of resolved) {
    expect(entry.index).toBeLessThan(end);
  }
}
