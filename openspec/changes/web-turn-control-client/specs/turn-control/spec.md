# Spec delta: turn-control（#472 web 联合类型与已停止文案）

> turn-control 尚无主 spec；本 delta 归档时新生该 capability（Purpose 取父 delta，#449 tool-approval 先例），只 ADDED 本 issue 交付的部分：
> - 「回合控制 web 呈现」：只含父 delta 首句（状态联合与 `turn.end.status` 联合加 `stopped`、严格解析形状同步、`已停止` 文案）。助手消息 `stopped` 呈现、composer `停止`（stop 202/204 与 Toast `已停止生成`）与 503 `agent_capacity` composer 内联文案归 7.2 #477；`重新生成` 操作归 7.3a #478；`从此处分叉` 操作归 7.3b #479。Scenario「停止按钮与文案」此处只留本刀可断言的解析/归约与文案部分（非父原文，父三个 Scenario 均为页面级；标题不变），由 7.2 #477 归档时以父 delta 原文原位替换；Scenario「分叉跳转与草稿」归 7.3b #479，「容量文案」归 7.2 #477。
> - 「stopped 终态」的「与 web 联合类型」子句由本 issue 交付，但该 requirement 由 #455（turn-stopped-reduction）ADDED，本 delta 不写；orchestrator 在 #455 归档时把该子句并入其 delta。父 delta 其余 requirement 不在本 delta。

## ADDED Requirements

### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。

#### Scenario: 停止按钮与文案
- **WHEN** 收到 `turn.end{status:"stopped"}`，或快照中会话/消息/步骤的 status 为 `stopped`
- **THEN** 严格解析通过，消息与会话（及仍 running 的步骤）归约为 `stopped`，其状态文案为 `已停止`
