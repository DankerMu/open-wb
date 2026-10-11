import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPane } from "../src/features/files/preview.js";
import { ImagePreviewer } from "../src/features/files/previewers/image.js";
import { SvgPreviewer } from "../src/features/files/previewers/svg.js";
import { TablePreviewer } from "../src/features/files/previewers/table.js";
import { ToastProvider } from "../src/ui/index.js";
import { observeUnhandledRejections, settle } from "./chat-stream-support.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  renderFiles,
  stubBlobUrls,
  workspace,
} from "./files-fixture.js";
import { jsonResponse } from "./support.js";
import { listRepoFiles, readRepoFile } from "./ui-support.js";

afterEach(cleanup);

function renderTable(name: string, content: string) {
  const { container } = render(<TablePreviewer content={content} name={name} />);
  const slot = container.querySelector('[data-slot="preview-table"]');
  return {
    container,
    headers: [...(slot?.querySelectorAll("thead th") ?? [])].map((node) => node.textContent),
    rows: [...(slot?.querySelectorAll("tbody tr") ?? [])].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    ),
    note: slot?.querySelector("p")?.textContent,
  };
}

// file-previewers「Markdown、表格、图片与 SVG」的场景「tsv 与 csv」：分隔符只由扩展名决定。
describe("表格预览器：tsv 与 csv", () => {
  it.each([
    ["t.tsv", "name\tvalue\nalpha\t1\nbeta\t2"],
    ["t.csv", "name,value\nalpha,1\nbeta,2"],
  ])("%s 的第一行是表头，其余两行各占两格，下方注明行数", (name, content) => {
    const table = renderTable(name, content);

    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "name",
      "value",
    ]);
    expect(table.headers).toEqual(["name", "value"]);
    expect(table.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
    ]);
    expect(table.note).toBe("共 2 行 · 大文件仅预览前若干行");
  });

  it("扩展名大写的 T.TSV 同样按制表符分列", () => {
    const table = renderTable("T.TSV", "name\tvalue\nalpha\t1\nbeta\t2");

    expect(table.headers).toEqual(["name", "value"]);
    expect(table.rows).toEqual([
      ["alpha", "1"],
      ["beta", "2"],
    ]);
  });

  it("不看内容猜分隔符：csv 里的制表符与 tsv 里的逗号都留在单元格里", () => {
    const csv = renderTable("t.csv", "a\tb\n1\t2");
    expect(csv.headers).toEqual(["a\tb"]);
    expect(csv.rows).toEqual([["1\t2"]]);
    cleanup();

    const tsv = renderTable("t.tsv", "a,b\n1,2");
    expect(tsv.headers).toEqual(["a,b"]);
    expect(tsv.rows).toEqual([["1,2"]]);
  });

  it("tsv 开头与结尾的空单元格各占一格，表头不相对数据左移", () => {
    // 首尾各一个换行：只去换行，不去紧挨着它的制表符。
    const table = renderTable("t.tsv", "\n\tx\n1\t\n");

    expect(table.headers).toEqual(["", "x"]);
    expect(table.rows).toEqual([["1", ""]]);
  });

  it("tsv 单元格里的标记是文字，不产生元素", () => {
    const table = renderTable("t.tsv", "h\tnote\n<script>alert(1)</script>\tplain");

    expect(table.rows).toEqual([["<script>alert(1)</script>", "plain"]]);
    expect(table.container.querySelector("script")).toBeNull();
  });

  it("经预览面板选中的 tsv 落到表格预览器并按制表符分列", async () => {
    render(
      <PreviewPane
        mtime={1_726_000_000_000}
        name="t.tsv"
        path="t.tsv"
        preview={{
          data: {
            kind: "text",
            size: 26,
            text: "name\tvalue\nalpha\t1\nbeta\t2\n",
            truncated: false,
          },
          status: "success",
        }}
        size={26}
        workspaceId="w1"
      />,
    );

    expect((await screen.findAllByRole("columnheader")).map((node) => node.textContent)).toEqual([
      "name",
      "value",
    ]);
    expect(screen.getByText("共 2 行 · 大文件仅预览前若干行")).toBeTruthy();
  });
});

/*
 * 夹具含 script 元素、井号、百分号、中文与换行。`SVG_SRC` 是按百分号编码规则手写的字面量，
 * 不在期望里再调一次编码函数。
 */
const SVG_TEXT =
  '<svg viewBox="0 0 8 8">\n<script>alert(1)</script>\n<use href="#a"/>图 50%\n</svg>';
