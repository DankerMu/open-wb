# Tasks: approval-registration（#464）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.3 原文）

- [ ] 4.3 `approvals.ts` + `store-approvals.ts` 审批：请求 → `chat_approvals` 落库 pending（同一回合可有多条，`approval.request` 不覆盖旧记录）→ 发布 `approval.request` → 按 `approvalId` 各自独立的 60s 可注入时钟计时器；`decide(sessionId, approvalId, decision)`：以 `decision IS NULL` CAS 结算，次序「落库+审计 `session.approval`（store 经注入的 `audit.emit` 同一事务写入）→ 发 `Approve|Deny` 帧 → 发布 `approval.resolved`」；CAS 失败（已作答/已超时/已被非作答路径结算，含所属进程已退出）→ `approval_settled`；超时 → `timeout` + `Approve`；`sessions/index.ts` `registerSessions` 把 `core/audit` 的 emit（同一 DB）注入 store（chat-sessions「Session module registration and teardown」）。验证（新建测试文件，fake-omp 经 argv 注入 `write`）：`approval` 场景 allow/deny/timeout 三路与重复作答 409；`approval-parallel` 两条审批各自计时与作答、互不覆盖；行已被非作答路径结算（夹具直接写 `decision`）后作答 → 409 `approval_settled`；作答与超时竞争只有一方生效；审计行与决定行同事务可见；pending 插入失败 → ring 无 `approval.request`、不向 omp 发帧；结算事务失败 → ring 无 `approval.resolved`；真实 fake-omp 下 SSE 次序约束与 `Last-Event-ID` 回放（tool-approval「事件序与回放」）；并行审批 ring 内各恰一条 `approval.request`/一条 `approval.resolved` 且均先于 `turn.end`（chat-stream「Parallel approvals coexist」）；pending 行字段形状 `requested_at=T`、`expires_at=T+60000`（tool-approval「落库形状」）；经真实 `registerSessions` 装配落一条 `session.approval` 审计行
  - 交接注记（#487）：本 task 新建 `sessions/approvals.ts`，并以 MODIFIED 把它的职责与依赖方向（对 `supervisor.ts` 只允许类型导入、不经 `index.ts` 暴露）补进 chat-sessions「会话 supervisor 源码模块划分」；审批事件经 `#publish` 发布，不走非穷举的 `persistEvent`。
- [ ] （本 fixture 追加，见 proposal 偏离 3、5）`approval.request` 于 pump 处理到该 select 帧时发布，结算前未发布则先补发；审批事件只发往登记时且未封口的 generation。验证：design R13、R17、R17b、R19
- [ ] （本 fixture 追加，见 proposal 偏离 7、8）`shutdown()` 撤销全部审批计时器；`decide` 对未知或他会话 `approvalId` 拒绝 `not_found`。验证：design R18、R10

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `SessionSupervisor.decide` 新公开端口（#468 的调用对象）；`SessionStore` 新方法、`SessionStoreOptions.emit`；resolve 值精确键集与 `approval_settled`/`not_found` 拒绝码 → R2、R5、R10；knip 零新增 |
| Schema / columns / units / field names | yes | `chat_approvals` 行形状（`requested_at`/`expires_at`/`decided_at` 为注入时钟毫秒）、`approval.*` 事件载荷、审计 `detail` 键集 → R1、R2、R4、R8、R12 |
| Concurrency / shared state / ordering | yes | 作答与超时竞争、并发作答、`onApproval` 与 pump 的帧序竞态、每 `approvalId` 独立计时、迟到作答对后继进程的隔离、挂起对空闲回收的暂停 → R5、R7、R11–R14、R17、R17b、R19；A7 守护驱逐 |
| Error handling / rollback / partial outputs | yes | 决定与审计同事务、pending 插入与结算失败不发布不发帧、两个失败出口、关停撤销计时器 → R15、R16、R18、R20 |
| Legacy compatibility / examples | yes | `createSessionStore` 旧调用方零改动（`emit` 可选）；生产 argv 仍 `yolo`，非 write 模式行为不变 → Sibling surfaces 全部零 diff |
| Auth / permissions / secrets | yes | 审计 `actorId` 为会话 owner；`decide` 拒绝不属于该会话的 `approvalId` → R8、R10（REST 鉴权归 #468） |
| Config / project setup | no | 无新配置键；60s 为常量，`OMP_IDLE_MS` 语义不变 |
| Resource limits / large input / discovery | no | 不改池上限与驱逐；挂起即「在回合中」由既有 `busy()` 覆盖（A7 守护） |
| File IO / path safety / overwrite | no | 不涉文件 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；`docs/architecture/system.md` 归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/approvals.ts`（新建）、`store-approvals.ts`、`store.ts`（proposal 偏离 1）、`supervisor.ts`（只接线）、`index.ts`；`omp/`、`rest.ts`、`events.ts`、`turn-control.ts`、`pool.ts`、`store-branch.ts`、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] `approvals.ts` 对 `./supervisor.js` 只有 `import type`（或无导入），不经 `sessions/index.ts` 导出；审批行类型从 `store.ts` 导出（#454）；`onApproval`、计时器回调同步、不抛；`onExit` 不改、不调 `respondApproval`。
- [ ] 新测试只写进新建文件：`server/test/session-approvals.test.ts`、`session-approvals-parallel.test.ts`、`session-approvals-faults.test.ts`、`session-store-approvals.test.ts`（R20，可 import `store.ts`）、helper `session-approval-helpers.ts`，各 ≤800 行（超出则再拆新文件）；不 import `approvals.ts`/`store-approvals.ts`（R20 只 import `store.ts`），不访问私有字段；argv `write` 经 `gateApprovals` 或新 helper 注入，不改 `session-supervisor-helpers.ts`。
- [ ] 既有测试允许的改动：**无**。design「Sibling surfaces」所列既有测试与 helper 零 diff 全绿。
- [ ] 红/绿：R1–R20（含 R17b）在 master 上为红；design「红/绿」所列变异逐一临时施加并确认对应用例变红，失败输出记入 PR body；A7 与既有测试恒绿。
- [ ] 实测 `wc -l server/src/sessions/{supervisor,store,store-approvals,approvals}.ts` 与新测试文件，记入 PR body；`supervisor.ts` ≤755（硬上限 760）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate approval-registration --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions。
