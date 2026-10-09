-- 消息附件列（#995，s1g-composer-capabilities design D12「迁移 042」）：用户消息随附文件的 JSON 数组文本，元素为 {path, size}。
-- 可空、无 DEFAULT、无索引：旧行与无附件的消息读作 NULL，不回填。
-- 不带 CHECK：内容是否为合法 JSON、是否合规由应用层在写入与读取时判定（chat_steps.output、chat_messages.thinking 的先例）。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读写这一列。

ALTER TABLE chat_messages ADD COLUMN attachments TEXT NULL;
