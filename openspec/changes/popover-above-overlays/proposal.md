# Proposal: popover-above-overlays（#715）

## Why
`Popover` content 的 z-index 是 1300（`web/src/ui/popover.css:5`），低于 `Drawer` 遮罩 1350、面板 1360（`web/src/ui/dialog.css:90`、`:99`）与 `Dialog` 遮罩 1400（`dialog.css:10`）。`Popover` 总是 portal 到 `document.body`，Radix Popper 把 content 的 z-index 复制到定位包装层，所以从 `导航` Drawer 或 Dialog 内打开的 Popover 整块画在遮罩之下。第一个受影响的是 `≤760px` 侧栏里的 `筛选任务`：弹层不可见、单选项点不到。jsdom 不计算层叠，单测看不到；现有走查也没有在 `mobile-dark` 打开筛选。

## What Changes
- `web/src/ui/popover.css`：`.ui-popover` 的 z-index 1300 → 1500（高于 Drawer 1350/1360 与 Dialog 1400，低于 Menu 1600、Tooltip 1700、Toast 2000）。owner 选定 #715 的方案 1。
- `web/test/ui-popover-tooltip.test.tsx`：期望值改为 1500，并新增层级关系断言（`.ui-popover` 高于 `.ui-dialog-overlay`/`.ui-drawer-overlay`/`.ui-drawer`、低于 `.ui-menu`），防止以后任何一方单独改值又回到被遮挡。
- `web/e2e/ui-walk-sessions.spec.ts` 第 6 步：在同一侧栏（`mobile-dark` 上覆盖层仍打开）打开 `筛选任务`，以真实指针点击 `已完成`、再点 `全部` 复位、Escape 只关弹层。真实指针点击经 Playwright 的命中测试，被遮罩拦截即失败——这是本缺陷唯一能红的取证。
- 规格：ui-primitives「基元组件库」、session-sidebar「状态与时间筛选」、chat-harness「UI 走查会话元数据」各 MODIFIED 一条（delta 由主规格现文生成，只改与本缺陷相关的句子）。

## Non-goals
- 方案 2（`Popover` 增 `container`）不做。
- 不动 `Dialog`/`Drawer`/`Menu`/`Tooltip`/`Toast` 的层级，不动 `sidebar.css` 的 1100。
- Popover 的定位、焦点、关闭行为不变。

## 偏差
- demo 的 `.pop` 为 1300（`resource/workbuddy-live-demo.html:779`）；本仓改为 1500，在 ui-primitives 规格里写明为有意偏差。demo 的筛选用的是 `.menu-pop`（1600），没有这个问题。

## Impact
- 视觉：桌面上 Popover 与非覆盖层内容的相对层级不变（都高于 1100 以下的页面层）。Dialog 打开时 Radix 的外点关闭会先关掉 Popover，因此不会出现 Popover 压在新开 Dialog 之上的状态。
- 走查：`ui-walk-sessions.spec.ts` 多两次点击和一次 Escape，30 s 单测预算内。
