import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { renderChatPageWithAuthProbe, renewAccount } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  C,
  chooseEntryAction,
  entryTitles,
  FIRST_ACCOUNT_TASK,
  findList,
  focusOn,
  messagesPath,
  mountSessions,
  patchPath,
  SECOND_ACCOUNT_TASK,
  type SessionView,
  toasts,
  view,
} from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { CLOSED, chatSnapshot, FakeEventSource } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia } from "./media-query-support.js";
import { currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// 条目菜单删除（#532）测试的夹具与查询。`DELETE` 与 `PATCH` 同路径（`patchPath`），请求形状用
// meta-support 的 `patchRequests` 读取，方法从 `method` 断言。

export const CURRENT = "季度复盘";
export const OTHER = "需求评审";
export const THIRD = "周报整理";
export const SESSION_A = `/?session=${A}`;
export const SESSION_B = `/?session=${B}`;
export const DELETED_TOAST = "任务已删除";
export const BUSY_MESSAGE = "会话正在生成，请稍候";
export const HERO = "WorkBuddy，我帮你";
const CONFIRM_TITLE = "删除任务";
const PENDING_HINT = "删除请求已发送，关闭窗口不会撤销请求。";

/** 一次 DELETE 的期望形状：无 body、无 `Content-Type`。 */
export const DELETE_REQUEST = { body: undefined, contentType: null, method: "DELETE" };

/** 服务端顺序 A、B、C，都在 `临时空间` 分组。 */
export const SESSIONS = [view(A, CURRENT), view(B, OTHER), view(C, THIRD)];

export function noContent() {
  return new Response(null, { status: 204 });
}

/** 409 `session_busy` 信封（`server/src/core/errors/index.ts`）。 */
export function sessionBusy() {
  return jsonResponse({ error: { code: "session_busy", message: BUSY_MESSAGE } }, 409);
}

/** 会话 `session` 的就绪快照路由，助手回答为 `content`（用来辨认主区显示的是哪个会话）。 */
export function snapshotRoute(session: SessionView, content: string) {
  return () => jsonResponse({ ...chatSnapshot({ assistantStatus: "done", content }), session });
}

export function confirmBox() {
  return screen.queryByRole("alertdialog", { name: CONFIRM_TITLE });
}

export function confirmGone() {
  return waitFor(() => expect(confirmBox()).toBeNull());
}

/** 确认框的说明文本（`aria-describedby` 指向的元素）。 */
export function confirmDescription(dialog: HTMLElement) {
  return document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent;
}

async function confirmControls() {
  const dialog = await screen.findByRole("alertdialog", { name: CONFIRM_TITLE });
  const buttons = within(dialog).getAllByRole<HTMLButtonElement>("button");
  const [cancel] = buttons;
  if (!cancel) throw new Error("确认框没有按钮");
  return {
    buttons,
    cancel,
    confirm: within(dialog).getByRole<HTMLButtonElement>("button", { name: "删除" }),
    dialog,
  };
}

export type ConfirmControls = Awaited<ReturnType<typeof confirmControls>>;

/** 条目菜单 → `删除`，等确认框出现；`trigger` 是打开它的「更多」按钮。 */
export async function openDelete(scope: HTMLElement, title: string) {
  const trigger = await chooseEntryAction(scope, title, "删除");
  return { trigger, ...(await confirmControls()) };
}

/** 条目菜单 → `删除` → 确认，等确认框消失。 */
export async function deleteEntry(scope: HTMLElement, title: string) {
  const controls = await openDelete(scope, title);
  fireEvent.click(controls.confirm);
  await confirmGone();
  return controls;
}

/**
 * 条目菜单 → `删除` → 确认，DELETE 挂起（确认框处于忙碌态）。`close` 为真时随即点 `关闭`，等确认框
 * 消失、焦点回到该条目的「更多」按钮。
 */
export async function confirmPending(scope: HTMLElement, title: string, close: boolean) {
  const controls = await openDelete(scope, title);
  fireEvent.click(controls.confirm);
  expectConfirmBusy(controls);
  if (close) {
    fireEvent.click(controls.cancel);
    await confirmGone();
    await focusOn(controls.trigger);
  }
  return controls;
}

/** 关闭打开着的条目菜单。 */
export async function closeMenu(menu: HTMLElement) {
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** 未发请求的确认框：`取消` + 可用的 danger `删除`，无提示行。 */
export function expectConfirmIdle({ buttons, cancel, confirm, dialog }: ConfirmControls) {
  expect(buttons.map((button) => button.textContent)).toEqual(["取消", "删除"]);
  expect(cancel.disabled).toBe(false);
  expect(confirm.classList.contains("ui-btn--danger")).toBe(true);
  expect(confirm.disabled).toBe(false);
  expect(confirm.getAttribute("aria-busy")).toBeNull();
  expect(within(dialog).queryByText(/删除请求已发送/)).toBeNull();
}

/** 请求在途的确认框：`删除` 忙碌禁用，取消按钮文案为 `关闭` 且可用，提示行可见。 */
export function expectConfirmBusy({ buttons, cancel, confirm, dialog }: ConfirmControls) {
  expect(buttons.map((button) => button.textContent)).toEqual(["关闭", "删除"]);
  expect(cancel.disabled).toBe(false);
  expect(confirm.disabled).toBe(true);
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(within(dialog).getByText(PENDING_HINT).tagName).toBe("P");
}

/** 当前显示的 Toast，按出现顺序：`[文案, 含该文案的 .ui-toast 元素上的类型修饰类]`。 */
export function toastTypes() {
  return Array.from(document.querySelectorAll(".ui-toast-message"), (message) => [
    message.textContent,
    Array.from(message.closest(".ui-toast")?.classList ?? []).filter((name) =>
      name.startsWith("ui-toast--"),
    ),
  ]);
}

/**
 * 外壳断点查询交给返回的 `FakeMediaQuery`（初值 `narrow`；`emit` 让视口在用例中途跨越 760px），
 * 其它查询恒不匹配。
 */
export function installShellViewport(narrow: boolean) {
  const shell = createMediaQuery(narrow);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? shell : createMediaQuery(false)));
  return shell;
}

