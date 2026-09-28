# Spec delta: tool-approval（#477 恢复审批条下的 `停止` 子句）

> 「web 审批条」由 #480 以父 delta 原文 ADDED，只裁掉末句「会话 running 且存在 pending 审批时 composer 仍显示 `停止`。」（`停止` 按钮归本 issue）。本 issue 交付 `停止` 按钮后按父 delta 原文补回该句；三个 Scenario 与主 spec 逐字相同。本块即父 delta 同名块全文，本刀后该 requirement 全部交付。

## MODIFIED Requirements

### Requirement: web 审批条
web SHALL 在 assistant 消息内按 `approvals` 数组为每条审批各渲染一个审批条，同一消息的多个审批条按 `id` 升序纵向排列，各自独立交互。`decision:null` 的审批条 SHALL 显示：头部标题 `需要你的确认`；工具名徽章（取自 `tool`，即 title 首行 `Allow tool: <name>` 的解析结果）；正文为 `title` **全文**，以 `white-space: pre-wrap` 保留换行；按钮 `允许`/`拒绝`；以 `expiresAt` 与本地时钟计算的单句动态倒计时文案 `（<n>s 内未操作将自动允许）`，`<n>` 为剩余整秒并随时间递减（初值 60）。`allow`/`timeout` 显示 `已允许执行`，`deny` 显示 `已拒绝执行`，均无按钮、无倒计时。点击按钮 SHALL 以该条的 `approvalId` 调用作答 REST；409 `approval_settled` SHALL 使该审批条按随后到达的 `approval.resolved` 或重新拉取的快照更新为终态文案。会话 running 且存在 pending 审批时 composer 仍显示 `停止`。

#### Scenario: 审批条交互
- **WHEN** 页面级 fixture 收到 `approval.request{title:"Allow tool: bash\nReason: run ls"}` 且注入时钟距 `expiresAt` 剩 42s
- **THEN** 显示 `需要你的确认`、徽章 `bash`、正文按原换行呈现完整 title（含 `Reason: run ls`）、`允许`、`拒绝` 与 `（42s 内未操作将自动允许）`；时钟前进 1s 后文案为 `（41s 内未操作将自动允许）`；点击 `允许` 发出 `POST /api/sessions/:id/approvals/:approvalId {decision:"allow"}`；收到 `approval.resolved{decision:"allow"}` 后显示 `已允许执行`且按钮消失

#### Scenario: 超时与拒绝文案
- **WHEN** 收到 `approval.resolved{decision:"timeout"}` 或 `{decision:"deny"}`
- **THEN** 分别显示 `已允许执行` 与 `已拒绝执行`，倒计时消失

#### Scenario: 同一消息多个审批条
- **WHEN** 页面级 fixture 对同一 assistant 消息收到两个 `approval.request`（`a1`、`a2`），随后对 `a2` 点击 `拒绝`
- **THEN** 两个审批条按 `a1`、`a2` 顺序纵向显示；请求路径为 `a2` 的 approvalId；收到 `approval.resolved{approvalId:a2,decision:"deny"}` 后仅 `a2` 条显示 `已拒绝执行`，`a1` 条仍显示按钮与倒计时

