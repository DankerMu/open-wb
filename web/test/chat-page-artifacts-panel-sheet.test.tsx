/**
 * Issue 860 产物面板 on the copied-layer sheet (s1f-chat-surface task 7.3): what is new against
 * issue 537. A row's html preview is the copied-layer dialog of the artifact card, a second layer
 * above the sheet with its own focus discipline, and a row shows the outcome of its action in
 * place like the card does. The empty state inside the panel is in
 * chat-page-artifacts-panel.test.tsx (P4, rewritten). Seams as in that file; expected texts are
 * literals of the turn-artifacts spec delta. jsdom has no layout: that the preview is painted
 * above the sheet is asserted in the UI walk.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  APP,
  CODE_TEXT,
  COPY_APP,
  changedTurn,
  frameOf,
  glyphOf,
  HTML_TEXT,
  INDEX,
  OPEN_INDEX,
  openPreviewing,
  previewCalls,
  previewDialog,
  stubClipboard,
  toasts,
} from "./chat-page-artifact-card-support.js";
import {
  artifactsPanelFixture,
  bannerButtons,
  drawer,
  expectPanelClosed,
  NO_ARTIFACTS,
  openPanel,
  panelAction,
  panelBody,
  panelButton,
  panelRows,
  routeBack,
  rowAlerts,
  SESSION_PATH,
} from "./chat-page-artifacts-panel-support.js";
import {
  assistantMessage,
  edit,
  listed,
  quiesce,
  rowTexts,
  toolStep,
  WORKSPACES,
  write,
} from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherSnapshot,
  SESSION_MESSAGES,
} from "./chat-page-ownership-support.js";
import { expectChatLocation, renderChatPage } from "./chat-page-support.js";
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

artifactsPanelFixture();

/** Opens the panel on a.md and out/index.html and the html row's preview above it. */
async function openRowPreview() {
  await openPreviewing([edit("a.md", 1, 0), write(INDEX)], () => textPreviewResponse(HTML_TEXT));
  const { panel, trigger } = await openPanel();
  const open = panelAction(panel, OPEN_INDEX);
  open.focus();
  fireEvent.click(open);
  const preview = await previewDialog();
  // The dialog is in the document before its effects ran. Focus moving into it shows they did; one
  // task later its layer has the document's Escape and pointerdown listeners.
  await waitFor(() => expect(preview.contains(document.activeElement)).toBe(true));
  await yieldMacrotask();
  return { open, panel, preview, trigger };
}

describe("行内预览叠在面板之上", () => {
  it("T1 the row's preview is the copied-layer dialog after the sheet, focused on its 关闭 button and not on the iframe", async () => {
    const { open, panel, preview } = await openRowPreview();

    expect(preview.getAttribute("data-slot")).toBe("dialog-content");
    expect(preview.classList.contains("ui-dialog")).toBe(false);
    expect(screen.getAllByRole("dialog", { hidden: true })).toEqual([panel, preview]);
    expect(panel.compareDocumentPosition(preview)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(preview.closest('[aria-hidden="true"]')).toBeNull();
    expect(frameOf(preview).getAttribute("sandbox")).toBe("allow-scripts");
    const close = within(preview).getByRole("button", { name: "关闭" });
    expect(close.getAttribute("data-slot")).toBe("dialog-close");
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(frameOf(preview));
    expect(document.activeElement).not.toBe(open);
  });

  it("T2 Escape closes the preview only, focus returns to the row's button without scrolling; a second Escape closes the panel", async () => {
    const { open, panel, trigger } = await openRowPreview();
    const onOpen = vi.spyOn(open, "focus");

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "index.html" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(onOpen.mock.calls).toEqual([[{ preventScroll: true }]]);
    expect(screen.getAllByRole("dialog")).toEqual([panel]);
    expect(panel.getAttribute("aria-hidden")).toBeNull();
    expect(panelRows(panel)).toHaveLength(2);
    await yieldMacrotask();

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await expectPanelClosed();
    expect(document.activeElement).toBe(trigger);
  });

  it("T3 a press on the preview's overlay closes the preview and leaves the panel open", async () => {
    const { open, panel } = await openRowPreview();
    const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]');
    expect(overlays).toHaveLength(1);

    pressPointer(overlays[0] as Element);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "index.html" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
    await quiesce();
    expect(drawer()).toBe(panel);
    expect(screen.getAllByRole("dialog")).toEqual([panel]);
  });
});

