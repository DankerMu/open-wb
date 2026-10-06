/**
 * Issue #864 task-list pipeline on the production assembly (createApp → registerSessions): real
 * fake-omp `todo` children for the three-turn list, scripted controlled children for held turns,
 * invalid candidates and failed calls. Oracles are the recorded onEvent stream, the ring ids seen
 * by a subscriber, real SSE bytes, the snapshot route and the raw `chat_sessions.todo` column;
 * expected lists are literals from session-todo (copied from the scenario text, not imported).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { TodoRejection } from "../src/sessions/store-todo.js";
import type { RetainedEvent } from "../src/sessions/stream/ring-buffer.js";
import {
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
  waitForEvent,
} from "./session-approval-helpers.js";
import { SESSION_VIEW_KEYS } from "./session-meta-fixtures.js";
import { cookieFor, getSessionMessages, UNKNOWN_SESSION_ID } from "./session-rest-helpers.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import {
  closeAfterRetainedFault,
  closeOnEof,
  containsMessage,
  createControlledRuntime,
  createRealFakeRuntime,
  type OpenSessionOptions,
  openBareSession,
  openRecordingSession,
  type RecordingWorld,
  type RuntimeOptions,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

const T1 = {
  phases: [
    {
      name: "准备",
      tasks: [
        { content: "读取需求", status: "in_progress" },
        { content: "列出要点", status: "pending" },
      ],
    },
    { name: "交付", tasks: [{ content: "输出结论", status: "pending" }] },
  ],
};
const T1_TEXT =
  '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}';
const T3_FIRST_TASKS = [
  { content: "读取需求", status: "completed" },
  { content: "列出要点", status: "in_progress" },
];
/** One fake-omp `todo` turn: the tool call, three text deltas, the terminal. */
const TURN_WITH_UPDATE = [
  "turn.start",
  "step.start",
  "todo.updated",
  "step.end",
  "text.delta",
  "text.delta",
  "text.delta",
  "turn.end",
];
const TURN_WITHOUT_UPDATE = TURN_WITH_UPDATE.filter((type) => type !== "todo.updated");
const SENTINEL = "todo write sentinel";
const SECRET = "任务文本-864";

interface TodoWorld extends RecordingWorld {
  warns: TodoRejection[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function openWorld(
  runtime: RuntimeOptions,
  extra: OpenSessionOptions = {},
  faulted = false,
): Promise<TodoWorld> {
  const warns: TodoRejection[] = [];
  const world = await openRecordingSession(runtime, {
    ...extra,
    warn: (record) => warns.push(record),
  });
  cleanups.push(() => closeAfterRetainedFault(world.fixture, faulted));
  return { ...world, warns };
}

function events(world: RecordingWorld): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

function types(list: ReadonlyArray<{ type: string }>): string[] {
  return list.map((event) => event.type);
}

function todoColumn(db: DatabaseSync, session: string): string | null {
  const [row] = db.prepare("SELECT todo FROM chat_sessions WHERE id = ?").all(session);
  return (row as { todo: string | null }).todo;
}

async function turnDone(world: RecordingWorld): Promise<void> {
  await prompted(world);
  await waitForTurn(world.fixture, world.session, "done");
  await settle();
}

async function snapshotOf(world: RecordingWorld, cookie = world.cookie) {
  const response = await getSessionMessages(world.fixture.app, world.session, cookie);
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

function seqOf(id: string): number {
  return Number(id.slice(id.indexOf(":") + 1));
}

/** Frames of one tool call registered under `name`; `end` is merged into its end frame. */
function call(id: string, name: string, end: Record<string, unknown>): OmpFrame[] {
  return [
    { type: "tool_execution_start", toolCallId: id, toolName: name, args: { op: "view" } },
    { type: "tool_execution_end", toolCallId: id, toolName: name, ...end },
  ];
}

function result(phases: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: "ok" }], details: { op: "view", phases } };
}

const AGENT_END: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };

/** A controlled child that emits agent_start and `frames` on prompt; the test ends the turn. */
async function openScripted(frames: OmpFrame[]): Promise<{ world: TodoWorld; child: FakeChild }> {
  const controlled = createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      for (const frame of frames) {
        child.emitLine(frame);
      }
    });
  });
  const world = await openWorld(controlled.runtime);
  await prompted(world);
  const child = await waitFor(() => controlled.children[0], "controlled child");
  return { world, child };
}

