-- 模型注册表（s1d-model-registry design D3；model-registry「迁移 046 模型表」）：管理员登记的对话模型，
-- 每行自带 OpenAI 兼容上游（base URL + 密钥）。本迁移只建这张表与缺省模型的部分唯一索引，不回填、不改其它表；
-- 首次启动的环境种子由启动阶段 model_registry 写入（不在迁移里）。
-- efforts 是 JSON 数组文本；NULL = 不声明强度集合（非推理模型恒为 NULL，推理模型可为 NULL）。
-- 上游两列同为 NULL 或同非 NULL；至多一行 is_default = 1（「恰一行」由 store 维护）；≤32 行由 store 在插入前计数。
-- 列表次序 ORDER BY created_at, id。密钥与 DB 文件同一信任级别（DB 0600，ADR-0008 补充）。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 046 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）；回退只能前滚修复、回退代码时保留本文件，或连库恢复到部署前的备份。

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  reasoning INTEGER NOT NULL CHECK (reasoning IN (0,1)),
  vision INTEGER NOT NULL CHECK (vision IN (0,1)),
  max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 128000),
  efforts TEXT NULL,
  upstream_base_url TEXT NULL,
  upstream_api_key TEXT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')),
  probe_at INTEGER NULL,
  probe_message TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((upstream_base_url IS NULL) = (upstream_api_key IS NULL))
);

CREATE UNIQUE INDEX models_default ON models(is_default) WHERE is_default = 1;
