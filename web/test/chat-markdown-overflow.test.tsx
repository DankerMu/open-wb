// 助手正文 Markdown→hast 转换栈溢出时的本地错误边界（#1534，change markdown-body-error-boundary；chat-web「消息线程」
// 场景「正文转换栈溢出时回退纯文本」）。seam：整页挂载 + 假 API（chat-page-support.tsx），文本变化重试一步直接
// 渲染 `MessageBody`。N 是固定常量、在 issue 实测值（`> ` 3000 / `<div>` 1700）上留了余量，不是探出的最小值；
// 断言本身自证溢出——没溢出时会渲染出 `blockquote` / `div`、`<script>` 会被消毒删掉。没有本地边界时异常被
// react-router 的默认错误边界接住，整页换成 `Unexpected Application Error!`（红态的三个可观测量见各断言）。
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { MessageBody } from "../src/features/chat/message-segments-view.js";
import { cleanupChatPage, mountAssistantReply, renderChatPage } from "./chat-page-support.js";
import { step } from "./chat-segments-support.js";
import { chatSnapshot, historyUser, SESSION_ID } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

const BODY = '[data-slot="message-body"]';
const QUOTES = `${"> ".repeat(6000)}x`;
const DIVS = `${"<div>".repeat(4000)}x`;
const QUOTES_SCRIPT = `${"> ".repeat(6000)}<script>window.__pwned=1</script>`;
const RR_DEFAULT = "Error handled by React Router default ErrorBoundary";

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  // React 开发态会把边界接住的渲染错误打到 console.error：静音，并在断言里区分它与 react-router 那条。
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanupChatPage();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__pwned");
});

/** 渲染期确实抛过 RangeError（React 报告被边界接住的错误），且 react-router 的默认错误边界没有接到。 */
function expectCaughtLocally() {
  const calls = consoleError.mock.calls;
  expect(calls.some((args) => args.some((arg) => arg instanceof RangeError))).toBe(true);
  expect(calls.some((args) => args.some((arg) => String(arg).includes(RR_DEFAULT)))).toBe(false);
  expect(document.body.textContent).not.toContain("Unexpected Application Error!");
}

describe("chat-web「消息线程」：正文转换栈溢出时回退纯文本", () => {
  it("引用块嵌套溢出：正文段显示原文纯文本，没有 blockquote；助手消息在，页面不落到路由默认错误页", async () => {
    const { body } = await mountAssistantReply(QUOTES);

    expect(body.textContent?.startsWith("> > ")).toBe(true);
    expect(body.textContent?.endsWith("x")).toBe(true);
    expect(body.querySelector("blockquote")).toBeNull();
    expectCaughtLocally();
  });

  it("源 HTML（rehype-raw 路径）嵌套溢出：同样回退为纯文本，没有 div 子元素", async () => {
    const { body } = await mountAssistantReply(DIVS);

    expect(body.textContent?.startsWith("<div><div>")).toBe(true);
    expect(body.textContent?.endsWith("x")).toBe(true);
    expect(body.querySelector("div")).toBeNull();
    expectCaughtLocally();
  });

  it("回退文本不经 HTML 解析：<script> 按字面显示，没有 script 元素，不执行", async () => {
    const { body } = await mountAssistantReply(QUOTES_SCRIPT);

    expect(body.textContent).toContain("<script>window.__pwned=1</script>");
    expect(body.querySelector("blockquote")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expectCaughtLocally();
  });

  it("同一会话另一条消息的链接、溢出消息正文段之后的工具块、侧栏与输入框照常渲染", async () => {
    const overflowing = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      content: QUOTES,
      steps: [step(41, 0, "read", QUOTES.length)],
      cursor: { epoch: 1, seq: null },
    });
    const [user, reply] = overflowing.messages as [
      (typeof overflowing.messages)[number],
      (typeof overflowing.messages)[number],
    ];
    const snapshot = {
      ...overflowing,
      messages: [
        { ...historyUser, id: -5 },
        { ...reply, id: -4, content: "见[官网](https://example.com/a)。", steps: [] },
        user,
        reply,
      ],
    };
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
    });

    const replies = await screen.findAllByRole("article", { name: "助手" });
    expect(replies).toHaveLength(2);
    const [normal, broken] = replies as [HTMLElement, HTMLElement];
    expect(within(normal).getByRole("link", { name: "官网" }).getAttribute("href")).toBe(
      "https://example.com/a",
    );
    const body = broken.querySelector(BODY);
    expect(body?.textContent?.startsWith("> > ")).toBe(true);
    expect(body?.querySelector("blockquote")).toBeNull();
    const group = broken.querySelector('[data-slot="tool-group-root"]');
    expect(group).not.toBeNull();
    expect(body?.compareDocumentPosition(group as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole("complementary", { name: "侧栏" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    expectCaughtLocally();
  });

  it("回退态的正文段文本换成 **粗**：渲染出 strong，不再是纯文本", async () => {
    const { container, rerender } = render(<MessageBody dot={false} status="done" text={QUOTES} />);
    const body = container.querySelector(BODY) as HTMLElement;
    expect(body.textContent?.startsWith("> > ")).toBe(true);
    expect(body.querySelector("blockquote")).toBeNull();

    rerender(<MessageBody dot={false} status="done" text="**粗**" />);

    await waitFor(() => expect(body.querySelector("strong")?.textContent).toBe("粗"));
    expect(body.textContent).toBe("粗");
  });
});
