/**
 * Issue #1968 (s2c-kb-session tasks 6.2): chat-web「事件流消费与续流」Scenario「检索结果事件严格解码」
 * through the connector, and「纯会话视图归约」Scenario「检索结果归约」through `applyChatEvent`.
 * Decode rules are chat-stream「检索结果事件发布」; the negative rows are the「组 6 首刀约定」table.
 * Oracles are the scenarios' literals. Cases marked (guard) already hold before the change.
 */
import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import { deepFrozen, reduce, toolStep } from "./chat-page-file-changes-support.js";
import { chatSnapshot, historyUser, installedChat, settle } from "./chat-stream-support.js";

const HIT = { documentId: "d1", name: "规则.md", similarity: 0.82, content: "超时规则切片" };
const OK_BASE = { kbId: "k1", name: "产品文档", status: "ok", hits: [HIT] };
const MISSING_BASE = { kbId: "k9", name: null, status: "not_found", hits: [] };
const FIRST = { messageId: 7, stepId: 5, intent: "查规则", bases: [OK_BASE, MISSING_BASE] };
const SECOND = {
  ...FIRST,
  intent: null,
  bases: [{ kbId: "k1", name: "产品文档", status: "not_ready", hits: [] }],
};

/** `1:2` snapshot over a running assistant (id 0); `steps` are snapshot steps. */
function wired(steps: Parameters<typeof chatSnapshot>[0] = {}) {
  return installedChat(chatSnapshot({ cursor: { epoch: 1, seq: 2 }, ...steps }));
}

/** `FIRST` with fields of base `at` replaced; `hitWith` replaces fields of base 0's only hit. */
function baseWith(fields: Record<string, unknown>, at = 0) {
  return {
    ...FIRST,
    bases: FIRST.bases.map((base, i) => (i === at ? { ...base, ...fields } : base)),
  };
}

function hitWith(fields: Record<string, unknown>) {
  return baseWith({ hits: [{ ...HIT, ...fields }] });
}

