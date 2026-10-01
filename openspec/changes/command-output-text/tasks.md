# Tasks: command-output-text（#554）

## 10. Slash 命令 — 命令回复归约（父 tasks 10.3 原文）

- [ ] 10.3 `server/src/sessions/events.ts`：回合内 `command_output{text:string}` → 未 `started` 则先 `turn.start`（置 started，后到的 `agent_start` 不重置），再 `text.delta{delta}`：首条为 `text`，后续为 `"\n"+text`；state 只增布尔 `commandOutputSeen`；`text` 非字符串 → 过滤；终态后无事件。`supervisor.ts` 无改动（`text.delta` 走既有 `appendDelta` 落库；本地完成 → pump 末尾既有 `turn.end done`）。验证：新建 `server/test/session-events-command.test.ts`（纯函数：`turn.start` + 两条 delta 精确值、畸形帧与 ACK 无事件、终态后无事件、state 不含正文；chat-stream「Command output becomes assistant text」）+ 新建 `server/test/supervisor-command-output.test.ts`（真实 fake `slash` + 真实 SQLite：`/todo` 与 `/compact` 各恰 `turn.start`/一条 `text.delta`/`turn.end done`，助手正文精确等于 omp 文本、无 step 行、会话 done；`--compact-silent` 注入时钟推进 120 s 后恰一条 `turn.end done`、正文为空；等待期 POST stop → 202、`abort` 帧写出并得 `response{command:"abort"}`、无输出，注入时钟过 `OMP_ABORT_GRACE_MS` 后 runtime retire、恰一条 `turn.end stopped` 无 error，会话/助手 `stopped`（依赖 A #490 的 stop 终态路径）；chat-sessions「Local command output becomes the assistant body」）；`session-events.test.ts` 不增长

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 事件序列与助手正文 → P1、S1、S2 |
| Concurrency / shared state / ordering | yes | `turn.start` 只补发一次、输出晚于回执仍先于 `turn.end`、等待期 stop → P1、P2、S2、S4 |
| Error handling / rollback / partial outputs | yes | 畸形帧过滤、终态后无事件、静默压缩不伪造正文 → P2、P3、S3 |
| Legacy compatibility / examples | yes | 既有 Scenario 与 `session-events.test.ts` 零 diff → 既有测试全绿 |
| Schema / columns / units / field names | no | 复用既有事件与列 |
| Auth / permissions / secrets | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Resource limits / large input / discovery | no | 输出走既有 `appendDelta` 缓冲；归约器不累积 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进两个新文件；既有测试文件零改动（`session-events.test.ts` 不增长）。
- [ ] RED 集合以 design「Required evidence」为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate command-output-text --strict --no-interactive` 通过。
