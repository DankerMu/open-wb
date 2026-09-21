-- 会话/消息/步骤三表。同名冲突必须使本迁移事务失败，不得静默接受未知状态。
-- TEXT PRIMARY KEY 必须显式 NOT NULL：SQLite TEXT PK 本身不拒绝 NULL。
-- 仅会话时间戳/stream_epoch 与 step ordinal 有非负约束；消息与步骤时间戳只约束整数类型。
-- 事务与回执由 runner 所有，本文件不含 BEGIN/COMMIT 或 IF NOT EXISTS。

CREATE TABLE chat_sessions (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  omp_session_file TEXT,
  stream_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK (
    typeof(id) = 'text'
    AND length(id) = 32
    AND instr(id, char(0)) = 0
    AND id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (status IN ('idle', 'running', 'done', 'failed')),
  CHECK (typeof(stream_epoch) = 'integer' AND stream_epoch >= 0),
  CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE INDEX chat_sessions_owner_updated ON chat_sessions(owner_id, updated_at DESC);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  CHECK (role IN ('user', 'assistant')),
  CHECK (status IN ('done', 'running', 'failed')),
  CHECK (typeof(created_at) = 'integer')
);

CREATE INDEX chat_messages_session_history ON chat_messages(session_id, created_at, id);

CREATE TABLE chat_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  UNIQUE (message_id, ordinal),
  CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  CHECK (status IN ('running', 'done', 'failed')),
  CHECK (typeof(started_at) = 'integer'),
  CHECK (ended_at IS NULL OR typeof(ended_at) = 'integer')
);
