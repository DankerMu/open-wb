# Proposal: nonanswer-settlement（#474）

## Why
父 change `s1c-turn-control-governance` tasks 4.6（epic #448，issue #474）。

作答与超时（#464）、停止（#473）都已能结算审批。回合经其它路径进入终态时，审批行仍停在 `decision NULL`：

- 崩溃、传输失败或空闲回收中途退出：pump catch → `applyFailure` → `finishTurn(failed)`；
- 有界退回：grace 到期 → retire → `applyStop` → `finishTurn(stopped)`；
- 优雅关停：`shutdown` → retire → pump catch；兜底为 store `close()`；
- 启动对账：`reconcileOnStartup`。

现有代码的缺口：

- `finishOwnedTurn`（`server/src/sessions/store-approvals.ts:186-252`）与 `reconcileStatuses`（`:270-280`）不碰 `chat_approvals`；
- `ApprovalRegistry.close()`（`approvals.ts:138-143`）只撤销计时器、不结算，并且清掉了全部登记；
- 计时器未撤销的路径上，60s 到期会把一个从未执行的工具记为 `timeout`（自动允许）审计（carry-forward #597）；
- 进程已退出后作答仍会 CAS 命中，返回 200（#464 R17 注）；
- 重启后留下的 pending 行仍可被 REST 作答（carry-forward #599）。

本刀交付存储不变量：任何回合的终态事务提交后，该 assistant 消息不再有 `decision NULL` 的审批。四条非作答路径共用 store 的 `settlePendingForMessage`，结算与终态翻转、审计处于同一事务。有 ring 时，supervisor 在该提交之后、`turn.end` 之前发布 `approval.resolved{deny}`，不向子进程写帧，并撤销计时器。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」；审批默认方向、持久化结算与帧/事件次序只能用真实子进程与真实 SQLite 证明)
Blast radius: 终态消息残留 pending → 刷新后审批条仍可作答，进程已死却返回 200 并写审计；计时器未撤销 → 60s 后给未执行的工具写 `timeout`（=允许）审计；结算不与终态同事务 → 出现有终态无决定或有决定无审计；resolved 晚于 `turn.end` 或落在已封口 ring → 在线 web 一直显示 pending；向退出中的子进程写应答 → EPIPE/写已结束流；`finishTurn` 改返回值 → 约 50 处既有断言失效；缺 emit 时一律抛错 → 无审批的旧调用方关停失败
Selected risk packs: Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Public API / CLI / script entry；Legacy compatibility / examples；Resource limits / large input / discovery；Auth / permissions / secrets
Evidence floor: 新建 `server/test/session-store-settlement.test.ts`（store 级）、`session-settlement.test.ts`、`session-settlement-stop.test.ts` 与 helper `session-settlement-helpers.ts`（各 ≤800 行），真实 fake-omp 子进程 + 真实 SQLite + 注入时钟 + 真实 `createApp`→`registerSessions`；design「Required evidence」N1–N5、C1–C5、B1–B3 全绿，红/绿按 design 标注；既有测试只允许 design 列出的一处 helper 改动；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 退出 0

## What Changes
- `server/src/sessions/store-approvals.ts`：
  - 新增 `settlePendingForMessage`，在调用方事务内执行：列出该消息全部 `decision IS NULL` 行（按 id 升序）→ 逐条 CAS 为 `deny` 并写 `decided_at` → 逐条经注入 `emit` 写 `session.approval` 审计（`actorId` 为会话 `owner_id`）→ 返回被结算的条目；
  - 有待结算行而 emit 缺失时抛错回滚；
  - `finishOwnedTurn` 在同一事务里调用它；
  - 新增对账辅助：先对 running 消息结算，再翻转状态。
- `server/src/sessions/store.ts`：
  - 导出 `SettledApproval = {messageId, approvalId, decision:"deny"}`（carry-forward #454：跨模块消费的类型定义在 `store.ts`）；
  - `finishTurn(assistantMessageId, status, settled?)` 保持 `boolean` 返回值，事务提交后把结算条目追加到可选第三参数；
  - `close()`、`reconcileOnStartup()` 接入同一结算。
- `server/src/sessions/turn-control.ts`：`persistEvent` 把 `turn.end` 的结算回报传回调用方（偏离 1）。
- `server/src/sessions/approvals.ts`（偏离 1）：
  - 新增终态收尾方法（示意名 `settled(entries)`）：按登记撤销计时器，`clearPending`，request 未发布时先补发，删登记，经 `#emit` 发布 `approval.resolved{deny}`，不发帧；
  - `close()` 只撤销计时器、保留登记，使关停路径上的 pump catch 仍能发布。
