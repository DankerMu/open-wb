import type { ChatSession } from "../../lib/session-contract.js";
import type { TopbarAction, useTopbar } from "../../lib/topbar.js";
import { sessionTitle } from "./session-path.js";

/**
 * 会话页顶栏按钮的全部槽位，数组次序即 DOM 次序（demo:1942-1953）。页面只从这里按序构造
 * `useTopbar` 的 `actions`；没有填入的槽位不产出按钮。
 */
export const CHAT_TOPBAR_ACTIONS = [
  { key: "rename", label: "重命名", icon: "pencil" },
  { key: "search", label: "对话内搜索", icon: "search" },
  { key: "artifacts", label: "产物面板", icon: "package" },
] as const;

type ChatTopbarSlots = Partial<
  Record<(typeof CHAT_TOPBAR_ACTIONS)[number]["key"], Pick<TopbarAction, "expanded" | "onSelect">>
>;

/** 按 `CHAT_TOPBAR_ACTIONS` 的次序（与 `slots` 的键序无关）产出已填入槽位的描述符。 */
export function chatTopbarActions(slots: ChatTopbarSlots): TopbarAction[] {
  return CHAT_TOPBAR_ACTIONS.flatMap((action) => {
    const slot = slots[action.key];
    return slot ? [{ ...action, ...slot }] : [];
  });
}

/**
 * 会话页给 `useTopbar` 的上报：有当前会话时为面包屑标题、`重命名` 与 `产物面板`；没有（欢迎态，或
 * 标题尚未得知）时为空上报。不 memo：shell 按描述符的可比较字段判断是否更新。
 */
export function chatTopbar(
  selected: ChatSession | undefined,
  openRename: (session: ChatSession, trigger: HTMLElement) => void,
  openArtifacts: (trigger: HTMLElement) => void,
): Parameters<typeof useTopbar>[0] {
  if (!selected) return {};
  return {
    breadcrumb: sessionTitle(selected),
    actions: chatTopbarActions({
      rename: { onSelect: (trigger) => openRename(selected, trigger) },
      artifacts: { onSelect: openArtifacts },
    }),
  };
}
