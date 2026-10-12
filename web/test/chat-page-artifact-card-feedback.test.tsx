/**
 * Issue 859 产物卡 on the copied component layer (s1f-chat-surface task 7.2): what changed against
 * issue 536. An outcome is shown in the card instead of a toast — a check icon and a hidden 已复制
 * status for about two seconds, or one `role="alert"` line that the next action clears — and the
 * html preview is the copied-layer dialog, which gives focus back to the button that opened it
 * without scrolling. Seams as in chat-page-artifact-card.test.tsx; expected texts are literals of
 * the turn-artifacts spec delta.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP,
  action,
  actions,
  alerts,
  artifactCards,
  CHART,
  CODE_TEXT,
  COPY_APP,
  copiedStatus,
  DOWNLOAD_CHART,
  frameOf,
  glyphOf,
  HTML_TEXT,
  INDEX,
  OPEN_INDEX,
  openPreviewing,
  previewCalls,
  previewDialog,
  spyDownloads,
  stubClipboard,
  toasts,
  truncatedPreview,
  withOtherSession,
} from "./chat-page-artifact-card-support.js";
import {
  type Change,
  cardNamed,
  edit,
  quiesce,
  reply,
  write,
} from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { composer, envelope, OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import { chatShellFixture } from "./chat-page-shell-support.js";
import { imagePreviewResponse } from "./files-fixture.js";
import { deferredResponse, textPreviewResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const blobs = chatShellFixture();
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
    expect(toasts()).toEqual([]);
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
    expect(toasts()).toEqual([]);
  });

  it("F3 a failed download shows the envelope message in its card and a later successful one removes it", async () => {
    const bodies = [
      () => envelope(413, "preview_too_large", "图片超过预览上限"),
      () => imagePreviewResponse(),
    ];
    await openPreviewing([write(CHART)], () => bodies.shift()?.() ?? imagePreviewResponse());
    const clicks = spyDownloads(blobs.revokeObjectURL);
    const download = action(DOWNLOAD_CHART);

    fireEvent.click(download);
    await waitFor(() => expect(alerts()).toEqual(["图片超过预览上限"]));

    const alert = within(cardNamed("chart.PNG")).getByRole("alert");
    expect(alert.textContent).toBe("图片超过预览上限");
    expect(clicks).toEqual([]);

    fireEvent.click(download);
    await waitFor(() => expect(clicks).toHaveLength(1));
    await quiesce();

    expect(alerts()).toEqual([]);
    expect(copiedStatus()).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it("F3 a failed html preview shows its message between the head and the foot and an opened preview removes it", async () => {
    const bodies = [
      () => envelope(404, "not_found", "文件不存在或已被删除"),
      () => textPreviewResponse(HTML_TEXT),
    ];
    await openPreviewing(
      [write(INDEX)],
      () => bodies.shift()?.() ?? textPreviewResponse("exhausted"),
    );
    const [head, foot] = actions(OPEN_INDEX) as [HTMLButtonElement, HTMLButtonElement];

    fireEvent.click(foot);
    await waitFor(() => expect(alerts()).toEqual(["文件不存在或已被删除"]));

    const alert = within(cardNamed("index.html")).getByRole("alert");
    expect(head.compareDocumentPosition(alert)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(alert.compareDocumentPosition(foot)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(head);
    const dialog = await previewDialog();

    expect(frameOf(dialog).getAttribute("srcdoc")).toBe(HTML_TEXT);
    expect(alerts()).toEqual([]);
    expect(toasts()).toEqual([]);
  });
});

describe("html 预览对话框（拷入层 dialog）", () => {
  const closings: Array<[string, (dialog: HTMLElement) => void]> = [
    ["关闭", (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }))],
    ["Escape", () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })],
  ];

  it.each(closings)(
    "F4 closing the preview with %s focuses the button that opened it without scrolling",
    async (_name, close) => {
      await openPreviewing([write(INDEX)], () => textPreviewResponse(HTML_TEXT));
      const [head, foot] = actions(OPEN_INDEX) as [HTMLButtonElement, HTMLButtonElement];
      head.focus();
      const onHead = vi.spyOn(head, "focus");
      const onFoot = vi.spyOn(foot, "focus");

      fireEvent.click(head);
      const dialog = await previewDialog();
      await quiesce();

      expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.classList.contains("ui-dialog")).toBe(false);
      expect(within(dialog).getAllByRole("button", { name: "关闭" })).toHaveLength(1);
      // Initial focus is the dialog's 关闭 button, never the iframe of the fetched page: with focus
      // inside a sandboxed iframe the page gets no keydown and Escape cannot close the preview.
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "关闭" }));
      expect(document.activeElement).not.toBe(frameOf(dialog));
      expect(onHead.mock.calls).toEqual([]);

      close(dialog);

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(head));
      await quiesce();
      expect(onHead.mock.calls).toEqual([[{ preventScroll: true }]]);
      expect(onFoot.mock.calls).toEqual([]);
      expect(document.querySelector("iframe")).toBeNull();
    },
  );

  it("T3 a press on the preview's overlay closes it and hands focus back to the button that opened it", async () => {
    await openPreviewing([write(INDEX)], () => textPreviewResponse(HTML_TEXT));
    const [head] = actions(OPEN_INDEX) as [HTMLButtonElement, HTMLButtonElement];
    head.focus();
    fireEvent.click(head);
    const dialog = await previewDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // Radix arms the layer's document pointerdown listener in a setTimeout(0) after mount.
    await yieldMacrotask();
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
    expect(overlays).toHaveLength(1);

    pressPointer(overlays[0] as Element);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(head));
    expect(document.querySelector("iframe")).toBeNull();
    expect(toasts()).toEqual([]);
  });
});

/*
 * 焦点归还（issue 537 的 P13、Q1、Q3，产物卡这一半）：拉取结束时焦点在 `body` 上就还给被点的那个
 * 按钮。浏览器在聚焦的按钮变成 disabled 时把焦点移到 `body`；jsdom 把它留在 disabled 的按钮上、对它
 * 调 `blur()` 也无效，所以这些用例在点击的同一批里、disabled 提交之前先让按钮失焦。
 */
