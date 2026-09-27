# Design: local-command-wait（#553）

父设计：design D15「本地完成的等待」与 Risks。omp 对照：`resource/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1019-1054`（内建命令 `output` → `command_output`，回执 `agentInvoked === true` 否则 false）、`slash-commands/builtin-lifecycle.ts:176-187`（`compact` 后台执行，回执先于输出）、`slash-commands/helpers/todo.ts:246-253`（`/todo` 同步输出，先于回执）。行号为 origin/master。

- **Change surface**：新建 `server/src/sessions/omp/local-command.ts`；`server/src/sessions/omp/commands.ts` 的 `Turn`（:40-47）；`server/src/sessions/omp/runtime.ts` 的 `prompt()`（:134-162 `Turn` 字面量）、`#onFrame`（:381-398）、`#completeTurn`/`#failTurn`/`#abandon`（:453-485）、`#retire`（:509-515）；新测试文件。
- **Must preserve**：
  - 派发文本不以 `/` 开头的回合：匹配的 `agentInvoked:false`（`response{command:"prompt",success:true,data:{agentInvoked:false}}` 或 `prompt_result{agentInvoked:false}`，同 request id）照旧在该帧处结束，该帧为迭代器最后一帧。
  - 终态 `agent_end`（`isTerminal` 缺省或 true）结束回合、同 id 失败回执 `#failTurn` + retire、世代/回合门（:382-389）、每帧 `#resetIdle`、`#forwardApproval` 全部不变；`isTerminalEnd` 优先于本地判定（同一帧不会同时是两者，但次序保持现状：先 push，再判终态）。
  - `SessionRuntime` 公开签名、`SessionClock` 接口、`prompt()` 的 `SessionBusyError`/`dispatched` 语义不变。
  - `omp-runtime.test.ts`、`omp-runtime-io.test.ts`（含 :67-84 local-only 用例）、`omp-dispatch.test.ts`（:85-110）、`session-supervisor.test.ts`（:335-337）、`session-supervisor-faults.test.ts`（:447）零改动全绿——这些用例的 prompt 文本都不以 `/` 开头。
  - 定时器卫生：`omp-runtime.test.ts`「releases owned clock timers…」一类 `clock.pending()` 断言不受影响（宽限定时器在每条结束路径释放）。
