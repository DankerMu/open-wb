-- 版本回执完整性守卫：schema_migrations 是迁移账本，任何 UPDATE 都是账本篡改。
-- 迁移基座以回执抑制重放，账本不可更新是先决规则。
CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'UPDATE on schema_migrations is forbidden');
END;
