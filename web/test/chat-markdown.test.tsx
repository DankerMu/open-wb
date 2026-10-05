// 助手正文的 Markdown 规则（design D5；chat-web「Markdown 链接惰性与图片不加载」「代码块复制失败就地提示」）。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { jsonResponse, paths } from "./support.js";

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const BODY = '[data-slot="message-body"]';

const LINKS_AND_IMAGES = [
  "[官网](https://example.com/a)",
  "[明文](http://plain.example/b)",
  "[脚本](javascript:alert(1))",
  "[数据](data:text/html,x)",
  "[相对](docs/a.md)",
  "![示意图](https://img.example.com/a.png)",
  "![](https://img.example.com/b.png)",
  '<a href="https://evil.example">x</a>',
].join(" ");
const RAW_HTML = [
  "<script>window.__pwned = 1</script>",
  "",
  '段落 <img src="https://img.example.com/c.png" onerror="alert(1)"> <b>粗</b>',
  "",
  '<iframe src="https://evil.example/frame"></iframe>',
].join("\n");
const CODE = 'const a = "<b>";\nconsole.log(a);\n';
const WITH_CODE = `看代码：\n\n\`\`\`ts\n${CODE}\`\`\`\n\n完。`;

afterEach(() => {
  cleanupChatPage();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

async function mountReply(content: string) {
  const snapshot = chatSnapshot({
    status: "done",
    assistantStatus: "done",
    content,
    cursor: { epoch: 1, seq: null },
  });
  const mounted = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [messagesPath]: () => jsonResponse(snapshot),
  });
  const article = await screen.findByRole("article", { name: "助手" });
  const body = article.querySelector(BODY);
  if (!body) throw new Error("助手消息缺少正文");
  return { article, body, fetchMock: mounted.fetchMock };
}

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("Markdown 链接惰性与图片不加载", () => {
  it("任何目标的链接都只留可见文字：没有 a 元素，目标地址不出现在文本与属性里", async () => {
    const { article, body } = await mountReply(LINKS_AND_IMAGES);

    for (const text of ["官网", "明文", "脚本", "数据", "相对"]) {
      expect(body.textContent).toContain(text);
    }
    expect(body.querySelector("a")).toBeNull();
    expect(within(article).queryByRole("link")).toBeNull();
    const html = article.innerHTML;
    for (const target of [
      "example.com/a",
      "plain.example",
      "javascript:",
      "alert(1)",
      "data:text",
      "docs/a.md",
    ]) {
      expect(html, target).not.toContain(target);
    }
    for (const attribute of ["href", "src", "srcset"]) {
      expect(body.querySelector(`[${attribute}]`), attribute).toBeNull();
    }
  });

  it("图片不生成 img、不发请求：原位显示 alt，没有 alt 时显示地址", async () => {
    const { body, fetchMock } = await mountReply(LINKS_AND_IMAGES);

    expect(document.querySelector("img")).toBeNull();
    expect(body.textContent).toContain("示意图");
    expect(body.textContent).toContain("https://img.example.com/b.png");
    expect(body.textContent).not.toContain("a.png");
    expect(paths(fetchMock).filter((path) => path.includes("img.example.com"))).toEqual([]);
  });

  it("源 HTML 的 a 标签作为文本出现，不生成链接元素", async () => {
    const { body } = await mountReply(LINKS_AND_IMAGES);

    expect(body.textContent).toContain('<a href="https://evil.example">x</a>');
    expect(body.querySelector("a")).toBeNull();
  });

  it("源 HTML 的 script / img / iframe / b 都不生成元素，按文本出现", async () => {
    const { body } = await mountReply(RAW_HTML);

    for (const tag of ["script", "img", "iframe", "b"]) {
      expect(body.querySelector(tag), tag).toBeNull();
    }
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(body.textContent).toContain("<script>window.__pwned = 1</script>");
    expect(body.textContent).toContain(
      '<img src="https://img.example.com/c.png" onerror="alert(1)">',
    );
    expect(body.textContent).toContain('<iframe src="https://evil.example/frame"></iframe>');
    expect(body.textContent).toContain("<b>粗</b>");
    expect(body.querySelector("[onerror]")).toBeNull();
  });
});

