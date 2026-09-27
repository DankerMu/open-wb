# Design: stop-intent（#490）

父设计 D2 第一条（冷启动窗口内的停止意图；「进入 stop 时读取的 pending 快照必为空，故直接 `abort`」）。本文只写落到当前代码（HEAD `6e326f1`）时被代码逼出的约束。

## 派发前的四个窗口（为什么意图不能按 slot 查）
REST prompt 在 `acceptPrompt` 之后同步调用 `supervisor.prompt`（`rest.ts:148-150`），所以 store 进入 running 与 `#prompt` 进入是同一个同步段。之后、派发回执的 owner 续体（`supervisor.ts:380` 之后）之前，有四个真实等待窗口：
- **W1 等上一进程退役**：`#prompt` 在 `:260-261` `await existing.retiring`，此时还没有 claim。
- **W2 准入**：`#dispatchNew` 在 `:313` 登记 claim，`:316` await `pool.admit`；slot 的 runtime 在 `:353` 之前只是占位（`:303`），`#slots.set` 在 `:354`。
- **W3 获取/握手**：slot 已在 `#slots`，`runtime.abort()` 因 `!turn.receiptSettled` 返回 `false`（`runtime.ts:226-240`）。
- **W4 重新准入**：live 路径派发回执以 `ReadmissionRequired` 拒绝后，`:282` `await this.#retireSlot(live)` 先释放 claim（`:698-701`），再 `:287` 为**同一回合**走 `#dispatchNew`（新 slot、新 generation）。W4 内 claim 在 `#retireSlot` 的同步前缀里释放（`:699-701`），`#slots` 要到 `await slot.retiring` 之后才删（`:712-714`），因此此刻 `#claims.get(turn)` 为空、`#slots.get(sessionId)` 仍是 live：新 `stop()` 走与 W1 相同的「无 slot」分支（决定 2），证据等价于 I7，不单独构造（该间隙只有退役一个已死 runtime 的时长，无确定性手段停住它）。I6 证明的是另一件事：W3 登记的意图跨过 W4 仍在新 slot 上兑现。

当前 `stop()`（`:207-217`）经 `#slots.get(sessionId).claimedAssistantId` 查回合：W1、W2、W4 里查不到（或查到退役中的旧 slot，其 claim 已释放），直接 resolve；W3 里 `TurnStops.#run` 在 `false` 分支删登记后返回（`turn-control.ts:90-94`，#473 偏离 7）。四个窗口全是空操作。

## 决定
1. **意图按回合（`assistantMessageId`）登记，不按 slot/generation。** W1/W2 没有 generation；W4 同一回合换了 slot 与 generation。`chat_messages.id` 是 `AUTOINCREMENT`（`034_chat_turn_control.sql:44`），进程内不复用。「同一 generation」由兑现时机保证：兑现调用的是**产出该回执的 slot** 的 `runtime.abort()`，runtime 自身以 `gen.id === turn.genId`、未退役、子进程存活为闸（`runtime.ts:229-236`），abort 只会落到承载该 prompt 的 generation。
2. **`stop(sessionId)` 的回合来自 store，slot 来自 claim。** `#closed` 仍先判（S9 不变），然后 `turn = store.runtimeState(sessionId)?.activeTurn?.assistantMessageId`（内存活跃回合，`store.ts:527-548`）；无 → resolve。`slot = #claims.get(turn)`，只有 `#slots.get(sessionId) === slot` 时才交给 `TurnStops`，否则按「无 slot」处理：W2 的占位 runtime 永不被解引用，W1/W4 没有 claim。
3. **`TurnStops` 增加回合阶段标记**（示意名 `open(id)`，内部 `dispatching | dispatched`），它就是 #601 评审规则里的 owner 标志，同时决定「无 slot 的 stop」要不要登记意图：
   - `#prompt` 在 `:255-258` 首次 claim 检查通过后立即 `open(id)`（W1 的 await 之前）；`open` 只在该回合尚无标记时记为 `dispatching`，不把 `dispatched` 退回；
   - 派发回执续体里置 `dispatched`（见决定 5）；
   - 清除只在两处：`pump.finally` 已有的 `release(id)`（`:407`），与 `#prompt` 外层 catch（`:289-291`）。`:263-265`（已关停）与 `:266-268`（并发重复 prompt 抢到 claim）两个 throw **不清**：前者 stop 已被 `#closed` 拒绝，残留标记惰性；后者的标记属于抢到 claim 的那次调用，清掉会让它的意图丢失（经 REST 不可达：`acceptPrompt` 对 running 会话抛 `session_busy`）。
   - 有了标记，「store 仍 running、无 claim、无在途派发」（如 #473 S7：`finishTurn(stopped)` 失败后行停在 running）的 stop 仍是空操作：标记已在 `pump.finally` 清掉，不会留下悬挂意图。
