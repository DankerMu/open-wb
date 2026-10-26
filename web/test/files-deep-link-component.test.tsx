// files-web「地址定位到文件」：整页给不出的定位失败情形，直接渲染 `WorkspaceBrowser`。

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  dirEntry,
  FILE_README,
  fileEntry,
  previewRegion,
  ROOT,
  row,
  SRC,
  selectedRow,
  settle,
  tree,
} from "./files-deep-link-support.js";
import { cleanupFilesFixture, type FetchRoutes } from "./files-fixture.js";
import { createFetchMock, jsonResponse, paths, textPreviewResponse } from "./support.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
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
      requests: () => paths(fetchMock),
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
