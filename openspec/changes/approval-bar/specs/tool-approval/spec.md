# Spec delta: tool-approval（#480 审批条）

> - 「审批快照」：主 spec 已有这条 requirement（#476 归档）。本 issue 交付其余两处 web 子句后，整条已全部交付，所以直接取父 delta 同名块逐字（MODIFIED）。与主 spec 的差异只有两处：「刷新后继续作答」THEN 补回「页面渲染审批条」，「历史决定可见」THEN 补回「web 显示 `已拒绝执行`」。
> - 「web 审批条」：主 spec 没有这条 requirement（父 delta 为 ADDED），本 delta 用 ADDED，正文逐字取父 delta，只裁掉末句「会话 running 且存在 pending 审批时 composer 仍显示 `停止`。」。composer 的 `停止` 按钮归 7.2 #477，本 issue 不依赖它、master 上也还没有这个按钮。#477 与 #480 谁后归档，谁就在已推进的主 spec 上按父 delta 原文补回该句。三个 Scenario 逐字取父 delta，均由本 issue 交付。

## MODIFIED Requirements

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approvals` 字段，类型为数组：assistant 消息为该消息全部 `chat_approvals` 行按 `id` 升序的投影 `{id, tool, title, requestedAt, expiresAt, decision}`（`decision` 为 `"allow"|"deny"|"timeout"|null`）；user 消息与无审批记录的 assistant 消息为 `[]`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步（消息键集含 `approvals`，数组元素键集恰为上述六键）；归约器 SHALL 以 `approval.request` 按 `approvalId` 为键向对应消息 `approvals` 插入一条 `decision:null` 记录（同一 `approvalId` 重复到达——如回放——SHALL 不产生第二条、不覆盖其它审批），以 `approval.resolved` 只更新同一 `approvalId` 记录的 `decision`，并保持按 `id` 升序。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

#### Scenario: 刷新后继续作答
- **WHEN** 审批挂起时重新加载页面并请求 messages
- **THEN** running assistant 消息 `approvals=[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]`，其它消息 `approvals:[]`；页面渲染审批条；此时作答 allow 返回 200 且回合继续

#### Scenario: 历史决定可见
- **WHEN** 回合已 `done` 且审批曾以 deny 结算
- **THEN** 快照该消息 `approvals[0].decision="deny"`，web 显示 `已拒绝执行`

#### Scenario: 多条审批的快照与归约
- **WHEN** 同一消息先后收到 `approval.request` `a1`、`a2`，随后收到 `approval.resolved{approvalId:a2,decision:"deny"}`，再重连回放同一批事件
- **THEN** 该消息 `approvals` 为 `[{id:a1,decision:null},{id:a2,decision:"deny"}]`（按 `id` 升序、无重复）；`a1` 仍可作答；重新拉取的快照与归约结果一致

## ADDED Requirements

### Requirement: web 审批条
web SHALL 在 assistant 消息内按 `approvals` 数组为每条审批各渲染一个审批条，同一消息的多个审批条按 `id` 升序纵向排列，各自独立交互。`decision:null` 的审批条 SHALL 显示：头部标题 `需要你的确认`；工具名徽章（取自 `tool`，即 title 首行 `Allow tool: <name>` 的解析结果）；正文为 `title` **全文**，以 `white-space: pre-wrap` 保留换行；按钮 `允许`/`拒绝`；以 `expiresAt` 与本地时钟计算的单句动态倒计时文案 `（<n>s 内未操作将自动允许）`，`<n>` 为剩余整秒并随时间递减（初值 60）。`allow`/`timeout` 显示 `已允许执行`，`deny` 显示 `已拒绝执行`，均无按钮、无倒计时。点击按钮 SHALL 以该条的 `approvalId` 调用作答 REST；409 `approval_settled` SHALL 使该审批条按随后到达的 `approval.resolved` 或重新拉取的快照更新为终态文案。

#### Scenario: 审批条交互
- **WHEN** 页面级 fixture 收到 `approval.request{title:"Allow tool: bash\nReason: run ls"}` 且注入时钟距 `expiresAt` 剩 42s
- **THEN** 显示 `需要你的确认`、徽章 `bash`、正文按原换行呈现完整 title（含 `Reason: run ls`）、`允许`、`拒绝` 与 `（42s 内未操作将自动允许）`；时钟前进 1s 后文案为 `（41s 内未操作将自动允许）`；点击 `允许` 发出 `POST /api/sessions/:id/approvals/:approvalId {decision:"allow"}`；收到 `approval.resolved{decision:"allow"}` 后显示 `已允许执行`且按钮消失

#### Scenario: 超时与拒绝文案
- **WHEN** 收到 `approval.resolved{decision:"timeout"}` 或 `{decision:"deny"}`
- **THEN** 分别显示 `已允许执行` 与 `已拒绝执行`，倒计时消失

#### Scenario: 同一消息多个审批条
- **WHEN** 页面级 fixture 对同一 assistant 消息收到两个 `approval.request`（`a1`、`a2`），随后对 `a2` 点击 `拒绝`
- **THEN** 两个审批条按 `a1`、`a2` 顺序纵向显示；请求路径为 `a2` 的 approvalId；收到 `approval.resolved{approvalId:a2,decision:"deny"}` 后仅 `a2` 条显示 `已拒绝执行`，`a1` 条仍显示按钮与倒计时
