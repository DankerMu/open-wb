# Design: stop-dispatched-path（#473）

父设计：D2（停止 = `abort` + `stopped` + 有界退回）、D5（停止先 Deny 全部 pending 的理由：omp 的 abort 等待未应答 select）、D7（fake 场景行为）。本文只写落地到现有代码时被代码逼出的约束。

## Change surface
- **`turn-control.ts`**（68 → 约 170）：新增一个类（示意名 `TurnStops`）。构造时注入端口，对 `supervisor.ts` 无值导入：
  - `clock: SessionClock | undefined`：缺省系统时钟在本文件内定义，同 `approvals.ts:38-44` 先例；
  - `pending(slot): number[]`：审批快照，按 id 升序；
  - `deny(sessionId, approvalId): Promise<unknown>`：即 `ApprovalRegistry.decide(…,"deny")`；
  - `retire(slot): Promise<void>`：即 `#retireSlot`，永不 reject（carry-forward #595）。

  状态按回合 `assistantMessageId` 登记：`{ promise, timer, expired }`。方法（示意名）：
  - `stop(slot)`；
  - `expired(assistantMessageId)`；
  - `release(assistantMessageId)`：撤销计时并删登记。

  `OMP_ABORT_GRACE_MS = 8000` 为模块私有常量。
- **`supervisor.ts`**（749 → ≤780，硬上限 785）只接线：
  - 构造时传入 `options.runtime.clock`（与 pool/approvals/runtime 同一对象，`supervisor.ts:116-130,329`）；
  - 公开 `stop(sessionId)`：关停后 reject `agent_unavailable`；无 slot 或 `slot.claimedAssistantId` 为 undefined 时 resolve；否则委托 `TurnStops.stop(slot)`；
  - pump catch（`:466-481`）：`expired(assistantMessageId) ? applyStop(mapper) : applyFailure(mapper, …)`；
  - `pump.finally`（`:385-393`）：调 `release(assistantMessageId)`。
- **`approvals.ts`**（+约 8 行）：`pendingFor(slot)` 返回 `registration.slot === slot` 的 approvalId，升序（proposal 偏离 1）。

## stop(slot) 次序（governing invariant：每个回合恰一条路径发出 `turn.end`）
1. 取 `id = slot.claimedAssistantId`。已有登记 → 返回其 `promise`（偏离 4），此时尚未读快照、未调 `abort()`。否则同步登记后再进入任何 await。
2. `snapshot = pending(slot)`，只读一次，逐条 `await deny(slot.sessionId, approvalId)`。快照读取与第一条 `deny` 的调用都在 stop 的同步前缀内（`decide` 在首个 await 之前已同步写出应答帧，`approvals.ts:110-124,165-176`）：
   - `approval_settled`（快照后被并发作答）与 `not_found`（行已级联删除，同 `#expire` 的处理 `approvals.ts:149-155`）视为已结算，跳过；
   - 其它错误 → 删登记、以原错误 reject，不调 `abort()`（偏离 3）。
3. `const answer = slot.runtime.abort()`：
   - `false` → 删登记后返回（偏离 7）；
   - Promise → **同步** `answer.catch(() => {})`，然后 `timer = clock.setTimeout(onGrace, 8000)`，resolve。abort 帧此时已写出：`OmpProcess.request` 在调用内同步 `stdin.write`（`process.ts:245-249,335-353,371`）。
4. `onGrace`：置 `expired = true` → `void retire(slot)`。retire 调 `runtime.shutdown()`，后者经 `#failActiveTurn` 调 `stream.fail`（`runtime.ts:186-193,596-604`），pump 落入 catch → `applyStop` → `#commit`（`turn.end stopped` → `finishTurn(stopped)`）。
5. `release(id)`：由 `pump.finally` 调用，撤销 timer 并删登记。grace 内 `agent_end` 到达时，pump 正常结束，走的就是这条撤销路径。`setSessionFile` 失败路径（`supervisor.ts:370-377`）回执已兑现却不建 pump；若 stop 恰落在这里，由 `onGrace` 在无 pump 时自行删登记，避免泄漏。

