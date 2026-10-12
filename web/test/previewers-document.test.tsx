// file-previewers「PDF 与办公文档」的三个场景（「PDF 的嵌入」「办公文档的嵌入与转换提示」「不建
// iframe 的三种情况」），与「隔离来源的嵌入与令牌」里含 pdf 的「共用与续期」。两段：组件级静态导入
// 预览器、令牌作属性给入，同步断言；页面级经文件页与假 fetch，iframe 在签发落定之后才有，一律
// `findBy…` / `waitFor` 取到再断言。
// jsdom 不为 iframe 导航，也不为它派发 `load`：这里钉的是属性值、节点是否换新、请求次数，`load` 由
// 用例自己派发。浏览器里查看器是否出现、`load` 是否对 PDF 响应与失败页触发、框内文档的来源与凭据，
// 都不在这个文件里。
import { inspect } from "node:util";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentPreviewer } from "../src/features/files/previewers/frame.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  BASE,
  fileRequests,
  frame,
  ISSUE,
  issueRequests,
  openSite,
  PREVIEW_HOST,
  previewRegion,
  renderSite,
  select,
  shownFrame,
  TOKEN,
} from "./files-site-fixture.js";
import { jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  cleanupFilesFixture();
  vi.restoreAllMocks();
  // `restoreAllMocks` 不还原 `defineProperty` 打的桩。
  Reflect.deleteProperty(navigator, "pdfViewerEnabled");
});

const OFFICE_BASE = `https://${PREVIEW_HOST}/o/${TOKEN}/`;
/** 文档预览的上限，即令牌应答里的 `documentMaxBytes`（100 MiB）。 */
const LIMIT = 104_857_600;
const TWO_MB = 2_097_152;
const HUGE = 157_286_400;

const TOO_LARGE = "文件过大，无法预览";
const NO_CONVERTER = "服务器未启用文档转换，请下载后查看";
const NO_VIEWER = "此浏览器不支持内嵌 PDF 预览，请下载后查看";
const CONVERTING = "正在转换文档…";

/** jsdom 没有这个属性；用例从 `undefined` 起步，各自打桩。 */
function stubPdfViewer(enabled: boolean) {
  expect(navigator.pdfViewerEnabled).toBeUndefined();
  Object.defineProperty(navigator, "pdfViewerEnabled", { configurable: true, value: enabled });
}

type Doc = NonNullable<ComponentProps<typeof DocumentPreviewer>["doc"]>;
type Ready = Extract<Doc["token"], { status: "ready" }>;

function ready(patch: Partial<Ready> = {}): Ready {
  return {
    status: "ready",
    base: BASE,
    officeBase: OFFICE_BASE,
    documentMaxBytes: LIMIT,
    officeAvailable: true,
    ...patch,
  };
}

function pdf(patch: Partial<Doc> = {}): Doc {
  return { path: "doc.pdf", token: ready(), reload: 0, size: TWO_MB, office: false, ...patch };
}

function office(patch: Partial<Doc> = {}): Doc {
  return { path: "plan.docx", token: ready(), reload: 0, size: 4096, office: true, ...patch };
}

/** 说明文字在、没有 iframe、没有转换遮层。 */
function expectRefusal(title: string) {
  expect(screen.getByText(title, { exact: true })).toBeTruthy();
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.queryByText(CONVERTING)).toBeNull();
}

