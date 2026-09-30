# Tasks: thinking-merge-persist（#519）

## 3. thinking-fold — 合并、落库与发布（父 tasks 3.3 原文）

- [ ] 3.3 新建 `server/src/sessions/store-thinking.ts`（`appendThinking(messageId, chunk)`：单条 `UPDATE chat_messages SET thinking = COALESCE(thinking,'') || ?`，共享上限 32768 码点、不拆代理对，超限那次只落「填满上限的前缀 + `…（已截断）`」并返回实际落库片段，此后返回空且不写）+ `thinking-buffer.ts`（每助手消息一缓冲，注入 `SessionClock`；累计 2048 UTF-8 字节 / 首段起 2000 ms / 同回合其它事件发布前 / 回合终态前任一时刻整段刷出）+ `supervisor.ts` 接线：刷出投递到 pump 串行提交链，先 `appendThinking` 再在同一同步段发布该片段（中间无 await），落库失败不发布走 owned error-sink；`applyFailure`/`applyStop`/崩溃/优雅关停前刷出。验证：新建模块级 `server/test/thinking-buffer.test.ts`（注入时钟、合成增量，真实 SQLite）：跨过 2048 字节的那段合入后立即刷出一条、首段后时钟推进 2000 ms 刷出、其它事件（`step.start`/`text.delta`）发布前先刷出、刷出后的增量进入新缓冲；合计 40000 码点且截断点落在代理对处 → 列为前 32768 码点（无孤立代理项）+ `…（已截断）`、跨限片段为到限前缀加标记、之后返回空不写；恰 32768 码点全文保存无标记。新建 `server/test/session-thinking.test.ts`（supervisor + fake-omp `thinking` 场景，直接读 `chat_messages.thinking` 列，不经快照投影）：三段小 delta 在首个 `text.delta` 前刷为一条 `thinking.delta`；不含 thinking 帧的场景（A 的 `abort-ok`）→ 列为 null（thinking-fold「真 omp 帧到达」的 null 分支；快照为 null 由 5.1 证明）；列值恰等于已发布片段之和；`--thinking-repeat <n>` 使合计超 32768 码点 → 标记只发一次、此后无该消息的 `thinking.delta`、列值等于已发布之和；`--hold-after-thinking` 挂起时 stop → 缓冲内容以 `thinking.delta` 先于 `turn.end stopped` 发布且已落列；`appendThinking` 注入失败 → 无 `thinking.delta` 发布、ring 序号不推进、错误进 error-sink；带 `thinking.delta` 之前游标的 SSE 重连按序恰重放一次，回合 running 时无游标连接从活跃 `turn.start` 起的回放包含它

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 冲刷漏斗、同步段、计时器与 REST 结算交错、回放 → M1–M3、S1、S4、S6、S7、S8 |
| Error handling / rollback / partial outputs | yes | 落库失败不发布、infraFault 丢弃、终态前冲刷 → M5、M6、S4、S5 |
| Resource limits / large input / discovery | yes | 32768 码点上限、代理对、恰满边界 → M4、S3 |
| Public API / CLI / script entry | yes | SSE `thinking.delta` 普通 ring 事件与回放 → S1、S6 |
| Legacy compatibility / examples | yes | text.delta 纪律与既有测试不变 → S1、既有测试全绿 |
| Schema / columns / units / field names | no | 列已由 035 新增；只写不改形 |
| Auth / permissions / secrets | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试进两个新文件；既有测试文件除 proposal 偏差 2 声明的 `session-persist-new-events.test.ts` 删一个 describe 外零改动。
- [ ] RED 集合以 design「Required evidence」为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate thinking-merge-persist --strict --no-interactive` 通过。
