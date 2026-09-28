# Tasks: nonanswer-settlement（#474）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.6 原文）

- [ ] 4.6 `store-approvals.ts` + supervisor 非作答路径结算：`settlePendingForMessage(messageId, decision)` 与 running→failed 或 running→stopped 翻转同一事务、审计经注入 `audit.emit` 同事务写入；崩溃、有界退回、优雅关停（`close()`）、启动对账（`reconcileOnStartup`）四路一律 `deny`、不向 omp 发帧、取消其超时计时器；有 ring 时在该事务提交后、`turn.end` 之前发布 `approval.resolved`（含优雅关停）；无 ring（启动对账）只落库+审计。验证（新建测试文件）：四路各一用例断言终态消息无 `decision NULL` 审批、每条结算恰一条 `session.approval` 审计；崩溃/有界退回/优雅关停三路 ring 中 `approval.resolved` 先于 `turn.end`，对账路径不发布任何事件；有界退回用例用 fake `approval-chain-abort-ignored`（6.6）：stop 以 Deny 结算 `r1`，fake 随后发出 `r2` 并忽略 abort，可注入时钟越过 grace 时该回合仍有审批 pending → 在 running→stopped 同一事务内以 `deny` 结算、助手与会话 `stopped`；不断言 `r2` 与 `abort` 帧的相对先后，也不 probe `frames=`（进程已被有界退回、无法再接收 probe；Deny 先于 `abort` 的帧序由 4.2a 的 `approval-then-abort`/`approval-parallel` 用例证明）；对账用例以带 pending 审批的 running 旧库启动；「作答与进程退出竞争」（审批挂起时子进程退出 → 崩溃路径以 `deny` 结算 → 随后作答得 409 `approval_settled` → 该行仍为 `deny` → 不向 omp 发任何帧 → 该审批恰一条 `session.approval` 审计）
  - 本 fixture 的裁定见 proposal「偏离与决定」：`approvals.ts`/`turn-control.ts` 越出 PR Boundary（偏离 1）；`finishTurn` 经可选第三参数回报（偏离 2）；任意终态均结算（偏离 3）；`decided_at` 取 store 时钟（偏离 4）；`session-rest-helpers.ts` 补传 emit（偏离 5）。
- [ ] （本 fixture 追加，见 proposal 偏离 1、6）`ApprovalRegistry.close()` 只撤销计时器、保留登记；缺 emit 只在确有待结算行时失败关闭。验证：design C4、N4
- [ ] （#473/#475 移交）补证停止路径的 `decision`/审计：tool-approval「先 Deny 后 abort」「停止拒绝全部挂起审批」全文，chat-sessions「Stop is accepted …」审批 WHEN。验证：design B2、B3（恒绿守护）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | resolved 须在终态提交之后、`turn.end` 之前进入未封口的 ring；终态结算与作答、超时、stop 竞争时由同一 CAS 裁决；关停保留登记 → C1、C3、C4、B1（live 订阅与 onEvent 次序）、C2（409）；变异表 |
| Error handling / rollback / partial outputs | yes | 审计失败使终态与决定整体回滚、不发布；缺 emit 且有行时失败关闭；infraFaulted 回合不发布 → N3、N4、Must preserve 7；infraFaulted 计时器问题列为 Open question |
| Public API / CLI / script entry | yes | `SessionStore.finishTurn` 新增可选第三参数、导出 `SettledApproval`；`persistEvent` 签名变化（模块内） → N1（两参与三参）、knip 零新增、`make typecheck` |
| Legacy compatibility / examples | yes | 两参 `finishTurn` 仍返回 boolean；无 emit 的既有 store 在无审批行时不变；既有审批/停止测试零 diff；唯一允许的 helper 改动 → N4(a)、design Sibling surfaces 全绿 |
| Resource limits / large input / discovery | yes | 终态撤销计时器、删登记，60s 计时器不在死进程上触发，也不残留登记 → C1、C3、B1 的 `timersDueAt(T+60000)===0`，`advance(60000)` 后无变化；B1 `liveProcessCount()===0` |
| Auth / permissions / secrets | yes | 审计 `actorId` 取会话 `owner_id`，不写死 → N1、N5 用 `u2`；C2 走真实 REST 鉴权后 409 |
| Schema / columns / units / field names | no | 无迁移；审计 `detail` 形状与 #464 相同；`decided_at` 单位为 epoch ms（偏离 4） |
| Config / project setup | no | 无配置项 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Release / packaging / dependency compatibility | no | 无依赖变化；生产 argv 仍为 `yolo`（#481 依赖本刀） |
| Documentation / migration notes | no | 无数据迁移（生产库无审批行，proposal Impact）；`docs/architecture/system.md` 归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/store-approvals.ts`、`store.ts`（`finishTurn`/`close`/`reconcileOnStartup` 接线与类型）、`supervisor.ts`（只改 `#commit`）、`approvals.ts` 与 `turn-control.ts`（proposal 偏离 1）；`rest.ts`、`events.ts`、`pool.ts`、`index.ts`、`store-branch.ts`、`omp/`、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] 值导入方向不变：`store-approvals.ts` 对 `store.ts` 只有 `import type`；`approvals.ts`/`turn-control.ts` 对 `./supervisor.js` 无值导入；`SettledApproval` 定义并导出于 `store.ts`（carry-forward #454）；不经 `sessions/index.ts` 导出。
- [ ] 新测试只写进新建文件：`server/test/session-store-settlement.test.ts`（N1–N5）、`session-settlement.test.ts`（C1–C5）、`session-settlement-stop.test.ts`（B1–B3）、helper `session-settlement-helpers.ts`，各 ≤800 行。审批用例经 `openApprovalWorld`/`openStopWorld`（内含 `gateApprovals` 注入 argv `write`）；每个进程只跑一个门控回合；不 import `approvals.ts`/`turn-control.ts`/`store-approvals.ts`，不访问私有字段。
- [ ] 既有测试允许的改动**恰一处**：`server/test/session-rest-helpers.ts:52-56` 的 `createSessionStore` 选项加 `emit`（值导入 `../src/core/audit/index.js`），不改断言。design「Sibling surfaces」所列其它既有测试零 diff 全绿。
- [ ] 红/绿：N1–N3、N4(b)、N5、C1–C5、B1 在 master 上为红；N4(a)、B2、B3 是恒绿守护。design 变异表逐一临时施加并确认对应用例变红，失败输出记入 PR body。
- [ ] 实测 `wc -l server/src/sessions/{supervisor,store,store-approvals,approvals,turn-control}.ts` 与新测试文件并记入 PR body；`supervisor.ts` ≤790（硬上限 798，超出时只允许 proposal Impact 预批准的 `#failure` 纯搬迁）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate nonanswer-settlement --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions。
- [ ] 归档 PR：本刀交付的父块（tool-approval 四块、chat-sessions 三块、chat-stream「审批事件发布」）与推进后的主 spec 逐字一致，父 tasks 4.6 打勾。「审批事件」与「会话 REST」父块保留完整目标文本，仍为 MODIFIED。「审批事件」的两处孤儿片段按 Open questions 由编排者决定是否在本归档 PR 中补入。
