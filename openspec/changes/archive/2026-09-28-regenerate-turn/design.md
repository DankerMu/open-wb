# Design: regenerate-turn（#465）

父设计：
- D3：regenerate 复用 prompt 的获取路径，只有正常 generation。
- D4：会话级控制占用。
- 「模块拆分」：`turn-control.ts` 承载 stop/regenerate/fork 的回合控制编排。

主 spec chat-sessions「会话 supervisor 源码模块划分」据此分工：`supervisor.ts` 只接线，编排进 `turn-control.ts`，CAS 事务进 `store-branch.ts`。

## Change surface

实施分两个 commit，同一个 PR。

**Commit 1：前置纯移动（偏离 1）**
- 从 `supervisor.ts` 移入 `pool.ts`：
  - `class ReadmissionRequired`（`supervisor.ts:79-84`），加 `export`；
  - `#adapter`（`:627-669`），改为 `generationTokens(slot, pool, store, tokens)`；
  - `#releaseDispatch`/`#releasePump`/`#sealGeneration`（`:671-705`），改为导出函数。
- 允许的替换只有三种：`this.#x(` → `x(`，`this.#pool/#store/#tokens` → 参数，加 `export`。
- `RingBuffer` 的值导入随之移到 `pool.ts`。`pool.ts` 不导入 `supervisor.ts`/`turn-control.ts`，无环。
- `supervisor.ts:31` 的 `releasePumpExit` 再导出保留（carry-forward :49）。`pool.ts` 的判定规则（`:129-160`）不动。
- 行数实测：`supervisor.ts` 785 → ≤705，`pool.ts` 161 → ≤260。
- 验收：既有测试零 diff 全绿；`git diff --color-moved` 只显示移动块和上述替换。

**Commit 2：功能**
- **`turn-control.ts`（236 → ≤440）**
  - `ControlClaims`：按 `sessionId` 计数。
    - 成员：`held(id)`；`hold(id)`，返回只生效一次的 release；`during(id, fn)`。
    - `during` 同步 hold，`fn` 同步抛错时先释放再原样同步抛出，否则在返回 Promise 的 `.finally` 释放。
  - `Regenerations`：regenerate 编排，按预检 / RPC 段 / 提交段三个方法拆分（biome 认知复杂度 ≤15）。
    - 端口：`store`、`controls`、`stops`；`closed()`（读 `#closed`）、`live(slot)`（`pool.holds(slot.entry)`，fix pass 1）；`acquire`（见 supervisor）、`dispatch`（`#claim` + `#bindDispatch`）、`settled`（`approvals.settled`）。
- **`supervisor.ts`（≤705 → ≤775，硬上限 798）**
  - 新增 `#controls`。
  - `#prompt` 同步前缀（`:251-259`，在 `#stops.open` `:260` 之前）的拒绝条件改为 `claimed !== undefined || #controls.held(sessionId)`，结果 `session_busy`（carry-forward :64）。
  - `#dispatchNew` 的准入成员（`:319-322`）改为 `busy: () => !turnFree(slot) || #controls.held(sessionId)`；`retire` 不变，永不 reject（carry-forward :53）。
  - `#onProcessExit`（`:367-372`）的退役条件改为 `turnFree(slot) && !#controls.held(slot.sessionId)`，释放名额照旧无条件。
    - regenerate 的命令段没有 claim，`turnFree` 为真。若照旧 retire，`runtime.shutdown()` 会同步置 `#closed`（`runtime.ts:186-190`），在途命令只能以 `runtime shutdown` 失败。这样空闲回收窗口里 `issue` 闸门给出的 `ReadmissionRequired` 永远到不了，用户看到 502，丢掉 #463 决定 3 的回退。
    - 占用期间的退出由 `#onSlot` 的失败 catch 或 pump 收尾退役。
  - `stop()`（`:208-218`）在 closed 检查之后用 `#controls.during(sessionId, …)` 包住原体。stop 调用期间持有占用，且不查占用。
  - 公开 `regenerate(sessionId, ownerId): Promise<{assistantMessageId:number}>`：
    - closed 时返回 reject `agent_unavailable`；
    - 否则与 prompt 共用 `#track(work)`：`#admissions` 放宽为 `Set<Promise<unknown>>`，shutdown 照常等待它；
    - 任何失败都以 rejection 给出，不同步抛错（预检里 `getMessages` 抛错也一样）。
  - 公开同步 `controlHeld(sessionId): boolean`：供 #467 的 prompt 路由在 `acceptPrompt` 之前拒绝，本刀用于测试观察。
  - 把 `#prompt` 的活 slot 复用块（`:271-290`）泛化为 `#onSlot(sessionId, state, claim | undefined, use)`。
    - 活 slot 可用时，有 claim 则 `#claim`，再 `use(live)`。
    - 失败时 `live.pump === undefined` 则 retire；是 `ReadmissionRequired` 就回退一次 `#onNewSlot`。
    - `#onNewSlot` 即 `#dispatchNew`，改为 claim 可选、以 `use(slot)` 代替 `#bindDispatch`。
    - `#prompt` 的 `open`、`retiring` 等待、closed 检查、claim 复核（`:260-270`）仍在 try 之外，保持 #490 决定 3。
    - prompt 传 `use = slot => #bindDispatch(slot, text, id)`，行为不变。
  - `acquire` 端口 = `retiring` 等待 + closed 检查 + `#onSlot(…, undefined, use)`。
