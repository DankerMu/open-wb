import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPane } from "../src/features/files/preview.js";
import { highlightLines } from "../src/features/files/previewers/highlight.js";
import { NotebookPreviewer } from "../src/features/files/previewers/notebook.js";
import { downloadUrl } from "../src/lib/api.js";
import { settle } from "./chat-stream-support.js";

/*
 * file-previewers「Notebook」。预览器模块静态导入、直接渲染：单元格结构与输出是模块同步渲染的，
 * 同步断言；只有着色元素等出来。`previewers/index.ts` 只换掉高亮加载函数（其余原样），放行时给的是
 * 静态导入的真 `highlightLines`。jsdom 不加载 iframe：这里钉的是属性与主文档里没有什么，
 * 框内脚本在真实浏览器里跑不跑不在这个文件能说的范围内。
 */
const stub = vi.hoisted(() => ({ loadHighlighter: vi.fn() }));

vi.mock("../src/features/files/previewers/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/files/previewers/index.js")>()),
  loadHighlighter: stub.loadHighlighter,
}));

beforeEach(() => {
  stub.loadHighlighter.mockReset();
  stub.loadHighlighter.mockImplementation(() => Promise.resolve(highlightLines));
});

afterEach(cleanup);

const ESC = "\u001b";
const FALLBACK = "无法按 Notebook 解析，显示源码";
/** 带语法类别标记的元素。 */
const COLORED = '[class^="hljs-"]';

type Cell = Record<string, unknown>;

function notebook(cells: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells, ...extra });
}

function code(source: unknown, outputs: unknown = [], executionCount: unknown = 1): Cell {
  return { cell_type: "code", execution_count: executionCount, metadata: {}, source, outputs };
}

function display(data: unknown, outputType = "display_data"): Cell {
  return { output_type: outputType, data, metadata: {} };
}

function renderNotebook(content: string, truncated = false) {
  return render(<NotebookPreviewer content={content} name="a.ipynb" truncated={truncated} />)
    .container;
}

/** 文字恰为 `text` 的着色元素的类别。 */
function categoryOf(container: HTMLElement, text: string): string | undefined {
  return [...container.querySelectorAll(COLORED)].find((node) => node.textContent === text)
    ?.className;
}

async function untilColored(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(container.querySelectorAll(COLORED).length).toBeGreaterThan(0));
}

/** 让已排队的加载与随后的提交（如果有）落定；用于断言「之后仍然没有着色」。 */
async function flush(): Promise<void> {
  await act(async () => {
    await settle();
  });
}

/** 等宽输出块的文字，按文档次序。 */
function monoTexts(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("pre")].map((node) => node.textContent);
}

/** 执行计数，按文档次序；断言里顺带钉住代码单元的个数。 */
function prompts(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-slot="notebook-prompt"]')].map(
    (node) => node.textContent,
  );
}

/** 源码视图的行：行号与内容。 */
function sourceLines(container: HTMLElement): { number: string | null; text: string | null }[] {
  return [...container.querySelectorAll('[data-slot="preview-code"] tbody tr')].map((row) => {
    const [number, content] = row.querySelectorAll("td");
    return { number: number?.textContent ?? null, text: content?.textContent ?? null };
  });
}

const HTML = "<table><tr><td>HTML-SENTINEL</td></tr></table><script>window.__nb = 1</script>";
/** 内容里带一个换行（Jupyter 存的 base64 以换行结尾，也可能折行）。 */
const PNG_BASE64 = "iVBORw0KGgo=\nAAAA\n";
const PNG_SRC = "data:image/png;base64,iVBORw0KGgo=AAAA";
const RULE = "-".repeat(20);
const TRACEBACK = [
  `${ESC}[0;31m${RULE}${ESC}[0m`,
  `${ESC}[0;31mZeroDivisionError${ESC}[0m                         Traceback (most recent call last)`,
  `${ESC}[0;32m----> 1${ESC}[0;31m ${ESC}[0;36m1${ESC}[0;34m/${ESC}[0;36m0${ESC}[1;33m`,
  `${ESC}[0;31mZeroDivisionError${ESC}[0m: division by zero`,
];
const TRACEBACK_TEXT = [
  RULE,
  "ZeroDivisionError                         Traceback (most recent call last)",
  "----> 1 1/0",
  "ZeroDivisionError: division by zero",
].join("\n");

