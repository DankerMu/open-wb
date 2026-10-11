import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMtime } from "../src/features/files/file-meta.js";
import { PreviewPane } from "../src/features/files/preview.js";
import { CodeView } from "../src/features/files/previewers/code.js";
import { loadHighlighter } from "../src/features/files/previewers/index.js";
import { CsvTable } from "../src/features/files/previewers/table.js";
import { mdRender } from "../src/lib/md-render.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILE_MTIME = 1_726_000_000_000;
const FILE_MTIME_TEXT = formatMtime(FILE_MTIME);

function textPreview(
  name: string,
  text: string,
  extra?: { path?: string; size?: number; originalSize?: number; truncated?: boolean },
) {
  const originalSize = extra?.originalSize ?? extra?.size ?? text.length;
  const metadataSize = extra?.size ?? originalSize;
  return (
    <PreviewPane
      mtime={FILE_MTIME}
      name={name}
      path={extra?.path ?? name}
      preview={{
        data: {
          kind: "text",
          size: originalSize,
          text,
          truncated: extra?.truncated ?? false,
        },
        status: "success",
      }}
      previewToken={{ status: "idle" }}
      size={metadataSize}
      workspaceId="w1"
    />
  );
}

async function renderMarkdownProjections(src: string) {
  const html = document.createElement("div");
  html.innerHTML = mdRender(src);
  const { container } = render(textPreview("readme.md", src));
  await screen.findByRole("button", { name: "查看源码" });
  const reactRoot = container.querySelector("[data-markdown-body]");
  if (!(reactRoot instanceof HTMLElement)) {
    throw new Error("expected React Markdown body");
  }
  return {
    html,
    reactRoot,
    htmlParagraphs: html.querySelectorAll("p"),
    reactParagraphs: reactRoot.querySelectorAll("p"),
  };
}

function expectNormalizedDepth(body: HTMLElement, repeats: number) {
  const links = [...body.querySelectorAll("a")];
  expect(body.textContent).toBe("xt".repeat(repeats));
  expect(links).toHaveLength(repeats);
  expect(links.every((node) => node.getAttribute("href") === "#" && node.textContent === "x")).toBe(
    true,
  );
  let maxDepth = 0;
  for (const node of body.querySelectorAll("strong")) {
    let depth = 0;
    for (
      let current: Element | null = node;
      current && current !== body;
      current = current.parentElement
    ) {
      if (current.tagName === "STRONG") {
        depth += 1;
      }
    }
    if (depth > maxDepth) {
      maxDepth = depth;
    }
  }
  expect(maxDepth).toBe(64);
}

describe("CsvTable", () => {
  it("renders the first row as headers and notes two data rows", () => {
    render(<CsvTable text={"name,size\nalpha,1\nbeta,2\n"} />);

    expect([...screen.getAllByRole("columnheader")].map((node) => node.textContent)).toEqual([
      "name",
      "size",
    ]);
    expect(screen.getByRole("cell", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "beta" })).toBeTruthy();
    expect(screen.getByText("共 2 行 · 大文件仅预览前若干行")).toBeTruthy();
  });

  it("keeps CSV cell payloads as text rather than HTML", () => {
    render(<CsvTable text={"h\n<script>alert(1)</script>"} />);

    expect(screen.queryByRole("script")).toBeNull();
    expect(screen.getByRole("cell", { name: "<script>alert(1)</script>" })).toBeTruthy();
  });

  it("renders duplicate CSV rows without a React key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<CsvTable text={"name\nalpha\nalpha\n"} />);

    expect(screen.getAllByRole("cell", { name: "alpha" })).toHaveLength(2);
    expect(error.mock.calls.flat().join("\n")).not.toMatch(/same key/i);
    error.mockRestore();
  });
});

