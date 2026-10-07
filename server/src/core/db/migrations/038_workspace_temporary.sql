-- 工作空间临时标记列（#920，s1f-session-list-temp-space design D6「迁移 038」）：1 表示临时空间，0 表示正式空间。
-- NOT NULL DEFAULT 0、无索引：既有行读作 0（正式空间），不回填；CHECK 只收 0 与 1，谁写 1 由 temporary-workspaces 负责。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：031 的列顺序、约束与两个唯一索引不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读该列。

ALTER TABLE workspaces ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0 CHECK (temporary IN (0,1));
