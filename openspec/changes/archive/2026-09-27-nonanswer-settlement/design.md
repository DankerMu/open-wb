# Design: nonanswer-settlement（#474）

父设计：D5「结算路径枚举」「归属层与次序」、D7（`approval-chain-abort-ignored`）。本文只写落到现有代码时被代码逼出的约束。

## Change surface
- **`store-approvals.ts`**
  - `settlePendingForMessage(db, emit, messageId, decision: "deny", decidedAt): SettledApproval[]`，不自开事务，只在调用方的 owned 事务内运行：
    1. 按 `a.message_id = ?` 连 `chat_messages`/`chat_sessions`，读出 `decision IS NULL` 的行（`id ASC`，含 `session_id`、`owner_id`；`tool` 用 `CAST AS BLOB` 无损解码，同 `settlePendingApproval` `:134-160`）。
    2. 无行 → 返回 `[]`，不要求 emit。
    3. 有行且 emit 缺失 → 抛错。
    4. 否则逐条执行 `UPDATE … SET decision='deny', decided_at=? WHERE id=? AND decision IS NULL`（`requireChanges(…,1)`）→ `emit(db,{kind:"session.approval",actorId:owner_id,title:"工具执行审批",detail:{sessionId,messageId,tool,decision:"deny"}})`。
  - `finishOwnedTurn`（`:186-252`）：在同一 `runOwnedTransaction` 内，于 step 结算之后调用它，`decidedAt = now`（`:197`）；事务成功后才把结果交给调用方。参数多时收成一个对象，由实现者决定。
  - 对账：`store.ts` 的对账事务（`store.ts:514-518`）内，先对 `role='assistant' AND status='running'` 的每条消息调用它（`decidedAt` 为对账时刻），再 `reconcileStatuses` ×3（`:270-280`）。顺序不能反：先翻转状态就找不到 running 消息。
  - knip：`settlePendingForMessage` 只在 `store.ts` 直接调用它时才 `export`；若对账也收进 `store-approvals.ts` 的一个导出辅助，它就保持模块私有（「新模块 SHALL 不新增未被引用的导出」）。
- **`store.ts`**
  - 导出类型 `SettledApproval`；`SessionStore.finishTurn(id, status, settled?: SettledApproval[]): boolean`（`:143`）。
  - `finishTurn`（`:499-507`）、`close()`（`:564-576`）、`reconcileOnStartup()`（`:509-519`）传入 `options.emit`；`close()` 与对账不回报。
- **`turn-control.ts`**：`persistEvent`（`:174-225`）加一个参数 `settled: SettledApproval[]`，只在 `turn.end` 分支转交给 `finishTurn`（`:222`）。它唯一的调用方是 `supervisor.ts:525`，测试里没有直接调用（`grep -rn persistEvent server/test` 为空），所以可设为必填参数。
- **`approvals.ts`**
  - `settled(entries): Promise<boolean>`：对每条有登记的条目，依 `#finish`（`:176-195`）去掉 `respondApproval` 后的次序执行 `clearTimeout` → `clearPending` → 若 `!requestPublished` 则先补发 request → 删登记 → `#emit` resolved；`#emit` 返回 false 时立即返回 false。无登记的条目只落库，不发布（下文 Governing invariant 说明其不可达）。
  - `close()`（`:138-143`）改为只撤销计时器、保留登记（proposal 偏离 1）。
- **`supervisor.ts`**（只改 `#commit` `:515-543`）：每个事件建一个空数组传给 `persistEvent`；**数组非空时**才 `await this.#approvals.settled(settled)`，返回 false 即 `return false`；然后照旧发布该事件（`turn.end`）。

## Governing invariant
任一回合的终态事务提交时，该 assistant 消息的全部 `decision NULL` 审批在同一事务内变为 `deny`，每条恰有一条审计；有 ring 时，每条 `approval.resolved{deny}` 在提交之后、`turn.end` 之前进入该 generation 的 ring；不向子进程写任何帧，对应计时器已撤销。

**settle-before-seal（三条有 ring 的路径同一证明）**：
- `#sealGeneration` 要求 `pumpCount === 0`（`supervisor.ts:689-700`）。
- `pumpCount` 只在 `pump.finally` → `#releasePump`（`:407-409`、`:676-687`）中递减，而 `pump.finally` 晚于 catch 中的 `#commit`（`:490-505`）。
- 崩溃时 adapter `revoke`（`:655-662`）与有界退回、关停时 `#retireSlot`（`:709-713`）都只置 `revoked`，`#sealGeneration` 在 `pumpCount > 0` 时提前返回。
- 因此终态提交、resolved、`turn.end` 都落在未封口的 ring 上，`#emit` 的封口闸（`approvals.ts:204-210`）放行。
- 没有 pump 提交终态的回合（infraFaulted、未派发）只由 store `close()`/对账结算，此时无 ring，不发布。

