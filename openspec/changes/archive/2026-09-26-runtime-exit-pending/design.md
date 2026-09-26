# Design: runtime-exit-pending（#462）

父设计：D1「runtime 增 `onExit` 接线……同时修复 slot 泄漏」；D5「审批挂起期间 runtime 空闲计时器暂停（`markPending/clearPending`）」「终态消息不存在 `decision NULL` 的审批」；「模块拆分」`runtime.ts` → `commands.ts`（command/abort/pending 计时面）。

## Change surface
只改 `server/src/sessions/omp/runtime.ts` 与 `commands.ts`。

- **`onExit` 调用点**：从 `#onLogicalExit` 的 `:384` 移到 `#onNativeExit`（`:368-378`），放在 `this.#revoke(gen)`（`:374`）之后。
- **pending 集合**：
  - 新增 `markPending(id)` 与 `clearPending(id)`。`id` 类型为 `string | number`，按 `Set` 的 SameValueZero 比较：`7` 与 `"7"` 是两个键，#464 须始终用同一种类型。
  - 集合是 `Generation.pending`（`commands.ts:23-37`），在 `#acquire` 的字面量（`runtime.ts:242-256`）里建新集合。
  - 两个方法只作用于 `this.#generation`。没有当前 generation 时为空操作，不记录，也不带入下一个 generation。
- **`#resetIdle`（`:622-633`）**：在 `closed`/无 generation/retiring 三个条件之外，再加「`gen.pending.size > 0` 时不装定时器」。
  - `markPending` 新增 id 时清掉定时器。
  - `clearPending` 删掉最后一个 id 时调 `#resetIdle()`。
  - 删不存在的 id、mark 已存在的 id，都不碰定时器。
- **审批转接**：
  - `#bindProcess`（`:337-347`）加一个 `approval` 订阅，交给私有闸门。闸门与 `#onFrame` 的 `:350-356` 逐项相同：先判 `this.#generation !== gen`，再判 `turn === undefined || turn.genId !== gen.id || !turn.sent`，两者任一成立就丢弃；通过则同步调用 `onApproval?.(request)`，载荷原样传递。
  - `respondApproval(id, decision)` 实现为 `this.#generation?.proc.respondApproval(id, decision)`，同步调用、不 await。
  - 类型以语句级 `import type` 从 `./ui-requests.js` 引入。

## Must preserve
- `runtime.ts:59` 的 `onExit?: (exit: OmpExit) => void` 形状。
- `:130-158` `prompt` 的同步 closed/busy 抛错。
- `:160-173` `shutdown` 幂等。
- `:349-367` `#onFrame` 不变：审批的 `extension_ui_request` 帧照常推入回合流，由 #455 归约器过滤。
- `:380-391` `#onLogicalExit` 仍负责使该 generation 上的活跃回合失败并清掉 generation，只把回调移走。
- `:202-212` 串行获取：先 retire 旧 generation，再 acquire。因此同一个 runtime 的 `onExit` 调用互不重叠，每次调用对应的就是刚才存活的那一代。#463 依赖这一点，因为载荷里没有 generation 标识。
- `:312-325` pid-less 判定。
- `:467-509` stdin→TERM@5000→KILL@8000。
- `:607-614` 撤销恰一次。
- `process.ts` 零 diff：
  - `:568-587` 先发 `frame` 再发 `approval`，且 `!#writesClosed` 闸门不变。
  - `:252-260` `respondApproval` 自带「不可写即空操作」。
- `supervisor.ts:263-279` 与 `SessionSupervisorRuntime`（`:32-44`）不传 `onExit`/`onApproval`，归 #463/#464。`app.ts:140-146` 回退 runtime 与 `session-supervisor-helpers.ts` 的 `RuntimeOptions` 都不涉及这两个 per-slot 回调。

## Governing invariant
- 每个取得过 pid 的 generation，恰产生一次 `onExit`，在其 token 撤销之后，载荷为 Node 观察到的真实 code/signal；未取得 pid 的 generation 不产生回调。
- 只有当前 generation 上活跃回合的审批能到达 owner。
- owner 在当前 generation 上持有任一 pending id 期间，空闲回收不会触发。