describe("拉取结束后的焦点归还", () => {
  /** 打开只有一个已结束步骤改了 `change` 的页面；它的预览请求挂起。 */
  async function openPending(change: Change, more?: Parameters<typeof openPreviewing>[2]) {
    const pending = deferredResponse();
    await openPreviewing([change], () => pending.promise, more);
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

  it("P13 下载结束时焦点在 body 上：回到被点的 下载 按钮", async () => {
    const pending = await openPending(write(CHART));
    const clicks = spyDownloads(blobs.revokeObjectURL);
    const download = action(DOWNLOAD_CHART);
    await pressAndLoseFocus(download);

    await settleDeferredResponse(pending, imagePreviewResponse());

    await waitFor(() => expect(clicks).toHaveLength(1));
    await focusOn(download);
    expect(download.disabled).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it("Q1 归还焦点时只带 preventScroll，不把消息线程滚到那个按钮", async () => {
    const pending = await openPending(write(CHART));
    const clicks = spyDownloads(blobs.revokeObjectURL);
    const download = action(DOWNLOAD_CHART);
    await pressAndLoseFocus(download);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    await settleDeferredResponse(pending, imagePreviewResponse());

    await waitFor(() => expect(clicks).toHaveLength(1));
    await focusOn(download);
    const onDownload = focus.mock.calls.filter((_call, at) => focus.mock.contexts[at] === download);
    expect(onDownload).toEqual([[{ preventScroll: true }]]);
  });

  it("Q3 从 html 卡的卡脚按钮发起的预览失败：焦点回到卡脚按钮，不是卡头的那个", async () => {
    const pending = await openPending(write(INDEX));
    const [head, foot] = actions(OPEN_INDEX);
    if (!head || !foot) throw new Error("html 产物卡应有卡头与卡脚两个按钮");
    expect(foot.closest('[data-slot="artifact-foot"]')).not.toBeNull();
    await pressAndLoseFocus(foot);
    expect(head.disabled).toBe(true);

    await settleDeferredResponse(pending, envelope(404, "not_found", "文件不存在或已被删除"));

    await waitFor(() => expect(alerts()).toEqual(["文件不存在或已被删除"]));
    expect(toasts()).toEqual([]);
    await focusOn(foot);
    expect(document.activeElement).not.toBe(head);
    expect(head.disabled).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
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
    expect(toasts()).toEqual([]);
  });

  it("P13 html 卡：预览打开时焦点在对话框里而不在按钮上，关闭预览后回到被点的按钮", async () => {
    const pending = await openPending(write(INDEX));
    const [head, foot] = actions(OPEN_INDEX) as [HTMLButtonElement, HTMLButtonElement];
    await pressAndLoseFocus(foot);

    await settleDeferredResponse(pending, textPreviewResponse(HTML_TEXT));
    const preview = await previewDialog();
    await quiesce();

    expect(foot.disabled).toBe(false);
    expect(preview.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(foot);

    fireEvent.click(within(preview).getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "index.html" })).toBeNull());
    await focusOn(foot);
    expect(document.activeElement).not.toBe(head);
  });

  // 模态预览盖着会话列表，真实路径是浏览器的后退 / 前进，这里经路由切换。
  it("Q5 预览开着时切到另一个会话：没有残留的对话框与 iframe，页面不被留在不可点的状态", async () => {
    const page = await openPreviewing(
      [write(INDEX)],
      () => textPreviewResponse(HTML_TEXT),
      withOtherSession,
    );
    fireEvent.click(actions(OPEN_INDEX)[0] as HTMLButtonElement);
    await previewDialog();
    await yieldMacrotask();
    expect(document.body.style.pointerEvents).toBe("none");

    await act(() => page.router.navigate(`/?session=${OTHER_SESSION_ID}`));
    expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
    await quiesce();

    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(composer().closest('[aria-hidden="true"]')).toBeNull();
    expect(toasts()).toEqual([]);
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
