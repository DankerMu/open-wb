/**
 * Issue #865 — `todo.updated` in the web stream (chat-web「任务清单归约」「任务清单事件经同一游标过滤并
 * 严格解码」; session-todo「事件解码与归约」「非法事件负载与未知回合」). The page half of the last
 * scenario is in `chat-page-todo-resync.test.tsx`. Fixtures are the spec's literals.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
  isUnknownTurn,
} from "../src/features/chat/stream.js";
import { chatSnapshot, connectChat, resetFakeEventSources, settle } from "./chat-stream-support.js";

type Todo = ChatState["todo"];

const M = 0;
const N = 7;

function t1(): NonNullable<Todo> {
  return { phases: [{ name: "准备", tasks: [{ content: "读取需求", status: "in_progress" }] }] };
}

function t2(): NonNullable<Todo> {
  return {
    phases: [
      { name: "准备", tasks: [{ content: "读取需求", status: "completed" }] },
      { name: "交付", tasks: [{ content: "输出结论", status: "pending" }] },
    ],
  };
}

function updated(messageId: number, todo: Todo): ChatEvent {
  return { type: "todo.updated", data: { messageId, todo } };
}

/** Applies `event` and proves the input state was left as it was. */
function reduce(state: ChatState, event: ChatEvent): ChatState {
  const before = structuredClone(state);
  const next = applyChatEvent(state, event);
  expect(state).toEqual(before);
  return next;
}

afterEach(() => {
  resetFakeEventSources();
});

describe("task list reduction", () => {
  it("takes the snapshot's list as is", () => {
    const snapshot = chatSnapshot({ todo: t1() });

    expect(chatStateFromSnapshot(snapshot).todo).toBe(snapshot.todo);
    expect(chatStateFromSnapshot(chatSnapshot()).todo).toBeNull();
  });

  it("replaces the list wholesale and survives the turn boundary", () => {
    const s0 = chatStateFromSnapshot(chatSnapshot());
    expect(s0.todo).toBeNull();

    const list = t1();
    const s1 = reduce(s0, updated(M, list));
    expect(s1.todo).toBe(list);
    expect(s1.todo).toEqual(t1());
    expect(s1.messages).toBe(s0.messages);
    expect(s1.status).toBe(s0.status);

    const s2 = reduce(s1, updated(M, t1()));
    expect(s2).toBe(s1);

    const s3 = reduce(s2, updated(M, t2()));
    expect(s3.todo).toEqual(t2());
    expect(s3.messages).toBe(s2.messages);

    const s4 = reduce(s3, { type: "turn.end", data: { messageId: M, status: "done" } });
    expect(s4.status).toBe("done");
    expect(s4.todo).toBe(s3.todo);

    const s5 = reduce(s4, { type: "turn.start", data: { messageId: N } });
    expect(s5.status).toBe("running");
    expect(s5.messages.map((message) => message.id)).toEqual([-3, M, N]);
    expect(s5.todo).toBe(s3.todo);

    const s6 = reduce(s5, updated(N, null));
    expect(s6.todo).toBeNull();
    expect(s6.messages).toBe(s5.messages);
    expect(s6.status).toBe("running");

    expect(reduce(s6, updated(N, null))).toBe(s6);
  });

  it.each<[string, Todo]>([
    [
      "another status",
      { phases: [{ name: "准备", tasks: [{ content: "读取需求", status: "pending" }] }] },
    ],
    [
      "another content",
      { phases: [{ name: "准备", tasks: [{ content: "读取", status: "in_progress" }] }] },
    ],
    [
      "another phase name",
      { phases: [{ name: "交付", tasks: [{ content: "读取需求", status: "in_progress" }] }] },
    ],
    [
      "one more task",
      {
        phases: [
          {
            name: "准备",
            tasks: [
              { content: "读取需求", status: "in_progress" },
              { content: "列出要点", status: "pending" },
            ],
          },
        ],
      },
    ],
    ["one more phase", { phases: [...t1().phases, ...t1().phases] }],
  ])("a list differing by %s is a replacement, not the same state", (_label, todo) => {
    const state = chatStateFromSnapshot(chatSnapshot({ todo: t1() }));

    const next = reduce(state, updated(M, todo));

    expect(next).not.toBe(state);
    expect(next.todo).toBe(todo);
    expect(next.messages).toBe(state.messages);
  });

  it.each<[string, ChatEvent]>([
    ["text.delta", { type: "text.delta", data: { messageId: M, delta: "x" } }],
    ["thinking.delta", { type: "thinking.delta", data: { messageId: M, delta: "x" } }],
    [
      "step.start",
      { type: "step.start", data: { messageId: M, stepId: 1, name: "bash", detail: "" } },
    ],
    ["error", { type: "error", data: { messageId: M, message: "boom" } }],
    ["turn.end failed", { type: "turn.end", data: { messageId: M, status: "failed" } }],
    ["turn.end stopped", { type: "turn.end", data: { messageId: M, status: "stopped" } }],
    ["turn.start of the same message", { type: "turn.start", data: { messageId: M } }],
    [
      "approval.request",
      {
        type: "approval.request",
        data: { messageId: M, approvalId: 9, tool: "bash", title: "t", expiresAt: 1 },
      },
    ],
  ])("%s changes the view and keeps the list", (_label, event) => {
    const state = chatStateFromSnapshot(chatSnapshot({ todo: t1() }));

    const next = reduce(state, event);

    expect(next).not.toBe(state);
    expect(next.todo).toBe(state.todo);
  });

  it("does not create a message for an id the view does not hold", () => {
    const state = chatStateFromSnapshot(chatSnapshot());

    const next = reduce(state, updated(N, t1()));

    expect(next.todo).toEqual(t1());
    expect(next.messages).toBe(state.messages);
    expect(next.status).toBe(state.status);
  });
});

