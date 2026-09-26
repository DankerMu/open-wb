# Spec delta: turn-control（#455 stopped 终态结算与中断帧归约）

> turn-control 尚无主 spec；本 delta 只 ADDED 本 issue 交付的部分，其余由后续 issue 归档时以 MODIFIED 并入：
> - 「stopped 终态」：三处 CHECK 句已由 1.1 #449（迁移 034）交付，此处原文重述以使该 requirement 完整；「与 web 联合类型」子句已由 7.1 #472（PR #558）交付，归档时并入；「启动对账仍只把 `running` 置为 `failed`，`stopped` 行不受影响」句与 Scenario「停止后继续对话」「对账不触碰 stopped」归 4.2a #473。
> - 「中断帧归约与有界退回」：本 delta 交付归约器与 `turn.end.status` 联合两句，并以一句只陈述纯函数 `applyStop` 本身；supervisor 的 `OMP_ABORT_GRACE_MS` 有界等待、退回 retire 与迟到帧规则，以及 Scenario「原生 abort 收尾」「忽略 abort 时有界退回」归 4.2a #473（届时以父 delta 原文整句替换本 delta 的 `applyStop` 句）。
> - 父 delta 其余 requirement（会话级控制占用、停止生成 REST、重新生成 REST、从此处分叉 REST、回合控制 web 呈现）不在本 delta。

## ADDED Requirements

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
