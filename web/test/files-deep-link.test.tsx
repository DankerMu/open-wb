// files-web「地址定位到文件」：场景「深链打开」「选中写入地址」「指向目录、不存在与越界」。
// 整页渲染（路由在内）。地址里的 `path` 只是数据：用例逐字断言发给服务端的请求串，是否越界由服务端
// 裁决——这里的 403 / 404 是 fetch 桩给的应答，服务端是否写了 `sandbox.reject` 在 web 测试里看不到
// （由 server/test/workspaces-http.test.ts 与 workspaces-http-boundary.test.ts 承担）。
// 路由值是函数：每次请求给一份新应答，多发的请求留在记录里，由对整份记录的相等断言判红。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  expectLocation,
  type FetchRoutes,
  openWorkspaceDialog,
  renderFiles,
  secondWorkspace,
  selectWorkspaceByName,
  type WorkspaceFixture,
  workspace,
  workspaceRoute,
} from "./files-fixture.js";
import { createFetchMock, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const TREE = "/api/workspaces/workspace-1/tree?path=";
const FILE = "/api/workspaces/workspace-1/file?path=";
const ROOT = TREE;
const OUT = `${TREE}out`;
const SRC = `${TREE}src`;
const DEEP = `${TREE}src%2Fdeep`;
const FILE_A = `${FILE}out%2Fa.md`;
const FILE_APP = `${FILE}src%2Fdeep%2Fapp.ts`;
const FILE_README = `${FILE}readme.md`;
const SECOND_ROOT = "/api/workspaces/workspace-2/tree?path=";
/** 名字里的 é 是分解形式（e 加组合用的重音符）；合成形式是另一个字符串。 */
const DECOMPOSED = "café.md";
const COMPOSED = "café.md";
const FILE_DECOMPOSED = `${FILE}cafe%CC%81.md`;
/** 轮询里按它找树、不按角色：实测角色查询一次几十毫秒，等待大半花在它上面（#1362）。 */
const TREE_NAV = 'nav[aria-label="工作空间目录树"]';
/** 服务端信封里的两条文案（`server/src/core/errors` 的 `not_found`、`sandbox_denied`）。 */
const NOT_FOUND = "请求的资源不存在";
const DENIED = "目标路径不在你的沙箱内，操作已拒绝";
const MISSING = "文件不存在";

const dirEntry = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
const fileEntry = (name: string, size = 4) => ({ name, type: "file", size, mtime: 200 });
const notFound = () => jsonResponse({ error: { code: "not_found", message: NOT_FOUND } }, 404);
const denied = () => jsonResponse({ error: { code: "sandbox_denied", message: DENIED } }, 403);

const ROOT_ROWS = ["设计文档", "out", "src", DECOMPOSED, "readme.md"];
const OUT_ROWS = ["设计文档", "out", "a.md", "b.md", "src", DECOMPOSED, "readme.md"];

/** 第一个空间：根下 `out`、`src` 两个目录与两个文件；第二个空间的根下也有一个 `readme.md`。 */
function routes(extra: FetchRoutes = {}, workspaces: WorkspaceFixture[] = [workspace]) {
  const readme = () => jsonResponse({ path: "", entries: [fileEntry("readme.md", 8)] });
  return authenticatedFilesRoutes(workspaces, {
    [ROOT]: () =>
      jsonResponse({
        path: "",
        entries: [
          dirEntry("out"),
          dirEntry("src"),
          fileEntry(DECOMPOSED),
          fileEntry("readme.md", 8),
        ],
      }),
    [OUT]: () => jsonResponse({ path: "out", entries: [fileEntry("a.md"), fileEntry("b.md")] }),
    [SRC]: () => jsonResponse({ path: "src", entries: [dirEntry("deep")] }),
    [DEEP]: () => jsonResponse({ path: "src/deep", entries: [fileEntry("app.ts", 12)] }),
    [FILE_A]: () => textPreviewResponse("甲的正文"),
    [FILE_APP]: () => textPreviewResponse("const app = 1;"),
    [FILE_README]: () => textPreviewResponse("自述正文"),
    [FILE_DECOMPOSED]: () => textPreviewResponse("分解形式的正文"),
    [SECOND_ROOT]: readme,
    ...extra,
  });
}

/** 文件页的地址：`path` 按 `URLSearchParams` 的写法编码（空格是加号，斜杠是 %2F）。 */
function address(path: string, workspaceId = "workspace-1") {
  return `/files?${new URLSearchParams({ ws: workspaceId, path })}`;
}

function open(at: string, table = routes()) {
  const mounted = renderFiles(at, table);
  const requests = (mark: string) =>
    mounted.fetchMock.mock.calls.map(([path]) => path).filter((path) => path.includes(mark));
  return {
    ...mounted,
    fileRequests: () => requests("/file?path="),
    treeRequests: () => requests("/tree?path="),
  };
}

function tree() {
  return screen.getByRole("navigation", { name: "工作空间目录树" });
}

/** 树上各行的名字，自上而下。 */
function rowNames() {
  const names = document.querySelectorAll(`${TREE_NAV} [data-slot="tree-name"]`);
  return [...names].map((node) => node.textContent);
}

function row(name: string) {
  return within(tree()).getByRole("button", { name });
}

/** 等树挂上（工作空间列表先要回来）再按名字等一行。 */
async function findRow(name: string) {
  const loaded = await screen.findByRole("navigation", { name: "工作空间目录树" });
  return within(loaded).findByRole("button", { name });
}

async function selectedRow(name: string) {
  await waitFor(() => {
    const current = `${TREE_NAV} [aria-current="true"] [data-slot="tree-name"]`;
    expect(document.querySelector(current)?.textContent).toBe(name);
  });
  expect(row(name).getAttribute("aria-current")).toBe("true");
}

function previewRegion() {
  return within(screen.getByRole("region", { name: "文件预览" }));
}

/** 源码预览的正文：着色后一行拆成多个元素，所以比容器的 `textContent`。 */
async function codePreview(text: string) {
  await waitFor(() => {
    const body = document.querySelector('[data-slot="files-preview"] [data-slot="preview-code"]');
    expect(body?.textContent).toContain(text);
  });
}

/** 让已经发出的请求、导航与随后的渲染都落地；之后再断「没有新请求」「地址没变」。 */
async function settle() {
  await act(async () => {
    await yieldMacrotask();
    await yieldMacrotask();
  });
}

/** 预览区没有失败文案，是空态。 */
function expectEmptyPreview() {
  expect(previewRegion().getByText("未选择文件", { exact: true })).toBeTruthy();
  expect(previewRegion().queryByRole("alert")).toBeNull();
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
});

