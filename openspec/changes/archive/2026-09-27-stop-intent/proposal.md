# Proposal: stop-intent（#490）

## Why
父 change `s1c-turn-control-governance` tasks 4.2b（epic #448，issue #490）。

#473 交付了已派发回合的停止，但把 runtime `abort()` 返回 `false` 的分支留成空操作：`TurnStops.#run` 删登记后直接返回（`server/src/sessions/turn-control.ts:90-94`）。#603 评审另外发现，`supervisor.stop()` 经 `#slots` 查回合（`supervisor.ts:207-217`），而 `#dispatchNew` 在 `#slots.set`（`:354`）之前就已 await 进程池准入（`:316`），所以准入期间的 stop 同样落空。本刀交付停止意图的三个出口：派发前 stop 登记意图；该回合派发回执兑现后 supervisor 恰兑现一次 `abort`；获取/派发失败时意图丢弃，走与无意图时相同的失败路径。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」；abort 次序、准入/驱逐/重新准入窗口与失败路径只能用真实子进程与真实 SQLite 证明)
Blast radius: 意图丢失 → 冷启动/准入/等退役窗口里的「停止」被随后派发吞掉，回合照常跑完；兑现过早（`setSessionFile` 之前）→ 派发失败的回合仍被写 `abort`；兑现两次 → 第二帧 `abort`；意图挂在 slot 上 → 重新准入换 slot 后丢失；意图不在失败时丢弃 → 悬挂登记；意图路径合成终态 → 两个 `turn.end` 或把 `done`/`failed` 改写为 `stopped`；兑现的 abort Promise 未 catch → 进程退出时 unhandledRejection 崩溃
Selected risk packs: Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Public API / CLI / script entry；Resource limits / large input / discovery；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-stop-intent.test.ts`（I1–I5）、`session-stop-intent-windows.test.ts`（I6、I7、F1、F2、I8）与 helper `session-stop-intent-helpers.ts`（各 ≤800 行），真实 fake-omp 子进程 + 真实 SQLite + 注入时钟 + 真实 `createApp`→`registerSessions`；design「Required evidence」全绿、变异表逐条变红；既有测试零 diff；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 退出 0

## What Changes
- `server/src/sessions/turn-control.ts`（`TurnStops`）：
  - 回合阶段标记（示意名 `open(id)`，内部 `dispatching | dispatched`），即 #601 评审规则里的 owner 标志；
  - `stop(slot | undefined, id)`：slot 缺省时 deny 快照为空、`abort` 视为 `false`；`false` 且 `dispatching` → 登记意图并 resolve，其余 `false` → 丢弃；
  - 兑现（示意名 `dispatched(slot, id)`）：置 `dispatched`，有意图则恰调一次 `slot.runtime.abort()`：`false` 丢弃，Promise 走与已派发路径同一尾段（同步 catch + 注入时钟 grace）；
  - 「丢弃」只删停止登记与计时，阶段标记只由 `release(id)` 清除。
- `server/src/sessions/supervisor.ts` 只接线（design 决定 2–5）：
  - `stop()` 改为经 store 活跃回合与 `#claims` 取回合与 slot；
  - `#prompt` 首次 claim 检查后 `open(id)`，外层 catch `release(id)`；
  - `#bindDispatch` 成功路径末尾（pump 登记之后）调兑现。
- 测试：两个新测试文件 + 一个新 helper；既有测试与 helper 零 diff。

## Capabilities
- MODIFIED turn-control「停止生成 REST」：主 spec（#473 推进）+ 父文「中断 SHALL 分两种」与「prompt 尚未派发」整段（剪去 `202 {}` → #475、regenerate 片段与控制占用括注 → #465）+ 父 Scenario「派发前停止」「abort 返回 false 走停止意图」（同样剪去 `202 {}`）+ 自写 Scenario「获取失败丢弃停止意图」「准入与前代退役等待期间停止」（归档时父 delta 须逐字采纳）。见 delta 引注。
- omp-runtime「相关命令 API 与回合中断」**无 delta**：主 spec（`openspec/specs/omp-runtime/spec.md:226,241`）已含回执前/后 `false` 的 owner 语义与 Scenario「abort right after the dispatch receipt」（#488 推进）。本刀是它的 owner 侧实现，I1/I2 为 supervisor 侧证据。
- omp-test-harness「假 omp 入站帧记录」**无 delta**：主 spec（`openspec/specs/omp-test-harness/spec.md:168-170`）已含 Scenario「延迟握手期间停止 → 帧序 prompt,abort」（#459/#461 推进）。I1 以 supervisor 停止意图路径取得同一 `frames=`。
- chat-sessions「会话 supervisor 源码模块划分」不改：主 spec 已写 `turn-control.ts` 承载 stop 的回合控制编排。

## Impact
- 行数：
  - `supervisor.ts` 776 → 估算 ≈782（`stop()` +3、`#prompt` +2、`#bindDispatch` +1），目标 ≤786，硬上限 798。超出则先停下上报；预案是把 `#translate`（`:730-741`）与模块级 `asError`/`throwCollected` 纯搬进新文件，不在本刀自行执行（偏离需编排者认可）。
  - `turn-control.ts` 184 → 约 220。
  - 实测 `wc -l` 记入 PR body。
