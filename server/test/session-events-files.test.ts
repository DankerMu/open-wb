/**
 * Issue #515 files.changed at applyFrame: raw edit/write candidates immediately before step.end,
 * registered-name gating, failure/prototype rejection and non-aliasing. Expected events are
 * fixture literals from the chat-stream and turn-artifacts scenarios.
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 515;
const CALL = "call_files";
const APP_DETAILS = { diff: "+3|a\n+4|b\n-3|x\n 2|ctx", path: "/ws/src/app.ts" };

type EventState = ReturnType<typeof createEventState>;

/** Binds a turn, starts it and registers one running call under `toolName`. */
function running(toolName: string, toolCallId = CALL): EventState {
  const bound = createEventState({ messageId: MESSAGE_ID, promptRequestId: "req_files" });
  const started = applyFrame(bound, { type: "agent_start" }).state;
  return applyFrame(started, { type: "tool_execution_start", toolCallId, toolName, args: {} })
    .state;
}

function toolEnd(extra: Record<string, unknown>, toolName = "edit"): OmpFrame {
  return { type: "tool_execution_end", toolCallId: CALL, toolName, ...extra };
}

function okResult(details: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: "ok" }], details };
}

function stepEnd(status: "done" | "failed" = "done", output = "ok"): ChatEvent<string> {
  return { type: "step.end", data: { messageId: MESSAGE_ID, stepId: CALL, status, output } };
}

function filesChanged(files: unknown[]): ChatEvent<string> {
  return {
    type: "files.changed",
    data: { messageId: MESSAGE_ID, stepId: CALL, files },
  } as ChatEvent<string>;
}

function endWith(registered: string, end: OmpFrame): ChatEvent<string>[] {
  return applyFrame(running(registered), end).events;
}

describe("edit and write details yield raw candidates", () => {
  it("edit emits files.changed immediately before its step.end", () => {
    const events = endWith("edit", toolEnd({ result: okResult(APP_DETAILS) }));
    expect(events).toEqual([
      filesChanged([{ path: "/ws/src/app.ts", added: 2, removed: 1, kind: "edit" }]),
      stepEnd(),
    ]);
    const last = events[1];
    expect(last?.type === "step.end" && Object.keys(last.data).sort()).toEqual([
      "messageId",
      "output",
      "status",
      "stepId",
    ]);
  });

  it("write emits files.changed with null counts before its step.end", () => {
    const end = toolEnd({ result: okResult({ resolvedPath: "/ws/out/index.html" }) }, "write");
    expect(endWith("write", end)).toEqual([
      filesChanged([{ path: "/ws/out/index.html", added: null, removed: null, kind: "write" }]),
      stepEnd(),
    ]);
  });

  it("perFileResults yield one candidate per valid item in order", () => {
    const details = {
      path: "top.md",
      diff: "+1|top",
      perFileResults: [
        { path: "a.md", diff: "+1|x" },
        { path: "", diff: "+1|y" },
        { path: "b.md", diff: 7 },
        { path: "c.md", diff: "-2|z" },
      ],
    };
    expect(endWith("edit", toolEnd({ result: okResult(details) }))).toEqual([
      filesChanged([
        { path: "a.md", added: 1, removed: 0, kind: "edit" },
        { path: "c.md", added: 0, removed: 1, kind: "edit" },
      ]),
      stepEnd(),
    ]);
  });

  it("the registered edit name decides even when the end frame names bash", () => {
    const events = endWith("edit", toolEnd({ result: okResult(APP_DETAILS) }, "bash"));
    expect(events.map((event) => event.type)).toEqual(["files.changed", "step.end"]);
  });

  it("step.end output never carries details strings", () => {
    const details = { ...APP_DETAILS, resolvedPath: "/ws/secret/resolved.txt" };
    for (const name of ["edit", "write"]) {
      const events = endWith(name, toolEnd({ result: okResult(details) }, name));
      const last = events.at(-1);
      expect(last?.type).toBe("step.end");
      const output = last?.type === "step.end" ? last.data.output : "";
      expect(output).toBe("ok");
      for (const text of [APP_DETAILS.path, APP_DETAILS.diff, details.resolvedPath]) {
        expect(output).not.toContain(text);
      }
    }
  });
});

