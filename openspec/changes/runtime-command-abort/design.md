# Design: runtime-command-abort（#488）

父设计：D2「停止 = `abort` 帧 …… prompt 尚未派发时 `abort()` 返回 `false`」、D3「接缝：runtime 增 `command(frame)` 暴露 `OmpProcess.request`」、「模块拆分」（`commands.ts` = command/abort/pending 计时面）。行号均以 HEAD `e6f4b63` 为准。

## Change surface
只改 `server/src/sessions/omp/runtime.ts` 与 `commands.ts`，新建一个测试文件。实现分两步提交，同一个 PR：先搬迁（行为不变），再加功能。

## Must add/change

### 第 1 步：搬迁（行为不变）
`runtime.ts` 的下列私有成员改写为 `commands.ts` 的模块函数。它们只读写 `gen` 与时钟，不碰 `SessionRuntime` 的其它私有状态。

| 原位置（runtime.ts） | 新函数（commands.ts） |
|---|---|
| `:38-40` `TERM_GRACE_MS`/`KILL_GRACE_MS`/`SHUTDOWN_BUDGET_MS` | 同名常量；前两个导出（`#runRetire` 用），第三个模块私有 |
| `:627-639` `#awaitChild(gen)` | `awaitChild(gen)` |
| `:641-643` `#closeStdin(gen)` | `closeStdin(gen)`（`#spawnFor:377` 与 `#runRetire` 调用） |
| `:645-650` `#signal(gen, s)` | `signalLive(gen, s)` |
| `:658-672` `#drainHeld(gen, started)` | `drainHeld(clock, gen, started)` |
| `:674-685` `#watchHeldPipe(gen)` | `watchHeldPipe(clock, gen, isCurrent)`，`isCurrent` 即 `() => this.#generation === gen`，在定时器回调里求值，时机与原来相同 |
| `:687-692` `#clearDrain(gen)` | `clearDrain(clock, gen)` |
| `:694-699` `#clearGrace(gen)` | `clearGrace(clock, gen)` |
| `:701-721` `#waitNative(gen, ms)` | `waitNative(clock, gen, ms)` |

改写规则：函数体逐字搬迁，只允许三种替换：
- `this.#clock` → 参数 `clock`；
- `this.#clearGrace(gen)`/`this.#clearDrain(gen)` → `clearGrace(clock, gen)`/`clearDrain(clock, gen)`；
- `this.#generation === gen` → `isCurrent()`。

调用点一对一替换，await 次序与计时器的创建、清除时机不变。

搬迁后 `stdoutEnded`/`destroyStdio`/`raceDelay` 只剩 `commands.ts` 内部调用，因此去掉 `export`，保证 knip 零新增。

留在类内：`#runRetire`、`#finishDead`、`#revoke`、`#dropGeneration`、`#resetIdle`/`#clearIdle`、`#retire`。

### 第 2 步：功能

**`abort(): Promise<OmpFrame> | false`**，同步判定。以下全部成立时才调用 `gen.proc.request({type:"abort", id: this.#nextId()})` 并返回其 Promise：
- `turn = this.#turn` 存在，且 `turn.receiptSettled`。回合仍为当前回合，所以回执只可能是 resolved：所有 reject 路径都先清掉 `#turn`（`:527-555`），或只作用于已不是当前回合的 turn（`:241-243`）。
- `gen = this.#generation` 存在，且 `gen.id === turn.genId`。
- `gen.retiring === undefined`。
- `liveChild(gen) !== undefined`。

任一不成立时返回 `false`：不写帧、不 spawn、不抛错，也不触碰 turn、receipt 或 idle。runtime 内部**不** await、**不** catch 这个 Promise。

