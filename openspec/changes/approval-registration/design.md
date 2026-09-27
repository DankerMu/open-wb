# Design: approval-registration（#464）

父设计：D5「审批：识别、持久化、超时、与停止的次序」（多条审批模型、归属层与次序、审计同事务、markPending/clearPending）、D7（fake-omp 是服务端测试的真实边界）、D8（测试侧 argv 注入 `write`）。本文只写 D5 在现有代码上落地时被代码逼出的约束，不复述父设计。

## Change surface
- **新建 `server/src/sessions/approvals.ts`**（约 200 行）：一个类（示意名 `ApprovalRegistry`），构造时由 supervisor 注入端口，不值导入 `./supervisor.js`：
  - `store`（`SessionStore`，类型导入）、`clock`（`SessionClock` 类型导入自 `omp/runtime.ts`；缺省系统时钟在本文件内定义，`omp/` 的 `systemClock` 未导出且不可改）；
  - `publish(slot, event, generation): Promise<boolean>`（即 supervisor `#publish`）；
  - `fault(slot, error): void`（即 `#retain` + `slot.infraFaulted = true` + `void #retireSlot(slot)`，同 `#commit` 失败路径 `supervisor.ts:479-484`）。
  - 每条审批一项登记，按 `approvalId`（`chat_approvals.id`）为键：`{slot, generation, sessionId, messageId, requestId, timer, requestEvent, requestPublished}`。
  - 方法（示意名）：
    - `register(slot, request)`：同步、不抛；
    - `publishRequest(slot, frame)`：pump 挂点，返回 `Promise<boolean>`；
    - `decide(sessionId, approvalId, decision)`；
    - `close()`：撤销全部计时器并清空登记，不结算。
- **`store-approvals.ts`**（107 → 约 190）：
  - `insertApproval`：对 store 活跃回合的助手消息做 `INSERT … SELECT … WHERE EXISTS (running assistant of that session)`，`requireChanges(…,1)`，返回 `{approvalId, messageId, expiresAt}`。
  - `settleApproval`：在同一 owned 事务内依次执行：
    1. 按 `a.id` 连 `chat_messages`/`chat_sessions` 读出 `session_id`、`owner_id` 与视图列；`tool`/`title` 用 `CAST AS BLOB` + `createSqliteTextDecoder` 无损读取，同消息正文。
    2. 缺行或 `session_id` 不符 → `HttpError("not_found")`。
    3. `UPDATE chat_approvals SET decision=?, decided_at=? WHERE id=? AND decision IS NULL`：0 行 → 返回 `null`（CAS 未命中）；1 行 → 继续。
    4. `emit(db, {kind:"session.approval", actorId: owner_id, title:"工具执行审批", detail:{sessionId, messageId, tool, decision}})`；
    5. `emit` 缺失时在事务内抛错回滚（proposal 偏离 2）。
  - 返回 `{id, tool, title, requestedAt, expiresAt, decision}`。
- **`store.ts`**（605 → 约 640）：`SessionStoreOptions` 加 `emit?: typeof emit`（`core/audit` 类型导入，同 `workspaces/store.ts:8,32`）；`SessionStore` 加上述两个方法（实现委托 `store-approvals.ts`）；导出审批视图类型与三值决定类型（#454 carry-forward：`store-approvals.ts` 之外的消费者只从 `store.ts` 取类型）。`createSessionStore(db, options)` 签名向后兼容。
- **`supervisor.ts`**（724 → ≤755，硬上限 760）只接线：
  - 字段与构造；
  - `#dispatchNew` 的 runtime opts（`:290-309`）加 `onApproval: (request) => this.#approvals.register(slot, request)`；
  - `#pump` 循环（`:402-421`）在提交完某帧的归约事件后，对 `extension_ui_request` 帧调用 `publishRequest`，返回 false 即 `return`（同 `#commit`）；
  - 公开 `decide(sessionId, approvalId, decision: "allow"|"deny")` 委托；
  - `shutdown()`（`:180-198`）在 `#closed = true` 后、retire 前调用 `#approvals.close()`。
- **`index.ts`**（`:36-40`）：`createSessionStore(options.db, { onFlushError, emit })`，`emit` 值导入自 `../core/audit/index.js`（`app.ts:23,159-163` 同形先例）。`RegisterSessionsOptions` 不变。

