# Tasks: thinking-delta-reduction（#514）

## 3. chat-stream — thinking 归约（父 tasks 3.1 原文）

- [ ] 3.1 `server/src/sessions/events.ts`：回合内 assistant `message_update.assistantMessageEvent.type==="thinking_delta"` 且 `delta` 非空 → `thinking.delta{messageId, delta}`；`thinking_start`/`thinking_end` 与 `message_end` 内 thinking 块不产生事件；`ChatEvent` 联合增 `thinking.delta` 与 `files.changed{messageId, stepId, files:[{path, added, removed, kind}]}` 两型（`files.changed` 本刀只定义类型不产出）；`supervisor.ts` `persistEvent`（A #487 搬迁后的穷举 switch，无 default）（A #487 后实际位于 `server/src/sessions/turn-control.ts:218`，本刀 `supervisor.ts` 零改动）（该 switch 非 typecheck 强制穷举，见 design）为两型各加显式分支且本刀均返回 `undefined`（不落库、不发布；3.3/3.4 分别替换），使联合扩展后 switch 仍穷举且中间切片不会把 `details` 原始绝对路径发上 SSE；`server/test/session-events.test.ts:98-128` 噪声帧列表移出 `thinking_delta`（改期望值）。验证：新建 `server/test/session-events-thinking.test.ts` 断言回合外/空 delta/start-end 帧不产出、回合内逐帧一条；新建 `server/test/session-persist-new-events.test.ts` 断言 `persistEvent` 对两型返回 `undefined`、ring 无事件、无落库

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `ChatEvent` 联合是 SSE 事件类型源 → design 证据 1–6、8 + typecheck |
| Legacy compatibility / examples | yes | 既有归约序列与 text 语义不变 → 证据 3、9 + 既有 chat-stream/supervisor 测试零改动全绿 |
| Schema / columns / units / field names | yes | 两型 payload 字段 → 证据 1、7 + typecheck |
| Error handling / rollback / partial outputs | yes | 新两型不落库不发布（路径外泄闸门）→ 证据 7、8 |
| Concurrency / shared state / ordering | no | 纯函数；发布次序不变（`#commit` 未改） |
| File IO / path safety / overwrite | no | 本刀无 `files.changed` 生产者 |
| Resource limits / large input / discovery | no | 上限属 3.3；不累积由证据 6 覆盖 |
| Config / project setup | no | 不涉 |
| Auth / permissions / secrets | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进两个新建文件（各 ≤800 行）；`session-events.test.ts` 只改期望值、不增长；其它既有测试零改动。
- [ ] 每条新断言先在实现前跑红，再实现跑绿（记录命令与结果）；守卫按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate thinking-delta-reduction --strict --no-interactive` 通过。
