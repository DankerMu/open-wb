# Proposal: menu-outside-close-focus（#763）

## Why
`Menu`（`modal={false}`）与 `Popover` 都是非模态：Radix 在外部交互后不把焦点还给 trigger（`@radix-ui/react-dropdown-menu` 的 `hasInteractedOutsideRef`）。主规格 ui-primitives「基元组件库」的 Menu 句、`web/src/ui/menu.tsx` 与 `web/src/ui/popover.tsx` 的 JSDoc 仍写「外点关闭后焦点回 trigger」，与行为相反；Menu 外点后的焦点没有测试锁住。Popover 的规格句已由 #762 更正。

## What Changes
- 规格：ui-primitives MODIFIED「基元组件库」——Menu 句改为「选中项或 Escape 关闭后焦点回 trigger；外点关闭不归还焦点」，场景文本补上外点后的焦点断言。
- `web/src/ui/menu.tsx`、`web/src/ui/popover.tsx`：只改 JSDoc。
- `web/test/ui-menu.test.tsx`：非模态用例在外点关闭后断言 `document.activeElement` 不是 trigger。

## Non-goals
- 不改行为（不覆盖 `onCloseAutoFocus` 强制回焦：那会把焦点从用户刚点的元素上抢走）。
- Popover 的规格句与测试不动（#762 已落）。
