## MODIFIED Requirements

### Requirement: 按钮单一实现与旧类退役
尚未迁移到 ui-foundation「组件分层」的区域中所有按钮 SHALL 经 `web/src/ui/index.ts` 导出的 `Button` 渲染样式（类名 `ui-btn ui-btn--<variant> ui-btn--<size>`，调用方附加类经 `className` 透传）；已迁移区域的按钮经 `@/components/ui/button`，不带 `ui-btn` 类；自 s1f-session-list-temp-space 与 s1f-files-page 起，`web/src/features/chat/**` 与 `web/src/features/files/**` 都是已迁移区域（ui-foundation「组件分层」的「会话页迁移终态」与「文件页整目录已迁移」），这两个目录下的按钮不再带 `ui-btn` 类；旧 `.ui-button`、`.ui-button-primary`、`.ui-button-danger` 类及其规则 SHALL 从 `web/src` 移除，`web/src` 下 `.ts`/`.tsx`/`.css` 不得再出现 `ui-button`（`ui-btn` 不受影响）。本条取代「基元组件库」中 `.ui-button*`「迁移切片前不动」的过渡约定；`.ui-alert`/`.ui-muted`/`.ui-empty` 不在本条范围。迁移 SHALL 保持各按钮的可访问名、`type`、禁用态、点击行为与作为 Menu 触发器时的 ref/回焦不变。`web/test/ui-guardrails.test.ts` SHALL 有扫描 `web/src` 的 grep 守卫，并以注入样本自证其匹配式命中 `ui-button` 且不命中 `ui-btn`。

#### Scenario: 旧类清零且守卫自证
- **WHEN** 扫描 `web/src` 下全部 `.ts`/`.tsx`/`.css`，并对注入样本 `<button className="ui-button">` 与 `<button className="ui-btn ui-btn--md">` 运行同一匹配式
- **THEN** 仓库扫描零命中，注入样本恰命中 1 条（`ui-button` 行），`ui-btn` 行不命中

#### Scenario: 迁移后行为不回归
- **WHEN** s1f-files-page 的文件页首刀合入后渲染侧栏的 `新建会话`、文件预览的 `查看源码`/`渲染视图`、切换器里的 `＋ 新建工作空间`、`新建`（`＋` 菜单的触发器）、创建对话框的 `取消`/`创建`
- **THEN** 它们的类名都不含 `ui-btn`（文件页的五个按钮随 ui-foundation「文件页整目录已迁移」改经 `@/components/ui/button`；`新建会话` 已随 s1f-session-list-temp-space 重建在拷入层上——session-sidebar「分组侧栏」规定其名称与行为不变，ui-foundation「会话页迁移终态」规定 `session-sidebar.tsx` 不再从 `web/src/ui` 导入 `Button`）；可访问名不变，`创建`仍为 submit 且挂起期禁用，`新建`菜单开合与关闭回焦不变