describe("unknown turn", () => {
  it("is judged like every other event: resync after a settled turn, reducer while one runs", () => {
    const settled = chatStateFromSnapshot(
      chatSnapshot({ status: "done", assistantStatus: "done" }),
    );
    const running = chatStateFromSnapshot(chatSnapshot());

    expect(isUnknownTurn(settled, updated(N, t1()))).toBe(true);
    expect(isUnknownTurn(settled, updated(M, t1()))).toBe(false);
    expect(isUnknownTurn(running, updated(N, t1()))).toBe(false);
  });
});

async function opened(seq = 0, todo: Todo = null) {
  const snapshot = chatSnapshot({ cursor: { epoch: 1, seq }, todo });
  const context = connectChat(snapshot);
  context.source.emitOpen();
  context.loads[0]?.resolve(snapshot);
  await settle();
  expect(context.snapshots).toHaveLength(1);
  return context;
}

describe("cursor filter", () => {
  it("drops 1:5 on a 1:5 snapshot and delivers 1:6 and 1:7 in arrival order", async () => {
    const context = await opened(5);

    context.source.emitData("todo.updated", "1:5", { messageId: M, todo: t2() });
    expect(context.events).toHaveLength(0);
    expect(context.state.todo).toBeNull();
    context.source.emitData("todo.updated", "1:6", { messageId: M, todo: t1() });
    context.source.emitData("turn.end", "1:7", { messageId: M, status: "done" });

    expect(context.events).toEqual([
      updated(M, t1()),
      { type: "turn.end", data: { messageId: M, status: "done" } },
    ]);
    expect(context.state.todo).toEqual(t1());
    expect(context.state.status).toBe("done");
    expect(context.loads).toHaveLength(1);
    expect(context.errors).toHaveLength(0);
    context.handle.close();
  });

  it("drops a replayed seq and an older epoch, and accepts a later epoch", async () => {
    const context = await opened(5);

    context.source.emitData("todo.updated", "1:6", { messageId: M, todo: t1() });
    context.source.emitData("todo.updated", "1:6", { messageId: M, todo: t2() });
    context.source.emitData("todo.updated", "1:4", { messageId: M, todo: t2() });
    context.source.emitData("todo.updated", "0:99", { messageId: M, todo: t2() });
    expect(context.events).toEqual([updated(M, t1())]);
    expect(context.state.todo).toEqual(t1());

    context.source.emitData("todo.updated", "2:1", { messageId: M, todo: null });
    expect(context.events).toEqual([updated(M, t1()), updated(M, null)]);
    expect(context.state.todo).toBeNull();
    expect(context.loads).toHaveLength(1);
    context.handle.close();
  });

  it("queues a frame during recovery and drops it when the recovery snapshot covers it", async () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    context.source.emitData("todo.updated", "1:1", { messageId: M, todo: t1() });
    context.source.emitData("todo.updated", "1:2", { messageId: M, todo: t2() });
    expect(context.events).toHaveLength(0);

    context.loads[0]?.resolve(chatSnapshot({ cursor: { epoch: 1, seq: 1 }, todo: t1() }));
    await settle();

    expect(context.events).toEqual([updated(M, t2())]);
    expect(context.state.todo).toEqual(t2());
    context.handle.close();
  });
});

