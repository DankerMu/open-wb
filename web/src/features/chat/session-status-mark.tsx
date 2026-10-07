// 会话条目的状态标记（session-sidebar「会话状态标记」，design D3）：每个条目一个 `role="status"` 元素，
// 六种文案都以视觉隐藏的文本存在；看得见的标记只有三种，优先级 等待确认 > 运行中 > 失败。
import type { ChatSession } from "../../lib/session-contract.js";
import { sessionStatusText } from "./status-label.js";

type SessionState = Pick<ChatSession, "status" | "pendingApproval">;
type StatusMark = "waiting" | "running" | "failed";

/** 提示点、转动的指示、错误色标记。全局样式只在减少动态效果下关 transition，转动要在这里自己关。 */
const MARK_CLASS: Record<StatusMark, string> = {
  waiting: "size-2 rounded-full bg-(--wb-status-warning) ring-2 ring-(--wb-status-warning-soft-bg)",
  running:
    "size-3 rounded-full border-[1.5px] border-(--wb-brand-primary-deep) border-t-transparent animate-spin motion-reduce:animate-none",
  failed: "size-2 rounded-full bg-(--wb-status-error)",
};

function statusMark(session: SessionState): StatusMark | null {
  if (session.pendingApproval) return "waiting";
  if (session.status === "running") return "running";
  return session.status === "failed" ? "failed" : null;
}

export function SessionStatusMark({ session, title }: { session: SessionState; title: string }) {
  const text = sessionStatusText(session);
  const mark = statusMark(session);
  return (
    <span
      aria-label={`${title} ${text}`}
      className="relative inline-flex size-3 flex-none items-center justify-center"
      role="status"
    >
      {mark === null ? null : (
        <span aria-hidden="true" className={MARK_CLASS[mark]} data-status-mark={mark} />
      )}
      <span className="sr-only">{text}</span>
    </span>
  );
}