**`command(frame)`**：
- frame 类型为 `{type:"get_branch_messages"} | {type:"get_state"} | {type:"branch"; entryId:string}`。若命名导出，从 `runtime.ts` 导出（公开签名留在 `runtime.ts`），并由新测试引用（knip）。
- 同步判定：
  - `#closed` → 抛 `AgentUnavailableError("runtime shutdown")`；
  - `#turn !== undefined` 或已有 command 认领 → 抛 `SessionBusyError`。
- 通过后同步置认领、调 `#resetIdle()`（入口处唯一一次重置：复用存活代时它就是 command 的活动重置，C8 以变异 M8 钉住；新获取的代由 `#acquire` 在 `:319` 自行重置），然后异步执行：
  1. 经泛化后的 `#readyGeneration` 取 generation（见「单一获取路径」）；获取之后**不再**另加 `#resetIdle()`，否则 M8 不可区分；
  2. `await gen.proc.request({...frame, id: this.#nextId()})`；
  3. `success !== true` → 抛 `AgentUnavailableError`；
  4. `frame.type === "get_state"` 且 `data.sessionFile` 为非空字符串，并且 `this.#generation === gen` → 赋值 `#sessionFile` 与 `#resumePath`。纯读取辅助放在 `commands.ts`；
  5. 返回 `response.data`。
- 任何拒绝都映射为 `AgentUnavailableError`，已是该类型的原样透传。`OmpProcess` 在 stdout 截断时拒绝为 `OmpProtocolError("truncated frame")`（`process.ts:544-560`），这里也归一化。
- 认领在 `finally` 中释放，随后再 `#resetIdle()`，因此成功、失败、子进程退出、shutdown 每条路径都会释放。
- `prompt()` 的忙判定（`:154`）改为 `#turn !== undefined || 认领中`。

**单一获取路径**：把 `#readyGeneration(turn)`（`:246-265`）的回合断言参数化，改为传入断言回调。
- prompt 传 `() => this.#assertTurn(turn)`，行为逐字不变。
- command 传一个只检查 `#closed` 的断言。

`await this.#retired` → 复用存活代 → retire 旧代 → `#acquire()` → 获取后再断言，这条次序对两者相同。`#acquire` 仍只有这一个调用方。

**不新增回合结束路径**：
- `command` 不碰 `#turn`。
- `abort` 只写帧；被中断的回合仍经 `#onFrame` 的 `isTerminalEnd` → `#completeTurn`（`:407-409,518-525`）结束，而 `#completeTurn` 已调用 `#clearLocalWait()`。
- 这满足 carry-forward #553：`#localWait` 与 grace 计时器在每条回合结束路径上都被清除。

## Must preserve
- `prompt` 在 closed/busy 时同步抛错（`:151-156`）；`shutdown` 幂等（`:180-193`）。
- `#onFrame` 的 generation/回合闸门（`:397-417`）与 `#forwardApproval` 闸门（`:467-476`）不变。
- `onExit` 恰一次、在撤销之后（`:478-489`）；pid-less 判定（`:357-370`）；撤销恰一次（`:723-730`）。
- stdin→TERM@5000→KILL@8000 与 8000ms held pipe 预算（`:591-721` 搬迁前后）。
- `process.ts` 零 diff：`request`（`:245-249`）自动生成 id，只有 id 与 command 同时匹配才结算（`:591-597`）；stdout 结束时 `#rejectPending`（`:544-553`）；`#started` 之后原生退出不拒绝在途请求（`:621-632`）。command 的「子进程退出即拒绝」依赖的是 stdout 结束，而不是原生退出。
- `commands.ts` 对 `./runtime.js` 只有 `import type`；`runtime.ts`/`commands.ts` 对 `./ui-requests.js` 只有 `import type`，且不出现 `extension_ui_response`（#460 E10、#462 G1）。

## Governing invariant
- 每个 `abort` 帧都晚于它所中断回合的 `prompt` 帧写出完成。
- 每个 generation 只由一条获取路径产生，并恰签发一次 token。
- 任一时刻，同一 runtime 上至多一个 prompt 回合或 command 在途。

