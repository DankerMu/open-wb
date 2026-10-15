// issue 1448（issue 910 切片 6b）：thinking-fold「深度思考折叠块呈现」第四段的流式预览，场景「终态消息主体限高」
// 里 jsdom 能观察的部分（design D7）：running 折叠块展开着时主体是预览，内容增长时盒内贴到最新一行，用户在盒内
// 上滚后不被拉回、转录区滚动位置不变，滚回盒底后恢复；终态不是预览，手动展开不自动滚动。限高的类名与渐隐层在
// `chat-thinking.test.tsx` 的 issue 725 与 fade 两例。seam：整页挂载 + 假 API / 假 EventSource。jsdom 没有布局：
// 主体与转录滚动容器（按各自的 `data-slot` 选中）的滚动量在原型上桩出，`scrollTop` 的写入按浏览器的规则夹到
// [0, scrollHeight − clientHeight]；`ResizeObserver` 换成手动触发的桩（`chat-scroll-follow.test.tsx` 的先例）。
// 程序写 `scrollTop` 时 jsdom 不派发 scroll 事件，浏览器会派发：每次贴底之后测试补发一次，拷入组件靠它记下
// 「上一次的盒内位置」，否则用户上滚读不成上滚。
// 主体逐字展开（issue 1450，design D8）：思考增量到达的那一刻主体还是原文，此后逐帧补齐。增长用例在连上事件源
// 之后只假 rAF、cAF、Date（chat-smooth-text.test.tsx 的整页配置），逐帧推到全文再报尺寸变化。
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID, settle } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

type Message = ChatMessageSnapshot["messages"][number];

const BODY = '[data-slot="reasoning-text"]';
const VIEWPORT = '[data-slot="thread-viewport"]';
/** 主体可视高度：12rem。 */
const BOX_CLIENT = 192;
const box = { scrollHeight: 400, scrollTop: 0 };
const pane = { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 };
const METRIC_NAMES = ["scrollHeight", "clientHeight", "scrollTop"] as const;
const PAGE_CLOCK = ["requestAnimationFrame", "cancelAnimationFrame", "Date"] as const;

function metricsOf(element: HTMLElement) {
  if (element.matches(BODY)) return { ...box, clientHeight: BOX_CLIENT, target: box };
  if (element.matches(VIEWPORT)) return { ...pane, target: pane };
  return null;
}

function installMetrics() {
  const originals = Object.fromEntries(
    METRIC_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)]),
  );
  for (const name of ["scrollHeight", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return metricsOf(this)?.[name] ?? originals[name]?.get?.call(this);
      },
    });
  }
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return metricsOf(this)?.scrollTop ?? originals.scrollTop?.get?.call(this);
    },
    set(this: HTMLElement, value: number) {
      const metrics = metricsOf(this);
      if (!metrics) {
        originals.scrollTop?.set?.call(this, value);
        return;
      }
      const max = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
      metrics.target.scrollTop = Math.min(Math.max(value, 0), max);
    },
  });
}

/** 手动触发的 `ResizeObserver`：记下观察对象与断开次数。 */
class SpyResizeObserver {
  static instances: SpyResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    SpyResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }

  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function observing(element: Element) {
  return SpyResizeObserver.instances.filter((spy) => spy.observed.has(element));
}

/** 内容尺寸变化：触发此刻观察 `element` 的每个桩（转录区的观察者不在其中）。 */
function resize(element: Element) {
  act(() => {
    for (const spy of observing(element)) spy.fire();
  });
}

beforeEach(() => {
  Object.assign(box, { scrollHeight: 400, scrollTop: 0 });
  Object.assign(pane, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
  installMetrics();
  SpyResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", SpyResizeObserver);
});

afterEach(() => {
  cleanupChatPage();
  vi.useRealTimers();
  for (const name of METRIC_NAMES) Reflect.deleteProperty(HTMLElement.prototype, name);
});

/** 一条 running 助手消息（id 0），思考为第 1 行；连上事件源后 `emit` 从 `1:4` 起编号。 */
async function openRunningThinking() {
  const base = chatSnapshot({ assistantStatus: "running", cursor: { epoch: 1, seq: 3 } });
  const [user, assistant] = base.messages as [Message, Message];
  const snapshot = { ...base, messages: [user, { ...assistant, thinking: "思考第 1 行" }] };
  renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
  });
  await screen.findByRole("article", { name: "助手" });
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  const source = latestSource();
  act(() => source.emitOpen());
  for (let round = 0; round < 3; round += 1) await act(settle);
  let seq = 3;
  return (type: string, data: Record<string, unknown> = {}) => {
    seq += 1;
    act(() => source.emitData(type, `1:${String(seq)}`, { messageId: 0, ...data }));
  };
}

function fold() {
  const element = document.querySelector<HTMLElement>('[data-slot="reasoning-root"]');
  if (!element) throw new Error("未渲染思考折叠块");
  return element;
}

function control() {
  const element = fold().querySelector<HTMLElement>('[data-slot="reasoning-trigger"]');
  if (!element) throw new Error("未渲染折叠块控件");
  return element;
}

