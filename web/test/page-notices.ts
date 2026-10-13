import { screen } from "@testing-library/react";

/**
 * 整页范围内每个提示面的文案：全部 `alert` 与 `status` 角色的元素（含被模态层 `aria-hidden` 的），先
 * `alert` 后 `status`，各按文档顺序，写成 `角色:文案`。用来证明「没有另出提示」：页面上多出任何一条
 * 提示（不论文案、不论挂在哪个区域）这张清单都会变。
 */
export function pageNotices(): string[] {
  return (["alert", "status"] as const).flatMap((role) =>
    screen.queryAllByRole(role, { hidden: true }).map((node) => `${role}:${node.textContent}`),
  );
}

/** 会话与回合的状态标记：常驻的 `status`，文案恰为这几个之一，不是提示。 */
const STATE_MARKS = ["未开始", "运行中", "生成中", "已完成", "已停止"].map(
  (mark) => `status:${mark}`,
);

/** `pageNotices()` 去掉状态标记：剩下的每一条都是出给用户看的提示。 */
export function pagePrompts(): string[] {
  return pageNotices().filter((notice) => !STATE_MARKS.includes(notice));
}
