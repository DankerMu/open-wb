/**
 * Issue 859 产物卡 on the copied component layer (s1f-chat-surface task 7.2): what changed against
 * issue 536. An outcome is shown in the card instead of a toast — a check icon and a hidden 已复制
 * status for about two seconds, or one `role="alert"` line that the next action clears. Seams as
 * in chat-page-artifact-card.test.tsx; expected texts are literals of the turn-artifacts spec delta.
 *
 * Issue #1110: the html preview dialog is gone (its cases went with it; the focus round trip of the
 * narrow sidebar is in chat-workspace-sidebar-reveal-html.test.tsx) and an image card fetches
 * nothing, so only the code card has an in-flight state: the focus hand-back cases use 复制代码.
 */

import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP,
  action,
  alerts,
  artifactCards,
  CODE_TEXT,
  COPY_APP,
  copiedStatus,
  glyphOf,
  openPreviewing,
  previewCalls,
  stubClipboard,
  truncatedPreview,
} from "./chat-page-artifact-card-support.js";
import { type Change, cardNamed, edit, quiesce, reply } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import { chatShellFixture } from "./chat-page-shell-support.js";
import { pageNotices } from "./page-notices.js";
import { deferredResponse, textPreviewResponse } from "./support.js";

chatShellFixture();
afterEach(() => {
  vi.useRealTimers();
});

const okClipboard = () => stubClipboard(vi.fn((_text: string) => Promise.resolve()));
const cardOf = (element: Element) => element.closest('[data-slot="artifact-card"]');

describe("复制成功就地确认", () => {
  it("F1 swaps the copy icon for a check and announces 已复制 for two seconds, then restores it", async () => {
    const writeText = okClipboard();
    await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));
    const copy = action(COPY_APP);
    expect(glyphOf(copy)).toBe("copy");
    expect(copiedStatus()).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    fireEvent.click(copy);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(writeText.mock.calls).toEqual([[CODE_TEXT]]);
    expect(glyphOf(copy)).toBe("check");
    const status = copiedStatus() as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.closest("[hidden], [aria-hidden='true']")).toBeNull();
    expect(cardOf(status)).toBe(cardOf(copy));
    expect(copy.contains(status)).toBe(false);
    expect(copy.getAttribute("aria-label")).toBe(COPY_APP);
    expect(copy.disabled).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(glyphOf(copy)).toBe("check");
    expect(copiedStatus()).not.toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(glyphOf(copy)).toBe("copy");
    expect(copiedStatus()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(pageNotices()).toEqual(["status:已完成"]);
  });
});

describe("失败就地显示", () => {
  it("F2 shows 复制失败 then 文件过大，无法复制 in the clicked card only, clears each at the next click and shows none after a success", async () => {
    const writeText = stubClipboard(
      vi
        .fn((_text: string) => Promise.resolve())
        .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError")),
    );
    const third = deferredResponse();
    const bodies: Array<() => Response | Promise<Response>> = [
      () => textPreviewResponse(CODE_TEXT),
      () => truncatedPreview(CODE_TEXT),
      () => third.promise,
    ];
    const page = await openPreviewing(
      [edit(APP, 2, 1), edit("notes.md", 1, 0)],
      () => bodies.shift()?.() ?? textPreviewResponse("exhausted"),
    );
    const copy = action(COPY_APP);

    fireEvent.click(copy);
    await waitFor(() => expect(alerts()).toEqual(["复制失败"]));

    const [alert] = within(reply()).getAllByRole("alert");
    expect(cardOf(alert as HTMLElement)).toBe(cardOf(copy));
    expect(artifactCards().map((card) => within(card).queryAllByRole("alert").length)).toEqual([
      1, 0,
    ]);
    expect(writeText.mock.calls).toEqual([[CODE_TEXT]]);
    expect(glyphOf(copy)).toBe("copy");
    expect(copiedStatus()).toBeNull();

    fireEvent.click(copy);
    await waitFor(() => expect(alerts()).toEqual(["文件过大，无法复制"]));
    await quiesce();
    expect(writeText).toHaveBeenCalledTimes(1);

    fireEvent.click(copy);
    await quiesce();
    expect(copy.disabled).toBe(true);
    expect(alerts()).toEqual([]);

    await settleDeferredResponse(third, textPreviewResponse(CODE_TEXT));
    await waitFor(() => expect(glyphOf(copy)).toBe("check"));

    expect(alerts()).toEqual([]);
    expect(copiedStatus()?.textContent).toBe("已复制");
    expect(writeText.mock.calls).toEqual([[CODE_TEXT], [CODE_TEXT]]);
    expect(previewCalls(page.fetchMock)).toHaveLength(3);
    expect(pageNotices()).toEqual(["status:已完成", "status:已复制"]);
  });
});

