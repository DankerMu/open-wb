# Proposal: stop-route（#475）

## Why
父 change `s1c-turn-control-governance` tasks 5.1a（epic #448，issue #475）。

`supervisor.stop(sessionId)` 已由 #473（已派发路径）与 #490（停止意图）交付（`server/src/sessions/supervisor.ts:207-218`）。`POST /api/sessions/:id/stop` 也已由 #450 列入 content-parser 归属集（`server/src/http/errors.ts:54`）。但 `rest.ts` 没有这条路由，`stop` 在 src 中也没有调用方。现在该路径的 POST 落进 `/api/*` catch-all（`server/src/app.ts:172`），返回不带 no-store 的 404。web 的 `stopSession` 已按 202 `{}` / 204 解析（`web/src/lib/api-sessions.ts:133-150`，`web/src/lib/session-contract.ts:211-213`）。本刀补上这条路由，它是 web 停止按钮（7.2）与 smoke 停止条目（8.1b）的对端合同。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：公共 REST 路由、content-parser 归属集与跨端严格解析的 202 `{}` 形状，均为 public API / parser 硬触发项)
Blast radius: 路由模板与归属集不一致 → parser 错误变成 generic 500；owner 校验晚于 parser 或 supervisor → 泄露他人会话存在性，或以他人 `owner_id` 写 `session.approval` 审计；非 running 仍调 stop 或 body 被接受 → 多余的帧或写库；202 body 不是 `{}` 或返回 200 → web `stopSession` 抛错（`api-sessions.ts:139-146`）；stop 的拒绝被吞或未映射 → 进程级 unhandledRejection 或错误的 202
Selected risk packs: Public API / CLI / script entry；Auth / permissions / secrets；Schema / columns / units / field names；Resource limits / large input / discovery；Error handling / rollback / partial outputs；Concurrency / shared state / ordering；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-stop-rest.test.ts`（inject 与 `withListeningApp` 真实 socket 同一 vitest 文件，≤800 行）；design「Required evidence」A1–A7、R1–R4、W1–W2 全绿，红/绿按 design 标注；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `server/src/sessions/rest.ts`（286 → 约 310）新增 `POST /api/sessions/:id/stop`：
  - `bodyLimit: 1`，取 Fastify 允许的最小值（logout 先例，`server/src/auth/index.ts:92-93`），在 `rest.ts` 里声明为本地常量；
  - route-owned no-store（`noStoreSessionResponse`）；
  - 专用 preParsing 只做 `requireOwnedSession`，保证 401/404 早于 parser；
  - handler 依次执行：body 检查，`request.body !== undefined` 时返回 `HttpError("bad_request")`；在同一同步段内重读 owner-scoped 视图并判定 `status`：不是 `running` 返回 204，是 `running` 则 `await dependencies.supervisor.stop(id)` 后返回 202 `{}`。
- `SessionSupervisorPort`（`rest.ts:15-19`）加 `stop(sessionId: string): Promise<void>`。
- `server/test/session-rest-helpers.ts`：stub supervisor 加一个 `stop` 成员（偏离 3，类型强制）。
- 测试：新建 `server/test/session-stop-rest.test.ts`。

## Capabilities
- MODIFIED turn-control「停止生成 REST」：以主 spec（#473/#490 推进）为底，逐字并入父 delta 的以下内容：路由首段、`status="running"` 开头句（去掉控制占用括注）、`202 {}` 响应形状、204 段，以及 Scenario「非运行中停止幂等」「body 与鉴权」；四个既有 Scenario 的 THEN 恢复 `202 {}`。「（或 regenerate）」与控制占用 → #465。
- MODIFIED chat-sessions「会话 REST」：以主 spec（#468 推进）为底，路由清单只加 stop，并入父 stop 段（只写 stop，去掉控制占用子句）。Scenario「Owner and authentication isolation」只加 stop；新增 Scenario「Stop is accepted while running and idempotent otherwise」，其审批 WHEN 移给 #474，regenerate 移给 #467。
- MODIFIED http-service-skeleton「统一错误信封」：以主 spec 为底，并入正文 bodyless 句（只写 stop）。Scenario「回合控制 parser owner 的真实 HTTP 边界」第二个 WHEN 加 stop；新增 Scenario「bodyless 归属路由拒绝任何 body」（只写 stop）。

## Impact
- 行数：`rest.ts` 286 → 约 310；新测试文件 ≤800 行。
- 零 diff：
  - `supervisor.ts`、`turn-control.ts`、`approvals.ts`、`store*.ts`、`http/errors.ts`、`core/`、`index.ts`、`sessions/stream/sse.ts`、`omp/`、`app.ts`、web、`server/test/support/fake-omp*.mjs`；
  - 除 `session-rest-helpers.ts` 那一个成员外的全部既有测试与 helper。
- `index.ts:51` 传入真实 `SessionSupervisor`，其 `stop`（`supervisor.ts:208`）已满足加宽后的端口，无需改动。knip：`stop` 因此有了 src 调用方。

## 偏离与决定
1. **202/204 以 owner-scoped 会话视图的 `status` 判定，并在调用 `stop()` 的同一同步段内重读**。三处来源需要调和：
   - issue 原文：「状态判定读取 owner-scoped 会话视图」。
   - 父 spec：「会话 `status="running"` 时 SHALL 调用 supervisor stop」。
   - #605 评审（carry-forward）：路由须在调用 `stop()` 前的同一同步段读 `store.runtimeState(id)?.activeTurn`，不信持久化状态，因为 S7 类故障下两者不同。

   查证后的结论：
   - 在 store 层，持久化 `running` 与内存 `activeTurn` 在每条路径上都于同一同步段一起翻转：
     - `acceptPrompt` 先在事务里置 running（`store.ts:294-299`），同步段内接着 `activeTurns.set`（`:329-330`）；
     - `finishOwnedTurn` 只在事务提交后 `releaseTurn`（`store-approvals.ts:197-199`），事务失败时两者都保持 running（`:192-196`）；
     - `rollbackPrompt` 同样是提交后才释放（`store.ts:366-367`）；
     - `reconcileOnStartup` 在有活跃回合时拒绝执行（`:498-500`）。
   - #473 S7（`session-stop-faults.test.ts:92-111`）里，`finishTurn(stopped)` 失败后行仍为 running、`activeTurn` 仍在，两种读法都判为 running。真正不同的是 supervisor 已没有 claim 与阶段标记，`stop()` 空转（#490 design 决定 3）。这一层 `SessionSupervisorPort` 看不到，两种读法都一样。
   - 所以 #605 真正约束的是时序：不能用 preParsing 时读到的旧快照。数据源用哪一个都可以。
   - 本刀取 owner-scoped 视图：`requireOwnedSession(dependencies.store, request).session.status`，与 `supervisor.stop()` 内的 `runtimeState` 读取（`supervisor.ts:212`）处于同一同步段，中间没有 await。这同时满足 issue 原文、父 spec 措辞，以及主 spec「REST SHALL NOT use the trusted-supervisor-only runtimeState accessor」的边界，`rest.ts` 的 `SessionOwnerStore` 也只暴露 `getMessages`。
   - S7 类残局（持久化 running、supervisor 无 claim）下返回 202 但 stop 不生效，列入 Open questions。
2. **真实 supervisor 用例不止 issue 点名的一个**。issue 写「其余 inject 用例沿用既有 stub supervisor」，但本 delta 并入的几个 Scenario 需要真实 fake 或生产装配才能证明：
   - chat-sessions「Stop is accepted…」写明 backed by the real fake (`abort-ok`)；
   - turn-control「运行中停止」「同一回合二次停止」「派发前停止」要求 `abort` 帧、`turn.end(stopped)` 与 probe `frames=`；
   - http-service-skeleton 写明 production route 与 `abort` 帧。

   所以另加 R1–R3（`abort-ok`/`abort-ignored`/`slow-ready`）与 W1–W2（生产 `createApp` 上的真实 socket）。这些用例只增加证据，不扩大 PR 边界，也不改 supervisor。状态码矩阵与故障映射仍用 stub。
3. **越出 PR Boundary 改 `server/test/session-rest-helpers.ts` 一处**（issue：「`rest.ts` + 新建测试文件」）。原因：`RecordingSupervisor extends SessionSupervisorPort`（`:27`），而 `server/tsconfig.json` 的 include 含 `test`，端口加 `stop` 后，`createSupervisor()`（`:75-106`）不再满足类型。只加一个成员，调用即以 `Error("unexpected stop call")` 拒绝，与 #468 加 `decide`（`:101-103`）同形。carry-forward（#468/#473 fixture）已指派本刀做这一改动。
4. **`bodyLimit` 为 `rest.ts` 本地常量 1**，不从 `auth/` 导入：`LOGOUT_BODY_LIMIT` 是 `auth/index.ts:93` 的模块私有 `const`，要导出就得改 `auth/`，而那在 PR Boundary 之外；`server/src/sessions` 目前也不 import `auth/`。值与注释照抄 `auth/index.ts:92-93`。
5. **真实 socket 上的「超限」输入用 `{}`（2 字节 > 1）**，不用 1.1 MB 的 `OVERSIZED_PARSER_INPUT`：
   - 原因：#468 的 E15 在全量负载下偶发 `fetch failed/ECONNRESET`（carry-forward #488 impl），2 字节不存在这个问题；
   - 1.1 MB 输入只经 inject 发送（A3–A5）；
   - 真实 socket 上 401/404 的输入沿用 #468 收窄后的 malformed/empty/unsupported。

## Open questions（上报编排者，本刀不处理）
- **S7 类残局返回 202 但 stop 不生效**。持久化 `finishTurn(stopped)` 失败后，行停在 running、store 回合仍活跃，supervisor 却已没有 claim。此时 stop 走 `TurnStops` 的丢弃分支后 resolve，路由按 running 返回 202 `{}`，但回合永远不会收尾。说明：
  - 该会话本就卡在 running：`acceptPrompt` 返回 409，重启对账后变为 failed；
  - supervisor 已保留故障（`world.errors`）；
  - `SessionSupervisorPort.stop(): Promise<void>` 不给信号，本刀边界内无法区分。
  - 若要改为 204 或 502，需要 supervisor 返回「是否受理」。候选 owner 为 #474（终态/故障结算），或新 issue。
- 父 delta 归档对账：本刀归档后，父 turn-control、chat-sessions、http-service-skeleton 三块仍保留完整目标文本（regenerate、控制占用），仍为 MODIFIED；#467/#465 归档时须以推进后的主 spec 为底。
- OUT-OF-SCOPE：`session-approval-rest.test.ts` E15 在全量负载下偶发 ECONNRESET（#468 遗留），只报告不修。

## Non-goals
- `supervisor.stop` 的语义：Deny→abort、有界退回、停止意图（4.2a #473、4.2b #490 已交付，本刀只经 REST 观察）。
- 停止时审批 `decision`/审计的断言（4.6 #474），以及 stop 持有控制占用（4.4 #465）。
- regenerate/fork 路由（#467 5.1b、#469 5.2b）；错误码表与归属集定义（1.2 #450，只消费）。
- web 停止按钮（7.2）；smoke/ui-walk 停止条目（8.1b/8.2b）；架构文档 API 表（9.1 #486）。
