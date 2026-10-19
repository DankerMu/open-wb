// 助手正文（epic-acceptance-followups design D1）：拷入层 `MarkdownText` 负责排版；源 HTML 经 `rehypePlugins`
// 解析、不安全目标转文字、白名单外标签按原文显示、消毒与 `style` 过滤（markdown-html.ts），链接 / 图片的写出
// 规则与代码块复制经 `components` 覆盖写在这里。
import { TextMessagePartProvider } from "@assistant-ui/react";
import type { CodeHeaderProps } from "@assistant-ui/react-markdown";
import type { ComponentProps } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Icon } from "../../components/icon.js";
import { useCopyFeedback } from "./copy-feedback.js";
import {
  inertUnsafeTargets,
  literalUnknownTags,
  SANITIZE_SCHEMA,
  styleGuard,
} from "./markdown-html.js";

type Rendered<T extends "a" | "img"> = ComponentProps<T> & { node?: unknown };
const LINK_CLASS = "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2";

/**
 * 到这里的链接目标都是 http(s) / mailto（其它的已在 inertUnsafeTargets 转成文字）：新标签页打开，不带 opener
 * 与 referrer。class 是固定值（与拷入层 markdown-text 自带的 `a` 相同）：theme.css 的基础层把 `a` 重置为
 * 正文色、无下划线，ui-foundation 又不许加 CSS 规则，所以链接样式由这里写 Tailwind 类（owner 2026-10-18）；
 * 源 HTML 的 class 已被消毒剥掉，只剩这一份。
 */
function ExternalLink({ node: _node, children, ...rest }: Rendered<"a">) {
  return (
    <a {...rest} className={LINK_CLASS} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

/** 到这里的图片地址都是 http(s)：懒加载、不带 referrer，宽度不超过正文容器；加载失败交给浏览器显示 alt。 */
function ExternalImage({ node: _node, ...rest }: Rendered<"img">) {
  return (
    <img
      {...rest}
      alt={rest.alt ?? ""}
      className="max-w-full"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

/**
 * 代码块头：语言名与复制按钮。成功只把图标换成对勾（约 2 秒后恢复），失败在按钮旁就地显示
 * `复制失败`；规则与消息级 `复制` 共用（copy-feedback.ts）。写入的是代码块原文去掉末尾恰一个换行
 * （Markdown 转换追加的那个；代码自己以空行结尾时仍留一个），粘贴到终端时末行不会被直接执行。
 */
function CodeHeader({ code, language }: CodeHeaderProps) {
  const { copy, result } = useCopyFeedback(code.endsWith("\n") ? code.slice(0, -1) : code);
  return (
    <div className="mt-3 flex items-center gap-2 rounded-t-xl border border-b-0 border-border bg-muted px-3.5 py-1.5 text-xs">
      <span className="mr-auto font-medium text-muted-foreground lowercase">{language}</span>
      {result === "failed" ? (
        <span className="text-(--wb-status-error-text)" role="alert">
          复制失败
        </span>
      ) : null}
      <button
        aria-label="复制代码"
        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-(--wb-icon-muted) hover:bg-accent hover:text-foreground"
        onClick={() => void copy()}
        title="复制代码"
        type="button"
      >
        <Icon name={result === "copied" ? "check" : "copy"} size={12} />
      </button>
    </div>
  );
}

const COMPONENTS = { a: ExternalLink, img: ExternalImage, CodeHeader };
/** 顺序即 design D1 的四步；模块常量，保持引用稳定（基元只对插件数组做一层比较，内层元组按引用比）。 */
const REHYPE_PLUGINS = [
  rehypeRaw,
  inertUnsafeTargets,
  literalUnknownTags,
  [rehypeSanitize, SANITIZE_SCHEMA],
  styleGuard,
] satisfies ComponentProps<typeof MarkdownText>["rehypePlugins"];

/**
 * 基元的逐字显现在这里仍关着（`smooth={false}`）：它追赶期间把容器 `data-status` 置为 `running`，拷入的
 * dot.css 会在末块之后加一个脉动点，与消息自己的小圆点叠成两个运行指示。逐字展开改在应用层做
 * （smooth-text.tsx，design D8），`text` 收到的已是要显示的前缀，并以「已完成」的 text part 交给
 * `MarkdownText`；流式进度与小圆点由应用自己呈现（message-thread.tsx）。
 */
export function MarkdownBody({ text }: { text: string }) {
  return (
    <TextMessagePartProvider text={text}>
      <MarkdownText components={COMPONENTS} rehypePlugins={REHYPE_PLUGINS} smooth={false} />
    </TextMessagePartProvider>
  );
}
