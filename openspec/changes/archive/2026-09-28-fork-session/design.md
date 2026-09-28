# Design: fork-session（#466）

父设计：D4（临时进程 branch、源会话文件不动、存活进程先 retire，以及「同一文件不并存两个进程」三重保证）、D3（控制占用）、D7（进程池）。先例：#465 regenerate（`archive/2026-09-28-regenerate-turn/`）。

## Change surface

实施分两个 commit，同一个 PR。

**Commit 1：前置纯移动（proposal 偏离 2）**
- `turn-control.ts:204-363` 中以下内容原样移入新文件 `server/src/sessions/branching.ts`：
  - `Resume`、`RegeneratePorts`、`RegeneratePlan`、`TERMINAL`；
  - `class Regenerations`（加 `export` 保持不变）；
  - `record()`。
- 随代码带过去的导入是**复制**而非移动：`branching.ts` 新增 `HttpError`、`releaseDispatch`/`type Slot`（`pool.js`）、`SessionStore`/`SettledApproval` 类型，以及 `ControlClaims`/`TurnStops` 的类型导入（从 `turn-control.js`）；`turn-control.ts` 仍需 `HttpError`（`skipSettled`）与 `type Slot`（`TurnStops`），这两个保留，只删掉不再使用的 `releaseDispatch`。
- `turn-control.ts` 头注释 :5-7 改为指向 `branching.ts`；它保留 `TurnStops`、`ControlClaims`、`skipSettled`、`persistEvent`、`drain`。
- `supervisor.ts:392-415` 的 `SessionRuntimeOpts` 字面量抽成 `pool.ts` 的 `sessionRuntimeOpts(base: SessionSupervisorRuntime, per: {sessionId, ownerId, resumePath, tokens, onExit, onApproval?})`：
  - 对 `./supervisor.js` 只做类型导入（主 spec 允许）；
  - `#onNewSlot` 改为 `new SessionRuntime(sessionRuntimeOpts(this.#runtime, {...}))`。
- 允许的替换只有：
  - `this.#runtime.x` → `base.x`；
  - 每次调用的字段改为参数；
  - 加 `export`；
  - import 行调整。
- 验收：既有测试零 diff 全绿；`git diff --color-moved=zebra` 只显示移动块与上述替换；knip、jscpd 无新增。

**Commit 2：功能**
- **`branching.ts`（≤450）**
  - 共用函数：
    - `branchTo(runtime, entryId)`：即 `Regenerations.#branch` 原体（`turn-control.ts:296-315`）。字面量帧 `{type:"branch",entryId}` 后恒跟 `{type:"get_state"}`（carry-forward :63），任何失败抛 `HttpError("agent_unavailable")`。
    - `entryAt(data, index, text): string | undefined`：解析 `data.messages.at(index)`；regenerate 传 `-1`，fork 传序号。
  - `Forks`：
    - 端口：`store`、`controls`、`pool`、`tokens`（`TokenRegistry`）、`config`（`SessionSupervisorRuntime`，类型导入）、`closed()`，以及 `retireSource(sessionId): Promise<void>`（从不 reject）。
    - 方法：`run(sourceId, ownerId, messageId)`；`close(): Promise<void>` 关停 `#temps` 中全部在途临时 runtime，每个都 `.catch(noop)`。
- **`pool.ts`（≤315）**：`temporaryTokens(pool, entry, tokens)`：
  - `issue(id)`：仅在「从未 issue 过」且 `pool.holds(entry)` 时返回 `tokens.issue(id)`，否则抛错。这样就挡住了 `#readyGeneration`（`runtime.ts:313-333`）在子进程死后的惰性重 spawn：若不挡，第二个进程会在池外被 spawn。
  - 该重 spawn 的后果：`branch` 不更新 `#resumePath`，只有 `get_state` 更新（`runtime.ts:274-278`）。若 `branch` 应答后子进程死亡，下一条 `get_state` 会以握手时的路径（真实 omp 下即源文件）起第二个进程，其 `get_state` 回报源路径；再若 liveness 守卫也失效，新会话就会指向源 `.jsonl`。证据：F10/M21。
  - `revoke(id)` → `tokens.revoke(id)`。
  - 不建 `Generation`，不 bump epoch，因此没有 ring。
- **`supervisor.ts`（≤790，硬上限 798）**
  - 新增 `#forks`。`retireSource = id => { const s = this.#slots.get(id); return s === undefined ? Promise.resolve() : this.#retireSlot(s); }`：对任何已登记的源 slot **无条件**执行，不看 `pool.holds`。
  - `regenerate` 与新的公开 `fork(sessionId, ownerId, messageId): Promise<{session, draft}>` 共用 `#control(run)`：closed → reject `agent_unavailable`；`run().catch(e => { throw this.#translate(e) })`；`#track`（`:313-318`）。
  - `shutdown()`（`:252-271`）在 `await Promise.allSettled(admissions)`（`:260-261`）**之前**把 `this.#forks.close()` 放进 `retirements`。否则在途 command 永不返回时，shutdown 会挂住：临时进程不在 `#slots` 里，`:257-259` 关不到它。
  - `controlHeld` 注释（`:176`）补 fork。
