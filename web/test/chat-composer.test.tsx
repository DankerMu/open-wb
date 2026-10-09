import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, FakeEventSource, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { deferredResponse, jsonResponse } from "./support.js";
import { readRepoFile } from "./ui-support.js";

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
  it("renders textarea, sr-only label, toolbar with the 「+」 button, the permission tier and one icon send button, and the hint", async () => {
    const { input } = await mountSelectedDone();
    const { form, card, toolbar } = composerParts(input);

    const buttons = within(form).queryAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "添加文件或命令",
      "权限：只问命令",
      "发送",
    ]);
    const send = within(form).getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(buttons[2]).toBe(send);
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

  it("shows a visually hidden Chinese status named `<title> <状态>`, with a visible mark only while running or failed", async () => {
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
      expect(element.querySelector(".sr-only")?.textContent).toBe(label);
      // 可见标记只有 运行中 / 失败（与 等待确认）；已完成、未开始 没有标记元素。
      const mark = element.querySelector("[data-status-mark]");
      const visible = status === "running" || status === "failed";
      expect(mark?.getAttribute("data-status-mark") ?? null).toBe(visible ? status : null);
      if (mark) expect(mark.getAttribute("aria-hidden")).toBe("true");
      expect(within(nav).getByRole("button", { name: title })).toBeTruthy();
    }
    for (const english of ["running", "done", "failed", "idle"]) {
      expect(nav.textContent).not.toContain(english);
    }
  });
});

describe("(C5) static contract", () => {
  it("session nav maps session status through SessionStatusMark (sessionStatusText)", () => {
    // 条目行在 session-entry.tsx（默认视图与归档视图共用），侧栏与归档视图都经它渲染条目。
    const source = readRepoFile("web/src/features/chat/session-entry.tsx");
    expect(source).not.toMatch(/>\s*\{session\.status\}\s*</);
    expect(source).toContain("<SessionStatusMark ");
    for (const file of ["session-sidebar.tsx", "archived-view.tsx"]) {
      const list = readRepoFile(`web/src/features/chat/${file}`);
      expect(list).not.toMatch(/>\s*\{session\.status\}\s*</);
      expect(list).toContain("<SessionEntryList");
    }
    expect(readRepoFile("web/src/features/chat/session-status-mark.tsx")).toContain(
      "sessionStatusText(session)",
    );
    expect(readRepoFile("web/src/features/chat/status-label.ts")).toContain("SESSION_STATUS_LABEL");
    // 列表只经侧栏槽位渲染：主区视图不再持有会话列表。
    const view = readRepoFile("web/src/features/chat/conversation-view.tsx");
    expect(view).not.toContain("会话列表");
    expect(view).not.toContain("新建会话");
  });

  it("single-column layout lives in the view; the row menu and the rename dialog carry no legacy class", () => {
    const view = readRepoFile("web/src/features/chat/conversation-view.tsx");
    expect(view).toContain("grid-cols-[minmax(0,1fr)]");
    expect(view).not.toMatch(/chat-(layout|main)/);
    // 条目菜单与重命名对话框已改用 Tailwind；chat.css 已删除（分层守卫断言目录下没有 .css）。
    for (const source of ["session-menu.tsx", "rename-dialog.tsx", "session-sidebar.tsx"]) {
      expect(readRepoFile(`web/src/features/chat/${source}`)).not.toMatch(
        /chat-(session-more|session-item|rename-(form|actions))/,
      );
    }
  });

  it("the single-column shell has no gap class, plain or narrow-prefixed; the chat column keeps gap-2", async () => {
    const { input } = await mountSelectedDone();
    const column = input.closest('[data-slot="chat-column"]');
    const shell = column?.parentElement;
    if (!(column instanceof HTMLElement) || !(shell instanceof HTMLElement)) {
      throw new Error("expected the chat column inside the single-column shell");
    }
    expect(shell.classList.contains("grid-cols-[minmax(0,1fr)]")).toBe(true);
    expect([...shell.classList].filter((token) => /(^|:)-?gap-/.test(token))).toEqual([]);
    expect(column.classList.contains("gap-2")).toBe(true);
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
