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

### Requirement: 停止生成 REST
`POST /api/sessions/:id/stop` SHALL 受既有 cookie guard 与 owner 校验：未认证 401（先于 body 解析）、不存在或属他人 404 `not_found`，均在任何 supervisor 调用前；响应 `Cache-Control: no-store`。该路由 SHALL 是无 body 路由且列入 content-parser 归属集（与 logout 先例一致）：content-parser 错误（malformed/empty JSON、unsupported media、超出最小 body limit）SHALL 映射为 400 `bad_request`，任何被解析出的 body SHALL 400 `bad_request`，均在认证之后、任何 supervisor 调用之前，无写入、无帧。

会话 `status="running"` 时 SHALL 调用 supervisor stop；stop 在其调用期间持有该会话的控制占用（调用返回即释放；停止意图路径上的 `abort` 帧在调用返回之后才写出，不在占用内），并：先按 tool-approval 规范以 `deny` 结算该会话全部挂起审批（以进入 stop 时读取的快照为准，写 `abort` 前不重读）（每条结算落库与审计同一事务 → 发 `Deny` → 发布 `approval.resolved`），再处理中断，返回 202，body 恰为 JSON 空对象 `{}`；不等待 `agent_end`。中断 SHALL 分两种：
- prompt 已派发（runtime 存在活跃回合）：对该会话进程调用 `abort()` 写出 `{type:"abort"}`，写入成功后返回 202。
- prompt 尚未派发（runtime 仍在获取/握手，`abort()` 返回 `false`，即尚无已派发的回合）：supervisor SHALL 为该回合登记"停止意图"，此刻不写任何帧，stop 随即返回 202 `{}`；该次派发 SHALL 照常进行——握手完成后 `prompt` 帧照常写出，用户消息照常进入 omp 会话历史，仍在等待派发回执的 prompt（或 regenerate）请求 SHALL 以 202 返回其原本的受理 body。supervisor 本就等待的该 `prompt` 派发回执兑现后，SHALL 立即对同一 generation 再次调用 `abort()` 写出 `{type:"abort"}`；此后与上一条完全相同：回合经归约器的普通中断路径（`message_end{stopReason:"aborted"}` → `agent_end` → 恰一个 `turn.end{messageId,status:"stopped"}`）收尾，`agent_end` 未在 `OMP_ABORT_GRACE_MS` 内到达则走有界退回（见中断帧归约与有界退回）。停止意图路径本身 SHALL 不调用 `applyStop`、不直接 `finishTurn(stopped)`：一个回合的 `turn.end` 恰由一条路径发出。被停止的 assistant 正文为 abort 生效前已到达的 text.delta（可能为空）。停止意图登记期间 runtime 获取或派发失败（派发回执拒绝）时，SHALL 走该请求在无停止意图时完全相同的失败路径（prompt → 既有受理对补偿与既有错误响应；regenerate → 其自身规则），停止意图随之丢弃、不写 `abort`。若该回合已先被其它路径终态结算（如崩溃 `failed`），停止意图 SHALL 不改写其终态。

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

### Requirement: 会话级控制占用
supervisor SHALL 按 `sessionId` 维护"控制占用"（control claim）。regenerate 与 stop 在前置校验通过的同一同步段内登记占用，持有至该操作的 prompt 派发完成（regenerate）或响应返回（stop，以及任何失败路径），并 SHALL 在每一种结束路径（2xx、409、400、502、503、异常）上释放，使失败后会话仍可正常使用。占用 SHALL 按持有次数计数：同一会话可同时有多个持有者（如 regenerate 执行中到达的 stop），每个持有者只释放自己登记的那一次，全部释放后占用才解除；supervisor SHALL 提供同步可读的"该会话是否持有控制占用"判定，供受理前拒绝使用。持有占用期间，同一会话的 regenerate 请求 SHALL 一律 409 `session_busy`，不写任何行、不向进程发帧、不 spawn。stop 不受占用阻塞、永不因占用返回 409：它按会话 `status` 判定（非 running → 204；running 而 prompt 尚未派发 → 停止意图，见停止生成 REST；regenerate 派发后即为普通 running 回合，可正常停止）。持有占用的会话，其进程在 omp-pool 中视为"回合中"，不可被驱逐。

#### Scenario: regenerate 各 RPC 间隙的并发请求
- **WHEN** 会话 `done`，regenerate 执行中，分别在进程已准入而 `ready` 未到、`get_branch_messages` 应答未到、`branch` 应答未到、branch 之后的 `get_state` 应答未到（事务提交前）时向同一会话注入 regenerate 请求
- **THEN** 每个注入请求均 409 `session_busy`；注入请求未新增或修改任何 `chat_messages`/`chat_steps`/`chat_sessions` 行，未改动 `omp_session_file` 与会话文件，fake-omp 未收到注入请求引起的任何帧；原 regenerate 照常兑现并完成回合

#### Scenario: 失败后释放占用
- **WHEN** regenerate 因分支文本不一致 502、因池满 503 结束
- **THEN** 响应返回时占用已释放：随后对该会话的合法 prompt 返回 202