- **`store-branch.ts`（≤320）**：`copyForkHistory(db, {sourceId, sessionId, ownerId, messageId, expectedAssistantId, sessionFile, now})`，经 `runOwnedTransaction`（`:91-105`）执行，见下文 (f)。只值导入 `HttpError`。
- **`store.ts`（≤760，偏离 3）**：`SessionStore.commitFork(input)`：
  - `assertOpen` → `copyForkHistory` → 以 `SESSION_COLUMNS`（`:212-213`）+ `toSessionView`（`:603-611`）读回新会话五字段视图；
  - 返回类型取 `SessionStore["create"]` 的返回类型，必要时 `SessionView` 只作类型导出。

## Fork 执行序（Governing invariant 的落点）

1. **`run`**：
   - 先同步读 `busy = controls.held(sourceId)`，再 `controls.during(sourceId, () => { plan = #precheck(...); retired = retireSource(sourceId); return #fork(plan, retired); })`。
   - 预检、登记、源 retire 的发起都在同一同步段内。
   - `during` 同步抛错时先释放再抛（`turn-control.ts:190-201`）。`run` 是 async，所以一切失败都以 rejection 给出，不同步抛错。
2. **`#precheck`**（同步，按父文段落次序）：
   - `getMessages(sourceId, ownerId)` 或 `runtimeState` 为 null → `not_found`；
   - `messageId` 不是该会话 `user` 行 → `bad_request`。行已按 `(created_at,id)` 升序，`store.ts:264-268`；
   - `busy` 或 `status==="running"` → `session_busy`；
   - `ompSessionFile === null` → `agent_unavailable`。
   - 记下以下各项，并预生成 `sessionId = randomBytes(16).toString("hex")`：
     - `ordinal`（该 user 在 user 行中的下标）；
     - `text`（其 `content`）；
     - `expectedAssistantId`（末条 assistant 的 id，无则 null）；
     - `file`。
3. **`#fork`**：
   - (a) `await retired`：源 slot 退出、名额释放、slot 删除（`supervisor.ts:689-706`）。若源进程正在被 runtime 内部的空闲回收，`runtime.shutdown()` 会等同一次 `#retire`（`runtime.ts:186-197`）。
   - (b) `entry = await pool.admit({busy: () => controls.held(sourceId), retire: () => shutdownTemp()})`：
     - `retire` 从不 reject（carry-forward :53）；`busy` 在临时进程存活期间恒真，所以它不会被驱逐（omp-pool「（fork 临时进程则为其源会话）」）。
     - `agent_capacity` 原样 reject。
     - 准入后查 `closed()`：为真则 `pool.release(entry)` 并返回 `agent_unavailable`（同 `supervisor.ts:386-390`）。不在准入前另查：准入前那一次与这一次不可区分（shutdown 期间准入至多驱逐一个 shutdown 本就在 retire 的进程），`#onNewSlot` 也只有准入后这一处。证据：F11/M22。
   - (c) 构造临时 runtime：`temp = new SessionRuntime(sessionRuntimeOpts(config, {sessionId: plan.sessionId, ownerId, resumePath: plan.file, tokens: temporaryTokens(pool, entry, tokens), onExit: () => pool.release(entry)}))`。
     - 不传 `onApproval`；不进 `#slots`；登记进 `#temps`。
     - `onExit` 同步且不抛（carry-forward :42/:45）。
   - (d) 在 `try` 内执行：
     - `get_branch_messages`，包在 async 内：`command` 在 closed/busy 时同步抛（`runtime.ts:249-254`）。任何失败 → `agent_unavailable`，因为临时进程从不重准入。
     - `entryAt(data, ordinal, text)` 为 undefined → `agent_unavailable`，不发 `branch`。
     - `branchTo(temp, entryId)`。
     - **liveness 守卫**：`!pool.holds(entry)` → `agent_unavailable`。
       - 它**不是** #622 不变量的对应物：regenerate 提交后要在同一进程上派发，所以要求进程活着；fork 在提交前就关停临时进程，提交也不使用它。
       - 它保护的是「回答 `get_state` 的进程仍是被准入的那一个」：
         - 兜住 F10 的重 spawn 情形（`temporaryTokens` 失守时，第二个进程不持名额）；
         - 兜住 F1 的同段退出：exit 监听先于应答续体执行（#465 F2(c)），名额已释放，此处为假。
       - 它与 `get_state` 应答的续体在同一同步段，从应答到这里只经过微任务；关停之后再查恒为假，所以只能放在这里。
       - 它**观察不到**等待关停期间或信号升级期间的崩溃，因此**不能**证明新文件已完整落盘；该项仍归 9.3 真二进制验证。
   - (e) `finally`，每条路径都执行：
     - `await temp.shutdown()`（有界 retire；`runtime.ts:186-197`）；
     - `pool.release(entry)`（幂等，兜住无 pid 失败：runtime 对这种进程不调 `onExit`）；
     - `tokens.revoke(plan.sessionId)`（幂等，兜住 carry-forward :46 的无 pid close 路径可能跳过 runtime 撤销；fix pass 1 实证：只有「无 pid 子进程握手成功后命令中 close」这一条路径仅靠此处撤销，F13/M23）；
     - `#temps.delete(temp)`。

     这里的 await 等子进程退出，是真实的 I/O 边界。
   - (f) 关停之后：
     - 先查 `closed()` → `agent_unavailable`。shutdown 可能在关停途中开始；此时 store 仍开着（`index.ts:57-89` preClose → `closeSessions` 先 shutdown 后 close），但不再写。
     - 然后同步调 `store.commitFork(...)`：
       - `HttpError` 原样返回（CAS 未命中 → `session_busy`）；
       - 其它异常 → `agent_unavailable`（`turn-control.ts:329-333` 先例）；
       - 成功返回 `{session, draft: branched.text}`。
   - 事务 `copyForkHistory`：
     - CAS 复核：源行存在、`status !== "running"`；末条 assistant（`role='assistant' ORDER BY created_at DESC, id DESC LIMIT 1`）的 id 等于 `expectedAssistantId`；分叉点 user 行仍在。任一不满足 → `HttpError("session_busy")`，不写入。
     - 插入新会话行：`INSERT INTO chat_sessions(id, owner_id, title, status, omp_session_file, parent_session_id, created_at, updated_at) SELECT ?, owner_id, title, 'idle', ?, id, ?, ? FROM chat_sessions WHERE id = ?`。`stream_epoch` 取列缺省 0；标题无损复制。
     - 消息：`(created_at,id)` 严格早于分叉点，按 `(created_at,id)` 升序逐行 `INSERT INTO chat_messages(session_id, role, content, status, created_at) SELECT ?, role, content, status, created_at FROM chat_messages WHERE id = ?`，记录旧 id → 新 id。
     - 步骤：每条消息的 `chat_steps` 按 `(ordinal, id)` 升序拷贝，列为 `ordinal,name,detail,output,status,started_at,ended_at`。
     - 审批：每条消息的 `chat_approvals` 按 `id` 升序拷贝，列为 `request_id,tool,title,requested_at,expires_at,decision,decided_at`。
     - 全部用**显式列** `INSERT … SELECT`：TEXT 字节原样复制，不经解码；change B D14 届时在这些列清单上追加 035 列（`035_chat_session_metadata.sql:3`）。
     - 末条被拷贝 assistant 的 status：为 `running` 时抛普通 Error（映射 502，整体回滚）；否则 `UPDATE chat_sessions SET status=?, updated_at=? WHERE id=? AND status='idle'`，`requireChanges 1`。无拷贝消息时保持 `idle`。
     - 源会话的行与文件全程只读。