**终态时有登记**：
- 登记只在当前回合 `turn.sent` 后转交（`runtime.ts:541-550`）；
- `#failTurn` 先置空 `#turn` 再让流失败（`runtime.ts:598-605`），所以终态之后不会再有新登记；
- 关停保留登记（proposal 偏离 1），pump catch 能找到它们。

## 路径（全部经 pump catch 或 store）
| 路径 | 触发 | 终态提交 | 有 ring |
|---|---|---|---|
| 崩溃、空闲回收中途退出 | `#onLogicalExit` → `#failTurn`（`runtime.ts:564-574`） | pump catch `applyFailure` → `finishTurn(failed)` | 是 |
| 有界退回 | `TurnStops.#expire` → retire（`turn-control.ts:153-159`） | pump catch `applyStop` → `finishTurn(stopped)` | 是 |
| 优雅关停 | `shutdown` → retire → `runtime.shutdown` `#failActiveTurn`（`runtime.ts:186-193`） | pump catch → `finishTurn(failed)`；兜底 store `close()` | 是；兜底否 |
| 启动对账 | `registerSessions` → `reconcileOnStartup`（`index.ts:50`） | 对账事务 | 否 |

**#605 残留来源**：W1/W4 无 slot 的 stop 跳过 Deny 快照；W3 live slot 的快照含前一回合残留登记；兑现路径从不 Deny；快照之后新到达的审批（`r2`）。
- 前、后两类残留，若 `abort` 挂在 select 上，最终走有界退回 → `finishTurn(stopped)` 结算。
- W3 的来源被消除：任一终态（含 `done`，proposal 偏离 3）都会删掉该消息的登记，`pendingFor(slot)` 不再含前一回合残留。

## Must preserve
1. `finishTurn` 仍返回 `boolean`，两参调用语义不变（约 50 处 `toBe(true)`/`toBe(false)`）。stale/inactive 仍返回 false，不结算。
2. 缺 emit 只在确有待结算行时抛错（`store-approvals.ts:155-157` 先例）。
3. `#commit` 只在回报非空时多一次 await。普通帧的 pump 微任务轮廓不变（carry-forward #603：`TurnStops.#run` 依赖 decide/#finish/#publish 只经微任务）。
4. 终态路径不调用 `respondApproval`，不写 stdin；`onExit`/`#onProcessExit`（`supervisor.ts:342-344,367-372`）不变（carry-forward #573）。
5. resolved 只经 registry `#emit` → `#publish`，不经 `persistEvent` 的返回值（carry-forward #453）。
6. `decide`、`#expire`（CAS 未命中时静默清理，`approvals.ts:150-173`）与 stop 的 `skipSettled`（`turn-control.ts:163-172`）不变：它们与终态结算的竞争一律由同一 CAS 裁决。
7. 持久化失败不发布：终态事务（含审计）失败 → `#commit` catch（`supervisor.ts:535-540`），不发 resolved，也不发 `turn.end`。
8. 对账只动 running，`stopped` 与其它终态行不变（#473 S6 守护）。`shutdown()` 次序不变（`supervisor.ts:220-239`）。

## Sibling surfaces
**必然受影响的既有测试（允许改动恰一处）**：
- `session-approval-snapshot.test.ts:163,185,240`（S2/S3/S5）：`withSessionRest` 的 `store.close()`（`session-rest-helpers.ts:65`）会结算 pending 行，缺 emit 时抛错。**允许的改动**：`session-rest-helpers.ts:52-56` 的 `createSessionStore` 加 `emit`（值导入 `../src/core/audit/index.js`），不改任何断言。

**行为变化但断言不变（零 diff，须全绿）**：
- `session-approvals-faults.test.ts:190` R16b：关停时 store `close()` 结算会撞上仍在的审计触发器而抛错，`app.close()` 的 AggregateError 多一条同名错误；`containsMessage` 会递归 `errors`（`session-supervisor-helpers.ts:576-590`），断言成立。
- `:216` R17：迟到作答变为 `approval_settled`，用例本就 `.catch`。
- `:251` R17b：A1 计时器已撤销，断言更强地成立。
- `:313` R18：行变为 `deny`，但「无 `timeout` 行」「无帧」「无 onError」均成立。
- `session-approval-rest.test.ts:563` E14：`shutdown()` 已把行结算为 `deny`，`rowBefore` 在关停后读取，502 且行与审计计数不变，成立。
- `session-supervisor-pool.test.ts:232` A7：生产装配有 emit，关停时以 `deny` 结算，无相关断言。
- `session-stop.test.ts` S5b（`:271`）：`r2` 在关停前断言为 NULL，成立。S6（`:299`）：无 emit 对账，但库中没有 pending 行，成立。
- `session-stop-faults.test.ts` S7/S8/S8b：S8 的触发器在第二次 stop 前已删除，其余用例没有残留 pending 行。
- 全部 `session-store*.test.ts`、`sqlite-text.test.ts`、`core-db-chat-step-output.test.ts`：无审批行，两参 `finishTurn` 不变。

