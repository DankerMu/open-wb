/**
 * Issue 1471 (chat-interleaved-segments 3a) over the production assembly and a real fake-omp
 * `approval-parallel` child: chat-stream「步骤的正文偏移」at the database layer. Each step row's
 * `body_offset` equals the UTF-16 length of the `text.delta` deltas published before that
 * `step.start` (the recorded onEvent stream, i.e. ring order); the fake's deltas are fixed
 * (`fake-omp.mjs` DELTAS: "Hello ", "from ", "fake-omp"), so both offsets are also the literal 19.
 * The event field `bodyOffset` arrives with slice 5 (design D8): until then `step.start` keeps its
 * four keys.
 *
 * Issue 1472 (3b, carried from the PR 1481 review) adds a scripted controlled child on the injected
 * clock that never advances: `看` is published at once, `一下` arrives inside the 250 ms window and is
 * held, and a `tool_execution_start` follows with no approval. `#commit` routes (flushes) before it
 * persists, so the step's offset counts the held text too.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  ofType,
  openApprovalWorld,
  prompted,
  REAL,
  sessionEvents,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  closeOnEof,
  createControlledRuntime,
  openRecordingSession,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const worlds: Array<Pick<ApprovalWorld, "fixture">> = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

/** UTF-16 length of the text deltas published before each step.start, in ring order. */
function bodyBeforeEachStart(
  world: Parameters<typeof sessionEvents>[0],
): Array<{ stepId: number; length: number }> {
  let body = "";
  const starts: Array<{ stepId: number; length: number }> = [];
  for (const { event } of sessionEvents(world)) {
    if (event.type === "text.delta") {
      body += event.data.delta;
    } else if (event.type === "step.start") {
      starts.push({ stepId: event.data.stepId, length: body.length });
    }
  }
  return starts;
}

describe("chat-stream「步骤的正文偏移」at the database layer", () => {
  it(
    "both approval-parallel steps store the length of the text published before their step.start",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval-parallel");
      worlds.push(world);
      await prompted(world);
      const [r1, r2] = await waitForRows(world, 2);
      if (r1 === undefined || r2 === undefined) {
        throw new Error("expected two approval rows");
      }
      await waitForEvent(world, "step.start", 2);

      const starts = bodyBeforeEachStart(world);
      expect(starts.map((start) => start.length)).toEqual([19, 19]);
      const offsets = world.fixture.db
        .prepare("SELECT id, body_offset FROM chat_steps ORDER BY ordinal, id")
        .all() as Array<{ id: number; body_offset: unknown }>;
      expect(offsets).toEqual(
        starts.map(({ stepId, length }) => ({ id: stepId, body_offset: length })),
      );

      for (const start of ofType(sessionEvents(world), "step.start")) {
        expect(Object.keys(start.data).sort()).toEqual(["detail", "messageId", "name", "stepId"]);
      }
      await world.fixture.supervisor.decide(world.session, r2.id, "deny");
      await world.fixture.supervisor.decide(world.session, r1.id, "allow");
      await waitForTurn(world.fixture, world.session, "done");
      expect(
        world.fixture.db.prepare("SELECT body_offset FROM chat_steps ORDER BY ordinal, id").all(),
      ).toEqual([{ body_offset: 19 }, { body_offset: 19 }]);
    },
  );
});

const textFrame = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { contentIndex: 0, type: "text_delta", delta },
  message: { role: "assistant", content: [] },
});

describe("chat-stream「分段位置的记录与下发」: text held in the window before a step", () => {
  it(
    "看 published, 一下 held, then a tool start: body_offset 3, the ring prefix, more than 看 alone",
    REAL,
    async () => {
      const controlled = createControlledRuntime((child) => {
        closeOnEof(child);
        child.onCommand("prompt", () => {
          child.emitLine({ type: "agent_start" });
          child.emitLine(textFrame("看"));
          child.emitLine(textFrame("一下"));
          const call = { toolCallId: "call-1", toolName: "bash" };
          child.emitLine({ type: "tool_execution_start", ...call, args: { command: "ls" } });
          const result = { content: [{ type: "text", text: "ok" }] };
          child.emitLine({ type: "tool_execution_end", ...call, result });
          child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
        });
      });
      const world = await openRecordingSession(controlled.runtime);
      worlds.push(world);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");

      const texts = ofType(sessionEvents(world), "text.delta").map((event) => event.data.delta);
      expect(texts).toEqual(["看", "一下"]);
      const starts = bodyBeforeEachStart(world);
      expect(starts.map((start) => start.length)).toEqual([3]);
      const rows = world.fixture.db.prepare("SELECT id, body_offset FROM chat_steps").all();
      expect(rows).toEqual(
        starts.map(({ stepId, length }) => ({ id: stepId, body_offset: length })),
      );
      // The leading edge alone published 看 (one unit): the held 一下 is counted as well.
      expect(Number(rows[0]?.body_offset)).toBeGreaterThan("看".length);
      expect(world.errors).toEqual([]);
    },
  );
});
