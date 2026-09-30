# Tasks: public-retire（#516）

## 4. chat-sessions — 删除的回收原语（父 tasks 4.3a 原文）

- [ ] 4.3a 删除的回收原语：`supervisor.ts` 公开 `retire(sessionId)`（有 slot 走既有 `#retireSlot`、丢弃 slot 与事件环；对每个订阅者调用其关闭回调并清空订阅集；无存活 generation 时直接返回、不 spawn 不写不升 epoch）+ `subscribe` 增**可选**第四参 `onEnd`（既有三参调用方不改）+ `stream/sse.ts` 以其文件私有 `endOwned` 闭包作为 `onEnd` 传入（SSE 连接 `raw.end()`，不写任何事件）。本刀不加任何路由。验证：新建 `server/test/session-retire.test.ts`（supervisor + 真实 fake-omp + 真实 SSE 订阅）按 chat-sessions「Public retire for deletion」：idle 会话（空闲子进程存活、两个 SSE 订阅者）`retire` → 子进程退出、其 token 在模型代理处不再认证、进程名额释放、两个订阅者响应结束且无新事件、SQLite 行无变化，之后在该会话 prompt 获取新 generation 且 `stream_epoch` +1；第二次 `retire` 与对无存活 generation 会话的 `retire` 均立即返回、不 spawn、不写、不升 epoch；未传 `onEnd` 的订阅者仅被移出订阅集；既有 `session-supervisor-subscribe.test.ts`、`session-sse.test.ts` 不改动全绿

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `retire` 与 `subscribe` 第四参是删除刀消费的接缝 → 证据 1–5 + typecheck |
| Concurrency / shared state / ordering | yes | slot/订阅集映射、重复 retire、retire 期间的订阅 → 证据 1、2、4 |
| Error handling / rollback / partial outputs | yes | onEnd 抛错隔离、无 generation 零副作用 → 证据 2、5 |
| Legacy compatibility / examples | yes | 三参 `subscribe`、既有订阅/SSE 契约 → 证据 3、6 |
| Resource limits / large input / discovery | no | 池名额释放沿既有 `#retireSlot`，由证据 1 观测，不改池 |
| Auth / permissions / secrets | no | token 撤销沿既有 `#retireSlot`，由证据 1 观测，不改撤销逻辑 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Schema / columns / units / field names | no | 不改 schema 与事件 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建的 `server/test/session-retire.test.ts`（≤800 行）；既有测试零改动。
- [ ] 每条新断言先在实现前跑红，再实现跑绿（记录命令与结果）；守卫按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate public-retire --strict --no-interactive` 通过。
