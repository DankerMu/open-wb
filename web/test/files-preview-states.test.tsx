import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
import { deferredResponse, jsonResponse, paths, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * file-previewers「预览头、下载与不可预览的呈现」与「未知文件由服务端裁决」的页面级场景：
 * 浏览器不按扩展名预筛，每个文件发一次 `file` 请求，由应答决定呈现；预览头的下载链接哪一态都在。
 * 音视频除外（file-previewers「音视频」）：选中即把文件自己的地址交给媒体元素，页面不为它发 `file` 请求。
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

/** 预览区里的媒体元素（它们没有 ARIA role）；取不到就抛，供 `waitFor` 重试。 */
function mediaElement(tag: "audio" | "video") {
  const element = screen.getByRole("region", { name: "文件预览" }).querySelector(tag);
  if (!element) {
    throw new Error(`no ${tag} in the preview`);
  }
  return element;
}

/** 整个文档里的媒体元素标签名，按文档顺序。 */
function mediaElements() {
  return [...document.querySelectorAll("audio, video")].map((element) => element.tagName);
}

function mediaAttributes(element: Element) {
  return {
    controls: element.hasAttribute("controls"),
    preload: element.getAttribute("preload"),
    autoplay: element.hasAttribute("autoplay"),
    src: element.getAttribute("src"),
  };
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

  it("未读正文就判失败的应答被中止：文本类名字 clip.dat 回 200 的 video/mp4，显示请求失败的安全文案与下载链接，该请求随后被中止", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "clip.dat": {
        size: 8,
        route: new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
          headers: { "Content-Type": "video/mp4", "X-Workbuddy-Size": "8" },
        }),
      },
    });

    await select("clip.dat");
    expect((await previewRegion().findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    expectDownloadLink("clip.dat");
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}clip.dat`]);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([path]) => path === `${FILE}clip.dat`);
      expect(call?.[1]?.signal?.aborted).toBe(true);
    });
  });

  it("音视频不经 fetchPreview：clip.mp4 是 video、voice.mp3 是 audio，src 恰为各自的 file 地址，下载链接仍在，页面没有为它们发 file 请求", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "readme.md": { size: 4, route: textPreviewResponse("# 说明") },
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
      "voice.mp3": { size: 4096, route: new Error("voice.mp3 must not be fetched") },
    });

    // 先留下一条 file 记录：下面「没有新增」比的是非空列表，不是空对空。
    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`]);

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    expect(mediaAttributes(video)).toStrictEqual({
      controls: true,
      preload: "metadata",
      autoplay: false,
      src: `${FILE}clip.mp4`,
    });
    expect(mediaElements()).toStrictEqual(["VIDEO"]);
    expectDownloadLink("clip.mp4");
    expect(previewRegion().queryByRole("alert")).toBeNull();
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    await select("voice.mp3");
    const audio = await waitFor(() => mediaElement("audio"));
    expect(mediaAttributes(audio)).toStrictEqual({
      controls: true,
      preload: "metadata",
      autoplay: false,
      src: `${FILE}voice.mp3`,
    });
    expect(mediaElements()).toStrictEqual(["AUDIO"]);
    expectDownloadLink("voice.mp3");
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`]);
  });

  it("媒体地址按整段路径编码：uploads 下名字含空格、中文与井号的视频，src 与下载地址都是写死的含 uploads%2F 的编码结果", async () => {
    const name = "会议 录像#1.mp4";
    // 整段路径 `uploads/会议 录像#1.mp4` 的编码：目录分隔符也在里面，只传文件名得不到它。
    const encoded = "uploads%2F%E4%BC%9A%E8%AE%AE%20%E5%BD%95%E5%83%8F%231.mp4";
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace, secondWorkspace], {
        "/api/workspaces/workspace-1/tree?path=": () =>
          jsonResponse({
            path: "",
            entries: [{ name: "uploads", type: "dir", size: 0, mtime: 100 }],
          }),
        "/api/workspaces/workspace-1/tree?path=uploads": () =>
          jsonResponse({
            path: "uploads",
            entries: [{ name, type: "file", size: 2048, mtime: 101 }],
          }),
        [`${FILE}${encoded}`]: new Error("the video must not be fetched"),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "展开 uploads" }));
    await select(name);
    const video = await waitFor(() => mediaElement("video"));
    expect(video.getAttribute("src")).toBe(`${FILE}${encoded}`);
    expect(
      previewRegion()
        .getByRole("link", { name: `下载 ${name}` })
        .getAttribute("href"),
    ).toBe(`${DOWNLOAD}${encoded}`);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });

  it("文本预览还在途时选中视频：那个请求被中止，它迟到的正文不顶掉播放器", async () => {
    const pending = deferredResponse();
    const { fetchMock } = renderWorkspaceWith({
      "readme.md": { size: 4, route: () => pending.promise },
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });

    await select("readme.md");
    await waitFor(() => expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`]));
    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    const call = fetchMock.mock.calls.find(([path]) => path === `${FILE}readme.md`);
    expect(call?.[1]?.signal?.aborted).toBe(true);
    // 在途请求留下的读取提示随之收起：媒体没有要等的请求。
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    await act(async () => {
      pending.resolve(textPreviewResponse("# 说明"));
      await pending.promise;
    });
    await yieldMacrotask();
    expect(mediaElement("video")).toBe(video);
    expect(screen.queryByRole("heading", { level: 1, name: "说明" })).toBeNull();
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`]);
  });

  it("先图片后音频：选中 voice.mp3 时 logo.png 的 Blob 地址恰被释放一次", async () => {
    const blobUrls = stubBlobUrls(["blob:x"]);
    renderWorkspaceWith({
      "logo.png": { size: 8, route: imagePreviewResponse() },
      "voice.mp3": { size: 4096, route: new Error("voice.mp3 must not be fetched") },
    });

    await select("logo.png");
    expect(await screen.findByRole("img", { name: "logo.png" })).toBeTruthy();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([]);

    await select("voice.mp3");
    await waitFor(() => mediaElement("audio"));
    expect(screen.queryByRole("img", { name: "logo.png" })).toBeNull();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:x"]]);
  });

  it("换文件与换工作空间都移除媒体元素：视频之后选 readme.md，再选回视频后切空间，文档里都没有 video", async () => {
    renderWorkspaceWith({
      "readme.md": { size: 4, route: textPreviewResponse("# 说明") },
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });

    await select("clip.mp4");
    await waitFor(() => mediaElement("video"));

    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    expect(document.querySelectorAll("audio, video")).toHaveLength(0);

    await select("clip.mp4");
    await waitFor(() => mediaElement("video"));
    await selectWorkspaceByName(/数据分析/);
    await screen.findByText("未选择文件", { exact: true });
    expect(document.querySelectorAll("audio, video")).toHaveLength(0);
  });

  it("播放失败：video 触发 error 后显示「无法播放该文件」，下载链接仍在，页面不弹 Toast", async () => {
    renderWorkspaceWith({
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });
    const toasts = screen.getByRole("region", { name: "通知" });

    await select("clip.mp4");
    fireEvent.error(await waitFor(() => mediaElement("video")));

    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    expect(mediaElements()).toStrictEqual([]);
    expectDownloadLink("clip.mp4");
    // Toast 是通知区列表里的一项（类名 ui-toast，自身不带 role）。
    expect(within(toasts).queryByRole("listitem")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    expect(previewRegion().queryByRole("alert")).toBeNull();
  });

  it("刷新不重取也不重挂媒体：点「刷新」后还是同一个 video 元素，没有 file 请求；失败态在刷新与再点同一行之后都保留", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });
    const treeRequests = () => paths(fetchMock).filter((path) => path.includes("/tree?"));

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    expect(treeRequests()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(treeRequests()).toHaveLength(2));
    await yieldMacrotask();
    expect(mediaElement("video")).toBe(video);
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    fireEvent.error(video);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(treeRequests()).toHaveLength(3));
    await yieldMacrotask();
    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    expect(mediaElements()).toStrictEqual([]);

    // 再点一次同一行也一样：地址没变，预览体不重挂。
    await select("clip.mp4");
    await yieldMacrotask();
    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    expect(mediaElements()).toStrictEqual([]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
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