## Seams under test
- store 级：`openDb(":memory:")` + 公开入口 `createSessionStore(db,{onFlushError,emit})`（同 `session-store-approvals.test.ts:35-87`）。行经 `insertApproval`/`settleApproval` 写入；对账用 `seedSession`/`seedMessage`/`seedStep`（`session-store-helpers.ts:178-213`）加内联 SQL 插入审批行；时间用 `withFakeClock(R, …)`（`:160`）固定；故障用 `db.exec` 建触发器（R16 同法）。
- supervisor 级：`openApprovalWorld`（`session-approval-helpers.ts:85`，内含 `gateApprovals` 注入 `write`）与 `openStopWorld`（`session-stop-helpers.ts`）。
  - 观察面：`spawned[i].stdin`、`timersDueAt`、`world.events`（onEvent）、`approvalRows`/`approvalRow`、`pendingApproval`、`waitForTurn`。
  - 崩溃：`spawnedAt(world,0).child.kill("SIGKILL")`，同 R17 的 `killFirst`。
  - **ring 证据**：在失败发生前调用 `fixture.supervisor.subscribe(session, null, deliver)`，只有推入 ring 的事件才会经 `#fanout` 到达（`supervisor.ts:550-556`）；`onEvent` 在封口时也会被调用，不能单独当作 ring 证据。关停路径的订阅者在一开始就被清空（`:223`），证据只能是 onEvent 次序加上 settle-before-seal 论证。
  - 对账：`openApprovalWorld(…,{prepare})`，`prepare` 在 `createApp` 之前运行（`session-supervisor-helpers.ts:163`）。
  - 重启快照：`app.close()` 不关 db，再对同一 db 新建 `createSessionStore(db,{onFlushError,emit}).getMessages(session,"u1")`，然后自行 `db.close()`（R18 先例）。
  - 409：REST `POST /api/sessions/:id/approvals/:approvalId` inject。
  - 不 import `approvals.ts`/`turn-control.ts`/`store-approvals.ts`，不访问私有字段。

## Required evidence（T = 世界时钟起点 `session-approval-helpers.ts:30`；R = store 级固定的 `Date.now`）
文件分配：`session-store-settlement.test.ts` N1–N5；`session-settlement.test.ts` C1–C5；`session-settlement-stop.test.ts` B1–B3；共享的 subscribe/审计读取/杀进程放 `session-settlement-helpers.ts`。「审计行」一律按 `kind='session.approval'` 计。

