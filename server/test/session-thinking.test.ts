/**
 * Issue #519 supervisor thinking merge: production assembly (createApp → registerSessions) over
 * real fake-omp `thinking` children (knobs `--thinking-repeat` / `--hold-after-thinking` appended
 * by a spawn wrapper) or scripted controlled children. Oracles are the recorded onEvent stream,
 * the stream cursor, real SSE bytes and the `chat_messages.thinking` column read directly (never
 * the snapshot projection). The merge buffer's timer is the only 2000 ms timer on the injected
 * clock (idle 10000 ms, stop grace 8000 ms, text flush on real timers).
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import {
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
  waitForEvent,
} from "./session-approval-helpers.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import { messageRow, messageRows, sessionRow, sessionRows } from "./session-store-helpers.js";
import {
  assistantIdFor,
  closeAfterRetainedFault,
  closeOnEof,
  containsMessage,
  createControlledRuntime,
  createRealFakeRuntime,
  type OpenSessionOptions,
  openRecordingSession,
  type RecordingWorld,
  type RuntimeOptions,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";
import type { TestClock } from "./support/omp-runtime.js";

/** fake-omp THINKING_PARTS joined and DELTAS (support/fake-omp*.mjs); copied, not imported. */
const THOUGHT = "先读需求，再列要点，最后作答。";
const TEXT_DELTAS = ["Hello ", "from ", "fake-omp"];
/** thinking-fold spec literals. */
const MARK = "…（已截断）";
const CAP = 32_768;
const BUFFER_MS = 2_000;
const SENTINEL = "thinking write sentinel";

