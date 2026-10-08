// 消息级 `复制`（chat-web 消息线程「复制助手原文」；design D8：不弹轻提示，成功换图标 + 隐藏状态，失败就地提示）。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  historyUser,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const RAW = "# 标题\n\n段落 **粗体** 与 `行内`";
const OLD_TOAST = "已复制到剪贴板";
const COPIED = "已复制";
const FAILED = "复制失败";
const ROW = '[data-slot="message-actions"]';

afterEach(() => {
  vi.useRealTimers();
  cleanupChatPage();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function doneSnapshot(content: string): ChatMessageSnapshot {
  return chatSnapshot({
    status: "done",
    assistantStatus: "done",
    content,
    cursor: { epoch: 1, seq: null },
  });
}

function mountSnapshot(snapshot: ChatMessageSnapshot) {
  return renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [messagesPath]: () => jsonResponse(snapshot),
  });
}

/** 挂载一条 done 助手消息，返回它的 article 与 `复制` 按钮。 */
async function mountCopy(content = RAW) {
  mountSnapshot(doneSnapshot(content));
  const article = await screen.findByRole("article", { name: "助手" });
  const button = within(article).getByRole("button", { name: "复制" });
  return { article, button };
}

const iconOf = (button: HTMLElement) =>
  button
    .querySelector("svg")
    ?.getAttribute("class")
    ?.match(/lucide-(copy|check)\b/)?.[1];
const copiedStatus = (article: HTMLElement) => within(article).queryByRole("status");
const failedAlert = (article: HTMLElement) => within(article).queryByRole("alert");

/** 页面任何位置都没有轻提示：通知区为空，旧的成功文案也不出现。 */
function expectNoToast() {
  expect(within(screen.getByRole("region", { name: "通知" })).queryByRole("status")).toBeNull();
  expect(document.querySelector(".ui-toast")).toBeNull();
  expect(screen.queryByText(OLD_TOAST)).toBeNull();
}

describe("(C1) copy writes the raw assistant text", () => {
  it("writes the Markdown source once, swaps the icon and announces 已复制 without a toast", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { article, button } = await mountCopy();
    expect(iconOf(button)).toBe("copy");
    expect(copiedStatus(article)).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(iconOf(button)).toBe("check"));
    expect(writeText.mock.calls).toEqual([[RAW]]);
    const status = copiedStatus(article) as HTMLElement;
    expect(status.textContent).toBe(COPIED);
    // 视觉隐藏但留在可访问性树里：`sr-only`，不是 `hidden` / `aria-hidden`。
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.closest("[hidden], [aria-hidden='true']")).toBeNull();
    expect(status.closest(ROW)).toBe(button.closest(ROW));
    expect(button.contains(status)).toBe(false);
    expect(failedAlert(article)).toBeNull();
    expect(button.getAttribute("aria-label")).toBe("复制");
    expectNoToast();
  });

  it("writes a source that ends in a newline untouched: only the code-block copy trims one", async () => {
    const source = "第一段\n\n```sh\nls\n```\n";
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { button } = await mountCopy(source);

    fireEvent.click(button);
    await waitFor(() => expect(iconOf(button)).toBe("check"));
    expect(writeText.mock.calls).toEqual([[source]]);
  });

  it("reverts the check icon and drops the 已复制 status after about 2 seconds", async () => {
    mockClipboard(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined));
    const { article, button } = await mountCopy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    fireEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(iconOf(button)).toBe("check");
    expect(copiedStatus(article)?.textContent).toBe(COPIED);

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(iconOf(button)).toBe("check");
    expect(copiedStatus(article)?.textContent).toBe(COPIED);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(iconOf(button)).toBe("copy");
    expect(copiedStatus(article)).toBeNull();
    expectNoToast();
  });
});

