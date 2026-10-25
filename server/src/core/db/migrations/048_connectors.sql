-- MCP 连接器（s1d-connectors design D1；connectors「迁移 048 连接器 schema」）：
-- connectors 存管理员全局登记的连接器（不属于任何账号），name 为主键（D2：只有小写字母，创建后不可改），
-- 至多 32 行由 store 在插入前计数。type 决定形状：stdio 有 command（args / env 可有），url / headers 必须为空；
-- http 有 url（headers 可有），command / args / env 必须为空。args 是 JSON 字符串数组文本，env / headers 是键已
-- 排序的 JSON 对象文本（凭证只在这两列；取值规则由 connectors/validate.ts 校验）。probe_* 三列是最近一次探活。
-- account_connector_prefs 每个账号至多一行，存账号缺省停用的连接器；没有行 = []。
-- chat_sessions 加 disabled_connectors（缺省 '[]'：既有会话不停用任何连接器，行为不变）。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。主键不用 AUTOINCREMENT，sqlite_sequence 不增行。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 048 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）；回退代码时保留本文件，两表一列留着无害。

CREATE TABLE connectors (
  name TEXT NOT NULL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('stdio','http')),
  description TEXT NOT NULL,
  command TEXT NULL,
  args TEXT NULL,
  env TEXT NULL,
  url TEXT NULL,
  headers TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')),
  probe_at INTEGER NULL,
  probe_message TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (type = 'stdio' AND command IS NOT NULL AND url IS NULL AND headers IS NULL)
    OR (type = 'http' AND url IS NOT NULL AND command IS NULL AND args IS NULL AND env IS NULL)
  )
);

CREATE TABLE account_connector_prefs (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  disabled_connectors TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE chat_sessions ADD COLUMN disabled_connectors TEXT NOT NULL DEFAULT '[]';