/*
 * 焦点归还（issue 537 的 P13、Q1，产物卡这一半）：拉取结束时焦点在 `body` 上就还给被点的那个
 * 按钮。只有代码卡还有拉取（#1110）。浏览器在聚焦的按钮变成 disabled 时把焦点移到 `body`；jsdom 把它留在 disabled 的按钮上、对它
 * 调 `blur()` 也无效，所以这些用例在点击的同一批里、disabled 提交之前先让按钮失焦。
 */
describe("拉取结束后的焦点归还", () => {
  /** 打开只有一个已结束步骤改了 `change` 的页面；它的预览请求挂起。 */
  async function openPending(change: Change) {
    const pending = deferredResponse();
    await openPreviewing([change], () => pending.promise);
    return pending;
  }

  /** 聚焦并点击 `button`，在 disabled 提交之前执行 `then`，等到请求在途（按钮 disabled）。 */
  async function press(button: HTMLButtonElement, then: () => void = () => {}) {
    button.focus();
    act(() => {
      fireEvent.click(button);
      then();
    });
    await quiesce();
    expect(button.disabled).toBe(true);
  }

  /** `press`，并让焦点落到 `body`——浏览器里聚焦的按钮一 disabled 就是这样。 */
  async function pressAndLoseFocus(button: HTMLButtonElement) {
    await press(button, () => button.blur());
    expect(document.activeElement).toBe(document.body);
  }

  const focusOn = (element: Element) => waitFor(() => expect(document.activeElement).toBe(element));

  it("P13 复制结束时焦点在 body 上：回到被点的 复制代码 按钮", async () => {
    const writeText = okClipboard();
    const pending = await openPending(edit(APP, 2, 1));
    const copy = action(COPY_APP);
    await pressAndLoseFocus(copy);

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));

    await waitFor(() => expect(writeText.mock.calls).toEqual([[CODE_TEXT]]));
    await focusOn(copy);
    expect(copy.disabled).toBe(false);
    expect(pageNotices()).toEqual(["status:已完成", "status:已复制"]);
  });

  it("Q1 归还焦点时只带 preventScroll，不把消息线程滚到那个按钮", async () => {
    const writeText = okClipboard();
    const pending = await openPending(edit(APP, 2, 1));
    const copy = action(COPY_APP);
    await pressAndLoseFocus(copy);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));

    await waitFor(() => expect(writeText.mock.calls).toEqual([[CODE_TEXT]]));
    await focusOn(copy);
    const onCopy = focus.mock.calls.filter((_call, at) => focus.mock.contexts[at] === copy);
    expect(onCopy).toEqual([[{ preventScroll: true }]]);
  });

  it("P13 拉取期间用户把焦点移到了别处：结束后焦点留在那里，不被拉回按钮", async () => {
    okClipboard();
    const pending = await openPending(edit(APP, 2, 1));
    const copy = action(COPY_APP);
    await press(copy);
    const input = composer();
    input.focus();
    expect(document.activeElement).toBe(input);
    const onCopy = vi.spyOn(copy, "focus");

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));

    await waitFor(() => expect(glyphOf(copy)).toBe("check"));
    await quiesce();
    expect(copy.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onCopy.mock.calls).toEqual([]);
    expect(pageNotices()).toEqual(["status:已完成", "status:已复制"]);
  });
});

describe("卡片底色上的悬停底色", () => {
  it("F6 the icon buttons of the artifact card and of the file-change row take the accent hover in both themes", async () => {
    await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));
    const detail = within(cardNamed("文件变更（1 个）")).getByRole("button", {
      name: "查看详情 zhangsan/proj/src/app.ts",
    });

    for (const button of [action(COPY_APP), detail]) {
      const classes = button.className.split(/\s+/);
      expect(classes).toContain("hover:bg-accent");
      expect(classes).toContain("dark:hover:bg-accent");
      expect(classes).not.toContain("hover:bg-muted");
      expect(classes).not.toContain("dark:hover:bg-muted/50");
    }
  });
});