describe("first list: stored, then published right before the call's step.end", () => {
  it(
    "the todo scenario's first turn stores the list and publishes one todo.updated",
    REAL,
    async () => {
      let db: DatabaseSync | undefined;
      const columnsAtPublish: Array<string | null> = [];
      const world = await openWorld(createRealFakeRuntime("todo").runtime, {
        onEvent(session, _epoch, event) {
          if (event.type === "todo.updated" && db !== undefined) {
            columnsAtPublish.push(todoColumn(db, session));
          }
        },
      });
      db = world.fixture.db;
      expect(todoColumn(db, world.session)).toBeNull();
      const ring: RetainedEvent[] = [];
      const subscription = world.fixture.supervisor.subscribe(world.session, null, (event) => {
        ring.push(event);
      });

      await turnDone(world);
      subscription.unsubscribe();

      const published = events(world);
      expect(types(published)).toEqual(TURN_WITH_UPDATE);
      const [start] = ofType(sessionEvents(world), "turn.start");
      const assistant = start?.data.messageId;
      expect(published[2]).toEqual({
        type: "todo.updated",
        data: { messageId: assistant, todo: T1 },
      });
      expect(published[1]).toMatchObject({ type: "step.start", data: { name: "todo" } });
      expect(published[3]).toMatchObject({ type: "step.end", data: { status: "done" } });
      expect(JSON.stringify(published[3])).not.toContain("phases");
      expect(todoColumn(db, world.session)).toBe(T1_TEXT);
      expect(columnsAtPublish).toEqual([T1_TEXT]);

      const { epoch } = world.fixture.supervisor.streamCursor(world.session);
      expect(ring.map((event) => event.id)).toEqual(
        TURN_WITH_UPDATE.map((_type, index) => `${String(epoch)}:${String(index + 1)}`),
      );
      expect(world.warns).toEqual([]);
      expect(world.errors).toEqual([]);

      // Resume from the step.start (seq 2): the todo.updated (seq 3) is replayed exactly once.
      const last = `${String(epoch)}:${String(TURN_WITH_UPDATE.length)}`;
      const resumed = await openEventStream(
        world.fixture,
        world.session,
        world.cookie,
        `${String(epoch)}:2`,
      );
      const replayed = parseSse(await readUntil(resumed, (text) => text.includes(`id: ${last}`)));
      resumed.abort();
      expect(replayed[0]).toEqual({
        id: `${String(epoch)}:3`,
        event: "todo.updated",
        data: { messageId: assistant, todo: T1 },
      });
      expect(replayed.map((frame) => frame.event)).toEqual(TURN_WITH_UPDATE.slice(2));
    },
  );
});

