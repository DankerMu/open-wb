-- 知识库检索参数与重排模型（s2b-kb-retrieval design D5；knowledge-bases「迁移 051 检索参数与重排模型」）。
-- 只用 ADD COLUMN 追加到两张既有表末尾，不重建表、不改其它表、不插入或改写任何行：既有列、约束、索引不动。
-- knowledge_bases 的两列：既有行取列缺省 0.2 / 0.7（不迁移旧行为）。REAL 亲和性把整数 0、1 存成 real，
-- typeof 检查对两端值成立；数字形态的文本（如 '0.3'）在 CHECK 之前被转成 real，所以 CHECK 拦的是越界数值与
-- 非数字文本，字符串形式的参数由端点的 body 校验判为 400，不靠这一层。
-- kb_settings 的重排三列（名称、地址、密钥）同为 NULL 或同为非 NULL：ADD COLUMN 加不了表级 CHECK，由 store
-- 整组写入保证；密钥与 DB 文件同一信任级别，同 046 / 050。探活三列与嵌入模型的探活三列同形。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置；任一语句失败则整体回滚。迁移本身不逆转：
-- 回退代码时保留本文件，几列留着无害。

ALTER TABLE knowledge_bases ADD COLUMN retrieval_threshold REAL NOT NULL DEFAULT 0.2
  CHECK (typeof(retrieval_threshold) = 'real' AND retrieval_threshold BETWEEN 0 AND 1);
ALTER TABLE knowledge_bases ADD COLUMN retrieval_vector_weight REAL NOT NULL DEFAULT 0.7
  CHECK (typeof(retrieval_vector_weight) = 'real' AND retrieval_vector_weight BETWEEN 0 AND 1);
ALTER TABLE kb_settings ADD COLUMN rerank_name TEXT NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_base_url TEXT NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_api_key TEXT NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_probe_status TEXT NOT NULL DEFAULT 'never'
  CHECK (rerank_probe_status IN ('never','ok','failed'));
ALTER TABLE kb_settings ADD COLUMN rerank_probe_at INTEGER NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_probe_message TEXT NULL;
