## MODIFIED Requirements

### Requirement: 中断帧归约与有界退回
归约器 SHALL 把 assistant `message_end{stopReason:"aborted"}` 记为"已中断"而非失败：其后终止 `agent_end`（`isTerminal` 缺省或 true）SHALL 恰发一次 `turn.end{messageId,status:"stopped"}`，不发 `error`；`stopReason:"error"` 的既有 `error` + `turn.end failed` 路径不变；同一回合先 error 后 aborted 或反之，SHALL 以首个被记住的原因为准。`turn.end.status` 联合 SHALL 为 `done|failed|stopped`。supervisor 在调用 runtime `abort()` 取得 abort Promise 时 SHALL 启动有界等待（`abort` 帧可能推迟到回合开始后才写出，见停止生成 REST；等待不因推迟而顺延，回合迟迟不开始时同样有界）：内部常量 `OMP_ABORT_GRACE_MS = 8000`（不做配置，注入时钟），期限内 `agent_end` 未到达 SHALL 退回既有 retire 路径关停该进程，并以新增纯函数 `applyStop(state)`（与 `applyFailure` 对称）合成恰一个 `turn.end{status:"stopped"}`；退回后到达的迟到帧或进程退出 SHALL 不再产生 `error`/`turn.end failed`，会话仍以 `stopped` 收尾。`agent_end` 在期限内到达 SHALL 取消该等待且不 retire 进程，进程可继续受理下一 prompt。

#### Scenario: 原生 abort 收尾
- **WHEN** `abort` 发出后 fake-omp 依次发 `message_end{stopReason:"aborted"}`、`agent_end{isTerminal:true}`、`response{command:"abort"}`
- **THEN** 事件恰为 `…,turn.end(stopped)`，无 `error`；进程未被发送任何信号；同一进程随后可完成下一个 prompt 回合

#### Scenario: 忽略 abort 时有界退回
- **WHEN** fake-omp 以 `abort-ignored` 脚本收到 `abort` 后不再发任何帧，注入时钟推进到 7999ms 再到 8000ms
- **THEN** 7999ms 时无终止事件、无信号；8000ms 时进程进入 retire（stdin 关闭，随后按 5000/8000ms 升级），浏览器恰收到一个 `turn.end(stopped)`、无 `error`；会话/消息/步骤为 `stopped`；进程退出后活进程集合释放名额

#### Scenario: 归约纯函数
- **WHEN** 对 `createEventState` 产生的状态依次施加 `message_end aborted`、`agent_end`，以及对另一状态施加 `applyStop`
- **THEN** 两者都恰产出 `turn.end{status:"stopped"}` 一次；之后任何帧/`applyFailure`/`applyStop` 不再产出事件或改变状态；输入不被修改

### Requirement: 停止生成 REST
`POST /api/sessions/:id/stop` SHALL 受既有 cookie guard 与 owner 校验：未认证 401（先于 body 解析）、不存在或属他人 404 `not_found`，均在任何 supervisor 调用前；响应 `Cache-Control: no-store`。该路由 SHALL 是无 body 路由且列入 content-parser 归属集（与 logout 先例一致）：content-parser 错误（malformed/empty JSON、unsupported media、超出最小 body limit）SHALL 映射为 400 `bad_request`，任何被解析出的 body SHALL 400 `bad_request`，均在认证之后、任何 supervisor 调用之前，无写入、无帧。