describe("文档预览器（组件级）：iframe 的属性", () => {
  it("PDF 的嵌入：2 MB 的 doc.pdf 是恰一个 iframe，src 为 base 加 doc.pdf，title 为文件名，属性恰为 class、src、title 三个，没有 sandbox；load 前后都没有「正在转换文档…」", async () => {
    render(<DocumentPreviewer doc={pdf()} name="doc.pdf" />);

    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    // 属性集合封死：多出任何一个（sandbox、referrerpolicy、allow、name…）都要先改这里。
    expect(frame().getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
    expect(frame().hasAttribute("sandbox")).toBe(false);
    expect(frame().getAttribute("src")).toBe(`https://${PREVIEW_HOST}/w/${TOKEN}/doc.pdf`);
    expect(frame().getAttribute("title")).toBe("doc.pdf");
    expect(screen.queryByText(CONVERTING)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    await yieldMacrotask();
    expect(screen.queryByText(CONVERTING)).toBeNull();
    fireEvent.load(frame());
    expect(screen.queryByText(CONVERTING)).toBeNull();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("办公文档的嵌入与转换提示：plan.docx 的 src 为 officeBase 加 plan.docx，属性恰为 class、src、title 三个，没有 sandbox；load 之前「正在转换文档…」在且 iframe 已在文档里，load 之后撤掉、iframe 还是那个节点", async () => {
    render(<DocumentPreviewer doc={office()} name="plan.docx" />);

    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const first = frame();
    expect(first.getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
    expect(first.hasAttribute("sandbox")).toBe(false);
    expect(first.getAttribute("src")).toBe(`https://${PREVIEW_HOST}/o/${TOKEN}/plan.docx`);
    expect(first.getAttribute("title")).toBe("plan.docx");

    // 让出一轮：jsdom 若自己为这个 iframe 派发 `load`，遮层在这里就已经没了。
    await yieldMacrotask();
    expect(screen.getByRole("status").textContent).toBe(CONVERTING);
    expect(frame()).toBe(first);

    fireEvent.load(first);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(CONVERTING)).toBeNull();
    expect(frame()).toBe(first);
    expect(first.getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
  });

  it.each([
    ["pdf 用 base", pdf, "w"],
    ["办公文档用 officeBase", office, "o"],
  ] as const)(
    "路径编码：%s，后接各段分别编码的路径，斜杠保留；title 是文件名，不是路径",
    (_label, make, prefix) => {
      render(<DocumentPreviewer doc={make({ path: "报告 2026/a b#1.pdf" })} name="x" />);

      expect(frame().getAttribute("src")).toBe(
        `https://${PREVIEW_HOST}/${prefix}/${TOKEN}/%E6%8A%A5%E5%91%8A%202026/a%20b%231.pdf`,
      );
      // 规格「title 为文件名」：子目录里的文件，路径与文件名才分得开。
      expect(frame().getAttribute("title")).toBe("x");
    },
  );

  // 期望值是手写的字面量。这里只说属性里写了什么；浏览器解析这个地址时怎样处理点段与连续的斜杠、
  // 监听器怎样裁决，不在这个文件里。
  it.each([
    ["首尾空格", " a /b .pdf", "%20a%20/b%20.pdf"],
    ["两点段", "a/../b.pdf", "a/../b.pdf"],
    ["开头的两点段", "../b.pdf", "../b.pdf"],
    ["开头的斜杠", "/abs.pdf", "/abs.pdf"],
    ["空段", "a//b.pdf", "a//b.pdf"],
    ["合成形式的 é", "café.pdf", "caf%C3%A9.pdf"],
    ["分解形式的 é", "café.pdf", "cafe%CC%81.pdf"],
    ["问号与百分号", "q?x=1&y/100%.pdf", "q%3Fx%3D1%26y/100%25.pdf"],
    ["反斜杠", "a\\b.pdf", "a%5Cb.pdf"],
  ])("路径是数据：%s 不被裁剪或规范化，src 逐字等于按段编码的结果", (_label, path, encoded) => {
    render(<DocumentPreviewer doc={pdf({ path })} name="x.pdf" />);

    expect(frame().getAttribute("src")).toBe(`https://${PREVIEW_HOST}/w/${TOKEN}/${encoded}`);
  });
});

describe("文档预览器（组件级）：建 iframe 之前的三项判定", () => {
  it.each([
    ["huge.pdf", pdf],
    ["huge.docx", office],
  ] as const)(
    "150 MB 的 %s 超过 documentMaxBytes：显示「文件过大，无法预览」与文件名、大小，没有 iframe",
    (name, make) => {
      render(<DocumentPreviewer doc={make({ path: name, size: HUGE })} name={name} />);

      expectRefusal(TOO_LARGE);
      expect(screen.getByText(`${name} · 150.0 MB`, { exact: true })).toBeTruthy();
    },
  );

  it.each([
    ["pdf", pdf],
    ["办公文档", office],
  ] as const)(
    "%s 的大小恰等于 documentMaxBytes 仍建 iframe，多一个字节就是「文件过大，无法预览」",
    (_label, make) => {
      const view = render(<DocumentPreviewer doc={make({ size: LIMIT })} name="x" />);
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
      expect(screen.queryByText(TOO_LARGE)).toBeNull();

      view.rerender(<DocumentPreviewer doc={make({ size: LIMIT + 1 })} name="x" />);
      expectRefusal(TOO_LARGE);
    },
  );

  it("officeAvailable 为 false 时的 a.xlsx：显示「服务器未启用文档转换，请下载后查看」，没有 iframe", () => {
    render(
      <DocumentPreviewer
        doc={office({ path: "a.xlsx", token: ready({ officeAvailable: false }) })}
        name="a.xlsx"
      />,
    );

    expectRefusal(NO_CONVERTER);
    expect(screen.getByText("a.xlsx · 4.0 KB", { exact: true })).toBeTruthy();
  });

  it("officeAvailable 为 false 不影响 pdf：照常建 iframe，src 在 base 下", () => {
    render(<DocumentPreviewer doc={pdf({ token: ready({ officeAvailable: false }) })} name="x" />);

    expect(frame().getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(screen.queryByText(NO_CONVERTER)).toBeNull();
  });

  it.each([
    ["doc.pdf", pdf],
    ["plan.docx", office],
  ] as const)(
    "navigator.pdfViewerEnabled 为 false 时的 %s：显示「此浏览器不支持内嵌 PDF 预览，请下载后查看」，没有 iframe",
    (name, make) => {
      stubPdfViewer(false);
      render(<DocumentPreviewer doc={make()} name={name} />);

      expectRefusal(NO_VIEWER);
    },
  );

  it.each([
    ["pdf", pdf],
    ["办公文档", office],
  ] as const)(
    "navigator.pdfViewerEnabled 没有定义（jsdom 的起点）或为 true 时，%s 照常建 iframe",
    (_label, make) => {
      expect(navigator.pdfViewerEnabled).toBeUndefined();
      const view = render(<DocumentPreviewer doc={make()} name="x" />);
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
      expect(screen.queryByText(NO_VIEWER)).toBeNull();
      view.unmount();

      stubPdfViewer(true);
      render(<DocumentPreviewer doc={make()} name="x" />);
      expect(document.querySelectorAll("iframe")).toHaveLength(1);
      expect(screen.queryByText(NO_VIEWER)).toBeNull();
    },
  );

  it("次序一：超限且查看器被禁用的 pdf 显示「文件过大，无法预览」", () => {
    stubPdfViewer(false);
    render(<DocumentPreviewer doc={pdf({ size: HUGE })} name="huge.pdf" />);

    expectRefusal(TOO_LARGE);
    expect(screen.queryByText(NO_VIEWER)).toBeNull();
  });

  it("次序二：超限且服务器未启用转换的办公文档显示「文件过大，无法预览」", () => {
    render(
      <DocumentPreviewer
        doc={office({ size: HUGE, token: ready({ officeAvailable: false }) })}
        name="huge.docx"
      />,
    );

    expectRefusal(TOO_LARGE);
    expect(screen.queryByText(NO_CONVERTER)).toBeNull();
  });

  it("次序三：服务器未启用转换且查看器被禁用的办公文档显示「服务器未启用文档转换，请下载后查看」", () => {
    stubPdfViewer(false);
    render(
      <DocumentPreviewer
        doc={office({ token: ready({ officeAvailable: false }) })}
        name="plan.docx"
      />,
    );

    expectRefusal(NO_CONVERTER);
    expect(screen.queryByText(NO_VIEWER)).toBeNull();
  });
});

describe("文档预览器（组件级）：没有可用令牌时", () => {
  it.each([
    ["idle 的 pdf", pdf({ token: { status: "idle" } })],
    ["loading 的 pdf", pdf({ token: { status: "loading" } })],
    ["loading 的办公文档", office({ token: { status: "loading" } })],
    // 没有令牌就没有上限可比：超限的文件此时也只是在等。
    ["loading 的超限 pdf", pdf({ token: { status: "loading" }, size: HUGE })],
  ])("令牌是 %s：显示「正在加载预览…」，没有 iframe，没有转换遮层", (_label, doc) => {
    render(<DocumentPreviewer doc={doc} name="x" />);

    expect(screen.getByRole("status").textContent).toBe("正在加载预览…");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(CONVERTING)).toBeNull();
  });

  it.each([
    ["pdf", pdf],
    ["办公文档", office],
  ] as const)(
    "令牌是 error 的%s：alert 里是它的 message，没有 iframe，没有转换遮层",
    (_label, make) => {
      render(
        <DocumentPreviewer
          doc={make({ token: { status: "error", message: "预览未启用" } })}
          name="x"
        />,
      );

      expect(screen.getByRole("alert").textContent).toBe("预览未启用");
      expect(document.querySelector("iframe")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("不经页面直接渲染、没有 doc 属性：显示请求失败的安全文案，没有 iframe", () => {
    render(<DocumentPreviewer name="doc.pdf" />);

    expect(screen.getByRole("alert").textContent).toBe("请求失败，请稍后重试");
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("文档预览器（组件级）：续期、换地址与刷新", () => {
  it("办公文档：四个字段相同的新令牌对象不换节点、遮层不回来；reload 加一换成新节点且遮层重现；officeBase 变了也换成新节点且遮层重现", () => {
    const view = render(<DocumentPreviewer doc={office()} name="plan.docx" />);
    const first = frame();
    fireEvent.load(first);
    expect(screen.queryByText(CONVERTING)).toBeNull();

    view.rerender(<DocumentPreviewer doc={office({ token: ready() })} name="plan.docx" />);
    expect(frame()).toBe(first);
    expect(screen.queryByText(CONVERTING)).toBeNull();

    view.rerender(<DocumentPreviewer doc={office({ reload: 1 })} name="plan.docx" />);
    const second = frame();
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe(`${OFFICE_BASE}plan.docx`);
    expect(screen.getByRole("status").textContent).toBe(CONVERTING);
    fireEvent.load(second);
    expect(screen.queryByText(CONVERTING)).toBeNull();

    const moved = `https://${PREVIEW_HOST}/o/${"u".repeat(64)}/`;
    view.rerender(
      <DocumentPreviewer
        doc={office({ reload: 1, token: ready({ officeBase: moved }) })}
        name="plan.docx"
      />,
    );
    expect(frame()).not.toBe(second);
    expect(frame().getAttribute("src")).toBe(`${moved}plan.docx`);
    expect(screen.getByRole("status").textContent).toBe(CONVERTING);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("pdf：四个字段相同的新令牌对象不换节点、src 不变；reload 加一换成新节点；始终没有转换遮层", () => {
    const view = render(<DocumentPreviewer doc={pdf()} name="doc.pdf" />);
    const first = frame();

    view.rerender(<DocumentPreviewer doc={pdf({ token: ready() })} name="doc.pdf" />);
    expect(frame()).toBe(first);
    expect(frame().getAttribute("src")).toBe(`${BASE}doc.pdf`);

    view.rerender(<DocumentPreviewer doc={pdf({ reload: 1 })} name="doc.pdf" />);
    expect(frame()).not.toBe(first);
    expect(frame().getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(frame().getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
    expect(screen.queryByText(CONVERTING)).toBeNull();
  });
});

const TREE = "/api/workspaces/workspace-1/tree?path=";
const DOWNLOAD = "/api/workspaces/workspace-1/download?path=";

type Answer = { base?: string; officeAvailable?: boolean };

/** 签发端点的六键应答；每次一份新的。 */
function issuedDocs({ base = BASE, officeAvailable = true }: Answer = {}) {
  return jsonResponse({
    token: TOKEN,
    base,
    officeBase: OFFICE_BASE,
    expiresAt: 1_800_000_000_000,
    documentMaxBytes: LIMIT,
    officeAvailable,
  });
}

/**
 * `files-site-fixture` 的空间，根下多出四个文档。没有给这四个文件配 `file` 路由：页面若为它们发
 * `file` 请求，假 fetch 抛错。
 */
function renderDocs(routes: Parameters<typeof renderSite>[0] = {}) {
  return renderSite({
    [TREE]: () =>
      jsonResponse({
        path: "",
        entries: [
          { name: "site", type: "dir", size: 0, mtime: 100 },
          { name: "a.xlsx", type: "file", size: 2048, mtime: 104 },
          { name: "doc.pdf", type: "file", size: TWO_MB, mtime: 105 },
          { name: "huge.pdf", type: "file", size: HUGE, mtime: 106 },
          { name: "plan.docx", type: "file", size: 4096, mtime: 107 },
          { name: "readme.md", type: "file", size: 4, mtime: 101 },
        ],
      }),
    [ISSUE]: () => issuedDocs(),
    ...routes,
  });
}

function expectDownloadLink(name: string) {
  const link = previewRegion().getByRole("link", { name: `下载 ${name}` });
  expect(link.getAttribute("href")).toBe(`${DOWNLOAD}${name}`);
  expect(link.hasAttribute("download")).toBe(true);
}

describe("文件页的文档预览（页面级）：嵌入", () => {
  it("选中 doc.pdf：iframe 的 src 是签发的 base 加路径、没有 sandbox，零次 file 请求，下载链接在，没有转换遮层", async () => {
    const { fetchMock } = renderDocs();
    await select("doc.pdf");

    const shown = await shownFrame("doc.pdf");
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(shown.getAttribute("src")).toBe(`https://${PREVIEW_HOST}/w/${TOKEN}/doc.pdf`);
    expect(shown.getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expectDownloadLink("doc.pdf");
    expect(previewRegion().queryByText(CONVERTING)).toBeNull();
    expect(previewRegion().queryByText("正在读取文件")).toBeNull();
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
  });

  it.each([["plan.docx"], ["a.xlsx"]])(
    "选中 %s（officeAvailable 为 true）：iframe 的 src 是 officeBase 加路径、没有 sandbox，零次 file 请求；load 之前「正在转换文档…」在，之后撤掉，下载链接始终在",
    async (name) => {
      const { fetchMock } = renderDocs();
      await select(name);

      const shown = await shownFrame(name);
      expect(fileRequests(fetchMock)).toStrictEqual([]);
      expect(shown.getAttribute("src")).toBe(`https://${PREVIEW_HOST}/o/${TOKEN}/${name}`);
      expect(shown.getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
      expect(previewRegion().getByRole("status").textContent).toBe(CONVERTING);
      expectDownloadLink(name);

      fireEvent.load(shown);
      expect(previewRegion().queryByText(CONVERTING)).toBeNull();
      expect(frame()).toBe(shown);
      expectDownloadLink(name);
      await yieldMacrotask();
      expect(fileRequests(fetchMock)).toStrictEqual([]);
    },
  );
});

describe("文件页的文档预览（页面级）：不建 iframe 的三种情况", () => {
  it("依次选中 150 MB 的 huge.pdf、officeAvailable 为 false 时的 a.xlsx：各显示规格的说明，都没有 iframe，都有下载链接，全程零次 file 请求、恰一次签发", async () => {
    const { fetchMock } = renderDocs({ [ISSUE]: () => issuedDocs({ officeAvailable: false }) });

    await select("huge.pdf");
    expect(await previewRegion().findByText(TOO_LARGE, { exact: true })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expectDownloadLink("huge.pdf");

    await select("a.xlsx");
    expect(await previewRegion().findByText(NO_CONVERTER, { exact: true })).toBeTruthy();
    expect(previewRegion().queryByText(TOO_LARGE)).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expectDownloadLink("a.xlsx");

    // 同一份应答下 pdf 不受 officeAvailable 影响。
    await select("doc.pdf");
    expect((await shownFrame("doc.pdf")).getAttribute("src")).toBe(`${BASE}doc.pdf`);
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
  });

  it("navigator.pdfViewerEnabled 为 false 时选中 doc.pdf：显示「此浏览器不支持内嵌 PDF 预览，请下载后查看」，没有 iframe，有下载链接，零次 file 请求", async () => {
    stubPdfViewer(false);
    const { fetchMock } = renderDocs();
    await select("doc.pdf");

    expect(await previewRegion().findByText(NO_VIEWER, { exact: true })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expectDownloadLink("doc.pdf");
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });
});

describe("文件页的文档预览（页面级）：共用与续期", () => {
  // 假时钟随真实时间走（`findBy…` 照常轮询），停留的时间由 `advanceTimersByTimeAsync` 一次跨过。
  it("先后预览两个 html 与一个 pdf 合计恰一次签发；停留 11 分钟恰两次续期，iframe 还是原来的节点、src 不变；切到 md 再停 6 分钟没有新的签发", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetchMock } = renderDocs();
    await openSite();
    await select("index.html");
    await shownFrame("index.html");
    await select("about.htm");
    await shownFrame("about.htm");
    await select("doc.pdf");
    const shown = await shownFrame("doc.pdf");
    expect(shown.getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);

    await act(() => vi.advanceTimersByTimeAsync(660_000));
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE, ISSUE]);
    expect(frame()).toBe(shown);
    expect(frame().getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    await select("readme.md");
    expect(await screen.findByRole("heading", { level: 1, name: "说明" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(360_000));
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE, ISSUE]);
    expect(fileRequests(fetchMock)).toStrictEqual([
      "/api/workspaces/workspace-1/file?path=readme.md",
    ]);
  });
});

describe("文件页的文档预览（页面级）：刷新与再点同一行", () => {
  it("plan.docx 已 load、点「刷新」：iframe 换成新节点、src 不变、遮层重现；再点同一行同样；没有 file 请求，不满五分钟不另签发", async () => {
    const { fetchMock } = renderDocs();
    await select("plan.docx");
    const first = await shownFrame("plan.docx");
    fireEvent.load(first);
    expect(previewRegion().queryByText(CONVERTING)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(frame()).not.toBe(first));
    const second = frame();
    expect(second.getAttribute("src")).toBe(`${OFFICE_BASE}plan.docx`);
    expect(previewRegion().getByRole("status").textContent).toBe(CONVERTING);
    fireEvent.load(second);
    expect(previewRegion().queryByText(CONVERTING)).toBeNull();

    await select("plan.docx");
    await waitFor(() => expect(frame()).not.toBe(second));
    expect(frame().getAttribute("src")).toBe(`${OFFICE_BASE}plan.docx`);
    expect(previewRegion().getByRole("status").textContent).toBe(CONVERTING);
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
  });

  it("doc.pdf 下点「刷新」：iframe 换成新节点、src 不变，没有 file 请求，不另签发", async () => {
    const { fetchMock } = renderDocs();
    await select("doc.pdf");
    const first = await shownFrame("doc.pdf");

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(frame()).not.toBe(first));
    expect(frame().getAttribute("src")).toBe(`${BASE}doc.pdf`);
    expect(frame().getAttributeNames().sort()).toStrictEqual(["class", "src", "title"]);
    await yieldMacrotask();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
  });
});

/** 第二次签发给出的地址前缀：与 `BASE` 不同，`src` 用了哪一次的结果由此可辨。 */
const NEXT_BASE = `https://${PREVIEW_HOST}/w/${"u".repeat(64)}/`;

describe("文件页的文档预览（页面级）：签发失败", () => {
  it.each([
    ["点「刷新」", () => fireEvent.click(screen.getByRole("button", { name: "刷新" }))],
    ["再点同一行", () => fireEvent.click(screen.getByRole("button", { name: "doc.pdf" }))],
  ])(
    "第一次签发答 500、第二次成功，选中 doc.pdf：先是失败文案、没有 iframe、下载链接在、不弹 Toast；%s后签发请求恰两次，iframe 的 src 是新 base 加路径，全程零 file 请求",
    async (_label, again) => {
      const { fetchMock } = renderDocs({
        [ISSUE]: [
          jsonResponse({ error: { code: "internal_error", message: "签发失败" } }, 500),
          issuedDocs({ base: NEXT_BASE }),
        ],
      });
      const toasts = screen.getByRole("region", { name: "通知" });
      await select("doc.pdf");

      expect((await previewRegion().findByRole("alert")).textContent).toBe("签发失败");
      expect(document.querySelector("iframe")).toBeNull();
      expectDownloadLink("doc.pdf");
      expect(issueRequests(fetchMock)).toStrictEqual([ISSUE]);
      // 让出一轮：Toast 若有，是在文案之后的一次状态更新里才进通知区的。
      await yieldMacrotask();
      expect(within(toasts).queryByRole("listitem")).toBeNull();
      expect(document.querySelector(".ui-toast")).toBeNull();

      again();
      const shown = await shownFrame("doc.pdf");
      expect(shown.getAttribute("src")).toBe(`${NEXT_BASE}doc.pdf`);
      expect(previewRegion().queryByRole("alert")).toBeNull();
      expect(issueRequests(fetchMock)).toStrictEqual([ISSUE, ISSUE]);
      expect(fileRequests(fetchMock)).toStrictEqual([]);
    },
  );
});

describe("文件页的文档预览（页面级）：令牌不外露", () => {
  it("先后选中 doc.pdf 与 plan.docx：令牌与预览来源不在界面文字里、不在地址里、不在两个存储、cookie、history.state、document.title、window.name 与控制台输出里，页面标记里恰出现一次（iframe 的 src）；通知区没有条目", async () => {
    // 先于渲染装上：首次挂载时的输出也算。
    const consoles = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    renderDocs();
    const toasts = screen.getByRole("region", { name: "通知" });
    const leaked = (text: string) => text.includes(TOKEN) || text.includes(PREVIEW_HOST);

    await select("doc.pdf");
    await shownFrame("doc.pdf");
    // 选中文件会把 `path` 写进地址：这里比的是地址里有没有令牌与预览来源。
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/files?ws=workspace-1&path=doc.pdf",
    );
    expect(leaked(window.location.href)).toBe(false);
    expect(leaked(document.body.textContent ?? "")).toBe(false);
    // 标记里唯一的一处是 iframe 的 src：别的属性（data-*、href…）里没有第二份。
    expect(document.body.innerHTML.split(TOKEN)).toHaveLength(2);
    expect(frame().getAttribute("src")).toBe(`${BASE}doc.pdf`);

    await select("plan.docx");
    const shown = await shownFrame("plan.docx");
    expect(leaked(document.body.textContent ?? "")).toBe(false);
    fireEvent.load(shown);
    expect(leaked(document.body.textContent ?? "")).toBe(false);
    expect(document.body.innerHTML.split(TOKEN)).toHaveLength(2);
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/files?ws=workspace-1&path=plan.docx",
    );
    expect(leaked(window.location.href)).toBe(false);

    expect(leaked(JSON.stringify(window.localStorage))).toBe(false);
    expect(leaked(JSON.stringify(window.sessionStorage))).toBe(false);
    expect(document.cookie.includes(TOKEN)).toBe(false);
    // 另外三处跨导航或跨页面留得住的地方。`history.state` 为 null 时序列化成 "null"。
    expect(leaked(JSON.stringify(window.history.state))).toBe(false);
    expect(leaked(document.title)).toBe(false);
    expect(leaked(window.name)).toBe(false);
    await yieldMacrotask();
    expect(within(toasts).queryByRole("listitem")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    // 按参数的内容查，不按次数：别的输出（如 React 的告警）不算泄漏。
    const printed = consoles
      .flatMap((spy) => spy.mock.calls.flat())
      .map((argument) => (typeof argument === "string" ? argument : inspect(argument)));
    expect(printed.filter(leaked)).toStrictEqual([]);
  });
});
