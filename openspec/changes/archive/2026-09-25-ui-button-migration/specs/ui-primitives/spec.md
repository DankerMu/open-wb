## ADDED Requirements

### Requirement: 按钮单一实现与旧类退役
`web/src` 中所有按钮 SHALL 经 `web/src/ui/index.ts` 导出的 `Button` 渲染样式（类名 `ui-btn ui-btn--<variant> ui-btn--<size>`，调用方附加类经 `className` 透传）；旧 `.ui-button`、`.ui-button-primary`、`.ui-button-danger` 类及其规则 SHALL 从 `web/src` 移除，`web/src` 下 `.ts`/`.tsx`/`.css` 不得再出现 `ui-button`（`ui-btn` 不受影响）。本条取代「基元组件库」中 `.ui-button*`「迁移切片前不动」的过渡约定；`.ui-alert`/`.ui-muted`/`.ui-empty` 不在本条范围。迁移 SHALL 保持各按钮的可访问名、`type`、禁用态、点击行为与作为 Menu 触发器时的 ref/回焦不变。`web/test/ui-guardrails.test.ts` SHALL 有扫描 `web/src` 的 grep 守卫，并以注入样本自证其匹配式命中 `ui-button` 且不命中 `ui-btn`。

#### Scenario: 旧类清零且守卫自证
- **WHEN** 扫描 `web/src` 下全部 `.ts`/`.tsx`/`.css`，并对注入样本 `<button className="ui-button">` 与 `<button className="ui-btn ui-btn--md">` 运行同一匹配式
- **THEN** 仓库扫描零命中，注入样本恰命中 1 条（`ui-button` 行），`ui-btn` 行不命中

#### Scenario: 迁移后行为不回归
- **WHEN** 渲染 `新建会话`、`查看源码`/`渲染视图`、`＋ 新建工作空间`、`新建`（Menu 触发器）、对话框 `取消`/`创建`
- **THEN** 它们的类名为 `ui-btn ui-btn--primary|secondary ui-btn--md`（`新建会话`另含 `chat-new-session`），可访问名不变，`创建`仍为 submit 且挂起期禁用，`新建`菜单开合与关闭回焦不变
