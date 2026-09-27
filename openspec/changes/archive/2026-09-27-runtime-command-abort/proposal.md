# Proposal: runtime-command-abort（#488）

## Why
父 change `s1c-turn-control-governance` tasks 2.2b（epic #448，issue #488）。

`SessionRuntime` 目前只有 `prompt`/`shutdown`/`markPending`/`clearPending`/`respondApproval`（`server/src/sessions/omp/runtime.ts:148-217`），没有回合中断，也没有回合外的相关命令。停止（4.2a #473、4.2b #490）需要 `abort()`，并且需要它「`prompt` 帧写出前返回 `false`」这条精确边界。regenerate/fork（4.4 #465、4.5 #466）需要 `command(get_branch_messages|branch|get_state)`，并且要求它与 prompt 走同一条惰性获取路径。本刀交付这两面，并在同一刀内把 `runtime.ts` 的一组私有退役计时辅助搬进 `commands.ts`，以腾出 size-guard 余量。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：omp 子进程治理 Critical Path。新增公开 API `command`/`abort`，改动惰性获取路径与 prompt 的互斥判定，并搬迁退役升级（stdin→TERM→KILL）的计时辅助)
Blast radius: `abort()` 边界错了：4.2b 的停止意图可能在 `prompt` 之前写出 `abort`，或丢失停止；abort 的 response 若结束了回合，归约会少掉 `agent_end`。`command` 若走第二条获取路径，会让 token/epoch 多签发一次（#463 名额、ring 失配）；互斥缺失会让 branch 与 prompt 在同一进程上交错；认领不释放会让会话永久 busy。搬迁出错则会破坏 5s/8s 升级与 held pipe 回收。
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Auth / permissions / secrets；Resource limits / large input / discovery；Legacy compatibility / examples；Schema / columns / units / field names
Evidence floor: 新建 `server/test/omp-runtime-commands.test.ts`，按 design「Required evidence」覆盖 S1、A1–A7、C1–C8、G1（真实 fake-omp 子进程为主；只有真实子进程观察不到的窗口用 FakeChild：`prompt` 写入被扣住（A2）、原生退出而 stdout 未关（A7）、command 入口重置空闲计时（C8））。R 项先红后绿，G 项恒绿。既有测试零 diff 全绿。`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 退出 0；`runtime.ts` 目标 ≤770、硬上限 785 行

## What Changes
- **搬迁（行为不变，先做）**：把 `runtime.ts` 中只依赖 `gen` 与时钟的一组私有退役/排空辅助搬进 `commands.ts`，改写为模块函数：`#awaitChild`(:627-639)、`#closeStdin`(:641-643)、`#signal`(:645-650)、`#drainHeld`(:658-672)、`#watchHeldPipe`(:674-685)、`#clearDrain`(:687-692)、`#clearGrace`(:694-699)、`#waitNative`(:701-721)，连同常量 `TERM_GRACE_MS`/`KILL_GRACE_MS`/`SHUTDOWN_BUDGET_MS`(:38-40)。`#runRetire`、`#finishDead`、`#revoke`、`#dropGeneration`、`#resetIdle` 留在类内。清单与改写规则见 design「Must add/change」。
- **`abort(): Promise<OmpFrame> | false`**：只在「当前回合的派发回执已兑现，且该回合所在 generation 仍是当前代、未在退役、子进程存活」时，经 `OmpProcess.request` 写出恰一帧 `{type:"abort",id}`，返回其 response Promise；其余情况不写帧，返回 `false`。
- **`command(frame)`**：`frame` 只接受 `get_branch_messages`/`branch{entryId}`/`get_state`，返回 `Promise<unknown>`，即匹配 response 的 `data`。
  - 回合中或另一 command 在途时，同步抛 `SessionBusyError`；已 shutdown 时，同步抛 `AgentUnavailableError`。两种情况都不写帧。
  - 否则置 command 认领，经泛化后的 `#readyGeneration`（与 prompt 同一路径）获取 generation，再经 `OmpProcess.request` 发送。
  - `success !== true` 时以 `AgentUnavailableError` 拒绝；子进程先退出时也以 `AgentUnavailableError` 拒绝。
  - 成功的 `get_state` 若带非空 `sessionFile`，它成为新的 last-known-good 路径。
  - 认领在每条结算路径上释放。`prompt()` 的忙判定并入在途 command。
