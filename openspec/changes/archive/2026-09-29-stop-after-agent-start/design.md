# Design: stop-after-agent-start（#650）

Change surface:
- `SessionRuntime.abort()` 与 `#onFrame`（`server/src/sessions/omp/runtime.ts:226-240`、`:466-500`），以及回合的结束、失败、退役、退出路径（`#completeTurn`、`#failTurn`、`#retire`、`#onNativeExit`）。
- fake-omp：`abort-ok`/`slow-ready` 的持住回合（`holdTurn` `:493`、`handleAbort` `:573`）；argv 解析（`:66-80`、`:165-200`）搬到新模块 `fake-omp-argv.mjs`。

Must preserve:
- owner 契约：没有活跃回合、prompt 帧未写出、没有存活子进程、generation 正在退役时，`abort()` 仍同步返回 `false` 且不写帧（`TurnStops` 据此登记或丢弃意图，`turn-control.ts:134-141`）。
- 回合已开始时，`abort()` 仍立即写出恰一帧并返回 response Promise。现有 `abort-ok` 持住回合（已发出 `agent_start` 与两段 delta）上的全部停止行为逐字不变：#473 的 Deny→abort 次序、二次 stop 只一帧、有界退回、`applyStop`。
- abort response 只结算 abort 请求，不结束 iterator（omp-runtime spec 既有句）。
- `/compact` 这类「先回执后输出」的本地回合：本地完成应答之后的 `abort()` 立即写帧并取消后台输出（Scenario「abort response alone does not end the turn」）。
- fake-omp：n=0（缺省）时所有既有场景的出站帧序逐字不变；probe `frames=` 格式不变。

Must add/change:
- runtime 每个回合新增「已开始」标记：该回合的 iterator 收到 `agent_start`，或 `isLocalComplete(frame, requestId)` 为真的帧，即视为已开始。
- `abort()` 在「回执已兑现、回合未开始」时不写帧，返回一个推迟的 Promise，由该回合持有：
  - 回合开始时，在处理该帧的同一同步段内写出恰一帧 `abort`，Promise 以该帧的 response 结算。如果该帧同时让回合结束（本地完成且不再等输出），则不写帧，Promise 以 `AgentUnavailableError` 拒绝。
  - 回合在开始前结束（terminal `agent_end`）、失败（匹配的失败 response、协议错误）、被放弃（`#abandon`，`runtime.ts:613`：迭代器被 `return()` 取消，例如 supervisor pump 在 `supervisor.ts:529` break 或提交/发布失败后提前返回），或 generation 退役、子进程退出时，Promise 以 `AgentUnavailableError` 拒绝，不写帧。
  - 回合开始前再次调用 `abort()` 返回同一个推迟的 Promise（为复用 `TurnStops` 的 #526 定义确定行为）。
  - 在「开始」帧上写出之前，SHALL 重新核对 `abort()` 的同一组闸：同一 generation、未在退役、子进程仍存活；任一不满足就按拒绝处理。`#onFrame` 本身不跳过正在退役的 generation。
  - 状态放置：按主 spec「omp 运行时源码模块划分」（`openspec/specs/omp-runtime/spec.md:195`），`Turn` 的新字段与推迟 Promise 的辅助函数放进 `omp/commands.ts`（`Turn`、`deferredReceipt` 已在那里），`runtime.ts` 只保留调用与接线。
- fake-omp `--start-delay-ms <n>`（只对 `abort-ok`/`slow-ready` 生效，缺省 0，取最后一次出现的值，非法值与 `--ready-delay-ms` 相同：退出 1、零帧）：
  - prompt ack 之后，n ms 后才把「开出持住回合」（`agent_start` + 两段 delta）追加进串行 queue，期间继续读 stdin。
  - 这期间读到的 `abort`：回执 `response{command:"abort",success:true}`（回显 id），撤销待开的回合，永不发出该回合的 `agent_start`、delta、`message_end` 或 `agent_end`；其后的 prompt 按 `abortTurn="done"` 走缺省完整回合。

Governing invariant: 一个回合的 `abort` 帧只会在该回合已开始后写出；在此之前的停止要么推迟到开始时兑现，要么在回合不再存在时被拒绝，任何情况下都不写帧。

