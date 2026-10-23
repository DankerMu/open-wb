-- 专家与技能能力（s1d-experts-skills design D2；experts「迁移 047 专家与能力 schema」）：
-- experts 存账号自建专家（内置专家是代码常量，不进本表），随账号级联删除；列表次序 ORDER BY created_at, id，
-- 每账号 ≤50 行由 store 在插入前计数。account_skill_prefs 每个账号至多一行，存账号缺省停用技能；没有行 = []。
-- chat_sessions 加 expert_id（NULL = 无专家；不设外键：内置专家不在表里，引用的专家被删时由 store 在同一事务置 NULL）
-- 与 disabled_skills（缺省 '[]'：既有会话 = 无专家、无停用，行为不变）。
-- tags、skills、disabled_skills 都是 JSON 字符串数组文本；字段规则（码点长度、技能名、去重排序）由 store 校验。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。主键不用 AUTOINCREMENT，sqlite_sequence 不增行。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 047 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）；回退代码时保留本文件，两表两列留着无害。

CREATE TABLE experts (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('开发','办公','设计','产品')),
  tags TEXT NOT NULL,
  prompt TEXT NOT NULL,
  skills TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX experts_owner ON experts(owner_id, created_at);

CREATE TABLE account_skill_prefs (
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  disabled_skills TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE chat_sessions ADD COLUMN expert_id TEXT NULL;
ALTER TABLE chat_sessions ADD COLUMN disabled_skills TEXT NOT NULL DEFAULT '[]';
