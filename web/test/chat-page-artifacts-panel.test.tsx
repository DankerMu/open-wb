/**
 * Issue 537 产物面板 (parent tasks 7.6): P1–P12 of openspec/changes/artifacts-panel/design.md.
 * Seams: the jsdom chat page inside the shell over a stubbed `fetch`, the live event source, the
 * router, the two Blob URL statics, `<a>.click()`, `navigator.clipboard`, the pure `chatTopbar`,
 * and the static source and CSS text. Expected values are literals from the spec deltas; cases
 * marked (guard) already hold before the change.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chatTopbar } from "../src/features/chat/topbar-actions.js";
import {
  APP,
  BLOB_URL,
  CHART,
  CODE_TEXT,
  COPY_APP,
  changedTurn,
  DOWNLOAD_CHART,
  frameOf,
  HTML_TEXT,
  INDEX,
  OPEN_INDEX,
  openPreviewing,
  previewCalls,
  previewDialog,
  previewRoute,
  previewSignal,
  spyDownloads,
  stubClipboard,
  toasts,
  withOtherSession,
} from "./chat-page-artifact-card-support.js";
import {
  artifactsPanelFixture,
  bannerButtons,
  drawer,
  expectPanelClosed,
  footClose,
  headClose,
  NO_ARTIFACTS,
  openPanel,
  openProbedSession,
  panelAction,
  panelActions,
  panelButton,
  panelRows,
  routeBack,
  routeToOtherSession,
  rowButtons,
  SESSION_PATH,
  twoTurns,
} from "./chat-page-artifacts-panel-support.js";
import {
  type Change,
  edit,
  goLive,
  listed,
  openSession,
  PROJ,
  quiesce,
  ROOT_PREFIX,
  rowCells,
  rowTexts,
  type Snapshot,
  toolStep,
  turn,
  UNLISTED_ID,
  WORKSPACES,
  write,
} from "./chat-page-file-changes-support.js";
import { renewAccount, settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { envelope, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { renderChatPage } from "./chat-page-support.js";
import { deferred } from "./chat-stream-support.js";
import { hasLucideGlyph, imagePreviewResponse } from "./files-fixture.js";
import { currentLocation, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import {
  pressPointer,
  readRepoFile,
  ruleBody,
  stripComments,
  yieldMacrotask,
} from "./ui-support.js";

const A_MD = "a.md";
const DETAILS = /^查看详情/;
const DETAILS_A = "查看详情 zhangsan/proj/a.md";
const DETAILS_INDEX = "查看详情 zhangsan/proj/out/index.html";
const COPIED: [string, string] = ["success", "已复制到剪贴板"];

const blobs = artifactsPanelFixture();

/** One ended step that edited a.md and wrote out/index.html, in a session bound to `workspaceId`. */
const editedAndWritten = (workspaceId: string | null = PROJ.id) =>
  changedTurn([edit(A_MD, 1, 0), write(INDEX)], workspaceId);

describe("顶栏入口 (P1)", () => {
  it("P1 a selected session shows 重命名 then 产物面板; the new button has the package icon and no aria-expanded", async () => {
    await openSession(editedAndWritten());

    expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]);
    const button = panelButton();
    expect(button.hasAttribute("aria-expanded")).toBe(false);
    expect(hasLucideGlyph(button, "package")).toBe(true);

    await openPanel();

    expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]);
    expect(panelButton()).toBe(button);
    expect(button.hasAttribute("aria-expanded")).toBe(false);
  });

  it("P1 the welcome state renders neither top-bar button (guard)", async () => {
    const page = await openSession(editedAndWritten());

    await act(() => page.router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" });

    expect(screen.queryAllByRole("button", { name: /^(重命名|产物面板)$/ })).toEqual([]);
    expect(screen.queryByRole("banner")).toBeNull();
  });

  it("P1 chatTopbar reports nothing while no session is selected (guard)", () => {
    expect(
      chatTopbar(undefined, vi.fn(), { expanded: false, onSelect: vi.fn() }, vi.fn()),
    ).toStrictEqual({});
  });

  it("P1 chatTopbar fills rename then artifacts, the latter without expanded, and passes it the trigger", () => {
    const openRename = vi.fn();
    const openArtifacts = vi.fn();

    const report = chatTopbar(
      turn("done").session,
      openRename,
      { expanded: false, onSelect: vi.fn() },
      openArtifacts,
    );

    expect(report.actions?.map((action) => action.key)).toEqual(["rename", "search", "artifacts"]);
    const artifacts = report.actions?.[2];
    expect(Object.keys(artifacts ?? {})).not.toContain("expanded");
    const trigger = document.createElement("button");
    artifacts?.onSelect(trigger);
    expect(openArtifacts.mock.calls).toEqual([[trigger]]);
    expect(openRename).not.toHaveBeenCalled();
  });
});

