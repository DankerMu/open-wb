import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, FakeEventSource, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { deferredResponse, jsonResponse } from "./support.js";
import { COLOR_LITERAL_PATTERNS, readRepoFile, ruleBody, stripComments } from "./ui-support.js";

const COMPOSER_NAME = "给助手发消息";
const HINT = "Enter 发送 · Shift+Enter 换行";
const WELCOME_PLACEHOLDER = "今天帮你做些什么";
const FOLLOW_UP_PLACEHOLDER = "继续追问，或派一个新任务…";
const MESSAGES_PATH = `/api/sessions/${SESSION_ID}/messages`;
const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;

afterEach(() => {
  cleanupChatPage();
});

function doneSnapshot() {
  return chatSnapshot({ status: "done", assistantStatus: "done", cursor: { epoch: 1, seq: null } });
}

/** 已选中一个 done 会话，等历史读完（loading 期间 generating 也为真）后返回 composer 各部件。 */
async function mountSelectedDone() {
  const snapshot = doneSnapshot();
  const pendingPrompt = deferredResponse();
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [MESSAGES_PATH]: () => jsonResponse(snapshot),
    [PROMPT_PATH]: () => pendingPrompt.promise,
  });
  const input = (await screen.findByRole("textbox", {
    name: COMPOSER_NAME,
  })) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return { fetchMock, input };
}

function composerParts(input: HTMLElement) {
  const form = input.closest("form");
  const card = input.closest(".chat-composer-card");
  const toolbar = card?.querySelector(".chat-composer-toolbar");
  if (!(form instanceof HTMLFormElement) || !(card instanceof HTMLElement)) {
    throw new Error("expected textarea inside form.chat-composer > .chat-composer-card");
  }
  if (!(toolbar instanceof HTMLElement)) {
    throw new Error("expected .chat-composer-toolbar inside the card");
  }
  return { form, card, toolbar };
}

function precedes(first: Node, second: Node) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("(C1) composer placeholder", () => {
  it("uses the welcome placeholder without a selected session", async () => {
    renderChatPage("/", { "/api/sessions": () => jsonResponse({ sessions: [] }) });
    const input = (await screen.findByRole("textbox", {
      name: COMPOSER_NAME,
    })) as HTMLTextAreaElement;
    expect(input.placeholder).toBe(WELCOME_PLACEHOLDER);
  });

  it("uses the follow-up placeholder with a selected session", async () => {
    const { input } = await mountSelectedDone();
    expect(input.placeholder).toBe(FOLLOW_UP_PLACEHOLDER);
  });
});

describe("(C2) composer card structure", () => {
  it("renders textarea, sr-only label, toolbar with one icon send button and the hint", async () => {
    const { input } = await mountSelectedDone();
    const { form, card, toolbar } = composerParts(input);
    expect(form.className).toBe("chat-composer");

    const buttons = within(form).queryAllByRole("button");
    expect(buttons).toHaveLength(1);
    const send = within(form).getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(buttons[0]).toBe(send);
    expect(send.type).toBe("submit");
    expect(send.querySelector("svg")).not.toBeNull();
    expect(card.contains(send)).toBe(true);
    expect(toolbar.contains(send)).toBe(true);
    expect(card.lastElementChild).toBe(toolbar);
    expect(precedes(input, toolbar)).toBe(true);

    const label = form.querySelector(`label[for="${input.id}"]`);
    expect(input.id).not.toBe("");
    expect(label?.className).toBe("ui-sr-only");
    expect(label?.textContent).toBe(COMPOSER_NAME);

    const hint = screen.getByText(HINT, { exact: true });
    expect(form.contains(hint)).toBe(true);
    expect(card.contains(hint)).toBe(false);
    expect(hint.id).not.toBe("");
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("(C6) submits once through requestSubmit when Enter is pressed", async () => {
    const { fetchMock, input } = await mountSelectedDone();
    fireEvent.change(input, { target: { value: "继续" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([path]) => path === PROMPT_PATH)).toHaveLength(1);
    });
  });
});

describe("(C3) generating state", () => {
  it("names the disabled send button 生成中 and shows the toolbar status until done", async () => {
    const running = chatSnapshot({ cursor: { epoch: 1, seq: 3 } });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [running.session] }),
      [MESSAGES_PATH]: () => jsonResponse(running),
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      latestSource().emitOpen();
    });

    const pending = (await screen.findByRole("button", { name: "生成中" })) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    const input = screen.getByRole("textbox", { name: COMPOSER_NAME });
    const { toolbar } = composerParts(input);
    const status = within(toolbar).getByRole("status");
    expect(status.textContent).toBe("生成中");
    expect(precedes(status, pending)).toBe(true);

    act(() => {
      latestSource().emitData("turn.end", "1:4", { messageId: 0, status: "done" });
    });
    expect(await screen.findByRole("button", { name: "发送" })).toBeTruthy();
    expect(within(toolbar).queryByRole("status")).toBeNull();
  });
});

