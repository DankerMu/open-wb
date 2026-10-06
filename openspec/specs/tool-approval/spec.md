# tool-approval Specification

## Purpose
定义 exec 档工具调用的用户审批链路：审批请求识别、`chat_approvals` 持久化、`approval.request`/`approval.resolved` 事件、作答 REST、60s 超时自动允许、与停止的次序、非作答路径的终态结算、审计留痕、快照恢复与 web 审批条。同一回合可同时存在多条挂起审批，每条按 `approvalId` 独立作答、计时与结算。
## Requirements
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

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 修订后的 spawn 契约以 `--approval-mode write` 启动。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]`（顺序与内容精确）且 `title` 以 `Allow tool: ` 开头 → 视为审批请求向上抛出而不自动应答；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 不同的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。

#### Scenario: 识别为审批
- **WHEN** fake-omp `approval` 脚本在 `message_end(toolUse)` 之后、bash 的 `tool_execution_start` 之前（与真 omp v18.0.10 实测一致）发 `extension_ui_request{id:"r1",method:"select",title:"Allow tool: bash\nCommand: echo workbuddy-smoke",options:["Approve","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="bash"`，`title` 为原文

#### Scenario: 非审批 UI 请求仍回绝
- **WHEN** 子进程发 `extension_ui_request{method:"confirm"}`、`{method:"input"}`、`{method:"select",options:["A","B"]}` 或 `{method:"select",title:"Pick one",options:["Approve","Deny"]}`
- **THEN** 每个都立即收到对应 id 的 `cancelled:true`，不向 owner 上抛审批请求

#### Scenario: 工具名解析失败
- **WHEN** 审批 `title` 为 `Allow tool: ` 后紧跟换行
- **THEN** 仍作为审批请求上抛给 owner，`tool="unknown"`，不被自动回绝

### Requirement: 审批事件
supervisor SHALL 在审批行持久化之后、经既有 generation ring 发布 `approval.request{messageId, approvalId, tool, title, expiresAt}`（消费一个 seq；真 omp v18.0.10 在该工具的 `tool_execution_start` 之前下发审批 select，start 不等作答，工具在作答后才执行，故该事件位于对应 `step.start` 之前、该步骤 `step.end` 之前；并行时各 select 均先于各 start）；每条审批结算后（该审批登记时所属的 generation 的 ring 尚未封口时，见停止与终态对挂起审批的结算；但该 Requirement 第 7 条「基础设施故障 retire」的结算除外，它 SHALL 不发布）SHALL 发布恰一个 `approval.resolved{messageId, approvalId, decision}`，`decision ∈ {allow,deny,timeout}`。同一回合可有多条审批同时挂起（omp 并行执行多个工具时各自下发 select），其 `approval.request`/`approval.resolved` 可与其它步骤的 `step.*`、`text.delta` 事件交错；每条审批事件 SHALL 只作用于自身 `approvalId`，后到的 `approval.request` SHALL 不覆盖先前审批。两类事件 SHALL 进入 ring 回放、SSE 扇出与 `Last-Event-ID` 语义与其它事件一致。

#### Scenario: 事件序与回放
- **WHEN** fake-omp `approval` 脚本（`--approval-mode write`）的审批请求于注入时钟 T 到达后用户 allow，回合继续到 `agent_end`
- **THEN** 该回合 SSE 事件满足以下次序约束（不断言完整固定序列）：`turn.start` 为首个事件；`approval.request{…,expiresAt:T+60000}` 先于 `step.start(bash)`；`approval.request` 先于 `approval.resolved{decision:"allow"}`；`approval.resolved` 先于该步骤的 `step.end(done)`；以上全部先于恰一个 `turn.end(done)`，且它是该回合末个事件；`text.delta` 可出现在 `step.start` 之前与 `step.end` 之后（fake 在工具轮之前发出正文增量）；事件 id 严格单调；用户在 `step.start(bash)` 送达之后才作答时，`approval.request`、`step.start(bash)`、`approval.resolved` 的事件 id 连续；以 `approval.request` 的 id 作 `Last-Event-ID` 重连，回放首个事件为 `step.start(bash)`；以该 `step.start` 的 id 重连，回放首个事件为 `approval.resolved`

#### Scenario: 两条并行审批分别作答
- **WHEN** fake-omp `approval-parallel` 脚本在同一回合对两个 bash 调用先后发 `extension_ui_request` `r1` 与 `r2`（均未应答），用户先对 `r2` 作答 deny、再对 `r1` 作答 allow
- **THEN** 两个 `approval.request` 的 `approvalId` 不同且都保留；fake-omp 先收到 `extension_ui_response{id:"r2",value:"Deny"}`、后收到 `{id:"r1",value:"Approve"}`，每个 id 恰一帧；发布两个 `approval.resolved`，分别携带各自 `approvalId` 与 `deny`/`allow`；`r2` 对应步骤 `failed`、`r1` 对应步骤 `done`

### Requirement: 审批作答 REST
`POST /api/sessions/:id/approvals/:approvalId` SHALL 只接受 `application/json` 且 body 恰为 `{decision:"allow"|"deny"}`，其 content-parser 错误由归属集映射为 400 `bad_request`；其它形态（缺键/多键/其它值）400。受 cookie guard 与 owner 校验：未认证 401；会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`；未认证 401、会话 404 与非 canonical 正十进制整数 `approvalId` 的 404 SHALL 在 body 解析前返回，`approvalId` 不属于该会话的 404 SHALL 先于任何写入与发帧；均无写入。结算 SHALL 以 `decision IS NULL` 为条件的 CAS 执行，作答与超时、停止、崩溃/有界退回、优雅关停、启动对账共用这同一 CAS：`decision` 已非 NULL（已 allow/deny/timeout，同一审批第二次作答，或该消息所属进程已退出/回合已终态而被非作答路径结算为 `deny`）SHALL 409 `approval_settled`，无写入、不向 omp 发帧；并发作答时 CAS 的后到者 SHALL 409。CAS 命中时 SHALL 依序：在同一 SQLite 事务内写入 `decision`/`decided_at=now` 与审计行 → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消该 `approvalId` 的超时计时器 → 发布 `approval.resolved` → 200，body 恰为已结算的审批对象 `{id, tool, title, requestedAt, expiresAt, decision}`（与快照 `approvals` 数组元素同形）。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。session supervisor 关停开始后到达结算端口的作答 SHALL 以 `agent_unavailable`（502）拒绝，无写入、不向 omp 发帧。`core/errors` SHALL 新增 `approval_settled`(409, `该审批已处理`)，响应 no-store。

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

#### Scenario: 关停后作答
- **WHEN** 审批挂起时 session supervisor 已开始关停，随后 owner 对该审批作答 allow
- **THEN** 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}` 且 no-store；该请求不改变该行 `decision`/`decided_at`，不新增审计行，不写出 `extension_ui_response`

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

### Requirement: 审批审计
每次审批结算（allow/deny/timeout，含停止与第 4–6 条非作答路径触发的 deny）SHALL 经 `core/audit` 既有 `emit` 写恰一条 `audit_events`，且与该结算的 `decision` 落库处于同一 SQLite 事务（结算回滚则审计不存在，审计失败则结算不生效）：`kind="session.approval"`、`actorId`=会话 `owner_id`、`title="工具执行审批"`、`detail={sessionId, messageId, tool, decision}`；pending 不写审计；CAS 未命中（已结算）不写审计；`GET /api/audit` SHALL 以既有形状返回该事件。

#### Scenario: 三种决定各一条
- **WHEN** 三条审批分别以 allow、deny、timeout 结算
- **THEN** `GET /api/audit?limit=3` 的 `events[*].kind` 均为 `session.approval`，`detail.decision` 分别为 `allow`/`deny`/`timeout`，`detail.tool`/`sessionId`/`messageId` 与请求一致；审批 pending 期间 audit 行数不变

### Requirement: 停止与终态对挂起审批的结算
任何回合进入终态时，其 assistant 消息上 SHALL 不残留 `decision` NULL 的审批。审批的全部结算路径 SHALL 恰为以下七条，均经同一 `decision IS NULL` CAS、均在结算落库的同一 SQLite 事务内写审计：
1. 用户作答（见审批作答 REST）：`allow`/`deny`，向 omp 发对应帧；
2. 超时（见超时自动允许）：`timeout`，向 omp 发 `Approve`；
3. 停止：`deny`，向 omp 发 `Deny`；
4. 进程崩溃或有界退回 retire：`deny`；
5. 服务优雅关停（supervisor `close()`）：`deny`；
6. 启动对账（running→failed）：`deny`；
7. 基础设施故障 retire（持久化、flush、事件 sink 或审批事务失败使该 slot 进入 infraFaulted 后退役）：`deny`。

第 7 条 SHALL 在 supervisor 退役该 slot 的同步段内（撤销（revoke）其 generation 之后、等待进程关停之前），对该 slot 全部仍登记的审批先撤销计时器与登记，再逐条经 store `settleApproval` 以 `deny` 做 CAS 结算并审计；该回合的终态不在此翻转（由优雅关停时 store `close()` 或启动对账翻转）；已被其它路径先结算的行 SHALL 保持不变；结算事务失败 SHALL 不阻断退役，错误交给 supervisor 的故障保留，且计时器已撤销，不会事后写入 `timeout`。超时结算事务失败（非 `not_found`）的那条审批 SHALL 保留登记再进入故障保留，使它在随之发生的退役中与其它登记一并按第 7 条结算为 `deny`（不因超时事务失败而漏过）。已知残留：第 7 条的 `deny` 事务自身失败的行，以及登记半途失败（行已插入而登记未建立）的行，保持 `decision IS NULL` 直到优雅关停或启动对账；在此之前 owner 的作答仍可命中 CAS 并写入审计（作答 REST 契约不变）。已由第 7 条成功结算为 `deny` 的审批，此后的作答 SHALL 以 409 `approval_settled` 拒绝。第 4–7 条 SHALL 不向 omp 发任何帧（进程已退出或正在退出），SHALL 照常写审计；第 7 条 SHALL 不发布 `approval.resolved`（该 generation 已被撤销，其事件 sink 可能正是故障源，已订阅的客户端在重新读取快照后看到 `deny`）；第 4–6 条仅当该会话仍有可发布的 generation ring 时发布 `approval.resolved{decision:"deny"}`（启动对账时无 ring 可发布则只落库与审计；优雅关停时 ring 仍在则照常发布）。第 4–6 条的结算 SHALL 由 store 层（`store-approvals.ts` 的 `settlePendingForMessage(messageId, decision)`）执行，与该回合的终态翻转（running→failed 或 running→stopped）处于同一事务，审计经 store 注入的 `audit.emit` 在同一事务内写入；`reconcileOnStartup` 与 `close()` SHALL 都调用它。第 1–3 条的次序 SHALL 为：结算落库与审计（同一事务）→ 向 omp 发帧 → 发布 `approval.resolved`。

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

#### Scenario: 基础设施故障退役不留自动允许
- **WHEN** fake-omp `approval` 脚本的审批挂起时，该回合的持久化（`#commit`）失败或事件 sink 违约使 slot 以 infraFaulted 退役，随后注入时钟推进超过 60000ms；另在 `approval-parallel` 两条审批挂起时只让 `r1` 的超时事务失败并推进时钟至 `r1` 到期
- **THEN** 挂起审批（并行时为 `r1` 与 `r2` 两条：超时事务失败的 `r1` 保留登记，随退役一并结算）`decision="deny"`、`decided_at` 非空，审计为每条审批恰一条 `session.approval decision=deny`，没有任何 `decision=timeout` 的审批或审计；退役后与推进时钟后均未发布 `approval.resolved`；fake-omp 未收到 `extension_ui_response`；单审批时在推进时钟之前、并行时在退役之后再次推进时钟之前，owner 对已结算为 `deny` 的该审批（并行时含 `r1`，作答 `allow`）作答返回 409 `approval_settled` 且不写入

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
web SHALL 把审批分两处呈现：待决审批是 composer 上方停靠区里的提问卡，已结算审批是其所属 assistant 消息内的记录。web 只使用快照与事件归约出的 `approvals`（`tool` 字段即工具名，web 不再解析 `title`）；assistant-ui 工具调用 part 的 `approval` 字段与 `onRespondToToolApproval` SHALL NOT 使用（审批与步骤之间没有关联键，且工具调用组默认收起）。

**提问卡**：选中会话全部消息中 `decision:null` 的审批 SHALL 各渲染一张提问卡，跨消息按审批 `id` 升序纵向叠放在 composer 正上方的停靠区内（停靠区不随消息线程滚动；同一停靠区内任务清单面板在其上方，见 session-todo）；助手消息内 SHALL NOT 渲染待决审批。每张卡是独立的 `role="group"`，accessible name 为 `需要你的确认`，内容为：工具名徽章（`tool` 字段）；`title` **全文**，以 `white-space: pre-wrap` 保留换行，这段正文有自己的最大高度、超出时在卡内滚动（使按钮不被长 `title` 挤出，停靠区整体的限高见 chat-web `输入框上方停靠区`）；正文超出这个高度时，卡内 SHALL 在正文与倒计时句之间显示一行可见提示 `内容较长，请滚动查看全部`，并使正文的滚动容器可由键盘聚焦（`tabindex="0"`），未超出时两者都没有——被限高裁掉的内容不得没有任何迹象；由 `expiresAt` 与注入时钟计算的单句倒计时 `（<n>s 内未操作将自动允许）`，`<n>` SHALL 为 `max(0, ceil((expiresAt - now) / 1000))`（`now` 为注入时钟的毫秒时间），至少每秒重算一次（初值 60，`expiresAt` 已过时为 0），卡内无其它倒计时元素；按钮 `允许` / `拒绝`。点击按钮 SHALL 以该卡自己的审批 `id` 调用一次 `decideApproval(sessionId, approvalId, "allow"|"deny")`，该卡的两个按钮立即禁用，其它卡不受影响。409 `approval_settled` SHALL NOT 显示任何错误（无 Toast、composer 无内联错误、卡内无 alert）：页面主动对账权威历史（与现状一致），以对账得到的快照或随后到达的 `approval.resolved` 为准。其它失败（400/404/502/503、网络异常或非法响应）SHALL 在该提问卡内以 `role="alert"` 渲染 `ApiError` 的 message（400/404/502/503 为信封文案；网络异常与非法响应为既有 request_failed 的安全文案），该卡的两个按钮恢复可用，该 alert 在这张卡下一次点击按钮时清除；不显示 Toast，其它卡不受影响。停靠区里的提问卡集合在已有卡显示期间发生变化（有卡消失或新卡加入），或其上方的任务清单面板在已有卡显示期间出现、消失、收起 / 展开或展开时清单内容改变后的 400 毫秒内，所有提问卡 SHALL 忽略对 `允许` / `拒绝` 的点击（不发请求、不禁用按钮）：卡的位置刚刚移动（停靠区到达高度上限并在内部滚动时，面板高度变化同样会推移卡），这段时间内的点击可能原本是点向另一张卡的；停靠区从空到出现第一张卡不计入。提问卡的标题与内容 SHALL NOT 乐观改变：在 `approval.resolved` 或权威快照显示已结算之前，它始终是 `需要你的确认`。`approval.resolved` 到达或快照显示该审批已结算后，对应提问卡 SHALL 消失。

**已结算记录**：`decision` 非 null 的审批 SHALL 在其所属 assistant 消息内各渲染一条记录（位置见 chat-web `消息线程` 的助手块次序），同一消息的多条按 `id` 升序排列。每条是 `role="group"`，accessible name 按 `decision`：`allow` → `已允许执行`，`deny` → `已拒绝执行`，`timeout` → `超时自动允许`；显示工具名徽章与 `title` 全文（`white-space: pre-wrap`），无按钮、无倒计时。`approvals` 为 `[]` 的消息不渲染记录。

只要选中会话存在待决审批，回合即仍在进行：composer SHALL 保持锁定且 `停止` 可用。重新加载后，快照中的待决审批 SHALL 恢复为提问卡（倒计时从 `expiresAt` 起算，可继续作答），已结算审批恢复为消息内记录。

`title` 正文限高的证据按 seam 分工：多张提问卡与超长 `title` 由整页挂载测试断言结构（下方 `长 title 与多张提问卡的结构`，不作视口或像素断言）；真实浏览器里的布局只对 ui-walk 栈能产生的那一张待决提问卡（首回合 bash 审批）断言：其 `允许` / `拒绝` 与输入框、`停止` 都在视口内（chat-harness `UI 走查对话步骤`）。

#### Scenario: 提问卡挂起、允许与拒绝
- **WHEN** running 助手消息收到 `approval.request{approvalId, tool:"bash", title:"Allow tool: bash\nReason: run ls", expiresAt: now+60s}`
- **THEN** composer 上方停靠区出现一张名为 `需要你的确认` 的提问卡：工具名徽章为 `bash`，正文为 title 全文（两行均在，换行按 `white-space: pre-wrap` 保留），倒计时句为 `（60s 内未操作将自动允许）` 且随注入时钟推进 1s 后变为 `（59s 内未操作将自动允许）`，卡内无其它倒计时元素，按钮 `允许`/`拒绝` 可用；该助手消息内没有名为 `需要你的确认` 的元素；composer 仍锁定且 `停止` 可用
- **WHEN** 点击 `允许`，服务端 200，随后收到 `approval.resolved{decision:"allow"}`
- **THEN** `decideApproval(sessionId, approvalId, "allow")` 恰调用一次，该卡两按钮立即禁用；resolved 到达后停靠区不再有该提问卡，所属助手消息内出现名为 `已允许执行` 的记录，含工具名徽章 `bash` 与 title 全文，无按钮无倒计时句
- **WHEN** 另一条挂起审批点击 `拒绝` 并收到 `approval.resolved{decision:"deny"}`
- **THEN** 提问卡消失，所属助手消息内出现名为 `已拒绝执行` 的记录
- **WHEN** 点击 `允许` 时服务端返回 409 `approval_settled`，随后权威快照中该审批 `decision:"timeout"`
- **THEN** 页面发起一次历史对账；无 Toast、composer 无内联错误、页面无新增 `role="alert"`；提问卡消失，所属助手消息内出现名为 `超时自动允许` 的记录

#### Scenario: 作答失败在卡内提示并可重试
- **WHEN** 待决提问卡点击 `允许`，服务端返回 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}`；随后再次点击 `允许`，服务端 200 并送达 `approval.resolved{decision:"allow"}`；另一例点击 `拒绝` 时请求因网络异常失败
- **THEN** 502 之后该卡内出现 `role="alert"`，文本为 `Agent 运行时不可用`，卡的可访问名仍为 `需要你的确认`，`允许` / `拒绝` 两个按钮恢复可用，页面无 Toast、composer 无内联错误；第二次点击时该 alert 即被清除，`decideApproval` 累计恰调用两次，resolved 到达后提问卡消失、所属助手消息内出现 `已允许执行` 记录；网络异常的一例卡内 alert 为 request_failed 的安全文案，按钮同样恢复可用

#### Scenario: 超时与拒绝的记录文案
- **WHEN** 待决审批收到 `approval.resolved{decision:"timeout"}`；另一条收到 `{decision:"deny"}`
- **THEN** 两张提问卡消失；所属助手消息内分别出现名为 `超时自动允许` 与 `已拒绝执行` 的记录，均无按钮与倒计时句

#### Scenario: 两条并行审批分别作答
- **WHEN** running 助手消息先后收到 `approval.request{approvalId:7, tool:"bash"}` 与 `approval.request{approvalId:8, tool:"bash"}`（均 pending），用户先点 id 8 提问卡的 `拒绝`、再点 id 7 提问卡的 `允许`，服务端各返回 200，随后依次收到 `approval.resolved{approvalId:8, decision:"deny"}` 与 `approval.resolved{approvalId:7, decision:"allow"}`
- **THEN** 停靠区按文档顺序纵向叠放两张名为 `需要你的确认` 的提问卡（第一张为 id 7、第二张为 id 8），第二个 request 未替换第一张；点 id 8 的 `拒绝` 只以 `decideApproval(sessionId, 8, "deny")` 调用一次并只禁用 id 8 的两按钮，id 7 的按钮仍可用、倒计时句仍在；id 8 resolved 后停靠区只剩 id 7 的提问卡，助手消息内出现一条 `已拒绝执行` 记录，composer 仍锁定；id 7 作答并 resolved 后停靠区没有提问卡，助手消息内按 id 升序为 `已允许执行`、`已拒绝执行` 两条记录，均无按钮

#### Scenario: 长 title 与多张提问卡的结构
- **WHEN** 整页挂载（假 API 与假 EventSource）的 running 助手消息有三条待决审批，`id` 为 7、8、9，其中 id 7 的 `title` 为 50 行
- **THEN** 三张提问卡按 id 升序渲染在同一个停靠区容器内，该容器在所有消息 `article` 与消息线程的滚动容器之外、按文档顺序位于输入框之前；每张卡的 `title` 正文是独立的元素（经实现暴露的稳定钩子如 `data-slot` 属性定位），带有限高与内部滚动的样式声明，id 7 的正文含全部 50 行；每张卡的 `允许` / `拒绝` 按钮与倒计时句都不在该卡 `title` 正文的滚动容器之内。正文的内容高度超过其可见高度的卡（测试里按元素的 `scrollHeight` 大于 `clientHeight` 给出）显示 `内容较长，请滚动查看全部` 且正文带 `tabindex="0"`，其余卡两者都没有。本场景不对视口或像素尺寸作断言

#### Scenario: 卡位移后的短暂防误点
- **WHEN** 停靠区里有 id 7、8 两张待决提问卡，点击 id 8 的 `允许` 后 `approval.resolved` 使它消失，随即（400 毫秒内）点击 id 7 的 `允许`；之后过了 400 毫秒再点一次
- **THEN** 400 毫秒内的那次点击不发出任何请求，id 7 的按钮保持可用；之后的点击恰以 id 7 调用一次 `decideApproval`。只有一张卡、停靠区从空到出现它时，立即点击照常作答

#### Scenario: 任务清单面板变化后的短暂防误点
- **WHEN** 停靠区里有一张待决提问卡，其上方的任务清单面板依次出现、在展开时清单内容改变、被收起、被重新展开、消失，每次变化后随即（400 毫秒内）点击该卡的 `允许`；最后一次变化过了 400 毫秒再点一次
- **THEN** 每次变化后 400 毫秒内的点击都不发出任何请求，按钮保持可用；之后的点击恰调用一次 `decideApproval`。面板收起时清单内容改变不设防；面板已经显示、提问卡在其下方从无到有出现时，立即点击照常作答

#### Scenario: 待决审批跨消息按 id 叠放
- **WHEN** 选中会话的快照里两条不同的助手消息各有一条 `decision:null` 的审批，`id` 分别为 12 与 9
- **THEN** 停靠区恰有两张提问卡，按文档顺序先为 id 9、后为 id 12；两条助手消息内都没有待决审批的元素

#### Scenario: 刷新后审批状态保留
- **WHEN** 以 `/?session=<id>` 重新加载：快照中一条助手消息 `approvals` 含一条 pending 且 `expiresAt` 距今 40s，另一次加载中快照的 pending 审批 `expiresAt` 已过去 3s，再一次加载中一条助手消息的审批 `decision` 为 `timeout`、另一条助手消息的为 `deny`、还有一条为 `allow`
- **THEN** pending 加载后停靠区有名为 `需要你的确认` 的提问卡，倒计时句为 `（40s 内未操作将自动允许）`，按钮可点并能作答，composer 锁定且 `停止` 可用；`expiresAt` 已过的那次提问卡的倒计时句为 `（0s 内未操作将自动允许）`（不出现负数），按钮仍可点；`timeout`、`deny`、`allow` 分别在各自助手消息内渲染为名为 `超时自动允许`、`已拒绝执行`、`已允许执行` 的记录，均无按钮与倒计时句，停靠区没有它们的提问卡；`approvals` 为 `[]` 的助手消息不渲染记录

