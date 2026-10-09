// 用户气泡里的附件列表（message-attachments「用户气泡中的附件」、chat-web「消息线程」的「只有附件的用户消息」）：
// 受理后重读到的快照与刷新后首次读到的快照呈现一致，没有附件不渲染，只有附件的消息没有文本块。seam：整页挂载 +
// 假 API + `FakeXhr`；「刷新」是卸掉页面后重新挂载。期望的文件名与大小串取自规格条文。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { typeDraft } from "./chat-page-lifecycle-support.js";
import { promptAccepted } from "./chat-page-ownership-support.js";
import { count, toggleSearch, typeQuery } from "./chat-page-search-support.js";
import { cleanupSessionMeta, view } from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue, commandsOf } from "./chat-page-slash-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { PROJECT_A, workspaceList } from "./chat-page-welcome-scene-support.js";
import { historyUser } from "./chat-stream-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import { calls, composerOptionsRoute, jsonResponse } from "./support.js";
import { FakeXhr, installFakeXhr } from "./upload-support.js";

const W = PROJECT_A.id;
const S = view("a".repeat(32), "绑定会话", { workspaceId: W });
const MESSAGES = `/api/sessions/${S.id}/messages`;
const PROMPT = `/api/sessions/${S.id}/prompt`;
const SUFFIX = "用户随本条消息上传了以下文件";

type Attachment = { path: string; size: number };

const A_PDF: Attachment = { path: "uploads/a.pdf", size: 10 };
const NESTED_PNG: Attachment = { path: "uploads/子目录/图 (1).png", size: 2048 };

afterEach(cleanupSessionMeta);

/** 一个回合的快照：用户消息（`content`、`attachments`、可撤回）与一条已完成的回答 `好的`。 */
function turn(content: string, attachments: Attachment[]) {
  const answer = {
    ...historyUser,
    id: 0,
    role: "assistant",
    undo: null,
    content: "好的",
    createdAt: 0,
  };
  const messages = [{ ...historyUser, undo: "available", content, attachments }, answer];
  return { session: S, messages, streamCursor: { epoch: 1, seq: 0 }, todo: null };
}

/** 打开会话：第一次历史读取带回 `first`（缺省为空历史），之后的都带回 `later`。 */
async function open(later: unknown, first: unknown = { ...turn("", []), messages: [] }) {
  let reads = 0;
  const page = renderChatPage(`/?session=${S.id}`, {
    "/api/workspaces": () => workspaceList(PROJECT_A),
    ...composerOptionsRoute(DEFAULT_COMPOSER_OPTIONS),
    "/api/sessions": () => jsonResponse({ sessions: [S] }),
    [MESSAGES]: () => {
      reads += 1;
      return jsonResponse(reads === 1 ? first : later);
    },
    [commandsOf(W)]: catalogue(),
    [COMMANDS]: catalogue(),
    [PROMPT]: () => jsonResponse(promptAccepted, 202),
  });
  await screen.findByRole("textbox", { name: "给助手发消息" });
  await quiesce();
  installFakeXhr();
  return page;
}

/** 「刷新」：卸掉页面重新挂载，首次历史读取即带回 `snapshot`。 */
async function reload(snapshot: unknown) {
  cleanupChatPage();
  await open(snapshot, snapshot);
}

/** 经文件框选入 `attachments` 并逐个传完（上传响应的路径即 `path`），草稿设为 `draft` 后点 `发送`。 */
async function send(draft: string, attachments: Attachment[]) {
  const input = document.querySelector('[data-slot="composer-file-input"]') as HTMLInputElement;
  const names = attachments.map(({ path }) => path.slice(path.lastIndexOf("/") + 1));
  const files = attachments.map(
    ({ size }, at) => new File([new Uint8Array(size)], String(names[at])),
  );
  fireEvent.change(input, { target: { files } });
  await quiesce();
  for (const [at, { path, size }] of attachments.entries()) {
    const body = JSON.stringify({ path, name: names[at], size });
    act(() => FakeXhr.instances[at]?.respond(201, body));
    await quiesce();
  }
  typeDraft(draft);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(screen.getAllByRole("article", { name: "用户" })).toHaveLength(1));
  await quiesce();
}

function userBubble() {
  return screen.getByRole("article", { name: "用户" });
}

function body(article: HTMLElement) {
  return article.querySelector('[data-slot="message-body"]');
}

function attachmentList(article: HTMLElement) {
  return within(article).queryByRole("list", { name: "附件" });
}

