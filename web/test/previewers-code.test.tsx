import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodePreviewer,
  CodeView,
  highlightLanguage,
} from "../src/features/files/previewers/code.js";
import { highlightLines } from "../src/features/files/previewers/highlight.js";
import type { Highlighter } from "../src/features/files/previewers/index.js";
import { MarkdownPreviewer } from "../src/features/files/previewers/markdown.js";
import { SvgPreviewer } from "../src/features/files/previewers/svg.js";
import { deferred, observeUnhandledRejections, settle } from "./chat-stream-support.js";
import { readRepoFile } from "./ui-support.js";

/*
 * file-previewers「源码视图与语法高亮」。预览器模块静态导入、直接渲染：行号与文本是模块同步渲染的，
 * 同步断言；着色元素一律等出来。`previewers/index.ts` 只换掉高亮加载函数（其余原样），每条用例
 * 自己决定它何时、以什么结果落定；放行时给的是静态导入的真 `highlightLines`。
 * 着色后的单元格只比 `textContent`，不按可及名取。
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

/** 带语法类别标记的元素。 */
const COLORED = '[class^="hljs-"]';

type Line = { number: string | null; text: string | null; colored: number };

function sourceLines(container: HTMLElement): Line[] {
  return [...container.querySelectorAll('[data-slot="preview-code"] tbody tr')].map((row) => {
    const [number, content] = row.querySelectorAll("td");
    return {
      number: number?.textContent ?? null,
      text: content?.textContent ?? null,
      colored: content?.querySelectorAll(COLORED).length ?? 0,
    };
  });
}

function plain(lines: Line[]): Omit<Line, "colored">[] {
  return lines.map(({ number, text }) => ({ number, text }));
}

function coloredCount(container: HTMLElement): number {
  return container.querySelectorAll(COLORED).length;
}

/** 文字恰为 `text` 的着色元素的类别。 */
function categoryOf(container: HTMLElement, text: string): string | undefined {
  return [...container.querySelectorAll(COLORED)].find((node) => node.textContent === text)
    ?.className;
}

async function untilColored(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(coloredCount(container)).toBeGreaterThan(0));
}

/** 让已排队的加载与随后的提交（如果有）落定；用于断言「之后仍然没有着色」。 */
async function flush(): Promise<void> {
  await act(async () => {
    await settle();
  });
}

describe("源码视图：行号与字面值", () => {
  it("着色后仍是三行、行号 1 到 3，每行文字逐字相同，末尾空行是一个不换行空格，文档里没有 script 元素", async () => {
    const text = "<p>hi</p>\n<script>alert(1)</script>\n";
    const { container } = render(<CodeView name="x.html" text={text} />);
    await untilColored(container);

    expect(plain(sourceLines(container))).toEqual([
      { number: "1", text: "<p>hi</p>" },
      { number: "2", text: "<script>alert(1)</script>" },
      { number: "3", text: "\u00a0" },
    ]);
    expect(document.querySelector("script")).toBeNull();
  });

  it("跨行的记号按行切开：块注释的两行各自带注释类别，逐行文字不变", async () => {
    const { container } = render(<CodeView name="main.ts" text={"/* a\nb */\nconst x = 1;"} />);
    await untilColored(container);

    expect(plain(sourceLines(container))).toEqual([
      { number: "1", text: "/* a" },
      { number: "2", text: "b */" },
      { number: "3", text: "const x = 1;" },
    ]);
    expect(categoryOf(container, "/* a")).toBe("hljs-comment");
    expect(categoryOf(container, "b */")).toBe("hljs-comment");
    expect(categoryOf(container, "const")).toMatch(/^hljs-/);
    expect(categoryOf(container, "const")).not.toBe("hljs-comment");
  });

  it("嵌在子语言里的跨行记号也按行切开：x.html 的 script 里跨两行的块注释，每行文字与源码相同，注释的两行各带注释类别", async () => {
    const text = "<script>\n/* a\nb */\nconst x = 1;\n</script>";
    const { container } = render(<CodeView name="x.html" text={text} />);
    await flush();
    await flush();

    const lines = sourceLines(container);
    expect(lines.map((line) => line.text)).toEqual(text.split("\n"));
    expect(lines.map((line) => line.number)).toEqual(["1", "2", "3", "4", "5"]);
    expect(lines[1]?.colored).toBeGreaterThan(0);
    expect(lines[2]?.colored).toBeGreaterThan(0);
    expect(categoryOf(container, "/* a")).toBe("hljs-comment");
    expect(categoryOf(container, "b */")).toBe("hljs-comment");
    expect(document.querySelector("script")).toBeNull();
  });

  it("跨行记号中间的空行仍是一个不换行空格", async () => {
    const { container } = render(<CodeView name="main.ts" text={"/* a\n\nb */"} />);
    await untilColored(container);

    expect(plain(sourceLines(container))).toEqual([
      { number: "1", text: "/* a" },
      { number: "2", text: "\u00a0" },
      { number: "3", text: "b */" },
    ]);
  });

  it("json 先格式化再着色：行按缩进后的文本来", async () => {
    const { container } = render(<CodePreviewer content={'{"a":1,"b":"x"}'} name="data.json" />);
    await untilColored(container);

    expect(plain(sourceLines(container))).toEqual([
      { number: "1", text: "{" },
      { number: "2", text: '  "a": 1,' },
      { number: "3", text: '  "b": "x"' },
      { number: "4", text: "}" },
    ]);
    expect(categoryOf(container, "1")).toMatch(/^hljs-/);
    expect(categoryOf(container, '"x"')).toMatch(/^hljs-/);
    expect(categoryOf(container, "1")).not.toBe(categoryOf(container, '"x"'));
  });
});

