import { describe, expect, it } from "vitest";
import { mdRender, parseMarkdown } from "../src/features/files/md-render.js";

function renderMarkdown(src: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = mdRender(src);
  return root;
}

function maxStrongDepth(root: Element): number {
  let max = 0;
  const visit = (node: Element, depth: number) => {
    const next = node.tagName === "STRONG" ? depth + 1 : depth;
    if (next > max) {
      max = next;
    }
    for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
      visit(child, next);
    }
  };
  visit(root, 0);
  return max;
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
    expect(root.querySelector("p")?.textContent).toBe("click)");
    expect(root.innerHTML).not.toContain("javascript:");
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

describe("mdRender adjacent links", () => {
  it("keeps both labels and the comma between adjacent links", () => {
    expect(mdRender("[A](one),[B](two)")).toBe('<p><a href="#">A</a>,<a href="#">B</a></p>');
  });

  it("stops destinations at the first closing parenthesis", () => {
    expect(mdRender("[A](one) extra)")).toBe('<p><a href="#">A</a> extra)</p>');
  });
});

describe("mdRender demo bold and link-label precedence", () => {
  it("requires a nonempty bold span without an internal star or newline", () => {
    expect(mdRender("**a*b**")).toBe("<p>**a*b**</p>");
    expect(mdRender("****")).toBe("<p>****</p>");
    expect(mdRender("***a**")).toBe("<p>*<strong>a</strong></p>");
    expect(mdRender("** **")).toBe("<p><strong> </strong></p>");
  });

  it("preserves mixed and adjacent formatted link labels", () => {
    expect(mdRender("[**bold**](url)")).toBe('<p><a href="#"><strong>bold</strong></a></p>');
    expect(mdRender("[plain **bold** tail **again**](url)")).toBe(
      '<p><a href="#">plain <strong>bold</strong> tail <strong>again</strong></a></p>',
    );
    expect(mdRender("[**A**](one),[mid **B**](two)")).toBe(
      '<p><a href="#"><strong>A</strong></a>,<a href="#">mid <strong>B</strong></a></p>',
    );
    expect(mdRender("[**a*b**](url)")).toBe('<p><a href="#">**a*b**</a></p>');
  });

  it("nests valid links inside a surrounding bold span", () => {
    expect(mdRender("**[x](url)**")).toBe('<p><strong><a href="#">x</a></strong></p>');
  });

  it("projects bold-link crossings at both boundaries", () => {
    expect(mdRender("[**bold](url)**")).toBe('<p><a href="#"><strong>bold</strong></a></p>');
    expect(mdRender("**[bold**](url)")).toBe('<p><strong><a href="#">bold</a></strong></p>');
    expect(mdRender("[**bold](url) tail**")).toBe(
      '<p><a href="#"><strong>bold</strong></a><strong> tail</strong></p>',
    );
    expect(mdRender("**[bold** tail](url)")).toBe(
      '<p><strong><a href="#">bold</a></strong><a href="#"> tail</a></p>',
    );
  });

  it("keeps code markers literal beside formatted link labels", () => {
    expect(mdRender("[**A**](one)`**code**`[**B**](two)")).toBe(
      '<p><a href="#"><strong>A</strong></a><code>**code**</code><a href="#"><strong>B</strong></a></p>',
    );
    expect(mdRender("[**A**](one)`[**B**](two)")).toBe(
      '<p><a href="#"><strong>A</strong></a>`[**B**](two)</p>',
    );
    expect(mdRender("[`**code**`](url)")).toBe('<p><a href="#"><code>**code**</code></a></p>');
    expect(mdRender("[x `**code**` y](url)")).toBe(
      '<p><a href="#">x <code>**code**</code> y</a></p>',
    );
  });

  it("renders a bounded dense formatted label without an argument spread", () => {
    const label = "**a**".repeat(100_000);
    expect(mdRender(`[${label}](url)`)).toBe(
      `<p><a href="#">${"<strong>a</strong>".repeat(100_000)}</a></p>`,
    );
  });
});

