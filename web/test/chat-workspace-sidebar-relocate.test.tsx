/**
 * Issue #1380 侧边栏拿实际选中，再点同一张卡片重新定位（s1-followups-batch 11b.2）：workspace-sidebar
 * 「从卡片定位到文件」的场景「实际选中与再次点击」，以及同一条需求里 `打开网页预览` 的再次点击。接缝：
 * 真实外壳里的整页（桩掉的 `fetch` 与事件连接），事件经假的事件连接推入；请求取自 `fetch` 桩的调用
 * 记录。期望值是规格里的字面量。
 *
 * 定位落空之后预览区的空态（`未选择文件`、没有 `文件不存在`）由 #1372 做到，这里沿用并照样断言；本文件
 * 要证的是 `在文件页打开` 的地址取实际选中，以及同一行再点一次会重新定位。
 */
import { pagePrompts } from "./page-notices.js";
import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  actions,
  changedTurn,
  INDEX,
  OPEN_INDEX,
  siteRoutes,
} from "./chat-page-artifact-card-support.js";
import {
  type Change,
  goLive,
  listed,
  openSession,
  PROJ,
  toolStep,
  turn,
  write,
} from "./chat-page-file-changes-support.js";
import { cleanupSessionMeta, crumb } from "./chat-page-session-meta-support.js";
import { SESSION_ID } from "./chat-stream-support.js";
import {
  dir,
  file,
  fileOf,
  listing,
  NAME,
  OPEN_IN_FILES,
  openChanges,
  rowNames,
  settled,
  sidebarHead,
  treeOf,
  treeRequests,
} from "./chat-workspace-sidebar-support.js";
import { BASE } from "./files-site-fixture.js";
import {
  currentLocation,
  type FetchMock,
  jsonResponse,
  paths,
  textPreviewResponse,
} from "./support.js";

const ONLY = "只看本会话改动";
const NO_CHANGES = "本会话暂无文件改动";
const EMPTY = "未选择文件";
const MISSING = "文件不存在";
/** 服务端 `not_found` 信封的文案。 */
const NOT_FOUND = "请求的资源不存在";
const SESSION = `/?session=${SESSION_ID}`;
const ROOT = treeOf(PROJ.id);
const OUT = treeOf(PROJ.id, "out");
const README = fileOf(PROJ.id, "readme.md");
const FILES_PAGE = `/files?ws=${PROJ.id}`;

afterEach(cleanupSessionMeta);

type Send = Awaited<ReturnType<typeof goLive>>;

/** 一条回合（状态 `status`），唯一的已结束步骤（id 1）改了 `changes`。 */
const changed = (status: "done" | "running", ...changes: Change[]) =>
  turn(status, { content: "改好了", steps: [toolStep(1, 0, "write", changes)] });

/** 一个从开始到结束的步骤，`files.changed` 在 `step.end` 之前（服务端的次序）。 */
function endedStep(send: Send, stepId: number, ...files: Change[]) {
  send("step.start", {
    stepId,
    name: "write",
    detail: "write args",
    bodyOffset: 3,
    approvalId: null,
  });
  send("files.changed", { stepId, files });
  send("step.end", { stepId, status: "done", output: "ok" });
}

const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole<HTMLButtonElement>("button", { name });

const pane = (scope: HTMLElement) => within(scope).getByRole("region", { name: "文件预览" });

function previewShows(scope: HTMLElement, body: string) {
  return waitFor(() => expect(pane(scope).textContent).toContain(body));
}

function selectedRows(scope: HTMLElement) {
  return [...scope.querySelectorAll('button[aria-current="true"]')].map(
    (row) => row.querySelector('[data-slot="tree-name"]')?.textContent,
  );
}

function fileRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.startsWith(`/api/workspaces/${PROJ.id}/file?`));
}

const openInFiles = (scope: HTMLElement) =>
  within(sidebarHead(scope)).getByRole("link", { name: OPEN_IN_FILES }).getAttribute("href");

