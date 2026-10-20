/**
 * Issue #1568 (omp-pin-18-12 design D7) chat-stream「纯协议事件归约」 scenario「Eval step keeps its
 * name and carries browser status events」 at the pure createEventState/applyFrame seam
 * (session-events.test.ts is near its size limit; session-events-browser.test.ts is group 6's to
 * delete). Frames follow omp v18.12.3's `eval` shapes (design Context「浏览器 = eval 的 prelude」) and
 * v18.0.10's tool-bridge summaries (design D7 last sentence); every expected value is a literal from
 * that scenario or from those shapes, never derived from production code.
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 57;
const OPEN_CODE = 'await browser.open({ name: "main", url: "file:///ws/index.html" });';
const SHOT_CODE = 'await browser.tab("main").screenshot();';
const TIMEOUT = "Browser open timed out after 30000ms";

function reduce(frames: readonly OmpFrame[]): ChatEvent<string>[] {
  const out: ChatEvent<string>[] = [];
  let state = createEventState({ messageId: MESSAGE_ID, promptRequestId: "req_eval" });
  for (const frame of [{ type: "agent_start" } as OmpFrame, ...frames]) {
    const applied = applyFrame(state, frame);
    state = applied.state;
    out.push(...applied.events);
  }
  return out;
}

function toolStart(toolCallId: string, toolName: string, args: unknown): OmpFrame {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolEnd(toolCallId: string, toolName: string, result: unknown, isError = false): OmpFrame {
  return { type: "tool_execution_end", toolCallId, toolName, isError, result };
}

function evalResult(details: unknown, text = "(no output)") {
  return { content: [{ type: "text", text }], details };
}

/** The step.end mapper data of `stepId`; fails the test when there is none. */
function stepEnd(events: ChatEvent<string>[], stepId: string): Record<string, unknown> {
  const found = events.find((event) => event.type === "step.end" && event.data.stepId === stepId);
  expect(found).toBeDefined();
  return (found?.data ?? {}) as Record<string, unknown>;
}

/** One eval call with these details, ended (failed or not); its step.end mapper data. */
function evalEnd(details: unknown, isError = false): Record<string, unknown> {
  const events = reduce([
    toolStart("e1", "eval", { language: "js", code: "1" }),
    toolEnd("e1", "eval", evalResult(details), isError),
  ]);
  expect(events.map((event) => event.type)).toEqual(["turn.start", "step.start", "step.end"]);
  return stepEnd(events, "e1");
}

