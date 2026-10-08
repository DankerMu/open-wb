import type { ChatMessage, ChatStep } from "../../lib/session-contract.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";

/**
 * 导出只读的那部分消息：页面视图（`ChatState`）与新读的快照（`ChatMessageSnapshot`）的消息都满足它。
 * 思考、步骤的 detail 与 output、审批、文件变更不在其中，也就进不了导出。
 */
type ExportedMessage = {
  role: ChatMessage["role"];
  content: string;
  steps: readonly { name: string; status: ChatStep["status"] }[];
};

const FALLBACK_FILENAME = "会话";
/** 文件名里去掉的字符：路径分隔与控制字符（C0、DEL、C1）。 */
const UNSAFE_IN_FILENAME = /[/\\\p{Cc}]/gu;
const MARKDOWN_TYPE = "text/markdown;charset=utf-8";

/** 一条消息的各块：标题行；正文非空时是正文原文；助手消息有步骤时是步骤列表（每个步骤一行）。 */
function messageBlocks({ role, content, steps }: ExportedMessage): string[] {
  const blocks = [role === "user" ? "## 用户" : "## 助手"];
  if (content.length > 0) blocks.push(content);
  if (role === "assistant" && steps.length > 0) {
    blocks.push(
      steps.map((step) => `- ${step.name}（${SESSION_STATUS_LABEL[step.status]}）`).join("\n"),
    );
  }
  return blocks;
}

/**
 * 会话记录的 Markdown（session-sidebar「导出记录」）：标题块 `# <显示标题>` 与各消息的各块按序排列，
 * 相邻两块之间恰一个空行，全文以单个换行结尾。正文原样输出，不转义。
 */
export function sessionMarkdown(session: {
  title: string;
  messages: readonly ExportedMessage[];
}): string {
  return `${[`# ${session.title}`, ...session.messages.flatMap(messageBlocks)].join("\n\n")}\n`;
}

/** 下载文件名：显示标题去掉 `/`、`\`、控制字符与首尾空白后加 `.md`；去完为空时是 `会话.md`。 */
export function markdownFilename(title: string): string {
  return `${title.replace(UNSAFE_IN_FILENAME, "").trim() || FALLBACK_FILENAME}.md`;
}

/** 以临时链接触发浏览器下载；Blob URL 晚一个任务释放，浏览器此时仍读得到它。 */
export function downloadMarkdown(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: MARKDOWN_TYPE }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