- **Must add/change**：
  - `local-command.ts`（纯，无 IO、无模块级可变状态，只 import 类型）：
    ```ts
    export const LOCAL_COMMAND_GRACE_MS = 120_000;
    export type LocalSignal = "local-outcome" | "command-output" | "grace-tick" | "other";
    export interface LocalState { slashText: boolean; outputSeen: boolean; awaiting: boolean; elapsedMs: number }
    export function decideLocalCompletion(state: LocalState, signal: LocalSignal): "complete" | "await" | "none";
    ```
    规则（全表）：`local-outcome`：`awaiting` → `none`（重复结果不重启等待）；否则 `!slashText || outputSeen` → `complete`，否则 `await`。`command-output`：`awaiting` → `complete`，否则 `none`。`grace-tick`：`awaiting && elapsedMs >= LOCAL_COMMAND_GRACE_MS` → `complete`，否则 `none`。`other` → `none`（`agentInvoked:true` 回执、`agent_end`、失败、其它帧一律交给既有规则）。`outputSeen` 表示「本次派发后、本信号之前」已见 `command_output`。
  - `Turn` 增 `slashText: boolean`（`prompt(text)` 时 `text.startsWith("/")`，只看 wire 文本首字符，不识别命令名）与 `commandOutputSeen: boolean`（初值 false）。
  - `runtime.ts` 私有 `#localWait: { turn: Turn; since: number; timer: unknown } | undefined`（同一时刻至多一个活跃回合，故至多一个等待）。
  - `#onFrame` 在既有门与 `turn.stream.push(frame)` 之后：先判 `isTerminalEnd` → `#completeTurn`（现状）；再判 `isMatchingFailure` → 现状；否则按帧分类信号：`isLocalComplete(frame, requestId)` → `local-outcome`；`frame.type === "command_output"` → `command-output`；其它 → `other`。以当前 `{slashText, outputSeen: turn.commandOutputSeen, awaiting: #localWait?.turn === turn, elapsedMs: 0}` 求判定，然后若该帧是 `command_output` 置 `turn.commandOutputSeen = true`。`complete` → `#completeTurn(turn)`；`await` → 记录 `since = clock.now()` 并 `clock.setTimeout(cb, LOCAL_COMMAND_GRACE_MS)`。
  - 定时器回调：若 `this.#localWait` 仍是本次登记的对象且 `this.#turn === turn`，以 `grace-tick` 与 `elapsedMs = clock.now() - since` 求判定：`complete` → `#completeTurn`；`none`（仍在等待，例如墙钟 `Date.now` 与 Node 单调定时器取整不齐使 elapsed 为 119 999，或墙钟回拨）→ 以 `clock.setTimeout(cb, Math.max(1, LOCAL_COMMAND_GRACE_MS - elapsedMs))` 重新挂上并**把 `#localWait.timer` 替换为新句柄**（否则取消会清到失效句柄、新定时器泄漏）。守卫不成立时什么也不做。回调不伪造任何帧。
  - 取消：新 `#clearLocalWait()`（`clock.clearTimeout` + 置 undefined）在 `#completeTurn`、`#failTurn`、`#abandon` 中该回合确实结束时调用；`#retire(gen)` 在 `#localWait?.turn.genId === gen.id` 时也调用（generation retire 后宽限不再计时，回合由既有退出路径失败）。
  - 等待期内其它帧照常 push 并 `#resetIdle`（现状，`#onFrame` 开头已做）。
  - retire 清掉等待后，该回合不再计时，也不会因 retire 窗口内到达的 `command_output` 成功完成（`awaiting` 已为 false，判定 `none`），最终经 `#onLogicalExit` → `#failTurn` 以失败结束——符合 spec（只要求取消定时器），不要「修」它。retire 窗口内首次到达的 `agentInvoked:false` 可能在正在 retire 的世代上挂新定时器，它随逻辑退出的 `#failTurn` 被清，不会触发（接受的残余）。
- **Line budget**：`runtime.ts` 706 行，改后 ≤ 800；`commands.ts` 158 行；新测试文件 ≤ 800。
- **Sibling surfaces**：
  - A #488（open）也改 `runtime.ts`/`commands.ts`（`command(frame)`、`abort()`）；两者无语义依赖，后合者 rebase，本 PR 不预留 abort 钩子。已通知对端会话。
  - `server/src/sessions/supervisor*.ts` 只消费迭代器结束/失败，不改。
  - 10.3 #554 才把 `command_output` 映射为 `text.delta`；本刀后 supervisor 仍按现状处理 `command_output`（过滤），不影响完成时机。
