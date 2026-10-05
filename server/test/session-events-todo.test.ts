/**
 * Issue #864 todo.updated at applyFrame (chat-stream「Todo result yields a raw candidate」,
 * session-todo「任务清单来源与归一化」): the raw `details.phases` of a successful `todo` call is
 * emitted immediately before its step.end; the reducer neither validates nor retains it. Expected
 * events are literals from those scenarios.
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 864;
const CALL = "call_todo";
const PHASES = [{ name: "准备", tasks: [{ content: "读取需求", status: "in_progress" }] }];
const INIT = { op: "init", phases: PHASES, storage: "session" };

type EventState = ReturnType<typeof createEventState>;

function started(): EventState {
  const bound = createEventState({ messageId: MESSAGE_ID, promptRequestId: "req_todo" });
  return applyFrame(bound, { type: "agent_start" }).state;
}

/** A started turn with one running call registered under `toolName`. */
function running(toolName: string): EventState {
  const start = { type: "tool_execution_start", toolCallId: CALL, toolName, args: {} };
  return applyFrame(started(), start).state;
}

function toolEnd(extra: Record<string, unknown>, toolName = "todo"): OmpFrame {
  return { type: "tool_execution_end", toolCallId: CALL, toolName, ...extra };
}

function okResult(details?: unknown): Record<string, unknown> {
  const content = [{ type: "text", text: "ok" }];
  return details === undefined ? { content } : { content, details };
}

function stepEnd(status: "done" | "failed" = "done"): ChatEvent<string> {
  return { type: "step.end", data: { messageId: MESSAGE_ID, stepId: CALL, status, output: "ok" } };
}

function todoUpdated(todo: unknown): ChatEvent<string> {
  return { type: "todo.updated", data: { messageId: MESSAGE_ID, todo } };
}

function endWith(registered: string, end: OmpFrame): ChatEvent<string>[] {
  return applyFrame(running(registered), end).events;
}

describe("a successful todo result yields its raw phases", () => {
  it("emits todo.updated immediately before the call's step.end, without the other details", () => {
    const applied = applyFrame(running("todo"), toolEnd({ result: okResult(INIT) }));
    expect(applied.events).toEqual([todoUpdated(PHASES), stepEnd()]);
    expect(JSON.stringify(applied.events[1])).not.toContain("storage");
    expect(JSON.stringify(applied.state)).not.toContain("读取需求");
  });

  it("passes the value through unvalidated: a non-array, an unknown status and an own undefined", () => {
    const bad = [{ name: 7, tasks: [{ status: "done" }] }];
    expect(endWith("todo", toolEnd({ result: okResult({ phases: bad }) }))).toEqual([
      todoUpdated(bad),
      stepEnd(),
    ]);
    expect(endWith("todo", toolEnd({ result: okResult({ phases: { name: "A" } }) }))).toEqual([
      todoUpdated({ name: "A" }),
      stepEnd(),
    ]);
    const own = endWith("todo", toolEnd({ result: okResult({ phases: undefined }) }));
    expect(own.map((event) => event.type)).toEqual(["todo.updated", "step.end"]);
  });

  it("uses the name registered at tool_execution_start, not the end frame's toolName", () => {
    expect(endWith("todo", toolEnd({ result: okResult(INIT) }, "bash"))).toEqual([
      todoUpdated(PHASES),
      stepEnd(),
    ]);
    expect(endWith("bash", toolEnd({ result: okResult(INIT) }, "todo"))).toEqual([stepEnd()]);
  });
});

describe("failed calls, other tools and command output yield no candidate", () => {
  it("a frame isError or a result isError emits only step.end", () => {
    expect(endWith("todo", toolEnd({ isError: true, result: okResult(INIT) }))).toEqual([
      stepEnd("failed"),
    ]);
    const failedResult = { ...okResult(INIT), isError: true };
    expect(endWith("todo", toolEnd({ result: failedResult }))).toEqual([stepEnd()]);
  });

  it("details without an own phases, as an array, missing or on the prototype emit only step.end", () => {
    const inherited = Object.create({ phases: PHASES }) as Record<string, unknown>;
    for (const details of [{ op: "view", storage: "memory" }, [PHASES], undefined, inherited]) {
      expect(endWith("todo", toolEnd({ result: okResult(details) }))).toEqual([stepEnd()]);
    }
    expect(endWith("todo", toolEnd({ result: "ok" }))).toEqual([stepEnd()]);
  });

  it("a bash call carrying details.phases emits only step.end", () => {
    const end = toolEnd({ result: okResult({ phases: [] }) }, "bash");
    expect(endWith("bash", end)).toEqual([stepEnd()]);
  });

  it("a todo call never yields files.changed", () => {
    const details = { ...INIT, path: "/ws/a.md", diff: "+1|a", resolvedPath: "/ws/a.md" };
    const types = endWith("todo", toolEnd({ result: okResult(details) })).map((e) => e.type);
    expect(types).toEqual(["todo.updated", "step.end"]);
  });

  it("command_output, including a /todo reply, emits only its text.delta", () => {
    const applied = applyFrame(started(), { type: "command_output", text: "Added 1 task." });
    expect(applied.events).toEqual([
      { type: "text.delta", data: { messageId: MESSAGE_ID, delta: "Added 1 task." } },
    ]);
  });
});
