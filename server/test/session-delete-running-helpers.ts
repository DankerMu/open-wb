/**
 * Issue #526 DELETE running-path plumbing over the #473/#490 stop worlds (production createApp →
 * registerSessions, real fake-omp children, per-child stdin record, injected clock): per-test
 * ownership that closes retained-fault worlds and fails on any unhandled rejection, a TEMP trigger
 * recording what the session looked like the moment its row was deleted, SSE events read back
 * from real bytes, and the owned session file every 204 must unlink (the #525 constraint: it lives
 * in the owner session dir, so no DELETE reports an outside path).
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, expect } from "vitest";
import { type ApprovalWorld, parseSse, settle } from "./session-approval-helpers.js";
import { JSON_TYPE, ownedFile, ownerSessionDir, presetFile } from "./session-delete-helpers.js";
import { collected, type OpenStream } from "./session-sse-helpers.js";
import { collectRejections, openStopWorld, type RejectionLog } from "./session-stop-helpers.js";
import { closeAfterRetainedFault } from "./session-supervisor-helpers.js";

/** One recorded chat_sessions delete: the row's status, its assistants' and approvals' state. */
export interface DeletedState {
  id: string;
  session: string;
  assistants: string | null;
  approvals: string | null;
}

/**
 * Per-test ownership for one test file: every opened world is closed after the case (a world
 * marked `faulted` retained a fault, so its shutdown rejection is expected) and no unhandled
 * rejection may surface during the case or its close.
 */
export function runningWorlds() {
  const worlds = new Map<ApprovalWorld, boolean>();
  let rejections: RejectionLog | undefined;
  beforeEach(() => {
    rejections = collectRejections();
  });
  afterEach(async () => {
    try {
      for (const [world, faulted] of worlds) {
        await closeAfterRetainedFault(world.fixture, faulted);
      }
      worlds.clear();
      await settle();
      expect(rejections?.reasons).toEqual([]);
    } finally {
      rejections?.dispose();
    }
  });
  return {
    /** Any fake-omp scenario: the stop world spawns lazily, so the first prompt uses it. */
    async open(scenario: string): Promise<ApprovalWorld> {
      const world = await openStopWorld("abort-ok");
      world.rt.setScenario(scenario);
      worlds.set(world, false);
      return world;
    },
    faulted(world: ApprovalWorld): void {
      worlds.set(world, true);
    },
  };
}

/**
 * A TEMP table plus a TEMP BEFORE DELETE trigger on chat_sessions: each deleted row records its
 * own status, its assistant message statuses and its approval decisions as they were right then.
 */
export function observeDeletes(db: DatabaseSync): () => DeletedState[] {
  db.exec(`CREATE TEMP TABLE deleted_states(id TEXT, session TEXT, assistants TEXT, approvals TEXT);
    CREATE TEMP TRIGGER observe_session_delete BEFORE DELETE ON chat_sessions BEGIN
      INSERT INTO deleted_states SELECT OLD.id, OLD.status,
        (SELECT group_concat(status, ',') FROM chat_messages
          WHERE session_id = OLD.id AND role = 'assistant'),
        (SELECT group_concat(COALESCE(a.decision, 'pending'), ',') FROM chat_approvals AS a
          JOIN chat_messages AS m ON m.id = a.message_id WHERE m.session_id = OLD.id);
    END`);
  return () =>
    (
      db
        .prepare(
          "SELECT id, session, assistants, approvals FROM temp.deleted_states ORDER BY rowid",
        )
        .all() as unknown as DeletedState[]
    ).map((row) => ({ ...row }));
}

/** A real test-written session file in the owner session dir, preset as the row's file. */
export function presetOwnedFile(world: ApprovalWorld): string {
  const file = ownedFile(ownerSessionDir(world.rt.runtime.stateDir));
  presetFile(world.fixture.db, world.session, file);
  expect(existsSync(file)).toBe(true);
  return file;
}

/** The events (name + data) a stream received as real SSE bytes, replay and live alike. */
function sseEvents(stream: OpenStream): Array<{ event: string; data: unknown }> {
  return parseSse(collected(stream)).map(({ event, data }) => ({ event, data }));
}

/**
 * The stream ended and its last event is the only turn.end, `stopped`; with `approvalId`, a
 * `deny` approval.resolved for it came before that turn.end.
 */
export function expectStoppedTail(stream: OpenStream, messageId: number, approvalId?: number) {
  const events = sseEvents(stream);
  const end = { event: "turn.end", data: { messageId, status: "stopped" } };
  expect(events.filter((entry) => entry.event === "turn.end")).toEqual([end]);
  expect(events.at(-1)).toEqual(end);
  if (approvalId !== undefined) {
    const resolved = events.filter((entry) => entry.event === "approval.resolved");
    expect(resolved).toEqual([
      { event: "approval.resolved", data: { messageId, approvalId, decision: "deny" } },
    ]);
  }
  expect(stream.raw.writableEnded).toBe(true);
}

export function patchTitle(
  app: FastifyInstance,
  session: string,
  cookie: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "PATCH",
    url: `/api/sessions/${session}`,
    headers: { cookie, "content-type": JSON_TYPE },
    payload: JSON.stringify({ title: "x" }),
  });
}

export function getMessages(
  app: FastifyInstance,
  session: string,
  cookie: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/api/sessions/${session}/messages`,
    headers: { cookie },
  });
}
