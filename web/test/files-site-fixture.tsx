// 文件页的网页预览（页面级）夹具：一个带 `site` 目录的空间、签发端点的应答，以及取预览区、取 iframe、
// 数请求的几个助手。`previewers-frame.test.tsx` 与 `previewers-frame-refetch.test.tsx` 共用。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import {
  authenticatedFilesRoutes,
  type FetchRoutes,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { jsonResponse, paths, textPreviewResponse } from "./support.js";

/** 夹具令牌：长度与真实令牌相同，但不是十六进制。 */
export const TOKEN = "t".repeat(64);
export const PREVIEW_HOST = "preview.example.test";
export const BASE = `https://${PREVIEW_HOST}/w/${TOKEN}/`;

const TREE = "/api/workspaces/workspace-1/tree?path=";
export const FILE = "/api/workspaces/workspace-1/file?path=";
export const ISSUE = "/api/workspaces/workspace-1/preview-token";
export const INDEX_SOURCE = '<h1>首页</h1>\n<script>document.title = "ran";</script>';

export function frame(): HTMLIFrameElement {
  const element = document.querySelector("iframe");
  if (!(element instanceof HTMLIFrameElement)) {
    throw new Error("no iframe in the document");
  }
  return element;
}

/** 签发端点的六键应答；函数形式，续签或多发都给一份新的。`base` 缺省是 `BASE`。 */
export function issued(base = BASE) {
  return jsonResponse({
    token: TOKEN,
    base,
    officeBase: `https://${PREVIEW_HOST}/o/${TOKEN}/`,
    expiresAt: 1_800_000_000_000,
    documentMaxBytes: 104_857_600,
    officeAvailable: false,
  });
}

/**
 * 根下 `readme.md` 与目录 `site`，`site` 里是 `index.html` 与 `about.htm`。`file` 路由缺省对
 * `site/index.html` 答它的源码、对 `readme.md` 答一行 Markdown；别的 `file` 请求没有路由，发了就抛错。
 */
export function renderSite(routes: FetchRoutes = {}) {
  return renderFiles(
    "/files?ws=workspace-1",
    authenticatedFilesRoutes([workspace], {
      [TREE]: () =>
        jsonResponse({
          path: "",
          entries: [
            { name: "site", type: "dir", size: 0, mtime: 100 },
            { name: "readme.md", type: "file", size: 4, mtime: 101 },
          ],
        }),
      [`${TREE}site`]: () =>
        jsonResponse({
          path: "site",
          entries: [
            { name: "about.htm", type: "file", size: 20, mtime: 102 },
            { name: "index.html", type: "file", size: 52, mtime: 103 },
          ],
        }),
      [ISSUE]: () => issued(),
      [`${FILE}site%2Findex.html`]: () => textPreviewResponse(INDEX_SOURCE),
      [`${FILE}readme.md`]: () => textPreviewResponse("# 说明"),
      ...routes,
    }),
  );
}

type Mock = ReturnType<typeof renderFiles>["fetchMock"];

export function fileRequests(fetchMock: Mock) {
  return paths(fetchMock).filter((path) => path.includes("/file?"));
}

export function issueRequests(fetchMock: Mock) {
  return paths(fetchMock).filter((path) => path === ISSUE);
}

export function previewRegion() {
  return within(screen.getByRole("region", { name: "文件预览" }));
}

export async function select(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

export async function openSite() {
  fireEvent.click(await screen.findByRole("button", { name: "展开 site" }));
}

/** 等到预览里的 iframe 是 `name` 这个文件的（树里同名的行也带这个 title，所以不按 title 查）。 */
export function shownFrame(name: string) {
  return waitFor(() => {
    const element = frame();
    expect(element.getAttribute("title")).toBe(name);
    return element;
  });
}