## Governing invariant
一条审批在任一时刻恰处于二态之一：
- **pending**：行 `decision` 为 NULL；有一个属于它的计时器；其所属 slot 的 runtime 已 `markPending(approvalId)`。
- **已结算**：`decision`/`decided_at` 与恰一条 `session.approval` 审计同事务提交，此后不再变化；该事务提交之后才对登记时的 slot 发帧（仅作答/超时）、`clearPending`、撤销计时器，并向登记时的 generation 发布 resolved。

`approval.request` 恰一次、位于 select 帧的回合帧序位置，且早于它的 resolved。

## Must preserve
- `onExit` 接线与 `#onProcessExit`（`supervisor.ts:299-301,321-326`）不变：同步、不抛、不写 stdin、**不调 `respondApproval`**（carry-forward #573：`child.once("exit")` 先于 `OmpProcess #onNativeExit`，写入会 EPIPE → `failIo` 丢残留帧）。
- owner 回调契约（carry-forward #462）：`onApproval` 同步、不抛。抛错会被 `process.ts #onLine` 捕获成协议错误，回合失败、generation 被 retire。`markPending` 在 `onApproval` 返回前同步调用。
- 审批事件不经 `persistEvent`（`turn-control.ts:7-58` 非穷举 switch，对 `approval.*` 返回 undefined 即静默不发布；carry-forward #453），只经 `#publish`（`supervisor.ts:489-517`）；`turn-control.ts` 零 diff。
- `busy()`/`turnFree`（`pool.ts:65-68`）不扩展：pending 审批只存在于回合中（runtime 闸门 `runtime.ts:467-476` 只在 `turn.sent` 的当前代转发），claim 或 pump 必在，已判为忙；`retire()` 永不 reject 的性质不受影响（carry-forward #595）。
- runtime 面零 diff（`runtime.ts:196-217`）：`markPending`/`clearPending`/`respondApproval` 不带 generation 身份。身份由登记时捕获的 slot 提供：#463 决定 4 + `issue` 闸门（`supervisor.ts:570-573`）保证一个 slot 的 runtime 只有一代取得 pid；`OmpProcess.respondApproval`（`process.ts:252-260`）只应答本进程上抛过的 id。
- `createSessionStore` 四个既有调用方只传 `onFlushError` 仍编译并通过；`reconcileOnStartup`/`close()`/`finishTurn` 行为不变（其审批结算归 #474）。
- `events.ts`、`rest.ts`、`pool.ts`、`store-branch.ts`、`app.ts`、`core/`、`omp/`、fake-omp、web 零 diff。

## 决定（每条附强制它的证据）
1. **帧序发布**（proposal 偏离 3）。`process.ts:573` 先 emit `frame` 再 emit `approval`（`:582`）；`runtime.ts:383-405` 把 select 帧同步推入回合 `FrameStream`。`onApproval` 运行时，pump 可能尚未处理同一 stdout 块内更早的 `tool_execution_start`。因此：
   - `register` 同步做：插行、`markPending(approvalId)`、`clock.setTimeout(…, expiresAt - now)`，并把 request 事件暂存在登记项上；
   - pump 处理到 `id` 相同的 select 帧时发布暂存的 request；
   - 结算发布 resolved 之前，若 request 尚未发布，先发布它；
   - 「已发布」标志在调用 `publish` 之前同步置位，pump 与结算不会重复发布。
   - 补发的可达边界：同一 stdout 块内的帧全部同步推入 `FrameStream`，pump 在帧与帧之间只经过微任务（`#commit`/`#publish` 无真实 I/O 等待；只有故障路径的 retire 例外，此时回合本就在中止）。REST 作答与计时器回调都到得更晚，落在之后的宏任务上，那时 pump 已处理到 select 帧并发布了 request。所以只有进程内的同步调用方（例如在 `onEvent` 里同步调 `decide`）能触发补发，生产路径上 `step.start` < request 恒成立。补发仍是必要的兜底，保证 resolved 永不先于 request；R19 以确定性方式证明它。
