/**
 * Issue 1471 segment positions (chat-interleaved-segments design D1/D2/D16): the step insert moved
 * out of store.ts. `chat_steps.body_offset` is written by the same INSERT that creates the step row,
 * so the row never exists without it and a failed insert leaves neither. Its value is the turn's
 * published body length (`Turn.publishedLength`, UTF-16 code units of every delta `appendDelta`
 * took, pending ones included), never the stored `content` length, which lacks the pending deltas.
 * Issue 1472 adds the thinking segment rows a span opens and closes (thinking-span.ts). Issue 1473
 * (design D6) adds the two `chat_approvals.step_id` writes of approval-pairing.ts: the step insert's
 * own transaction and the select-time update; both only ever set a NULL `step_id`. Issue 1474
 * (design D8) publishes them: the inserted step's offset, the closed segment's row and the snapshot's
 * segment rows are read here.
 */
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import type { Turn } from "./store.js";
import { requireChanges, runOwnedTransaction } from "./store-branch.js";
import { createThinkingMsStore, storedThinking } from "./store-thinking.js";

export interface StartStepInput {
  ordinal: number;
  name: string;
  detail: string;
  /** The queued approval's request id the step takes (approval-pairing.ts rule 1). */
  approval?: string | undefined;
}

/** The new step, its stored `body_offset` and the id of the approval row it paired (or null). */
export interface StartedStep {
  stepId: number;
  bodyOffset: number;
  approvalId: number | null;
}

/** One `chat_thinking_segments` row as the snapshot carries it (chat-sessions「会话 REST」). */
export interface ThinkingSegment {
  bodyOffset: number;
  thinkingOffset: number;
  thinkingLength: number | null;
  stepsBefore: number;
  thinkingMs: number | null;
}

/** A closed segment row: every value is set (`thinking.end`'s `segment`). */
export type ClosedSegment = { [K in keyof ThinkingSegment]: number };

const INSERT_STEP = `INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, body_offset)
           SELECT ?, ?, ?, ?, 'running', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM chat_messages
             WHERE id = ? AND session_id = ? AND role = 'assistant' AND status = 'running'
           )`;

const APPROVAL_TOOL = "SELECT tool FROM chat_approvals WHERE message_id = ? AND request_id = ?";

/** The tool of the message's approval row for `requestId`; undefined without one. */
export function approvalTool(
  db: DatabaseSync,
  messageId: number,
  requestId: string,
): string | undefined {
  const row = db.prepare(APPROVAL_TOOL).get(messageId, requestId) as { tool: string } | undefined;
  return row === undefined ? undefined : String(row.tool);
}

const PAIR_APPROVAL = `UPDATE chat_approvals SET step_id = ?
           WHERE message_id = ? AND request_id = ? AND step_id IS NULL RETURNING id`;

/** One statement, so one transaction; the paired row's id, or null when no row changed. */
export function pairApproval(
  db: DatabaseSync,
  messageId: number,
  requestId: string,
  stepId: number,
): number | null {
  const row = db.prepare(PAIR_APPROVAL).get(stepId, messageId, requestId) as
    | { id: number }
    | undefined;
  return row === undefined ? null : Number(row.id);
}

/** Inserts the running step row of the current `turn` (not_found without one) and pairs it. */
export function startStep(
  db: DatabaseSync,
  turn: Turn | undefined,
  activeSteps: Map<number, number>,
  input: StartStepInput,
): StartedStep {
  if (turn === undefined) {
    throw new HttpError("not_found");
  }
  turn.progress = true;
  const now = Date.now();
  const bodyOffset = turn.publishedLength;
  const started = runOwnedTransaction(db, "step start rollback failed", () => {
    const receipt = db
      .prepare(INSERT_STEP)
      .run(
        turn.assistantMessageId,
        input.ordinal,
        input.name,
        input.detail,
        now,
        bodyOffset,
        turn.assistantMessageId,
        turn.sessionId,
      );
    requireChanges(receipt.changes, 1, "step insert");
    const stepId = Number(receipt.lastInsertRowid);
    const { approval } = input;
    const paired =
      approval === undefined ? null : pairApproval(db, turn.assistantMessageId, approval, stepId);
    return { stepId, bodyOffset, approvalId: paired };
  });
  activeSteps.set(started.stepId, turn.assistantMessageId);
  return started;
}