4. **`#run` 的 `false` 分支**（slot 缺省时 deny 快照为空、`answer` 视为 `false`）：
   - 标记为 `dispatching` → `entry.intent = true`，登记保留，stop resolve（resolve 即意图已登记）；
   - 否则（`dispatched`：回执后取得的 `false`，子进程已死或退役中；或无标记）→ 只删该回合的停止登记与计时（下称「丢弃」），**不删阶段标记**（pump 仍在，`expired()` 仍须可查）。
   - 既有 deny 失败分支（`:86-89`）同样改为「丢弃」。
5. **兑现在 pump 登记之后，丢弃在请求级失败。** 兑现调用（示意名 `dispatched(slot, id)`）放在 `#bindDispatch` 成功路径末尾，即 `slot.pump = pump` / `#pumps.add` / `pump.finally` 登记之后（`:401-413` 之后）。这样 `setSessionFile` 失败（`:389-396`，回执已兑现但派发失败）不会写出 `abort`。它同步、不抛：置 `dispatched`；若有意图 → 清 intent → `slot.runtime.abort()`：
   - `false` → 丢弃（恰重试一次，不再等待）；
   - Promise → 走与 `#run` 相同的尾段：同一同步段内挂 `.catch`，以注入时钟布 `OMP_ABORT_GRACE_MS`。
   `abort()` 不会同步抛错（`process.ts:335-353` 全在 Promise executor 内）。丢弃放在 `#prompt` 外层 catch，而不是 `#bindDispatch` 的回执 catch（`:381-388`）：W4 的 `ReadmissionRequired` 拒绝之后同一回合还会再派发一次。
6. **兑现不重读审批快照、不再 Deny（父 issue 问题 4）。** 父文写的是「立即对同一 generation 再次调用 `abort()`」，父 D2 写明「进入 stop 时读取的 pending 快照必为空」。代码事实：审批只在 `turn.sent` 之后转交 owner（`runtime.ts:541`），`sent` 在写 prompt 之前置位（`:296-297`），回执在写回调里兑现（`:298`，`process.ts:369-377`）。小 prompt 的管道写同步完成，其回调经 nextTick 延后，owner 续体在任何 stdout I/O 之前运行，select 不可能先登记。只有 prompt 写被背压（管道缓冲满）时 select 才可能抢先；那时 `abort` 遇到未应答的 select，回合走 #473 的有界退回，残留审批由 #474 结算。列为 Open question，不测。`TurnStops.#run` 与续体都不引入真实 await，#603 记下的「deny 循环后无复查」前提不变。

## Must preserve
1. #473 已派发路径逐字不变：Deny 快照 → `abort` → grace → `applyStop`（`:505-509`）；二次 stop 返回同一 Promise；`expired` 只在 grace 回调置位；`#expire` 的 `slot.pump === undefined` 分支不变（意图路径的 grace 只在 pump 存在后才布）。
2. 意图路径不发 `error`、不直接 `finishTurn`：`turn.end` 只由 pump 发出（`:471-501`，`!mapper.ended` 守卫）。
3. 无意图时，获取/派发失败路径逐字不变：`#bindDispatch` 两个 catch、`#abortPreProgress`、`#translate`（`:381-396,416-420,730-741`），REST `rollbackPrompt`（`rest.ts:151-153`）。
4. abort Promise 在返回它的同一同步段内挂 catch；帧按 `type === "abort"` 计数（runtime 写 `{type:"abort",id}`，`runtime.ts:239`）。
5. `#retireSlot` 永不 reject（`:698-715`）；`onExit`/`#onProcessExit`（`:339-341,364-369`）不写 stdin。
6. `rest.ts`、`store*.ts`、`events.ts`、`pool.ts`、`approvals.ts`、`index.ts`、`omp/`、`app.ts`、web、`server/test/support/fake-omp*.mjs`（793/800，不加场景）零 diff。

