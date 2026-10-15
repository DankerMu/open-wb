// 助手正文（design D5）：拷入层 `MarkdownText` 负责排版，安全规则与代码块复制经 `components` 覆盖写在这里。
import { TextMessagePartProvider } from "@assistant-ui/react";
import type { CodeHeaderProps } from "@assistant-ui/react-markdown";
import type { ComponentProps } from "react";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Icon } from "../../components/icon.js";
import { useCopyFeedback } from "./copy-feedback.js";

/** 链接保持惰性：任何目标都只留可见文字，不生成 `a` 元素。 */
function InertLink({ children }: ComponentProps<"a">) {
  return <>{children}</>;
}

/** 图片不加载：模型给出的地址会让浏览器向任意主机发请求。原位显示 alt，没有 alt 时显示地址。 */
function ImageText({ alt, src }: ComponentProps<"img">) {
  return <>{alt || src}</>;
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

const COMPONENTS = { a: InertLink, img: ImageText, CodeHeader };

/**
 * 基元的逐字显现在这里仍关着（`smooth={false}`）：它追赶期间把容器 `data-status` 置为 `running`，拷入的
 * dot.css 会在末块之后加一个脉动点，与消息自己的小圆点叠成两个运行指示。逐字展开改在应用层做
 * （smooth-text.tsx，design D8），`text` 收到的已是要显示的前缀，并以「已完成」的 text part 交给
 * `MarkdownText`；流式进度与小圆点由应用自己呈现（message-thread.tsx）。
 */
export function MarkdownBody({ text }: { text: string }) {
  return (
    <TextMessagePartProvider text={text}>
      <MarkdownText components={COMPONENTS} smooth={false} />
    </TextMessagePartProvider>
  );
}
