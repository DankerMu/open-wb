import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mdRender } from "../src/features/files/md-render.js";
import { CodeView, CsvTable, PreviewPane } from "../src/features/files/preview.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILE_MTIME = 1_726_000_000_000;
const FILE_MTIME_ISO = new Date(FILE_MTIME).toISOString();

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
      size={metadataSize}
    />
  );
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
    expect(screen.getByText(`42 B · ${FILE_MTIME_ISO}`)).toBeTruthy();
  });
});

describe("PreviewPane CSV routing", () => {
  it("routes a successful CSV preview through CsvTable", () => {
    render(textPreview("notes.csv", "name,size\nalpha,1\nbeta,2\n"));

    expect([...screen.getAllByRole("columnheader")].map((node) => node.textContent)).toEqual([
      "name",
      "size",
    ]);
    expect(screen.getByText("共 2 行 · 大文件仅预览前若干行")).toBeTruthy();
  });
});

describe("PreviewPane Markdown", () => {
  it("defaults to rendered Markdown and resets after changing file identity", () => {
    const view = render(textPreview("readme.md", "# 第一份"));

    expect(screen.getByRole("heading", { level: 1, name: "第一份" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(screen.queryByRole("heading", { level: 1, name: "第一份" })).toBeNull();
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(
      within(screen.getAllByRole("row")[0] as HTMLElement).getAllByRole("cell")[1]?.textContent,
    ).toBe("# 第一份");

    view.rerender(textPreview("notes.md", "# 第二份", { path: "notes.md" }));

    expect(screen.getByRole("heading", { level: 1, name: "第二份" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看源码" })).toBeTruthy();
  });

  it("leaves the URL unchanged for mouse and keyboard activation of inert Markdown link buttons", () => {
    const hrefBefore = window.location.href;
    const { container } = render(textPreview("readme.md", "[文档](https://evil.example/docs)"));
    const body = container.querySelector("[data-markdown-body]");
    const label = body?.querySelector("button");
    if (!(label instanceof HTMLButtonElement)) {
      throw new Error("expected an inert Markdown link button");
    }

    expect(label.type).toBe("button");
    expect(label.textContent).toBe("文档");
    expect(container.querySelector("a")).toBeNull();
    fireEvent.click(label);
    fireEvent.keyDown(label, { key: "Enter" });
    fireEvent.keyDown(label, { key: " " });
    expect(window.location.href).toBe(hrefBefore);
    expect(window.location.href).not.toContain("evil.example");
  });

  it("matches mdRender HTML structure except inert React buttons for serialized anchors", () => {
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
    const html = document.createElement("div");
    html.innerHTML = mdRender(src);
    const { container } = render(textPreview("readme.md", src));
    const reactRoot = container.querySelector("[data-markdown-body]");
    if (!(reactRoot instanceof HTMLElement)) {
      throw new Error("expected React Markdown body");
    }

    expect([...reactRoot.children].map((node) => node.tagName)).toEqual(
      [...html.children].map((node) => node.tagName),
    );
    expect(reactRoot.textContent?.replace(/\s+/g, " ").trim()).toBe(
      html.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(html.querySelector("a")?.getAttribute("href")).toBe("#");
    expect(html.querySelector("a")?.textContent).toBe("文档");
    expect(reactRoot.querySelector("a")).toBeNull();
    expect(
      [...reactRoot.querySelectorAll("button")].some(
        (button) => button.type === "button" && button.textContent === "文档",
      ),
    ).toBe(true);
  });
});

describe("PreviewPane image ownership", () => {
  it("renders the supplied image URL without allocating or revoking Blob URLs", () => {
    const createObjectURL = vi.fn(() => "blob:should-not-allocate");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const view = render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="logo.png"
        path="assets/logo.png"
        preview={{
          data: { kind: "image", size: 4096, truncated: false, url: "blob:preview-image-1" },
          status: "success",
        }}
        size={4096}
      />,
    );

    const image = screen.getByRole("img", { name: "logo.png" });
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
        size={4096}
      />,
    );
    expect(screen.getByRole("img", { name: "logo.png" }).getAttribute("src")).toBe(
      "blob:preview-image-2",
    );
    view.unmount();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe("PreviewPane unsupported error and truncation", () => {
  it("shows the unsupported copy while keeping metadata size", () => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="归档.zip"
        path="归档.zip"
        preview={{ status: "unsupported" }}
        size={91}
      />,
    );

    expect(screen.getByText("该类型不支持预览")).toBeTruthy();
    expect(screen.queryByText("二进制或未识别格式")).toBeNull();
    expect(screen.getByText(`91 B · ${FILE_MTIME_ISO}`)).toBeTruthy();
  });

  it("keeps a supplied unsupported message as literal text", () => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="归档.zip"
        path="归档.zip"
        preview={{ message: '<img src=x onerror="alert(1)">', status: "unsupported" }}
        size={91}
      />,
    );

    expect(screen.getByText("该类型不支持预览")).toBeTruthy();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("inlines the supplied error message and original size", () => {
    render(
      <PreviewPane
        mtime={FILE_MTIME}
        name="secret.txt"
        path="out/secret.txt"
        preview={{ message: "路径不在沙箱内", status: "error" }}
        size={91}
      />,
    );

    expect(screen.getByText("路径不在沙箱内")).toBeTruthy();
    expect(screen.getByText(`91 B · ${FILE_MTIME_ISO}`)).toBeTruthy();
  });

  it("shows a truncation banner with original total bytes rather than text length", () => {
    render(textPreview("notes.txt", "short", { originalSize: 12_345, size: 42, truncated: true }));

    expect(screen.getByText("预览已截断（原始大小 12345 B）")).toBeTruthy();
    expect(screen.getByText(`42 B · ${FILE_MTIME_ISO}`)).toBeTruthy();
    expect(screen.queryByText("预览已截断（原始大小 5 B）")).toBeNull();
    expect(screen.queryByText("预览已截断（原始大小 12 KB）")).toBeNull();
  });
});

describe("PreviewPane JSON", () => {
  it("pretty-prints valid JSON and keeps invalid JSON as original source", () => {
    const valid = render(textPreview("data.json", '{"name":"alpha","count":2}'));
    expect(
      within(valid.container.querySelector("table") as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent)
        .filter((_, index) => index % 2 === 1),
    ).toEqual(["{", '  "name": "alpha",', '  "count": 2', "}"]);

    valid.unmount();
    const invalidSource = "{not json";
    const invalid = render(textPreview("data.json", invalidSource));
    expect(
      within(invalid.container.querySelector("table") as HTMLElement).getAllByRole("cell")[1]
        ?.textContent,
    ).toBe(invalidSource);
  });
});
