import { afterEach, describe, expect, it } from "vitest";
import {
  type ChatEvent,
  chatStateFromSnapshot,
  type connectSessionEvents,
  isUnknownTurn,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  assistantContent,
  chatSnapshot,
  connectChat,
  historyUser,
  resetFakeEventSources,
  settle,
} from "./chat-stream-support.js";

type Handle = ReturnType<typeof connectSessionEvents>;
type Message = ChatMessageSnapshot["messages"][number];

afterEach(() => {
  resetFakeEventSources();
});

/** 开连接、open 并装入 `1:0` 快照，此后事件从 `1:1` 起。 */
async function openedChat() {
  const context = connectChat(chatSnapshot());
  context.source.emitOpen();
  context.loads[0]?.resolve(chatSnapshot());
  await settle();
  expect(context.snapshots).toHaveLength(1);
  return { context, handle: context.handle as Handle };
}

function delta(context: ReturnType<typeof connectChat>, seq: number, text: string) {
  context.source.emitData("text.delta", `1:${seq}`, { messageId: 0, delta: text });
}

describe("C1 connector resync", () => {
  it("reloads once without onGap, queues frames during recovery and delivers only successors", async () => {
    const { context, handle } = await openedChat();
    delta(context, 1, "a");
    expect(assistantContent(context.state)).toBe("a");

    handle.resync();
    expect(context.loads).toHaveLength(2);
    expect(context.gaps).toBe(0);
    delta(context, 2, "b");
    delta(context, 3, "c");
    expect(context.events).toHaveLength(1);

    context.loads[1]?.resolve(chatSnapshot({ content: "ab", cursor: { epoch: 1, seq: 2 } }));
    await settle();
    expect(context.snapshots).toHaveLength(2);
    expect(context.events.map((event) => event.type === "text.delta" && event.data.delta)).toEqual([
      "a",
      "c",
    ]);
    expect(assistantContent(context.state)).toBe("abc");
    expect(context.loads).toHaveLength(2);
    expect(context.gaps).toBe(0);
    expect(context.errors).toEqual([]);
    expect(context.source.closeCount).toBe(0);
    handle.close();
  });

  it("aborts a superseded recovery and never installs its late result", async () => {
    const { context, handle } = await openedChat();
    handle.resync();
    const superseded = context.loads[1];
    handle.resync();
    expect(context.loads).toHaveLength(3);
    expect(superseded?.signal.aborted).toBe(true);
    expect(context.loads[2]?.signal.aborted).toBe(false);

    superseded?.resolve(chatSnapshot({ content: "stale", cursor: { epoch: 1, seq: 5 } }));
    await settle();
    expect(context.snapshots).toHaveLength(1);

    context.loads[2]?.resolve(chatSnapshot({ content: "fresh", cursor: { epoch: 1, seq: 1 } }));
    await settle();
    expect(context.snapshots).toHaveLength(2);
    expect(assistantContent(context.state)).toBe("fresh");
    expect(context.gaps).toBe(0);
    expect(context.errors).toEqual([]);
    handle.close();
  });

  it("fails on a regressive recovery snapshot", async () => {
    const { context, handle } = await openedChat();
    delta(context, 1, "a");
    delta(context, 2, "b");
    handle.resync();
    context.loads[1]?.resolve(chatSnapshot({ content: "a", cursor: { epoch: 1, seq: 1 } }));
    await settle();
    expect(context.errors).toHaveLength(1);
    expect(String(context.errors[0])).toContain("Session snapshot is not current");
    expect(context.snapshots).toHaveLength(1);
    expect(context.source.closeCount).toBe(1);
  });

  it("is a no-op after close", async () => {
    const { context, handle } = await openedChat();
    handle.close();
    handle.resync();
    expect(context.loads).toHaveLength(1);
    await settle();
    expect(context.snapshots).toHaveLength(1);
    expect(context.events).toEqual([]);
    expect(context.gaps).toBe(0);
    expect(context.errors).toEqual([]);
    expect(context.source.closeCount).toBe(1);
  });
});

function message(id: number, role: Message["role"], status: Message["status"]): Message {
  return { ...historyUser, id, role, status, content: "", createdAt: id };
}

function viewOf(...messages: Message[]) {
  const base = chatSnapshot();
  return chatStateFromSnapshot({ ...base, messages });
}

const user = message(1, "user", "done");
const turnStart = (messageId: number): ChatEvent => ({ type: "turn.start", data: { messageId } });

describe("U1 isUnknownTurn", () => {
  it("is false for a known message id", () => {
    const view = viewOf(user, message(2, "assistant", "done"));
    expect(isUnknownTurn(view, turnStart(2))).toBe(false);
    expect(isUnknownTurn(view, turnStart(1))).toBe(false);
  });

  it.each(["done", "failed", "stopped"] as const)(
    "is true for an unknown id when the last assistant is %s",
    (status) => {
      const view = viewOf(user, message(2, "assistant", status));
      expect(isUnknownTurn(view, turnStart(3))).toBe(true);
      expect(isUnknownTurn(view, { type: "text.delta", data: { messageId: 3, delta: "x" } })).toBe(
        true,
      );
    },
  );

  it("judges only the last assistant", () => {
    const settledLast = viewOf(
      user,
      message(2, "assistant", "running"),
      message(3, "user", "done"),
      message(4, "assistant", "done"),
    );
    expect(isUnknownTurn(settledLast, turnStart(5))).toBe(true);
    const runningLast = viewOf(
      user,
      message(2, "assistant", "done"),
      message(3, "user", "done"),
      message(4, "assistant", "running"),
    );
    expect(isUnknownTurn(runningLast, turnStart(5))).toBe(false);
  });

  it("is false for an unknown id while the last assistant is running", () => {
    const view = viewOf(user, message(2, "assistant", "running"));
    expect(isUnknownTurn(view, turnStart(3))).toBe(false);
  });

  it("is false when the view holds no assistant", () => {
    expect(isUnknownTurn(viewOf(user), turnStart(2))).toBe(false);
    expect(isUnknownTurn(viewOf(), turnStart(2))).toBe(false);
  });
});