- **`store-branch.ts`（115 → ≤175）**：新增 CAS 事务函数（示意名 `replaceLastAssistant`），经 `runOwnedTransaction` 执行：
  - 读会话行与末条消息（`ORDER BY created_at DESC, id DESC`）；
  - `status === "running"` 或末条 id ≠ 预检 id 时抛 `HttpError("session_busy")`；
  - `DELETE` 旧 assistant 行（`chat_steps`/`chat_approvals` 经 `ON DELETE CASCADE` 删除，`034_chat_turn_control.sql:66,145`）；
  - 用 `INSERT_MESSAGE` 插入 `running` 空 assistant 行；
  - `UPDATE` `omp_session_file`、`status='running'`、`updated_at`。
  - 只值导入 `HttpError`，不值导入 `store.ts`/`store-approvals.ts`（carry-forward :10）。
- **`store.ts`（694 → ≤725，偏离 2）**
  - `SessionStore` 加 `acceptRegenerate(sessionId, expectedAssistantId, sessionFile): number`（示意名），先调事务，再登记内存 Turn。
  - `acceptPrompt` 的 Turn 字面量（`:339-357`）抽成共用 `openTurn(...)`，免 jscpd 重复。
  - regenerate 的 Turn 以已存在的 user 行为 `userMessageId`，`progress: true`，使 `rollbackPrompt`（`:367-368`）必然拒绝：它会删 `userMessageId`，那是既有 user 行。REST 只对自己受理的 id 调 rollback，本就不可达，此处为结构性守护。

## Regenerate 执行序（Governing invariant 的落点）

1. **同步预检**，与 `hold` 在同一同步段内，结束时一律 `finally` 释放：
   - `getMessages(sessionId, ownerId)` 为 `null` → `not_found`；
   - 会话为 running 或占用已被持有 → `session_busy`；
   - 形态（`done/failed/stopped`、末条 assistant、前一条 user）不满足 → `bad_request`；
   - 记下 expectedId 与 user 原文，经 `runtimeState` 读 `ompSessionFile` 作 resume 路径；
   - 然后 `hold`。