describe("(C4) session list status element", () => {
  const rows = [
    { id: "a".repeat(32), title: "会话甲", status: "running", label: "运行中" },
    { id: "b".repeat(32), title: "会话乙", status: "done", label: "已完成" },
    { id: "c".repeat(32), title: "会话丙", status: "failed", label: "失败" },
    { id: "d".repeat(32), title: "会话丁", status: "idle", label: "未开始" },
  ] as const;

  it("shows a dot plus visually hidden Chinese status named `<title> <状态>`", async () => {
    const sessions = rows.map(({ id, title, status }, index) => ({
      id,
      title,
      status,
      createdAt: 1_740_000_000_000,
      updatedAt: 1_740_000_000_100 - index,
    }));
    renderChatPage("/", { "/api/sessions": () => jsonResponse({ sessions }) });
    const nav = await screen.findByRole("navigation", { name: "会话列表" });
    await within(nav).findByRole("button", { name: "会话甲" });

    for (const { title, status, label } of rows) {
      const element = within(nav).getByRole("status", { name: `${title} ${label}` });
      expect(element.textContent).toBe(label);
      expect(element.querySelector(".ui-sr-only")?.textContent).toBe(label);
      const dot = element.querySelector(".chat-session-dot");
      expect(dot?.getAttribute("aria-hidden")).toBe("true");
      expect(dot?.classList.contains(`chat-session-dot-${status}`)).toBe(true);
      expect(dot?.classList.contains("ui-pulse")).toBe(status === "running");
      expect(within(nav).getByRole("button", { name: title })).toBeTruthy();
    }
    for (const english of ["running", "done", "failed", "idle"]) {
      expect(nav.textContent).not.toContain(english);
    }
  });
});

describe("(C5) static contract", () => {
  it("composer uses the Icon/Button primitives and no role other than status", () => {
    const source = readRepoFile("web/src/features/chat/composer.tsx");
    for (const needle of ["Icon", "Button", "ui-sr-only", '"生成中"', '"发送"']) {
      expect(source).toContain(needle);
    }
    const roles = source.match(/role=/g) ?? [];
    expect(roles.length).toBe((source.match(/role="status"/g) ?? []).length);
    const buttonTag = /<Button\b[^>]*>/.exec(source)?.[0] ?? "";
    expect(buttonTag).not.toBe("");
    expect(buttonTag).not.toContain("role");
  });

  it("conversation view maps session status through SESSION_STATUS_LABEL", () => {
    const source = readRepoFile("web/src/features/chat/conversation-view.tsx");
    expect(source).not.toMatch(/>\s*\{session\.status\}\s*</);
    expect(source).toContain("SESSION_STATUS_LABEL");
    expect(source).toContain("ui-pulse");
  });

  it("chat.css drops the badge and visible-label styles and keeps the round focus ring", () => {
    const raw = readRepoFile("web/src/features/chat/chat.css");
    const css = stripComments(raw);
    for (const removed of [
      ".chat-session-status-running",
      ".chat-composer-label",
      ".chat-composer-foot",
      "outline: none",
    ]) {
      expect(css).not.toContain(removed);
    }
    expect(raw).not.toMatch(COLOR_LITERAL_PATTERNS[0] as RegExp);
    expect(raw).toContain("demo.html:282-298");
    expect(raw).toContain("demo.html:363-378");
    expect(ruleBody(css, ".chat-send:focus-visible")).toContain("border-radius: 50%");
    const statusRule = ruleBody(css, ".chat-session-status");
    expect(statusRule).not.toContain("padding");
    expect(statusRule).not.toContain("background");
  });

  it("ui-walk expects the Chinese session status", () => {
    const walk = readRepoFile("web/e2e/ui-walk.spec.ts");
    expect(walk).toContain('toHaveText("运行中")');
    expect(walk).toContain('toHaveText("已完成")');
    expect(walk).not.toContain('toHaveText("running")');
    expect(walk).not.toContain('toHaveText("done")');
  });
});
