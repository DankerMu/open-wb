import { afterEach, describe, expect, it } from "vitest";
import { SESSION_STATUS_LABEL } from "../src/features/chat/status-label.js";
import { applyChatEvent, chatStateFromSnapshot } from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  chatSnapshot,
  connectChat,
  resetFakeEventSources,
  settle,
  userView,
} from "./chat-stream-support.js";

const bashStep = {
  id: 1,
  ordinal: 0,
  name: "bash",
  detail: "ls",
  output: "o",
  status: "running" as const,
};

const readStep = {
  id: 2,
  ordinal: 1,
  name: "read",
  detail: "a.txt",
  output: "text",
  status: "done" as const,
};

function runningState() {
  return chatStateFromSnapshot(chatSnapshot({ content: "partial", steps: [bashStep, readStep] }));
}

/** 连接并安装 open 触发的首个快照，此后帧按该快照游标过滤。 */
async function connectInstalled(snapshot: ChatMessageSnapshot) {
  const context = connectChat(snapshot);
  context.source.emitOpen();
  context.loads[0]?.resolve(snapshot);
  await settle();
  return context;
}

afterEach(() => {
  resetFakeEventSources();
});

describe("turn.end stopped reduction", () => {
  it("settles the running assistant, its running step and the session as stopped", () => {
    const state = runningState();
    const before = structuredClone(state);

    const next = applyChatEvent(state, {
      type: "turn.end",
      data: { messageId: 0, status: "stopped" },
    });

    expect(next.status).toBe("stopped");
    expect(next.messages[1]).toEqual({
      id: 0,
      role: "assistant",
      content: "partial",
      status: "stopped",
      steps: [
        { id: 1, name: "bash", detail: "ls", output: "o", status: "stopped" },
        { id: 2, name: "read", detail: "a.txt", output: "text", status: "done" },
      ],
      error: null,
    });
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.messages[0]).toEqual(userView);
    expect(next.messages[1]?.steps[1]).toBe(state.messages[1]?.steps[1]);
    expect(state).toEqual(before);
  });

  it("creates a stopped assistant for a standalone turn.end(stopped)", () => {
    const state = runningState();

    const next = applyChatEvent(state, {
      type: "turn.end",
      data: { messageId: 9, status: "stopped" },
    });

    expect(next.status).toBe("stopped");
    expect(next.messages).toHaveLength(3);
    expect(next.messages[2]).toEqual({
      id: 9,
      role: "assistant",
      content: "",
      status: "stopped",
      steps: [],
      error: null,
    });
  });

  it("clears a prior error text when the turn ends stopped", () => {
    const failed = applyChatEvent(runningState(), {
      type: "error",
      data: { messageId: 0, message: "x" },
    });
    expect(failed.messages[1]?.error).toBe("x");

    const next = applyChatEvent(failed, {
      type: "turn.end",
      data: { messageId: 0, status: "stopped" },
    });

    expect(next.status).toBe("stopped");
    expect(next.messages[1]?.status).toBe("stopped");
    expect(next.messages[1]?.error).toBeNull();
  });

  it("keeps done clearing and failed preserving the error text", () => {
    const failed = applyChatEvent(runningState(), {
      type: "error",
      data: { messageId: 0, message: "x" },
    });

    const done = applyChatEvent(failed, {
      type: "turn.end",
      data: { messageId: 0, status: "done" },
    });
    const failedEnd = applyChatEvent(failed, {
      type: "turn.end",
      data: { messageId: 0, status: "failed" },
    });

    expect(done.messages[1]).toMatchObject({ status: "done", error: null });
    expect(done.messages[1]?.steps.map((step) => step.status)).toEqual(["done", "done"]);
    expect(failedEnd.messages[1]).toMatchObject({ status: "failed", error: "x" });
    expect(failedEnd.messages[1]?.steps.map((step) => step.status)).toEqual(["failed", "done"]);
  });
});

describe("turn.end stopped delivery", () => {
  it("filters by cursor and delivers turn.end stopped in arrival order", async () => {
    const context = await connectInstalled(
      chatSnapshot({ content: "X", cursor: { epoch: 1, seq: 5 } }),
    );

    context.source.emitData("text.delta", "1:5", { messageId: 0, delta: "old" });
    context.source.emitData("text.delta", "1:6", { messageId: 0, delta: "Y" });
    context.source.emitData("turn.end", "1:7", { messageId: 0, status: "stopped" });

    expect(context.events).toEqual([
      { type: "text.delta", data: { messageId: 0, delta: "Y" } },
      { type: "turn.end", data: { messageId: 0, status: "stopped" } },
    ]);
    expect(context.state.status).toBe("stopped");
    expect(context.state.messages[1]).toMatchObject({ content: "XY", status: "stopped" });
    expect(context.loads).toHaveLength(1);
    expect(context.errors).toEqual([]);
    context.handle.close();
  });

  it.each([
    ["step.end", { messageId: 0, stepId: 1, status: "stopped", output: "o" }],
    ["turn.end", { messageId: 0, status: "cancelled" }],
  ] as const)("resyncs instead of delivering %s with an unsupported status", async (type, data) => {
    const context = await connectInstalled(
      chatSnapshot({ steps: [bashStep], cursor: { epoch: 1, seq: 5 } }),
    );

    context.source.emitData(type, "1:6", data);

    expect(context.loads).toHaveLength(2);
    expect(context.events).toEqual([]);
    context.handle.close();
  });
});

describe("stopped status label", () => {
  it("labels stopped as 已停止 across exactly five session states", () => {
    expect(SESSION_STATUS_LABEL.stopped).toBe("已停止");
    expect(Object.keys(SESSION_STATUS_LABEL).sort()).toEqual(
      ["done", "failed", "idle", "running", "stopped"].sort(),
    );
  });
});
