-- 会话任务清单列（#863，s1f-chat-surface design D10「迁移 036」）：存归一化清单的 JSON 文本。
-- 可空、无 DEFAULT、无 CHECK、无索引：旧行读作 NULL（无清单），不回填；内容规则由写入端保证。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读该列。

ALTER TABLE chat_sessions ADD COLUMN todo TEXT;
