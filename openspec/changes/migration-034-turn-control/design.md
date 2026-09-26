# Design: migration-034-turn-control（#449）

权威配方见父 design D2「迁移 034」(1)–(6) 与 Migration Plan；本文件只写本切片的审查面。

- **Change surface**：`server/src/core/db/migrations/034_chat_turn_control.sql`（新）；由 `server/src/core/db/index.ts` `openDb` → `migration-runner.ts` 在其事务内执行（二者不改）。
- **Must preserve**：032/033 的全部列、默认值、NOT NULL、主键、AUTOINCREMENT、FK 与 `ON DELETE CASCADE`、`UNIQUE(message_id,ordinal)`、`owner_id,updated_at DESC` 与 `(session_id,created_at,id)` 两个索引；三张表的**列顺序**不变（`chat_steps.output` 仍在 `ended_at` 之后，033 requirement 规定），`parent_session_id` 作为 `chat_sessions` **最后一列**；既有七条回执与业务数据逐字节不变；已删除的 message/step id 永不复用；`accounts` 删除仍级联到会话/消息/步骤；032/033 文件不改。
- **Must add/change**：三处 status CHECK 扩 `stopped`；`chat_sessions.parent_session_id TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL`；`chat_approvals`（列/约束见 spec）+ `message_id` 索引；第八条回执 `034`。
- **Governing invariant**：034 要么整体提交（三表行、序列高水位、FK 目标全为最终表名、`chat_approvals` 就位、回执八条），要么什么都不留（无 `_next`、无 `chat_approvals`、无 034 回执，原三表/行/序列不变）。
- **Sibling surfaces**：
  - 生产者：runner 事务（`BEGIN`/`COMMIT`/ROLLBACK）——不改，但 034 不得自带事务语句或 `PRAGMA foreign_keys`。
  - 存储：`sqlite_sequence`（DROP 会删行 → 必须在 DROP 前读、RENAME 后写）；`sqlite_master` 中 FK 文本（RENAME 在 `legacy_alter_table=OFF` 下改写）。
  - 消费者：`server/src/sessions/store.ts` 读写三表（既有列集与顺序不变故无需改）。
  - 既有迁移测试（允许的最小联动，不删断言、不放宽其它条件）：`server/test/core-db-helpers.ts` 增 `MIGRATION_034`，`TRACKED_MIGRATION_FILENAMES`/`COMPLETE_CATALOG` 回执与 `sequenceRows` 7→8；`core-db-chat-schema.test.ts:214-216` 与 `core-db-chat-step-output.test.ts:57` 的种子过滤条件再排除 034（否则 034 在 033 之前的 schema 上执行）；`core-db-chat-schema.test.ts` `columnInfo(db,"chat_sessions")` 期望末尾加 `parent_session_id` 行；其余回执/计数断言改期望值。
  - `sqlite_sequence` 空表语义：表从未插入过行时 `max(seq,max(id))` 为 NULL，步骤 (5) SHALL 不写该表的序列行（与 AUTOINCREMENT 从未使用时一致），绝不写 `seq` 为 NULL 的行。
  - 失败路径：中途冲突对象（预建 `chat_messages_next` 或 `chat_approvals`）→ runner 回滚。
- **Seams under test**：`openDb`（公共入口）+ 原始 SQL 探查（`PRAGMA foreign_key_list`/`foreign_key_check`/`sqlite_sequence`/`sqlite_master`），真实临时文件 SQLite，不 mock 迁移。
- **Required evidence**（逐条对应 spec Scenario）：
  - 新库与 033 升级库各做一次 `PRAGMA table_info(chat_sessions|chat_messages|chat_steps|chat_approvals)` → 列名/类型/NOT NULL/默认值/主键按顺序与期望完全相等（`parent_session_id` 为 `chat_sessions` 末列）。
  - 新库 → `sqlite_sequence` 中无 `chat_messages`/`chat_steps` 行；混合 033 库（`chat_messages` 有行、`chat_steps` 从未插入）→ 升级后前者序列值不变、后者无行，两表新插入均成功且 id 单调。
  - 新库 → 回执 `0010,002,010,030,031,032,033,034`；三表接受 `stopped`、拒绝 `cancelled`；`chat_approvals` decision 只收 allow/deny/timeout、重复 `(message_id,request_id)` 被拒；`sqlite_master` 无 `_next` 引用。
  - 手工构造的 033 库（两 owner、删除后留空 id、步骤含 detail/output）→ 034 追加一次，每行既有列逐字节等价、行数相同、`parent_session_id` NULL、`foreign_key_check` 空、重开目录稳定。
  - 高水位：旧库两表 `seq > max(id)` → 升级后 `sqlite_sequence` 值不变，新插入 id 均大于旧高水位。
  - `PRAGMA foreign_key_list(chat_messages/chat_steps/chat_approvals/chat_sessions)` 目标为最终表名。
  - 预建冲突对象 → 无 `_next`、无 `chat_approvals`、无 034 回执、原数据不变；移除后重试成功一次。
  - 升级后删账户/会话级联删消息/步骤/审批；删父会话 → 子会话 `parent_session_id` 置 NULL 不删行。
- **Non-goals**：store/supervisor/REST 对新列与新表的任何读写；索引命名。
- **Review focus**：DROP（子先）/RENAME（父先）次序与 `_next` FK 指向；`sqlite_sequence` 读写时机与取值 `max(seq,max(id))`；逐列 `INSERT … SELECT`（无 `SELECT *`、列顺序对应）；无 PRAGMA、无 BEGIN/COMMIT；索引与约束与 032/033 逐项等价。
