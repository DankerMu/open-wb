import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  type ChatState,
  chatStateFromSnapshot,
  connectSessionEvents,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  COMPLETED_BODY,
  deferred,
  FakeEventSource,
  historyUser,
  latestSource,
  resetFakeEventSources,
  runningSession,
  SESSION_ID,
  userView,
} from "./chat-stream-support.js";

function completedSnapshot(): ChatMessageSnapshot {
  return {
    session: runningSession("done"),
    messages: [
      historyUser,
      {
        id: 0,
        role: "assistant",
        content: COMPLETED_BODY,
        status: "done",
        createdAt: 0,
        steps: [],
      },
    ],
    streamCursor: { epoch: 1, seq: 3 },
  };
}

describe("Chat stream connector", () => {
  it("reconciles a completed first-open snapshot then applies only later events", async () => {
    resetFakeEventSources();
    const load = deferred<ChatMessageSnapshot>();
    const loads: AbortSignal[] = [];
    const snapshots: ChatMessageSnapshot[] = [];
    const events: unknown[] = [];
    const gaps: unknown[] = [];
    const errors: unknown[] = [];
    let state: ChatState | undefined;

    const handle = connectSessionEvents(SESSION_ID, {
      EventSourceCtor: FakeEventSource,
      initialCursor: { epoch: 1, seq: 1 },
      loadSnapshot(signal) {
        loads.push(signal);
        return load.promise;
      },
      onSnapshot(snapshot) {
        snapshots.push(snapshot);
        state = chatStateFromSnapshot(snapshot);
      },
      onEvent(event) {
        events.push(event);
        if (state === undefined) {
          throw new Error("expected an installed snapshot before onEvent");
        }
        state = applyChatEvent(state, event);
      },
      onGap() {
        gaps.push("gap");
      },
      onError(error) {
        errors.push(error);
      },
    });

    const source = latestSource();
    expect(source.url).toBe(`/api/sessions/${SESSION_ID}/events`);
    expect(source.withCredentials).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(loads).toHaveLength(0);

    source.emitOpen();
    expect(loads).toHaveLength(1);
    expect(snapshots).toHaveLength(0);
    expect(events).toEqual([]);

    source.emitNamed("turn.start", JSON.stringify({ messageId: 0 }), "1:1");
    source.emitNamed("text.delta", JSON.stringify({ messageId: 0, delta: "stale" }), "1:2");
    source.emitNamed("turn.start", JSON.stringify({ messageId: 4 }), "1:4");
    source.emitNamed("text.delta", JSON.stringify({ messageId: 4, delta: "Z" }), "1:5");

    expect(snapshots).toHaveLength(0);
    expect(events).toEqual([]);
    expect(state).toBeUndefined();

    load.resolve(completedSnapshot());
    await load.promise;

    expect(gaps).toEqual([]);
    expect(errors).toEqual([]);
    expect(loads).toHaveLength(1);
    expect(snapshots).toEqual([completedSnapshot()]);
    expect(events).toEqual([
      { type: "turn.start", data: { messageId: 4 } },
      { type: "text.delta", data: { messageId: 4, delta: "Z" } },
    ]);
    expect(state).toEqual({
      status: "running",
      messages: [
        userView,
        {
          id: 0,
          role: "assistant",
          content: COMPLETED_BODY,
          status: "done",
          steps: [],
          error: null,
        },
        {
          id: 4,
          role: "assistant",
          content: "Z",
          status: "running",
          steps: [],
          error: null,
        },
      ],
    });

    handle.close();
    handle.close();
    expect(source.closeCount).toBe(1);
    expect(errors).toEqual([]);

    const afterClose = state;
    source.emitNamed("text.delta", JSON.stringify({ messageId: 4, delta: "late" }), "1:6");
    expect(events).toHaveLength(2);
    expect(state).toBe(afterClose);
  });
});
