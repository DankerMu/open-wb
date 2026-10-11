// file-previewers「隔离来源的嵌入与令牌」的场景「网页渲染视图」「路径编码」「签发失败」，与 files-web
// 「目录树与预览」里网页不发 `file` 请求的例外。两段：组件级静态导入预览器、令牌作属性给入，同步断言；
// 页面级经文件页与假 fetch，iframe 在签发落定之后才有，一律 `findBy…` / `waitFor` 取到再断言。
// jsdom 不为 iframe 导航：这里钉的是属性值与请求次数。框内文档的来源、是否带凭据、同目录资源是否
// 生效都不在这个文件里。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPreviewer } from "../src/features/files/previewers/frame.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  type FetchRoutes,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { deferredResponse, jsonResponse, paths, textPreviewResponse } from "./support.js";
import { listRepoFiles, readRepoFile, stripTsComments, yieldMacrotask } from "./ui-support.js";

afterEach(() => {
  cleanup();
  cleanupFilesFixture();
});

/** 夹具令牌：长度与真实令牌相同，但不是十六进制。 */
const TOKEN = "t".repeat(64);
const PREVIEW_HOST = "preview.example.test";
const BASE = `https://${PREVIEW_HOST}/w/${TOKEN}/`;
const SANDBOX = "allow-scripts allow-forms allow-modals";

type Web = NonNullable<ComponentProps<typeof WebPreviewer>["web"]>;

function ready(base = BASE): Web["token"] {
  return {
    status: "ready",
    base,
    officeBase: `https://${PREVIEW_HOST}/o/${TOKEN}/`,
    documentMaxBytes: 1_000,
    officeAvailable: true,
  };
}

function web(patch: Partial<Web> = {}): Web {
  return {
    path: "site/index.html",
    token: ready(),
    view: "rendered",
    reload: 0,
    onViewChange: () => {},
    source: null,
    ...patch,
  };
}

function frame(): HTMLIFrameElement {
  const element = document.querySelector("iframe");
  if (!(element instanceof HTMLIFrameElement)) {
    throw new Error("no iframe in the document");
  }
  return element;
}

describe("网页预览器（组件级）：iframe 的属性", () => {
  it("sandbox 恰为三个令牌，referrerpolicy 为 no-referrer，title 为文件名，没有 srcdoc，文档里只有这一个 iframe", () => {
    render(<WebPreviewer name="index.html" web={web()} />);

    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-modals");
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame().getAttribute("title")).toBe("index.html");
    expect(frame().hasAttribute("srcdoc")).toBe(false);
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
  });

  it.each([
    ["site/index.html", "site/index.html"],
    ["报告 2026/a b#1.html", "%E6%8A%A5%E5%91%8A%202026/a%20b%231.html"],
    ["q?x=1&y/100%.html", "q%3Fx%3D1%26y/100%25.html"],
  ])("路径编码：%s 的 src 是 base 后接各段分别编码的路径，斜杠保留", (path, encoded) => {
    render(<WebPreviewer name="x.html" web={web({ path })} />);

    expect(frame().getAttribute("src")).toBe(`https://${PREVIEW_HOST}/w/${TOKEN}/${encoded}`);
  });

  // 期望值是手写的字面量。这里只说属性里写了什么；浏览器解析这个地址时怎样处理点段与连续的斜杠、
  // 监听器怎样裁决，不在这个文件里。
  it.each([
    ["首尾空格", " a /b .html", "%20a%20/b%20.html"],
    ["两点段", "a/../b.html", "a/../b.html"],
    ["开头的两点段", "../b.html", "../b.html"],
    ["开头的斜杠", "/abs.html", "/abs.html"],
    ["空段", "a//b.html", "a//b.html"],
    ["合成形式的 é", "café.html", "caf%C3%A9.html"],
    ["分解形式的 é", "café.html", "cafe%CC%81.html"],
    ["反斜杠", "a\\b.html", "a%5Cb.html"],
  ])("路径是数据：%s 不被裁剪或规范化，src 逐字等于按段编码的结果", (_label, path, encoded) => {
    render(<WebPreviewer name="x.html" web={web({ path })} />);

    expect(frame().getAttribute("src")).toBe(`https://${PREVIEW_HOST}/w/${TOKEN}/${encoded}`);
  });
});

