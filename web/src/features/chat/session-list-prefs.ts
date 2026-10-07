import type { SessionGrouping } from "./session-groups.js";

const GROUPING_KEY = "workbuddy-session-grouping";
const COLLAPSED_KEY = "workbuddy-session-collapsed";

// 读失败（隐私模式、存储被禁用）、缺失与非法值一律按默认；写失败静默，内存状态由调用方持有。
// 沿用 `workbuddy-sidebar` 的先例。

/** 分组方式：`workspace` | `time`，其余按 `workspace`。 */
export function readSessionGrouping(): SessionGrouping {
  try {
    return window.localStorage.getItem(GROUPING_KEY) === "time" ? "time" : "workspace";
  } catch {
    return "workspace";
  }
}

export function writeSessionGrouping(grouping: SessionGrouping): void {
  try {
    window.localStorage.setItem(GROUPING_KEY, grouping);
  } catch {
    // 写失败静默。
  }
}

/** 折叠的分组键：JSON 字符串数组；不是数组或含非字符串元素时整体按空数组，不逐项挑拣。 */
export function readCollapsedGroups(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    if (Array.isArray(parsed) && parsed.every((key) => typeof key === "string")) return parsed;
    return [];
  } catch {
    return [];
  }
}

export function writeCollapsedGroups(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(keys));
  } catch {
    // 写失败静默。
  }
}