## 退出点的事实依据
- **pid 子进程**：撤销的第一现场就是 `#onNativeExit` 的 `:374`，由 `child.once("exit")`（`:328-330`）同步触发。`#runRetire` 在 `:486/:492/:538` 的撤销只会发生在原生退出已被观察之后，或 pid-less 的情况下，且 `gen.revoked` 保证幂等。所以把回调放在 `:374` 之后，天然满足「撤销后」。
- **未取得 pid**：Node 对缺失的可执行文件只发 `error` 与 `close(-2,null)`，不发 `exit`（已实测）。`:328` 的监听不会挂上，所以不回调。但 `process.ts:413-415` 会把 `close` 转成 transport `exit`，再进 `#onLogicalExit`，因此回调**不能**放在逻辑退出点。
- **`#spawnFor` 的 gen 不匹配分支**（`:307-311`，直接 SIGKILL，不挂监听）是防御性分支，按当前流程不可达：generation 在 `awaitChild` 解析前不会被丢弃。这里不回调，本刀不测。

## Sibling surfaces
必然变红的既有测试**无**，允许的既有测试编辑为**空**。已逐一核对：

- `omp-runtime.test.ts:79`：两个回合完成后 `exits` 为 `[]`。断言时子进程存活，不变。
- `omp-runtime.test.ts:149/:164`：崩溃 `[{code:2,signal:null}]` 与后续长度 1。值相同，`:164` 时第二代仍存活。
- `omp-runtime-io.test.ts:209`：`[{code:7,signal:null}]`。回调改为在 `nativeExit(7)` 时发出（原先在 8s 排空后），断言时值相同。
- `omp-runtime-io.test.ts:244-265`（过期 generation）：`once("exit")` 加 `gen.native` 守卫，旧子进程再次 `nativeExit(9)` 不会重报。该测试不断言 `exits`。
- `omp-approval-requests.test.ts:441-478`（E8/E9）：不传 `onApproval`。E9 依赖「转接不自动 mark」，仍会被 idle 回收。
- `omp-approval-requests.test.ts:485-488`（E10）：`runtime.ts`/`commands.ts` 不得出现 `extension_ui_response` 字面量，注释里也不行。
- `omp-dispatch.test.ts`、`linux/uid-isolation.test.ts`、`session-supervisor*.test.ts`：都不传这两个回调，行为不变。
- knip：新公开方法由新测试（`test/**/*.test.ts` 为 entry）引用；`commands.ts` 若新增导出，必须被 `runtime.ts` 引用。

## Seams under test
新建一个测试文件，只经公开 API，不访问私有字段。

- **真实子进程**：
  - 用 `createRealFakeRuntime(scenario)`（`session-supervisor-helpers.ts:87-121`），`setScenario` 可切换。
  - 在测试内包装它的 `runtime.spawnImpl`，照抄 #460 `launch()`（`omp-approval-requests.test.ts:61-88`）：把 `--approval-mode` 后的 `yolo` 换成 `write`（#481 之后为空操作）；记录 stdin 写出的帧；对每个子进程 `observeChild`。
  - 直接 `new SessionRuntime({...real.runtime, sessionId, ownerId:"u1", tokens:createTokens(TOKEN), idleMs:IDLE_MS(10_000), clock:real.clock, spawnImpl:wrapped, onExit, onApproval})`。
- **`onExit` 记录器**：在回调内快照 `{exit, live: tokens.live.get(SESSION_ID), revoked: [...tokens.revoked]}`。「撤销之后」即断言调用时 `live === undefined`，且 `revoked` 已含该代的 `issued[i]`。
- **真实退出值**：与 `observeChild(child).exit`（Node 观察值）逐字相等，不写死常量，X8 尤其如此。
- **外部崩溃**：用 `process.kill(child.pid, "SIGKILL")`，绕过 `observeChild` 的 kill 包装，使 `watch.signals` 保持 `[]`，证明 runtime 自己没有发信号。
- **缺失可执行文件**：`bin` 设为临时目录下不存在的绝对路径，spawnImpl 用真实 `spawn`，先例 `omp-runtime.test.ts:636-637`（设 `bin`）与 `:699-706`（真实 `spawn`）。
- **spawnImpl 同步抛错**：先例 `omp-runtime.test.ts:592-594`。
- **FakeChild**：
  - 世界搭法照 `omp-runtime-io.test.ts:319-380`：`harness.fake()`，然后 `emitLine(DEFAULT_READY)`、`replyHandshake()`、`onCommand("prompt")`。
  - pid-less 版照 `omp-runtime.test.ts:721-732`：`pid = undefined`、`kill = () => false`，但**不** `endStdout`，而且照常应答握手。
