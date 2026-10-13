/**
 * Issue #968 临时空间会话的产物卡 (tasks 17.5): the turn-artifacts scenarios 「临时空间会话的文件变更卡」
 * and 「临时空间会话照常渲染产物卡」 (with its promoted half); 「临时空间会话的面板行」 was removed with
 * the panel it described (#1105).
 * Seams: the jsdom chat page over a stubbed `fetch`, the list-event connection, the two Blob URL
 * statics and `navigator.clipboard`. Expected values are literals from the spec
 * deltas. The session uses a temporary workspace: `temporaryWorkspace` is true and its
 * `workspaceId` is in no workspace list, so every route is keyed by that id. Since #1110 only the
 * code card asks the preview API: 打开网页预览 opens the sidebar on that id (its token is issued for
 * it) and 下载 is a link to that id's download endpoint.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  action,
  actions,
  artifactCards,
  cardTitles,
  copiedStatus,
  link,
  previewCalls,
  siteRoutes,
  slot,
  stubClipboard,
} from "./chat-page-artifact-card-support.js";
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
import { chatShellFixture } from "./chat-page-shell-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { latestListSource, SESSION_ID, settle } from "./chat-stream-support.js";
import { imagePreviewResponse } from "./files-fixture.js";
import { BASE } from "./files-site-fixture.js";
import { calls, currentLocation, jsonResponse, textPreviewResponse } from "./support.js";

const blobs = chatShellFixture();

/** The temporary workspace of the session: `listed` holds the ids of 5s and 6s only. */
const TEMP = "7c".repeat(16);
const INDEX = "out/index.html";
const CHART = "assets/chart.png";
const NOTES = "notes.md";
const NOTES_TEXT = "# 笔记\n";
/** `notes.md` as the root listing of the temporary workspace holds it. */
const NOTES_ENTRY = { name: NOTES, type: "file", size: 4, mtime: 1 };
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

const TOKEN_PATH = `${WORKSPACES}/${TEMP}/preview-token`;

/**
 * What the three actions may ask of TEMP: the sidebar's two listings and its preview token
 * (`siteRoutes`), and the preview of `notes.md`. The previews of the page and of the image answer
 * too, so a card that still asked for one would be caught by the request list, not by a thrown fetch.
 */
