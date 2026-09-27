# Tasks: approval-snapshot（#476）

## 5. chat-sessions — REST 与跨端快照（父 tasks 5.3 原文）

- [ ] 5.3 跨端同刀：server `GET …/messages` 每条消息增 `approvals: Approval[]`（按 id 升序，用户消息与无记录助手消息为 `[]`；store 投影在 `store-approvals.ts`）+ web `web/src/lib/session-contract.ts` 消息键集加 `approvals` 与 `Approval` 严格解析 + 新建 `web/src/features/chat/stream-approvals.ts` 承载归约（`stream.ts` 不拆分，只增接线调用）：`approval.request`（按 `approvalId` 为键增入、不覆盖旧条）/`approval.resolved`（按 `approvalId` 更新 decision，未知 id 忽略）。验证：server 新建 inject 测试断言快照形状；web 新建测试文件断言解析与归约（含同一消息两条审批）
- [ ] （本 fixture 追加，见 proposal 偏离 1、2）审批元素类型定义并导出于 `store.ts`（`ApprovalView` 与之同形）；`store-branch.ts:36` 只改 `Omit` 一行类型；`rest.ts` 的快照元素复用 `toPublicApproval`（只放宽签名），审批路由注册与 handler 零 diff。验证：design S7/S8（快照元素 `toStrictEqual` 作答 200 body）、S11
- [ ] （本 fixture 追加，见 proposal 偏离 4、5）投影只取 assistant 消息的行；`approval.request` 接线不改会话状态。验证：design S5、W7

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 公共 REST `GET …/messages` 形状变化；SSE 两类命名事件开始被 web 消费 → S1–S10、W9–W11 |
| Schema / columns / units / field names | yes | 消息七键、审批元素六键、视图五键（无 `requestedAt`）、`decision` 值域 → S1–S4（`toStrictEqual`）、W1–W3 |
| Auth / permissions / secrets | yes | 投影按会话取行，他会话与 user 消息不泄露；owner 404/401 路径不变 → S5；既有 `session-rest.test.ts:225,286` 守卫 |
| Concurrency / shared state / ordering | yes | 快照与 `streamCursor` 同一 preParsing 捕获；并行审批 id 序；事件按同一游标过滤与回放幂等 → S3、S6、S10、W8、W9 |
| Legacy compatibility / examples | yes | 严格键集跨端同刀；作答 200 六键不变；既有测试只按允许清单补键 → S11、W12，design「Sibling surfaces」 |
| Error handling / rollback / partial outputs | yes | 任一元素非法 → 整个快照拒绝（不部分安装）；非法 `approval.*` → 重新同步而非静默丢弃 → W2、W11 |
| Config / project setup | no | 无配置变化 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Resource limits / large input / discovery | no | 每次 `getMessages` 多一条按会话的索引查询（`message_id` 索引，迁移 034），审批行数受回合内工具调用数约束；不新增上限 |
| Release / packaging / dependency compatibility | no | 无依赖变化；同仓同部署无兼容窗口（父 D6） |
| Documentation / migration notes | no | 无迁移；架构文档 API 表归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：server 只改 `store-approvals.ts`、`store.ts`（proposal 偏离 1）、`store-branch.ts:36`（一行类型）、`rest.ts`（`PublicMessage`、`toPublicHistory`、`toPublicApproval` 签名）；web 只改 `session-contract.ts`、`stream.ts`（只增接线），新建 `stream-approvals.ts`。`supervisor.ts`、`approvals.ts`、`turn-control.ts`、`events.ts`、`stream/sse.ts`、`http/errors.ts`、`core/`、`omp/`、fake-omp、`api.ts`、`api-sessions.ts`、`page.tsx`、`turn-actions.ts`、`conversation-view.tsx` 零 diff。
- [ ] 新测试只写进新建的 `server/test/session-approval-snapshot.test.ts` 与 `web/test/chat-stream-approvals.test.ts`（各 ≤800 行）。不 import `store-approvals.ts`/`approvals.ts`，不访问私有字段；fake-omp 只用既有 `approval`/`approval-parallel` 场景，经 `openApprovalWorld`（其 `gateApprovals` 已注入 `--approval-mode write`），不新增 fake-omp 场景。
- [ ] 既有测试允许的改动：只在 design「Sibling surfaces」列出的消息 DTO/视图字面量里插入 `approvals: []`（兄弟键 `steps` 为 `[] as []` 处同样写 `as []`）；`api-sessions.test.ts:345` 的拒绝用例不改。不删、不放宽任何断言。清单外的破坏只允许同一种插入，并在 PR body 列出行号。
- [ ] 红/绿：S1–S10、W1–W11 先对 master 跑红，再实现跑绿；design「红/绿」所列变异逐一临时施加并确认对应用例变红，失败输出记入 PR body；S11、W12 恒绿。
- [ ] 实测 `wc -l server/src/sessions/{store,store-approvals,store-branch,rest}.ts web/src/lib/session-contract.ts web/src/features/chat/{stream,stream-approvals}.ts` 与两个新测试文件，记入 PR body；`stream.ts` ≤770。
- [ ] `npm test --workspace server`、`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd ≤3%）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate approval-snapshot --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions（含「`status` 含 `stopped`」句的归属）。