- 新建测试文件 `server/test/omp-runtime-commands.test.ts`。

## Capabilities
- ADDED `omp-runtime`「相关命令 API 与回合中断」：主 spec 无此 requirement，父 delta 为 ADDED，由本 issue 全量交付。以父块逐字为底，加入「偏离与决定」3、5 所列的自写精化（两个 abort Scenario 的 THEN 改写、两句 requirement 文字、两个新 Scenario），**归档时父 delta 须逐字采纳**，由编排者对账。
- `omp-test-harness`「假 omp 入站帧记录」**无 delta**。主 spec（`openspec/specs/omp-test-harness/spec.md:161-170`）已含该 requirement 与 Scenario「延迟握手期间停止 → 帧序 prompt,abort」，与父 delta 逐字一致，由 #459（fake-omp-probe-frames）与 #461（fake-omp-slow-ready）推进。这个 Scenario 的分工如下：
  - 假 omp 侧记录：已交付。
  - runtime 层用真实子进程证明 `frames=negotiate_protocol,get_state,prompt,abort,prompt`：由本刀 A3 交付。
  - supervisor 停止意图路径下的同一帧序：归 4.2b #490，见父 tasks 4.2b 验证原文。
- 「omp 运行时源码模块划分」**不改**。主 spec 已写明 `commands.ts` 承载「子进程存活与 stdio 辅助、延时竞速」以及 command/abort 面，搬迁后该文字仍然成立。

## Impact
- 源码只改 `server/src/sessions/omp/runtime.ts` 与 `commands.ts`。以下文件零 diff：`process.ts`、`ui-requests.ts`、`frame.ts`、`prompt-stream.ts`、`local-command.ts`、supervisor、store、`app.ts`、`server/test/support/fake-omp*.mjs`、全部既有测试与 helper。
- 行数估算：
  - 搬迁后 `runtime.ts` 784 → ≈700（移出约 91 行，import 净增约 7 行），硬上限 705。
  - 加入 `command`/`abort` 后 ≈765，目标 ≤770，硬上限 785（仍比 size-guard 低 15 行；S1c 其余 issue 不再给 `runtime.ts` 加代码：4.2b 明确「runtime 不为停止意图新增任何接口」）。
  - `commands.ts` 162 → ≈265。
  - 新测试文件 ≤800。
  - 实测 `wc -l` 记入 PR body。超上限时的退路见 design「行数」。
- supervisor 本刀不调用 `command`/`abort`。调用方是 4.2a #473、4.2b #490、4.4 #465、4.5 #466。

