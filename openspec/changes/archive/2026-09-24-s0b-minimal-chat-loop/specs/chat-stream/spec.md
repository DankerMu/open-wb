# Spec: chat-stream

## ADDED Requirements

### Requirement: 归一化事件集
app-server SHALL 把 omp 事件映射为且仅为以下事件：`turn.start{messageId}`（`agent_start`）、`text.delta{messageId,delta}`（`message_update.assistantMessageEvent.text_delta`）、`step.start{messageId,stepId,name,detail}`（`tool_execution_start`，detail 为参数单行摘要 ≤120 字符）、`step.end{messageId,stepId,status,detail}`（`tool_execution_end`，`isError` → `failed`）、`turn.end{messageId,status}`（`agent_end && isTerminal !== false` → 本回合此前出现过 `message_end` 且 `message.role=="assistant"`、`stopReason ∈ {error,aborted}` 则 `failed` 并先发 `error{message: errorMessage}`，否则 `done`；子进程异常退出或同 id 失败响应 → `failed`）、`error{messageId?,message}`、`replay.gap{}`。`thinking_*`、`toolcall_*`、`turn_*`、`message_start/end` 与其它 omp 帧 SHALL 不产生浏览器事件。`extension_ui_request` SHALL 立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。

#### Scenario: 映射与过滤
- WHEN 假子进程发出含 thinking_delta、toolcall_delta、turn_start 的完整回合
- THEN 浏览器侧事件序列精确为 `turn.start, step.start, step.end, text.delta×n, turn.end(done)`，无其它类型
- WHEN 假子进程发出 `message_end{stopReason:"error",errorMessage:"upstream 500"}` 后 `agent_end{isTerminal:true}`
- THEN 事件序列以 `error{message:"upstream 500"}, turn.end(failed)` 结束

#### Scenario: UI 请求回绝
- WHEN 假子进程发出 `extension_ui_request{method:"confirm"}`
- THEN 子进程 stdin 收到对应 id 的 `cancelled:true` 响应，浏览器无事件

### Requirement: 事件 id、缓冲与回放
每会话事件 id SHALL 为 `<streamEpoch>:<seq>`：`streamEpoch` 每次 runtime 创建时对 `chat_sessions.stream_epoch` 加一并持久化，`seq` 在 epoch 内从1单调递增。Supervisor SHALL 在持久化/缓冲后、外部观察者前把事件写入该 generation 的唯一 RingBuffer；SSE SHALL 复用它，不另设计数器/缓冲。每会话保留当前 epoch 最近1000条事件。带 Last-Event-ID 且 epoch 相同、seq≥缓冲最小seq−1时 SHALL 回放后继再实时，否则先 replay.gap 再实时。不带ID时，非running直接实时；running且保留本回合turn.start则从start回放，否则gap再实时。native/token撤销时 SHALL 保留尚待发布排空的ring；只有残留发布排空后才清除并以快照seq:null封口，下一epoch重新计数。GET messages 的完整历史与streamCursor由#214提供；客户端按其边界过滤重叠事件。

#### Scenario: 断线回放
- WHEN 客户端收到 `1:5` 后断开，回合继续到 `1:9`，客户端以 `Last-Event-ID: 1:5` 重连
- THEN 依次收到 `1:6..1:9` 后接实时事件，无重复无缺失

#### Scenario: 刷新中重放
- WHEN 回合进行中（已发 turn.start、step.*、两段 text.delta）一个不带 `Last-Event-ID` 的新连接到达
- THEN 首帧为该回合的 `turn.start`，随后依序回放 step 与两段 delta，再接实时事件；若缓冲已淘汰该 `turn.start`，首帧为 `replay.gap`

#### Scenario: 缺口
- WHEN 以 `Last-Event-ID: 0:3`（旧 epoch）或已被淘汰的 seq 重连，或服务重启后重连
- THEN 首帧为 `event: replay.gap`，随后只收实时事件

### Requirement: SSE 端点
`GET /api/sessions/:id/events` SHALL 返回 `200`、`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-store`、`Connection: keep-alive`；数据帧为 `id:<epoch>:<seq>`、`event:<type>`、`data:<JSON>`；replay.gap 控制帧 SHALL 使用空 `id:` 行重置 EventSource 游标且不消耗数据序号。每15s一条 `: keepalive` 注释；同一会话允许多个并发订阅并扇出同一已记录事件序列；客户端断开不影响runtime与其它订阅者；会话不存在或属他人须在任何帧前404。订阅/回放交接和关停清理 SHALL 复用#214的generation身份与记录所有权，不重建第二套缓冲。

#### Scenario: 双订阅扇出
- WHEN 两个连接订阅同一会话后发生一个回合
- THEN 两个连接收到相同 id 序列；关闭其一后另一个继续收到后续事件