describe("代码块复制", () => {
  function copyButton(article: HTMLElement) {
    return within(article).getByRole("button", { name: "复制代码" });
  }
  const failed = (article: HTMLElement) => within(article).queryByRole("alert");

  it("代码块按原文渲染、不做高亮，带一个复制按钮；消息级 复制 仍是另一个按钮", async () => {
    const { article, body } = await mountReply(WITH_CODE);

    expect(body.querySelector("pre > code")?.textContent).toBe(CODE);
    expect(body.querySelector("pre > code")?.children).toHaveLength(0);
    expect(within(article).getAllByRole("button", { name: "复制代码" })).toHaveLength(1);
    expect(copyButton(article).getAttribute("type")).toBe("button");
    expect(within(article).getByRole("button", { name: "复制" })).not.toBe(copyButton(article));
  });

  it("成功只换图标、不弹提示；reject 时按钮旁就地显示 复制失败；再次成功后消失", async () => {
    const rejections = observeUnhandledRejections();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { article } = await mountReply(WITH_CODE);
    const button = copyButton(article);
    expect(button.querySelector("svg.lucide-copy")).not.toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(button.querySelector("svg.lucide-check")).not.toBeNull());
    expect(writeText.mock.calls).toEqual([[CODE]]);
    expect(failed(article)).toBeNull();
    expect(within(screen.getByRole("region", { name: "通知" })).queryByRole("status")).toBeNull();
    expect(screen.queryByText("已复制到剪贴板")).toBeNull();

    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(button);
    const alert = await within(article).findByRole("alert");
    expect(alert.textContent).toBe("复制失败");
    expect(alert.parentElement).toBe(button.parentElement);
    expect(button.querySelector("svg.lucide-copy")).not.toBeNull();
    expect(screen.queryByText("已复制到剪贴板")).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(failed(article)).toBeNull());
    await waitFor(() => expect(button.querySelector("svg.lucide-check")).not.toBeNull());
    expect(writeText).toHaveBeenCalledTimes(3);
    await settle();
    rejections.stop();
    expect(rejections.unhandled).toEqual([]);
  });

  it("剪贴板 API 不存在或同步抛错时同样就地显示 复制失败，异常不外泄", async () => {
    const rejections = observeUnhandledRejections();
    const { article } = await mountReply(WITH_CODE);
    const button = copyButton(article);

    fireEvent.click(button);
    expect((await within(article).findByRole("alert")).textContent).toBe("复制失败");

    const blocked = vi.fn<(text: string) => Promise<void>>(() => {
      throw new Error("blocked");
    });
    mockClipboard(blocked);
    fireEvent.click(button);
    await waitFor(() => expect(blocked).toHaveBeenCalledTimes(1));
    expect(failed(article)?.textContent).toBe("复制失败");
    expect(button.querySelector("svg.lucide-copy")).not.toBeNull();
    await settle();
    rejections.stop();
    expect(rejections.unhandled).toEqual([]);
  });

  it("对勾约 2 秒后恢复为复制图标", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockClipboard(vi.fn().mockResolvedValue(undefined));
      const { article } = await mountReply(WITH_CODE);
      const button = copyButton(article);

      fireEvent.click(button);
      await waitFor(() => expect(button.querySelector("svg.lucide-check")).not.toBeNull());
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(button.querySelector("svg.lucide-copy")).not.toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("流式正文不落后于数据", () => {
  it("增量一到就整段可见：不等逐字显现", async () => {
    const delta = "后续的一整段增量文字，长度足以让逐字显现跨过好几帧。";
    const snapshot = chatSnapshot({
      content: "开头。",
      assistantStatus: "running",
      cursor: { epoch: 1, seq: 3 },
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [messagesPath]: () => jsonResponse(snapshot),
    });
    const article = await screen.findByRole("article", { name: "助手" });
    await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
    const source = latestSource();

    await act(async () => {
      source.emitOpen();
      source.emitData("text.delta", "1:4", { messageId: 0, delta });
      await settle();
    });

    // 只让出一个宏任务就断言，不用 waitFor：轮询等待会让逐字显现有时间追上。
    expect(article.querySelector(BODY)?.querySelector("p")?.textContent).toBe(`开头。${delta}`);
  });
});