2. **`acquire(use)`**，`use(slot)` 依次执行：
   - (a) 首个 `command({type:"get_branch_messages"})`，包在 async 函数内：`command()` 在 closed 或 busy 时同步抛错（`runtime.ts:249-254`）。
     - 失败时抛 `slot.acquisitionFault ?? error`，读后清空：`command` 把一切拒绝映射成 `AgentUnavailableError`（`runtime.ts:279-281`），只有这样空闲回收窗口的 `ReadmissionRequired` 才能触发一次重准入（#463 决定 3）。
     - 若本次命令新取得 generation（`slot.generation` 前后不同），`finally` 中对它 `releaseDispatch`：`issue` 以 `dispatchCount: 1` 建 generation（`:641-648`），`#bindDispatch` 会再 +1（`:376-379`），pump 收尾只减 1（`:681-692`），不平衡则永不封口。
   - (b) 校验 `data.messages`：必须是数组，末项 `entryId`/`text` 为字符串，且 `text === user 原文`。否则（含空列表）抛 `agent_unavailable`，不发 `branch`。
   - (c) 依次发两个字面量帧（carry-forward :63，不展开任何请求体）：
     - `command({type:"branch", entryId})`：要求 `text` 为字符串且 `cancelled === false`；
     - `command({type:"get_state"})`：取 `sessionFile`。
     - (c) 中任何失败都映射为 `HttpError("agent_unavailable")`，不再浮出 `ReadmissionRequired`。
   - (d) 提交段。`get_state` 应答到 `acceptRegenerate` 之间只经过微任务：`command()` 的 `.finally`（`runtime.ts:257-260`）、`#runCommand` 的 await/return（`:270-279`）、`use` 包装里的 await。没有 I/O 或宏任务边界，外部请求插不进来。从下面第一步起到 `dispatch` 调用，是一个无 await 的同步段：
     - **先查 `closed()` 与 `live(slot)`**（后者 fix pass 1：子进程回完 `get_state` 后同段退出时，`#onProcessExit` 已释放名额但因占用保留 slot，不查则 CAS 照提交、派发失败、旧回答被删；F2(c)/M18）：为真则抛 `HttpError("agent_unavailable")`，按提交前失败处理，retire，行与文件不动。shutdown 可能在最后一个应答途中开始，`runtime.ts:263-283` 不在应答时查 closed，`OmpProcess` 也不因 stdin 关闭拒绝在途请求（`process.ts:262-264,541-553`）；不查会先提交 CAS，再在 `runtime.prompt()` 抛 closed（`runtime.ts:157-159`），经 (e) 把新行结算 `failed`，旧回答已删。守卫同 `#prompt` 的 `supervisor.ts:265-267`。
     - `acceptRegenerate(...)`：CAS 未命中时抛 `HttpError("session_busy")`。其它任何非 `HttpError` 异常（SQLite/事务错误）映射为 `HttpError("agent_unavailable")`，依据 turn-control「branch 之后提交之前失败」的「事务写入抛错 → 502」。这一步在 regenerate 上覆盖 prompt 路径的 provenance 规则（`#translate`，`supervisor.ts:739-750`，把通用错误原样透传）。
     - `stops.open(newId)`；
     - `dispatch(slot, branchText, newId)`。
   - (e) 提交后派发失败：
     - `stops.release(newId)`，丢弃停止意图；
     - `finishTurn(newId, "failed", settled)`，非空则 `await settled(settled)`（carry-forward :83；此时尚无 pump，按构造为空，仍照规则路由）；
     - 不发布 `turn.end`/`error`，同 prompt 的预进度失败；
     - 抛 `agent_unavailable`，不复活旧行。
3. **失败即 retire**：`#onSlot` 的 catch 在 `pump === undefined` 时 retire 该进程，覆盖提交前一切失败，包括文本不一致与 CAS 未命中（决定 2）。只有 (a) 可能以 `ReadmissionRequired` 回到 `#onNewSlot`，(c)(d)(e) 不会，所以 `use` 不会重跑事务。

## Governing invariant

一个会话的控制占用被持有时：
- 该会话不会进入 `#prompt` 的派发（不 `open`、不 `dispatchCount+1`、不对正在执行命令的 runtime 调 `prompt()`）；
- 不会开始第二个 regenerate；
- 其进程不会被驱逐。

regenerate 对 SQLite 只做一次写入，即步骤 (d) 的单事务；此后与普通 prompt 回合同一路径。

