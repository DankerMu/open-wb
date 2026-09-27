# Spec delta: chat-sessions（#464 审批审计 emit 注入与 approvals.ts 模块划分）

> 只含本 issue（父 tasks 4.3）交付的部分：
> - 「Session module registration and teardown」：以主 spec 为底，只并入父 delta 的「pass the store the `core/audit` emit bound to that same DB (the workspace-store precedent) for approval-settlement audit rows」一段。父 delta 中对账结算 pending 审批的括注与两条 Scenario 的审批子句 → #474；两条 Scenario 保持主 spec 原文。
> - 「会话 supervisor 源码模块划分」（#487 自写、主 spec 已有，父 delta 无此块）：按父 tasks 4.0b/4.3 交接注记补入 `approvals.ts` 的职责与依赖方向。归档时父 delta 无需对账（父 delta 不含此 Requirement）。

## MODIFIED Requirements

### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens and runtime options, pass the store the `core/audit` emit bound to that same DB (the workspace-store precedent) for approval-settlement audit rows, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly.
#### Scenario: Reconcile before route acceptance
- WHEN the module is registered on a real app with stale running rows
- THEN all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged and a new prompt can be accepted
#### Scenario: Shutdown ordering and isolation
- WHEN app.close runs with active sessions or a task/storage failure
- THEN new supervisor prompts are rejected, all children/tokens and pumps settle before store close, failures are propagated honestly and the caller DB remains usable

### Requirement: 会话 supervisor 源码模块划分
`server/src/sessions/` 下的会话 supervisor 实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。

`SessionSupervisor` 及其端口类型（`SessionSupervisorOptions`、`SessionSupervisorRuntime`、`StreamCursor`、`SessionStreamSubscription`、`SessionStreamLiveHandler`）SHALL 保持从 `supervisor.ts` 导出。`supervisor.ts` 是会话派发与回合生命周期的唯一公共入口。

`pool.ts`、`turn-control.ts` 与 `approvals.ts` 的导出 SHALL 只供 `sessions/` 内的 supervisor 模块使用，不经 `sessions/index.ts` 对外暴露。三个模块的职责如下：
- `pool.ts` SHALL 承载 slot 登记：活 slot 与 generation 的记录形状、按回合认领的释放（`releaseClaim`/`releasePumpExit`），以及进程池的准入、驱逐与名额。
- `turn-control.ts` SHALL 承载回合派发辅助：回合事件到 store 的落库映射、预进度失败后的帧排空，以及 stop/regenerate/fork 的回合控制编排。
- `approvals.ts` SHALL 承载审批编排：审批请求的登记（经 store 落库 pending 行、按回合帧序发布 `approval.request`、按 `approvalId` 启动超时计时并标记挂起），以及作答与超时的结算（经 store 的 CAS 与审计同事务结算后，向该审批所属进程发帧、清除挂起、发布 `approval.resolved`）。

值导入 SHALL 无环。`pool.ts`/`turn-control.ts`/`approvals.ts` 对 `supervisor.ts` SHALL 只允许类型导入。新模块 SHALL 不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** 同时满足以下各项：
  - size-guard 退出 0；
  - knip 报告无未引用导出；
  - `pool.ts`/`turn-control.ts`/`approvals.ts` 不值导入 `./supervisor.js`；
  - 既有调用方仍从 `sessions/supervisor.js` 取得 `SessionSupervisor` 及其端口类型；
  - supervisor 相关测试全绿。
