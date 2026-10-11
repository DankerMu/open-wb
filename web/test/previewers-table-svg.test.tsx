import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPane } from "../src/features/files/preview.js";
import { SvgPreviewer } from "../src/features/files/previewers/svg.js";
import { TablePreviewer } from "../src/features/files/previewers/table.js";
import { observeUnhandledRejections, settle } from "./chat-stream-support.js";
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
    const table = renderTable("t.tsv", "\tx\n1\t");

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

/** 把文件内容当 HTML 解析的两种写法；按原文查（注释也算）。 */
function injectsHtml(source: string): boolean {
  return source.includes("dangerouslySetInnerHTML") || source.includes(".innerHTML");
}

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
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("查看源码显示带行号的原文且按钮变为图片视图，点回后图片复现", () => {
    render(<SvgPreviewer content={SVG_TEXT} name="logo.svg" truncated={false} />);

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(sourceLines()).toEqual(SVG_LINES);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();
    expect(document.querySelector("svg, script")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "图片视图" }));
    expect(screen.getByRole("img", { name: "logo.svg" }).getAttribute("src")).toBe(SVG_SRC);
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
    expect(sourceLines()).toEqual([]);
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
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();
  });

  it("经预览面板的损坏 svg：提示出现、下载链接仍在、仍可看源码", async () => {
    render(svgPane("bad.svg", "plain words", false));

    fireEvent.error(await screen.findByRole("img", { name: "bad.svg" }));
    expect(screen.getByText("无法显示该图片")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: "下载 bad.svg" }).getAttribute("href")).toBe(
      "/api/workspaces/w1/download?path=uploads%2Fbad.svg",
    );

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(sourceLines()).toEqual(["plain words"]);
  });

  it("previewers/ 下没有任何文件把内容当 HTML 解析", () => {
    expect(injectsHtml("<div dangerouslySetInnerHTML={{ __html: content }} />")).toBe(true);
    expect(injectsHtml("node.innerHTML = content;")).toBe(true);
    expect(injectsHtml("<img alt={name} src={src} />")).toBe(false);

    const files = listRepoFiles("web/src/features/files/previewers", () => true);
    expect(files).toContain("web/src/features/files/previewers/svg.tsx");
    expect(files.filter((path) => injectsHtml(readRepoFile(path)))).toEqual([]);
  });
});
