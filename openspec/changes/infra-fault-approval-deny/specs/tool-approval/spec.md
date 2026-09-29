## MODIFIED Requirements

### Requirement: 停止与终态对挂起审批的结算
任何回合进入终态时，其 assistant 消息上 SHALL 不残留 `decision` NULL 的审批。审批的全部结算路径 SHALL 恰为以下七条，均经同一 `decision IS NULL` CAS、均在结算落库的同一 SQLite 事务内写审计：
1. 用户作答（见审批作答 REST）：`allow`/`deny`，向 omp 发对应帧；
2. 超时（见超时自动允许）：`timeout`，向 omp 发 `Approve`；
3. 停止：`deny`，向 omp 发 `Deny`；
4. 进程崩溃或有界退回 retire：`deny`；
5. 服务优雅关停（supervisor `close()`）：`deny`；
6. 启动对账（running→failed）：`deny`；
7. 基础设施故障 retire（持久化、flush、事件 sink 或审批事务失败使该 slot 进入 infraFaulted 后退役）：`deny`。

第 7 条 SHALL 在 supervisor 退役该 slot 的同步段内（封口其 generation 之后、等待进程关停之前），对该 slot 全部仍登记的审批先撤销计时器与登记，再逐条经 store `settleApproval` 以 `deny` 做 CAS 结算并审计；该回合的终态不在此翻转（由优雅关停时 store `close()` 或启动对账翻转）；已被其它路径先结算的行 SHALL 保持不变；结算事务失败 SHALL 不阻断退役，错误交给 supervisor 的故障保留，且计时器已撤销，不会事后写入 `timeout`。已由第 7 条成功结算为 `deny` 的审批，此后的作答 SHALL 以 409 `approval_settled` 拒绝。第 4–7 条 SHALL 不向 omp 发任何帧（进程已退出或正在退出），SHALL 照常写审计；第 7 条 SHALL 不发布 `approval.resolved`（该 generation 已被撤销，其事件 sink 可能正是故障源，已订阅的客户端在重新读取快照后看到 `deny`）；第 4–6 条仅当该会话仍有可发布的 generation ring 时发布 `approval.resolved{decision:"deny"}`（启动对账时无 ring 可发布则只落库与审计；优雅关停时 ring 仍在则照常发布）。第 4–6 条的结算 SHALL 由 store 层（`store-approvals.ts` 的 `settlePendingForMessage(messageId, decision)`）执行，与该回合的终态翻转（running→failed 或 running→stopped）处于同一事务，审计经 store 注入的 `audit.emit` 在同一事务内写入；`reconcileOnStartup` 与 `close()` SHALL 都调用它。第 1–3 条的次序 SHALL 为：结算落库与审计（同一事务）→ 向 omp 发帧 → 发布 `approval.resolved`。

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
- **WHEN** fake-omp `approval` 脚本的审批挂起时，该回合的持久化（`#commit`）失败或事件 sink 违约使 slot 以 infraFaulted 退役，随后注入时钟推进超过 60000ms；另在 `approval-parallel` 两条审批挂起时只让 `r1` 的超时事务失败
- **THEN** 挂起审批（并行时为 `r2`）`decision="deny"`、`decided_at` 非空，审计恰一条 `session.approval decision=deny`，没有任何 `decision=timeout` 的审批或审计；fake-omp 未收到 `extension_ui_response`；在推进时钟之前，owner 对已结算为 `deny` 的该审批作答返回 409 `approval_settled` 且不写入