## Sibling surfaces
必然变红的既有测试：**无**。允许的既有测试编辑：**无**。已核对：
- 搬迁的守护：
  - `omp-runtime.test.ts:196-275`（EOF、TERM@5000、KILL@8000、hang-term 原生退出）；
  - `:326-427`（竞态 spawn、pid-less、活子进程 error）；
  - `omp-runtime-io.test.ts:176-242`（原生死亡先于管道关闭、held pipe 8s 回收）；
  - `omp-runtime-exit-pending.test.ts` X6/X8/F5。
- `omp-runtime.test.ts:167`「rejects overlapping prompts」：忙判定只多一个条件，无 command 时语义相同。
- `omp-approval-requests.test.ts:485-494`（E10）与 `omp-runtime-exit-pending.test.ts:689-700`（G1）：搬迁代码不含被禁的字面量与导入。
- supervisor、`app.ts` 回退 runtime、`session-supervisor-helpers.ts`：不调用新方法，行为不变。
- `commands.ts` 的 `SessionClock` 类型已从 `runtime.js` 以 `import type` 取得（`:5`），无新环。
- 下游契约：
  - #473/#490 必须处理 abort Promise 的拒绝，并对二次 stop 去重；
  - #465/#466 以 `command` 的 `AgentUnavailableError` 映射 502，并自行 retire（父 D3 :45）。

## Seams under test
新建 `server/test/omp-runtime-commands.test.ts`，只经公开 API，不访问私有字段。

- **真实子进程世界**：照抄 `omp-runtime-exit-pending.test.ts:76-129` 的 `openReal`/`tapStdin`。用 `createRealFakeRuntime(scenario)`（`session-supervisor-helpers.ts:87-121`），包一层 spawnImpl 记录 argv、tap stdin、`observeChild`，再直接 `new SessionRuntime({...real.runtime, sessionId, ownerId:"u1", tokens:createTokens(...), resumePath?, idleMs?, spawnImpl, onExit})`。
  - stdin tap 在每次写调用时记录帧，并快照 `tokens.issued.length`（C1 用）。
  - abort/command 的 id 从 tap 读取，不写死。
- **额外 argv**：`slash --compact-silent` 由包装 spawnImpl 追加 `--compact-silent`，再 `setScenario("slash")`；先例 `omp-runtime-local-command.test.ts:401-415`。
- **idle**：该世界必须把 `idleMs` 设为 600_000，否则推进 120000ms 时会先触发空闲回收（`createRealFakeRuntime` 缺省 `IDLE_MS`=10_000）。
- **slow-ready**：`setScenario("slow-ready")`，用缺省 500ms。这个延迟是真实时间，窗口内不推进注入时钟（carry-forward #461）。握手超时是 `process.ts` 的真实 `setTimeout`（`:700-711`），与注入时钟无关。本刀不依赖到期后精确的关闭时机（carry-forward #571）。
- **probe**：`runtime.prompt(\`probe:${process.pid}:${tmp}/probe.txt\`)`，收集帧后按 `omp-approval-requests.test.ts:180-195` 的办法取 text_delta，再用 `/ frames=(\S*) cwd=/` 取出记录。
- **FakeChild 布线世界**（A7、C8）：照 `omp-runtime-io.test.ts:319-363` 的 `openWired`（`harness.fake()`、`emitLine(DEFAULT_READY)`、`replyHandshake()`、`onCommand("prompt", …)`），`idleMs: IDLE_MS`（10_000，与 `omp-runtime-io.test.ts:36,337` 相同），注入 `createClock()`。`replyHandshake` 注册的 `get_state` 处理器对每个 `get_state` 都应答（`support/omp-rpc.ts:415-423`）；`get_branch_messages` 不注册处理器，所以永不应答。FakeChild 在 stdin 关闭时不会自行退出（`support/omp-rpc.ts:357-410`）。
- **被扣住的 prompt 写入**：FakeChild 世界照 `omp-dispatch.test.ts:245-282`（`harness.fake()`、`emitLine(DEFAULT_READY)`、`replyHandshake()`），用 `holdNextPromptWrite(child)`（`support/omp-rpc.ts:470-500`），再 `child.onCommand("abort", …)` 记录 abort 帧并按需应答。
- **外部崩溃**：`process.kill(child.pid, "SIGKILL")`，绕过 `observeChild` 的 kill 包装（#462 X5 先例）。
- **同步抛错**用 `expect(() => …).toThrow(Class)`，不用 `rejects`。

