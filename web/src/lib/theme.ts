/** 主题标识：与 demo 的 data-wb-theme 约定一致，SPA 落地时由根元素消费。 */
export type Theme = "light" | "dark";

/** 归一化用户输入/存储值；未知值回退 light，与 demo 行为一致。 */
export function normalizeTheme(value: string | null): Theme {
  return value === "dark" ? "dark" : "light";
}
