import type { ComponentType } from "react";

/** 中心页的一个 tab：`key` 即 `?tab=` 的值；`adminOnly` 为真时只对管理员可见；`Panel` 是该 tab 的面板。 */
export type CenterTab = {
  key: string;
  label: string;
  adminOnly: boolean;
  Panel: ComponentType;
};

/** 中心页 tab 表，按显示次序；各 change 往这里追加（表项与面板同一处登记）。 */
export const CENTER_TABS: readonly CenterTab[] = [];
