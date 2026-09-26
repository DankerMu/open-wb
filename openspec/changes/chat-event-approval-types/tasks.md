# Tasks: chat-event-approval-types（#453）

## 3. 审批事件联合（父 tasks 3.2 原文）

- [ ] 3.2 `ChatEvent` 联合新增 `approval.request{messageId,approvalId,tool,title,expiresAt}`、`approval.resolved{messageId,approvalId,decision}`；ring/SSE 无改动即透传。验证：新建测试文件断言两事件入 ring、`Last-Event-ID` 回放包含它们

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | SSE 事件是 server/web 公共契约 → 真实 SSE 订阅读回 `event:` 名与 payload |
| Schema / columns / units / field names | yes | payload 字段/类型固定 → `toEqual` 原样 + `@ts-expect-error` 非法 decision |
| Legacy compatibility / examples | yes | 既有六类事件与 ring/SSE 行为不变 → ring/SSE 既有测试零改动全绿 |
| Concurrency / shared state / ordering | yes | seq 次序与回放 → 连续 seq、`Last-Event-ID` 恰一次、无 cursor 从 turn.start 起 |
| Error handling / rollback / partial outputs | no | 失败不发布属 4.3/4.6 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | SSE 鉴权不变（既有测试覆盖） |
| Resource limits / large input / discovery | no | ring 保留上限不变 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | 不涉 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/*.test.ts`；ring/SSE/supervisor 既有测试零改动；`server/src` 除 `events.ts` 外零改动（含 `supervisor.ts`）。
- [ ] 测试接缝按 design「Seams under test」：`openBareSession` + `vi.spyOn(supervisor, "subscribe")` + 测试自持真实 `RingBuffer`。
- [ ] 正向断言先红后绿：未改联合时，红来自新测试文件中向 `RingBuffer.push` 传入审批事件那一行的 typecheck 错误（`src` 内不报错）；记录 `make typecheck` 输出。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate chat-event-approval-types --strict --no-interactive` 通过。
