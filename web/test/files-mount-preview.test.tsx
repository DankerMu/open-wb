/**
 * s1b-workspace-mounts 任务 10.3：file-previewers「挂载内文件不签发」（「隔离来源的嵌入与令牌」「PDF 与办公文档」
 * 的挂载内部分）与 files-web「挂载内文件交给预览区的标记」（文件页与会话页侧边栏各一例）。
 *
 * 接缝：文件页与会话页侧边栏的真实外壳（桩掉的 `fetch`）。「在挂载内」是 `WorkspaceBrowser` 交给预览区的输入，
 * 从外面看就是它的后果：为真时预览区是固定文案、没有 `iframe`、零 `issuePreviewToken`；为假时照常签发并建
 * `iframe`。期望值是规格里的字面量（文案、`src` = `base` + 路径、下载地址 `…/download?path=` 整段编码）。
 * 假定时器只换 `setTimeout` / `clearTimeout` / `Date`，并随真实时间走（`findBy…` 照常轮询），停留的六分钟由
 * `advanceTimersByTimeAsync` 一次跨过（同 `previewers-frame-refetch.test.tsx`）。
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import {
  fileOf,
  listing,
  mountSidebarPage,
  openSidebar,
  treeOf,
  W1,
} from "./chat-workspace-sidebar-support.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  type FetchRoutes,
  imagePreviewResponse,
  renderFiles,
  stubBlobUrls,
  workspace,
} from "./files-fixture.js";
import { rowIn } from "./files-ops-support.js";
import { BASE, issued } from "./files-site-fixture.js";
import { calls, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const API = "/api/workspaces/workspace-1";
const TREE = `${API}/tree?path=`;
const FILE = `${API}/file?path=`;
const ISSUE = `${API}/preview-token`;
const MOUNTS = `${API}/mounts`;
const DOWNLOAD = `${API}/download?path=`;
const ROOT = "设计文档";
const MOUNT = "远端";
const IN_MOUNT = "挂载目录内的文件暂不支持预览，请下载查看";
const TOO_LARGE = "文件过大，无法预览";
const NO_CONVERTER = "服务器未启用文档转换，请下载后查看";
/** 150 MB，大于签发应答里的 `documentMaxBytes`（104857600）。 */
const HUGE = 157_286_400;
const MOUNT_SOURCE = "<h1>远端首页</h1>";

const dir = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
const file = (name: string, size = 2_097_152) => ({ name, type: "file", size, mtime: 200 });
const tree = (path: string, entries: unknown[]) => () => jsonResponse({ path, entries });
const remote = {
  id: "m-1",
  name: MOUNT,
  backend: "sftp",
  host: "files.intra",
  port: null,
  remotePath: "/data",
  sourceId: null,
  sourceName: null,
  readOnly: false,
  status: "online",
  createdAt: 1_760_000_000_000,
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await cleanupSessionMeta();
});

/**
 * 文件页：根下目录 `site`（`index.html`）、普通目录 `远端2`（`doc.pdf`）与 `doc.pdf`；挂载 `远端` 里是 `site`
 * （`index.html`）、`doc.pdf`、`plan.docx`、150 MB 的 `huge.pdf`、`notes.md` 与 `logo.png`。签发应答的
 * `officeAvailable` 为 false。`extra` 顶掉同名的路由，`at` 是进入的地址。
 */
function openPage(extra: FetchRoutes = {}, at = "/files?ws=workspace-1") {
  const page = renderFiles(
    at,
    authenticatedFilesRoutes([workspace], {
      [MOUNTS]: () => jsonResponse({ enabled: true, mounts: [remote] }),
      [TREE]: tree("", [dir("site"), dir("远端2"), file("doc.pdf")]),
      [`${TREE}site`]: tree("site", [file("index.html", 52)]),
      [`${TREE}${encodeURIComponent("远端2")}`]: tree("远端2", [file("doc.pdf")]),
      [`${TREE}${encodeURIComponent(MOUNT)}`]: tree(MOUNT, [
        dir("site"),
        file("doc.pdf"),
        file("huge.pdf", HUGE),
        file("logo.png", 8),
        file("notes.md", 9),
        file("plan.docx", 4096),
      ]),
      [`${TREE}${encodeURIComponent(`${MOUNT}/site`)}`]: tree(`${MOUNT}/site`, [
        file("index.html", 30),
      ]),
      [`${FILE}${encodeURIComponent(`${MOUNT}/site/index.html`)}`]: () =>
        textPreviewResponse(MOUNT_SOURCE),
      [`${FILE}${encodeURIComponent(`${MOUNT}/notes.md`)}`]: () =>
        textPreviewResponse("# 远端说明"),
      [`${FILE}${encodeURIComponent(`${MOUNT}/logo.png`)}`]: () => imagePreviewResponse(8),
      [ISSUE]: () => issued(),
      ...extra,
    }),
  );
  const count = (path: string) => calls(page.fetchMock, path).length;
  const fileRequests = () =>
    page.fetchMock.mock.calls.map(([path]) => path).filter((path) => path.startsWith(FILE));
  return { ...page, issues: () => count(ISSUE), fileRequests };
}