describe("Eval step keeps its name and carries browser status events", () => {
  const e1Args = { language: "js", code: OPEN_CODE };
  const e2Args = { language: "js", code: SHOT_CODE };
  const notes = { path: "notes.md", content: "hi" };
  const frames: OmpFrame[] = [
    toolStart("e1", "eval", e1Args),
    toolEnd(
      "e1",
      "eval",
      evalResult({
        language: "js",
        languages: ["js"],
        cells: [],
        statusEvents: [
          { op: "browser", detail: "open main file:///ws/index.html" },
          { op: "eval", detail: "x" },
        ],
      }),
    ),
    toolStart("e2", "eval", e2Args),
    toolEnd("e2", "eval", {
      content: [
        { type: "text", text: "shot" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      details: {
        language: "js",
        images: [{ data: "AAAA", mimeType: "image/png" }],
        statusEvents: [{ op: "browser", detail: "main.screenshot()" }],
        statusEventsElided: 3,
      },
    }),
    toolStart("w3", "write", notes),
  ];

  it("characterization: eval registers the name eval with its args JSON; no files.changed", () => {
    const events = reduce(frames);
    expect(events.map((event) => event.type)).toEqual([
      "turn.start",
      "step.start",
      "step.end",
      "step.start",
      "step.end",
      "step.start",
    ]);
    expect(events[1]).toEqual({
      type: "step.start",
      data: {
        messageId: MESSAGE_ID,
        stepId: "e1",
        name: "eval",
        detail:
          '{"language":"js","code":"await browser.open({ name: \\"main\\", url: \\"file:///ws/index.html\\" });"}',
      },
    });
    expect(events[3]).toEqual({
      type: "step.start",
      data: { messageId: MESSAGE_ID, stepId: "e2", name: "eval", detail: JSON.stringify(e2Args) },
    });
    expect(events[5]).toEqual({
      type: "step.start",
      data: { messageId: MESSAGE_ID, stepId: "w3", name: "write", detail: JSON.stringify(notes) },
    });
  });

  it("each eval step.end carries browser {calls, elided} from its statusEvents", () => {
    const events = reduce(frames);
    expect(stepEnd(events, "e1")).toEqual({
      messageId: MESSAGE_ID,
      stepId: "e1",
      status: "done",
      output: "(no output)",
      browser: {
        calls: [{ detail: "open main file:///ws/index.html", error: null }],
        elided: null,
      },
    });
    expect(stepEnd(events, "e2")).toEqual({
      messageId: MESSAGE_ID,
      stepId: "e2",
      status: "done",
      output: "shot\n[图片]",
      browser: { calls: [{ detail: "main.screenshot()", error: null }], elided: 3 },
    });
  });

  it("a failed eval carries its browser error, a non-string detail becomes null", () => {
    expect(evalEnd({ statusEvents: [{ op: "browser", error: TIMEOUT }] }, true)).toEqual({
      messageId: MESSAGE_ID,
      stepId: "e1",
      status: "failed",
      output: "(no output)",
      browser: { calls: [{ detail: null, error: TIMEOUT }], elided: null },
    });
    expect(evalEnd({ statusEvents: [{ op: "browser", detail: 7 }] }).browser).toEqual({
      calls: [{ detail: null, error: null }],
      elided: null,
    });
  });

  it("v18.0.10 tool-bridge summaries: {op,chars} and {op,chars,hasError,error}, {op,error}", () => {
    const statusEvents = [
      { op: "browser", chars: 12 },
      { op: "browser", chars: 40, hasError: true, error: "Navigation failed" },
      { op: "browser", error: "Tool bridge threw" },
      { op: "read", chars: 3 },
    ];
    expect(evalEnd({ statusEvents }).browser).toEqual({
      calls: [
        { detail: null, error: null },
        { detail: null, error: "Navigation failed" },
        { detail: null, error: "Tool bridge threw" },
      ],
      elided: null,
    });
  });

  it("only own keys of plain objects: prototype keys and non-plain elements are skipped", () => {
    const inherited = Object.create({ op: "browser", detail: "main.screenshot()" });
    const element = Object.assign(Object.create({ detail: "inherited", error: "inherited" }), {
      op: "browser",
    });
    const statusEvents = [null, "browser", [{ op: "browser" }], inherited, element];
    expect(evalEnd({ statusEvents, statusEventsElided: 1 }).browser).toEqual({
      calls: [{ detail: null, error: null }],
      elided: 1,
    });
    expect(evalEnd(Object.create({ statusEventsElided: 4 })).browser).toBeUndefined();
  });

  it("elided alone is enough; a non-positive or non-integer count is null", () => {
    expect(evalEnd({ statusEvents: [], statusEventsElided: 5 }).browser).toEqual({
      calls: [],
      elided: 5,
    });
    for (const count of [0, -2, 2.5, "3", Number.MAX_SAFE_INTEGER + 2]) {
      const calls = [{ op: "browser", detail: "close all" }];
      expect(evalEnd({ statusEvents: calls, statusEventsElided: count }).browser).toEqual({
        calls: [{ detail: "close all", error: null }],
        elided: null,
      });
    }
  });

  it("no browser field: details lacking statusEvents, prototype statusEvents, bash, other ends", () => {
    const shots = [{ op: "browser", detail: "open main x" }];
    const cases: Array<[string, unknown, boolean]> = [
      ["eval", evalResult({ language: "js" }), false],
      ["eval", evalResult(Object.create({ statusEvents: [{ op: "browser" }] })), false],
      ["eval", evalResult({ statusEvents: [{ op: "eval", detail: "x" }] }), false],
      ["eval", evalResult({ statusEvents: { 0: shots[0] } }), false],
      ["eval", evalResult([{ statusEvents: shots }]), false],
      ["eval", "plain text", true],
      ["eval", undefined, true],
      ["bash", evalResult({ statusEvents: shots }), false],
      ["write", evalResult({ statusEvents: shots, resolvedPath: "" }), false],
    ];
    for (const [tool, result, isError] of cases) {
      const events = reduce([toolStart("c1", tool, {}), toolEnd("c1", tool, result, isError)]);
      expect(Object.keys(stepEnd(events, "c1")).sort()).toEqual([
        "messageId",
        "output",
        "status",
        "stepId",
      ]);
    }
  });
});