- **静默窗**：`settlesWithin`（`support/omp-runtime.ts:173`），或者 `waitImmediate` 之后再检查记录。

## Required evidence
真实子进程的退出值（X1、X5、X6 的最终 KILL，P1/P2/P3/F6 的 EOF 退出）一律先 `await watch.exit` 再断言（先例 `omp-runtime.test.ts:92-95`），`waitImmediate` 只用于查信号。

标记说明：R 表示先红后绿；G 表示守护，恒绿；「变异」表示实现后临时删掉对应闸门条件时必须变红，结果记入 PR body。T 为 `"Allow tool: bash\nCommand: echo workbuddy-smoke"`。

**每个 X 项的共同断言**：被测 generation 恰产生 1 条 `exits`；该条等于 Node 观察值；调用时 token 已撤销。然后 `waitImmediate`，再 `await shutdown()`，已退出的那一代不再产生调用。X1–X4、X6、X8 此时 `exits` 仍为 1 条；X5、X9 中其后新起的 generation 会被 `shutdown` 正常上报一条，属于后继代，按各自条目计数。

### 退出上报（X）
- **X1 R 空闲到期**：`normal` 场景，一个回合完成后 `advance(9_999)`，`exits` 为 `[]`；再 `advance(1)`，得到 `{0,null}`，`signals` 为 `[]`。
- **X2 R 活跃回合中 shutdown**：`hang-prompt` 场景，迭代到 prompt ACK 后 `await shutdown()`。迭代器以 `AgentUnavailableError` 失败；`shutdown` 返回时 `exits` 已有 `{0,null}`。
- **X3 R 回合间外部 retire**：`normal` 场景，回合完成后 `await shutdown()`，得到 `{0,null}`，`signals` 为 `[]`。
- **X4 G 回合中崩溃**：`crash` 场景，得到 `{2,null}`。撤销后调用这一点现状已满足。
- **X5 R 回合间崩溃**：`normal` 场景，回合完成后外部 SIGKILL，得到 `{null,"SIGKILL"}`。
  - `watch.signals` 为 `[]`，token 已撤销。
  - 下一个 prompt 以 `--resume /tmp/open-wb-fake-session.jsonl` 起第二代；此时 `exits` 仍为 1 条。
- **X6 R 驱逐式 retire（KILL 升级）**：`hang-term` 场景，回合完成后调 `shutdown()`，不 await。每次 `advance` 之后先 `waitImmediate` 再断言，写法同 `omp-runtime.test.ts:659-674`。
  - `advance(5_000)` 后 `signals` 为 `["SIGTERM"]`；`advance(2_999)` 后 `exits` 为 `[]`；`advance(1)` 后得到 `{null,"SIGKILL"}`。
- **X7 G 从未取得 pid**：缺失可执行文件、spawnImpl 同步抛错，两种情况各一次。
  - prompt 以 `AgentUnavailableError` 失败，`clock.nowMs` 为 0；`shutdown` 后 `exits` 为 `[]`。
- **X8 R 取得 pid 后启动失败**：`missing-session` 场景，prompt 失败。`exits` 恰 1 条，等于该子进程的 Node 观察值，调用时 token 已撤销。
- **X9 R 每代恰一次**：`normal` 场景，依次执行：回合 → idle 回收 → 回合 → `shutdown`。
  - `exits` 为 2 条，按代排序。第 1 条调用时 `revoked` 为 `[issued[0]]`，第 2 条调用时为 `[issued[0], issued[1]]`。

### pending（P）
- **P1 R 单条挂起（真实审批）**：`approval` 场景，argv 为 write；`onApproval` 回调内调用 `runtime.markPending(req.id)`。
  - 迭代到 r1 帧后 `advance(30_000)`：子进程未终止，`exits` 为 `[]`，`signals` 为 `[]`，token 存活。
  - 调 `clearPending("r1")`（不作答），`advance(9_999)` 后仍存活；`advance(1)` 后 EOF 退出 `{0,null}`，`exits` 为 1 条。
  - 挂起的 `next()` 以 `AgentUnavailableError` 失败；全程无 `extension_ui_response`。
