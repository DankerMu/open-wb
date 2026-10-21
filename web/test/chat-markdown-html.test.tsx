// 助手正文里源 HTML 的渲染与消毒（epic-acceptance-followups design D1；chat-web「链接、图片与源 HTML 的渲染与
// 消毒」「流式期间的半截 HTML 不留痕」与「图片」规则的加载失败一句）。jsdom 不加载图片与外链样式，所以「不发
// 请求」由「没有 `img` 元素 / 没有 `style` 属性」与精确的属性取值来证明。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage, mountAssistantReply, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

const BODY = '[data-slot="message-body"]';
/** 链接规则写出的固定样式类（与拷入层 markdown-text 自带的 `a` 相同）。 */
const LINK_CLASS = "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2";

/**
 * 规格场景「链接、图片与源 HTML 的渲染与消毒」的正文（`\\75` 是 CSS 转义的字面反斜杠），比场景少两组（其余逐字、
 * 同序）：`集` 之后的 `注`、`配` 两个 `span`——其跨声明注释的 style 写法测在本文件「白名单之外的元素与 style 的外连
 * 写法」；以及 `[r](https:evil) ![i](https:t.png) <img src="https:/t.example/x.png">` 三个协议后不带 `//` 的目标——
 * 测在 chat-markdown.test.tsx「协议后必须是 //」。
 */
const SANITIZE = [
  [
    "[官网](https://example.com/a)",
    "[脚本](javascript:alert(1))",
    "[数据](data:text/html,x)",
    "[相对](docs/a.md)",
    "[邮件](mailto:a@example.com)",
    "![示意图](https://img.example.com/a.png)",
    "![](data:image/png;base64,AAAA)",
    '<a href="https://evil.example" onclick="alert(1)" class="x" id="y" name="n" target="_self">x</a>',
    '<span style="color:#c0392b">红</span>',
    '<span style="background:url(https://t.example/p.png)">底</span>',
    '<span style="background:\\75 rl(https://t.example/q.png)">转</span>',
    "<span style=\"background-image:image-set('https://t.example/r.png' 1x)\">集</span>",
    "<script>window.__pwned = 1</script>",
    "<style>body{display:none}</style>",
    '<iframe src="https://evil.example/frame"></iframe>',
    '<img src="https://img.example.com/c.png" onerror="alert(1)">',
    "<details><summary>折叠</summary>内容</details>",
    "<table><tr><td>格</td></tr></table>",
    '<input type="text" value="v">',
    "Use /todo append <task> to start one.",
    '<font color="red">彩</font>',
  ].join(" "),
  "",
  "- [x] 做完",
].join("\n");

afterEach(() => {
  cleanupChatPage();
});

function linkNamed(article: HTMLElement, name: string) {
  return within(article).getByRole("link", { name }) as HTMLAnchorElement;
}

function spanWithText(body: Element, text: string) {
  const span = [...body.querySelectorAll("span")].find((node) => node.textContent === text);
  if (!span) throw new Error(`没有文本为 ${text} 的 span`);
  return span;
}