## 决定
1. **提交前无 turn，stop 在 RPC 间隙为空操作**（carry-forward :70/:71）。`stop()` 以 `runtimeState(...).activeTurn` 定位回合（`:212`），新 id 在事务提交前不存在，此时的 stop 按 status 非 running 处理。
   - closed 检查 → CAS → `open` → `#claim` → `#bindDispatch` 之间无 await，提交后的 stop 必然看到 `dispatching` 并登记意图（主 spec 的意图路径），所以 carry-forward :71「command 的 await 须在 `open` 之后」不适用：那时还没有要 open 的回合。
   - 与 prompt 的等价门：预检（running/占用）+ CAS（非 running、末条 id）+ `#claim` 唯一性。
2. **提交前任何失败都 retire**（超出父文，父文只要求 branch 之后 retire）：
   - 一条 catch 覆盖全部失败，不必推理「哪条命令已到达 omp」；
   - runtime 在 `get_state` 后已把 `#resumePath` 指向新文件（`runtime.ts:274-277`），不 retire 就会以新文件复用进程。
   - 代价：失败后的下一次 prompt 多一次 spawn（仍 `--resume <原文件>`）。
3. **stop 的占用不引入 await**（carry-forward :66/:67/:68）。`during` 只做同步计数与 `.finally` 释放，`TurnStops.#run`（`turn-control.ts:121-142`）不变，因此不需要 #603 的 `entries.get(id) === entry` 守卫。
   - 计数而非 Set：regenerate 与 stop 可同时持有，stop 的释放不得抵消 regenerate 的持有（R8/M4）。
4. **旧行上不可能有 pending 审批**：#474 之后，每个终态翻转都在终态事务内把 NULL 结算为 `deny`（`store-approvals.ts:241-291`），级联只删已结算行。若旧行的超时计时器仍在（`approvals.ts:176-186`），它把 `not_found` 当作 CAS 未命中（carry-forward :56）。不加代码。
5. **没有可注入的第四个间隙**：`get_state` 应答到 CAS 之间、各应答到下一次写帧之间都有 await，但只经过微任务，没有 I/O 或宏任务边界，外部请求（HTTP、子进程帧、计时器）不可能插入。因此父文「`get_state` 应答后」的间隙与「最终事务复核失败」的时点无法构造。测试改为扣住应答，在扣住期间改写行（spec 引注）。
6. **不新增假 omp 场景**（`fake-omp.mjs` 793/800）：
   - 真实子进程用既有 `branch` 场景与 `--branch-entry` 旋钮（`fake-omp.mjs:84-92,163-175`）；
   - 间隙靠 `openApprovalWorld` 的 stdout `hold`，只作用于首个子进程（`session-approval-helpers.ts:96-102,157-190`）；
   - 退出、空列表、池满、派发窗口用 FakeChild：`onCommand`、`holdNextPromptWrite`（`support/omp-rpc.ts:411-413,470-500`）。

## Must preserve
- prompt 路径：`#prompt` 的 `session_busy`/`agent_unavailable` 与 #490 意图语义（`supervisor.ts:250-295`）；`#translate`（`:739-750`）；REST `acceptPrompt → supervisor.prompt → rollbackPrompt`（`rest.ts:162-166`）。
- 每次获取 epoch 恰 +1（`:636`）；准入闸门早于 bump；`releasePumpExit` 再导出（`:31`）。
- `TurnStops` 全部语义与 `persistEvent`（`turn-control.ts:55-226`）不变；`omp/`、`rest.ts`、`approvals.ts`、`events.ts`、`index.ts`、`fake-omp*.mjs`、web 零 diff。
- `SessionSupervisorPort`（`rest.ts:15`）不变，REST 桩不变。

## Sibling surfaces
- **必然变红的既有测试：无。** 允许的既有测试编辑：**无**。
  - 已核对：`SessionStore` 新增必选方法不会破坏测试，测试一律经 `createSessionStore` 或 app 装配取得 store，没有手写实现或 `satisfies SessionStore`（`grep -rn "SessionStore" server/test`）。
  - `SessionSupervisorRuntime` 与 `SessionSupervisorPort` 均不变。