## fake 能力边界（不加场景）
- 非 `branch` 场景对 `get_branch_messages`/`branch` 回的是**不带 id** 的 `unsupported`（`fake-omp.mjs:248-259`），runtime 的请求因此永不结算。C4、C6 正是借此制造「在途 command」。
- 只有 `branch` 场景会回显这三种命令的 id（carry-forward #457）。`get_state` 所有场景都回显（`:273-296`）。
- `abort-ok`/`slow-ready` 每个进程只兑现第一个 abort；没有挂起回合时的 abort 无帧（carry-forward #456）。所以测试从不 await 回合外或第二次的 abort Promise。
- 以下三个窗口，真实子进程几乎观察不到，只能用 FakeChild 构造：A2 的「写入已开始、回执未兑现」；A7 的「原生退出、stdout 未关」；C8 的「子进程不应答、也不因 stdin 关闭而退出」。

## Required evidence
标记：R 为先红后绿，G 为守护（恒绿）。「变异」指实现后临时施加、对应用例必须变红，结果记入 PR body。每个真实子进程用例结束时都 `await shutdown()`。

### 搬迁（S）
- **S1 G**：只做第 1 步时，既有测试零 diff 全绿，`runtime.ts` ≤705，knip 零新增，size-guard 退出 0。在 PR body 中贴出 `git diff --color-moved` 下只见搬迁块与三种允许的替换。

### abort（A）
- **A1 R `abort-ok` 活跃回合**：`prompt("hi")` → `await dispatched` → 迭代到两段 delta → `abort()`。
  - 返回 Promise；tap 中 `abort` 帧恰 1 个，位于 `prompt` 之后。
  - iterator 剩余帧末尾恰为 `message_end{stopReason:"aborted"}`、终止 `agent_end`，随后 done；iterator 中没有任何 `command:"abort"` 帧。
  - Promise 兑现为 `{id:<tap 中 abort 的 id>, type:"response", command:"abort", success:true}`。
  - 之后 `abort()` 返回 `false`，tap 仍只有 1 个 abort。
  - `prompt("next")` 正常完成；spawn 1 次，`issued` 1 个。
- **A2 R 写入被扣住时返回 false（FakeChild）**：`holdNextPromptWrite` → `prompt("x")` → `await held.entered`（此时 `turn.sent` 已为 true，回执未兑现）。
  - `abort()` 为 `false`，子进程未收到 `abort`。
  - `held.release()` → `await dispatched` → `abort()` 返回 Promise；子进程收到的帧次序为 `prompt` 在前、`abort` 在后。
  - 子进程应答 `message_end aborted`、`agent_end`、`response{abort}` 后，iterator 结束，Promise 兑现。
  - 变异 M1：把判据改为 `turn.sent`，A2 变红：扣住期间写出 abort，且 abort 先于 prompt 到达。
- **A3 R `slow-ready` 派发回执后 abort**：
  - `prompt("stop me")` 后立即 `abort()` 为 `false`（尚无 generation）。
  - 等 `real.children.length === 1` 且 `observePromise(dispatched)` 仍为 pending 时，再次 `abort()` 为 `false`（已获取、握手中）；tap 中无 `abort`。
  - `await dispatched` → `abort()` 返回 Promise；iterator 末尾恰为 `message_end aborted`、`agent_end`，Promise 兑现为 abort response。
  - 随后 probe prompt 取得 `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`；spawn 1 次，`issued` 1 个。
  - 这个世界里不调用 `command`，否则 `frames=` 会多出一条 `get_state`。