会话 `status="running"` 时 SHALL 调用 supervisor stop；stop 在其调用期间持有该会话的控制占用（调用返回即释放；停止意图路径上的 `abort` 帧在调用返回之后才写出，不在占用内），并：先按 tool-approval 规范以 `deny` 结算该会话全部挂起审批（以进入 stop 时读取的快照为准，写 `abort` 前不重读）（每条结算落库与审计同一事务 → 发 `Deny` → 发布 `approval.resolved`），再处理中断，返回 202，body 恰为 JSON 空对象 `{}`；不等待 `agent_end`。中断 SHALL 分两种：
- prompt 已派发（runtime 存在活跃回合）：对该会话进程调用 `abort()`，随即返回 202。`{type:"abort"}` 帧由 runtime 在该回合已开始（收到 `agent_start` 或本地完成应答）之后写出（见 omp-runtime「相关命令 API 与回合中断」）：真 omp 在回合开始前收到 `abort` 会静默丢弃整轮，用户消息不入会话历史，其后的 regenerate/fork 对齐随之失效。stop 不等待该帧写出；`OMP_ABORT_GRACE_MS` 从 `abort()` 被调用时起算。
- prompt 尚未派发（runtime 仍在获取/握手，`abort()` 返回 `false`，即尚无已派发的回合）：supervisor SHALL 为该回合登记"停止意图"，此刻不写任何帧，stop 随即返回 202 `{}`；该次派发 SHALL 照常进行——握手完成后 `prompt` 帧照常写出，用户消息照常进入 omp 会话历史，仍在等待派发回执的 prompt（或 regenerate）请求 SHALL 以 202 返回其原本的受理 body。supervisor 本就等待的该 `prompt` 派发回执兑现后，SHALL 立即对同一 generation 再次调用 `abort()`，`{type:"abort"}` 帧同样在该回合已开始之后才写出；此后与上一条完全相同：回合经归约器的普通中断路径（`message_end{stopReason:"aborted"}` → `agent_end` → 恰一个 `turn.end{messageId,status:"stopped"}`）收尾，`agent_end` 未在 `OMP_ABORT_GRACE_MS` 内到达则走有界退回（见中断帧归约与有界退回）。停止意图路径本身 SHALL 不调用 `applyStop`、不直接 `finishTurn(stopped)`：一个回合的 `turn.end` 恰由一条路径发出。被停止的 assistant 正文为 abort 生效前已到达的 text.delta（可能为空）。停止意图登记期间 runtime 获取或派发失败（派发回执拒绝）时，SHALL 走该请求在无停止意图时完全相同的失败路径（prompt → 既有受理对补偿与既有错误响应；regenerate → 其自身规则），停止意图随之丢弃、不写 `abort`。若该回合已先被其它路径终态结算（如崩溃 `failed`），停止意图 SHALL 不改写其终态。

会话非 running（`idle`/`done`/`failed`/`stopped`）SHALL 返回 204 无 body，不写任何行、不向进程发帧（幂等）。supervisor SHALL 记录该回合的停止已在途：同一回合再次 stop SHALL 不写第二帧 `abort`、不重复结算审批，返回 202 `{}`。

#### Scenario: 运行中停止
- **WHEN** 回合进行中调用 stop，fake-omp 以 `abort-ok` 脚本应答
- **THEN** 202，body 恰为 `{}`；fake-omp stdin 收到恰一帧 `{type:"abort"}`；随后浏览器事件序列以 `turn.end{messageId,status:"stopped"}` 结束且不含 `error`；`GET /api/sessions` 中该会话 `status="stopped"`

#### Scenario: 非运行中停止幂等
- **WHEN** 对 `idle`、`done`、`failed`、`stopped` 会话分别调用 stop
- **THEN** 204、响应无 body；消息表行数与 `updated_at` 不变、无入站帧

#### Scenario: 同一回合二次停止
- **WHEN** fake-omp 以 `abort-ignored` 脚本运行，回合中调用 stop，在 `abort` 已发出而 `agent_end` 未到、有界退回尚未触发时再次调用 stop
- **THEN** 两次均 202 `{}`；fake-omp stdin 记录恰一帧 `abort`；无第二次审批结算；最终恰一个 `turn.end(stopped)`

#### Scenario: 派发前停止
- **WHEN** fake-omp 以 `slow-ready` 脚本运行（`--ready-delay-ms` 使获取/握手窗口可观察），会话发出 prompt（REST 仍在等待派发回执、会话已为 running）时调用 stop，随后握手完成；该回合结束后对同一会话发一个 probe prompt
- **THEN** stop 在握手完成前返回 202 `{}`；该 prompt 请求返回 202 `{userMessageId,assistantMessageId}`；该回合的 assistant 与会话为 `stopped`，SSE 该回合恰一个 `turn.end(stopped)`、无 `error`、无 `turn.end(failed)`；probe prompt 在同一进程上 202 且正常完成，其报告的 `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`（`abort` 紧随被停止回合的 `prompt`，末个 `prompt` 为 probe）

