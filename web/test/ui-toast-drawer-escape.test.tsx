import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { createAppRouter } from "../src/routes/index.js";
import { ToastProvider, useToast } from "../src/ui/index.js";
import { FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import {
  authenticatedPrincipal,
  composerOptionsRoute,
  createFetchMock,
  jsonResponse,
  serviceInfo,
  setBrowserPath,
} from "./support.js";
import { waitMs, yieldMacrotask } from "./ui-support.js";

/*
 * #643 回归闸门：Toast（每条 Root 是一个 DismissableLayer）与窄屏 导航 Drawer（Radix Dialog）共用
 * DismissableLayer 的模块级层栈；只有“最高层”在 document 上以 capture 注册 keydown，交接要等一轮
 * 重新渲染。交接窗口只在真实调度器下（IS_REACT_ACT_ENVIRONMENT=false、原生事件派发）可见——act 会
 * 同步冲刷掉它，故 T1-real-* 不得改写为 act 版。每个变体断言 Escape 后 dialog 导航 关闭、Toast 仍在
 * （到期变体除外）；快照（Escape 时的层监听等）只进断言消息。
 */

const HERO = "WorkBuddy，我帮你";
const TOAST = "已停止生成";

type Show = ReturnType<typeof useToast>["show"];
type ActEnv = { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };

let show: Show | undefined;
let disposeRouter: (() => void) | undefined;
const actEnv = globalThis as ActEnv;
const initialActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;

/** document 上以 capture 注册、当前仍挂着的 keydown 监听（即 DismissableLayer 的最高层监听）。 */
const activeKeydown = new Set<EventListenerOrEventListenerObject>();
/** 监听身份 → 层名（useCallbackRef 使每个层实例的 handleKeyDown 身份稳定）。 */
const tags = new Map<EventListenerOrEventListenerObject, string>();
/** 监听身份 → 注册来源（按注册时调用栈区分 DismissableLayer 与 Menu 的键盘态跟踪监听）。 */
const kinds = new Map<EventListenerOrEventListenerObject, string>();

function kindOf(stack: string) {
  if (stack.includes("react-dismissable-layer")) return "layer";
  if (stack.includes("react-menu")) return "menu-keyboard-tracker";
  return "other";
}

afterEach(async () => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = initialActEnv;
  vi.useRealTimers();
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  show = undefined;
  uninstallMatchMedia();
  await yieldMacrotask();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  activeKeydown.clear();
  tags.clear();
  kinds.clear();
  window.localStorage.clear();
  document.body.replaceChildren();
});

function isCapture(options: boolean | AddEventListenerOptions | EventListenerOptions | undefined) {
  return options === true || (typeof options === "object" && options.capture === true);
}

/** 渲染前装上：跟踪 document 上 capture keydown 监听的增删（仍调用原实现）。 */
function trackKeydownListeners() {
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "keydown" && listener && isCapture(options)) {
      activeKeydown.add(listener);
      if (!kinds.has(listener)) kinds.set(listener, kindOf(new Error().stack ?? ""));
    }
    add.call(document, type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "keydown" && listener && isCapture(options)) activeKeydown.delete(listener);
    remove.call(document, type, listener, options);
  });
}

/** 把当前挂着但尚未命名的 capture keydown 监听命名为 `name`。 */
function tagActive(name: string) {
  for (const listener of activeKeydown) {
    if (kinds.get(listener) === "layer" && !tags.has(listener)) tags.set(listener, name);
  }
}

function receivers() {
  return [...activeKeydown].map((listener) => {
    const kind = kinds.get(listener) ?? "other";
    // 本文件只有 Toast、Drawer（与 D5 的 Menu）层，未命名的层监听是新打开的 Drawer 或 Menu。
    return kind === "layer" ? `layer:${tags.get(listener) ?? "untagged"}` : kind;
  });
}

function Probe() {
  show = useToast().show;
  return null;
}

/** 与 render-app-router 的 mountAuthenticatedApp 同构，只多一个取 useToast().show 的探针。 */
async function mountNarrowShell() {
  const narrow = createMediaQuery(true);
  const other = createMediaQuery(false);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? narrow : other));
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  setBrowserPath("/");
  vi.stubGlobal(
    "fetch",
    createFetchMock({
      "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
      "/api/info": () => jsonResponse(serviceInfo),
      "/api/sessions": () => jsonResponse({ sessions: [] }),
      "/api/workspaces": () => jsonResponse({ workspaces: [] }),
      ...composerOptionsRoute(),
    }),
  );
  trackKeydownListeners();
  const router = createAppRouter();
  render(
    <ToastProvider>
      <Probe />
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  disposeRouter = () => router.dispose();
  await screen.findByRole("heading", { level: 1, name: HERO });
}