## Must preserve
1. 既有失败路径不变：非「已退回」回合的 pump catch 仍走 `applyFailure`，即 `error` + `turn.end failed`（chat-sessions「Supervisor ordered persistence and publication」既有四个 Scenario）。
2. 被中断的回合不发 `error`：web `endTurn` 在 `stopped` 时清 error，依赖这一点（carry-forward #558）。
3. `turn.end` 恰一次，靠既有守卫 `!mapper.ended`（`supervisor.ts:467`）与 `applyStop`/`applyFailure` 的已终态静默（`events.ts:113-126`）。`FrameStream.fail` 先排空已入队帧再抛错（`prompt-stream.ts:57-64`），所以如果 grace 到期时 `agent_end` 已入队，归约器先发 `turn.end stopped`，catch 不会被触发。
4. 标记以 `assistantMessageId` 为键，不以 slot 为键：`#retireSlot` 一开头就释放 `claimedAssistantId`（`supervisor.ts:672-674`），退回后 pump 仍以自己的 id 查询 `expired`。
5. `onExit`/`#onProcessExit`（`supervisor.ts:320-322,345-350`）不变：不写 stdin，不调 `respondApproval`（carry-forward #573）。`#retireSlot` 永不 reject（`:675-677`）。
6. `decide` 的结算次序不变：事务 → `respondApproval` → `clearTimeout` → `clearPending` → 发布 resolved（`approvals.ts:165-184`）。stop 只是它的一个调用方，因此 Deny 帧与 resolved 都先于 `abort`。
7. 持久化失败不发布：`finishTurn(stopped)` 抛错时走 `#commit` catch（`supervisor.ts:504-509`）：`infraFaulted`、retain、retire，不发布 `turn.end`。原生收尾与退回两条路径共用这一处。
8. `rest.ts`、`store*.ts`、`events.ts`、`pool.ts`、`index.ts`、`omp/`、fake-omp 零 diff；`reconcileOnStartup` 只改 running（`store-approvals.ts:219-229`）。

## Sibling surfaces（既有测试一律零 diff 全绿；允许改动的既有测试：无）
- `session-supervisor*.test.ts`、`session-sse*.test.ts`、`session-rest*.test.ts`：没有 stop，`expired` 恒 false，pump catch 行为不变。
- `session-events-stop.test.ts`、`session-store-stopped.test.ts`（#455）：纯归约与 store 层，不经 supervisor stop。
- `session-approvals*.test.ts`（#464）：`pendingFor` 只读；`decide` 不变。
- `omp-runtime-commands.test.ts`（#488）：runtime 层，本刀不改 runtime。
- `session-rest-helpers.ts` 的 `SessionSupervisorPort` 桩（`rest.ts:15`）：端口不变，`stop` 由 #475 加入端口。

## Seams under test
- **Worlds**：`openApprovalWorld("approval")`（`session-approval-helpers.ts:85`），在首个 prompt 之前调 `world.rt.setScenario("abort-ok"|"abort-ignored"|"approval-then-abort"|"approval-parallel"|"approval-chain-abort-ignored")`（`session-supervisor-helpers.ts:118`）。spawn 是惰性的；`gateApprovals` 追加的 `--approval-mode write` 对非审批场景无效（`fake-omp.mjs:101-104`）。helper 提供的能力：
  - 真实 `createApp`→`registerSessions`；
  - 逐子进程 stdin 帧记录 `spawned[i].stdin`（`:139`）；
  - `timersDueAt`（`:120`）；
  - `onEvent` 观察（与 ring/SSE 扇出同一 `#publish`，`supervisor.ts:514-542`）。

  新 helper `session-stop-helpers.ts` 只组合这些，不改既有 helper。
- **公开端口**：唯一新增的是 `fixture.supervisor.stop(session)`。REST prompt 用 `prompted`/`postPrompt`；`GET /api/sessions` 与 messages 经 `fixture.app.inject`。
- **probe**：REST prompt `probe:<pid>:<writePath>`（`fake-omp.mjs:439-468`），从 assistant `content` 解析 `frames=`。
- **故障注入**：`fixture.db.exec` 建触发器（`session-approvals-faults.test.ts:40-44` 同法）；`assertRetainedFaultOnShutdown`（`session-supervisor-helpers.ts:592`）。
- **对账**：`fixture.app.close()`（不关 db）→ `seedSession/seedMessage/seedStep`（`session-store-helpers.ts:178-213`）→ `createSessionStore(fixture.db,{onFlushError}).reconcileOnStartup()` → 自行 `db.close()`，该 fixture 不进共享清理（#464 R18 先例）。
- **unhandledRejection**：用例内 `process.on("unhandledRejection", …)` 收集，结束时 `off`。
- 不 import `turn-control.ts`/`approvals.ts`，不访问私有字段。

## Required evidence（全部新建；T=开始 stop 时的注入时钟，`clock.nowMs` 固定于 `session-approval-helpers.ts:30` 的 T 起）
文件分配：`session-stop.test.ts` 放 S1–S6，`session-stop-faults.test.ts` 放 S7–S9（含 S8b）。「无 error」指该会话 `onEvent` 中无 `error`、无 `turn.end{failed}`。abort 帧一律按 `frame.type === "abort"` 计数：runtime 写出的是 `{type:"abort",id}`（`runtime.ts:239`），不得与 `{type:"abort"}` 做深相等。