## Governing invariant

- 一个 `.jsonl` 在任何时刻至多被一个 omp 进程打开：源进程先退出，临时进程才准入；占用挡住源会话的再次 spawn。
- fork 对 SQLite 只做一次写入，即 (f) 的单事务；此前任何失败都不留下任何行。
- 源会话的行、`omp_session_file` 与文件全程不变。
- fork 兑现或拒绝时，临时进程已退出、名额与 token 已释放、源占用已释放。

## 决定
1. **新会话行在事务内插入**（proposal 偏离 1）。因此无需对新 id 持占用，也没有补偿删除；crash 与 shutdown 都不留孤儿。
2. **carry-forward :100「源 slot 退出后留下无名额 slot」由构造保证，不改 `#onProcessExit`**（`supervisor.ts:429-434`）。
   - `retireSource` 与占用登记在同一同步段，对任何已登记的源 slot 调用 `#retireSlot`；后者在退出后删除该 slot（`:703-705`）。
   - 占用期间 `#onProcessExit` 虽然保留 slot，但删除由 fork 发起的 retire 负责。
   - 占用又挡住 prompt/regenerate 在源会话上新建 slot（`:288-291`、`branching.ts` 预检）。
   - 所以 fork 期间不可能出现「保留而无名额」的源 slot。临时进程不是 slot，其退出只释放名额。
3. **临时进程的 token 键 = 预生成的新会话 id**。它不会覆盖源会话的 token：源 token 已随源 retire 撤销，而 `TokenRegistry` 按会话 id 一对一（`tokens.ts:13-23`）。事务提交前临时 token 已撤销，新会话首次 prompt 另发 token。
4. **没有补偿写**：失败路径只关停临时进程、释放名额与占用，SQLite 无任何写入。
5. **注入 prompt 的瞬时行**：REST prompt 注入走 `acceptPrompt → supervisor 拒绝 → rollbackPrompt`（#465 偏离 3）。这三步之间只有微任务；fork 的事务在子进程退出（宏任务）之后运行，看不到瞬时行。即使看到，CAS 也只会走向 409。
6. **不新增假 omp 场景**（`fake-omp.mjs` 793/800）：
   - 真实子进程用 `branch` 场景的固定列表（`:52-55`）与 `--branch-entry`（`:84-92`）；
   - FakeChild 复用 `session-regenerate-helpers.ts` 的 `scriptedRuntime`（`:356`）与 `ChildScript` 的 `keepStdout`/`exitAfterState`/`hold:"branch"`/`prompt:"hold"`（`:249-266`）。该脚本的 `branch` 恒回 `"second question"`，所以 FakeChild 用例一律对 u2 fork。