/** `path` 那一行的 `查看详情`：每次现取，两次点的是同一行的那个按钮。 */
function clickDetail(path: string) {
  const opener = screen.getByRole("button", { name: `查看详情 zhangsan/proj/${path}` });
  opener.focus();
  fireEvent.click(opener);
}

/** 没有选中的行，预览区是 `未选择文件`；页面上没有 `文件不存在`、没有服务端的不存在文案、没有 Toast。 */
function expectCleared(scope: HTMLElement) {
  expect(selectedRows(scope)).toStrictEqual([]);
  expect(within(pane(scope)).getByText(EMPTY, { exact: true })).toBeTruthy();
  expect(pane(scope).querySelector('[data-slot="preview-header"]')).toBeNull();
  expect(screen.queryByText(MISSING)).toBeNull();
  expect(screen.queryByText(NOT_FOUND)).toBeNull();
  // 整页范围：除会话与回合的状态标记外，没有任何 alert 或 status。
  expect(pagePrompts()).toEqual([]);
}

/** 侧边栏开着、选中了 `readme.md`：`在文件页打开` 带着它。 */
async function withReadme(region: HTMLElement) {
  fireEvent.click(button(region, "readme.md"));
  await previewShows(region, "自述正文");
  await waitFor(() => expect(openInFiles(region)).toBe(`${FILES_PAGE}&path=readme.md`));
}

describe("实际选中与再次点击", () => {
  it("L1 开关关着、已选中 readme.md，点已被删除的 out/gone.md 的 查看详情：没有选中、预览区是 未选择文件，在文件页打开 不带 path；助手重新写出它、out 一层随之刷新后选中不自己回来，再点同一行才重新定位并选中它、显示预览，在文件页打开 带 path=out%2Fgone.md；地址始终只有会话", async () => {
    const GONE = fileOf(PROJ.id, "out/gone.md");
    const disk = { exists: false };
    const { fetchMock, region } = await openChanges(changed("running", write("out/gone.md")), {
      [ROOT]: listing("", [dir("out"), file("readme.md")]),
      [OUT]: () =>
        jsonResponse({
          path: "out",
          entries: disk.exists ? [file("b.md"), file("gone.md")] : [file("b.md")],
        }),
      [GONE]: () => textPreviewResponse("重写的正文"),
    });
    const send = await goLive();
    await withReadme(region);

    clickDetail("out/gone.md");

    await waitFor(() => expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]));
    await waitFor(() => expect(pane(region).textContent).not.toContain("自述正文"));
    await settled();
    expectCleared(region);
    expect(rowNames(region)).toStrictEqual(["项目", "out", "b.md", "readme.md"]);
    expect(openInFiles(region)).toBe(FILES_PAGE);
    expect(fileRequests(fetchMock)).toStrictEqual([README]);

    // 助手重新写出它：步骤结束的局部刷新（300 毫秒的合并窗口之后）重列根与 `out`，行出现。
    disk.exists = true;
    endedStep(send, 2, write("out/gone.md"));
    await waitFor(() => expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT, ROOT, OUT]));
    expect(await within(region).findByRole("button", { name: "gone.md" })).toBeTruthy();
    await settled();
    // 刷新本身不选中它，地址也不带它。
    expect(selectedRows(region)).toStrictEqual([]);
    expect(openInFiles(region)).toBe(FILES_PAGE);
    expect(fileRequests(fetchMock)).toStrictEqual([README]);

    clickDetail("out/gone.md");

    await previewShows(region, "重写的正文");
    await waitFor(() => expect(openInFiles(region)).toBe(`${FILES_PAGE}&path=out%2Fgone.md`));
    await settled();
    expect(selectedRows(region)).toStrictEqual(["gone.md"]);
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(fileRequests(fetchMock)).toStrictEqual([README, GONE]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT, ROOT, OUT]);
    expect(currentLocation()).toBe(SESSION);
  });

  it("L2 开关开着、根的列表里没有 old.md：点它的 查看详情 之后 在文件页打开 不带被定位的路径", async () => {
    const { fetchMock, region } = await openChanges(changed("done", write("old.md")), {
      [ROOT]: listing("", [file("readme.md")]),
    });
    await withReadme(region);
    fireEvent.click(button(region, ONLY));
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    expect(within(region).getByText(NO_CHANGES, { exact: true })).toBeTruthy();
    // 开关不动选中：地址仍带着 readme.md。
    expect(openInFiles(region)).toBe(`${FILES_PAGE}&path=readme.md`);

    clickDetail("old.md");

    await waitFor(() => expect(pane(region).textContent).not.toContain("自述正文"));
    await settled();
    expectCleared(region);
    expect(openInFiles(region)).toBe(FILES_PAGE);
    expect(fileRequests(fetchMock)).toStrictEqual([README]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
  });

  it("L3 开关开着时定位落空，其后 old.md 被建出：关掉开关、点 刷新（根的列表读到它）之后再点同一行，选中它并显示预览，在文件页打开 带 path=old.md", async () => {
    const OLD = fileOf(PROJ.id, "old.md");
    const disk = { exists: false };
    const { fetchMock, region } = await openChanges(changed("done", write("old.md")), {
      [ROOT]: () =>
        jsonResponse({
          path: "",
          entries: disk.exists ? [file("old.md"), file("readme.md")] : [file("readme.md")],
        }),
      [OLD]: () => textPreviewResponse("重建的正文"),
    });
    fireEvent.click(button(region, ONLY));
    clickDetail("old.md");
    await settled();
    expectCleared(region);
    expect(openInFiles(region)).toBe(FILES_PAGE);

    disk.exists = true;
    fireEvent.click(button(region, ONLY));
    fireEvent.click(button(region, "刷新"));
    expect(await within(region).findByRole("button", { name: "old.md" })).toBeTruthy();
    await settled();
    expect(selectedRows(region)).toStrictEqual([]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);

    clickDetail("old.md");

    await previewShows(region, "重建的正文");
    await waitFor(() => expect(openInFiles(region)).toBe(`${FILES_PAGE}&path=old.md`));
    await settled();
    expect(selectedRows(region)).toStrictEqual(["old.md"]);
    expect(fileRequests(fetchMock)).toStrictEqual([OLD]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, ROOT]);
  });
});

