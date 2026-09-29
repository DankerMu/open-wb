# Proposal: stop-after-agent-start（#650）

## Why
epic #448 收尾 issue #650；父 change `s1c-turn-control-governance` design D2「修订」（Stage 2 定案，2026-09-29 用户拍板方向 A）。

#495 用真 omp v18.0.10 验证 Open Questions 第二项 (c)，结论为「否」：`prompt` 应答后、agent loop 起跑前收到 `abort` 时，omp 的 `AgentSession.abort()` 递增 `#promptGeneration`，仍在预处理的 `prompt` 按 generation-bail 静默放弃。两个 response 都返回 success，此后没有 `agent_start`/`agent_end`，用户条目也不写入 `.jsonl`。现行代码在派发回执兑现时就写 `abort`：已派发分支 `TurnStops.#run` 调 `slot.runtime.abort()`（`server/src/sessions/turn-control.ts:134`），停止意图分支由 `dispatched()` 调用（`:92-104`），runtime 在回执兑现后立即写帧（`server/src/sessions/omp/runtime.ts:226-240`）。这两个分支都会落进这个窗口。后果是：约 8s 后才靠 `OMP_ABORT_GRACE_MS` 退回结算为 `stopped`；之后对该消息 regenerate/fork 永久 502，后续用户消息上的 fork 因序位错开也 502。

本刀按定案把 `abort` 帧的写出推迟到「该回合已开始」：已收到 `agent_start`，或 prompt 应答已报告本地完成结果（`agentInvoked:false`）。推迟完全放在 runtime `abort()` 内部。同时 fake-omp 改为真二进制语义（回合开始前的 abort 静默丢弃整轮），并提供回执到 `agent_start` 之间的可控延迟。

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（issue 为 needs-triage；expanded 触发：AGENTS.md Critical Path「omp 子进程治理」、进程/回合并发次序、fake-omp 协议契约）
Blast radius: 推迟后永不写 → 停止退化为 8s retire；回合开始前结束时推迟的 Promise 悬挂或未 catch → unhandledRejection 崩溃；开始的判定漏掉本地 slash → `/compact` 停不下来；写两帧 → omp 收到重复 abort；fake 语义改错 → 全部 stop 类测试失去对真二进制的代表性
Selected risk packs: Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Public API / CLI / script entry；Legacy compatibility / examples；Documentation / migration notes
Evidence floor: runtime 真 fake 子进程用例 R1–R7、supervisor 真 fake 用例 S1–S3（新文件）、fake 契约用例 F1–F3；既有 stop/stop-intent/abort/slash 测试全绿，只在 tasks 2.2 允许的范围内改动；`make check`；编排者以真 omp v18.0.10 复测（design「Required evidence」E-real）

## What Changes
- `server/src/sessions/omp/runtime.ts` + `omp/commands.ts`（`Turn` 新字段与推迟辅助函数，按主 spec 模块划分）：`abort()` 在回执已兑现但回合未开始时不写帧，返回推迟的 Promise；`#onFrame` 在该回合的 `agent_start`，或需要继续等待输出的本地完成应答处，写出恰一帧 `abort` 并以其 response 结算；回合在开始前结束、失败、被放弃（`#abandon`）、退役或子进程退出时，以 `AgentUnavailableError` 拒绝且不写帧。
- `server/test/support/fake-omp.mjs`：`abort-ok`/`slow-ready` 新增 `--start-delay-ms <n>`：prompt ack 之后延迟 n ms 才开出持住的回合，延迟期间继续读 stdin；这期间读到的 `abort` 只回执 success 并丢弃该回合。纯搬迁把 argv 解析拆到新模块 `server/test/support/fake-omp-argv.mjs`，给 `fake-omp.mjs` 腾出行数（当前 793/800）。
- 测试：新增 runtime、supervisor 与 fake 契约三个测试文件；既有测试只在前提失效处改动（tasks 2.2）。
- supervisor.ts **零 diff**；turn-control.ts 只更新两处过时的文档注释。调用点、停止意图兑现时机与 grace 起算点都不变（父 design D2 修订）。

## Capabilities
- MODIFIED omp-runtime「相关命令 API 与回合中断」：`abort()` 的写出时机改为回合开始后；新增三个 Scenario。
- MODIFIED turn-control「停止生成 REST」：两个中断分支的写帧时机改为回合开始后；新增 Scenario「派发后极早停止」。
- MODIFIED omp-test-harness「假 omp 进程契约」：`abort-ok` 早期 abort 规则改为真二进制的丢弃语义，新增 `--start-delay-ms`；MODIFIED「假 omp 夹具模块划分」：新增 `fake-omp-argv.mjs`。

## Impact
- 行数：`runtime.ts` 763 → 目标 ≤790，硬上限 798（`Turn` 字段与推迟辅助函数放进 `commands.ts`）；`fake-omp.mjs` 793 → 拆分后 ≤770；新模块 ≤120。实测 `wc -l` 记入 PR body。
- 零 diff：`supervisor.ts`、`pool.ts`、`approvals.ts`、`store*.ts`、`events.ts`、`rest.ts`、web、`fake-omp-proxy.mjs`、`fake-omp-thinking.mjs`、全部既有 helper；`turn-control.ts` 只改注释；既有测试只在 tasks 2.2 允许的范围内改动。
- 下游：change B #526（DELETE running 复用停止序列）自动继承本修复，不需要另改。

## 偏离与决定
1. **推迟放在 runtime，不放在 supervisor/TurnStops**：runtime 本就逐帧看到该回合的 `agent_start` 与 prompt 应答，并已拥有「回执已兑现」「generation 退役」的闸；放在这里时 owner 的调用契约（何时调 `abort()`、如何处理 `false`、grace 从调用起算）一行不改。放进 supervisor pump 的话，要改接近上限的 `supervisor.ts`（782/800），还要让 `TurnStops` 新增一个阶段。
2. **本地完成的判定复用 `isLocalComplete`**（`commands.ts:246`，覆盖 `response.data.agentInvoked===false` 与 `prompt_result`）。如果这个本地完成帧同时结束了回合（无 slash 或输出已到），推迟的 abort 被拒绝、不写帧；如果回合转入等待输出（`/compact` 先回执后输出），就写出 abort，用于取消后台输出（fake `slash` 的 `handleSlashAbort` 已建模）。
3. **grace 起算点不变**：推迟期间 grace 照常计时。回执后 8s 内一直没有开始的回合走既有有界退回；这种情况下用户消息仍不入 omp 历史，按父 design 修订段的边界处理，不另作补偿。
4. **fake 的早期 abort 规则直接改成丢弃语义，不另设开关**：旧规则（「开始前读到的 abort 在 agent_start 与两段 delta 之后兑现」）只描述了一个真二进制不存在的行为；而且 n=0 时，`agent_start` 与 ack 在同一个串行步里发出，fake 读不到开始前的 abort，所以现有用例的观测不受影响。

## Non-goals
- Deny 之后 abort 时真 omp 多开的空 aborted 回合、select 与 `tool_execution_start` 的帧次序：#620。
- 审批 select 挂起期间 abort 的延后规则：#495 (a) 已验证正确，不动。
- `OMP_ABORT_GRACE_MS` 数值、有界退回语义、`applyStop`。
- 回合开始前被 grace 退役时用户消息不入历史：不补偿（偏离 3）。
- web：stop 按钮与呈现不变。