interface ThinkingWorld extends RecordingWorld {
  clock: TestClock;
  /** Merge-buffer timers (2000 ms on the injected clock) armed and neither fired nor cleared. */
  bufferTimers(): number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Counts only 2000 ms timers; wraps the clock every consumer shares, before the app opens. */
function trackBufferTimers(clock: TestClock): () => number {
  const live = new Set<unknown>();
  const arm = clock.setTimeout.bind(clock);
  const disarm = clock.clearTimeout.bind(clock);
  clock.setTimeout = (callback, ms) => {
    if (ms !== BUFFER_MS) {
      return arm(callback, ms);
    }
    const id = arm(() => {
      live.delete(id);
      callback();
    }, ms);
    live.add(id);
    return id;
  };
  clock.clearTimeout = (id) => {
    live.delete(id);
    disarm(id);
  };
  return () => live.size;
}

async function openWorld(
  runtime: RuntimeOptions,
  extra: OpenSessionOptions = {},
  faulted = false,
): Promise<ThinkingWorld> {
  const bufferTimers = trackBufferTimers(runtime.clock);
  const world = await openRecordingSession(runtime, extra);
  cleanups.push(() => closeAfterRetainedFault(world.fixture, faulted));
  return { ...world, clock: runtime.clock, bufferTimers };
}

/** fake-omp `scenario` with `extraArgs` appended to every spawn's argv; `spawned` collects them. */
function fakeRuntime(
  scenario: string | undefined,
  extraArgs: string[] = [],
  spawned: ChildProcessWithoutNullStreams[] = [],
): RuntimeOptions {
  const { runtime } = createRealFakeRuntime(scenario);
  const inner: SpawnImpl = runtime.spawnImpl;
  runtime.spawnImpl = (command, args, options) => {
    const child = inner(command, [...args, ...extraArgs], options);
    spawned.push(child);
    return child;
  };
  return runtime;
}

const REJECT_THINKING = `CREATE TEMP TRIGGER reject_thinking
  BEFORE UPDATE OF thinking ON chat_messages
  BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`;

/** The raw column, not the snapshot projection. */
function thinkingColumn(db: DatabaseSync, messageId: number): string | null {
  const [row] = db.prepare("SELECT thinking FROM chat_messages WHERE id = ?").all(messageId);
  return (row as { thinking: string | null }).thinking;
}

function events(world: RecordingWorld): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

function types(world: RecordingWorld): string[] {
  return events(world).map((event) => event.type);
}

function thinkingDeltas(world: RecordingWorld): string[] {
  return ofType(sessionEvents(world), "thinking.delta").map((event) => event.data.delta);
}

async function waitForBufferTimer(world: ThinkingWorld): Promise<void> {
  await waitFor(() => (world.bufferTimers() > 0 ? true : undefined), "armed thinking buffer timer");
}

/** An owner POST under the session: `stop` (202) or an approval answer (200). */
async function ownerPost(world: RecordingWorld, path: string, body?: object): Promise<number> {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/${path}`,
    headers: {
      cookie: world.cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return response.statusCode;
}

function thinkingFrame(delta: string): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
    message: { role: "assistant", content: [] },
  };
}

const SELECT: OmpFrame = {
  type: "extension_ui_request",
  id: "r1",
  method: "select",
  title: "Allow tool: bash\nCommand: echo thinking",
  options: ["Approve", "Deny"],
};
const AGENT_END: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };

/** A controlled child: `script` on prompt; any extension_ui_response ends the turn. */
async function openScriptedWorld(script: (child: FakeChild) => void): Promise<{
  world: ThinkingWorld;
  child: () => FakeChild;
}> {
  const controlled = createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      script(child);
    });
    child.onCommand("extension_ui_response", () => {
      child.emitLine(AGENT_END);
    });
  });
  const world = await openWorld(controlled.runtime);
  return {
    world,
    child: () => {
      const child = controlled.children[0];
      if (child === undefined) {
        throw new Error("missing controlled child");
      }
      return child;
    },
  };
}

/** Answers the published request with allow; the scripted child then ends the turn. */
async function allowToEnd(
  world: RecordingWorld,
  request: Extract<ChatEvent<number>, { type: "approval.request" }> | undefined,
): Promise<string[]> {
  const path = `approvals/${String(request?.data.approvalId)}`;
  expect(await ownerPost(world, path, { decision: "allow" })).toBe(200);
  await waitForTurn(world.fixture, world.session, "done");
  return types(world);
}

describe("S1 merge and persist", () => {
  it(
    "three small deltas become one thinking.delta persisted before its publication",
    REAL,
    async () => {
      let db: DatabaseSync | undefined;
      const columnsAtPublish: Array<string | null> = [];
      const world = await openWorld(fakeRuntime("thinking"), {
        onEvent(_session, _epoch, event) {
          if (event.type === "thinking.delta" && db !== undefined) {
            columnsAtPublish.push(thinkingColumn(db, event.data.messageId));
          }
        },
      });
      db = world.fixture.db;
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");

      const assistant = assistantIdFor(world.fixture, world.session);
      expect(events(world)).toEqual([
        { type: "turn.start", data: { messageId: assistant } },
        { type: "thinking.delta", data: { messageId: assistant, delta: THOUGHT } },
        ...TEXT_DELTAS.map((delta) => ({
          type: "text.delta",
          data: { messageId: assistant, delta },
        })),
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      const epoch = sessionEvents(world)[0]?.epoch;
      expect(world.fixture.supervisor.streamCursor(world.session)).toEqual({
        epoch,
        seq: events(world).length,
      });
      expect(columnsAtPublish).toEqual([THOUGHT]);
      expect(thinkingColumn(world.fixture.db, assistant)).toBe(THOUGHT);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("S2 no reasoning", () => {
  it(
    "a turn without thinking frames publishes no thinking.delta and leaves the column NULL",
    REAL,
    async () => {
      const world = await openWorld(fakeRuntime(undefined));
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(thinkingDeltas(world)).toEqual([]);
      expect(thinkingColumn(world.fixture.db, assistant)).toBeNull();
      expect(world.errors).toEqual([]);
    },
  );
});

describe("S3 cap", () => {
  it("past 32768 code points exactly one marked thinking.delta ends the message's thinking", {
    timeout: 60_000,
  }, async () => {
    // 6900 deltas of 5 code points / 15 bytes: a byte-threshold flush every 137 deltas (685 code
    // points). The 48th crosses the cap (32880 > 32768); the 49th and 50th and the closing flush
    // of the last 50 deltas find the column capped and publish nothing.
    const world = await openWorld(fakeRuntime("thinking", ["--thinking-repeat", "2300"]));
    await prompted(world);
    await waitForTurn(world.fixture, world.session, "done");

    const assistant = assistantIdFor(world.fixture, world.session);
    const published = thinkingDeltas(world);
    expect(published).toHaveLength(48);
    expect(published).not.toContain("");
    const marked = published.filter((delta) => delta.endsWith(MARK));
    expect(marked).toHaveLength(1);
    expect(published.at(-1)).toBe(marked[0]);
    const column = thinkingColumn(world.fixture.db, assistant);
    expect(published.join("")).toBe(column);
    expect([...(column ?? "")].length).toBe(CAP + [...MARK].length);
    expect(column?.startsWith(THOUGHT.repeat(Math.floor(CAP / [...THOUGHT].length)))).toBe(true);
    expect(world.fixture.supervisor.streamCursor(world.session).seq).toBe(events(world).length);
    // turn.start, 48 thinking.delta, three text.delta, turn.end.
    expect(events(world)).toHaveLength(53);
    expect(world.errors).toEqual([]);
  });
});

describe("S4 flush before the terminal", () => {
  it("a held buffer is published and saved before turn.end stopped", REAL, async () => {
    const world = await openWorld(fakeRuntime("thinking", ["--hold-after-thinking"]));
    await prompted(world);
    await waitForBufferTimer(world);
    const assistant = assistantIdFor(world.fixture, world.session);
    expect(events(world)).toEqual([{ type: "turn.start", data: { messageId: assistant } }]);
    expect(thinkingColumn(world.fixture.db, assistant)).toBeNull();

    expect(await ownerPost(world, "stop")).toBe(202);
    await waitForEvent(world, "turn.end");
    expect(events(world)).toEqual([
      { type: "turn.start", data: { messageId: assistant } },
      { type: "thinking.delta", data: { messageId: assistant, delta: THOUGHT } },
      { type: "turn.end", data: { messageId: assistant, status: "stopped" } },
    ]);
    expect(thinkingColumn(world.fixture.db, assistant)).toBe(THOUGHT);
    expect(world.bufferTimers()).toBe(0);
    expect(world.errors).toEqual([]);
  });

  it(
    "a held buffer is published and saved before the failure events of a crash",
    REAL,
    async () => {
      const spawned: ChildProcessWithoutNullStreams[] = [];
      const world = await openWorld(fakeRuntime("thinking", ["--hold-after-thinking"], spawned));
      await prompted(world);
      await waitForBufferTimer(world);
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(events(world)).toEqual([{ type: "turn.start", data: { messageId: assistant } }]);
      expect(thinkingColumn(world.fixture.db, assistant)).toBeNull();

      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.kill("SIGKILL")).toBe(true);
      await waitForTurn(world.fixture, world.session, "failed");
      expect(types(world)).toEqual(["turn.start", "thinking.delta", "error", "turn.end"]);
      expect(thinkingDeltas(world)).toEqual([THOUGHT]);
      expect(events(world).at(-1)).toEqual({
        type: "turn.end",
        data: { messageId: assistant, status: "failed" },
      });
      expect(thinkingColumn(world.fixture.db, assistant)).toBe(THOUGHT);
      expect(world.bufferTimers()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("S5 persistence failure", () => {
  it(
    "a failing timer flush publishes nothing, spends no sequence and takes the error sink",
    REAL,
    async () => {
      const world = await openWorld(
        fakeRuntime("thinking", ["--hold-after-thinking"]),
        {
          prepare(db) {
            db.exec(REJECT_THINKING);
          },
        },
        true,
      );
      await prompted(world);
      await waitForBufferTimer(world);
      const assistant = assistantIdFor(world.fixture, world.session);
      const { epoch } = world.fixture.supervisor.streamCursor(world.session);
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      await readUntil(stream, (text) => text.includes(`id: ${String(epoch)}:1`));

      world.clock.advance(BUFFER_MS);
      expect(world.fixture.supervisor.streamCursor(world.session)).toEqual({ epoch, seq: 1 });
      expect(events(world)).toEqual([{ type: "turn.start", data: { messageId: assistant } }]);
      expect(world.errors.some((error) => containsMessage(error, SENTINEL))).toBe(true);

      await settle();
      stream.resume();
      expect(parseSse(await readUntil(stream, () => true)).map((frame) => frame.id)).toEqual([
        `${String(epoch)}:1`,
      ]);
      expect(thinkingDeltas(world)).toEqual([]);
      expect(thinkingColumn(world.fixture.db, assistant)).toBeNull();
      stream.abort();
    },
  );

  it(
    "a failing flush before turn.end leaves the turn running: no terminal is stored or published",
    REAL,
    async () => {
      let db: DatabaseSync | undefined;
      /** Message and session status read inside the error sink, the instant the flush failed. */
      const atFault: Array<{ message: string; session: string }> = [];
      const world = await openWorld(
        fakeRuntime("thinking", ["--hold-after-thinking"]),
        {
          prepare(opened) {
            db = opened;
            opened.exec(REJECT_THINKING);
          },
          onError(error) {
            if (db !== undefined && containsMessage(error, SENTINEL)) {
              const session = sessionRows(db)[0];
              const message = messageRows(db).find((row) => row.role === "assistant");
              atFault.push({ message: String(message?.status), session: String(session?.status) });
            }
          },
        },
        true,
      );
      await prompted(world);
      await waitForBufferTimer(world);
      const assistant = assistantIdFor(world.fixture, world.session);
      const started = [{ type: "turn.start", data: { messageId: assistant } }];
      expect(events(world)).toEqual(started);

      expect(await ownerPost(world, "stop")).toBe(202);
      await waitFor(
        () => (world.errors.some((error) => containsMessage(error, SENTINEL)) ? true : undefined),
        "thinking write sentinel in the error sink",
      );
      expect(atFault).toEqual([{ message: "running", session: "running" }]);

      await settle();
      expect(events(world)).toEqual(started);
      expect(thinkingColumn(world.fixture.db, assistant)).toBeNull();
      expect(messageRow(world.fixture.db, assistant).status).toBe("running");
      expect(sessionRow(world.fixture.db, world.session).status).toBe("running");
      expect(world.bufferTimers()).toBe(0);
    },
  );
});

describe("S6 replay and refresh", () => {
  it(
    "a published thinking.delta replays once after the preceding id and in a running refresh",
    REAL,
    async () => {
      // 138 deltas of 15 bytes: the 137th crosses 2048 bytes; the last stays buffered.
      const world = await openWorld(
        fakeRuntime("thinking", ["--thinking-repeat", "46", "--hold-after-thinking"]),
      );
      await prompted(world);
      const [published] = await waitForEvent(world, "thinking.delta");
      const assistant = assistantIdFor(world.fixture, world.session);
      const { epoch } = world.fixture.supervisor.streamCursor(world.session);
      const first = `${String(epoch)}:1`;
      const second = `${String(epoch)}:2`;
      const data = { messageId: assistant, delta: published?.data.delta };
      expect(published?.data.delta).toBe(`${THOUGHT.repeat(45)}先读需求，再列要点，`);
      expect(thinkingColumn(world.fixture.db, assistant)).toBe(published?.data.delta);

      const resumed = await openEventStream(world.fixture, world.session, world.cookie, first);
      const replayed = parseSse(await readUntil(resumed, (text) => text.includes(`id: ${second}`)));
      expect(replayed).toEqual([{ id: second, event: "thinking.delta", data }]);
      resumed.abort();

      const fresh = await openEventStream(world.fixture, world.session, world.cookie);
      const refreshed = parseSse(await readUntil(fresh, (text) => text.includes(`id: ${second}`)));
      expect(refreshed).toEqual([
        { id: first, event: "turn.start", data: { messageId: assistant } },
        { id: second, event: "thinking.delta", data },
      ]);
      fresh.abort();
    },
  );
});

describe("S7 flush before other events through the publication funnel", () => {
  it("thinking.delta immediately precedes the step.start of a following tool", REAL, async () => {
    const { world } = await openScriptedWorld((child) => {
      child.emitLine(thinkingFrame("想一想"));
      child.emitLine({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      child.emitLine({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
      });
      child.emitLine(AGENT_END);
    });
    await prompted(world);
    await waitForTurn(world.fixture, world.session, "done");
    expect(types(world)).toEqual([
      "turn.start",
      "thinking.delta",
      "step.start",
      "step.end",
      "turn.end",
    ]);
    expect(thinkingDeltas(world)).toEqual(["想一想"]);
    const assistant = assistantIdFor(world.fixture, world.session);
    expect(thinkingColumn(world.fixture.db, assistant)).toBe("想一想");
  });

  it(
    "thinking.delta immediately precedes the approval.request of a following select",
    REAL,
    async () => {
      const { world } = await openScriptedWorld((child) => {
        child.emitLine(thinkingFrame("先想"));
        child.emitLine(SELECT);
      });
      await prompted(world);
      const [request] = await waitForEvent(world, "approval.request");
      expect(types(world)).toEqual(["turn.start", "thinking.delta", "approval.request"]);
      expect(await allowToEnd(world, request)).toEqual([
        "turn.start",
        "thinking.delta",
        "approval.request",
        "approval.resolved",
        "turn.end",
      ]);
      expect(thinkingDeltas(world)).toEqual(["先想"]);
    },
  );

  it(
    "a REST settlement flushes thinking that arrived after the request, before approval.resolved",
    REAL,
    async () => {
      const { world, child } = await openScriptedWorld((scripted) => {
        scripted.emitLine(SELECT);
      });
      await prompted(world);
      const [request] = await waitForEvent(world, "approval.request");
      child().emitLine(thinkingFrame("后想"));
      await waitForBufferTimer(world);
      expect(types(world)).toEqual(["turn.start", "approval.request"]);

      expect(await allowToEnd(world, request)).toEqual([
        "turn.start",
        "approval.request",
        "thinking.delta",
        "approval.resolved",
        "turn.end",
      ]);
      expect(thinkingDeltas(world)).toEqual(["后想"]);
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(thinkingColumn(world.fixture.db, assistant)).toBe("后想");
    },
  );
});

describe("S8 timer lifecycle", () => {
  it(
    "no buffer timer survives turn.end or retirement, so no late write or publication",
    REAL,
    async () => {
      const world = await openWorld(fakeRuntime("thinking"), {
        prepare(db) {
          db.exec(`CREATE TEMP TABLE thinking_writes(message_id INTEGER);
          CREATE TEMP TRIGGER count_thinking_writes AFTER UPDATE OF thinking ON chat_messages
          BEGIN INSERT INTO thinking_writes VALUES (NEW.id); END`);
        },
      });
      const writes = () =>
        (
          world.fixture.db.prepare("SELECT COUNT(*) AS count FROM thinking_writes").get() as {
            count: number;
          }
        ).count;
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      const settled = { events: events(world).length, writes: writes() };
      expect(world.bufferTimers()).toBe(0);

      world.clock.advance(BUFFER_MS);
      await settle();
      expect({ events: events(world).length, writes: writes() }).toEqual(settled);

      await world.fixture.supervisor.retire(world.session);
      world.clock.advance(BUFFER_MS);
      await settle();
      expect({ events: events(world).length, writes: writes() }).toEqual(settled);
      expect(world.bufferTimers()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );
});
