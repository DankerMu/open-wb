-- 会话元数据列（#510，父 design D1「迁移 035」）：空间绑定、场景、置顶、深度思考、文件变更。
-- 只用 ADD COLUMN 追加到各表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 五列全部可空、无 DEFAULT、无索引：旧行读作 NULL，不回填；可空是 fork 显式列插入（4.4）的前提。
-- workspace_id 删工作空间时置 NULL（会话保留）；删账号仍经 owner_id 级联删会话。
-- 所有者一致性（会话与其工作空间同属一人）不由外键保证，由写入端校验。
-- 运维：升级前务必备份 DB 文件；本迁移不可逆，回滚 = 恢复备份 + 回退代码。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置；任一语句失败则整体回滚。

ALTER TABLE chat_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN scene TEXT CHECK (scene IS NULL OR scene IN ('office','code','design'));
ALTER TABLE chat_sessions ADD COLUMN pinned_at INTEGER CHECK (pinned_at IS NULL OR (typeof(pinned_at) = 'integer' AND pinned_at >= 0));
ALTER TABLE chat_messages ADD COLUMN thinking TEXT;
ALTER TABLE chat_steps ADD COLUMN changes TEXT;