- **Required evidence**（`server/test/omp-runtime-local-command.test.ts`；每条先红后绿，证据 2 与证据 8 的 `/todo`、`hello` 段为回归护栏，实现前即绿，按 characterization 记录）。通则：本节「回执」均指迭代器 `next()` 吐出该 `response{command:"prompt"}`/`prompt_result` 帧，**不以 `dispatched` 为准**（`dispatched` 在写出完成时即 resolve，早于子进程回执）；宽限定时器在同一次 `#onFrame` 内 push 之后同步挂上，故迭代器吐出回执时它必已登记。本文件的 wired / real world 缺省**不传 `idleMs`**（取 600 000），只有证据 5 与证据 7 的 idle 用例显式传小值。
  1. 纯判定表驱动（`it.each`）：`hello`(slashText=false)+`local-outcome` → `complete`；`/x`+outputSeen+`local-outcome` → `complete`；`/x`+未见+`local-outcome` → `await`；awaiting+`local-outcome` → `none`；任何状态+`other`（代表 `agentInvoked:true` 回执、`agent_end`、失败）→ `none`；awaiting+`command-output` → `complete`；未 awaiting+`command-output` → `none`；awaiting+`grace-tick` 119 999 → `none`、120 000 → `complete`；未 awaiting+`grace-tick` 120 000 → `none`；`LOCAL_COMMAND_GRACE_MS === 120_000`。
  2. wired 手写帧（同 `omp-runtime-io.test.ts` 的 `openWired` 写法，本文件自带最小副本；`clock` 为 `createClock()`）：`hello` + 裸 `agentInvoked:false` 回执 → 立即结束，该回执为最后一帧；`/x` + `command_output` + `agentInvoked:true` 回执 + `agent_start` + 非终态 `agent_end` → 迭代器未结束；终态 `agent_end` → 结束，帧序列完整。
  3. wired：`/a` 回执 `agentInvoked:false` → 未结束（一个宏任务后仍 pending）；`command_output` → 结束且为最后一帧；随后 `clock.advance(120_000)` 期间的下一回合 `hello`（`agentInvoked:true` 回执后挂起）不被结束，终态 `agent_end` 后才结束（已完成回合的定时器不影响后续回合）；`clock.pending()` 在两回合结束后回到基线（只剩 idle 定时器）。
  4. wired：`/a` 回执 → 等待；`advance(60_000)` → 重复 `prompt_result{agentInvoked:false}` → `advance(59_999)` 未结束 → `advance(1)` 结束（重复结果不重启等待），迭代器只含两帧、无伪造帧。
  5. wired：等待中非输出帧（如 `{type:"notice"}`）→ 被 push 且重置 idle：`idleMs` 取小值（如 1 000），`advance(900)` → notice → `advance(900)` → 仍未 retire、回合未结束。
  6. wired：等待中终态 `agent_end` → 结束（`none` 交由既有规则）；另一回合等待中同 id 失败回执 → 迭代器以 `AgentUnavailableError` 失败、世代 retire。
  7. wired idle 用例：`idleMs = 100_000`。`/a` 回执之后 `advance(100_000)` 触发 idle retire，立即断言 `clock.pending() === 1`（只剩 TERM 定时器；未清宽限则为 2）；随后 `world.child.endStdout(); world.child.exit(0)` 模拟 EOF 退出（FakeChild 收 EOF 不自行退出），回合以 `AgentUnavailableError` 失败；下一 prompt `spawns === 2`，`agentInvoked:true` 回执之后 `advance(20_000)`（越过旧宽限到期点）仍 pending，终态 `agent_end` 才结束。shutdown 用例：等待中调用 `shutdown()`，`world.child.endStdout(); world.child.exit(0)` 后再 await，最后 `clock.pending() === 0`。放弃用例：等待中迭代器 `return()` 之后，`clock.pending()` 按计数不含宽限定时器。
  7b. 墙钟取整：手写 `SessionClock`（可控 `now()` 与手动触发回调），首次触发宽限回调时 `now()` 返回 `since + 119_999` → 回合仍 pending、登记的定时器多出一个（重挂，延时 1）；使 `now()` 返回 `since + 120_000` 后触发新回调 → 回合结束，帧中无伪造帧；另起一回合：重挂之后先到 `command_output`（或终态 `agent_end`）结束回合，断言 `pending()` 不含那个延时 1 的重挂定时器（未替换句柄时 `#clearLocalWait` 清的是已失效的旧 id，新定时器残留）。这是区分「有无重挂」的唯一红灯用例。
  8. 真实 fake `slash`（同 `omp-runtime.test.ts:707` 的 spawn 包装追加 `--scenario slash`，注入 `createClock()`）：`/todo` → 帧恰 `[command_output{text:"No todos. Use /todo append <task> to start one."}, 回执 agentInvoked:false]` 且迭代器结束；同一 runtime `/compact` → 帧恰 `[回执, command_output{text:"Compaction complete."}]`，结束于输出（若在回执处结束，输出会被丢弃，帧只有一条）；再 `hello` → normal 回合，spawn 次数仍为 1。
  9. 真实 fake `slash --compact-silent`：`/compact` 的回执帧经迭代器吐出后 `advance(119_999)` → 未结束；`advance(1)` → 结束，帧恰 `[回执]`；再 `hello` 复用同一子进程。
  10. 行数：`wc -l runtime.ts` ≤ 800，PR 写明实测值。
