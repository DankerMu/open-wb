-- 账号最近选择表（#994，s1g-composer-capabilities design D4「迁移 041」）：每个账号至多一行，存最近一次选的审批档位、模型、推理强度。
-- 主键即账号 id，随账号级联删除；没有行表示该账号从未做过选择，三个选择列各自可空、无 DEFAULT。
-- approval_mode、reasoning_effort 的 CHECK 与迁移 040 的同名列相同（auto 不合法）；model_id 无 CHECK，是否在白名单内读取时再定。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。不改动任何既有表；主键不用 AUTOINCREMENT，sqlite_sequence 不增行。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读写该表。

CREATE TABLE account_composer_prefs (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  approval_mode TEXT NULL CHECK (approval_mode IN ('always-ask','write','yolo')),
  model_id TEXT NULL,
  reasoning_effort TEXT NULL CHECK (reasoning_effort IN ('off','minimal','low','medium','high','xhigh','max')),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at)='integer' AND updated_at >= 0)
);
