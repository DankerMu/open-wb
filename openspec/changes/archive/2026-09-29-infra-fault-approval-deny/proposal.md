# Proposal: infra-fault-approval-deny（#619）

## Why
#448 的 PR #617 在「范围外」一节列出的问题，另见 archive `2026-09-27-nonanswer-settlement` 的 Open question。2026-09-29 owner 拍板采用推荐方案。

pump 走基础设施故障（infraFaulted）路径时，只置 `slot.infraFaulted = true` 并调 `#retireSlot`，不提交终态。触发点包括：
- `#commit` 持久化失败（`server/src/sessions/supervisor.ts:617-621`）；
- `#publish` 的 onEvent sink 违约（`:649-653`）；
- `handleFlushError`（`:287-292`）；
- 审批自身的 fault sink（`:126-131`）。

`#retireSlot`（`:704-721`）只释放 claim、关停 runtime、封口 generation，不碰 `ApprovalRegistry`。该 slot 上挂起审批的登记与 60s 计时器因此留了下来，到期后 `#expire`（`approvals.ts:176-199`）经 `decision IS NULL` 的 CAS 写入 `timeout`，也就是「自动允许」，并记一条 `session.approval detail.decision=timeout` 审计。但工具从未执行，进程也早已退出。启动对账只 deny NULL 行，这条虚假的「已允许执行」会永久保留。在计时器到期之前，owner 的 REST 作答同样能 CAS 命中，给一个未执行的工具记下 `allow`。自 #617 切到 write 之后，这条路径在生产上可达。

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent（expanded 触发：AGENTS.md Critical Path「omp 子进程治理」、持久化状态与审计、并发计时器与结算竞争）
Blast radius:
- 漏结算：仍写入虚假的 timeout/allow。
- 重复结算：同一审批出现两条审计，或 CAS 冲突抛错。
- 结算失败未兜住：计时器残留，或 retire 抛错使关停链路中断。
- 误伤非 infra 的 retire（崩溃、有界退回、关停、空闲回收）：这些路径的既有结算语义被改变。
Selected risk packs: Error handling / rollback / partial outputs；Concurrency / shared state / ordering；Schema / columns / units / field names（审计 detail 与 decision 取值）；Legacy compatibility / examples；Documentation / migration notes
Evidence floor: 新测试 F1–F4（真实 fake-omp 子进程、真实 SQLite trigger 注入故障、注入时钟）；既有 R15/R16a/R16b/R18 与 `session-settlement*.test.ts` 全绿；`make check`

## What Changes
- `server/src/sessions/approvals.ts`：新增 `abandon(slot)`。对该 slot 的每条登记：撤销计时器、删除登记、`clearPending`，再经 store `settleApproval(sessionId, approvalId, "deny", now)` 做 `decision IS NULL` CAS 结算，结算与审计在同一事务内完成。不向 omp 发帧，不发布事件（generation 已撤销，其 sink 可能正是故障源；pump 仍活着时封口可能推迟）。返回结算失败的错误，由 supervisor 保留。
- `server/src/sessions/supervisor.ts`：`#retireSlot` 在 `slot.infraFaulted` 为真时，于撤销 generation（`sealGeneration`）之后、await 关停之前调用 `abandon(slot)`，并把返回的错误交给 `#retain`。非 infra 的 retire 路径行为不变。
- spec：MODIFIED tool-approval「停止与终态对挂起审批的结算」，结算路径由六条增为七条，新增第 7 条「基础设施故障 retire：`deny`」；MODIFIED「审批事件」，把第 7 条从「每条结算发布恰一个 `approval.resolved`」中排除。

## Capabilities
- MODIFIED tool-approval「停止与终态对挂起审批的结算」、「审批事件」。

## Impact
- `supervisor.ts` 782 → 目标 ≤788（硬上限 798）；`approvals.ts` 241 → 约 275。实测行数记入报告。
- 零 diff：`store*.ts`、`turn-control.ts`、`events.ts`、`rest.ts`、runtime 与 `omp/`、web、fake-omp。
- 父 change `s1c-turn-control-governance` 的 tool-approval delta 也含同名需求，在本 change 的归档 PR 里做定点同步。

## Non-goals
- infraFaulted 回合本身在 store 中一直 running、直到优雅关停或重启才翻转终态的问题：issue 的 Out of scope。
- 残留：结算事务失败的行、故障前登记已被删除的行（例如超时事务单次失败的审批，`#expire` 在 `#fault` 之前删登记）在对账前仍为 NULL，见 design Non-goals。
- 审批 TTL 数值；select 挂起时 stdin EOF 的真实 omp 行为。
- 非 infra 的 retire 路径：崩溃与有界退回由 pump 终态结算，关停由 `close()` 与 pump 终态结算，二者都已覆盖。