| ID（Scenario） | 输入 | 期望 |
|---|---|---|
| N1 Terminal settlement（finishTurn） | 对 `failed`/`stopped`/`done` 各一轮：`u2` 会话受理；`insertApproval` r1、r2、r3（T）；`settleApproval(r3,"allow",T+1)`；`withFakeClock(R)` 下 `finishTurn(id,status,settled)` | 返回 `true`；r1、r2 为 `deny`/`R`，r3 仍 `allow`/`T+1`；新增审计恰 2 条，`actor_id="u2"`、`detail` 恰为 `{sessionId,messageId,tool:"bash",decision:"deny"}`；`settled` 恰为 `[{messageId,approvalId:r1,decision:"deny"},{…r2…}]`；assistant、会话为 `status`。另：两参调用同样结算并返回 `true` |
| N2 close 结算 | 同上 pending ×2 + allow ×1，回合活跃；`withFakeClock(R)` 下 `store.close()` | assistant、会话 `failed`；两行 `deny`/`R`；审计 +2；allow 行不变 |
| N3 审计失败整体回滚 | 先 `startStep` 造一条 running 步骤（N1 输入之上）；触发器 `BEFORE INSERT ON audit_events WHEN NEW.kind='session.approval'` `RAISE(ABORT,'terminal audit blocked')`；(a) `finishTurn(id,"failed",settled)`；(b) `close()`；每次之后 `DROP TRIGGER` 再重试 | 抛错且含该消息；assistant、会话、running 步骤仍 `running`；审批仍 NULL；无新审计；`settled` 仍为 `[]`；删触发器后重试成功并结算（「explicit finish/close may retry」） |
| N4 缺 emit | 不传 emit 的 store：(a) 无审批行时依次 `reconcileOnStartup()` → 受理并 `finishTurn(done)` → 再受理一回合后 `close()`（`close()` 之后 store 已关闭，故放在最后）；(b) 另一个无 emit 的 store 在有 pending 行时 `finishTurn(failed)` | (a) 全部成功（恒绿守护）；(b) 抛错，状态与审批行均未提交，无审计 |
| N5 对账（Startup reconciliation） | 种入：`u2` 的 running 会话 + running assistant + running 步骤，带 pending p 与 `allow` a；另一 `stopped` 消息带一条 NULL 行 q；`done` 消息带 `deny` 行。`withFakeClock(R)` 下新 store `reconcileOnStartup()`。再建一库加审计触发器做同样对账 | p 为 `deny`/`R`；a、q 与 done 行逐字段不变；审计恰 1 条，`actor_id="u2"`、`decision:"deny"`；三类 running 行变为 `failed`。触发器库：抛错，无任何状态或决定被提交 |
| C1 崩溃（崩溃与对账不留 pending / Settlement without a child answer） | `approval`；`pendingApproval`；subscribe；记录 `before=Date.now()`；SIGKILL；`waitForTurn(failed)` | 行 `deny`，`decided_at ∈ [before, Date.now()]`；审计恰 1 条 `deny`，actor 为 owner；`responses(spawned[0])` 为 `[]`；onEvent 中 `approval.resolved{messageId,approvalId,decision:"deny"}` 与 `error` 均先于唯一的 `turn.end{failed}`；live 订阅者收到 resolved，其索引小于 `turn.end`；`timersDueAt(T+60000)===0`；再 `advance(60000)`：无 `timeout` 行、无新审计、无新事件、无帧；快照该审批 `decision:"deny"` |
| C2 作答与进程退出竞争 | C1 至 `failed` 后，REST 作答 `{decision:"allow"}` | 409 `{error:{code:"approval_settled",message:"该审批已处理"}}` 且 no-store；行仍 `deny`，`decided_at` 不变；审计仍 1 条；`responses` 仍为 `[]`；无新 `approval.resolved` |
| C3 并行崩溃 | `approval-parallel`；两行 pending、两个 request 已发布；subscribe；SIGKILL | 两行 `deny`；审计 2 条；两个 resolved 按 approvalId 升序，均先于唯一的 `turn.end{failed}`（onEvent 与 live 订阅均如此）；`timersDueAt(T+60000)===0` |
| C4 优雅关停（优雅关停结算挂起审批 / Shutdown ordering and isolation） | `approval-parallel`；两行 pending；`await fixture.app.close()`（不关 db） | 两行 `deny`，`decided_at` 非空；审计 2 条；`responses` 为 `[]`；onEvent 中两个 resolved 先于唯一的 `turn.end{failed}`；`world.errors` 为空；`advance(120000)` 后无变化；新 store 读 `getMessages(session,"u1")`，两条 approvals 均为 `decision:"deny"` |
| C5 对账（Reconcile before route acceptance） | `openApprovalWorld("approval",{prepare})`，`prepare` 种入 `u1` 的 running 会话，带 pending p 与 `allow` a；记录 `before`/`after` 包住 open | p 为 `deny`，`decided_at ∈ [before,after]`；a 不变；审计恰 1 条（actor `u1`）；`world.events` 中该会话无事件；REST GET messages 中 p 为 `decision:"deny"`，会话 `failed` |
| B1 有界退回（Stop bounded-retire exception） | `openStopWorld("approval-chain-abort-ignored")`；`prompted`；等 r1 行与 request；subscribe；T 时 `await stop(S)`；等 r2 行与第 2 个 request；断言 r2 为 NULL 且 `timersDueAt(T+60000)===1`；`advance(7999)`；`advance(1)` | 7999：无 `turn.end`，会话 running。8000：恰一个 `turn.end{stopped}`，无 error；r1 `deny`（stop）、r2 `deny` 且 `decided_at` 非空；审计恰 2 条 `deny`；`afterPrompt(stdin)` 中 `extension_ui_response` 恰一帧且为 `{id:"r1",value:"Deny"}`，`type==="abort"` 恰一帧，不断言 r2 与 abort 的先后；两个 resolved 均先于 `turn.end`（onEvent 与 live 订阅）；会话、assistant 为 `stopped`，r2 所属步骤为 `stopped`；子进程以 code 0 退出（EOF 即退出，不在 hang 集，`fake-omp.mjs:138-150`；carry-forward #470），退出后 `settle()` 无新事件；`timersDueAt(T+60000)===0`；`liveProcessCount()===0`；无 unhandledRejection。不做 probe |
| B2 停止先 Deny（先 Deny 后 abort；Stop is accepted … 审批 WHEN） | `approval-then-abort`；`pendingApproval`；REST `POST /stop` | 202 `{}`；行 `deny`；审计恰 1 条；stdin 在 `prompt` 之后依次为 Deny r1、abort；resolved 先于 `turn.end{stopped}`（probe 帧序由 #473 S3 证明） |
| B3 停止拒绝全部挂起审批 | `approval-parallel`；两行 pending；REST `POST /stop` | 202；两行 `deny`；审计 2 条；两个 resolved 先于 `turn.end{stopped}` |