const SVG_SRC =
  "data:image/svg+xml;charset=utf-8," +
  "%3Csvg%20viewBox%3D%220%200%208%208%22%3E%0A" +
  "%3Cscript%3Ealert(1)%3C%2Fscript%3E%0A" +
  "%3Cuse%20href%3D%22%23a%22%2F%3E%E5%9B%BE%2050%25%0A" +
  "%3C%2Fsvg%3E";
const SVG_LINES = [
  '<svg viewBox="0 0 8 8">',
  "<script>alert(1)</script>",
  '<use href="#a"/>图 50%',
  "</svg>",
];

/** 源码视图各行的内容格（每行第二格）。 */
function sourceLines(): (string | null)[] {
  return [...document.querySelectorAll('[data-slot="preview-code"] tbody tr')].map(
    (row) => row.querySelectorAll("td")[1]?.textContent ?? null,
  );
}

function svgPane(name: string, text: string, truncated: boolean) {
  return (
    <PreviewPane
      mtime={1_726_000_000_000}
      name={name}
      path={`uploads/${name}`}
      preview={{ data: { kind: "text", size: text.length, text, truncated }, status: "success" }}
      size={text.length}
      workspaceId="w1"
    />
  );
}

/** 把文件内容当 HTML 解析的四种写法；按原文查（注释也算）。iframe 元素本身不在其列。 */
function injectsHtml(source: string): boolean {
  return ["dangerouslySetInnerHTML", ".innerHTML", "srcDoc", "insertAdjacentHTML"].some((needle) =>
    source.includes(needle),
  );
}

/** 能把内容当另一份文档载入的嵌入元素；SVG 预览器一个都不该渲染。 */
const EMBEDDERS = "iframe, object, embed";

