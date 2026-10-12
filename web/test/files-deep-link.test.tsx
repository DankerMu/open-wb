// files-web「地址定位到文件」：场景「深链打开」「选中写入地址」。整页渲染（路由在内）。
// 场景「指向目录、不存在与越界」在 files-deep-link-failures.test.ts，组件一级的情形在
// files-deep-link-component.test.tsx；夹具在 files-deep-link-support.ts。

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  address,
  DECOMPOSED,
  DEEP,
  expectEmptyPreview,
  FILE_A,
  FILE_APP,
  FILE_DECOMPOSED,
  FILE_README,
  findRow,
  open,
  previewRegion,
  ROOT,
  ROOT_ROWS,
  routes,
  row,
  rowNames,
  SRC,
  selectedRow,
  settle,
  tree,
} from "./files-deep-link-support.js";
import {
  cleanupFilesFixture,
  expectLocation,
  openWorkspaceDialog,
  secondWorkspace,
  selectWorkspaceByName,
  workspace,
  workspaceRoute,
} from "./files-fixture.js";
import { jsonResponse } from "./support.js";

/** 源码预览的正文：着色后一行拆成多个元素，所以比容器的 `textContent`。 */
async function codePreview(text: string) {
  await waitFor(() => {
    const body = document.querySelector('[data-slot="files-preview"] [data-slot="preview-code"]');
    expect(body?.textContent).toContain(text);
  });
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
