-- 知识库（s2a-kb-ragflow design D6、D8、D9；knowledge-bases「迁移 050 知识库 schema」）：kb_settings 恒为
-- id = 'kb' 的唯一一行，存全局嵌入模型（密钥与 DB 文件同一信任级别，DB 0600，同 046）、嵌入代数、知识库对话
-- 模型的引用与 rebuild_actor_id（最近一次发起或重试重建的管理员，重建器写审计时用，audit_events.actor_id
-- NOT NULL）。updated_at 从 0 起，表示还没保存过。不为 RAGFlow 加列：模型实例名是常量（D7）。
-- knowledge_bases 存两组 RAGFlow id：当前一代的 dataset_id、canvas_id、template_group_id，重建中新一代的
-- rebuild_* 三列。两个开关都为 0 的库，画布与模板组的列都是 NULL。template 的 CHECK 是十一种模板，不含 tag
-- 与 audio（D9）。每账号 50 个、每库 500 份由调用方在锁内、插行之前计数（D6、D20）。
-- kb_documents 的 workspace 与 upload 两种形状恰为二者之一：workspace 的三列全有，upload 的三列全无。
-- source_mtime_ms 不加 typeof：INTEGER 亲和性保留 fstat 的小数毫秒，入库记录才能与 mtimeMs 精确比较（D12）。
-- workspace_id 不加外键：工作空间删除后，文档是入库快照，照常保留（D6）。
-- UNIQUE (kb_id, workspace_id, source_path) 里 NULL 互不相等，所以只约束 workspace 来源，同名上传不受限。
-- 同名冲突必须使本迁移事务失败：不含 IF NOT EXISTS。主键不用 AUTOINCREMENT，sqlite_sequence 不增行。id 必须
-- 显式 NOT NULL：SQLite TEXT PRIMARY KEY 本身不拒绝 NULL。
-- 事务与回执由 runner 所有：本文件不含事务语句，也不改连接级设置。迁移本身不逆转：已应用 050 的库不能交给
-- 不含本文件的旧构建（账本拒收多出的回执）；回退代码时保留本文件，几张表留着无害。

CREATE TABLE kb_settings (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'kb'),
  embedding_name TEXT NULL,
  embedding_base_url TEXT NULL,
  embedding_api_key TEXT NULL,
  embedding_generation INTEGER NOT NULL DEFAULT 0 CHECK (typeof(embedding_generation) = 'integer'),
  embedding_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (embedding_probe_status IN ('never','ok','failed')),
  embedding_probe_at INTEGER NULL,
  embedding_probe_message TEXT NULL,
  chat_model_id TEXT NULL REFERENCES models(id) ON DELETE SET NULL,
  rebuild_actor_id TEXT NULL REFERENCES accounts(id),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  CHECK (
    (embedding_name IS NULL) = (embedding_base_url IS NULL)
    AND (embedding_name IS NULL) = (embedding_api_key IS NULL)
  )
);

INSERT INTO kb_settings(id, updated_at) VALUES ('kb', 0);

CREATE TABLE knowledge_bases (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  template TEXT NOT NULL CHECK (template IN ('naive','book','email','laws','manual','one','paper','picture','presentation','qa','table')),
  raptor INTEGER NOT NULL CHECK (raptor IN (0,1)),
  graph INTEGER NOT NULL CHECK (graph IN (0,1)),
  dataset_id TEXT NOT NULL,
  rebuild_dataset_id TEXT NULL,
  canvas_id TEXT NULL,
  template_group_id TEXT NULL,
  rebuild_canvas_id TEXT NULL,
  rebuild_template_group_id TEXT NULL,
  embedding_generation INTEGER NOT NULL CHECK (typeof(embedding_generation) = 'integer'),
  state TEXT NOT NULL CHECK (state IN ('ready','rebuilding','rebuild_failed')),
  state_message TEXT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer'),
  UNIQUE (owner_id, name),
  CHECK (
    typeof(id) = 'text'
    AND length(id) = 32
    AND instr(id, char(0)) = 0
    AND id NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(name) = 'text'
    AND length(name) BETWEEN 1 AND 64
    AND instr(name, char(0)) = 0
    AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  ),
  CHECK (
    (canvas_id IS NULL) = (template_group_id IS NULL)
    AND (canvas_id IS NULL) = (raptor = 0 AND graph = 0)
  ),
  CHECK (
    (rebuild_canvas_id IS NULL) = (rebuild_template_group_id IS NULL)
    AND (rebuild_canvas_id IS NULL) = (rebuild_dataset_id IS NULL OR (raptor = 0 AND graph = 0))
  )
);

CREATE TABLE kb_documents (
  id TEXT NOT NULL PRIMARY KEY,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  ragflow_document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (typeof(size) = 'integer'),
  source TEXT NOT NULL CHECK (source IN ('workspace','upload')),
  workspace_id TEXT NULL,
  source_path TEXT NULL,
  source_mtime_ms INTEGER NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  UNIQUE (kb_id, workspace_id, source_path),
  CHECK (
    (source = 'workspace') = (workspace_id IS NOT NULL)
    AND (source = 'workspace') = (source_path IS NOT NULL)
    AND (source = 'workspace') = (source_mtime_ms IS NOT NULL)
  )
);
