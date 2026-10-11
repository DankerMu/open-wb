import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  type FetchRoutes,
  imagePreviewResponse,
  renderFiles,
  secondWorkspace,
  selectWorkspaceByName,
  stubBlobUrls,
  workspace,
} from "./files-fixture.js";
import { jsonResponse, paths, textPreviewResponse } from "./support.js";

/*
 * file-previewers「预览头、下载与不可预览的呈现」与「未知文件由服务端裁决」的页面级场景：
 * 浏览器不按扩展名预筛，每个文件发一次 `file` 请求，由应答决定呈现；预览头的下载链接哪一态都在。
 */

afterEach(() => {
  cleanupFilesFixture();
});

const FILE = "/api/workspaces/workspace-1/file?path=";
const DOWNLOAD = "/api/workspaces/workspace-1/download?path=";

type FileFixture = { size: number; route: FetchRoutes[string] };

function unsupported() {
  return jsonResponse({ error: { code: "preview_unsupported", message: "该类型不支持预览" } }, 415);
}

/** 根目录下恰有 `files` 这些文件的空间；每个文件的 `file` 路由就是它的 `route`。 */
function renderWorkspaceWith(files: Record<string, FileFixture>, strict = false) {
  const names = Object.keys(files);
  const entries = names.map((name, index) => ({
    name,
    type: "file",
    size: files[name]?.size ?? 0,
    mtime: 101 + index,
  }));
  return renderFiles(
    "/files?ws=workspace-1",
    authenticatedFilesRoutes([workspace, secondWorkspace], {
      "/api/workspaces/workspace-1/tree?path=": () => jsonResponse({ path: "", entries }),
      "/api/workspaces/workspace-2/tree?path=": () => jsonResponse({ path: "", entries: [] }),
      ...Object.fromEntries(names.map((name) => [`${FILE}${name}`, files[name]?.route])),
    }),
    strict,
  );
}

