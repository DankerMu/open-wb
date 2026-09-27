# Spec delta: tool-approval（#473 停止路径对挂起审批的 deny 结算与帧序）

> 「停止与终态对挂起审批的结算」（父 ADDED，与 4.6 #474 分担，主 spec 尚无）只收停止路径：
> - 路径列表只列第 1–3 条（作答、超时已由 #464 交付，停止由本 issue 交付），引导句由「恰为以下六条」改为「包括以下三条」，使其在 #474 补入第 4–6 条前后都成立；第 1–3 条条目、「第 1–3 条的次序」句与「停止：」段均为父文逐字（第 3 条句末标点由「；」改「。」）。
> - 首句「任何回合进入终态时 … 不残留 `decision` NULL 的审批」、第 4–6 条、「第 4–6 条 SHALL …」段（`settlePendingForMessage`）与 Scenario「崩溃与对账不留 pending」「优雅关停结算挂起审批」→ 4.6 #474。
> - Scenario「先 Deny 后 abort」「停止拒绝全部挂起审批」按 issue 验收只收帧序、`approval.resolved` 先于 `turn.end(stopped)` 与 `turn.end(stopped)`：去掉「202；」、`chat_approvals.decision="deny"` 与审计子句。这些行为经 #464 的 `decide` 结算路径交付（其行值与审计由 #464 证明），#474 归档时以父块整段逐字恢复。
> - 「审批作答 REST」「超时自动允许」「审批审计」中与停止有关的片段（「作答与超时、停止、崩溃……共用这同一 CAS」「被停止或其它非作答路径结算的审批取消计时器」「含停止与第 4–6 条非作答路径触发的 deny」）与第 4–6 条写在同一枚举里，无法逐字单独并入，留给 #474 以父文整句推进；「审批事件」括注「见停止与终态对挂起审批的结算」同样随 #474。

## ADDED Requirements

### Requirement: 停止与终态对挂起审批的结算
审批的结算路径 SHALL 包括以下三条，均经同一 `decision IS NULL` CAS、均在结算落库的同一 SQLite 事务内写审计：
1. 用户作答（见审批作答 REST）：`allow`/`deny`，向 omp 发对应帧；
2. 超时（见超时自动允许）：`timeout`，向 omp 发 `Approve`；
3. 停止：`deny`，向 omp 发 `Deny`。

第 1–3 条的次序 SHALL 为：结算落库与审计（同一事务）→ 向 omp 发帧 → 发布 `approval.resolved`。

停止：`POST /api/sessions/:id/stop` 的路由契约（鉴权、归属、202 `{}`/204、停止意图）由 turn-control 定义；本 Requirement 只定义其对挂起审批的结算。对 running 会话，supervisor SHALL 在发送 `abort` 之前，对该会话**全部** pending 审批逐条按上述第 3 条次序结算为 `deny` 并发 `value:"Deny"`；pending 集合 SHALL 以进入 stop 调用时读取的快照为准，写入 `abort` 前不重读——快照之后新到达的审批（如 Deny 后模型的后续调用）留给有界退回或其它非作答路径结算；全部快照项结算完毕后才写入 `abort` 帧。fake-omp probe 记录的入站帧序 SHALL 证明每条 `extension_ui_response(Deny)` 都先于 `abort`。

#### Scenario: 先 Deny 后 abort
- **WHEN** fake-omp `approval-then-abort` 脚本中 select 挂起时调用 stop
- **THEN** probe `frames=` 显示 `extension_ui_response` 先于 `abort`（probe 只记帧类型）；该应答为 `{id:"r1",value:"Deny"}` 由 fake-omp 随之发出的 `tool_execution_end{isError:true}` 证明；`approval.resolved{decision:"deny"}` 先于该回合唯一的 `turn.end(stopped)`

#### Scenario: 停止拒绝全部挂起审批
- **WHEN** `approval-parallel` 中 `r1`、`r2` 均挂起时调用 stop
- **THEN** probe `frames=` 显示两帧 `extension_ui_response` 然后恰一帧 `abort`（probe 只记帧类型）；两帧的 `id`/`value` 分别为 `{id:"r1",value:"Deny"}`、`{id:"r2",value:"Deny"}`，按审批 `id` 升序，由 fake-omp 的 `tool_execution_end` 到达顺序（各 select 应答后立即发出）证明；发布两个 `approval.resolved{decision:"deny"}`，均先于 `turn.end(stopped)`
