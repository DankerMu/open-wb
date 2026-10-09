/**
 * Issue #526 DELETE /api/sessions/:id, running path (parent s1c-session-metadata-presentation tasks
 * 4.3c, design D3 step 2): under the DELETE's own control claim the stop sequence runs, the DELETE
 * waits for the turn's terminal persistence or its compensated admission, then the #525 tail
 * deletes. Evidence numbers follow the fixture design "Required evidence" (7 lives in
 * session-delete.test.ts). Production createApp → registerSessions over real fake-omp children,
 * real SQLite (TEMP triggers observe the pre-delete state and inject failures), the injected clock
 * for the 8000 ms grace, real SSE bytes and `GET /api/audit`; store cases run on a bare store.
 */
import { existsSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import type { ChatEvent } from "../src/sessions/events.js";
import { createSessionStore } from "../src/sessions/store.js";
import {
  approvalAuditCount,
  pendingApproval,
  prompted,
  REAL,
  settle,
  spawnedAt,
  waitForEvent,
} from "./session-approval-helpers.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import {
  auditEvents,
  auditRows,
  deleteEvent,
  expectDeleted,
  JSON_TYPE,
  NOT_FOUND_WIRE,
  ownedArtifactDir,
  parkedDelete,
  sendDelete,
  sessionState,
  temporaryWorkspaceDeleteEvent,
  wireShape,
} from "./session-delete-helpers.js";
import {
  expectStoppedTail,
  getMessages,
  observeDeletes,
  patchTitle,
  presetOwnedFile,
  runningWorlds,
} from "./session-delete-running-helpers.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  postPrompt,
  SESSION_BUSY_ENVELOPE,
} from "./session-rest-helpers.js";
import { openEventStream } from "./session-sse-helpers.js";
import {
  abortCount,
  expectAnswersThenAbort,
  expectNoError,
  GRACE_MS,
  heldTurn,
  history,
  turnEnds,
} from "./session-stop-helpers.js";
import { delayReady, ended } from "./session-stop-intent-helpers.js";
import { captureThrown } from "./session-store-helpers.js";
import {
  assistantIdFor,
  containsMessage,
  createSession,
  expectSettled,
  OWNER_ID,
  waitFor,
} from "./session-supervisor-helpers.js";
import { isLive, waitExited } from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";
import { workspaceOf } from "./support/temporary-workspace.js";

const { open, faulted } = runningWorlds();

const SETTLE_BLOCKED = "stopped settle blocked";
const BLOCK_STOPPED = `CREATE TEMP TRIGGER block_stopped_settle BEFORE UPDATE OF status ON chat_messages
  WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(ABORT, '${SETTLE_BLOCKED}'); END`;
const INSERT_BLOCKED = "approval insert blocked";
const BLOCK_APPROVAL = `CREATE TEMP TRIGGER block_approval_insert BEFORE INSERT ON chat_approvals
  BEGIN SELECT RAISE(ABORT, '${INSERT_BLOCKED}'); END`;

function stopped(id: string, approvals: string | null = null) {
  return [{ id, session: "stopped", assistants: "stopped", approvals }];
}

