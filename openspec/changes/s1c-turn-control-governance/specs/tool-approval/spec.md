# Spec: tool-approval

## Purpose
定义 exec 档工具调用的用户审批链路：审批请求识别、`chat_approvals` 持久化、`approval.request`/`approval.resolved` 事件、作答 REST、60s 超时自动允许、与停止的次序、非作答路径的终态结算、审计留痕、快照恢复与 web 审批条。同一回合可同时存在多条挂起审批，每条按 `approvalId` 独立作答、计时与结算。

## MODIFIED Requirements

### Requirement: chat_approvals 持久化
迁移 `034_chat_turn_control.sql` SHALL 新建 `chat_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK (decision IN ('allow','deny','timeout')), decided_at INTEGER NULL, UNIQUE(message_id, request_id))`。supervisor 收到审批请求 SHALL 先插入一行（`decision` NULL、`requested_at`=注入时钟 now、`expires_at = requested_at + 60000`），再发布事件；同一消息上已存在的审批行（无论 pending 或已结算）SHALL 不被新请求改写或覆盖，一条 assistant 消息可有多行审批。结算 SHALL 以 compare-and-set（`UPDATE … WHERE id=? AND decision IS NULL`）把 `decision`/`decided_at` 一次性写入，此后不可再改；CAS 未命中者即为"已结算"。同一 `(message_id, request_id)` 重复请求 SHALL 被 UNIQUE 拒绝而不产生第二行。删除消息（regenerate 删旧助手行、删会话）SHALL 级联删除其审批行。

#### Scenario: 落库形状
- **WHEN** 审批请求到达，注入时钟为 T
- **THEN** `chat_approvals` 恰一行：`message_id` 为当前 running assistant id、`request_id="r1"`、`tool="bash"`、`title` 原文、`requested_at=T`、`expires_at=T+60000`、`decision`/`decided_at` NULL

#### Scenario: 同一消息多行审批
- **WHEN** 同一回合内先后到达 `request_id` 为 `r1`、`r2` 的两个审批请求
- **THEN** `chat_approvals` 中该 assistant 消息恰有两行，`id` 按到达顺序递增，`r1` 行在 `r2` 到达后字段不变

#### Scenario: 级联删除
- **WHEN** 对含审批记录的会话执行 regenerate（删旧助手行）或删除会话
- **THEN** 对应 `chat_approvals` 行不存在，无孤儿行

#### Scenario: 重复请求与决定值域
- **WHEN** 对同一 `(message_id, request_id)` 插入第二行，或写入 allow/deny/timeout 以外的 `decision`
- **THEN** SQLite 拒绝该写入，既有行不变

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

### Requirement: 审批事件
supervisor SHALL 在审批行持久化之后、经既有 generation ring 发布 `approval.request{messageId, approvalId, tool, title, expiresAt}`（消费一个 seq；omp 在 `tool_execution_start` 之后、工具执行之前下发审批 select，故该事件位于对应 `step.start` 之后、该步骤 `step.end` 之前）；每条审批结算后（该会话存在可发布的 generation ring 时，见停止与终态对挂起审批的结算）SHALL 发布恰一个 `approval.resolved{messageId, approvalId, decision}`，`decision ∈ {allow,deny,timeout}`。同一回合可有多条审批同时挂起（omp 并行执行多个工具时各自下发 select），其 `approval.request`/`approval.resolved` 可与其它步骤的 `step.*`、`text.delta` 事件交错；每条审批事件 SHALL 只作用于自身 `approvalId`，后到的 `approval.request` SHALL 不覆盖先前审批。两类事件 SHALL 进入 ring 回放、SSE 扇出与 `Last-Event-ID` 语义与其它事件一致；web `stream.ts` 联合类型 SHALL 同步。

#### Scenario: 事件序与回放
- **WHEN** fake-omp `approval` 脚本（`--approval-mode write`）的审批请求于注入时钟 T 到达后用户 allow，回合继续到 `agent_end`
- **THEN** 该回合 SSE 事件满足以下次序约束（不断言完整固定序列）：`turn.start` 为首个事件；`step.start(bash)` 先于 `approval.request{…,expiresAt:T+60000}`；`approval.request` 先于 `approval.resolved{decision:"allow"}`；`approval.resolved` 先于该步骤的 `step.end(done)`；以上全部先于恰一个 `turn.end(done)`，且它是该回合末个事件；`text.delta` 可出现在 `step.start` 之前与 `step.end` 之后（fake 在工具轮之前发出正文增量）；事件 id 严格单调；以 `approval.request` 的 id 作 `Last-Event-ID` 重连恰从 `approval.resolved` 起回放

