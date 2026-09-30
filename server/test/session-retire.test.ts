/**
 * Issue #516 public supervisor retire: the deletion recycle primitive over a real fake-omp child
 * and real SSE subscribers. Expected values are the pre-retire observations (tokens, cursor,
 * full-table rows, streamed bytes), not a second model of the supervisor.
 */
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetainedEvent } from "../src/sessions/stream/ring-buffer.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  collected,
  eventCount,
  type OpenStream,
  openEventStream,
  readUntil,
} from "./session-sse-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import {
  createRealFakeRuntime,
  createSession,
  openRecordingSession,
  type RecordingWorld,
  requiredCall,
  requiredToken,
  waitForTurn,
} from "./session-supervisor-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

type TableSnapshot = Record<string, unknown[]>;

/** Every row of every table in the database, ordered by rowid. */
function snapshotTables(db: DatabaseSync): TableSnapshot {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const snapshot: TableSnapshot = {};
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    snapshot[name] = db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all();
  }
  return snapshot;
}

async function promptToDone(world: RecordingWorld, session: string, text: string): Promise<void> {
  const response = await postPrompt(
    world.fixture.app,
    session,
    world.cookie,
    JSON.stringify({ message: text }),
  );
  expect(response.statusCode).toBe(202);
  await waitForTurn(world.fixture, session, "done");
}

/** Lets any in-flight SSE bytes reach the collected buffer before a byte comparison. */
async function settle(streams: readonly OpenStream[]): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    for (const stream of streams) {
      stream.resume();
    }
    await waitImmediate();
  }
}

function childAt(runtime: ReturnType<typeof createRealFakeRuntime>, index: number) {
  const child = runtime.children[index];
  if (child === undefined) {
    throw new Error(`missing fake-omp child ${index}`);
  }
  return child;
}

function recorder() {
  const delivered: RetainedEvent[] = [];
  let ended = 0;
  return {
    delivered,
    get ended() {
      return ended;
    },
    deliver(event: RetainedEvent) {
      delivered.push(event);
    },
    onEnd() {
      ended += 1;
    },
  };
}

async function openIdleWorld() {
  const runtime = createRealFakeRuntime();
  const world = await openRecordingSession(runtime.runtime);
  return { runtime, world };
}

