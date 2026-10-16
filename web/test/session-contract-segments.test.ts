/**
 * Issue 1474 (chat-interleaved-segments 5.3, design D8): chat-web「API 客户端扩展」Scenario「分段位置
 * 三键严格解析」through the API client (message `thinkingSegments`, step `bodyOffset`, approval
 * `stepId`), the seven-key settled approval of `decideApproval`, and the values' way into the chat
 * view (`chatStateFromSnapshot`). Oracles are the scenario's literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStateFromSnapshot } from "../src/features/chat/stream.js";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const STEP_ID = 5;

const session = {
  id: SESSION_ID,
  title: "saved title",
  status: "running" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  ...NULL_SESSION_META,
};

const SEGMENTS = [
  { bodyOffset: 0, thinkingOffset: 0, thinkingLength: 4, stepsBefore: 0, thinkingMs: 1400 },
  { bodyOffset: 12, thinkingOffset: 4, thinkingLength: null, stepsBefore: 1, thinkingMs: null },
];

function step(id: number, bodyOffset: unknown) {
  return {
    id,
    ordinal: 0,
    name: "bash",
    detail: "{}",
    output: "",
    changes: null,
    status: "done",
    bodyOffset,
  };
}

function approval(id: number, stepId: unknown) {
  return {
    id,
    tool: "bash",
    title: "Allow tool: bash",
    requestedAt: 1_000,
    expiresAt: 61_000,
    decision: "allow",
    stepId,
  };
}

function message(id: number, role: "user" | "assistant", fields: Record<string, unknown> = {}) {
  return {
    id,
    role,
    content: role === "user" ? "问" : "看一下看一下看一下看一下",
    thinking: role === "user" ? null : "先想再想",
    status: role === "user" ? "done" : "running",
    createdAt: id,
    approvals: [],
    steps: [],
    undo: role === "user" ? "available" : null,
    attachments: [],
    error: null,
    thinkingMs: null,
    thinkingSegments: [],
    ...fields,
  };
}

const user = message(1, "user");
const segmented = message(2, "assistant", {
  thinkingSegments: SEGMENTS,
  steps: [step(STEP_ID, 12)],
  approvals: [approval(7, STEP_ID)],
});
const legacy = message(3, "assistant", {
  steps: [step(6, null)],
  approvals: [approval(8, null)],
});

function snapshotOf(messages: readonly unknown[]) {
  return { session, messages, streamCursor: { epoch: 1, seq: null }, todo: null };
}

function serve(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat-web「分段位置三键严格解析」", () => {
  it("keeps every value of both assistants and the user's [] in order, into the chat view", async () => {
    serve(snapshotOf([user, segmented, legacy]));
    const snapshot = await createApiClient().getMessages(SESSION_ID);

    expect(snapshot.messages.map((item) => item.thinkingSegments)).toStrictEqual([
      [],
      SEGMENTS,
      [],
    ]);
    expect(snapshot.messages.map((item) => item.steps.map((entry) => entry.bodyOffset))).toEqual([
      [],
      [12],
      [null],
    ]);
    expect(snapshot.messages.map((item) => item.approvals.map((entry) => entry.stepId))).toEqual([
      [],
      [STEP_ID],
      [null],
    ]);

    const view = chatStateFromSnapshot(snapshot).messages;
    expect(view.map((item) => item.thinkingSegments)).toStrictEqual([[], SEGMENTS, []]);
    expect(view.map((item) => item.steps.map((entry) => entry.bodyOffset))).toEqual([
      [],
      [12],
      [null],
    ]);
    expect(view.map((item) => item.approvals.map((entry) => entry.stepId))).toEqual([
      [],
      [STEP_ID],
      [null],
    ]);
  });

  const [first, second] = SEGMENTS;
  const withSegment = (segment: unknown) => ({ ...segmented, thinkingSegments: [first, segment] });
  const { thinkingSegments: _dropped, ...withoutSegments } = segmented;
  const { bodyOffset: _offset, ...stepWithoutOffset } = step(STEP_ID, 12);
  const { stepId: _stepId, ...approvalWithoutStep } = approval(7, STEP_ID);
  const rejected: Array<[string, unknown]> = [
    ["a message without thinkingSegments", withoutSegments],
    ["a segment with one more key", withSegment({ ...second, total: 1 })],
    ["a segment bodyOffset -1", withSegment({ ...second, bodyOffset: -1 })],
    ['a segment thinkingLength "4"', withSegment({ ...second, thinkingLength: "4" })],
    ["a segment stepsBefore null", withSegment({ ...second, stepsBefore: null })],
    ["a step without bodyOffset", { ...segmented, steps: [stepWithoutOffset] }],
    ["a step bodyOffset 1.5", { ...segmented, steps: [step(STEP_ID, 1.5)] }],
    ["an approval without stepId", { ...segmented, approvals: [approvalWithoutStep] }],
    ['an approval stepId "5"', { ...segmented, approvals: [approval(7, "5")] }],
    ["a user message with a segment", message(1, "user", { thinkingSegments: [first] })],
  ];

  it.each(rejected)("rejects the whole snapshot for %s", async (_label, bad) => {
    serve(snapshotOf([user, legacy, bad]));
    expectRequestFailure(await captureApiError(createApiClient().getMessages(SESSION_ID)), 200);
  });
});

describe("tool-approval「审批作答 REST」: decideApproval's 200 is seven keys", () => {
  it("returns the settled approval with its stepId; six keys and a string stepId are refused", async () => {
    serve(approval(7, STEP_ID));
    await expect(createApiClient().decideApproval(SESSION_ID, 7, "allow")).resolves.toStrictEqual(
      approval(7, STEP_ID),
    );
    serve(approval(7, null));
    await expect(createApiClient().decideApproval(SESSION_ID, 7, "allow")).resolves.toStrictEqual(
      approval(7, null),
    );

    for (const bad of [approvalWithout(), approval(7, "5"), approval(7, 1.5)]) {
      serve(bad);
      expectRequestFailure(
        await captureApiError(createApiClient().decideApproval(SESSION_ID, 7, "allow")),
        200,
      );
    }
  });
});

function approvalWithout() {
  const { stepId: _stepId, ...rest } = approval(7, STEP_ID);
  return rest;
}