## carry-forward 对照（`.workplans/epic-448/carry-forward.md`）
| 行 | 要求 | 本刀落实 |
|---|---|---|
| :10/:11 | approvals 拷贝与新会话插入的接线留在 `store.ts`；`store-branch.ts` 不值导入 `store.ts`/`store-approvals.ts` | 事务与插入 SQL 在 `store-branch.ts`，只值导入 `HttpError`；视图映射留在 `store.ts`（偏离 3） |
| :30 | 按序号+文本对齐；原会话文件不动；9.3 真二进制首条 user fork | `entryAt(data, ordinal, text)`（R6/M8/M9）；R1 断言文件字节与 mtime；9.3 → Open question |
| :42/:45 | owner 回调同步、不抛，不在 onExit 内作答 | 临时进程 `onExit` 只 `pool.release`，不传 `onApproval` |
| :46 | 无 pid close 路径可能跳过 token 撤销 | (e) 无条件 `tokens.revoke(sessionId)`；F13/M23（`missing`/`throw`/握手前 close 由 runtime 自行撤销，R10 另断言其结果） |
| :53 | `PoolMember.retire` 永不 reject | 临时进程成员 `retire` 带 `.catch(noop)` |
| :63 | branch 后恒跟 get_state；帧为字面量 | 共用 `branchTo`（`turn-control.ts:296-315` 原体） |
| :64 | `#prompt` 在 `#commanding` 期间同步 busy 会 retire 活 slot | 临时进程不是 slot；占用在 `#prompt` 派发前拒绝源会话（`supervisor.ts:288-291`，R5/M7） |
| :84 | #474 之前的 NULL 审批行 | 按父文「原值」拷贝；是否改为结算 → Open question |
| :95 | 注入 fork 到 regenerate 间隙；spawn 契约句 fork 一半；「上限恒成立」与退出枚举；控制占用的 fork 部分 | R4；omp-runtime delta；omp-pool delta + G1/R10；turn-control delta |
| :100 | 提交段 liveness 守卫；占用期间源 slot 退出；`during` 同步抛错测试；事务中途 CAS 故障测试 | fork 提交不用临时进程，#622 意义上的守卫无对应物；(d) 的 `pool.holds(entry)` 只保证回答 `get_state` 的是被准入进程（F1/M13、F10/M21），不证明落盘（9.3）。决定 2 + R9/M11；R8/M10；F4/M15 |
| :102 | SQLite 领先 omp 文件 → 永久 502 | OPEN，Open question，不在本刀修 |
| :103 | 父 Scenario「fork 各 RPC 间隙」的「X 应答后」不可达；`turn-control.ts` 439/440 | 改为「应答未到」+ 自写第五间隙（R5/F3）；偏离 2 纯移动 |

## Must preserve
- regenerate 全部语义与证据：`session-regenerate{,-faults}.test.ts` 零 diff 全绿；纯移动后 `Regenerations` 逐字不变，只有 commit 2 把 `#branch` 改为调用共用函数。
- `#prompt` 的占用判定与 #490 意图语义（`supervisor.ts:282-311`）；`stop` 的 `during`（`:238-250`）；`#translate`（`:721-732`）。
- 每次 generation 获取 epoch 恰 +1（`pool.ts:173-220`）；临时进程**不**经 `generationTokens`。
- 进程池判定规则（`pool.ts:131-162`）；`#onProcessExit`（`supervisor.ts:429-434`）不变。
- `SessionSupervisorPort`（`rest.ts:15-20`）不变。
- 零 diff：`omp/`、`rest.ts`、`approvals.ts`、`events.ts`、`index.ts`、`app.ts`、`store-approvals.ts`、`fake-omp*.mjs`、web。

## Sibling surfaces
- **必然变红的既有测试：无。允许的既有测试编辑：无。**
  - 已核对：没有测试导入 `turn-control.ts`/`pool.ts`/`store-branch.ts`（`grep -rln "sessions/turn-control\|sessions/pool\|sessions/store-branch" server/test` 为空）。
  - `SessionStore` 新增必选方法不影响测试：没有手写实现或 `satisfies SessionStore`。
- 守护（零 diff 全绿）：
  - `session-regenerate*.test.ts`；
  - `session-supervisor{,-admission,-claims,-faults,-sinks,-stream,-subscribe,-pool,-pool-exit}.test.ts`；
  - `session-stop*.test.ts`、`session-approval*.test.ts`、`session-rest.test.ts`、`session-store*.test.ts`；
  - `omp-runtime*.test.ts`、`migration-034.test.ts`（`parent_session_id` SET NULL 与级联）。
- 生产方/消费方：fork 不发布任何事件、不建 ring，SSE 与 web 不变；`reconcileOnStartup` 不变（fork 不留 running 行）。

## Seams under test
- 新建三个文件，各 ≤800 行，不 import `pool.ts`/`turn-control.ts`/`branching.ts`/`store-branch.ts`，不访问私有字段：
  - `server/test/session-fork.test.ts`（真实 fake）；
  - `session-fork-faults.test.ts`（FakeChild）；
  - `session-fork-helpers.ts`。