describe("聚合 (P2, P3)", () => {
  it("P2 opens a right drawer of width 420 with one row per path across both assistant messages and fetches nothing", async () => {
    const page = await openSession(
      twoTurns(
        [toolStep(11, 0, "edit", [edit(A_MD, 1, 0)])],
        [toolStep(21, 0, "edit", [edit(A_MD, 3, 1)]), toolStep(22, 1, "write", [write(INDEX)])],
      ),
    );

    const { panel } = await openPanel();

    expect(screen.getByRole("dialog", { name: "产物面板" })).toBe(panel);
    expect(screen.getAllByRole("dialog")).toEqual([panel]);
    expect(panel.classList.contains("ui-drawer--right")).toBe(true);
    expect(panel.classList.contains("ui-drawer--w420")).toBe(true);
    expect(panelRows(panel)).toHaveLength(2);
    expect(rowCells(panel)).toEqual([
      [
        ["file-change-add", "+3"],
        ["file-change-del", "-1"],
        ["file-change-path", "zhangsan/proj/a.md"],
      ],
      [
        ["file-change-kind", "写入"],
        ["file-change-path", "zhangsan/proj/out/index.html"],
      ],
    ]);
    expect(rowButtons(panel)).toEqual([
      [DETAILS_A, "复制代码 a.md"],
      [DETAILS_INDEX, "打开网页预览 index.html"],
    ]);
    expect(previewCalls(page.fetchMock)).toEqual([]);
    expect(blobs.createObjectURL).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
    expect(document.querySelectorAll("iframe, img")).toHaveLength(0);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
  });

  const orderings: Array<[string, () => Snapshot, string[]]> = [
    [
      "the step of the larger ordinal wins inside one message",
      () =>
        turn("done", {
          content: "改好了",
          steps: [
            toolStep(11, 0, "edit", [edit("b.ts", 1, 0)]),
            toolStep(12, 1, "edit", [edit("b.ts", 5, 2)]),
          ],
        }),
      ["+5-2zhangsan/proj/b.ts"],
    ],
    [
      "(Q2) the later message wins and a path keeps the place of its first appearance",
      () =>
        twoTurns(
          [toolStep(11, 0, "edit", [edit("y.md", 1, 0), edit("x.md", 1, 0)])],
          [toolStep(21, 0, "edit", [edit("y.md", 4, 2), write("w.md")])],
        ),
      ["+4-2zhangsan/proj/y.md", "+1zhangsan/proj/x.md", "写入zhangsan/proj/w.md"],
    ],
    [
      "the changes of a running step are left out",
      () =>
        turn("running", {
          content: "正在改",
          steps: [
            toolStep(11, 0, "edit", [edit("done.md", 1, 0)]),
            toolStep(12, 1, "edit", [edit("done.md", 7, 0), write("pending.md")], "running"),
          ],
        }),
      ["+1zhangsan/proj/done.md"],
    ],
  ];

  it.each(orderings)("P3 %s", async (_name, snapshot, expected) => {
    await openSession(snapshot());

    const { panel } = await openPanel();

    expect(rowTexts(panel)).toEqual(expected);
    expect(panelRows(panel)).toHaveLength(expected.length);
  });

  it("P3 a path that derives no artifact has a row and 查看详情 but no action button", async () => {
    await openSession(changedTurn([write("main.py"), edit(APP, 2, 1)]));

    const { panel } = await openPanel();

    expect(rowTexts(panel)).toEqual(["写入zhangsan/proj/main.py", "+2-1zhangsan/proj/src/app.ts"]);
    expect(rowButtons(panel)).toEqual([
      ["查看详情 zhangsan/proj/main.py"],
      ["查看详情 zhangsan/proj/src/app.ts", COPY_APP],
    ]);
  });
});

