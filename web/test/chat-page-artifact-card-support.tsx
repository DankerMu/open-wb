// 产物卡（issue 536）测试的夹具与页面查询：预览路由、迟到与 abort 的响应、jsdom 缺的下载/剪贴板接缝、
// 卡片与 Toast 的读取、切换会话。页面搭法来自 chat-page-file-changes-support.tsx（不改它）。
// 只供 chat-page-artifact-card.test.tsx 使用。
import { fireEvent, screen, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import {
  type Change,
  listed,
  openSession,
  PROJ,
  quiesce,
  type Snapshot,
  toolStep,
  turn,
  WORKSPACES,
} from "./chat-page-file-changes-support.js";
import {
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherIdleSession,
  otherSnapshot,
} from "./chat-page-ownership-support.js";
import { expectChatLocation, type FetchRoutes } from "./chat-page-support.js";
import { observeUnhandledRejections, settle } from "./chat-stream-support.js";
import { type FetchMock, jsonResponse, textPreviewResponse } from "./support.js";

export const HTML_TEXT = "<h1>hi</h1><script>document.title='x'</script>";
export const CODE_TEXT = "export const answer = 42;\n";
export const BLOB_URL = "blob:artifact-first";
export const REQUEST_FAILED = "请求失败，请稍后重试";
export const OPEN_INDEX = "打开网页预览 index.html";
export const COPY_APP = "复制代码 app.ts";
export const DOWNLOAD_CHART = "下载 chart.PNG";
export const TRUNCATION_NOTE = "文件超过 1 MiB，仅预览前 1 MiB";

/** Route key of the preview request for `path` (workspace-relative) in PROJ. */
export const previewRoute = (path: string) =>
  `${WORKSPACES}/${PROJ.id}/file?path=${encodeURIComponent(path)}`;

/** A done turn bound to `workspaceId` whose single ended step changed `changes`. */
export function changedTurn(changes: Change[], workspaceId: string | null = PROJ.id): Snapshot {
  return turn(
    "done",
    { content: "改好了", steps: [toolStep(11, 0, "edit", changes)] },
    workspaceId,
  );
}

/**
 * Opens the page on `changedTurn(changes)` with the workspace list installed. `route` answers the
 * preview of every changed path; `more` adds routes that depend on the snapshot.
 */
export function openPreviewing(
  changes: Change[],
  route: FetchRoutes[string],
  more: (snapshot: Snapshot) => FetchRoutes = () => ({}),
) {
  const snapshot = changedTurn(changes);
  const previews = changes.map((change) => [previewRoute(change.path), route]);
  return openSession(snapshot, listed, { ...more(snapshot), ...Object.fromEntries(previews) });
}

/** Every preview (`…/file?path=`) request so far, in call order. */
export function previewCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([path]) => path.includes("/file?"));
}

/** The abort signal the page handed to its `at`-th preview request. */
export function previewSignal(fetchMock: FetchMock, at = 0) {
  const signal = previewCalls(fetchMock)[at]?.[1]?.signal;
  if (!signal) throw new Error(`第 ${at + 1} 个预览请求没有 signal`);
  return signal;
}

/** A text preview the server cut at its 1 MiB limit. */
export function truncatedPreview(text: string) {
  const response = textPreviewResponse(text);
  response.headers.set("X-Workbuddy-Truncated", "1");
  return response;
}

/** A preview route that settles the way the real `fetch` does: it rejects once its signal aborts. */
export const rejectOnAbort: FetchRoutes[string] = (_path, options) =>
  new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });

/** Every artifact card on the page, in document order. */
export function artifactCards() {
  return [...document.querySelectorAll<HTMLElement>(".artifact-card")];
}

/**
 * Buttons named `name` inside the assistant message, in document order. An open preview dialog
 * hides the rest of the page from the accessibility tree, so hidden elements are included.
 */
export function actions(name: string) {
  const message = screen.getByRole("article", { name: "助手", hidden: true });
  return within(message).getAllByRole<HTMLButtonElement>("button", { name, hidden: true });
}

export function action(name: string) {
  const [only, ...rest] = actions(name);
  if (!only || rest.length > 0) throw new Error(`期望恰有一个「${name}」按钮`);
  return only;
}

/** The preview dialog of `index.html`, once it is open. */
export function previewDialog() {
  return screen.findByRole("dialog", { name: "index.html" });
}

export function frameOf(dialog: HTMLElement) {
  const frame = dialog.querySelector("iframe");
  if (!frame) throw new Error("预览对话框里没有 iframe");
  return frame;
}

/** `[type, message]` of every toast on screen, oldest first. */
export function toasts() {
  return [...document.querySelectorAll(".ui-toast")].map((toast) => [
    toast.className.replace("ui-toast ui-toast--", ""),
    toast.querySelector(".ui-toast-message")?.textContent,
  ]);
}

/** Installs `navigator.clipboard` with `writeText`; the test file removes it after each case. */
export function stubClipboard<T extends (text: string) => Promise<void>>(writeText: T) {
  Reflect.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

type DownloadClick = {
  href: string | null;
  download: string;
  /** `revokeObjectURL` calls made before the link was clicked. */
  revokedAtClick: number;
  /** The same count sampled by a 0 ms timer queued during the click, ahead of any later timer. */
  revokedNextTimer: number | null;
};

/**
 * Replaces `<a>.click()` (jsdom would try to navigate) and records, per click, the link's
 * attributes and how often `revoke` had run by then.
 */
export function spyDownloads(revoke: { mock: { calls: unknown[] } }) {
  const clicks: DownloadClick[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const seen: DownloadClick = {
      href: this.getAttribute("href"),
      download: this.download,
      revokedAtClick: revoke.mock.calls.length,
      revokedNextTimer: null,
    };
    clicks.push(seen);
    setTimeout(() => {
      seen.revokedNextTimer = revoke.mock.calls.length;
    }, 0);
  });
  return clicks;
}

/** Session-list and message routes adding the idle neighbour `other session` to `snapshot`'s list. */
export const withOtherSession = (snapshot: Snapshot): FetchRoutes => ({
  "/api/sessions": () => jsonResponse({ sessions: [snapshot.session, otherIdleSession()] }),
  [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
});

/** Selects the neighbour in the sidebar and waits until its transcript replaced the current one. */
export async function switchSession() {
  fireEvent.click(screen.getByRole("button", { name: otherIdleSession().title ?? "" }));
  await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
  expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
  expect(screen.queryByRole("article", { name: "助手" })).toBeNull();
  await quiesce();
}

/** Runs `scenario`, then fails if any promise rejection went unhandled meanwhile. */
export async function withoutUnhandledRejections(scenario: () => Promise<void>) {
  const observer = observeUnhandledRejections();
  try {
    await scenario();
    await settle();
    expect(observer.unhandled).toEqual([]);
  } finally {
    observer.stop();
  }
}
