-- 部门、项目组与知识库可见范围（#2026，s2c-kb-visibility design D1；account-groups「迁移 053 部门与项目组」、
-- knowledge-bases「迁移 053 知识库范围列」）：一个迁移让「范围列引用组表」在同一事务里成立。
-- accounts.department 可空；department、project_groups.id 与 name 的文本约束照 050 的名称写法：1–64 个字符，
-- 不含 NUL、C0 控制字符与 DEL。project_groups.created_at 为非负整数 epoch 毫秒。
-- 种子与 010 的种子账号同一先例，生产库里也有这几行（镜像 demo 的账号与项目组）：u1–u3 的部门，u4 留空；
-- 项目组 g1，成员 u1、u2。g1 的 created_at 取 0，不取墙钟（先例：050 的 kb_settings.updated_at 从 0 起）。
-- knowledge_bases.scope 缺省 'me'：既有的库升级后行为不变。scope_group_id 引用组表用 RESTRICT 而不是 CASCADE 或
-- SET NULL：删组会让共享给该组的库失去范围，S3a 的删组须先把这些库退回 'me'，数据库在此兜底拒绝。
-- 不给新列建索引、不加触发器：accounts 与 knowledge_bases 上只有唯一索引。
-- 同名冲突必须使本迁移事务失败，所以建表、加列与种子写入都不带存在性或冲突豁免子句。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 053 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）。更早的迁移文件一律不改。
-- 语句次序固定（迁移测试的中途失败用例依赖它）。

ALTER TABLE accounts ADD COLUMN department TEXT NULL CHECK (
  department IS NULL
  OR (
    typeof(department) = 'text'
    AND length(department) BETWEEN 1 AND 64
    AND instr(department, char(0)) = 0
    AND department NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  )
);

CREATE TABLE project_groups (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (
    typeof(id) = 'text'
    AND length(id) BETWEEN 1 AND 64
    AND instr(id, char(0)) = 0
    AND id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  ),
  CHECK (
    typeof(name) = 'text'
    AND length(name) BETWEEN 1 AND 64
    AND instr(name, char(0)) = 0
    AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  )
);

CREATE TABLE project_group_members (
  group_id TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, account_id)
);

CREATE INDEX project_group_members_account ON project_group_members(account_id);

ALTER TABLE knowledge_bases ADD COLUMN scope TEXT NOT NULL DEFAULT 'me' CHECK (scope IN ('me','dept','group','all'));

ALTER TABLE knowledge_bases ADD COLUMN scope_group_id TEXT NULL REFERENCES project_groups(id) ON DELETE RESTRICT CHECK ((scope = 'group') = (scope_group_id IS NOT NULL));

UPDATE accounts SET department = CASE id
  WHEN 'u1' THEN '平台研发部'
  WHEN 'u2' THEN '数据部'
  WHEN 'u3' THEN '产品部'
END
WHERE id IN ('u1', 'u2', 'u3');

INSERT INTO project_groups(id, name, created_at) VALUES ('g1', '内网落地专项', 0);

INSERT INTO project_group_members(group_id, account_id) VALUES ('g1', 'u1'), ('g1', 'u2');
