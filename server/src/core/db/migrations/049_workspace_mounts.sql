-- 工作空间挂载（s1b-workspace-mounts design D1；workspace-mounts「迁移 049 挂载 schema」）：
-- mount_sources 存管理员登记的服务器目录（不属于任何空间与账号），至多 32 行由 store 在插入前计数；
-- path 是登记时取的 realpath（取值与包含规则在端点）。workspace_mounts 存某个正式空间的一个挂载，
-- name 同时是挂载点目录名 <空间根>/<name>：字符规则照抄 031 workspaces.dir 的 CHECK，另排除保留名
-- uploads 与 screenshots。形状恰为二者之一：local 引用一个挂载源、没有 host / port / remote_path；
-- sftp / smb 有 host 与 remote_path、没有 source_id。workspace_id 与 source_id 用 RESTRICT：先卸载并删
-- 挂载行，才能删空间行或挂载源行；owner_id 冗余记属主，不带级联动作。
-- 两表都没有用户名、口令、私钥、域列（凭证只在 <OMP_STATE_DIR>/mounts/<id>/rclone.conf），也没有在线
-- 状态列（只在内存里）。同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。主键不用 AUTOINCREMENT，
-- sqlite_sequence 不增行。id 必须显式 NOT NULL：SQLite TEXT PRIMARY KEY 本身不拒绝 NULL。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 049 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）；回退代码时保留本文件，两张空表留着无害。

CREATE TABLE mount_sources (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  read_only INTEGER NOT NULL CHECK (read_only IN (0,1)),
  created_at INTEGER NOT NULL,
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
  CHECK (typeof(path) = 'text' AND substr(path, 1, 1) = '/'),
  CHECK (typeof(created_at) = 'integer')
);

CREATE TABLE workspace_mounts (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('sftp','smb','local')),
  host TEXT NULL,
  port INTEGER NULL CHECK (port IS NULL OR (typeof(port) = 'integer' AND port BETWEEN 1 AND 65535)),
  remote_path TEXT NULL,
  source_id TEXT NULL REFERENCES mount_sources(id) ON DELETE RESTRICT,
  read_only INTEGER NOT NULL CHECK (read_only IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name),
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
    AND name NOT IN ('.', '..')
    AND name NOT GLOB '*[^A-Za-z0-9_一-龥-]*'
    AND name NOT IN ('uploads', 'screenshots')
  ),
  CHECK (
    (backend = 'local' AND source_id IS NOT NULL AND host IS NULL AND port IS NULL AND remote_path IS NULL)
    OR (backend IN ('sftp','smb') AND source_id IS NULL AND host IS NOT NULL AND remote_path IS NOT NULL)
  ),
  CHECK (typeof(created_at) = 'integer')
);
