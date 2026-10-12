// files-web「地址定位到文件」三个测试文件共用的夹具：files-deep-link.test.tsx（深链打开、选中写入地址）、
// files-deep-link-failures.test.ts（指向目录、不存在与越界）、files-deep-link-component.test.tsx（组件）。
// 路由值是函数：每次请求给一份新应答，多发的请求留在记录里，由对整份记录的相等断言判红。

import { act, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import {
  authenticatedFilesRoutes,
  type FetchRoutes,
  renderFiles,
  type WorkspaceFixture,
  workspace,
} from "./files-fixture.js";
import { jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const TREE = "/api/workspaces/workspace-1/tree?path=";
const FILE = "/api/workspaces/workspace-1/file?path=";
export const ROOT = TREE;
export const OUT = `${TREE}out`;
export const SRC = `${TREE}src`;
export const DEEP = `${TREE}src%2Fdeep`;
export const FILE_A = `${FILE}out%2Fa.md`;
export const FILE_APP = `${FILE}src%2Fdeep%2Fapp.ts`;
export const FILE_README = `${FILE}readme.md`;
const SECOND_ROOT = "/api/workspaces/workspace-2/tree?path=";
/** 名字里的 é 是分解形式（e 加组合用的重音符）；合成形式是另一个字符串。 */
export const DECOMPOSED = "café.md";
export const FILE_DECOMPOSED = `${FILE}cafe%CC%81.md`;
/** 轮询里按它找树、不按角色：实测角色查询一次几十毫秒，等待大半花在它上面（#1362）。 */
const TREE_NAV = 'nav[aria-label="工作空间目录树"]';

export const dirEntry = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
export const fileEntry = (name: string, size = 4) => ({ name, type: "file", size, mtime: 200 });

export const ROOT_ROWS = ["设计文档", "out", "src", DECOMPOSED, "readme.md"];

/** 第一个空间：根下 `out`、`src` 两个目录与两个文件；第二个空间的根下也有一个 `readme.md`。 */
export function routes(extra: FetchRoutes = {}, workspaces: WorkspaceFixture[] = [workspace]) {
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
export function address(path: string, workspaceId = "workspace-1") {
  return `/files?${new URLSearchParams({ ws: workspaceId, path })}`;
}

export function open(at: string, table = routes()) {
  const mounted = renderFiles(at, table);
  const requests = (mark: string) =>
    mounted.fetchMock.mock.calls.map(([path]) => path).filter((path) => path.includes(mark));
  return {
    ...mounted,
    fileRequests: () => requests("/file?path="),
    treeRequests: () => requests("/tree?path="),
  };
}

export function tree() {
  return screen.getByRole("navigation", { name: "工作空间目录树" });
}

/** 树上各行的名字，自上而下。 */
export function rowNames() {
  const names = document.querySelectorAll(`${TREE_NAV} [data-slot="tree-name"]`);
  return [...names].map((node) => node.textContent);
}

export function row(name: string) {
  return within(tree()).getByRole("button", { name });
}

/** 等树挂上（工作空间列表先要回来）再按名字等一行。 */
export async function findRow(name: string) {
  const loaded = await screen.findByRole("navigation", { name: "工作空间目录树" });
  return within(loaded).findByRole("button", { name });
}

export async function selectedRow(name: string) {
  await waitFor(() => {
    const current = `${TREE_NAV} [aria-current="true"] [data-slot="tree-name"]`;
    expect(document.querySelector(current)?.textContent).toBe(name);
  });
  expect(row(name).getAttribute("aria-current")).toBe("true");
}

export function previewRegion() {
  return within(screen.getByRole("region", { name: "文件预览" }));
}

/** 让已经发出的请求、导航与随后的渲染都落地；之后再断「没有新请求」「地址没变」。 */
export async function settle() {
  await act(async () => {
    await yieldMacrotask();
    await yieldMacrotask();
  });
}

/** 预览区没有失败文案，是空态。 */
export function expectEmptyPreview() {
  expect(previewRegion().getByText("未选择文件", { exact: true })).toBeTruthy();
  expect(previewRegion().queryByRole("alert")).toBeNull();
}