#### Scenario: stop 持有占用且不被占用阻塞
- **WHEN** 会话 A 回合进行中调用 stop；另一次，A 的 regenerate 持有占用（`branch` 应答未到）时对 A 调用 stop
- **THEN** 前者 stop 调用期间 A 持有控制占用、调用返回后占用解除，stop 不因占用被拒；后者 stop 正常返回且不写任何帧，返回后 A 仍持有占用（stop 的释放不抵消 regenerate 的登记），regenerate 照常完成后占用解除

### Requirement: 重新生成 REST
前置校验：会话 `status="running"` 或该会话持有控制占用 SHALL 409 `session_busy`；`status ∈ {done,failed,stopped}` 且末条消息 `role="assistant"` 且其前一条为 `role="user"` 方可执行，否则（含 `idle` 无消息、末条为 user）400 `bad_request`；校验阶段不写任何行。校验通过即登记控制占用（见会话级控制占用），并记下预检读到的末条 assistant id。

执行序：取得该会话进程——若有存活进程则复用；若进程已被回收，SHALL 经与 prompt **相同**的懒 spawn 路径（omp-pool 准入、`--resume <omp_session_file>`、握手、token）取得一个正常 generation：`stream_epoch` 恰 +1 并新建该 generation 的 ring，后续回合事件经该 ring 发布、SSE 语义与普通 prompt 回合一致（准入可能 503 `agent_capacity`，无行变更）→ `request(get_branch_messages)` → 取列表最后一项，其 `text` SHALL 等于 SQLite 中该会话末条 user 消息的 `content`，不等（含列表为空）SHALL 502 `agent_unavailable` 且不改任何行、不发 `branch` → `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务：先以 CAS 复核会话 `status` 仍非 running 且末条 assistant id 仍等于预检读到的 id，复核失败 SHALL 409 `session_busy`、不改任何行并 retire 该进程；复核通过则删除旧 assistant 行（步骤与审批级联删除）、插入新 `running` 空 assistant 行、`omp_session_file`=新文件、会话 `status="running"`、`updated_at=now` → 以 `branch` 返回的 `text` 在同一 generation 上走既有 prompt 派发（不再 bump epoch）。regenerate 调用以 `{assistantMessageId}`（新行 id）兑现。`branch` 之后、事务提交之前的任何失败 SHALL retire 该进程且不改动 `omp_session_file` 与消息行，返回 502 `agent_unavailable`。事务提交之后的派发失败 SHALL 把新 assistant 行与会话结算为 `failed` 并返回 502 `agent_unavailable`，不复活已删除的旧 assistant 行。后续回合事件、刷盘与终态 SHALL 与普通 prompt 回合完全一致。

#### Scenario: 正常重新生成
- **WHEN** 会话 `done`、历史为 user(`"second question"`) → assistant(a1)，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}`
- **THEN** regenerate 兑现 `{assistantMessageId:<新 id>}`；fake-omp 依次收到 `get_branch_messages`、`branch{entryId:"fake-entry-2"}`、`get_state`、`prompt{message:"second question"}`；a1 及其步骤行已删除；`omp_session_file` 等于 branch 后 `get_state` 返回的新路径；回合结束后 messages 为 user(`"second question"`) → assistant(新内容, `done`)

#### Scenario: 已回收会话的重新生成取得正常 generation
- **WHEN** 会话 `done` 且其进程已经 `OMP_IDLE_MS` 空闲回收，此时 messages 快照 `streamCursor.epoch=E`，随后调用 regenerate
- **THEN** regenerate 兑现；子进程以 `--resume <omp_session_file>` spawn；`stream_epoch` 恰 +1 一次（`get_branch_messages` 所用获取与随后的 prompt 派发共用这一 generation，不二次递增）；该会话 SSE 收到新 generation 的 `turn.start` … `turn.end(done)`；回合结束后 messages 快照 `streamCursor.epoch=E+1`

#### Scenario: 运行中与形态不满足
- **WHEN** 会话 running 时 regenerate
- **THEN** 409 `session_busy`，无入站帧、无行变更
- **WHEN** 会话 `idle` 无消息、或末条消息为 user
- **THEN** 400 `bad_request`，无入站帧、无行变更

#### Scenario: 分支文本不一致
- **WHEN** `get_branch_messages` 最后一项 `text` 与 SQLite 末条 user `content` 不相等，或返回空列表
- **THEN** 502 `agent_unavailable`；未发送 `branch`；assistant 行、`omp_session_file`、会话状态与 `updated_at` 完全不变；会话随后仍可正常 prompt

#### Scenario: branch 之后提交之前失败
- **WHEN** fake-omp 对 `branch` 正常应答后在 `get_state` 应答前退出（或事务写入抛错）
- **THEN** 502 `agent_unavailable`；该进程被 retire；旧 assistant 行及其步骤、`omp_session_file`、会话 `status` 与 `updated_at` 完全不变；随后对该会话的合法 prompt 以 `--resume <原 omp_session_file>` 重 spawn 并 202

#### Scenario: 最终事务复核失败
- **WHEN** regenerate 的 branch 之后的 `get_state` 已发出、应答尚未到达时，会话行被直接改写为末条 assistant id 不同于预检值（或 `status="running"`）
- **THEN** 409 `session_busy`；事务不写入任何行，旧 assistant 行与 `omp_session_file` 不变；该进程被 retire；占用已释放

#### Scenario: 池满
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 regenerate 一个已被回收进程的会话
- **THEN** 503 `agent_capacity`，无行变更
