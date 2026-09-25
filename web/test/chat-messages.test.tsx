import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, historyUser, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";
import {
  COLOR_LITERAL_PATTERNS,
  listRepoFiles,
  readRepoFile,
  ruleBody,
  stripComments,
} from "./ui-support.js";

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const exactText = { exact: true, collapseWhitespace: false, trim: false } as const;
const MARKDOWN_REPLY = [
  "# 标题",
  "",
  "段落 **粗体** 与 `行内`",
  "",
  "```",
  "<script>alert(1)</script>",
  "```",
  "",
  "<img src=x onerror=alert(1)> [链接](https://example.com)",
].join("\n");
const MULTILINE_USER = "第一行\n  第二行\n\n末行";

afterEach(() => {
  cleanupChatPage();
});

function doneSnapshot(
  content: string,
  steps: ChatMessageSnapshot["messages"][number]["steps"] = [],
): ChatMessageSnapshot {
  return chatSnapshot({
    status: "done",
    assistantStatus: "done",
    content,
    steps,
    cursor: { epoch: 1, seq: null },
  });
}

function mountSnapshot(snapshot: ChatMessageSnapshot) {
  return renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [messagesPath]: () => jsonResponse(snapshot),
  });
}

async function assistantArticle(): Promise<HTMLElement> {
  return screen.findByRole("article", { name: "助手" });
}

function chatCss(): string {
  return stripComments(readRepoFile("web/src/features/chat/chat.css"));
}

describe("(M1) assistant Markdown renders through the shared safe renderer", () => {
  it("renders heading/strong/code, keeps source HTML as text and links inert", async () => {
    mountSnapshot(doneSnapshot(MARKDOWN_REPLY));
    const article = await assistantArticle();
    const view = within(article);
    expect(view.getByRole("heading", { level: 1, name: "标题" })).toBeTruthy();
    expect(article.querySelector("strong")?.textContent).toBe("粗体");
    expect(article.querySelector("pre > code")?.textContent).toBe("<script>alert(1)</script>");
    expect(article.querySelector("p code")?.textContent).toBe("行内");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(article.textContent).toContain("<img src=x onerror=alert(1)>");
    const link = view.getByRole("link", { name: "链接" });
    expect(link.getAttribute("href")).toBe("#");
    expect(fireEvent.click(link)).toBe(false);
  });
});

describe("(M2) user bubble keeps the raw text", () => {
  it("renders multi-line user text verbatim in the first paragraph of the user article", async () => {
    const snapshot = doneSnapshot("好的");
    snapshot.messages[0] = { ...historyUser, content: MULTILINE_USER };
    mountSnapshot(snapshot);
    const user = await screen.findByRole("article", { name: "用户" });
    const first = user.querySelector("p");
    expect(first?.textContent).toBe(MULTILINE_USER);
    expect(first?.classList.contains("chat-msg-body")).toBe(true);
  });

  it("styles the user bubble right-aligned with pre-wrap text", () => {
    const css = chatCss();
    expect(ruleBody(css, ".chat-msg-user .chat-msg-body")).toContain("white-space: pre-wrap");
    expect(ruleBody(css, ".chat-msg-user")).toContain("align-self: flex-end");
  });
});

describe("(M3) streaming caret lifecycle", () => {
  it("shows a trailing decorative caret while running and drops it at done", async () => {
    mountSnapshot(
      chatSnapshot({ content: "进行中", assistantStatus: "running", cursor: { epoch: 1, seq: 3 } }),
    );
    const article = await assistantArticle();
    const body = article.querySelector(".chat-md");
    expect(body).not.toBeNull();
    const caret = body?.lastElementChild;
    expect(caret?.tagName).toBe("SPAN");
    expect(caret?.classList.contains("ui-caret")).toBe(true);
    expect(caret?.classList.contains("chat-caret")).toBe(true);
    expect(caret?.getAttribute("aria-hidden")).toBe("true");

    await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
    const source = latestSource();
    act(() => {
      source.emitOpen();
      source.emitData("text.delta", "1:4", { messageId: 0, delta: "！" });
      source.emitData("turn.end", "1:5", { messageId: 0, status: "done" });
    });
    await waitFor(() => {
      expect(document.querySelector(".ui-caret")).toBeNull();
    });
    expect(within(article).getByText("进行中！", exactText)).toBeTruthy();
  });

  it("paints the caret with the brand token", () => {
    expect(ruleBody(chatCss(), ".chat-caret")).toContain("background: var(--wb-brand-primary)");
  });
});

describe("(M4) avatar and assistant block structure", () => {
  it("leads the assistant block with a decorative BrandMark and keeps steps after the text", async () => {
    mountSnapshot(
      doneSnapshot("完成", [
        { id: 11, ordinal: 0, name: "bash", detail: "echo ok", status: "done" },
      ]),
    );
    const article = await assistantArticle();
    expect(within(article).queryByRole("img")).toBeNull();
    const avatar = article.firstElementChild;
    expect(avatar?.tagName).toBe("SPAN");
    expect(avatar?.classList.contains("chat-msg-avatar")).toBe(true);
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.querySelector("svg.ui-brand-mark")).not.toBeNull();

    const user = screen.getByRole("article", { name: "用户" });
    expect(user.querySelector(".chat-msg-avatar")).toBeNull();
    expect(document.querySelector(".chat-msg-role")).toBeNull();

    const main = article.querySelector(".chat-msg-main");
    const text = main?.querySelector(".chat-md");
    const step = within(article).getByRole("region", { name: "bash" });
    expect(text).not.toBeNull();
    expect(main?.contains(step)).toBe(true);
    expect(
      (text as Element).compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("(M5) static contract", () => {
  it("relocates md-render and shares one React renderer between files and chat", () => {
    expect(readRepoFile("web/src/lib/md-render.ts")).toContain(
      "Markdown subset renderer ported from resource/workbuddy-live-demo.html:1145-1185",
    );
    expect(existsSync(resolve(import.meta.dirname, "../src/features/files/md-render.ts"))).toBe(
      false,
    );
    const preview = readRepoFile("web/src/features/files/preview.tsx");
    expect(preview).toContain("MarkdownView");
    expect(preview).not.toContain("function renderBlock");
    const conversation = readRepoFile("web/src/features/chat/conversation-view.tsx");
    expect(conversation).toContain("MarkdownView");
    expect(conversation).toContain("BrandMark");
    const view = readRepoFile("web/src/lib/markdown-view.tsx");
    expect(view).not.toContain('from "../features');
    expect(view).not.toContain('from "../ui');
  });

  it("never injects HTML anywhere in web/src", () => {
    const sources = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path));
    expect(sources.length).toBeGreaterThan(0);
    const injecting = sources.filter((path) => {
      const source = readRepoFile(path);
      return source.includes("dangerouslySetInnerHTML") || source.includes(".innerHTML");
    });
    expect(injecting).toEqual([]);
  });

  it("chat.css carries no literal colors", () => {
    const raw = readRepoFile("web/src/features/chat/chat.css");
    for (const pattern of COLOR_LITERAL_PATTERNS) {
      expect(raw).not.toMatch(pattern);
    }
  });
});
