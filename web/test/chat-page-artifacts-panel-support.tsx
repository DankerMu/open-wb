// 产物面板（issue 537；issue 860 起由拷入层 sheet 渲染，下文仍称它「抽屉」）测试的夹具与页面查询：
// 两轮助手消息的快照、顶栏按钮与抽屉的读取、抽屉内的行、按钮、空态与就地提示、经路由切换会话、
// 带续期探针的外壳挂载、会话列表动作的 Toast（本页仅剩的 Toast 来源）。页面搭法来自 chat-page-file-changes-support.tsx 与
// chat-page-artifact-card-support.tsx（不改它们）。供 chat-page-artifacts-panel*.test.tsx 使用。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createBrowserRouter, RouterProvider } from "react-router";
import { afterEach, expect, vi } from "vitest";
import { AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { ChatPage } from "../src/features/chat/index.js";
import { AppShell } from "../src/routes/shell/app-shell.js";
import { ToastProvider } from "../src/ui/index.js";
import { artifactCardFixture } from "./chat-page-artifact-card-support.js";
import {
  assistantMessage,
  listed,
  type Message,
  quiesce,
  type Snapshot,
  turn,
  WORKSPACES,
} from "./chat-page-file-changes-support.js";
import type { ChatAuthProbe } from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { expectChatLocation } from "./chat-page-support.js";
import {
  FakeEventSource,
  historyUser,
  resetFakeEventSources,
  SESSION_ID,
} from "./chat-stream-support.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  jsonResponse,
  setBrowserPath,
} from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const PANEL = "产物面板";
export const NO_ARTIFACTS = "当前任务暂无产物";
export const SESSION_PATH = `/?session=${SESSION_ID}`;
const ACTION = /^(打开网页预览|下载|复制代码) /;

let disposeProbedShell: (() => void) | undefined;

/**
 * Registers the hooks of every 产物面板 case and returns the Blob URL stubs of the current case
 * (see `artifactCardFixture`). The drawer's focus scope hands focus back in a timer, so each case
 * lets one macrotask pass before the next one starts; a probed shell's router is disposed.
 */
export function artifactsPanelFixture() {
  const blobs = artifactCardFixture();
  afterEach(async () => {
    await yieldMacrotask();
    disposeProbedShell?.();
    disposeProbedShell = undefined;
  });
  return blobs;
}

type Steps = Message["steps"];

/**
 * `turn("done")` followed by a second question (id 1) and a second assistant message (id 2): the
 * first assistant message holds `first`, the second holds `second`.
 */
export function twoTurns(first: Steps, second: Steps): Snapshot {
  const base = turn("done", { content: "第一轮", steps: first });
  const again: Message = { ...historyUser, id: 1, content: "再改一下", createdAt: 1 };
  const answer = assistantMessage("done", {
    id: 2,
    content: "第二轮",
    createdAt: 2,
    steps: second,
  });
  return { ...base, messages: [...base.messages, again, answer] };
}

/** The banner; an open drawer or preview hides it from the accessibility tree. */
function banner() {
  return screen.getByRole("banner", { hidden: true });
}

/** `aria-label` of every button in the banner, in document order. */
export function bannerButtons() {
  return within(banner())
    .getAllByRole("button", { hidden: true })
    .map((button) => button.getAttribute("aria-label"));
}

export function panelButton() {
  return within(banner()).getByRole<HTMLButtonElement>("button", { name: PANEL, hidden: true });
}

/**
 * The 产物面板 drawer, null when it is closed. A preview dialog above it puts `aria-hidden` on the
 * drawer element itself, which empties its computed accessible name even for `hidden: true`
 * queries, so the drawer is recognised by the text of the title it is labelled by.
 */
export function drawer() {
  const labelled = screen.queryAllByRole("dialog", { hidden: true }).filter((dialog) => {
    const title = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    return title?.textContent === PANEL;
  });
  return labelled[0] ?? null;
}

/** Clicks the banner button without focusing it first and waits for the drawer. */
export async function openPanel() {
  const trigger = panelButton();
  fireEvent.click(trigger);
  const panel = await screen.findByRole("dialog", { name: PANEL });
  return { panel, trigger };
}