## 偏离与决定
1. **搬迁不算 PR Boundary 偏离**。编排者预期要新建一个 sibling 模块，但被搬的辅助正是主 spec「omp 运行时源码模块划分」列给 `commands.ts` 的一类：「子进程存活与 stdio 辅助、延时竞速」。`#drainHeld` 本来就在调用 `commands.ts` 的 `stdoutEnded`/`destroyStdio`/`raceDelay`。所以落在 `commands.ts`，既在 issue 的 PR Boundary（`runtime.ts`/`commands.ts` + 一个新测试文件）之内，也不必 MODIFIED 模块划分 requirement。它**超出了 issue In Scope 的字面**（In Scope 只写了 command/abort），理由是 size-guard：不先搬，784 + ≈65 > 800。
2. **不新建「相关请求结算表」**。issue 写「`commands.ts` 中按 id 与 command 匹配的相关请求结算表」，但这张表已经存在：`OmpProcess` 的 `#pending`（`process.ts:182`，登记在 `:335-353`，结算在 `:591-597`，只有 id 与 command 同时匹配才结算）。`command` 与 `abort` 都经 `OmpProcess.request`（`:245-249`）进入这张表，也就是「同一结算路径」。在 runtime 再建一张表，就成了第二个真相源。
3. **abort 的 response 不在 iterator 中**（修改 issue 验收文字与父 Scenario 的 THEN）。fake 在终止 `agent_end` **之后**才发 `response{command:"abort"}`（`fake-omp.mjs:587-595`），父 design 记录的真 omp 次序也是这样。而 `agent_end` 一到，`#onFrame` 就结束回合（`runtime.ts:407-409`），之后的帧因无活跃回合被丢弃（`:402-405`）。因此「iterator 见 … `response{command:"abort"}`」无法字面成立。本刀把它钉为：iterator 以 `message_end aborted`、`agent_end` 收尾后结束；相关 response 是 abort Promise 的兑现值。子 delta 两个 abort Scenario 的 THEN 按此改写。
4. **`false` 边界以「派发回执已兑现」为准，不以 `turn.sent` 为准**。`turn.sent = true` 写在 `await gen.proc.send(...)` 之前（`runtime.ts:230-231`），回执在写回调之后才兑现（`:232`）。以 `sent` 为判据时，被扣住的 prompt 写入期间调用 `abort()`，会让 `abort` 行先于 `prompt` 行到达子进程。父文「自其派发回执 `dispatched` 可兑现之时起」即指回执兑现后。design A2 用被扣住的写入证明这一点。
5. **自写精化**（父 delta 未规定；4.4/4.5 依赖前两条，4.2b #490 依赖第三条；归档时父 delta 须逐字采纳）：
   - `success !== true` 的匹配 response（如 `branch` 未知 `entryId`：`fake-omp.mjs:342-347,367-369`）使 `command` 以 `AgentUnavailableError` 拒绝，且 **不** 回收 generation。依据是父 design D3「branch 之后、提交之前失败：retire 该进程」，retire 由 owner 执行。
   - shutdown 后 `command` 同 `prompt`（`runtime.ts:151-153`），同步抛 `AgentUnavailableError`，不 spawn。
   - `abort()` 在 generation 正在退役时同样返回 `false`；「`false` = 尚无已派发的回合」只适用于派发回执兑现之前。回执兑现之后取得的 `false`（子进程已死或正在退役）表示回合正经失败路径收尾，owner 丢弃停止意图、不再重试。不写这一句的话，#490 会在回执已兑现后把 `false` 当成「尚未派发」，去等一个不会再来的回执，或反复重试。证据：design A6（退役中）、A7（原生退出、stdout 未关）。
   - 子 delta 另加两个 Scenario：「abort response alone does not end the turn」「Command failure response and closed runtime」。
6. **不给 fake-omp 加场景**。`fake-omp.mjs` 已 793/800 行，issue PR Boundary 也禁止触碰它。全部验收只用既有场景：`abort-ok`、`slow-ready`、`branch`、`normal`、`slash --compact-silent`，以及 FakeChild。能力边界见 design「fake 能力边界」。

## Open questions（上报编排者，本刀不处理）
- 同一回合的第二次 `abort()` 仍会写帧（runtime 不去重）。`abort-ok` 每个进程只兑现一次 abort，第二个 Promise 会一直挂到进程退出（carry-forward #456 impl）。去重属 4.2a「二次 stop 只发一帧」。abort Promise 在子进程先退出时会以 `AgentUnavailableError` 拒绝，runtime 不替 owner catch，#473/#490 必须自己处理这个拒绝。
- `/compact` 这类等待迟到输出的 slash 回合（#553）在 abort 后不会收到 `agent_end`，只能靠 120000ms grace 结束。4.2a 的 `OMP_ABORT_GRACE_MS`（8000）有界退回会先到。本刀 A4 只证明「abort response 不结束回合」，不处理 4.2a 的收尾。
- 在途 command 期间子进程长时间静默时，空闲回收照常触发（command 只在开始与结算时重置计时），command 随之以 `AgentUnavailableError` 拒绝。这与 prompt 回合的既有静默回收问题同源（carry-forward #547），不修。

## Non-goals
- supervisor 接线、停止编排与停止意图、abort 去重、有界退回：4.2a #473、4.2b #490。
- regenerate/fork 编排、entry 对齐、SQLite 事务：4.4 #465、4.5 #466。
- `process.ts`、fake-omp 的任何改动；`onExit`/`markPending`/`onApproval` 语义（2.2a，已交付）。
- runtime 为停止意图新增接口。