describe("DELETE of a running session stops it first (evidence 1–3)", () => {
  it(
    "1 a pending approval is denied, then one abort; both streams see resolved and one stopped end",
    REAL,
    async () => {
      const world = await open("approval-then-abort");
      const { app, db, supervisor } = world.fixture;
      const row = await pendingApproval(world);
      const child = spawnedAt(world, 0);
      const streams = [
        await openEventStream(world.fixture, world.session, world.cookie),
        await openEventStream(world.fixture, world.session, world.cookie),
      ];
      for (const stream of streams) {
        stream.resume();
      }
      await settle();
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(2);
      const deletes = observeDeletes(db);
      const file = presetOwnedFile(world);
      const artifacts = ownedArtifactDir(file);
      const admin = await cookieFor(app, "lisi");
      const before = await auditEvents(app, admin);
      const space = workspaceOf(db, world.session);

      expectDeleted(await sendDelete(app, world.session, world.cookie));

      expect(deletes()).toEqual(stopped(world.session, "deny"));
      expectAnswersThenAbort(child.stdin, [["r1", "Deny"]]);
      await settle();
      for (const stream of streams) {
        expectStoppedTail(stream, row.message_id, row.id);
      }
      expect(isLive(child.child)).toBe(false);
      expect(sessionState(db, world.session).row).toBeUndefined();
      expect(existsSync(file)).toBe(false);
      expect(existsSync(artifacts)).toBe(false);
      const after = await auditEvents(app, admin);
      // Newest first: the session's own temporary workspace (#930) went after the session row.
      expect(after.slice(3)).toEqual(before);
      expect(after[0]).toEqual(
        temporaryWorkspaceDeleteEvent(world.session, space, world.rt.runtime.sandboxRoot),
      );
      expect(after[1]).toEqual(deleteEvent(world.session, file, 2, space));
      expect(after[2]).toMatchObject({
        kind: "session.approval",
        actorId: OWNER_ID,
        detail: {
          sessionId: world.session,
          messageId: row.message_id,
          tool: "bash",
          decision: "deny",
        },
      });
      expectNoError(world);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "2 abort-ignored: DELETE waits out the 8000 ms grace untombstoned, then deletes the stopped turn",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      const { db, supervisor } = world.fixture;
      await heldTurn(world);
      const assistant = assistantIdFor(world.fixture, world.session);
      const deletes = observeDeletes(db);
      const file = presetOwnedFile(world);
      const { child, stdin } = spawnedAt(world, 0);

      const { pending } = await parkedDelete(world);
      const observed = observePromise(pending);
      expect(abortCount(stdin)).toBe(1);
      // The tombstone starts at retire, after the wait: a stream opened during the wait subscribes.
      const subscribers = supervisor.sessionStreamSubscriberCount(world.session);
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();
      await settle();
      expect(stream.raw.writableEnded).toBe(false);
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(subscribers + 1);
      world.clock.advance(GRACE_MS - 1);
      await settle();
      expect(observed.outcome).toBe("pending");
      expect(isLive(child)).toBe(true);
      expect(deletes()).toEqual([]);

      world.clock.advance(1);
      expectDeleted(await pending);
      await settle();
      expect(stream.raw.writableEnded).toBe(true);
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(0);
      expect(deletes()).toEqual(stopped(world.session));
      expect(turnEnds(world)).toEqual([ended(assistant, "stopped")]);
      expectNoError(world);
      expect(isLive(child)).toBe(false);
      expect(sessionState(db, world.session).row).toBeUndefined();
      expect(existsSync(file)).toBe(false);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "3 a user stop while DELETE waits joins it: 202 {}, one abort frame in total",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      const { app } = world.fixture;
      await heldTurn(world);
      presetOwnedFile(world);
      const { stdin } = spawnedAt(world, 0);

      const { pending } = await parkedDelete(world);
      const stop = await postSessionAction(app, "stop", world.session, world.cookie);
      expect([stop.statusCode, stop.payload]).toEqual([202, "{}"]);
      await settle();
      expect(abortCount(stdin)).toBe(1);

      world.clock.advance(GRACE_MS);
      expectDeleted(await pending);
      expect(abortCount(stdin)).toBe(1);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("DELETE while the stop intent meets a failed acquisition (evidence 4)", () => {
  it(
    "4 the prompt fails 502 and is compensated; DELETE 204; the id is gone, no claim left",
    REAL,
    async () => {
      const world = await open("slow-ready");
      const { app, db, supervisor } = world.fixture;
      delayReady(world, 60_000);
      const admin = await cookieFor(app, "lisi");
      const before = await auditEvents(app, admin);
      const space = workspaceOf(db, world.session);
      const prompt = postPrompt(
        app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "never ready" }),
      );
      const promptObserved = observePromise(prompt);
      const spawned = await waitFor(() => world.spawned[0], "slow-ready child");

      const { pending } = await parkedDelete(world);
      expect(promptObserved.outcome).toBe("pending");
      spawned.child.kill("SIGKILL");

      expectEnvelope(await prompt, 502, AGENT_UNAVAILABLE_ENVELOPE);
      expectDeleted(await pending);
      expect(spawned.stdin).toEqual([]);
      const after = await auditEvents(app, admin);
      // Newest first: the session's own temporary workspace (#930) went after the session row.
      expect(after.slice(2)).toEqual(before);
      expect(after.slice(0, 2)).toEqual([
        temporaryWorkspaceDeleteEvent(world.session, space, world.rt.runtime.sandboxRoot),
        deleteEvent(world.session, null, 0, space),
      ]);
      const gone = [
        await sendDelete(app, world.session, world.cookie),
        await patchTitle(app, world.session, world.cookie),
        await getMessages(app, world.session, world.cookie),
      ];
      expect(gone.map(wireShape)).toEqual([NOT_FOUND_WIRE, NOT_FOUND_WIRE, NOT_FOUND_WIRE]);
      expect(supervisor.controlHeld(world.session)).toBe(false);
      expect(sessionState(db, world.session).row).toBeUndefined();

      world.rt.setScenario("normal");
      const other = await createSession(app, world.cookie);
      await prompted(world, other);
      await waitForEvent(world, "turn.end", 1, other);
      await settle();
      expectDeleted(await sendDelete(app, other, world.cookie));
    },
  );
});

describe("DELETE waiting on a stopped turn holds the control claim (evidence 5)", () => {
  it(
    "5 prompt, regenerate, fork and a second DELETE are 409 with no change; then 204, then 404",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      const { app, db } = world.fixture;
      await heldTurn(world);
      presetOwnedFile(world);
      const user = (await history(world)).messages[0]?.id ?? -1;
      const { stdin } = spawnedAt(world, 0);

      const { pending } = await parkedDelete(world);
      const before = sessionState(db, world.session);
      const audits = auditRows(db);
      const frames = stdin.length;
      const concurrent = [
        await postPrompt(app, world.session, world.cookie, JSON.stringify({ message: "x" })),
        await postSessionAction(app, "regenerate", world.session, world.cookie),
        await postSessionAction(app, "fork", world.session, world.cookie, {
          name: "fork body",
          payload: JSON.stringify({ messageId: user }),
          contentType: JSON_TYPE,
        }),
        await sendDelete(app, world.session, world.cookie),
      ];
      for (const response of concurrent) {
        expectEnvelope(response, 409, SESSION_BUSY_ENVELOPE);
      }
      await settle();
      expect(sessionState(db, world.session)).toEqual(before);
      expect(auditRows(db)).toBe(audits);
      expect(stdin).toHaveLength(frames);
      expect(world.rt.calls).toHaveLength(1);

      world.clock.advance(GRACE_MS);
      expectDeleted(await pending);
      expect(wireShape(await sendDelete(app, world.session, world.cookie))).toEqual(NOT_FOUND_WIRE);
    },
  );
});

describe("DELETE when the turn cannot settle (evidence 6, 8)", () => {
  it(
    "6 a failed terminal persistence is a generic 500; rows stay, claim and tombstone lift",
    REAL,
    async () => {
      const world = await open("abort-ok");
      faulted(world);
      const { app, db, supervisor } = world.fixture;
      await heldTurn(world);
      db.exec(BLOCK_STOPPED);
      const before = sessionState(db, world.session);
      expect(before.row).toMatchObject({ status: "running" });
      const audits = auditRows(db);

      const response = await sendDelete(app, world.session, world.cookie);

      expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
      expect(sessionState(db, world.session)).toEqual(before);
      expect(auditRows(db)).toBe(audits);
      expect(supervisor.controlHeld(world.session)).toBe(false);
      await waitFor(() => (world.errors.length > 0 ? true : undefined), "retained settle fault");
      expect(containsMessage(world.errors[0], SETTLE_BLOCKED)).toBe(true);
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      await settle();
      expect(stream.raw.writableEnded).toBe(false);
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(1);
      stream.abort();
    },
  );

  it(
    "8 a turn orphaned by its pump's infra fault fails DELETE with a bounded 500, twice",
    REAL,
    async () => {
      const world = await open("approval");
      faulted(world);
      const { app, db, supervisor } = world.fixture;
      db.exec(BLOCK_APPROVAL);
      await prompted(world);
      await waitFor(() => (world.errors.length > 0 ? true : undefined), "retained approval fault");
      await waitExited(spawnedAt(world, 0).child, "retired child");
      await waitFor(
        () => (supervisor.liveProcessCount() === 0 ? true : undefined),
        "released process",
      );
      await settle();
      expect(containsMessage(world.errors[0], INSERT_BLOCKED)).toBe(true);
      const before = sessionState(db, world.session);
      expect(before.row).toMatchObject({ status: "running" });
      const audits = auditRows(db);

      for (const [attempt, boundMs] of [
        ["first DELETE of the orphaned turn", 5_000],
        ["second DELETE of the orphaned turn", 1_000],
      ] as const) {
        const response = (await expectSettled(
          sendDelete(app, world.session, world.cookie),
          attempt,
          "resolved",
          boundMs,
        )) as LightMyRequestResponse;
        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(supervisor.controlHeld(world.session)).toBe(false);
        expect(sessionState(db, world.session)).toEqual(before);
        expect(auditRows(db)).toBe(audits);
      }
    },
  );
});

describe("store turn release signal (evidence 9)", () => {
  const FLUSH_BLOCKED = "flush blocked";
  const openStore = () => {
    const db = openDb(":memory:");
    const store = createSessionStore(db, {
      onFlushError: () => undefined,
      composer: TEST_COMPOSER,
    });
    const { id } = store.create(OWNER_ID);
    return { db, store, id };
  };

  it("9a no turn resolves at once; rollbackPrompt and a terminal flip resolve the wait", async () => {
    const { db, store, id } = openStore();
    try {
      await expect(store.turnReleased(id)).resolves.toBeUndefined();
      await expect(store.turnReleased("f".repeat(32))).resolves.toBeUndefined();
      const first = store.acceptPrompt(id, OWNER_ID, "one");
      const rolledBack = store.turnReleased(id);
      const observed = observePromise(rolledBack);
      await settle();
      expect(observed.outcome).toBe("pending");
      expect(store.rollbackPrompt(first.assistantMessageId)).toBe(true);
      await expect(rolledBack).resolves.toBeUndefined();

      const second = store.acceptPrompt(id, OWNER_ID, "two");
      const finished = store.turnReleased(id);
      expect(store.finishTurn(second.assistantMessageId, "stopped")).toBe(true);
      await expect(finished).resolves.toBeUndefined();
      store.faultTurn(second.assistantMessageId, new Error("released already"));
      await expect(store.turnReleased(id)).resolves.toBeUndefined();
    } finally {
      store.close();
      db.close();
    }
  });

  it("9b a delta flush fault rejects the wait with that error; later appends and faults keep it", async () => {
    const { db, store, id } = openStore();
    try {
      const { assistantMessageId } = store.acceptPrompt(id, OWNER_ID, "flush");
      const content = () =>
        db.prepare("SELECT content FROM chat_messages WHERE id = ?").get(assistantMessageId);
      const persisted = content();
      const waiting = store.turnReleased(id);
      db.exec(`CREATE TEMP TRIGGER block_flush BEFORE UPDATE OF content ON chat_messages
        BEGIN SELECT RAISE(ABORT, '${FLUSH_BLOCKED}'); END`);
      const thrown = captureThrown(() => store.appendDelta(assistantMessageId, "x".repeat(2_048)));
      expect(containsMessage(thrown, FLUSH_BLOCKED)).toBe(true);
      await expect(waiting).rejects.toBe(thrown);
      await expect(store.turnReleased(id)).rejects.toBe(thrown);
      db.exec("DROP TRIGGER block_flush");
      // Sticky: with the trigger gone a flush-sized append still rethrows and writes nothing.
      expect(captureThrown(() => store.appendDelta(assistantMessageId, "y".repeat(2_048)))).toBe(
        thrown,
      );
      expect(content()).toEqual(persisted);
      await expect(store.turnReleased(id)).rejects.toBe(thrown);
      store.faultTurn(assistantMessageId, new Error("orphan"));
      await expect(store.turnReleased(id)).rejects.toBe(thrown);
    } finally {
      store.close();
      db.close();
    }
  });

  it("9c a failed rollback compensation throws and rejects the wait with the same error", async () => {
    const { db, store, id } = openStore();
    try {
      const { assistantMessageId } = store.acceptPrompt(id, OWNER_ID, "compensate");
      const waiting = store.turnReleased(id);
      db.exec(`CREATE TEMP TRIGGER block_rollback BEFORE DELETE ON chat_messages
        BEGIN SELECT RAISE(ABORT, 'rollback blocked'); END`);
      const thrown = captureThrown(() => store.rollbackPrompt(assistantMessageId));
      expect(containsMessage(thrown, "rollback blocked")).toBe(true);
      await expect(waiting).rejects.toBe(thrown);
      await expect(store.turnReleased(id)).rejects.toBe(thrown);
      expect(store.runtimeState(id)?.activeTurn?.assistantMessageId).toBe(assistantMessageId);
      db.exec("DROP TRIGGER block_rollback");
    } finally {
      store.close();
      db.close();
    }
  });

  it("9d faultTurn rejects the in-flight wait and every later one; unknown ids are a no-op", async () => {
    const { db, store, id } = openStore();
    try {
      const { assistantMessageId } = store.acceptPrompt(id, OWNER_ID, "orphan");
      const waiting = store.turnReleased(id);
      const orphan = new Error("turn outlived its event pump");
      store.faultTurn(assistantMessageId + 100, new Error("unknown"));
      expect(observePromise(waiting).outcome).toBe("pending");
      store.faultTurn(assistantMessageId, orphan);
      await expect(waiting).rejects.toBe(orphan);
      await expect(store.turnReleased(id)).rejects.toBe(orphan);
      store.faultTurn(assistantMessageId, new Error("second fault"));
      await expect(store.turnReleased(id)).rejects.toBe(orphan);
    } finally {
      store.close();
      db.close();
    }
  });
});

type Seen = ChatEvent<number> | "end";

/**
 * Characterization of the chat-sessions sentence "retire first awaits the in-flight pump": the
 * pump yields at the terminal approval settlement after the store released the turn, and a retire
 * issued right then still ends the subscriber only after approval.resolved and turn.end. It stays
 * green with the drain removed too: `sealGeneration` refuses while the pump is counted and the
 * subscriber end trails the runtime shutdown await, so the drain is defensive (see #526 report).
 */
describe("supervisor retire after the store release (evidence 10)", () => {
  it(
    "10 retire right after the store release still lets resolved and turn.end reach subscribers",
    REAL,
    async () => {
      const world = await open("approval");
      const { store, supervisor } = world.fixture;
      const row = await pendingApproval(world);
      const seen: Seen[] = [];
      supervisor.subscribe(
        world.session,
        null,
        (retained) => {
          const { id: _id, ...event } = retained;
          seen.push(event as ChatEvent<number>);
        },
        () => {
          seen.push("end");
        },
      );
      const retired = store
        .turnReleased(world.session)
        .then(() => supervisor.retire(world.session));

      spawnedAt(world, 0).child.kill("SIGKILL");
      await retired;

      expect(seen.slice(-3)).toEqual([
        {
          type: "approval.resolved",
          data: { messageId: row.message_id, approvalId: row.id, decision: "deny" },
        },
        { type: "turn.end", data: { messageId: row.message_id, status: "failed" } },
        "end",
      ]);
      expect(seen.filter((event) => event === "end")).toHaveLength(1);
      expect(approvalAuditCount(world.fixture.db)).toBe(1);
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(0);
    },
  );
});