describe("源码视图：按语言着色", () => {
  const TEXT = 'const a = "x"; // c';

  it("main.ts 的关键字、字符串与注释落在类别各不相同的元素里；同文的 notes.unknownext 没有着色元素也不加载高亮库，两者行数与文本相同", async () => {
    const mapped = render(<CodeView name="main.ts" text={TEXT} />);
    await untilColored(mapped.container);

    const categories = [
      categoryOf(mapped.container, "const"),
      categoryOf(mapped.container, '"x"'),
      categoryOf(mapped.container, "// c"),
    ];
    expect(categories.every((category) => category?.startsWith("hljs-"))).toBe(true);
    expect(new Set(categories).size).toBe(3);
    const mappedLines = plain(sourceLines(mapped.container));
    expect(mappedLines).toEqual([{ number: "1", text: TEXT }]);
    mapped.unmount();
    stub.loadHighlighter.mockClear();

    const unmapped = render(<CodeView name="notes.unknownext" text={TEXT} />);
    await flush();

    expect(coloredCount(unmapped.container)).toBe(0);
    expect(stub.loadHighlighter).not.toHaveBeenCalled();
    expect(plain(sourceLines(unmapped.container))).toEqual(mappedLines);
  });

  it("不传文件名时不着色、仍带行号，也不加载高亮库", async () => {
    const { container } = render(<CodeView text={TEXT} />);
    await flush();

    expect(sourceLines(container)).toEqual([{ number: "1", text: TEXT, colored: 0 }]);
    expect(stub.loadHighlighter).not.toHaveBeenCalled();
  });

  it("Markdown 的源码视图按 md 着色，文字不变", async () => {
    const { container } = render(
      <MarkdownPreviewer content={"# 标题\n\n**粗体**"} name="readme.md" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    await untilColored(container);

    expect(plain(sourceLines(container))).toEqual([
      { number: "1", text: "# 标题" },
      { number: "2", text: "\u00a0" },
      { number: "3", text: "**粗体**" },
    ]);
  });

  it("SVG 的源码视图与被截断时的源码都按标记语言着色，文档里没有内联的 svg 元素", async () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const toggled = render(<SvgPreviewer content={content} name="logo.svg" truncated={false} />);
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    await untilColored(toggled.container);
    expect(plain(sourceLines(toggled.container))).toEqual([{ number: "1", text: content }]);
    expect(document.querySelector("svg")).toBeNull();
    toggled.unmount();

    const truncated = render(<SvgPreviewer content={content} name="logo.svg" truncated />);
    await untilColored(truncated.container);
    expect(plain(sourceLines(truncated.container))).toEqual([{ number: "1", text: content }]);
    expect(document.querySelector("svg")).toBeNull();
  });

  // 规格列出的 27 个扩展名与两个文件名，对应的语言照实施注记逐项写死。
  it.each([
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
    ["a.ts", "typescript"],
    ["a.tsx", "typescript"],
    ["a.json", "json"],
    ["a.css", "css"],
    ["a.scss", "scss"],
    ["a.html", "xml"],
    ["a.htm", "xml"],
    ["a.xml", "xml"],
    ["a.svg", "xml"],
    ["a.py", "python"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["a.java", "java"],
    ["a.c", "c"],
    ["a.h", "c"],
    ["a.cpp", "cpp"],
    ["a.sh", "bash"],
    ["a.sql", "sql"],
    ["a.yaml", "yaml"],
    ["a.yml", "yaml"],
    ["a.toml", "ini"],
    ["a.ini", "ini"],
    ["a.md", "markdown"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["MAIN.TS", "typescript"],
  ])("%s 映射到 %s，且该语言已注册（着色一行不抛错）", (name, language) => {
    expect(highlightLanguage(name)).toBe(language);
    expect(highlightLines("a", language)).toHaveLength(1);
  });

  it.each(["notes.unknownext", "notes.txt", "README", "Dockerfile.dev", "makefile", "a.proto"])(
    "%s 没有对应的语言",
    (name) => {
      expect(highlightLanguage(name)).toBeNull();
    },
  );

  it("toml 交给兼管它的 ini 语法：键、字符串与表头各有类别", async () => {
    const { container } = render(<CodeView name="conf.toml" text={'a = "b"\n[t]'} />);
    await untilColored(container);

    const categories = [
      categoryOf(container, "a"),
      categoryOf(container, '"b"'),
      categoryOf(container, "[t]"),
    ];
    expect(categories.every((category) => category?.startsWith("hljs-"))).toBe(true);
    expect(new Set(categories).size).toBe(3);
  });

  it("没有注册的语言名着色时抛错", () => {
    expect(() => highlightLines("a", "unknownext")).toThrow();
  });
});

describe("源码视图：先内容后颜色", () => {
  it("高亮库的加载挂起时 main.py 已带行号显示且没有着色元素；放行后出现着色元素，行数与文本不变", async () => {
    const gate = deferred<Highlighter>();
    stub.loadHighlighter.mockReturnValue(gate.promise);

    const { container } = render(<CodeView name="main.py" text={"print(1)\nx = 2"} />);

    const before = sourceLines(container);
    expect(before).toEqual([
      { number: "1", text: "print(1)", colored: 0 },
      { number: "2", text: "x = 2", colored: 0 },
    ]);
    expect(stub.loadHighlighter).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve(highlightLines);
    });
    await untilColored(container);

    expect(plain(sourceLines(container))).toEqual(plain(before));
  });

  it("换了内容之后旧内容的着色不留在新行上：新文本立即显示且未着色，随后按新文本着色", async () => {
    const view = render(<CodeView name="main.ts" text="const a = 1;" />);
    await untilColored(view.container);

    const gate = deferred<Highlighter>();
    stub.loadHighlighter.mockReturnValue(gate.promise);
    view.rerender(<CodeView name="main.ts" text={"let b = 2;\nlet c = 3;"} />);

    expect(sourceLines(view.container)).toEqual([
      { number: "1", text: "let b = 2;", colored: 0 },
      { number: "2", text: "let c = 3;", colored: 0 },
    ]);

    await act(async () => {
      gate.resolve(highlightLines);
    });
    await untilColored(view.container);
    expect(plain(sourceLines(view.container))).toEqual([
      { number: "1", text: "let b = 2;" },
      { number: "2", text: "let c = 3;" },
    ]);
  });

  it("同一段文本改名成没有对应语言的文件后，原先的着色立即撤掉", async () => {
    const text = 'const a = "x";';
    const view = render(<CodeView name="main.ts" text={text} />);
    await untilColored(view.container);

    view.rerender(<CodeView name="notes.unknownext" text={text} />);

    expect(sourceLines(view.container)).toEqual([{ number: "1", text, colored: 0 }]);
  });

  it("卸载之后才落定的加载不再着色，也不报错", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const highlighter = vi.fn(highlightLines);
    const gate = deferred<Highlighter>();
    stub.loadHighlighter.mockReturnValue(gate.promise);
    try {
      const view = render(<CodeView name="main.ts" text="const a = 1;" />);
      view.unmount();
      await act(async () => {
        gate.resolve(highlighter);
      });
      await flush();

      expect(highlighter).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join("\n")).toBe("");
    } finally {
      error.mockRestore();
    }
  });
});

