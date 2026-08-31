-- 版本回执完整性守卫：schema_migrations 是迁移账本，任何 UPDATE 都是账本篡改。
-- 迁移基座以回执抑制重放，账本不可更新是先决规则。
CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'UPDATE on schema_migrations is forbidden');
END;

-- INSERT OR REPLACE 会先删后插，且默认不会递归触发 DELETE 守卫；在插入前拒绝
-- 已有 filename 或显式 sequence 的重用，保持回执身份与应用顺序只追加。
CREATE TRIGGER schema_migrations_no_reinsert
BEFORE INSERT ON schema_migrations
WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE filename = NEW.filename)
  OR EXISTS (SELECT 1 FROM schema_migrations WHERE sequence = NEW.sequence)
BEGIN
  SELECT RAISE(ABORT, 'INSERT on schema_migrations reuses an existing receipt');
END;
