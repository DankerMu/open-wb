# Tasks: approval-bar（#480）

## 7. chat-web（父 tasks 7.4 原文）

- [ ] 7.4 `approval-bar.tsx` + `conversation-view.tsx` + `page.tsx`/`turn-actions.ts`：一条助手消息可按 `approvals` id 升序纵向渲染多个审批条；pending 头部 `需要你的确认` + 工具名徽章（title 首行 `Allow tool: <name>` 解析）+ 正文为 title 全文（`white-space: pre-wrap`）+ 单句动态倒计时 `（<n>s 内未操作将自动允许）`（由 `expiresAt` 实时计算，初值 60）+ `允许`/`拒绝`（点击后禁用）；allow/timeout → `已允许执行`、deny → `已拒绝执行`；`approval_settled` 409 不弹错、等下次快照。验证：新建 jsdom 测试文件覆盖四态、同一消息两条审批独立作答、刷新后从快照恢复 pending 与倒计时
- [ ] （本 fixture 追加，见 proposal 偏离 2）工具名徽章直接取 `tool` 字段（server 已解析 title 首行），web 不解析 title。验证：design A10
- [ ] （本 fixture 追加，见 proposal 偏离 1）只断言有 pending 时 composer 仍锁定；`停止` 可用由 #477 交付。实现开工时若 #477 已在 master，则按父 delta 原文恢复两个 spec delta 中的 `停止` 子句，在 A1 加 `停止` 可用断言，并在 PR body 记录。验证：design A1 守卫断言
- [ ] （本 fixture 追加，见 proposal 偏离 3–5）200 body 不回写视图；非 `approval_settled` 失败时显示内联错误并解禁该条；409 对账先 GET，成功后 `installSnapshot` + `openSource`，失败时静默且保留旧源；作答不触碰 prompt 的 mutation fence。验证：design A3、A5、A5b、A6、A12、A12b、A13

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 首个消费 `POST /api/sessions/:id/approvals/:approvalId` 的 UI。请求路径与 body 必须对准该条 id，不能串到别的审批或别的会话 → A3、A7、A8、A12 |
| Concurrency / shared state / ordering | yes | 多条审批独立作答；作答与在途 prompt 共存；409 对账与实时源、`loadHistory` 交错；每秒 tick → A7、A11、A12、A12b、A13、A5b |
| Error handling / rollback / partial outputs | yes | 409 静默对账、其它信封内联并解禁、对账失败静默；不乐观更新 → A3、A5、A5b、A6；401 交接只经代码审查（`isUnauthorized` 分支不写 UI） |
| Legacy compatibility / examples | yes | 既有页面行为与测试零 diff；`approvals: []` 时 DOM 不变；助手块结构守卫 → G3、design「Sibling surfaces」 |
| Auth / permissions / secrets | yes | 作答只发往当前 client 与当前选中会话；切换会话或账号后，迟到的结果不写 UI；401 走既有登录交接（页面卸载后由 `mountedRef` 围栏兜底，只经代码审查）；切会话迟到结果 → A12、A12b；账号续期后迟到的 409 → A12c；owner 校验在 server（#468），本刀不改 |
| Config / project setup | no | 无配置变化 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Schema / columns / units / field names | no | 只读 #476 已定形的视图字段 `{id,tool,title,expiresAt,decision}`，不改解析与键集（`session-contract.ts`、`stream-approvals.ts` 零 diff） |
| Resource limits / large input / discovery | no | 每个含 pending 的列表只有一个 interval，无 pending 即清除 → A11；不新增上限 |
| Release / packaging / dependency compatibility | no | 无依赖变化，不新增图标（`shield` 已注册） |
| Documentation / migration notes | no | 无迁移；架构文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只新建 `web/src/features/chat/approval-bar.tsx`，只改 `turn-actions.ts`、`conversation-view.tsx`、`page.tsx`、`messages.css`（`messages.css` 越出 issue 文件清单，见 proposal 偏离 6，只追加 `.chat-approval*` 规则）。`stream.ts`、`stream-approvals.ts`、`session-contract.ts`、`api-sessions.ts`、`api.ts`、`errors.ts`、`types.ts`、`composer.tsx`、`web/src/ui/**`、server、Makefile、e2e 零 diff。
- [ ] 新测试只写进新建的 `web/test/chat-approval-bar.test.tsx`（≤800 行）。快照由本文件自建，`chat-stream-support.ts`/`chat-page-support.tsx`/`support.ts` 不改。时钟用 `vi.useFakeTimers({ toFake: ["Date","setInterval","clearInterval"] })` + `vi.setSystemTime`，在 `renderChatPage` 之前设置；禁用 `vi.waitFor`；`afterEach` 调 `vi.useRealTimers()`。
- [ ] 既有测试允许的改动：无。实现后若出现清单外的破坏，停下上报，不改既有测试。
- [ ] 红/绿：A1–A13 与 G1 的 `pre-wrap` 断言先对 master 跑红。design「红/绿」列出的变异逐一临时施加，确认对应用例变红，失败输出记入 PR body。G2、G3 恒绿。
- [ ] 行数：实测 `wc -l web/src/features/chat/{page.tsx,turn-actions.ts,conversation-view.tsx,approval-bar.tsx,messages.css}` 与新测试文件，记入 PR body；`page.tsx` ≤630，`turn-actions.ts` ≤290。
- [ ] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增：新增导出只有 `ApprovalBars`，被 `conversation-view.tsx` 使用；jscpd ≤3%）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate approval-bar --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions（`停止` 子句归属、carry-forward 80、父 tasks/design 中「title 首行解析」措辞）。