## Sibling surfaces（既有测试一律零 diff 全绿；允许改动的既有测试：无）
- `session-stop.test.ts` S1–S6、`session-stop-faults.test.ts` S7–S9（#473）：全是已派发路径，`stop()` 改为 store+claim 取回合后，这些用例里 `#claims.get(turn) === #slots.get(session)` 恒成立，行为不变；S7 故障后再 stop 仍是空操作（决定 3）。它们是本刀的恒绿守护。
- `session-supervisor*.test.ts`、`session-sse*.test.ts`、`session-rest*.test.ts`、`session-approval*.test.ts`：不调用 `stop`；`open`/清除标记对它们不可观察。
- `omp-runtime-commands.test.ts`（#488 A3）：runtime 层，本刀不改 runtime。
- `session-rest-helpers.ts` 的 `SessionSupervisorPort` 桩：不变（`stop` 进端口归 #475）。

## Seams under test
- **世界**：`openStopWorld("abort-ok")`（`session-stop-helpers.ts:53`），首个 prompt 之前 `world.rt.setScenario(<scenario>)`（`session-supervisor-helpers.ts:118`；`StopScenario` 只是类型，`setScenario` 收任意字符串）。可用场景：`slow-ready`、`abort-ok`、`abort-ignored`、`normal`、`crash`、`hang-eof`、`no-ready-hang`。复用 `session-stop-helpers.ts` 的 `stop`/`abortCount`/`afterPrompt`/`turnEnds`/`expectNoError`/`history`/`listedStatus`/`probeFrames`/`collectRejections` 与 `session-approval-helpers.ts` 的 `spawned[i].stdin`、`timersDueAt`、`waitForEvent`、`settle`、`rejection`，全部原样使用。
- **同步窗口**：`fixture.store.acceptPrompt(session, OWNER_ID, text)` → `const pa = fixture.supervisor.prompt(session, text)` → 同一同步段 `const sa = fixture.supervisor.stop(session)`（与 `rest.ts:148-150` 同序）。冷会话下此刻位于 W2，调用返回时 `spawned.length === 0` 必须**同步**断言。
- **运行时参数**：supervisor 持有的是 `world.rt.runtime` 同一对象（`app.ts:150-154` → `index.ts:46`），每次派发时读取（`supervisor.ts:345-351`），所以可在 open 之后以 `Object.assign(world.rt.runtime, { handshakeTimeoutMs: 1_000 })` 设置握手时限（`RuntimeOptions` 类型没有该字段，`session-supervisor-helpers.ts:30-40`，直接赋值不过类型检查），或包一层 `world.rt.runtime.spawnImpl` 追加 `--ready-delay-ms <n>`。握手超时是真实 `setTimeout`（`process.ts:700-706`），不受注入时钟控制；超时经 `#failStartup` 直接 SIGKILL 子进程（`process.ts:663-686`），`no-ready-hang` 无从忽略，F1 无需推进时钟。退役升级走注入时钟：stdin 关闭后 TERM@5000（`commands.ts:7-9`），`hang-eof` 忽略 EOF、不拦 TERM（`fake-omp.mjs:138-156`），一次 `advance(5000)` 即退出（先例 A8 `session-supervisor-pool.test.ts:258-297`）。
- **驱逐世界**（I7）：`createRealFakeRuntime("hang-eof")` + `openRecordingSession({...rt.runtime, maxProcesses: 2})` + `createSession`（`session-supervisor-helpers.ts:88,210,303`；先例 `session-supervisor-pool.test.ts:258-297` A8）。注入时钟冻结时 `lastActive` 全相等，按准入序选牺牲者（`pool.ts:144-160`）；有 claim 的 slot `busy()`（`supervisor.ts:317`）。probe 用同一写法（REST `probe:<pid>:<path>`，从 assistant content 取 `frames=`）。该世界没有 `spawned[i].stdin`（`session-approval-helpers.ts:139` 的 `recordStdin` 未导出）：新 helper 在 `openRecordingSession` 之前包一层 `rt.runtime.spawnImpl`，照 `omp-runtime-exit-pending.test.ts:123-137` 的 `tapStdin` 逐子进程记录 stdin 帧。
- `hang-eof` 用例在 `finally` 里对仍存活的子进程 SIGKILL 再 `close()`，否则断言失败时退役卡在注入时钟上（A8 先例 `session-supervisor-pool.test.ts:291-295`）。
- 新 helper 文件只组合上述能力；不 import `turn-control.ts`，不访问私有字段。