function showToast() {
  if (!show) throw new Error("Probe 未就绪");
  const toastApi = show;
  act(() => toastApi({ type: "info", message: TOAST }));
}

// 以下观测只读 DOM，不走 RTL 的 act 包装（非 act 轨道里不能让 act 冲刷调度）。
const dialogPresent = () => document.querySelector('[role="dialog"]') !== null;
const toastPresent = () => document.querySelector(".ui-toast") !== null;
const navButton = () => screen.getByRole("button", { name: "打开导航" });

function nativeClick(target: Element) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function nativeEscape() {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

type Observation = {
  variant: string;
  dialogAtEscape: boolean;
  toastAtEscape: boolean;
  focusInDialogAtEscape: boolean;
  keydownReceiversAtEscape: string[];
  dialogAfter?: boolean;
  toastAfter?: boolean;
  /** 首次 Escape 后 Drawer 仍在时，再按一次 Escape 后 Drawer 是否还在。 */
  dialogAfterSecondEscape?: boolean;
};

type Step = { escape: () => void; settle: () => Promise<void> };
const actStep: Step = { escape: () => act(() => nativeEscape()), settle: () => waitMs(100) };

/** Escape 之前一刻的快照。 */
function snapshot(variant: string): Observation {
  const dialog = document.querySelector('[role="dialog"]');
  return {
    variant,
    dialogAtEscape: dialog !== null,
    toastAtEscape: toastPresent(),
    focusInDialogAtEscape: dialog?.contains(document.activeElement) ?? false,
    keydownReceiversAtEscape: receivers(),
  };
}

/** 首次 Escape 已派发并稳定后：断言 dialog 导航 已关闭；`toastKept` 时再断言 Toast 仍在。 */
async function report(record: Observation, step: Step, toastKept: boolean) {
  record.dialogAfter = dialogPresent();
  record.toastAfter = toastPresent();
  if (record.dialogAfter) {
    step.escape();
    await step.settle();
    record.dialogAfterSecondEscape = dialogPresent();
  }
  const detail = JSON.stringify(record);
  expect(record.dialogAfter, `dialog 导航 仍在：${detail}`).toBe(false);
  if (toastKept) expect(record.toastAfter, `Toast 被 Escape 关闭：${detail}`).toBe(true);
}

const realMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 非 act 轨道：真实调度器，点击打开后让出 `between` 再派发 Escape，前后不经 RTL/act。 */
async function nonActOpenThenEscape(variant: string, between: () => Promise<void>) {
  await mountNarrowShell();
  showToast();
  await yieldMacrotask();
  tagActive("toast");
  const button = navButton();
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  button.focus();
  nativeClick(button);
  await between();
  const record = snapshot(variant);
  const realStep: Step = {
    escape: nativeEscape,
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await realMacrotask();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    },
  };
  realStep.escape();
  await realStep.settle();
  try {
    await report(record, realStep, true);
  } finally {
    actEnv.IS_REACT_ACT_ENVIRONMENT = initialActEnv;
  }
}