describe("源码视图：着色失败时保留未着色的源码", () => {
  const TEXT = "const a = 1;\nconst b = 2;";
  const PLAIN: Line[] = [
    { number: "1", text: "const a = 1;", colored: 0 },
    { number: "2", text: "const b = 2;", colored: 0 },
  ];

  it.each<[string, () => Promise<Highlighter>]>([
    ["高亮库加载被拒绝", () => Promise.reject(new Error("chunk request failed"))],
    [
      "高亮函数抛错",
      () =>
        Promise.resolve(() => {
          throw new Error("grammar failed");
        }),
    ],
    ["高亮函数给出的行数与源码不符", () => Promise.resolve(() => ["const a = 1;const b = 2;"])],
  ])("%s：文本与行号仍在，没有错误提示，没有未处理的拒绝", async (_case, load) => {
    stub.loadHighlighter.mockImplementation(load);
    const observer = observeUnhandledRejections();
    try {
      const { container } = render(<CodeView name="main.ts" text={TEXT} />);
      await flush();
      await flush();

      expect(stub.loadHighlighter).toHaveBeenCalledTimes(1);
      expect(sourceLines(container)).toEqual(PLAIN);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});

describe("源码视图：着色的大小上限", () => {
  it("恰好 100000 个字符仍着色；多一个字符就不着色、不加载高亮库，仍带行号", async () => {
    const atLimit = `// ${"x".repeat(99_997)}`;
    expect(atLimit).toHaveLength(100_000);
    const within = render(<CodeView name="main.ts" text={atLimit} />);
    await untilColored(within.container);
    expect(plain(sourceLines(within.container))).toEqual([{ number: "1", text: atLimit }]);
    within.unmount();
    stub.loadHighlighter.mockClear();

    const over = render(<CodeView name="main.ts" text={`${atLimit}x`} />);
    await flush();

    expect(sourceLines(over.container)).toEqual([{ number: "1", text: `${atLimit}x`, colored: 0 }]);
    expect(stub.loadHighlighter).not.toHaveBeenCalled();
  });
});

describe("源码视图：颜色取自主题变量", () => {
  it("code.tsx 用到的语法色变量都在 theme.css 里定义为单个 token 引用，code.tsx 与 highlight.ts 不写颜色字面量", () => {
    const code = readRepoFile("web/src/features/files/previewers/code.tsx");
    const used = [...new Set(code.match(/--syntax-[a-z]+/g))].sort();
    expect(used).toEqual([
      "--syntax-comment",
      "--syntax-keyword",
      "--syntax-number",
      "--syntax-string",
      "--syntax-title",
    ]);

    const theme = readRepoFile("web/src/styles/theme.css");
    const defined = [...theme.matchAll(/^\s*(--syntax-[a-z]+):\s*([^;]+);/gm)].map(
      ([, name, value]) => [name, /^var\(--wb-[a-z0-9-]+\)$/.test(value ?? "")] as const,
    );
    expect(defined.sort()).toEqual(used.map((name) => [name, true]));

    const source = code + readRepoFile("web/src/features/files/previewers/highlight.ts");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|oklch)a?\(/g)).toBeNull();
  });
});

describe("loadHighlighter", () => {
  const INDEX = "../src/features/files/previewers/index.js";
  const HIGHLIGHT = "../src/features/files/previewers/highlight.js";

  afterEach(() => {
    vi.doUnmock(HIGHLIGHT);
    vi.resetModules();
  });

  it("每次调用给出同一个 promise，落定为按行着色的函数", async () => {
    const { loadHighlighter } =
      await vi.importActual<typeof import("../src/features/files/previewers/index.js")>(INDEX);

    const first = loadHighlighter();
    expect(loadHighlighter()).toBe(first);
    const lines = (await first)("a\nb", "typescript");
    expect(lines).toHaveLength(2);
  });

  it("加载被拒绝后不留住那个失败：下一次调用重新加载并成功", async () => {
    vi.resetModules();
    vi.doMock(HIGHLIGHT, () => {
      throw new Error("chunk request failed");
    });
    const { loadHighlighter } =
      await vi.importActual<typeof import("../src/features/files/previewers/index.js")>(INDEX);

    await expect(loadHighlighter()).rejects.toThrow();

    vi.doUnmock(HIGHLIGHT);
    const lines = (await loadHighlighter())("a\nb", "typescript");
    expect(lines).toHaveLength(2);
  });
});