## Required evidence
T 为注入时钟起点（`session-approval-helpers.ts:30`）。`timersDueAt(T+8000)` 不能单独代表 grace：`SHUTDOWN_BUDGET_MS` 同为 8000（`commands.ts:9`），子进程原生退出而 stdout 未关时 `watchHeldPipe` 以它布排空计时（`commands.ts:159-174`，`runtime.ts:553-555`），退役排空同样用它。所有 `timersDueAt(T+8000)` 断言（I1、I3、I4、I5）都在 `waitFor`/`settle()` 返回、`pump.finally` 已执行且子进程状态已稳定后读取；I5（崩溃）与退役后的读数须先等 `liveProcessCount() === 0` 与 `settle()`，确保排空计时已随 stdout 关闭撤销，否则读到的可能是排空计时而不是 grace。「无 error」指该会话 `onEvent` 中无 `error`、无 `turn.end{failed}`。每个用例结束前 `collectRejections()` 收集到的 unhandledRejection 为空（含 `fixture.close()` 期间）。

| ID（Scenario） | 输入 | 期望 |
|---|---|---|
| I1 派发前停止（W3） | `slow-ready`，helper **必须**在 open 之后包一层 `world.rt.runtime.spawnImpl` 追加 `--ready-delay-ms 2000`（延迟是 fake 启动起算的真实时间，缺省 500ms 在负载下不足以稳定断言「stop resolve 时 stdin 为空」；fake 取该参数最后一次出现的值，与位置无关，`fake-omp.mjs:94-97`）；REST `postPrompt` 不 await；等到 `spawned.length === 1`；`await stop(world)` | resolve 时：`spawned[0].stdin` 为空（尚无 `negotiate_protocol`，更无 `prompt`/`abort`），REST 请求仍 pending，`listedStatus` 为 `running`。随后 REST 202，body 键集恰为 `{userMessageId,assistantMessageId}` 且等于 history 中该对 id。恰一个 `turn.end{messageId,status:"stopped"}`，无 error；`afterPrompt(spawned[0].stdin)` 的 type 恰为 `["abort"]`；assistant `stopped`、content `"Hello from "`；会话 `stopped`。回合结束后（`waitFor` 返回后读取）`timersDueAt(T+8000) === 0`；`advance(8000)` 后子进程仍存活、无新事件。probe `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`；`calls.length === 1` |
| I2 abort 返回 false 走停止意图 / 准入期间停止（W2，#603） | `abort-ok`，冷会话；同步窗口里连调两次 stop | 同步断言 `spawned.length === 0`；两个 stop 均 resolve；`pa` resolve；恰一个 `turn.end{stopped}`，无 error；`afterPrompt` 恰为 `["abort"]`（两次 stop 只一帧）；content `"Hello from "`；probe `frames=` 同 I1 |
| I3 意图兑现后同样布 grace、兑现后再 stop 仍去重（W2） | `abort-ignored`，同步窗口 stop；等到两个 `text.delta`；再 `await stop(world)` 一次 | 第三次 stop resolve 后 `abortCount(spawned[0].stdin) === 1`、`timersDueAt(T+8000) === 1`（兑现沿用意图登记，不新建）；`advance(7999)` 无 `turn.end`、会话 running；`advance(1)` 后恰一个 `turn.end{stopped}`，无 error，stdin 已结束，最终 `liveProcessCount() === 0` |
| I4 不改写已先到达的终态：正常完成（W2） | `normal`，同步窗口 stop | `pa` resolve；`afterPrompt` 恰为 `["abort"]`（意图已兑现）；恰一个 `turn.end{done}`，无 `stopped`、无 error；assistant `done`、content `"Hello from fake-omp"`。fake 串行处理：prompt 回合先完整结束，随后的 `abort` 只得到不带 id 的 `unsupported`（`fake-omp.mjs:240-262`），它匹配不到 `#pending`（`process.ts:589-594`），abort Promise 挂到进程退出后被拒绝，由同步 catch 吸收。回合结束后 `timersDueAt(T+8000) === 0`；`advance(8000)` 后子进程存活、`liveProcessCount() === 1`、无新事件；probe `frames=` 同 I1 |
| I5 不改写已先到达的终态：崩溃（W2） | `crash`（应答 prompt 后 `exit(2)`，`fake-omp.mjs:409`），同步窗口 stop | `afterPrompt` 含恰一帧 `abort`；恰一个 `turn.end{failed}` 与一个 `error`，无 `stopped`；assistant `failed`；`timersDueAt(T+8000) === 0`；`liveProcessCount()` 归 0；unhandledRejection 为空 |
| I6 准入与前代退役等待期间停止：W3 登记的意图跨重新准入兑现（W3→W4） | `hang-eof`（忽略 EOF，TERM 即退出）：REST prompt 完成（`done`）；`advance(IDLE_MS)`，等 `spawned[0]` stdin 结束（runtime 空闲退役）；`setScenario("abort-ok")`；同步窗口 stop；`advance(5000)` | stop resolve 时 `calls.length === 1`，`spawned[0].stdin` 无 `abort`。TERM 后第一代退出，派发回执以 `ReadmissionRequired` 拒绝，同一回合重新准入：`calls.length === 2`，`pa` resolve；`afterPrompt(spawned[1].stdin)` 恰为 `["abort"]`；恰一个 `turn.end{stopped}`（该回合），无 error；`spawned[0].stdin` 始终无 `abort`；probe（第二代）`frames=` 同 I1 |
| I7 准入与前代退役等待期间停止：等上一进程退役（W1→W2） | 驱逐世界，cap 2，会话 a/c/b。`hang-eof` 下 a 回合完成；`setScenario("normal")`，c 回合完成；REST prompt b 不 await（准入驱逐 a，a 的 slot 进入 `retiring`，`hang-eof` 忽略 EOF）；等 a 的子进程 stdin 结束；对 a 走同步窗口 stop（`#prompt` 停在 `:260`）；`setScenario("abort-ok")`；`advance(5000)` | stop resolve 时 `calls.length === 2`（a、c），a 的旧子进程 stdin 无 `abort`。TERM 后 a 旧进程退出 → b 准入；a 的 prompt 重新准入时驱逐 c（b 有 claim 故 busy）→ 新进程派发后恰一帧 `abort`；a 恰一个 `turn.end{stopped}`，无 error；a 的 probe `frames=` 同 I1。收尾对 b 调 stop（已派发路径）使其 `stopped` |
| F1 获取失败丢弃停止意图（对照） | 两个独立世界，各自 `no-ready-hang` + `Object.assign(world.rt.runtime, { handshakeTimeoutMs: 1_000 })`；REST prompt 不 await；等 `spawned.length === 1`；意图世界 `await stop(world)`（resolve 时 `spawned[0].stdin` 为空），对照世界不调；两世界都 await REST 响应（真实握手超时 → SIGKILL → 派发回执拒绝），不推进注入时钟 | 两世界的 REST 状态码与 JSON body 相同；history 相同（受理对已补偿，会话状态复原）；`spawned[0].stdin` 的 type 序列相同且都不含 `abort`；两会话都无 `turn.end`、无 `error`；`calls.length === 1`；`liveProcessCount() === 0`；`world.errors` 相同 |
| F2 派发失败（回执已兑现）丢弃停止意图（对照） | 两个独立世界，`abort-ok`，各自 `fixture.db.exec` 建触发器 `BEFORE UPDATE OF omp_session_file ON chat_sessions BEGIN SELECT RAISE(ABORT,'session file blocked'); END`（先例 `session-supervisor-faults.test.ts:113`）；意图世界走同步窗口 stop，对照世界只 prompt | 两个 `pa` 以同一消息拒绝；两世界 `spawned[0].stdin` 的 type 序列相同（`negotiate_protocol,get_state,prompt`），都不含 `abort`；都无 `turn.end`、无 `error` 事件；进程均被 retire（`liveProcessCount() === 0`） |
| I8 获取失败确实丢弃意图（泄漏探针） | `openStopWorld("abort-ok")` 后 `setScenario("no-ready-hang")`、`Object.assign(world.rt.runtime, { handshakeTimeoutMs: 1_000 })`；`world.fixture.store.acceptPrompt(world.session, OWNER_ID, "x")`（`session-supervisor-helpers.ts:71-78,375`）→ `const pa = world.fixture.supervisor.prompt(world.session, "x")`；等 `spawned.length === 1` 后 `await stop(world)`（W3 登记意图）；`await rejection(pa)`（真实握手超时 → SIGKILL → 派发失败）；**不**调 `rollbackPrompt`，store 活跃回合仍是同一 assistant id；`setScenario("normal")`，并以 `Object.assign(world.rt.runtime, { handshakeTimeoutMs: undefined })` 恢复缺省握手时限。这是必须的：时限是真实时间、从 spawn 起算（`process.ts:700-706`），每次派发都会重读（`supervisor.ts:349-351`）。不恢复的话，新子进程要在 1s 内 ready，负载下会偶发失败；`await world.fixture.supervisor.prompt(world.session, "x")` 再派发同一回合 | 首个 `pa` 以 `HttpError` `agent_unavailable` 拒绝，无 `turn.end`；第二次 prompt resolve，`calls.length === 2`；`afterPrompt(spawned[1].stdin)` 中 `type === "abort"` 的帧为 0；恰一个 `turn.end{messageId:<同一 id>,status:"done"}`，无 error。若失败时意图未被丢弃，第二次派发的回执续体会兑现这条残留意图而写出 `abort`。它能观察泄漏，是因为同一回合 id 被再次派发；F1 经 REST 会 `rollbackPrompt`（AUTOINCREMENT id 不复用），泄漏在 F1 里不可见 |

