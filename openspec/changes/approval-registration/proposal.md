# Proposal: approval-registration（#464）

## Why
父 change `s1c-turn-control-governance` tasks 4.3（epic #448，issue #464）。

今天 runtime 已能把审批 select 转给 owner（#460 识别、#462 `onApproval`/`markPending`/`clearPending`/`respondApproval`），但 supervisor 没有接收者：`#dispatchNew` 构造 runtime opts 时不传 `onApproval`（`server/src/sessions/supervisor.ts:290-309`）。`chat_approvals` 表（#449）与 `approval.*` 事件类型（#453，`events.ts:25-36`）都没有生产者；审批不会超时，也没有作答端口。本刀把登记、计时与 CAS 结算作为同一不变量交付：每条审批要么仍 pending 且有计时器，要么恰被结算一次、结算与审计同事务、之后才发帧与发布。

前置件均已就绪：#454 `store-approvals.ts` 落点；#487 supervisor 拆分（`approvals.ts` 未建占位，由本刀新建）；#460/#462 runtime 面；#453 事件联合；#449 表；#450 `approval_settled` 码；#458 fake-omp `approval`/`approval-parallel`；#463 进程池（`busy()` 已覆盖挂起审批）。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」：审批默认方向（超时=允许）与持久化结算)
Blast radius: 审批永不结算会挂住 omp 回合并冻结空闲回收；重复结算会向 omp 发两帧或写两条审计；决定与审计不同事务会破坏「有决定必有审计」；迟到作答打到后继进程的同名 `r1` 会替错误的工具调用作答；事件次序错会让 web 在 `step.start` 前渲染审批条；计时器越过关停会写入已关闭的 store
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Legacy compatibility / examples；Auth / permissions / secrets
Evidence floor: 新建 `server/test/session-approvals.test.ts`、`session-approvals-parallel.test.ts`、`session-approvals-faults.test.ts`、store 级 `session-store-approvals.test.ts` 与 helper `session-approval-helpers.ts`（各 ≤800 行），真实 fake-omp 子进程 + 真实 SQLite + 注入时钟 + 真实 `createApp`→`registerSessions` 装配 + 真实 SSE；design「Required evidence」R1–R20（含 R17b）全绿，R 标记项先红后绿；既有测试零改动；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- 新建 `server/src/sessions/approvals.ts`：审批编排（登记、按回合帧序发布 `approval.request`、按 `approvalId` 的 60s 注入时钟计时、作答与超时结算、关停时撤销计时器）。对 `supervisor.ts` 无值导入，不经 `index.ts` 暴露。
- `server/src/sessions/store-approvals.ts`：pending 行插入（`WHERE EXISTS` 当前 running assistant）与 CAS 结算事务（归属校验 → `UPDATE … WHERE id=? AND decision IS NULL` → 同事务 `emit` 审计）。
- `server/src/sessions/store.ts`：`SessionStoreOptions` 加可选 `emit`；`SessionStore` 加两个审批方法；导出审批视图与决定类型（#454 carry-forward）。
- `server/src/sessions/supervisor.ts` 只接线：`onApproval` opt、pump 的帧序发布挂点、公开 `decide(sessionId, approvalId, decision)`、`shutdown()` 撤销审批计时器。
- `server/src/sessions/index.ts`：`registerSessions` 把 `core/audit` 的 `emit` 传给 `createSessionStore`。
- 测试：四个新测试文件（含 store 级 `session-store-approvals.test.ts`）+ 一个新 helper 文件；既有测试零 diff。

## Capabilities
- MODIFIED tool-approval「chat_approvals 持久化」：主 spec + 父 delta 的登记/CAS 句与 Scenario「落库形状」「同一消息多行审批」（逐字）。
- ADDED tool-approval「审批事件」「审批作答 REST」「超时自动允许」「审批审计」：取父 delta 同名块中本刀交付的部分，裁剪见 spec 引注（→ #465/#468/#473/#474/#476）。
- MODIFIED chat-stream「审批事件发布」：主 spec + 父 delta 的发布纪律（去掉停止与非作答路径）+ Scenario「Persistence failure publishes nothing」「Parallel approvals coexist」（逐字）。
- MODIFIED chat-sessions「Session module registration and teardown」：主 spec + 父 delta 的 emit 注入一段。
- MODIFIED chat-sessions「会话 supervisor 源码模块划分」：补入 `approvals.ts` 职责与依赖方向（父 tasks 4.3 交接注记）。
- 不改 omp-pool：主 spec「活进程集合与上限不变量」已写「含挂起审批期间」，`busy()`（claim 或 pump 仍在）已覆盖；既有 A7（`session-supervisor-pool.test.ts:232`）在本刀后成为真实挂起审批下的守护。