- **A4 R abort response 不结束回合（`slash --compact-silent`，`idleMs` 600_000）**：`prompt("/compact")`，第一帧是回执 `{…,data:{agentInvoked:false}}`（回合进入 awaiting-output）；`await dispatched` 之后再调用 abort。
  - `abort()` 返回 Promise，tap 中 abort 恰 1 个；Promise 兑现为 `{id, type:"response", command:"abort", success:true}`。
  - 该 response 作为活跃回合的普通帧推入 iterator（`#onFrame:397-417`），但 iterator 不结束：`settlesWithin(next, 300)` 为 false。
  - `clock.advance(119_999)` 后仍未结束；`advance(1)` 后 done。收集到的帧恰为 `[回执, abort response]`。
  - 之后 `prompt("hello")` 完成，spawn 1 次。
  - 变异 M6：abort response 结束或失败回合，A4 变红。
- **A5 R 无活跃回合**，三个子项：
  - (a) 全新 runtime 上 `abort()` 为 `false`：spawn 0 次，`issued` 为 0；
  - (b) `normal` 场景一个回合完成后，`abort()` 为 `false`，tap 无 `abort`；
  - (c) `shutdown()` 之后 `abort()` 为 `false`。
- **A6 R 正在退役的代**：`hang-prompt` 场景，`await dispatched`，然后 `clock.advance(IDLE_MS)` 触发空闲 retire（回合仍活跃，子进程尚未退出）。
  - 紧接着同步调用 `abort()`，返回 `false`，tap 无 `abort`。
  - 随后回合以 `AgentUnavailableError` 失败，`exits` 1 条。
  - 变异 M2：删掉 `retiring` 条件，A6 变红：tap 出现 abort 写入尝试。
  - A6 同时是 spec「回执兑现之后取得的 `false` 表示回合正经失败路径收尾」一句（退役分支）的证据。
- **A7 R 子进程已原生退出、stdout 未关（FakeChild）**：世界照 `omp-runtime-io.test.ts:319-363` 的 `openWired`，写法同 `:176-190`。`prompt("x")` → `waitPrompt` → ACK → `await dispatched` → `child.nativeExit(0)`（不 `endStdout`）→ `await waitImmediate()`。
  - 此时 generation 仍是当前代：`#onLogicalExit` 要等 stdout 结束（`runtime.ts:491-501`），`#onNativeExit` 只撤销 token 并挂 held-pipe 计时（`:478-489`）。回合仍活跃，`receiptSettled` 为 true，`retiring` 为 undefined，只有 `liveChild(gen)` 为 undefined（`commands.ts:56-67`：`exitCode !== null`）。
  - 断言：`abort()` 恰为 `false`；子进程未收到 `abort`（`onCommand("abort")` 计数 0）；token 已撤销，`exits` 为 `[{code:0,signal:null}]`。
  - 随后 `child.endStdout()`：回合以 `AgentUnavailableError` 失败（`#onStdoutEnd` → `#publishExit` → `#onLogicalExit` → `#failTurn`，`process.ts:544-553`）。
  - A7 是 spec「回执兑现之后取得的 `false`」一句（子进程已死分支）的证据。
  - 变异 M7：删掉 `liveChild` 条件，A7 变红。`abort()` 改为返回一个 Promise，并立即以 `AgentUnavailableError` 拒绝：原生退出时 `#forbidCommands` 已置 `#writesClosed`（`process.ts:621-623`），`#request` 在 `:341-343` 直接拒绝。