Sibling surfaces:
- `TurnStops.#run`/`dispatched`/`#arm`（`turn-control.ts:92-161`）：只消费 `abort()` 的返回值；只允许更新已过时的文档注释（`:3-5`「dispatched turn ... write `abort`」、`:63-64`「Resolves once `abort` is written」），代码零 diff。推迟的 Promise 在 `#arm` 同步段内已挂 catch（`:148`），拒绝不会产生 unhandledRejection；grace 从调用时起算；`release` 在 pump 结束时清 grace。零 diff。
- supervisor pump（`supervisor.ts:511-575`）：迭代器帧序不变；零 diff。
- 审批（`approvals.ts`、#473 Deny 快照）：select 只会出现在 `agent_start` 之后，所以已开始的回合才有挂起审批；零 diff。
- 本地 slash（`local-command.ts`、runtime `#onLocalFrame`/`#awaitOutput`）：「已开始」判定与本地完成共用 `isLocalComplete`；等待输出期间的 abort 行为保持不变。
- regenerate/fork（`branching.ts`）：依赖用户消息入 omp 历史，是本刀的受益方；代码零 diff，由真二进制复测 E-real 证明。
- change B #526（DELETE running 复用停止序列）：未实现，自动继承。
- smoke `chat.hurl` 停止用例（#482，审批挂起时 stop，已过 `agent_start`）与 ui-walk 停止步骤（#484，delta 之后 stop）：都在开始之后，行为不变。
- fake-omp 的其它 abortable 场景（approval*、thinking hold、slash）：`--start-delay-ms` 不作用于它们，零行为变化。

Seams under test:
- runtime + 真实 fake-omp 子进程（`openReal`，`omp-runtime-commands.test.ts` 的世界构造）：R1–R7。
- `SessionSupervisor` + 真实 fake-omp + 真实 SQLite + 注入时钟（`openStopWorld`/`intentWorlds`，`session-stop-helpers.ts`、`session-stop-intent-helpers.ts`）：S1–S3。
- fake-omp 子进程契约（`fake-omp-helpers.ts`）：F1–F3。