## Impact
- 源码行数（实测记入 PR body）：`supervisor.ts` 724 → ≤755（硬上限 760，超出则把更多逻辑挪进 `approvals.ts`）；`store.ts` 605 → 约 640；`store-approvals.ts` 107 → 约 190；`approvals.ts` 新建约 200。
- 零 diff：`omp/` 全部、`rest.ts`、`events.ts`、`turn-control.ts`、`pool.ts`、`store-branch.ts`、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs`、全部既有测试文件与 helper。
- 生产 argv 仍为 `yolo`（`process.ts` spawn 契约），审批分支在生产不可达，直到 #481；本刀的行为只在测试侧 `--approval-mode write` 下出现。

## 偏离与决定
1. **PR Boundary 外改 `store.ts`**。issue 文件清单只列 `approvals.ts`、`store-approvals.ts`、`supervisor.ts`、`index.ts`。但 `createSessionStore` 与 `SessionStore` 是 store 唯一公共入口（chat-sessions「会话 store 源码模块划分」），emit 注入与两个审批方法只能从 `store.ts` 进；审批视图/决定类型被 `approvals.ts`（后续 `rest.ts`）消费，按 #454 carry-forward 须在 `store.ts` 定义导出。
2. **`emit` 为可选、缺失即失败关闭**。`createSessionStore` 有四个既有调用方只传 `onFlushError`（`core-db-chat-step-output.test.ts:134`、`sqlite-text.test.ts:95`、`session-store-helpers.ts:107`、`session-rest-helpers.ts:52`）。设为必填会迫使四处既有测试改动；设为可选并在结算事务内缺 `emit` 即抛错回滚（不存在「无审计的决定」），则零改动。代价是契约由运行时而非类型保证；R9 在 `index.ts` 漏传时变红，store 级 R20 区分失败关闭与静默跳过，补上这一缺口。不设缺省 `emit`：缺省会让 `index.ts` 的注入不可证伪。
3. **`approval.request` 在回合帧序位置发布，而非在 `onApproval` 内发布**。issue 次序写「落库 → 发布 request → 计时 + markPending」。但 `process.ts:573` 先 emit `frame` 再 emit `approval`（`:582`），`runtime.ts:383-405` 把该 select 帧同步推进回合 `FrameStream`，pump 异步消费：`onApproval` 运行时 pump 可能尚未提交此前的 `tool_execution_start`。若在 `onApproval` 内发布，同一 stdout 块内的 `tool_execution_start`+select 会让 `approval.request` 先于 `step.start(bash)`，违反 tool-approval「事件序与回放」。故 `onApproval` 同步完成落库、`markPending`、起计时器（carry-forward #462：`markPending` 须在 `onApproval` 内同步调用），`approval.request` 暂存，由 pump 处理到该 select 帧时发布；结算时若尚未发布则先发布 request 再发布 resolved（保证 resolved 不先于 request）；补发只有进程内同步调用方可触发，生产路径不可达（design 决定 1，R19 确定性证明）。spec 措辞（pending 行提交之后发布）不受影响。
4. **迟到作答与后继进程隔离靠登记时捕获的 slot**，不靠 CAS。carry-forward #462/#573：`respondApproval`/`markPending`/`clearPending` 无 generation 身份，fake id `r1` 每进程重复。#463 决定 4 已保证一个 slot 的 runtime 只有一代取得 pid（tokens 适配器 `issue` 闸门 `supervisor.ts:570-573`），因此登记时捕获的 slot 即 generation 身份；`markPending`/`clearPending` 以 `chat_approvals.id` 为键。本刀无崩溃结算（#474），迟到作答在本刀 CAS 仍会命中；R17（作答路径）与 R17b（计时器路径）只断言后继侧事实，不断言迟到调用自身的结果（#474 之后为 `approval_settled`）。
5. **只向登记时的 generation 发布，且仅当它未封口**。本刀无崩溃结算：进程带 pending 审批死亡后，该行仍 NULL、计时器仍在。若到期仍经 `#publish` 发布，`supervisor.ts:494-500` 会跳过已封口 ring 的 push 但仍调 `onEvent`，把 resolved 送到 `turn.end` 之后。一行判断即可让「resolved 先于 turn.end」在本刀基本成立；残余窗口见 design 决定 2（封口晚于 `turn.end`，fake 不可达），由 #474 关闭。这类审批的 `deny` 结算与发布归 #474。
6. **两个失败出口**。`decide` 有调用方：结算事务失败即以原错误拒绝，行保持 pending、计时器保留（可重试），不发帧、不发布。超时没有调用方：失败经既有 owned error sink（`#retain` + `infraFaulted` + `#retireSlot`，同 `#commit` 失败路径 `supervisor.ts:479-484`）。pending 插入失败同样走该 sink；omp 在 select 上等待、不会再来帧，只置 `infraFaulted` 的 pump 永远不会醒，所以必须主动 retire。`onApproval` 与计时器回调全部 try/catch，retire 不 await，自身不抛。
7. **关停撤销审批计时器**（issue 未写）。生产时钟是真实 `setTimeout`，未撤销的 60s 计时器会在 `store.close()` 之后触发、写入已关闭的 store。`shutdown()` 在进入 retire 前撤销全部审批计时器，不结算（关停 `deny` 结算归 #474）。
8. **`decide` 的 `not_found`**。端口带 `sessionId`，未知或属于其它会话的 `approvalId` 以 `not_found` 拒绝、无写入、无帧（取父 REST 块的 404 子句），供 #468 直接复用。
9. **argv 注入**：`session-supervisor-helpers.ts` 不做 `yolo`→`write` 替换（carry-forward #460）。新测试复用 `session-supervisor-pool-helpers.ts:70` 的 `gateApprovals`（追加 `--approval-mode write`，fake 取最后一个），或在新 helper 内按 `omp-approval-requests.test.ts:61-75` 的 `launch()` 自带替换；不改既有 helper。
10. **「r2 于 T+5000 到达」由测试侧 stdout 闸门驱动**。fake 背靠背发两个 select（`fake-omp.mjs:500-520`）。新 helper 扣住 `r2` 的 select 行，待 `r1` 行落库后把注入时钟置为 T+5000 再放行；同一闸门也用于把 `tool_execution_start` 与 select 合并成一次写入，确定性地触发偏离 3 的竞态（R13 先红）。

## Open questions（上报编排者，本刀不处理）
- 空闲回收进行中（`runtime.ts` 长时间静默的活跃回合被空闲回收，carry-forward）转发来的审批、以及带 pending 审批崩溃/infra 故障结束的回合：本刀让该行保持 NULL、不发布，只在关停时撤销计时器；结算归 #474。
- #474 归档时：tool-approval「超时自动允许」补回「被停止或其它非作答路径结算的」取消计时器子句，chat-stream 补回非作答结算句；#473 补回停止路径的次序括注。
- `session-approval-events.test.ts` 头注释称生产者是 #464、以测试 ring 顶替 supervisor ring；本刀后该注释陈旧但测试仍正确，零 diff，是否清理由编排者定。

## Non-goals
- REST 路由 `POST /api/sessions/:id/approvals/:approvalId`（5.2a #468）。
- 停止路径 `deny`（4.2a #473，调用本刀的结算）；崩溃/有界退回/关停/对账的 `settlePendingForMessage`（4.6 #474），含「作答与进程退出竞争」。
- 快照 `approvals` 投影与 web 归约（5.3 #476）；web 审批条（7.4 #480）；argv 切 `write`（#481）。
- `omp/` 任何改动（审批识别 #460、runtime 面 #462 已交付）。