### command（C）
- **C1 R 获取上报同 prompt（`branch`，`resumePath` 为 P）**：
  - `command({type:"get_branch_messages"})` 兑现为 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}`。
  - tap 写出该帧时 `issued.length === 1`；argv 末尾恰为 `--resume P`。
  - 随后 `prompt("hi")` 完成：spawn 仍 1 次，`issued` 仍 1 个。
  - 变异 M5：command 另走获取（不复用存活代），C1 或 C3 变红。
- **C2 R branch 家族与新 resume 路径**：接 C1。
  - `command({type:"branch",entryId:"fake-entry-2"})` 兑现为 `{text:"second question",cancelled:false}`。
  - `command({type:"get_state"})` 的 `data.sessionFile` 为 F：F ≠ P，位于 `<stateDir>/sessions/u1/` 下，文件存在；`runtime.sessionFile === F`。
  - `clock.advance(IDLE_MS)` 后 `await watch.exit` 为 `{0,null}`。
  - 下一次 `command({type:"get_state"})` 起第二代，argv 末尾恰为 `--resume F`；`issued` 2 个，`revoked` 1 个。随后 prompt 的回执 `sessionFile === F`。
  - 变异 M3：删掉 get_state 路径采纳，C2 变红。
- **C3 R 回合中忙（`abort-ok`）**：
  - `prompt()` 之后、`dispatched` 之前，以及 `dispatched` 之后，`command({type:"get_branch_messages"})` 两次都同步抛 `SessionBusyError`；tap 无该帧。
  - 然后 `abort()` 收尾。回合结束后 `command({type:"get_state"})` 兑现，spawn 仍 1 次。
- **C4 R 在途互斥与子进程死亡（`normal`）**：`const c = command({type:"get_branch_messages"})`。
  - 同步地，`prompt("x")` 与 `command({type:"get_state"})` 都抛 `SessionBusyError`。
  - 待 tap 出现该帧后外部 SIGKILL，`c` 以 `AgentUnavailableError` 拒绝。拒绝来自 stdout 结束，可能早于 Node 的 `exit` 事件，所以先 `await watch.exit`，再断言撤销与 `exits`。
  - `revoked` 为 `[issued[0]]`；`exits` 为 `[{code:null,signal:"SIGKILL"}]`，且等于 Node 观察值。
  - 随后 `prompt("y")` 完成：第二代 argv 末尾为 `--resume /tmp/open-wb-fake-session.jsonl`，`issued` 2 个。
  - `shutdown` 之后 `revoked` 为 `[issued[0], issued[1]]`，每个恰一次。
  - 变异 M4：拒绝路径不释放认领，C4 变红：`prompt("y")` 抛 `SessionBusyError`。
- **C5 R 失败 response（`branch`）**：
  - `command({type:"branch",entryId:"nope"})` 以 `AgentUnavailableError` 拒绝；`runtime.sessionFile` 不变。
  - 随后 `command({type:"get_branch_messages"})` 兑现；spawn 1 次，`issued` 1 个，`exits` 为空。
- **C6 R 关停**，四个子项：
  - (a) `shutdown()` 后，`command({type:"get_state"})` 同步抛 `AgentUnavailableError`，spawn 次数不变；
  - (b) `normal` 场景 command 在途（未应答）时调 `shutdown()`，command 以 `AgentUnavailableError` 拒绝，shutdown 兑现，子进程 `{0,null}`；
  - (c) `slow-ready` 场景：`command({type:"get_state"})` 后先等 `calls.length === 1`（子进程已 spawn，`ready` 仍被扣住），再 `shutdown()`。command 以 `AgentUnavailableError` 拒绝；spawn 1 次，tap 无任何帧，`revoked` 1 个。
  - (d) 同步变体：`command(...)` 与 `shutdown()` 在同一 tick 内先后调用。command 以 `AgentUnavailableError` 拒绝；spawn 0 次，`issued` 为 0。
- **C7 R command 视为活动（`normal`）**：一个回合完成后 `advance(9_999)`，`command({type:"get_state"})` 兑现；再 `advance(9_999)` 仍存活，`advance(1)` 后回收。它只因方法不存在而先红：response 帧本身就会经 `#onFrame:401` 重置计时，所以本项不区分 command 自身是否调用 `#resetIdle`，不做变异。
- **C8 R command 入口重置空闲计时（FakeChild 布线世界）**：
  - `await command({type:"get_state"})` 兑现为 `{…, sessionFile:"/tmp/open-wb-fake-session.jsonl"}`。此时注入时钟 t=0，空闲截止在 10_000：response 帧经 `#onFrame:401` 重置，结算时 `finally` 再重置，两者都在 t=0。
  - `clock.advance(9_999)`。
  - `const c = command({type:"get_branch_messages"})`，子进程不应答。入口 `#resetIdle()` 把截止推到 19_999；这期间没有任何子进程帧会再重置计时。
  - `clock.advance(9_999)`（t=19_998）后 `await waitImmediate()`：stdin 未结束（`stdin` 的 `finish` 未触发，写法同 `omp-runtime-io.test.ts:118-150`），`c` 仍 pending，`tokens.live` 仍有 token。
  - `clock.advance(1)`（t=19_999）后 `await waitImmediate()`：空闲 retire 已开始，stdin 已结束。
  - 由测试模拟子进程对 EOF 退出：`child.exit(0)` 会同时发出 `exit` 与 `close`，`close` 经 `#onChildClose` → `#onStdoutEnd` → `#rejectPending`（`process.ts:544-553,610-617`）。随后 `c` 以 `AgentUnavailableError` 拒绝，token 撤销恰一次，`exits` 为 `[{code:0,signal:null}]`。
  - 收尾：FakeChild 的 stdout 未结束，`#drainHeld` 会等 8000ms 预算（注入时钟），所以先 `child.endStdout()`，再 `await shutdown()`。
  - 数字依据：`#resetIdle` 以 `this.#idleMs` 装定时器（`runtime.ts:738-749`）；`createClock().advance` 触发所有 `due ≤ target` 的定时器（`support/omp-runtime.ts:62-92`）。
  - 变异 M8：删掉 command 入口处的 `#resetIdle()`，C8 变红。截止仍停在 10_000，第二次 `advance(9_999)` 时 stdin 已结束。

