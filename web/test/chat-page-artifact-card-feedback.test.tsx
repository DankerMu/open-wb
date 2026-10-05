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
  changedTurn,
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
} from "./chat-page-artifact-card-support.js";
import {
  artifactsPanelFixture,
  renameBehindDialog,
  renameRoute,
} from "./chat-page-artifacts-panel-support.js";
import { cardNamed, edit, quiesce, reply, write } from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { envelope } from "./chat-page-ownership-support.js";
import { imagePreviewResponse } from "./files-fixture.js";
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";

const blobs = artifactsPanelFixture();
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

  // A toast that arrives after the preview opened sits above it in the Radix layer stack and takes
  // its Escape. The only toasts left on this page are the session list's, so a rename is submitted
  // first and answered once the card's preview is open.
  it("F5 Escape closes the preview while a later toast holds the top of the layer stack", async () => {
    const renamed = deferredResponse();
    const changes = [write(INDEX)];
    await openPreviewing(
      changes,
      () => textPreviewResponse(HTML_TEXT),
      () => renameRoute(renamed.promise),
    );
    await renameBehindDialog();
    const [head] = actions(OPEN_INDEX) as [HTMLButtonElement];

    fireEvent.click(head);
    const dialog = await previewDialog();
    const session = { ...changedTurn(changes).session, title: "新标题" };
    await settleDeferredResponse(renamed, jsonResponse(session));
    await waitFor(() => expect(toasts()).toEqual([["success", "已重命名"]]));
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(head));
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