- 守护（零 diff 全绿）：
  - `session-supervisor{,-admission,-claims,-faults,-sinks,-stream,-subscribe,-pool,-pool-exit}.test.ts`；
  - `session-stop*.test.ts`（含意图与 `publish-fault` 用例）；
  - `session-approval*.test.ts`、`session-rest.test.ts`、`omp-runtime*.test.ts`、`session-store*.test.ts`；
  - `migration-034.test.ts:449-453`（删会话级联）。
- 生产方与消费方：regenerate 的事件经同一 `#pump`/`#commit`/`#publish`；web 与 SSE 不变；`reconcileOnStartup` 照常结算 running 行。

## Seams under test
- 新建 `server/test/session-regenerate.test.ts`（真实 fake）、`session-regenerate-faults.test.ts`（FakeChild/池）、`session-regenerate-helpers.ts`，各 ≤800 行。不 import `pool.ts`/`turn-control.ts`，不访问私有字段；只用 `supervisor.regenerate`/`controlHeld`/`stop`/`streamCursor`/`liveProcessCount` 与 REST prompt。
- 播种（helper）：
  - `store.acceptPrompt(s, "u1", "second question")` + `finishTurn(a, "done")` + `presetSessionFile(db, s, <P>)`（`session-supervisor-pool-helpers.ts:175`）；
  - 可选插入一条已结算审批行，用 SQL，照 `migration-034.test.ts:277`。
  - 这样 regenerate 的 spawn 即 0 号子进程。
- 扣住点（`LineMatch`）：`"type":"ready"`、`"command":"get_branch_messages"`、`"command":"branch"`、`"command":"get_state"` 且含 `/branch-`（握手的 `get_state` 回的是 resume 路径，`fake-omp.mjs:322`；branch 写 `<session-dir>/branch-<uuid>.jsonl`，`:350`）。
  - 握手时限按真实时间计（`process.ts:130`，10s），扣住后须及时 `gate.release()`。
- 场景切换：`openApprovalWorld` 的 `scenario` 类型只有 `"approval" | "approval-parallel"`（`session-approval-helpers.ts:85-87`），不得放宽。做法是以 `"approval"` 打开，在任何 spawn 之前 `world.rt.setScenario("branch")`；`--approval-mode write` 对 `branch` 无影响。
- `--branch-entry`：打开后包一层 `world.rt.runtime.spawnImpl`，同 `delayReady`（`session-stop-intent-helpers.ts:74-78`）。`#dispatchNew` 每次派发都从同一 runtime 对象重建 opts（`supervisor.ts:333-355`），所以包装会生效。
- spawn 契约：比较 `rt.calls` 前后两次的 argv（去掉 `--resume` 对）与 env 键集合（`recordedSpawn`，`session-supervisor-helpers.ts:336-357`）。

## Required evidence
标记：R 先红后绿；G 守护，恒绿；M 变异，记入 PR body。

**`session-regenerate.test.ts`**
- **R1 正常 + 级联**（R，含 carry-forward :30）
  - 输入：不播种。REST prompt `"second question"` 完成一轮，进程存活，a1 带 `branch` 场景的 bash 步骤；用 SQL 给 a1 插一条已结算审批行；然后 regenerate。
  - 期望：
    - 兑现 `{assistantMessageId: n}`，`n` 大于旧 id；
    - 入站帧序 `get_branch_messages, branch{entryId:"fake-entry-2"}, get_state, prompt{message:"second question"}`；
    - 旧行、步骤、审批行计数为 0；
    - `omp_session_file` 匹配 `/branch-.*\.jsonl$/`，且等于 `get_state` 回报值；
    - 回合 `done`，历史为 `[user "second question", assistant(done)]`；
    - `advance(IDLE_MS)` 后再 prompt，以 `--resume <新文件>` spawn。
- **R2 已回收**（R）
  - 输入：播种后 `streamCursor = {E, …}`，`subscribeLive`，然后 regenerate。
  - 期望：
    - spawn 1 次，`--resume <P>`；`stream_epoch` 为 E+1（仅一次）；
    - 订阅者先收 `turn.start`，后收 `turn.end(done)`，`messageId = n`；
    - 结束后 `streamCursor.epoch === E+1`；
    - 与一次普通 prompt 的 spawn 对比：argv 去掉 `--resume` 后相等，env 键集合相等。
