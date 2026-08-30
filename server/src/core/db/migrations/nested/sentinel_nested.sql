-- 验证数据（非生产迁移源）：嵌套 .sql 文件。migrations/ 发现规则只取直属文件，
-- 本文件必须被忽略。若被误当作迁移执行，会创建 forbidden_sentinel_nested 表。
CREATE TABLE IF NOT EXISTS forbidden_sentinel_nested (id INTEGER PRIMARY KEY);
