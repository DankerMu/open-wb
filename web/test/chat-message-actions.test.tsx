// 用户消息的气泡与操作行、用户消息的 `复制`、操作行显隐的结构契约（chat-web「消息线程」：「用户气泡与操作行的
// 结构」「复制用户原文」「用户消息操作行的按钮与次序」「隐藏的操作行仍可达」）。jsdom 不计算样式，这里只断言结构、
// 类名、可达性属性与复制行为；计算 `opacity` 与 `transition-duration` 在 ui-walk（web/e2e/ui-walk-action-row.ts）。
// seam：整页挂载 + 假 API；期望值取自规格条文。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { count, toggleSearch, typeQuery } from "./chat-page-search-support.js";
import {
  cleanupSessionMeta,
  messagesPath,
  mountSessions,
  view,
} from "./chat-page-session-meta-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  historyUser,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

const ROW = '[data-slot="message-actions"]';
const BUBBLE = '[data-slot="message-bubble"]';
const BUBBLE_FILL = "bg-(--wb-bg-hover-light)";
const RAW = "  第一行\n第二行";
const COPIED = "已复制";
const FAILED = "复制失败";
const OLD_TOAST = "已复制到剪贴板";
/** 显隐的五个类（design D3）：渐变、能悬停时隐藏、悬停本条消息 / 行内焦点 / `复制失败` 时显现。 */
const VISIBILITY_CLASSES = [
  "transition-opacity",
  "[@media(hover:hover)]:opacity-0",
  "group-hover/message:opacity-100",
  "focus-within:opacity-100",
  "has-[[role=alert]]:opacity-100",
];

afterEach(async () => {
  vi.useRealTimers();
  await cleanupSessionMeta();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

/** 一个回合的快照：用户消息 `content`（可撤回）与一条已完成的回答 `好的`；`status` 缺省 `done`。 */
function turn(content: string, status: "done" | "running" = "done"): ChatMessageSnapshot {
  const snapshot = chatSnapshot({
    status,
    assistantStatus: status,
    content: "好的",
    cursor: { epoch: 1, seq: status === "done" ? null : 3 },
  });
  const [, answer] = snapshot.messages;
  if (!answer) throw new Error("chatSnapshot 缺少助手消息");
  snapshot.messages = [{ ...historyUser, undo: "available", content }, answer];
  return snapshot;
}

async function mount(snapshot: ChatMessageSnapshot) {
  const page = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
  });
  const user = await screen.findByRole("article", { name: "用户" });
  await within(screen.getByRole("article", { name: "助手" })).findByText("好的");
  return { ...page, user };
}

const slots = (element: Element) =>
  Array.from(element.children, (child) => child.getAttribute("data-slot"));
const labels = (buttons: HTMLElement[]) => buttons.map((b) => b.getAttribute("aria-label"));
const rowButtons = (article: HTMLElement) => {
  const row = article.querySelector<HTMLElement>(ROW);
  if (!row) throw new Error("消息没有操作行");
  return within(row).getAllByRole<HTMLButtonElement>("button");
};
const iconOf = (button: HTMLElement) =>
  button
    .querySelector("svg")
    ?.getAttribute("class")
    ?.match(/lucide-(copy|check)\b/)?.[1];

describe("用户气泡与操作行的结构", () => {
  it("`hello`：article 的直接子元素依次为气泡与操作行；气泡只有正文、没有按钮、带底色；article 不带底色", async () => {
    const { user } = await mount(turn("hello"));
    expect(user.getAttribute("data-message-id")).toBe(String(historyUser.id));
    expect(slots(user)).toEqual(["message-bubble", "message-actions"]);
    const bubble = user.querySelector<HTMLElement>(BUBBLE) as HTMLElement;
    expect(slots(bubble)).toEqual(["message-body"]);
    expect(bubble.textContent).toBe("hello");
    expect(within(bubble).queryAllByRole("button")).toEqual([]);
    const row = user.querySelector<HTMLElement>(ROW) as HTMLElement;
    expect(bubble.contains(row)).toBe(false);
    expect(row.parentElement).toBe(user);
    expect(bubble.classList.contains(BUBBLE_FILL)).toBe(true);
    expect(user.classList.contains(BUBBLE_FILL)).toBe(false);
  });

  it("对话内搜索的当前匹配：`aria-current` 在 article 上，气泡与操作行都不带它", async () => {
    const { user } = await mount(turn("hello"));
    toggleSearch();
    typeQuery("hello");
    await waitFor(() => expect(count()).toBe("1/1"));
    expect(user.getAttribute("aria-current")).toBe("true");
    expect(user.querySelector("[aria-current]")).toBeNull();
    expect(slots(user)).toEqual(["message-bubble", "message-actions"]);
  });
});