#### Scenario: abort 返回 false 走停止意图
- **WHEN** supervisor 对 running 会话调用 runtime `abort()` 而它因 prompt 尚未派发返回 `false`
- **THEN** 此刻不写 `abort` 帧，stop 仍返回 202 `{}`；该回合派发回执兑现后 supervisor 对同一 generation 再次调用 `abort()`，入站帧序为该回合的 `prompt` 后恰一帧 `abort`；回合经 `message_end aborted` → `agent_end` 以恰一个 `turn.end(stopped)` 收尾（不经 `applyStop` 合成）；不产生 `error` 或 `turn.end(failed)`

#### Scenario: body 与鉴权
- **WHEN** 已认证 owner 以 `{}`、`{"x":1}`、malformed JSON 或 `text/plain` body 调用 stop
- **THEN** 400 `bad_request`，无 supervisor 调用、无写入、无入站帧
- **WHEN** 匿名请求、他人会话、不存在会话调用 stop
- **THEN** 分别 401、404、404（后两者响应一致），无 supervisor 调用与数据变更

#### Scenario: 获取失败丢弃停止意图
- **WHEN** fake-omp 以 `no-ready-hang` 脚本运行，会话发出 prompt 后、握手超时之前调用 stop，随后握手超时、该进程经既有获取失败路径关停；另一会话以同一脚本发出 prompt 但不调用 stop，作为对照
- **THEN** 两个 prompt 以同一既有错误结束（响应状态码、错误信封、受理对补偿后的消息与会话状态均与对照相同）；两个子进程收到的入站帧相同，且都不含 `abort`；两个会话都没有 `turn.end` 或 `error` 事件

#### Scenario: 准入与前代退役等待期间停止
- **WHEN** 会话的 prompt 已受理但尚未取得可派发的进程时调用 stop：该 prompt 仍在进程池准入中，或在等待该会话上一进程退役完成；或 stop 在该 prompt 的获取/握手期间登记了停止意图，随后该 prompt 因上一进程已退出而改在新进程上重新准入
- **THEN** stop 正常返回，此刻不写任何帧；该 prompt 在其最终取得的进程上照常派发，派发回执兑现后该进程恰收到一帧 `abort`，回合以恰一个 `turn.end(stopped)` 收尾，不产生 `error`；已退役的上一进程没有收到 `abort`

#### Scenario: regenerate 派发前停止
- **WHEN** regenerate 已提交事务（新 assistant 行与会话为 running）而其 prompt 派发回执尚未兑现时调用 stop，随后派发回执兑现
- **THEN** stop 正常返回，此刻不写任何帧；派发回执兑现后该进程恰收到一帧 `abort`，回合经 `message_end aborted` → `agent_end` 以恰一个 `turn.end(stopped)` 收尾，不产生 `error`；regenerate 兑现其 `{assistantMessageId}`
- **WHEN** 同样登记了停止意图，但提交后的派发失败
- **THEN** 新 assistant 行与会话为 `failed`，regenerate 以 502 `agent_unavailable` 拒绝；进程未收到 `abort`；已删除的旧 assistant 行未被复活

#### Scenario: 派发后极早停止
- **WHEN** fake-omp 以 `abort-ok --start-delay-ms 300` 运行（回合在 prompt ack 后 300ms 才开始；此前读到的 `abort` 按真 omp 语义静默丢弃整轮），会话 prompt 的派发回执兑现后立即调用 stop；另以 `slow-ready --ready-delay-ms 300 --start-delay-ms 300` 在握手期间调用 stop；两者都在该回合结束后发一个 probe prompt
- **THEN** stop 均返回；不推进注入时钟，该回合的 assistant 与会话为 `stopped`，SSE 恰一个 `turn.end(stopped)`、无 `error`，未经有界退回；probe prompt 在同一进程上正常完成，其 `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`

#### Scenario: 回合迟迟不开始时仍有界收尾
- **WHEN** fake-omp 以 `abort-ok --start-delay-ms 60000` 运行，派发回执兑现后调用 stop，注入时钟推进 `OMP_ABORT_GRACE_MS`
- **THEN** 进程不收到 `abort` 帧；回合经有界退回以恰一个 `turn.end(stopped)` 收尾，不产生 `error`，没有未处理的 Promise 拒绝