- `server/src/sessions/supervisor.ts`：只在 `#commit` 接线。结算回报非空时，先 await 上述收尾，再发布 `turn.end`。
- 测试：三个新测试文件与一个新 helper；既有测试只改一处 helper（偏离 5）。

## Capabilities
- MODIFIED tool-approval：
  - 「停止与终态对挂起审批的结算」「审批审计」「超时自动允许」「审批作答 REST」：父 delta 整段逐字（全量交付）；
  - 「审批事件」：主 spec 加父括注「，见停止与终态对挂起审批的结算」，属部分交付，其余差异见 delta 引注与 Open questions。
- MODIFIED chat-sessions：
  - 「会话持久化与回合刷盘」「Supervisor ordered persistence and publication」「Session module registration and teardown」：父 delta 整段逐字（全量交付）；
  - 「会话 REST」：主 spec 加父 Scenario「Stop is accepted …」中的审批 WHEN/THEN（#475 移交）。
- MODIFIED chat-stream「审批事件发布」：父 delta 整段逐字（全量交付，含 #464 裁掉的非作答结算句与 Scenario「Settlement without a child answer」）。
- 不改「会话 supervisor 源码模块划分」：`approvals.ts` 的「审批编排」已涵盖终态收尾，终态收尾不发帧，与该条「作答与超时的结算」措辞不冲突（#473 同样的处理）。
- 不改「会话 store 源码模块划分」：主 spec 已写 `store-approvals.ts` 承载「非作答结算」。

## Impact
- 行数（实测记入 PR body）：
  - `supervisor.ts` 780 → 约 785（目标 ≤790，硬上限 798）。只加 `#commit` 内约 5 行，不需要先做纯搬迁。若超过 790：把 `#failure`（`supervisor.ts:508-513`）作为纯搬迁移入 `TurnStops`（`turn-control.ts`）。它只包装停止退回的结局，与 `expired()` 同一职责，这是唯一预批准的后备方案。启用后备方案时 `turn-control.ts` 条件预算放宽到 ≤255（搬入 `#failure` 连同 `applyStop`/`applyFailure` 值导入与 `asError` 约 +10 行），`supervisor.ts` 相应下降。
  - `store.ts` 680 → ≤700；`store-approvals.ts` 280 → ≤360；`approvals.ts` 215 → ≤245；`turn-control.ts` 235 → ≤240。
- 零 diff：`rest.ts`、`events.ts`、`pool.ts`、`index.ts`、`store-branch.ts`、`omp/` 全部、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs`（793/800，不加场景）。
- 生产 argv 仍为 `yolo`，直到 #481（2.1b，依赖本刀）才切换。因此生产库里不存在审批行，也就没有「终态消息上遗留 NULL 行」的历史数据需要迁移；对账只处理 running 消息，符合父文。

## 偏离与决定
1. **PR Boundary 外改 `approvals.ts` 与 `turn-control.ts`**。
   - `approvals.ts`：计时器与登记是 `#registrations` 私有状态（`approvals.ts:51`），撤销计时器、`clearPending` 以及「resolved 不先于 request」的补发，都只能在登记处完成（同 #473 偏离 1）。
   - `approvals.ts` 的 `close()`：`shutdown()` 在 retire 之前调用它（`supervisor.ts:220-227`）。如果它继续清空登记，关停时 pump catch 的终态结算找不到登记，无从发布 resolved，「优雅关停时 ring 仍在则照常发布」便不成立。
   - `turn-control.ts`：`finishTurn` 唯一的 src 调用方是 `persistEvent`（`turn-control.ts:221-223`），结算回报只能经它回到 `#commit`。
2. **`finishTurn` 以可选第三参数回报，不改返回值**。约 50 处既有断言 `expect(store.finishTurn(...)).toBe(true)`（`session-store*.test.ts`、`sqlite-text.test.ts`、`session-rest.test.ts` 等 12 个文件）依赖 `boolean`。只在事务提交后追加；事务回滚时参数保持不变。
3. **`finishTurn` 对任意终态（含 `done`）都结算**。issue 只列 failed|stopped，父 chat-sessions 原文不区分状态，本刀逐字交付父文。
   - 可达性：`done` 伴随 pending 经 omp 不可达（omp 的 agent loop 等待 select 后才会 `agent_end`，fake 同理），无需分支。
   - 附带效果：这消除了 #605 记下的 W3「同 slot 前一回合残留登记」来源，因为任一终态都会删掉登记（design「#605 残留来源」）。
   - 证据：store 级 N1 对三种状态参数化。