describe("链接、图片与源 HTML 的渲染与消毒", () => {
  it("http(s) 与 mailto 链接是新标签页打开的 a；源 HTML 的事件、class、name、id、target 都不留下", async () => {
    const { article, body } = await mountAssistantReply(SANITIZE);

    expect(body.querySelectorAll("a")).toHaveLength(3);
    const expected = [
      ["官网", "https://example.com/a"],
      ["x", "https://evil.example"],
      ["邮件", "mailto:a@example.com"],
    ] as const;
    for (const [name, href] of expected) {
      const link = linkNamed(article, name);
      expect(link.getAttribute("href"), name).toBe(href);
      expect(link.getAttribute("target"), name).toBe("_blank");
      expect(link.relList.contains("noopener"), name).toBe(true);
      expect(link.relList.contains("noreferrer"), name).toBe(true);
      expect(link.getAttribute("class"), name).toBe(LINK_CLASS);
    }
    const evil = linkNamed(article, "x");
    expect(evil.getAttributeNames().sort()).toEqual(["class", "href", "rel", "target"]);
    expect(evil.classList.contains("x")).toBe(false);
    expect(body.querySelector("[id], [name], [onclick]")).toBeNull();
    for (const text of ["脚本", "数据", "相对"]) {
      expect(body.textContent).toContain(text);
      expect(within(article).queryByRole("link", { name: text }), text).toBeNull();
    }
    for (const target of ["javascript:", "alert(1)", "data:text", "docs/a.md", "user-content-"]) {
      expect(article.innerHTML, target).not.toContain(target);
    }
  });

  it("http(s) 图片渲染为懒加载、不带 referrer 的 img；data: 图片原位显示地址", async () => {
    const { body } = await mountAssistantReply(SANITIZE);

    const images = [...body.querySelectorAll("img")];
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      "https://img.example.com/a.png",
      "https://img.example.com/c.png",
    ]);
    for (const img of images) {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(img.hasAttribute("onerror")).toBe(false);
    }
    expect(images[0]?.getAttribute("alt")).toBe("示意图");
    expect(body.textContent).toContain("data:image/png;base64,AAAA");
  });

  it("style 保留普通声明；url( / CSS 转义 / image-set( 三种外连写法整个 style 属性丢弃", async () => {
    const { body } = await mountAssistantReply(SANITIZE);

    expect(spanWithText(body, "红").style.color).toBe("rgb(192, 57, 43)");
    for (const text of ["底", "转", "集"]) {
      expect(spanWithText(body, text).hasAttribute("style"), text).toBe(false);
    }
    expect(body.innerHTML).not.toContain("t.example");
  });

  it("script / style / iframe 连内容去掉、不执行；标签字样与 CSS 文本不出现", async () => {
    const { body } = await mountAssistantReply(SANITIZE);

    for (const tag of ["script", "style", "iframe"]) {
      expect(document.querySelector(tag), tag).toBeNull();
    }
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.body.style.display).toBe("");
    for (const leaked of ["<script>", "<style>", "<iframe", "body{display:none}", "__pwned"]) {
      expect(document.body.textContent, leaked).not.toContain(leaked);
    }
    expect(body.innerHTML).not.toContain("evil.example/frame");
  });

  it("details / table 成元素；非 checkbox 的 input 去掉，任务列表的 checkbox 保留为禁用", async () => {
    const { body } = await mountAssistantReply(SANITIZE);

    expect(body.querySelectorAll("details")).toHaveLength(1);
    expect(body.querySelector("details > summary")?.textContent).toBe("折叠");
    expect(body.querySelector("table td")?.textContent).toBe("格");
    expect(body.querySelector('input[type="text"]')).toBeNull();
    expect(body.querySelectorAll("input")).toHaveLength(1);
    const task = body.querySelector<HTMLInputElement>('input[type="checkbox"][disabled]');
    expect(task?.checked).toBe(true);
    expect(body.querySelector('input[type="checkbox"][disabled][checked]')).not.toBeNull();
    expect(task?.closest("li")?.classList.contains("task-list-item")).toBe(true);
    expect(task?.closest("ul")?.classList.contains("contains-task-list")).toBe(true);
    expect(body.innerHTML).not.toContain('value="v"');
  });

  it("白名单外的 <task> 与 <font …> 按源文本原样显示，不生成元素", async () => {
    const { body } = await mountAssistantReply(SANITIZE);

    expect(body.textContent).toContain("Use /todo append <task> to start one.");
    expect(body.textContent).toContain('<font color="red">彩</font>');
    expect(body.querySelector("task, font")).toBeNull();
  });
});

