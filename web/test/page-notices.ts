import { screen } from "@testing-library/react";

/**
 * 整页范围内 `alert` 与 `status` 两种角色的元素的文案（含被模态层 `aria-hidden` 的；显式 `role` 与
 * 隐式角色都算，如 `<output>` 是 `status`），先 `alert` 后 `status`，各按文档顺序，写成 `角色:文案`。
 * 用来证明「没有另出提示」，范围只到这两种角色：页面上多出一条 `alert` 或 `status`（不论文案、不论
 * 挂在哪个区域）这张清单就变；不带这两种角色的提示它看不见——只有 `aria-live` 而没有角色的节点、
 * `role="log"`、普通文字都不在清单里，那类提示要按文案另行断言。
 */
export function pageNotices(): string[] {
  return (["alert", "status"] as const).flatMap((role) =>
    screen.queryAllByRole(role, { hidden: true }).map((node) => `${role}:${node.textContent}`),
  );
}

/**
 * 会话与回合的状态标记：常驻的 `status`，文案恰为这几个之一，不是提示。`正在思考…` 是运行中助手消息
 * 尚无可见块时的等待指示（issue 1446），同属回合状态。
 */
const STATE_MARKS = ["未开始", "运行中", "生成中", "已完成", "已停止", "正在思考…"].map(
  (mark) => `status:${mark}`,
);

/** `pageNotices()` 去掉状态标记：剩下的每一条都是出给用户看的提示。 */
export function pagePrompts(): string[] {
  return pageNotices().filter((notice) => !STATE_MARKS.includes(notice));
}
