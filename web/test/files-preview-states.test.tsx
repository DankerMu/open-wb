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
import {
  currentLocation,
  deferredResponse,
  jsonResponse,
  paths,
  textPreviewResponse,
} from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * file-previewers「预览头、下载与不可预览的呈现」与「未知文件由服务端裁决」的页面级场景：
 * 浏览器不按扩展名预筛，每个文件发一次 `file` 请求，由应答决定呈现；预览头的下载链接哪一态都在。
 * 音视频除外（file-previewers「音视频」）：选中即把文件自己的地址交给媒体元素，页面不为它发 `file` 请求；
 * 刷新与再点同一行之后那个地址追加 `&v=<n>`，n 在整个测试文件里只增（计数在模块级，跨用例累加）。
 * 压缩包也除外（file-previewers「压缩包列表」）：选中发一次 `archive` 请求列出成员，不发 `file` 请求。
 */

afterEach(() => {
  cleanupFilesFixture();
});

const FILE = "/api/workspaces/workspace-1/file?path=";
const DOWNLOAD = "/api/workspaces/workspace-1/download?path=";
const ARCHIVE = "/api/workspaces/workspace-1/archive?path=";

type FileFixture = { size: number; route: FetchRoutes[string] };

function unsupported() {
  return jsonResponse({ error: { code: "preview_unsupported", message: "该类型不支持预览" } }, 415);
}

/** 一次 `archive` 应答；函数形式，供同一文件被列出多次。 */
function archiveListing(...members: string[]) {
  return () =>
    jsonResponse({
      format: "zip",
      entries: members.map((path, index) => ({ path, type: "file", size: index + 1 })),
      truncated: false,
    });
}

/**
 * 根目录下恰有 `files` 这些文件的空间；每个文件的 `file` 路由就是它的 `route`，`extraRoutes` 是
 * 另外的路由（压缩包的 `archive`）。
 */
