// files-web「地址定位到文件」：场景「指向目录、不存在与越界」。整页渲染（路由在内）。
// 地址里的 `path` 只是数据：用例逐字断言发给服务端的请求串，是否越界由服务端裁决——这里的 403 / 404
// 是 fetch 桩给的应答，服务端是否写了 `sandbox.reject` 在 web 测试里看不到
// （由 server/test/workspaces-http.test.ts 与 workspaces-http-boundary.test.ts 承担）。

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  address,
  DECOMPOSED,
  dirEntry,
  expectEmptyPreview,
  FILE_README,
  fileEntry,
  findRow,
  OUT,
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
import { cleanupFilesFixture, expectLocation, type FetchRoutes } from "./files-fixture.js";
import { jsonResponse } from "./support.js";

/** `tree` 请求串的前缀；根的请求串就是它。 */
const TREE = ROOT;
/** 合成形式的 é（一个字符）；根的列表里那个名字是分解形式，是另一个字符串。 */
const COMPOSED = "café.md";
/** 服务端信封里的两条文案（`server/src/core/errors` 的 `not_found`、`sandbox_denied`）。 */
const NOT_FOUND = "请求的资源不存在";
const DENIED = "目标路径不在你的沙箱内，操作已拒绝";
const MISSING = "文件不存在";

const notFound = () => jsonResponse({ error: { code: "not_found", message: NOT_FOUND } }, 404);
const denied = () => jsonResponse({ error: { code: "sandbox_denied", message: DENIED } }, 403);

const OUT_ROWS = ["设计文档", "out", "a.md", "b.md", "src", DECOMPOSED, "readme.md"];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
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
