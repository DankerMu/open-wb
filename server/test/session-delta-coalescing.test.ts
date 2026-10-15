/**
 * Issue #910 slice 2b: text deltas through the delta coalescer, supervisor level (chat-stream
 * 「正文与思考增量的时间窗合并」, task 2.3). Production assembly (createApp → registerSessions) over
 * scripted controlled children or real fake-omp children (`crash-after-deltas`, `abort-ok`), real
 * SQLite, REST and SSE. The coalescer's timer is the only timer of at most 250 ms on the injected
 * clock (idle 10000 ms, stop grace 8000 ms, the store's text flush on real timers); the clock moves
 * only when a case advances it, so text arriving within 250 ms of the last text publication is held
 * until the window ends, a non-delta event or the terminal. Oracles: the recorded onEvent stream,
 * the assistant body as the store serves it (stored + pending, the snapshot's source) read inside
 * each publication, REST snapshots and SSE bytes. A scripted batch is written as one stdout chunk:
 * its frames are mapped within one microtask drain, before any wait below polls again.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import type { MessageView } from "../src/sessions/store.js";
import {
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
  waitForEvent,
} from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import { messageRow } from "./session-store-helpers.js";
import {
  assistantIdFor,
  closeAfterRetainedFault,
  closeOnEof,
  createControlledRuntime,
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  type RuntimeOptions,
  trackBufferTimers,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";
import type { TestClock } from "./support/omp-runtime.js";

/** chat-stream spec literal. */
const WINDOW_MS = 250;
const AGENT_END: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };

interface Publication {
  at: number;
  event: ChatEvent<number>;
  /** The assistant body the store serves (stored + pending) inside this publication. */
  body: string | undefined;
  /** Whether the store already holds the assistant's error columns (#909) at that instant. */
  failed: boolean;
}

interface CoalescingWorld extends RecordingWorld {
  clock: TestClock;
  bufferTimers(): number;
  published: Publication[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function openWorld(runtime: RuntimeOptions, faulted = false): Promise<CoalescingWorld> {
  const bufferTimers = trackBufferTimers(runtime.clock);
  const published: Publication[] = [];
  let read: () => MessageView | undefined = () => undefined;
  const world = await openRecordingSession(runtime, {
    onEvent(_session, _epoch, event) {
      const answer = read();
      published.push({
        at: runtime.clock.now(),
        event,
        body: answer?.content,
        failed: (answer?.error ?? null) !== null,
      });
    },
  });
  read = () => world.fixture.store.getMessages(world.session, OWNER_ID)?.messages[1];
  cleanups.push(() => closeAfterRetainedFault(world.fixture, faulted));
  return { ...world, clock: runtime.clock, bufferTimers, published };
}

/** A controlled child that answers the prompt with `agent_start`; the case writes the rest. */
async function openScripted(
  onPrompt: (child: FakeChild, prompt: OmpFrame) => void = (child) => {
    child.emitLine({ type: "agent_start" });
  },
): Promise<{ world: CoalescingWorld; child: () => FakeChild }> {
  const controlled = createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", (frame) => {
      onPrompt(child, frame);
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

/** fake-omp `scenario`; `spawned` collects the children. */
function fakeRuntime(scenario: string, spawned: ChildProcessWithoutNullStreams[] = []) {
  const { runtime } = createRealFakeRuntime(scenario);
  const inner: SpawnImpl = runtime.spawnImpl;
  runtime.spawnImpl = (command, args, options) => {
    const child = inner(command, args, options);
    spawned.push(child);
    return child;
  };
  return runtime;
}

function textFrame(delta: string): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    message: { role: "assistant", content: [] },
  };
}

/** One stdout chunk of text frames. */
function emitText(child: FakeChild, ...deltas: string[]): void {
  child.emitRaw(deltas.map((delta) => `${JSON.stringify(textFrame(delta))}\n`).join(""));
}

function events(world: RecordingWorld): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

function types(world: RecordingWorld): string[] {
  return events(world).map((event) => event.type);
}

function textDeltas(world: RecordingWorld): string[] {
  return ofType(sessionEvents(world), "text.delta").map((event) => event.data.delta);
}

function publicationOf(world: CoalescingWorld, type: string): Publication[] {
  return world.published.filter((entry) => entry.event.type === type);
}

async function waitForBufferTimer(world: CoalescingWorld): Promise<void> {
  await waitFor(() => (world.bufferTimers() > 0 ? true : undefined), "armed coalescer timer");
}

/** The REST snapshot: the assistant body and the stream cursor read with it. */
async function snapshotOf(
  world: RecordingWorld,
): Promise<{ content: string; cursor: { epoch: number; seq: number | null } }> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: `/api/sessions/${world.session}/messages`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    messages: Array<{ role: string; content: string }>;
    streamCursor: { epoch: number; seq: number | null };
  };
  const answer = body.messages.find((message) => message.role === "assistant");
  return { content: String(answer?.content), cursor: body.streamCursor };
}