describe("深链打开", () => {
  /** 场景的结局：三级都展开、`app.ts` 被选中并显示预览，三层目录与文件各请求一次。 */
  async function expectAppOpened(mounted: ReturnType<typeof open>) {
    await selectedRow("app.ts");
    await codePreview("const app = 1;");
    expect(previewRegion().getByText("src/deep/app.ts", { exact: true })).toBeTruthy();
    for (const name of ["设计文档", "src", "deep"]) {
      expect(within(tree()).getByRole("button", { name: `折叠 ${name}` })).toBeTruthy();
    }
    expect(within(tree()).getByRole("button", { name: "展开 out" })).toBeTruthy();
    await settle();
    expect(mounted.treeRequests()).toStrictEqual([ROOT, SRC, DEEP]);
    expect(mounted.fileRequests()).toStrictEqual([FILE_APP]);
  }

  it("直接访问带 path 的地址：依次对根、src、src/deep 请求 tree 各一次，三级展开，app.ts 被选中并显示预览", async () => {
    const before = window.history.length;
    const at = "/files?ws=workspace-1&path=src%2Fdeep%2Fapp.ts";
    const mounted = open(at);

    await expectAppOpened(mounted);
    // 定位不写地址：地址原样，历史记录没有增加。
    await expectLocation(at);
    expect(window.history.length).toBe(before);
  });

  it("地址里的斜杠没有编码时同样定位，地址不被改写成编码后的写法", async () => {
    const before = window.history.length;
    const at = "/files?ws=workspace-1&path=src/deep/app.ts";
    const mounted = open(at);

    await expectAppOpened(mounted);
    await expectLocation(at);
    expect(window.history.length).toBe(before);
  });

  it("卸载后按同一地址重新挂载：空间、展开与选中相同，请求序列相同", async () => {
    const at = address("src/deep/app.ts");
    const first = open(at);
    await expectAppOpened(first);
    first.view.unmount();

    await expectAppOpened(open(at));
    await expectLocation(at);
  });

  it("分解形式的名字原样比对、原样发出；点回它时写进地址的仍是分解形式", async () => {
    const at = "/files?ws=workspace-1&path=cafe%CC%81.md";
    const { fileRequests, treeRequests } = open(at);

    await selectedRow(DECOMPOSED);
    expect(await previewRegion().findByText("分解形式的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(treeRequests()).toStrictEqual([ROOT]);
    expect(fileRequests()).toStrictEqual([FILE_DECOMPOSED]);

    fireEvent.click(row("readme.md"));
    await expectLocation(address("readme.md"));
    fireEvent.click(row(DECOMPOSED));
    await expectLocation(at);
    await settle();
    expect(row(DECOMPOSED).getAttribute("aria-current")).toBe("true");
    expect(await previewRegion().findByText("分解形式的正文", { exact: true })).toBeTruthy();
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(fileRequests()).toStrictEqual([FILE_DECOMPOSED, FILE_README, FILE_DECOMPOSED]);
  });

  it("path 是空串：当作没有，预览为 未选择文件、没有失败文案，地址不被改写", async () => {
    const at = "/files?ws=workspace-1&path=";
    const { fileRequests, treeRequests } = open(at);

    expect(await findRow("readme.md")).toBeTruthy();
    await settle();
    expectEmptyPreview();
    expect(tree().querySelector('[aria-current="true"]')).toBeNull();
    expect(treeRequests()).toStrictEqual([ROOT]);
    expect(fileRequests()).toStrictEqual([]);
    await expectLocation(at);
  });

  it("path 写了两次：取第一个；之后选中别的文件，地址里只剩一个 path", async () => {
    const { fileRequests } = open("/files?ws=workspace-1&path=readme.md&path=out%2Fa.md");

    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    await settle();
    expect(fileRequests()).toStrictEqual([FILE_README]);
    expect(within(tree()).getByRole("button", { name: "展开 out" })).toBeTruthy();

    fireEvent.click(row(DECOMPOSED));
    await expectLocation("/files?ws=workspace-1&path=cafe%CC%81.md");
  });
});

describe("选中写入地址", () => {
  it("依次选中 readme.md 与 out/a.md：地址依次写入，没有新增历史记录，后退离开文件页", async () => {
    // 先落在一个不发文件请求的路由，再进文件页：后退有处可去。
    const { router } = open("/center");
    await screen.findByRole("heading", { level: 1, name: "中心" });
    await act(async () => {
      await router.navigate("/files?ws=workspace-1");
    });
    fireEvent.click(await findRow("展开 out"));
    await findRow("a.md");
    // jsdom 的历史记录跨用例累积：比的是相对起点的变化。此刻至少有 `/center` 与文件页两项。
    const before = window.history.length;
    expect(before).toBeGreaterThanOrEqual(2);

    fireEvent.click(row("readme.md"));
    await expectLocation("/files?ws=workspace-1&path=readme.md");
    await selectedRow("readme.md");
    fireEvent.click(row("a.md"));
    await expectLocation("/files?ws=workspace-1&path=out%2Fa.md");
    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(window.history.length).toBe(before);

    await act(async () => {
      await router.navigate(-1);
    });
    await expectLocation("/center");
  });

  it("写 path 时其它参数与页内锚点原样保留", async () => {
    open("/files?keep=1&ws=workspace-1#x");

    fireEvent.click(await findRow("readme.md"));
    await expectLocation("/files?keep=1&ws=workspace-1&path=readme.md#x");
    await selectedRow("readme.md");
    await settle();
    await expectLocation("/files?keep=1&ws=workspace-1&path=readme.md#x");
  });

  it("不等地址落地连点两个文件：最终选中与地址都是后一个", async () => {
    const { fileRequests } = open("/files?ws=workspace-1");
    fireEvent.click(await findRow("展开 out"));
    await findRow("a.md");

    fireEvent.click(row("readme.md"));
    fireEvent.click(row("a.md"));
    await expectLocation("/files?ws=workspace-1&path=out%2Fa.md");
    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    await settle();
    await expectLocation("/files?ws=workspace-1&path=out%2Fa.md");
    expect(row("a.md").getAttribute("aria-current")).toBe("true");
    expect(row("readme.md").getAttribute("aria-current")).toBeNull();
    expect(previewRegion().getByText("甲的正文", { exact: true })).toBeTruthy();
    // 请求次数是实测值，不是「最少」的保证：第一次点击的 `file` 请求发出后被第二次点击中止。
    expect(fileRequests()).toStrictEqual([FILE_README, FILE_A]);
  });

  it.each([
    ["ws 属于别人或不存在", "/files?ws=other-account&path=readme.md"],
    ["没有 ws", "/files?path=readme.md"],
  ])(
    "%s：ws 被纠正时 path 一并移除，第一个空间里的同名文件不被选中、不请求 file",
    async (_title, at) => {
      const { fetchMock, fileRequests, treeRequests } = open(
        at,
        routes({}, [workspace, secondWorkspace]),
      );

      await expectLocation("/files?ws=workspace-1");
      // 同名文件真的在第一个空间的根下，而且根只列了一次。
      expect(await findRow("readme.md")).toBeTruthy();
      await settle();
      expect(rowNames()).toStrictEqual(ROOT_ROWS);
      expect(treeRequests()).toStrictEqual([ROOT]);
      expect(fileRequests()).toStrictEqual([]);
      expect(tree().querySelector('[aria-current="true"]')).toBeNull();
      expectEmptyPreview();
      await expectLocation("/files?ws=workspace-1");
      expect(
        fetchMock.mock.calls.map(([path]) => path).filter((path) => path.includes("other-account")),
      ).toStrictEqual([]);
    },
  );

  it("经切换器切空间后地址没有 path：新空间里的同名文件不被选中；后退回到原空间时 path 随地址恢复", async () => {
    const { fileRequests, router } = open(
      address("readme.md"),
      routes({}, [workspace, secondWorkspace]),
    );
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();

    await selectWorkspaceByName(/数据分析/);
    await expectLocation("/files?ws=workspace-2");
    await waitFor(() => {
      expect(rowNames()).toStrictEqual(["数据分析", "readme.md"]);
    });
    await settle();
    expect(row("readme.md").getAttribute("aria-current")).toBeNull();
    expectEmptyPreview();
    expect(fileRequests()).toStrictEqual([FILE_README]);
    await expectLocation("/files?ws=workspace-2");

    await act(async () => {
      await router.navigate(-1);
    });
    await expectLocation(address("readme.md"));
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    expect(rowNames()).toStrictEqual(ROOT_ROWS);
  });

  it("新建空间后地址没有 path", async () => {
    const created = { ...secondWorkspace, name: "新空间", dir: "new-workspace" };
    const { fileRequests } = open(
      address("readme.md"),
      routes({
        "/api/workspaces": workspaceRoute([workspace], () => jsonResponse(created, 201)),
      }),
    );
    await selectedRow("readme.md");

    const dialog = await openWorkspaceDialog();
    fireEvent.change(within(dialog).getByLabelText("工作空间名称"), {
      target: { value: "新空间" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await expectLocation("/files?ws=workspace-2");
    await waitFor(() => {
      expect(rowNames()).toStrictEqual(["新空间", "readme.md"]);
    });
    await settle();
    expect(row("readme.md").getAttribute("aria-current")).toBeNull();
    expectEmptyPreview();
    expect(fileRequests()).toStrictEqual([FILE_README]);
    await expectLocation("/files?ws=workspace-2");
  });
});

describe("指向目录、不存在与越界", () => {
  type Case = {
    title: string;
    path: string;
    /** 发出的 `tree` 请求，逐字。 */
    trees: string[];
    /** 预览区的失败文案；`null` 是空态 `未选择文件`。 */
    notice: string | null;
    rows: string[];
    extra?: FetchRoutes;
  };

  const cases: Case[] = [
    {
      title: "path=out（目录）：展开到 out，不选中文件，预览区为 未选择文件",
      path: "out",
      trees: [ROOT, OUT],
      notice: null,
      rows: OUT_ROWS,
    },
    {
      title: "path=out/gone.md（不存在）：展开到 out，预览区显示 文件不存在",
      path: "out/gone.md",
      trees: [ROOT, OUT],
      notice: MISSING,
      rows: OUT_ROWS,
    },
    {
      title: "path=nodir/x.md（父目录不存在）：照样请求 nodir，停在根，显示服务端的 404 文案",
      path: "nodir/x.md",
      trees: [ROOT, `${TREE}nodir`],
      notice: NOT_FOUND,
      rows: ROOT_ROWS,
      extra: { [`${TREE}nodir`]: notFound },
    },
    {
      title: "path=../x：两个点原样发出，停在根，显示服务端的 403 文案",
      path: "../x",
      trees: [ROOT, `${TREE}..`],
      notice: DENIED,
      rows: ROOT_ROWS,
      extra: { [`${TREE}..`]: denied },
    },
    {
      title: "path=readme.md/x（中间一级是文件）：照样请求它，显示服务端的 404 文案",
      path: "readme.md/x",
      trees: [ROOT, `${TREE}readme.md`],
      notice: NOT_FOUND,
      rows: ROOT_ROWS,
      extra: { [`${TREE}readme.md`]: notFound },
    },
    {
      title: "path=/etc/x（斜杠开头）：请求串是编码后的 /etc，显示服务端的 403 文案",
      path: "/etc/x",
      trees: [ROOT, `${TREE}%2Fetc`],
      notice: DENIED,
      rows: ROOT_ROWS,
      extra: { [`${TREE}%2Fetc`]: denied },
    },
    {
      title: "path=constructor/x（与对象内置成员同名的一级）：照样请求它，显示服务端的 404 文案",
      path: "constructor/x",
      trees: [ROOT, `${TREE}constructor`],
      notice: NOT_FOUND,
      rows: ROOT_ROWS,
      extra: { [`${TREE}constructor`]: notFound },
    },
    {
      title: "path=__proto__/x（与原型访问器同名的一级）：照样请求它，显示服务端的 404 文案",
      path: "__proto__/x",
      trees: [ROOT, `${TREE}__proto__`],
      notice: NOT_FOUND,
      rows: ROOT_ROWS,
      extra: { [`${TREE}__proto__`]: notFound },
    },
    {
      title: "path=..（单独两个点）：根的列表里没有它，显示 文件不存在，不为它发请求",
      path: "..",
      trees: [ROOT],
      notice: MISSING,
      rows: ROOT_ROWS,
    },
    {
      title: "path=/x：根的列表里没有它，显示 文件不存在，没有额外请求",
      path: "/x",
      trees: [ROOT],
      notice: MISSING,
      rows: ROOT_ROWS,
    },
    {
      title: "path=out/（斜杠结尾）：展开到 out，显示 文件不存在",
      path: "out/",
      trees: [ROOT, OUT],
      notice: MISSING,
      rows: OUT_ROWS,
    },
    {
      title: "前导空格不去掉：请求的是带空格的目录名，显示服务端的 404 文案",
      path: " out/a.md",
      trees: [ROOT, `${TREE}%20out`],
      notice: NOT_FOUND,
      rows: ROOT_ROWS,
      extra: { [`${TREE}%20out`]: notFound },
    },
    {
      title: "尾随空格不去掉：out 的列表里没有带空格的名字，显示 文件不存在",
      path: "out/a.md ",
      trees: [ROOT, OUT],
      notice: MISSING,
      rows: OUT_ROWS,
    },
    {
      title: "合成形式的名字不等于列表里分解形式的名字：显示 文件不存在",
      path: COMPOSED,
      trees: [ROOT],
      notice: MISSING,
      rows: ROOT_ROWS,
    },
    {
      title: "某一级父目录的请求没有得到应答：停在该级，显示通用的失败文案",
      path: "src/deep/app.ts",
      trees: [ROOT, SRC],
      notice: "请求失败，请稍后重试",
      rows: ROOT_ROWS,
      extra: { [SRC]: () => new Error("offline") },
    },
  ];

  // 标题用 %s：整句照印，不截断。
  it.each(cases.map((item) => [item.title, item] as const))(
    "%s；树可继续操作，没有 console error",
    async (_title, item) => {
      const errors = vi.spyOn(console, "error");
      const at = address(item.path);
      const { fileRequests, treeRequests } = open(at, routes(item.extra));

      await waitFor(() => {
        expect(rowNames()).toStrictEqual(item.rows);
      });
      if (item.notice === null) {
        await settle();
        expectEmptyPreview();
      } else {
        expect((await previewRegion().findByRole("alert")).textContent).toBe(item.notice);
        expect(previewRegion().queryByText("未选择文件", { exact: true })).toBeNull();
        await settle();
      }
      expect(treeRequests()).toStrictEqual(item.trees);
      expect(fileRequests()).toStrictEqual([]);
      expect(rowNames()).toStrictEqual(item.rows);
      expect(tree().querySelector('[aria-current="true"]')).toBeNull();
      // 失败的定位不改写地址。
      await expectLocation(at);

      // 树仍可用：点另一个文件，失败文案让位给它的预览。
      fireEvent.click(row("readme.md"));
      await selectedRow("readme.md");
      expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
      expect(previewRegion().queryByRole("alert")).toBeNull();
      await expectLocation(address("readme.md"));
      await settle();
      expect(fileRequests()).toStrictEqual([FILE_README]);
      expect(treeRequests()).toStrictEqual(item.trees);
      expect(errors.mock.calls).toStrictEqual([]);
    },
  );

  it.each([
    ["../x", `${TREE}..`, denied, DENIED],
    ["nodir/x.md", `${TREE}nodir`, notFound, NOT_FOUND],
  ])(
    "%s 定位失败后点 刷新：只重取根，不再请求失败的那一级",
    async (path, level, respond, notice) => {
      const { treeRequests } = open(address(path), routes({ [level]: respond }));
      await findRow("readme.md");
      expect((await previewRegion().findByRole("alert")).textContent).toBe(notice);
      await settle();
      expect(treeRequests()).toStrictEqual([ROOT, level]);

      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => {
        expect(treeRequests()).toHaveLength(3);
      });
      await settle();
      expect(treeRequests()).toStrictEqual([ROOT, level, ROOT]);
      expect(rowNames()).toStrictEqual(ROOT_ROWS);
    },
  );

  it("path=./bad（别名指向目录，bad 的列表读取失败）：没有行的 ./bad 不展开、不请求；点 刷新 只重取根，没有错误行", async () => {
    const listing = () =>
      jsonResponse({ path: "", entries: [dirEntry("bad"), fileEntry("readme.md", 8)] });
    const { treeRequests } = open(
      address("./bad"),
      routes({ [ROOT]: listing, [`${TREE}.`]: listing, [`${TREE}.%2Fbad`]: notFound }),
    );
    await findRow("展开 bad");
    await waitFor(() => {
      expect(treeRequests()).toHaveLength(2);
    });
    await settle();
    expect(treeRequests()).toStrictEqual([ROOT, `${TREE}.`]);
    expectEmptyPreview();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => {
      expect(treeRequests()).toHaveLength(3);
    });
    await settle();
    expect(treeRequests()).toStrictEqual([ROOT, `${TREE}.`, ROOT]);
    expect(rowNames()).toStrictEqual(["设计文档", "bad", "readme.md"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("失败的那一级后来真的出现在根的列表里：它是一个折叠着的普通目录，没有被当作展开过", async () => {
    let rootReads = 0;
    const { treeRequests } = open(
      address("nodir/x.md"),
      routes({
        [ROOT]: () => {
          rootReads += 1;
          const entries = [dirEntry("out"), fileEntry("readme.md", 8)];
          return jsonResponse({
            path: "",
            entries: rootReads === 1 ? entries : [dirEntry("nodir"), ...entries],
          });
        },
        [`${TREE}nodir`]: notFound,
      }),
    );
    await findRow("readme.md");
    expect((await previewRegion().findByRole("alert")).textContent).toBe(NOT_FOUND);
    expect(rowNames()).toStrictEqual(["设计文档", "out", "readme.md"]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await findRow("展开 nodir")).toBeTruthy();
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "nodir", "out", "readme.md"]);
    expect(within(tree()).queryByRole("alert")).toBeNull();
    expect(treeRequests()).toStrictEqual([ROOT, `${TREE}nodir`, ROOT]);
  });

  it("地址从文件改到目录：展开到它，原来的选中被清掉，预览为 未选择文件", async () => {
    const { fileRequests, router, treeRequests } = open(address("readme.md"));
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();

    await act(async () => {
      await router.navigate(address("out"));
    });
    await waitFor(() => {
      expect(rowNames()).toStrictEqual(OUT_ROWS);
    });
    await settle();
    expect(tree().querySelector('[aria-current="true"]')).toBeNull();
    expectEmptyPreview();
    expect(treeRequests()).toStrictEqual([ROOT, OUT]);
    expect(fileRequests()).toStrictEqual([FILE_README]);
  });

  it.each([
    ["out/gone.md", MISSING, [ROOT, OUT], {}],
    ["nodir/x.md", NOT_FOUND, [ROOT, `${TREE}nodir`], { [`${TREE}nodir`]: notFound }],
  ] satisfies [string, string, string[], FetchRoutes][])(
    "已选中 readme.md 时地址改到 %s：选中被清掉，预览区显示失败文案，不请求新的 file",
    async (path, notice, trees, extra) => {
      const { fileRequests, router, treeRequests } = open(address("readme.md"), routes(extra));
      await selectedRow("readme.md");
      expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();

      await act(async () => {
        await router.navigate(address(path));
      });
      expect((await previewRegion().findByRole("alert")).textContent).toBe(notice);
      await settle();
      expect(tree().querySelector('[aria-current="true"]')).toBeNull();
      expect(previewRegion().queryByText("自述正文", { exact: true })).toBeNull();
      expect(treeRequests()).toStrictEqual(trees);
      expect(fileRequests()).toStrictEqual([FILE_README]);
    },
  );

  it("失败文案在 path 再变时清掉：改到目录、改到没有 path 都回到 未选择文件", async () => {
    const { router } = open(address("out/gone.md"));
    await findRow("readme.md");
    expect((await previewRegion().findByRole("alert")).textContent).toBe(MISSING);

    await act(async () => {
      await router.navigate(address("src"));
    });
    expect(await findRow("展开 deep")).toBeTruthy();
    await settle();
    expectEmptyPreview();

    await act(async () => {
      await router.navigate(address("out/gone.md"));
    });
    expect((await previewRegion().findByRole("alert")).textContent).toBe(MISSING);
    await act(async () => {
      await router.navigate("/files?ws=workspace-1");
    });
    await settle();
    expectEmptyPreview();
  });
});

// 页面给不出的三种情形，直接渲染组件：401 在页面上会先换成登录页，`onlyPaths` 与 `reveal()` 在文件页
// 没有使用方。
describe("不显示失败文案的定位失败（组件）", () => {
  function mount(table: FetchRoutes) {
    const fetchMock = createFetchMock(table);
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();
    const onPathChange = vi.fn<(path: string) => void>();
    const handle = createRef<WorkspaceBrowserHandle>();
    const browser = (path: string | null, onlyPaths?: ReadonlySet<string>) => (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        onlyPaths={onlyPaths}
        onPathChange={onPathChange}
        path={path}
        ref={handle}
        workspaceId="workspace-1"
      />
    );
    const view = render(browser(null));
    return {
      handle,
      onPathChange,
      requests: () => fetchMock.mock.calls.map(([path]) => path),
      show: (path: string | null, onlyPaths?: ReadonlySet<string>) =>
        view.rerender(browser(path, onlyPaths)),
    };
  }

  const root = () =>
    jsonResponse({ path: "", entries: [dirEntry("src"), fileEntry("readme.md", 8)] });
  const table = (src: () => Response): FetchRoutes => ({
    [ROOT]: root,
    [SRC]: src,
    [FILE_README]: () => textPreviewResponse("自述正文"),
  });

  it("某一级父目录应答 401：不显示任何失败文案（登录层接手），选中不动", async () => {
    const { onPathChange, requests, show } = mount(
      table(() => jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401)),
    );
    show("readme.md");
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();

    show("src/deep/app.ts");
    await waitFor(() => {
      expect(requests()).toStrictEqual([ROOT, FILE_README, SRC]);
    });
    await settle();
    expect(requests()).toStrictEqual([ROOT, FILE_README, SRC]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(row("readme.md").getAttribute("aria-current")).toBe("true");
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });

  it("onlyPaths 下 path 指向没加载过的层：不请求，也不拿这一层早先那次失败的文案出来显示", async () => {
    const only = new Set(["readme.md"]);
    const { requests, show } = mount(
      table(() => jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500)),
    );
    show("src/deep/app.ts");
    expect((await previewRegion().findByRole("alert")).textContent).toBe("目录读取失败");
    show("readme.md");
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, SRC, FILE_README]);

    show("readme.md", only);
    show("src/deep/app.ts", only);
    await settle();
    expect(requests()).toStrictEqual([ROOT, SRC, FILE_README]);
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(row("readme.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("自述正文", { exact: true })).toBeTruthy();
  });

  it("reveal() 定位到不存在的文件或失败的一级：不显示失败文案、不清选中、不回调（呈现留给使用方）", async () => {
    const { handle, onPathChange, requests, show } = mount(
      table(() => jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500)),
    );
    show("readme.md");
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();

    act(() => handle.current?.reveal("gone.md"));
    act(() => handle.current?.reveal("src/deep/app.ts"));
    await waitFor(() => {
      expect(requests()).toStrictEqual([ROOT, FILE_README, SRC]);
    });
    // `src` 的失败落在树的错误行里；预览区没有失败文案。
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    await settle();
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(row("readme.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("自述正文", { exact: true })).toBeTruthy();
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });
});