describe("failure, non edit/write and prototype keys (reducer side)", () => {
  it.each([
    [
      "frame isError edit",
      "edit",
      toolEnd({ isError: true, result: okResult(APP_DETAILS) }),
      "failed",
    ],
    [
      "result.isError edit",
      "edit",
      toolEnd({ result: { ...okResult(APP_DETAILS), isError: true } }),
      "done",
    ],
    ["bash with exitCode", "bash", toolEnd({ result: okResult({ exitCode: 0 }) }, "bash"), "done"],
    [
      "read with resolvedPath",
      "read",
      toolEnd({ result: okResult({ resolvedPath: "/ws/a.md" }) }, "read"),
      "done",
    ],
    [
      "ast_edit with path and diff",
      "ast_edit",
      toolEnd({ result: okResult(APP_DETAILS) }, "ast_edit"),
      "done",
    ],
    ["edit with array details", "edit", toolEnd({ result: okResult([APP_DETAILS]) }), "done"],
    [
      "bash registered, edit-named end",
      "bash",
      toolEnd({ result: okResult(APP_DETAILS) }, "edit"),
      "done",
    ],
    [
      "edit with prototype-only keys",
      "edit",
      toolEnd({ result: okResult(Object.create(APP_DETAILS)) }),
      "done",
    ],
    [
      "write with prototype-only resolvedPath",
      "write",
      toolEnd({ result: okResult(Object.create({ resolvedPath: "/ws/a.md" })) }, "write"),
      "done",
    ],
  ] as const)("%s emits only step.end", (_name, registered, end, status) => {
    expect(endWith(registered, end)).toEqual([stepEnd(status)]);
  });

  it("unknown and duplicate ends emit nothing", () => {
    const end = toolEnd({ result: okResult(APP_DETAILS) });
    const state = running("edit");
    expect(applyFrame(state, { ...end, toolCallId: "call_unknown" }).events).toEqual([]);
    const first = applyFrame(state, end);
    expect(first.events.at(-1)?.type).toBe("step.end");
    expect(applyFrame(first.state, end).events).toEqual([]);
  });
});

describe("files.changed purity", () => {
  it("the same inputs yield equal events and frozen inputs stay untouched", () => {
    const frame = structuredClone(toolEnd({ result: okResult(APP_DETAILS) }));
    const snapshot = structuredClone(frame);
    deepFreeze(frame);
    const state = running("edit");
    const first = applyFrame(state, frame).events;
    const second = applyFrame(state, frame).events;
    expect(second).toEqual(first);
    expect(first[0]?.type).toBe("files.changed");
    expect(frame).toEqual(snapshot);
  });

  it("returned files do not alias details in either direction", () => {
    const details = structuredClone(APP_DETAILS);
    const state = running("edit");
    const end = toolEnd({ result: okResult(details) });
    const first = filesOf(applyFrame(state, end).events);
    first.push({ path: "injected", added: 0, removed: 0, kind: "edit" });
    const change = first[0];
    if (change === undefined) {
      throw new Error("expected a candidate");
    }
    change.path = "mutated";
    change.added = 99;
    expect(details).toEqual(APP_DETAILS);
    details.path = "/ws/changed-after.ts";
    expect(change.path).toBe("mutated");
    const again = filesOf(applyFrame(state, toolEnd({ result: okResult(APP_DETAILS) })).events);
    expect(again).toEqual([{ path: "/ws/src/app.ts", added: 2, removed: 1, kind: "edit" }]);
  });
});

type Candidate = { path: string; added: number | null; removed: number | null; kind: string };

function filesOf(events: ChatEvent<string>[]): Candidate[] {
  const head = events[0];
  if (head?.type !== "files.changed") {
    throw new Error("expected files.changed first");
  }
  return head.data.files as Candidate[];
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
}
