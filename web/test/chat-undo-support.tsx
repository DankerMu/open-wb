// `撤回` 整页测试的夹具（chat-undo.test.tsx 与 chat-undo-notice.test.tsx 共用）：A 的两轮会话、undo 的 200、
// 以 `?session=A&tab=x#frag` 挂载，以及线程、输入框与按钮的查询。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import type {
  ChatMessageSnapshot,
  ChatSession,
  ChatSessionUndo,
} from "../src/lib/session-contract.js";
import { cleanupChatLifecycle } from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import { expectChatLocation, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { calls, type FetchMock, jsonResponse } from "./support.js";

export const UNDO = `/api/sessions/${SESSION_ID}/undo`;
export const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const B_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
export const LIST = "/api/sessions";
export const QUERY = "&tab=x#frag";
export const A_URL = `/?session=${SESSION_ID}${QUERY}`;
export const UNDO_LABEL = "撤回";
export const FORK_LABEL = "从此处分叉";
const CONFLICT_TITLE = "其它会话改动过这个工作空间";
export const CONFLICT_TEXT =
  "这条消息发出之后，共用这个工作空间的其它会话还运行过回合。连文件一起还原会把它们的改动一并冲掉。";
export const UNRESTORED = "已撤回，以下文件未还原";
export const GUIDANCE = "请刷新页面后重试";
export const REASONS = [
  ["too_large", "这一轮开始前工作空间超出快照上限，无法撤回"],
  ["failed", "这一轮开始前的文件快照没有保存成功，无法撤回"],
  ["unbound", "这个会话没有使用工作空间，无法撤回"],
  ["command", "命令消息无法撤回"],
  ["none", "这条消息没有文件快照，无法撤回"],
] as const;

type Snapshot = ChatMessageSnapshot;
type Message = Snapshot["messages"][number];
type UndoState = NonNullable<Message["undo"]>;

export function envelope(code: string, message: string) {
  return { error: { code, message } };
}

export const CONFLICT = () => jsonResponse(envelope("undo_conflict", "别的会话动过"), 409);

export function user(id: number, content: string, undo: UndoState): Message {
  return { ...historyUser, id, undo, content, createdAt: id };
}

export function assistant(
  id: number,
  content: string,
  status: Message["status"] = "done",
): Message {
  return { ...historyUser, id, role: "assistant", undo: null, status, content, createdAt: id };
}

export function session(
  id: string,
  status: ChatSession["status"],
  title: string,
  updatedAt: number,
): ChatSession {
  return { id, title, status, createdAt: 1_740_000_000_000, updatedAt, ...NULL_SESSION_META };
}

export function snapshotOf(s: ChatSession, messages: Message[]): Snapshot {
  return { session: s, messages, streamCursor: { epoch: 1, seq: 0 }, todo: null };
}

/** S：A 的 done 会话，两轮问答，两条用户消息都可撤回。 */
export const S = snapshotOf(session(SESSION_ID, "done", "saved title", 1_740_000_000_023), [
  user(1, "第一个问题", "available"),
  assistant(2, "一"),
  user(3, "第二个问题", "available"),
  assistant(4, "二"),
]);
/** 撤回 u3 之后服务端的会话与快照（`updatedAt` 落在今天）。 */
export const REWOUND_SESSION = { ...S.session, updatedAt: Date.now() };
const REWOUND = snapshotOf(REWOUND_SESSION, S.messages.slice(0, 2));
const B = snapshotOf(session(OTHER_SESSION_ID, "done", "other session", 1_740_000_000_010), [
  user(21, "B 问", "available"),
  assistant(22, "B 回答"),
]);
export const FULL = ["第一个问题", "一", "第二个问题", "二"];
export const TRIMMED = ["第一个问题", "一"];

const NO_PATHS = { count: 0, paths: [] };

/** 撤回提交之后 A 的消息读取的回复；null 时回挂载时的快照。每例复位。 */
let afterUndo: (() => Response) | null = null;

/** undo 的 200。服务端此时已提交：此后 A 的消息读取回 `after`（默认是撤回 u3 之后的快照）。 */
export function undone(
  after: () => Response = () => jsonResponse(REWOUND),
  draft = "第二个问题",
  files: Partial<ChatSessionUndo["files"]> = {},
) {
  afterUndo = after;
  return jsonResponse({
    session: REWOUND_SESSION,
    draft,
    files: {
      mode: "restored",
      restored: 1,
      removed: 0,
      skipped: NO_PATHS,
      failed: NO_PATHS,
      ...files,
    },
    attachments: [],
  } satisfies ChatSessionUndo);
}

export async function flush() {
  for (const _ of [1, 2, 3]) {
    await act(settle);
  }
}

/** 以 `?session=A&tab=x#frag` 挂载并 open。A 的消息读取回 `initial`，undo 200 之后回 `afterUndo`。 */
export async function mount(initial: Snapshot, routes: FetchRoutes = {}, withB = false) {
  const mounted = renderChatPage(A_URL, {
    [LIST]: () =>
      jsonResponse({ sessions: withB ? [initial.session, B.session] : [initial.session] }),
    [MESSAGES]: () => (afterUndo ? afterUndo() : jsonResponse(initial)),
    [B_MESSAGES]: () => jsonResponse(B),
    ...routes,
  });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = latestSource();
  act(() => source.emitOpen());
  await flush();
  if (initial.session.archivedAt === null) {
    await waitFor(() => expect(textarea().disabled).toBe(initial.session.status === "running"));
  }
  return { fetchMock: mounted.fetchMock, router: mounted.router, source };
}

export function listGets(fetchMock: FetchMock) {
  return calls(fetchMock, LIST).filter(([, init]) => init?.method !== "POST").length;
}

export function undoBodies(fetchMock: FetchMock) {
  return calls(fetchMock, UNDO).map(([, init]) => {
    expect(init?.method).toBe("POST");
    return init?.body;
  });
}

export function buttons(label: string, scope: HTMLElement = document.body) {
  return within(scope).queryAllByRole("button", { name: label }) as HTMLButtonElement[];
}

export function undoButton(scope: HTMLElement) {
  const [button, ...rest] = buttons(UNDO_LABEL, scope);
  expect(rest).toHaveLength(0);
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

/** `aria-describedby` 所指元素的文本（仓库没有 jest-dom）。 */
export function description(element: HTMLElement) {
  const id = element.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

export function bar() {
  const element = document.querySelector<HTMLElement>('form [data-slot="composer-toolbar"]');
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}

/** 页面内容的查询都带 `hidden`：冲突对话框开着时页面其余部分是 `aria-hidden`。 */
export function textarea() {
  return screen.getByRole("textbox", {
    name: "给助手发消息",
    hidden: true,
  }) as HTMLTextAreaElement;
}

export function typeDraft(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

export function userArticles() {
  return screen.queryAllByRole("article", { name: "用户", hidden: true }) as HTMLElement[];
}

export function alerts() {
  return screen.queryAllByRole("alert", { hidden: true }).map((alert) => alert.textContent);
}

export function transcript() {
  const region = screen.queryByRole("region", { name: "消息", hidden: true });
  if (!region) {
    return [];
  }
  return within(region)
    .queryAllByRole("article", { hidden: true })
    .map((article) => article.querySelector('[data-slot="message-body"]')?.textContent ?? "");
}

export function nav() {
  return screen.getByRole("navigation", { name: "会话列表" });
}

export async function selectInNav(title: string, sessionId: string) {
  fireEvent.click(within(nav()).getByRole("button", { name: title }));
  await expectChatLocation(`/?session=${sessionId}${QUERY}`);
  await flush();
}

/** 第二条用户消息（u3）的 `撤回`。 */
export function secondUndo() {
  return undoButton((userArticles() as [HTMLElement, HTMLElement])[1]);
}

export async function clickUndo(button: HTMLButtonElement = secondUndo()) {
  fireEvent.click(button);
  await flush();
}

export function conflictDialog() {
  return screen.queryByRole("alertdialog", { name: CONFLICT_TITLE });
}

export function expectNoDialog() {
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
}

/** 没有轻提示，也没有未还原文件说明。 */
export function expectNoNotice() {
  expect(document.querySelector(".ui-toast")).toBeNull();
  expect(screen.queryByText(UNRESTORED)).toBeNull();
}

/** 200 之后的页面：线程回到 u1/a2，草稿是原文，焦点在输入框，没有请求之外的提示。 */
export function expectRewound() {
  expect(transcript()).toEqual(TRIMMED);
  expect(textarea().value).toBe("第二个问题");
  expect(textarea().disabled).toBe(false);
  expect(document.activeElement).toBe(textarea());
  expect(alerts()).toEqual([]);
  expectNoDialog();
  expectNoNotice();
}

/** 每例之后：撤回后的读取回复复位，卸载页面并还原 mock。 */
export function cleanupUndoPage() {
  afterUndo = null;
  window.localStorage.clear();
  cleanupChatLifecycle();
  vi.restoreAllMocks();
}