/** Every prefix of the published text deltas, in publication order. */
function prefixes(deltas: readonly string[]): string[] {
  return deltas.map((_, index) => deltas.slice(0, index + 1).join(""));
}

describe("chat-stream 首段立即、之后按时间窗", () => {
  it(
    "the first text at once, then at most one per window; the store serves exactly the published prefix",
    REAL,
    async () => {
      const { world, child } = await openScripted();
      await prompted(world);
      await waitForEvent(world, "turn.start");
      emitText(child(), "一");
      await waitForEvent(world, "text.delta");
      emitText(child(), "二", "三", "四");
      await waitForBufferTimer(world);
      expect(textDeltas(world)).toEqual(["一"]);
      // The held text is in neither the store nor the snapshot.
      expect((await snapshotOf(world)).content).toBe("一");

      world.clock.advance(100);
      emitText(child(), "五");
      await settle();
      world.clock.advance(149);
      await settle();
      expect(textDeltas(world)).toEqual(["一"]);
      world.clock.advance(1);
      await waitForEvent(world, "text.delta", 2);

      emitText(child(), "六", "七");
      await waitForBufferTimer(world);
      world.clock.advance(WINDOW_MS);
      await waitForEvent(world, "text.delta", 3);
      // A full window after the last publication with nothing held: published at once.
      world.clock.advance(WINDOW_MS);
      emitText(child(), "八");
      await waitForEvent(world, "text.delta", 4);
      emitText(child(), "九");
      await waitForBufferTimer(world);
      child().emitLine(AGENT_END);
      await waitForTurn(world.fixture, world.session, "done");

      const published = ["一", "二三四五", "六七", "八", "九"];
      expect(textDeltas(world)).toEqual(published);
      expect(publicationOf(world, "text.delta").map(({ at }) => at)).toEqual([
        0, 250, 500, 750, 750,
      ]);
      expect(types(world)).toEqual([
        "turn.start",
        ...published.map(() => "text.delta"),
        "turn.end",
      ]);
      expect(publicationOf(world, "text.delta").map(({ body }) => body)).toEqual(
        prefixes(published),
      );
      const assistant = assistantIdFor(world.fixture, world.session);
      expect((await snapshotOf(world)).content).toBe(published.join(""));
      expect(messageRow(world.fixture.db, assistant).content).toBe(published.join(""));
      expect(world.bufferTimers()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "an empty command_output publishes nothing yet counts as a publication: output 100 ms later waits until 250",
    REAL,
    async () => {
      // PR deviation D4: the empty segment is no event, but its emission marks the window.
      const { world, child } = await openScripted((scripted) => {
        // One stdout chunk, so the empty segment is routed before turn.start is observed.
        const frames = [{ type: "agent_start" }, { type: "command_output", text: "" }];
        scripted.emitRaw(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
      });
      await prompted(world);
      await waitForEvent(world, "turn.start");
      await settle();
      expect(types(world)).toEqual(["turn.start"]);
      expect(world.bufferTimers()).toBe(0);

      world.clock.advance(100);
      child().emitLine({ type: "command_output", text: "输出" });
      await waitForBufferTimer(world);
      world.clock.advance(149);
      await settle();
      expect(textDeltas(world)).toEqual([]);
      expect((await snapshotOf(world)).content).toBe("");
      world.clock.advance(1);
      await waitForEvent(world, "text.delta");
      child().emitLine(AGENT_END);
      await waitForTurn(world.fixture, world.session, "done");

      const assistant = assistantIdFor(world.fixture, world.session);
      // events.ts: a command_output after the first is "\n" + its text.
      expect(events(world)).toEqual([
        { type: "turn.start", data: { messageId: assistant } },
        { type: "text.delta", data: { messageId: assistant, delta: "\n输出" } },
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      expect(publicationOf(world, "text.delta").map(({ at }) => at)).toEqual([WINDOW_MS]);
      expect(messageRow(world.fixture.db, assistant).content).toBe("\n输出");
      expect(world.bufferTimers()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("chat-stream 非增量事件前冲刷", () => {
  it(
    "held text xy is published right before the step.start and is then in the store",
    REAL,
    async () => {
      const { world, child } = await openScripted();
      await prompted(world);
      await waitForEvent(world, "turn.start");
      emitText(child(), "w");
      await waitForEvent(world, "text.delta");
      emitText(child(), "x", "y");
      await waitForBufferTimer(world);
      child().emitLine({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      await waitForEvent(world, "step.start");
      expect(types(world)).toEqual(["turn.start", "text.delta", "text.delta", "step.start"]);
      expect(textDeltas(world)).toEqual(["w", "xy"]);
      expect(publicationOf(world, "text.delta").map(({ body }) => body)).toEqual(["w", "wxy"]);
      expect(publicationOf(world, "step.start").map(({ body }) => body)).toEqual(["wxy"]);
      expect(world.bufferTimers()).toBe(0);

      child().emitLine({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }] },
      });
      child().emitLine(AGENT_END);
      await waitForTurn(world.fixture, world.session, "done");
      expect((await snapshotOf(world)).content).toBe("wxy");
      expect(world.errors).toEqual([]);
    },
  );
});

describe("chat-stream 快照与重连不重复", () => {
  it(
    "a snapshot read while 尾部 is held omits it; resuming at its cursor yields 尾部 once",
    REAL,
    async () => {
      const { world, child } = await openScripted();
      await prompted(world);
      await waitForEvent(world, "turn.start");
      emitText(child(), "头");
      await waitForEvent(world, "text.delta");
      emitText(child(), "尾部");
      await waitForBufferTimer(world);
      const held = await snapshotOf(world);
      expect(held.content).toBe("头");
      expect(held.cursor.seq).toBe(2);
      const { epoch } = held.cursor;

      world.clock.advance(WINDOW_MS);
      await waitForEvent(world, "text.delta", 2);
      const resumed = await openEventStream(
        world.fixture,
        world.session,
        world.cookie,
        `${String(epoch)}:2`,
      );
      const successor = `${String(epoch)}:3`;
      const replayed = parseSse(await readUntil(resumed, (text) => text.includes(successor)));
      resumed.abort();
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(replayed).toEqual([
        { id: successor, event: "text.delta", data: { messageId: assistant, delta: "尾部" } },
      ]);

      child().emitLine(AGENT_END);
      await waitForTurn(world.fixture, world.session, "done");
      expect((await snapshotOf(world)).content).toBe(`${held.content}尾部`);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("chat-stream 崩溃时的缓冲", () => {
  it(
    "fake-omp exits holding the second segment: it is published before the error and kept",
    REAL,
    async () => {
      const world = await openWorld(fakeRuntime("crash-after-deltas"));
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "failed");
      // fake-omp DELTAS[0..1]; the clock never moved, so the second was held until the error.
      expect(textDeltas(world)).toEqual(["Hello ", "from "]);
      expect(types(world)).toEqual(["turn.start", "text.delta", "text.delta", "error", "turn.end"]);
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(events(world).at(-1)).toEqual({
        type: "turn.end",
        data: { messageId: assistant, status: "failed" },
      });
      expect(publicationOf(world, "error").map(({ body }) => body)).toEqual(["Hello from "]);
      // Flushed before the error is even stored, not only before it is published.
      expect(world.published.map(({ failed }) => failed)).toEqual([
        false,
        false,
        false,
        true,
        true,
      ]);
      expect(messageRow(world.fixture.db, assistant)).toMatchObject({
        content: "Hello from ",
        status: "failed",
      });
      expect(world.bufferTimers()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "an infra-fault retirement drops the held segment: never stored, never published",
    REAL,
    async () => {
      const controlled = createControlledRuntime((child) => {
        closeOnEof(child);
        child.onCommand("prompt", () => {
          child.emitLine({ type: "agent_start" });
          emitText(child, "头", "尾");
        });
      });
      const world = await openWorld(controlled.runtime, true);
      await prompted(world);
      await waitForBufferTimer(world);
      expect(textDeltas(world)).toEqual(["头"]);
      const leading = events(world);
      const assistant = assistantIdFor(world.fixture, world.session);

      const error = new Error("text flush sentinel");
      world.fixture.supervisor.handleFlushError({
        sessionId: world.session,
        assistantMessageId: assistant,
        error,
      });
      expect(world.bufferTimers()).toBe(0);
      world.clock.advance(WINDOW_MS);
      await settle();
      expect(events(world)).toEqual(leading);
      expect(world.fixture.store.getMessages(world.session, OWNER_ID)?.messages[1]?.content).toBe(
        "头",
      );
      expect(world.errors).toContain(error);
    },
  );

  it(
    "a shutdown clears the timer at once; the held segment is published before the turn ends",
    REAL,
    async () => {
      const controlled = createControlledRuntime((child) => {
        closeOnEof(child);
        child.onCommand("prompt", () => {
          child.emitLine({ type: "agent_start" });
          emitText(child, "头", "尾");
        });
      });
      const world = await openWorld(controlled.runtime, true);
      await prompted(world);
      await waitForBufferTimer(world);
      expect(textDeltas(world)).toEqual(["头"]);

      // An ordinary (not infra-fault) retirement, before any terminal: the window no longer ends.
      const closing = world.fixture.supervisor.shutdown();
      expect(world.bufferTimers()).toBe(0);
      world.clock.advance(WINDOW_MS);
      expect(textDeltas(world)).toEqual(["头"]);
      await closing.catch(() => undefined);

      const assistant = assistantIdFor(world.fixture, world.session);
      // The shutdown failure path (chat-stream: graceful shutdown is a terminal) flushes first.
      expect(textDeltas(world)).toEqual(["头", "尾"]);
      expect(types(world)).toEqual(["turn.start", "text.delta", "text.delta", "error", "turn.end"]);
      expect(events(world).at(-1)).toEqual({
        type: "turn.end",
        data: { messageId: assistant, status: "failed" },
      });
      expect(publicationOf(world, "error").map(({ body }) => body)).toEqual(["头尾"]);
      expect(messageRow(world.fixture.db, assistant).content).toBe("头尾");
      expect(world.errors).toEqual([]);
    },
  );
});

describe("chat-stream 本地完成路径的冲刷", () => {
  it(
    "two command_output at one instant: the second is published before turn.end done",
    REAL,
    async () => {
      const { world } = await openScripted((child, prompt) => {
        child.emitLine({ type: "command_output", text: "第一段" });
        child.emitLine({ type: "command_output", text: "第二段" });
        child.emitLine({
          id: prompt.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { agentInvoked: false },
        });
      });
      const response = await postPrompt(
        world.fixture.app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "/todo" }),
      );
      expect(response.statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();

      const assistant = assistantIdFor(world.fixture, world.session);
      // events.ts: the second command_output is "\n" + its text.
      expect(events(world)).toEqual([
        { type: "turn.start", data: { messageId: assistant } },
        { type: "text.delta", data: { messageId: assistant, delta: "第一段" } },
        { type: "text.delta", data: { messageId: assistant, delta: "\n第二段" } },
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      expect(publicationOf(world, "turn.end").map(({ body }) => body)).toEqual(["第一段\n第二段"]);
      expect(messageRow(world.fixture.db, assistant)).toMatchObject({
        content: "第一段\n第二段",
        status: "done",
      });
      expect(world.bufferTimers()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("chat-stream 停止路径", () => {
  it("held text is published before turn.end stopped", REAL, async () => {
    const world = await openWorld(fakeRuntime("abort-ok"));
    await prompted(world);
    await waitForEvent(world, "text.delta");
    await waitForBufferTimer(world);
    expect(textDeltas(world)).toEqual(["Hello "]);

    await world.fixture.supervisor.stop(world.session);
    await waitForEvent(world, "turn.end");
    const assistant = assistantIdFor(world.fixture, world.session);
    expect(events(world)).toEqual([
      { type: "turn.start", data: { messageId: assistant } },
      { type: "text.delta", data: { messageId: assistant, delta: "Hello " } },
      { type: "text.delta", data: { messageId: assistant, delta: "from " } },
      { type: "turn.end", data: { messageId: assistant, status: "stopped" } },
    ]);
    expect(publicationOf(world, "turn.end").map(({ body }) => body)).toEqual(["Hello from "]);
    expect(messageRow(world.fixture.db, assistant).content).toBe("Hello from ");
    expect(world.bufferTimers()).toBe(0);
    expect(world.errors).toEqual([]);
  });
});