| ID（Scenario） | 输入 | 期望 |
|---|---|---|
| S1 运行中停止 / 原生 abort 收尾 / 停止后继续对话 | `abort-ok`；`prompted` 202；等到两个 `text.delta`；T 时 `await stop(S)` | resolve 时 `spawned[0].stdin` 在 `prompt` 之后 `type==="abort"` 的帧恰一帧，会话行仍 running，`timersDueAt(T+8000)===1`。等到 `turn.end`：恰一个 `turn.end{messageId,status:"stopped"}`，无 error；`timersDueAt(T+8000)===0`；`timersDueAt` 须在 `waitForEvent`/`waitFor`（经 `setImmediate` 轮询）返回后读取，不在 `onEvent` 回调内同步读取，因为 `release` 在 `pump.finally` 中执行；`GET /api/sessions` 该会话 `stopped`，assistant `stopped`、content `"Hello from "`；子进程 `signalCode===null`，stdin 未结束。`advance(8000)`：仍存活，无新事件。再 REST prompt `probe:…`：202，body 键集恰为 `{userMessageId,assistantMessageId}`；回合 `done`，历史保留 `stopped` 助手；`frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`；`calls.length===1` |
| S2 忽略 abort 时有界退回 | `abort-ignored`；同 S1 至 stop；`advance(7999)`，再 `advance(1)` | 7999：子进程存活、stdin 未结束、`signalCode===null`，无 `turn.end`，会话 running。8000：stdin 已结束，子进程以 code 0 退出（EOF 即退出，`fake-omp.mjs:138-150`，5s/8s 升级是既有 retire 行为，不重证）；恰一个 `turn.end{stopped}`，无 error，退出后无新事件；会话与 assistant `stopped`，content `"Hello from "`（该脚本无步骤；步骤结算由 #455 store 用例证明）；`liveProcessCount()===0`；`world.errors` 为空；收集到的 unhandledRejection 为空；`fixture.close()` resolve |
| S3 先 Deny 后 abort | `approval-then-abort`；等到 1 行 pending 与 `approval.request`；`await stop(S)` | stdin 在 `prompt` 之后依次为 `{type:"extension_ui_response",id:"r1",value:"Deny"}`、`type==="abort"` 的帧（恰一帧）；`approval.resolved{decision:"deny"}` 先于唯一的 `turn.end{stopped}`，无 error；bash 步骤 `failed`，output `Tool call denied by user: bash`（即 `tool_execution_end{isError}`）。probe `frames=` 恰为 `negotiate_protocol,get_state,prompt,extension_ui_response,abort,prompt`；`calls.length===1` |
| S4 停止拒绝全部挂起审批 | `approval-parallel`；等到 2 行 pending；`await stop(S)` | stdin 依次为 Deny `r1`、Deny `r2`，然后 `type==="abort"` 的帧恰一帧；两个 `approval.resolved{deny}` 均先于唯一的 `turn.end{stopped}`；两步骤 `failed`；probe `frames=` 恰为 `…,prompt,extension_ui_response,extension_ui_response,abort,prompt` |
| S5a 同一回合二次停止 | `abort-ignored`；T 时 `Promise.all([stop(S),stop(S)])`；`advance(4000)`，第三次 `await stop(S)`；`advance(3999)`；`advance(1)` | 三次 stop 均 resolve；stdin 中 `type==="abort"` 的帧始终恰一帧；T+7999 仍无 `turn.end`，T+8000 退回，恰一个 `turn.end{stopped}`，无 error（grace 不被重布：若重布，T+8000 时尚未退回，用例变红） |
| S5b 二次停止不重复结算 | `approval-chain-abort-ignored`；`r1` pending 时 `await stop(S)`；等到 `r2` 行出现；`await stop(S)`；不推进到 grace | stdin 恰一帧 `extension_ui_response`（`r1` Deny）、`type==="abort"` 的帧恰一帧；`r2` 行 `decision` 仍 NULL，无 `r2` 的 `approval.resolved`。不断言 `r2` 与 `abort` 的先后，也不断言 `r2` 的终态（grace 之后归 #474） |
| S6 对账不触碰 stopped | S1 流程至会话 `stopped`（不跑 probe）；`app.close()`；读该会话三表行快照；seed 另一 running 会话（running assistant + running 步骤）；新 store `reconcileOnStartup()` | `stopped` 会话/消息行逐字段相等；seed 的三类 running 行变为 `failed` |
| S7 持久化失败不发布 | 触发器 `BEFORE UPDATE OF status ON chat_messages WHEN NEW.status='stopped' BEGIN SELECT RAISE(ABORT,'stopped settle blocked'); END`。(a) `abort-ok` 下 stop；(b) `abort-ignored` 下 stop，`advance(8000)` | 两路都满足：无 `turn.end`、无 error 事件；`world.errors` 恰含该消息一次；assistant 行仍 `running`；子进程被 retire；`assertRetainedFaultOnShutdown(fixture,'stopped settle blocked')`（WHEN 条件不拦 `close()` 的 failed 终结） |
| S8 Deny 结算失败不写 abort（偏离 3） | `approval-then-abort`，`r1` pending；建触发器 `BEFORE INSERT ON audit_events WHEN NEW.kind='session.approval'` 以 `RAISE(ABORT,'stop deny blocked')`；`stop(S)`；`DROP TRIGGER`；再 `await stop(S)` | 首次 reject，含该消息；stdin 无 `extension_ui_response`、无 `abort`；行 `decision` NULL；无 `approval.resolved`；会话 running。第二次 resolve：Deny 一帧、`type==="abort"` 的帧一帧，恰一个 `turn.end{stopped}`（证明标记已清除） |
| S8b CAS 未命中跳过（偏离 3） | `approval-parallel`；等到 2 行 pending 且两个 `approval.request` 均已发布；在同一同步段内 `const p = stop(S); void supervisor.decide(S, r2Id, "allow")`。stop 的 `decide(r1)` 在发布处 await 时，r2 先被作答结算：`requestPublished` 为 true，`#finish` 同步删登记（`approvals.ts:115-123,165-176`）；随后 stop 自己对 r2 的结算 CAS 未命中（`approval_settled`），被跳过 | `p` resolve；stdin 在 `prompt` 之后依次为 `extension_ui_response{id:"r1",value:"Deny"}`、`extension_ui_response{id:"r2",value:"Approve"}`，然后 `type==="abort"` 的帧恰一帧；恰一个 `turn.end`，状态为 `done`（fake 见 approvedAny 后 `finishTurn` 正常完成，`abortTurn="done"`，随后到达的 `abort` 不产生任何帧，`fake-omp.mjs:558-567,573-585,728-734`；`message_end{stopReason:"stop"}` → `turn.end done`），无 error；r1 步骤 `failed`、r2 步骤 `done`；每个 approvalId 恰一个 `approval.resolved`（r1 `deny`、r2 `allow`）；abort Promise 挂到进程退出后被拒绝，`fixture.close()` 期间收集到的 unhandledRejection 为空 |
| S9 关停后 stop | `await fixture.app.close()` 后 `stop(S)` | reject，code `agent_unavailable` |