describe("复制用户原文", () => {
  it("写入恰为气泡原文（前导空白与换行保留），对勾约 2 秒、`已复制` 视觉隐藏，没有轻提示", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { user } = await mount(turn(RAW));
    const button = within(user).getByRole("button", { name: "复制" });
    expect(button.getAttribute("title")).toBe("复制");
    expect(iconOf(button)).toBe("copy");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    fireEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(writeText.mock.calls).toEqual([[RAW]]);
    expect(iconOf(button)).toBe("check");
    const status = within(user).getByRole("status");
    expect(status.textContent).toBe(COPIED);
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.closest(ROW)).toBe(button.closest(ROW));
    expect(within(user).queryByRole("alert")).toBeNull();
    expect(screen.queryByText(OLD_TOAST)).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(iconOf(button)).toBe("check");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(iconOf(button)).toBe("copy");
    expect(within(user).queryByRole("status")).toBeNull();
  });

  it("剪贴板 API 缺失与 `writeText` reject 都就地显示 `复制失败`，不外泄；恢复后再点清除", async () => {
    expect("clipboard" in navigator).toBe(false);
    const observer = observeUnhandledRejections();
    try {
      const { user } = await mount(turn(RAW));
      const button = within(user).getByRole("button", { name: "复制" });
      fireEvent.click(button);
      const missing = await within(user).findByRole("alert");
      expect(missing.textContent).toBe(FAILED);
      expect(missing.previousElementSibling).toBe(button);

      const rejecting = vi
        .fn<(text: string) => Promise<void>>()
        .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
      mockClipboard(rejecting);
      fireEvent.click(button);
      expect(within(user).queryByRole("alert")).toBeNull();
      expect((await within(user).findByRole("alert")).textContent).toBe(FAILED);
      expect(rejecting.mock.calls).toEqual([[RAW]]);
      expect(iconOf(button)).toBe("copy");
      expect(within(user).queryByRole("status")).toBeNull();

      const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
      mockClipboard(writeText);
      fireEvent.click(button);
      await waitFor(() => expect(iconOf(button)).toBe("check"));
      expect(within(user).queryByRole("alert")).toBeNull();
      expect(writeText.mock.calls).toEqual([[RAW]]);
      expect(screen.queryByText(OLD_TOAST)).toBeNull();
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});

describe("用户消息操作行的按钮与次序", () => {
  it("`done` 会话、`undo` 为 available：依次为 `复制`、`撤回`、`从此处分叉`，三者可用", async () => {
    const { user } = await mount(turn("hello"));
    const buttons = rowButtons(user);
    expect(labels(buttons)).toEqual(["复制", "撤回", "从此处分叉"]);
    expect(buttons.map((b) => b.title)).toEqual(["复制", "撤回", "从此处分叉"]);
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, false]);
    expect(buttons.map((b) => b.getAttribute("aria-disabled"))).toEqual([null, null, null]);
  });

  it("回合进行中：`撤回` 与 `从此处分叉` 禁用，`复制` 可用", async () => {
    const { user } = await mount(turn("hello", "running"));
    const buttons = rowButtons(user);
    expect(labels(buttons)).toEqual(["复制", "撤回", "从此处分叉"]);
    expect(buttons.map((b) => b.disabled)).toEqual([false, true, true]);
  });

  it("已归档会话：用户消息的行只有 `复制`；只发附件的用户消息没有操作行", async () => {
    const archived = view("a".repeat(32), "旧项目", { archivedAt: 1_760_000_000_000 });
    const snapshot = turn("hello");
    const [question, answer] = snapshot.messages;
    if (!question || !answer) throw new Error("快照缺少消息");
    snapshot.messages = [
      question,
      answer,
      {
        ...question,
        id: 1,
        createdAt: 1,
        content: "",
        attachments: [{ path: "uploads/a.pdf", size: 3 }],
      },
      { ...answer, id: 2, createdAt: 2, content: "收到" },
    ] as ChatMessageSnapshot["messages"];
    mountSessions(`/?session=${archived.id}`, [archived], {
      [messagesPath(archived.id)]: () => jsonResponse({ ...snapshot, session: archived }),
    });
    await screen.findByText("收到");
    const [text, attachmentOnly] = screen.getAllByRole("article", { name: "用户" });
    if (!text || !attachmentOnly) throw new Error("缺少用户消息");
    expect(labels(rowButtons(text))).toEqual(["复制"]);
    expect(within(attachmentOnly).queryByRole("list", { name: "附件" })).toBeTruthy();
    expect(attachmentOnly.querySelector(ROW)).toBeNull();
    expect(within(attachmentOnly).queryAllByRole("button")).toEqual([]);
    for (const label of ["撤回", "从此处分叉", "重新生成"]) {
      expect(screen.queryByRole("button", { name: label }), label).toBeNull();
    }
  });
});