2. **只向登记时的 generation 发布，且仅当 `!generation.sealed`**（偏离 5）。封口即该 generation 已被撤销且 pump 已收尾，发布会落到 `turn.end` 之后；此时跳过发布（连 `onEvent` 也不调）。这一行判断只收窄窗口，不是完整保证：封口发生在 `turn.end` 发布之后的 `pump.finally`（`supervisor.ts:361-369`，经 `#releasePump` → `#sealGeneration`）。所以在 pump catch 发布 `turn.end(failed)` 到 retire/封口之间，如果有结算，其 resolved 仍会落在 `turn.end` 之后。fake 不可达：该窗口只有微任务，而作答与计时器都是宏任务。这类回合的 pending 审批由 #474 在终态事务内以 `deny` 结算并先于 `turn.end` 发布，从而关闭该窗口。
3. **结算序**：CAS+审计事务（同步）→ `slot.runtime.respondApproval(requestId, decision==="deny" ? "deny" : "allow")`（timeout → `allow`）→ `clock.clearTimeout` → `slot.runtime.clearPending(approvalId)` → 删登记 → 发布 resolved。事务之前不触碰计时器，事务失败时审批保持完整的 pending 态。
4. **CAS 未命中**：
   - `decide` 以 `HttpError("approval_settled")` 拒绝，不动登记（结算方负责清理）；
   - 计时器到期 CAS 未命中：静默删登记并 `clearPending`（幂等），不发帧、不审计、不发布；
   - 登记缺失而行仍 NULL（重启前遗留行、关停已撤销）：`decide` 仍按 CAS 落库+审计，无帧、无发布；此类行的 `deny` 归 #474 对账。
5. **两个失败出口**（偏离 6）：
   - `decide` 事务失败：原错误拒绝给调用方，行、计时器、`markPending` 均保持；
   - 超时事务失败、pending 插入失败：经 `fault(slot, error)`；`register` 的失败路径不 `markPending`、不起计时器、不暂存事件。
6. **`decided_at`**：作答取 `clock.now()`，超时取 `expires_at`；`requested_at` 取 `register` 时的 `clock.now()`；审计 `ts` 用 `emit` 缺省。

## Sibling surfaces（既有测试一律零 diff 全绿；允许改动的既有测试：无）
- `session-supervisor-pool.test.ts:232` A7：真实 `approval` 场景、cap=1、挂起时第二会话 503。本刀后它首次在真实 pending 行、`markPending` 与注入时钟计时器下运行。TestClock 不推进，关停时 `close()` 撤销计时器，store `close()` 把回合置 failed、行保持 NULL，断言不变，成为 omp-pool「全部在回合中（或挂起审批中）」的守护。
- `session-approval-events.test.ts`（#453）：spy `supervisor.subscribe` 并以测试 ring 顶替，本刀不影响。
- `omp-approval-requests.test.ts`、`omp-runtime-exit-pending.test.ts`、`fake-omp-approval*.test.ts`：runtime/进程/fake 层，不经 supervisor。
- 全部 `session-supervisor*.test.ts`、`session-store*.test.ts`、`session-rest*.test.ts`、`session-sse*.test.ts`：无审批帧（非 write 模式）。`extension-ui` 场景的 `confirm` 仍即时 `cancelled`，`publishRequest` 对无登记的 id 为空操作。
- `core-db-chat-step-output.test.ts:134`、`sqlite-text.test.ts:95`、`session-store-helpers.ts:107`、`session-rest-helpers.ts:52`：只传 `onFlushError`，因 `emit` 可选而零改动。
- `server-assembly.test.ts:376`（`audit_events` 计数 1）与 `:466`（spy `registerSessions` 透传）、`omp-max-processes-config.test.ts:186`（runtime 对象同一性）：只在审批结算时才写审计，均不受影响。
- `http-typed-errors.test.ts`：`approval_settled` 409 映射既有。

## Seams under test
- 最高 seam：`openBareSession`/`openRecordingSession`（`session-supervisor-helpers.ts:201-228`）。经真实 `createApp` → `registerSessions` → `createSessionStore`，因此每个用例都跑生产装配，`fixture.supervisor.decide(...)` 是唯一新增的公开端口。
- 真实 fake-omp：`createRealFakeRuntime("approval" | "approval-parallel")`（`:88-122`），用 `gateApprovals`（`session-supervisor-pool-helpers.ts:70-74`）让 argv 带 `write`。
- 新 helper `server/test/session-approval-helpers.ts` 只包 `runtime.spawnImpl`：
  - 按子进程记录 stdin 帧（`omp-approval-requests.test.ts:77-87` 同法）；
  - stdout 行闸门（扣住匹配行、放行时与后续行合并为一次写入，保留行边界并转发 EOF）；
  - 读 `chat_approvals`/`audit_events` 行；建删触发器（`auth-session.test.ts:496` 同法，经 `prepare(db)` 或测试中途 `db.exec`）。
- 其它观察面：
  - SSE：真实 `openEventStream`/`readUntil`（`session-sse-helpers.ts:65,236`）；
  - 审计：`GET /api/audit?limit=3`（owner cookie）；
  - 时钟：`TestClock`（`nowMs` 可直接赋值，`advance` 按序触发）；
  - 子进程存活：`runtime.children`。
