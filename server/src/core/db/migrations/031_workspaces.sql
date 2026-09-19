-- 工作空间身份与按 owner 隔离的 name/dir 唯一性。同名冲突必须使本迁移事务失败，
-- 不得静默接受未知状态。id 必须显式 NOT NULL：SQLite TEXT PRIMARY KEY 本身不拒绝 NULL。
-- name 允许普通 Unicode/空格/斜杠，但拒绝 U+0000–U+001F 与 U+007F；dir 精确匹配 D5 字母表。

CREATE TABLE workspaces (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (owner_id, name),
  UNIQUE (owner_id, dir),
  FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK (
    typeof(id) = 'text'
    AND length(id) = 32
    AND instr(id, char(0)) = 0
    AND id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(name) = 'text'
    AND length(name) BETWEEN 1 AND 64
    AND instr(name, char(0)) = 0
    AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  ),
  CHECK (
    typeof(dir) = 'text'
    AND length(dir) BETWEEN 1 AND 64
    AND instr(dir, char(0)) = 0
    AND dir NOT IN ('.', '..')
    AND dir NOT GLOB '*[^A-Za-z0-9_一-龥-]*'
  ),
  CHECK (typeof(created_at) = 'integer')
);
