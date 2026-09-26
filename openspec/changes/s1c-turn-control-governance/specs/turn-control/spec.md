# Spec: turn-control

## Purpose
定义回合控制三条 REST 及其状态机：停止（`abort` 帧、独立 `stopped` 终态、有界退回）、重新生成（`branch` 后以原文重发）、从此处分叉（临时进程 `branch` + 行拷贝、原会话不动），以及配套的 schema 与 web 呈现契约。

## ADDED Requirements

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

### Requirement: 停止生成 REST
`POST /api/sessions/:id/stop` SHALL 受既有 cookie guard 与 owner 校验：未认证 401、不存在或属他人 404 `not_found`，均在任何 supervisor 调用前；响应 `Cache-Control: no-store`。会话 `status="running"` SHALL：先按 tool-approval 规范以 `deny` 结算该会话全部挂起审批（每条先落库、发 `Deny`、发布 `approval.resolved`、写审计），再对该会话进程 `request({type:"abort"})`，写入成功后返回 202，body 恰为 `{}`；不等待 `agent_end`。会话非 running（`idle`/`done`/`failed`/`stopped`）SHALL 返回 204 无 body，不写任何行、不向进程发帧（幂等）。supervisor SHALL 记录该回合 `abort` 已在途：同一回合再次 stop SHALL 不写第二帧 `abort`，返回 202。runtime `abort()` 因无存活子进程返回 `false` 时 SHALL 不合成 `stopped`，该回合由既有崩溃路径以 `failed` 收尾（原始退出只上报一次），响应仍为 202。

#### Scenario: 运行中停止
- **WHEN** 回合进行中调用 stop，fake-omp 以 `abort-ok` 脚本应答
- **THEN** 202 `{}`；fake-omp stdin 收到恰一帧 `{type:"abort"}`；随后浏览器事件序列以 `turn.end{messageId,status:"stopped"}` 结束且不含 `error`；`GET /api/sessions` 中该会话 `status="stopped"`

#### Scenario: 非运行中停止幂等
- **WHEN** 对 `idle`、`done`、`failed`、`stopped` 会话分别调用 stop，或对同一回合连续两次调用 stop
- **THEN** 非 running 时 204、消息表行数与 `updated_at` 不变、无入站帧；第二次 stop 落在 `abort` 已发出而 `agent_end` 未到时 fake-omp 只收到一帧 `abort`（第二次仍返回 202）

#### Scenario: 鉴权与归属
- **WHEN** 匿名请求、他人会话、不存在会话调用 stop
- **THEN** 分别 401、404、404（后两者响应一致），无 supervisor 调用与数据变更

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

