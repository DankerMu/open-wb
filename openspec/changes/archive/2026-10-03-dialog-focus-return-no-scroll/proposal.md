# Proposal: dialog-focus-return-no-scroll（#735，owner 决议 (a)）

## Why
`useFocusHandoff().onCloseAutoFocus`（`web/src/ui/dialog.tsx`）自行归还焦点时调用不带参数的 `focus()`，浏览器会把归还目标滚入视口。转录贴底跟随时从较早消息的产物卡打开 html 预览，内容把卡片顶出视口后关闭预览：转录被拽回旧卡片，`scroll-follow` 的 `onScroll` 解除贴底。（issue 里「Radix 自己的归还带 `preventScroll`」的说法对 Dialog 不成立：`@radix-ui/react-dialog` 模态内容的 `onCloseAutoFocus` 在我方未 `preventDefault` 时调用不带参数的 `triggerRef.focus()`，focus-scope 里带 `preventScroll` 的那段走不到。owner 选 (a) 的依据是复现到的拽回本身，不依赖这一点。）

真实浏览器复现（Chromium，编译后的真实服务 + 官方 omp + 可控上游，无 route mock）：
- 回合结束后关闭：1440×900 `scrollTop` 2101 → 109、距底 0 → 1992，`回到最新` 出现；390×844 3673 → 160、距底 3513。Escape 与 `关闭` 按钮一致。
- 流式进行中关闭：上游增量间隔 200ms / 40ms 时 20/20 次失去贴底；5ms 时 3/20 次。
- 加上 `preventScroll` 的对照构建：上述场景全部保持 `scrollTop` 与贴底，无 `回到最新`。

## What Changes
- `dialog.tsx` `useFocusHandoff`：归还一律 `focus({ preventScroll: true })`（Dialog、ConfirmDialog、Drawer 共用）。
- `web/test/ui-dialog.test.tsx`（Drawer 的归还用例也在该文件）：对归还调用的入参加断言。
- 规格：ui-primitives MODIFIED「基元组件库」一句 + 一个 Scenario。

## 已知并接受的代价（owner 选 (a) 时已权衡；复现中实测）
- 归还后焦点所在的控件可能在可视区之外，没有可见的焦点指示。
- 键盘用户随后按 Tab / Shift+Tab 时，浏览器把新焦点元素滚入视口，转录此时才被拽回并解除贴底（1440：2101 → 160）。鼠标用户不受影响。本 change 不处理。

## Non-goals
- `onOpenAutoFocus` 的 `initialFocus.current?.focus()`（目标在模态内容里，不涉及转录）。
- 归还目标的选择规则、忙碌期焦点救回不变。`scroll-follow.tsx` 不动。
- 有 `trigger` 且未传 `returnFocus` 的 Dialog：归还由 Radix 做（不带参数的 `focus()`，仍会滚动）。生产代码里没有这样的消费者，不改。
- Menu/Popover（Radix 自己回焦）与 feature 层的各处 `.focus()` 不在范围。
