# Tasks: chat-welcome-state（#289）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate chat-welcome-state --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 W1–W5 与 `ICON_NAMES` 补项。先红。
- [x] 2.2 `welcome-content.ts`、`welcome.tsx`、`conversation-view.tsx`、`ui/icon.tsx`、`chat.css`。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入九项各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR：父 delta `s1e-frontend-parity/specs/chat-web/spec.md` 的 Welcome state 段与 Scenario 原句照搬，无扩展则不同步；若实现偏离（如卡片可访问名、组件拆分）影响 spec 文本，同步之。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：新增按钮文本不得与 jsdom/ui-walk 的既有定位冲突。证据：既有测试全绿、3.3。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：纯呈现。
- Not selected Schema / columns / units / field names：无数据契约变化。
- Not selected Auth / permissions / secrets：无。
- Not selected Concurrency / shared state / ordering：草稿写入沿用 `onChangeDraft`；不引入新请求。
- Not selected Resource limits / large input / discovery：静态七项。
- Selected Legacy compatibility / examples：hero 归属、composer 身份与键盘用例、无会话发送流程不变。证据：W5、既有 chat 测试全绿。
- Not selected Error handling / rollback / partial outputs：无新错误路径。
- Not selected Release / packaging / dependency compatibility：lucide 已在。
- Not selected Documentation / migration notes：无迁移。
