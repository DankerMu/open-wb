## ADDED Requirements

### Requirement: 迁移 050 知识库 schema
`server/src/core/db/migrations/050_knowledge_bases.sql` SHALL 建三张表并只插入一行：`kb_settings`（`id TEXT NOT NULL PRIMARY KEY CHECK (id = 'kb')`；`embedding_name`、`embedding_base_url`、`embedding_api_key` 三列同 NULL 或同非 NULL；`embedding_generation INTEGER NOT NULL DEFAULT 0`；`embedding_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (… IN ('never','ok','failed'))`、`embedding_probe_at INTEGER NULL`、`embedding_probe_message TEXT NULL`；`chat_model_id TEXT NULL REFERENCES models(id) ON DELETE SET NULL`；`updated_at INTEGER NOT NULL`），迁移插入 `id = 'kb'` 的唯一一行；`knowledge_bases`（`id` 为 32 位小写十六进制、`owner_id REFERENCES accounts(id) ON DELETE RESTRICT`、`name` 1–64 码点且无 C0 / DEL、`template` 取十二种模板之一、`raptor` / `graph` 为 0 或 1、`dataset_id TEXT NOT NULL`、`rebuild_dataset_id TEXT NULL`、`embedding_generation INTEGER NOT NULL`、`state` 取 `ready` / `rebuilding` / `rebuild_failed`、`state_message TEXT NULL`、`created_at`、`updated_at`，`UNIQUE (owner_id, name)`）；`kb_documents`（`id`、`kb_id REFERENCES knowledge_bases(id) ON DELETE CASCADE`、`ragflow_document_id TEXT NOT NULL`、`name`、`size INTEGER NOT NULL`、`source` 取 `workspace` / `upload`、`workspace_id TEXT NULL`、`source_path TEXT NULL`、`source_mtime_ms INTEGER NULL`、`created_at`；`(source = 'workspace')` 与三列均非 NULL 等价，`UNIQUE (kb_id, workspace_id, source_path)`）。迁移 SHALL NOT 改任何既有表；`server/test/core-db-helpers.ts` 的跟踪清单 SHALL 加入 `MIGRATION_050`。

#### Scenario: 约束
- **WHEN** 在迁移后的库里：插第二行 `kb_settings`；插 `template = 'audio'` 的知识库；插 `source = 'upload'` 而 `source_path` 非空的文档；同一账号插两个同名知识库；删除一个被 `kb_settings.chat_model_id` 引用的模型行
- **THEN** 前四次插入都被约束拒绝；删除成功且 `chat_model_id` 变为 NULL

### Requirement: 知识库端点
知识库开启后，已登录用户 SHALL 能经 `GET /api/kb/bases` 列出自己的知识库、`POST /api/kb/bases` 建库、`DELETE /api/kb/bases/:id` 删库；别人的或不存在的 id 一律 404 `not_found`（不可探测）。视图 `BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`，`documents` 为本地文档行数，`compile` 为 `{raptor, graph}`（各取 `off` / `pending` / `running` / `done` / `failed`，从 RAGFlow 按需读取，读不到时整个 `compile` 为 `null`）。`POST` body 键集为 `name`、`template`、`raptor?`、`graph?`：嵌入模型未就绪 409 `kb_not_ready`；名称不合规、模板不在十二种之内、开关对该模板不可用（RAPTOR 只对 `qa`、`manual`、`paper`、`book`、`laws`、`presentation`；知识图谱对 `tag` 之外的十一种）或开关为真而知识库对话模型未指定，400 `bad_request`；同账号重名或已有 50 个知识库，409 `conflict`。建库 SHALL 先在 RAGFlow 建名为 `owb-<id>` 的数据集（模板、开关与当前嵌入模型），成功后插行并审计 `kb.create`；插行失败 SHALL 删除刚建的数据集。没有修改模板或开关的端点。`DELETE` SHALL 先删 RAGFlow 数据集（不存在视为已删；不可达 503 且行不动），再删行（文档行级联）并审计 `kb.delete`；`state` 为 `rebuilding` 时 409 `kb_rebuilding`，为 `rebuild_failed` 时两份数据集都删。

