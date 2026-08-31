-- 版本回执完整性守卫：schema_migrations 是迁移账本，DELETE 同样是账本篡改。
CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'DELETE on schema_migrations is forbidden');
END;

-- 只读迁移史视图：按 sequence（实际应用顺序）呈现，供审计与排查读取。
-- 注意：不使用 IF NOT EXISTS——若同名对象已存在（如预置冲突表），本迁移必须
-- 失败以暴露冲突，而不是静默跳过（静默跳过会掩盖 schema 形状与预期不符）。
CREATE VIEW schema_migration_history AS
SELECT sequence, filename, applied_at
FROM schema_migrations
ORDER BY sequence;
