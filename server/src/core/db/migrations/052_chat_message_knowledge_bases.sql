-- 消息知识库引用列（#1970，s2c-kb-session design D8「迁移 052」）：用户消息引用的知识库 JSON 数组文本，元素为 {id, name}。
-- 可空、无 DEFAULT、无索引：旧行与无引用的消息读作 NULL，不回填。
-- 不带 CHECK：内容是否为合法 JSON、是否合规由应用层在写入与读取时判定（迁移 042 attachments 的先例）。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读写这一列。

ALTER TABLE chat_messages ADD COLUMN knowledge_bases TEXT NULL;
