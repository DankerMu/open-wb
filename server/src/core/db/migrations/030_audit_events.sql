-- 只追加审计表：普通 INSERT 写入合法事件；UPDATE/DELETE 与被引用账号删除必须失败。
-- 同名冲突必须使本迁移事务失败，不得静默接受未知状态。workspace_id 可空，尚无 workspaces 表故不加 FK。
-- kind 为至少两段小写点分标识：[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*)+。

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  workspace_id TEXT,
  FOREIGN KEY (actor_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CHECK (typeof(ts) = 'integer' AND ts >= 0),
  CHECK (typeof(actor_id) = 'text' AND length(actor_id) > 0),
  CHECK (typeof(detail) = 'text' AND json_valid(detail)),
  CHECK (
    typeof(kind) = 'text'
    AND length(kind) > 0
    AND instr(kind, char(0)) = 0
    AND kind GLOB '[a-z]*'
    AND kind NOT GLOB '*[^a-z0-9_.]*'
    AND kind NOT GLOB '*.'
    AND kind NOT GLOB '.*'
    AND kind NOT GLOB '*..*'
    AND instr(kind, '.') > 0
    AND kind NOT GLOB '*.[0-9_]*'
  )
);

CREATE INDEX audit_events_actor_id ON audit_events(actor_id, id DESC);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
