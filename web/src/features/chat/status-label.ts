import type { ChatSession } from "../../lib/session-contract.js";

/** 会话状态的中文呈现；步骤徽章复用 running/done/failed/stopped 四项。 */
export const SESSION_STATUS_LABEL: Record<ChatSession["status"], string> = {
  idle: "未开始",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 列表条目的状态文案：有待决确认时是 `等待确认`，优先于 `status`（session-sidebar「会话状态标记」）。 */
export function sessionStatusText(
  session: Pick<ChatSession, "status" | "pendingApproval">,
): string {
  return session.pendingApproval ? "等待确认" : SESSION_STATUS_LABEL[session.status];
}