#### Scenario: 建库与列表隔离
- **WHEN** 用户 A 建 `规范库`（`manual`，`raptor:true`，知识库对话模型已指定）；用户 B 列表并 `DELETE` A 的库 id
- **THEN** A 得 201 与 `BaseView`，假 RAGFlow 收到名为 `owb-<id>` 的建数据集请求且带 RAPTOR 配置；B 的列表为空、`DELETE` 为 404 `not_found`，假 RAGFlow 没有收到删除请求

#### Scenario: 开关校验
- **WHEN** 建 `table` 模板带 `raptor:true`；未指定知识库对话模型时建 `manual` 带 `graph:true`；嵌入模型未配置时建任意库
- **THEN** 前两次 400 `bad_request`、第三次 409 `kb_not_ready`；三次都没有出站请求

#### Scenario: 删库
- **WHEN** 删除一个有两份文档的知识库；另一次删除时假 RAGFlow 不可达
- **THEN** 第一次 204，假 RAGFlow 收到一次删数据集请求，库与文档行都不在，恰一条 `kb.delete`；第二次 503 `kb_unavailable`，行仍在

### Requirement: 工作空间来源入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/documents` body `{workspaceId, paths}`（`paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个相对路径，越界个数或空数组 400）把自己工作空间里的文件入库。每条路径 SHALL 依次：经 `sandbox.resolve(principal, workspaceId, path, "read")`（越界照常写 `sandbox.reject`）；挂载内的文件经挂载读取（离线即被拒），挂载外的必须是普通文件（不跟随符号链接）；大小不超过 `KB_UPLOAD_MAX_BYTES`；同一知识库已有同一 `(workspaceId, path)` 的文档即被拒；然后以 multipart 流式上传到该库的数据集（不落临时文件），成功即插文档行（`size` 与 `source_mtime_ms` 取自上传前的那次 stat）。全部处理后 SHALL 对本批成功的文档触发一次解析。应答 201 `{documents: DocumentView[], rejected: {path, message}[]}`；每条被拒审计 `kb.ingest_reject`（`reason` 取 `outside` / `not_file` / `too_large` / `offline` / `duplicate` / `rejected`），有成功时整批审计一条 `kb.ingest`。RAGFlow 不可达时 SHALL 中止本批：已上传的保留，其余以 message `知识库服务暂不可用` 列入 `rejected`。知识库 `state` 不是 `ready` 时 409 `kb_rebuilding`。只读挂载里的文件可以入库。

#### Scenario: 混合批次
- **WHEN** 一批路径为：普通文件 `a.md`、只读挂载 `docs/` 下的 `b.pdf`、`../x`、一个目录、一个超过上限的文件、已入库过的 `a.md`
- **THEN** 201；`documents` 为 `a.md` 与 `docs/b.pdf` 两条；`rejected` 四条，审计 `kb.ingest_reject` 的 `reason` 依次为 `outside`、`not_file`、`too_large`、`duplicate`，另有一条 `sandbox.reject` 与一条 `kb.ingest`；假 RAGFlow 收到两次上传（字节与源文件一致）与一次解析触发

#### Scenario: 挂载离线
- **WHEN** 入库路径位于一个离线的挂载内
- **THEN** 该条以 `reason: offline` 被拒，没有上传请求

### Requirement: 本地上传入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/uploads?name=<文件名>` 以 `application/octet-stream` 请求体上传一个文件入库：文件名规则与 255 字节上限同工作空间上传；请求 SHALL 带 `Content-Length`（缺失 400 `bad_request`）；`Content-Length` 超过 `KB_UPLOAD_MAX_BYTES` 或流中实际字节超过它，413 `upload_too_large` 并审计 `kb.ingest_reject`（`reason: too_large`）。请求体 SHALL 直接拼进出站 multipart 上传，app-server 不落盘、不保留副本；成功 201 返回 `DocumentView`（`source: "upload"`、`workspaceId` 与 `path` 为 `null`），触发该文档的解析，审计 `kb.ingest`（detail `{id, source:"upload", name, size}`）。

