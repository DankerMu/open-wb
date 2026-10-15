// issue 1450（issue 910 切片 7b）：thinking-fold「深度思考折叠块呈现」第五段与场景「思考的逐字展开」。
// seam：整页挂载 + 假 API / 假 EventSource；期望值取自场景字面量（已展开的折叠块收到 200 字、终态立即全文、
// reduce 收到即全文）。假时钟沿用 chat-smooth-text.test.tsx 的整页配置（7a 实测）：只假 rAF、cAF、Date，
// setTimeout 留真，页面夹具的 `settle` 与 `waitFor` 靠它。
// 终态时折叠块按规格收起。jsdom 没有 CSS 动画，Radix Presence 读到 animationName 为 none 就立刻卸下主体，
// 「终态那一刻主体是否已是全文」看不到；再展开是重新挂载，挂载时本来就显示全文，也证明不了什么。浏览器里
// 收起有退场动画（`data-closed:animate-collapsible-up`，theme.css 把 data-closed 映射到 data-state="closed"），
// 动画结束前 Presence 保留主体（读代码推出：@radix-ui/react-presence 的 ANIMATION_OUT 分支）。终态用例因此
// 桩 `getComputedStyle`，让 reasoning-content 按 data-state 报出进场 / 退场动画名、尊重内联的
// animationName: none（Radix 测量时写的），复现这段退场窗口，在窗口里读主体。
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID, settle } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { jsonResponse } from "./support.js";

type Message = ChatMessageSnapshot["messages"][number];

const PAGE_CLOCK = ["requestAnimationFrame", "cancelAnimationFrame", "Date"] as const;
const FRAME_MS = 16;
/** 200 个字，逐帧比对前缀才有意义。 */
const TWO_HUNDRED = `${"甲乙丙丁".repeat(48)}一二三春夏秋冬戊`;
const CONTENT = '[data-slot="reasoning-content"]';
const BODY = '[data-slot="reasoning-text"]';

afterEach(() => {
  cleanupChatPage();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uninstallMatchMedia();
});

function frame() {
  act(() => {
    vi.advanceTimersByTime(FRAME_MS);
  });
}

/** 一条 running 助手消息（id 0），思考为 `thinking`、折叠块展开着；连上事件源后从 `1:4` 起编号。 */
async function openRunningThinking(thinking: string) {
  const base = chatSnapshot({ assistantStatus: "running", cursor: { epoch: 1, seq: 3 } });
  const [user, assistant] = base.messages as [Message, Message];
  const snapshot = { ...base, messages: [user, { ...assistant, thinking }] };
  renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
  });
  await screen.findByRole("article", { name: "助手" });
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  act(() => latestSource().emitOpen());
  for (let round = 0; round < 3; round += 1) await act(settle);
  expect(control().getAttribute("aria-expanded")).toBe("true");
}

/** 投递一条事件并让出一个宏任务：运行时在被动 effect 里才把新消息交给线程。 */
async function emit(seq: number, type: string, data: Record<string, unknown>) {
  await act(async () => {
    latestSource().emitData(type, `1:${String(seq)}`, { messageId: 0, ...data });
    await settle();
  });
}

function control() {
  const element = document.querySelector<HTMLElement>('[data-slot="reasoning-trigger"]');
  if (!element) throw new Error("未渲染折叠块控件");
  return element;
}

/** 主体显示的文本；主体不在 DOM 中时为 null。 */
function shown() {
  return document.querySelector(BODY)?.textContent ?? null;
}

/**
 * 浏览器里收起的退场动画：reasoning-content 的 animationName 按 data-state 报出，内联写了 none 时为 none；
 * 其它元素照旧。返回派发 animationend 的函数（动画放完，Presence 卸下主体）。
 */
