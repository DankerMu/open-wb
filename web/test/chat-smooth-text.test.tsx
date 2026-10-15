// issue 1449（issue 910 切片 7a）：chat-web「消息线程」的「正文逐字展开」段与场景「正文逐字展开」。
// seam：`useSmooth` 分支钉子直接挂 smooth-text.tsx 的 `SmoothText`；正文呈现走整页挂载 + 假 API /
// 假 EventSource，期望值取自场景字面量（`A` 加 200 字、500 字快照、复制与搜索读全文）。
// 假时钟（7a 实测）：`useSmooth` 的动画器只用 `requestAnimationFrame` 与 `Date.now`。tasks 7.2 列的五项
// 配置（再加 setTimeout / clearTimeout）能驱动它，钉子用例用的就是这五项；整页用例只假前三项，setTimeout
// 留真——页面夹具的 `settle` 与 `waitFor` 靠它。jsdom 的 rAF 在假时钟下推进 16ms 恰出一帧。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmoothText } from "../src/features/chat/smooth-text.js";
import {
  conversationSearchFixture,
  highlighted,
  openConversation,
  runningConversation,
  toggleSearch,
  typeQuery,
} from "./chat-page-search-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID, settle } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { jsonResponse } from "./support.js";

const HOOK_CLOCK = [
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Date",
  "setTimeout",
  "clearTimeout",
] as const;
const PAGE_CLOCK = ["requestAnimationFrame", "cancelAnimationFrame", "Date"] as const;
const FRAME_MS = 16;

/** 200 个互不重复成串的字：逐帧比对前缀才有意义；末五字 `甲乙丙丁戊` 只在末尾出现。 */
const TWO_HUNDRED = `${"春夏秋冬".repeat(48)}一二三甲乙丙丁戊`;
const LAST_FIVE = "甲乙丙丁戊";
const BODY = '[data-slot="message-body"]';
const CARET = '[data-slot="message-caret"]';

afterEach(() => {
  cleanupChatPage();
  vi.useRealTimers();
  uninstallMatchMedia();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

function frame() {
  act(() => {
    vi.advanceTimersByTime(FRAME_MS);
  });
}

describe("SmoothText（useSmooth 行为钉子）", () => {
  function Shown({ running, text }: { running: boolean; text: string }) {
    return (
      <SmoothText running={running} text={text}>
        {(shown) => <span data-testid="shown">{shown}</span>}
      </SmoothText>
    );
  }

  it("依赖 @assistant-ui/react useSmooth 分支：同一 provider 下逐次增长文本，显示的文本逐帧变长", () => {
    vi.useFakeTimers({ toFake: [...HOOK_CLOCK] });
    const { rerender } = render(<Shown running text="A" />);
    const shown = () => screen.getByTestId("shown").textContent ?? "";
    expect(shown()).toBe("A");

    let target = "A";
    const lengths: number[] = [];
    for (const piece of [TWO_HUNDRED.slice(0, 80), TWO_HUNDRED.slice(80)]) {
      target += piece;
      rerender(<Shown running text={target} />);
      for (let i = 0; i < 6; i += 1) {
        frame();
        expect(target.startsWith(shown())).toBe(true);
        lengths.push(shown().length);
      }
    }
    // 逐帧严格变长，且 12 帧（192ms）后仍未到 201 字：在展开，不是整段提交。
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1] ?? 0);
    }
    expect(lengths.at(-1)).toBeLessThan(target.length);
    // 200 字约 0.6s 展开完（规格「在有限时间内」；7a 实测 592ms），这里给足 2s。
    for (let i = 0; i < 125 && shown() !== target; i += 1) frame();
    expect(shown()).toBe(target);
  });

  it("依赖 @assistant-ui/react useSmooth 分支：从空串开始的第一段直接整段提交，此后的增长才展开", () => {
    vi.useFakeTimers({ toFake: [...HOOK_CLOCK] });
    const { rerender } = render(<Shown running text="" />);
    const first = TWO_HUNDRED.slice(0, 50);
    rerender(<Shown running text={first} />);
    expect(screen.getByTestId("shown").textContent).toBe(first);
    rerender(<Shown running text={TWO_HUNDRED} />);
    frame();
    const shown = screen.getByTestId("shown").textContent ?? "";
    expect(shown.length).toBeGreaterThan(first.length);
    expect(shown.length).toBeLessThan(TWO_HUNDRED.length);
  });
});

/** 打开一条 running 助手消息（正文 `content`，游标 1:3）并接通事件流，返回助手消息。 */
async function openRunning(content: string) {
  const snapshot = chatSnapshot({
    content,
    assistantStatus: "running",
    cursor: { epoch: 1, seq: 3 },
  });
  renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
  });
  const article = await screen.findByRole("article", { name: "助手" });
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  act(() => latestSource().emitOpen());
  return article;
}