#### Scenario: 两条并行审批分别作答
- **WHEN** fake-omp `approval-parallel` 脚本在同一回合对两个 bash 调用先后发 `extension_ui_request` `r1` 与 `r2`（均未应答），用户先对 `r2` 作答 deny、再对 `r1` 作答 allow
- **THEN** 两个 `approval.request` 的 `approvalId` 不同且都保留；fake-omp 先收到 `extension_ui_response{id:"r2",value:"Deny"}`、后收到 `{id:"r1",value:"Approve"}`，每个 id 恰一帧；发布两个 `approval.resolved`，分别携带各自 `approvalId` 与 `deny`/`allow`；`r2` 对应步骤 `failed`、`r1` 对应步骤 `done`；快照该消息 `approvals` 按 `id` 升序为 `[{…r1,decision:"allow"},{…r2,decision:"deny"}]`

### Requirement: 审批作答 REST
`POST /api/sessions/:id/approvals/:approvalId` SHALL 只接受 `application/json` 且 body 恰为 `{decision:"allow"|"deny"}`，其 content-parser 错误由归属集映射为 400 `bad_request`；其它形态（缺键/多键/其它值）400。受 cookie guard 与 owner 校验：未认证 401；会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`；均在 body 解析前，无写入。结算 SHALL 以 `decision IS NULL` 为条件的 CAS 执行，作答与超时、停止、崩溃/有界退回、优雅关停、启动对账共用这同一 CAS：`decision` 已非 NULL（已 allow/deny/timeout，同一审批第二次作答，或该消息所属进程已退出/回合已终态而被非作答路径结算为 `deny`）SHALL 409 `approval_settled`，无写入、不向 omp 发帧；并发作答时 CAS 的后到者 SHALL 409。CAS 命中时 SHALL 依序：在同一 SQLite 事务内写入 `decision`/`decided_at=now` 与审计行 → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消该 `approvalId` 的超时计时器 → 发布 `approval.resolved` → 200，body 恰为已结算的审批对象 `{id, tool, title, requestedAt, expiresAt, decision}`（与快照 `approvals` 数组元素同形）。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。`core/errors` SHALL 新增 `approval_settled`(409, `该审批已处理`)，响应 no-store。

#### Scenario: 允许
- **WHEN** pending 审批收到 `{decision:"allow"}`
- **THEN** 200 `{id,tool:"bash",title,requestedAt,expiresAt,decision:"allow"}`；fake-omp 收到 `extension_ui_response{id:"r1",value:"Approve"}`；发布 `approval.resolved{decision:"allow"}`；随后 bash 步骤 `done`，回合 `done`

#### Scenario: 拒绝
- **WHEN** pending 审批收到 `{decision:"deny"}`
- **THEN** 200 `decision:"deny"`；fake-omp 收到 `value:"Deny"` 并发 `tool_execution_end{isError:true}`；该步骤 `failed`、assistant 与会话最终 `done`（非 `failed`）

#### Scenario: 已结算与重复作答
- **WHEN** 对已 allow、已 deny、已 timeout 的审批再次作答，或对同一 pending 审批并发两次作答
- **THEN** 后到者 409 `{error:{code:"approval_settled",message:"该审批已处理"}}`；`chat_approvals` 该行 `decision` 与首次一致；omp 只收到一帧应答

#### Scenario: 作答与进程退出竞争
- **WHEN** 审批挂起时子进程退出，其非作答结算把该审批 CAS 为 `deny`，随后（或与之并发）用户对该审批作答 allow
- **THEN** CAS 仅一方命中：进程退出后到达的作答返回 409 `approval_settled`；该行 `decision="deny"` 不变；无任何 `extension_ui_response` 写出；审计恰一条 `decision=deny`

#### Scenario: 形态、鉴权与归属
- **WHEN** body 为 `{decision:"maybe"}`、`{}`、`{decision:"allow",x:1}` 或非 JSON
- **THEN** 400 `bad_request`，无写入
- **WHEN** 匿名、他人会话、不存在的 approvalId、或 approvalId 属于另一会话
- **THEN** 401 或一致的 404，无写入、无入站帧

### Requirement: 超时自动允许
每条 pending 审批 SHALL 由 supervisor 以注入时钟、按 `approvalId` 各自启动独立的 60000ms 计时器（自该审批 `requested_at` 起）；到期时该审批若仍 pending SHALL 经同一 CAS 结算为 `decision="timeout"`、`decided_at=expires_at`（与审计同一事务），向 omp 发该审批 `request_id` 的 `value:"Approve"`，发布 `approval.resolved{decision:"timeout"}`。59999ms 时 SHALL 无任何结算。某条审批到期 SHALL 不影响同回合其它审批的计时器与状态。已由用户作答、被停止或其它非作答路径结算的审批 SHALL 取消其计时器，到期不再动作。每条审批登记时 supervisor SHALL 调用 runtime `markPending(approvalId)`、结算时调用 `clearPending(approvalId)`；只要该进程仍有任一 pending 审批，runtime 空闲计时器 SHALL 暂停，最后一条 pending 审批结算后 SHALL 从该结算时刻起以完整空闲期限重置；挂起审批的进程在 omp-pool 中视为"在回合中"，不可被驱逐。

#### Scenario: 到期允许
- **WHEN** 审批请求于 T 到达，注入时钟推进到 T+59999 再到 T+60000
- **THEN** T+59999 时 `decision` 仍 NULL、无入站帧；T+60000 时 `decision="timeout"`、`decided_at=T+60000`，fake-omp 收到 `value:"Approve"`，发布 `approval.resolved{decision:"timeout"}`，随后工具步骤照常执行并 `done`

#### Scenario: 并行审批各自计时
- **WHEN** `approval-parallel` 中 `r1` 于 T 到达、`r2` 于 T+5000 到达且均无人作答，时钟推进到 T+60000 再到 T+65000
- **THEN** T+60000 时仅 `r1` 为 `timeout`、`r2` 仍 NULL，fake-omp 只收到 `{id:"r1",value:"Approve"}`；T+65000 时 `r2` 为 `timeout`、`decided_at=T+65000`，fake-omp 收到 `{id:"r2",value:"Approve"}`；两条各发布一个 `approval.resolved{decision:"timeout"}`

#### Scenario: 作答后计时器失效
- **WHEN** 用户在 T+10000 作答 deny，随后时钟推进过 T+60000
- **THEN** 不再有第二次结算、第二帧应答或第二个 `approval.resolved`

#### Scenario: 挂起不触发空闲回收
- **WHEN** `OMP_IDLE_MS=1000`，审批于 T 到达且无人作答，时钟推进到 T+50000
- **THEN** 进程未被 retire、无信号；T+60000 超时结算后，自结算时刻起 1000ms 无活动才 retire

### Requirement: 停止与终态对挂起审批的结算
任何回合进入终态时，其 assistant 消息上 SHALL 不残留 `decision` NULL 的审批。审批的全部结算路径 SHALL 恰为以下六条，均经同一 `decision IS NULL` CAS、均在结算落库的同一 SQLite 事务内写审计：
1. 用户作答（见审批作答 REST）：`allow`/`deny`，向 omp 发对应帧；
2. 超时（见超时自动允许）：`timeout`，向 omp 发 `Approve`；
3. 停止：`deny`，向 omp 发 `Deny`；
4. 进程崩溃或有界退回 retire：`deny`；
5. 服务优雅关停（supervisor `close()`）：`deny`；
6. 启动对账（running→failed）：`deny`。

第 4–6 条 SHALL 不向 omp 发任何帧（进程已退出或正在退出），SHALL 照常写审计，且仅当该会话仍有可发布的 generation ring 时发布 `approval.resolved{decision:"deny"}`（启动对账时无 ring 可发布则只落库与审计；优雅关停时 ring 仍在则照常发布）。第 4–6 条的结算 SHALL 由 store 层（`store-approvals.ts` 的 `settlePendingForMessage(messageId, decision)`）执行，与该回合的终态翻转（running→failed 或 running→stopped）处于同一事务，审计经 store 注入的 `audit.emit` 在同一事务内写入；`reconcileOnStartup` 与 `close()` SHALL 都调用它。第 1–3 条的次序 SHALL 为：结算落库与审计（同一事务）→ 向 omp 发帧 → 发布 `approval.resolved`。

停止：`POST /api/sessions/:id/stop` 的路由契约（鉴权、归属、202 `{}`/204、停止意图）由 turn-control 定义；本 Requirement 只定义其对挂起审批的结算。对 running 会话，supervisor SHALL 在发送 `abort` 之前，对该会话**全部** pending 审批逐条按上述第 3 条次序结算为 `deny` 并发 `value:"Deny"`；pending 集合 SHALL 以进入 stop 调用时读取的快照为准，写入 `abort` 前不重读——快照之后新到达的审批（如 Deny 后模型的后续调用）留给有界退回或其它非作答路径结算；全部快照项结算完毕后才写入 `abort` 帧。fake-omp probe 记录的入站帧序 SHALL 证明每条 `extension_ui_response(Deny)` 都先于 `abort`。

#### Scenario: 先 Deny 后 abort
- **WHEN** fake-omp `approval-then-abort` 脚本中 select 挂起时调用 stop
- **THEN** 202；probe `frames=` 显示 `extension_ui_response` 先于 `abort`（probe 只记帧类型）；该应答为 `{id:"r1",value:"Deny"}` 由 fake-omp 随之发出的 `tool_execution_end{isError:true}` 证明；`chat_approvals.decision="deny"`；`approval.resolved{decision:"deny"}` 先于该回合唯一的 `turn.end(stopped)`；审计有一条 `session.approval decision=deny`

#### Scenario: 停止拒绝全部挂起审批
- **WHEN** `approval-parallel` 中 `r1`、`r2` 均挂起时调用 stop
- **THEN** 202；probe `frames=` 显示两帧 `extension_ui_response` 然后恰一帧 `abort`（probe 只记帧类型）；两帧的 `id`/`value` 分别为 `{id:"r1",value:"Deny"}`、`{id:"r2",value:"Deny"}`，按审批 `id` 升序，由 fake-omp 的 `tool_execution_end` 到达顺序（各 select 应答后立即发出）证明；两行 `decision="deny"`；发布两个 `approval.resolved{decision:"deny"}`，均先于 `turn.end(stopped)`；审计两条 `decision=deny`

#### Scenario: 崩溃与对账不留 pending
- **WHEN** 审批挂起时子进程退出，或服务重启时库中有 pending 审批的 running 会话
- **THEN** 消息为 `failed` 且该审批 `decision="deny"`、`decided_at` 非空；快照不再显示倒计时；审计各有一条 `session.approval decision=deny`；无任何 `extension_ui_response` 写出

#### Scenario: 优雅关停结算挂起审批
- **WHEN** 审批挂起时 supervisor `close()`
- **THEN** 关停完成后该审批 `decision="deny"`、`decided_at` 非空；审计恰一条 `session.approval decision=deny`；未向子进程写 `extension_ui_response`；重启后 messages 快照该审批 `decision:"deny"`

### Requirement: 审批审计
每次审批结算（allow/deny/timeout，含停止与第 4–6 条非作答路径触发的 deny）SHALL 经 `core/audit` 既有 `emit` 写恰一条 `audit_events`，且与该结算的 `decision` 落库处于同一 SQLite 事务（结算回滚则审计不存在，审计失败则结算不生效）：`kind="session.approval"`、`actorId`=会话 `owner_id`、`title="工具执行审批"`、`detail={sessionId, messageId, tool, decision}`；pending 不写审计；CAS 未命中（已结算）不写审计；`GET /api/audit` SHALL 以既有形状返回该事件。

#### Scenario: 三种决定各一条
- **WHEN** 三条审批分别以 allow、deny、timeout 结算
- **THEN** `GET /api/audit?limit=3` 的 `events[*].kind` 均为 `session.approval`，`detail.decision` 分别为 `allow`/`deny`/`timeout`，`detail.tool`/`sessionId`/`messageId` 与请求一致；审批 pending 期间 audit 行数不变

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approvals` 字段，类型为数组：assistant 消息为该消息全部 `chat_approvals` 行按 `id` 升序的投影 `{id, tool, title, requestedAt, expiresAt, decision}`（`decision` 为 `"allow"|"deny"|"timeout"|null`）；user 消息与无审批记录的 assistant 消息为 `[]`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步（消息键集含 `approvals`，数组元素键集恰为上述六键）；归约器 SHALL 以 `approval.request` 按 `approvalId` 为键向对应消息 `approvals` 插入一条 `decision:null` 记录（同一 `approvalId` 重复到达——如回放——SHALL 不产生第二条、不覆盖其它审批），以 `approval.resolved` 只更新同一 `approvalId` 记录的 `decision`，并保持按 `id` 升序。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