- **R3 四个间隙**（R）
  - 输入：每个扣住点各开一个世界，在扣住期间：
    - (i) `supervisor.regenerate` → reject `session_busy`；
    - (ii) REST prompt → 409 `session_busy`。
  - 期望：注入前后 `chat_messages`/`chat_steps`/`chat_sessions` 快照逐字相等；子进程入站帧无新增；spawn 次数不变。放开后原 regenerate 兑现并 `done`。
  - M1：删 `#prompt` 的占用判定后 (ii) 变红：`runtime.prompt` 在 `#commanding` 时同步抛 busy，catch retire 活 slot，原 regenerate 失败。M2：删预检的占用判定后 (i) 变红。
- **R4 文本不一致**（R）
  - 输入：spawn 追加 `--branch-entry "other"`。
  - 期望：
    - reject `agent_unavailable`；入站帧无 `branch`；
    - 行、`omp_session_file`、`status`、`updated_at` 不变；子进程已退出；`controlHeld === false`；
    - 随后 REST prompt 202，以 `--resume <P>` spawn。
  - M13：去掉文本比对后变红。M3：失败路径不释放占用时，本例及 R6、F4、F6 的 `controlHeld === false` 与随后 prompt 202 变红。
- **R5 事务写入抛错**（R）
  - 输入：`CREATE TRIGGER … BEFORE DELETE ON chat_messages BEGIN SELECT RAISE(ABORT,'x'); END`。
  - 期望：
    - reject 为 502 `agent_unavailable`；行与 `omp_session_file` 不变；子进程退出；
    - 删触发器后 prompt 202，`--resume <P>`（不是 branch 文件）。
  - M16：`acceptRegenerate` 的非 `HttpError` 不映射时 reject 为原始 SQLite 错误，不是 `agent_unavailable`，变红。
- **fix pass 1 追加证据**（PR #622 评审）：
  - R5b CAS 原子性：真实回合播种（a1 带步骤与已结算审批）后建 `BEFORE INSERT ... WHEN NEW.role='assistant' AND NEW.status='running'` 触发器 → reject `agent_unavailable`，快照（含 `stream_epoch`、步骤、审批）逐字不变；`DROP TRIGGER` 后 prompt `--resume <原文件>` 202。M19：去掉 `runOwnedTransaction` 包裹 → DELETE 未回滚，变红。
  - R8d `during` 同步抛错释放：`runtimeState` 注入一次同步抛错 → `stop` 同步抛出、`controlHeld === false`、随后 prompt 202。M17：catch 不 release → 变红。
  - F2(c) 应答后同段退出：`exitAfterState` 先回 BRANCHED 再 `nativeExit(1)`+`endStdout()` → reject `agent_unavailable`，快照含 `omp_session_file` 不变，spawn 1 次，随后 prompt `--resume P` 202。M18：去掉 `live(slot)` → 旧行被删、文件被改，变红（修复前即红）。
- **R6 复核失败**（R）
  - 输入：扣住 branch 后的 `get_state`，其间分两例 SQL 改写：`status='running'`；或插入一条更新的 assistant。
  - 期望：
    - reject `session_busy`；除该改写外无行变化；子进程退出；`controlHeld === false`；
    - 撤销改写（`status` 改回 `done`，或删掉插入的那条 assistant）后，REST prompt 202，以 `--resume <P>` spawn。
  - M7：CAS 不比 id 时第二例变红。
- **R7 预检**（R）
  - 输入：running、idle 无消息、末条 user、他人 owner、未知会话、`fixture.close()` 后。
  - 期望：依次为 `session_busy`、`bad_request`、`bad_request`、`not_found`、`not_found`、`agent_unavailable`；均无 spawn、无行变化，regenerate 不同步抛错。
