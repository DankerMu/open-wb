# Proposal: scroll-echo-keeps-pin（#726）

## Why
宽屏直接打开 `/?session=<id>` 且历史超过一屏时，转录先被贴底赋值（`scrollTop = scrollHeight`），顶栏随后在同一帧挂载，滚动容器矮了 56px。浏览器稍后派发的 scroll 事件里 `scrollTop` 没变、距底却 >4px，`onScroll`（`web/src/features/chat/scroll-follow.tsx:51-62`）不区分来源，把它当成用户上滚并解除贴底；之后不再自动跟随，也没有 `回到最新` 提示（距底不足一屏）。这违反现行规格「更新前处于贴底的转录 SHALL 回到底部」。

## What Changes
- `web/src/features/chat/scroll-follow.tsx`：记录上一次的 `scrollTop`（scroll 事件、`settle()` 与 `回到最新` 写入之后都更新）。`onScroll` 只在 `scrollTop` 变小且距底 >4px 时解除贴底；`scrollTop` 未变小而距底 >4px 时保持原贴底状态并执行一次 `settle()`。
- `web/test/chat-scroll-follow.test.tsx`：新增回声用例与「上滚仍解除」用例。
- `web/e2e/ui-walk.spec.ts`：W-scroll 在强制溢出的视口下增加一步刷新页面后断言贴底（`desktop-light`）。
- 规格：chat-web MODIFIED「转录区尺寸变化触发贴底重算」——scroll 事件的判据一句与三个 Scenario。

## Non-goals
- 顶栏三态规则不动（备选方案不做）。
- 焦点归还引起的滚动（#735）：那是 `scrollTop` 变小，本改动不处理。
- `.thinking-body` 的展开（#725）另行处理。

## 风险
- 用户上滚的唯一判据变为「`scrollTop` 变小」。键盘、滚轮、拖动滚动条、`scrollIntoView` 向上都满足；`scrollToMessage`（对话内搜索）在调用 `onScroll()` 前已滚动，目标在当前位置上方时 `scrollTop` 变小，照常解除贴底。目标恰在底部时保持贴底，与现有语义一致。
