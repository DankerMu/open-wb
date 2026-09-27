# Spec delta: chat-stream（#464 审批事件的发布纪律）

> 以主 spec「审批事件发布」为底，只并入父 delta 中本 issue（父 tasks 4.3）交付的发布纪律：pending 行提交后发 request、决定与审计同事务提交后发 resolved、落库失败不发布、多条并行审批、每个 `approvalId` 至多各一次、resolved 先于 `turn.end`。裁剪：
> - 次序括注「作答、超时与停止路径」裁为作答与超时；「（含停止前的 deny 与超时 allow）」裁为「（含超时 allow）」。停止路径 → #473。
> - 「回合在没有子进程应答的情况下终止时……」一整句（崩溃、传输失败、`applyStop` 退回、优雅关停、启动对账的 `deny` 结算）→ #474；Scenario「Settlement without a child answer」→ #474，未收录。
> - Scenario「Request and resolution are ordered ring events」取父 delta 的持久化提交措辞（本刀交付）；「Refresh during a pending approval」与主 spec 相同。

## MODIFIED Requirements

### Requirement: 审批事件发布
会话事件联合 SHALL 新增两类由 supervisor（而非纯归约器）产生的事件：`approval.request{messageId,approvalId,tool,title,expiresAt}` 与 `approval.resolved{messageId,approvalId,decision}`，其中 `messageId` 为当前回合的助手消息数字 id，`approvalId` 为 `chat_approvals.id`，`tool`/`title` 为字符串，`expiresAt` 为 epoch ms 整数，`decision` ∈ `allow|deny|timeout`。二者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer，消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，不需要 ring 或 SSE 端点的任何特殊处理；SSE 以 `event:approval.request`/`event:approval.resolved` 帧投递。发布纪律与步骤相同：`approval.request` SHALL 在 `chat_approvals` pending 行提交之后发布，`approval.resolved` SHALL 在该行 `decision`/`decided_at` 与其 `session.approval` 审计行同一事务提交之后发布（作答与超时路径的次序为：落库+审计（同一事务）→ 向子进程发帧 → 发布 `approval.resolved`）；落库失败 SHALL 不发布对应事件。同一助手消息 SHALL 可同时存在多条 pending 审批（并行工具调用），每条以各自 `approvalId` 独立发布 request、独立计时与结算；`approval.request` SHALL 永不覆盖或结算同一消息的更早审批，两类事件的 payload 形状不因此改变。同一 `approvalId` SHALL 至多发布一次 `approval.request` 与一次 `approval.resolved`，且 resolved 不得先于 request。这两类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合的 `approval.resolved`（含超时 allow）SHALL 在该回合 `turn.end` 之前发布。

#### Scenario: Request and resolution are ordered ring events
- **WHEN** a bound turn publishes turn.start, then an approval is persisted pending and answered `allow`, and the turn later ends
- **THEN** the ring contains, with consecutive sequence ids, `approval.request{messageId,approvalId,tool,title,expiresAt}` after the pending row commit and `approval.resolved{…,decision:"allow"}` after the decision commit, both before turn.end; an SSE subscriber reconnecting with the id preceding the request replays both in order exactly once

#### Scenario: Refresh during a pending approval
- **WHEN** a client connects without a cursor while the turn is running and its approval is still pending
- **THEN** replay starts at the retained turn.start and includes the `approval.request` event, so the client can render the approval bar without a snapshot round trip; a resolved event published later arrives live with the next sequence

#### Scenario: Persistence failure publishes nothing
- **WHEN** the pending insert, or the transaction writing the decision together with its audit row, fails in SQLite
- **THEN** no `approval.request` respectively `approval.resolved` event enters the ring, no frame is written to the child for that decision, the failure follows the existing owned error-sink path and the ring sequence is not advanced by the failed publication

#### Scenario: Parallel approvals coexist
- **WHEN** real fake-omp (`approval-parallel`) raises two approval selects in one turn and the owner answers the second (`deny`) before the first (`allow`), so the fake completes the turn normally
- **THEN** the ring holds two `approval.request` events with distinct approvalIds in request order, the second request does not alter the first, `approval.resolved` for the second precedes the one for the first, each approvalId has exactly one request and one resolved, and both precede turn.end
