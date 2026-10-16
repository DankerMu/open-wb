-- 分段位置与确认关联（issue 1469，chat-interleaved-segments design D5「迁移 045」）：步骤开始时正文已发布的长度、
-- 确认指向的步骤，以及按段存放的思考。本迁移只加列、加表，读写方随后续切片加入。
-- 两列可空、无 DEFAULT、无 CHECK、无索引（042–044 的先例）：旧行读作 NULL，不回填。step_id 不加外键：
-- 它只指向同一消息的步骤，步骤只随消息删除，而消息删除同时级联删除确认行。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 新表随消息级联删除；偏移、计数与时长非负（design D5：负数会让 web 的严格解析整体拒收快照）。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 045 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）；回退只能前滚修复、回退代码时保留本文件，或连库恢复到部署前的备份。

ALTER TABLE chat_steps ADD COLUMN body_offset INTEGER;
ALTER TABLE chat_approvals ADD COLUMN step_id INTEGER;

CREATE TABLE chat_thinking_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  body_offset INTEGER NOT NULL,
  thinking_offset INTEGER NOT NULL,
  steps_before INTEGER NOT NULL,
  thinking_length INTEGER NULL,
  thinking_ms INTEGER NULL,
  CHECK (body_offset >= 0 AND thinking_offset >= 0 AND steps_before >= 0 AND (thinking_length IS NULL OR thinking_length >= 0) AND (thinking_ms IS NULL OR thinking_ms >= 0))
);

CREATE INDEX chat_thinking_segments_message ON chat_thinking_segments(message_id);