describe("de-duplication across turns", () => {
  it(
    "an identical second list publishes nothing; the changed third publishes one",
    REAL,
    async () => {
      const world = await openWorld(createRealFakeRuntime("todo").runtime);
      const ring: RetainedEvent[] = [];
      world.fixture.supervisor.subscribe(world.session, null, (event) => {
        ring.push(event);
      });

      await turnDone(world);
      const afterFirst = ring.length;
      await turnDone(world);
      const afterSecond = ring.length;
      expect(todoColumn(world.fixture.db, world.session)).toBe(T1_TEXT);
      await turnDone(world);

      const second = ring.slice(afterFirst, afterSecond);
      expect(types(second)).toEqual(TURN_WITHOUT_UPDATE);
      const [, stepStart, stepEnd] = second;
      expect(seqOf(String(stepEnd?.id)) - seqOf(String(stepStart?.id))).toBe(1);
      expect(types(ring.slice(afterSecond))).toEqual(TURN_WITH_UPDATE);

      const updates = ofType(sessionEvents(world), "todo.updated");
      expect(updates).toHaveLength(2);
      expect(updates[1]?.data.todo?.phases[0]?.tasks).toEqual(T3_FIRST_TASKS);
      expect(JSON.parse(String(todoColumn(world.fixture.db, world.session)))).toEqual(
        updates[1]?.data.todo,
      );
      // No sequence was consumed by the dropped duplicate.
      expect(ring.map((event) => seqOf(event.id))).toEqual(ring.map((_event, index) => index + 1));
      expect(world.warns).toEqual([]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("snapshot", () => {
  it(
    "a new session reads four keys with todo null; another account gets the unknown-id 404",
    REAL,
    async () => {
      const world = await openWorld(createRealFakeRuntime("todo").runtime);

      const snapshot = await snapshotOf(world);

      expect(Object.keys(snapshot)).toEqual(["session", "messages", "streamCursor", "todo"]);
      expect(snapshot.todo).toBeNull();
      const { app } = world.fixture;
      const foreign = await cookieFor(app, "zhaoliu");
      const denied = await getSessionMessages(app, world.session, foreign);
      const unknown = await getSessionMessages(app, UNKNOWN_SESSION_ID, foreign);
      expect(denied.statusCode).toBe(404);
      expect(denied.payload).toBe(unknown.payload);
      expect(denied.payload).not.toContain("todo");
    },
  );

  it("the stored list is returned after the turn and again after a restart", REAL, async () => {
    const first = await openRecordingSession(createRealFakeRuntime("todo").runtime);
    let closed = false;
    cleanups.push(async () => {
      if (!closed) {
        await first.fixture.close();
      }
    });
    await turnDone(first);

    const snapshot = await snapshotOf(first);
    expect(Object.keys(snapshot)).toEqual(["session", "messages", "streamCursor", "todo"]);
    expect(snapshot.todo).toEqual(T1);
    expect(Object.keys(snapshot.session as object)).toEqual(SESSION_VIEW_KEYS);
    const listed = await first.fixture.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: first.cookie },
    });
    const { sessions } = listed.json() as { sessions: Array<Record<string, unknown>> };
    expect(sessions.map((session) => Object.keys(session))).toEqual([[...SESSION_VIEW_KEYS]]);

    // Restart: the app (supervisor, store, children) goes away, the database rows stay.
    await first.fixture.app.close();
    closed = true;
    const second = await openBareSession(createRealFakeRuntime("todo").runtime, {
      db: first.fixture.db,
    });
    cleanups.push(() => second.fixture.close());
    const reread = await getSessionMessages(second.fixture.app, first.session, second.cookie);
    expect(reread.statusCode).toBe(200);
    expect((reread.json() as Record<string, unknown>).todo).toEqual(T1);
  });
});

describe("resume and refresh during a running turn", () => {
  it(
    "a cursor before todo.updated replays it once; no cursor replays from turn.start",
    REAL,
    async () => {
      const { world, child } = await openScripted(
        call("c1", "todo", { result: result(T1.phases) }),
      );
      await waitForEvent(world, "step.end");
      const { epoch } = world.fixture.supervisor.streamCursor(world.session);
      const id = (seq: number) => `${String(epoch)}:${String(seq)}`;
      const [update] = ofType(sessionEvents(world), "todo.updated");
      const data = { messageId: update?.data.messageId, todo: T1 };

      const resumed = await openEventStream(world.fixture, world.session, world.cookie, id(2));
      const replayed = parseSse(await readUntil(resumed, (text) => text.includes(`id: ${id(4)}`)));
      resumed.abort();
      expect(replayed.map((frame) => [frame.id, frame.event])).toEqual([
        [id(3), "todo.updated"],
        [id(4), "step.end"],
      ]);
      expect(replayed[0]?.data).toEqual(data);

      const fresh = await openEventStream(world.fixture, world.session, world.cookie);
      const refreshed = parseSse(await readUntil(fresh, (text) => text.includes(`id: ${id(4)}`)));
      fresh.abort();
      expect(refreshed.map((frame) => [frame.id, frame.event])).toEqual([
        [id(1), "turn.start"],
        [id(2), "step.start"],
        [id(3), "todo.updated"],
        [id(4), "step.end"],
      ]);
      expect(refreshed[2]?.data).toEqual(data);
      expect((await snapshotOf(world)).todo).toEqual(T1);

      child.emitLine(AGENT_END);
      await waitForTurn(world.fixture, world.session, "done");
      expect((await snapshotOf(world)).todo).toEqual(T1);
    },
  );
});

describe("candidates that must not change the list", () => {
  it(
    "each invalid candidate is dropped with one warn; steps and the turn are unaffected",
    REAL,
    async () => {
      const invalid: unknown[] = [
        [{ name: "A", tasks: [{ content: SECRET, status: "done" }] }],
        { name: SECRET },
        [{ name: SECRET, tasks: [{ status: "pending" }] }],
        [{ name: 7, tasks: [] }],
        [{ name: "A", tasks: [{ content: SECRET, status: "pending" }, null] }],
      ];
      const frames = [
        ...call("c0", "todo", { result: result(T1.phases) }),
        ...invalid.flatMap((phases, index) =>
          call(`bad${String(index)}`, "todo", { result: result(phases) }),
        ),
        AGENT_END,
      ];
      const { world } = await openScripted(frames);
      await waitForTurn(world.fixture, world.session, "done");

      const published = events(world);
      expect(types(published)).toEqual([
        "turn.start",
        "step.start",
        "todo.updated",
        "step.end",
        ...invalid.flatMap(() => ["step.start", "step.end"]),
        "turn.end",
      ]);
      const ends = ofType(sessionEvents(world), "step.end");
      expect(ends.map((event) => event.data.status)).toEqual(Array(6).fill("done"));
      expect(published.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
      // Dropped candidates take no ring sequence.
      expect(world.fixture.supervisor.streamCursor(world.session).seq).toBe(published.length);
      expect(todoColumn(world.fixture.db, world.session)).toBe(T1_TEXT);
      const assistant = published[0]?.data.messageId;
      expect(world.warns).toEqual(
        invalid.map(() => ({
          level: "warn",
          event: "session_todo_rejected",
          assistantMessageId: assistant,
        })),
      );
      expect(JSON.stringify(world.warns)).not.toContain(SECRET);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "failed todo calls, a todo result without phases and other tools yield no update",
    REAL,
    async () => {
      // A stored list first, so "unchanged" is observable; the rejected calls carry another one.
      const other = [{ name: "别的", tasks: [{ content: "别的任务", status: "pending" }] }];
      const frames = [
        ...call("c0", "todo", { result: result(T1.phases) }),
        ...call("c1", "todo", { isError: true, result: result(other) }),
        ...call("c2", "todo", { result: { ...result(other), isError: true } }),
        ...call("c3", "todo", { result: { content: [], details: { op: "view" } } }),
        ...call("c4", "bash", { result: result(other) }),
        { type: "command_output", text: "Added 1 task." },
        AGENT_END,
      ];
      const { world } = await openScripted(frames);
      await waitForTurn(world.fixture, world.session, "done");

      const published = events(world);
      const updates = ofType(sessionEvents(world), "todo.updated");
      expect(updates.map((event) => event.data.todo)).toEqual([T1]);
      expect(ofType(sessionEvents(world), "files.changed")).toEqual([]);
      expect(ofType(sessionEvents(world), "step.end").map((event) => event.data.status)).toEqual([
        "done",
        "failed",
        "done",
        "done",
        "done",
      ]);
      expect(published.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
      expect(todoColumn(world.fixture.db, world.session)).toBe(T1_TEXT);
      expect(world.warns).toEqual([]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("a failed write", () => {
  it(
    "publishes no todo.updated, takes no ring sequence and reaches the owned error sink",
    REAL,
    async () => {
      // The sink runs synchronously inside the failed commit, while the pump still holds the
      // generation: the only point where the live ring sequence is readable after the fault.
      let cursorAtFault: (() => number | null) | undefined;
      const seqAtFault: Array<number | null> = [];
      const world = await openWorld(
        createRealFakeRuntime("todo").runtime,
        {
          prepare(db) {
            db.exec(`CREATE TEMP TRIGGER reject_todo BEFORE UPDATE OF todo ON chat_sessions
            BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
          },
          onError(error) {
            if (cursorAtFault !== undefined && containsMessage(error, SENTINEL)) {
              seqAtFault.push(cursorAtFault());
            }
          },
        },
        true,
      );
      const { supervisor } = world.fixture;
      cursorAtFault = () => supervisor.streamCursor(world.session).seq;
      const ring: RetainedEvent[] = [];
      supervisor.subscribe(world.session, null, (event) => {
        ring.push(event);
      });
      await prompted(world);
      await waitFor(
        () => (world.errors.some((error) => containsMessage(error, SENTINEL)) ? true : undefined),
        "owned todo write fault",
      );
      // The fault then retires the slot: the live cursor is gone for good and nothing is pushed
      // later, so the subscriber's log is everything this generation's ring ever fanned out.
      await waitFor(
        () => (supervisor.streamCursor(world.session).seq === null ? true : undefined),
        "retired slot",
      );

      expect(types(events(world))).toEqual(["turn.start", "step.start"]);
      expect(seqAtFault).toEqual([2]);
      const epoch = sessionEvents(world)[0]?.epoch;
      expect(ring.map((event) => [event.id, event.type])).toEqual([
        [`${String(epoch)}:1`, "turn.start"],
        [`${String(epoch)}:2`, "step.start"],
      ]);
      expect(supervisor.streamCursor(world.session)).toEqual({ epoch, seq: null });
      expect(todoColumn(world.fixture.db, world.session)).toBeNull();
      expect(world.warns).toEqual([]);
    },
  );
});
