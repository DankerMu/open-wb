# Spec delta: tool-approval（#476 审批快照）

> 主 spec 尚无「审批快照」（父 delta 为 ADDED，由 5.3 #476 与 7.4 #480 分担），故本 delta 为 ADDED 且只含本 issue（父 tasks 5.3）交付的部分：requirement 正文逐字取父 delta（server 投影、web 严格键集、归约与「刷新后可从快照恢复并继续作答」均由本刀交付，作答 REST 已由 #468 交付）；三个 Scenario 保留父标题，裁剪如下，#480 归档时以父 delta 原文原位替换：
> - 「刷新后继续作答」THEN 去掉「页面渲染审批条」→ 7.4 #480；
> - 「历史决定可见」THEN 去掉「web 显示 `已拒绝执行`」→ 7.4 #480；
> - 「多条审批的快照与归约」全文取父 delta（快照投影与 web 归约同属本刀）。
> - 父 delta「web 审批条」整条 → 7.4 #480，不在本 delta。

## ADDED Requirements

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approvals` 字段，类型为数组：assistant 消息为该消息全部 `chat_approvals` 行按 `id` 升序的投影 `{id, tool, title, requestedAt, expiresAt, decision}`（`decision` 为 `"allow"|"deny"|"timeout"|null`）；user 消息与无审批记录的 assistant 消息为 `[]`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步（消息键集含 `approvals`，数组元素键集恰为上述六键）；归约器 SHALL 以 `approval.request` 按 `approvalId` 为键向对应消息 `approvals` 插入一条 `decision:null` 记录（同一 `approvalId` 重复到达——如回放——SHALL 不产生第二条、不覆盖其它审批），以 `approval.resolved` 只更新同一 `approvalId` 记录的 `decision`，并保持按 `id` 升序。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

#### Scenario: 刷新后继续作答
- **WHEN** 审批挂起时重新加载页面并请求 messages
- **THEN** running assistant 消息 `approvals=[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]`，其它消息 `approvals:[]`；此时作答 allow 返回 200 且回合继续

#### Scenario: 历史决定可见
- **WHEN** 回合已 `done` 且审批曾以 deny 结算
- **THEN** 快照该消息 `approvals[0].decision="deny"`

#### Scenario: 多条审批的快照与归约
- **WHEN** 同一消息先后收到 `approval.request` `a1`、`a2`，随后收到 `approval.resolved{approvalId:a2,decision:"deny"}`，再重连回放同一批事件
- **THEN** 该消息 `approvals` 为 `[{id:a1,decision:null},{id:a2,decision:"deny"}]`（按 `id` 升序、无重复）；`a1` 仍可作答；重新拉取的快照与归约结果一致
