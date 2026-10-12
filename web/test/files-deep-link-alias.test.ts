// files-web「地址定位到文件」：场景「别名路径」，以及「指向目录、不存在与越界」里含 `..` 的那一例。
// 整页渲染（路由在内）。地址里的 `path` 先去掉空段与 `.` 段再定位；有一段恰为 `..` 时不为它发请求。
// 用例逐字断言发给服务端的请求串。服务端有没有写 `sandbox.reject` 在 web 测试里看不到，这里只能断
// 「没有发出请求」。

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  address,
  DECOMPOSED,
  DEEP,
  dirEntry,
  expectEmptyPreview,
  FILE_APP,
  FILE_README,
  fileEntry,
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
import { cleanupFilesFixture, expectLocation } from "./files-fixture.js";
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";

const FILE = "/api/workspaces/workspace-1/file?path=";
const MISSING = "文件不存在";
/** 服务端信封里的两条文案（`server/src/core/errors` 的 `not_found`、`sandbox_denied`）。 */
const NOT_FOUND = "请求的资源不存在";
const DENIED = "目标路径不在你的沙箱内，操作已拒绝";
const findTree = () => screen.findByRole("navigation", { name: "工作空间目录树" });
/** `src`、`src/deep` 都展开之后树上的各行。 */
const DEEP_ROWS = ["设计文档", "out", "src", "deep", "app.ts", DECOMPOSED, "readme.md"];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
});