function previewRegion(scope: HTMLElement = document.body) {
  return within(within(scope).getByRole("region", { name: "文件预览" }));
}

/** 展开 `directory`（根下或挂载根行），等它的条目出现。 */
async function expand(directory: string, scope: HTMLElement = document.body) {
  fireEvent.click(await within(scope).findByRole("button", { name: `展开 ${directory}` }));
  await within(scope).findByRole("button", { name: `折叠 ${directory}` });
}

/** 目录行或挂载根行 `name`（已展开）所在的 `<li>`：空间根的不含挂载根行，它们是它的兄弟。 */
function itemOf(name: string) {
  return screen.getByRole("button", { name: `折叠 ${name}` }).closest("li") as HTMLElement;
}

/** 点 `directory` 直属的 `name` 一行，等预览头显示 `path`。 */
async function choose(directory: string, name: string, path: string, scope?: HTMLElement) {
  await waitFor(() => rowIn(directory, name));
  fireEvent.click(rowIn(directory, name));
  await waitFor(() => expect(previewRegion(scope).getByText(path, { exact: true })).toBeTruthy());
}

/** 预览区是挂载内的固定文案：没有过大 / 转换未启用文案、没有 iframe，预览头有该文件的下载链接。 */
async function expectRefused(path: string, scope?: HTMLElement, download = `${DOWNLOAD}`) {
  const region = previewRegion(scope);
  expect((await region.findByText(IN_MOUNT)).textContent).toBe(IN_MOUNT);
  expect(region.queryByText(TOO_LARGE)).toBeNull();
  expect(region.queryByText(NO_CONVERTER)).toBeNull();
  expect(document.querySelector("iframe")).toBeNull();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const link = region.getByRole("link", { name: `下载 ${name}` });
  expect(link.getAttribute("href")).toBe(`${download}${encodeURIComponent(path)}`);
}

async function shownFrame(name: string) {
  return waitFor(() => {
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("title")).toBe(name);
    return frame as HTMLIFrameElement;
  });
}

describe("挂载内文件不签发（file-previewers）", () => {
  it("挂载内的网页、PDF、办公文档（转换未启用）与 150 MB 的 PDF 都显示固定文案、没有 iframe、有下载链接；停留 6 分钟零签发；查看源码恰一次 file；随后根下的 site/index.html 恰一次签发并建 iframe", {
    timeout: 20_000,
  }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const page = openPage();
    await expand(MOUNT);
    await expand("site", itemOf(MOUNT));

    await choose("site", "index.html", `${MOUNT}/site/index.html`);
    await expectRefused(`${MOUNT}/site/index.html`);
    expect(previewRegion().getByRole("button", { name: "查看源码" })).toBeTruthy();
    for (const name of ["doc.pdf", "plan.docx", "huge.pdf"]) {
      await choose(MOUNT, name, `${MOUNT}/${name}`);
      await expectRefused(`${MOUNT}/${name}`);
    }
    // 再点同一行与 `刷新`：被挡下的预览不签发。
    fireEvent.click(rowIn(MOUNT, "huge.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await expectRefused(`${MOUNT}/huge.pdf`);

    await act(() => vi.advanceTimersByTimeAsync(360_000));
    expect(page.issues()).toBe(0);
    expect(page.fileRequests()).toStrictEqual([]);

    await choose("site", "index.html", `${MOUNT}/site/index.html`);
    await expectRefused(`${MOUNT}/site/index.html`);
    fireEvent.click(previewRegion().getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: MOUNT_SOURCE })).toBeTruthy();
    expect(
      previewRegion()
        .getAllByRole("row")
        .map((row) =>
          within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent),
        ),
    ).toStrictEqual([["1", MOUNT_SOURCE]]);
    expect(page.fileRequests()).toStrictEqual([
      `${FILE}${encodeURIComponent(`${MOUNT}/site/index.html`)}`,
    ]);
    expect(page.issues()).toBe(0);

    // 先收起挂载里的 `site`：两个 `site` 都展开时按名字找不出是哪一个。
    fireEvent.click(screen.getByRole("button", { name: "折叠 site" }));
    await expand("site", itemOf(ROOT));
    await choose("site", "index.html", "site/index.html");
    expect((await shownFrame("index.html")).getAttribute("src")).toBe(`${BASE}site/index.html`);
    expect(page.issues()).toBe(1);
    expect(previewRegion().queryByText(IN_MOUNT)).toBeNull();
  });

  it("挂载内的 Markdown 与图片照常经 file 预览", async () => {
    stubBlobUrls(["blob:remote-logo"]);
    const page = openPage();
    await expand(MOUNT);

    await choose(MOUNT, "notes.md", `${MOUNT}/notes.md`);
    expect(
      await previewRegion().findByRole("heading", { level: 1, name: "远端说明" }),
    ).toBeTruthy();
    await choose(MOUNT, "logo.png", `${MOUNT}/logo.png`);
    await waitFor(() =>
      expect(previewRegion().getByRole("img").getAttribute("src")).toBe("blob:remote-logo"),
    );

    expect(page.fileRequests()).toStrictEqual([
      `${FILE}${encodeURIComponent(`${MOUNT}/notes.md`)}`,
      `${FILE}${encodeURIComponent(`${MOUNT}/logo.png`)}`,
    ]);
    expect(previewRegion().queryByText(IN_MOUNT)).toBeNull();
    expect(page.issues()).toBe(0);
  });
});