- **P2 R 两条挂起（真实并行审批）**：`approval-parallel` 场景，`onApproval` 回调内 mark。
  - 转接记录的 id 依次为 `["r1","r2"]`。
  - `clearPending("r1")` 调两次，`advance(30_000)` 后仍存活。
  - 调 `clearPending("r2")`：`advance(9_999)` 后存活，`advance(1)` 后回收，`exits` 为 1 条，等于 Node 观察值（不写死常量）。
- **P3 R 重复与缺席 id**：`normal` 场景。
  - (a) 回合完成后 `markPending("a1")` 调两次，再 `clearPending("a1")` 一次。计时恢复：`advance(9_999)` 后存活，`advance(1)` 后回收。这证明是集合语义，不是引用计数。
  - (b) 新世界，回合完成后 `advance(9_999)`，调 `clearPending("never")`，再 `advance(1)`，在原截止点回收。这证明清除缺席 id 不重置计时。
- **P4 R 挂起期间的活动不重装计时**：`normal` 场景，回合完成后 `markPending("a1")`，再完整跑一个回合（prompt 与子进程帧都会调 `#resetIdle`）。
  - `advance(30_000)` 后仍存活。
  - `clearPending("a1")` 后满 10_000 才回收。
- **P5 R 集合随 generation 丢弃**：
  - 首个 prompt 前 `markPending("a0")`：不抛、不 spawn。
  - 第一代回合完成后 `markPending("a1")`，外部 SIGKILL。
  - 第二代回合完成后 `advance(9_999)`，调 `clearPending("a1")`（空操作），再 `advance(1)`，第二代被回收。这证明 a0 与 a1 都没有带入第二代。
  - `exits` 为 2 条。

### 转接（F）
- **F1 R 转接（真实审批）**：`approval` 场景，argv 为 write，迭代到 r1 帧。
  - `onApproval` 记录为 `toEqual [{id:"r1",title:T,tool:"bash"}]`，恰一次。
  - 之后 300ms 静默窗内无 `extension_ui_response`。
- **F2 过期 generation（合成）**：
  - 构造第一代 A：pid-less FakeChild，完成握手，prompt 1 ACK。`advance(10_000)` 触发 idle，retire 走 pid-less 路径立即丢弃 A；回合 1 仍记在 A 上，transport 仍在读 A。
  - `A.emitLine(select "rA")` 后，`onApproval` 为 `[]`。这一步是变异项 M1。
  - 对回合 1 调 `return()`，prompt 2 起第二代 B（普通 FakeChild），ACK。
  - `B.emitLine(select "rB")` 后，记录为 `[rB]`，此项为 R；再 `A.emitLine(select "rA2")`，记录仍为 `[rB]`。
  - 若实测 A 的 transport 不再上抛，说明这条推理有误：如实记录并上报，不得改 `process.ts`。
- **F3 无活跃回合（合成，普通 FakeChild）**，三个子项在同一世界内依次进行：
  - (a) prompt → ACK → 终止 `agent_end`，回合完成后 `emitLine(select "rIdle")`：`onApproval` 为 `[]`，stdin 无应答。变异项 M2。
  - (b) 下一代（或新世界）：自定义 `get_state` 处理器先发 select `rEarly`，再回 state。此时回合存在，但尚未绑定到本代（`turn.genId` 仍为 0），`prompt` 帧也未写出。回合照常完成后，记录仍为 `[]`。变异项 M2、M3。
  - 说明：`!turn.sent` 只为与 `#onFrame` 保持一致而保留，没有可观察的窗口。`turn.genId = gen.id` 与 `turn.sent = true`（`runtime.ts:179-186`）在同一段同步代码里完成，中间没有 await；持有 prompt 写入时 `sent` 也已为 true。因此 `turn.genId !== gen.id` 与 `!turn.sent` 在可观察层面是同一个谓词：F3(b) 的 rEarly 到达时两者同时成立。`turn === undefined` 在 strict 下删不掉，改写成 `turn?.` 属等价变异。所以变异矩阵按语义谓词写，不按单个子条件写：
  - M1：删 `this.#generation !== gen`，F2 的 rA 必须变红。
  - M2：删整个回合子句 `turn === undefined || turn.genId !== gen.id || !turn.sent`，F3(a) 与 F3(b) 都必须变红。
  - M3：只保留 undefined 守卫，把 `turn.genId !== gen.id || !turn.sent` 一起删，F3(b) 必须变红。
  - 单独删其中任何一个子条件，要么是等价变异，要么编不过，不要求变红，也不要当成缺陷上报。
  - (c) 正对照：再发一个 prompt → ACK → select `rTurn`，记录为 `[rTurn]`。此项为 R。