describe("SessionSupervisor public retire", () => {
  it("retires an idle generation: child exits, token revoked, cap released, SSE ends, no rows", {
    timeout: 15_000,
  }, async () => {
    const { runtime, world } = await openIdleWorld();
    const { fixture, session, cookie } = world;
    try {
      await promptToDone(world, session, "first");
      const token = requiredToken(requiredCall(runtime.calls, 0).token);
      const child = childAt(runtime, 0);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(fixture.tokens.lookup(token)).toBe(session);
      expect(fixture.supervisor.liveProcessCount()).toBe(1);
      const cursor = fixture.supervisor.streamCursor(session);
      const lastSeq = cursor.seq;
      if (lastSeq === null) {
        throw new Error("idle generation must still own its ring");
      }
      const epoch = cursor.epoch;

      const fresh = await openEventStream(fixture, session, cookie);
      const replaying = await openEventStream(fixture, session, cookie, `${epoch}:${lastSeq - 1}`);
      const replayBytes = await readUntil(replaying, (text) => text.includes("event: turn.end"));
      await settle([fresh, replaying]);
      expect(collected(fresh)).toBe("");
      expect(collected(replaying)).toBe(replayBytes);
      expect(eventCount(replayBytes)).toBe(1);
      expect(replayBytes.startsWith(`id: ${epoch}:${lastSeq}\nevent: turn.end\n`)).toBe(true);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(2);
      expect(fresh.raw.writableEnded).toBe(false);
      expect(replaying.raw.writableEnded).toBe(false);

      const tables = snapshotTables(fixture.db);
      expect(Object.keys(tables)).toEqual(
        expect.arrayContaining([
          "chat_sessions",
          "chat_messages",
          "chat_steps",
          "chat_approvals",
          "audit_events",
        ]),
      );
      const eventsBefore = world.events.length;
      const spawnsBefore = runtime.calls.length;

      await fixture.supervisor.retire(session);

      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(fixture.tokens.lookup(token)).toBeNull();
      expect(fixture.supervisor.liveProcessCount()).toBe(0);

      await settle([fresh, replaying]);
      expect(fresh.raw.writableEnded, "fresh SSE subscriber response ends").toBe(true);
      expect(replaying.raw.writableEnded, "replaying SSE subscriber response ends").toBe(true);
      expect(collected(fresh)).toBe("");
      expect(collected(replaying)).toBe(replayBytes);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);

      expect(snapshotTables(fixture.db)).toEqual(tables);
      expect(runtime.calls).toHaveLength(spawnsBefore);
      expect(world.events).toHaveLength(eventsBefore);
      expect(world.errors).toEqual([]);

      expect(fixture.supervisor.streamCursor(session)).toEqual({ epoch, seq: null });
      const late = fixture.supervisor.subscribe(session, `${epoch}:${lastSeq}`, () => {
        throw new Error("a dropped ring must not deliver");
      });
      expect(late.mode).toBe("gap");
      expect(late.replay).toEqual([]);
      late.unsubscribe();
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      await world.fixture.close();
    }
  });

  it("repeats and no-generation retires are side-effect free; a later prompt gets epoch + 1", {
    timeout: 15_000,
  }, async () => {
    const { runtime, world } = await openIdleWorld();
    const { fixture, session, cookie } = world;
    try {
      await promptToDone(world, session, "first");
      const epoch = fixture.supervisor.streamCursor(session).epoch;
      await fixture.supervisor.retire(session);
      expect(runtime.calls).toHaveLength(1);

      const afterFirst = snapshotTables(fixture.db);
      await fixture.supervisor.retire(session);
      expect(runtime.calls).toHaveLength(1);
      expect(snapshotTables(fixture.db)).toEqual(afterFirst);
      expect(fixture.supervisor.streamCursor(session)).toEqual({ epoch, seq: null });
      expect(fixture.supervisor.liveProcessCount()).toBe(0);

      const untouched = await createSession(fixture.app, cookie);
      const untouchedEpoch = fixture.supervisor.streamCursor(untouched).epoch;
      const stream = await openEventStream(fixture, untouched, cookie);
      await settle([stream]);
      expect(collected(stream)).toBe("");
      expect(fixture.supervisor.sessionStreamSubscriberCount(untouched)).toBe(1);
      const beforeUntouched = snapshotTables(fixture.db);

      await fixture.supervisor.retire(untouched);

      await settle([stream]);
      expect(stream.raw.writableEnded, "no-generation SSE subscriber response ends").toBe(true);
      expect(collected(stream)).toBe("");
      expect(fixture.supervisor.sessionStreamSubscriberCount(untouched)).toBe(0);
      expect(runtime.calls).toHaveLength(1);
      expect(snapshotTables(fixture.db)).toEqual(beforeUntouched);
      expect(fixture.supervisor.streamCursor(untouched)).toEqual({
        epoch: untouchedEpoch,
        seq: null,
      });
      expect(fixture.supervisor.liveProcessCount()).toBe(0);

      await promptToDone(world, session, "after retire");
      expect(runtime.calls).toHaveLength(2);
      const next = fixture.supervisor.streamCursor(session);
      expect(next.epoch).toBe(epoch + 1);
      expect(sessionRow(fixture.db, session).stream_epoch).toBe(epoch + 1);
      expect(fixture.supervisor.liveProcessCount()).toBe(1);
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });

  it("only removes a three-argument subscriber, which then receives nothing further", {
    timeout: 15_000,
  }, async () => {
    const { runtime, world } = await openIdleWorld();
    const { fixture, session } = world;
    try {
      await promptToDone(world, session, "first");
      const epoch = fixture.supervisor.streamCursor(session).epoch;
      const legacy = recorder();
      const subscription = fixture.supervisor.subscribe(session, null, legacy.deliver);
      expect(subscription.mode).toBe("fresh");
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);

      await fixture.supervisor.retire(session);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
      expect(legacy.delivered).toEqual([]);

      const control = recorder();
      const controlSubscription = fixture.supervisor.subscribe(session, null, control.deliver);
      await promptToDone(world, session, "after retire");
      expect(runtime.calls).toHaveLength(2);
      expect(legacy.delivered).toEqual([]);
      expect(control.delivered.length).toBeGreaterThan(0);
      expect(control.delivered.every((event) => event.id.startsWith(`${epoch + 1}:`))).toBe(true);
      expect(control.delivered.at(-1)?.type).toBe("turn.end");
      controlSubscription.unsubscribe();
      subscription.unsubscribe();
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });

  it("ends a subscriber registered while retire awaits native exit", {
    timeout: 15_000,
  }, async () => {
    const { runtime, world } = await openIdleWorld();
    const { fixture, session } = world;
    try {
      await promptToDone(world, session, "first");
      const child = childAt(runtime, 0);
      const late = recorder();

      const pending = fixture.supervisor.retire(session);
      fixture.supervisor.subscribe(session, null, late.deliver, late.onEnd);
      expect(late.ended).toBe(0);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);

      await pending;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(late.ended).toBe(1);
      expect(late.delivered).toEqual([]);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });

  it("isolates a throwing onEnd from the other subscribers of the session", async () => {
    const { world } = await openIdleWorld();
    const { fixture, session } = world;
    try {
      let thrown = 0;
      const survivor = recorder();
      fixture.supervisor.subscribe(
        session,
        null,
        () => {},
        () => {
          thrown += 1;
          throw new Error("controlled onEnd failure");
        },
      );
      fixture.supervisor.subscribe(session, null, survivor.deliver, survivor.onEnd);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(2);

      await expect(fixture.supervisor.retire(session)).resolves.toBeUndefined();
      expect(thrown).toBe(1);
      expect(survivor.ended).toBe(1);
      expect(survivor.delivered).toEqual([]);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });
});