describe("挂载内文件交给预览区的标记（files-web）", () => {
  it("文件页：远端/doc.pdf 在挂载内（固定文案、零签发）；根下 doc.pdf 与普通目录 远端2 下的 远端2/doc.pdf 不在（签发并建 iframe）", async () => {
    const page = openPage();
    await expand(MOUNT);
    await expand("远端2");

    await choose(MOUNT, "doc.pdf", `${MOUNT}/doc.pdf`);
    await expectRefused(`${MOUNT}/doc.pdf`);
    expect(page.issues()).toBe(0);

    await choose(ROOT, "doc.pdf", "doc.pdf");
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(`${BASE}doc.pdf`);
    await choose("远端2", "doc.pdf", "远端2/doc.pdf");
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(
      `${BASE}${encodeURIComponent("远端2")}/doc.pdf`,
    );
    expect(page.issues()).toBe(1);
  });

  it("会话页侧边栏：同样三处，只有 远端/doc.pdf 在挂载内", async () => {
    const id = W1.id;
    const { fetchMock } = await mountSidebarPage(undefined, {
      [`/api/workspaces/${id}/mounts`]: () => jsonResponse({ enabled: true, mounts: [remote] }),
      [treeOf(id)]: listing("", [dir("远端2"), file("doc.pdf"), file("readme.md", 4)]),
      [treeOf(id, MOUNT)]: listing(MOUNT, [file("doc.pdf")]),
      [treeOf(id, "远端2")]: listing("远端2", [file("doc.pdf")]),
      [fileOf(id, "readme.md")]: () => textPreviewResponse("自述正文"),
      [`/api/workspaces/${id}/preview-token`]: () => issued(),
    });
    const { region } = await openSidebar("readme.md");
    const issues = () => calls(fetchMock, `/api/workspaces/${id}/preview-token`).length;
    await expand(MOUNT, region);
    await expand("远端2", region);

    await choose(MOUNT, "doc.pdf", `${MOUNT}/doc.pdf`, region);
    await expectRefused(`${MOUNT}/doc.pdf`, region, `/api/workspaces/${id}/download?path=`);
    await yieldMacrotask();
    expect(issues()).toBe(0);

    await choose(W1.name, "doc.pdf", "doc.pdf", region);
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(`${BASE}doc.pdf`);
    await choose("远端2", "doc.pdf", "远端2/doc.pdf", region);
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(
      `${BASE}${encodeURIComponent("远端2")}/doc.pdf`,
    );
    expect(issues()).toBe(1);
  });
});

/** `GET …/mounts` 的 500 应答。 */
const MOUNTS_FAILED = "服务器开小差了";
const mountsFailed = () =>
  jsonResponse({ error: { code: "internal", message: MOUNTS_FAILED } }, 500);

