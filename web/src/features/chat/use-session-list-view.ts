import { useState } from "react";
import type { SessionGrouping } from "./session-groups.js";
import {
  readCollapsedGroups,
  readSessionGrouping,
  writeCollapsedGroups,
  writeSessionGrouping,
} from "./session-list-prefs.js";

/**
 * 列表区的视图状态（session-sidebar「分组侧栏」「标题搜索」），由会话页持有：列表节点会随侧栏折叠与
 * 导航覆盖层关闭卸载，状态不能放在它里面。
 * - `query`：搜索词，只在内存里，刷新或离开会话页即清空；默认视图与归档视图共用。
 * - `archived`：列表区是否在归档视图（session-sidebar「归档视图」），只在内存里，刷新后回到默认视图。
 * - `grouping` / `collapsed`：初值读 `localStorage`，改动时写回；写入放在回调里而不是 effect 或
 *   updater 里（挂载不写默认值，StrictMode 的双调用不重复写）。存储不可用时只剩内存状态。
 */
export function useSessionListView() {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [grouping, setGroupingState] = useState(readSessionGrouping);
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);

  const setGrouping = (next: SessionGrouping) => {
    setGroupingState(next);
    writeSessionGrouping(next);
  };
  /** 切换分组键 `key` 的折叠与否。 */
  const toggleGroup = (key: string) => {
    const next = collapsed.includes(key)
      ? collapsed.filter((item) => item !== key)
      : [...collapsed, key];
    setCollapsed(next);
    writeCollapsedGroups(next);
  };

  return { archived, collapsed, grouping, query, setArchived, setGrouping, setQuery, toggleGroup };
}

export type SessionListView = ReturnType<typeof useSessionListView>;
