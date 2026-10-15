/**
 * Issue #910 slice 3b thinking spans, supervisor level (thinking-fold「思考时长记录与下发」, design D3
 * Sketch seam `SessionSupervisor` + fake-omp): order and wiring only, no millisecond values (those
 * are pinned in thinking-span.test.ts). Production assembly (createApp → registerSessions) over
 * real fake-omp children (`thinking`, `edit-write`, the default scenario) or scripted controlled
 * children, real SQLite, REST and SSE, on the injected clock. Oracles: the recorded onEvent
 * stream, the raw `chat_messages.thinking_ms` column (read inside the publication where the order
 * of the write matters), SSE bytes, and a second store opened over the same rows for the startup
 * reconciliation a restarted host runs. The snapshot `thinkingMs` key is slice 3c's; here the
 * column stands in for it.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { createSessionStore } from "../src/sessions/store.js";
import {
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
  waitForEvent,
} from "./session-approval-helpers.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import { messageRow } from "./session-store-helpers.js";
import {
  assistantIdFor,
  closeAfterRetainedFault,
  closeOnEof,
  createControlledRuntime,
  createRealFakeRuntime,
  type OpenSessionOptions,
  openRecordingSession,
  type RecordingWorld,
  type RuntimeOptions,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";
import type { TestClock } from "./support/omp-runtime.js";

/** fake-omp THINKING_PARTS and DELTAS (support/fake-omp*.mjs); copied, not imported. */
const FIRST = "先读需求，";
const HELD = "再列要点，最后作答。";
const THOUGHT = `${FIRST}${HELD}`;
/** turn-artifacts「edit 与 write 的推导」payloads (session-file-changes.test.ts). */
const NOTES = [{ path: "notes.md", added: 2, removed: 1, kind: "edit" }];
const REPORT = [{ path: "out/report.html", added: null, removed: null, kind: "write" }];
const PLANTED = 4242;

interface SpanWorld extends RecordingWorld {
  clock: TestClock;
  /** `thinking_ms` read inside each thinking.end publication, in order. */
  atEnd: Array<number | null>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function thinkingMs(db: DatabaseSync, messageId: number): number | null {
  const row = db.prepare("SELECT thinking_ms FROM chat_messages WHERE id = ?").get(messageId);
  return (row as { thinking_ms: number | null }).thinking_ms;
}

async function openWorld(
  runtime: RuntimeOptions,
  extra: OpenSessionOptions = {},
  faulted = false,
): Promise<SpanWorld> {
  let db: DatabaseSync | undefined;
  const atEnd: Array<number | null> = [];
  const world = await openRecordingSession(runtime, {
    ...extra,
    prepare(opened) {
      db = opened;
      extra.prepare?.(opened);
    },
    onEvent(_session, _epoch, event) {
      if (event.type === "thinking.end" && db !== undefined) {
        atEnd.push(thinkingMs(db, event.data.messageId));
      }
    },
  });
  cleanups.push(() => closeAfterRetainedFault(world.fixture, faulted));
  return { ...world, clock: runtime.clock, atEnd };
}

function events(world: RecordingWorld): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

function types(world: RecordingWorld): string[] {
  return events(world).map((event) => event.type);
}

function update(event: Record<string, unknown>): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { contentIndex: 0, ...event },
    message: { role: "assistant", content: [] },
  };
}

const thinkingFrame = (delta: string) => update({ type: "thinking_delta", delta });
const THINKING_END = update({ type: "thinking_end", content: "" });

/** A controlled child that answers the prompt with agent_start and one thinking frame. */
async function openThinkingChild(
  extra: OpenSessionOptions = {},
): Promise<{ world: SpanWorld; child: () => FakeChild }> {
  const controlled = createControlledRuntime((child) => {
    closeOnEof(child);
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      child.emitLine(thinkingFrame("想"));
    });
  });
  const world = await openWorld(controlled.runtime, extra, true);
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

/** Every assistant row starts with a planted duration, so a NULL afterwards was written. */
const PLANT: OpenSessionOptions = {
  prepare(db) {
    db.exec(`CREATE TEMP TRIGGER plant_thinking_ms AFTER INSERT ON chat_messages
      WHEN NEW.role = 'assistant'
      BEGIN UPDATE chat_messages SET thinking_ms = ${String(PLANTED)} WHERE id = NEW.id; END`);
  },
};

/** The restarted host: a new store over the same rows runs the startup reconciliation. */
function restartReconcile(world: RecordingWorld): void {
  createSessionStore(world.fixture.db, {
    onFlushError() {},
    composer: TEST_COMPOSER,
  }).reconcileOnStartup();
}