/** 树区上方（树之外）的 role=alert 文案。 */
function columnAlerts() {
  return within(screen.getByRole("complementary", { name: "工作空间文件" }))
    .queryAllByRole("alert")
    .filter((alert) => alert.closest("nav") === null)
    .map((alert) => alert.textContent);
}

describe("挂载列表还不知道或读取失败时的挂载内文件（#1797 F1、F4）", () => {
  it("选中 远端/doc.pdf 后点 刷新、GET …/mounts 答 500：挂载根行消失、树区上方是信封文案，预览仍是固定文案、零签发、没有 iframe", async () => {
    const page = openPage({
      [MOUNTS]: [jsonResponse({ enabled: true, mounts: [remote] }), mountsFailed()],
    });
    await expand(MOUNT);
    await choose(MOUNT, "doc.pdf", `${MOUNT}/doc.pdf`);
    await expectRefused(`${MOUNT}/doc.pdf`);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(columnAlerts()).toStrictEqual([MOUNTS_FAILED]));
    expect(document.querySelector('[data-slot="mount-root"]')).toBeNull();
    await expectRefused(`${MOUNT}/doc.pdf`);
    await yieldMacrotask();
    expect(calls(page.fetchMock, MOUNTS)).toHaveLength(2);
    expect(page.issues()).toBe(0);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("地址 path=远端/doc.pdf，挂载列表在根与 远端 的 tree 之后才答：落地时就是固定文案、零签发；列表到了之后 远端 行展开、doc.pdf 选中，仍零签发", async () => {
    const list = deferredResponse();
    const page = openPage(
      { [MOUNTS]: () => list.promise },
      `/files?${new URLSearchParams({ ws: "workspace-1", path: `${MOUNT}/doc.pdf` })}`,
    );
    await waitFor(() =>
      expect(previewRegion().getByText(`${MOUNT}/doc.pdf`, { exact: true })).toBeTruthy(),
    );
    expect(calls(page.fetchMock, `${TREE}${encodeURIComponent(MOUNT)}`)).toHaveLength(1);
    await expectRefused(`${MOUNT}/doc.pdf`);
    await yieldMacrotask();
    expect(page.issues()).toBe(0);

    list.resolve(jsonResponse({ enabled: true, mounts: [remote] }));
    const mountButton = await screen.findByRole("button", { name: `折叠 ${MOUNT}` });
    expect(mountButton.getAttribute("aria-expanded")).toBe("true");
    expect(rowIn(MOUNT, "doc.pdf").getAttribute("aria-current")).toBe("true");
    await expectRefused(`${MOUNT}/doc.pdf`);
    await yieldMacrotask();
    expect(page.issues()).toBe(0);
    expect(calls(page.fetchMock, `${TREE}${encodeURIComponent(MOUNT)}`)).toHaveLength(1);
  });

  it("GET …/mounts 首次就答 500：地址里的 远端/doc.pdf（根的列表不列它）不签发、显示固定文案；随后根下的 doc.pdf 照常恰一次签发并建 iframe", async () => {
    const page = openPage(
      { [MOUNTS]: mountsFailed },
      `/files?${new URLSearchParams({ ws: "workspace-1", path: `${MOUNT}/doc.pdf` })}`,
    );
    await waitFor(() => expect(columnAlerts()).toStrictEqual([MOUNTS_FAILED]));
    await waitFor(() =>
      expect(previewRegion().getByText(`${MOUNT}/doc.pdf`, { exact: true })).toBeTruthy(),
    );
    await expectRefused(`${MOUNT}/doc.pdf`);
    await yieldMacrotask();
    expect(page.issues()).toBe(0);

    await choose(ROOT, "doc.pdf", "doc.pdf");
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(page.issues()).toBe(1);
    expect(previewRegion().queryByText(IN_MOUNT)).toBeNull();
  });

  it("根下 doc.pdf 已签发（一次）后选中 远端/doc.pdf 停留 6 分钟：不续期（仍是一次）、没有 iframe、固定文案盖过手里的令牌", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const page = openPage();
    await expand(MOUNT);
    await choose(ROOT, "doc.pdf", "doc.pdf");
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(page.issues()).toBe(1);

    await choose(MOUNT, "doc.pdf", `${MOUNT}/doc.pdf`);
    await expectRefused(`${MOUNT}/doc.pdf`);
    await act(() => vi.advanceTimersByTimeAsync(360_000));
    expect(page.issues()).toBe(1);
    await expectRefused(`${MOUNT}/doc.pdf`);
  });
});
