// change s2c-kb-session 组 6 第二刀（#1969）：chat-web「会话知识库检索卡」。seam：整页挂载 + 假 API / 假 EventSource
// （chat-segments-support.tsx），实时一侧经 step.start / kb.hits / step.end 帧，刷新一侧经消息快照；期望值取自规格
// 四个场景的字面量与「组 6 第二刀约定」的补例。
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage } from "./chat-page-support.js";
import {
  assistant,
  groups,
  type Message,
  openSession,
  session,
  slots,
  step,
} from "./chat-segments-support.js";

type Step = Message["steps"][number];
type Approval = Message["approvals"][number];

afterEach(() => {
  cleanupChatPage();
});

const RULE_HITS = [
  { documentId: "d1", name: "规则.md", similarity: 0.68, content: "超时 48 小时\n自动关闭" },
  { documentId: "d2", name: "流程.pdf", similarity: 0.5, content: "<b>x</b>" },
];
const SLA_HIT = { documentId: "d3", name: "SLA.md", similarity: 0.41, content: "工单分级" };

function question(text: string) {
  return JSON.stringify({ question: text });
}

/** 快照里的 `kb_search` 步骤，detail 带问句。 */
function kbStep(id: number, ordinal: number, status: Step["status"], ask: string): Step {
  return { ...step(id, ordinal, "kb_search", 0, status), detail: question(ask), output: "r" };
}

function kbStart(stepId: number, detail: string) {
  return { stepId, name: "kb_search", detail, bodyOffset: 0, approvalId: null };
}

function okBase(kbId: string, name: string, hits: readonly object[]) {
  return { kbId, name, status: "ok", hits };
}

function cards() {
  return [...assistant().querySelectorAll<HTMLElement>('[data-slot="kb-search-card"]')];
}

