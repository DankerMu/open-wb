import { describe, expect, it } from "vitest";
import { mdRender, parseMarkdown } from "../src/features/files/md-render.js";

function renderMarkdown(src: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = mdRender(src);
  return root;
}

describe("mdRender headings", () => {
  it("renders an ATX heading as a real heading element", () => {
    const root = renderMarkdown("# 文档标题");
    const heading = root.querySelector("h1");

    expect(heading).not.toBeNull();
    expect(heading?.tagName).toBe("H1");
    expect(heading?.textContent).toBe("文档标题");
  });
});

describe("mdRender supported subset", () => {
  it("renders headings, lists, rules, quotes, tables, code and inert links", () => {
    const root = renderMarkdown(
      [
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
      ].join("\n"),
    );

    expect([...root.children].map((node) => node.tagName)).toEqual([
      "H1",
      "H2",
      "H3",
      "H4",
      "P",
      "UL",
      "OL",
      "BLOCKQUOTE",
      "HR",
      "TABLE",
      "PRE",
    ]);
    expect(root.querySelector("h1")?.textContent).toBe("一级标题");
    expect(root.querySelector("h2")?.textContent).toBe("二级标题");
    expect(root.querySelector("h3")?.textContent).toBe("三级标题");
    expect(root.querySelector("h4")?.textContent).toBe("四级标题");
    expect(root.querySelector("p strong")?.textContent).toBe("加粗");
    expect(root.querySelector("p code")?.textContent).toBe("行内代码");
    const link = root.querySelector("p a");
    expect(link?.textContent).toBe("文档");
    expect(link?.getAttribute("href")).toBe("#");
    expect(link?.getAttribute("onclick")).toBeNull();
    expect([...root.querySelectorAll("ul li")].map((node) => node.textContent)).toEqual([
      "无序一项",
      "无序二项",
    ]);
    expect([...root.querySelectorAll("ol li")].map((node) => node.textContent)).toEqual([
      "有序一项",
      "有序二项",
    ]);
    expect(root.querySelector("blockquote")?.textContent).toBe("引用内容");
    expect([...root.querySelectorAll("th")].map((node) => node.textContent)).toEqual([
      "列A",
      "列B",
    ]);
    expect([...root.querySelectorAll("td")].map((node) => node.textContent)).toEqual(["甲", "乙"]);
    expect(root.querySelector("pre code")?.textContent).toBe("const n = 1;");
    expect(root.innerHTML).toMatchInlineSnapshot(
      `"<h1>一级标题</h1><h2>二级标题</h2><h3>三级标题</h3><h4>四级标题</h4><p>一段 <strong>加粗</strong> 与 <code>行内代码</code> 以及 <a href="#">文档</a>。</p><ul><li>无序一项</li><li>无序二项</li></ul><ol><li>有序一项</li><li>有序二项</li></ol><blockquote>引用内容</blockquote><hr><table><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table><pre><code>const n = 1;</code></pre>"`,
    );
  });
});

function eventAttributeNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll("*")].flatMap((node) =>
    [...node.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("on")),
  );
}

describe("mdRender input safety", () => {
  it("keeps a script tag as literal paragraph text", () => {
    const root = renderMarkdown("<script>alert(1)</script>");

    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe("<script>alert(1)</script>");
  });

  it("renders a javascript destination as an inert hash link", () => {
    const root = renderMarkdown("[click](javascript:alert(1))");
    const link = root.querySelector("a");

    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("#");
    expect(link?.getAttributeNames()).toEqual(["href"]);
    expect(link?.textContent).toBe("click");
    expect(root.querySelector("p")?.textContent).toBe("click");
  });

  it("keeps an onerror attribute injection as literal text", () => {
    const root = renderMarkdown('<img src=x onerror="alert(1)">');

    expect(root.querySelector("img")).toBeNull();
    expect(eventAttributeNames(root)).toEqual([]);
    expect(root.querySelector("p")?.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("keeps Markdown markers and injection strings literal inside code", () => {
    const closedFence = renderMarkdown(
      ["```", "**not-bold** [link](javascript:alert(1)) <script>alert(1)</script>", "```"].join(
        "\n",
      ),
    );
    const unclosedFence = renderMarkdown(
      ["```", "still `inline` and **stars**", "trailing"].join("\n"),
    );
    const inlineCode = renderMarkdown("before `**stars** [x](javascript:alert(1))` after");
    const unclosedInline = renderMarkdown("before `**unclosed** after");

    expect(closedFence.querySelector("pre code")?.textContent).toBe(
      "**not-bold** [link](javascript:alert(1)) <script>alert(1)</script>",
    );
    expect(closedFence.querySelector("strong")).toBeNull();
    expect(closedFence.querySelector("a")).toBeNull();
    expect(closedFence.querySelector("script")).toBeNull();
    expect(unclosedFence.querySelector("pre code")?.textContent).toBe(
      "still `inline` and **stars**\ntrailing",
    );
    expect(unclosedFence.querySelector("code code")).toBeNull();
    expect(unclosedFence.querySelector("strong")).toBeNull();
    expect(inlineCode.querySelector("p code")?.textContent).toBe(
      "**stars** [x](javascript:alert(1))",
    );
    expect(inlineCode.querySelector("p strong")).toBeNull();
    expect(inlineCode.querySelector("p a")).toBeNull();
    expect(unclosedInline.querySelector("code")).toBeNull();
    expect(unclosedInline.querySelector("p")?.textContent).toBe("before `**unclosed** after");
    expect(unclosedInline.querySelector("strong")).toBeNull();
  });
});

describe("parseMarkdown node identity", () => {
  it("assigns distinct source identities to duplicate list items", () => {
    const [list] = parseMarkdown("- same\n- same");
    if (list?.type !== "list") {
      throw new Error("expected a list");
    }
    expect(list.items.map((item) => item.source)).toEqual([0, 7]);
  });
});
