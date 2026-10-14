## MODIFIED Requirements

### Requirement: 中断帧归约与有界退回
归约器 SHALL 把 assistant `message_end{stopReason:"aborted"}` 记为"已中断"而非失败：其后终止 `agent_end`（`isTerminal` 缺省或 true）SHALL 恰发一次 `turn.end{messageId,status:"stopped"}`，不发 `error`；`stopReason:"error"` 的既有 `error` + `turn.end failed` 路径不变；同一回合先 error 后 aborted 或反之，SHALL 以首个被记住的原因为准；唯一的例外是其间发生了 omp 会话级重试：重试之后的结局替换此前记住的失败，重试被取消（`auto_retry_end` 的 `finalError` 为 `Retry cancelled`）记为已中断（chat-stream「纯协议事件归约」，#909）。`turn.end.status` 联合 SHALL 为 `done|failed|stopped`。supervisor 在调用 runtime `abort()` 取得 abort Promise 时 SHALL 启动有界等待（`abort` 帧可能推迟到回合开始后才写出，见停止生成 REST；等待不因推迟而顺延，回合迟迟不开始时同样有界）：内部常量 `OMP_ABORT_GRACE_MS = 8000`（不做配置，注入时钟），期限内 `agent_end` 未到达 SHALL 退回既有 retire 路径关停该进程，并以新增纯函数 `applyStop(state)`（与 `applyFailure` 对称）合成恰一个 `turn.end{status:"stopped"}`；退回后到达的迟到帧或进程退出 SHALL 不再产生 `error`/`turn.end failed`，会话仍以 `stopped` 收尾。`agent_end` 在期限内到达 SHALL 取消该等待且不 retire 进程，进程可继续受理下一 prompt。

#### Scenario: 原生 abort 收尾
- **WHEN** `abort` 发出后 fake-omp 依次发 `message_end{stopReason:"aborted"}`、`agent_end{isTerminal:true}`、`response{command:"abort"}`
- **THEN** 事件恰为 `…,turn.end(stopped)`，无 `error`；进程未被发送任何信号；同一进程随后可完成下一个 prompt 回合

#### Scenario: 忽略 abort 时有界退回
- **WHEN** fake-omp 以 `abort-ignored` 脚本收到 `abort` 后不再发任何帧，注入时钟推进到 7999ms 再到 8000ms
- **THEN** 7999ms 时无终止事件、无信号；8000ms 时进程进入 retire（stdin 关闭，随后按 5000/8000ms 升级），浏览器恰收到一个 `turn.end(stopped)`、无 `error`；会话/消息/步骤为 `stopped`；进程退出后活进程集合释放名额

#### Scenario: 归约纯函数
- **WHEN** 对 `createEventState` 产生的状态依次施加 `message_end aborted`、`agent_end`，以及对另一状态施加 `applyStop`
- **THEN** 两者都恰产出 `turn.end{status:"stopped"}` 一次；之后任何帧/`applyFailure`/`applyStop` 不再产出事件或改变状态；输入不被修改

#### Scenario: 重试退避中停止（真实 omp）
- **WHEN** 官方 omp v18.0.10 经模型代理连接一个对每次请求都答 503 的假上游，回合发出 `auto_retry_start` 之后、下一轮请求之前调用 stop
- **THEN** stop 返回 202 `{}`；回合在 `abort()` 之后 `OMP_ABORT_GRACE_MS` 内以恰一个 `turn.end{status:"stopped"}` 收尾，没有 `error` 事件；会话与助手消息为 `stopped`，三个错误列为 NULL；实测到的收尾路径（omp 发出 `agent_end`，或有界退回）写进实现 PR