function onlyCard() {
  const found = cards();
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

function text(root: Element, slot: string) {
  return root.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;
}

/** 卡头的 [标题, 轮数, 状态]。 */
function head(card = onlyCard()) {
  return [
    text(card, "kb-search-title"),
    text(card, "kb-search-rounds"),
    text(card, "kb-search-status"),
  ];
}

function rows(card = onlyCard()) {
  return [...card.querySelectorAll<HTMLElement>('[data-slot="kb-search-row"]')];
}

/** 每行的 [轮次, 意图, 命中条数, 确认标记, 行状态]；没有的为 null。 */
function rowStates(card = onlyCard()) {
  return rows(card).map((row) =>
    [
      "kb-search-round",
      "kb-search-intent",
      "kb-search-count",
      "kb-search-mark",
      "kb-search-row-status",
    ].map((slot) => text(row, slot)),
  );
}

function toggle(row: HTMLElement) {
  const button = row.querySelector("button");
  if (!button) throw new Error("行内没有展开控件");
  return button;
}

function expanded(card = onlyCard()) {
  return rows(card).map(
    (row) => row.querySelector("button")?.getAttribute("aria-expanded") ?? null,
  );
}

/** 一行展开内容里逐库的 [库标签, 说明]；`ok` 的库说明为 null。 */
function basesOf(row: HTMLElement) {
  return [...row.querySelectorAll('[data-slot="kb-search-base"]')].map((base) => [
    text(base, "kb-search-base-name"),
    text(base, "kb-search-base-note"),
  ]);
}

/** 实时两轮：规格场景「实时两轮」的帧序列。 */
async function liveTwoRounds() {
  const live = await openSession(session("running"));
  live.emit("step.start", kbStart(1, question("查规则 问句")));
  live.emit("kb.hits", {
    stepId: 1,
    intent: "查规则",
    bases: [okBase("k1", "产品文档", RULE_HITS)],
  });
  live.emit("step.end", { stepId: 1, status: "done", output: "r" });
  live.emit("step.start", kbStart(2, question("工单超时 详细说明")));
  live.emit("kb.hits", { stepId: 2, intent: null, bases: [okBase("k1", "产品文档", [SLA_HIT])] });
  live.emit("step.end", { stepId: 2, status: "done", output: "r" });
  return live;
}

/** 一轮意图为 `甲` 的检索：step.start、kb.hits（给定的库）、以 `status` 结束。 */
async function firstRound(status: "done" | "failed", bases: readonly object[]) {
  const live = await openSession(session("running"));
  live.emit("step.start", kbStart(1, question("甲")));
  live.emit("kb.hits", { stepId: 1, intent: "甲", bases });
  live.emit("step.end", { stepId: 1, status, output: "r" });
  return live;
}

describe("chat-web「会话知识库检索卡」", () => {
  it("实时两轮：一张卡、卡头与两行的字面量；展开第一行列出两条命中的文档名、相似度与原文", async () => {
    await liveTwoRounds();

    const card = onlyCard();
    expect(card.getAttribute("aria-label")).toBe("知识库检索");
    expect(head(card)).toEqual(["知识库检索 · 产品文档", "（2 轮）", "检索完成"]);
    expect(card.querySelector('[data-slot="kb-search-title"]')?.getAttribute("title")).toBe(
      "知识库检索 · 产品文档",
    );
    expect(rowStates(card)).toEqual([
      ["第 1 轮", "查规则", "命中 2 条", null, "已完成"],
      ["第 2 轮", "工单超时 详细说明", "命中 1 条", null, "已完成"],
    ]);
    // 检索不进工具段：消息里没有工具调用组。
    expect(groups()).toHaveLength(0);
    expect(expanded(card)).toEqual(["false", "false"]);

    const [first] = rows(card) as [HTMLElement];
    fireEvent.click(toggle(first));

    expect(expanded(card)).toEqual(["true", "false"]);
    expect(basesOf(first)).toEqual([["产品文档", null]]);
    expect([...first.querySelectorAll("li")].map((hit) => hit.textContent)).toEqual([
      "规则.md相似度 0.68超时 48 小时\n自动关闭",
      "流程.pdf相似度 0.50<b>x</b>",
    ]);
    // 切片原文是纯文本：`<b>x</b>` 不生成元素。
    expect(card.querySelector("b")).toBeNull();
  });

  it("刷新后只剩各轮：仍是一张卡、两行；行里是 detail 的问句与状态，没有命中条数，行不可展开", async () => {
    await openSession(
      session("done", {
        content: "",
        steps: [kbStep(1, 0, "done", "查规则 问句"), kbStep(2, 1, "done", "工单超时 详细说明")],
      }),
    );

    const card = onlyCard();
    expect(head(card)).toEqual(["知识库检索", "（2 轮）", "检索完成"]);
    expect(rowStates(card)).toEqual([
      ["第 1 轮", "查规则 问句", null, null, "已完成"],
      ["第 2 轮", "工单超时 详细说明", null, null, "已完成"],
    ]);
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("检索行的确认标记：deny 与 timeout 分别在行状态之前标 已拒绝 与 超时自动允许；消息内没有兜底确认记录", async () => {
    const settled = (id: number, decision: Approval["decision"], stepId: number): Approval => ({
      id,
      tool: "kb_search",
      title: "Allow tool: kb_search",
      requestedAt: 1,
      expiresAt: 2,
      decision,
      stepId,
    });
    await openSession(
      session("done", {
        steps: [kbStep(1, 0, "done", "甲"), kbStep(2, 1, "done", "乙")],
        approvals: [settled(8, "deny", 1), settled(9, "timeout", 2)],
      }),
    );

    expect(rowStates()).toEqual([
      ["第 1 轮", "甲", null, "已拒绝", "已完成"],
      ["第 2 轮", "乙", null, "超时自动允许", "已完成"],
    ]);
    for (const row of rows()) {
      const mark = row.querySelector('[data-slot="kb-search-mark"]') as HTMLElement;
      const status = row.querySelector('[data-slot="kb-search-row-status"]') as HTMLElement;
      expect(mark.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(assistant().querySelector('[data-slot="approval-records"]')).toBeNull();
  });

  it("部分失败与检索中：卡头 检索中；第一行 命中 0 条，展开后先列 检索失败 的库，再列命中 0 条的库", async () => {
    const live = await openSession(session("running"));
    live.emit("step.start", kbStart(1, question("甲")));
    live.emit("kb.hits", {
      stepId: 1,
      intent: "查两库",
      bases: [{ kbId: "k1", name: "甲库", status: "failed", hits: [] }, okBase("k2", "乙库", [])],
    });
    live.emit("step.end", { stepId: 1, status: "done", output: "r" });
    live.emit("step.start", kbStart(2, question("乙")));

    expect(head()).toEqual(["知识库检索 · 乙库", "（2 轮）", "检索中"]);
    expect(rowStates()).toEqual([
      ["第 1 轮", "查两库", "命中 0 条", null, "已完成"],
      ["第 2 轮", "乙", null, null, "运行中"],
    ]);
    const [first] = rows() as [HTMLElement];
    fireEvent.click(toggle(first));
    expect(basesOf(first)).toEqual([
      ["甲库", "检索失败"],
      ["乙库", null],
    ]);
    expect(first.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("chat-web「会话知识库检索卡」：补例", () => {
  it("意图回退：intent 为 null 且 detail 不是 JSON 时意图为空，不抛错", async () => {
    const live = await openSession(session("running"));
    live.emit("step.start", kbStart(1, "kb_search args"));
    live.emit("kb.hits", { stepId: 1, intent: null, bases: [okBase("k1", "产品文档", [SLA_HIT])] });
    live.emit("step.start", kbStart(2, JSON.stringify({ question: 7 })));

    expect(rowStates().map((row) => row[1])).toEqual(["", ""]);
  });

  it("not_found 的库标签用 kbId，not_ready 为 正在重建，本轮未检索；没有 ok 的库时卡头不接库名", async () => {
    await firstRound("done", [
      { kbId: "kb-gone", name: null, status: "not_found", hits: [] },
      { kbId: "k3", name: "丙库", status: "not_ready", hits: [] },
    ]);

    expect(head()).toEqual(["知识库检索", "（1 轮）", "检索完成"]);
    const [first] = rows() as [HTMLElement];
    fireEvent.click(toggle(first));
    expect(basesOf(first)).toEqual([
      ["kb-gone", "未找到该知识库"],
      ["丙库", "正在重建，本轮未检索"],
    ]);
  });

  it("卡头状态：stopped 不算失败为 检索完成；全部 failed 为 检索失败；库名按首次出现去重", async () => {
    const live = await firstRound("failed", [okBase("k2", "乙库", []), okBase("k1", "甲库", [])]);
    live.emit("step.start", kbStart(2, question("乙")));
    live.emit("kb.hits", { stepId: 2, intent: "乙", bases: [okBase("k1", "甲库", [])] });
    live.emit("step.end", { stepId: 2, status: "failed", output: "r" });

    expect(head()).toEqual(["知识库检索 · 乙库、甲库", "（2 轮）", "检索失败"]);
    expect(rowStates().map((row) => row[4])).toEqual(["失败", "失败"]);
    cleanupChatPage();

    await openSession(
      session("done", {
        steps: [kbStep(1, 0, "failed", "甲"), kbStep(2, 1, "stopped", "乙")],
      }),
    );
    expect(head()).toEqual(["知识库检索", "（2 轮）", "检索完成"]);
    expect(rowStates().map((row) => row[4])).toEqual(["失败", "已停止"]);
  });

  it("展开第一行后追加第三轮：同一张卡，第一行仍展开，新行收起", async () => {
    const live = await liveTwoRounds();
    const card = onlyCard();
    fireEvent.click(toggle(rows(card)[0] as HTMLElement));

    live.emit("step.start", kbStart(3, question("第三问")));
    live.emit("kb.hits", { stepId: 3, intent: "第三问", bases: [okBase("k1", "产品文档", [])] });

    expect(onlyCard()).toBe(card);
    expect(head(card)[1]).toBe("（3 轮）");
    expect(head(card)[2]).toBe("检索中");
    expect(expanded(card)).toEqual(["true", "false", "false"]);
  });

  it("展开一行后快照原地重装：卡仍挂载、行内无 button、无展开内容、不抛错", async () => {
    const live = await liveTwoRounds();
    const card = onlyCard();
    fireEvent.click(toggle(rows(card)[0] as HTMLElement));
    expect(card.querySelectorAll('[data-slot="kb-search-detail"]')).toHaveLength(1);

    await live.resync(
      session("running", {
        steps: [kbStep(1, 0, "done", "查规则 问句"), kbStep(2, 1, "done", "工单超时 详细说明")],
      }),
    );

    expect(onlyCard()).toBe(card);
    expect(rows(card)).toHaveLength(2);
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(card.querySelectorAll('[data-slot="kb-search-detail"]')).toHaveLength(0);
    expect(rowStates(card).map((row) => row[2])).toEqual([null, null]);
  });

  it("检索块是最后一块：小圆点单独一行在卡之下", async () => {
    const live = await openSession(session("running"));
    live.emit("step.start", kbStart(1, question("甲")));

    expect(slots().slice(0, 2)).toEqual(["kb-search-card", "message-caret-row"]);
  });
});
