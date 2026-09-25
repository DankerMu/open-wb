# Tasks: chat-copy-action（#291）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate chat-copy-action --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/chat-copy.test.tsx` C1–C6。先红。
- [x] 2.2 `message-actions.tsx`；`conversation-view.tsx` 装配；`messages.css` 样式。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入八项各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR：父 delta `s1e-frontend-parity/specs/chat-web/spec.md` Messages 段的操作条句按子 delta 细化同步；把子 Scenario「复制助手原文」并入父 delta；勾父 tasks 4.6。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：按钮可访问名 `复制`、Toast 文本。证据：C1–C5。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：纯呈现。
- Not selected Schema / columns / units / field names：复制的是既有 `content` 字段原文，不改契约。证据：C1。
- Selected Auth / permissions / secrets：剪贴板权限拒绝走 reject 路径。证据：C3。
- Not selected Concurrency / shared state / ordering：每次点击各自独立，无共享状态。
- Not selected Resource limits / large input / discovery：原文长度由服务端既有上限约束，本刀不做截断。
- Selected Legacy compatibility / examples：M1–M5、步骤卡、W5 保持绿。证据：`web/test` 全绿、3.3。
- Selected Error handling / rollback / partial outputs：API 缺失、reject、同步抛错三条路径收敛为 Toast，无未捕获异常。证据：C2、C3、C3b。
- Not selected Release / packaging / dependency compatibility：无。
- Not selected Documentation / migration notes：无迁移。