- 只用：`supervisor.fork`/`regenerate`/`stop`/`controlHeld`/`streamCursor`/`liveProcessCount`/`subscribe`/`sessionStreamSubscriberCount`、REST prompt 与 `GET /api/sessions`、SQL 行、子进程 stdin/stdout 记录、spawn argv/env，以及 `fixture.tokens.lookup`。
- helper：
  - `seedTwoTurns(world, {a1?, u2Text?, extraTurn?})`：用 `store.acceptPrompt` + `finishTurn` 播种 u1=`"first question"`→a1、u2=`"second question"`→a2，然后 `presetSessionFile` 指向一个**真实**临时文件（`realSource()` 返回路径与 `unchanged()`：字节与 `mtimeMs` 比较）。不 spawn，所以 fork 的临时进程是 0 号子进程。
  - `openForkWorld(opts)`：包装 `openRegenWorld`（`session-regenerate-helpers.ts:154`）。对 `{runtime: world.rt.runtime, children: world.rt.children}` 调 `sampleSpawns`（`session-supervisor-pool-helpers.ts:49`）。supervisor 每次构造 runtime 都读同一 `rt.runtime`，所以开世界后包装仍然生效（#465 design 已证）。
  - `openCappedWorld(cap)`：`createRealFakeRuntime("branch")` → `gateApprovals` → `sampleSpawns` → 置 `rt.runtime.maxProcesses = cap`（`RuntimeOptions.maxProcesses` 可选，`session-supervisor-helpers.ts:36`）→ `openRecordingSession(rt.runtime)`。
  - 规则：带上限的世界一律改写 runtime 对象上的 `maxProcesses`，**绝不展开（spread）runtime**。supervisor 把传入对象保存为 `#runtime`，展开得到的是副本，此后对 `rt.runtime.spawnImpl` 的 `switchSpawns`/`sampleSpawns`/`mixedScenarios` 包装都到不了它（R3、R10、G1 依赖开世界后的包装）。
  - `openForkScripted(scripts, cap?)`：`scriptedRuntime` + `openRecordingSession(rt.runtime)`，`cap` 经 `rt.runtime.maxProcesses = cap` 设置。与 `session-regenerate-faults.test.ts:40-46` 的 `openScripted` 不同：后者展开 runtime（`{ ...rt.runtime, maxProcesses: cap }`），违反上一条规则；本 helper 不照抄。
  - `mixedScenarios(rt)`：带 `--resume` 的 spawn 追加 `--scenario branch`，其余追加 `--scenario hang-prompt`（基础 scenario 置 undefined）。
- R4 的 regenerate 扣住世界：照 `session-regenerate.test.ts:53-59` 的局部 `heldRegenerate`，在新 helper 中重建（不改既有文件）。
- 扣住点：复用 `HOLD`（`session-regenerate-helpers.ts:42-50`）。`HOLD.state` 只匹配含 `/branch-` 的 `get_state`，握手的 `get_state` 回的是 resume 路径。`hold` 只作用于首个子进程（`session-approval-helpers.ts:96-101`）。
- 「关停未完成」间隙：
  - FakeChild `keepStdout`：临时进程 stdin 关闭后不退出，等 `child.stdin.writableEnded` 为真即进入该间隙；
  - 放行用 `child.endStdout(); child.exit(0)`；在此之前不推进注入时钟，否则 5000ms 后会升级 SIGTERM。
- shutdown 时点：`shutdown()` 先置 `#closed` 再同步清订阅（`supervisor.ts:253-255`）。测试先 `subscribe` 一个会话，调 `fixture.close()` 后等 `sessionStreamSubscriberCount === 0`，即可确定性地得知 `#closed` 已为真。

## Required evidence
标记：R 先红后绿；G 守护，恒绿；M 变异，记入 PR body。所有 fork 调用都断言不同步抛错。

**`session-fork.test.ts`（真实 fake-omp `branch`）**
- **R1 正常分叉 + 非 generation**（Scenario「正常分叉」「拷贝审批记录」「Fork temporary runtime is not a generation」）
  - 输入：
    - `openForkWorld()`，REST prompt u1、u2 各完成一回合（0 号子进程存活）；
    - 用 SQL 给 a1 插两条审批（`deny`、`timeout`，照 `migration-034.test.ts:277`）；
    - `presetSessionFile` 指向真实文件 F；
    - `subscribe(source)`；
    - 记下 `snapshot(db, source, true)`、事件数、0 号子进程 stdin 长度。
    - 然后 `fork(source, OWNER, u2)`。
  - 期望：
    - 兑现结果的键恰为 `["session","draft"]`，`draft === "second question"`；`session` 恰五键，`title === "first question"`，`status === "done"`，id 为新。
    - 新行：`parent_session_id` 为源 id；`omp_session_file` 匹配 `/branch-.*\.jsonl$/` 且等于 1 号子进程最后一次 `get_state` 应答；`stream_epoch` 为 0；`streamCursor(new)` 为 `{epoch:0,seq:null}`。
    - 新会话 messages 为 u1、a1 的副本：
      - id 为新，`content`/`status`/`created_at` 相同；
      - a1 步骤逐字段相同（`ordinal,name,detail,output,status,started_at,ended_at`）；
      - 审批按 id 升序为 `deny`、`timeout`，七个原值字段相同，无 NULL；
      - 无 u2/a2 副本。
    - 源侧：快照（含 epoch）不变；F 字节与 mtime 不变；0 号子进程 fork 后无新 stdin 帧且已退出；订阅者未收到事件；`world.events` 无新增。
    - 1 号（临时）子进程：
      - 握手之后（`stdin.slice(2)`，握手帧集属 `OmpProcess`）的 stdin 类型恰为 `get_branch_messages,branch,get_state`，`branch.entryId === "fake-entry-2"`，全程没有 `prompt`；
      - `await` 返回当下已退出；
      - `liveAtSpawn[1]` 为 `[]`；
      - `fixture.tokens.lookup(calls[1].token) === null`。
    - spawn 契约：`calls[1]` 去掉 `--resume` 对后的 argv 等于 `calls[0]` 的；env 键集合相等；`resumePath(calls[1].args) === F`。
    - `controlHeld(source) === false`；`GET /api/sessions` 列出两会话。
    - 随后：新会话 REST prompt 202，2 号 spawn 为 `--resume <新文件>`，完成 `done`；源会话 REST prompt 202，`--resume F`。
  - M1：不先 retire 源进程 → `liveAtSpawn[1]` 含 0，变红。M2：不拷审批 → 变红。M3：临时进程经 `generationTokens` → 源或新会话的 `stream_epoch` 变化，变红。
