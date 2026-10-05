/**
 * Issue #864 web snapshot contract (session-todo「web 契约解析与归约」: 四键严格解析、非法 todo 结构
 * 整体拒绝; chat-web「四键快照与任务清单」): `parseMessageSnapshot` and `getMessages()` accept
 * exactly the four keys with a null or well-formed task list and reject everything else whole.
 * Until the web reduces it, `todo.updated` is an unknown event type. Fixtures are the spec's
 * literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { parseMessageSnapshot } from "../src/lib/session-contract.js";
import { chatSnapshot, connectChat, resetFakeEventSources, settle } from "./chat-stream-support.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const LIST = {
  phases: [{ name: "准备", tasks: [{ content: "读取需求", status: "in_progress" }] }],
};
/** U+1F600 takes two UTF-16 code units: 200 of them are 200 code points and 400 units. */
const ASTRAL = "😀";

const threeKeys = (() => {
  const { todo: _todo, ...rest } = chatSnapshot({ sessionId: SESSION_ID });
  return rest;
})();

function withTodo(todo: unknown): Record<string, unknown> {
  return { ...threeKeys, todo };
}

function task(content = "a", status = "pending"): Record<string, unknown> {
  return { content, status };
}

function phase(tasks: unknown, name: unknown = "A"): Record<string, unknown> {
  return { name, tasks };
}

async function expectRejected(body: unknown): Promise<void> {
  expect(parseMessageSnapshot(body)).toBeNull();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
  const error = await captureApiError(createApiClient().getMessages(SESSION_ID));
  expectRequestFailure(error, 200);
  expect(JSON.stringify(error)).not.toContain("phases");
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetFakeEventSources();
});

describe("four-key strict snapshot", () => {
  it.each([
    ["a null list", null],
    ["a well-formed list", LIST],
    [
      "all five statuses",
      {
        phases: [
          phase(
            ["pending", "in_progress", "completed", "abandoned", "blocked"].map((s) => task(s, s)),
          ),
        ],
      },
    ],
    [
      "200-code-point astral texts",
      { phases: [phase([task(ASTRAL.repeat(200))], ASTRAL.repeat(200))] },
    ],
    [
      "200 tasks across two phases",
      {
        phases: [
          phase(Array.from({ length: 150 }, () => task())),
          phase(
            Array.from({ length: 50 }, () => task()),
            "B",
          ),
        ],
      },
    ],
  ])("accepts %s and keeps it value for value", async (_label, todo) => {
    const body = withTodo(todo);

    expect(parseMessageSnapshot(body)).toEqual(body);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    expect(await createApiClient().getMessages(SESSION_ID)).toEqual(body);
  });

  it.each([
    ["only session, messages and streamCursor", threeKeys],
    ["a fifth top-level key", { ...withTodo(null), extra: 1 }],
    ["an undefined todo", withTodo(undefined)],
  ])("rejects %s", async (_label, body) => {
    await expectRejected(body);
  });
});

describe("an illegal todo structure rejects the whole snapshot", () => {
  it.each([
    ["an empty object", {}],
    ["empty phases", { phases: [] }],
    ["a phase without tasks", { phases: [phase([])] }],
    ["an unknown status", { phases: [phase([task("a", "done")])] }],
    ["a blocker key on a task", { phases: [phase([{ ...task("a", "blocked"), blocker: "x" }])] }],
    ["an extra key on a phase", { phases: [{ ...phase([task()]), extra: 1 }] }],
    ["an extra key beside phases", { phases: [phase([task()])], extra: 1 }],
    ["a 201-code-point name", { phases: [phase([task()], "名".repeat(201))] }],
    ["a 201-code-point astral content", { phases: [phase([task(ASTRAL.repeat(201))])] }],
    ["a phase of 201 tasks", { phases: [phase(Array.from({ length: 201 }, () => task()))] }],
    [
      "201 tasks across two phases",
      {
        phases: [phase(Array.from({ length: 200 }, () => task())), phase([task()], "B")],
      },
    ],
    ["a missing content", { phases: [phase([{ status: "pending" }])] }],
    ["a missing name", { phases: [{ tasks: [task()] }] }],
    ["a non-string name", { phases: [phase([task()], 7)] }],
    ["a non-array tasks", { phases: [phase({ 0: task() })] }],
    ["a non-object task", { phases: [phase([null])] }],
    ["non-array phases", { phases: phase([task()]) }],
    ["a string", "x"],
    ["an array", []],
  ])("%s", async (_label, todo) => {
    await expectRejected(withTodo(todo));
  });
});

describe("todo.updated before the web reduces it", () => {
  it("is ignored as an unknown event type: no event, no resync, state unchanged", async () => {
    const context = connectChat(chatSnapshot());
    context.source.emitOpen();
    context.loads[0]?.resolve(chatSnapshot());
    await settle();
    const before = context.state;

    context.source.emitData("todo.updated", "1:1", { messageId: 0, todo: LIST });
    context.source.emitData("todo.updated", "1:2", { messageId: 0 });
    await settle();

    expect(context.loads).toHaveLength(1);
    expect(context.events).toHaveLength(0);
    expect(context.errors).toHaveLength(0);
    expect(context.state).toBe(before);
    context.handle.close();
  });
});
