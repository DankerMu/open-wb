# Tasks: session-delete-idle（#525）

## 4. session-metadata — 删除（非 running 路径）（父 tasks 4.3b 原文）

- [ ] 4.3b 删除（非 running 路径）：新建 `server/src/sessions/session-delete.ts` + 扩展 `store-metadata.ts` 加 `deleteSession` + 扩展 `rest-metadata.ts` 加 `DELETE /api/sessions/:id` + `stream/sse.ts` 在 `subscribe` 前查询 `session-delete.ts` 导出的 `isDeleting(sessionId)`（命中即 `endOwned`、不写事件；不改 `supervisor.ts`）：preParsing 401/404 先于任何 supervisor 调用；格式良好的 body 被忽略；登记 A 的控制占用（已被持有 → 409 `session_busy` 无副作用）并加入删除墓碑集；会话 running → 过渡期 `409 session_busy`（释放占用与墓碑、无任何副作用，4.3c 替换为停止路径）；非 running → 4.3a `retire`（墓碑期内新的 `GET …/events` 在 sse.ts 调用 `subscribe` 之前即被 `isDeleting` 拦下、连接立即结束、不写事件）→ store 单事务（确认无活跃回合/缓冲/步骤内存态，否则视为不变量破坏、通用失败不删行；读出 `omp_session_file` 与消息数 → `DELETE FROM chat_sessions WHERE id=? AND owner_id=?` 级联；fork 子会话 `parent_session_id` 置 NULL → `session.delete` 审计 `{sessionId, ompSessionFile, messageCount}`，审计失败整体回滚）→ 提交后 `unlink` 当前 `omp_session_file`（为 NULL 跳过；ENOENT 视为成功；其它错误经 `onError` 上报仍 204）→ `finally` 释放占用与墓碑 → 204 无 body；之后该 id 的 messages/events/PATCH/DELETE 与未知 id 相同地 404。验证：新建 `server/test/session-delete.test.ts`（supervisor + fake-omp + production `createApp` inject）：未登录 401、他人与未知 id 404 且 supervisor 未被调用（spy）；idle 会话（空闲进程存活）删除后进程退出、两个 SSE 订阅者连接结束且无任何事件、行与文件消失、`GET /api/audit` 对管理员返回 `session.delete` 且 `detail` 恰为 `{sessionId, ompSessionFile, messageCount}`、非管理员不可见、再 DELETE 404、PATCH 404、fork 子会话保留且 parent 为 NULL；`omp_session_file` 为 NULL（从未派发）→ 204；带格式良好 JSON body 的 DELETE → 忽略、204；在 retire 与删行之间注入一次 `GET …/events` → 连接立即结束、无事件；删除事务注入失败 → 通用 5xx、行保留（进程已回收）、占用已释放；审计写入注入失败 → 该窗口内注入的一次 `GET …/events` 仍立即结束且无事件、DELETE 通用 5xx、此后新 `GET …/events` 订阅正常建立（墓碑已解除）；「审计形状」整轮：`{workspaceId, scene:"office"}` 创建 → fake `thinking` 场景 prompt 至 done → DELETE → `GET /api/audit?limit=2` 依次为 `session.delete`（`detail.messageCount` 2）与 `session.bind`，非管理员不可见；production `createApp` 下带 malformed JSON body 的 DELETE → 通用 500、行/审计/进程不变，随后无 body 的 DELETE → 204；占用被他路持有 → 409 无副作用；running 会话 → 过渡期 409、进程/行/订阅不变；unlink 非 ENOENT 失败 → 204 + 错误上报；`server/test/linux/uid-isolation.test.ts` 新增「sudo 模式删除会话后会话文件不存在」用例（Linux CI job 证据；design Open Questions 3）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | DELETE 合同（204/401/404/409/5xx、body 忽略） → 证据 1、2、4 |
| Auth / permissions / secrets | yes | owner 预检先于 supervisor、审计可见规则、跨 uid unlink → 证据 1、2、10、11 |
| Concurrency / shared state / ordering | yes | 控制占用、墓碑窗口、retire 期间并发请求 → 证据 5、6、7、8 |
| Error handling / rollback / partial outputs | yes | 删除事务/审计失败整体回滚、占用与墓碑释放、unlink 失败上报 → 证据 6、9 |
| File IO / path safety / overwrite | yes | 提交后 unlink、unlink 前路径校验、ENOENT、非 ENOENT、跨 uid → 证据 2、3、9、11、13 |
| Legacy compatibility / examples | yes | 既有路由与测试冻结、`#translate` 移出映射不变 → 证据 12 |
| Resource limits / large input / discovery | no | 不设 bodyLimit（非归属，默认 1 MiB → 通用 500，证据 4 覆盖 malformed） |
| Schema / columns / units / field names | no | 外键与列由 032/034/035 提供 |
| Config / project setup | no | 装配只在 `index.ts` 内传依赖 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试写进新建的 `server/test/session-delete.test.ts`（≤800 行，超出则拆第二个新文件）；`server/test/linux/uid-isolation.test.ts` 按增长例外新增一例；其余既有测试文件零改动，唯一既有测试改动为 `server/test/session-rest-helpers.ts:59` harness 接线一处。
- [ ] RED 集合以 design「Required evidence」的划分为准：先在实现前跑红，再实现跑绿（记录命令与结果）；其余按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR CI `uid-isolation` job 绿；`openspec validate session-delete-idle --strict --no-interactive` 通过。