describe("mdRender bounded inline scanning", () => {
  it("keeps all rejected link branches literal without suppressing bold", () => {
    expect(mdRender("[unfinished **bold**")).toBe("<p>[unfinished <strong>bold</strong></p>");
    expect(mdRender("[**bold**]")).toBe("<p>[<strong>bold</strong>]</p>");
    expect(mdRender("[x](**bold**")).toBe("<p>[x](<strong>bold</strong></p>");
    expect(mdRender("[](one) **bold**")).toBe("<p>[](one) <strong>bold</strong></p>");
    expect(mdRender("[x]() **bold**")).toBe("<p>[x]() <strong>bold</strong></p>");
  });

  it("rejects every JavaScript whitespace destination before later valid formatting", () => {
    for (const whitespace of ["\v", "\f", "\u00a0"]) {
      expect(mdRender(`[x](${whitespace})[A](one) **bold**`)).toBe(
        `<p>[x](${whitespace})<a href="#">A</a> <strong>bold</strong></p>`,
      );
    }
  });

  it("keeps later valid links and bold after rejected link syntax", () => {
    expect(mdRender("[broken] [A](one) **bold**")).toBe(
      '<p>[broken] <a href="#">A</a> <strong>bold</strong></p>',
    );
    expect(mdRender("[x]( [A](one) **bold**")).toBe(
      '<p>[x]( <a href="#">A</a> <strong>bold</strong></p>',
    );
  });

  it("preserves malformed-link formatting across headings, quotes, lists and table cells", () => {
    const root = renderMarkdown(
      [
        "# [unfinished **head**",
        "> [broken] [A](one) **quote**",
        "- [**item**]",
        "| value |",
        "| --- |",
        "| [x]( [B](two) **cell** |",
      ].join("\n"),
    );

    expect(root.querySelector("h1 strong")?.textContent).toBe("head");
    expect(root.querySelector("blockquote a")?.textContent).toBe("A");
    expect(root.querySelector("blockquote strong")?.textContent).toBe("quote");
    expect(root.querySelector("li strong")?.textContent).toBe("item");
    expect(root.querySelector("td a")?.textContent).toBe("B");
    expect(root.querySelector("td strong")?.textContent).toBe("cell");
  });

  it("keeps rejected links literal at bounded preview sizes", () => {
    for (const count of [50_000, 200_000, 1_048_573]) {
      const input = `${"[".repeat(count)}]()`;
      expect(mdRender(input)).toBe(`<p>${input}</p>`);
    }
    for (const count of [50_000, 200_000, 262_143]) {
      const input = `${"[x](".repeat(count)} )`;
      expect(mdRender(input)).toBe(`<p>${input}</p>`);
    }
  });

  it("keeps closer-free marker prefixes literal at bounded preview size", () => {
    const brackets = "[".repeat(1024 * 1024);
    const unfinishedLinks = "[x](".repeat(262_144);

    expect(mdRender(brackets)).toBe(`<p>${brackets}</p>`);
    expect(mdRender(unfinishedLinks)).toBe(`<p>${unfinishedLinks}</p>`);
  });

  it("renders dense strong runs through no-backtick, between-code and unclosed-tick paths", () => {
    const strongA = "**a**".repeat(200_000);
    const renderedA = "<strong>a</strong>".repeat(200_000);
    const left = "**a**".repeat(100_000);
    const right = "**b**".repeat(100_000);

    expect(mdRender(strongA)).toBe(`<p>${renderedA}</p>`);
    expect(mdRender(`${left}\`code\`${right}`)).toBe(
      `<p>${"<strong>a</strong>".repeat(100_000)}<code>code</code>${"<strong>b</strong>".repeat(100_000)}</p>`,
    );
    expect(mdRender(`${strongA}\`tail`)).toBe(`<p>${renderedA}\`tail</p>`);
  });

  it("keeps decorated siblings around closed and unclosed inline code", () => {
    expect(mdRender("[A](one)`code`[B](two)")).toBe(
      '<p><a href="#">A</a><code>code</code><a href="#">B</a></p>',
    );
    expect(mdRender("**a**`x`**b**")).toBe(
      "<p><strong>a</strong><code>x</code><strong>b</strong></p>",
    );
    expect(mdRender("[unfinished **bold**`code`[A](one)")).toBe(
      '<p><a href="#">unfinished <strong>bold</strong><code>code</code>[A</a></p>',
    );
    expect(mdRender("[unfinished **bold**`[A](one)")).toBe(
      "<p>[unfinished <strong>bold</strong>`[A](one)</p>",
    );
  });

  it("keeps rejected code-bearing link syntax literal at bounded sizes", () => {
    for (const count of [64, 50_000]) {
      const brackets = "[".repeat(count);
      expect(mdRender(`${brackets}\`x\`]()`)).toBe(`<p>${brackets}<code>x</code>]()</p>`);
    }
  });

  it("keeps demo link delimiters inside code visible to recognition", () => {
    expect(mdRender("[x](`a b`)")).toBe("<p>[x](<code>a b</code>)</p>");
    expect(mdRender("[x](`a)b`)")).toBe('<p><a href="#">x</a>b)</p>');
    expect(mdRender("[`a]b`](url)")).toBe("<p>[<code>a]b</code>](url)</p>");
  });
});

