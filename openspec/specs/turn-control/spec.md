# turn-control Specification

## Purpose
定义回合控制三条 REST 及其状态机：停止（`abort` 帧、独立 `stopped` 终态、派发前的停止意图、有界退回）、重新生成（`branch` 后以原文重发）、从此处分叉（临时进程 `branch` + 行拷贝、原会话行与文件不动），会话级控制占用互斥，以及配套的 schema 与 web 呈现契约。
## Requirements
### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。

#### Scenario: 停止按钮与文案
- **WHEN** 收到 `turn.end{status:"stopped"}`，或快照中会话/消息/步骤的 status 为 `stopped`
- **THEN** 严格解析通过，消息与会话（及仍 running 的步骤）归约为 `stopped`，其状态文案为 `已停止`