#### Scenario: 刷新后继续作答
- **WHEN** 审批挂起时重新加载页面并请求 messages
- **THEN** running assistant 消息 `approvals=[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]`，其它消息 `approvals:[]`；页面渲染审批条；此时作答 allow 返回 200 且回合继续

#### Scenario: 历史决定可见
- **WHEN** 回合已 `done` 且审批曾以 deny 结算
- **THEN** 快照该消息 `approvals[0].decision="deny"`，web 显示 `已拒绝执行`

#### Scenario: 多条审批的快照与归约
- **WHEN** 同一消息先后收到 `approval.request` `a1`、`a2`，随后收到 `approval.resolved{approvalId:a2,decision:"deny"}`，再重连回放同一批事件
- **THEN** 该消息 `approvals` 为 `[{id:a1,decision:null},{id:a2,decision:"deny"}]`（按 `id` 升序、无重复）；`a1` 仍可作答；重新拉取的快照与归约结果一致

### Requirement: web 审批条
web SHALL 在 assistant 消息内按 `approvals` 数组为每条审批各渲染一个审批条，同一消息的多个审批条按 `id` 升序纵向排列，各自独立交互。`decision:null` 的审批条 SHALL 显示：头部标题 `需要你的确认`；工具名徽章（取自 `tool`，即 title 首行 `Allow tool: <name>` 的解析结果）；正文为 `title` **全文**，以 `white-space: pre-wrap` 保留换行；按钮 `允许`/`拒绝`；以 `expiresAt` 与本地时钟计算的单句动态倒计时文案 `（<n>s 内未操作将自动允许）`，`<n>` 为剩余整秒并随时间递减（初值 60）。`allow`/`timeout` 显示 `已允许执行`，`deny` 显示 `已拒绝执行`，均无按钮、无倒计时。点击按钮 SHALL 以该条的 `approvalId` 调用作答 REST；409 `approval_settled` SHALL 使该审批条按随后到达的 `approval.resolved` 或重新拉取的快照更新为终态文案。会话 running 且存在 pending 审批时 composer 仍显示 `停止`。

