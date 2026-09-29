# Design: infra-fault-approval-deny（#619）

Change surface:
- `ApprovalRegistry`（`server/src/sessions/approvals.ts`）新增 `abandon(slot)`。
- `SessionSupervisor.#retireSlot`（`supervisor.ts:704-721`）的一处调用。

Must preserve:
- 六条既有结算路径的语义与次序逐字不变：作答、超时、停止、崩溃或有界退回、优雅关停、启动对账。
- 非 infra 的 retire 路径（`slot.infraFaulted` 为假）零行为变化：
  - 空闲回收、驱逐、进程退出后的 retire、`#abortPreProgress`；
  - pump catch 的崩溃或有界退回：先由 pump 提交终态，经 `settled()` 结算 deny，再 retire；
  - `close()`：计时器撤销、登记保留给 pump 终态 deny。
- 已结算的行（`decision` 非 NULL）不被改写，也不重复审计。
- `abandon` 同步完成、从不抛出，结算失败只返回错误；`#retireSlot` 其余步骤（释放名额、删除 slot）照常执行。

Must add/change:
- `abandon(slot)`：对 `registration.slot === slot` 的每条登记依次执行：
  1. 撤销计时器，删除登记，`slot.runtime.clearPending(approvalId)`；
  2. `store.settleApproval(sessionId, approvalId, "deny", clock.now())`。返回 null 表示已结算，静默跳过；抛出 `not_found`（消息已删，级联掉审批）同样静默跳过；其它错误收集起来返回。
  - 不调 `respondApproval`（进程正在退出），不 `#emit`：此时 generation 已 revoked，但 pump 仍活着时 `sealGeneration` 会推迟封口，所以它未必已 sealed；不发布是有意的，因为其 sink 可能正是故障源。已订阅的客户端要重新读取快照才会看到「已拒绝执行」。
- `#retireSlot`：`if (slot.infraFaulted) for (const e of this.#approvals.abandon(slot)) this.#retain(e);`，放在 `sealGeneration` 之后、`await slot.retiring` 之前（同步段内，任何计时器回调都插不进来）。
- 结果：
  - 该审批 `decision="deny"`、`decided_at` 非空，审计恰一条 `session.approval detail.decision=deny`；
  - 此后 owner 的 REST 作答 → 409 `approval_settled`；
  - 注入时钟推进 ≥60000ms 不会写入 timeout，fake 不会收到任何 `extension_ui_response`。

Governing invariant: slot 因 infra 故障退役之后，该 slot 上所有仍登记的审批要么以 deny 结算（或已由其它路径先结算），要么在结算事务失败时保持 NULL；两种情况下计时器都已撤销，不存在之后才到期的 timeout。残留：结算事务失败的行，以及故障发生前登记已被删除的行（F2 中超时事务失败的 r1），在重启对账之前仍为 NULL，owner 的作答仍可能命中 CAS，见 Non-goals。

Sibling surfaces:
- 各个 infraFaulted 入口：
  - approvals fault sink（`:126-131`）：插入失败、超时事务失败，这条路径的登记已先删除；
  - `handleFlushError`（`:287-292`）；
  - pump 循环（`:528`、`:548`）；
  - `#commit` catch（`:617-621`）；
  - `#publish` catch（`:649-653`）。
  它们都经 `#retireSlot`，由这一个接入点统一覆盖。
- `#expire`（`approvals.ts:176-199`）：登记删除后，已排定的回调走不到（计时器已撤销）；即使在同一事件循环里已经进入回调，也会被 CAS 的 `decision IS NULL` 拒绝，返回 null，走静默分支。
- `decide`（REST 作答）：与 `abandon` 共用同一 CAS，后到者返回 null → 409。
- pump 终态 `settled()`：infra 路径下 pump 已不再提交终态；`settled()` 遇到已删除的登记会 `continue`。
- 启动对账 `reconcileRunning`：只处理 NULL 行，本刀结算后的 deny 行保持不变，回合本身仍由它翻转为 failed（不在本刀范围）。
- 快照 `approvals` 投影与 web 审批条：deny 显示「已拒绝执行」。
- `settled()`（`approvals.ts:154-159`）发布失败时提前 return，后面几条登记的计时器仍在；现在 `#publish` 故障 → retire → `abandon` 会把它们清掉，是顺带修好的问题。

Seams under test: `SessionSupervisor` + 真实 fake-omp（`approval`、`approval-parallel`）+ 真实 SQLite（用 trigger 注入故障）+ 注入时钟 + 真实 `createApp`/`registerSessions`，即既有 `openApprovalWorld` 世界（`session-approval-helpers.ts`）。

