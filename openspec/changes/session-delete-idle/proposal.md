# Proposal: session-delete-idle（#525）

## Why
父 change `s1c-session-metadata-presentation` tasks 4.3b（epic #509，design D3「删除」、「落刀次序（三刀）」）。4.3a（#516）已给 supervisor 公开 `retire(sessionId)` 与 `subscribe` 的 `onEnd`，4.1/4.2 已建 `rest-metadata.ts`/`store-metadata.ts`；但会话、消息/步骤/审批行、`omp_session_file` 与空闲进程仍无任何删除路径，审计无 `session.delete`。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 公共 REST 删除路由（204/401/404/409/5xx）；进程与订阅回收（supervisor 控制占用、`retire`、SSE 墓碑）；删行 + 审计同事务与提交后删文件的次序不变量「行先于文件消失、占用与墓碑在每条结束路径释放」；跨 uid 删除会话文件（Linux sudo 模式）。
Selected risk packs: Public API / CLI / script entry（DELETE 合同）；Auth / permissions / secrets（owner 预检先于任何 supervisor 调用、审计可见规则、跨 uid unlink）；Concurrency / shared state / ordering（控制占用、墓碑窗口、retire 期间的并发请求）；Error handling / rollback / partial outputs（删除事务/审计失败整体回滚、占用释放、unlink 失败上报）；File IO / path safety / overwrite（提交后 unlink、ENOENT、非 ENOENT）；Legacy compatibility / examples（既有路由、既有测试冻结）
Evidence floor: 新建 `server/test/session-delete.test.ts` 覆盖 design「Required evidence」；`server/test/linux/uid-isolation.test.ts` 按父 tasks 增长例外新增一例（仅 CI `uid-isolation` job 运行）；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR CI 的 `uid-isolation` job 绿。

## What Changes
- 新建 `server/src/sessions/session-delete.ts`：`createSessionDeleter({ store, supervisor, metadata, onError })` 返回 `{ deleteSession(sessionId, ownerId), isDeleting(sessionId) }`——同步段内查占用 → 登记占用 → running 过渡 409 → 墓碑 → `retire` → 内存态不变量检查 → store 删除事务 → 提交后 unlink → `finally` 解除墓碑与占用。
- `store-metadata.ts`：`deleteSession(ownerId, sessionId)`——单事务读 `omp_session_file`/`workspace_id`/消息数 → 所有者作用域 `DELETE` → `session.delete` 审计；返回 `{ ompSessionFile, messageCount }` 或 null（0 行）。
- `rest-metadata.ts`：`DELETE /api/sessions/:id`（复用 4.2 的 preParsing owner 预检，no-store，不读 body，204）。
- `stream/sse.ts`：`SessionEventStreamOptions` 增必填 `isDeleting`；在调用 `supervisor.subscribe` 之前命中即 `endOwned`、不写事件。
- `supervisor.ts`：新增公开 `holdControl(sessionId): () => void`（包装既有 `#controls.hold`）；为守住 800 行把 `#translate` 移到 `supervisor-faults.ts`。
- `rest.ts`（依赖透传）、`index.ts`（构造 deleter 并装配到路由与 SSE）、`server/test/session-rest-helpers.ts`（独立路由 harness 接线一处）。
- 测试：新建 `server/test/session-delete.test.ts`；`server/test/linux/uid-isolation.test.ts` 新增一例。

## Capabilities
- ADDED `session-metadata`「会话删除」：父 delta 全文，但第 2 步改写为本刀的过渡行为（running → 409 `session_busy`、释放占用、无其它副作用），「第 2–4 步失败」相应改为「第 3–4 步失败」；删去 Scenario「删除运行中的会话先停止」「删除时停止意图遇获取失败」与「删除期间的并发请求」的第一组 WHEN/THEN（均属 4.3c）；新增 Scenario「运行中删除的过渡拒绝」。4.3c（#526）以父 delta 全文 MODIFIED 本 Requirement、移除过渡行为。
- MODIFIED `session-metadata`「会话元数据审计」：父 delta 全文（`session.delete` 条目、「两类事件」、Scenario「审计形状」），并保留 main 的 Scenario「绑定审计形状」（MODIFIED 不得丢弃既有 Scenario；父 change 归档前 rebase 时取舍）。
- MODIFIED `chat-sessions`「会话 REST」：main 原文 + DELETE 路由（十路由）、「PATCH 与 DELETE 分别遵循『会话元数据修改』『会话删除』」、Owner isolation Scenario 的 DELETE；组 10、fork 继承（4.4）、`stopped` 句、「id-scoped requests」措辞漂移不并入。
- MODIFIED `http-service-skeleton`「统一错误信封」：main 原文 + DELETE 非归属句与 Scenario「会话元数据 parser owner 的真实 HTTP 边界」的 DELETE 两组 WHEN/THEN。

## Impact
- server：新建 `session-delete.ts`；改 `store-metadata.ts`、`rest-metadata.ts`、`stream/sse.ts`、`supervisor.ts`、`supervisor-faults.ts`、`rest.ts`、`index.ts`；测试 harness `session-rest-helpers.ts` 一处接线。不触碰 `store.ts`、`omp/`、`http/errors.ts`、web。
- 与 issue 的偏差：
  1. issue 写「不改 `supervisor.ts`，只消费 A #473 的控制占用登记 API」，但 A 的占用（`ControlClaims`）是 supervisor 私有字段 `#controls`（`supervisor.ts:122`），无公开登记入口；prompt 路由（`rest.ts:190`）、`#prompt`（`supervisor.ts:350`）与 regenerate/fork（`branching.ts:73/206`）读的都是这一实例，DELETE 必须登记到同一实例才能让它们 409。故新增一个公开方法 `holdControl`（不改占用语义），并把纯函数 `#translate` 移出以守住 size-guard（现 799 行）。
  2. issue 写「`session-delete.ts` 导出 `isDeleting(sessionId)`」；为避免模块级可变全局（同进程多 app、测试间串扰），墓碑集随 deleter 实例创建，`isDeleting` 为实例方法，经 `registerSessionEventStream` 的必填选项注入 sse.ts。
  3. issue 把「无活跃回合内存态」检查放在 store `deleteSession` 内；改在 `session-delete.ts` 于删除事务调用前经 `store.runtimeState(id).activeTurn` 完成（同一同步段、紧邻事务），免于把 SessionStore 注入 metadata store。
  4. `index.ts` 之外，`server/test/session-rest-helpers.ts:59` 的独立路由 harness 需接线一处（路由依赖新增 `deleter`），与 #523 先例相同；既有测试断言零改动。
- 依赖：#516（4.3a）、#523/#524（4.1/4.2）、#518（6.1 fake `thinking`）、A #467/#473 均已合并。

## Non-goals
- running 会话的停止 → 等终态或补偿 → 删除（4.3c/#526）；regenerate/fork 遗留的旧分支 `.jsonl` 与 omp artifacts 清理（父 design「Not yet specified」）；web 删除入口（7.2b）；smoke DELETE 条目（8.1）。