**红/绿**
- 先红：N1–N3、N4(b)、N5、C1–C5、B1。master 上结算不存在（行仍为 NULL，或 C2 返回 200），类型检查也因第三参数而失败。
- 恒绿守护：N4(a)、B2、B3（行为由 #464 `decide` 与 #473 交付，本刀只推进 spec 并补证据），以及 Sibling surfaces 列出的全部既有测试。
- 下列变异各须使对应用例变红，逐一临时施加，失败输出记入 PR body：

| 变异 | 变红用例 |
|---|---|
| 结算移出终态事务（先提交终态再结算） | N3 |
| 缺 emit 时静默跳过 | N4(b) |
| 有行时才要求 emit 改为总要求 | N4(a) |
| 对账先 `reconcileStatuses` 再结算 | N5、C5 |
| 对账结算非 running 消息 | N5（q 被改） |
| resolved 在 `turn.end` 之后发布 | C1、C3、B1 |
| 终态收尾不撤销计时器 | C1、C3、B1（`timersDueAt`） |
| 终态收尾调用 `respondApproval` | 实测存活，改为只经代码审查：所有可达终态路径上 stdin 已关闭（`#runRetire` 同步 `closeStdin`）或 generation 已清空，`process.ts` 的 `respondApproval` 守卫丢弃写入，stdin 层不可观测；抓它需 spy runtime，违反「不 mock 被测系统」 |
| `close()` 仍清空登记 | C4（无 resolved） |
| `finishTurn` 只对 failed/stopped 结算 | N1 的 `done` 轮 |
| supervisor 不接回报（只 store 落库） | C1（无 resolved） |

## Non-goals
见 proposal Non-goals。无登记条目的「只落库不发布」分支只经代码审查，理由见 Governing invariant。request 补发分支在终态路径上同样不可达：select 帧会先被 pump 排空处理（`prompt-stream.ts:57-64`），只经代码审查。终态收尾对**仍存活的 runtime** 调用 `clearPending` 也只经代码审查：冻结的 fake 里没有「存活进程上回合以 pending 审批结束」的场景（C1/C3 子进程已死，B1/C4 runtime 已 retiring，`runtime.ts` 的 `#resetIdle` 直接返回），因此「`settled()` 漏掉 `clearPending`」变异无用例能抓；后果是真实 omp 原生 stop 后迟到的 select 使该进程 idle 永久暂停。

## Review focus
1. 同事务：`settlePendingForMessage` 在 `finishOwnedTurn` 与对账的同一 `runOwnedTransaction` 内调用；审计失败使终态整体回滚；只在提交后回报。
2. 次序：`#commit` 中 `persistEvent` → 回报非空才 await `settled` → 发布 `turn.end`；resolved 只经 `#emit`；无任何 stdin 写入。
3. 登记生命周期：`close()` 保留登记；终态收尾撤销计时器、`clearPending`、删登记；`decide`/`#expire` 与之竞争时由 CAS 裁决。
   - `clearPending` 检查项（无测试证据，见 Non-goals）：终态收尾对每个被结算的登记都调用其 runtime 的 `clearPending(approvalId)`，与 `decide`/`#expire` 路径相同；对已 retiring/已死 runtime 调用为无害空操作。
4. 兼容：`finishTurn` 仍返回 boolean；缺 emit 只在有行时抛错；既有测试只改 `session-rest-helpers.ts` 一处。
5. 行数：`supervisor.ts` ≤790（硬上限 798），实测 `wc -l` 记入 PR body；`approvals.ts`/`turn-control.ts` 对 `./supervisor.js` 无值导入；knip 零新增（`SettledApproval` 被 `turn-control.ts`、`approvals.ts` 引用）。
