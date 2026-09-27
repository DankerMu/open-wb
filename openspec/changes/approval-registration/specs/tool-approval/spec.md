# Spec delta: tool-approval（#464 审批登记、按 approvalId 独立计时与 CAS 作答结算）

> 只含本 issue（父 tasks 4.3）交付的部分。被裁掉的段落与 Scenario 保留父标题，由后续刀原位补回：
> - 「chat_approvals 持久化」：以主 spec 为底，并入父 delta 的登记与 CAS 句、Scenario「落库形状」「同一消息多行审批」（逐字）；Scenario「级联删除」保持主 spec 措辞（父文的 regenerate 删旧助手行 → #465）。
> - 「审批事件」（父 ADDED，多刀分担）：去掉括注里对「停止与终态对挂起审批的结算」的引用（该 Requirement → #473/#474），去掉「web `stream.ts` 联合类型 SHALL 同步」（→ #476）；Scenario「两条并行审批分别作答」去掉快照子句（→ #476）。
> - 「审批作答 REST」（父 ADDED）：只收结算部分。路由、body、媒体类型、鉴权与 parser 归属、200/no-store、错误码表句 → #468；「作答与超时、停止、崩溃……共用」一句裁为作答与超时（停止 → #473，崩溃/有界退回/关停/对账 → #474）；Scenario「作答与进程退出竞争」→ #474，「形态、鉴权与归属」→ #468，未收录；「允许」「拒绝」「已结算与重复作答」去掉 HTTP 状态与信封，改述为结算结果。
> - 「超时自动允许」：「被停止或其它非作答路径结算的审批」取消计时器一句 → #473/#474。
> - 「审批审计」：「含停止与第 4–6 条非作答路径触发的 deny」→ #473/#474。
> - 「审批请求识别」MODIFIED（argv `write` 句）→ #481；「停止与终态对挂起审批的结算」→ #473/#474；「审批快照」→ #476；「web 审批条」→ #480。均不在本 delta。

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
- **WHEN** 删除含审批记录的助手消息，或删除其所属会话
- **THEN** 对应 `chat_approvals` 行不存在，无孤儿行

#### Scenario: 重复请求与决定值域
- **WHEN** 对同一 `(message_id, request_id)` 插入第二行，或写入 allow/deny/timeout 以外的 `decision`
- **THEN** SQLite 拒绝该写入，既有行不变

## ADDED Requirements

### Requirement: 审批事件
supervisor SHALL 在审批行持久化之后、经既有 generation ring 发布 `approval.request{messageId, approvalId, tool, title, expiresAt}`（消费一个 seq；omp 在 `tool_execution_start` 之后、工具执行之前下发审批 select，故该事件位于对应 `step.start` 之后、该步骤 `step.end` 之前）；每条审批结算后（该会话存在可发布的 generation ring 时）SHALL 发布恰一个 `approval.resolved{messageId, approvalId, decision}`，`decision ∈ {allow,deny,timeout}`。同一回合可有多条审批同时挂起（omp 并行执行多个工具时各自下发 select），其 `approval.request`/`approval.resolved` 可与其它步骤的 `step.*`、`text.delta` 事件交错；每条审批事件 SHALL 只作用于自身 `approvalId`，后到的 `approval.request` SHALL 不覆盖先前审批。两类事件 SHALL 进入 ring 回放、SSE 扇出与 `Last-Event-ID` 语义与其它事件一致。

#### Scenario: 事件序与回放
- **WHEN** fake-omp `approval` 脚本（`--approval-mode write`）的审批请求于注入时钟 T 到达后用户 allow，回合继续到 `agent_end`
- **THEN** 该回合 SSE 事件满足以下次序约束（不断言完整固定序列）：`turn.start` 为首个事件；`step.start(bash)` 先于 `approval.request{…,expiresAt:T+60000}`；`approval.request` 先于 `approval.resolved{decision:"allow"}`；`approval.resolved` 先于该步骤的 `step.end(done)`；以上全部先于恰一个 `turn.end(done)`，且它是该回合末个事件；`text.delta` 可出现在 `step.start` 之前与 `step.end` 之后（fake 在工具轮之前发出正文增量）；事件 id 严格单调；以 `approval.request` 的 id 作 `Last-Event-ID` 重连恰从 `approval.resolved` 起回放