- **F4 R 透传（真实审批）**：接 F1，调 `runtime.respondApproval("r1","allow")`。
  - 调用返回后立刻（不 await）检查 stdin 记录：UI 应答恰为 `[{type:"extension_ui_response",id:"r1",value:"Approve"}]`。同步写出是 #473「Deny 先于 abort」的前提。
  - 随后出现无 `isError` 的 `tool_execution_end{toolCallId:"tool-1"}` 与终止 `agent_end`，回合完成。
  - 再调 `respondApproval("r1","deny")`，无写出。
  - 第二个 prompt 在同一子进程上完成，spawn 次数为 1。
- **F5 R 空操作**：
  - (a) 首个 prompt 前调 `respondApproval("r1","allow")`：不抛，spawn 0 次，无 token 签发。
  - (b) `approval` 场景转接 r1 后执行 `const closing = shutdown()`，同步调 `respondApproval("r1","allow")`，此时 generation 正在 retire；`await closing` 后再调 `respondApproval("r1","deny")`。两次都不抛，UI 应答为 `[]`，子进程 `{0,null}`，`signals` 为 `[]`，spawn 次数为 1。
- **F6 R 转接不自动挂起**：`approval` 场景，`onApproval` 只记录，不 mark。转接到 r1 后 `advance(10_000)`：EOF 退出 `{0,null}`，`exits` 为 1 条，UI 应答为 `[]`。

### 源码守护（G）
- **G1 G**：检查 `runtime.ts` 与 `commands.ts` 源码。
  - 按语句而不是按行提取：biome 会把长 import 折成多行（见 `process.ts:20-26`）。对整文件用 `/\b(?:import|export)\b[^;]*?["']\.\/ui-requests\.js["']\s*\)?\s*;/g` 取出所有引用 `./ui-requests.js` 的语句，断言每条都以 `import type` 开头。
  - 以下均无匹配：`import "./ui-requests.js"`、`import("./ui-requests.js")`、`export … from "./ui-requests.js"`。
  - 不得出现 `answerFrame`、`cancelFrame`、`approvalRequest`。
- **G2 G**：递归检查 `server/src/sessions/**/*.ts`，排除 `omp/process.ts` 与 `omp/ui-requests.ts`。
  - 以下均无匹配：值导入 `ui-requests.js`、`extension_ui_response` 字面量。值导入的判定复用 G1 的按语句提取正则（语句级 `import type` 不算值导入），但路径段放宽为 `["'][^"']*ui-requests\.js["']`，以覆盖 omp/ 以外的 `./omp/`、`../omp/` 写法。这条比 spec 的 runtime.ts/commands.ts 范围更宽，是额外的仓库守护，不对应 spec 句子。
  - `size-guard` 退出 0，knip 零新增。

## Non-goals
见 proposal。

## Review focus
- `onExit` 只在 `#onNativeExit` 的撤销之后调用，`#onLogicalExit` 里已删除。未取得 pid 的路径（`close` 有、`exit` 无）不回调。
- `#resetIdle` 的 pending 条件覆盖全部调用方：`:155`、`:181`、`:274`、`:353`，以及 clear 最后一个 id 时的调用。清除缺席 id、重复 mark 都不碰定时器。
- 审批闸门与 `#onFrame` 逐项相同、同步转发，并且不自动 mark。
- `respondApproval` 同步透传，没有当前 generation 时为空操作。
- owner 回调抛错：`onExit` 在子进程 `exit` 监听内执行，抛错会成为未捕获异常，这与既有 `onExit` 一致；`onApproval` 的抛错沿 transport `#onLine` 的既有路径处理。两者都是 owner 契约（同步、不抛），本刀不加 try/catch。评审确认 #463/#464 的 fixture 写明这一点。
