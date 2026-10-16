// change chat-interleaved-segments 切片 6（issue 1475）：thinking-fold「深度思考折叠块呈现」改写后的分段布局场景
// （owner 2026-10-15 B12：只展开正在思考的那一段；B5：每段各自的时长）与旧布局对照例。seam：整页挂载 + 假 API /
// 假 EventSource（chat-segments-support.tsx），期望值取自场景字面量与 N = max(1, round(ms ÷ 1000))。旧布局夹具按
// design D14 的判定：快照里已有思考而 `thinkingSegments` 为 `[]`，其后到达的 `thinking.end` 段的
// `thinkingOffset` 取快照思考的长度（通用纪律第 4 种改法同一取值），消息保持旧布局。
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage } from "./chat-page-support.js";
import {
  assistant,
  foldStates,
  folds,
  isOpen,
  openSession,
  segment,
  session,
  titleOf,
  triggerOf,
} from "./chat-segments-support.js";

const ACTIVE = "正在思考…";
const TEXT = '[data-slot="reasoning-text"]';

afterEach(() => {
  cleanupChatPage();
});

function closing(bodyOffset: number, offset: number, length: number, before: number, ms: number) {
  return { thinkingMs: ms, segment: segment(bodyOffset, offset, length, before, ms) };
}

function click(fold: HTMLElement) {
  fireEvent.click(triggerOf(fold));
}

describe("thinking-fold「流式展开、终态收起」旧布局一例", () => {
  it("快照 running、思考 先想一想、没有段：折叠块一直展开到 turn.end done 才收起，thinking.end 后标题为 已思考 1 秒", async () => {
    const live = await openSession(session("running", { thinking: "先想一想" }));
    expect(foldStates()).toEqual([[ACTIVE, true, true]]);

    live.emit("thinking.end", closing(0, 4, 0, 0, 1400));
    expect(foldStates()).toEqual([["已思考 1 秒", true, true]]);
    live.emit("text.delta", { delta: "答案" });
    expect(foldStates()).toEqual([["已思考 1 秒", true, true]]);

    live.emit("turn.end", { status: "done" });
    expect(foldStates()).toEqual([["已思考 1 秒", false, false]]);
  });
});

describe("thinking-fold「标题三态与多段思考」分段布局的快照", () => {
  it("failed 消息两段：第一段 1500ms、第二段长度与毫秒为 null：已思考 2 秒 与 深度思考过程，都不带流光、都收起", async () => {
    await openSession(
      session("failed", {
        content: "回答",
        thinking: "想甲想乙",
        thinkingSegments: [segment(0, 0, 2, 0, 1500), segment(1, 2, null, 0, null)],
      }),
    );

    expect(folds().map(titleOf)).toEqual([
      ["已思考 2 秒", false],
      ["深度思考过程", false],
    ]);
    expect(foldStates().map(([, open]) => open)).toEqual([false, false]);
  });
});

describe("thinking-fold「深度思考折叠块呈现」只含空白的思考段", () => {
  it("思考原文只有 \\n、有一段：照样渲染折叠块（只有原文为空串的段不渲染）", async () => {
    await openSession(
      session("done", {
        content: "答",
        thinking: "\n",
        thinkingMs: 500,
        thinkingSegments: [segment(0, 0, 1, 0, 500)],
      }),
    );

    expect(folds().map(titleOf)).toEqual([["已思考 1 秒", false]]);
  });
});