#### Scenario: 两条并行审批分别作答
- **WHEN** fake-omp `approval-parallel` 脚本在同一回合对两个 bash 调用先后发 `extension_ui_request` `r1` 与 `r2`（均未应答），用户先对 `r2` 作答 deny、再对 `r1` 作答 allow
- **THEN** 两个 `approval.request` 的 `approvalId` 不同且都保留；fake-omp 先收到 `extension_ui_response{id:"r2",value:"Deny"}`、后收到 `{id:"r1",value:"Approve"}`，每个 id 恰一帧；发布两个 `approval.resolved`，分别携带各自 `approvalId` 与 `deny`/`allow`；`r2` 对应步骤 `failed`、`r1` 对应步骤 `done`

### Requirement: 审批作答 REST
`approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`，无写入。结算 SHALL 以 `decision IS NULL` 为条件的 CAS 执行，作答与超时共用这同一 CAS：`decision` 已非 NULL（已 allow/deny/timeout，同一审批第二次作答，或该消息所属进程已退出/回合已终态而被非作答路径结算为 `deny`）SHALL 以 `approval_settled`（409）拒绝，无写入、不向 omp 发帧；并发作答时 CAS 的后到者 SHALL 以 `approval_settled` 拒绝。CAS 命中时 SHALL 依序：在同一 SQLite 事务内写入 `decision`/`decided_at=now` 与审计行 → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消该 `approvalId` 的超时计时器 → 发布 `approval.resolved` → 返回已结算的审批对象 `{id, tool, title, requestedAt, expiresAt, decision}`。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。

#### Scenario: 允许
- **WHEN** pending 审批收到 `{decision:"allow"}`
- **THEN** 结算结果为 `{id,tool:"bash",title,requestedAt,expiresAt,decision:"allow"}`；fake-omp 收到 `extension_ui_response{id:"r1",value:"Approve"}`；发布 `approval.resolved{decision:"allow"}`；随后 bash 步骤 `done`，回合 `done`

#### Scenario: 拒绝
- **WHEN** pending 审批收到 `{decision:"deny"}`
- **THEN** 结算结果 `decision:"deny"`；fake-omp 收到 `value:"Deny"` 并发 `tool_execution_end{isError:true}`；该步骤 `failed`、assistant 与会话最终 `done`（非 `failed`）

#### Scenario: 已结算与重复作答
- **WHEN** 对已 allow、已 deny、已 timeout 的审批再次作答，或对同一 pending 审批并发两次作答
- **THEN** 后到者以 `approval_settled`（409，`该审批已处理`）拒绝；`chat_approvals` 该行 `decision` 与首次一致；omp 只收到一帧应答

### Requirement: 超时自动允许
每条 pending 审批 SHALL 由 supervisor 以注入时钟、按 `approvalId` 各自启动独立的 60000ms 计时器（自该审批 `requested_at` 起）；到期时该审批若仍 pending SHALL 经同一 CAS 结算为 `decision="timeout"`、`decided_at=expires_at`（与审计同一事务），向 omp 发该审批 `request_id` 的 `value:"Approve"`，发布 `approval.resolved{decision:"timeout"}`。59999ms 时 SHALL 无任何结算。某条审批到期 SHALL 不影响同回合其它审批的计时器与状态。已由用户作答的审批 SHALL 取消其计时器，到期不再动作。每条审批登记时 supervisor SHALL 调用 runtime `markPending(approvalId)`、结算时调用 `clearPending(approvalId)`；只要该进程仍有任一 pending 审批，runtime 空闲计时器 SHALL 暂停，最后一条 pending 审批结算后 SHALL 从该结算时刻起以完整空闲期限重置；挂起审批的进程在 omp-pool 中视为"在回合中"，不可被驱逐。

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
每次审批结算（allow/deny/timeout）SHALL 经 `core/audit` 既有 `emit` 写恰一条 `audit_events`，且与该结算的 `decision` 落库处于同一 SQLite 事务（结算回滚则审计不存在，审计失败则结算不生效）：`kind="session.approval"`、`actorId`=会话 `owner_id`、`title="工具执行审批"`、`detail={sessionId, messageId, tool, decision}`；pending 不写审计；CAS 未命中（已结算）不写审计；`GET /api/audit` SHALL 以既有形状返回该事件。

#### Scenario: 三种决定各一条
- **WHEN** 三条审批分别以 allow、deny、timeout 结算
- **THEN** `GET /api/audit?limit=3` 的 `events[*].kind` 均为 `session.approval`，`detail.decision` 分别为 `allow`/`deny`/`timeout`，`detail.tool`/`sessionId`/`messageId` 与请求一致；审批 pending 期间 audit 行数不变
