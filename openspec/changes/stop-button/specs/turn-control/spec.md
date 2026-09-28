# Spec delta: turn-control（#477 回合控制 web 呈现：停止按钮、已停止呈现与容量文案）

> 「回合控制 web 呈现」由多个 issue 分担（主 spec 由 #472 新生）。本块以主 spec 原文为底，逐字并入父 delta 的三句：`stopped` 助手消息按 chat-web 呈现、composer `停止`（stop 202/204、Toast `已停止生成`、`turn.end stopped` 归约）、503 `agent_capacity` composer 内联文案。
> - Scenario「停止按钮与文案」：#472 在该标题下写的是解析/归约与文案部分，并注明由 #477 归档时以父 delta 原文原位替换；本块照此以父 delta 原文替换（标题不变）。#472 的解析/归约断言仍由 chat-web「stopped 与 approval 字段严格解析」「停止终态归约」两个 Scenario 承载。
> - 新增父 Scenario「容量文案」（全文）。
> - 未交付、保持主 spec 原样：`重新生成` 句归 7.3a #478；`从此处分叉` 句与 Scenario「分叉跳转与草稿」归 7.3b #479。

## MODIFIED Requirements

### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。status 为 `stopped` 的助手消息 SHALL 按 chat-web 会话页 Requirement 的定义呈现（正文末 `role="status"` 徽章 `已停止`，正文为空时显示占位 `（已停止生成）`），本 Requirement 不另行定义。会话 running 时 composer 发送按钮 SHALL 变为 `停止` 并调用 stop（202 响应 body 解析为 JSON 空对象 `{}`，204 无 body），收到 202 后 Toast `已停止生成`，收到 `turn.end stopped` 后消息与会话归约为 `stopped`。503 `agent_capacity` 的文案 `Agent 容量已满，请稍后重试` SHALL 在 composer 内联显示。

#### Scenario: 停止按钮与文案
- **WHEN** 页面级 fixture 中回合进行中
- **THEN** 发送按钮文案为 `停止`；点击后发出 `POST /api/sessions/:id/stop`，出现 Toast `已停止生成`；收到 `turn.end{status:"stopped"}` 后会话状态显示 `已停止`，该助手消息显示 `已停止` 状态徽章，按钮恢复为发送

#### Scenario: 容量文案
- **WHEN** prompt 返回 503 `agent_capacity`
- **THEN** composer 内联显示 `Agent 容量已满，请稍后重试`，草稿保留，未新增消息
