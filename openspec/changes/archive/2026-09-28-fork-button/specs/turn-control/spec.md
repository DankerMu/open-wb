# Spec delta: turn-control（#479 回合控制 web 呈现：从此处分叉）

> 「回合控制 web 呈现」由多个 issue 分担。本块逐字取父 delta 全文：它等于当前主 spec 原文（已含 #477 的 `stopped`/`停止`/503 句、#478 的 `重新生成` 句）加上本 issue 交付的 `从此处分叉` 句（`重新生成` 句之后、503 句之前）与 Scenario「分叉跳转与草稿」（「停止按钮与文案」之后、「容量文案」之前）。本 slice 之后，该 requirement 全部交付，归档时父块应与推进后的主 spec 逐字一致。

## MODIFIED Requirements

### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。status 为 `stopped` 的助手消息 SHALL 按 chat-web 会话页 Requirement 的定义呈现（正文末 `role="status"` 徽章 `已停止`，正文为空时显示占位 `（已停止生成）`），本 Requirement 不另行定义。会话 running 时 composer 发送按钮 SHALL 变为 `停止` 并调用 stop（202 响应 body 解析为 JSON 空对象 `{}`，204 无 body），收到 202 后 Toast `已停止生成`，收到 `turn.end stopped` 后消息与会话归约为 `stopped`。末条助手消息在会话 `status ∈ {done,failed,stopped}` 时 SHALL 提供 `重新生成` 操作，调用 regenerate，受理（202）后以对账得到的权威快照替换末条助手消息（旧行消失、新 id 的 running 行取代，web 不按响应的 `assistantMessageId` 在本地合成行）。每条用户消息 SHALL 提供操作条 `从此处分叉`，调用 fork 后跳转 `?session=<新 id>` 并把 `draft` 填入 composer 草稿而不发送。503 `agent_capacity` 的文案 `Agent 容量已满，请稍后重试` SHALL 在 composer 内联显示。

#### Scenario: 停止按钮与文案
- **WHEN** 页面级 fixture 中回合进行中
- **THEN** 发送按钮文案为 `停止`；点击后发出 `POST /api/sessions/:id/stop`，出现 Toast `已停止生成`；收到 `turn.end{status:"stopped"}` 后会话状态显示 `已停止`，该助手消息显示 `已停止` 状态徽章，按钮恢复为发送

#### Scenario: 分叉跳转与草稿
- **WHEN** 点击用户消息 u2 的 `从此处分叉`，fork 返回 201 `{session,draft:"<u2>"}`
- **THEN** 地址栏切到 `?session=<session.id>`，composer 草稿等于 `<u2>` 且未发出 prompt 请求，消息列表显示拷贝的历史

#### Scenario: 容量文案
- **WHEN** prompt 返回 503 `agent_capacity`
- **THEN** composer 内联显示 `Agent 容量已满，请稍后重试`，草稿保留，未新增消息

