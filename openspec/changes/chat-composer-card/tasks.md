# Tasks: chat-composer-card（#288）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate chat-composer-card --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新 `web/test/chat-composer.test.tsx` 写 C1–C5 与 C6 新增条；按改写规则 2 全仓 grep 并改写英文会话状态断言；ui-walk 两处期望改中文。先红。
- [x] 2.2 `status-label.ts`、`composer.tsx`；`conversation-view.tsx` 接入 Composer 与会话项状态元素；`page.tsx` 删常量；`chat.css` 按 design。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入十三项各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR 同步父 delta `s1e-frontend-parity/specs/chat-web/spec.md` 会话页状态句（加 `idle` → `未开始`），防止父变更整体归档时回退。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：会话项 status 名/文本、发送按钮名、`生成中` status 是 ui-walk 与 jsdom 的完成 oracle。证据：C3、C4、3.3。
- Not selected Config / project setup：不加依赖、不改配置。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：只消费既有 `ChatSession.status`。
- Not selected Auth / permissions / secrets：无。
- Not selected Concurrency / shared state / ordering：`generating`/`sendDisabled` 计算不改；所有权用例覆盖。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：键盘发送、生成锁、既有 chat 测试与 ui-walk。证据：C6、改写清单、3.3。
- Not selected Error handling / rollback / partial outputs：错误呈现不改。
- Not selected Release / packaging / dependency compatibility：不加依赖。
- Selected Documentation / migration notes：英文会话状态断言改写清单。证据：PR 迁移说明。