describe("空态 (P4)", () => {
  const unchanged = { content: "答", steps: [toolStep(11, 0, "bash", null)] };
  const empties: Array<[string, () => Snapshot]> = [
    ["the session changed no file", () => turn("done", unchanged)],
    ["the session is bound to no workspace", () => turn("done", unchanged, null)],
  ];

  it.each(empties)("P4 only toasts 当前任务暂无产物 when %s", async (_name, snapshot) => {
    await openSession(snapshot());

    fireEvent.click(panelButton());
    await quiesce();

    expect(toasts()).toEqual([["info", "当前任务暂无产物"]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(drawer()).toBeNull();
  });

  it("P4 only toasts while the history is still being read, and opens once it arrived", async () => {
    const history = deferredResponse();
    const snapshot = editedAndWritten();
    renderChatPage(SESSION_PATH, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [WORKSPACES]: listed,
      [SESSION_MESSAGES]: () => history.promise,
    });
    await waitFor(() => expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]));
    expect(screen.queryByRole("article", { name: "助手" })).toBeNull();

    fireEvent.click(panelButton());
    await quiesce();

    expect(toasts()).toEqual([NO_ARTIFACTS]);
    expect(drawer()).toBeNull();

    await settleDeferredResponse(history, jsonResponse(snapshot));
    await screen.findByRole("article", { name: "助手" });
    await quiesce();
    expect(drawer()).toBeNull();

    const { panel } = await openPanel();

    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md", "写入zhangsan/proj/out/index.html"]);
    expect(toasts()).toEqual([NO_ARTIFACTS]);
  });

  it("P4 only toasts while the one step carrying changes still runs, and opens after its step.end", async () => {
    const steps = [toolStep(21, 0, "edit", [edit("notes/todo.md", 3, 0)], "running")];
    await openSession(turn("running", { content: "正在改", steps }));

    fireEvent.click(panelButton());
    await quiesce();

    expect(toasts()).toEqual([NO_ARTIFACTS]);
    expect(drawer()).toBeNull();

    const send = await goLive();
    send("step.end", { stepId: 21, status: "done", output: "ok" });
    const { panel } = await openPanel();

    expect(rowTexts(panel)).toEqual(["+3zhangsan/proj/notes/todo.md"]);
    expect(toasts()).toEqual([NO_ARTIFACTS]);
  });
});

describe("打开期间更新 (P5)", () => {
  it("P5 the open drawer follows step.end and later steps without reopening", async () => {
    const steps = [
      toolStep(11, 0, "edit", [edit(A_MD, 1, 0)]),
      toolStep(12, 1, "write", [write("out/new.html")], "running"),
    ];
    await openSession(turn("running", { content: "正在改", steps }));

    const { panel } = await openPanel();
    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md"]);

    const send = await goLive();
    expect(drawer()).toBe(panel);
    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md"]);

    send("step.end", { stepId: 12, status: "done", output: "ok" });

    expect(drawer()).toBe(panel);
    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md", "写入zhangsan/proj/out/new.html"]);
    expect(rowButtons(panel)[1]).toEqual([
      "查看详情 zhangsan/proj/out/new.html",
      "打开网页预览 new.html",
    ]);

    send("step.start", { stepId: 13, name: "edit", detail: '{"path":"a.md"}' });
    send("files.changed", { stepId: 13, files: [edit(A_MD, 9, 0)] });
    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md", "写入zhangsan/proj/out/new.html"]);

    send("step.end", { stepId: 13, status: "done", output: "ok" });

    expect(drawer()).toBe(panel);
    expect(rowTexts(panel)).toEqual(["+9zhangsan/proj/a.md", "写入zhangsan/proj/out/new.html"]);
    expect(toasts()).toEqual([]);
  });
});

