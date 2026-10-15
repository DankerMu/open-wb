-- 思考时长列（issue 1439，chat-thinking-status-stream design D4「迁移 044」）：一条助手消息思考段的毫秒时长。
-- 可空、无 DEFAULT、无索引：旧行、用户行与没有思考的助手行读作 NULL，不回填。
-- 不带 CHECK：取值由应用层在写入时保证（042、043 的先例）。本迁移只加列，读写方随后续切片加入。
-- 只用一条 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读写这一列。

ALTER TABLE chat_messages ADD COLUMN thinking_ms INTEGER;
