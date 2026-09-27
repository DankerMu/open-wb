# Spec delta: turn-control（#473 stop 已派发路径：Deny 全部 pending 后 abort、有界退回、二次 stop 去重）

> 只含本 issue（父 tasks 4.2a）交付的部分：
> - 「中断帧归约与有界退回」「stopped 终态」：父 delta 整段逐字，全量交付。#455 fixture 指派给本 issue 的 grace/retire/迟到帧句、对账句与 Scenario「原生 abort 收尾」「忽略 abort 时有界退回」「停止后继续对话」「对账不触碰 stopped」在此补齐，其余文字与主 spec 相同。
> - 「停止生成 REST」（父 ADDED，多刀分担，主 spec 尚无）：只收 supervisor 已派发路径，即快照 Deny 后 `abort`、不等 `agent_end`、停止已在途去重。以下部分不在本 delta：
>   - 首段路由/鉴权/parser 归属、「会话 `status="running"` 时 SHALL 调用 supervisor stop」、202 `{}`/204、Scenario「非运行中停止幂等」「body 与鉴权」→ 5.1a #475；
>   - 「prompt 尚未派发」停止意图分支与 Scenario「派发前停止」「abort 返回 false 走停止意图」→ 4.2b #490；
>   - 「stop 在其调用期间持有该会话的控制占用（…）」括注 → 4.4 #465（见下，#465 issue 正文「In Scope 补充」）。
> - Scenario 裁剪（保留父标题）：「运行中停止」去掉「202，body 恰为 `{}`」；「同一回合二次停止」的「两次均 202 `{}`」改为「两次 stop 均正常返回」，「probe 记录」改为「stdin 记录」。后者是对父文的修正：`abort-ignored` 回合挂起期间会话 running、host 不会再发 prompt，有界退回后进程已退出，probe 无从取得（carry-forward #456/#561）。父 delta 归档对账时应采纳此措辞。
> - 「会话级控制占用」（父 ADDED）整条不在本 delta。当前代码没有控制占用结构，也没有读取它的一方：prompt/regenerate/fork 在占用期间 409 的判定由 4.4 #465 首次引入，在那之前 stop 持有占用不可观察。stop 部分（「stop 在其调用期间持有该会话的控制占用，并且永不因占用返回 409」）已移交 #465，owner 记录见 #465 issue 正文「In Scope 补充（自 #473 移交，2026-09-27）」，由 #465 的新测试验证。

## MODIFIED Requirements

### Requirement: 中断帧归约与有界退回
归约器 SHALL 把 assistant `message_end{stopReason:"aborted"}` 记为"已中断"而非失败：其后终止 `agent_end`（`isTerminal` 缺省或 true）SHALL 恰发一次 `turn.end{messageId,status:"stopped"}`，不发 `error`；`stopReason:"error"` 的既有 `error` + `turn.end failed` 路径不变；同一回合先 error 后 aborted 或反之，SHALL 以首个被记住的原因为准。`turn.end.status` 联合 SHALL 为 `done|failed|stopped`。supervisor 在发出 `abort` 后 SHALL 启动有界等待：内部常量 `OMP_ABORT_GRACE_MS = 8000`（不做配置，注入时钟），期限内 `agent_end` 未到达 SHALL 退回既有 retire 路径关停该进程，并以新增纯函数 `applyStop(state)`（与 `applyFailure` 对称）合成恰一个 `turn.end{status:"stopped"}`；退回后到达的迟到帧或进程退出 SHALL 不再产生 `error`/`turn.end failed`，会话仍以 `stopped` 收尾。`agent_end` 在期限内到达 SHALL 取消该等待且不 retire 进程，进程可继续受理下一 prompt。

#### Scenario: 原生 abort 收尾
- **WHEN** `abort` 发出后 fake-omp 依次发 `message_end{stopReason:"aborted"}`、`agent_end{isTerminal:true}`、`response{command:"abort"}`
- **THEN** 事件恰为 `…,turn.end(stopped)`，无 `error`；进程未被发送任何信号；同一进程随后可完成下一个 prompt 回合