/** Issue 1472 (design D3/D4): the thinking span's two writes, each one transaction. */
export interface ThinkingSegmentStore {
  /** Span opens: `thinking_ms` NULL and the segment row (length and ms NULL); the row id. */
  openThinkingSegment(messageId: number): number;
  /** Span closes: the message's total, then the row's length (stored now − offset) and ms. */
  closeThinkingSegment(
    messageId: number,
    segmentId: number,
    totalMs: number,
    ms: number,
  ): ClosedSegment;
}

// `steps_before` counts the message's step rows: a step row exists from its step.start on.
const INSERT_SEGMENT = `INSERT INTO chat_thinking_segments(message_id, body_offset, thinking_offset, steps_before)
           VALUES (?, ?, ?, (SELECT COUNT(*) FROM chat_steps WHERE message_id = ?))`;
const SEGMENT_COLUMNS = `body_offset AS bodyOffset, thinking_offset AS thinkingOffset,
           thinking_length AS thinkingLength, steps_before AS stepsBefore, thinking_ms AS thinkingMs`;
// The published segment is the row this UPDATE wrote, read back by the same statement.
const CLOSE_SEGMENT = `UPDATE chat_thinking_segments SET thinking_length = ? - thinking_offset, thinking_ms = ?
           WHERE id = ? AND message_id = ? RETURNING ${SEGMENT_COLUMNS}`;
const SESSION_SEGMENTS = `SELECT message_id AS messageId, ${SEGMENT_COLUMNS} FROM chat_thinking_segments
           WHERE message_id IN (SELECT id FROM chat_messages WHERE session_id = ? AND role = 'assistant')
           ORDER BY id ASC`;

/**
 * Offsets and lengths are UTF-16 code units of the stored `thinking` (the truncation mark included,
 * never the code points the cap counts), so a segment after the cap has length 0. The body offset
 * is the current turn's published length; a message without one is not_found, as for a step.
 */
export function createThinkingSegmentStore(
  db: DatabaseSync,
  turnOf: (messageId: number) => Pick<Turn, "publishedLength"> | undefined,
): ThinkingSegmentStore {
  const durations = createThinkingMsStore(db);
  const thinkingLength = (messageId: number) => storedThinking(db, messageId)?.length ?? 0;
  return {
    openThinkingSegment(messageId) {
      const turn = turnOf(messageId);
      if (turn === undefined) {
        throw new HttpError("not_found");
      }
      return runOwnedTransaction(db, "thinking segment open rollback failed", () => {
        durations.clearThinkingMs(messageId);
        const receipt = db
          .prepare(INSERT_SEGMENT)
          .run(messageId, turn.publishedLength, thinkingLength(messageId), messageId);
        requireChanges(receipt.changes, 1, "thinking segment insert");
        return Number(receipt.lastInsertRowid);
      });
    },
    closeThinkingSegment(messageId, segmentId, totalMs, ms) {
      return runOwnedTransaction(db, "thinking segment close rollback failed", () => {
        durations.setThinkingMs(messageId, totalMs);
        const rows = db
          .prepare(CLOSE_SEGMENT)
          .all(thinkingLength(messageId), ms, segmentId, messageId) as unknown as ClosedSegment[];
        requireChanges(rows.length, 1, "thinking segment close");
        return { ...(rows[0] as ClosedSegment) };
      });
    },
  };
}

/** Every segment row of the session's messages by message id, each message's in row id order. */
export function thinkingSegmentsBySession(
  db: DatabaseSync,
  sessionId: string,
): Map<number, ThinkingSegment[]> {
  const byMessage = new Map<number, ThinkingSegment[]>();
  const rows = db.prepare(SESSION_SEGMENTS).all(sessionId) as unknown as Array<
    ThinkingSegment & { messageId: number }
  >;
  for (const { messageId, ...segment } of rows) {
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), segment]);
  }
  return byMessage;
}
