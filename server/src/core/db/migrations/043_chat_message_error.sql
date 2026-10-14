-- 消息错误列（#909，fix-upstream-failure-surfacing design D13「迁移 043」）：失败回合的分类、状态码与净化后的上游原文。
-- 可空、无 DEFAULT、无索引：旧行、未失败与被停止的回合、启动对账置为 failed 的行读作 NULL，不回填。
-- 不带 CHECK：reason 是否在分类表内、detail 是否已净化由应用层在写入与读取时保证（042 的先例）。
-- 只用 ADD COLUMN 依次追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读写这三列。

ALTER TABLE chat_messages ADD COLUMN error_reason TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN error_status INTEGER NULL;
ALTER TABLE chat_messages ADD COLUMN error_detail TEXT NULL;
