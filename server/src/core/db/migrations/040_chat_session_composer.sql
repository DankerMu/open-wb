-- 会话输入框设置三列（#993，s1g-composer-capabilities design D3「迁移 040」）：审批档位、模型、推理强度，存用户的原始选择。
-- 都可空、无 DEFAULT、无索引：旧行读作 NULL（未选择），不回填；对外使用的值由 session-composer-settings「有效值解析」算出。
-- approval_mode 只收三个档位名，reasoning_effort 只收七个强度名（auto 不合法）；model_id 无 CHECK，是否在白名单内读取时再定。
-- 只用 ADD COLUMN 追加到表末尾，不重建表：既有列顺序、约束、索引与 sqlite_sequence 不动。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。回滚 = 不再读这三列。

ALTER TABLE chat_sessions ADD COLUMN approval_mode TEXT NULL CHECK (approval_mode IN ('always-ask','write','yolo'));
ALTER TABLE chat_sessions ADD COLUMN model_id TEXT NULL;
ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT NULL CHECK (reasoning_effort IN ('off','minimal','low','medium','high','xhigh','max'));