// file-previewers「Markdown、表格、图片与 SVG」的场景「SVG 以图片方式加载」「被截断的 SVG」与「损坏的图片」的 svg 半边。
describe("SvgPreviewer", () => {
  const createObjectURL = vi.fn(() => "blob:should-not-allocate");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("以图片方式加载：img 的 src 是 data: 地址，文档里没有内联的 svg 与 script，也不建 Blob 地址", () => {
    expect(document.querySelector("svg, script")).toBeNull();

    render(<SvgPreviewer content={SVG_TEXT} name="logo.svg" truncated={false} />);

    const image = screen.getByRole("img", { name: "logo.svg" });
    expect(image.getAttribute("src")).toBe(SVG_SRC);
    expect(image.getAttribute("alt")).toBe("logo.svg");
    expect(document.querySelector("svg, script")).toBeNull();
    expect(document.querySelector(EMBEDDERS)).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("查看源码显示带行号的原文且按钮变为图片视图，点回后图片复现", () => {
    render(<SvgPreviewer content={SVG_TEXT} name="logo.svg" truncated={false} />);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(sourceLines()).toEqual(SVG_LINES);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();
    expect(document.querySelector("svg, script")).toBeNull();
    expect(document.querySelector(EMBEDDERS)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "图片视图" }));
    expect(screen.getByRole("img", { name: "logo.svg" }).getAttribute("src")).toBe(SVG_SRC);
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
    expect(sourceLines()).toEqual([]);
    expect(document.querySelector(EMBEDDERS)).toBeNull();
  });

  it("被截断的 SVG 只显示源码：没有 img，也没有切换按钮", () => {
    render(<SvgPreviewer content={SVG_TEXT} name="big.svg" truncated />);

    expect(sourceLines()).toEqual(SVG_LINES);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("img 触发 error 后显示无法显示该图片并移除 img，仍可看源码，切回图片视图仍是该文案", async () => {
    const rejections = observeUnhandledRejections();
    try {
      render(<SvgPreviewer content="plain words" name="bad.svg" truncated={false} />);

      fireEvent.error(screen.getByRole("img", { name: "bad.svg" }));
      expect(screen.getByText("无法显示该图片")).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
      expect(sourceLines()).toEqual(["plain words"]);
      expect(screen.queryByText("无法显示该图片")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "图片视图" }));
      expect(screen.getByText("无法显示该图片")).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();

      await settle();
      expect(rejections.unhandled).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("失败按地址记：同一文件取回不同内容后 img 复现，内容不变时仍是失败文案", () => {
    const view = render(<SvgPreviewer content="plain words" name="bad.svg" truncated={false} />);
    fireEvent.error(screen.getByRole("img", { name: "bad.svg" }));

    view.rerender(<SvgPreviewer content="plain words" name="bad.svg" truncated={false} />);
    expect(screen.getByText("无法显示该图片")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();

    view.rerender(<SvgPreviewer content={SVG_TEXT} name="bad.svg" truncated={false} />);
    expect(screen.getByRole("img", { name: "bad.svg" }).getAttribute("src")).toBe(SVG_SRC);
    expect(screen.queryByText("无法显示该图片")).toBeNull();
  });

  it("经预览面板选中的 svg 落到 SVG 预览器，以 data: 地址的 img 显示", async () => {
    render(svgPane("logo.svg", SVG_TEXT, false));

    const image = await screen.findByRole("img", { name: "logo.svg" });
    expect(image.getAttribute("src")).toBe(SVG_SRC);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("经预览面板的截断 svg 只有源码行，没有 img 与查看源码按钮", async () => {
    render(svgPane("big.svg", SVG_TEXT, true));

    expect(await screen.findAllByRole("row")).toHaveLength(SVG_LINES.length);
    expect(sourceLines()).toEqual(SVG_LINES);
    expect(screen.getByText(/^文件超过预览上限，仅显示开头部分/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();
  });

  it("经预览面板的损坏 svg：提示出现且没有 Toast、下载链接仍在、仍可看源码", async () => {
    // 与 main.tsx 同样挂在 ToastProvider 之下：通知区在场，「没有 Toast」才不是空话。
    render(<ToastProvider>{svgPane("bad.svg", "plain words", false)}</ToastProvider>);
    const toasts = screen.getByRole("region", { name: "通知" });

    fireEvent.error(await screen.findByRole("img", { name: "bad.svg" }));
    expect(screen.getByText("无法显示该图片")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    // Toast 是通知区列表里的一项（Radix 的 li，类名 ui-toast，自身不带 role）；只在通知区里查，
    // 不碰面板自己的 status。面板此时也不该有 alert。
    expect(within(toasts).queryByRole("listitem")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: "下载 bad.svg" }).getAttribute("href")).toBe(
      "/api/workspaces/w1/download?path=uploads%2Fbad.svg",
    );

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(sourceLines()).toEqual(["plain words"]);
  });

  it("previewers/ 下没有任何文件把内容当 HTML 解析", () => {
    expect(injectsHtml("<div dangerouslySetInnerHTML={{ __html: content }} />")).toBe(true);
    expect(injectsHtml("node.innerHTML = content;")).toBe(true);
    expect(injectsHtml("<iframe srcDoc={content} />")).toBe(true);
    expect(injectsHtml('node.insertAdjacentHTML("beforeend", content);')).toBe(true);
    expect(injectsHtml("<img alt={name} src={src} />")).toBe(false);
    expect(injectsHtml("<iframe src={src} />")).toBe(false);

    const files = listRepoFiles("web/src/features/files/previewers", () => true);
    expect(files).toContain("web/src/features/files/previewers/svg.tsx");
    expect(files.filter((path) => injectsHtml(readRepoFile(path)))).toEqual([]);
  });
});

/** 根目录下恰有 `files`（文件名 → 应答的 Content-Type）的文件页；正文是八个与类型无关的字节。 */
function renderImageFiles(files: Record<string, string>) {
  const names = Object.keys(files);
  return renderFiles(
    "/files?ws=workspace-1",
    authenticatedFilesRoutes([workspace], {
      "/api/workspaces/workspace-1/tree?path=": () =>
        jsonResponse({
          path: "",
          entries: names.map((name, index) => ({
            name,
            type: "file",
            size: 8,
            mtime: 101 + index,
          })),
        }),
      ...Object.fromEntries(
        names.map((name) => [
          `/api/workspaces/workspace-1/file?path=${name}`,
          () =>
            new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
              headers: { "Content-Type": files[name] ?? "", "X-Workbuddy-Size": "8" },
            }),
        ]),
      ),
    }),
  );
}

// file-previewers「Markdown、表格、图片与 SVG」的场景「损坏的图片」的 broken.png 半边，与图片预览接受的六种类型。
describe("ImagePreviewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupFilesFixture();
  });

  it("img 触发 error 后显示无法显示该图片并移除 img，只把这一个 Blob 地址释放一次，不新建地址", () => {
    const blobUrls = stubBlobUrls([]);
    render(<ImagePreviewer content="blob:broken" name="broken.png" />);
    const image = screen.getByRole("img", { name: "broken.png" });
    expect(image.getAttribute("src")).toBe("blob:broken");
    expect(screen.queryByText("无法显示该图片")).toBeNull();
    expect(blobUrls.revokeObjectURL).not.toHaveBeenCalled();

    fireEvent.error(image);

    expect(screen.getByText("无法显示该图片")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:broken"]]);
    expect(blobUrls.createObjectURL).not.toHaveBeenCalled();
  });

  it("失败按地址记：同一文件换了新的 Blob 地址后 img 复现，地址不变时仍是失败文案，不再多释放", () => {
    const blobUrls = stubBlobUrls([]);
    const view = render(<ImagePreviewer content="blob:broken" name="broken.png" />);
    fireEvent.error(screen.getByRole("img", { name: "broken.png" }));

    view.rerender(<ImagePreviewer content="blob:broken" name="broken.png" />);
    expect(screen.getByText("无法显示该图片")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();

    view.rerender(<ImagePreviewer content="blob:next" name="broken.png" />);
    expect(screen.getByRole("img", { name: "broken.png" }).getAttribute("src")).toBe("blob:next");
    expect(screen.queryByText("无法显示该图片")).toBeNull();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:broken"]]);
  });

  it("没有 error 就不释放：渲染、重渲染、换地址与卸载都不动调用方的 Blob 地址", () => {
    const blobUrls = stubBlobUrls([]);
    const view = render(<ImagePreviewer content="blob:fine" name="logo.png" />);
    expect(screen.getByRole("img", { name: "logo.png" }).getAttribute("src")).toBe("blob:fine");

    view.rerender(<ImagePreviewer content="blob:fine" name="logo.png" />);
    view.rerender(<ImagePreviewer content="blob:other" name="logo.png" />);
    view.unmount();

    expect(blobUrls.revokeObjectURL).not.toHaveBeenCalled();
    expect(blobUrls.createObjectURL).not.toHaveBeenCalled();
  });

  it("文件页选中损坏的 broken.png：提示出现且没有 Toast、img 被移除、Blob 地址被释放、下载链接仍在", async () => {
    const blobUrls = stubBlobUrls(["blob:broken"]);
    const consoleError = vi.spyOn(console, "error");
    const rejections = observeUnhandledRejections();
    try {
      renderImageFiles({ "broken.png": "image/png" });
      const toasts = screen.getByRole("region", { name: "通知" });
      const preview = within(await screen.findByRole("region", { name: "文件预览" }));

      fireEvent.click(await screen.findByRole("button", { name: "broken.png" }));
      const image = await preview.findByRole("img", { name: "broken.png" });
      expect(image.getAttribute("src")).toBe("blob:broken");
      expect(blobUrls.revokeObjectURL).not.toHaveBeenCalled();

      fireEvent.error(image);

      expect(preview.getByText("无法显示该图片")).toBeTruthy();
      expect(preview.queryByRole("img")).toBeNull();
      expect(blobUrls.revokeObjectURL).toHaveBeenCalledWith("blob:broken");
      // Toast 是通知区列表里的一项（类名 ui-toast，自身不带 role）；预览区此时也不该有 alert。
      expect(within(toasts).queryByRole("listitem")).toBeNull();
      expect(document.querySelector(".ui-toast")).toBeNull();
      expect(preview.queryByRole("alert")).toBeNull();
      const link = preview.getByRole("link", { name: "下载 broken.png" });
      expect(link.getAttribute("href")).toBe(
        "/api/workspaces/workspace-1/download?path=broken.png",
      );
      expect(link.hasAttribute("download")).toBe(true);

      await settle();
      expect(rejections.unhandled).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      rejections.stop();
    }
  });

  it.each([
    ["shot.png", "image/png"],
    ["photo.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["photo.webp", "image/webp"],
    ["scan.bmp", "image/bmp"],
    ["favicon.ico", "image/x-icon"],
  ])("文件页选中 %s（%s）显示为 img，src 是为它分配的 Blob 地址", async (name, contentType) => {
    const blobUrls = stubBlobUrls(["blob:picture"]);
    renderImageFiles({ [name]: contentType });

    fireEvent.click(await screen.findByRole("button", { name }));

    const image = await screen.findByRole("img", { name });
    expect(image.getAttribute("src")).toBe("blob:picture");
    expect(screen.queryByText("无法显示该图片")).toBeNull();
    expect(screen.queryByText("该类型不支持预览")).toBeNull();
    expect(blobUrls.createObjectURL).toHaveBeenCalledTimes(1);
    expect(blobUrls.revokeObjectURL).not.toHaveBeenCalled();
  });
});
