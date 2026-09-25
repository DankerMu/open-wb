# Tasks: chat-step-cards（#287）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate chat-step-cards --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 S1–S3 与既有测试改写。先红。
- [x] 2.2 拆 `messages.css` 与 `ui-walk-gate.ts`（行为不变）；`step-summary.ts`；`StepCard`；步骤卡样式；ui-walk 定位。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入九项各红并回退（design Required evidence）。

## 3. Verification
- [x] 3.0 archive PR：
  - 父 delta `s1e-frontend-parity/specs/chat-web/spec.md` Step cards 段补三处摘要细化（`text` 优先于 `content`、首键值 `<key>: <value>`、非对象 JSON 走文本规则并取首行 trim），并补子 Scenario「步骤卡呈现」；
  - 父 `specs/verification-harness/spec.md` 的真正回合 THEN 已是父原句，无需改；
  - 父 tasks 4.2 行删去"正文须在步骤卡之前"的移交约束（#366 已解除）；
  - 关闭 #366。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：徽章可访问名 `bash 运行中|bash 已完成` 与 region 名是 jsdom/ui-walk 定位面。证据：S2、S3、`chat-page.test.tsx`、3.3。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：纯呈现。
- Selected Schema / columns / units / field names：detail 的摘要规则。证据：S1。
- Not selected Auth / permissions / secrets：detail 以 React 文本呈现，不引入注入面。
- Not selected Concurrency / shared state / ordering：流式归约不改。
- Selected Resource limits / large input / discovery：超长 detail、深层 JSON、代理对截断。证据：S1。
- Selected Legacy compatibility / examples：拆 CSS 与 e2e 行为不变；既有 region/detail 断言保持绿。证据：既有测试全绿、3.3。
- Not selected Error handling / rollback / partial outputs：`JSON.parse` 失败回落文本分支。证据：S1 `{not json` 行。
- Not selected Release / packaging / dependency compatibility：无。
- Not selected Documentation / migration notes：无迁移。

3.0 实际：父 Step cards 句同步三处细化（"non-blank" 与实现 `trim() !== ""` 一致，子 delta 同改）；子 Scenario「步骤卡呈现」并入父 delta；父 tasks 4.2 行的移交约束随勾选改写删除；#366 已由 PR #368 合并提交信息中的 `Closes #366` 自动关闭。