- **R2 新会话状态三态**（Scenario「新会话状态随拷贝历史」；播种、不起源进程）
  - (a) 对 u1 fork：`status:"idle"`，messages `[]`，`draft === "first question"`，`branch.entryId === "fake-entry-1"`，新文件已落库。
  - (b) a1 为 `stopped`，世界 `entries:["first question"]`，对 u2 fork：`status:"stopped"`。
    - 列表为 `[first, second, first]`，序号 1 仍对齐。
    - 随后 `regenerate(new)` 兑现，末项 `fake-entry-3` 对齐新会话末条 user，回合 `done`。
  - (c) a1 为 `failed`：`status:"failed"`。
  - M4：status 取源会话 status → (b)(c) 变红。
- **R3 cap=1 源进程存活**（Scenario「源会话存活进程先退出」「fork 先退回源会话进程」）
  - 输入：`openCappedWorld(1)`，REST 两回合，对 u1 fork。
  - 期望：
    - 兑现，无 503；`expectWithinCap(liveAtSpawn, 1)`；`liveAtSpawn[1] = []`；兑现时 `liveProcessCount() === 0`。
    - 随后源会话 REST prompt 202，`--resume` 为源文件，`stream_epoch` 恰 +1。
  - M5：不 await 源 retire → 临时准入时源条目仍在（占用中不可驱逐）→ `agent_capacity`，变红。
- **R4 regenerate 各间隙注入 fork**（carry-forward :95）
  - 输入：四个 `HOLD` 点各开 `heldRegenerate`；扣住期间 `fork(session, OWNER, <其 user id>)`。
  - 期望：
    - reject `session_busy`；`chat_sessions` 行数、快照（含 epoch）、子进程 stdin、spawn 数均不变；
    - 放开后 regenerate 兑现 `done`。
  - M6：fork 预检不看占用 → 变红。
- **R5 fork 四个 RPC 间隙**（Scenario「fork 各 RPC 间隙的并发请求」的 ready / messages / branch / state）
  - 输入：`seedTwoTurns`，`openForkWorld({hold})`，fork(u2)，`heldLine`。扣住期间向源会话注入：
    - REST prompt → 409 `SESSION_BUSY_ENVELOPE`；
    - `regenerate(source)` → `session_busy`；
    - `fork(source,u2)` → `session_busy`。
  - 另在 `branch` 点：`await stop(source)` resolve，无新帧，`controlHeld(source)` 仍为 true。
  - 期望：
    - 源快照（含 epoch）、F、`chat_sessions` 行数、临时子进程 stdin、spawn 数不变；
    - 放开后原 fork 兑现，行数 +1，`controlHeld === false`。
  - M7：去掉 `#prompt` 的占用判定（`supervisor.ts:289`）→ REST prompt 在占用中 spawn 源进程，变红。
- **R6 对齐失败**（Scenario「对齐失败回滚」「失败后释放占用」）
  - (a) `u2Text:"other"`，对 u2 fork；(b) `extraTurn`（第三条 user），对 u3 fork。
  - 期望：
    - reject `agent_unavailable`；临时子进程 stdin 无 `branch`；行数、源快照、F 不变；
    - 子进程已退出；`controlHeld === false`；随后源会话 REST prompt 202，`--resume F`。
  - M8：只比文本不比序号（取末项）→ (a) 变红。M9：不校验越界 → (b) 变红。
- **R7 预检**（Scenario「非法目标与运行中」）
  - bad_request：assistant id、他会话 user id、`999999`。
  - not_found：他人 owner、未知会话。
  - `omp_session_file` 置 NULL → `agent_unavailable`。
  - `fixture.close()` 之后 → `agent_unavailable`。
  - running 源（`openStopWorld("abort-ok")` + `heldTurn`）→ `session_busy`，且该子进程 stdin 未结束、无新帧。
  - 以上均无 spawn、无行变化、不同步抛错。
- **R8 `during` 同步抛错释放**（carry-forward :100，#622 R8d 类）
  - 输入：`vi.spyOn(store,"getMessages").mockImplementationOnce(() => { throw new Error("r8") })`。
  - 期望：fork reject 原 Error（非 `HttpError`）；`controlHeld(source) === false`；无 spawn；随后 REST prompt 202。
  - M10：`during` 的 catch 不释放 → 变红。
- **R9 源进程空闲回收进行中**（#463 E6 / #465 R9 类，carry-forward :100 的时序面）
  - 输入：
    - `openForkWorld({scenario:"hang-eof"})`，REST 两回合；
    - `advance(IDLE_MS)`，等 0 号 stdin 结束；
    - `setScenario("branch")`；
    - fork(u2) 保持 pending，`calls.length === 1`；
    - `advance(5000)`。
  - 期望：
    - 0 号退出后才有 1 号 spawn（`liveAtSpawn[1] = []`），fork 兑现；
    - 随后源会话 prompt 202，`--resume` 为源文件，epoch 恰 +1。
  - M11：`retireSource` 只在 `pool.holds` 且无 runtime 内部回收时执行 → 1 号在 0 号存活时 spawn，变红。