**红/绿**
- 先红：S1–S5b、S7、S8、S8b、S9。master 上没有 `stop`，调用即为 TypeError/类型错误。
- S6 中「对账只动 running」是恒绿守护（`store-approvals.ts:219-229`）；它只因需要真实 stop 产出 `stopped` 行而在 master 上红。
- 下列变异各须使对应用例变红，逐一临时施加，失败输出记入 PR body：

| 变异 | 变红用例 |
|---|---|
| 先 `abort` 后 Deny | S3、S4（stdin 次序与 `frames=`） |
| 去掉去重 | S5a（两帧 `abort`） |
| 二次 stop 重读快照 | S5b（`r2` 被 Deny） |
| 二次 stop 重布 grace | S5a |
| grace 不随 `agent_end` 撤销 | S1（`timersDueAt`、`advance(8000)` 后被 retire） |
| 退回走 `applyFailure` | S2（出现 error + `turn.end failed`） |
| 去掉 abort Promise 的 catch | S2（收集到 unhandledRejection） |
| Deny 失败仍写 `abort` | S8 |
| Deny 失败不清标记 | S8 第二次 stop |
| CAS 未命中（`approval_settled`）时拒绝 stop | S8b（`p` reject，无 `abort` 帧） |
| 第一条 `deny` 不在同步前缀内调用 | S8b（stdin 中 Approve r2 先于 Deny r1） |
| grace 用真实 `setTimeout` | S2（7999/8000 不可控） |

- 恒绿守护：Sibling surfaces 列出的全部既有测试。

## Non-goals
见 proposal Non-goals。`abort()` 返回 `false` 的过渡分支（偏离 7）只经代码审查，不写测试。`deny` 的 `not_found` 跳过分支（行被级联删除）在运行中回合不可达：运行中的 assistant 行不会被删除，regenerate 只作用于非 running 会话。它同样只经代码审查（proposal 偏离 3）。

## Review focus
1. 恰一条 `turn.end`：`expired` 只在 grace 回调中置位；`applyStop` 只在 pump catch 中、`!mapper.ended` 守卫之下出现。
2. 次序：快照在任何 await 之前读取且只读一次；每条 `deny` 被 await 后才调 `abort()`；去重判定先于 `abort()`。
3. abort Promise 同步挂 catch；grace 与 retire 不产生未处理 rejection；`release` 在所有回合结束路径（pump.finally）与无 pump 的边角都会撤销 timer。
4. `supervisor.ts` ≤780（硬上限 785），实测 `wc -l`；`turn-control.ts` 对 `./supervisor.js` 只有类型导入或无导入；knip 零新增。
