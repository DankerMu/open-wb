/**
 * Issue #968 临时空间会话的产物卡 (tasks 17.5): the turn-artifacts scenarios 「临时空间会话的文件变更卡」,
 * 「临时空间会话照常渲染产物卡」 (with its promoted half) and 「临时空间会话的面板行」.
 * Seams: the jsdom chat page over a stubbed `fetch`, the list-event connection, the two Blob URL
 * statics, `<a>.click()` and `navigator.clipboard`. Expected values are literals from the spec
 * deltas. The session uses a temporary workspace: `temporaryWorkspace` is true and its
 * `workspaceId` is in no workspace list, so every preview route is keyed by that id.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  action,
  actions,
  artifactCards,
  BLOB_URL,
  cardTitles,
  copiedStatus,
  frameOf,
  HTML_TEXT,
  previewCalls,
  previewDialog,
  slot,
  spyDownloads,
  stubClipboard,
} from "./chat-page-artifact-card-support.js";
import {
  artifactsPanelFixture,
  openPanel,
  panelAction,
  rowButtons,
} from "./chat-page-artifacts-panel-support.js";
import {
  type Change,
  cardNamed,
  detailButtons,
  edit,
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
  WORKSPACES,
  write,
} from "./chat-page-file-changes-support.js";
import { envelope } from "./chat-page-ownership-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { latestListSource, settle } from "./chat-stream-support.js";
import { imagePreviewResponse } from "./files-fixture.js";
import { calls, currentLocation, jsonResponse, textPreviewResponse } from "./support.js";

const blobs = artifactsPanelFixture();

/** The temporary workspace of the session: `listed` holds the ids of 5s and 6s only. */
const TEMP = "7c".repeat(16);
const INDEX = "out/index.html";
const CHART = "assets/chart.png";
const NOTES = "notes.md";
const NOTES_TEXT = "# 笔记\n";
const OPEN_INDEX = "打开网页预览 index.html";

const previewPath = (path: string) => `${WORKSPACES}/${TEMP}/file?path=${encodeURIComponent(path)}`;

/** A done turn of a session using the temporary workspace whose single ended step changed `changes`. */
function temporaryTurn(changes: Change[]): Snapshot {
  const snapshot = turn(
    "done",
    { content: "改好了", steps: [toolStep(11, 0, "edit", changes)] },
    TEMP,
  );
  return { ...snapshot, session: { ...snapshot.session, temporaryWorkspace: true } };
}

/** The previews of the three paths, each of its own kind. */
const previews = (): FetchRoutes => ({
  [previewPath(INDEX)]: () => textPreviewResponse(HTML_TEXT),
  [previewPath(CHART)]: () => imagePreviewResponse(),
  [previewPath(NOTES)]: () => textPreviewResponse(NOTES_TEXT),
});

/** The workspace list really answers with a failure (an envelope), it is not left pending. */
const failing = () => envelope(503, "service_unavailable", "服务暂不可用");

/** The two readings of the workspace list every scenario holds under: without TEMP, and failed. */
const lists: Array<[string, FetchRoutes[string]]> = [
  ["工作空间列表里没有它", listed],
  ["空间列表读取失败的另一例", failing],
];

/** No text or attribute names the temporary workspace's directory or any workspace root. */
function expectNoWorkspacePath() {
  expect(document.documentElement.innerHTML).not.toContain("tmp-");
  expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
}

const labels = () => artifactCards().map((card) => slot(card, "label")?.textContent);

describe("临时空间会话的文件变更卡", () => {
  it.each(lists)(
    "%s：两行只有空间内相对路径，卡里没有 查看详情，index.html 与 notes.md 的产物卡照常渲染",
    async (_name, workspaces) => {
      const page = await openSession(temporaryTurn([write(INDEX), edit(NOTES, 3, 0)]), workspaces);

      const card = cardNamed("文件变更（2 个）");
      expect(rowTexts(card)).toEqual(["写入out/index.html", "+3notes.md"]);
      expect(rowCells(card)).toEqual([
        [
          ["file-change-kind", "写入"],
          ["file-change-path", INDEX],
        ],
        [
          ["file-change-add", "+3"],
          ["file-change-path", NOTES],
        ],
      ]);
      expect(card.querySelectorAll("button")).toHaveLength(0);
      expect(detailButtons()).toEqual([]);
      expect(cardTitles()).toEqual(["index.html", "notes.md"]);
      expect(previewCalls(page.fetchMock)).toEqual([]);
      expectNoWorkspacePath();
    },
  );
});