Required evidence（新文件 `server/test/session-approvals-infra-fault.test.ts`，≤800 行）:
- F1 `approval` 场景 r1 挂起后注入 pump 的 infra 故障，两种注入各一个用例：
  - (a) 让 `#commit` 持久化失败：`approval` 场景里 r1 登记之后第一个、也是唯一一个持久化写，是 `tool_execution_start` → `step.start` → `startStep` 对 `chat_steps` 的 INSERT（fake 先发 select 再发 start；toolUse 的 `message_end` 不产生事件；`onApproval` 在读到帧时就已登记），所以用 `BEFORE INSERT ON chat_steps` 的 trigger 阻断；
  - (b) onEvent sink 违约。
  随后注入时钟推进到 T+60000 之后，断言：
  - `chat_approvals` r1 的 `decision="deny"`、`decided_at` 非空；
  - 审计恰一条 `session.approval detail.decision=deny`，零条 `timeout`；
  - fake 入站帧没有 `extension_ui_response`；
  - 故障被保留（`closeAfterRetainedFault` 或同类断言）。
- F2 `approval-parallel`，r1、r2 均挂起：仅让 r1 的超时事务失败（trigger 只匹配 r1 的 id），走 fault sink 触发 retire。断言 r2 为 `deny` 而非 `timeout`；r1 保持 NULL，留给重启对账，本用例只断言它不是 timeout；审计中没有 timeout。
- F3 F1(a) 的 infra retire 完成之后、推进注入时钟之前，owner `POST /api/sessions/:id/approvals/:r1` 返回 409 `approval_settled`：审批行与审计条数都不变，fake 没有收到帧。这一时序是 master 为红（返回 200 allow）的前提。
- F4 infra retire 时审批的结算事务本身失败（同时装两个 trigger：先用 F1(a) 的 `chat_steps` trigger 引出 infra retire，再用 `BLOCK_AUDIT` 阻断审计写入）：
  - `#retireSlot` 仍完成（名额释放、slot 删除）；
  - retire 之后立刻断言 `world.timersDueAt(T + TTL_MS) === 0`；
  - 推进时钟之前，保留的错误恰为 2 条（commit 故障与结算故障），推进 ≥60000ms 之后仍为 2 条。master 上为推进前 1 条、推进后 2 条（`#expire` 的事务失败）。可复用 `assertRetainedFaultOnShutdown`/`containsMessage`，它们能递归进 `AggregateError`；
  - 不写入 timeout。
- 红：F1、F2 在 master 上为红（写入了 timeout）；F3 在 master 上为红（返回 200 allow）。
- 变异：`#retireSlot` 去掉 `infraFaulted` 条件，对所有 retire 都调用 `abandon`。实现期实测结果：`session-settlement.test.ts` C4 与 `session-settlement-stop.test.ts` B1 变红。原因是 `abandon` 抢先结算，pump 终态的 `settled()` 拿到空列表，不再发布 `approval.resolved`，说明该条件是承重的。另外两处差异：`decided_at` 的来源（注入时钟对 `Date.now()`），以及事务边界。
- 既有：R15、R16a、R16b、R18、`session-settlement*.test.ts`、`session-stop*.test.ts` 零 diff 全绿。如果 R16b 在新行为下期望必须变化（例如 r2 从未断言变为 deny），只允许把缺口补成更强的断言，并在报告里列出。

Non-goals: 见 proposal。另外：
- 残留：结算事务失败的行、故障前登记已被删除的行（例如超时事务单次失败的审批：`#expire` 在 `#fault` 之前删登记，这是单一故障而非双重故障；瞬时错误如 SQLITE_BUSY 同样落入），在重启对账前仍为 NULL，owner 的 `allow` 仍能命中 CAS。要堵住它（例如 `decide` 拒绝没有活动登记的 NULL 行）属于范围决策，本刀不做，记入工作说明。

Review focus:
1. `abandon` 只在 infra 路径调用，非 infra retire 零行为变化。
2. 计时器撤销与登记删除先于任何可能抛错的结算调用，失败不会留下计时器。
3. 与 `#expire`、`decide`、`settled()` 的竞争都只由同一条 CAS 裁决，不会双写审计。
4. 同步段位置：在 `await slot.retiring` 之前完成，无 await。
5. spec delta 的第 7 条与实现一致，其余六条逐字不变。