- **R8 stop 与占用**（R）
  - (a) 回合中 `const p = supervisor.stop(s)`，同步断言 `controlHeld(s) === true`，`await p` 后为 false。
  - (b) regenerate 扣在 `branch` 应答时 `await supervisor.stop(s)` resolve，无新帧，之后 `controlHeld(s)` 仍为 true。放开后 regenerate 兑现，`controlHeld` 为 false。
  - (c) issue 补充「stop 在途时 regenerate 409」：会话 `done`（播种）时同步连调 `const p = supervisor.stop(s); const r = supervisor.regenerate(s, "u1")`。
    - `r` reject `session_busy`：会话非 running，只有 stop 的占用能拒绝它；
    - `await p` 之后再 regenerate 兑现。
  - M4：Set 语义下 (b) 变红。M5：stop 不持占用时 (a)(c) 变红。
- **R9 空闲回收窗口重准入**（R，#463 E6 先例）
  - 输入：
    - `hang-eof` 场景下 REST prompt `"second question"` 完成一回合；
    - `advance(IDLE_MS)`，等 stdin 结束；
    - `setScenario("branch")`；
    - 调 regenerate，保持 pending；
    - `advance(5000)`，SIGTERM 使旧进程退出。
  - 期望：regenerate 兑现，spawn 2 次，第 2 次 `--resume` 为该会话文件，`stream_epoch` 恰 +1。
  - M11：不浮出 `acquisitionFault` 时变红，结果为 `agent_unavailable`。M14：`#onProcessExit` 不看占用时变红，结果同为 `agent_unavailable`。
- **G 关停**：扣住 `get_branch_messages` 时调用 `fixture.close()`，随即 `gate.release()`，避免排空等在闸门上。regenerate 以 `agent_unavailable` reject，close 正常 resolve，`liveProcessCount() === 0`。
- **R10 提交前关停**（R）
  - 输入：扣住 branch 之后的 `get_state` 应答；先读快照，再调 `fixture.close()`（不 await），**等 `world.spawned[0].child.stdin.writableEnded` 为真**（`supervisor.shutdown()` 先同步置 `#closed`，再经 retire 链同步 `closeStdin`，`runtime.ts:660-665`；故 stdin 已关即 `#closed` 已为真），然后 `gate.release()`。不能「close 后随即 release」：`fixture.close()` 经 `app.close()` → avvio `process.nextTick` 才到 preClose（`session-supervisor-helpers.ts:183-188`、avvio `index.js:337`、`sessions/index.ts:57-73`），`#closed` 与应答谁先取决于 nextTick/promise 交错，M15 会失去确定性。OmpProcess 只在 stdout end/致命错误时 reject 在途请求（`process.ts:541-553,600-609`），故 stdin 关闭后放行的应答仍会先于 stdout end 被解析。
  - 期望：
    - regenerate reject `agent_unavailable`；
    - 旧 assistant 行及其步骤、`omp_session_file`、会话 `status` 与 `updated_at` 与快照逐字相同，无新 assistant 行；
    - close 正常 resolve，`liveProcessCount() === 0`。
    - 取证方式：`fixture.close()` 在 finally 里关 `:memory:` db。测试先包一层 `fixture.db.close`，在真正关闭前读行快照，这样取证时点确定，不依赖微任务次序。
  - M15：删掉 (d) 的 closed 检查后，CAS 提交、新行 `failed`、旧行消失，变红。

**`session-regenerate-faults.test.ts`（FakeChild，脚本化 `get_branch_messages`/`branch`/第二次 `get_state`）**
- **F1 空列表**（R）：`{messages:[]}` → `agent_unavailable`，无 `branch` 帧，行不变。
- **F2 get_state 前退出**（R）
  - 两个变体：
    - (a) `branch` 正常应答，在第二次 `get_state` 的处理器内 `exit(1)`；
    - (b) 在 `branch` 处理器内先 `emitLine(ok)`，同一同步段再 `nativeExit(1)` 与 `endStdout()`（照 #463 E6）。依赖上面的 `#onProcessExit` 占用条件：占用期间不 retire，runtime 未关闭。exit 监听先于应答续体的微任务，下一条 `command` 经 `#readyGeneration` → retire → `#acquire` → `issue` 时 `holds(entry) === false`，得到 `ReadmissionRequired`。
  - 期望（两者相同）：`agent_unavailable`；spawn 恒为 1 次；行与文件不变；随后 prompt 202，`--resume <P>`。
  - M12：步骤 (c) 也浮出 `acquisitionFault` 时，(b) 会重准入，spawn 变为 2 次，变红。M12 只映射 (b)。
