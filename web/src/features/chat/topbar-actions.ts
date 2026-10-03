import type { ChatSession } from "../../lib/session-contract.js";
import type { TopbarAction, useTopbar } from "../../lib/topbar.js";
import { sessionTitle } from "./session-path.js";

/**
 * 会话页顶栏按钮的全部槽位，数组次序即 DOM 次序（demo:1942-1953）。页面只从这里按序构造
 * `useTopbar` 的 `actions`；没有填入的槽位不产出按钮。
 */
export const CHAT_TOPBAR_ACTIONS = [
  { key: "config", label: "项目配置", icon: "file-text" },
  { key: "rename", label: "重命名", icon: "pencil" },
  { key: "search", label: "对话内搜索", icon: "search" },
  { key: "artifacts", label: "产物面板", icon: "package" },
] as const;

/** 槽位可带 `label` 覆盖表中的名字（`项目配置` 的 accessible name 带文件数）。 */
type ChatTopbarSlot = Pick<TopbarAction, "expanded" | "onSelect"> & { label?: string };

type ChatTopbarSlots = Partial<Record<(typeof CHAT_TOPBAR_ACTIONS)[number]["key"], ChatTopbarSlot>>;

/** 按 `CHAT_TOPBAR_ACTIONS` 的次序（与 `slots` 的键序无关）产出已填入槽位的描述符。 */
export function chatTopbarActions(slots: ChatTopbarSlots): TopbarAction[] {
  return CHAT_TOPBAR_ACTIONS.flatMap((action) => {
    const slot = slots[action.key];
    return slot ? [{ ...action, ...slot }] : [];
  });
}

/**
 * 会话页给 `useTopbar` 的上报：有当前会话时为面包屑标题、`重命名`、`对话内搜索` 与 `产物面板`，
 * 该会话的项目配置列表非空时其前另有 `项目配置`（`config` 为 undefined 即不产出）；没有当前会话
 * （欢迎态，或标题尚未得知）时为空上报。前三个回调的次序同槽位次序，`config` 殿后；`config` 与 `search` 原样填入槽位
 * （`expanded` 反映弹层、搜索框是否打开）。不 memo：shell 按描述符的可比较字段判断是否更新。
 */
export function chatTopbar(
  selected: ChatSession | undefined,
  openRename: (session: ChatSession, trigger: HTMLElement) => void,
  search: { expanded: boolean; onSelect(trigger: HTMLElement): void },
  openArtifacts: (trigger: HTMLElement) => void,
  config?: ChatTopbarSlot | undefined,
): Parameters<typeof useTopbar>[0] {
  if (!selected) return {};
  return {
    breadcrumb: sessionTitle(selected),
    actions: chatTopbarActions({
      ...(config ? { config } : {}),
      rename: { onSelect: (trigger) => openRename(selected, trigger) },
      search,
      artifacts: { onSelect: openArtifacts },
    }),
  };
}