/** 投递一条事件并让出一个宏任务：运行时在被动 effect 里才把新消息交给线程。 */
async function emit(seq: number, type: string, data: Record<string, unknown>) {
  await act(async () => {
    latestSource().emitData(type, `1:${seq}`, { messageId: 0, ...data });
    await settle();
  });
}

function bodyText(article: HTMLElement) {
  return article.querySelector(BODY)?.textContent ?? "";
}

describe("正文逐字展开", () => {
  it("已显示 A 后收到 200 字：逐帧由短到长、每帧是 A 加前缀，最终等于全文；其间无 running 容器、恰一个小圆点", async () => {
    const article = await openRunning("A");
    expect(bodyText(article)).toBe("A");
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });

    await emit(4, "text.delta", { delta: TWO_HUNDRED });

    const full = `A${TWO_HUNDRED}`;
    const lengths = [bodyText(article).length];
    while (bodyText(article) !== full && lengths.length < 125) {
      frame();
      const shown = bodyText(article);
      expect(shown.startsWith("A")).toBe(true);
      expect(full.startsWith(shown)).toBe(true);
      expect(article.querySelector(".aui-md")?.getAttribute("data-status")).not.toBe("running");
      expect(article.querySelectorAll(CARET)).toHaveLength(1);
      lengths.push(shown.length);
    }
    expect(bodyText(article)).toBe(full);
    // 收到的那一刻还没显示新字，此后至少十帧里显示的字数各不相同、逐帧变长。
    expect(lengths[0]).toBe(1);
    expect(new Set(lengths).size).toBeGreaterThan(10);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  it("展开到一半时收到 turn.end(done)：立即显示全文，复制写入全文", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const article = await openRunning("A");
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
    await emit(4, "text.delta", { delta: TWO_HUNDRED });
    for (let i = 0; i < 5; i += 1) frame();
    const midway = bodyText(article).length;
    expect(midway).toBeGreaterThan(1);
    expect(midway).toBeLessThan(201);

    await emit(5, "turn.end", { status: "done" });

    expect(bodyText(article)).toBe(`A${TWO_HUNDRED}`);
    expect(article.querySelectorAll(CARET)).toHaveLength(0);
    vi.useRealTimers();
    fireEvent.click(within(article).getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(`A${TWO_HUNDRED}`);
  });

  it("以快照打开一条正文已有 500 字的 running 消息：首次渲染即显示全部 500 字，不从头展开", async () => {
    const five = "春夏秋冬甲".repeat(100);
    // 挂载前就冻住帧：首次渲染若从空串起步，在这里不会有机会追上。
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
    const article = await openRunning(five);
    expect(bodyText(article)).toBe(five);
    frame();
    expect(bodyText(article)).toBe(five);
  });

  it("prefers-reduced-motion: reduce 下收到 200 字：收到后立即显示全文", async () => {
    installMatchMedia((query) => createMediaQuery(query === "(prefers-reduced-motion: reduce)"));
    const article = await openRunning("A");
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });

    await emit(4, "text.delta", { delta: TWO_HUNDRED });

    expect(bodyText(article)).toBe(`A${TWO_HUNDRED}`);
  });

  // 等待指示让位时 MessageBody 才挂载（slice 5b），首段整段出现；这与平滑状态放在 MessageBody 之上时
  // 「从空串开始的第一段直接提交」结果相同（7a 实测），之后的增量照常展开。
  it("等待指示让位于第一段正文：首段整段显示，下一段逐字展开", async () => {
    const article = await openRunning("");
    expect(article.querySelector('[data-slot="message-waiting"]')).not.toBeNull();
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
    const first = TWO_HUNDRED.slice(0, 30);

    await emit(4, "text.delta", { delta: first });

    expect(article.querySelector('[data-slot="message-waiting"]')).toBeNull();
    expect(bodyText(article)).toBe(first);

    await emit(5, "text.delta", { delta: TWO_HUNDRED.slice(30) });
    frame();
    const shown = bodyText(article);
    expect(shown.length).toBeGreaterThan(first.length);
    expect(shown.length).toBeLessThan(TWO_HUNDRED.length);
    expect(TWO_HUNDRED.startsWith(shown)).toBe(true);
  });
});

describe("正文逐字展开期间的对话内搜索", () => {
  conversationSearchFixture();

  it("展开期间搜该 200 字的最后五个字：该消息被匹配", async () => {
    await openConversation(runningConversation("问", "A"));
    act(() => latestSource().emitOpen());
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
    await emit(4, "text.delta", { delta: TWO_HUNDRED });
    frame();
    const article = screen.getByRole("article", { name: "助手" });
    expect(bodyText(article)).not.toContain(LAST_FIVE);

    toggleSearch();
    typeQuery(LAST_FIVE);

    expect(highlighted()).toEqual(["0"]);
    expect(bodyText(article)).not.toContain(LAST_FIVE);
  });
});