- **F3 控制占用不可驱逐**（R）
  - 输入：cap=1；A regenerate 扣住 `branch` 应答；B 发 REST prompt。
  - 期望：
    - B 返回 503 `agent_capacity`，A 的子进程 stdin 未结束、无信号；
    - 放开后 A `done`；
    - B 再 prompt 时驱逐 A，202。
  - M6：busy 不含占用时变红。
- **F4 池满**（R）
  - 输入：cap=1，B 回合挂起；A（已回收）regenerate。
  - 期望：
    - `agent_capacity`；A 行不变；`controlHeld(A) === false`；无 spawn；
    - 放开 B 的回合并等其结束后，A 的 REST prompt 202：驱逐 B，以 `--resume <P>` spawn。
- **F5 提交后停止意图**（R）
  - 输入：活进程 + `holdNextPromptWrite`；`entered` 之后 `await stop`。
  - 期望：
    - stop 时未写 `abort`；
    - 放开后 prompt 之后恰一帧 `abort`；
    - 脚本回 `message_end aborted` + `agent_end`，得到恰一个 `turn.end(stopped)`，无 error；
    - regenerate 兑现。
  - M9：缺 `open(newId)` 时 stop 丢失，变红。
- **F6 提交后派发失败**（R）
  - 输入：
    - 触发器：`CREATE TRIGGER … BEFORE UPDATE OF omp_session_file ON chat_sessions WHEN OLD.status='running' AND NEW.omp_session_file = OLD.omp_session_file`。它不依赖 CAS 的语句拆分：CAS 改变路径，所以不触发；派发回执后的 `setSessionFile` 写入同一路径，所以触发。
    - 停止意图：用 `holdNextPromptWrite` 扣住 prompt 写入，其间 stop 登记意图，然后放开。
  - 期望：
    - reject `agent_unavailable`；
    - 新 assistant 行与会话为 `failed`，旧行不存在；
    - 无 `abort` 帧，无该回合事件；
    - `controlHeld === false`；此后 prompt 202。
  - M10：复活旧行时变红。
- **F7 dispatchCount 平衡**（R）
  - 输入：已回收会话 regenerate 至 `done`，`nativeExit(0)`，不 `endStdout`。
  - 期望：`streamCursor(s)` 为 `{epoch: E+1, seq: null}`（先例 `session-supervisor-stream.test.ts:142`）。
  - M8：去掉平衡后 `seq` 非 null。
- **G**：Sibling surfaces 全部零 diff 全绿；size-guard、knip、jscpd 无新增。

## Non-goals
- REST 路由、202 形状、受理前占用检查、「（或 regenerate）」的 HTTP 层、合并措辞：#467。
- fork 与其注入：#466。
- web 重新生成按钮：7.x。
- 回合结束后无 `turn.end` 的在线刷新：Open question。

## Review focus
- (d) 段：closed/live 检查 → CAS → `open` → `#claim` → `#bindDispatch` 之间无 await；`get_state` 应答到 closed 检查之间只有微任务。
- `acceptRegenerate` 的错误映射：`session_busy` 原样，其它一律 `agent_unavailable`（R5/M16）。
- `ReadmissionRequired` 只从首个命令浮出；`use` 不会在提交后重跑。
- 首个命令新取得 generation 时恰一次 `releaseDispatch`（F7）。
- 占用在每条结束路径上恰释放一次，含同步抛错、shutdown、CAS 未命中；stop 的 `during` 不改变 `stop()` 的同步抛错语义（carry-forward :70）。
- 前置纯移动 commit 可按 `--color-moved` 逐行复核。
