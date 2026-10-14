// 助手消息的错误文本（chat-web「消息线程」，issue 909 design D19）：一句分类说明，有状态码时后接
// `（HTTP <status>）`；原文非空时一个 `查看原文` 按钮（默认收起），展开后按纯文本显示原文——文本节点，
// 不经 Markdown、不当 HTML。同一位置在回合运行且 omp 正在会话级重试时显示一行重试提示。
import { useState } from "react";
import type { ChatMessageCustom } from "./runtime-convert.js";

const DETAIL_BLOCK =
  "m-0 max-h-60 overflow-auto rounded-md bg-(--wb-bg-secondary) px-2 py-1.5 font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-(--wb-text-secondary)";

export function MessageError({
  error,
  retrying,
  status,
}: Pick<ChatMessageCustom, "error" | "retrying" | "status">) {
  if (error !== null) {
    return <FailureText error={error} />;
  }
  return status === "running" && retrying ? (
    <p
      className="m-0 text-xs text-(--wb-text-secondary)"
      data-slot="message-retrying"
      role="status"
    >
      上游出错，正在重试…
    </p>
  ) : null;
}

function FailureText({ error }: { error: NonNullable<ChatMessageCustom["error"]> }) {
  const [open, setOpen] = useState(false);
  const line =
    error.status === null ? error.message : `${error.message}（HTTP ${String(error.status)}）`;
  return (
    <div
      className="flex min-w-0 flex-col items-start gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text)"
      data-slot="message-error"
    >
      <p className="m-0" role="alert">
        {line}
      </p>
      {error.detail === "" ? null : (
        <button
          aria-expanded={open}
          className="cursor-pointer text-xs text-(--wb-text-secondary) underline-offset-2 hover:underline"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          查看原文
        </button>
      )}
      {open && error.detail !== "" ? (
        <pre className={`${DETAIL_BLOCK} self-stretch`} data-slot="message-error-detail">
          {error.detail}
        </pre>
      ) : null}
    </div>
  );
}
