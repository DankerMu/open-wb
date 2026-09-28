# Spec delta: chat-sessions（#466 fork 的 supervisor 编排、临时 runtime 与模块划分）

> - 「Supervisor dispatch and generation binding」以主 spec 原文为底，并入父 delta 同名块中本 issue（4.5）交付的 fork 部分；主 spec 八个 Scenario 保留（前六个为无加粗 `- WHEN` 格式，照抄）。
>   - 首段：
>     - 「Regenerate is … its …」按父文恢复为「Regenerate and fork are … their …」的复数句；父文「（Requirement「会话 REST」）」引注随 REST 路由 → #467/#469，由它们按父文恢复。
>     - 补偿括注中父文「removing a pre-created fork session row」按 proposal「偏离与决定」1（新会话行在事务内插入，失败时不存在）改为「shutting down a fork's temporary process」，归档时父 delta 须采纳。
>     - 控制占用句按父文补回 fork。
>     - 失败映射句（#465 自写）扩为 regenerate 与 fork 两条路径：fork 事务存储故障 → `agent_unavailable`、复核失败 → `session_busy`。这是自写扩展，归档时父 delta 须采纳。
>   - 第三段：并入父文「A fork's temporary runtime is not a generation …」句，逐字。
>   - Scenario：
>     - 「Control claim excludes concurrent turn operations」取父文逐字。注入 prompt 走现有 REST 路由（`acceptPrompt` → supervisor 拒绝 → `rollbackPrompt`），「no row … change」断言结束后的行与注入前逐字相同；受理前拒绝、不写任何行归 #467（#465 偏离 3 同例）。
>     - 「Fork temporary runtime is not a generation」：WHEN 由「the owner forks」改为 supervisor 层「fork is called for」，REST 形状 → #469；其余逐字。
> - 「会话 supervisor 源码模块划分」（proposal「偏离与决定」2，#464 为 `approvals.ts` 改此块的先例）：新增 `branching.ts`，承接从 `turn-control.ts` 移出的 regenerate 编排与本刀的 fork 编排；`turn-control.ts` 保留事件落库、帧排空、stop 编排与控制占用；`pool.ts` 增列 runtime 选项组装与 token 适配器。Scenario 标题保留，条目补 `branching.ts`。

## MODIFIED Requirements

### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner and resume metadata. On the prompt path it SHALL neither admit nor compensate a pair itself. Regenerate and fork are supervisor-owned admission and compensation paths: the supervisor SHALL perform their single final SQLite transaction (including the control-claim recheck) and their failure compensation (retiring the process, shutting down a fork's temporary process, or settling a dispatched regenerate assistant row `failed`). The supervisor SHALL hold a per-session control claim for regenerate, fork and stop from a passed precheck until dispatch completes or the response is returned; while it is held, prompt, regenerate and fork on that session SHALL be rejected with session_busy (a stop after regenerate has dispatched proceeds normally because the session is then `running`), and the claimed session's process counts as in-turn for the process cap. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error. On the regenerate and fork paths the failure mapping of turn-control「重新生成 REST」and「从此处分叉 REST」takes precedence over this rule: a storage fault of their final transaction, and any regenerate dispatch failure after that transaction commits, SHALL reject with agent_unavailable; a failed control-claim recheck SHALL reject with session_busy.
The supervisor SHALL await the exact runtime dispatch receipt and persist the validated sessionFile before resolving the REST port, without consuming business frames first. Pre-progress failure SHALL retire/discard that runtime before rejecting so REST can compensate. No post-progress error SHALL reject the already-accepted REST operation.
Every runtime generation acquisition, including idle re-spawn, crash recovery and a regenerate on a session whose process has been reclaimed or evicted, SHALL increment stream_epoch exactly once via the existing store method before shared-token issuance; reuse of a live generation SHALL not increment it. Regenerate SHALL acquire that normal generation (epoch+1, a fresh ring) through the same lazy acquisition path as prompt. A fork's temporary runtime is not a generation: it SHALL NOT bump either session's stream_epoch, own a ring, publish events or bind a session slot, and counts only against the process cap. Failed acquisition may advance epoch independently of REST compensation. Runtime SHALL retain token-revocation ownership; native exit SHALL make that generation token invalid, without stale callbacks revoking a newer token. No requestId SHALL be guessed from an ACK.
#### Scenario: Cold start and reuse
- WHEN an owner prompts a new session and later prompts the same healthy runtime again
- THEN both requests return202 after dispatch, sessionFile is stored, one generation/epoch/token is used and no duplicate native child is spawned
#### Scenario: Failed acquisition compensation
- WHEN binary acquisition or nonempty-sessionFile handshake fails
- THEN prompt returns502, no business frames are persisted/published, the child/token is retired and REST restores prior pair/title/status/history while independent generation metadata may advance
#### Scenario: Idle and crash re-spawn
- WHEN a runtime is retired by idle or by a mid-turn crash and another prompt arrives
- THEN the next generation uses the persisted resume path, epoch increases once, the old token is invalid and its late callbacks cannot revoke the new token
#### Scenario: Retiring instance cannot revoke replacement
- WHEN a transport-failed runtime's native exit is delayed and a new prompt is admitted for that session
- THEN replacement acquisition waits for prior retirement/pump settlement, no replacement token is issued while the old instance can revoke, and later stale callbacks cannot invalidate the replacement; other sessions remain usable
#### Scenario: Generation adapter failure provenance
- WHEN epoch persistence or shared-registry issuance throws during runtime acquisition
- THEN the original generic failure is retained despite runtime sanitization, REST does not report502, its unprogressed admission is compensated, and no token/child remains leaked
#### Scenario: Dispatch metadata storage fault
- WHEN the prompt write succeeds but persisting validated sessionFile fails before any business frame is consumed
- THEN the runtime is retired, REST receives a generic failure and compensates its unprogressed admission; no background work continues against removed rows

