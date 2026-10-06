/**
 * Issue 537 产物面板, P13 of openspec/changes/artifacts-panel/design.md (D9): when an artifact
 * action ends while focus is on `body`, focus goes back to the button that was clicked. A browser
 * moves focus to `body` when the focused button becomes disabled; jsdom keeps it on the disabled
 * button and ignores `blur()` there, so the cases blur the button in the same batch as the click,
 * before the disabled state commits. Seams as in chat-page-artifacts-panel.test.tsx.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  APP,
  action,
  actions,
  alerts,
  CHART,
  CODE_TEXT,
  COPY_APP,
  changedTurn,
  DOWNLOAD_CHART,
  glyphOf,
  HTML_TEXT,
  INDEX,
  OPEN_INDEX,
  openPreviewing,
  previewDialog,
  previewRoute,
  spyDownloads,
  stubClipboard,
  toasts,
  withOtherSession,
} from "./chat-page-artifact-card-support.js";
import {
  artifactsPanelFixture,
  drawer,
  expectPanelClosed,
  footClose,
  NO_ARTIFACTS,
  openPanel,
  panelAction,
  panelBody,
  panelButton,
  renameBehindDialog,
  renameRoute,
  routeToOtherSession,
  rowAlerts,
  rowButtons,
  twoTurns,
} from "./chat-page-artifacts-panel-support.js";
import {
  type Change,
  edit,
  goLive,
  listed,
  openSession,
  quiesce,
  rowTexts,
  toolStep,
  write,
} from "./chat-page-file-changes-support.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { envelope, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { imagePreviewResponse } from "./files-fixture.js";
import { calls, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const blobs = artifactsPanelFixture();

/** Opens the page on one ended step that changed `change`; its preview stays pending. */
async function openPending(change: Change) {
  const pending = deferredResponse();
  await openPreviewing([change], () => pending.promise);
  return pending;
}

/**
 * Focuses and clicks `button`, runs `then` before the click's disabled state commits, and waits
 * until the request is in flight (the button disabled).
 */
async function press(button: HTMLButtonElement, then: () => void = () => {}) {
  button.focus();
  act(() => {
    fireEvent.click(button);
    then();
  });
  await quiesce();
  expect(button.disabled).toBe(true);
}

/** `press` with focus dropping to `body`, as in a browser once the focused button is disabled. */
async function pressAndLoseFocus(button: HTMLButtonElement) {
  await press(button, () => button.blur());
  expect(document.activeElement).toBe(document.body);
}

function focusOn(element: Element) {
  return waitFor(() => expect(document.activeElement).toBe(element));
}