describe("T1 Toast 可见 → 打开窄屏 导航 Drawer → 立即 Escape（验收 1）", () => {
  it("T1-act-one-flush：fireEvent.click（一次 act 冲刷）后立刻 Escape", async () => {
    await mountNarrowShell();
    showToast();
    await yieldMacrotask();
    tagActive("toast");
    const button = navButton();
    button.focus();
    fireEvent.click(button);
    const record = snapshot("T1-act-one-flush");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitMs(100);
    await report(record, actStep, true);
  });

  it("T1-act-settled：Drawer 完全就绪（findByRole + 一个宏任务）后 Escape", async () => {
    await mountNarrowShell();
    showToast();
    await yieldMacrotask();
    tagActive("toast");
    const button = navButton();
    button.focus();
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "导航" });
    await yieldMacrotask();
    const record = snapshot("T1-act-settled");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitMs(100);
    await report(record, actStep, true);
  });

  it("T1-real-microtask：真实调度器，点击后一个微任务再 Escape", async () => {
    await nonActOpenThenEscape("T1-real-microtask", () => Promise.resolve());
  });

  it("T1-real-macrotask-1：真实调度器，点击后一个宏任务再 Escape", async () => {
    await nonActOpenThenEscape("T1-real-macrotask-1", realMacrotask);
  });

  it("T1-real-handoff-window：真实调度器，逐个宏任务轮询 Escape 监听何时由 Toast 层交给 Drawer 层", async () => {
    await mountNarrowShell();
    showToast();
    await yieldMacrotask();
    tagActive("toast");
    const button = navButton();
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;
    button.focus();
    nativeClick(button);
    const timeline: string[] = [];
    let handoff = false;
    try {
      for (let i = 0; i <= 200 && !handoff; i += 1) {
        const now = receivers().filter((name) => name.startsWith("layer:"));
        const line = `${i}:${dialogPresent() ? "dialog" : "-"}:${now.join("+")}`;
        if (timeline.at(-1)?.slice(line.indexOf(":")) !== line.slice(line.indexOf(":"))) {
          timeline.push(line);
        }
        handoff = now.length === 1 && now[0] === "layer:untagged";
        if (!handoff) await realMacrotask();
      }
    } finally {
      actEnv.IS_REACT_ACT_ENVIRONMENT = initialActEnv;
    }
    expect(handoff, `交接未发生：${timeline.join(" ")}`).toBe(true);
  });

  it("T1-real-settled：真实调度器，点击后 50ms 再 Escape", async () => {
    await nonActOpenThenEscape(
      "T1-real-settled",
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );
  });
});

describe("T2 Drawer 已开 → Toast 出现/到期卸载 → Escape（验收 2）", () => {
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const fakeStep: Step = {
    escape: () => act(() => nativeEscape()),
    settle: async () => {
      advance(0);
    },
  };

  it("T2-appear：Drawer 就绪后 Toast 出现 → Escape", async () => {
    await mountNarrowShell();
    const button = navButton();
    button.focus();
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "导航" });
    await yieldMacrotask();
    tagActive("drawer");
    showToast();
    await yieldMacrotask();
    tagActive("toast");
    const record = snapshot("T2-appear");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitMs(100);
    await report(record, actStep, true);
  });

  it("T2-expire-before-open：Toast 先在 → 打开 Drawer → Toast 到期卸载（epoch 重挂）→ Escape", async () => {
    await mountNarrowShell();
    vi.useFakeTimers();
    showToast();
    advance(0);
    tagActive("toast");
    const button = navButton();
    button.focus();
    fireEvent.click(button);
    advance(0);
    expect(screen.getByRole("dialog", { name: "导航" })).toBeTruthy();
    tagActive("drawer");
    advance(2400);
    expect(toastPresent(), "Toast 应已到期卸载").toBe(false);
    const record = snapshot("T2-expire-before-open");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    advance(0);
    await report(record, fakeStep, false);
  });

  it("T2-appear-then-expire：Drawer 就绪 → Toast 出现 → 到期卸载（epoch 重挂）→ Escape", async () => {
    await mountNarrowShell();
    vi.useFakeTimers();
    const button = navButton();
    button.focus();
    fireEvent.click(button);
    advance(0);
    expect(screen.getByRole("dialog", { name: "导航" })).toBeTruthy();
    tagActive("drawer");
    showToast();
    advance(0);
    tagActive("toast");
    advance(2400);
    expect(toastPresent(), "Toast 应已到期卸载").toBe(false);
    const record = snapshot("T2-appear-then-expire");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    advance(0);
    await report(record, fakeStep, false);
  });
});

describe("D5 覆盖层内嵌菜单：Escape 只关菜单", () => {
  it("D5 导航 Drawer 内打开 用户菜单（交接完成）→ Escape 只关菜单；再 Escape 关 Drawer", async () => {
    await mountNarrowShell();
    const button = navButton();
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "导航" });
    await yieldMacrotask();
    const trigger = screen.getByRole("button", { name: "用户菜单" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const item = await screen.findByRole("menuitem", { name: "退出登录" });
    await yieldMacrotask();
    expect(document.activeElement?.closest('[role="menu"]')).toBe(item.closest('[role="menu"]'));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitMs(100);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(dialog.isConnected, "Escape 连带关闭了 dialog 导航").toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("open");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitMs(100);
    expect(dialogPresent()).toBe(false);
  });
});
