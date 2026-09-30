# Proposal: public-retire（#516）

## Why
父 change `s1c-session-metadata-presentation` tasks 4.3a（epic #509，design D3 第 3 步、「落刀次序（三刀）」、Sketch seams「supervisor 公开 retire」）。删除（4.3b/4.3c）需要一个公开的回收原语：关停该会话的进程并结束其全部 SSE 订阅者，且不写事件、不写库。现状 `#retireSlot`（`server/src/sessions/supervisor.ts:717`）私有；`subscribe`（`:216`）没有按连接的关闭句柄；`stream/sse.ts` 的 `endOwned`（`:294`）文件私有。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: supervisor 的进程/订阅状态机（slot、池名额、token、generation 封存、订阅集）是 omp 子进程治理的 Critical Path；retire 若写事件会让删除前的客户端收到伪终态，若漏关订阅者则删除后连接悬挂，若在无 generation 时 spawn/写库则删除刀引入副作用。
Selected risk packs: Public API / CLI / script entry（supervisor 公开 `retire`、`subscribe` 第四参）；Concurrency / shared state / ordering（retire 与订阅集/slot 映射、重复 retire、retire 期间新订阅）；Error handling / rollback / partial outputs（onEnd 抛错隔离、无 generation 零副作用）；Legacy compatibility / examples（三参 `subscribe` 调用方与既有测试零改动）
Evidence floor: 新建 `server/test/session-retire.test.ts` 覆盖 design「Required evidence」；`session-supervisor-subscribe.test.ts`、`session-sse.test.ts` 及其它既有测试零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`（`supervisor.ts` ≤800）退出 0，knip 零新增。

## What Changes
- `server/src/sessions/supervisor.ts`：公开 `retire(sessionId): Promise<void>`；`subscribe` 增可选第四参 `onEnd?: () => void`（返回形状不变）；订阅集改为记录每个 deliver 的 `onEnd`。为守住 800 行（现 798），把文件底部三个与 retire 无关的模块级纯函数 `throwCollected`、`asError`、`synchronousSinkViolation` 原样搬到新建 `server/src/sessions/supervisor-faults.ts` 并导出，supervisor 改为导入（纯搬迁，行为不变）。
- `server/src/sessions/stream/sse.ts`：`supervisor.subscribe` 调用传入 `() => endOwned(connection, options.clock)` 作为 `onEnd`。
- 新建 `server/test/session-retire.test.ts`。

## Capabilities
- MODIFIED `chat-sessions`「Session module registration and teardown」：以主 spec 为底，只并入父 delta 中 4.3a 的部分——public `retire(sessionId)` 段与 Scenario「Public retire for deletion」。父 delta 同一 Requirement 中的 `rootOf`（workspace store 注入，2.2）与 `agentDir`（`ompAgentDir`，组 10）措辞留给各自切片。

## Impact
- `supervisor.ts`、新建 `supervisor-faults.ts`（仅接收搬迁的纯函数）、`stream/sse.ts` 与一个新测试文件；不触碰 `rest.ts`、`store*.ts`、`omp/`、web。本刀无调用 `retire` 的路由：行为只由测试可观测。

## Non-goals
- `DELETE /api/sessions/:id`、删除墓碑 `isDeleting` 与 sse 的墓碑查询、store 删除事务、unlink（4.3b）；running 会话的停止—等终态路径（4.3c）；retire 与并发 prompt/regenerate/fork 的竞态排除（由 4.3b 的控制占用与墓碑承担）；running 会话（`activeTurn !== null`）上的 retire——调用方保证非 running，running 路径由 4.3b 过渡 409 与 4.3c 停止—等终态负责；池治理本身（A #463）；web 侧 EventSource 行为。