function body() {
  const element = fold().querySelector<HTMLElement>(BODY);
  if (!element) throw new Error("折叠块主体不在 DOM 中");
  return element;
}

/** 主体里被观察尺寸的内容层（拷入 `ReasoningText` 的内层 div）。 */
function content() {
  const element = body().firstElementChild;
  if (!element) throw new Error("主体缺少内容层");
  return element;
}

/** 浏览器在一次（程序或用户的）滚动之后派发的 scroll 事件；scroll 不冒泡。 */
function scrolled(scrollTop = box.scrollTop) {
  box.scrollTop = scrollTop;
  fireEvent.scroll(body());
}

/**
 * 思考再长一截：先改盒内内容高度，再推一条 `thinking.delta`；收到的那一刻主体还是原文，逐帧推到全文，最后报
 * 一次内容尺寸变化。调用前须已假上 `PAGE_CLOCK`。
 */
function grow(emit: Awaited<ReturnType<typeof openRunningThinking>>, height: number, line: number) {
  const before = body().textContent ?? "";
  const after = `${before}\n思考第 ${String(line)} 行`;
  box.scrollHeight = height;
  emit("thinking.delta", { delta: `\n思考第 ${String(line)} 行` });
  expect(body().textContent).toBe(before);
  for (let i = 0; i < 60 && body().textContent !== after; i += 1) {
    act(() => {
      vi.advanceTimersByTime(16);
    });
  }
  resize(content());
}

const bottom = () => box.scrollHeight - BOX_CLIENT;

describe("thinking-fold「终态消息主体限高」running 主体是流式预览（design D7）", () => {
  it("贴到最新一行；盒内上滚后增长不拉回、转录区不动；滚回盒底后下一次增长重新贴底", async () => {
    const emit = await openRunningThinking();

    expect(fold().getAttribute("data-running")).toBe("");
    expect(control().getAttribute("aria-expanded")).toBe("true");
    expect(observing(content())).toHaveLength(1);
    // 挂载即贴底，转录区由它自己的贴底跟随停在底部。
    expect(box.scrollTop).toBe(bottom());
    expect(pane.scrollTop).toBe(2500);
    scrolled();
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });

    grow(emit, 900, 2);
    expect(body().textContent).toBe("思考第 1 行\n思考第 2 行");
    expect(box.scrollTop).toBe(708);
    scrolled();

    scrolled(300);
    grow(emit, 1400, 3);
    expect(body().textContent).toContain("思考第 3 行");
    expect(box.scrollTop).toBe(300);
    grow(emit, 1600, 4);
    expect(box.scrollTop).toBe(300);
    expect(pane.scrollTop).toBe(2500);
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();

    scrolled(bottom());
    grow(emit, 1900, 5);
    expect(box.scrollTop).toBe(1708);
    expect(pane.scrollTop).toBe(2500);
  });

  // 6b 评审补测：一段思考结束、回合仍在进行时折叠块仍是预览（预览只看 running，不看思考段是否开着）。
  it("thinking.end 后回合仍在进行：主体仍是预览；step.start 与新一段思考之后盒内上滚位置保持", async () => {
    const emit = await openRunningThinking();
    scrolled();
    vi.useFakeTimers({ toFake: [...PAGE_CLOCK] });
    grow(emit, 900, 2);
    scrolled();
    scrolled(300);

    emit("thinking.end", { thinkingMs: 400 });

    expect(control().textContent).toBe("已思考 1 秒");
    expect(fold().getAttribute("data-running")).toBe("");
    expect(body().textContent).toBe("思考第 1 行\n思考第 2 行");
    expect(observing(content())).toHaveLength(1);
    expect(fold().querySelectorAll('[data-slot="reasoning-fade"]')).toHaveLength(2);
    expect(box.scrollTop).toBe(300);

    emit("step.start", { stepId: 21, name: "bash", detail: "ls" });
    grow(emit, 1400, 3);

    expect(control().textContent).toBe("正在思考…");
    expect(body().textContent).toBe("思考第 1 行\n思考第 2 行\n思考第 3 行");
    expect(box.scrollTop).toBe(300);
    expect(pane.scrollTop).toBe(2500);
  });

  it("turn.end 后不带 data-running、不再是预览：手动展开的终态主体不自动滚动", async () => {
    const emit = await openRunningThinking();
    const live = content();
    expect(observing(live)).toHaveLength(1);

    emit("turn.end", { status: "done" });

    expect(fold().hasAttribute("data-running")).toBe(false);
    expect(control().getAttribute("aria-expanded")).toBe("false");
    expect(observing(live)).toHaveLength(0);
    box.scrollHeight = 900;
    box.scrollTop = 0;
    fireEvent.click(control());
    expect(control().getAttribute("aria-expanded")).toBe("true");
    expect(observing(content())).toHaveLength(0);
    expect(box.scrollTop).toBe(0);
    resize(content());
    expect(box.scrollTop).toBe(0);
  });
});