/**
 * 顺序焦点导航的可达集合（HTML「sequentially focusable」在本页的子集：页面不用正的 `tabindex`）：文档序里
 * `tabIndex >= 0`、未禁用、自己与祖先都不带 `inert` / `hidden` / `aria-hidden` 的元素。jsdom 不实现 Tab 键的
 * 焦点移动，这里按它取下一个并 `focus()`；真实 Tab 在 ui-walk 的显隐一步里量。
 */
function tabbable(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !(element as HTMLButtonElement).disabled &&
      element.closest("[inert], [hidden], [aria-hidden='true']") === null,
  );
}

function pressTab() {
  const order = tabbable();
  const at = order.indexOf(document.activeElement as HTMLElement);
  const next = order[at + 1];
  if (!next) throw new Error("Tab 之后没有可聚焦元素");
  next.focus();
  return next;
}

describe("隐藏的操作行仍可达", () => {
  it("两条消息的操作行都在文档中、按名找得到，按钮与祖先不带 aria-hidden / inert / tabindex=-1，Tab 依次到达", async () => {
    const { user } = await mount(turn("hello"));
    const assistant = screen.getByRole("article", { name: "助手" });
    const userButtons = rowButtons(user);
    const assistantButtons = rowButtons(assistant);
    expect(labels(userButtons)).toEqual(["复制", "撤回", "从此处分叉"]);
    expect(labels(assistantButtons)).toEqual(["复制", "重新生成"]);
    for (const button of [...userButtons, ...assistantButtons]) {
      expect(document.body.contains(button)).toBe(true);
      expect(button.closest("[aria-hidden], [inert], [tabindex='-1'], [hidden]")).toBeNull();
      expect(button.disabled).toBe(false);
    }
    expect(within(user).getByRole("button", { name: "从此处分叉" })).toBe(userButtons[2]);
    expect(within(assistant).getByRole("button", { name: "重新生成" })).toBe(assistantButtons[1]);

    const first = userButtons[0] as HTMLElement;
    const before = tabbable()[tabbable().indexOf(first) - 1];
    if (!before) throw new Error("用户消息的 复制 之前没有可聚焦元素");
    before.focus();
    const reached = [userButtons, assistantButtons].flat().map(() => pressTab());
    expect(reached).toEqual([...userButtons, ...assistantButtons]);
    expect(document.activeElement).toBe(assistantButtons[1]);
  });

  it("类名契约：两种消息的 article 带具名组 `group/message`，两行都带显隐的五个类", async () => {
    const { user } = await mount(turn("hello"));
    const assistant = screen.getByRole("article", { name: "助手" });
    for (const article of [user, assistant]) {
      const label = article.getAttribute("aria-label") ?? "";
      expect(article.classList.contains("group/message"), label).toBe(true);
      const row = article.querySelector<HTMLElement>(ROW) as HTMLElement;
      for (const name of VISIBILITY_CLASSES) {
        expect(row.classList.contains(name), name).toBe(true);
      }
      for (const name of ["hidden", "invisible", "opacity-0"]) {
        expect(row.classList.contains(name), name).toBe(false);
      }
      expect(row.closest("[aria-hidden], [inert]")).toBeNull();
    }
  });
});