const previews = (): FetchRoutes => ({
  ...siteRoutes(TEMP),
  [previewPath(INDEX)]: () => textPreviewResponse("<h1>hi</h1>"),
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

/** The title in the head of the workspace sidebar (the tree column has a heading of its own). */
const sidebarTitle = (sidebar: HTMLElement) =>
  sidebar.querySelector('[data-slot="workspace-sidebar-head"] h2')?.textContent;

const detailNames = () => detailButtons().map((button) => button.getAttribute("aria-label"));
/** 查看详情 of the three paths while the workspace is in no list: named by the relative path. */
const RELATIVE_DETAILS = [`查看详情 ${INDEX}`, `查看详情 ${CHART}`, `查看详情 ${NOTES}`];

describe("临时空间会话的文件变更卡", () => {
  it.each(lists)(
    "%s：两行只有空间内相对路径，各带以相对路径为名的 查看详情（点它在原地打开侧边栏并选中），index.html 与 notes.md 的产物卡照常渲染",
    async (_name, workspaces) => {
      const tree = `${WORKSPACES}/${TEMP}/tree?path=`;
      const page = await openSession(temporaryTurn([write(INDEX), edit(NOTES, 3, 0)]), workspaces, {
        [tree]: () => jsonResponse({ path: "", entries: [NOTES_ENTRY] }),
        [previewPath(NOTES)]: () => textPreviewResponse(NOTES_TEXT),
      });

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
      expect(
        [...card.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
      ).toEqual(RELATIVE_DETAILS.filter((name) => !name.endsWith(CHART)));
      expect(detailButtons()).toEqual([...card.querySelectorAll("button")]);
      expect(cardTitles()).toEqual(["index.html", "notes.md"]);
      expect(previewCalls(page.fetchMock)).toEqual([]);
      expectNoWorkspacePath();

      fireEvent.click(detailButtons()[1] as HTMLElement);

      const sidebar = await screen.findByRole("complementary", { name: "工作空间侧边栏" });
      const row = await within(sidebar).findByRole("button", { name: NOTES });
      await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
      expect(sidebarTitle(sidebar)).toBe("工作空间");
      expect(within(sidebar).queryByRole("link", { name: "在文件页打开" })).toBeNull();
      expect(calls(page.fetchMock, tree)).toHaveLength(1);
      expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
      expectNoWorkspacePath();
    },
  );
});

describe("临时空间会话照常渲染产物卡", () => {
  const changes = () => [write(INDEX), write(CHART), edit(NOTES, 3, 0)];

  it.each(lists)(
    "%s：三张产物卡都在；打开网页预览 打开头部为 工作空间 的侧边栏并以会话的 workspaceId 签发一次令牌，下载 是指向该 id 下载端点的链接，只有 复制代码 请求预览（恰一次）",
    async (_name, workspaces) => {
      const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
      const page = await openSession(temporaryTurn(changes()), workspaces, previews());

      expect(cardTitles()).toEqual(["index.html", "chart.png", "notes.md"]);
      expect(labels()).toEqual(["HTML", "PNG", "MD"]);
      expect(previewCalls(page.fetchMock)).toEqual([]);

      fireEvent.click(actions(OPEN_INDEX)[0] as HTMLButtonElement);
      const sidebar = await screen.findByRole("complementary", { name: "工作空间侧边栏" });
      const row = await within(sidebar).findByRole("button", { name: "index.html" });
      await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
      await waitFor(() =>
        expect(sidebar.querySelector("iframe")?.getAttribute("src")).toBe(`${BASE}${INDEX}`),
      );
      expect(sidebarTitle(sidebar)).toBe("工作空间");
      expect(within(sidebar).queryByRole("link", { name: "在文件页打开" })).toBeNull();
      expect(document.querySelector("iframe[srcdoc]")).toBeNull();
      expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
      expect(
        calls(page.fetchMock, TOKEN_PATH).map(([path, options]) => [path, options?.method]),
      ).toEqual([[TOKEN_PATH, "POST"]]);
      expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);

      // The sidebar's preview head has a 下载 link of its own (of index.html): `link` reads the card's.
      const download = link("下载 chart.png");
      expect(download.getAttribute("href")).toBe(
        `/api/workspaces/${TEMP}/download?path=assets%2Fchart.png`,
      );
      expect(download.hasAttribute("download")).toBe(true);
      download.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(download);
      await quiesce();
      expect(blobs.createObjectURL).not.toHaveBeenCalled();

      fireEvent.click(action("复制代码 notes.md"));
      await waitFor(() => expect(copiedStatus()?.getAttribute("role")).toBe("status"));
      expect(writeText.mock.calls).toEqual([[NOTES_TEXT]]);

      expect(
        previewCalls(page.fetchMock).map(([path, options]) => [path, options?.method]),
      ).toEqual([[`/api/workspaces/${TEMP}/file?path=notes.md`, "GET"]]);
      expect(calls(page.fetchMock, TOKEN_PATH)).toHaveLength(1);
      expect(detailNames()).toEqual(RELATIVE_DETAILS);
      expectNoWorkspacePath();
    },
  );

  it("转正后：产物卡仍在，文件变更卡的行与 查看详情 的名字改为逻辑路径，点它仍是在原地打开侧边栏（头部是空间名并有 在文件页打开），不去文件页", async () => {
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
        [tree]: () => jsonResponse({ path: "", entries: [NOTES_ENTRY] }),
        [previewPath(NOTES)]: () => textPreviewResponse(NOTES_TEXT),
      },
    );
    expect(cardTitles()).toEqual(["index.html", "chart.png", "notes.md"]);
    expect(detailNames()).toEqual(RELATIVE_DETAILS);

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
    expect(detailNames()).toEqual([
      `查看详情 ${prefix}/out/index.html`,
      `查看详情 ${prefix}/assets/chart.png`,
      `查看详情 ${prefix}/notes.md`,
    ]);
    expect(cardTitles()).toEqual(["index.html", "chart.png", "notes.md"]);
    expect(labels()).toEqual(["HTML", "PNG", "MD"]);
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);

    fireEvent.click(detailButtons()[2] as HTMLElement);

    const sidebar = await screen.findByRole("complementary", { name: "工作空间侧边栏" });
    const row = await within(sidebar).findByRole("button", { name: NOTES });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
    await quiesce();
    expect(sidebarTitle(sidebar)).toBe("转正空间");
    expect(within(sidebar).getByRole("link", { name: "在文件页打开" })).toBeTruthy();
    expect(calls(page.fetchMock, tree)).toHaveLength(1);
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
  });
});