function without(value: Record<string, unknown>, key: string) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("chat-web「检索结果事件严格解码」", () => {
  it("delivers kb.hits(1:3) and kb.hits(1:4, intent null) in order, value for value", async () => {
    const connector = await wired();
    connector.source.emitData("kb.hits", "1:3", FIRST);
    connector.source.emitData("kb.hits", "1:4", SECOND);
    expect(connector.events).toStrictEqual([
      { type: "kb.hits", data: FIRST },
      { type: "kb.hits", data: SECOND },
    ]);
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  it("accepts the limits: five bases, six hits on an ok base, a failed base, empty hit strings", async () => {
    const connector = await wired();
    const edge = { documentId: "", name: "", similarity: -0.5, content: "" };
    const limits = {
      ...FIRST,
      stepId: -1,
      bases: [
        { ...OK_BASE, hits: Array.from({ length: 6 }, () => edge) },
        { ...OK_BASE, kbId: "k2", hits: [] },
        { kbId: "k3", name: "工单", status: "failed", hits: [] },
        { kbId: "k4", name: "手册", status: "not_ready", hits: [] },
        MISSING_BASE,
      ],
    };
    connector.source.emitData("kb.hits", "1:3", limits);
    expect(connector.events).toStrictEqual([{ type: "kb.hits", data: limits }]);
    expect(connector.loads).toHaveLength(1);
  });

  const invalid: Array<[string, unknown]> = [
    ["a missing key (no intent)", without(FIRST, "intent")],
    ["one more key", { ...FIRST, query: "查规则" }],
    ['stepId "5"', { ...FIRST, stepId: "5" }],
    ["stepId 1.5", { ...FIRST, stepId: 1.5 }],
    ['messageId "7"', { ...FIRST, messageId: "7" }],
    ["intent a number", { ...FIRST, intent: 3 }],
    ['intent ""', { ...FIRST, intent: "" }],
    ["bases not an array", { ...FIRST, bases: OK_BASE }],
    ["bases []", { ...FIRST, bases: [] }],
    ["six bases", { ...FIRST, bases: Array.from({ length: 6 }, () => OK_BASE) }],
    ["a base that is a string", { ...FIRST, bases: ["k1"] }],
    ["a base missing hits", { ...FIRST, bases: [without(OK_BASE, "hits")] }],
    ["a base with one more key", baseWith({ score: 1 })],
    ['a base with kbId ""', baseWith({ kbId: "" })],
    ['a base with status "partial"', baseWith({ status: "partial" })],
    ["a not_found base with a string name", baseWith({ name: "不可见" }, 1)],
    ["an ok base with a null name", baseWith({ name: null })],
    ['an ok base with name ""', baseWith({ name: "" })],
    ["a failed base carrying a hit", baseWith({ status: "failed" })],
    ["a not_found base carrying a hit", baseWith({ hits: [HIT] }, 1)],
    ["an ok base with seven hits", baseWith({ hits: Array.from({ length: 7 }, () => HIT) })],
    ["a hit missing content", baseWith({ hits: [without(HIT, "content")] })],
    ["a hit with one more key", hitWith({ url: "x" })],
    ['a hit with similarity "0.8"', hitWith({ similarity: "0.8" })],
    ["a hit with similarity null", hitWith({ similarity: null })],
    ["a hit with a numeric documentId", hitWith({ documentId: 1 })],
  ];

  it.each(invalid)("%s starts a full-snapshot resync and is not delivered", async (_l, data) => {
    const connector = await wired();
    connector.source.emitData("kb.hits", "1:3", data);
    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(2);
  });

  it("a hit whose similarity parses to Infinity (1e999) starts a resync and is not delivered", async () => {
    const connector = await wired();
    const raw = JSON.stringify(FIRST).replace('"similarity":0.82', '"similarity":1e999');
    expect(raw).toContain("1e999");
    connector.source.emitNamed("kb.hits", raw, "1:3");
    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(2);
  });
});

const kbStep = (status: "running" | "done" = "running") =>
  toolStep(5, 0, "kb_search", null, status);

function runningView(): ChatState {
  return deepFrozen(chatStateFromSnapshot(chatSnapshot({ content: "前文" })));
}

/** The kb.hits event `data` retargeted at `messageId` / `stepId` (default: assistant 0, step 5). */
function kbHits(
  data: typeof FIRST | typeof SECOND,
  messageId = 0,
  stepId = data.stepId,
): ChatEvent {
  return { type: "kb.hits", data: { ...data, messageId, stepId } } as ChatEvent;
}

const START: ChatEvent = {
  type: "step.start",
  data: {
    messageId: 0,
    stepId: 5,
    name: "kb_search",
    detail: "{}",
    bodyOffset: 2,
    approvalId: null,
  },
};

function step5(state: ChatState) {
  return state.messages.find((message) => message.id === 0)?.steps.find((step) => step.id === 5);
}

describe("chat-web「检索结果归约」", () => {
  it("step.start makes kbHits null; each kb.hits replaces it (the later wins), nothing else moves", () => {
    const started = reduce(runningView(), START);
    expect(step5(started)).toStrictEqual({
      id: 5,
      name: "kb_search",
      detail: "{}",
      output: "",
      changes: null,
      status: "running",
      bodyOffset: 2,
      kbHits: null,
    });
    const first = reduce(started, kbHits(FIRST));
    expect(step5(first)).toStrictEqual({
      ...step5(started),
      kbHits: { intent: "查规则", bases: FIRST.bases },
    });
    expect(first.messages[1]).toMatchObject({ content: "前文", status: "running" });
    expect(first.messages[0]).toBe(started.messages[0]);
    expect(first.status).toBe("running");
    const second = reduce(first, kbHits(SECOND));
    expect(step5(second)).toStrictEqual({
      ...step5(started),
      kbHits: { intent: null, bases: SECOND.bases },
    });
  });

  it("only the targeted step changes: a sibling step keeps its reference", () => {
    const steps = [kbStep(), toolStep(6, 1, "kb_search", null, "running")];
    const before = deepFrozen(chatStateFromSnapshot(chatSnapshot({ steps })));
    const after = applyChatEvent(before, kbHits(FIRST));
    expect(after.messages[1]?.steps[1]).toBe(before.messages[1]?.steps[1]);
    expect(after.messages[1]?.steps[0]?.kbHits).toStrictEqual({
      intent: "查规则",
      bases: FIRST.bases,
    });
  });

  it("the full chain step.start → kb.hits → step.end → turn.end keeps the kb.hits value", () => {
    const end = reduce(
      runningView(),
      START,
      kbHits(FIRST),
      { type: "step.end", data: { messageId: 0, stepId: 5, status: "done", output: "两条命中" } },
      { type: "turn.end", data: { messageId: 0, status: "done" } },
    );
    expect(step5(end)).toMatchObject({ status: "done", output: "两条命中" });
    expect(step5(end)?.kbHits).toStrictEqual({ intent: "查规则", bases: FIRST.bases });
  });

  it("turn.end stopped over a still-running kb_search step keeps its kbHits", () => {
    const end = reduce(runningView(), START, kbHits(SECOND), {
      type: "turn.end",
      data: { messageId: 0, status: "stopped" },
    });
    expect(step5(end)).toMatchObject({ status: "stopped" });
    expect(step5(end)?.kbHits).toStrictEqual({ intent: null, bases: SECOND.bases });
  });

  it("kb.hits does not lower retrying", () => {
    const state = reduce(
      deepFrozen(chatStateFromSnapshot(chatSnapshot({ steps: [kbStep()] }))),
      { type: "turn.retry", data: { messageId: 0 } },
      kbHits(FIRST),
    );
    expect(state.messages[1]).toMatchObject({ retrying: true });
    expect(step5(state)?.kbHits).toStrictEqual({ intent: "查规则", bases: FIRST.bases });
  });

  it("a snapshot holding a kb_search step gives kbHits null (刷新后只剩各轮)", () => {
    const state = chatStateFromSnapshot(
      deepFrozen(chatSnapshot({ assistantStatus: "done", steps: [kbStep("done")] })),
    );
    expect(step5(state)).toStrictEqual({
      id: 5,
      name: "kb_search",
      detail: "kb_search args",
      output: "ok",
      changes: null,
      status: "done",
      bodyOffset: null,
      kbHits: null,
    });
  });

  const unknownTargets: Array<[string, ChatEvent]> = [
    ["a step the message does not hold (99)", kbHits(FIRST, 0, 99)],
    ["a messageId the view does not hold (42)", kbHits(FIRST, 42)],
    ["the user message id", kbHits(FIRST, historyUser.id)],
  ];

  it.each(unknownTargets)("%s returns the same state reference (guard)", (_l, event) => {
    const before = deepFrozen(chatStateFromSnapshot(chatSnapshot({ steps: [kbStep()] })));
    const after = applyChatEvent(before, event);
    expect(after).toBe(before);
    expect(after.messages).toHaveLength(2);
  });
});

describe("kb.hits replay and resync", () => {
  it("a repeated frame is dropped by the cursor; a full-snapshot resync clears every kbHits", async () => {
    const connector = await wired({ steps: [kbStep()] });
    const live = { ...FIRST, messageId: 0 };
    connector.source.emitData("kb.hits", "1:3", live);
    connector.source.emitData("kb.hits", "1:3", { ...live, intent: "重复帧" });
    expect(connector.events).toStrictEqual([{ type: "kb.hits", data: live }]);
    expect(step5(connector.state)?.kbHits).toStrictEqual({ intent: "查规则", bases: FIRST.bases });

    connector.source.emitOpen();
    expect(connector.loads).toHaveLength(2);
    const recovered = chatSnapshot({ cursor: { epoch: 1, seq: 4 }, steps: [kbStep()] });
    connector.loads[1]?.resolve(recovered);
    await settle();
    expect(step5(connector.state)?.kbHits).toBeNull();

    connector.source.emitData("kb.hits", "1:4", live);
    expect(connector.events).toHaveLength(1);
    expect(step5(connector.state)?.kbHits).toBeNull();

    connector.source.emitData("kb.hits", "1:5", { ...live, intent: null });
    expect(connector.events).toHaveLength(2);
    expect(step5(connector.state)?.kbHits).toStrictEqual({ intent: null, bases: FIRST.bases });
  });
});