describe("网页预览器（组件级）：没有可用令牌时", () => {
  it.each([
    ["idle", { status: "idle" }],
    ["loading", { status: "loading" }],
  ] as const)("令牌是 %s：显示「正在加载预览…」，没有 iframe，切换按钮在", (_label, token) => {
    render(<WebPreviewer name="index.html" web={web({ token })} />);

    expect(screen.getByRole("status").textContent).toBe("正在加载预览…");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
  });

  it("令牌是 error：alert 里是它的 message，没有 iframe，切换按钮在", () => {
    render(
      <WebPreviewer
        name="index.html"
        web={web({ token: { status: "error", message: "预览未启用" } })}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("预览未启用");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
  });

  it("不经页面直接渲染、没有 web 属性：显示请求失败的安全文案，没有 iframe 也没有按钮", () => {
    render(<WebPreviewer name="index.html" />);

    expect(screen.getByRole("alert").textContent).toBe("请求失败，请稍后重试");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("网页预览器（组件级）：续期、换地址与刷新", () => {
  it("base 相同的新令牌对象不换 iframe 节点、src 不变；base 变了同一个节点的 src 跟着变；reload 加一换成新节点", () => {
    const view = render(<WebPreviewer name="index.html" web={web()} />);
    const first = frame();
    expect(first).toBeInstanceOf(HTMLIFrameElement);
    expect(first.getAttribute("src")).toBe(`${BASE}site/index.html`);

    view.rerender(<WebPreviewer name="index.html" web={web({ token: ready() })} />);
    expect(frame()).toBe(first);
    expect(frame().getAttribute("src")).toBe(`${BASE}site/index.html`);

    const moved = `https://${PREVIEW_HOST}/w/${"u".repeat(64)}/`;
    view.rerender(<WebPreviewer name="index.html" web={web({ token: ready(moved) })} />);
    // 同一个节点换了地址：框只按 reload 换节点，不按令牌或 base。
    expect(frame()).toBe(first);
    expect(frame().getAttribute("src")).toBe(`${moved}site/index.html`);

    const before = frame();
    view.rerender(<WebPreviewer name="index.html" web={web({ token: ready(moved), reload: 1 })} />);
    expect(before).toBeInstanceOf(HTMLIFrameElement);
    expect(frame()).toBeInstanceOf(HTMLIFrameElement);
    expect(frame()).not.toBe(before);
    expect(frame().getAttribute("src")).toBe(`${moved}site/index.html`);
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-modals");
  });
});

describe("网页预览器（组件级）：渲染与源码的切换", () => {
  it("渲染视图点「查看源码」以 source 回调一次；源码视图显示交进来的节点、没有 iframe，点「渲染视图」以 rendered 回调一次", () => {
    const onViewChange = vi.fn<Web["onViewChange"]>();
    const view = render(<WebPreviewer name="index.html" web={web({ onViewChange })} />);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(onViewChange.mock.calls).toStrictEqual([["source"]]);
    // 视图归宿主：回调之后属性没变，仍是渲染视图。
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    view.rerender(
      <WebPreviewer
        name="index.html"
        web={web({ onViewChange, view: "source", source: <p>源码在这里</p> })}
      />,
    );
    expect(screen.getByText("源码在这里")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    expect(onViewChange.mock.calls).toStrictEqual([["source"], ["rendered"]]);
  });

  it("源码视图下令牌失败不显示失败文案：那是渲染视图的事", () => {
    render(
      <WebPreviewer
        name="index.html"
        web={web({
          token: { status: "error", message: "预览未启用" },
          view: "source",
          source: <p>源码在这里</p>,
        })}
      />,
    );

    expect(screen.getByText("源码在这里")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("令牌 hook 的调用点", () => {
  it("web/src 里恰有一处调用，在 workspace-browser.tsx；frame.tsx 与 preview.tsx 没有", () => {
    const callers = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path)).filter(
      (path) => path !== "web/src/features/files/use-preview-token.ts",
    );
    const counts = callers
      .map((path) => ({
        path,
        calls: stripTsComments(readRepoFile(path)).split("usePreviewToken(").length - 1,
      }))
      .filter((entry) => entry.calls > 0);

    expect(callers).toContain("web/src/features/files/previewers/frame.tsx");
    expect(callers).toContain("web/src/features/files/preview.tsx");
    expect(counts).toStrictEqual([
      { path: "web/src/features/files/workspace-browser.tsx", calls: 1 },
    ]);
  });
});

const TREE = "/api/workspaces/workspace-1/tree?path=";
const FILE = "/api/workspaces/workspace-1/file?path=";
const DOWNLOAD = "/api/workspaces/workspace-1/download?path=";
const ISSUE = "/api/workspaces/workspace-1/preview-token";
const INDEX_SOURCE = '<h1>首页</h1>\n<script>document.title = "ran";</script>';

/** 签发端点的六键应答；函数形式，续签或多发都给一份新的。 */
function issued() {
  return jsonResponse({
    token: TOKEN,
    base: BASE,
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
function renderSite(routes: FetchRoutes = {}) {
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
      [ISSUE]: issued,
      [`${FILE}site%2Findex.html`]: () => textPreviewResponse(INDEX_SOURCE),
      [`${FILE}readme.md`]: () => textPreviewResponse("# 说明"),
      ...routes,
    }),
  );
}

type Mock = ReturnType<typeof renderFiles>["fetchMock"];

function fileRequests(fetchMock: Mock) {
  return paths(fetchMock).filter((path) => path.includes("/file?"));
}

function issueRequests(fetchMock: Mock) {
  return paths(fetchMock).filter((path) => path === ISSUE);
}

function previewRegion() {
  return within(screen.getByRole("region", { name: "文件预览" }));
}

async function select(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

async function openSite() {
  fireEvent.click(await screen.findByRole("button", { name: "展开 site" }));
}

/** 源码视图的各行文字（行号格之后的那一格）。 */
function sourceLines() {
  return previewRegion()
    .queryAllByRole("row")
    .map((row) => within(row).getAllByRole("cell")[1]?.textContent);
}

/** 等到预览里的 iframe 是 `name` 这个文件的（树里同名的行也带这个 title，所以不按 title 查）。 */
function shownFrame(name: string) {
  return waitFor(() => {
    const element = frame();
    expect(element.getAttribute("title")).toBe(name);
    return element;
  });
}

function expectDownloadLink(path: string, name: string) {
  const link = previewRegion().getByRole("link", { name: `下载 ${name}` });
  expect(link.getAttribute("href")).toBe(`${DOWNLOAD}${path}`);
  expect(link.hasAttribute("download")).toBe(true);
}

describe("文件页的网页预览（页面级）：渲染视图与源码", () => {
  it("选中 site/index.html：iframe 的 src 是签发的 base 加路径，此时零次 file 请求；「查看源码」后恰一次并显示带行号的源码，来回切换不再发", async () => {
    const { fetchMock } = renderSite();
    await openSite();
    await select("index.html");

    const rendered = await shownFrame("index.html");
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(rendered.getAttribute("src")).toBe(`https://${PREVIEW_HOST}/w/${TOKEN}/site/index.html`);
    expect(rendered.getAttribute("sandbox")).toBe(SANDBOX);
    expect(rendered.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(rendered.hasAttribute("srcdoc")).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
    expect(sourceLines()).toStrictEqual([
      "<h1>首页</h1>",
      '<script>document.title = "ran";</script>',
    ]);
    expect(
      previewRegion()
        .getAllByRole("row")
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent),
    ).toStrictEqual(["1", "2"]);
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}site%2Findex.html`]);
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    // 源码只是文字：主文档里没有因此多出标题元素，标题也没被改。
    expect(previewRegion().queryByRole("heading", { name: "首页" })).toBeNull();
    expect(document.title).not.toBe("ran");

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    expect((await shownFrame("index.html")).getAttribute("src")).toBe(`${BASE}site/index.html`);
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}site%2Findex.html`]);
  });

  it("选中网页之前不签发；先后选两个网页签发恰一次，第二个的 src 用同一个 base；换文件时视图回到渲染", async () => {
    const { fetchMock } = renderSite();
    await openSite();
    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    await yieldMacrotask();
    expect(issueRequests(fetchMock)).toStrictEqual([]);

    await select("index.html");
    await shownFrame("index.html");
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();

    await select("about.htm");
    const about = await shownFrame("about.htm");
    expect(about.getAttribute("src")).toBe(`${BASE}site/about.htm`);
    expect(about.getAttribute("sandbox")).toBe(SANDBOX);
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();

    await select("index.html");
    expect((await shownFrame("index.html")).getAttribute("src")).toBe(`${BASE}site/index.html`);
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
    await yieldMacrotask();
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}readme.md`, `${FILE}site%2Findex.html`]);
  });

  it("令牌与 base 不在界面文字里，不在地址里，也不在两个存储里；来回切换视图地址不变", async () => {
    renderSite();
    await openSite();
    await select("index.html");
    await shownFrame("index.html");

    const visited = window.location.href;
    const leaked = (text: string) => text.includes(TOKEN) || text.includes(PREVIEW_HOST);
    expect(leaked(document.body.textContent ?? "")).toBe(false);
    expect(leaked(visited)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
    expect(leaked(document.body.textContent ?? "")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    await shownFrame("index.html");

    expect(window.location.href).toBe(visited);
    expect(leaked(JSON.stringify(window.localStorage))).toBe(false);
    expect(leaked(JSON.stringify(window.sessionStorage))).toBe(false);
  });

  it("源码被截断时截断行只在源码视图里有", async () => {
    renderSite({
      [`${FILE}site%2Findex.html`]: () =>
        new Response("<h1>开头</h1>", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-Workbuddy-Size": "2097152",
            "X-Workbuddy-Truncated": "1",
          },
        }),
    });
    await openSite();
    await select("index.html");
    await shownFrame("index.html");

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>开头</h1>" })).toBeTruthy();
    expect(
      previewRegion().getByText("文件超过预览上限，仅显示开头部分 · 共 2.0 MB", { exact: true }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    await shownFrame("index.html");
    expect(previewRegion().queryByText(/^文件超过预览上限/)).toBeNull();
  });
});

describe("文件页的网页预览（页面级）：源码视图下的续期", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // 假时钟随真实时间走（`findBy…` 照常轮询），续期的那五分钟由 `advanceTimersByTimeAsync` 一次跨过。
  it("停在源码视图满五分钟：再签发一次，切回渲染视图时 iframe 立即可用且不另签发", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetchMock } = renderSite();
    await openSite();
    await select("index.html");
    await shownFrame("index.html");
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);

    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE]);
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    expect(frame().getAttribute("src")).toBe(`${BASE}site/index.html`);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE]);
  });
});

describe("文件页的网页预览（页面级）：签发失败", () => {
  it.each([
    [
      "404（预览未装配）",
      () => jsonResponse({ error: { code: "not_found", message: "预览未启用" } }, 404),
      "预览未启用",
    ],
    ["网络失败", new Error("offline"), "请求失败，请稍后重试"],
  ])(
    "%s：渲染视图处是失败文案，没有 iframe，下载链接在，「查看源码」能显示源码，不弹 Toast",
    async (_label, route, message) => {
      const { fetchMock } = renderSite({ [ISSUE]: route });
      const toasts = screen.getByRole("region", { name: "通知" });
      await openSite();
      await select("index.html");

      expect((await previewRegion().findByRole("alert")).textContent).toBe(message);
      expect(document.querySelector("iframe")).toBeNull();
      expectDownloadLink("site%2Findex.html", "index.html");
      expect(fileRequests(fetchMock)).toStrictEqual([]);
      // 让出一轮：Toast 若有，是在文案之后的一次状态更新里才进通知区的。
      await yieldMacrotask();
      expect(within(toasts).queryByRole("listitem")).toBeNull();
      expect(document.querySelector(".ui-toast")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
      expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
      expect(previewRegion().queryByRole("alert")).toBeNull();
      expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}site%2Findex.html`]);
      expectDownloadLink("site%2Findex.html", "index.html");
      expect(document.querySelector("iframe")).toBeNull();
    },
  );
});

describe("文件页的网页预览（页面级）：刷新与再点同一行", () => {
  it("渲染视图下点「刷新」：file 请求数不变，iframe 换成新节点、src 不变；再点同一行同样", async () => {
    const { fetchMock } = renderSite();
    await openSite();
    await select("index.html");
    const first = await shownFrame("index.html");
    expect(fileRequests(fetchMock)).toStrictEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(frame()).not.toBe(first));
    const second = frame();
    expect(second.getAttribute("src")).toBe(`${BASE}site/index.html`);
    expect(second.getAttribute("sandbox")).toBe(SANDBOX);

    await select("index.html");
    await waitFor(() => expect(frame()).not.toBe(second));
    expect(frame().getAttribute("src")).toBe(`${BASE}site/index.html`);
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
  });

  it("源码视图下点「刷新」：file 请求由一次变两次，仍是源码视图并显示新取回的内容", async () => {
    const answers = [INDEX_SOURCE, "<h1>改过了</h1>"];
    const { fetchMock } = renderSite({
      [`${FILE}site%2Findex.html`]: () => textPreviewResponse(answers.shift() ?? "多发了一次"),
    });
    await openSite();
    await select("index.html");
    await shownFrame("index.html");
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}site%2Findex.html`]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>改过了</h1>" })).toBeTruthy();
    expect(fileRequests(fetchMock)).toStrictEqual([
      `${FILE}site%2Findex.html`,
      `${FILE}site%2Findex.html`,
    ]);
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(sourceLines()).toStrictEqual(["<h1>改过了</h1>"]);
  });

  it("渲染视图下刷新之后再看源码：重新取一次，不沿用刷新之前取回的那份", async () => {
    const answers = [INDEX_SOURCE, "<h1>改过了</h1>"];
    const { fetchMock } = renderSite({
      [`${FILE}site%2Findex.html`]: () => textPreviewResponse(answers.shift() ?? "多发了一次"),
    });
    await openSite();
    await select("index.html");
    await shownFrame("index.html");
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>首页</h1>" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    const before = await shownFrame("index.html");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(frame()).not.toBe(before));
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}site%2Findex.html`]);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>改过了</h1>" })).toBeTruthy();
    expect(fileRequests(fetchMock)).toStrictEqual([
      `${FILE}site%2Findex.html`,
      `${FILE}site%2Findex.html`,
    ]);
  });
});