#### Scenario: 审批条交互
- **WHEN** 页面级 fixture 收到 `approval.request{title:"Allow tool: bash\nReason: run ls"}` 且注入时钟距 `expiresAt` 剩 42s
- **THEN** 显示 `需要你的确认`、徽章 `bash`、正文按原换行呈现完整 title（含 `Reason: run ls`）、`允许`、`拒绝` 与 `（42s 内未操作将自动允许）`；时钟前进 1s 后文案为 `（41s 内未操作将自动允许）`；点击 `允许` 发出 `POST /api/sessions/:id/approvals/:approvalId {decision:"allow"}`；收到 `approval.resolved{decision:"allow"}` 后显示 `已允许执行`且按钮消失

#### Scenario: 超时与拒绝文案
- **WHEN** 收到 `approval.resolved{decision:"timeout"}` 或 `{decision:"deny"}`
- **THEN** 分别显示 `已允许执行` 与 `已拒绝执行`，倒计时消失

#### Scenario: 同一消息多个审批条
- **WHEN** 页面级 fixture 对同一 assistant 消息收到两个 `approval.request`（`a1`、`a2`），随后对 `a2` 点击 `拒绝`
- **THEN** 两个审批条按 `a1`、`a2` 顺序纵向显示；请求路径为 `a2` 的 approvalId；收到 `approval.resolved{approvalId:a2,decision:"deny"}` 后仅 `a2` 条显示 `已拒绝执行`，`a1` 条仍显示按钮与倒计时