describe("打开网页预览 的再次点击", () => {
  it("L4 out 的列表里没有 index.html 时点 打开网页预览：没有选中、在文件页打开 不带 path；它被建出、刷新 之后再点同一个按钮，选中它并显示渲染视图的框，在文件页打开 带 path=out%2Findex.html", async () => {
    const disk = { exists: false };
    const { fetchMock } = await openSession(changedTurn([write(INDEX)]), listed, {
      ...siteRoutes(),
      [OUT]: () => jsonResponse({ path: "out", entries: disk.exists ? [file("index.html")] : [] }),
    });
    await crumb("saved title");
    const [head] = actions(OPEN_INDEX);
    if (!head) throw new Error("html 产物卡应有 打开网页预览");

    head.focus();
    fireEvent.click(head);

    const region = await screen.findByRole("complementary", { name: NAME });
    await waitFor(() => expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]));
    await settled();
    expectCleared(region);
    expect(pane(region).querySelector("iframe")).toBeNull();
    expect(openInFiles(region)).toBe(FILES_PAGE);

    disk.exists = true;
    fireEvent.click(button(region, "刷新"));
    expect(await within(region).findByRole("button", { name: "index.html" })).toBeTruthy();
    await settled();
    expect(selectedRows(region)).toStrictEqual([]);

    fireEvent.click(head);

    await waitFor(() => expect(selectedRows(region)).toStrictEqual(["index.html"]));
    await waitFor(() =>
      expect(pane(region).querySelector("iframe")?.getAttribute("src")).toBe(
        `${BASE}out/index.html`,
      ),
    );
    await waitFor(() => expect(openInFiles(region)).toBe(`${FILES_PAGE}&path=out%2Findex.html`));
    await settled();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT, ROOT, OUT]);
    expect(currentLocation()).toBe(SESSION);
  });
});