/** `sessionId` 最近一次打开的事件流连接。 */
export function stream(sessionId: string) {
  const url = `${patchPath(sessionId)}/events`;
  const source = FakeEventSource.instances.filter((candidate) => candidate.url === url).at(-1);
  if (!source) throw new Error(`没有为 ${sessionId} 打开事件流`);
  return source;
}

export async function findStream(sessionId: string) {
  await waitFor(() => stream(sessionId));
  return stream(sessionId);
}

export function expectStreamOpen(source: FakeEventSource) {
  expect(source.readyState).not.toBe(CLOSED);
  expect(source.closeCount).toBe(0);
}

/** 记录 `source.close()` 每次被调用那一刻的 location（关闭是否先于导航）。 */
function closeLocations(source: FakeEventSource) {
  const seen: string[] = [];
  const close = source.close.bind(source);
  source.close = () => {
    seen.push(currentLocation());
    close();
  };
  return seen;
}

export async function expectWelcome() {
  expect(await screen.findByRole("heading", { level: 1, name: HERO })).toBeTruthy();
}

/** 记下当前会话页面收尾要对照的量：事件流、它被关闭时的 location、history 深度、此刻的 URL。 */
export function watchCurrent(source: FakeEventSource) {
  return {
    closedAt: closeLocations(source),
    depth: window.history.length,
    from: currentLocation(),
    source,
  };
}

/**
 * 当前会话被删后的页面收尾：以 replace 到 `to`（history 深度不变，不是 push）；事件流在 URL 仍指向
 * 该会话时关闭且只关一次（关闭先于导航）；欢迎态，无错误提示。
 */
export async function expectReturnedToWelcome(
  { closedAt, depth, from, source }: ReturnType<typeof watchCurrent>,
  to = "/",
) {
  await waitFor(() => expect(currentLocation()).toBe(to));
  expect(window.history.length).toBe(depth);
  expect(closedAt).toEqual([from]);
  expect(source.readyState).toBe(CLOSED);
  await expectWelcome();
  await yieldMacrotask();
  expect(screen.queryByRole("alert")).toBeNull();
}

/** `SESSIONS` 里的 A 已移除（其余次序不变），Toast 恰为 `shown`。 */
export function expectRemoved(nav: HTMLElement, shown = [DELETED_TOAST]) {
  expect(entryTitles(nav)).toEqual([OTHER, THIRD]);
  expect(toasts()).toEqual(shown);
}

/** 点选列表里的 `title` 会话，等 URL 与它的事件流就绪。 */
export async function selectEntry(nav: HTMLElement, title: string, sessionId: string) {
  fireEvent.click(within(nav).getByRole("button", { name: title }));
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${sessionId}`));
  return findStream(sessionId);
}

/**
 * 在 `path` 挂载 `SESSIONS`，确认删除 A 而 DELETE 挂起（`confirmPending`；`close` 同它）。`extra`
 * 追加或覆盖路由。
 */
export async function pendingDelete(
  path: string,
  { close = false, extra = {} }: { close?: boolean; extra?: FetchRoutes } = {},
) {
  const request = deferredResponse();
  const mounted = mountSessions(path, SESSIONS, {
    [patchPath(A)]: () => request.promise,
    ...extra,
  });
  const nav = await findList(CURRENT);
  const requested = new URLSearchParams(path.split("?")[1]).get("session");
  if (requested) await findStream(requested);
  const controls = await confirmPending(nav, CURRENT, close);
  return { ...mounted, controls, nav, request };
}

/**
 * 裸挂会话页（带续期探针）于 `/?session=<A>`：两个账号各有一条 id 同为 A 的会话，A 是当前会话
 * （meta-support 的 `mountTwoAccounts` 挂在 `/`，没有当前会话时观察不到「不导航」）。`remove` 是
 * `DELETE /api/sessions/<A>` 的路由；`renew()` 续期为第二个账号，返回它的列表区与它为 A 新开的
 * 事件流。
 */
export async function mountTwoAccountsOnCurrent(remove: FetchRoutes[string]) {
  const account = { task: FIRST_ACCOUNT_TASK };
  const owned = () => view(A, account.task);
  const { fetchMock, getProbe } = renderChatPageWithAuthProbe(SESSION_A, {
    "/api/sessions": () => jsonResponse({ sessions: [owned()] }),
    [messagesPath(A)]: () => snapshotRoute(owned(), `${account.task}的回答`)(),
    [patchPath(A)]: remove,
  });
  const nav = await findList(FIRST_ACCOUNT_TASK);
  const first = await findStream(A);
  await screen.findByText(`${FIRST_ACCOUNT_TASK}的回答`);
  return {
    fetchMock,
    nav,
    async renew() {
      account.task = SECOND_ACCOUNT_TASK;
      await renewAccount(getProbe);
      const list = await findList(SECOND_ACCOUNT_TASK);
      await screen.findByText(`${SECOND_ACCOUNT_TASK}的回答`);
      await waitFor(() => expect(stream(A)).not.toBe(first));
      return { list, source: stream(A) };
    },
  };
}
