import type { ChatSession } from "../../lib/session-contract.js";

/** 会话状态的中文呈现；步骤徽章复用 running/done/failed/stopped 四项。 */
export const SESSION_STATUS_LABEL: Record<ChatSession["status"], string> = {
  idle: "未开始",
  running: "运行中",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};
