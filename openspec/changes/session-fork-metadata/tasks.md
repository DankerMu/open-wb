# Tasks: session-fork-metadata（#527）

## 4. session-metadata — fork 继承（父 tasks 4.4 原文）

- [x] 4.4 fork 继承：A 的 `server/src/sessions/store-branch.ts` fork 新会话显式列插入增 `workspace_id`、`scene`（取源会话值），`pinned_at` NULL；分叉点前消息/步骤拷贝语句分别增 `chat_messages.thinking`、`chat_steps.changes`；fork 继承不写 `session.bind` 审计；fork 201 的 `session` 为八键（投影由 5.1 提供）。验证：新建 `server/test/session-fork-metadata.test.ts`：绑定+场景+置顶的源会话 fork → 新会话 `workspaceId/scene` 相同、`pinnedAt` null、无 bind 审计；含 thinking 与 changes 的历史 fork 后逐字相等；fork 会话 prompt 的 probe `cwd=` 为源空间根

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Schema / columns / units / field names | yes | 三条显式列语句，漏列即静默丢数据 → 证据 1、3、4 |
| Public API / CLI / script entry | yes | fork 201 八键值与列表一致 → 证据 1、3 |
| Auth / permissions / secrets | yes | fork 会话 cwd 为源空间根、不写 bind 审计 → 证据 1、2 |
| Legacy compatibility / examples | yes | 未绑定 fork 与既有 fork 行为不变 → 证据 4、5 |
| Concurrency / shared state / ordering | no | 事务与 CAS 不变 |
| Error handling / rollback / partial outputs | no | 回滚路径不变（同一事务多拷两列） |
| File IO / path safety / overwrite | no | 不涉 |
| Resource limits / large input / discovery | no | 不涉 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件 `server/test/session-fork-metadata.test.ts`；既有测试文件零改动。
- [x] RED 集合以 design「Required evidence」为准：先实现前跑红，再实现跑绿（记录命令与结果）。
- [x] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-fork-metadata --strict --no-interactive` 通过。