describe("关闭与焦点 (P6)", () => {
  const closers: Array<[string, (panel: HTMLElement) => void]> = [
    ["the foot 关闭 button", (panel) => fireEvent.click(footClose(panel))],
    ["the head 关闭 icon button", (panel) => fireEvent.click(headClose(panel))],
    ["Escape", () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })],
    [
      "a press on the overlay",
      () => {
        const overlay = document.querySelector(".ui-drawer-overlay");
        if (!overlay) throw new Error("缺遮罩");
        pressPointer(overlay);
      },
    ],
  ];

  it.each(closers)(
    "P6 %s closes the drawer, returns focus to 产物面板 and it can be opened again",
    async (_name, close) => {
      await openSession(editedAndWritten());
      expect(document.activeElement).toBe(document.body);

      const { panel, trigger } = await openPanel();
      expect(panel.contains(document.activeElement)).toBe(true);
      await yieldMacrotask();

      close(panel);

      await expectPanelClosed();
      expect(document.activeElement).toBe(trigger);
      expect(screen.queryByRole("dialog")).toBeNull();

      const again = await openPanel();

      expect(again.trigger).toBe(trigger);
      expect(panelRows(again.panel)).toHaveLength(2);
    },
  );
});

describe("行操作复用 (P7)", () => {
  const dismissals: Array<[string, (preview: HTMLElement) => void]> = [
    ["Escape", () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })],
    [
      "the preview's 关闭 button",
      (preview) => fireEvent.click(within(preview).getByRole("button", { name: "关闭" })),
    ],
  ];

  it.each(dismissals)(
    "P7 the html row previews above the drawer in the sandboxed iframe; %s closes only the preview",
    async (_name, dismiss) => {
      const page = await openPreviewing([edit(A_MD, 1, 0), write(INDEX)], () =>
        textPreviewResponse(HTML_TEXT),
      );
      const { panel } = await openPanel();
      const open = panelAction(panel, OPEN_INDEX);

      fireEvent.click(open);
      const preview = await previewDialog();

      expect(
        previewCalls(page.fetchMock).map(([path, options]) => [path, options?.method]),
      ).toEqual([[`/api/workspaces/${PROJ.id}/file?path=out%2Findex.html`, "GET"]]);
      expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
      expect(drawer()).toBe(panel);
      expect(panel.contains(preview)).toBe(false);
      const frame = frameOf(preview);
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("srcdoc")).toBe(HTML_TEXT);
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
      expect(preview.contains(document.activeElement)).toBe(true);
      // Radix hands the document Escape listener from the drawer's layer to the preview's one
      // render after the preview mounted; until then the key still belongs to the drawer.
      await yieldMacrotask();

      dismiss(preview);

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "index.html" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(open));
      expect(screen.getAllByRole("dialog")).toEqual([panel]);
      expect(panelAction(panel, OPEN_INDEX)).toBe(open);
      expect(document.querySelector("iframe")).toBeNull();
      expect(previewCalls(page.fetchMock)).toHaveLength(1);
      expect(toasts()).toEqual([]);
    },
  );

  it("P7 the image row downloads through a temporary link whose Blob URL is revoked one task later", async () => {
    const page = await openPreviewing([write(CHART), write(INDEX)], () => imagePreviewResponse());
    const clicks = spyDownloads(blobs.revokeObjectURL);
    const { panel } = await openPanel();

    fireEvent.click(panelAction(panel, DOWNLOAD_CHART));
    await waitFor(() => expect(clicks).toHaveLength(1));
    await quiesce();

    expect(previewCalls(page.fetchMock).map(([path]) => path)).toEqual([previewRoute(CHART)]);
    const download = { download: "chart.PNG", href: BLOB_URL };
    expect(clicks).toEqual([{ ...download, revokedAtClick: 0, revokedNextTimer: 0 }]);
    expect(drawer()).toBe(panel);
    expect(blobs.revokeObjectURL.mock.calls).toEqual([[BLOB_URL]]);
    expect(toasts()).toEqual([]);
  });

  it("P7 the code row copies exactly the fetched text and confirms with a toast", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const page = await openPreviewing([edit(APP, 2, 1)], () => textPreviewResponse(CODE_TEXT));
    const { panel } = await openPanel();

    fireEvent.click(panelAction(panel, COPY_APP));

    await waitFor(() => expect(toasts()).toEqual([COPIED]));
    expect(writeText.mock.calls).toEqual([[CODE_TEXT]]);
    expect(previewCalls(page.fetchMock).map(([path]) => path)).toEqual([previewRoute(APP)]);
    expect(screen.getAllByRole("dialog")).toEqual([panel]);
  });

  it("P7 a failed row action toasts the envelope message, keeps the drawer open and can be retried", async () => {
    const gone = "复制代码 gone.md";
    const page = await openPreviewing([edit("gone.md", 1, 0)], () =>
      envelope(404, "not_found", "文件不存在或已被删除"),
    );
    const { panel } = await openPanel();

    fireEvent.click(panelAction(panel, gone));

    await waitFor(() => expect(toasts()).toEqual([["error", "文件不存在或已被删除"]]));
    await quiesce();
    expect(drawer()).toBe(panel);
    expect(panelAction(panel, gone).disabled).toBe(false);

    fireEvent.click(panelAction(panel, gone));

    await waitFor(() => expect(previewCalls(page.fetchMock)).toHaveLength(2));
    await waitFor(() => expect(toasts()).toHaveLength(2));
    expect(drawer()).toBe(panel);
  });

  it("P7 a pending row action disables only its own button", async () => {
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    const pending = deferredResponse();
    const snapshot = changedTurn([write(INDEX), edit(APP, 2, 1)]);
    const page = await openSession(snapshot, listed, {
      [previewRoute(INDEX)]: () => pending.promise,
      [previewRoute(APP)]: () => textPreviewResponse(CODE_TEXT),
    });
    const { panel } = await openPanel();
    const open = panelAction(panel, OPEN_INDEX);
    expect(panelActions(panel).map((button) => button.hasAttribute("disabled"))).toEqual([
      false,
      false,
    ]);

    fireEvent.click(open);
    await quiesce();

    expect(open.disabled).toBe(true);
    expect(panelAction(panel, COPY_APP).disabled).toBe(false);
    expect(previewCalls(page.fetchMock)).toHaveLength(1);

    fireEvent.click(panelAction(panel, COPY_APP));

    await waitFor(() => expect(previewCalls(page.fetchMock)).toHaveLength(2));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE_TEXT));
    expect(open.disabled).toBe(true);
    await waitFor(() => expect(toasts()).toEqual([COPIED]));
    expect(screen.queryByRole("dialog", { name: "index.html", hidden: true })).toBeNull();
  });
});