- **R10 无 pid 启动失败**（omp-pool「进程退出即释放名额」的 fork 枚举）
  - 输入：cap=1，`switchSpawns`（`session-supervisor-pool-helpers.ts:84`），`missing` 与 `throw` 各一次 fork，然后 `valid` 再 fork。
  - 期望：前两次 `agent_unavailable`，`liveProcessCount() === 0`，无新行，`controlHeld === false`；第三次兑现。
  - M12：去掉 (e) 的 `pool.release` → 第二次起得到 `agent_capacity`，变红。
- **G1 上限恒成立**（omp-pool Scenario「上限恒成立」父文）
  - 输入：cap=2，四会话，`mixedScenarios`。以下四个 `Promise.all` 并发：S1、S2 的 REST prompt；S3 播种后 `regenerate`；S4 两回合播种后 fork(u2)。
  - 期望：
    - 每个结果只能是成功或 `agent_capacity`（REST 503 用 `expectCapacity`）；
    - 每次 capacity 出现时 `liveProcessCount() === 2`（A2 先例，`session-supervisor-pool.test.ts:62-93`）；
    - `expectWithinCap(liveAtSpawn, 2)`；fork 若被拒，则无新行。
  - 恒绿不变量（确定性的红面由 F7 承担）。

**`session-fork-faults.test.ts`（FakeChild；播种两回合于 P，对 u2 fork）**
- **F1 liveness 守卫**（回答 `get_state` 的仍是被准入进程；非 #622 意义上的提交前存活）
  - 输入：`[{exitAfterState:true}]`。
  - 期望：`agent_unavailable`；无新行；spawn 1 次；stdin 含 `branch`；源快照不变；`controlHeld === false`。
  - M13：去掉 `pool.holds(entry)` 检查 → fork 兑现、新行出现，变红。
- **F2 提交时 CAS 复核**（Scenario「fork 最终事务复核失败」，父文时点）
  - 输入：`[{keepStdout:true}]`；等临时 `stdin.writableEnded`，再以 SQL 分两例改写源会话：`status='running'`；或插入更新的 assistant。然后 `endStdout()`+`exit(0)`。
  - 期望：
    - `session_busy`；无新行，`chat_messages` 总行数只多出改写本身；
    - 源快照等于改写后的快照；子进程已退出；`controlHeld === false`；
    - 撤销改写后 REST prompt 202，`--resume P`。
  - M14：CAS 不比 id → 第二例变红。
- **F3 关停未完成间隙**（自写第五间隙）
  - 输入：同 F2 进入间隙后，注入 REST prompt / `regenerate` / `fork`。
  - 期望：
    - 依次 409 / `session_busy` / `session_busy`；源快照、行数、spawn 数不变；
    - 放行后原 fork 兑现，行数 +1。
- **F4 事务中途故障**（#622 R5b 类）
  - 输入：
    - 用 SQL 给 a1 插一个步骤与两条审批；
    - 建 `CREATE TRIGGER f4 BEFORE INSERT ON chat_approvals BEGIN SELECT RAISE(ABORT,'f4'); END`。此时新会话行、消息、步骤已插入。
  - 期望：
    - `agent_unavailable`；`chat_sessions`/`chat_messages`/`chat_steps`/`chat_approvals` 总行数不变；源快照不变；`controlHeld === false`；
    - `DROP TRIGGER` 后再 fork 兑现，拷贝完整。
  - M15：去掉 `runOwnedTransaction` 包裹 → 残留半个会话，变红。M16：非 `HttpError` 不映射 → reject 原始 SQLite 错误，变红。
- **F5 末条被拷贝 assistant 为 running**
  - 输入：SQL 置 a1 `status='running'`（会话仍为 `done`）。
  - 期望：`agent_unavailable`，无新行。
  - M17：去掉守卫 → 新会话 `running` 且无活跃回合，变红。
- **F6 关停途中 shutdown**
  - 输入：
    - `[{keepStdout:true}]` 进入间隙，`subscribe` 一个会话；
    - 包一层 `db.close`，在真正关闭前读 `chat_sessions` 行数；
    - 调 `fixture.close()`，等 `sessionStreamSubscriberCount === 0`，然后 `endStdout()`+`exit(0)`。
  - 期望：fork `agent_unavailable`；close resolve；关闭时的行数不变；`liveProcessCount() === 0`。
  - M18：去掉关停后的 `closed()` 复查 → 行数 +1，变红。
- **F7 临时进程计入上限**（Scenario「临时进程计入上限」「池满与临时进程释放」第二支）
  - 输入：cap=1，`[{hold:"branch"},{}]`，fork 挂在 `branch`；另一会话 REST prompt。
  - 期望：
    - 503 `agent_capacity`，临时子进程 stdin 未结束、无信号；
    - 放开后 fork 兑现，`liveProcessCount() === 0`；
    - 另一会话再 prompt 202，无驱逐；新会话 REST prompt 202，`--resume` 为事务写入的新文件。
  - M19：临时进程不经池准入 → 首个 prompt 202，变红。
