import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { cleanupChatLifecycle } from "./chat-page-lifecycle-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { calls, type FetchMock, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// 条目菜单、重命名与置顶（#531）两个测试文件共用的夹具与查询。

export const A = "a".repeat(32);
export const B = "b".repeat(32);
export const C = "c".repeat(32);

export const PINNED_AT = 1_750_000_000_000;
export const RENAMED_TOAST = "已重命名";
export const PINNED_TOAST = "已更新置顶状态";
export const REQUEST_FAILED = "请求失败，请稍后重试";
export const PIN = "置顶任务";
export const UNPIN = "取消置顶";

type SessionStatus = "idle" | "running" | "done" | "failed" | "stopped";

/** 服务端八键会话视图；列表项、快照会话与 PATCH 200 响应体共用这一形状。 */
export function view(
  id: string,
  title: string | null,
  meta: { pinnedAt?: number | null; status?: SessionStatus } = {},
) {
  return {
    ...NULL_SESSION_META,
    id,
    title,
    status: "done" as SessionStatus,
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_600_000,
    ...meta,
  };
}

export type SessionView = ReturnType<typeof view>;

export function patchPath(sessionId: string) {
  return `/api/sessions/${sessionId}`;
}

export function messagesPath(sessionId: string) {
  return `${patchPath(sessionId)}/messages`;
}

export function envelope(status: number, message: string) {
  return jsonResponse({ error: { code: "rejected", message } }, status);
}

/** 列表读取 + 每个会话的就绪快照（快照会话即该视图）；`extra` 追加或覆盖。 */
export function sessionRoutes(sessions: readonly SessionView[], extra: FetchRoutes = {}) {
  const routes: FetchRoutes = { "/api/sessions": () => jsonResponse({ sessions }) };
  for (const session of sessions) {
    routes[messagesPath(session.id)] = () =>
      jsonResponse({ ...chatSnapshot({ assistantStatus: "done", content: "回答" }), session });
  }
  return { ...routes, ...extra };
}

export function mountSessions(
  path: string,
  sessions: readonly SessionView[],
  extra: FetchRoutes = {},
  strict = false,
) {
  return renderChatPage(path, sessionRoutes(sessions, extra), strict);
}

/** 只让外壳断点查询匹配：侧栏改由 `打开导航` 覆盖层承载。 */
export function installNarrowViewport() {
  installMatchMedia((query) => createMediaQuery(query === SHELL_NARROW_QUERY));
}

/** 覆盖层与 Dialog 的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 mock。 */
export async function cleanupSessionMeta() {
  cleanupChatLifecycle();
  uninstallMatchMedia();
  await yieldMacrotask();
  vi.restoreAllMocks();
  window.localStorage.clear();
}

/** 列表区 nav，等到标题为 `title` 的选择按钮出现。 */
export async function findList(title: string) {
  const nav = await screen.findByRole("navigation", { name: "会话列表" });
  await within(nav).findByRole("button", { name: title });
  return nav;
}

/** 选择按钮的标题，按文档顺序（Dialog 打开期间列表被 aria-hidden，故直接读 DOM）。 */
export function entryTitles(scope: Element) {
  return Array.from(scope.querySelectorAll("button.chat-session-button"), (button) =>
    button.getAttribute("aria-label"),
  );
}

/** 名为 `name` 的分区（`role="group"`）；不存在为 null。 */
export function partition(nav: HTMLElement, name: string) {
  return within(nav).queryByRole("group", { hidden: true, name });
}

/** `name` 分区内的条目标题；分区不存在时抛错。 */
export function partitionTitles(nav: HTMLElement, name: string) {
  const group = partition(nav, name);
  if (!group) throw new Error(`未渲染分区 ${name}`);
  return entryTitles(group);
}

export function moreButton(scope: HTMLElement, title: string) {
  return within(scope).getByRole("button", { hidden: true, name: `更多操作：${title}` });
}

/** 左键 pointerdown 打开条目的「更多」菜单（Radix DropdownMenu 不认 click）。 */
export async function openEntryMenu(scope: HTMLElement, title: string) {
  const trigger = moreButton(scope, title);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  return { items: within(menu).getAllByRole("menuitem"), menu, trigger };
}

/** 打开条目菜单并点选 `action`，等菜单关闭；返回该条目的「更多」按钮。 */
export async function chooseEntryAction(scope: HTMLElement, title: string, action: string) {
  const { menu, trigger } = await openEntryMenu(scope, title);
  fireEvent.click(within(menu).getByRole("menuitem", { name: action }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return trigger;
}

export function renameDialog() {
  return screen.queryByRole("dialog", { name: "重命名任务" });
}

async function renameControls() {
  const dialog = await screen.findByRole("dialog", { name: "重命名任务" });
  const input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "任务名称" });
  const form = input.closest("form");
  if (!form) throw new Error("任务名称 输入框不在表单内");
  return {
    cancel: within(dialog).getByRole("button", { name: "取消" }),
    dialog,
    form,
    input,
    save: within(dialog).getByRole<HTMLButtonElement>("button", { name: "保存" }),
  };
}

export type RenameControls = Awaited<ReturnType<typeof renameControls>>;

/** 条目菜单 → `重命名`，等 Dialog 出现；`trigger` 是打开它的「更多」按钮。 */
export async function openRename(scope: HTMLElement, title: string) {
  const trigger = await chooseEntryAction(scope, title, "重命名");
  return { trigger, ...(await renameControls()) };
}

/** 顶栏 `重命名`，等 Dialog 出现；`trigger` 是顶栏按钮。 */
export async function openTopbarRename() {
  const trigger = within(screen.getByRole("banner")).getByRole("button", { name: "重命名" });
  fireEvent.click(trigger);
  return { trigger, ...(await renameControls()) };
}

export function typeTitle({ input }: RenameControls, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

/** 填入 `text` 并点 `保存`。 */
export function saveTitle(controls: RenameControls, text: string) {
  typeTitle(controls, text);
  fireEvent.click(controls.save);
}

/** 发往 `PATCH /api/sessions/<id>` 的请求，按调用顺序。 */
export function patchRequests(fetchMock: FetchMock, sessionId: string) {
  return calls(fetchMock, patchPath(sessionId)).map(([, options]) => ({
    body: options?.body,
    contentType: new Headers(options?.headers).get("Content-Type"),
    method: options?.method,
  }));
}

/** 一次 JSON PATCH 的期望形状。 */
export function patchOf(body: string) {
  return { body, contentType: "application/json", method: "PATCH" };
}

/** 当前显示的 Toast 文案，按出现顺序。 */
export function toasts() {
  return Array.from(document.querySelectorAll(".ui-toast-message"), (node) => node.textContent);
}

/** 顶栏面包屑 heading（Dialog 打开期间 banner 被 aria-hidden）。 */
export function crumb(title: string) {
  return screen.findByRole("heading", { hidden: true, level: 1, name: `我的工作 / ${title}` });
}

export function focusOn(element: Element) {
  return waitFor(() => expect(document.activeElement).toBe(element));
}