describe("关闭即 abort (P8)", () => {
  const late: Array<[string, Change, string, () => Response, string[][]]> = [
    ["an image", write(CHART), DOWNLOAD_CHART, () => imagePreviewResponse(), [[BLOB_URL]]],
    ["a text", edit(APP, 2, 1), COPY_APP, () => textPreviewResponse(CODE_TEXT), []],
  ];

  it.each(late)(
    "P8 closing the drawer aborts the pending row request and %s answer arriving later has no effect",
    async (_kind, change, name, response, revoked) => {
      const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
      const pending = deferredResponse();
      const page = await openPreviewing([change], () => pending.promise);
      const clicks = spyDownloads(blobs.revokeObjectURL);
      const { panel } = await openPanel();

      fireEvent.click(panelAction(panel, name));
      await quiesce();
      const signal = previewSignal(page.fetchMock);
      expect(signal.aborted).toBe(false);

      fireEvent.click(footClose(panel));
      await expectPanelClosed();

      expect(signal.aborted).toBe(true);

      await settleDeferredResponse(pending, response());
      await quiesce();

      expect(blobs.revokeObjectURL.mock.calls).toEqual(revoked);
      expect(clicks).toEqual([]);
      expect(writeText).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
      expect(previewCalls(page.fetchMock)).toHaveLength(1);
    },
  );
});

describe("空间不可解析 (P9)", () => {
  /** Both rows show the workspace-relative path only: no 查看详情, no artifact action, no toast. */
  function expectRelativeRows(panel: HTMLElement) {
    expect(rowTexts(panel)).toEqual(["+1a.md", "写入out/index.html"]);
    expect(rowButtons(panel)).toEqual([[], []]);
    expect(within(panel).queryAllByRole("button", { name: DETAILS })).toEqual([]);
    expect(panelActions(panel)).toEqual([]);
    expect(toasts()).toEqual([]);
  }

  const unresolved: Array<[string, string | null, () => Response]> = [
    ["the bound workspace is not listed", UNLISTED_ID, listed],
    ["the workspace list fails", PROJ.id, () => envelope(500, "internal", "工作空间不可用")],
  ];

  it.each(unresolved)(
    "P9 opens the drawer with relative paths and no buttons in the rows when %s",
    async (_name, workspaceId, workspaces) => {
      const page = await openSession(editedAndWritten(workspaceId), workspaces);

      const { panel } = await openPanel();

      expectRelativeRows(panel);
      expect(previewCalls(page.fetchMock)).toEqual([]);
      expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
    },
  );

  it("P9 rows opened while the workspace list is loading gain logical paths and buttons once it arrives", async () => {
    const gate = deferred<void>();
    await openSession(editedAndWritten(), () => gate.promise.then(listed));

    const { panel } = await openPanel();
    expectRelativeRows(panel);

    gate.resolve();
    await quiesce();

    expect(drawer()).toBe(panel);
    expect(rowTexts(panel)).toEqual(["+1zhangsan/proj/a.md", "写入zhangsan/proj/out/index.html"]);
    expect(rowButtons(panel)).toEqual([
      [DETAILS_A, "复制代码 a.md"],
      [DETAILS_INDEX, OPEN_INDEX],
    ]);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
  });
});