- 不 import `approvals.ts`/`store-approvals.ts`，不访问私有字段；只有 R20 直接 import `store.ts`（公共入口）。

## Required evidence（全部为新建测试；T 为测试设定的注入时钟起点，如 1_700_000_000_000）
文件分配：`session-approvals.test.ts` R1–R10；`session-approvals-parallel.test.ts` R11–R13、R19；`session-approvals-faults.test.ts` R14–R18、R17b；store 级 `session-store-approvals.test.ts` R20（可 import `store.ts`）。「无副作用」= 无 `extension_ui_response` 帧、无 `session.approval` 审计、无 `approval.resolved`。凡结算后还要推进时钟超过 `idleMs` 的用例，先等回合 `done` 再推进，以免空闲回收在回合中触发、让用例证明错的东西。

| ID（Scenario） | 输入 | 期望输出 |
|---|---|---|
| R1 落库形状 | `approval`，T 时 prompt，等到 select | `chat_approvals` 恰一行 `{message_id: running assistant id, request_id:"r1", tool:"bash", title:"Allow tool: bash\nCommand: echo workbuddy-smoke", requested_at:T, expires_at:T+60000, decision:null, decided_at:null}`；恰一个 `approval.request{messageId, approvalId: 行 id, tool, title, expiresAt:T+60000}`；无副作用 |
| R2 允许 | `nowMs=T+1000`，`decide(S,id,"allow")` | resolve 值恰为 `{id,tool:"bash",title,requestedAt:T,expiresAt:T+60000,decision:"allow"}`（精确键集）；行 `allow`/T+1000；stdin 恰一帧 `{type:"extension_ui_response",id:"r1",value:"Approve"}`；恰一个 `approval.resolved{messageId,approvalId:id,decision:"allow"}`；bash 步骤、助手、会话 `done` |
| R3 拒绝 | 同 R2，`deny` | 帧 `value:"Deny"`；bash 步骤 `failed`，output `Tool call denied by user: bash`；助手与会话 `done`；resolved `deny` |
| R4 到期允许 | `advance` 到 T+59999，再 `advance(1)` | T+59999：行 NULL、无副作用；T+60000：`timeout`/T+60000，帧 `{id:"r1",value:"Approve"}`，resolved `timeout`，步骤与回合 `done` |
| R5 已结算与重复作答 | 三会话分别 allow/deny/timeout 结算后各再 `decide` allow 与 deny；另一会话 pending 时 `Promise.allSettled([allow, deny])` | 后到者 reject code `approval_settled`，行不变；每条审批恰一帧、一条审计、一个 resolved；并发组恰一 fulfilled 一 rejected，行值等于 fulfilled 的决定 |
| R6 非作答已结算后作答 | pending 时测试直写 `decision='deny', decided_at=T+500`，`decide(allow)`，再 `advance` 到 T+60000 | reject `approval_settled`；行保持 `deny`/T+500；两个时点均无副作用（到期 CAS 未命中静默） |
| R7 作答后计时器失效 | T+10000 `decide(deny)`，等回合 `done`，再 `advance` 到 T+120000 | 恰一帧、一条审计、一个 resolved；行 `deny`/T+10000 |
| R8 三种决定各一条 | 三会话于 T 各一条审批；先查审计；allow 一条、deny 一条，`advance(60000)` 让第三条超时 | pending 期间 `audit_events` 行数与 prompt 前相同；`GET /api/audit?limit=3` 200，恰三条（id 降序 `timeout`、`deny`、`allow`），均 `kind:"session.approval"`、`actorId`=owner、`title:"工具执行审批"`、`detail` 恰为 `{sessionId,messageId,tool:"bash",decision}` 且与请求一致 |
| R9 生产装配审计（chat-sessions emit 段） | 经 `openBareSession`（真实 `registerSessions`，测试不注入 emit）作答一次 | `audit_events` 恰一条 `kind='session.approval'` |
| R10 `not_found` | S1 有 pending X，S2 无审批；`decide(S2,X,"allow")`、`decide(S1,999999,"allow")` | 均 reject code `not_found`；X 行不变；无副作用 |
| R11 两条并行分别作答 + Parallel approvals coexist | `approval-parallel`，SSE 读取；两行出现后先 `decide(r2,deny)` 再 `decide(r1,allow)` | 两行 `id` 递增，`r1` 行在 `r2` 到达后逐字段不变；stdin 应答序恰为 `[{id:"r2",value:"Deny"},{id:"r1",value:"Approve"}]`；`r2` 步骤 `failed`、`r1` 步骤 `done`、回合 `done`；SSE 两个 request 按请求序，每个 `approvalId` 恰一 request 一 resolved，`r2` 的 resolved 先于 `r1` 的，均先于唯一 `turn.end` |
| R12 并行各自计时 | stdout 闸门扣住 `r2` select 行；`r1` 行落库后置 `nowMs=T+5000` 再放行；`advance` 到 T+60000、再到 T+65000 | 前置：`r2.requested_at=T+5000`；T+60000 仅 `r1` `timeout`，stdin 只有 `{id:"r1",value:"Approve"}`；T+65000 `r2` `timeout`/T+65000，再加 `{id:"r2",value:"Approve"}`；两个 resolved `timeout`；回合 `done` |
| R13 事件序与回放（+ chat-stream「Request and resolution are ordered ring events」） | `approval`，stdout 闸门把 `tool_execution_start` 与其后的 select 合并为一次写入；无游标 SSE 读到 `turn.end`；以 `approval.request` 的 id 作 `Last-Event-ID` 重连 | `turn.start` 为首；`step.start(bash)` < `approval.request{expiresAt:T+60000}` < `approval.resolved{allow}` < 该步 `step.end(done)` < 恰一个末位 `turn.end(done)`；id 严格单调；`request.seq + 1 === resolved.seq`（相邻序号）；以 request 的 id 重连，回放首个事件为该 resolved，其后顺序与首读一致；以 request **前一个**事件的 id 重连，回放以 request、resolved 开头，二者相邻、各恰一次，其后是首读中的剩余事件（step.end、turn.end）|
| R14 挂起不触发空闲回收（`runtime.idleMs=1000`） | (a) `advance` 到 T+50000；到 T+60000 超时结算，等 `done`；`advance(999)`、`advance(1)`。(b) `approval-parallel`：T+10000 deny `r2`，`advance` 到 T+50000；allow `r1`，等 `done`；`+999`、`+1` | (a) T+50000 子进程存活、stdin 未结束、无信号；+999 仍存活；+1 后 stdin 结束、子进程退出。(b) T+50000 仍存活（`r1` 挂起）；+999 存活，+1 被回收 |
| R15 pending 插入失败（chat-stream「Persistence failure publishes nothing」） | 触发器 `BEFORE INSERT ON chat_approvals … RAISE(ABORT,'approval insert blocked')` | `onError` 恰一次含该消息；0 行；无 `approval.*` 事件；无 `extension_ui_response`；子进程 stdin 结束并退出；`assertRetainedFaultOnShutdown(fixture,'approval insert blocked')`（`session-supervisor-helpers.ts:592`） |
| R16 结算事务失败（同上 + 审计同事务） | 触发器 `BEFORE INSERT ON audit_events WHEN NEW.kind='session.approval' … RAISE(ABORT,'approval audit blocked')`。(a) `decide(allow)`；`DROP TRIGGER` 后再 `decide(allow)`。(b) 带触发器 `advance` 到 T+60000 | (a) reject 含该消息；行 `decision`/`decided_at` 仍 NULL（同事务回滚）；无副作用；`onError` 为空；删触发器后 resolve，恰一帧一 resolved，回合 `done`。(b) `onError` 含该消息；行仍 NULL；无帧无 resolved；子进程被 retire；关停报告保留故障 |
| R17 迟到作答与后继隔离（carry-forward #462/#573） | `runtime.idleMs=1000`；P1 挂起 `r1`（行 A1）；真实 `SIGKILL` P1，等会话 `failed`；再 prompt 起 P2 挂起 `r1`（行 A2）；`decide(S,A1,"allow")`（结果不断言：本刀 CAS 命中，#474 后为 `approval_settled`）；`advance(5000)`；`decide(S,A2,"allow")`。全程推进 <60000，不触发 A1 计时器 | 迟到调用后 P2 stdin 无 `extension_ui_response`、A2 行仍 NULL、调用后无新的 `approval.resolved`；`advance(5000)` 后 P2 仍存活（A1 的 `clearPending` 未清 P2 的挂起）；最后 P2 恰收 `{id:"r1",value:"Approve"}`，回合 `done` |
| R17b 计时器路径的后继隔离（carry-forward #462/#573） | `runtime.idleMs=1000`；P1 于 T1 挂起 `r1`（行 A1）；真实 `SIGKILL` P1，等会话 `failed`；`advance(30000)` 后再 prompt，起 P2，挂起同名 `r1`（行 A2，`requested_at≈T1+30000`）；记下 P2 generation ring 上已有的 `approval.resolved` 数；`advance` 到 T1+60000（只有 A1 到期，A2 在 T1+90000 到期） | P2 stdin 无 `extension_ui_response`；A2 行仍 NULL；P2 generation 的 ring（SSE 或按 P2 epoch 过滤的 `onEvent`）上没有新的 `approval.resolved`；P2 仍存活。**不**断言 A1 行（本刀为 `timeout`，#474 后为 `deny`） |
| R18 关停撤销计时器 | pending 时 `await fixture.app.close()`，`clock.advance(120000)`，读 `fixture.db` 后自行 `db.close()`；该 fixture 不进共享 afterEach（或清理幂等），避免二次关闭 | `onError` 为空；无 `decision='timeout'` 行；关停后无新写入帧 |
| R19 补发 request（决定 1） | 复用 R13 的合并写入；在 `onEvent` 收到 `step.start(bash)` 时，同步读出审批行 id 并 `void decide(S,id,"allow")`（捕获 rejection，同步返回），随后让回合跑完 | ring 顺序 `step.start(bash)` < `approval.request` < `approval.resolved{allow}`；整个回合恰**一个** `approval.request`（pump 之后到达 select 帧时不再发第二个）；恰一帧 `Approve`；回合 `done` |
| R20 store 级失败关闭（偏离 2） | `createSessionStore(db,{onFlushError})` 不传 emit；受理 prompt、插入一条 pending 行、调用结算。正对照：同库另建一个传入 `emit` 的 store，走同样流程 | 无 emit：结算抛错；行 `decision`/`decided_at` 仍 NULL；`audit_events` 无 `session.approval` 行。正对照：行被结算，且恰一条审计 |

