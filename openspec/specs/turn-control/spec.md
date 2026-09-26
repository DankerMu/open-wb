# turn-control Specification

## Purpose
定义回合控制三条 REST 及其状态机：停止（`abort` 帧、独立 `stopped` 终态、派发前的停止意图、有界退回）、重新生成（`branch` 后以原文重发）、从此处分叉（临时进程 `branch` + 行拷贝、原会话行与文件不动），会话级控制占用互斥，以及配套的 schema 与 web 呈现契约。
## Requirements
### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。

#### Scenario: 停止按钮与文案
- **WHEN** 收到 `turn.end{status:"stopped"}`，或快照中会话/消息/步骤的 status 为 `stopped`
- **THEN** 严格解析通过，消息与会话（及仍 running 的步骤）归约为 `stopped`，其状态文案为 `已停止`

### Requirement: stopped 终态
`chat_sessions.status`、`chat_messages.status`、`chat_steps.status` 三处 CHECK SHALL 扩为分别含 `stopped`：会话 `∈ {idle,running,done,failed,stopped}`、消息 `∈ {done,running,failed,stopped}`、步骤 `∈ {running,done,failed,stopped}`（由迁移 `034_chat_turn_control.sql` 以重建表方式完成，列/索引/FK/级联语义与 032/033 等价）。`stopped` SHALL 是与 `failed` 不同的独立终态：`finishTurn` SHALL 接受 `stopped`，把 assistant 消息与会话置为 `stopped`、`updated_at=now`、仍 `running` 的步骤置为 `stopped` 并写 `ended_at`（output 保持 NULL，读回为 `""`），已终态步骤不变；assistant 已刷盘与待刷的部分正文 SHALL 保留。会话/消息/步骤视图、`GET /api/sessions`、`GET /api/sessions/:id/messages` 与 web 联合类型 SHALL 接受 `stopped`。`stopped` 之后会话 SHALL 与 `done`/`failed` 同等可再受理 prompt。

#### Scenario: 停止落盘形状
- **WHEN** 回合已发两段 text.delta 且一条步骤 running 时以 `stopped` 结算
- **THEN** assistant `content` 等于两段拼接、`status="stopped"`；该步骤 `status="stopped"`、`output=""`、`ended_at` 非空；会话 `status="stopped"`；`GET /api/sessions/:id/messages` 原样返回上述状态

### Requirement: 中断帧归约与有界退回
归约器 SHALL 把 assistant `message_end{stopReason:"aborted"}` 记为"已中断"而非失败：其后终止 `agent_end`（`isTerminal` 缺省或 true）SHALL 恰发一次 `turn.end{messageId,status:"stopped"}`，不发 `error`；`stopReason:"error"` 的既有 `error` + `turn.end failed` 路径不变；同一回合先 error 后 aborted 或反之，SHALL 以首个被记住的原因为准。`turn.end.status` 联合 SHALL 为 `done|failed|stopped`。归约器 SHALL 提供新增纯函数 `applyStop(state)`（与 `applyFailure` 对称），合成恰一个 `turn.end{status:"stopped"}`。

#### Scenario: 归约纯函数
- **WHEN** 对 `createEventState` 产生的状态依次施加 `message_end aborted`、`agent_end`，以及对另一状态施加 `applyStop`
- **THEN** 两者都恰产出 `turn.end{status:"stopped"}` 一次；之后任何帧/`applyFailure`/`applyStop` 不再产出事件或改变状态；输入不被修改