describe("CodeView", () => {
  it("numbers two content lines plus a trailing empty line", () => {
    render(<CodeView text={"first  line\nsecond\n"} />);
    const rows = screen.getAllByRole("row");

    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(within(rows[0] as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe("first  line");
    expect(within(rows[1] as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe("second");
    expect(within(rows[2] as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe("\u00a0");
  });

  it("keeps injection payloads as numbered source text", () => {
    render(<CodeView text={'<script>alert(1)</script>\n<img src=x onerror="alert(1)">'} />);
    const rows = screen.getAllByRole("row");

    expect(screen.queryByRole("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(within(rows[0] as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe(
      "<script>alert(1)</script>",
    );
    expect(within(rows[1] as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe(
      '<img src=x onerror="alert(1)">',
    );
  });

  it("renders duplicate code lines without a React key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<CodeView text={"same\nsame\n"} />);

    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(error.mock.calls.flat().join("\n")).not.toMatch(/same key/i);
    error.mockRestore();
  });
});

describe("PreviewPane metadata", () => {
  it("shows path, byte size and mtime for a text file", () => {
    render(textPreview("notes.txt", "hello", { path: "docs/notes.txt", size: 42 }));

    expect(screen.getByText("docs/notes.txt")).toBeTruthy();
    expect(screen.getByText(`42 B · ${FILE_MTIME_TEXT}`)).toBeTruthy();
    const meta = document.querySelector('[data-slot="preview-meta"]')?.textContent ?? "";
    expect(meta).toMatch(/^\S+ \S+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(meta).not.toMatch(/T\d{2}:|Z$/);
  });
});

describe("PreviewPane CSV routing", () => {
  it("routes a successful CSV preview through CsvTable", async () => {
    render(textPreview("notes.csv", "name,size\nalpha,1\nbeta,2\n"));

    expect(
      [...(await screen.findAllByRole("columnheader"))].map((node) => node.textContent),
    ).toEqual(["name", "size"]);
    expect(screen.getByText("共 2 行 · 大文件仅预览前若干行")).toBeTruthy();
  });
});

describe("PreviewPane Markdown", () => {
  it("defaults to rendered Markdown and resets after changing file identity", async () => {
    const view = render(textPreview("readme.md", "# 第一份"));

    expect(await screen.findByRole("heading", { level: 1, name: "第一份" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.queryByRole("heading", { level: 1, name: "第一份" })).toBeNull();
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(
      within(screen.getAllByRole("row")[0] as HTMLElement).getAllByRole("cell")[1]?.textContent,
    ).toBe("# 第一份");

    view.rerender(textPreview("notes.md", "# 第二份", { path: "notes.md" }));

    expect(await screen.findByRole("heading", { level: 1, name: "第二份" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
  });

  it("renders the 查看源码/渲染视图 toggle as a type=button without the legacy button class in both modes", async () => {
    render(textPreview("readme.md", "# 样式"));

    const toggle = await screen.findByRole("button", { name: "查看源码" });
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.className).not.toMatch(/\bui-btn/);
    fireEvent.click(toggle);
    const back = screen.getByRole("button", { name: "渲染视图" });
    expect(back.getAttribute("type")).toBe("button");
    expect(back.className).not.toMatch(/\bui-btn/);
  });

  it("replaces same-path document content without resetting the chosen mode", async () => {
    const path = "docs/readme.md";
    const view = render(textPreview("readme.md", "# 初始", { path }));

    expect(await screen.findByRole("heading", { level: 1, name: "初始" })).toBeTruthy();
    view.rerender(textPreview("readme.md", "## 渲染更新", { path }));
    expect(screen.queryByRole("heading", { level: 1, name: "初始" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "渲染更新" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    view.rerender(textPreview("readme.md", "### 源码更新", { path }));
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(
      within(screen.getAllByRole("row")[0] as HTMLElement).getAllByRole("cell")[1]?.textContent,
    ).toBe("### 源码更新");

    fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
    expect(screen.getByRole("heading", { level: 3, name: "源码更新" })).toBeTruthy();
  });

  it("renders deep reconstructed Markdown with every literal text pair and link", async () => {
    const input = "[**x](u**)t";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(textPreview("deep.md", input.repeat(3), { path: "docs/deep.md" }));
      await screen.findByRole("button", { name: "查看源码" });
      let body = view.container.querySelector("[data-markdown-body]");
      if (!(body instanceof HTMLElement)) {
        throw new Error("expected React Markdown body");
      }
      expect(body.innerHTML).toBe(
        '<p><a href="#"><strong>x</strong></a><strong>t<a href="#"><strong>x</strong></a><strong>t<a href="#"><strong>x</strong></a><strong>t</strong></strong></strong></p>',
      );

      fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
      await act(async () => {
        await loadHighlighter();
      });
      view.rerender(textPreview("deep.md", input.repeat(10_000), { path: "docs/deep.md" }));
      await act(async () => {
        await loadHighlighter();
      });
      expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "渲染视图" }));
      body = view.container.querySelector("[data-markdown-body]");
      if (!(body instanceof HTMLElement)) {
        throw new Error("expected React Markdown body");
      }
      expectNormalizedDepth(body, 10_000);

      view.rerender(textPreview("deep.md", "# 普通", { path: "docs/deep.md" }));
      expect(screen.getByRole("heading", { level: 1, name: "普通" })).toBeTruthy();
      view.rerender(textPreview("other.md", "# 另一份", { path: "docs/other.md" }));
      expect(await screen.findByRole("heading", { level: 1, name: "另一份" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
      view.unmount();
      expect(error.mock.calls.flat().join("\n")).toBe("");
    } finally {
      error.mockRestore();
    }
  }, 30_000);

  it("renders bold and a later href# link after malformed link syntax", async () => {
    const { container } = render(
      textPreview("readme.md", "[unfinished **bold**\n[x]( [A](one) **later**"),
    );
    await screen.findByRole("button", { name: "查看源码" });
    const body = container.querySelector("[data-markdown-body]");
    if (!(body instanceof HTMLElement)) {
      throw new Error("expected React Markdown body");
    }

    expect(body.querySelectorAll("strong")).toHaveLength(2);
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("a")?.getAttribute("href")).toBe("#");
    expect(body.querySelector("a")?.textContent).toBe("A");
    expect(body.textContent).toContain("[unfinished bold");
    expect(body.textContent).toContain("[x]( A later");
  });

  it("matches demo bold and formatted-label structure in both HTML and React projections", async () => {
    const src = [
      "**a*b**",
      "[**bold**](url)",
      "**[x](url)**",
      "[**A**](one)`**code**`[**B**](two)",
      "[**bold](url)**",
      "**[bold**](url)",
      "[**bold](url) tail**",
      "**[bold** tail](url)",
      "[`**code**`](url)",
      "[unfinished **bold**`code`[A](one)",
    ].join("\n");
    const { htmlParagraphs, reactParagraphs } = await renderMarkdownProjections(src);

    expect(htmlParagraphs[0]?.textContent).toBe("**a*b**");
    expect(htmlParagraphs[0]?.querySelector("strong")).toBeNull();
    expect(reactParagraphs[0]?.textContent).toBe("**a*b**");
    expect(reactParagraphs[0]?.querySelector("strong")).toBeNull();

    expect(htmlParagraphs[1]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(reactParagraphs[1]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(htmlParagraphs[2]?.querySelector("strong > a")?.textContent).toBe("x");
    expect(reactParagraphs[2]?.querySelector("strong > a")?.textContent).toBe("x");

    expect(htmlParagraphs[3]?.querySelectorAll("a > strong")).toHaveLength(2);
    expect(reactParagraphs[3]?.querySelectorAll("a > strong")).toHaveLength(2);
    expect(htmlParagraphs[3]?.querySelector("code")?.textContent).toBe("**code**");
    expect(reactParagraphs[3]?.querySelector("code")?.textContent).toBe("**code**");
    expect(htmlParagraphs[3]?.querySelector("code strong")).toBeNull();
    expect(reactParagraphs[3]?.querySelector("code strong")).toBeNull();

    expect(htmlParagraphs[4]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(reactParagraphs[4]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(htmlParagraphs[5]?.querySelector("strong > a")?.textContent).toBe("bold");
    expect(reactParagraphs[5]?.querySelector("strong > a")?.textContent).toBe("bold");

    expect(
      [...((htmlParagraphs[6]?.children ?? []) as HTMLCollection)].map((node) => node.localName),
    ).toEqual(["a", "strong"]);
    expect(
      [...((reactParagraphs[6]?.children ?? []) as HTMLCollection)].map((node) => node.localName),
    ).toEqual(["a", "strong"]);
    expect(htmlParagraphs[6]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(reactParagraphs[6]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(htmlParagraphs[6]?.children[1]?.textContent).toBe(" tail");
    expect(reactParagraphs[6]?.children[1]?.textContent).toBe(" tail");

    expect(
      [...((htmlParagraphs[7]?.children ?? []) as HTMLCollection)].map((node) => node.localName),
    ).toEqual(["strong", "a"]);
    expect(
      [...((reactParagraphs[7]?.children ?? []) as HTMLCollection)].map((node) => node.localName),
    ).toEqual(["strong", "a"]);
    expect(htmlParagraphs[7]?.querySelector("strong > a")?.textContent).toBe("bold");
    expect(reactParagraphs[7]?.querySelector("strong > a")?.textContent).toBe("bold");
    expect(htmlParagraphs[7]?.children[1]?.textContent).toBe(" tail");
    expect(reactParagraphs[7]?.children[1]?.textContent).toBe(" tail");

    expect(htmlParagraphs[8]?.querySelector("a > code")?.textContent).toBe("**code**");
    expect(reactParagraphs[8]?.querySelector("a > code")?.textContent).toBe("**code**");
    expect(htmlParagraphs[8]?.querySelector("code strong")).toBeNull();
    expect(reactParagraphs[8]?.querySelector("code strong")).toBeNull();

    expect(htmlParagraphs[9]?.querySelector("a")?.textContent).toBe("unfinished boldcode[A");
    expect(reactParagraphs[9]?.querySelector("a")?.textContent).toBe("unfinished boldcode[A");
    expect(htmlParagraphs[9]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(reactParagraphs[9]?.querySelector("a > strong")?.textContent).toBe("bold");
    expect(htmlParagraphs[9]?.querySelector("a > code")?.textContent).toBe("code");
    expect(reactParagraphs[9]?.querySelector("a > code")?.textContent).toBe("code");
    expect(htmlParagraphs[9]?.querySelector("a a")).toBeNull();
    expect(reactParagraphs[9]?.querySelector("a a")).toBeNull();
  });

  it("matches demo link punctuation around inline code in both HTML and React projections", async () => {
    const src = ["[x](`a b`)", "[x](`a)b`)", "[`a]b`](url)"].join("\n");
    const { htmlParagraphs, reactParagraphs } = await renderMarkdownProjections(src);

    expect(htmlParagraphs[0]?.textContent).toBe("[x](a b)");
    expect(reactParagraphs[0]?.textContent).toBe("[x](a b)");
    expect(htmlParagraphs[0]?.querySelector("a")).toBeNull();
    expect(reactParagraphs[0]?.querySelector("a")).toBeNull();
    expect(htmlParagraphs[0]?.querySelector("code")?.textContent).toBe("a b");
    expect(reactParagraphs[0]?.querySelector("code")?.textContent).toBe("a b");

    expect(htmlParagraphs[1]?.textContent).toBe("xb)");
    expect(reactParagraphs[1]?.textContent).toBe("xb)");
    expect(htmlParagraphs[1]?.querySelector("a")?.textContent).toBe("x");
    expect(reactParagraphs[1]?.querySelector("a")?.textContent).toBe("x");
    expect(htmlParagraphs[1]?.querySelector("code")).toBeNull();
    expect(reactParagraphs[1]?.querySelector("code")).toBeNull();

    expect(htmlParagraphs[2]?.textContent).toBe("[a]b](url)");
    expect(reactParagraphs[2]?.textContent).toBe("[a]b](url)");
    expect(htmlParagraphs[2]?.querySelector("a")).toBeNull();
    expect(reactParagraphs[2]?.querySelector("a")).toBeNull();
    expect(htmlParagraphs[2]?.querySelector("code")?.textContent).toBe("a]b");
    expect(reactParagraphs[2]?.querySelector("code")?.textContent).toBe("a]b");
  });
  it("leaves the URL unchanged for mouse and keyboard activation of href# Markdown links", async () => {
    const hrefBefore = window.location.href;
    const { container } = render(textPreview("readme.md", "[文档](https://evil.example/docs)"));
    await screen.findByRole("button", { name: "查看源码" });
    const body = container.querySelector("[data-markdown-body]");
    const link = body?.querySelector("a");
    if (!(link instanceof HTMLAnchorElement)) {
      throw new Error("expected a Markdown href# anchor");
    }

    expect(link.getAttribute("href")).toBe("#");
    expect(link.getAttribute("onclick")).toBeNull();
    expect(link.textContent).toBe("文档");
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent.keyDown(link, { key: " " });
    expect(window.location.href).toBe(hrefBefore);
    expect(window.location.href).not.toContain("evil.example");
  });

  it("matches mdRender HTML structure including href# anchors", async () => {
    const src = [
      "# 一级标题",
      "## 二级标题",
      "### 三级标题",
      "#### 四级标题",
      "",
      "一段 **加粗** 与 `行内代码` 以及 [文档](https://example.com/docs)。",
      "",
      "- 无序一项",
      "- 无序二项",
      "",
      "1. 有序一项",
      "2. 有序二项",
      "",
      "> 引用内容",
      "",
      "---",
      "",
      "| 列A | 列B |",
      "| --- | --- |",
      "| 甲 | 乙 |",
      "",
      "```ts",
      "const n = 1;",
      "```",
    ].join("\n");
    const { html, reactRoot } = await renderMarkdownProjections(src);

    expect([...reactRoot.children].map((node) => node.tagName)).toEqual(
      [...html.children].map((node) => node.tagName),
    );
    expect(reactRoot.textContent?.replace(/\s+/g, " ").trim()).toBe(
      html.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(html.querySelector("a")?.getAttribute("href")).toBe("#");
    expect(reactRoot.querySelector("a")?.getAttribute("href")).toBe("#");
    expect(reactRoot.querySelector("a")?.textContent).toBe("文档");
    expect(reactRoot.querySelector("button")?.textContent).not.toBe("文档");
  });
});

describe("PreviewPane image ownership", () => {
  it("renders the supplied image URL without allocating or revoking Blob URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:should-not-allocate");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const view = render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="logo.png"
        path="assets/logo.png"
        preview={{
          data: { kind: "image", size: 4096, truncated: false, url: "blob:preview-image-1" },
          status: "success",
        }}
        previewToken={{ status: "idle" }}
        size={4096}
        workspaceId="w1"
      />,
    );

    const image = await screen.findByRole("img", { name: "logo.png" });
    expect(image.getAttribute("src")).toBe("blob:preview-image-1");

    view.rerender(
      <PreviewPane
        mtime={FILE_MTIME}
        name="logo.png"
        path="assets/logo.png"
        preview={{
          data: { kind: "image", size: 4096, truncated: false, url: "blob:preview-image-2" },
          status: "success",
        }}
        previewToken={{ status: "idle" }}
        size={4096}
        workspaceId="w1"
      />,
    );
    expect(screen.getByRole("img", { name: "logo.png" }).getAttribute("src")).toBe(
      "blob:preview-image-2",
    );
    view.unmount();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("follows the payload when the same path turns from an image into text", async () => {
    const view = render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="logo.png"
        path="assets/logo.png"
        preview={{
          data: { kind: "image", size: 4096, truncated: false, url: "blob:preview-image-1" },
          status: "success",
        }}
        previewToken={{ status: "idle" }}
        size={4096}
        workspaceId="w1"
      />,
    );
    expect(await screen.findByRole("img", { name: "logo.png" })).toBeTruthy();

    view.rerender(textPreview("logo.png", "not an image", { path: "assets/logo.png" }));

    expect(await screen.findByRole("cell", { name: "not an image" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("blob:preview-image-1")).toBeNull();
  });
});

describe("PreviewPane unsupported error and truncation", () => {
  it("shows the unsupported copy while keeping metadata size", () => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="归档.zip"
        path="nested/归档.zip"
        preview={{ status: "unsupported" }}
        previewToken={{ status: "idle" }}
        size={91}
        workspaceId="w1"
      />,
    );

    expect(screen.getByText("该类型不支持预览")).toBeTruthy();
    expect(document.querySelector('[data-slot="empty-state-desc"]')?.textContent).toBe(
      "归档.zip · 91 B",
    );
    expect(screen.getByText(`91 B · ${FILE_MTIME_TEXT}`)).toBeTruthy();
  });

  it("keeps a markup-like unsupported file name as literal text", () => {
    const name = '<img src=x onerror="alert(1)">.zip';
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name={name}
        path={name}
        preview={{ status: "unsupported" }}
        previewToken={{ status: "idle" }}
        size={91}
        workspaceId="w1"
      />,
    );

    expect(screen.getByText("该类型不支持预览")).toBeTruthy();
    expect(document.querySelector('[data-slot="empty-state-desc"]')?.textContent).toBe(
      `${name} · 91 B`,
    );
    expect(document.querySelector("img")).toBeNull();
  });

  it("inlines the supplied error message and original size", () => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="secret.txt"
        path="out/secret.txt"
        preview={{ message: "路径不在沙箱内", status: "error" }}
        previewToken={{ status: "idle" }}
        size={91}
        workspaceId="w1"
      />,
    );

    expect(screen.getByText("路径不在沙箱内")).toBeTruthy();
    expect(screen.getByText(`91 B · ${FILE_MTIME_TEXT}`)).toBeTruthy();
  });

  it("shows a truncation banner with original total bytes rather than text length", () => {
    render(textPreview("notes.txt", "short", { originalSize: 12_345, size: 42, truncated: true }));

    expect(screen.getByText("文件超过预览上限，仅显示开头部分 · 共 12.1 KB")).toBeTruthy();
    expect(screen.getByText(`42 B · ${FILE_MTIME_TEXT}`)).toBeTruthy();
    expect(screen.queryByText("文件超过预览上限，仅显示开头部分 · 共 5 B")).toBeNull();
    expect(screen.queryByText("文件超过预览上限，仅显示开头部分 · 共 42 B")).toBeNull();
  });

  it("shows the too-large copy with the same name and size subline", () => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="huge.png"
        path="assets/huge.png"
        preview={{ status: "too-large" }}
        previewToken={{ status: "idle" }}
        size={22_020_096}
        workspaceId="w1"
      />,
    );

    expect(screen.getByText("文件过大，无法预览")).toBeTruthy();
    expect(document.querySelector('[data-slot="empty-state-desc"]')?.textContent).toBe(
      "huge.png · 21.0 MB",
    );
    expect(screen.queryByText("该类型不支持预览")).toBeNull();
    expect(screen.getByText(`21.0 MB · ${FILE_MTIME_TEXT}`)).toBeTruthy();
  });
});

// file-previewers「预览头、下载与不可预览的呈现」：下载链接在公共预览头里，哪一态都有。
describe("PreviewPane download link", () => {
  const STATES = [
    ["unsupported", "blob.bin", { status: "unsupported" }],
    ["too-large", "huge.png", { status: "too-large" }],
    ["error", "secret.txt", { message: "路径不在沙箱内", status: "error" }],
    [
      "success",
      "notes.txt",
      { data: { kind: "text", size: 5, text: "hello", truncated: false }, status: "success" },
    ],
  ] as const;

  it.each(STATES)("links to the download address in the %s state", (_state, name, preview) => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name={name}
        path={`out/${name}`}
        preview={preview}
        previewToken={{ status: "idle" }}
        size={91}
        workspaceId="w1"
      />,
    );

    const link = screen.getByRole("link", { name: `下载 ${name}` });
    expect(link.getAttribute("href")).toBe(`/api/workspaces/w1/download?path=out%2F${name}`);
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("download")).toBe("");
    expect(link.getAttribute("title")).toBe(`下载 ${name}`);
    expect(link.hasAttribute("target")).toBe(false);
    expect(link.closest('[data-slot="preview-header"]')).not.toBeNull();
  });

  // 路径是数据：首尾空格、`..` 段、开头的 `/`、合成与分解两种写法的字符都原样编码，不裁剪、不规范化。
  it.each([
    [" /docs/../\u00e9-e\u0301.txt ", "%20%2Fdocs%2F..%2F%C3%A9-e%CC%81.txt%20"],
    ["/ docs/../\u00e9-e\u0301.txt ", "%2F%20docs%2F..%2F%C3%A9-e%CC%81.txt%20"],
  ])("encodes the path %j whole without trimming or normalising it", (path, encoded) => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="e.txt"
        path={path}
        preview={{ status: "unsupported" }}
        previewToken={{ status: "idle" }}
        size={91}
        workspaceId="w1"
      />,
    );

    const href = screen.getByRole("link", { name: "下载 e.txt" }).getAttribute("href");
    expect(href).toBe(`/api/workspaces/w1/download?path=${encoded}`);
    expect(href).toBe(`/api/workspaces/w1/download?path=${encodeURIComponent(path)}`);
    expect(new URL(href ?? "", "http://localhost").searchParams.get("path")).toBe(path);
  });
});

describe("PreviewPane TSV", () => {
  it("shows a tab-separated file as a table split on tabs rather than as source", async () => {
    render(textPreview("t.tsv", "name\tsize\nalpha\t1\n"));

    expect(
      [...(await screen.findAllByRole("columnheader"))].map((node) => node.textContent),
    ).toEqual(["name", "size"]);
    expect(document.querySelector('[data-slot="preview-table"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="preview-code"]')).toBeNull();
    expect(screen.getAllByRole("cell").map((node) => node.textContent)).toEqual(["alpha", "1"]);
  });
});

describe("PreviewPane JSON", () => {
  it("pretty-prints valid JSON and keeps invalid JSON as original source", async () => {
    const valid = render(textPreview("data.json", '{"name":"alpha","count":2}'));
    await screen.findAllByRole("row");
    expect(
      within(valid.container.querySelector("table") as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent)
        .filter((_, index) => index % 2 === 1),
    ).toEqual(["{", '  "name": "alpha",', '  "count": 2', "}"]);

    valid.unmount();
    const invalidSource = "{not json";
    const invalid = render(textPreview("data.json", invalidSource));
    await screen.findAllByRole("row");
    expect(
      within(invalid.container.querySelector("table") as HTMLElement).getAllByRole("cell")[1]
        ?.textContent,
    ).toBe(invalidSource);
  });
});
