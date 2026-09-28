# Spec delta: chat-stream（#474 无子进程应答的结算发布）

> 「审批事件发布」本 issue 交付后全部交付，以父 delta 同名块整段逐字替换主 spec。相对主 spec，新增末句「回合在没有子进程应答的情况下终止时 … 使快照不残留 pending 审批」（即 #464 裁掉的非作答结算句）与 Scenario「Settlement without a child answer」。停止路径的次序括注已由 #473 推进。主 spec 的四个 Scenario 原样保留。

## MODIFIED Requirements

### Requirement: 审批事件发布
会话事件联合 SHALL 新增两类由 supervisor（而非纯归约器）产生的事件：`approval.request{messageId,approvalId,tool,title,expiresAt}` 与 `approval.resolved{messageId,approvalId,decision}`，其中 `messageId` 为当前回合的助手消息数字 id，`approvalId` 为 `chat_approvals.id`，`tool`/`title` 为字符串，`expiresAt` 为 epoch ms 整数，`decision` ∈ `allow|deny|timeout`。二者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer，消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，不需要 ring 或 SSE 端点的任何特殊处理；SSE 以 `event:approval.request`/`event:approval.resolved` 帧投递。发布纪律与步骤相同：`approval.request` SHALL 在 `chat_approvals` pending 行提交之后发布，`approval.resolved` SHALL 在该行 `decision`/`decided_at` 与其 `session.approval` 审计行同一事务提交之后发布（作答、超时与停止路径的次序为：落库+审计（同一事务）→ 向子进程发帧 → 发布 `approval.resolved`）；落库失败 SHALL 不发布对应事件。同一助手消息 SHALL 可同时存在多条 pending 审批（并行工具调用），每条以各自 `approvalId` 独立发布 request、独立计时与结算；`approval.request` SHALL 永不覆盖或结算同一消息的更早审批，两类事件的 payload 形状不因此改变。同一 `approvalId` SHALL 至多发布一次 `approval.request` 与一次 `approval.resolved`，且 resolved 不得先于 request。这两类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合的 `approval.resolved`（含停止前的 deny 与超时 allow）SHALL 在该回合 `turn.end` 之前发布。回合在没有子进程应答的情况下终止时（崩溃、传输失败、`applyStop` 退回、优雅关停），以及启动对账把 running 消息置为 `failed` 时，该消息每条仍 pending 的审批 SHALL 由 store 在同一终态事务内以 `deny` 结算（写 `decided_at` 与 `session.approval` 审计，见 chat-sessions「会话持久化与回合刷盘」），不向已死/正在回收的子进程写任何帧，supervisor 取消其超时计时器；对应 `approval.resolved` SHALL 仅在该回合 generation 的 ring 存在时发布（启动对账时尚无 ring，只落库与审计、不发布任何事件），且凡发布 SHALL 在该事务提交之后、该回合 `turn.end` 之前，使快照不残留 pending 审批。

#### Scenario: Request and resolution are ordered ring events
- **WHEN** a bound turn publishes turn.start, then an approval is persisted pending and answered `allow`, and the turn later ends
- **THEN** the ring contains, with consecutive sequence ids, `approval.request{messageId,approvalId,tool,title,expiresAt}` after the pending row commit and `approval.resolved{…,decision:"allow"}` after the decision commit, both before turn.end; an SSE subscriber reconnecting with the id preceding the request replays both in order exactly once

#### Scenario: Refresh during a pending approval
- **WHEN** a client connects without a cursor while the turn is running and its approval is still pending
- **THEN** replay starts at the retained turn.start and includes the `approval.request` event, so the client can render the approval bar without a snapshot round trip; a resolved event published later arrives live with the next sequence

#### Scenario: Persistence failure publishes nothing
- **WHEN** the pending insert, or the transaction writing the decision together with its audit row, fails in SQLite
- **THEN** no `approval.request` respectively `approval.resolved` event enters the ring, no frame is written to the child for that decision, the ring sequence is not advanced by the failed publication; a failed pending insert or timeout settlement follows the existing owned error-sink path, while a failed owner answer rejects the caller with the original error and leaves the approval pending

#### Scenario: Parallel approvals coexist
- **WHEN** real fake-omp (`approval-parallel`) raises two approval selects in one turn and the owner answers the second (`deny`) before the first (`allow`), so the fake completes the turn normally
- **THEN** the ring holds two `approval.request` events with distinct approvalIds in request order, the second request does not alter the first, `approval.resolved` for the second precedes the one for the first, each approvalId has exactly one request and one resolved, and both precede turn.end

#### Scenario: Settlement without a child answer
- **WHEN** a turn with a pending approval ends by native crash, by stop's bounded retire, or by graceful shutdown while its generation's ring exists, and separately the server restarts with a running message holding a pending approval
- **THEN** in the first three cases the approval row reads `deny` with its audit row committed in the terminal transaction, no frame is written to the child for it, and `approval.resolved{decision:"deny"}` is published after that commit and before the single turn.end; on restart reconcile the row reads `deny` with its audit row and no event is published
