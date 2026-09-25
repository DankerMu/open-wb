# Proposal: files-dialog-migration（#302）

## Why
父 change `s1e-frontend-parity` 的 tasks 1.6b：files 页仍有 S1e 之前手写的覆盖层，是 ui-primitives「只经基元取行为」的最后一处例外：

- `web/src/features/files/dialogs.tsx:36-81` `DialogSurface`：原生 `<dialog>.showModal()` + `web/src/lib/dialog.ts` `trapDialogFocus` 手写 Tab 循环 + 卸载时手动归还焦点；
- `dialogs.tsx:83-182` `CreationMenu`：手写 `role="menu"`、方向键/Home/End、Escape；
- `web/src/features/files/page.tsx:62-173` `WorkspaceSwitcher`：手写 `role="dialog"` 面板、手动聚焦搜索框与 Escape。

#315 / PR #379 已给 `Dialog` 加了 `busy`（忙碌上升沿焦点救回），并在父 1.6b 写明交接约束：两个表单对话框传 `busy={pending}`，且要有真实浏览器断言证明提交按钮禁用后 Tab/Shift+Tab 仍在模态内（#302 留言）。

## What Changes
- `WorkspaceDialog`/`DirectoryDialog` → `Dialog`（`busy={pending}`、`initialFocus` 指向首个表单控件、`returnFocus` 指向发起流程的触发器）；删 `DialogSurface`。
- `CreationMenu` → `Menu`（两项 `新建文件夹`/`新建工作空间`）；删手写键盘代码。
- `WorkspaceSwitcher` → 受控 `Popover`（`contentLabel="工作空间切换器"`，默认 `role="dialog"`）；删手动聚焦/Escape；弹层外壳改由 `.ui-popover` 承载，`.files-switcher-panel` 只留内部布局。
- 交互增量（唯一一处）：对话框遮罩点击关闭，与 `取消` 同义（挂起期即取消等待）；与 demo `openModal` 一致，原生 `<dialog>` 无此行为。
- 删 `web/src/lib/dialog.ts`、`web/test/dialog.test.tsx`；`src` 已无 `<dialog>`，同删 `web/test/dialog-platform.ts` 及其 9 处 import。
- `files.css` 删随之失效的规则（`.files-dialog`、`::backdrop`、`h2`、`.files-menu*`，以及 `.files-switcher-panel` 的外壳属性）。
- jsdom：files 测试的菜单打开方式改 pointer（Radix 在 pointerdown 打开），对话框/菜单/切换器定位改页面范围；新文件 `web/test/files-overlays.test.tsx` 承载焦点闭环与静态契约用例。
- ui-walk：walkFiles 的切换器/对话框/菜单项定位改页面范围；`walk-out` 创建改为键盘提交并挂起 `POST …/dirs`，断言焦点救回与 Tab 循环；挂起/放行抽成与退出段共用的 helper。

## Non-goals
- 文案/布局/视觉对齐（5.x：逻辑路径、`根目录　<空间名>`、按钮换 `Button`、切换器卡图标等）。
- `dialog.tsx` 的 `FOCUSABLE` 口径与无匹配回退：复核结论见 design「FOCUSABLE 复核」，本刀不改。
- 服务端、API、`app-reference/**`。

## Capabilities
- MODIFIED `ui-primitives`：「基元组件库」的迁移句把 files 侧由"后续切片"改为已迁移的等价约束，并新增父 change 待交付的 Scenario「既有对话框迁移不回归」。
- MODIFIED `files-web`：「文件界面与键盘可用性」新增基元接线句（`busy`、焦点归还目标）与 Scenario「创建流程焦点闭环」。
- MODIFIED `files-harness`：「走查 /files 步骤」的 walk-out 创建改为挂起期焦点断言。

## Impact
- Error handling / rollback / partial outputs：挂起期 `关闭`/`取消`/Escape 仍为"取消等待"（abort + 代际守卫），语义不变；遮罩点击新增为取消入口，挂起期点击即 abort，与 `取消` 相同。失败（409/其它）后对话框保持打开、焦点留在框内、`创建` 恢复可用。