- **F8 池满**（Scenario「池满与临时进程释放」第一支）
  - 输入：cap=1，另一会话回合挂起（`prompt:"hold"`）。
  - 期望：
    - fork `agent_capacity`；无新行；`controlHeld === false`；spawn 1 次；
    - 放开并等其结束后再 fork 兑现（驱逐它）。
- **F9 shutdown 关停在途临时进程**
  - 输入：`[{hold:"branch"}]`，从不 release；调 `fixture.close()`。
  - 期望：fork `agent_unavailable`；close resolve；`liveProcessCount() === 0`；无新行。
  - M20：`shutdown()` 不调 `Forks.close()` → close 在 `settle()` 后仍 pending（`observePromise`），变红；用例随后 release 收尾。
- **F10 branch 应答后死亡，不得惰性重 spawn**（`temporaryTokens` 的一次性闸门）
  - 输入：`[{exitAfterBranch:true}]`（`session-regenerate-helpers.ts:257,322`：回 `branch` 后同段 `nativeExit(1)`+`endStdout()`）。
  - 期望：
    - `agent_unavailable`；
    - **`rt.calls.length === 1`**；
    - `liveProcessCount() === 0`；
    - 无新行；源快照与源文件不变；
    - `controlHeld === false`；
    - `fixture.tokens.lookup(calls[0].token) === null`。
  - M21：适配器无条件 `issue` → 下一条 `get_state` 起第 2 个子进程（池外），`calls.length === 2`，变红。liveness 守卫此时仍给出 502，所以区分这一变异的是 spawn 数，不是错误码。
- **F11 准入等待中 shutdown**（准入后 `closed()` 复查）
  - 输入：
    - cap=1，`[{keepStdout:true}, {}]`；另一会话 B 经 REST prompt 完成一回合，其 0 号子进程空闲存活，且 stdin 关闭后不退出，所以驱逐它会挂住；
    - A 播种两回合（无源进程），`subscribe` 一个会话；
    - `fork(A,u2)`：准入选中 B 驱逐，停在 `pool.admit`；
    - 调 `fixture.close()`，等 `sessionStreamSubscriberCount === 0`（`#closed` 已为真），然后对 B 执行 `endStdout()`+`exit(0)`。
  - 期望：fork `agent_unavailable`；`rt.calls.length === 1`（没有临时进程被 spawn）；close resolve；`liveProcessCount() === 0`；无新行。
  - M22：去掉准入后的 `closed()` 复查 → shutdown 开始后仍构造临时进程并 spawn（它不在 `Forks.close()` 当时的快照里），`calls.length === 2`，变红。
- **fix pass 1 追加证据**（PR #624 评审）：
  - F12 branch 报告源文件：FakeChild 的 branch 后 `get_state` 回源路径 → `#commit` 在 closed 检查之后、事务之前以 `agent_unavailable` 拒绝（`branched.sessionFile === plan.file`），各表行数、源行与源文件字节/mtime 不变，claim 释放，`liveProcessCount() === 0`，临时 token 已撤销。M24：去掉该检查 → fork 成功且两会话共用一个文件，变红（修复前即红）。oh-my-pi 的 `branch` 总写新文件，正常 fork 不受影响；v18.0.10 实测归 9.3。
  - F13 无 pid 子进程握手后命令中 close：`#spawnFor` 不给无 pid 子进程挂 exit 监听、`#onLogicalExit` 只清空 generation，`shutdown()` 无 generation 早退 → 只有 fork `finally` 的 `tokens.revoke` 撤销临时 token。M23：删除该 revoke → `lookup(token)` 非 null，变红。R10 追加真实无 pid spawn（`missing`/`throw`）的 token 已撤销断言（由 runtime 自行撤销）。
- **G**：Sibling surfaces 全部零 diff 全绿；size-guard、knip、jscpd 无新增。

## Non-goals
- REST 路由与 201 映射：#469。受理前占用检查：#467。web：7.3b。真二进制：9.3。
- 035 元数据列继承：change B D14。
- 源会话失败后的进程恢复：父文明确不恢复，下次 prompt 懒 spawn。

## Review focus
- 源 retire 与占用登记同段、且无条件；临时进程在 `await retired` 之后才准入（R3/R9/M5/M11）。
- 临时进程：
  - 准入后的 `closed()` 复查是 `shutdown()` 与 `#temps.add` 之间唯一的闸门（`Forks.close()` 只关它被调用时已登记的临时进程）（F11/M22）；
  - 不进 `#slots`，没有 `Generation`，token 只 issue 一次且名额必须在（M3/M12，F10/M21）；
  - 每条路径 `finally` 都关停、释放、撤销；
  - shutdown 经 `Forks.close()` 关到它（F9/M20）。
- liveness 守卫的位置：必须在关停之前、与 `get_state` 续体同段（F1/M13）；关停之后只复查 `closed()`（F6/M18）。守卫的理由按 (d) 的如实表述，不宣称证明落盘。
- 事务原子性、显式列无损拷贝、CAS 三项、`running` 守卫；非 `HttpError` → `agent_unavailable`（F2/F4/F5）。
- 纯移动 commit 可按 `--color-moved` 逐行复核；`branching.ts` 与 regenerate 共用 `branchTo`/`entryAt`，jscpd 无新增。
