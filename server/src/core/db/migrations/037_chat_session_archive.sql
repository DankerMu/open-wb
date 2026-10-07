-- 会话归档时间列（#919，s1f-session-list-temp-space design D4「迁移 037」）：epoch 毫秒，NULL 表示未归档。
-- 可空、无 DEFAULT、无索引：旧行读作 NULL（未归档），不回填；CHECK 只收 NULL 或非负整数，写入规则由 session-metadata 负责。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读该列。

ALTER TABLE chat_sessions ADD COLUMN archived_at INTEGER NULL CHECK (archived_at IS NULL OR (typeof(archived_at)='integer' AND archived_at >= 0));
