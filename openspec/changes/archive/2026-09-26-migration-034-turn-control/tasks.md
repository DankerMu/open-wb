# Tasks: migration-034-turn-control（#449）

## 1. 迁移 034（父 tasks 1.1 原文）

- [ ] 1.1 `server/src/core/db/migrations/034_chat_turn_control.sql`：按 design D2 配方 (1)–(6) 重建三表——(1) 建 `chat_sessions_next`/`chat_messages_next`/`chat_steps_next`，列/默认值/NOT NULL/主键/AUTOINCREMENT/FK 与级联/UNIQUE 显式列出、此时不建索引，FK 指向对应 `_next` 父表（含自引用 `parent_session_id → chat_sessions_next`，`owner_id` 仍指向 `accounts`）；(2) 按父表优先（sessions→messages→steps）逐列 `INSERT … SELECT` 复制（不用 `SELECT *`），并在任何 DROP 之前读出并暂存 `chat_messages`、`chat_steps` 各自的 `max(旧 sqlite_sequence.seq, max(id))`（DROP 会删除该表的 `sqlite_sequence` 行，之后无法再读）；(3) 全部复制完后按子表优先 DROP（steps→messages→sessions）；(4) 按父表优先 RENAME（sessions→messages→steps）；(5) 把 (2) 暂存的值显式写为两张 AUTOINCREMENT 表 `chat_messages`/`chat_steps` 的 `sqlite_sequence` 高水位（`chat_sessions` 为 TEXT 主键、无序列行）；(6) RENAME 之后再建 `chat_approvals`（含 `message_id` 索引）并重建三张被重建表的索引。事务内不写任何 `PRAGMA foreign_keys`。status CHECK 扩为含 `stopped`；新增 `chat_sessions.parent_session_id`（`ON DELETE SET NULL`）。验证（新建 `server/test/migration-034.test.ts`，真实临时 SQLite）：新库回执八条且三表接受 `stopped`/拒绝其它值；带数据的 033 库升级后每行等价、`chat_approvals` 空表就位、`PRAGMA foreign_key_check` 为空；高水位用例（旧库 `chat_messages` 与 `chat_steps` 各自 `max(id)` 低于其 `sqlite_sequence` 时，升级后两表新插入 id 均大于各自旧高水位）；在 node:sqlite 内置 SQLite 版本上断言 RENAME 后子表 FK 目标已改写为新父表名（`PRAGMA foreign_key_list`）；重建中途冲突不留半表且无 034 回执；升级后删除会话仍级联删消息/步骤（证明 DROP 未级联删数据）；删除消息级联删除其 `chat_approvals` 行

## 2. Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Schema / columns / units / field names | yes | 三表重建 + 新列 + 新表 → `migration-034.test.ts` Fresh/Populated/Stopped 用例 |
| Error handling / rollback / partial outputs | yes | 中途失败必须原子 → Mid-rebuild failure 用例（预建冲突对象 + 重试） |
| Legacy compatibility / examples | yes | 033 库带数据升级逐字节等价、id 不复用 → Populated + 高水位用例；既有 schema 测试按 §3 所列联动修改后全绿 |
| Concurrency / shared state / ordering | yes | DDL 次序（DROP 子先 / RENAME 父先 / 序列读写时机）决定 FK 与数据存活 → Foreign keys survive 用例 + `foreign_key_list` 断言 |
| Documentation / migration notes | yes | 迁移不可逆 → SQL 文件头注释写明配方与「升级前备份」；父 design Migration Plan 已载，无额外文档改动 |
| Public API / CLI / script entry | no | 无 REST/CLI 改动 |
| Config / project setup | no | 无配置项 |
| File IO / path safety / overwrite | no | 不涉文件路径 |
| Auth / permissions / secrets | no | `owner_id → accounts` 级联只作为保持项验证 |
| Resource limits / large input / discovery | no | 迁移为一次性 O(行数) 复制，无新限额 |
| Release / packaging / dependency compatibility | no | 构建已按 glob 复制 migrations/*.sql（实现时核对 server build 产物含 034，若不含则为缺陷） |

## 3. 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/migration-034.test.ts`；既有测试文件不增长，只允许 design「Sibling surfaces · 既有迁移测试」列出的四类联动（期望值 +034、`columnInfo(chat_sessions)` 末尾 +`parent_session_id`、两处种子过滤条件多排除 034、helper 增 `MIGRATION_034` 与目录清单）；不删任何断言。
- [ ] 列顺序：三表保持原列顺序，`parent_session_id` 为 `chat_sessions` 末列；新测试对新库与升级库做 `PRAGMA table_info` 顺序全等断言。
- [ ] `sqlite_sequence`：从未插入行的表不写序列行（绝无 NULL seq）；新测试覆盖新库、两表皆有行、一有一无的混合库。
- [ ] 每条新断言先在无 034 文件时跑红，再加 034 跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`npm run build --workspace server` 产物含 `034_chat_turn_control.sql`。