const DEMO = notebook([
  { cell_type: "markdown", metadata: {}, source: "# 标题" },
  code('print("hi")', [{ output_type: "stream", name: "stdout", text: "hi\n" }], 3),
  code("show()", [
    display({
      "text/plain": "PNG-PLAIN-SENTINEL",
      "text/html": "<b>PNG-HTML-SENTINEL</b>",
      "image/png": PNG_BASE64,
    }),
  ]),
  code("HTML(t)", [
    display({ "text/plain": "PLAIN-SENTINEL", "text/html": HTML }, "execute_result"),
  ]),
  code("1/0", [
    {
      output_type: "error",
      ename: "ZeroDivisionError",
      evalue: "division by zero",
      traceback: TRACEBACK,
    },
  ]),
  code("custom()", [display({ "application/vnd.custom+json": { a: 1 } })]),
]);
const DEMO_CODE_CELLS = 5;

// file-previewers「Notebook」的场景「单元格与输出」。
describe("Notebook 预览器：单元格与输出", () => {
  it("依次是一级标题、带执行计数与着色源码的代码单元和等宽的 hi、data: 地址的 png、空 sandbox 的 iframe（HTML 不进主文档）、不含转义序列的 traceback、不支持的类型的说明", async () => {
    const container = renderNotebook(DEMO);

    expect(screen.getByRole("heading", { level: 1, name: "标题" })).toBeTruthy();

    expect(prompts(container)).toStrictEqual(["[3]", "[1]", "[1]", "[1]", "[1]"]);
    expect(screen.getByText("[3]", { exact: true })).toBeTruthy();
    expect(monoTexts(container)[0]).toBe("hi\n");
    expect(screen.getByText("hi", { exact: true }).tagName).toBe("PRE");

    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe(PNG_SRC);
    expect(images[0]?.getAttribute("src")).not.toMatch(/\s/);
    expect(images[0]?.hasAttribute("alt")).toBe(true);

    const frames = [...container.querySelectorAll("iframe")];
    expect(frames).toHaveLength(1);
    const frame = frames[0] as HTMLIFrameElement;
    expect(frame.hasAttribute("sandbox")).toBe(true);
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe(HTML);
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.getAttribute("title")).toBe("HTML 输出");
    expect(screen.queryByText("PLAIN-SENTINEL")).toBeNull();
    expect(screen.queryByText(/PNG-(PLAIN|HTML)-SENTINEL/)).toBeNull();

    expect(monoTexts(container)).toStrictEqual(["hi\n", TRACEBACK_TEXT]);
    expect(container.textContent).not.toContain(ESC);

    expect(screen.getByText("不支持的输出类型 application/vnd.custom+json")).toBeTruthy();

    expect(
      [...container.querySelectorAll('h1, img, iframe, pre, [data-slot="notebook-prompt"]')].map(
        (node) => node.tagName,
      ),
    ).toStrictEqual(["H1", "SPAN", "PRE", "SPAN", "IMG", "SPAN", "IFRAME", "SPAN", "PRE", "SPAN"]);

    expect(container.querySelectorAll(COLORED)).toHaveLength(0);
    await untilColored(container);
    expect(categoryOf(container, "print")).toBe("hljs-built_in");
    expect(categoryOf(container, '"hi"')).toBe("hljs-string");
  });

  // 三条分开写：其中任何一条都单独说明 HTML 输出进了主文档。
  it("HTML 输出里的文字不在主文档里", () => {
    renderNotebook(DEMO);

    expect(screen.getByText("[3]", { exact: true })).toBeTruthy();
    expect(screen.queryByText("HTML-SENTINEL")).toBeNull();
    expect(document.body.textContent).not.toContain("HTML-SENTINEL");
  });

  it("主文档里没有因 HTML 输出新增的 script 元素，它的脚本也没有运行", () => {
    Reflect.deleteProperty(window, "__nb");
    renderNotebook(DEMO);

    expect(screen.getByText("[3]", { exact: true })).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect("__nb" in window).toBe(false);
  });

  it("主文档里的表格恰是每个代码单元的源码视图自带的那一张，没有因 HTML 输出新增的", () => {
    renderNotebook(DEMO);

    expect(document.querySelectorAll("table")).toHaveLength(DEMO_CODE_CELLS);
    expect(document.querySelectorAll("table td, table th")).toHaveLength(DEMO_CODE_CELLS * 2);
    expect(document.querySelectorAll('[data-slot="preview-code"] > table')).toHaveLength(
      DEMO_CODE_CELLS,
    );
  });

  it("没有任何可编辑、可运行或可展开的控件", () => {
    const container = renderNotebook(DEMO);

    expect(
      container.querySelectorAll(
        "button, input, textarea, select, details, a[href], [contenteditable], [role=button]",
      ),
    ).toHaveLength(0);
  });

  it("execution_count 为 null、小数、字符串或缺失时是 [ ]，是整数（含 0）时是 [n]", () => {
    const { outputs: _outputs, execution_count: _count, ...bare } = code("e");
    const container = renderNotebook(
      notebook([
        code("a", [], null),
        code("b", [], 1.5),
        code("c", [], "3"),
        code("d", [], 0),
        bare,
      ]),
    );

    expect(prompts(container)).toStrictEqual(["[ ]", "[ ]", "[ ]", "[0]", "[ ]"]);
  });

  it("source 是字符串数组时原样拼接；raw 单元是等宽文本，其中的标记只是文字", () => {
    const container = renderNotebook(
      notebook([
        code(["a = 1\n", "b = 2"]),
        { cell_type: "raw", metadata: {}, source: ["<script>alert(1)</script>\n", "<b>raw</b>"] },
        {
          cell_type: "markdown",
          metadata: {},
          source: ["- 一\n", "- 二 <script>alert(2)</script>"],
        },
      ]),
    );

    expect(sourceLines(container)).toStrictEqual([
      { number: "1", text: "a = 1" },
      { number: "2", text: "b = 2" },
    ]);
    expect(monoTexts(container)).toStrictEqual(["<script>alert(1)</script>\n<b>raw</b>"]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(document.querySelector("script, b")).toBeNull();
  });
});

