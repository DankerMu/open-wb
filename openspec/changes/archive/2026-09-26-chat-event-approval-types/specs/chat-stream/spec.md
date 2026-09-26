# Spec delta: chat-stream（#453 审批事件形状与 ring 透传）

> 父 delta「审批事件发布」由 #453（事件联合形状与 ring/SSE 透传）与 4.3 #464 / 4.6 #474（发布纪律：落库后发布、失败不发布、并行审批、无应答结算）分担；本 delta 只含前者，后者由对应 issue 归档时 MODIFIED 并入。

## ADDED Requirements

### Requirement: 审批事件发布
会话事件联合 SHALL 新增两类由 supervisor（而非纯归约器）产生的事件：`approval.request{messageId,approvalId,tool,title,expiresAt}` 与 `approval.resolved{messageId,approvalId,decision}`，其中 `messageId` 为当前回合的助手消息数字 id，`approvalId` 为 `chat_approvals.id`，`tool`/`title` 为字符串，`expiresAt` 为 epoch ms 整数，`decision` ∈ `allow|deny|timeout`。二者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer，消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，不需要 ring 或 SSE 端点的任何特殊处理；SSE 以 `event:approval.request`/`event:approval.resolved` 帧投递。

#### Scenario: Request and resolution are ordered ring events
- **WHEN** a bound turn's ring receives turn.start, `approval.request{messageId,approvalId,tool,title,expiresAt}`, `approval.resolved{messageId,approvalId,decision:"allow"}` and turn.end in that order
- **THEN** the four events carry consecutive sequence ids with both approval payloads unchanged and before turn.end; an SSE subscriber reconnecting with the id preceding the request receives `event:approval.request`, `event:approval.resolved` and turn.end in order exactly once

#### Scenario: Refresh during a pending approval
- **WHEN** a client connects without a cursor while the turn is running and its approval is still pending
- **THEN** replay starts at the retained turn.start and includes the `approval.request` event, so the client can render the approval bar without a snapshot round trip; a resolved event published later arrives live with the next sequence
