# Tasks: chat-scroll-follow（#290）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate chat-scroll-follow --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/chat-scroll-follow.test.tsx` F1–F8。先红。
- [x] 2.2 `scroll-follow.tsx`；`conversation-view.tsx` 装配；`messages.css` 样式。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入八项各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR：父 delta `s1e-frontend-parity/specs/chat-web/spec.md` 的 `回到最新` 句按子 delta 细化同步；父 Scenario「回到最新」按子 Scenario 扩写（打开位于底部、点击后继续跟随、欢迎态无按钮）；勾父 tasks 4.5。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：按钮可访问名 `回到最新` 与 `.chat-transcript` 滚动元素是测试定位面。证据：F1–F7。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：纯呈现。
- Not selected Schema / columns / units / field names：不改数据契约。
- Not selected Auth / permissions / secrets：无。
- Selected Concurrency / shared state / ordering：scroll 事件与内容更新的先后决定是否跟随；切换会话时的状态隔离。证据：F2、F3、F4、F6。
- Selected Resource limits / large input / discovery：长历史与持续增长的流式内容。证据：F1、F4。
- Selected Legacy compatibility / examples：欢迎态结构、composer 身份、既有 transcript 相关断言不变。证据：F7、W5、`web/test` 全绿、3.3。
- Not selected Error handling / rollback / partial outputs：无失败路径（ref 为空时 no-op）。
- Not selected Release / packaging / dependency compatibility：无。
- Not selected Documentation / migration notes：无迁移。
