# Spec: tool-approval

## Purpose
定义 exec 档工具调用的用户审批链路：审批请求识别、`chat_approvals` 持久化、`approval.request`/`approval.resolved` 事件、作答 REST、60s 超时自动允许、与停止的次序、审计留痕、快照恢复与 web 审批条。

## ADDED Requirements

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 修订后的 spawn 契约以 `--approval-mode write` 启动。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]`（顺序与内容精确）且 `title` 以 `Allow tool: ` 开头 → 视为审批请求向上抛出而不自动应答；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 不同的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。

#### Scenario: 识别为审批
- **WHEN** fake-omp `approval` 脚本在 bash 的 `tool_execution_start` 之后、执行前发 `extension_ui_request{id:"r1",method:"select",title:"Allow tool: bash\nReason: …",options:["Approve","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；supervisor 收到审批请求，`tool="bash"`，`title` 为原文

#### Scenario: 非审批 UI 请求仍回绝
- **WHEN** 子进程发 `extension_ui_request{method:"confirm"}`、`{method:"input"}`、`{method:"select",options:["A","B"]}` 或 `{method:"select",title:"Pick one",options:["Approve","Deny"]}`
- **THEN** 每个都立即收到对应 id 的 `cancelled:true`，无 `chat_approvals` 行、无 `approval.*` 事件

#### Scenario: 工具名解析失败
- **WHEN** 审批 `title` 为 `Allow tool: ` 后紧跟换行
- **THEN** 仍落库为审批，`tool="unknown"`，流程与正常审批一致

### Requirement: chat_approvals 持久化
迁移 `034_chat_turn_control.sql` SHALL 新建 `chat_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK (decision IN ('allow','deny','timeout')), decided_at INTEGER NULL, UNIQUE(message_id, request_id))`。supervisor 收到审批请求 SHALL 先插入一行（`decision` NULL、`requested_at`=注入时钟 now、`expires_at = requested_at + 60000`），再发布事件。结算 SHALL 把 `decision`/`decided_at` 一次性写入且此后不可再改；同一 `(message_id, request_id)` 重复请求 SHALL 被 UNIQUE 拒绝而不产生第二行。删除消息（regenerate 删旧助手行、删会话）SHALL 级联删除其审批行。

#### Scenario: 落库形状
- **WHEN** 审批请求到达，注入时钟为 T
- **THEN** `chat_approvals` 恰一行：`message_id` 为当前 running assistant id、`request_id="r1"`、`tool="bash"`、`title` 原文、`requested_at=T`、`expires_at=T+60000`、`decision`/`decided_at` NULL

#### Scenario: 级联删除
- **WHEN** 对含审批记录的会话执行 regenerate（删旧助手行）或删除会话
- **THEN** 对应 `chat_approvals` 行不存在，无孤儿行

### Requirement: 审批事件
supervisor SHALL 在审批行持久化之后、经既有 generation ring 发布 `approval.request{messageId, approvalId, tool, title, expiresAt}`（消费一个 seq；omp 在 `tool_execution_start` 之后、工具执行之前下发审批 select，故该事件位于对应 `step.start` 之后、`step.end` 之前）；每次结算后 SHALL 发布 `approval.resolved{messageId, approvalId, decision}`，`decision ∈ {allow,deny,timeout}`。两类事件 SHALL 进入 ring 回放、SSE 扇出与 `Last-Event-ID` 语义与其它事件一致；web `stream.ts` 联合类型 SHALL 同步。审批挂起期间 SHALL 无其它该回合数据事件（omp 不发后续帧）。

#### Scenario: 事件序与回放
- **WHEN** 审批请求到达后用户 allow，回合继续到 `agent_end`
- **THEN** SSE 序列为 `turn.start, step.start(bash), approval.request{…,expiresAt:T+60000}, approval.resolved{decision:"allow"}, step.end(done), text.delta×n, turn.end(done)`，id 单调；以 `approval.request` 的 id 作 `Last-Event-ID` 重连恰从 `approval.resolved` 起回放

### Requirement: 审批作答 REST
`POST /api/sessions/:id/approvals/:approvalId` SHALL 只接受 `application/json` 且 body 恰为 `{decision:"allow"|"deny"}`，其 content-parser 错误由归属集映射为 400 `bad_request`；其它形态（缺键/多键/其它值）400。受 cookie guard 与 owner 校验：未认证 401；会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`；均在 body 解析前，无写入。`decision` 已非 NULL（已 allow/deny/timeout，或同一审批第二次作答）SHALL 409 `approval_settled`，无写入、不向 omp 发帧。pending 时 SHALL 依序：落库 `decision`/`decided_at=now` → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消超时计时器 → 发布 `approval.resolved` → 写审计 → 200，body 恰为 `{id, tool, title, requestedAt, expiresAt, decision}`（与快照 `approval` 同形）。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。`core/errors` SHALL 新增 `approval_settled`(409, `该审批已处理`)，响应 no-store。

#### Scenario: 允许
- **WHEN** pending 审批收到 `{decision:"allow"}`
- **THEN** 200 `{id,tool:"bash",title,requestedAt,expiresAt,decision:"allow"}`；fake-omp 收到 `extension_ui_response{id:"r1",value:"Approve"}`；发布 `approval.resolved{decision:"allow"}`；随后 bash 步骤 `done`，回合 `done`

#### Scenario: 拒绝
- **WHEN** pending 审批收到 `{decision:"deny"}`
- **THEN** 200 `decision:"deny"`；fake-omp 收到 `value:"Deny"` 并发 `tool_execution_end{isError:true}`；该步骤 `failed`、assistant 与会话最终 `done`（非 `failed`）

#### Scenario: 已结算与重复作答
- **WHEN** 对已 allow、已 deny、已 timeout 的审批再次作答，或对同一 pending 审批并发两次作答
- **THEN** 后到者 409 `{error:{code:"approval_settled",message:"该审批已处理"}}`；`chat_approvals` 该行 `decision` 与首次一致；omp 只收到一帧应答

#### Scenario: 形态、鉴权与归属
- **WHEN** body 为 `{decision:"maybe"}`、`{}`、`{decision:"allow",x:1}` 或非 JSON
- **THEN** 400 `bad_request`，无写入
- **WHEN** 匿名、他人会话、不存在的 approvalId、或 approvalId 属于另一会话
- **THEN** 401 或一致的 404，无写入、无入站帧

### Requirement: 超时自动允许
每条 pending 审批 SHALL 由 supervisor 以注入时钟启动 60000ms 计时器（自 `requested_at` 起）；到期时 pending SHALL 结算为 `decision="timeout"`、`decided_at=expires_at`，向 omp 发 `value:"Approve"`，发布 `approval.resolved{decision:"timeout"}`，写审计。59999ms 时 SHALL 无任何结算。已由用户作答或被停止结算的审批 SHALL 取消其计时器，到期不再动作。挂起审批期间 runtime 空闲计时器 SHALL 暂停（`markPending()`），结算后 SHALL 从结算时刻重置空闲期限（`clearPending()`）；挂起审批的进程在 omp-pool 中视为"在回合中"，不可被驱逐。

#### Scenario: 到期允许
- **WHEN** 审批请求于 T 到达，注入时钟推进到 T+59999 再到 T+60000
- **THEN** T+59999 时 `decision` 仍 NULL、无入站帧；T+60000 时 `decision="timeout"`、`decided_at=T+60000`，fake-omp 收到 `value:"Approve"`，发布 `approval.resolved{decision:"timeout"}`，随后工具步骤照常执行并 `done`

#### Scenario: 作答后计时器失效
- **WHEN** 用户在 T+10000 作答 deny，随后时钟推进过 T+60000
- **THEN** 不再有第二次结算、第二帧应答或第二个 `approval.resolved`

#### Scenario: 挂起不触发空闲回收
- **WHEN** `OMP_IDLE_MS=1000`，审批于 T 到达且无人作答，时钟推进到 T+50000
- **THEN** 进程未被 retire、无信号；T+60000 超时结算后，自结算时刻起 1000ms 无活动才 retire

### Requirement: 停止与终态对挂起审批的结算
`POST /api/sessions/:id/stop` 对 running 会话 SHALL 在发送 `abort` 之前，对该会话每条 pending 审批依序：落库 `decision="deny"` → 发 `value:"Deny"` → 发布 `approval.resolved{decision:"deny"}` → 写审计；全部结算完毕后才写入 `abort` 帧。fake-omp probe 记录的入站帧序 SHALL 证明 `extension_ui_response(Deny)` 先于 `abort`。回合因其它原因终态（进程崩溃、有界退回 retire、启动对账 running→failed）时仍 pending 的审批 SHALL 在同一结算中置为 `decision="deny"`（不向已死进程发帧；能发布时发布 `approval.resolved`），使任何终态消息上不残留 `decision` NULL 的审批。

#### Scenario: 先 Deny 后 abort
- **WHEN** fake-omp `approval-then-abort` 脚本中 select 挂起时调用 stop
- **THEN** 202；probe 帧序为 `extension_ui_response{id:"r1",value:"Deny"}` 然后 `abort`；`chat_approvals.decision="deny"`；事件序为 `approval.resolved{decision:"deny"}` 后接 `turn.end(stopped)`；审计有一条 `session.approval decision=deny`

#### Scenario: 崩溃与对账不留 pending
- **WHEN** 审批挂起时子进程退出，或服务重启时库中有 pending 审批的 running 会话
- **THEN** 消息为 `failed` 且该审批 `decision="deny"`、`decided_at` 非空；快照不再显示倒计时；审计各有一条 `session.approval decision=deny`

### Requirement: 审批审计
每次审批结算（allow/deny/timeout，含停止与终态触发的 deny）SHALL 经 `core/audit` 既有 `emit` 写恰一条 `audit_events`：`kind="session.approval"`、`actorId`=会话 `owner_id`、`title="工具执行审批"`、`detail={sessionId, messageId, tool, decision}`；pending 不写审计；`GET /api/audit` SHALL 以既有形状返回该事件。

#### Scenario: 三种决定各一条
- **WHEN** 三条审批分别以 allow、deny、timeout 结算
- **THEN** `GET /api/audit?limit=3` 的 `events[*].kind` 均为 `session.approval`，`detail.decision` 分别为 `allow`/`deny`/`timeout`，`detail.tool`/`sessionId`/`messageId` 与请求一致；审批 pending 期间 audit 行数不变

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approval` 字段：assistant 消息为该消息 `chat_approvals` 中 `id` 最大的一条投影 `{id, tool, title, requestedAt, expiresAt, decision}`（`decision` 为 `"allow"|"deny"|"timeout"|null`），无记录或 user 消息为 `null`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步；归约器 SHALL 以 `approval.request` 写入对应消息 `approval`（`decision:null`），以 `approval.resolved` 更新 `decision`。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

#### Scenario: 刷新后继续作答
- **WHEN** 审批挂起时重新加载页面并请求 messages
- **THEN** running assistant 消息 `approval={id,tool:"bash",title,requestedAt,expiresAt,decision:null}`，其它消息 `approval:null`；页面渲染审批条；此时作答 allow 返回 200 且回合继续

#### Scenario: 历史决定可见
- **WHEN** 回合已 `done` 且审批曾以 deny 结算
- **THEN** 快照该消息 `approval.decision="deny"`，web 显示 `已拒绝执行`

### Requirement: web 审批条
web SHALL 在 assistant 消息内根据 `approval` 渲染审批条：`decision:null` 显示标题 `需要你的确认`、工具名与 title 首行、按钮 `允许`/`拒绝`，以及以 `expiresAt` 与本地时钟计算的倒计时文案 `（60s 内未操作将自动允许）`（数字为剩余整秒）；`allow`/`timeout` 显示 `已允许执行`，`deny` 显示 `已拒绝执行`，均无按钮。点击按钮 SHALL 调用作答 REST；409 `approval_settled` SHALL 使审批条按随后到达的 `approval.resolved` 或重新拉取的快照更新为终态文案。会话 running 且存在 pending 审批时 composer 仍显示 `停止`。

#### Scenario: 审批条交互
- **WHEN** 页面级 fixture 收到 `approval.request` 且注入时钟距 `expiresAt` 剩 42s
- **THEN** 显示 `需要你的确认`、`bash`、`允许`、`拒绝` 与 `（42s 内未操作将自动允许）`；点击 `允许` 发出 `POST /api/sessions/:id/approvals/:approvalId {decision:"allow"}`；收到 `approval.resolved{decision:"allow"}` 后显示 `已允许执行`且按钮消失

#### Scenario: 超时与拒绝文案
- **WHEN** 收到 `approval.resolved{decision:"timeout"}` 或 `{decision:"deny"}`
- **THEN** 分别显示 `已允许执行` 与 `已拒绝执行`，倒计时消失