#### Scenario: 忽略 abort 时有界退回
- **WHEN** fake-omp 以 `abort-ignored` 脚本收到 `abort` 后不再发任何帧，注入时钟推进到 7999ms 再到 8000ms
- **THEN** 7999ms 时无终止事件、无信号；8000ms 时进程进入 retire（stdin 关闭，随后按 5000/8000ms 升级），浏览器恰收到一个 `turn.end(stopped)`、无 `error`；会话/消息/步骤为 `stopped`；进程退出后活进程集合释放名额

#### Scenario: 归约纯函数
- **WHEN** 对 `createEventState` 产生的状态依次施加 `message_end aborted`、`agent_end`，以及对另一状态施加 `applyStop`
- **THEN** 两者都恰产出 `turn.end{status:"stopped"}` 一次；之后任何帧/`applyFailure`/`applyStop` 不再产出事件或改变状态；输入不被修改

### Requirement: stopped 终态
`chat_sessions.status`、`chat_messages.status`、`chat_steps.status` 三处 CHECK SHALL 扩为分别含 `stopped`：会话 `∈ {idle,running,done,failed,stopped}`、消息 `∈ {done,running,failed,stopped}`、步骤 `∈ {running,done,failed,stopped}`（由迁移 `034_chat_turn_control.sql` 以重建表方式完成，列/索引/FK/级联语义与 032/033 等价）。`stopped` SHALL 是与 `failed` 不同的独立终态：`finishTurn` SHALL 接受 `stopped`，把 assistant 消息与会话置为 `stopped`、`updated_at=now`、仍 `running` 的步骤置为 `stopped` 并写 `ended_at`（output 保持 NULL，读回为 `""`），已终态步骤不变；assistant 已刷盘与待刷的部分正文 SHALL 保留。会话/消息/步骤视图、`GET /api/sessions`、`GET /api/sessions/:id/messages` 与 web 联合类型 SHALL 接受 `stopped`。启动对账仍只把 `running` 置为 `failed`，`stopped` 行不受影响。`stopped` 之后会话 SHALL 与 `done`/`failed` 同等可再受理 prompt。

#### Scenario: 停止落盘形状
- **WHEN** 回合已发两段 text.delta 且一条步骤 running 时以 `stopped` 结算
- **THEN** assistant `content` 等于两段拼接、`status="stopped"`；该步骤 `status="stopped"`、`output=""`、`ended_at` 非空；会话 `status="stopped"`；`GET /api/sessions/:id/messages` 原样返回上述状态

#### Scenario: 停止后继续对话
- **WHEN** 会话为 `stopped` 时发送合法 prompt
- **THEN** 返回 202 `{userMessageId,assistantMessageId}`，历史保留 `stopped` 的助手消息，新回合正常进行

#### Scenario: 对账不触碰 stopped
- **WHEN** 服务重启时库中有 `stopped` 会话与 `running` 会话
- **THEN** 只有 `running` 会话及其 running 消息被置为 `failed`，`stopped` 行逐字不变

## ADDED Requirements

### Requirement: 停止生成 REST
supervisor 的 stop（对 `status="running"` 的会话）SHALL 先按 tool-approval 规范以 `deny` 结算该会话全部挂起审批（以进入 stop 时读取的快照为准，写 `abort` 前不重读）（每条结算落库与审计同一事务 → 发 `Deny` → 发布 `approval.resolved`），再处理中断；不等待 `agent_end`。prompt 已派发（runtime 存在活跃回合）时：对该会话进程调用 `abort()` 写出 `{type:"abort"}`，写入成功后 stop 返回。supervisor SHALL 记录该回合的停止已在途：同一回合再次 stop SHALL 不写第二帧 `abort`、不重复结算审批。

#### Scenario: 运行中停止
- **WHEN** 回合进行中调用 stop，fake-omp 以 `abort-ok` 脚本应答
- **THEN** fake-omp stdin 收到恰一帧 `{type:"abort"}`；随后浏览器事件序列以 `turn.end{messageId,status:"stopped"}` 结束且不含 `error`；`GET /api/sessions` 中该会话 `status="stopped"`

#### Scenario: 同一回合二次停止
- **WHEN** fake-omp 以 `abort-ignored` 脚本运行，回合中调用 stop，在 `abort` 已发出而 `agent_end` 未到、有界退回尚未触发时再次调用 stop
- **THEN** 两次 stop 均正常返回；fake-omp stdin 记录恰一帧 `abort`；无第二次审批结算；最终恰一个 `turn.end(stopped)`