describe("strict decoding", () => {
  const task = { content: "a", status: "pending" };

  it.each<[string, unknown]>([
    ["a missing todo", { messageId: 1 }],
    ["a missing messageId", { todo: null }],
    ["an extra key", { messageId: 1, todo: null, extra: 1 }],
    ["a string messageId", { messageId: "1", todo: null }],
    ["a fractional messageId", { messageId: 1.5, todo: null }],
    ["an unsafe messageId", { messageId: 2 ** 53, todo: null }],
    ["empty phases", { messageId: 1, todo: { phases: [] } }],
    ["a phase without tasks", { messageId: 1, todo: { phases: [{ name: "A", tasks: [] }] } }],
    [
      "a blocker key",
      { messageId: 1, todo: { phases: [{ name: "A", tasks: [{ ...task, blocker: "x" }] }] } },
    ],
    [
      "an unknown status",
      {
        messageId: 1,
        todo: { phases: [{ name: "A", tasks: [{ content: "a", status: "done" }] }] },
      },
    ],
    [
      "an extra key beside phases",
      { messageId: 1, todo: { phases: [{ name: "A", tasks: [task] }], extra: 1 } },
    ],
    [
      "a 201-code-point name",
      { messageId: 1, todo: { phases: [{ name: "名".repeat(201), tasks: [task] }] } },
    ],
    [
      "201 tasks",
      {
        messageId: 1,
        todo: { phases: [{ name: "A", tasks: Array.from({ length: 201 }, () => task) }] },
      },
    ],
    ["an undefined-like todo string", { messageId: 1, todo: "x" }],
    ["an array todo", { messageId: 1, todo: [] }],
    ["a non-object payload", [1, null]],
  ])("%s triggers one full resync and delivers nothing", async (_label, data) => {
    const context = await opened(0, t1());
    const before = context.state;

    context.source.emitData("todo.updated", "1:1", data);

    expect(context.loads).toHaveLength(2);
    expect(context.events).toHaveLength(0);
    expect(context.state).toBe(before);
    expect(context.state.todo).toEqual(t1());

    // The recovery snapshot's list is installed whole through onSnapshot.
    context.loads[1]?.resolve(chatSnapshot({ cursor: { epoch: 1, seq: 1 }, todo: t2() }));
    await settle();
    expect(context.snapshots).toHaveLength(2);
    expect(context.state.todo).toEqual(t2());
    expect(context.errors).toHaveLength(0);
    context.handle.close();
  });

  it("resyncs on a valid payload under a non-canonical event id", async () => {
    const context = await opened();

    context.source.emitData("todo.updated", "1:01", { messageId: M, todo: t1() });

    expect(context.loads).toHaveLength(2);
    expect(context.events).toHaveLength(0);
    expect(context.state.todo).toBeNull();
    context.handle.close();
  });

  it("delivers a null list and a 200-task list value for value", async () => {
    const context = await opened(0, t1());
    const big = {
      phases: [{ name: "😀".repeat(200), tasks: Array.from({ length: 200 }, () => ({ ...task })) }],
    };

    context.source.emitData("todo.updated", "1:1", { messageId: M, todo: null });
    expect(context.state.todo).toBeNull();
    context.source.emitData("todo.updated", "1:2", { messageId: M, todo: big });

    expect(context.events).toEqual([
      updated(M, null),
      { type: "todo.updated", data: { messageId: M, todo: big } },
    ]);
    expect(context.state.todo).toEqual(big);
    expect(context.loads).toHaveLength(1);
    context.handle.close();
  });
});