describe("临时空间会话照常渲染产物卡", () => {
  const changes = () => [write(INDEX), write(CHART), edit(NOTES, 3, 0)];

  it.each(lists)(
    "%s：三张产物卡都在，预览、下载、复制各恰以会话的 workspaceId 请求一次",
    async (_name, workspaces) => {
      const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
      const page = await openSession(temporaryTurn(changes()), workspaces, previews());
      const clicks = spyDownloads(blobs.revokeObjectURL);

      expect(cardTitles()).toEqual(["index.html", "chart.png", "notes.md"]);
      expect(labels()).toEqual(["HTML", "PNG", "MD"]);
      expect(previewCalls(page.fetchMock)).toEqual([]);

      fireEvent.click(actions(OPEN_INDEX)[0] as HTMLButtonElement);
      const dialog = await previewDialog();
      expect(frameOf(dialog).getAttribute("sandbox")).toBe("allow-scripts");
      expect(frameOf(dialog).getAttribute("srcdoc")).toBe(HTML_TEXT);
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.click(action("下载 chart.png"));
      await waitFor(() => expect(clicks).toHaveLength(1));
      await quiesce();
      expect(clicks.map(({ href, download }) => [href, download])).toEqual([
        [BLOB_URL, "chart.png"],
      ]);

      fireEvent.click(action("复制代码 notes.md"));
      await waitFor(() => expect(copiedStatus()?.getAttribute("role")).toBe("status"));
      expect(writeText.mock.calls).toEqual([[NOTES_TEXT]]);

      expect(
        previewCalls(page.fetchMock).map(([path, options]) => [path, options?.method]),
      ).toEqual([
        [`/api/workspaces/${TEMP}/file?path=out%2Findex.html`, "GET"],
        [`/api/workspaces/${TEMP}/file?path=assets%2Fchart.png`, "GET"],
        [`/api/workspaces/${TEMP}/file?path=notes.md`, "GET"],
      ]);
      expect(detailButtons()).toEqual([]);
      expectNoWorkspacePath();
    },
  );

  it("转正后：产物卡仍在，文件变更卡的行改为逻辑路径并带 查看详情，指向该空间的文件页", async () => {
    const snapshot = temporaryTurn(changes());
    const promotedWorkspace = {
      ...PROJ,
      id: TEMP,
      name: "转正空间",
      dir: `tmp-${TEMP}`,
      root: `${ROOT_PREFIX}/u-1/tmp-${TEMP}`,
    };
    let promoted = false;
    const tree = `${WORKSPACES}/${TEMP}/tree?path=`;
    const page = await openSession(
      snapshot,
      () => jsonResponse({ workspaces: promoted ? [PROJ, promotedWorkspace] : [PROJ] }),
      {
        "/api/sessions": () =>
          jsonResponse({
            sessions: [{ ...snapshot.session, temporaryWorkspace: !promoted }],
          }),
        [tree]: () => jsonResponse({ path: "", entries: [] }),
      },
    );
    expect(cardTitles()).toEqual(["index.html", "chart.png", "notes.md"]);
    expect(detailButtons()).toEqual([]);

    // 服务端原地转正后发 `sessions.changed`：会话列表与工作空间列表各重取一次。
    promoted = true;
    await act(async () => {
      latestListSource().emitNamed("sessions.changed", "{}");
      await settle();
    });

    const prefix = `zhangsan/tmp-${TEMP}`;
    await waitFor(() =>
      expect(rowTexts(cardNamed("文件变更（3 个）"))).toEqual([
        `写入${prefix}/out/index.html`,
        `写入${prefix}/assets/chart.png`,
        `+3${prefix}/notes.md`,
      ]),
    );
    expect(detailButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      `查看详情 ${prefix}/out/index.html`,
      `查看详情 ${prefix}/assets/chart.png`,
      `查看详情 ${prefix}/notes.md`,
    ]);
    expect(cardTitles()).toEqual(["index.html", "chart.png", "notes.md"]);
    expect(labels()).toEqual(["HTML", "PNG", "MD"]);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);

    fireEvent.click(detailButtons()[0] as HTMLElement);

    await waitFor(() => expect(currentLocation()).toBe(`/files?ws=${TEMP}`));
    await screen.findByRole("navigation", { name: "工作空间目录树" });
    await quiesce();
    expect(calls(page.fetchMock, tree)).not.toHaveLength(0);
  });
});

describe("临时空间会话的面板行", () => {
  it("恰两行，只有空间内相对路径、没有 查看详情；index.html 一行以会话的 workspaceId 打开预览，main.py 一行没有操作按钮", async () => {
    const page = await openSession(
      temporaryTurn([write(INDEX), edit("main.py", 2, 0)]),
      listed,
      previews(),
    );

    const { panel } = await openPanel();

    expect(rowCells(panel)).toEqual([
      [
        ["file-change-kind", "写入"],
        ["file-change-path", INDEX],
      ],
      [
        ["file-change-add", "+2"],
        ["file-change-path", "main.py"],
      ],
    ]);
    expect(rowButtons(panel)).toEqual([[OPEN_INDEX], []]);
    expect(previewCalls(page.fetchMock)).toEqual([]);
    expectNoWorkspacePath();

    fireEvent.click(panelAction(panel, OPEN_INDEX));
    const dialog = await previewDialog();

    expect(frameOf(dialog).getAttribute("sandbox")).toBe("allow-scripts");
    expect(frameOf(dialog).getAttribute("srcdoc")).toBe(HTML_TEXT);
    expect(previewCalls(page.fetchMock).map(([path, options]) => [path, options?.method])).toEqual([
      [`/api/workspaces/${TEMP}/file?path=out%2Findex.html`, "GET"],
    ]);
  });
});