function emulateCollapseAnimation() {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const real = original(element, pseudo);
    if (!(element instanceof HTMLElement) || !element.matches(CONTENT)) return real;
    return new Proxy(real, {
      get(target, name) {
        if (name === "animationName") {
          if (element.style.animationName === "none") return "none";
          return element.dataset.state === "closed" ? "collapsible-up" : "collapsible-down";
        }
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  // Presence 用 CSS.escape 比对动画名；jsdom 没有它。动画名只含字母与连字符，原样返回即可。
  if (typeof globalThis.CSS?.escape !== "function") {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
  }
  return () => {
    const content = document.querySelector(CONTENT);
    if (!content) throw new Error("主体容器不在 DOM 中");
    const event = new Event("animationend");
    Object.defineProperty(event, "animationName", { value: "collapsible-up" });
    act(() => {
      content.dispatchEvent(event);
    });
  };
}

/** 展开着的主体在收到 200 字后推进几帧：断言此刻显示的是严格前缀（在展开，不是整段）。 */
async function unrollHalfway(full: string) {
  // 先等一个真帧：Radix 在主体挂载后的第一帧才解除「挂载不放动画」（内联 animationName: none），之后收起才有
  // 退场动画可复现。
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
  await emit(4, "thinking.delta", { delta: TWO_HUNDRED });
  for (let i = 0; i < 5; i += 1) frame();
  const midway = shown() ?? "";
  expect(midway.length).toBeGreaterThan(1);
  expect(midway.length).toBeLessThan(full.length);
  expect(full.startsWith(midway)).toBe(true);
}

describe("thinking-fold「思考的逐字展开」", () => {
  it("展开着的折叠块收到 200 字：逐帧由短到长、每帧是已收到 thinking 的前缀，最终等于全文", async () => {
    await openRunningThinking("想");
    expect(shown()).toBe("想");
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });

    await emit(4, "thinking.delta", { delta: TWO_HUNDRED });

    const full = `想${TWO_HUNDRED}`;
    const lengths = [(shown() ?? "").length];
    while (shown() !== full && lengths.length < 125) {
      frame();
      const text = shown() ?? "";
      expect(full.startsWith(text)).toBe(true);
      lengths.push(text.length);
    }
    expect(shown()).toBe(full);
    // 收到的那一刻还没显示新字，此后至少十帧里显示的字数各不相同、逐帧变长。
    expect(lengths[0]).toBe(1);
    expect(new Set(lengths).size).toBeGreaterThan(10);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  it("展开到一半时收到 turn.end(stopped)：收起的退场动画里主体已是全文，动画放完再展开仍是全文", async () => {
    const finish = emulateCollapseAnimation();
    await openRunningThinking("想");
    const full = `想${TWO_HUNDRED}`;
    await unrollHalfway(full);

    await emit(5, "turn.end", { status: "stopped" });

    expect(control().getAttribute("aria-expanded")).toBe("false");
    expect(shown()).toBe(full);
    finish();
    expect(shown()).toBeNull();
    fireEvent.click(control());
    expect(shown()).toBe(full);
  });

  it("展开到一半时收到 error 与 turn.end(failed)：error 一到主体即是全文，turn.end 后仍是", async () => {
    const finish = emulateCollapseAnimation();
    await openRunningThinking("想");
    const full = `想${TWO_HUNDRED}`;
    await unrollHalfway(full);

    await emit(5, "error", {
      reason: "model_call_failed",
      message: "上游失败",
      status: null,
      detail: "",
    });

    expect(control().getAttribute("aria-expanded")).toBe("false");
    expect(shown()).toBe(full);
    await emit(6, "turn.end", { status: "failed" });
    expect(shown()).toBe(full);
    finish();
    fireEvent.click(control());
    expect(shown()).toBe(full);
  });

  it("prefers-reduced-motion: reduce 下收到 200 字：收到后立即显示全文", async () => {
    installMatchMedia((query) => createMediaQuery(query === "(prefers-reduced-motion: reduce)"));
    await openRunningThinking("想");
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });

    await emit(4, "thinking.delta", { delta: TWO_HUNDRED });

    expect(shown()).toBe(`想${TWO_HUNDRED}`);
  });

  it("以快照打开一条思考已有 500 字的 running 消息：首次渲染即显示全部 500 字，不从头展开", async () => {
    const five = "甲乙丙丁戊".repeat(100);
    // 挂载前就冻住帧：首次渲染若从空串起步，在这里不会有机会追上。
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
    await openRunningThinking(five);
    expect(shown()).toBe(five);
    frame();
    expect(shown()).toBe(five);
  });
});
