/**
 * Change s2c-kb-session 5.2 (#1967) kb.hits at applyFrame (chat-stream「纯协议事件归约」, scenario
 * 「kb_search result yields a raw candidate」): a successful `kb_search` call's raw `details.bases` is
 * emitted immediately before its step.end, carrying the start frame's own top-level `intent`; the
 * reducer neither validates nor retains it. Expected events are literals from that scenario, plus the
 * fixture's extra cases (`result.isError`, prototype-only `bases`, empty or non-string `intent`).
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 1967;
const ARGS = { question: "q", kb_ids: ["k1"] };
const DETAIL = '{"question":"q","kb_ids":["k1"]}';
const RAW_BASES = [{ kbId: "k1" }];

type EventState = ReturnType<typeof createEventState>;

function started(): EventState {
  const bound = createEventState({ messageId: MESSAGE_ID, promptRequestId: "req_kb" });
  return applyFrame(bound, { type: "agent_start" }).state;
}

function toolStart(extra: Record<string, unknown> = {}, toolName = "kb_search"): OmpFrame {
  return { type: "tool_execution_start", toolCallId: "c1", toolName, args: ARGS, ...extra };
}

function toolEnd(extra: Record<string, unknown>): OmpFrame {
  return { type: "tool_execution_end", toolCallId: "c1", ...extra };
}

function okResult(details?: unknown): Record<string, unknown> {
  const content = [{ type: "text", text: "t" }];
  return details === undefined ? { content } : { content, details };
}

/** The events of one start + end pair on a started turn. */
function run(start: OmpFrame, end: OmpFrame): ChatEvent<string>[] {
  const first = applyFrame(started(), start);
  return [...first.events, ...applyFrame(first.state, end).events];
}

function stepStart(name = "kb_search"): ChatEvent<string> {
  const data = { messageId: MESSAGE_ID, stepId: "c1", name, detail: DETAIL };
  return { type: "step.start", data };
}

function stepEnd(status: "done" | "failed" = "done"): ChatEvent<string> {
  return { type: "step.end", data: { messageId: MESSAGE_ID, stepId: "c1", status, output: "t" } };
}

function kbHits(intent: string | null, bases: unknown = RAW_BASES): ChatEvent<string> {
  return { type: "kb.hits", data: { messageId: MESSAGE_ID, stepId: "c1", intent, bases } };
}

describe("kb_search result yields a raw candidate", () => {
  it("emits kb.hits with the start's intent immediately before step.end, without other details keys", () => {
    const end = toolEnd({ result: okResult({ bases: RAW_BASES, other: 1 }), isError: false });
    const events = run(toolStart({ intent: "查规则" }), end);
    expect(events).toEqual([stepStart(), kbHits("查规则"), stepEnd()]);
    expect(JSON.stringify(events[1])).not.toContain("other");
  });

  it("a failed call (frame isError) yields no kb.hits", () => {
    const end = toolEnd({ result: okResult({ bases: RAW_BASES }), isError: true });
    expect(run(toolStart({ intent: "查规则" }), end)).toEqual([stepStart(), stepEnd("failed")]);
  });

  it("a start without intent ends with kb.hits whose intent is null", () => {
    const end = toolEnd({ result: okResult({ bases: RAW_BASES }), isError: false });
    expect(run(toolStart(), end)).toEqual([stepStart(), kbHits(null), stepEnd()]);
  });

  it("a bash call ending with details.bases yields no kb.hits", () => {
    const end = toolEnd({ result: okResult({ bases: RAW_BASES }), isError: false });
    expect(run(toolStart({ intent: "查规则" }, "bash"), end)).toEqual([
      stepStart("bash"),
      stepEnd(),
    ]);
  });
});

describe("the reducer passes bases through and reads own properties only", () => {
  it("a result whose own isError is true yields no kb.hits even when the frame says false", () => {
    const result = { ...okResult({ bases: RAW_BASES }), isError: true };
    const events = run(toolStart({ intent: "查规则" }), toolEnd({ result, isError: false }));
    expect(events).toEqual([stepStart(), stepEnd()]);
  });

  it("bases only on the prototype of details, missing, or details not a plain object: no kb.hits", () => {
    const inherited = Object.create({ bases: RAW_BASES }) as Record<string, unknown>;
    for (const details of [inherited, { other: 1 }, [RAW_BASES], undefined]) {
      const events = run(toolStart({ intent: "查规则" }), toolEnd({ result: okResult(details) }));
      expect(events).toEqual([stepStart(), stepEnd()]);
    }
    expect(run(toolStart(), toolEnd({ result: "t" }))).toEqual([stepStart(), stepEnd()]);
  });

  it("an empty, non-string or inherited intent becomes null", () => {
    const end = toolEnd({ result: okResult({ bases: RAW_BASES }) });
    for (const intent of ["", 7, { text: "查规则" }, null]) {
      expect(run(toolStart({ intent }), end)).toEqual([stepStart(), kbHits(null), stepEnd()]);
    }
    const inherited = Object.assign(Object.create({ intent: "查规则" }) as OmpFrame, toolStart());
    expect(run(inherited, end)).toEqual([stepStart(), kbHits(null), stepEnd()]);
  });

  it("bases is forwarded unvalidated, an own undefined included, and the state keeps none of it", () => {
    for (const bases of ["x", [{ kbId: 7, extra: true }], []]) {
      const end = toolEnd({ result: okResult({ bases }) });
      expect(run(toolStart({ intent: "i" }), end)).toEqual([
        stepStart(),
        kbHits("i", bases),
        stepEnd(),
      ]);
    }
    const own = run(toolStart(), toolEnd({ result: okResult({ bases: undefined }) }));
    expect(own.map((event) => event.type)).toEqual(["step.start", "kb.hits", "step.end"]);
    const first = applyFrame(started(), toolStart({ intent: "查规则" }));
    const after = applyFrame(
      first.state,
      toolEnd({ result: okResult({ bases: [{ kbId: "kZ" }] }) }),
    );
    expect(JSON.stringify(after.state)).not.toContain("kZ");
    expect(JSON.stringify(after.state)).not.toContain("查规则");
  });

  it("uses the name registered at tool_execution_start, not the end frame's toolName", () => {
    const end = toolEnd({ result: okResult({ bases: RAW_BASES }), toolName: "bash" });
    expect(run(toolStart({ intent: "查规则" }), end)).toEqual([
      stepStart(),
      kbHits("查规则"),
      stepEnd(),
    ]);
  });
});
