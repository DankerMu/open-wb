-- 回合快照登记表（#942，s1f-session-list-temp-space design D9「登记」）：每条被受理的用户消息至多一行。
-- 主键即用户消息 id，随消息级联删除（会话删除经 chat_messages 传到这里）；workspace_id 随工作空间行级联删除。
-- outcome 只收 ok / too_large / failed / command；skipped、todo 的内容规则由 workspace-snapshots 负责，库里只当文本。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。不改动任何既有表；主键不用 AUTOINCREMENT，sqlite_sequence 不增行。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读写该表。

CREATE TABLE chat_turn_snapshots (
  message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','too_large','failed','command')),
  skipped TEXT NULL,
  todo TEXT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at)='integer' AND created_at >= 0)
);

CREATE INDEX chat_turn_snapshots_workspace ON chat_turn_snapshots(workspace_id);