#### Scenario: 上传不落盘
- **WHEN** 上传一个 1 MiB 的文件
- **THEN** 201；假 RAGFlow 收到的文件字节与请求体一致、multipart 的 `Content-Length` 与实际字节数相等；上传期间与之后 `SANDBOX_ROOT`、`OMP_STATE_DIR` 与系统临时目录里都没有新增文件

#### Scenario: 超限
- **WHEN** 以 `KB_UPLOAD_MAX_BYTES + 1` 的 `Content-Length` 上传；另一次声明的长度在上限内但实际多发一个字节
- **THEN** 两次 413 `upload_too_large`，各一条 `kb.ingest_reject`；第一次没有出站请求

### Requirement: 文档列表与状态
所有者 SHALL 能经 `GET /api/kb/bases/:id/documents` 读文档列表。状态 SHALL 以 RAGFlow 为准、每次请求时读取（分页读取该数据集的全部文档并按 RAGFlow 文档 id 关联），不起后台轮询。`DocumentView` 恰为 `{id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：`status` 取 `queued` / `parsing` / `done` / `failed` / `cancelled` / `missing`（RAGFlow 列表里没有该 id 为 `missing`）；`chunkCount` 只在 `done` 时为数字、否则 `null`；`message` 只在 `failed` 时为 `解析失败`、否则 `null`。`sourceChanged` 只对工作空间来源计算：源路径当前的大小或修改时间与入库记录不同、或文件已不存在为 `true`，相同为 `false`，挂载离线或无法判定为 `null`；工作空间来源以外为 `null`。RAGFlow 不可达时 503 `kb_unavailable`。

#### Scenario: 状态映射
- **WHEN** 假 RAGFlow 对三份文档分别报告：解析完成 12 个切片、解析中、失败；第四份本地记录在 RAGFlow 列表里不存在
- **THEN** 四条 `status` 依次为 `done`（`chunkCount: 12`）、`parsing`、`failed`（`message: "解析失败"`）、`missing`

#### Scenario: 源文件变更
- **WHEN** 入库后改写工作空间里的源文件；另一份的源文件被删除；第三份未动
- **THEN** 三条 `sourceChanged` 依次为 `true`、`true`、`false`；这次读取不产生审计记录

### Requirement: 重新入库与移出
所有者 SHALL 能经 `POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>` 重新入库一份工作空间来源的文档：按「工作空间来源入库」的读取规则重读源文件并上传为新文档、触发解析，成功后单事务更新该行的 RAGFlow 文档 id、`size` 与 `source_mtime_ms`，再删除旧的 RAGFlow 文档（失败只写一行 `{"event":"kb_document_leak", ...}`），审计 `kb.ingest`（detail 含 `reingest: true`）；源不可读或不合规时 409 `conflict` 且行不变；本地上传的文档 400 `bad_request`。所有者 SHALL 能经 `DELETE /api/kb/bases/:id/documents?doc=<文档 id>` 移出文档：先删 RAGFlow 文档（不存在视为已删），再删行，审计 `kb.document_delete`；源文件不动。两者在知识库 `state` 不是 `ready` 时 409 `kb_rebuilding`；`doc` 缺失、为空或多值 400；不属于该库的文档 404。

#### Scenario: 重新入库
- **WHEN** 源文件改写后对该文档重新入库
- **THEN** 200 返回新的 `DocumentView`（`sourceChanged: false`）；假 RAGFlow 依次收到上传、解析触发、删除旧文档

#### Scenario: 移出不动源文件
- **WHEN** 移出一份工作空间来源的文档
- **THEN** 204；工作空间里的源文件字节不变；恰一条 `kb.document_delete`

### Requirement: 知识库审计
知识库相关审计 SHALL 只用 `kb.create`、`kb.delete`、`kb.ingest`、`kb.ingest_reject`、`kb.document_delete`、`kb.settings`、`kb.rebuild` 七种 kind，标题为中文短句，detail SHALL NOT 含密钥、文件内容或 RAGFlow 应答原文。审计与对应的本地写入在同一事务内；写入失败时不留审计。

#### Scenario: detail 不含敏感内容
- **WHEN** 以内容含哨兵串的文件完成一次入库、一次上传、一次移出，并保存一次带密钥哨兵的知识库模型设置
- **THEN** 全部审计行的 `title` 与 `detail` 都不含任一哨兵

### Requirement: 中心「知识库」tab
`/center?tab=knowledge-bases` SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时对所有用户可见（见 model-registry「中心页外壳」），渲染当前用户的知识库：

- 状态行：`available:false` 时页顶 `role="alert"` 显示 `知识库服务暂不可用` 与 `重试` 按钮（重取状态与列表），其余控件不渲染；`embeddingReady:false` 时显示 `管理员尚未配置知识库嵌入模型`，不渲染 `新建知识库`。
- 列表：每个知识库一行（名称、模板中文名、`RAPTOR` / `知识图谱` 标签与其编译状态、文档数、`重建中` / `重建失败` 标记），点行进入详情；没有知识库时空态 `还没有知识库`。
- `新建知识库` 对话框：名称、模板（十二种，每项带 demo 的说明文案）、`RAPTOR` 与 `知识图谱` 复选——只在 `compileReady` 为真且所选模板支持时渲染；提交恰一次 `createKnowledgeBase`，失败在对话框内 `role="alert"` 显示信封文案。
- 详情：文档表（名称、来源——工作空间来源显示 `<空间名>/<路径>`、本地上传显示 `本地上传`——、大小、状态 `排队中` / `解析中` / `已切片 N` / `解析失败` / `已取消` / `已丢失`、`源文件已变更` 标记与 `重新入库` 按钮、`移出`）；`从工作空间入库` 对话框（选工作空间，逐级浏览目录树并勾选文件，至多 `uploadMaxFiles` 个，提交恰一次 `ingestFromWorkspace`，结果里被拒的条目逐条显示 message）；`上传文件`（文件选择，一次至多 `uploadMaxFiles` 个、单个超过 `uploadMaxBytes` 在客户端就地拒绝，逐个调用 `uploadToKnowledgeBase`）；`删除知识库`（确认对话框）。知识库 `state` 不是 `ready` 时入库、上传、重新入库按钮不渲染。
- 刷新：详情里存在 `queued` / `parsing` 文档且页面可见时每 3 秒重取文档列表；页面隐藏时停止。

API 客户端 `web/src/lib/api-kb.ts` SHALL 严格解析全部应答（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型与方法。

#### Scenario: 不可用与未就绪
- **WHEN** 状态为 `{enabled:true, available:false, …}` 时打开 tab；点 `重试` 后状态变为可用但 `embeddingReady:false`
- **THEN** 先看到 `知识库服务暂不可用` 与 `重试`、没有 `新建知识库`；重试后看到 `管理员尚未配置知识库嵌入模型`、仍没有 `新建知识库`

#### Scenario: 解析中自动刷新
- **WHEN** 详情的第一次列表里有一份 `parsing`，第二次全部 `done`
- **THEN** 3 秒后恰一次重取；之后不再重取；`已切片 N` 显示 RAGFlow 给出的切片数

#### Scenario: 编译开关按模板显示
- **WHEN** `compileReady:true` 时在新建对话框选 `manual`，再选 `table`；`compileReady:false` 时选 `manual`
- **THEN** `manual` 时显示两个复选；`table` 时只显示 `知识图谱`；`compileReady:false` 时两个都不显示