function renderWorkspaceWith(
  files: Record<string, FileFixture>,
  strict = false,
  extraRoutes: FetchRoutes = {},
) {
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
      ...extraRoutes,
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

/**
 * 重取之后的媒体地址：恰为 `${url}&v=<n>`，n 是不带前导零的正整数；返回 n 供调用方比大小。
 * 取不出 n 时下面的断言以 `&v=NaN` 判红。
 */
function refetchVersion(element: Element, url: string) {
  const src = element.getAttribute("src");
  const n = Number(/&v=([1-9]\d*)$/.exec(src ?? "")?.[1]);
  expect(src).toBe(`${url}&v=${n}`);
  return n;
}

function fileRequests(fetchMock: ReturnType<typeof renderFiles>["fetchMock"]) {
  return paths(fetchMock).filter((path) => path.includes("/file?"));
}

function archiveRequests(fetchMock: ReturnType<typeof renderFiles>["fetchMock"]) {
  return paths(fetchMock).filter((path) => path.includes("/archive?"));
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
    const { fetchMock } = renderWorkspaceWith(
      {
        "readme.md": { size: 4, route: textPreviewResponse("# 说明") },
        "blob.bin": { size: 91, route: unsupported() },
        "huge.png": {
          size: 22_020_096,
          route: jsonResponse(
            { error: { code: "preview_too_large", message: "文件过大，无法预览" } },
            413,
          ),
        },
        "archive.zip": { size: 2048, route: new Error("archive.zip must not be fetched") },
      },
      false,
      { [`${ARCHIVE}archive.zip`]: archiveListing("inner/note.txt") },
    );

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
    expect(await previewRegion().findByRole("cell", { name: "inner/note.txt" })).toBeTruthy();
    expectDownloadLink("archive.zip");

    expect(fileRequests(fetchMock)).toStrictEqual(
      ["readme.md", "blob.bin", "huge.png"].map((name) => `${FILE}${name}`),
    );
    expect(archiveRequests(fetchMock)).toStrictEqual([`${ARCHIVE}archive.zip`]);
    expect(paths(fetchMock).filter((path) => path.includes("/download"))).toStrictEqual([]);
  });

  it("压缩包的刷新与再点同一行各重新列出一次：archive 请求依次为一、二、三次，前一次的 signal 已中止，全程没有 file 请求", async () => {
    let listed = 0;
    const { fetchMock } = renderWorkspaceWith(
      { "archive.zip": { size: 2048, route: new Error("archive.zip must not be fetched") } },
      false,
      {
        [`${ARCHIVE}archive.zip`]: () => {
          listed += 1;
          return archiveListing(`第 ${listed} 次.txt`)();
        },
      },
    );
    const signals = () =>
      fetchMock.mock.calls
        .filter(([path]) => path.includes("/archive?"))
        .map(([, options]) => options?.signal?.aborted);

    await select("archive.zip");
    expect(await previewRegion().findByRole("cell", { name: "第 1 次.txt" })).toBeTruthy();
    expect(archiveRequests(fetchMock)).toStrictEqual([`${ARCHIVE}archive.zip`]);
    expect(previewRegion().getByText("共 1 项", { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await previewRegion().findByRole("cell", { name: "第 2 次.txt" })).toBeTruthy();
    expect(previewRegion().queryByRole("cell", { name: "第 1 次.txt" })).toBeNull();
    expect(archiveRequests(fetchMock)).toStrictEqual([
      `${ARCHIVE}archive.zip`,
      `${ARCHIVE}archive.zip`,
    ]);
    expectDownloadLink("archive.zip");

    await select("archive.zip");
    expect(await previewRegion().findByRole("cell", { name: "第 3 次.txt" })).toBeTruthy();
    expect(archiveRequests(fetchMock)).toHaveLength(3);
    expect(signals().slice(0, 2)).toStrictEqual([true, true]);
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });

  it("先图片后压缩包再回文本：选中压缩包时图片的 Blob 地址恰被释放一次；切走后表格消失，切换工作空间后也没有表格", async () => {
    const blobUrls = stubBlobUrls(["blob:x"]);
    const { fetchMock } = renderWorkspaceWith(
      {
        "logo.png": { size: 8, route: imagePreviewResponse() },
        "archive.zip": { size: 2048, route: new Error("archive.zip must not be fetched") },
        "readme.md": { size: 4, route: textPreviewResponse("# 说明") },
      },
      false,
      { [`${ARCHIVE}archive.zip`]: archiveListing("inner/note.txt") },
    );

    await select("logo.png");
    expect(await screen.findByRole("img", { name: "logo.png" })).toBeTruthy();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([]);

    await select("archive.zip");
    expect(await previewRegion().findByRole("cell", { name: "inner/note.txt" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "logo.png" })).toBeNull();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:x"]]);

    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    expect(previewRegion().queryByRole("cell", { name: "inner/note.txt" })).toBeNull();

    await select("archive.zip");
    expect(await previewRegion().findByRole("cell", { name: "inner/note.txt" })).toBeTruthy();
    await selectWorkspaceByName(/数据分析/);
    await screen.findByText("未选择文件", { exact: true });
    expect(screen.queryByRole("cell", { name: "inner/note.txt" })).toBeNull();
    expect(archiveRequests(fetchMock)).toHaveLength(2);
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}logo.png`, `${FILE}readme.md`]);
  });

  it("压缩包的列表请求按整段路径编码：uploads 下名字含空格、中文与井号的压缩包，请求地址是写死的含 uploads%2F 的编码结果", async () => {
    const name = "会议 归档#1.zip";
    // 整段路径 `uploads/会议 归档#1.zip` 的编码：目录分隔符也在里面，只传文件名得不到它。
    const encoded = "uploads%2F%E4%BC%9A%E8%AE%AE%20%E5%BD%92%E6%A1%A3%231.zip";
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
        [`${ARCHIVE}${encoded}`]: archiveListing("inner/note.txt"),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "展开 uploads" }));
    await select(name);
    expect(await previewRegion().findByRole("cell", { name: "inner/note.txt" })).toBeTruthy();
    expect(archiveRequests(fetchMock)).toStrictEqual([`${ARCHIVE}${encoded}`]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });

  it("损坏的压缩包：archive 答 415 时显示「无法读取该压缩包」而不是不支持态，下载链接仍在，页面不弹 Toast，没有 file 请求", async () => {
    const { fetchMock } = renderWorkspaceWith(
      { "broken.zip": { size: 39, route: new Error("broken.zip must not be fetched") } },
      false,
      { [`${ARCHIVE}broken.zip`]: unsupported },
    );
    const toasts = screen.getByRole("region", { name: "通知" });

    await select("broken.zip");
    expect((await previewRegion().findByRole("alert")).textContent).toBe("无法读取该压缩包");
    expect(screen.queryByText("该类型不支持预览")).toBeNull();
    expectDownloadLink("broken.zip");
    // 让出一轮：Toast 若有，是在文案之后的一次状态更新里才进通知区的。
    await yieldMacrotask();
    expect(within(toasts).queryByRole("listitem")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    expect(archiveRequests(fetchMock)).toStrictEqual([`${ARCHIVE}broken.zip`]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
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

  it("播放失败：video 触发 error 后显示「无法播放该文件」，下载链接仍在，页面不弹 Toast，不另发请求", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });
    const toasts = screen.getByRole("region", { name: "通知" });

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    const requested = paths(fetchMock);
    fireEvent.error(video);

    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    expect(mediaElements()).toStrictEqual([]);
    expectDownloadLink("clip.mp4");
    // error 之后页面不为它另发任何请求（不探测状态码，也不问认证守卫）。
    await yieldMacrotask();
    expect(paths(fetchMock)).toStrictEqual(requested);
    // Toast 是通知区列表里的一项（类名 ui-toast，自身不带 role）。
    expect(within(toasts).queryByRole("listitem")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    expect(previewRegion().queryByRole("alert")).toBeNull();
  });

  it("刷新与再点同一行都换一个新的媒体元素：src 由 file 地址变为其后追加 &v=<n>、n 一次比一次大，没有 file 请求；已显示的「无法播放该文件」在刷新与再点同一行之后各自清除，播放器回来", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });
    const treeRequests = () => paths(fetchMock).filter((path) => path.includes("/tree?"));

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    expect(video.getAttribute("src")).toBe(`${FILE}clip.mp4`);
    expect(treeRequests()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(treeRequests()).toHaveLength(2));
    await yieldMacrotask();
    const refreshed = mediaElement("video");
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect(refreshed).toBeInstanceOf(HTMLVideoElement);
    expect(refreshed).not.toBe(video);
    const first = refetchVersion(refreshed, `${FILE}clip.mp4`);
    expect(mediaAttributes(refreshed)).toStrictEqual({
      controls: true,
      preload: "metadata",
      autoplay: false,
      src: `${FILE}clip.mp4&v=${first}`,
    });
    expect(mediaElements()).toStrictEqual(["VIDEO"]);
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    fireEvent.error(refreshed);
    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    expect(mediaElements()).toStrictEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(treeRequests()).toHaveLength(3));
    await yieldMacrotask();
    expect(previewRegion().queryByText("无法播放该文件")).toBeNull();
    const retried = mediaElement("video");
    expect(retried).not.toBe(refreshed);
    const second = refetchVersion(retried, `${FILE}clip.mp4`);
    expect(second).toBeGreaterThan(first);

    // 再点一次同一行也一样：失败态清掉，换一个新元素；没在失败态时同样换。
    fireEvent.error(retried);
    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    await select("clip.mp4");
    await yieldMacrotask();
    expect(previewRegion().queryByText("无法播放该文件")).toBeNull();
    const clicked = mediaElement("video");
    expect(clicked).not.toBe(retried);
    const third = refetchVersion(clicked, `${FILE}clip.mp4`);
    expect(third).toBeGreaterThan(second);
    await select("clip.mp4");
    await yieldMacrotask();
    expect(mediaElement("video")).not.toBe(clicked);
    expect(refetchVersion(mediaElement("video"), `${FILE}clip.mp4`)).toBeGreaterThan(third);
    expect(mediaElements()).toStrictEqual(["VIDEO"]);
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });

  it("刷新总是重取：clip.mp4 触发 error 后点「刷新」换成新的 video、文案消失、src 由 file 地址变为其后追加 &v=<n>、再点一次 n 更大、没有 file 请求；归档.zip 的第二次 archive 应答挂起时旧列表仍在且其后是「正在读取文件」，应答到达后换成新列表、状态行消失", async () => {
    const second = deferredResponse();
    const listings = [archiveListing("旧.txt")(), second.promise];
    const { fetchMock } = renderWorkspaceWith(
      {
        "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
        "归档.zip": { size: 2048, route: new Error("归档.zip must not be fetched") },
      },
      false,
      {
        [`${ARCHIVE}%E5%BD%92%E6%A1%A3.zip`]: () => listings.shift() ?? new Error("第三次 archive"),
      },
    );

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    expect(video.getAttribute("src")).toBe(`${FILE}clip.mp4`);
    fireEvent.error(video);
    expect(previewRegion().getByText("无法播放该文件", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(mediaElement("video")).not.toBe(video));
    expect(previewRegion().queryByText("无法播放该文件")).toBeNull();
    const refreshed = mediaElement("video");
    const first = refetchVersion(refreshed, `${FILE}clip.mp4`);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(mediaElement("video")).not.toBe(refreshed));
    expect(refetchVersion(mediaElement("video"), `${FILE}clip.mp4`)).toBeGreaterThan(first);
    expect(fileRequests(fetchMock)).toStrictEqual([]);

    await select("归档.zip");
    expect(await previewRegion().findByRole("cell", { name: "旧.txt" })).toBeTruthy();
    expect(archiveRequests(fetchMock)).toStrictEqual([`${ARCHIVE}%E5%BD%92%E6%A1%A3.zip`]);
    expect(previewRegion().queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(archiveRequests(fetchMock)).toHaveLength(2));
    await yieldMacrotask();
    expect(archiveRequests(fetchMock)).toStrictEqual([
      `${ARCHIVE}%E5%BD%92%E6%A1%A3.zip`,
      `${ARCHIVE}%E5%BD%92%E6%A1%A3.zip`,
    ]);
    const table = previewRegion().getByRole("table", { name: "压缩包成员" });
    expect(within(table).getByRole("cell", { name: "旧.txt" })).toBeTruthy();
    const status = previewRegion().getByRole("status");
    expect(status.textContent).toBe("正在读取文件");
    expect(table.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    second.resolve(archiveListing("新-1.txt", "新-2.txt")());
    expect(await previewRegion().findByRole("cell", { name: "新-1.txt" })).toBeTruthy();
    expect(previewRegion().queryByRole("cell", { name: "旧.txt" })).toBeNull();
    expect(previewRegion().getByText("共 2 项", { exact: true })).toBeTruthy();
    expect(previewRegion().queryByRole("status")).toBeNull();
    expect(archiveRequests(fetchMock)).toHaveLength(2);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });

  it("v 只在重取后的媒体 src 上：改选 readme.md 再选回 clip.mp4 不带 v，此后刷新的 n 仍大于此前各次；下载链接、页面地址与 readme.md 重取的 file 请求都不带 v", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "readme.md": { size: 4, route: textPreviewResponse("# 说明") },
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });
    const refresh = async (previous: Element) => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => expect(mediaElement("video")).not.toBe(previous));
      return mediaElement("video");
    };

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    expect(video.getAttribute("src")).toBe(`${FILE}clip.mp4`);
    const address = currentLocation();
    expect(address).toBe("/files?ws=workspace-1&path=clip.mp4");

    const refreshed = await refresh(video);
    const first = refetchVersion(refreshed, `${FILE}clip.mp4`);
    const again = await refresh(refreshed);
    const second = refetchVersion(again, `${FILE}clip.mp4`);
    expect(second).toBeGreaterThan(first);
    expectDownloadLink("clip.mp4");
    await yieldMacrotask();
    expect(currentLocation()).toBe(address);

    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(fileRequests(fetchMock)).toHaveLength(2));
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`, `${FILE}readme.md`]);

    await select("clip.mp4");
    const back = await waitFor(() => mediaElement("video"));
    expect(back.getAttribute("src")).toBe(`${FILE}clip.mp4`);
    expect(refetchVersion(await refresh(back), `${FILE}clip.mp4`)).toBeGreaterThan(second);
    expectDownloadLink("clip.mp4");
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`, `${FILE}readme.md`]);
  });

  it("n 不随工作空间切换归零：clip.mp4 刷新两次后切到数据分析再切回设计文档，重新选中 clip.mp4 不带 v，此后刷新的 n 大于切换前各次", async () => {
    const { fetchMock } = renderWorkspaceWith({
      "clip.mp4": { size: 2048, route: new Error("clip.mp4 must not be fetched") },
    });
    const refresh = async (previous: Element) => {
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => expect(mediaElement("video")).not.toBe(previous));
      return mediaElement("video");
    };

    await select("clip.mp4");
    const video = await waitFor(() => mediaElement("video"));
    expect(video.getAttribute("src")).toBe(`${FILE}clip.mp4`);
    const refreshed = await refresh(video);
    const first = refetchVersion(refreshed, `${FILE}clip.mp4`);
    const second = refetchVersion(await refresh(refreshed), `${FILE}clip.mp4`);
    expect(second).toBeGreaterThan(first);

    await selectWorkspaceByName(/数据分析/);
    await screen.findByText("未选择文件", { exact: true });
    expect(mediaElements()).toStrictEqual([]);
    await selectWorkspaceByName(/设计文档/);

    await select("clip.mp4");
    const back = await waitFor(() => mediaElement("video"));
    expect(back.getAttribute("src")).toBe(`${FILE}clip.mp4`);
    expect(refetchVersion(await refresh(back), `${FILE}clip.mp4`)).toBeGreaterThan(second);
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