describe("文件页的网页预览（页面级）：源码请求的失败与中途切回", () => {
  it("file 答 500 之后「渲染视图」按钮仍在：源码处是信封的 message，切回是 iframe，下载链接在", async () => {
    const { fetchMock } = renderSite({
      [`${FILE}site%2Findex.html`]: () =>
        jsonResponse({ error: { code: "internal_error", message: "读取失败" } }, 500),
    });
    await openSite();
    await select("index.html");
    await shownFrame("index.html");

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect((await previewRegion().findByRole("alert")).textContent).toBe("读取失败");
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expectDownloadLink("site%2Findex.html", "index.html");
    expect(fileRequests(fetchMock)).toStrictEqual([`${FILE}site%2Findex.html`]);

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    expect((await shownFrame("index.html")).getAttribute("src")).toBe(`${BASE}site/index.html`);
    expect(previewRegion().queryByRole("alert")).toBeNull();
  });

  it("file 答 415 之后显示不支持态，「渲染视图」按钮仍在", async () => {
    renderSite({
      [`${FILE}site%2Findex.html`]: () =>
        jsonResponse({ error: { code: "preview_unsupported", message: "该类型不支持预览" } }, 415),
    });
    await openSite();
    await select("index.html");
    await shownFrame("index.html");

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByText("该类型不支持预览")).toBeTruthy();
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
  });

  it("源码还在取时切回渲染视图：请求被中止、读取提示撤掉，迟到的应答不把视图带回源码；再看源码重新取", async () => {
    const pending = deferredResponse();
    const answers: (Promise<Response> | Response)[] = [
      pending.promise,
      textPreviewResponse("<h1>第二次</h1>"),
    ];
    const signals: (AbortSignal | null | undefined)[] = [];
    const { fetchMock } = renderSite({
      [`${FILE}site%2Findex.html`]: (_path, options) => {
        signals.push(options?.signal);
        return answers.shift() ?? new Error("a third file request");
      },
    });
    await openSite();
    await select("index.html");
    await shownFrame("index.html");

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect((await previewRegion().findByRole("status")).textContent).toBe("正在读取文件");
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(signals.map((signal) => signal?.aborted)).toStrictEqual([false]);

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    await shownFrame("index.html");
    expect(signals.map((signal) => signal?.aborted)).toStrictEqual([true]);
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();

    pending.resolve(textPreviewResponse("<h1>迟到的</h1>"));
    await yieldMacrotask();
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(await previewRegion().findByRole("cell", { name: "<h1>第二次</h1>" })).toBeTruthy();
    expect(sourceLines()).toStrictEqual(["<h1>第二次</h1>"]);
    expect(fileRequests(fetchMock)).toStrictEqual([
      `${FILE}site%2Findex.html`,
      `${FILE}site%2Findex.html`,
    ]);
  });
});