describe("thinking-fold「用户手动切换保留」分段布局", () => {
  it("第一段结束收起后用户展开它：正文、第二段思考、第二段的 thinking.end 与 turn.end 都不改变它；第二段在其 thinking.end 时收起", async () => {
    const live = await openSession(session("running"));
    live.emit("thinking.delta", { delta: "先" });
    live.emit("thinking.end", closing(0, 0, 1, 0, 400));
    const [first] = folds() as [HTMLElement];
    expect(isOpen(first)).toBe(false);

    click(first);
    live.emit("text.delta", { delta: "看" });
    live.emit("thinking.delta", { delta: "想" });
    expect(foldStates()).toEqual([
      ["已思考 1 秒", true, false],
      [ACTIVE, true, true],
    ]);
    live.emit("thinking.end", closing(1, 1, 1, 0, 700));
    expect(foldStates()).toEqual([
      ["已思考 1 秒", true, false],
      ["已思考 1 秒", false, false],
    ]);
    live.emit("turn.end", { status: "done" });

    expect(folds()[0]).toBe(first);
    expect(foldStates()).toEqual([
      ["已思考 1 秒", true, false],
      ["已思考 1 秒", false, false],
    ]);
  });
});

describe("thinking-fold「分段布局下只展开进行中的一段」", () => {
  it("第二段进行中：第一个收起、第二个展开带 data-running 且只有它的主体在 DOM；第二段结束后两个都收起，消息仍 running", async () => {
    const live = await openSession(session("running"));
    live.emit("thinking.delta", { delta: "先" });
    live.emit("thinking.end", closing(0, 0, 1, 0, 400));
    live.emit("text.delta", { delta: "看" });
    live.emit("thinking.delta", { delta: "想" });

    expect(foldStates()).toEqual([
      ["已思考 1 秒", false, false],
      [ACTIVE, true, true],
    ]);
    const [first, second] = folds() as [HTMLElement, HTMLElement];
    expect(titleOf(second)).toEqual([ACTIVE, true]);
    expect(first.querySelector(TEXT)).toBeNull();
    expect(second.querySelector(TEXT)?.textContent).toBe("想");
    expect(assistant().querySelectorAll(TEXT)).toHaveLength(1);

    live.emit("thinking.end", closing(1, 1, 1, 0, 2200));
    live.emit("text.delta", { delta: "好" });

    expect(foldStates()).toEqual([
      ["已思考 1 秒", false, false],
      ["已思考 2 秒", false, false],
    ]);
    expect(assistant().querySelector('[data-slot="message-caret"]')).not.toBeNull();
  });
});

describe("thinking-fold「终态消息主体限高」分段布局的 running 例", () => {
  it("进行中的一段增长到 120 行：带 data-running、主体限高并盒内滚动；该段 thinking.end 后属性消失（消息仍 running）", async () => {
    const live = await openSession(session("running"));
    const lines = Array.from({ length: 120 }, (_, index) => `思考第 ${String(index + 1)} 行`);
    const thinking = lines.join("\n");

    live.emit("thinking.delta", { delta: thinking });

    const [fold] = folds() as [HTMLElement];
    const body = fold.querySelector(TEXT);
    expect(fold.getAttribute("data-running")).toBe("");
    expect([...(body?.classList ?? [])].filter((name) => /^(max-h-|overflow-)/.test(name))).toEqual(
      ["max-h-48", "overflow-auto"],
    );

    live.emit("thinking.end", closing(0, 0, thinking.length, 0, 3000));
    expect(fold.hasAttribute("data-running")).toBe(false);
    expect(folds()).toEqual([fold]);
  });
});

describe("thinking-fold「快照中的思考与截断标记」分段布局", () => {
  it("思考以 …（已截断）结尾、整段一行：收起的折叠块，展开后逐字显示标记；thinking 为 null 与空串的不渲染折叠块", async () => {
    const truncated = "想了很久很久…（已截断）";
    const live = await openSession(
      session("done", {
        content: "一",
        thinking: truncated,
        thinkingMs: 5000,
        thinkingSegments: [segment(0, 0, truncated.length, 0, 5000)],
      }),
    );
    const [fold] = folds() as [HTMLElement];
    expect(isOpen(fold)).toBe(false);
    click(fold);
    expect(fold.querySelector(TEXT)?.textContent).toBe(truncated);

    await live.resync(session("done", { content: "二", thinking: null }));
    expect(folds()).toEqual([]);
    await live.resync(session("done", { content: "三", thinking: "" }));
    expect(folds()).toEqual([]);
  });
});