describe("Notebook 预览器：输出按类型", () => {
  /** 只有一个代码单元、带这些输出的 Notebook。 */
  function withOutputs(...outputs: unknown[]) {
    return renderNotebook(notebook([code("x", outputs)]));
  }

  it("image/jpeg 是固定前缀 data:image/jpeg;base64, 的 img", () => {
    const container = withOutputs(
      display({ "image/jpeg": "/9j/4AAQ\n", "text/plain": "<Figure>" }),
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/jpeg;base64,/9j/4AAQ",
    );
    expect(monoTexts(container)).toStrictEqual([]);
  });

  it("image/svg+xml 是百分号编码的 data:image/svg+xml 地址的 img，文档里没有内联的 svg 与 script", () => {
    const container = withOutputs(
      display({
        "image/svg+xml": ['<svg viewBox="0 0 8 8">\n', "<script>alert(1)</script>图 50%</svg>"],
        "text/html": "<i>SVG-HTML-SENTINEL</i>",
      }),
    );

    // 手写的百分号编码字面量，不在期望里再调一次编码函数。
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/svg+xml;charset=utf-8," +
        "%3Csvg%20viewBox%3D%220%200%208%208%22%3E%0A" +
        "%3Cscript%3Ealert(1)%3C%2Fscript%3E%E5%9B%BE%2050%25%3C%2Fsvg%3E",
    );
    expect(document.querySelector("svg, script, iframe")).toBeNull();
  });

  it("三种图片并存时取 png，没有 png 时取 jpeg；始终只有一张图", () => {
    const all = withOutputs(
      display({ "image/svg+xml": "<svg/>", "image/jpeg": "JJJJ", "image/png": "PPPP" }),
    );
    expect([...all.querySelectorAll("img")].map((node) => node.getAttribute("src"))).toStrictEqual([
      "data:image/png;base64,PPPP",
    ]);
    cleanup();

    const two = withOutputs(display({ "image/svg+xml": "<svg/>", "image/jpeg": "JJJJ" }));
    expect([...two.querySelectorAll("img")].map((node) => node.getAttribute("src"))).toStrictEqual([
      "data:image/jpeg;base64,JJJJ",
    ]);
  });

  it("只有 text/plain 时是等宽文本；其中的标记只是文字", () => {
    const container = withOutputs(display({ "text/plain": ["<b>3</b>\n", "4"] }, "execute_result"));

    expect(monoTexts(container)).toStrictEqual(["<b>3</b>\n4"]);
    expect(document.querySelector("b")).toBeNull();
  });

  it("text/html 是字符串数组时拼接后原样成为 srcdoc，前后不加任何内容", () => {
    const container = withOutputs(display({ "text/html": ["<p>一</p>\n", "<p>二</p>"] }));

    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toBe("<p>一</p>\n<p>二</p>");
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  });

  it("stream 原样显示（不去转义序列），多个输出各占一块", () => {
    const container = withOutputs(
      { output_type: "stream", name: "stdout", text: ["a\n", "b\n"] },
      { output_type: "stream", name: "stderr", text: `${ESC}[31mwarn${ESC}[0m` },
    );

    expect(monoTexts(container)).toStrictEqual(["a\nb\n", `${ESC}[31mwarn${ESC}[0m`]);
  });

  it("error 没有 traceback 时显示 ename: evalue", () => {
    const container = withOutputs({
      output_type: "error",
      ename: "ZeroDivisionError",
      evalue: "division by zero",
      traceback: [],
    });

    expect(monoTexts(container)).toStrictEqual(["ZeroDivisionError: division by zero"]);
  });

  it("traceback 里不是颜色码的转义序列也不留下 ESC 字符", () => {
    const container = withOutputs({
      output_type: "error",
      traceback: [`a${ESC}[2Kb${ESC}[?25lc${ESC}[1;2Hd`, `e${ESC}`],
    });

    expect(monoTexts(container)).toStrictEqual(["abcd\ne"]);
  });

  it("不认识的 output_type 显示「不支持的输出类型」加类型名；data 为空的输出什么都不显示", () => {
    const container = withOutputs(
      { output_type: "update_display_data", data: { "text/plain": "x" } },
      display({}),
    );

    expect(screen.getByText("不支持的输出类型 update_display_data")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("pre, img, iframe")).toHaveLength(0);
  });

  it("类型名里的标记只是文字", () => {
    withOutputs(display({ "<img src=x onerror=alert(1)>": 1 }));

    expect(screen.getByText("不支持的输出类型 <img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

// file-previewers「Notebook」的场景「解析失败退回源码」。
describe("Notebook 预览器：解析失败退回源码", () => {
  it.each([
    ["不是 JSON", "not json\n第二行 <script>alert(1)</script>"],
    ["nbformat 为 3", '{"nbformat": 3,\n "cells": []}'],
    ["没有 cells", '{"nbformat": 4,\n "metadata": {}}'],
    ["nbformat 是字符串 4", '{"nbformat": "4",\n "cells": []}'],
    ["cells 不是数组", '{"nbformat": 4,\n "cells": {"0": 1}}'],
    ["根是数组", '[{"nbformat": 4,\n "cells": []}]'],
    ["根是 null", "null"],
    ["根是数字", "4"],
    ["空文件", ""],
  ])("%s：显示说明与带行号的原文，没有单元格", async (_label, content) => {
    const container = renderNotebook(content);

    expect(screen.getByText(FALLBACK, { exact: true })).toBeTruthy();
    expect(sourceLines(container)).toStrictEqual(
      content
        .split("\n")
        .map((text, index) => ({ number: String(index + 1), text: text === "" ? " " : text })),
    );
    expect(
      container.querySelectorAll('iframe, img, script, [data-slot="notebook-prompt"]'),
    ).toHaveLength(0);
    await flush();
    expect(container.querySelectorAll(COLORED)).toHaveLength(0);
    expect(stub.loadHighlighter).not.toHaveBeenCalled();
  });

  it("嵌套极深的 JSON 不抛错，按退回处理", () => {
    const depth = 200_000;
    const content = `${"[".repeat(depth)}${"]".repeat(depth)}`;

    expect(() => renderNotebook(content)).not.toThrow();
    expect(screen.getByText(FALLBACK, { exact: true })).toBeTruthy();
  });

  it("被截断的内容不解析：即使开头是完整的 Notebook 也显示源码", () => {
    const content = notebook([code('print("hi")', [], 3)]);
    const container = renderNotebook(content, true);

    expect(screen.getByText(FALLBACK, { exact: true })).toBeTruthy();
    expect(sourceLines(container)).toStrictEqual([{ number: "1", text: content }]);
    expect(prompts(container)).toStrictEqual([]);
  });
});

describe("Notebook 预览器：任何 JSON 都不抛", () => {
  it("形状不对的单元格与输出各自降级：不是对象或类型不认识的单元按 raw 显示 source，孤立代理的 svg 显示为不支持，其余不显示", () => {
    const hostile = notebook(
      [
        null,
        1,
        {},
        { cell_type: "code" },
        { cell_type: "x", source: ["a", "b"] },
        { cell_type: "markdown", source: 5 },
        { cell_type: "code", source: { length: 3 }, outputs: {}, execution_count: {} },
        code(
          ["s", 7, null, "t"],
          [
            display({ "image/svg+xml": "<svg>\ud800</svg>", "text/plain": "SVG-PLAIN-SENTINEL" }),
            null,
            5,
            "stream",
            [],
            {},
            { output_type: 7 },
            { output_type: "display_data" },
            { output_type: "display_data", data: ["image/png"] },
            { output_type: "display_data", data: { "image/png": 5 } },
            { output_type: "stream", text: { a: 1 } },
            { output_type: "error" },
            { output_type: "error", ename: 1, evalue: ["x"], traceback: "not-an-array" },
            { output_type: "execute_result", data: { "text/html": null } },
            { output_type: "__proto__" },
          ],
        ),
      ],
      { metadata: { language_info: { name: "__proto__" }, kernelspec: 5 } },
    );
    expect(hostile).toContain("\\ud800");

    let container: HTMLElement | undefined;
    expect(() => {
      container = renderNotebook(hostile);
    }).not.toThrow();
    const root = container as HTMLElement;

    expect(prompts(root)).toStrictEqual(["[ ]", "[ ]", "[1]"]);
    // 恰这两条说明：形状不对的 data（数组）与其余输出都不产生第三条。
    expect(screen.getAllByText(/^不支持的输出类型/).map((node) => node.textContent)).toStrictEqual([
      "不支持的输出类型 image/svg+xml",
      "不支持的输出类型 __proto__",
    ]);
    expect(screen.queryByText("SVG-PLAIN-SENTINEL")).toBeNull();
    // 四个按 raw 显示的单元（前三个与 x）、一个空的 stream、两个 error、一张空内容的 png、一个空文档的 iframe。
    expect(monoTexts(root)).toStrictEqual(["", "", "", "ab", "", "", "not-an-array"]);
    expect(sourceLines(root).map((line) => line.text)).toStrictEqual([" ", " ", "st"]);
    expect([...root.querySelectorAll("img")].map((node) => node.getAttribute("src"))).toStrictEqual(
      ["data:image/png;base64,"],
    );
    expect(
      [...root.querySelectorAll("iframe")].map((node) => node.getAttribute("srcdoc")),
    ).toStrictEqual([""]);
    expect(root.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  });

  it("语言名不是已注册的语法时不抛、不着色、没有提示", async () => {
    const container = renderNotebook(
      notebook([code("x <- 1")], { metadata: { language_info: { name: "R" } } }),
    );

    await flush();
    expect(stub.loadHighlighter).toHaveBeenCalled();
    expect(container.querySelectorAll(COLORED)).toHaveLength(0);
    expect(sourceLines(container)).toStrictEqual([{ number: "1", text: "x <- 1" }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Notebook 预览器：代码单元的语言", () => {
  // `const` 在 python 语法下不是关键字；`print` 在 javascript 语法下不是内建名。
  it.each([
    ["language_info.name", { language_info: { name: "javascript" } }],
    ["kernelspec.language（没有 language_info）", { kernelspec: { language: "javascript" } }],
    [
      "language_info.name 先于 kernelspec.language",
      { language_info: { name: "javascript" }, kernelspec: { language: "python" } },
    ],
    [
      "language_info.name 是空串时退到 kernelspec.language",
      { language_info: { name: "" }, kernelspec: { language: "javascript" } },
    ],
  ])("取 %s", async (_label, metadata) => {
    const container = renderNotebook(notebook([code("const a = 1")], { metadata }));

    expect(container.querySelectorAll(COLORED)).toHaveLength(0);
    await untilColored(container);
    expect(categoryOf(container, "const")).toBe("hljs-keyword");
  });

  it.each([
    ["没有 metadata", {}],
    [
      "metadata 里两处都不是非空字符串",
      { metadata: { language_info: { name: 5 }, kernelspec: {} } },
    ],
  ])("%s 时按 python 着色", async (_label, extra) => {
    const { metadata: _metadata, ...bare } = JSON.parse(notebook([code('print("hi")')]));
    const container = renderNotebook(JSON.stringify({ ...bare, ...extra }));

    expect(container.querySelectorAll(COLORED)).toHaveLength(0);
    await untilColored(container);
    expect(categoryOf(container, "print")).toBe("hljs-built_in");
    expect(categoryOf(container, "const")).toBeUndefined();
  });

  it("超过源码视图着色上限的代码单元不着色、仍带行号（上限对 Notebook 照旧）", async () => {
    const long = `x = 1\n${"# pad\n".repeat(20_000)}`;
    expect(long.length).toBeGreaterThan(100_000);
    const container = renderNotebook(notebook([code(long)]));

    await flush();
    expect(stub.loadHighlighter).not.toHaveBeenCalled();
    expect(container.querySelectorAll(COLORED)).toHaveLength(0);
    expect(sourceLines(container)).toHaveLength(20_002);
  });
});

// 经预览面板：类别到预览器的选择，与场景「超限」。
describe("PreviewPane：Notebook", () => {
  function pane(name: string, preview: Parameters<typeof PreviewPane>[0]["preview"], size: number) {
    return (
      <PreviewPane
        mtime={1_726_000_000_000}
        name={name}
        path={`uploads/${name}`}
        preview={preview}
        size={size}
        workspaceId="w1"
      />
    );
  }

  it("g.ipynb 的文本落到 Notebook 预览器：出现执行计数与 iframe，不是一整段 JSON 源码", async () => {
    const text = notebook([code('print("hi")', [display({ "text/html": HTML })], 3)]);
    const { container } = render(
      pane(
        "g.ipynb",
        { data: { kind: "text", size: text.length, text, truncated: false }, status: "success" },
        text.length,
      ),
    );

    expect(await screen.findByText("[3]", { exact: true })).toBeTruthy();
    expect(sourceLines(container)).toStrictEqual([{ number: "1", text: 'print("hi")' }]);
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toBe(HTML);
    expect(screen.getByRole("link", { name: "下载 g.ipynb" })).toBeTruthy();
  });

  it("扩展名大写的 G.IPYNB 同样落到 Notebook 预览器", async () => {
    const text = notebook([code("x", [], 7)]);
    render(
      pane(
        "G.IPYNB",
        { data: { kind: "text", size: text.length, text, truncated: false }, status: "success" },
        text.length,
      ),
    );

    expect(await screen.findByText("[7]", { exact: true })).toBeTruthy();
  });

  it("超限：big.ipynb 显示「文件过大，无法预览」与下载链接，没有单元格", async () => {
    const { container } = render(pane("big.ipynb", { status: "too-large" }, 10_485_761));

    expect(await screen.findByText("文件过大，无法预览", { exact: true })).toBeTruthy();
    expect(screen.getByText("big.ipynb · 10.0 MB", { exact: true })).toBeTruthy();
    const link = screen.getByRole("link", { name: "下载 big.ipynb" });
    expect(link.getAttribute("href")).toBe(downloadUrl("w1", "uploads/big.ipynb"));
    expect(link.hasAttribute("download")).toBe(true);
    await flush();
    expect(
      container.querySelectorAll(
        'iframe, [data-slot="notebook-prompt"], [data-slot="preview-code"]',
      ),
    ).toHaveLength(0);
    expect(screen.queryByText(/^\[/)).toBeNull();
    expect(screen.queryByText(FALLBACK)).toBeNull();
  });
});
