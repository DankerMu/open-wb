-- 回合控制 schema（#449，父 design D2「迁移 034」配方 (1)–(6)）：
--   三处 status CHECK 扩为含 'stopped'；chat_sessions 末列新增 parent_session_id（ON DELETE SET NULL）；
--   新建 chat_approvals（消息删除级联）。
-- SQLite 不能 ALTER CHECK，故重建 chat_sessions/chat_messages/chat_steps：
--   (1) 建 *_next 三表，FK 指向 _next 父表（owner_id 仍指 accounts），此时不建索引；
--   (2) 父表优先逐列 INSERT … SELECT；任何 DROP 之前把 chat_messages/chat_steps 的
--       max(旧 sqlite_sequence.seq, max(id)) 暂存到连接私有的 TEMP 表（DROP 会删掉该表的序列行）；
--   (3) 子表优先 DROP 旧表（steps → messages → sessions），旧子表已先删，级联无行可删；
--   (4) 父表优先 RENAME（sessions → messages → steps），legacy_alter_table=OFF 下子表 FK 改写为最终表名；
--   (5) 用暂存值显式写两表 sqlite_sequence 高水位；从未插入过行（值为 NULL）的表不写序列行；
--   (6) 建 chat_approvals 及其 message_id 索引，重建三表索引（沿用 032 的索引名）。
-- 列顺序与 032/033 相同（chat_steps.output 在 ended_at 之后），parent_session_id 为 chat_sessions 末列。
-- 运维：升级前务必备份 DB 文件；本迁移不可逆，回滚 = 恢复备份 + 回退代码。
-- 事务与回执由 runner 所有：本文件不含 BEGIN/COMMIT，也不写 PRAGMA foreign_keys（事务内无效），
-- 正确性只依赖上述 DROP/RENAME 次序；任一语句失败则整个迁移随 runner 事务回滚。

-- (1) _next 表：显式列出全部列/默认值/NOT NULL/主键/AUTOINCREMENT/FK/级联/UNIQUE/CHECK。
CREATE TABLE chat_sessions_next (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  omp_session_file TEXT,
  stream_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  parent_session_id TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_session_id) REFERENCES chat_sessions_next(id) ON DELETE SET NULL,
  CHECK (
    typeof(id) = 'text'
    AND length(id) = 32
    AND instr(id, char(0)) = 0
    AND id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (status IN ('idle', 'running', 'done', 'failed', 'stopped')),
  CHECK (typeof(stream_epoch) = 'integer' AND stream_epoch >= 0),
  CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE TABLE chat_messages_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions_next(id) ON DELETE CASCADE,
  CHECK (role IN ('user', 'assistant')),
  CHECK (status IN ('done', 'running', 'failed', 'stopped')),
  CHECK (typeof(created_at) = 'integer')
);

CREATE TABLE chat_steps_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  output TEXT,
  FOREIGN KEY (message_id) REFERENCES chat_messages_next(id) ON DELETE CASCADE,
  UNIQUE (message_id, ordinal),
  CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
  CHECK (status IN ('running', 'done', 'failed', 'stopped')),
  CHECK (typeof(started_at) = 'integer'),
  CHECK (ended_at IS NULL OR typeof(ended_at) = 'integer')
);

-- (2) 父表优先逐列复制；既有行 parent_session_id 取列默认 NULL。
INSERT INTO chat_sessions_next (
  id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at
)
SELECT id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at
FROM chat_sessions;

INSERT INTO chat_messages_next (id, session_id, role, content, status, created_at)
SELECT id, session_id, role, content, status, created_at
FROM chat_messages;

INSERT INTO chat_steps_next (
  id, message_id, ordinal, name, detail, status, started_at, ended_at, output
)
SELECT id, message_id, ordinal, name, detail, status, started_at, ended_at, output
FROM chat_steps;

-- (2) 高水位暂存：聚合 max 忽略 NULL，seq 与 max(id) 皆无时为 NULL（表从未插入过行）。
CREATE TEMP TABLE chat_turn_control_high_water (
  name TEXT NOT NULL PRIMARY KEY,
  seq INTEGER
);

INSERT INTO chat_turn_control_high_water (name, seq)
SELECT 'chat_messages', max(value)
FROM (
  SELECT seq AS value FROM sqlite_sequence WHERE name = 'chat_messages'
  UNION ALL
  SELECT max(id) FROM chat_messages
);

INSERT INTO chat_turn_control_high_water (name, seq)
SELECT 'chat_steps', max(value)
FROM (
  SELECT seq AS value FROM sqlite_sequence WHERE name = 'chat_steps'
  UNION ALL
  SELECT max(id) FROM chat_steps
);

-- (3) 子表优先 DROP。
DROP TABLE chat_steps;
DROP TABLE chat_messages;
DROP TABLE chat_sessions;

-- (4) 父表优先 RENAME。
ALTER TABLE chat_sessions_next RENAME TO chat_sessions;
ALTER TABLE chat_messages_next RENAME TO chat_messages;
ALTER TABLE chat_steps_next RENAME TO chat_steps;

-- (5) 显式写高水位：先清掉复制时为 _next 自动生成、随 RENAME 改名的序列行，再写暂存值。
DELETE FROM sqlite_sequence WHERE name IN ('chat_messages', 'chat_steps');

INSERT INTO sqlite_sequence (name, seq)
SELECT name, seq
FROM chat_turn_control_high_water
WHERE seq IS NOT NULL
ORDER BY name;

DROP TABLE chat_turn_control_high_water;

-- (6) 新表与索引。
CREATE TABLE chat_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decision TEXT,
  decided_at INTEGER,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  UNIQUE (message_id, request_id),
  CHECK (decision IN ('allow', 'deny', 'timeout'))
);

CREATE INDEX chat_approvals_message ON chat_approvals(message_id);

CREATE INDEX chat_sessions_owner_updated ON chat_sessions(owner_id, updated_at DESC);

CREATE INDEX chat_messages_session_history ON chat_messages(session_id, created_at, id);