async function select(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

function previewRegion() {
  return within(screen.getByRole("region", { name: "文件预览" }));
}

/** 预览区里那一个下载链接：断言名字、地址与 `download` 属性，并且只有这一个。 */
function expectDownloadLink(name: string) {
  const links = previewRegion().getAllByRole("link");
  expect(links.map((link) => link.getAttribute("aria-label"))).toStrictEqual([`下载 ${name}`]);
  const link = previewRegion().getByRole("link", { name: `下载 ${name}` });
  expect(link.getAttribute("href")).toBe(`${DOWNLOAD}${name}`);
  expect(link.hasAttribute("download")).toBe(true);
}

async function expectEmptyState(title: string, description: string) {
  await waitFor(() => {
    const preview = screen.getByRole("region", { name: "文件预览" });
    const block = preview.querySelector('[data-slot="empty-state"]');
    expect(block?.firstElementChild?.textContent).toBe(title);
    expect(block?.querySelector('[data-slot="empty-state-desc"]')?.textContent).toBe(description);
  });
  expect(previewRegion().queryByRole("alert")).toBeNull();
}

function fileRequests(fetchMock: ReturnType<typeof renderFiles>["fetchMock"]) {
  return paths(fetchMock).filter((path) => path.includes("/file?"));
}

describe("文件页的预览状态", () => {
  it("未知文件由服务端裁决：schema.proto 按文本显示为带行号的源码，blob.bin 得到 415 后显示不支持，各恰一次 file 请求", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "schema.proto": { size: 30, route: textPreviewResponse('syntax = "proto3";\nmessage A {}') },
      "blob.bin": { size: 91, route: unsupported() },
    });

    await select("schema.proto");
    expect(await previewRegion().findByRole("cell", { name: 'syntax = "proto3";' })).toBeTruthy();
    expect(
      previewRegion()
        .getAllByRole("row")
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent),
    ).toStrictEqual(["1", "2"]);
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}schema.proto`]);

    await select("blob.bin");
    await expectEmptyState("该类型不支持预览", "blob.bin · 91 B");
    expectDownloadLink("blob.bin");
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}schema.proto`, `${FILE}blob.bin`]);
  });

  it("信封残缺的 415 与 413 不算不支持或超限：显示请求失败的安全文案，下载链接仍在", async () => {
    renderWorkspaceWith({
      "bare.bin": { size: 91, route: new Response("unsupported media type", { status: 415 }) },
      "bare.png": { size: 91, route: jsonResponse({ code: "preview_too_large" }, 413) },
    });

    for (const name of ["bare.bin", "bare.png"]) {
      await select(name);
      await waitFor(() => expectDownloadLink(name));
      expect((await previewRegion().findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
      expect(screen.queryByText("该类型不支持预览")).toBeNull();
      expect(screen.queryByText("文件过大，无法预览")).toBeNull();
    }
  });

  it("每个文件都能下载：可预览、不支持、超限与压缩包的预览头都有下载链接，页面不对 download 地址发请求", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "readme.md": { size: 4, route: textPreviewResponse("# 说明") },
      "blob.bin": { size: 91, route: unsupported() },
      "huge.png": {
        size: 22_020_096,
        route: jsonResponse(
          { error: { code: "preview_too_large", message: "文件过大，无法预览" } },
          413,
        ),
      },
      "archive.zip": { size: 2048, route: unsupported() },
    });

    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    expectDownloadLink("readme.md");

    await select("blob.bin");
    await expectEmptyState("该类型不支持预览", "blob.bin · 91 B");
    expectDownloadLink("blob.bin");

    await select("huge.png");
    await expectEmptyState("文件过大，无法预览", "huge.png · 21.0 MB");
    expectDownloadLink("huge.png");

    await select("archive.zip");
    await expectEmptyState("该类型不支持预览", "archive.zip · 2.0 KB");
    expectDownloadLink("archive.zip");

    expect(fileRequests(fetchMock)).toStrictEqual(
      ["readme.md", "blob.bin", "huge.png", "archive.zip"].map((name) => `${FILE}${name}`),
    );
    expect(paths(fetchMock).filter((path) => path.includes("/download"))).toStrictEqual([]);
  });

  it("截断提示：带截断头的 big.log 显示源码与一行按响应头大小写成的提示", async () => {
    renderWorkspaceWith({
      "big.log": {
        size: 2048,
        route: new Response("line 1\nline 2", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Workbuddy-Size": "1572864",
            "X-Workbuddy-Truncated": "1",
          },
        }),
      },
    });

    await select("big.log");
    expect(await previewRegion().findByRole("cell", { name: "line 1" })).toBeTruthy();
    expect(
      previewRegion().getByText("文件超过预览上限，仅显示开头部分 · 共 1.5 MB", { exact: true }),
    ).toBeTruthy();
    expect(previewRegion().queryByText(/共 2\.0 KB/)).toBeNull();
    expectDownloadLink("big.log");
  });

  it("视频在其预览器合入之前：200 的 video/mp4 显示请求失败的安全文案与下载链接，该请求随后被中止", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "clip.mp4": {
        size: 8,
        route: new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "Content-Type": "video/mp4", "X-Workbuddy-Size": "8" },
        }),
      },
    });

    await select("clip.mp4");
    expect((await previewRegion().findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    expectDownloadLink("clip.mp4");
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}clip.mp4`]);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([path]) => path === `${FILE}clip.mp4`);
      expect(call?.[1]?.signal?.aborted).toBe(true);
    });
  });

  it("已显示的图片在刷新时重取失败：换成不支持态，它的 Blob 地址被释放", async () => {
    const blobUrls = stubBlobUrls(["blob:x"]);
    renderWorkspaceWith({
      "logo.png": { size: 8, route: [imagePreviewResponse(), unsupported()] },
    });

    await select("logo.png");
    expect(await screen.findByRole("img", { name: "logo.png" })).toBeTruthy();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await expectEmptyState("该类型不支持预览", "logo.png · 8 B");
    expect(screen.queryByRole("img", { name: "logo.png" })).toBeNull();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:x"]]);
  });

  it("StrictMode 下图片显示后切换工作空间，它的 Blob 地址恰被释放一次", async () => {
    const blobUrls = stubBlobUrls(["blob:x"]);
    renderWorkspaceWith({ "logo.png": { size: 8, route: imagePreviewResponse() } }, true);

    await select("logo.png");
    const image = await screen.findByRole("img", { name: "logo.png" });
    expect(image.getAttribute("src")).toBe("blob:x");
    expect(blobUrls.createObjectURL.mock.calls).toHaveLength(1);
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([]);

    await selectWorkspaceByName(/数据分析/);
    await screen.findByText("未选择文件", { exact: true });
    expect(screen.queryByRole("img", { name: "logo.png" })).toBeNull();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:x"]]);
  });
});
