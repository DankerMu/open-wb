## MODIFIED Requirements

### Requirement: 审批作答 REST
`POST /api/sessions/:id/approvals/:approvalId` SHALL 只接受 `application/json` 且 body 恰为 `{decision:"allow"|"deny"}`，其 content-parser 错误由归属集映射为 400 `bad_request`（`Content-Length` 超过全局 body 上限 1 MiB 的请求仅凭请求头即被拒绝：服务端不读取请求体，发出 400 后关闭连接；仍在写请求体的客户端可能观察到连接重置，这不改变服务端已发出的响应）；其它形态（缺键/多键/其它值）400。受 cookie guard 与 owner 校验：未认证 401；会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`；未认证 401、会话 404 与非 canonical 正十进制整数 `approvalId` 的 404 SHALL 在 body 解析前返回，`approvalId` 不属于该会话的 404 SHALL 先于任何写入与发帧；均无写入。结算 SHALL 以 `decision IS NULL` 为条件的 CAS 执行，作答与超时、停止、崩溃/有界退回、优雅关停、启动对账共用这同一 CAS：`decision` 已非 NULL（已 allow/deny/timeout，同一审批第二次作答，或该消息所属进程已退出/回合已终态而被非作答路径结算为 `deny`）SHALL 409 `approval_settled`，无写入、不向 omp 发帧；并发作答时 CAS 的后到者 SHALL 409。CAS 命中时 SHALL 依序：在同一 SQLite 事务内写入 `decision`/`decided_at=now` 与审计行 → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消该 `approvalId` 的超时计时器 → 发布 `approval.resolved` → 200，body 恰为已结算的审批对象 `{id, tool, title, requestedAt, expiresAt, decision}`（与快照 `approvals` 数组元素同形）。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。session supervisor 关停开始后到达结算端口的作答 SHALL 以 `agent_unavailable`（502）拒绝，无写入、不向 omp 发帧。`core/errors` SHALL 新增 `approval_settled`(409, `该审批已处理`)，响应 no-store。

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