stdout 闸门的可行性：`spawnTracked`（`support/omp-rpc.ts:54-63`）不在 stdout 上挂监听，`OmpProcess` 在 `spawnImpl` 返回后才挂读取端。所以 helper 可在返回前用闸门流替换 `stdout`，也可返回一个 `stdout` 为闸门的代理子进程。闸门须保留行边界、转发 EOF/close、响应 `destroy`，因为 runtime 的 `stdoutEnded`/`destroyStdio`（`commands.ts:69-84`）会作用在它上面。

**红/绿**
- 以上 R1–R20（含 R17b）在 master 上全部为红（无 `decide`、无生产者、无 store 审批方法）。
- 下列变异各须使对应用例变红，逐一临时施加并把失败输出记入 PR body：
  - 在 `onApproval` 内直接发布 request → R13；
  - 去掉 `markPending` → R14(a)；
  - 去掉某一路的 `clearPending` → R14 对应分支；
  - 审计移出结算事务 → R16(a)（行被写入）；
  - `decide` 按会话当前 slot 应答 → R17；
  - 超时回调按会话当前 slot 应答或发布 → R17b；
  - 去掉补发 → R19（出现没有 request 的 resolved）；
  - 「已发布」标志放到 `publish` 之后才置位 → R19（出现重复 request）；
  - emit 缺失时静默跳过审计而非抛错 → R20；
  - 去掉 CAS 条件 → R5/R6；
  - 作答不撤销计时器 → R7；
  - 单回合一个共享计时器 → R12；
  - `index.ts` 不传 emit → R9；
  - `shutdown` 不撤销 → R18。
- 恒绿守护：A7 与 Sibling surfaces 全部既有测试。

## Non-goals
见 proposal Non-goals。另外：空闲回收进行中转发来的审批，以及带 pending 审批因崩溃/infra 故障结束的回合，其结算只经进程退出，归 #474（carry-forward #573）。本刀不为它们写结算或发布，只在关停时撤销计时器。

## Review focus
1. 帧序发布：R13 的合并写入确实把两行放进同一 stdout 块；request 只发布一次，且不晚于 resolved。
2. 结算序与失败语义：事务（含审计）先于一切副作用；两个失败出口各自的状态保持。
3. 身份：发帧、`clearPending` 与发布一律取登记时捕获的 slot/generation，绝不按 `sessionId` 重新查找。
4. `onApproval` 与计时器回调在任何输入下同步、不抛；`onExit` 未被触碰。
5. 行数：`supervisor.ts` ≤755，实测 `wc -l` 记入 PR body；`approvals.ts` 不值导入 `./supervisor.js`，不经 `index.ts` 导出，knip 零新增。
