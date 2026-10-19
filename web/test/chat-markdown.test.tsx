// 助手正文的 Markdown 规则（epic-acceptance-followups design D1；chat-web「Markdown 链接惰性与图片不加载」
// 「代码块复制失败就地提示」）。源 HTML 的渲染与消毒、流式半截 HTML 见 chat-markdown-html.test.tsx。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupChatPage,
  mountAssistantReply as mountReply,
  renderChatPage,
} from "./chat-page-support.js";
import {
  chatSnapshot,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const BODY = '[data-slot="message-body"]';

/** 规格场景「Markdown 链接惰性与图片不加载」的正文：全部是不安全或无法解析的目标。 */
const UNSAFE_TARGETS = [
  "[脚本](javascript:alert(1))",
  "[数据](data:text/html,x)",
  "[相对](docs/a.md)",
  "[锚点](#top)",
  "![](data:image/png;base64,AAAA)",
  "![本地](./a.png)",
  '<a href="javascript:void(0)">j</a>',
  '<img src="data:image/gif;base64,R0lGOD" alt="内联">',
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

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("Markdown 链接惰性与图片不加载", () => {
  it("不安全目标的链接只留可见文字：没有 a 元素，目标地址不出现在文本与属性里", async () => {
    const { article, body } = await mountReply(UNSAFE_TARGETS);

    for (const text of ["脚本", "数据", "相对", "锚点", "j"]) {
      expect(body.textContent).toContain(text);
    }
    expect(body.querySelector("a")).toBeNull();
    expect(within(article).queryByRole("link")).toBeNull();
    const html = article.innerHTML;
    for (const target of ["javascript:", "alert(1)", "data:text", "docs/a.md", "#top", "void(0)"]) {
      expect(html, target).not.toContain(target);
    }
    for (const attribute of ["href", "src", "srcset"]) {
      expect(body.querySelector(`[${attribute}]`), attribute).toBeNull();
    }
  });

  it("不安全目标的图片不生成 img：原位依次显示地址（无 alt）、本地、内联", async () => {
    const { body } = await mountReply(UNSAFE_TARGETS);

    expect(document.querySelector("img")).toBeNull();
    expect(body.textContent).toBe("脚本 数据 相对 锚点 data:image/png;base64,AAAA 本地 j 内联");
  });
});

describe("源 HTML 的脚本与事件不生效", () => {
  it("script / iframe 连内容去掉、不执行；img 没有 onerror；b 成元素；标签字样不出现", async () => {
    const { body } = await mountReply(RAW_HTML);

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(body.querySelector("[onerror]")).toBeNull();
    expect(body.innerHTML).not.toContain("onerror");
    expect(body.querySelector("b")?.textContent).toBe("粗");
    expect(body.querySelector("img")?.getAttribute("src")).toBe("https://img.example.com/c.png");
    for (const leaked of ["<script", "__pwned", "<iframe", "evil.example", "<b>", "<img"]) {
      expect(body.textContent, leaked).not.toContain(leaked);
    }
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
    // 写入值是代码块原文去掉末尾恰一个换行（Markdown 转换追加的那个），不以换行结尾。
    expect(writeText.mock.calls).toEqual([['const a = "<b>";\nconsole.log(a);']]);
    expect(failed(article)).toBeNull();
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

  it("代码块以空行结尾时写入值仍以恰一个换行结尾，内部换行与空行原样", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { article, body } = await mountReply("```sh\na\n\nb\n\n```");
    expect(body.querySelector("pre > code")?.textContent).toBe("a\n\nb\n\n");

    fireEvent.click(copyButton(article));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls).toEqual([["a\n\nb\n"]]);
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

// 原用例「流式正文不落后于数据 / 增量一到就整段可见」钉的是被 owner 裁定推翻的旧行为（issue 910 O2/O6）：
// 按通用纪律第 3 种改法改为反向钉子。假时钟只假 rAF / cAF / Date（`useSmooth` 只读这两样，7a 实测）。
describe("流式正文逐字展开、终态立即全文", () => {
  it("展开期间显示的是前缀，进入终态立即全文", async () => {
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
    const shown = () => article.querySelector(BODY)?.querySelector("p")?.textContent ?? "";
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "Date"] });
    try {
      await act(async () => {
        source.emitOpen();
        source.emitData("text.delta", "1:4", { messageId: 0, delta });
        await settle();
      });
      act(() => {
        vi.advanceTimersByTime(16);
      });

      const prefix = shown();
      expect(prefix.length).toBeGreaterThan("开头。".length);
      expect(prefix.length).toBeLessThan(`开头。${delta}`.length);
      expect(`开头。${delta}`.startsWith(prefix)).toBe(true);

      await act(async () => {
        source.emitData("turn.end", "1:5", { messageId: 0, status: "done" });
        await settle();
      });

      expect(shown()).toBe(`开头。${delta}`);
    } finally {
      vi.useRealTimers();
    }
  });
});