describe("别名路径", () => {
  type Case = {
    title: string;
    path: string;
    trees: string[];
    files: string[];
    /** 选中行的名字；`null` 是没有选中行、预览为空态。 */
    selected: string | null;
    rows: string[];
  };

  const cases: Case[] = [
    {
      title: "path=./readme.md：选中 readme.md，tree 只有对根的一次",
      path: "./readme.md",
      trees: [ROOT],
      files: [FILE_README],
      selected: "readme.md",
      rows: ROOT_ROWS,
    },
    {
      title: "path=src//deep/app.ts：与 src/deep/app.ts 的请求序列、展开与选中相同",
      path: "src//deep/app.ts",
      trees: [ROOT, SRC, DEEP],
      files: [FILE_APP],
      selected: "app.ts",
      rows: DEEP_ROWS,
    },
    {
      title: "path=/readme.md（斜杠开头）：选中 readme.md，tree 只有对根的一次",
      path: "/readme.md",
      trees: [ROOT],
      files: [FILE_README],
      selected: "readme.md",
      rows: ROOT_ROWS,
    },
    {
      title: "path=src/deep/（斜杠结尾）：展开到 src/deep，不选中文件，预览为 未选择文件",
      path: "src/deep/",
      trees: [ROOT, SRC, DEEP],
      files: [],
      selected: null,
      rows: DEEP_ROWS,
    },
    {
      title: "path=././src/./deep/./app.ts：与 src/deep/app.ts 的请求序列、展开与选中相同",
      path: "././src/./deep/./app.ts",
      trees: [ROOT, SRC, DEEP],
      files: [FILE_APP],
      selected: "app.ts",
      rows: DEEP_ROWS,
    },
    {
      title: "path=.：与不带 path 相同，预览为 未选择文件，没有失败文案",
      path: ".",
      trees: [ROOT],
      files: [],
      selected: null,
      rows: ROOT_ROWS,
    },
    {
      title: "path=/（只有一个斜杠）：与不带 path 相同，预览为 未选择文件，没有失败文案",
      path: "/",
      trees: [ROOT],
      files: [],
      selected: null,
      rows: ROOT_ROWS,
    },
  ];

  it.each(cases.map((item) => [item.title, item] as const))(
    "%s；地址保持访问时的写法，没有 console error",
    async (_title, item) => {
      const errors = vi.spyOn(console, "error");
      const before = window.history.length;
      const at = address(item.path);
      const { fileRequests, treeRequests } = open(at, routes());

      if (item.selected === null) {
        await waitFor(() => {
          expect(rowNames()).toStrictEqual(item.rows);
        });
        await settle();
        expectEmptyPreview();
        expect(tree().querySelector('[aria-current="true"]')).toBeNull();
      } else {
        await selectedRow(item.selected);
        await settle();
        expect(previewRegion().queryByRole("alert")).toBeNull();
        expect(tree().querySelectorAll('[aria-current="true"]')).toHaveLength(1);
      }
      expect(rowNames()).toStrictEqual(item.rows);
      expect(treeRequests()).toStrictEqual(item.trees);
      expect(fileRequests()).toStrictEqual(item.files);
      // 定位不写地址：别名写法原样留着，历史记录没有增加。
      await expectLocation(at);
      expect(window.history.length).toBe(before);
      expect(errors.mock.calls).toStrictEqual([]);
    },
  );

  it("别名地址上点已选中的那一行：地址换成点击写入的规范写法，file 只多一次，没有新的 tree", async () => {
    const { fileRequests, treeRequests } = open(address("./readme.md"));
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    await settle();
    expect(fileRequests()).toStrictEqual([FILE_README]);

    fireEvent.click(row("readme.md"));
    await expectLocation(address("readme.md"));
    await settle();
    expect(row("readme.md").getAttribute("aria-current")).toBe("true");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    expect(fileRequests()).toStrictEqual([FILE_README, FILE_README]);
    expect(treeRequests()).toStrictEqual([ROOT]);
  });

  it("已选中 readme.md 时地址改到它的别名 ./readme.md：选中不动，不再请求 file 与 tree", async () => {
    const { fileRequests, router, treeRequests } = open(address("readme.md"));
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();

    const alias = address("./readme.md");
    await act(async () => {
      await router.navigate(alias);
    });
    await settle();
    await expectLocation(alias);
    expect(row("readme.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("自述正文", { exact: true })).toBeTruthy();
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(fileRequests()).toStrictEqual([FILE_README]);
    expect(treeRequests()).toStrictEqual([ROOT]);
  });
});

describe("含两个点的路径不发请求", () => {
  /** 根下有目录 `a`、`out` 与文件 `b`、`x`、`readme.md`：把 `..` 解析掉的实现会落在它们身上。 */
  const table = () =>
    routes({
      [ROOT]: () =>
        jsonResponse({
          path: "",
          entries: [
            dirEntry("a"),
            dirEntry("out"),
            fileEntry("b"),
            fileEntry("readme.md", 8),
            fileEntry("x"),
          ],
        }),
      [`${FILE}b`]: () => textPreviewResponse("乙的正文"),
      [`${FILE}x`]: () => textPreviewResponse("某的正文"),
    });
  const rows = ["设计文档", "a", "out", "b", "readme.md", "x"];

  it.each([
    ["path=../x", address("../x")],
    ["path=a/../b（中间一段）", address("a/../b")],
    ["path=out/..（末段）", address("out/..")],
    ["path=%2E%2E%2Fx（点也写成百分号编码）", "/files?ws=workspace-1&path=%2E%2E%2Fx"],
  ])(
    "%s：除对根的一次 tree 之外不发任何请求，预览区显示 文件不存在；树可继续操作，没有 console error",
    async (_title, at) => {
      const errors = vi.spyOn(console, "error");
      const before = window.history.length;
      const { fileRequests, treeRequests } = open(at, table());

      await waitFor(() => {
        expect(rowNames()).toStrictEqual(rows);
      });
      expect((await previewRegion().findByRole("alert")).textContent).toBe(MISSING);
      await settle();
      expect(previewRegion().queryByText("未选择文件", { exact: true })).toBeNull();
      expect(screen.queryByText(DENIED, { exact: true })).toBeNull();
      expect(treeRequests()).toStrictEqual([ROOT]);
      expect(fileRequests()).toStrictEqual([]);
      expect(rowNames()).toStrictEqual(rows);
      expect(tree().querySelector('[aria-current="true"]')).toBeNull();
      // 被拦下的地址不改写。
      await expectLocation(at);
      expect(window.history.length).toBe(before);

      // 树仍可用：点一个文件，失败文案让位给它的预览。
      fireEvent.click(row("readme.md"));
      await selectedRow("readme.md");
      expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
      expect(previewRegion().queryByRole("alert")).toBeNull();
      await expectLocation(address("readme.md"));
      await settle();
      expect(fileRequests()).toStrictEqual([FILE_README]);
      expect(treeRequests()).toStrictEqual([ROOT]);
      expect(errors.mock.calls).toStrictEqual([]);
    },
  );

  it("定位 src/deep/app.ts 进行到一半时地址改到 ../x：那次定位被顶掉，src 的列表回来后不再往下请求、不选中", async () => {
    const src = deferredResponse();
    const { fileRequests, router, treeRequests } = open(
      address("src/deep/app.ts"),
      routes({ [SRC]: () => src.promise }),
    );
    await waitFor(() => {
      expect(treeRequests()).toStrictEqual([ROOT, SRC]);
    });

    await act(async () => {
      await router.navigate(address("../x"));
    });
    expect((await previewRegion().findByRole("alert")).textContent).toBe(MISSING);
    await act(async () => {
      src.resolve(jsonResponse({ path: "src", entries: [dirEntry("deep")] }));
      await src.promise;
    });
    await settle();
    expect(previewRegion().getByRole("alert").textContent).toBe(MISSING);
    expect(tree().querySelector('[aria-current="true"]')).toBeNull();
    expect(treeRequests()).toStrictEqual([ROOT, SRC]);
    expect(fileRequests()).toStrictEqual([]);
  });

  it("根的列表读取失败时照样显示 文件不存在：预览区不拿根的失败文案出来，根的失败留在树的错误行里", async () => {
    const { fileRequests, treeRequests } = open(
      address("../x"),
      routes({
        [ROOT]: () => jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
      }),
    );

    expect((await within(await findTree()).findByRole("alert")).textContent).toBe("目录读取失败");
    await settle();
    expect(previewRegion().getByRole("alert").textContent).toBe(MISSING);
    expect(treeRequests()).toStrictEqual([ROOT]);
    expect(fileRequests()).toStrictEqual([]);
  });
});

describe("不当作点段、不当作分隔符的写法", () => {
  // 真实的列表给不出这样的名字（一级目录里的名字不含斜杠）；这里钉的是：点击选中后由地址送回来的那个
  // 路径与选中逐字相同，不因为它的写法被拦下或清掉。
  it("点击选中的行，名字里有斜杠与两个点：写进地址后选中与预览都不动，不显示 文件不存在", async () => {
    const name = "/../odd.md";
    const file = `${FILE}%2F..%2Fodd.md`;
    const { fileRequests, treeRequests } = open(
      "/files?ws=workspace-1",
      routes({
        [ROOT]: () =>
          jsonResponse({ path: "", entries: [fileEntry(name), fileEntry("readme.md", 8)] }),
        [file]: () => textPreviewResponse("怪名字的正文"),
      }),
    );

    fireEvent.click(await findRow(name));
    await expectLocation(address(name));
    expect(await previewRegion().findByText("怪名字的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(row(name).getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("怪名字的正文", { exact: true })).toBeTruthy();
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(treeRequests()).toStrictEqual([ROOT]);
    expect(fileRequests()).toStrictEqual([file]);
  });

  it("path=..\\x（反斜杠不是分隔符）：整串是根下的一个名字，列表里有就选中它", async () => {
    const name = "..\\x";
    const file = `${FILE}..%5Cx`;
    const at = address(name);
    const { fileRequests, treeRequests } = open(
      at,
      routes({
        [ROOT]: () =>
          jsonResponse({ path: "", entries: [fileEntry(name), fileEntry("readme.md", 8)] }),
        [file]: () => textPreviewResponse("反斜杠的正文"),
      }),
    );

    await selectedRow(name);
    expect(await previewRegion().findByText("反斜杠的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(treeRequests()).toStrictEqual([ROOT]);
    expect(fileRequests()).toStrictEqual([file]);
    await expectLocation(at);
  });

  it("path=%252E%252E%2Fx（编码了两层）：只解码一层，%2E%2E 是普通的一级，照样请求它", async () => {
    const at = "/files?ws=workspace-1&path=%252E%252E%2Fx";
    const level = `${ROOT}%252E%252E`;
    const { fileRequests, treeRequests } = open(
      at,
      routes({
        [level]: () => jsonResponse({ error: { code: "not_found", message: NOT_FOUND } }, 404),
      }),
    );

    await findRow("readme.md");
    expect((await previewRegion().findByRole("alert")).textContent).toBe(NOT_FOUND);
    await settle();
    expect(treeRequests()).toStrictEqual([ROOT, level]);
    expect(fileRequests()).toStrictEqual([]);
    expect(rowNames()).toStrictEqual(ROOT_ROWS);
    await expectLocation(at);
  });
});