#### Scenario: Regenerate on a reclaimed session
- **WHEN** a done session's process has been retired by idle or eviction and regenerate is called for it
- **THEN** the process is re-acquired through the prompt path with `--resume`, `streamCursor.epoch` is the previous value plus one, and an SSE subscriber of the new generation receives turn.start followed by turn.end for the new assistant message

#### Scenario: Fork temporary runtime is not a generation
- **WHEN** fork is called for a session with a live idle process and the fork succeeds
- **THEN** the source's live idle process was retired before the temporary process started, neither the source nor the new session's `stream_epoch` changed, no event was published to any ring and the temporary process has exited before the response

#### Scenario: Control claim excludes concurrent turn operations
- **WHEN** a regenerate or fork holds the control claim (the fake held between `get_branch_messages` and `branch`, and between `branch` and `get_state`) and a prompt, regenerate or fork arrives for the same session
- **THEN** each concurrent request returns409 session_busy with no row, file or process change; after the claimed operation finishes the claim is released and a later prompt is admitted

### Requirement: 会话 supervisor 源码模块划分
`server/src/sessions/` 下的会话 supervisor 实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。

`SessionSupervisor` 及其端口类型（`SessionSupervisorOptions`、`SessionSupervisorRuntime`、`StreamCursor`、`SessionStreamSubscription`、`SessionStreamLiveHandler`）SHALL 保持从 `supervisor.ts` 导出。`supervisor.ts` 是会话派发与回合生命周期的唯一公共入口。

`pool.ts`、`turn-control.ts`、`branching.ts` 与 `approvals.ts` 的导出 SHALL 只供 `sessions/` 内的 supervisor 模块使用，不经 `sessions/index.ts` 对外暴露。四个模块的职责如下：
- `pool.ts` SHALL 承载 slot 登记：活 slot 与 generation 的记录形状、按回合认领的释放（`releaseClaim`/`releasePumpExit`）、会话 runtime 的选项组装与 token 适配器（会话 generation 的，以及 fork 临时进程的不递增 epoch 的），以及进程池的准入、驱逐与名额。
- `turn-control.ts` SHALL 承载回合派发辅助：回合事件到 store 的落库映射、预进度失败后的帧排空、stop 的回合控制编排，以及会话级控制占用。
- `branching.ts` SHALL 承载 regenerate 与 fork 的编排：预检与控制占用登记、`get_branch_messages`/`branch`/`get_state` 命令序列与 entry 对齐、最终事务的调用与失败补偿；fork 另含源会话进程的先行 retire 与临时进程的准入、关停。
- `approvals.ts` SHALL 承载审批编排：审批请求的登记（经 store 落库 pending 行、按回合帧序发布 `approval.request`、按 `approvalId` 启动超时计时并标记挂起），以及作答与超时的结算（经 store 的 CAS 与审计同事务结算后，向该审批所属进程发帧、清除挂起、发布 `approval.resolved`）。

值导入 SHALL 无环。`pool.ts`/`turn-control.ts`/`branching.ts`/`approvals.ts` 对 `supervisor.ts` SHALL 只允许类型导入。新模块 SHALL 不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** 同时满足以下各项：
  - size-guard 退出 0；
  - knip 报告无未引用导出；
  - `pool.ts`/`turn-control.ts`/`branching.ts`/`approvals.ts` 不值导入 `./supervisor.js`；
  - 既有调用方仍从 `sessions/supervisor.js` 取得 `SessionSupervisor` 及其端口类型；
  - supervisor 相关测试全绿。