4. **`decided_at` 取 store 的 `Date.now()`**：与同一事务写入的 `updated_at`/`ended_at` 同一个 `now`（`store-approvals.ts:197`）；对账取对账时刻。store 没有注入时钟，supervisor 级用例对时间取上下界，store 级用例用 `withFakeClock` 固定。
5. **必要的既有 helper 改动**：`server/test/session-rest-helpers.ts:52` 的 `createSessionStore` 补传 `emit`。
   - 原因：`session-approval-snapshot.test.ts` 的 S2/S3/S5 在 running 回合上留下 pending 行，`withSessionRest` 在 `finally` 里调用 `store.close()`。本刀后 `close()` 会结算这些行，缺 emit 就失败关闭并抛错。
   - 外键满足：该库经 migration 010 已有 `u1` 账户（`010_auth_schema_seed.sql:36`），审计外键成立。
6. **缺 emit 只在「确有待结算行」时失败关闭**。这与 `settlePendingApproval` 在 CAS 命中后才要求 emit 的先例一致（`store-approvals.ts:155-157`）。以下调用方在没有 pending 行时行为不变：`session-stop.test.ts:346`（S6 无 emit 对账）、`session-store-helpers.ts:107`、`sqlite-text.test.ts:95`、`core-db-chat-step-output.test.ts:134`。
7. **「优雅关停（supervisor `close()`）」的落点**：即 app `preClose`（`index.ts:57-88`）的 `supervisor.shutdown()` → retire → pump catch → `finishTurn(failed)`，此时有 ring，照常发布；随后 store `close()` 兜底结算 pump 未能提交终态的回合（infraFaulted、未派发），此时无 ring，不发布。父文措辞逐字保留。
8. **关停时在线 SSE 客户端收不到 resolved**：`shutdown()` 先 `#subscribers.clear()`（`supervisor.ts:223`），之后才 retire。resolved 仍进 ring 并送达 `onEvent`，但不再扇出。这是既有的关停次序，本刀不改；客户端重连后以快照为准，快照中为 `deny`。

## Open questions（上报编排者，本刀不处理）
- **infra-faulted 回合保留审批计时器**（R16b 路径、S7 类持久化失败、publish 故障）：pump 不提交终态（`supervisor.ts:471-474,491`），登记与计时器仍在；60s 后 `#expire` 会把该行写成 `timeout`（自动允许）审计，而工具从未执行。这不是四条路径之一；store `close()`/对账只在它之前到达时才以 `deny` 结算。建议新 issue：`#retireSlot` 对 infraFaulted slot 撤销其审批计时器。
- **「审批事件」孤儿片段**：#464 把「web `stream.ts` 联合类型 SHALL 同步」与 Scenario「两条并行审批分别作答」的快照子句指派给 #476，但 #476 归档时没有推进，行为已由 #476 交付。建议在本刀归档 PR 或 #486 对账时补入主 spec。
- **S7 类残局 stop 返回 202 却不生效**（carry-forward #475/#607）：`finishTurn(stopped)` 失败后行仍为 running、supervisor 没有 claim，`SessionSupervisorPort.stop()` 没有受理信号。本刀不改 stop 端口与路由，建议新 issue。这类行在重启对账时以 `deny` 结算（N5 覆盖同一代码）。
- **carry-forward #611 的 pump 次序问题**（`decide` → `#publishRequestOnce` 可能先于 pump 的 `turn.start`）：本刀的终态发布在 pump 的 `#commit` 内，排在该回合全部已排队帧（含 `agent_start` → `turn.start`）之后（`FrameStream.fail` 先排空，`prompt-stream.ts:57-64`），不受影响，也不修复它。owner 仍是 #480 或新 issue。
- `session-approvals-faults.test.ts:313` R18 标题「without settling them」在本刀后不再准确：关停会以 `deny` 结算，断言仍全部成立。零 diff；是否改名由编排者在归档时决定。
- `session-approval-events.test.ts` 头注释陈旧（carry-forward #464）：只报告。

## Non-goals
- 作答、超时、停止三条发帧结算（4.3 #464、4.2a #473 已交付）；`r2` 与 `abort` 帧的相对先后，以及 probe `frames=`（Deny 先于 abort 由 #473 S3/S4 证明）。
- REST 路由（5.x）、快照投影（5.3 #476）、web（7.x）；fake-omp 任何改动。
- 未派发回合（回执前）上的审批：REST 的 `rollbackPrompt`（`rest.ts:163-167`）会删掉 assistant 行，审批行随之级联删除；残留的登记在到期时按 `not_found` 静默删除（#464 R21 路径）。这属于既有补偿，不是终态结算。
- infra-faulted 回合的计时器（见 Open questions）；stop 端口的受理信号。
