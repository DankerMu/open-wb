# 候选面板：切换工作空间后高亮回到首项

## Why

#814 的评审指出：草稿不变时切换工作空间，候选面板换成另一份目录，但高亮沿用上一份目录的下标，按 Enter 会选中用户没看过的命令。规格原先只要求草稿变化时重置高亮。

## What Changes

- 面板所显示目录的工作空间 id 变化时，高亮回到第一项。`Esc` 的关闭状态不受影响（仍持续到草稿变化）。

## Impact

- 规格：chat-web「会话页」一句与一个新场景。
- 代码：`web/src/features/chat/slash-menu.tsx`（必要时 `slash-menu-state.ts`）与对应测试。server 不变。
