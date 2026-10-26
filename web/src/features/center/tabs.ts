import type { ComponentType } from "react";
import { ConnectorsPanel } from "./connectors/panel.js";
import { ExpertsPanel } from "./experts/panel.js";
import { ModelsPanel } from "./models/panel.js";
import { MountSourcesPanel } from "./mount-sources-tab.js";
import { SkillsPanel } from "./skills/list.js";

/** 中心页的一个 tab：`key` 即 `?tab=` 的值；`adminOnly` 为真时只对管理员可见；`Panel` 是该 tab 的面板。 */
export type CenterTab = {
  key: string;
  label: string;
  adminOnly: boolean;
  Panel: ComponentType;
};

/** 中心页 tab 表，按显示次序；各 change 往这里追加（表项与面板同一处登记）。 */
export const CENTER_TABS: readonly CenterTab[] = [
  { key: "experts", label: "专家", adminOnly: false, Panel: ExpertsPanel },
  { key: "skills", label: "技能", adminOnly: false, Panel: SkillsPanel },
  { key: "connectors", label: "连接器", adminOnly: false, Panel: ConnectorsPanel },
  { key: "models", label: "模型", adminOnly: true, Panel: ModelsPanel },
  { key: "mount-sources", label: "挂载源", adminOnly: true, Panel: MountSourcesPanel },
];
