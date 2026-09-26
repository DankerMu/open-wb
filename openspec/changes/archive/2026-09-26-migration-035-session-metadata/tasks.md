# Tasks: migration-035-session-metadata（#510）

## 1. 迁移 035（父 tasks 1.1 原文）

- [ ] 1.1 `server/src/core/db/migrations/035_chat_session_metadata.sql`：按 design D1 五条 `ALTER TABLE … ADD COLUMN`（`chat_sessions.workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`、`scene TEXT CHECK(...)`、`pinned_at INTEGER CHECK(...)`、`chat_messages.thinking TEXT`、`chat_steps.changes TEXT`），无 DEFAULT/NOT NULL/索引；A 的 034 之后第九条回执。`server/test/core-db-helpers.ts:13-23` 增 `MIGRATION_035` 进 `TRACKED_MIGRATION_FILENAMES`、:70-77 回执表增 `[9, MIGRATION_035]`、`sequenceRows` 为 9；`core-db-chat-schema.test.ts` 顺序断言追加第九条（改期望值）。验证：新建 `server/test/core-db-session-metadata.test.ts`：新库与「带数据的 034 库」（含 fork 子会话、带审批的消息、带 detail/output 的步骤，两个所有者）升级后五列存在且可空、旧行全 NULL、既有列值/行数/外键/级联/唯一约束/索引/`sqlite_sequence` 不变、`PRAGMA foreign_key_check` 为空、重开目录稳定；回执止于 `033` 的库同次运行先 034 后 035；`035` 中途失败（一次性副本中预置冲突对象，如既有 `chat_sessions.scene` 列）→ 无 035 列与回执残留、034 及更早回执与行保留，移除冲突对象后重试恰应用一次；`workspace_id` 写入不存在的工作空间 id 被外键拒绝；删一行 `workspaces` 后引用它的会话 `workspace_id` 变 NULL 而会话与消息仍在；删除账号仍级联其工作空间、会话、消息、步骤与审批；`scene` 取 `chat`/`Office`/`''`、`pinned_at` 取 `-1`/`1.5`/`'x'` 被拒；`thinking`/`changes` 任意文本可写

## 2. Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Schema / columns / units / field names | yes | 五个新列的类型/可空/默认/FK/CHECK → 新测试「新库」「约束」「级联」用例 |
| Error handling / rollback / partial outputs | yes | 035 中途失败必须原子 → 「中途失败」用例（预置 `chat_sessions.scene` + 重试恰一次） |
| Legacy compatibility / examples | yes | 带数据 034 库逐行逐列不变、新列 NULL、序列不变 → 「带数据 034 库升级」用例；既有迁移测试按 design「Sibling surfaces」联动后全绿 |
| Concurrency / shared state / ordering | yes | 账本连续前缀：035 只能在 034 之后 → 「回执止于 033 的库同次先 034 后 035」用例 |
| Release / packaging / dependency compatibility | yes | 生产产物须携带新 SQL → `npm run build --workspace server` 后 `ls server/dist/**/migrations/035_chat_session_metadata.sql` 存在 |
| Public API / CLI / script entry | no | 无 REST/CLI 改动（列投影归 5.1） |
| Config / project setup | no | 无配置项 |
| File IO / path safety / overwrite | no | 不涉文件路径 |
| Auth / permissions / secrets | no | 所有者一致性不由 FK 保证，归 4.1 `rootOf`；账号级联只作为保持项由「级联」用例验证 |
| Resource limits / large input / discovery | no | `ADD COLUMN` 只改 schema 文本，O(1)，无新限额 |
| Documentation / migration notes | no | 不可逆与备份要求写入 SQL 文件头注释；父 design Migration Plan 已载，无额外文档 |

## 3. 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/core-db-session-metadata.test.ts`；既有测试文件只允许 design「Sibling surfaces · 既有测试」列出的联动（期望值 +035、精确列清单末尾追加新列、种子过滤多排除 035、helper 常量），不删、不放宽任何断言；每处列入 PR `偏离记录`。
- [ ] SQL 文件不含 `BEGIN`/`COMMIT`/`ROLLBACK`/`PRAGMA`/`IF NOT EXISTS`；五条语句顺序与 design 一致。
- [ ] 每条新断言先在无 035 文件时跑红，再加 035 跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`npm run build --workspace server`（产物含 035）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate migration-035-session-metadata --strict --no-interactive` 通过。