Required evidence（新建 `server/test/omp-runtime-abort-start.test.ts`、`session-stop-early.test.ts`、`fake-omp-early-abort.test.ts`，各 ≤800 行）:
- R1 `abort-ok --start-delay-ms 200`：`prompt("x")`，`await dispatched` 后立即 `abort()` → 返回 Promise；此刻 stdin 没有 `abort` 帧（agent_start 到达前等待 ≥50ms 再核对）。agent_start 到达后恰写出一帧 `abort`，在 `prompt` 之后；iterator 依次观测到 `agent_start`、两段 delta、`message_end aborted`、`agent_end` 并结束；Promise 以匹配的 abort response 结算；同一 generation 上的下一个 prompt 正常完成，没有新 spawn。红的基线是「tasks 1 的新 fake + master 的 `runtime.ts`」（即变异 M1）：abort 在 agent_start 之前写出，fake 丢弃整轮，iterator 在超时内等不到 `agent_end`。未改的 master 忽略 `--start-delay-ms`，不构成基线。
- R2 `slow-ready --ready-delay-ms 300 --start-delay-ms 200`：回执前 `abort()` → `false`；回执后再调 → 推迟；其余同 R1（覆盖停止意图的兑现调用）。
- R3 `crash`（prompt ack 后退出 2，没有 agent_start）：回执后 `abort()` → Promise 以 `AgentUnavailableError` 拒绝，stdin 没有 `abort` 帧，iterator 按既有失败路径结束。
- R4 `slash`，prompt `/todo`（先输出后回执）：`await dispatched` 后、应答到达前调 `abort()` → 本地完成应答同时结束回合，Promise 拒绝，没有 `abort` 帧；下一个 prompt 复用同一子进程。
- R6 `abort-ok --start-delay-ms 300`：回执后 `abort()` 推迟，随后对 iterator 调 `return()`（模拟 pump 提前退出）→ Promise 以 `AgentUnavailableError` 拒绝，此后 agent_start 到达也不写 `abort` 帧。
- R7 同一回合开始前两次 `abort()` 返回同一个 Promise，开始后恰写一帧。
- R5 `slash --compact-silent`，prompt `/compact`：本地完成应答之前调 `abort()` → 应答到达（回合转入等待输出）时恰写出一帧 `abort`，Promise 以其 response 结算；回合仍只在本地命令 grace 到期后结束（与既有 Scenario 相同）。
- S1 已派发分支：`abort-ok --start-delay-ms 300`，REST/`supervisor.prompt` 得到回执后立即 stop → stop 返回；不推进注入时钟，回合以恰一个 `turn.end(stopped)` 收尾，没有 `error`、没有 retire；probe prompt 在同一子进程上完成，`frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`。基线（新 fake + master runtime）上为红：回合等不到 `agent_end`，只能靠推进 8000ms 退回，probe 落在新进程上。
- S2 停止意图分支：`slow-ready --ready-delay-ms 300 --start-delay-ms 300`，握手期间 stop → 同 S1 的结论（帧序同上，`abort` 在该回合 `agent_start` 之后）。
- S3 grace 仍从 stop 起算：`abort-ok --start-delay-ms 60000`（回合一直不开始），回执后 stop → 注入时钟推进 8000ms 后按既有有界退回结算 `turn.end(stopped)`，stdin 没有 `abort` 帧，没有 unhandledRejection（`collectRejections`）。
- F1 `abort-ok --start-delay-ms 200`：发 prompt 后立即发 abort → stdout 依次为 prompt ack、abort response（success，回显 id）；之后 500ms 内没有 `agent_start`/`message_update`/`message_end`/`agent_end`；下一个 prompt 是完整缺省回合。
- F2 同一 argv 下，在 agent_start 之后才发 abort → 与现有 `abort-ok` 相同的持住回合与中断帧序。
- F3 `--start-delay-ms` 非法值（`-1`、`abc`、缺值）→ 退出 1、零帧；对其它场景（如 `normal`）不生效，帧序逐字不变。
- E-real（编排者执行，不入 CI）：官方 omp v18.0.10（`make omp-fetch` 钉值 SHA256），编译产物服务端加仓内假上游，两个分支各至少 5 次：「prompt 202 后 0–1ms 内 stop」与「派发前 stop」。每次都在远小于 8s 内结算为 `stopped`，不经 retire；`.jsonl` 含该用户条目；随后对该消息 regenerate、fork，以及在后续用户消息上 fork，都返回 2xx 并完成。结论（含二进制 SHA256、日期、次数）回写父 design Open Questions 第二项 (c)，不含任何主机地址或凭据。

Mutation table（实现者逐条临时施加，确认对应用例变红，记入 PR body）:
- M1 `abort()` 回执后立即写帧（即 master 行为）→ R1、R2、S1、S2 红。
- M2 「已开始」只认 `agent_start`，不认本地完成 → R5 红。
- M3 回合开始前结束时不拒绝推迟的 Promise → R3、R4 红（等待超时）。
- M5 `#abandon` 路径不拒绝推迟的 Promise → R6 红。
- M4 fake 在开始前读到 abort 时仍按旧规则兑现 → F1 红。

Non-goals: 见 proposal。

Review focus:
1. 推迟 Promise 的每一条终局（开始时写、本地完成即结束时拒绝、结束/失败/放弃（`#abandon`）/退役/退出时拒绝）都恰发生一次，不留悬挂。
2. 写 abort 的时点在处理 `agent_start` 的同步段内，而且只对同一 generation 与同一回合写；写前重新核对 generation 未退役、子进程存活。
3. 已开始回合上 `abort()` 的行为与 master 逐字相同，既有测试只在其前提（回执后不发 agent_start 就期待 abort 帧）失效处改动。
4. fake 的丢弃语义与 #495 实测一致（abort 回执 success，此后无该回合任何帧），n=0 时帧序零变化。
5. `runtime.ts` 行数 ≤798（新状态与辅助函数放在 `commands.ts`），`fake-omp*.mjs` 各 ≤800，模块划分的导入方向满足 spec。