describe("白名单之外的元素与 style 的外连写法", () => {
  it("七个资源函数在大小写、空白、注释与 CSS 转义的各种写法下都让 style 整个丢弃", async () => {
    const styles = [
      "background:-webkit-image-set(url(a.png) 1x)",
      "background:cross-fade(url(a.png),url(b.png),50%)",
      "background:image('a.png')",
      "background:src('a.png')",
      "width:expression(alert(1))",
      "background:URL ( 'a.png' )",
      "background:u/**/rl(a.png)",
      "background:\\000075rl(a.png)",
      "background:\\55\\52\\4c (a.png)",
      "content:'/*'; background:url(https://t.example/s.png) /* '*/",
      "content:'/*';background:u/**/rl(https://t.example/q.png)",
      "color:red/*;background:u/**/rl(https://t.example/p.png)",
    ];
    const html = styles.map((style, i) => `<span style="${style}">s${i}</span>`).join(" ");
    const { body } = await mountAssistantReply(
      `${html} <span style="display:inline-block;width:2em">留</span>`,
    );

    for (const [index, style] of styles.entries()) {
      expect(spanWithText(body, `s${index}`).hasAttribute("style"), style).toBe(false);
    }
    expect(spanWithText(body, "留").style.width).toBe("2em");
  });

  it("/todo 回复里的占位符 <task> 原样可见", async () => {
    const { body } = await mountAssistantReply("No todos. Use /todo append <task> to start one.");

    expect(body.textContent).toBe("No todos. Use /todo append <task> to start one.");
    expect(body.querySelector("task")).toBeNull();
  });

  it("段尾未闭合、没有内容的占位符同样原样可见", async () => {
    const { body } = await mountAssistantReply("usage: cmd <file>");

    expect(body.textContent).toBe("usage: cmd <file>");
  });

  it("form / button / select / svg / video / font 按原文显示为文字；noscript / textarea / object 连内容去掉", async () => {
    const literal = [
      '<form action="https://f.example"><button formaction="https://g.example">按钮</button></form>',
      "<select><option>选项</option></select>",
      "<svg><text>矢量</text></svg>",
      '<video src="https://v.example/a.mp4">视频</video>',
      '<font color="red">彩</font>',
    ];
    const gone = [
      "<noscript>无脚本</noscript>",
      "<textarea>文本框</textarea>",
      '<object data="https://o.example">对象</object>',
    ];
    const { body } = await mountAssistantReply([...literal, ...gone].join(" "));

    for (const fragment of literal) expect(body.textContent).toContain(fragment);
    for (const tag of [
      "form",
      "button",
      "select",
      "option",
      "svg",
      "video",
      "font",
      "noscript",
      "textarea",
      "object",
    ]) {
      expect(body.querySelector(tag), tag).toBeNull();
    }
    expect(body.querySelector("[action], [formaction], [src], [data], [color]")).toBeNull();
    for (const text of ["无脚本", "文本框", "对象", "o.example"])
      expect(body.textContent).not.toContain(text);
  });

  it("GFM 脚注的 section 不是源 HTML 写出的：去壳留文字，不显示标签字样", async () => {
    const { body } = await mountAssistantReply("脚注[^1]\n\n[^1]: 注");

    expect(body.querySelector("section")).toBeNull();
    expect(body.textContent).toContain("注");
    expect(body.textContent).not.toContain("<section");
    expect(body.textContent).not.toContain("</");
  });
});

describe("图片加载失败", () => {
  it("由浏览器显示 alt：页面不弹提示，src 不变（不重试）", async () => {
    const { article, body } = await mountAssistantReply("![示意图](https://img.example.com/a.png)");
    const img = body.querySelector("img");
    if (!img) throw new Error("没有渲染出 img");

    fireEvent.error(img);
    await settle();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(article).queryByRole("alert")).toBeNull();
    expect(body.querySelector("img")).toBe(img);
    expect(img.getAttribute("src")).toBe("https://img.example.com/a.png");
    expect(img.getAttribute("alt")).toBe("示意图");
  });
});

describe("流式期间的半截 HTML 不留痕", () => {
  const DELTAS = ["<b>粗", "</b>\n\n<details><summary>折", "叠</summary>内容</details>"];
  const FULL = DELTAS.join("");

  it("半截标签按容错解析，终态恰有一个 b 与一个 details，且与一次性渲染相同", async () => {
    const rejections = observeUnhandledRejections();
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    try {
      const snapshot = chatSnapshot({ assistantStatus: "running", cursor: { epoch: 1, seq: 3 } });
      renderChatPage(`/?session=${SESSION_ID}`, {
        "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
        [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(snapshot),
      });
      const article = await screen.findByRole("article", { name: "助手" });
      await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
      const source = latestSource();
      await act(async () => {
        source.emitOpen();
        await settle();
      });
      for (const [index, delta] of DELTAS.entries()) {
        await act(async () => {
          source.emitData("text.delta", `1:${index + 4}`, { messageId: 0, delta });
          await settle();
        });
      }
      await act(async () => {
        source.emitData("turn.end", "1:7", { messageId: 0, status: "done" });
        await settle();
      });

      const body = () => article.querySelector(BODY);
      await waitFor(() =>
        expect(body()?.querySelector("details > summary")?.textContent).toBe("折叠"),
      );
      const streamed = body();
      if (!streamed) throw new Error("助手消息缺少正文");
      expect(streamed.querySelectorAll("b")).toHaveLength(1);
      expect(streamed.querySelector("b")?.textContent).toBe("粗");
      expect(streamed.querySelectorAll("details")).toHaveLength(1);
      for (const leaked of ["<b>", "</b>", "<details", "<summary"]) {
        expect(streamed.textContent, leaked).not.toContain(leaked);
      }
      const streamedHtml = streamed.innerHTML;

      cleanupChatPage();
      const once = await mountAssistantReply(FULL);
      expect(streamedHtml).toBe(once.body.innerHTML);
      await settle();
      expect(rejections.unhandled).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      rejections.stop();
      window.removeEventListener("error", onError);
    }
  });
});
