import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, FakeEventSource, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { deferredResponse, jsonResponse } from "./support.js";
import {
  blockBody,
  COLOR_LITERAL_PATTERNS,
  readRepoFile,
  ruleBody,
  stripComments,
} from "./ui-support.js";

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
  const card = input.closest('[data-slot="composer-card"]');
  const toolbar = card?.querySelector('[data-slot="composer-toolbar"]');
  if (!(form instanceof HTMLFormElement) || !(card instanceof HTMLElement)) {
    throw new Error("expected textarea inside form > composer card");
  }
  if (!(toolbar instanceof HTMLElement)) {
    throw new Error("expected the composer toolbar inside the card");
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

    const buttons = within(form).queryAllByRole("button");
    expect(buttons).toHaveLength(1);
    const send = within(form).getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(buttons[0]).toBe(send);
    expect(send.type).toBe("submit");
    expect(send.querySelector("svg")?.classList.contains("lucide-send")).toBe(true);
    expect(card.contains(send)).toBe(true);
    expect(toolbar.contains(send)).toBe(true);
    expect(card.lastElementChild).toBe(toolbar);
    expect(precedes(input, toolbar)).toBe(true);

    const label = form.querySelector(`label[for="${input.id}"]`);
    expect(input.id).not.toBe("");
    expect(label?.textContent).toBe(COMPOSER_NAME);

    const hint = screen.getByText(HINT, { exact: true });
    expect(form.contains(hint)).toBe(true);
    expect(card.contains(hint)).toBe(false);
    expect(hint.id).not.toBe("");
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    // 卡 + 提示行之外不渲染任何东西（能力栏在卡内的工具栏里）。
    const children = Array.from(form.children);
    expect(children).toHaveLength(2);
    expect(children[0]).toBe(card);
    expect(children[1]).toBe(hint);
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
  it("replaces send with 停止 and shows the toolbar status until done", async () => {
    const running = chatSnapshot({ cursor: { epoch: 1, seq: 3 } });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [running.session] }),
      [MESSAGES_PATH]: () => jsonResponse(running),
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      latestSource().emitOpen();
    });

    const pending = (await screen.findByRole("button", { name: "停止" })) as HTMLButtonElement;
    expect(pending.disabled).toBe(false);
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
      ...NULL_SESSION_META,
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
  it("session nav maps session status through SESSION_STATUS_LABEL", () => {
    const source = readRepoFile("web/src/features/chat/session-sidebar.tsx");
    expect(source).not.toMatch(/>\s*\{session\.status\}\s*</);
    expect(source).toContain("SESSION_STATUS_LABEL");
    expect(source).toContain("ui-pulse");
    // 列表只经侧栏槽位渲染：主区视图不再持有会话列表。
    const view = readRepoFile("web/src/features/chat/conversation-view.tsx");
    expect(view).not.toContain("会话列表");
    expect(view).not.toContain("新建会话");
  });

  it("chat.css: single-column layout, one-row playbooks at ≥761px, wrap kept at ≤760px", () => {
    const css = stripComments(readRepoFile("web/src/features/chat/chat.css"));
    expect(ruleBody(css, ".chat-layout")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(css).not.toContain(".chat-sidebar");
    const row = ruleBody(css, ".chat-playbooks-row");
    expect(row).toContain("flex-wrap: nowrap;");
    expect(row).not.toContain("overflow");
    const card = ruleBody(css, ".chat-playbooks-row > li");
    expect(card).toContain("flex: 1 1 0;");
    expect(card).toContain("min-width: 0;");
    expect(card).toContain("max-width: 220px;");
    expect(ruleBody(css, ".chat-playbook-title-text")).toContain("text-overflow: ellipsis;");
    const narrow = blockBody(css, /@media\s*\(max-width:\s*760px\)\s*\{/);
    expect(ruleBody(narrow, ".chat-playbooks-row")).toContain("flex-wrap: wrap;");
    expect(ruleBody(narrow, ".chat-playbooks-row > li")).toContain("flex: 1 1 140px;");
    expect(ruleBody(narrow, ".chat-layout")).not.toContain("gap");
    expect(ruleBody(css, ".chat-session-nav")).not.toContain("overflow");
  });

  it("chat.css drops the badge styles and holds no composer rules", () => {
    const raw = readRepoFile("web/src/features/chat/chat.css");
    const css = stripComments(raw);
    for (const removed of [
      ".chat-session-status-running",
      ".chat-composer",
      ".chat-send",
      ".chat-workspace-",
      "outline: none",
    ]) {
      expect(css).not.toContain(removed);
    }
    expect(raw).not.toMatch(COLOR_LITERAL_PATTERNS[0] as RegExp);
    expect(raw).toContain("demo.html:282-298");
    const statusRule = ruleBody(css, ".chat-session-status");
    expect(statusRule).not.toContain("padding");
    expect(statusRule).not.toContain("background");
  });

  it("ui-walk expects the Chinese session status", () => {
    const walk = readRepoFile("web/e2e/ui-walk.spec.ts");
    expect(walk).toContain('expectSelectedSessionStatus(page, project, "运行中")');
    expect(walk).toContain('expectSelectedSessionStatus(page, project, "已完成")');
    expect(readRepoFile("web/e2e/ui-walk-layout.ts")).toContain(
      'current.getByRole("status")).toHaveText(text)',
    );
    expect(walk).not.toContain('toHaveText("running")');
    expect(walk).not.toContain('toHaveText("done")');
  });
});
