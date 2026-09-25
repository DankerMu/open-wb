-- 步骤工具输出列（#367）：detail 只存 args，output 存 result 归一化文本。
-- 可空、无 DEFAULT、无 CHECK：旧行读作 NULL，不回填；SQLite 此形态 ADD COLUMN 只改元数据。
-- 事务与回执由 runner 所有，本文件不含 BEGIN/COMMIT。

ALTER TABLE chat_steps ADD COLUMN output TEXT;
