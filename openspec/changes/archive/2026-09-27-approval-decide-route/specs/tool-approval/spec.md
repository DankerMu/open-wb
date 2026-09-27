# Spec delta: tool-approval（#468 审批作答 REST 路由）

> 只含本 issue（父 tasks 5.2a）交付的部分。「审批作答 REST」以主 spec（#464 推进后）为底，并入父 delta 的路由、body、媒体类型、鉴权与 parser 归属、200/no-store 与错误码表句，以及 Scenario「允许」「拒绝」「已结算与重复作答」的 HTTP 原文与「形态、鉴权与归属」（逐字）。裁剪与自写：
> - 与父 delta 的分歧（proposal 偏离 2，归档时父块采用本文措辞，或 #476 把检查前移后再恢复父文）：父文「会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404；均在 body 解析前」中，`approvalId` 行归属不在 body 解析前判定——`SessionStore` 在本刀没有审批读取面，行归属由结算端口在 body 解析之后、任何写入与发帧之前判定；未认证 401、会话 404 与非 canonical `approvalId` 404 仍在 body 解析前（正文已写明）。
> - 「作答与超时、停止、崩溃/有界退回、优雅关停、启动对账共用这同一 CAS」保持主 spec 的「作答与超时共用」（停止 → #473，崩溃/有界退回/关停/对账 → #474）；Scenario「作答与进程退出竞争」→ #474，不在本 delta。
> - 自写（proposal 偏离 1，归档时补进父块）：关停后作答 `agent_unavailable` 一句与 Scenario「关停后作答」。
> - 「与快照 `approvals` 数组元素同形」取父文原样；快照投影由 #476 交付，此前为前向引用。

## MODIFIED Requirements

### Requirement: 审批作答 REST
`POST /api/sessions/:id/approvals/:approvalId` SHALL 只接受 `application/json` 且 body 恰为 `{decision:"allow"|"deny"}`，其 content-parser 错误由归属集映射为 400 `bad_request`；其它形态（缺键/多键/其它值）400。受 cookie guard 与 owner 校验：未认证 401；会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`；未认证 401、会话 404 与非 canonical 正十进制整数 `approvalId` 的 404 SHALL 在 body 解析前返回，`approvalId` 不属于该会话的 404 SHALL 先于任何写入与发帧；均无写入。结算 SHALL 以 `decision IS NULL` 为条件的 CAS 执行，作答与超时共用这同一 CAS：`decision` 已非 NULL（已 allow/deny/timeout，同一审批第二次作答，或该消息所属进程已退出/回合已终态而被非作答路径结算为 `deny`）SHALL 409 `approval_settled`，无写入、不向 omp 发帧；并发作答时 CAS 的后到者 SHALL 409。CAS 命中时 SHALL 依序：在同一 SQLite 事务内写入 `decision`/`decided_at=now` 与审计行 → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消该 `approvalId` 的超时计时器 → 发布 `approval.resolved` → 200，body 恰为已结算的审批对象 `{id, tool, title, requestedAt, expiresAt, decision}`（与快照 `approvals` 数组元素同形）。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。session supervisor 关停开始后到达结算端口的作答 SHALL 以 `agent_unavailable`（502）拒绝，无写入、不向 omp 发帧。`core/errors` SHALL 新增 `approval_settled`(409, `该审批已处理`)，响应 no-store。

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

#### Scenario: 关停后作答
- **WHEN** 审批挂起时 session supervisor 已开始关停，随后 owner 对该审批作答 allow
- **THEN** 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}` 且 no-store；该请求不改变该行 `decision`/`decided_at`，不新增审计行，不写出 `extension_ui_response`