/** Waits until the drawer is gone and focus is back on the banner's 产物面板 button. */
export async function expectPanelClosed() {
  await waitFor(() => expect(drawer()).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(panelButton()));
}

/** The rows of the drawer's list, in document order. */
export function panelRows(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>('[data-slot="file-change-row"]')];
}

/** The text of the drawer's body: what it shows between its title and its foot. */
export function panelBody(panel: HTMLElement) {
  return panel.querySelector('[data-slot="artifacts-panel-body"]')?.textContent;
}

/** Per row, the text of each `role="alert"` line inside it. */
export function rowAlerts(panel: HTMLElement) {
  return panelRows(panel).map((row) =>
    within(row)
      .queryAllByRole("alert", { hidden: true })
      .map((alert) => alert.textContent),
  );
}

/** Per row, the `aria-label` of each button in document order. */
export function rowButtons(panel: HTMLElement) {
  return panelRows(panel).map((row) =>
    [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
  );
}

/** The one button named `name` inside the drawer (the transcript's cards carry the same names). */
export function panelAction(panel: HTMLElement, name: string) {
  return within(panel).getByRole<HTMLButtonElement>("button", { name, hidden: true });
}

/** Every artifact action button (打开网页预览/下载/复制代码) inside the drawer. */
export function panelActions(panel: HTMLElement) {
  return within(panel).queryAllByRole("button", { name: ACTION, hidden: true });
}

/** The two 关闭 buttons of the drawer: the icon button at its top right, then the foot button. */
function closeButtons(panel: HTMLElement) {
  const buttons = within(panel).getAllByRole("button", { name: "关闭" });
  const foot = buttons.filter((button) => button.closest('[data-slot="sheet-footer"]') !== null);
  const head = buttons.filter((button) => !foot.includes(button));
  if (foot.length !== 1 || head.length !== 1) throw new Error("抽屉应恰有头部与脚部两个 关闭");
  return { foot: foot[0] as HTMLElement, head: head[0] as HTMLElement };
}

export function footClose(panel: HTMLElement) {
  return closeButtons(panel).foot;
}

export function headClose(panel: HTMLElement) {
  return closeButtons(panel).head;
}

type Router = { navigate(to: string): Promise<void> };

/**
 * Selects the neighbour session through the router (the sidebar is unreachable under the modal
 * drawer; the real path is the browser's back/forward) and waits for its transcript.
 */
export async function routeToOtherSession(router: Router) {
  await act(() => router.navigate(`/?session=${OTHER_SESSION_ID}`));
  await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
  expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
  await quiesce();
}

/** Routes back to SESSION_ID and waits until its history was read again. */
export async function routeBack(router: Router) {
  await act(() => router.navigate(SESSION_PATH));
  await expectChatLocation(SESSION_PATH);
  await screen.findAllByRole("article", { name: "助手" });
  await quiesce();
}

let auth: ChatAuthProbe | undefined;

function AuthProbe() {
  const { login, principal, status } = useAuth();
  auth = { login, principal, status };
  return null;
}

/**
 * Opens `snapshot`'s session inside the real shell with an auth probe beside it, for `renewAccount`:
 * `renderChatPageWithAuthProbe` mounts the page bare, so it has no banner and no 产物面板 button.
 * Logging in again answers as `lisi`; both accounts read the same session, snapshot and workspaces.
 */
export async function openProbedSession(snapshot: Snapshot) {
  auth = undefined;
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    createFetchMock({
      "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
      "/api/auth/login": () => jsonResponse({ id: "user-2", account: "lisi", role: "member" }),
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [WORKSPACES]: listed,
      [SESSION_MESSAGES]: () => jsonResponse(snapshot),
    }),
  );
  setBrowserPath(SESSION_PATH);
  const shell = (
    <AuthProvider>
      <AuthProbe />
      <AuthGuard>
        <AppShell />
      </AuthGuard>
    </AuthProvider>
  );
  const router = createBrowserRouter([
    { element: shell, children: [{ path: "/", element: <ChatPage /> }] },
  ]);
  disposeProbedShell = () => router.dispose();
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  await screen.findAllByRole("article", { name: "助手" });
  await quiesce();
  return () => {
    if (!auth) throw new Error("认证探针尚未渲染");
    return auth;
  };
}
