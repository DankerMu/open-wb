# Spec delta: turn-control（#478 回合控制 web 呈现：重新生成）

> 「回合控制 web 呈现」由多个 issue 分担。本块以主 spec 原文为底（已含 #477 的 `stopped` 呈现、composer `停止` 与 503 文案三句），逐字并入父 delta 的 `重新生成` 句，位置同父 delta（`停止` 句之后、503 句之前）。两个既有 Scenario 不变。
> - web 以「受理后重载权威快照 + 从快照游标重连」实现该句的「替换」，不在本地按 `assistantMessageId` 合成新行；结果形状（旧行消失、新 id 的 running 空助手行）与句意一致，证据见 chat-web Scenario「重新生成末条回答」。
> - 未交付、保持主 spec 原样：`从此处分叉` 句与 Scenario「分叉跳转与草稿」归 7.3b #479。

## MODIFIED Requirements

### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。status 为 `stopped` 的助手消息 SHALL 按 chat-web 会话页 Requirement 的定义呈现（正文末 `role="status"` 徽章 `已停止`，正文为空时显示占位 `（已停止生成）`），本 Requirement 不另行定义。会话 running 时 composer 发送按钮 SHALL 变为 `停止` 并调用 stop（202 响应 body 解析为 JSON 空对象 `{}`，204 无 body），收到 202 后 Toast `已停止生成`，收到 `turn.end stopped` 后消息与会话归约为 `stopped`。末条助手消息在会话 `status ∈ {done,failed,stopped}` 时 SHALL 提供 `重新生成` 操作，调用 regenerate 并以响应的 `assistantMessageId` 替换末条助手消息为 running 空消息。503 `agent_capacity` 的文案 `Agent 容量已满，请稍后重试` SHALL 在 composer 内联显示。

#### Scenario: 停止按钮与文案
- **WHEN** 页面级 fixture 中回合进行中
- **THEN** 发送按钮文案为 `停止`；点击后发出 `POST /api/sessions/:id/stop`，出现 Toast `已停止生成`；收到 `turn.end{status:"stopped"}` 后会话状态显示 `已停止`，该助手消息显示 `已停止` 状态徽章，按钮恢复为发送

#### Scenario: 容量文案
- **WHEN** prompt 返回 503 `agent_capacity`
- **THEN** composer 内联显示 `Agent 容量已满，请稍后重试`，草稿保留，未新增消息