/** 气泡里附件列表各项的全部文字：文件名紧跟大小。 */
function listed(article: HTMLElement) {
  const list = attachmentList(article);
  if (!list) throw new Error("气泡里没有附件列表");
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

/** 只有附件的气泡：根元素与操作行照旧，除列表项 `item` 外没有任何文字，也没有文本块。 */
function expectAttachmentOnly(item: string) {
  const article = userBubble();
  expect(article.getAttribute("data-message-id")).toBe(String(historyUser.id));
  expect(listed(article)).toEqual([item]);
  expect(body(article)).toBeNull();
  expect(article.querySelector("p")).toBeNull();
  expect(article.textContent).toBe(item);
  const buttons = within(article).getAllByRole<HTMLButtonElement>("button");
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "撤回",
    "从此处分叉",
  ]);
  expect(buttons.map((button) => button.disabled)).toEqual([false, false]);
  expect(buttons.map((button) => button.getAttribute("aria-disabled"))).toEqual([null, null]);
}

/** 对话内搜索只看 `content`：输入文件名没有匹配。 */
function expectFileNameUnmatched() {
  toggleSearch();
  typeQuery("a.pdf");
  expect(count()).toBe("0/0");
  expect(userBubble().getAttribute("aria-current")).toBeNull();
}

describe("受理后与刷新后一致", () => {
  function expectBubble() {
    const article = userBubble();
    expect(body(article)?.textContent).toBe("看看");
    expect(article.textContent).not.toContain(SUFFIX);
    expect(listed(article)).toEqual(["a.pdf10 B", "图 (1).png2.0 KB"]);
    const list = attachmentList(article) as HTMLElement;
    expect(within(list).queryAllByRole("link")).toEqual([]);
    expect(within(list).queryAllByRole("button")).toEqual([]);
    expect(list.querySelector("a, button, [title]")).toBeNull();
    // 文本在上，列表在下，操作行在最后。
    expect(Array.from(article.children, (child) => child.getAttribute("data-slot"))).toEqual([
      "message-body",
      "message-attachments",
      "message-actions",
    ]);
  }

  it("带两个附件发送 `看看`：气泡文本下方按次序列出文件名与大小，没有链接与按钮；刷新后一样", async () => {
    const snapshot = turn("看看", [A_PDF, NESTED_PNG]);
    const { fetchMock } = await open(snapshot);
    await send("看看", [A_PDF, NESTED_PNG]);
    expect(
      calls(fetchMock, PROMPT).map(([, options]) => JSON.parse(String(options?.body))),
    ).toEqual([{ message: "看看", attachments: [A_PDF.path, NESTED_PNG.path] }]);
    const requests = fetchMock.mock.calls.length;
    expectBubble();
    // 点文件名没有反应：不发请求。
    fireEvent.click(within(userBubble()).getByText("a.pdf"));
    await quiesce();
    expect(fetchMock.mock.calls).toHaveLength(requests);

    await reload(snapshot);
    expectBubble();
  });
});

describe("无附件不渲染", () => {
  it("不带附件的用户消息与助手消息里都没有名为 `附件` 的列表", async () => {
    const snapshot = turn("看看", []);
    await open(snapshot, snapshot);
    const user = userBubble();
    const assistant = screen.getByRole("article", { name: "助手" });
    expect(body(user)?.textContent).toBe("看看");
    expect(attachmentList(user)).toBeNull();
    expect(attachmentList(assistant)).toBeNull();
    expect(document.querySelector('[data-slot="message-attachments"]')).toBeNull();
    expect(screen.queryByRole("list", { name: "附件" })).toBeNull();
  });
});

describe("只有附件的气泡", () => {
  it("两个空格的草稿带一个附件发送：受理后气泡里只有附件列表，操作行照常，搜索文件名不匹配", async () => {
    const { fetchMock } = await open(turn("", [A_PDF]));
    await send("  ", [A_PDF]);
    expect(calls(fetchMock, PROMPT).map(([, options]) => options?.body)).toEqual([
      '{"message":"  ","attachments":["uploads/a.pdf"]}',
    ]);
    expectAttachmentOnly("a.pdf10 B");
    expectFileNameUnmatched();
  });

  it("刷新后（快照里 `content` 为空串）同样只有附件列表，操作行照常，搜索文件名不匹配", async () => {
    await open(turn("", [A_PDF]));
    await send("  ", [A_PDF]);
    await reload(turn("", [A_PDF]));
    expectAttachmentOnly("a.pdf10 B");
    expectFileNameUnmatched();
  });
});

describe("只有附件的用户消息（chat-web「消息线程」）", () => {
  it("`done` 会话的第一条用户消息 `content` 为空串、带一个 3 字节的附件：只有列表，`撤回` 在 `从此处分叉` 之前且都可用", async () => {
    const snapshot = turn("", [{ path: "uploads/a.pdf", size: 3 }]);
    await open(snapshot, snapshot);
    expect(
      screen.getAllByRole("article").map((article) => article.getAttribute("aria-label")),
    ).toEqual(["用户", "助手"]);
    expectAttachmentOnly("a.pdf3 B");
  });
});