### Requirement: 重新生成 REST
`POST /api/sessions/:id/regenerate` SHALL 受 cookie guard 与 owner 校验（401/404 同 stop），响应 no-store。前置校验：会话 `status="running"` SHALL 409 `session_busy`；`status ∈ {done,failed,stopped}` 且末条消息 `role="assistant"` 且其前一条为 `role="user"` 方可执行，否则（含 `idle` 无消息、末条为 user）400 `bad_request`；校验阶段不写任何行。执行序：经 omp-pool 准入取得或以 `--resume <omp_session_file>` 起该会话进程（可能 503 `agent_capacity`，无持久化副作用）→ `request(get_branch_messages)` → 取列表最后一项，其 `text` SHALL 等于 SQLite 中该会话末条 user 消息的 `content`，不等（含列表为空）SHALL 502 `agent_unavailable` 且不改任何行、不发 `branch` → `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务：删除旧 assistant 行（步骤级联删除）、插入新 `running` 空 assistant 行、`omp_session_file`=新文件、会话 `status="running"`、`updated_at=now` → 以 `branch` 返回的 `text` 走既有 prompt 派发。响应 202 `{assistantMessageId}`（新行 id）。`branch` 之后、事务提交之前的任何失败 SHALL retire 该进程且不改动 `omp_session_file` 与消息行，返回 502。后续回合事件、刷盘与终态 SHALL 与普通 prompt 回合完全一致。

#### Scenario: 正常重新生成
- **WHEN** 会话 `done`、历史为 user(u1) → assistant(a1)，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `[{entryId:"e1",text:"<u1 原文>"}]`
- **THEN** 202 `{assistantMessageId:<新 id>}`；fake-omp 依次收到 `get_branch_messages`、`branch{entryId:"e1"}`、`get_state`、`prompt{message:"<u1 原文>"}`；a1 及其步骤行已删除；`omp_session_file` 等于 branch 后 `get_state` 返回的新路径；回合结束后 messages 为 user(u1) → assistant(新内容, `done`)

#### Scenario: 运行中与形态不满足
- **WHEN** 会话 running 时 regenerate
- **THEN** 409 `session_busy`，无入站帧、无行变更
- **WHEN** 会话 `idle` 无消息、或末条消息为 user
- **THEN** 400 `bad_request`，无入站帧、无行变更

#### Scenario: 分支文本不一致
- **WHEN** `get_branch_messages` 最后一项 `text` 与 SQLite 末条 user `content` 不相等，或返回空列表
- **THEN** 502 `agent_unavailable`；未发送 `branch`；assistant 行、`omp_session_file`、会话状态与 `updated_at` 完全不变；会话随后仍可正常 prompt

#### Scenario: 池满
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 regenerate 一个已被回收进程的会话
- **THEN** 503 `agent_capacity`，无行变更

### Requirement: 从此处分叉 REST
`POST /api/sessions/:id/fork` SHALL 只接受 `application/json` 且 body 恰为 `{messageId:number}`，其 content-parser 错误由归属集映射为 400 `bad_request`；受 cookie guard 与 owner 校验（401/404 同 stop），响应 no-store。`messageId` SHALL 属于该会话且 `role="user"`，否则 400 `bad_request`；原会话 `status="running"` SHALL 409 `session_busy`；原会话 `omp_session_file` 为 NULL SHALL 502 `agent_unavailable`。执行序：SQLite 先插入新会话行（`owner_id` 同、`title` 复制、`parent_session_id`=原会话 id（列为 `TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL`，删除原会话时分叉会话保留且该列置 NULL）、`status="idle"`、`omp_session_file` NULL、`stream_epoch=0`）→ 经 omp-pool 准入起**临时** `SessionRuntime`（同一 spawn 契约、`--resume <原 omp_session_file>`、不绑定任何会话 slot、计入活进程集合）→ `get_branch_messages` → 在返回列表中取序号等于该 user 消息在 SQLite 该会话 user 消息中序号（按 `created_at,id` 升序，从 0 起）的项，其 `text` SHALL 等于该消息 `content`，序号越界或文本不等 SHALL 502 → `branch{entryId}` → `get_state` 取新文件 → 关停临时进程（既有有界 retire，token 撤销）→ SQLite 单事务：新会话 `omp_session_file`=新文件，把原会话中 `(created_at,id)` 严格早于分叉点 user 消息的全部 `chat_messages` 及其 `chat_steps` 拷贝到新会话（新 id、保持顺序、`content`/`status`/`created_at`/步骤 `ordinal`/`name`/`detail`/`output`/`status`/时间原值），分叉点 user 消息本身不拷贝。响应 201 `{session:{id,title,status,createdAt,updatedAt}, draft:<branch 返回的 text>}`，`session` 为既有公共视图，不暴露 `parent_session_id`。准入 503、`branch` 前后任何失败、文本/序号不一致 SHALL 删除已建的新会话行（新会话不存在于 `GET /api/sessions`）并关停临时进程；原会话的行与 `omp_session_file` SHALL 全程不被改写（只读取以复制），原会话活进程（若有）SHALL 不被发帧、不被 retire。响应返回前临时进程 SHALL 已退出并释放名额。

#### Scenario: 正常分叉
- **WHEN** 原会话 `done`、历史 u1→a1→u2→a2，对 u2 调用 fork，fake-omp `branch` 脚本返回 `[{entryId:"e1",text:"<u1>"},{entryId:"e2",text:"<u2>"}]` 并在 `branch{entryId:"e2"}` 后创建新会话文件
- **THEN** 201 `{session:{id:<新>,title:<原 title>,status:"idle",...},draft:"<u2>"}`；新会话 messages 为 u1、a1（含 a1 步骤，新 id，顺序与内容相同）、`streamCursor:{epoch:0,seq:null}`；`chat_sessions.parent_session_id`=原 id；`omp_session_file` 为新文件路径；原会话行与文件不变；临时进程已退出且原会话未收到任何帧；`GET /api/sessions` 同时列出两会话

#### Scenario: 非法目标与运行中
- **WHEN** `messageId` 为 assistant 消息、属他会话、不存在，或 body 形态不为 `{messageId:number}`
- **THEN** 400 `bad_request`，无新会话行、无进程 spawn
- **WHEN** 原会话 running 时 fork
- **THEN** 409 `session_busy`，无新会话行、无进程 spawn

#### Scenario: 对齐失败回滚
- **WHEN** `get_branch_messages` 在目标序号处的 `text` 与该 user 消息 `content` 不等，或列表长度不足
- **THEN** 502 `agent_unavailable`；新会话行已删除、`GET /api/sessions` 不含它；未发送 `branch`；临时进程已关停；原会话不变

#### Scenario: 池满与临时进程释放
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 fork
- **THEN** 503 `agent_capacity`，新会话行已删除
- **WHEN** `OMP_MAX_PROCESSES=1` 且无其它活进程时 fork 成功
- **THEN** 201 返回时活进程数为 0，随后对新会话发 prompt 以 `--resume <新文件>` spawn 并 202

### Requirement: 回合控制 web 呈现
web SHALL：会话/消息/步骤状态联合与 `turn.end.status` 联合加 `stopped`，`hasExactlyKeys` 严格解析随 `parent_session_id` 不入视图、`turn.end{status:"stopped"}` 与 fork/regenerate 响应形状同步；`stopped` 状态文案为 `已停止`。会话 running 时 composer 发送按钮 SHALL 变为 `停止` 并调用 stop，收到 202 后 Toast `已停止生成`，收到 `turn.end stopped` 后消息与会话归约为 `stopped`。末条助手消息（会话非 running）SHALL 提供 `重新生成` 操作，调用 regenerate 并以响应的 `assistantMessageId` 替换末条助手消息为 running 空消息。每条用户消息 SHALL 提供操作条 `从此处分叉`，调用 fork 后跳转 `?session=<新 id>` 并把 `draft` 填入 composer 草稿而不发送。503 `agent_capacity` 的文案 `Agent 容量已满，请稍后重试` SHALL 在 composer 内联显示。

#### Scenario: 停止按钮与文案
- **WHEN** 页面级 fixture 中回合进行中
- **THEN** 发送按钮文案为 `停止`；点击后发出 `POST /api/sessions/:id/stop`，出现 Toast `已停止生成`；收到 `turn.end{status:"stopped"}` 后会话状态显示 `已停止`，按钮恢复为发送

#### Scenario: 分叉跳转与草稿
- **WHEN** 点击用户消息 u2 的 `从此处分叉`，fork 返回 201 `{session,draft:"<u2>"}`
- **THEN** 地址栏切到 `?session=<session.id>`，composer 草稿等于 `<u2>` 且未发出 prompt 请求，消息列表显示拷贝的历史

#### Scenario: 容量文案
- **WHEN** prompt 返回 503 `agent_capacity`
- **THEN** composer 内联显示 `Agent 容量已满，请稍后重试`，草稿保留，未新增消息