describe("(C2) missing clipboard API", () => {
  it("shows 复制失败 next to the button without a toast or an escaping rejection", async () => {
    expect("clipboard" in navigator).toBe(false);
    const observer = observeUnhandledRejections();
    try {
      const { article, button } = await mountCopy();
      fireEvent.click(button);
      const alert = await within(article).findByRole("alert");
      expect(alert.textContent).toBe(FAILED);
      expect(alert.parentElement).toBe(button.parentElement);
      expect(alert.previousElementSibling).toBe(button);
      expect(iconOf(button)).toBe("copy");
      expect(copiedStatus(article)).toBeNull();
      expectNoToast();
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});

describe("(C3) writeText fails", () => {
  it.each([
    ["rejects", () => Promise.reject(new DOMException("denied", "NotAllowedError"))],
    [
      "throws synchronously",
      (): Promise<void> => {
        throw new Error("sync");
      },
    ],
  ] as const)("shows 复制失败 inline and contains the failure when it %s", async (_, fail) => {
    const writeText = vi.fn<(text: string) => Promise<void>>(fail);
    mockClipboard(writeText);
    const observer = observeUnhandledRejections();
    try {
      const { article, button } = await mountCopy();
      fireEvent.click(button);
      expect((await within(article).findByRole("alert")).textContent).toBe(FAILED);
      expect(writeText.mock.calls).toEqual([[RAW]]);
      expect(iconOf(button)).toBe("copy");
      expect(copiedStatus(article)).toBeNull();
      expectNoToast();
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });

  it("clears 复制失败 on the next click, before that copy settles", async () => {
    let release: () => void = () => undefined;
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("denied"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    mockClipboard(writeText);
    const { article, button } = await mountCopy();
    fireEvent.click(button);
    await within(article).findByRole("alert");

    fireEvent.click(button);
    expect(failedAlert(article)).toBeNull();
    expect(iconOf(button)).toBe("copy");
    expect(copiedStatus(article)).toBeNull();

    await act(async () => release());
    expect(iconOf(button)).toBe("check");
    expect(copiedStatus(article)?.textContent).toBe(COPIED);
    expect(failedAlert(article)).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(2);
    expectNoToast();
  });

  it("clears 复制失败 once the clipboard recovers and the next copy succeeds", async () => {
    const { article, button } = await mountCopy();
    fireEvent.click(button);
    await within(article).findByRole("alert");

    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    fireEvent.click(button);
    await waitFor(() => expect(iconOf(button)).toBe("check"));
    expect(failedAlert(article)).toBeNull();
    expect(writeText.mock.calls).toEqual([[RAW]]);
    expectNoToast();
  });

  it("replaces 已复制 with 复制失败 when a later copy fails", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    mockClipboard(writeText);
    const { article, button } = await mountCopy();
    fireEvent.click(button);
    await waitFor(() => expect(iconOf(button)).toBe("check"));

    fireEvent.click(button);
    expect((await within(article).findByRole("alert")).textContent).toBe(FAILED);
    expect(iconOf(button)).toBe("copy");
    expect(copiedStatus(article)).toBeNull();
  });
});

describe("(C4) render conditions", () => {
  it("renders no copy button on a running assistant with text", async () => {
    mountSnapshot(
      chatSnapshot({ content: "进行中", assistantStatus: "running", cursor: { epoch: 1, seq: 3 } }),
    );
    const article = await screen.findByRole("article", { name: "助手" });
    expect(within(article).getByText("进行中")).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("renders no copy button on a done assistant with empty text", async () => {
    mountSnapshot(doneSnapshot(""));
    const article = await screen.findByRole("article", { name: "助手" });
    expect(within(article).queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("renders a decorative icon button on a failed assistant with text", async () => {
    mountSnapshot(
      chatSnapshot({
        status: "failed",
        content: "部分",
        assistantStatus: "failed",
        steps: [
          {
            id: 11,
            ordinal: 0,
            name: "bash",
            detail: "",
            output: "",
            status: "done",
            changes: null,
          },
        ],
        cursor: { epoch: 1, seq: null },
      }),
    );
    const article = await screen.findByRole("article", { name: "助手" });
    const button = within(article).getByRole("button", { name: "复制" });
    expect(button.getAttribute("title")).toBe("复制");
    expect(button.getAttribute("aria-label")).toBe("复制");
    const icon = button.querySelector("svg.ui-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(button.getAttribute("type")).toBe("button");
    const actions = button.closest(ROW);
    expect(actions).not.toBeNull();
    expect(actions?.classList.contains("mt-2")).toBe(true);
    expect(
      article.querySelector('[data-slot="message-content"] > [data-slot="tool-group-root"]'),
    ).not.toBeNull();
    expect(article.querySelector('[data-slot="message-content"]')?.lastElementChild).toBe(actions);
    const user = screen.getByRole("article", { name: "用户" });
    expect(within(user).queryByRole("button", { name: "复制" })).toBeNull();
    expect(user.querySelector(ROW)?.classList.contains("mt-2")).toBe(true);
    const userButtons = within(user).getAllByRole("button");
    expect(userButtons.map((b) => b.getAttribute("aria-label"))).toEqual(["撤回", "从此处分叉"]);
  });
});

describe("(C5) each assistant copies its own text", () => {
  it("binds every copy button to its own message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const snapshot = doneSnapshot("一");
    const [, first] = snapshot.messages;
    if (!first) throw new Error("chatSnapshot 缺少助手消息");
    snapshot.messages = [
      historyUser,
      first,
      { ...historyUser, id: 1, createdAt: 1, content: "第二问" },
      { ...first, id: 2, createdAt: 2, content: "二" },
    ];
    mountSnapshot(snapshot);
    await screen.findByText("二");
    const articles = screen.getAllByRole("article", { name: "助手" });
    expect(articles).toHaveLength(2);
    const [one, two] = articles;
    if (!one || !two) throw new Error("缺少助手 article");
    fireEvent.click(within(one).getByRole("button", { name: "复制" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.lastCall?.[0]).toBe("一");
    fireEvent.click(within(two).getByRole("button", { name: "复制" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.lastCall?.[0]).toBe("二");
    await waitFor(() => expect(copiedStatus(two)?.textContent).toBe(COPIED));
    expectNoToast();
  });
});