**红/绿**
- 先红：I1–I7（master 上四个窗口的 stop 都是空操作；`abort-ok`/`slow-ready` 的回合挂到 abort 才结束，`waitForEvent` 经 `waitFor` 的 8s 实时截止（`session-supervisor-helpers.ts:317-329`，短于 `REAL` 的 20s）以「timed out waiting for …」变红，不靠 vitest 超时）。I4/I5 在 master 上因 `afterPrompt` 不含 `abort` 而红，其终态断言本身是守护。
- 恒绿守护：F1、F2、I8（master 上没有意图：F1/F2 两世界本就相同，I8 第二次派发本就无 `abort`；它们在实现后用于区分下列变异）；Sibling surfaces 全部既有测试。
- 下列变异各须使对应用例变红，逐一临时施加，失败输出记入 PR body：

| 变异 | 变红用例 |
|---|---|
| `stop()` 仍经 `#slots` 取回合（master 行为） | I2、I7（I6 不区分：它的 stop 落在 W3 live 路径，runtime 空闲退役不置 `slot.retiring`（adapter `revoke` 只封 generation，`supervisor.ts:651-658`），子进程仍活、`pool.holds(live.entry)` 为真（`:273`），`#slots.get` 即 live） |
| 不做 `#slots.get(sessionId) === slot` 判定，把准入中的占位 slot 交给 `TurnStops` | I2（stop 以 TypeError 拒绝） |
| `false` 一律丢弃（无阶段标记） | I1、I2 |
| `open(id)` 挪到 `:268` 之后（W1 的 await 之后） | I7 |
| 在 `#bindDispatch` 回执 catch 里丢弃意图 | I6 |
| 兑现挪到 `await stream.dispatched` 之后、`setSessionFile` 之前 | F2（意图世界出现 `abort`） |
| 兑现不布 grace | I3 |
| 兑现不挂 catch | I5（进程退出时 unhandledRejection） |
| 意图路径直接合成 `stopped`（`applyStop`/`finishTurn`） | I4（`done` 被改写或出现两个 `turn.end`） |
| 兑现时删掉意图登记或另建新登记 | I3（兑现后再 stop 写出第二帧 `abort`） |
| 获取失败不丢弃意图（`#prompt` 外层 catch 不 `release`） | I8（第二次派发写出 `abort`） |

- 只经代码审查（外部不可观察）：「回执后取得的 `false` 不登记意图」（丢失标志时登记的意图也永不能兑现：回执后的 `false` 表示子进程已死或退役中）；`#prompt` 在 `:264`/`:267` 两处 throw 不清标记（前者关停后惰性，后者经 REST 不可达）。

## Non-goals
见 proposal。兑现时抢先登记的审批（背压的 prompt 写）只列 Open question。

## Review focus
1. 四个窗口都登记意图（决定 2、3），且 W2 的占位 runtime 永不被解引用。
2. 意图恰兑现一次、只在 pump 登记之后；丢弃只在请求级失败与回执后 `false`；阶段标记只在 `pump.finally` 与 `#prompt` 外层 catch 清除。
3. 意图路径不合成终态、不发 `error`；兑现后与已派发路径共用同一尾段（同步 catch + 注入时钟 grace）。
4. 失败路径与无意图时相同（F1/F2 以对照世界证明）。
5. 行数：`supervisor.ts` 实测 ≤786（硬上限 798），`turn-control.ts` 对 `./supervisor.js` 无值导入。