### 守护（G）
- **G1 G**：`commands.ts` 中凡引用 `./runtime.js` 的语句都是 `import type`（按语句提取，正则同 `omp-runtime-exit-pending.test.ts:686-687`）；`runtime.ts` 中 `this.#acquire(` 恰出现一次。

## 行数
- 第 1 步后 `runtime.ts` ≤705（估算 ≈700）。
- 第 2 步后目标 ≤770（估算 ≈765），硬上限 785，仍比 size-guard 低 15 行。S1c 其余 issue 不再给 `runtime.ts` 加代码（4.2b：「runtime 不为停止意图新增任何接口」）。
- 超过 785 时先停下上报编排者，不要自行加刀。预案（需编排者认可）：把 `#runRetire`/`#finishDead` 经一个小端口 `{clock, clearIdle, revoke, drop}` 也搬进 `commands.ts`，仍在 PR Boundary 内。

## Non-goals
见 proposal。

## Review focus
- `abort()` 的 `false` 边界：以回执兑现为准，每个条件都有区分性用例与变异：回执（A2/M1）、退役（A6/M2）、子进程存活（A7/M7），另有 A3、A5。runtime 不 await、不 catch abort Promise。
- command 只在入口重置空闲计时，获取之后不再重置（C8/M8）。
- 只有一条获取路径：`#readyGeneration` 泛化后，prompt 路径逐字不变，`#acquire` 只有一个调用方。
- command 认领在每条结算路径上释放；prompt 忙判定包含在途 command。
- 搬迁：只允许三种替换；计时器的创建、清除时机与 await 次序不变；三个辅助函数去掉 `export` 后 knip 零新增。
- 没有新增回合结束路径（#553 `#localWait`）。