describe("行内就地提示", () => {
  it("T4 a failed copy shows 复制失败 in the row of the clicked button only; the next click clears it and its success shows none", async () => {
    const writeText = stubClipboard(
      vi
        .fn((_text: string) => Promise.resolve())
        .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError")),
    );
    const second = deferredResponse();
    const bodies: Array<() => Response | Promise<Response>> = [
      () => textPreviewResponse(CODE_TEXT),
      () => second.promise,
    ];
    const page = await openPreviewing(
      [edit("notes.md", 1, 0), edit(APP, 2, 1)],
      () => bodies.shift()?.() ?? textPreviewResponse("exhausted"),
    );
    const { panel } = await openPanel();
    const copy = panelAction(panel, COPY_APP);

    fireEvent.click(copy);

    await waitFor(() => expect(rowAlerts(panel)).toEqual([[], ["复制失败"]]));
    const row = panelRows(panel)[1] as HTMLElement;
    const alert = within(row).getByRole("alert");
    expect(copy.compareDocumentPosition(alert)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(row.contains(copy)).toBe(true);
    expect(glyphOf(copy)).toBe("copy");
    expect(within(row).queryByRole("status")).toBeNull();
    expect(toasts()).toEqual([]);
    await quiesce();

    fireEvent.click(copy);
    await quiesce();

    expect(copy.disabled).toBe(true);
    expect(rowAlerts(panel)).toEqual([[], []]);

    await settleDeferredResponse(second, textPreviewResponse(CODE_TEXT));
    await waitFor(() => expect(glyphOf(copy)).toBe("check"));

    expect(rowAlerts(panel)).toEqual([[], []]);
    expect(within(row).getByRole("status").textContent).toBe("已复制");
    expect(writeText.mock.calls).toEqual([[CODE_TEXT], [CODE_TEXT]]);
    expect(previewCalls(page.fetchMock)).toHaveLength(2);
    expect(drawer()).toBe(panel);
    expect(toasts()).toEqual([]);
  });
});

describe("面板随它打开时的会话关闭", () => {
  it("T5 opened while session A's history is pending, the panel closes when session B is selected, shows no row of B and does not reopen on return to A", async () => {
    const historyA = deferredResponse();
    const snapshotA = changedTurn([edit("a.md", 1, 0)]);
    const other = otherSnapshot();
    const snapshotB = {
      ...other,
      session: { ...other.session, workspaceId: snapshotA.session.workspaceId },
      messages: [
        ...other.messages,
        assistantMessage("done", {
          content: "乙",
          steps: [toolStep(31, 0, "write", [write("b-only.md")])],
        }),
      ],
    };
    const bodiesA = [() => historyA.promise, () => jsonResponse(snapshotA)];
    const page = renderChatPage(SESSION_PATH, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshotA.session, snapshotB.session] }),
      [WORKSPACES]: listed,
      [SESSION_MESSAGES]: () => bodiesA.shift()?.() ?? jsonResponse(snapshotA),
      [OTHER_MESSAGES]: () => jsonResponse(snapshotB),
    });
    await waitFor(() => expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]));
    const { panel } = await openPanel();
    expect(panelBody(panel)).toBe(NO_ARTIFACTS);

    await act(() => page.router.navigate(`/?session=${OTHER_SESSION_ID}`));
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    await screen.findByRole("group", { name: "文件变更（1 个）", hidden: true });
    await quiesce();

    expect(drawer()).toBeNull();
    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(panel.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(panelButton()));

    await settleDeferredResponse(historyA, jsonResponse(snapshotA));
    await routeBack(page.router);
    await yieldMacrotask();

    expect(drawer()).toBeNull();
    expect(toasts()).toEqual([]);

    const again = await openPanel();

    expect(rowTexts(again.panel)).toEqual(["+1zhangsan/proj/a.md"]);
  });
});
