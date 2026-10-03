# Tasks: menu-outside-close-focus（#763）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `web/src/ui/menu.tsx` JSDoc：写明 Escape 与选中项关闭后回焦 trigger、外点关闭不回焦。
- [ ] 1.2 `web/src/ui/popover.tsx` JSDoc：写明 Escape 关闭回焦 trigger、外点关闭不回焦。
- [ ] 1.3 `web/test/ui-menu.test.tsx`「非模态 (M8)」用例：外点序列关闭后让出一个宏任务，再断言 `document.activeElement` 不是 trigger（与 `ui-popover-tooltip.test.tsx` 的同类断言同法）。
- [ ] 1.4 两个组件文件除注释外零 diff；不改其它被跟踪文件。

## Must preserve
- `ui-menu`、`ui-popover-tooltip`、`chat-page-sidebar` 既有测试全部通过；Escape 与选中项回焦的既有断言不动。

## Required evidence
- E1 `npm test --workspace web` 全绿（报告文件数/测试数；基线 86 / 1796）。
- E2 新断言非空：改成 `.toBe(trigger)` 时失败（记录实际焦点落点）；并用一次临时产品变异（外点关闭后强制 `trigger.focus()`）证明断言会红；之后还原。
- E3 `git diff` 对两个组件文件只含注释行。
- E4 `make lint`、`make typecheck`、`make anti-drift`（jscpd 不增）、`openspec validate menu-outside-close-focus --strict --no-interactive` exit 0。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Accessibility / keyboard / focus | yes | 焦点归还契约 → E1、E2 |
| Documentation / migration notes | yes | JSDoc 与规格同步 → E3 |
| 其它 | no | 无行为改动 |
