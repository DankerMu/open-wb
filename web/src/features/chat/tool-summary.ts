// 工具段摘要（chat-web「工具段摘要与折叠」；owner 裁定 B6 的对应表、B7 的后缀）。纯模块：步骤名按表精确匹配
// （区分大小写）归入一类，各非零类按表的次序以 `、` 连接，计数按步骤（一次 `read` 读多个文件也记 1）；
// 有失败接 `，N 步失败`，有运行中再接 `，进行中`；`stopped` 照常计入其类、不加后缀。
import type { ChatStepView } from "./stream-steps.js";

type ToolAction = "执行命令" | "读取" | "新建" | "修改" | "搜索" | "其它";

/** 表的次序即摘要的次序。 */
const ACTIONS: readonly {
  action: ToolAction;
  names: readonly string[];
  unit: (n: number) => string;
}[] = [
  { action: "执行命令", names: ["bash", "eval"], unit: (n) => `执行 ${n} 条命令` },
  { action: "读取", names: ["read"], unit: (n) => `读取 ${n} 个文件` },
  { action: "新建", names: ["write"], unit: (n) => `新建 ${n} 个文件` },
  { action: "修改", names: ["edit", "ast_edit"], unit: (n) => `修改 ${n} 个文件` },
  {
    action: "搜索",
    names: ["grep", "glob", "ast_grep", "web_search", "search", "find"],
    unit: (n) => `搜索 ${n} 次`,
  },
  { action: "其它", names: [], unit: (n) => `其它 ${n} 步` },
];

// `Map` 而不是对象字面量：`constructor`、`__proto__` 这类名字不会命中原型上的键。
const BY_NAME = new Map(
  ACTIONS.flatMap(({ action, names }) => names.map((name) => [name, action] as const)),
);

/** 步骤名对应的动作类；表外的名字一律是 `其它`。 */
export function toolAction(name: string): ToolAction {
  return BY_NAME.get(name) ?? "其它";
}

/** 一个工具段的摘要文字（展开/收起控件的可见文本与可访问名）。 */
export function summarizeTools(steps: readonly ChatStepView[]): string {
  const counts = new Map<ToolAction, number>();
  for (const step of steps) {
    const action = toolAction(step.name);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const parts = ACTIONS.flatMap(({ action, unit }) => {
    const n = counts.get(action) ?? 0;
    return n > 0 ? [unit(n)] : [];
  });
  const failed = steps.filter((step) => step.status === "failed").length;
  const running = steps.some((step) => step.status === "running");
  return `${parts.join("、")}${failed > 0 ? `，${failed} 步失败` : ""}${running ? "，进行中" : ""}`;
}
