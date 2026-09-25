import { fireEvent, screen, within } from "@testing-library/react";
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
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const RAW = "# 标题\n\n段落 **粗体** 与 `行内`";
const COPIED = "已复制到剪贴板";
const FAILED = "复制失败";

afterEach(() => {
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

async function clickCopy() {
  const article = await screen.findByRole("article", { name: "助手" });
  fireEvent.click(within(article).getByRole("button", { name: "复制" }));
}

function toastRegion() {
  return within(screen.getByRole("region", { name: "通知" }));
}

async function expectToast(message: string, type: "success" | "error") {
  const text = await toastRegion().findByText(message);
  expect(text.closest(".ui-toast")?.classList.contains(`ui-toast--${type}`)).toBe(true);
}

describe("(C1) copy writes the raw assistant text", () => {
  it("writes the Markdown source once and shows the success toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    mountSnapshot(doneSnapshot(RAW));
    await clickCopy();
    await expectToast(COPIED, "success");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe(RAW);
    expect(toastRegion().queryByText(FAILED)).toBeNull();
  });
});

describe("(C2) missing clipboard API", () => {
  it("shows the failure toast without an escaping rejection", async () => {
    expect("clipboard" in navigator).toBe(false);
    const observer = observeUnhandledRejections();
    try {
      mountSnapshot(doneSnapshot(RAW));
      await clickCopy();
      await expectToast(FAILED, "error");
      expect(toastRegion().queryByText(COPIED)).toBeNull();
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});

describe("(C3) writeText rejects", () => {
  it("shows the failure toast and contains the rejection", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    mockClipboard(writeText);
    const observer = observeUnhandledRejections();
    try {
      mountSnapshot(doneSnapshot(RAW));
      await clickCopy();
      await expectToast(FAILED, "error");
      expect(toastRegion().queryByText(COPIED)).toBeNull();
      expect(writeText).toHaveBeenCalledTimes(1);
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});

describe("(C3b) writeText throws synchronously", () => {
  it("shows the failure toast and contains the throw", async () => {
    const writeText = vi.fn((_text: string): Promise<void> => {
      throw new Error("sync");
    });
    mockClipboard(writeText);
    const observer = observeUnhandledRejections();
    try {
      mountSnapshot(doneSnapshot(RAW));
      await clickCopy();
      await expectToast(FAILED, "error");
      expect(toastRegion().queryByText(COPIED)).toBeNull();
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
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
        steps: [{ id: 11, ordinal: 0, name: "bash", detail: "", output: "", status: "done" }],
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
    const actions = button.closest(".chat-msg-actions");
    expect(actions).not.toBeNull();
    expect(article.querySelector(".chat-msg-main > .chat-step")).not.toBeNull();
    expect(article.querySelector(".chat-msg-main")?.lastElementChild).toBe(actions);
    const user = screen.getByRole("article", { name: "用户" });
    expect(within(user).queryByRole("button")).toBeNull();
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
    await toastRegion().findAllByText(COPIED);
  });
});

describe("(C6) static contract", () => {
  const css = () => stripComments(readRepoFile("web/src/features/chat/messages.css"));

  it("lays out the action row and sizes the button with tokens", () => {
    expect(ruleBody(css(), ".chat-msg-actions")).toContain("display: flex");
    const action = ruleBody(css(), ".chat-msg-action");
    expect(action).toContain("width: 26px");
    expect(action).toMatch(/(^|[^-])color: var\(--wb-[a-z0-9-]+\)/);
    expect(ruleBody(css(), ".chat-msg-action:hover:not(:disabled)")).toContain(
      "color: var(--wb-text-secondary)",
    );
    expect(ruleBody(css(), ".chat-msg-action:focus-visible")).toContain("border-radius: 6px");
  });
});