describe("thinking-fold 合并与落库", () => {
  it(
    "thinking.end follows the delta thinking_end flushed and precedes the first text.delta",
    REAL,
    async () => {
      const world = await openWorld(createRealFakeRuntime("thinking").runtime);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");

      const assistant = assistantIdFor(world.fixture, world.session);
      expect(types(world)).toEqual([
        "turn.start",
        "thinking.delta",
        "thinking.delta",
        "thinking.end",
        "text.delta",
        "text.delta",
        "turn.end",
      ]);
      expect(ofType(sessionEvents(world), "thinking.delta").map((e) => e.data.delta)).toEqual([
        FIRST,
        HELD,
      ]);
      const [end] = ofType(sessionEvents(world), "thinking.end");
      expect(end?.data.messageId).toBe(assistant);
      // Non-negative integer, written before publication and kept after the turn.
      const value = end?.data.thinkingMs;
      expect(Number.isSafeInteger(value) && Number(value) >= 0).toBe(true);
      expect(world.atEnd).toEqual([value]);
      expect(thinkingMs(world.fixture.db, assistant)).toBe(value);
      expect(world.fixture.supervisor.streamCursor(world.session).seq).toBe(7);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("thinking-fold edit-write wiring", () => {
  it(
    "thinking.delta, thinking.end and the first step.start are adjacent, in that order",
    REAL,
    async () => {
      const world = await openWorld(createRealFakeRuntime("edit-write").runtime);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      const sequence = types(world);
      const end = sequence.indexOf("thinking.end");
      expect(sequence.slice(end - 1, end + 2)).toEqual([
        "thinking.delta",
        "thinking.end",
        "step.start",
      ]);
      expect(sequence.filter((type) => type === "thinking.end")).toHaveLength(1);
      expect(sequence.indexOf("step.start")).toBe(end + 1);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("thinking-fold 无 reasoning 的模型", () => {
  it(
    "a turn without thinking frames publishes no thinking.end and leaves the column NULL",
    REAL,
    async () => {
      const world = await openWorld(createRealFakeRuntime(undefined).runtime);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(types(world)).not.toContain("thinking.end");
      expect(types(world)).not.toContain("thinking.delta");
      expect(thinkingMs(world.fixture.db, assistant)).toBeNull();
      expect(world.errors).toEqual([]);
    },
  );
});

describe("thinking-fold 中断后无法恢复（启动对账一半）", () => {
  it(
    "killed inside the first span: the opening cleared the column and reconciliation keeps NULL",
    REAL,
    async () => {
      const { world } = await openThinkingChild(PLANT);
      await prompted(world);
      await waitForEvent(world, "thinking.delta");
      const assistant = assistantIdFor(world.fixture, world.session);
      expect(thinkingMs(world.fixture.db, assistant)).toBeNull();

      const published = events(world).length;
      restartReconcile(world);
      expect(messageRow(world.fixture.db, assistant).status).toBe("failed");
      expect(thinkingMs(world.fixture.db, assistant)).toBeNull();
      expect(events(world)).toHaveLength(published);
      expect(types(world)).not.toContain("thinking.end");
    },
  );

  it(
    "killed inside the second span: the first span's value is cleared and stays NULL",
    REAL,
    async () => {
      const { world, child } = await openThinkingChild(PLANT);
      await prompted(world);
      await waitForEvent(world, "thinking.delta");
      const assistant = assistantIdFor(world.fixture, world.session);
      world.clock.advance(500);
      child().emitLine(THINKING_END);
      const [first] = await waitForEvent(world, "thinking.end");
      expect(first?.data.thinkingMs).toBe(500);
      expect(thinkingMs(world.fixture.db, assistant)).toBe(500);

      world.clock.advance(300);
      child().emitLine(thinkingFrame("再想"));
      await waitForEvent(world, "thinking.delta", 2);
      expect(thinkingMs(world.fixture.db, assistant)).toBeNull();

      const published = events(world).length;
      restartReconcile(world);
      expect(messageRow(world.fixture.db, assistant).status).toBe("failed");
      expect(thinkingMs(world.fixture.db, assistant)).toBeNull();
      expect(events(world)).toHaveLength(published);
      expect(ofType(sessionEvents(world), "thinking.end")).toHaveLength(1);
    },
  );

  it(
    "killed while answering after a closed span: reconciliation keeps the written value",
    REAL,
    async () => {
      const { world, child } = await openThinkingChild(PLANT);
      await prompted(world);
      await waitForEvent(world, "thinking.delta");
      const assistant = assistantIdFor(world.fixture, world.session);
      world.clock.advance(500);
      child().emitLine(THINKING_END);
      await waitForEvent(world, "thinking.end");
      expect(thinkingMs(world.fixture.db, assistant)).toBe(500);

      world.clock.advance(300);
      child().emitLine(update({ type: "text_delta", delta: "答" }));
      await waitForEvent(world, "text.delta");
      expect(thinkingMs(world.fixture.db, assistant)).toBe(500);

      const published = events(world).length;
      restartReconcile(world);
      expect(messageRow(world.fixture.db, assistant).status).toBe("failed");
      expect(thinkingMs(world.fixture.db, assistant)).toBe(500);
      expect(events(world)).toHaveLength(published);
      expect(ofType(sessionEvents(world), "thinking.end")).toHaveLength(1);
    },
  );

  it(
    "an infra fault inside a span writes no duration and publishes no thinking.end",
    REAL,
    async () => {
      const { world } = await openThinkingChild(PLANT);
      await prompted(world);
      await waitForEvent(world, "thinking.delta");
      const assistant = assistantIdFor(world.fixture, world.session);
      const leading = events(world);

      const error = new Error("text flush sentinel");
      world.fixture.supervisor.handleFlushError({
        sessionId: world.session,
        assistantMessageId: assistant,
        error,
      });
      world.clock.advance(1000);
      await settle();
      await world.fixture.supervisor.shutdown().catch(() => undefined);
      expect(events(world)).toEqual(leading);
      expect(thinkingMs(world.fixture.db, assistant)).toBeNull();
      expect(world.errors).toContain(error);
    },
  );
});

/** Creates u1's workspace `proj` and binds the session (session-file-changes.test.ts). */
async function bindWorkspace(world: RecordingWorld, sandboxRoot: string): Promise<void> {
  mkdirSync(sandboxRoot, { recursive: true });
  const created = await world.fixture.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name: "proj", dir: "proj" }),
  });
  expect(created.statusCode).toBe(201);
  const { id } = created.json() as { id: string };
  world.fixture.db
    .prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?")
    .run(id, world.session);
}

describe("chat-stream Ordered publication after persistence", () => {
  it(
    "thinking.delta, thinking.end after thinking_ms is saved, steps with files.changed, text, turn.end",
    REAL,
    async () => {
      const { runtime } = createRealFakeRuntime("edit-write");
      runtime.sandboxRoot = join(realpathSync(dirname(runtime.sandboxRoot)), "sandbox");
      const world = await openWorld(runtime);
      await bindWorkspace(world, runtime.sandboxRoot);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();

      const sequence = [
        "turn.start",
        "thinking.delta",
        "thinking.delta",
        "thinking.end",
        "step.start",
        "files.changed",
        "step.end",
        "step.start",
        "files.changed",
        "step.end",
        "text.delta",
        "text.delta",
        "turn.end",
      ];
      expect(types(world)).toEqual(sequence);
      const assistant = assistantIdFor(world.fixture, world.session);
      const value = thinkingMs(world.fixture.db, assistant);
      expect(world.atEnd).toEqual([value]);
      expect(ofType(sessionEvents(world), "files.changed").map((e) => e.data.files)).toEqual([
        NOTES,
        REPORT,
      ]);

      // A reconnect with the id preceding the first thinking.delta replays each event once.
      const epoch = String(sessionEvents(world)[0]?.epoch);
      expect(world.fixture.supervisor.streamCursor(world.session).seq).toBe(sequence.length);
      const stream = await openEventStream(
        world.fixture,
        world.session,
        world.cookie,
        `${epoch}:1`,
      );
      const last = `id: ${epoch}:${String(sequence.length)}\n`;
      const frames = parseSse(await readUntil(stream, (text) => text.includes(last)));
      stream.abort();
      expect(frames.map((frame) => frame.id)).toEqual(
        sequence.slice(1).map((_, index) => `${epoch}:${String(index + 2)}`),
      );
      expect(frames.map((frame) => frame.event)).toEqual(sequence.slice(1));
      expect(frames.map((frame) => frame.data)).toEqual(
        events(world)
          .slice(1)
          .map((event) => event.data),
      );
      expect(frames[2]?.data).toEqual({ messageId: assistant, thinkingMs: value });

      const history = await world.fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${world.session}/messages`,
        headers: { cookie: world.cookie },
      });
      const answer = (
        history.json() as { messages: Array<{ role: string; thinking: string | null }> }
      ).messages.find((message) => message.role === "assistant");
      expect(answer?.thinking).toBe(THOUGHT);
      expect(world.errors).toEqual([]);
    },
  );
});