- 零 diff：`rest.ts`、`store*.ts`、`events.ts`、`pool.ts`、`approvals.ts`、`index.ts`、`omp/` 全部、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs`（793/800，不加场景）、全部既有测试与 helper。
- 5.1a #475 合入前 `stop` 仍无 src 调用方；新增的 `TurnStops` 方法由 supervisor 调用，knip 零新增。

## 偏离与决定
1. **意图按回合 id 登记，不按 generation 登记**（issue：「停止意图按 generation 绑定」）。准入与等退役窗口里还没有 generation，重新准入时同一回合换了 slot 与 generation；「对同一 generation 调 `abort()`」由兑现时机与 runtime 自身的 `gen.id === turn.genId` 闸保证（design 决定 1）。
2. **「获取/握手」窗口按 supervisor 的全部派发前等待解释**：进程池准入（#603 评审）、等本会话上一进程退役（`supervisor.ts:260-261`，无 claim）、`ReadmissionRequired` 后的重新准入（`:280-288`，claim 已释放，走与等退役相同的无 slot 分支）都登记意图。issue 字面只写「runtime 仍在获取/握手」；不这样解释，#603 指出的空操作仍在，且意图会在重新准入时丢失。证据 I2、I7；获取期间登记的意图跨重新准入仍兑现：I6。
3. **丢弃点在 `#prompt` 外层 catch，不在 `#bindDispatch` 的回执 catch**：`ReadmissionRequired` 让回执拒绝，但同一回合随后再派发一次；在回执 catch 丢弃会丢掉仍然有效的停止。证据 I6。
4. **兑现点在 pump 登记之后**，不在 `await stream.dispatched` 之后立即兑现：`setSessionFile` 失败（`:389-396`）是回执已兑现后的派发失败，此时不得写 `abort`。证据 F2。
5. **兑现直接 `abort`，不重读审批快照**（issue 问题 4）：父文「立即…再次调用 `abort()`」与父 D2「进入 stop 时读取的 pending 快照必为空」；代码上 owner 续体先于任何 stdout I/O（design 决定 6）。背压写入下的边角列为 Open question。
6. **失败路径的等同性用对照世界证明，丢弃本身用同一回合再派发探测**：I8 让派发失败后不回滚、对同一活跃回合再派发，残留意图会在第二次回执续体里写出 `abort`；F1 两世界都经 REST prompt，断言状态码、body、history 与无意图世界相同，这是对既有 REST 行为的只读断言，不改 `rest.ts`；F2 需要同步窗口，两世界都直接调 `supervisor.prompt`，只断言拒绝消息、入站帧与事件相同。stop REST 本身（202/204/body/鉴权）仍归 #475。
7. **`#prompt` 在 `:264`（已关停）与 `:267`（并发重复 prompt）两处 throw 不清阶段标记**：前者关停后 stop 已被拒绝，残留标记惰性；后者的标记属于抢到 claim 的那次调用。经 REST 两者都不产生悬挂意图（`acceptPrompt` 对 running 会话抛 `session_busy`）。只经代码审查。
8. **不写「prompt 在派发回执续体之前完成」用例**：不可达。回执在 prompt 写回调里兑现（`runtime.ts:297-298`，`process.ts:369-377`），owner 续体在该微任务链上运行；任何子进程帧都要等下一次 stdout I/O。可达的对应情形是「兑现的 `abort` 晚于回合正常完成」（I4，`done` 不被改写）与「兑现后崩溃」（I5，`failed` 不被改写）。

9. **I3 在后一次 stop 之前加前置断言**（实现期补入，PR #605 评审记录）：断言意图已由派发回执本身兑现（`abortCount===1`、grace 已布）。不加这两条的话，master 上后一次 stop 会走 #473 的已派发路径，观测完全相同，I3 做不到先红。

## Open questions（上报编排者，本刀不处理）
- prompt 写被背压（管道缓冲满）时，select 可能先于 owner 续体被转交（`runtime.ts:541` 以 `turn.sent` 为闸），兑现的 `abort` 会遇到未应答的 select，回合落到 #473 的有界退回，残留审批由 #474 结算。现有 fake 与真实管道都构造不出，不测。
- carry-forward #603：`TurnStops.#run` 的 deny 循环后无复查。本刀不引入真实 await，前提不变；#465 若给 stop 加 claim 持有，仍须补 `entries.get(id) === entry` 守卫与用例。

## Non-goals
- 已派发路径（Deny → abort、有界退回、二次 stop 去重）：4.2a #473，已交付，本刀只复用。
- stop REST 路由与 202/204/body/鉴权、`SessionSupervisorPort.stop`：5.1a #475。
- regenerate 在等待派发回执时被停止、控制占用（含 stop 持有占用）：4.4 #465。
- runtime `abort()` 面、fake-omp 任何改动：2.2b #488 已交付；fake 793/800 不加场景。
- 残留审批的非作答结算：4.6 #474。web：7.2。