describe("焦点归还 (P13)", () => {
  // The toast is the session list's 已重命名: a row's copy no longer shows one. It arrives while the
  // drawer is open, so it sits above the drawer in the Radix layer stack and takes its Escape.
  it("P13 a finished row copy takes focus back from body, so Escape closes the drawer while a toast is shown", async () => {
    stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const renamed = deferredResponse();
    const changes = [edit(APP, 2, 1)];
    await openPreviewing(
      changes,
      () => pending.promise,
      () => renameRoute(renamed.promise),
    );
    await renameBehindDialog();
    const { panel, trigger } = await openPanel();
    const copy = panelAction(panel, COPY_APP);
    await pressAndLoseFocus(copy);

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));
    const session = { ...changedTurn(changes).session, title: "新标题" };
    await settleDeferredResponse(renamed, jsonResponse(session));

    await waitFor(() => expect(glyphOf(copy)).toBe("check"));
    await waitFor(() => expect(toasts()).toEqual([["success", "已重命名"]]));
    await focusOn(copy);
    expect(copy.disabled).toBe(false);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await expectPanelClosed();
    expect(document.activeElement).toBe(trigger);
  });

  it("P13 focus the user moved elsewhere while the row action was pending stays there", async () => {
    stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = await openPending(edit(APP, 2, 1));
    const { panel } = await openPanel();
    const close = footClose(panel);
    await press(panelAction(panel, COPY_APP));
    close.focus();

    await settleDeferredResponse(pending, textPreviewResponse(CODE_TEXT));

    await waitFor(() => expect(glyphOf(panelAction(panel, COPY_APP))).toBe("check"));
    await quiesce();
    expect(toasts()).toEqual([]);
    expect(panelAction(panel, COPY_APP).disabled).toBe(false);
    expect(document.activeElement).toBe(close);
  });

  it("P13 a failed row action takes focus back from body after its failure is shown in the row", async () => {
    const pending = await openPending(edit("gone.md", 1, 0));
    const { panel } = await openPanel();
    const copy = panelAction(panel, "复制代码 gone.md");
    await pressAndLoseFocus(copy);

    await settleDeferredResponse(pending, envelope(404, "not_found", "文件不存在或已被删除"));

    await waitFor(() => expect(rowAlerts(panel)).toEqual([["文件不存在或已被删除"]]));
    expect(toasts()).toEqual([]);
    await focusOn(copy);
    expect(drawer()).toBe(panel);
  });

  it("P13 an artifact card in the transcript takes focus back from body once its download finished", async () => {
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

  it("Q1 the hand-back focuses the clicked button without scrolling the transcript to it", async () => {
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

  it("Q3 a failed preview started from the html card's foot button hands focus back to that button, not the head one", async () => {
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

  it("P13 an html row leaves focus inside its preview dialog and gets it back when the preview closes", async () => {
    const pending = await openPending(write(INDEX));
    const { panel } = await openPanel();
    const open = panelAction(panel, OPEN_INDEX);
    await pressAndLoseFocus(open);

    await settleDeferredResponse(pending, textPreviewResponse(HTML_TEXT));
    const preview = await previewDialog();
    await quiesce();

    expect(open.disabled).toBe(false);
    expect(preview.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(open);

    fireEvent.click(within(preview).getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "index.html" })).toBeNull());
    await focusOn(open);
    expect(drawer()).toBe(panel);
  });
});

describe("外层先离场 (Q5)", () => {
  it("Q5 routing away while a row's preview covers the drawer leaves no dialog, no inert page and a 产物面板 button that opens the other session's empty panel", async () => {
    const snapshot = changedTurn([write(INDEX)]);
    const page = await openSession(snapshot, listed, {
      ...withOtherSession(snapshot),
      [previewRoute(INDEX)]: () => textPreviewResponse(HTML_TEXT),
    });
    const { panel } = await openPanel();
    fireEvent.click(panelAction(panel, OPEN_INDEX));
    const preview = await previewDialog();
    await yieldMacrotask();
    expect(screen.getAllByRole("dialog", { hidden: true })).toEqual([panel, preview]);
    expect(document.body.style.pointerEvents).toBe("none");
    expect(panelButton().closest('[aria-hidden="true"]')).not.toBeNull();

    await routeToOtherSession(page.router);

    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(panelButton().closest('[aria-hidden="true"]')).toBeNull();
    const button = within(screen.getByRole("banner")).getByRole("button", { name: "产物面板" });

    fireEvent.click(button);
    const empty = await screen.findByRole("dialog", { name: "产物面板" });

    expect(panelBody(empty)).toBe(NO_ARTIFACTS);
    expect(screen.getAllByRole("dialog", { hidden: true })).toEqual([empty]);
    expect(toasts()).toEqual([]);
  });
});

// s1f-chat-followups 5.7：视图末条助手已终态时到达未知回合的事件，连接重装一次完整快照（不经「历史加载中」）。
describe("跨重同步保持打开", () => {
  it("an unknown-turn event while the panel is open re-reads the snapshot once: the panel stays open and lists the new snapshot's changes", async () => {
    const first = [toolStep(11, 0, "edit", [edit("a.md", 1, 0)])];
    const before = changedTurn([edit("a.md", 1, 0)]);
    // 别处开始并结束的下一回合（助手消息 id 2）：改了 a.md，新写了 out/index.html；游标盖过 `1:4`。
    const after = {
      ...twoTurns(first, [
        toolStep(21, 0, "edit", [edit("a.md", 3, 1)]),
        toolStep(22, 1, "write", [write(INDEX)]),
      ]),
      streamCursor: { epoch: 1, seq: 4 },
    };
    let current = before;
    const { fetchMock } = await openSession(before, listed, {
      [SESSION_MESSAGES]: () => jsonResponse(current),
    });
    const send = await goLive();
    const reads = () => calls(fetchMock, SESSION_MESSAGES).length;
    const baseline = reads();
    const { panel } = await openPanel();
    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md"]);

    current = after;
    send("turn.start", { messageId: 2 });
    await quiesce();

    expect(reads()).toBe(baseline + 1);
    expect(drawer()).toBe(panel);
    expect(screen.getAllByRole("dialog")).toEqual([panel]);
    expect(rowTexts(panel)).toEqual(["+3-1zhangsan/proj/a.md", "写入zhangsan/proj/out/index.html"]);
    expect(rowButtons(panel)[1]).toEqual([
      "查看详情 zhangsan/proj/out/index.html",
      "打开网页预览 index.html",
    ]);
    expect(toasts()).toEqual([]);
  });
});