describe("会话归属 (P10)", () => {
  it("P10/Q4 routing to another session closes the drawer with focus back on 产物面板, and routing back does not reopen it", async () => {
    const snapshot = editedAndWritten();
    const page = await openSession(snapshot, listed, withOtherSession(snapshot));
    const { panel } = await openPanel();

    await routeToOtherSession(page.router);

    await waitFor(() => expect(document.activeElement).toBe(panelButton()));
    expect(drawer()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panel.isConnected).toBe(false);

    await routeBack(page.router);
    await yieldMacrotask();

    expect(drawer()).toBeNull();
    expect(toasts()).toEqual([]);

    const again = await openPanel();

    expect(again.panel).not.toBe(panel);
    expect(rowTexts(again.panel)).toEqual([
      "+1zhangsan/proj/a.md",
      "写入zhangsan/proj/out/index.html",
    ]);
  });

  it("P10 renewing the account closes the drawer and the renewed account's view does not reopen it", async () => {
    const getProbe = await openProbedSession(editedAndWritten());
    const { panel } = await openPanel();
    expect(panelRows(panel)).toHaveLength(2);

    await renewAccount(getProbe);

    await waitFor(() => expect(drawer()).toBeNull());
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await screen.findAllByRole("article", { name: "助手" });
    await quiesce();
    expect(drawer()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toasts()).toEqual([]);

    const again = await openPanel();

    expect(rowTexts(again.panel)).toEqual(["+1lisi/proj/a.md", "写入lisi/proj/out/index.html"]);
  });
});

describe("查看详情 (P11)", () => {
  it("P11 查看详情 in a row opens the workspace in /files and the drawer is gone", async () => {
    const tree = `${WORKSPACES}/${PROJ.id}/tree?path=`;
    const page = await openSession(editedAndWritten(), listed, {
      [tree]: () => jsonResponse({ path: "", entries: [] }),
    });
    const { panel } = await openPanel();

    fireEvent.click(panelAction(panel, DETAILS_INDEX));

    await waitFor(() => expect(currentLocation()).toBe(`/files?ws=${PROJ.id}`));
    await screen.findByRole("navigation", { name: "工作空间目录树" });
    await quiesce();
    expect(drawer()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const { pathname, search } = page.router.state.location;
    expect(`${pathname}${search}`).toBe(`/files?ws=${PROJ.id}`);
    expect(previewCalls(page.fetchMock)).toEqual([]);
  });
});

describe("产物面板 static contract (P12)", () => {
  it("P12 styles the drawer list in messages.css with the file-change card frame", () => {
    const css = stripComments(readRepoFile("web/src/features/chat/messages.css"));
    const frame = ruleBody(css, ".artifacts-panel-list");

    expect(frame).toBe(ruleBody(css, ".file-changes-card"));
    expect(frame).toContain("border: 1px solid var(--wb-border-default)");
  });

  it("P12 keeps the panel's styles out of chat.css (guard)", () => {
    expect(readRepoFile("web/src/features/chat/chat.css")).not.toContain("artifacts-panel");
  });

  it("P12 the panel module holds no fetch, iframe, clipboard or Blob URL code of its own", () => {
    const source = readRepoFile("web/src/features/chat/artifacts-panel.tsx");

    for (const word of ["fetchPreview", "sandbox", "clipboard", "createObjectURL"]) {
      expect(source, word).not.toContain(word);
    }
  });
});