describe("mdRender reconstructed format depth", () => {
  const input = "[**x](u**)t";
  const unit = '<a href="#"><strong>x</strong></a><strong>t';

  function rendered(repeats: number): string {
    const extra = repeats > 64 ? '<a href="#">x</a>t'.repeat(repeats - 64) : "";
    const wrapped = Math.min(repeats, 64);
    return `<p>${unit.repeat(wrapped)}${extra}${"</strong>".repeat(wrapped)}</p>`;
  }

  it("preserves the demo's shallow nested reconstruction", () => {
    expect(mdRender(input.repeat(3))).toBe(rendered(3));
  });

  it("elides redundant strong wrappers after 64 reconstructed ancestors", () => {
    expect(mdRender(input.repeat(63))).toBe(rendered(63));
    expect(mdRender(input.repeat(64))).toBe(rendered(64));
    expect(mdRender(input.repeat(65))).toBe(rendered(65));
  });

  it("keeps text, links and mixed formatting after saturating strong depth", () => {
    const mixed = `${input.repeat(65)}[**bold](url) tail** **y** \`c\``;
    const html = mdRender(mixed);
    const root = renderMarkdown(mixed);
    const links = [...root.querySelectorAll("a")];

    expect(root.textContent).toBe(`${"xt".repeat(65)}bold tail y c`);
    expect(links).toHaveLength(66);
    expect(links.every((node) => node.getAttribute("href") === "#")).toBe(true);
    expect(links[64]?.textContent).toBe("x");
    expect(links[65]?.textContent).toBe("bold");
    expect(links[65]?.nextSibling?.textContent).toBe(" tail y ");
    expect(root.querySelector("code")?.textContent).toBe("c");
    expect(maxStrongDepth(root)).toBe(64);
    expect(html.endsWith(`${"</strong>".repeat(64)}</p>`)).toBe(true);
  });

  it("serializes 10k reconstructed units with bounded strong depth", () => {
    const html = mdRender(input.repeat(10_000));
    const root = renderMarkdown(input.repeat(10_000));
    expect(html).toBe(rendered(10_000));
    expect(root.textContent).toBe("xt".repeat(10_000));
    expect(root.querySelectorAll("a")).toHaveLength(10_000);
    expect([...root.querySelectorAll("a")].every((node) => node.getAttribute("href") === "#")).toBe(
      true,
    );
    expect(maxStrongDepth(root)).toBe(64);
  }, 15_000);

  it("serializes a near-1MiB reconstructed document without dropping links", () => {
    const html = mdRender(input.repeat(95_325));
    expect(html).toBe(rendered(95_325));
    expect(html.replace(/<[^>]+>/g, "")).toBe("xt".repeat(95_325));
    expect(html.match(/<a href="#">/g)).toHaveLength(95_325);
    expect(html.match(/<strong>/g)).toHaveLength(128);
  }, 60_000);
});
