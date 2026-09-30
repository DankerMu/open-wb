/**
 * Issue #514 publication gate: until the thinking (3.3) and file-change (3.4) supervisor slices
 * land, `persistEvent` neither stores nor publishes `thinking.delta` / `files.changed`, so they
 * consume no ring sequence and write no row. Real subprocess uses the fake-omp `thinking`
 * scenario (frame shapes checked against omp v18.0.10).
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { SessionStore, SettledApproval } from "../src/sessions/store.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  assistantIdFor,
  createRealFakeRuntime,
  eventsFor,
  openRecordingSession,
  waitForContent,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const ASSISTANT_ID = 41;
/** fake-omp DELTAS joined (support/fake-omp.mjs); copied, not imported. */
const ANSWER = "Hello from fake-omp";

const THINKING: ChatEvent<string> = {
  type: "thinking.delta",
  data: { messageId: ASSISTANT_ID, delta: "先读需求，" },
};
const FILES: ChatEvent<string> = {
  type: "files.changed",
  data: {
    messageId: ASSISTANT_ID,
    stepId: "tool-edit-1",
    files: [
      { path: "/srv/workbuddy/sandbox/u1/demo/notes.md", added: 2, removed: 1, kind: "edit" },
      {
        path: "/srv/workbuddy/sandbox/u1/demo/out/report.html",
        added: null,
        removed: null,
        kind: "write",
      },
    ],
  },
};

/** Every property read on the store is recorded; any method returns undefined after recording. */
function recordingStore(): { store: SessionStore; touched: string[] } {
  const touched: string[] = [];
  const store = new Proxy(
    {},
    {
      get(_target, key) {
        touched.push(String(key));
        return () => undefined;
      },
    },
  ) as unknown as SessionStore;
  return { store, touched };
}

function persistAlone(event: ChatEvent<string>) {
  const { store, touched } = recordingStore();
  const toolIds = new Map<string, number>([["call_prior", 7]]);
  const nextOrdinal = vi.fn(() => 1);
  const settled: SettledApproval[] = [];
  const published = persistEvent(store, ASSISTANT_ID, event, toolIds, nextOrdinal, settled);
  return { published, touched, toolIds: [...toolIds], nextOrdinal, settled };
}

describe("persistEvent — thinking.delta and files.changed are neither stored nor published", () => {
  it("the recording store double sees an existing store-backed event", () => {
    const text: ChatEvent<string> = {
      type: "text.delta",
      data: { messageId: ASSISTANT_ID, delta: "答" },
    };
    const result = persistAlone(text);
    expect(result.published).toBe(text);
    expect(result.touched).toEqual(["appendDelta"]);
  });

  for (const [name, event] of [
    ["thinking.delta", THINKING],
    ["files.changed", FILES],
  ] as const) {
    it(`${name} returns undefined without touching the store, tool ids, ordinals or settlements`, () => {
      const result = persistAlone(event);
      expect(result.published).toBeUndefined();
      expect(result.touched).toEqual([]);
      expect(result.toolIds).toEqual([["call_prior", 7]]);
      expect(result.nextOrdinal).not.toHaveBeenCalled();
      expect(result.settled).toEqual([]);
    });
  }
});

describe("supervisor — a real thinking turn", () => {
  it("publishes no thinking.delta, spends no ring sequence on it and stores no thinking", {
    timeout: 15_000,
  }, async () => {
    const runtime = createRealFakeRuntime("thinking");
    const world = await openRecordingSession(runtime.runtime);
    try {
      const response = await postPrompt(
        world.fixture.app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "think first" }),
      );
      expect(response.statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      await waitForContent(world.fixture, world.session, ANSWER);

      const assistant = assistantIdFor(world.fixture, world.session);
      const observed = eventsFor(world.events, world.session);
      expect(observed.map((entry) => entry.event)).toEqual([
        { type: "turn.start", data: { messageId: assistant } },
        { type: "text.delta", data: { messageId: assistant, delta: "Hello " } },
        { type: "text.delta", data: { messageId: assistant, delta: "from " } },
        { type: "text.delta", data: { messageId: assistant, delta: "fake-omp" } },
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      const epoch = observed[0]?.epoch;
      expect(world.fixture.supervisor.streamCursor(world.session)).toEqual({
        epoch,
        seq: observed.length,
      });
      expect(
        world.fixture.db
          .prepare("SELECT content, thinking FROM chat_messages WHERE id = ?")
          .get(assistant),
      ).toEqual({ content: ANSWER, thinking: null });
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });
});
