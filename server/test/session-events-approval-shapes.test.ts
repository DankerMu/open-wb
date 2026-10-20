/**
 * Issue #1566 (omp-pin-18-12 task 2.2): chat-stream「纯协议事件归约」 scenario「Approval frames are not
 * reducer events」 as rewritten by #1563 — the three-item approval, the two-item approval, the
 * browser prelude card and a non-approval extension UI request arrive during a started turn and
 * each is filtered with unchanged state and no event. The four frames are the scenario's literals.
 * (session-events.test.ts is at 721 lines; design 行数预算 sends new cases to new files.)
 */
import { describe, expect, it } from "vitest";
import { applyFrame, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const FRAMES: Array<[string, OmpFrame]> = [
  [
    "the three-item approval",
    {
      type: "extension_ui_request",
      id: "r1",
      method: "select",
      title: "Allow tool: bash\nCommand: echo workbuddy-smoke",
      options: ["Approve", "Approve bash for this session", "Deny"],
    },
  ],
  [
    "the two-item approval",
    {
      type: "extension_ui_request",
      id: "r2",
      method: "select",
      title: "Allow tool: bash\nCommand: echo workbuddy-smoke",
      options: ["Approve", "Deny"],
    },
  ],
  [
    "the browser prelude card",
    {
      type: "extension_ui_request",
      id: "p1",
      method: "select",
      title: "Allow tool: browser",
      options: ["Approve", "Deny"],
    },
  ],
  [
    "a non-approval request",
    { type: "extension_ui_request", id: "u1", method: "input", title: "Your name?" },
  ],
];

describe("chat-stream「Approval frames are not reducer events」(#1563 shapes)", () => {
  it.each(FRAMES)("%s during a started turn: no event, unchanged state", (_label, frame) => {
    const state = applyFrame(createEventState({ messageId: 7, promptRequestId: "p" }), {
      type: "agent_start",
    }).state;
    const before = structuredClone(state);

    const result = applyFrame(state, frame);

    expect(result.events).toEqual([]);
    expect(result.state).toEqual(before);
  });
});
