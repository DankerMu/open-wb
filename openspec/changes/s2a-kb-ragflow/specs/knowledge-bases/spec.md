## ADDED Requirements

### Requirement: 迁移 050 知识库 schema
`server/src/core/db/migrations/050_knowledge_bases.sql` SHALL 建三张表，并只插入一行数据。

**`kb_settings`**：迁移插入 `id = 'kb'` 的唯一一行。列：
- `id TEXT NOT NULL PRIMARY KEY CHECK (id = 'kb')`。
- `embedding_name`、`embedding_base_url`、`embedding_api_key`：三列同为 NULL 或同为非 NULL。
- `embedding_generation INTEGER NOT NULL DEFAULT 0`。
- `embedding_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (… IN ('never','ok','failed'))`、`embedding_probe_at INTEGER NULL`、`embedding_probe_message TEXT NULL`。
- `chat_model_id TEXT NULL REFERENCES models(id) ON DELETE SET NULL`。
- `rebuild_actor_id TEXT NULL REFERENCES accounts(id)`：最近一次发起或重试重建的管理员。
- `updated_at INTEGER NOT NULL`。

**`knowledge_bases`**：
- `id`：32 位小写十六进制。
- `owner_id REFERENCES accounts(id) ON DELETE RESTRICT`。
- `name`：1–64 码点，无 C0 / DEL。
- `template`：十一种模板之一：`naive`、`book`、`email`、`laws`、`manual`、`one`、`paper`、`picture`、`presentation`、`qa`、`table`。`tag` 与 `audio` 不在其中。
- `raptor`、`graph`：0 或 1。
- `dataset_id TEXT NOT NULL`、`rebuild_dataset_id TEXT NULL`。
- `canvas_id TEXT NULL`、`template_group_id TEXT NULL`：`raptor`、`graph` 都为 0 时两列都是 NULL，否则两列都非 NULL。
- `rebuild_canvas_id TEXT NULL`、`rebuild_template_group_id TEXT NULL`：`rebuild_dataset_id` 为 NULL 或 `raptor`、`graph` 都为 0 时两列都是 NULL，否则两列都非 NULL。
- `embedding_generation INTEGER NOT NULL`。
- `state`：`ready` / `rebuilding` / `rebuild_failed`；`state_message TEXT NULL`。
- `created_at`、`updated_at`。
- `UNIQUE (owner_id, name)`。

**`kb_documents`**：
- `id`、`kb_id REFERENCES knowledge_bases(id) ON DELETE CASCADE`。
- `ragflow_document_id TEXT NOT NULL`、`name`、`size INTEGER NOT NULL`。
- `source`：`workspace` / `upload`。
- `workspace_id TEXT NULL`、`source_path TEXT NULL`、`source_mtime_ms INTEGER NULL`；`(source = 'workspace')` 与这三列均非 NULL 等价。
- `created_at`。
- `UNIQUE (kb_id, workspace_id, source_path)`。

迁移 SHALL NOT 改任何既有表；`server/test/core-db-helpers.ts` 的跟踪清单 SHALL 加入 `MIGRATION_050`。

#### Scenario: 约束
- **WHEN** 在迁移后的库里依次：插第二行 `kb_settings`；插 `template = 'audio'` 的知识库；插 `template = 'tag'` 的知识库；插 `raptor = 1` 而 `canvas_id` 为 NULL 的知识库；插两个开关都为 0 而 `canvas_id` 非空的知识库；插 `rebuild_dataset_id` 为 NULL 而 `rebuild_canvas_id` 非空的知识库；插 `source = 'upload'` 而 `source_path` 非空的文档；同一账号插两个同名知识库；删除一个被 `kb_settings.chat_model_id` 引用的模型行
- **THEN** 前八次插入都被约束拒绝；删除成功，`chat_model_id` 变为 NULL

### Requirement: 同一知识库的写操作串行
`kb` 模块 SHALL 为每个知识库持有一把进程内写锁。持锁范围：
- 工作空间入库（整批）、本地上传、重新入库、移出文档、删库，各在整个操作期间持有该库的锁。
- 重建器在重建该库期间持有它的锁。

写操作 SHALL 在取得锁之后重新判定：该库是否存在、`state` 是否允许本操作、本操作涉及的文档数上限。锁正被重建器持有时，写操作不等待，立即 409 `kb_rebuilding`。

结果：
- 同一知识库上不存在并发的上传与切换。
- 每个文档行都指向该库当前 `dataset_id` 里的 RAGFlow 文档。

#### Scenario: 上传与确认重建交错
- **WHEN** 一次本地上传已通过状态判定，假 RAGFlow 挂起该上传；此时管理员带 `confirmRebuild:true` 换嵌入模型；随后假 RAGFlow 放行上传
- **THEN** 上传得 201；重建器在上传完成之后才枚举该库的文档，新数据集里含这份文档；重建完成后，该库每一行的 RAGFlow 文档 id 都属于新数据集，旧数据集已删除

#### Scenario: 同一路径并发入库
- **WHEN** 两个请求并发把同一 `(workspaceId, path)` 入库到同一知识库
- **THEN** 一个请求的 `documents` 含该文档；另一个的 `rejected` 含该路径，`reason` 为 `duplicate`；假 RAGFlow 恰收到一次上传

#### Scenario: 入库中删库
- **WHEN** 一批入库进行中（假 RAGFlow 挂起第一份上传），所有者删除该知识库，然后假 RAGFlow 放行
- **THEN** 删除在入库结束之后才执行，得 204；结束后库与文档行都不在，假 RAGFlow 收到的删数据集请求在上传之后

### Requirement: 知识库端点
知识库开启后，已登录用户 SHALL 能管理自己的知识库。别人的或不存在的 id 一律 404 `not_found`，不可探测。全部应答带 no-store。

**视图** `BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`：
- `documents`：本地文档行数。
- `compile`：
  - 两个开关都为 0 的库：恒为 `{raptor:"off", graph:"off"}`，不发出站请求。
  - 其余的库：为 `{raptor, graph}`，关着的类型为 `off`，开着的类型按下面的规则从 RAGFlow 现读，各取 `pending` / `running` / `done` / `failed`。

**编译状态的判定**：SHALL NOT 读 `GET …/compilation/status`。每次读该库的文档列表，以及任务日志 `GET /api/v1/datasets/<id>/ingestions`（逐页读到 `total`）；文档列表已判定为下面第 1 步的 `running` 时不读任务日志。类型只按日志的 `task_type` 判定：RAPTOR 为 `Tree`，知识图谱为 `Graph`。对开着的每种类型，按次序：
1. 有本地文档在 RAGFlow 处于 `CREATED` / `SCHEDULED` / `RUNNING` / `STOPPING`，或该类型有 `operation_status` 为 `RUNNING` 的日志：`running`。
2. 有本地文档为 `FAILED`：`failed`。
3. 除 `COMPLETED` 且 `chunk_count` 为 0 的文档外，其余本地文档非空，且每份的 id 都出现在该类型 `operation_status` 为 `DONE` 的日志的 `dsl.entries[].doc_id` 里：`done`。
4. 其它：`pending`。

`failed` SHALL 只来自文档 `FAILED`。文档已 `COMPLETED` 而该类型没有日志时（RAPTOR 在对话模型失败时没有任何信号）SHALL 保持 `pending`，不得显示 `failed` 或 `done`。

**`GET /api/kb/bases`**：200 `{bases: BaseView[]}`，按 `created_at` 升序。
- 列表只依赖本地行。
- 各库的编译状态读取并发发出，共用一个 5 s 总期限；没有在期限内读完的库 `compile` 为 `null`，读取失败同此。
- RAGFlow 不可达时列表照常 200。

**`POST /api/kb/bases`**：body 键集为 `name`、`template`、`raptor?`、`graph?`。依次判定：
1. 键集、类型、名称或模板不合规：400 `bad_request`。
2. 嵌入模型未就绪：409 `kb_not_ready`。
3. 开关为真而知识库对话模型未指定：400 `bad_request`。RAPTOR 与知识图谱对十一种模板都可用，没有按模板的限制。
4. 同账号重名：409 `conflict`。已有 50 个知识库：409 `kb_limit`。

建库在进程级设置锁下进行。下文的「代数」为当前嵌入代数，`<名字>` 为 `owb-<id>-g<代数>`。

两个开关都为 0：
1. `POST /api/v1/datasets`，body `{name:<名字>, parser_id, parse_type:1, embedding_model}`。`parser_id` 在 `naive` 时为 `general`，其余等于模板名。

任一开关为真：
1. `GET /api/v1/compilation-templates/builtins` 取内置 `config`。RAPTOR 用 `id:"tree"`，SHALL 删掉 `entity`、`relation` 与 `llm_id`；知识图谱用 `id:"knowledge_graph"`，SHALL 删掉 `llm_id`。
2. `POST /api/v1/compilation-template-groups`，名为 `<名字>`，`templates` 含开着的类型（`kind` 为 `tree` / `knowledge_graph`）。
3. `GET /api/v1/pipelines/<parser_id>` 取内置 DSL，插入 Compiler 节点（见下），`POST /api/v1/agents`，`title` 为 `<名字>`，`canvas_category` 为 `dataflow_canvas`。
4. `POST /api/v1/datasets`，body `{name:<名字>, parse_type:2, pipeline_id:<画布 id>, embedding_model}`。

两种情形：
- `embedding_model` SHALL 恒显式传三段式 `<名称>@owb-embed@OpenAI-API-Compatible`。
- SHALL NOT 发送 `chunk_method`，也不在 `parser_config` 里发送 RAPTOR 或知识图谱字段。
- 全部成功后插行，并在同一事务里审计 `kb.create`；成功应答为 201 `BaseView`。
- 任一步失败或插行失败：SHALL 逆序删除这一次已建的资源（数据集 → 画布 → 模板组），按「RAGFlow 出站请求」映射返回；这次回滚里的删除失败只写一行 stderr 记录（`kb_dataset_leak` 或 `kb_pipeline_leak`，见 ragflow-backend「嵌入模型更换与全量重建」），不改变应答。

**DSL**：画布 DSL SHALL 由内置 DSL 改写，并同时含 `components` 与 `graph`：
- 按 `obj.component_name` 含 `Chunker` 查 chunker 节点；查到的不是恰一个，或内置 DSL 没有 `graph`：SHALL 失败（`kb_unavailable`），不提交画布。
- `components` 加 `Compiler:Owb`：`upstream` 为 chunker，`downstream` 为 chunker 原来的下游，`obj` 的 `component_name` 为 `Compiler`，`params` 含 `compilation_template_group_id`、空串 `llm_id`、`plan:false` 与 `outputs`。
- chunker 的 `downstream` 改为 `Compiler:Owb`；原下游的 `upstream` 里 chunker 换成 `Compiler:Owb`。
- `graph.nodes` 加 `id` 为 `Compiler:Owb`、`type` 为 `compilationNode` 的节点，`data.form` 放同一份 `params`。
- `graph.edges`：chunker 原来的出边把 `source` 改为 `Compiler:Owb`，原边不保留；再加一条 chunker → `Compiler:Owb`。

没有修改模板或开关的端点。

**`DELETE /api/kb/bases/:id`**：
- `state` 为 `rebuilding`：409 `kb_rebuilding`。
- 否则按数据集 → 画布 → 模板组的次序删除 RAGFlow 资源。上一步确认已删（成功或不存在）之前 SHALL NOT 发下一步。`rebuild_failed` 时先删新一代，再删当前一代，各按同一次序。没有画布与模板组的库只删数据集。不存在视为已删；不可达时 503，行不动，重试时从头走一遍。
- 都删完后删行（文档行级联），并审计 `kb.delete`，应答 204。

#### Scenario: 建库与列表隔离
- **WHEN** 用户 A 建 `规范库`（`manual`，`raptor:true`，知识库对话模型已指定）；用户 B 请求列表，并 `DELETE` A 的库 id
- **THEN** A 得 201 `BaseView`，假 RAGFlow 依次收到读内置模板、建模板组、读内置 pipeline、建画布与建数据集，名字都是 `owb-<id>-g0`，数据集 body 为 `parse_type:2`、`pipeline_id` 为该画布；B 的列表为 `{bases:[]}`，`DELETE` 为 404 `not_found`，假 RAGFlow 没有收到删除请求

#### Scenario: 普通模板的建库请求
- **WHEN** 两个开关都为 0 时，分别建 `naive` 与 `manual` 模板的库
- **THEN** 假 RAGFlow 只收到两次建数据集，`parser_id` 依次为 `general`、`manual`，都带 `parse_type:1` 与三段式 `embedding_model`；没有模板组、画布请求，body 不含 `chunk_method`

#### Scenario: 十一种模板都能开两个开关
- **WHEN** 知识库对话模型已指定，对十一种模板各建一个 `raptor:true`、`graph:true` 的库，假 RAGFlow 的内置 pipeline 按记录的节点名给出不同的 chunker
- **THEN** 十一次都是 201；每次的画布 DSL 都含 `graph`，Compiler 节点插在该模板的 chunker 与其下游之间，`graph.edges` 比内置 DSL 恰多一条且不含 chunker 到原下游的边；模板组含 `tree`、`knowledge_graph` 两项，`tree` 的 `config` 不含 `entity`、`relation`、`llm_id`，`knowledge_graph` 的不含 `llm_id`

#### Scenario: 只开一种编译
- **WHEN** 建 `raptor:true` 的库；再建 `graph:true` 的库
- **THEN** 模板组的 `templates` 依次只含 `tree`、只含 `knowledge_graph`

#### Scenario: 开关校验
- **WHEN** 未指定知识库对话模型时建 `manual` 并带 `graph:true`；嵌入模型未配置时建任意库；`template` 为 `tag`；`template` 为 `audio`
- **THEN** 依次 400 `bad_request`、409 `kb_not_ready`、400 `bad_request`、400 `bad_request`；四次都没有出站请求

#### Scenario: 建库中途失败逐步回滚
- **WHEN** 开了开关的建库，假 RAGFlow 依次在建画布、建数据集时应答 HTTP 503；另一次在全部建成后经注入让插行失败
- **THEN** 第一次删除模板组；第二次先删画布、再删模板组；第三次依次删数据集、画布、模板组；三次都是失败应答，没有知识库行，没有 `kb.create`

#### Scenario: DSL 无法改写
- **WHEN** 假 RAGFlow 的内置 pipeline 不带 `graph`；另一次带两个 chunker 节点
- **THEN** 两次都是 503 `kb_unavailable`；假 RAGFlow 没有收到建画布与建数据集，建好的模板组已删除

#### Scenario: 删库
- **WHEN** 删除一个两开关都为 0、有两份文档的知识库；另一次删除时假 RAGFlow 不可达
- **THEN** 第一次 204，假 RAGFlow 收到一次删数据集请求，库与文档行都不在，恰一条 `kb.delete`；第二次 503 `kb_unavailable`，行仍在

#### Scenario: 删除次序
- **WHEN** 删除一个开了开关的知识库；另一次假 RAGFlow 在删画布时不可达，随后恢复，用户重试；再一次假 RAGFlow 对删数据集、删画布、删模板组分别应答 `code:403`、`code:103`、`code:404`
- **THEN** 第一次假 RAGFlow 依次收到删数据集、删画布、删模板组；第二次先 503、行仍在、没有发出删模板组，重试时依次得到数据集不存在、删画布、删模板组，204；第三次 204，三个「不存在」都视为已删

#### Scenario: 编译状态读取有界
- **WHEN** 列表里有三个开了 RAPTOR 的库和一个两开关都为 0 的库，假 RAGFlow 挂起全部文档列表与任务日志请求（总期限经装配注入缩短）
- **THEN** 列表在该期限后返回 200；三个库的 `compile` 为 `null`，第四个为 `{raptor:"off", graph:"off"}`

#### Scenario: 编译状态按任务日志判定
- **WHEN** 一个开了两种编译、有两份文档的库，假 RAGFlow 依次呈现：
  - 一份 `RUNNING`；
  - 两份都 `COMPLETED`，任务日志没有记录；
  - 两份都 `COMPLETED`，`Tree` 的 `DONE` 日志覆盖两份，`Graph` 为 `RUNNING`；
  - `Tree` 与 `Graph` 的 `DONE` 日志都只覆盖第一份；
  - 两种都覆盖两份；
  - 一份 `FAILED`，另一份 `COMPLETED` 且两种都覆盖它。
- **THEN** `compile` 依次为 `{running, running}`、`{pending, pending}`、`{done, running}`、`{pending, pending}`、`{done, done}`、`{failed, failed}`

#### Scenario: 只有 0 切片的文档
- **WHEN** 一个开了 RAPTOR 的库有两份文档，一份 `COMPLETED` 且 `chunk_count` 为 0，另一份被 `Tree` 的 `DONE` 日志覆盖；另一个库只有一份 0 切片的文档
- **THEN** 第一个库 `raptor` 为 `done`；第二个库 `raptor` 为 `pending`

#### Scenario: 类型只看 task_type
- **WHEN** 一个只开 RAPTOR 的库，`Graph` 日志的 `dsl.entries[].variants` 含 `tree` 且覆盖全部文档，没有 `Tree` 日志
- **THEN** `raptor` 为 `pending`，`graph` 为 `off`

#### Scenario: 知识库数上限
- **WHEN** 一个账号已有 50 个知识库，再建第 51 个
- **THEN** 409 `kb_limit`，没有出站请求

### Requirement: 工作空间来源入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/documents` 把自己工作空间里的文件入库。

**请求**：body `{workspaceId, paths}`。
- `paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个相对路径；空数组或超出个数：400。
- `workspaceId` 不是当前用户可见的工作空间（别人的或已删除）：整个请求 404 `not_found`，不发出站请求。
- 知识库 `state` 不是 `ready`：整个请求 409 `kb_rebuilding`。

**逐条处理**：在该库的写锁下，每条路径依次经过以下步骤；被拒的条目以括号里的 `reason` 记录：
1. 经 `sandbox.resolve(principal, workspaceId, path, "read")` 解析。被拒为 `outside`；越界照常由 facade 写 `sandbox.reject`。路径上任一分量是符号链接时，`resolve` 拒绝，同样记为 `outside`。
2. 查重与计数：该库已有同一 `(workspaceId, path)`（`duplicate`）；该库已有 500 份文档（`limit`）。
3. 后缀判定：路径 basename 最后一个 `.` 之后的部分转小写，不在该模板的后缀表（实测记录表 C 末列）里，或没有后缀（`unsupported_type`）。这条对全部知识库生效，不分是否开了编译。
4. 打开文件：挂载内经挂载读取，离线即被拒（`offline`）；挂载外以 `O_NOFOLLOW` 打开，不是普通文件即被拒（`not_file`）。之后对同一 fd 做 `fstat`，得到 `size` 与 `mtimeMs`。
5. 大小为 0（`empty`）；大小超过 `KB_UPLOAD_MAX_BYTES`（`too_large`）。
6. 以 multipart 流式上传到该库的数据集，字段名 `file`，文件名用原始 UTF-8 或 `filename*`，不落临时文件；`Content-Length` 按 `fstat` 的大小计算。实际读出的字节数与之不符时：中止出站请求，该条记为 `changed`。
7. 触发该文档的解析，`document_ids` 只含这一个 id。
8. 在同一事务里插文档行，并审计 `kb.ingest`。

入库不发送任何编译请求：编译随解析自动运行。

**RAGFlow 失败**：
- 上传或解析触发得到 `kb_rejected`：删除已建的文档，该条记为 `rejected`，继续处理下一条。
- 解析触发回 `code:0` 而 `success_count` 为 0：SHALL 按解析失败处理，删除已建的文档，该条记为 `rejected`，继续处理下一条。
- 上传回 `code:500` 且 message 表明不支持这种文件：SHALL 把该条记为 `unsupported_type`，继续处理下一条，不中止整批。
- 得到 `kb_unavailable`，或上传、解析触发得知数据集不存在：删除已建的文档（尽力而为）；该条与其后全部条目都记为 `unavailable`，后续条目不再发请求。
- 任何补偿删除按「重新入库与移出」的删除写法进行，失败只写一行 `{"event":"kb_document_leak","documentId":<id>}`，不改变该条的结果。本地上传与重新入库的补偿删除同此。

**应答**：只要请求本身合法，即为 201 `{documents: DocumentView[], rejected: {path, reason, message}[]}`。`message` 按 `reason` 固定：

| `reason` | `message` |
|---|---|
| `outside` | `目标路径不在你的沙箱内` |
| `not_file` | `不是普通文件` |
| `too_large` | `文件超过大小上限` |
| `unsupported_type` | `这个模板不支持这种文件` |
| `empty` | `文件是空的，不能入库` |
| `offline` | `挂载已离线` |
| `duplicate` | `已在知识库里` |
| `limit` | `知识库文档数已达上限` |
| `changed` | `读取期间文件发生了变化` |
| `rejected` | `知识库服务拒绝了这个文件` |
| `unavailable` | `知识库服务暂不可用` |

每个被拒的条目审计一条 `kb.ingest_reject`。只读挂载里的文件可以入库。

#### Scenario: 混合批次
- **WHEN** 一批路径依次为：普通文件 `a.md`、只读挂载 `docs/` 下的 `b.pdf`、`../x`、一个目录、一个超过上限的文件、已入库过的 `a.md`、一个以符号链接为分量的路径
- **THEN** 201；`documents` 为 `a.md` 与 `docs/b.pdf` 两条；`rejected` 五条，`reason` 依次为 `outside`、`not_file`、`too_large`、`duplicate`、`outside`；审计有五条 `kb.ingest_reject`、两条 `kb.ingest`、两条 `sandbox.reject`；假 RAGFlow 收到两次上传（字节与源文件一致）与两次解析触发

#### Scenario: 后缀与空文件
- **WHEN** 一个 `manual` 模板的库，一批路径依次为：`a.txt`、`b.PDF`、`noext`、一个 0 字节的 `c.pdf`、`d.docx`
- **THEN** 201；`documents` 为 `b.PDF` 与 `d.docx`；`rejected` 依次为 `a.txt`（`unsupported_type`）、`noext`（`unsupported_type`）、`c.pdf`（`empty`），`message` 分别为 `这个模板不支持这种文件`、`这个模板不支持这种文件`、`文件是空的，不能入库`；假 RAGFlow 恰收到两次上传；有三条 `kb.ingest_reject`

#### Scenario: 不支持的后缀不中止整批
- **WHEN** 一批三个路径，后缀都在模板的表里，假 RAGFlow 对第二份的上传应答 HTTP 200 `code:500` 与记录里不支持文件的 message
- **THEN** 201；第一、三份入库；第二份的 `reason` 为 `unsupported_type`；假 RAGFlow 收到三次上传

#### Scenario: 挂载离线
- **WHEN** 入库路径位于一个离线的挂载内
- **THEN** 该条以 `reason: offline` 被拒，没有上传请求

#### Scenario: 中途不可达
- **WHEN** 一批三个路径，假 RAGFlow 对第二份的上传应答 HTTP 503
- **THEN** 201；`documents` 只有第一份；第二、三份的 `reason` 都是 `unavailable`；假 RAGFlow 恰收到两次上传，没有第三次

#### Scenario: 解析触发失败
- **WHEN** 一批两个路径，第一份上传成功，假 RAGFlow 对它的解析触发在三次请求里分别应答：HTTP 503；`code:101`；`code:0` 且 `success_count:0`
- **THEN** 第一次请求：第一份为 `unavailable`，假 RAGFlow 收到删除该文档的请求，没有该行，第二份不发请求；后两次请求：第一份为 `rejected` 且该文档被删除，第二份照常入库

#### Scenario: 逐条被拒
- **WHEN** 一批两个路径，假 RAGFlow 对第一份的上传应答 `code:101`
- **THEN** 第一份以 `reason: rejected` 被拒，第二份成功入库

#### Scenario: 读取期间文件变化
- **WHEN** 经测试缝让第一份文件在 `fstat` 之后、读完之前被追加了字节
- **THEN** 该条以 `reason: changed` 被拒；没有该文档行；出站上传被中止，假 RAGFlow 上没有这份文档

#### Scenario: 文档数上限
- **WHEN** 一个知识库已有 499 份文档，一批入库两个合规文件
- **THEN** 第一份成功；第二份以 `reason: limit` 被拒，没有为它发上传请求

#### Scenario: 别人的工作空间
- **WHEN** 用户把另一个账号的 `workspaceId` 用于入库
- **THEN** 404 `not_found`；假 RAGFlow 收到零个请求；没有 `kb.ingest_reject`

### Requirement: 本地上传入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/uploads?name=<文件名>` 上传一个文件入库，请求体为 `application/octet-stream`。

**请求校验**：
- 文件名规则与 255 字节上限同工作空间上传。
- SHALL 带 `Content-Length`；缺失或分块传输：400 `bad_request`。
- `Content-Length` 超过 `KB_UPLOAD_MAX_BYTES`：413 `upload_too_large`，并审计 `kb.ingest_reject`（`reason: too_large`），不发出站请求。
- 文件名后缀按「工作空间来源入库」第 3 步判定，不通过：400 `kb_file_unsupported`，并审计 `kb.ingest_reject`（`reason: unsupported_type`），不发出站请求。
- `Content-Length` 为 0：400 `kb_file_unsupported`，并审计 `kb.ingest_reject`（`reason: empty`），不发出站请求。
- 知识库 `state` 不是 `ready`：409 `kb_rebuilding`。

**处理**：在该库的写锁下进行。
1. 取锁后计数：该库已有 500 份文档时 409 `kb_limit`，并审计 `kb.ingest_reject`（`reason: limit`），不发出站请求。
2. 请求体直接拼进出站 multipart 上传；app-server 不落盘，不保留副本。
3. 客户端中途断开，或发送的字节少于 `Content-Length`：中止出站请求；不插行，不写 `kb.ingest`。
4. 上传回 `code:500` 且 message 表明不支持这种文件：400 `kb_file_unsupported`，并审计 `kb.ingest_reject`（`reason: unsupported_type`）。
5. 上传成功后，触发该文档的解析。
6. 解析触发失败：删除该文档，按「RAGFlow 出站请求」映射返回；回 `code:0` 而 `success_count` 为 0 时同样删除该文档，返回 400 `kb_rejected`。
7. 都成功后，在同一事务里插行并审计 `kb.ingest`。

**成功应答**：201 `DocumentView`，其中 `source` 为 `upload`，`workspaceId` 与 `path` 为 `null`。

#### Scenario: 上传不落盘
- **WHEN** 上传一个 1 MiB 的文件
- **THEN** 201；假 RAGFlow 收到的文件字节与请求体一致，multipart 的 `Content-Length` 与实际字节数相等；上传期间与之后，`SANDBOX_ROOT`、`OMP_STATE_DIR` 与系统临时目录里都没有新增文件

#### Scenario: 超限与缺少长度
- **WHEN** 以 `KB_UPLOAD_MAX_BYTES + 1` 的 `Content-Length` 上传；另一次以分块传输、不带 `Content-Length` 上传
- **THEN** 第一次 413 `upload_too_large`，一条 `kb.ingest_reject`；第二次 400 `bad_request`；两次都没有出站请求

#### Scenario: 上传的后缀与空文件
- **WHEN** 向 `paper` 模板的库上传 `a.txt`；再上传一个 `Content-Length: 0` 的 `b.pdf`
- **THEN** 两次都是 400 `kb_file_unsupported`，没有出站请求；两条 `kb.ingest_reject`，`reason` 依次为 `unsupported_type`、`empty`

#### Scenario: 客户端中断
- **WHEN** 请求声明 1 MiB，发送 512 KiB 后断开连接
- **THEN** 出站上传被中止；没有文档行，没有 `kb.ingest`；假 RAGFlow 上没有留下这份文档

#### Scenario: 解析触发失败
- **WHEN** 上传成功，但假 RAGFlow 对解析触发应答 HTTP 503；另一次应答 `code:0` 且 `success_count:0`
- **THEN** 第一次 503 `kb_unavailable`，第二次 400 `kb_rejected`；两次假 RAGFlow 都收到删除该文档的请求；没有文档行

### Requirement: 文档列表与状态
所有者 SHALL 能经 `GET /api/kb/bases/:id/documents` 读文档列表，应答 200 `{documents: DocumentView[]}`，按 `created_at` 升序，带 no-store。
- 状态以 RAGFlow 为准，每次请求时读取：分页读取该数据集的全部文档（`page_size` 为 100，读到 `total` 为止），按 RAGFlow 文档 id 关联；不起后台轮询。
- 数据集本身为 not-found 时，全部文档为 `missing`。
- RAGFlow 不可达：503 `kb_unavailable`。

**视图** `DocumentView` 恰为 `{id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：
- `name` SHALL 取本地记录，不读 RAGFlow 的 `name`：RAGFlow 对同名文件改名（`a(1).txt`）。
- `status` 取 `queued` / `parsing` / `done` / `failed` / `cancelled` / `unparsed` / `missing`，由 RAGFlow 的 `ingestion_status` 映射（SHALL NOT 读恒为 `"1"` 的 `status` 字段）：
  - `UNSTART`：`unparsed`。
  - `CREATED`、`SCHEDULED`：`queued`。
  - `RUNNING`、`STOPPING`：`parsing`。
  - `STOPPED`：`cancelled`。
  - `COMPLETED`：`done`。
  - `FAILED`：`failed`。
  - RAGFlow 列表里没有该 id：`missing`。
  - 其它取值：整个请求 503 `kb_unavailable`。
- `chunkCount`：只在 `done` 时为数字，取 RAGFlow 的 `chunk_count`，可以是 0；否则为 `null`。
- `message`：只在 `failed` 时为 `解析失败`，否则为 `null`。
- `sourceChanged`：
  - 只对工作空间来源计算，其它来源为 `null`。
  - 计算方式：经 core 的无审计解析（工作空间根加纯函数 `resolve`，第四个参数传该工作空间的挂载名集合，与 facade 注入的 `mountNamesOf` 同一来源，使挂载点及其下路径不被同步 `lstat`，遵守 workspace-mounts 对挂载路径的既有约束），再 stat 源路径；挂载内经挂载 stat。
  - 大小或修改时间与入库记录不同，或文件已不存在：`true`；相同：`false`。
  - 解析被拒、工作空间已不可见、挂载离线：`null`。

这次读取 SHALL NOT 写任何审计。

#### Scenario: 状态映射
- **WHEN** 假 RAGFlow 对八份文档依次报告 `UNSTART`、`CREATED`、`SCHEDULED`、`RUNNING`、`STOPPING`、`STOPPED`、`COMPLETED`（12 个切片）、`FAILED`，且 `status` 字段都是 `"1"`；第九份本地记录在 RAGFlow 列表里不存在
- **THEN** 九条 `status` 依次为 `unparsed`、`queued`、`queued`、`parsing`、`parsing`、`cancelled`、`done`（`chunkCount: 12`）、`failed`（`message: "解析失败"`）、`missing`

#### Scenario: 0 切片
- **WHEN** 假 RAGFlow 报告一份文档 `COMPLETED` 且 `chunk_count` 为 0
- **THEN** 该条 `status` 为 `done`，`chunkCount` 为 0

#### Scenario: 未知运行状态
- **WHEN** 假 RAGFlow 的列表里有一份文档的 `ingestion_status` 不在记录的八种之内
- **THEN** 503 `kb_unavailable`

#### Scenario: 源文件变更
- **WHEN** 入库后改写工作空间里一份源文件；另一份的源文件被删除；第三份未动
- **THEN** 三条 `sourceChanged` 依次为 `true`、`true`、`false`；这次读取不产生审计记录

#### Scenario: 挂载来源的变更
- **WHEN** 一份文档来自在线挂载内的文件，入库后远端改写了它
- **THEN** 该条 `sourceChanged` 为 `true`；计算过程中服务进程没有对挂载点或其下路径做同步文件系统调用

#### Scenario: 源路径变成符号链接
- **WHEN** 入库后把源文件所在目录换成指向它的符号链接，然后连续两次请求列表
- **THEN** 两次该条的 `sourceChanged` 都是 `null`；`audit_events` 里没有新增 `sandbox.reject`

### Requirement: 重新入库与移出
**重新入库**：所有者 SHALL 能经 `POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>` 重新入库一份工作空间来源的文档，在该库的写锁下进行。
- 知识库 `state` 不是 `ready`：409 `kb_rebuilding`。
- 本地上传的文档：400 `bad_request`。
- 按「工作空间来源入库」的规则重读源文件。读取被拒（含工作空间已不可见、`outside`、`not_file`、`offline`、`empty`、`too_large`、`changed`、源文件不存在）：409 `kb_source_unreadable`，行不变。`outside` 仍由 facade 写 `sandbox.reject`。
- 读取成功：上传为新文档并触发解析。
- 上传或解析触发失败：删除新文档，按映射返回，行不变。
- 成功：在单事务里更新该行的 RAGFlow 文档 id、`size` 与 `source_mtime_ms`，并审计 `kb.ingest`；再按下面的删除写法删除旧的 RAGFlow 文档，失败只写一行 `{"event":"kb_document_leak","documentId":<id>}`。应答 200 `DocumentView`。

**移出**：所有者 SHALL 能经 `DELETE /api/kb/bases/:id/documents?doc=<文档 id>` 移出文档，在该库的写锁下进行。
- 允许的 `state`：`ready` 与 `rebuild_failed`；`rebuilding` 时 409 `kb_rebuilding`。
- 先按下面的删除写法删 RAGFlow 文档：不存在视为已删；不可达时 503，行不变；结果为 `busy` 时 409 `kb_document_busy`，行不变。
- 再删行，并审计 `kb.document_delete`，应答 204。源文件不动。

**RAGFlow 文档的删除写法**：`code:0` 不代表删成了，RAGFlow 对 `RUNNING`、`STOPPING` 的文档回 `deleted:0` 且行仍在。SHALL 检查 `deleted`：
1. 发删除。`deleted:1` 或不存在：完成。
2. `deleted:0`：发一次停止解析，再每 500 ms 重发删除，至多 5 s（期限经装配注入）。`deleted:1` 或不存在：完成。
3. 到期仍为 `deleted:0`：结果为 `busy`。

SHALL NOT 在 `deleted:0` 时删除本地行。

**两者共用的校验**：`doc` 缺失、为空或多值：400；文档不属于该库：404。

#### Scenario: 重新入库
- **WHEN** 源文件改写后对该文档重新入库
- **THEN** 200 返回新的 `DocumentView`（`sourceChanged: false`）；假 RAGFlow 依次收到上传、解析触发、删除旧文档

#### Scenario: 源不可读
- **WHEN** 源文件已被删除后对该文档重新入库
- **THEN** 409 `kb_source_unreadable`；该行不变；假 RAGFlow 没有收到上传

#### Scenario: 移出不动源文件
- **WHEN** 移出一份工作空间来源的文档
- **THEN** 204；工作空间里的源文件字节不变；恰一条 `kb.document_delete`

#### Scenario: 移出解析中的文档
- **WHEN** 假 RAGFlow 对一份文档的删除先应答 `code:0`、`deleted:0`，收到停止解析之后应答 `deleted:1`
- **THEN** 204；假 RAGFlow 依次收到删除、停止、删除；行已删除，恰一条 `kb.document_delete`

#### Scenario: 停不下来的文档
- **WHEN** 假 RAGFlow 对删除一直应答 `code:0`、`deleted:0`（重试期限经装配注入缩短）
- **THEN** 409 `kb_document_busy`；行仍在，没有 `kb.document_delete`；假 RAGFlow 收到一次停止解析

#### Scenario: 重新入库时旧文档在解析
- **WHEN** 对一份 `RUNNING` 的文档重新入库，假 RAGFlow 对删旧文档一直应答 `deleted:0`
- **THEN** 200，行换成新文档；stderr 恰一行 `{"event":"kb_document_leak","documentId":<旧 id>}`

#### Scenario: 重建失败后移出
- **WHEN** 知识库处于 `rebuild_failed` 时移出其中一份文档；再对它请求重新入库
- **THEN** 移出 204，该行已删除；重新入库 409 `kb_rebuilding`

### Requirement: 知识库审计
知识库相关审计 SHALL 只用下表七种 kind。标题为中文短句；detail 的键集恰如下表，SHALL NOT 含密钥、文件内容或 RAGFlow 应答原文。

| kind | 时机 | detail |
|---|---|---|
| `kb.create` | 建库成功 | `{id, template, raptor, graph}` |
| `kb.delete` | 删库成功 | `{id}` |
| `kb.ingest` | 工作空间入库，每份文档一条 | `{id, source:"workspace", workspaceId, path, documentId}` |
| `kb.ingest` | 本地上传 | `{id, source:"upload", name, size, documentId}` |
| `kb.ingest` | 重新入库 | `{id, source:"workspace", reingest:true, documentId}` |
| `kb.ingest_reject` | 工作空间入库，每个被拒的条目一条 | `{id, source:"workspace", workspaceId, path, reason}` |
| `kb.ingest_reject` | 本地上传被拒 | `{id, source:"upload", name, reason}` |
| `kb.document_delete` | 移出成功 | `{id, documentId}` |
| `kb.settings` | 保存设置 | `{embedding?: <名称>, chatModelId?: string \| null}` |
| `kb.settings` | 探活 | `{probe: "ok" \| "failed"}` |
| `kb.rebuild` | 确认重建 | `{bases, documents}` |
| `kb.rebuild` | 重试 | `{bases, documents, retry:true}` |
| `kb.rebuild` | 单库结束 | `{id, result:"ok", skipped: string[]}` 或 `{id, result:"failed"}` |

规则：
- actor 为请求的 principal；重建器写的单库记录，actor 为 `kb_settings.rebuild_actor_id`。
- 工作空间来源的记录，`workspaceId` 列为该工作空间；其余为 null。
- 每条成功审计与它对应的那一次本地写入在同一事务内；本地写入失败时不留审计。确认重建的那次保存写 `kb.settings` 与 `kb.rebuild` 两条，其余每次写入一条。
- `kb.ingest_reject` 没有对应的本地写入，单独写入。

#### Scenario: detail 不含敏感内容
- **WHEN** 以内容含哨兵串的文件完成一次工作空间入库、一次本地上传、一次重新入库与一次移出，并以带密钥哨兵的 body 保存一次知识库模型设置
- **THEN** 全部审计行的 `title` 与 `detail` 都不含任一哨兵；各行的 detail 键集与上表一致

#### Scenario: 写入失败不留审计
- **WHEN** 经注入让文档行插入失败
- **THEN** 没有 `kb.ingest` 审计；假 RAGFlow 收到删除刚上传文档的请求

### Requirement: 中心「知识库」tab
`/center?tab=knowledge-bases` SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时对所有用户可见（见 model-registry「中心页外壳」），渲染当前用户的知识库。

**状态行**：
- `available:false`：页顶以 `role="alert"` 显示 `知识库服务暂不可用` 与 `重试` 按钮（重取状态与列表），其余控件不渲染。
- `embeddingReady:false`：显示 `管理员尚未配置知识库嵌入模型`，不渲染 `新建知识库`。

**列表**：
- 每个知识库一行：名称、模板中文名、`RAPTOR` / `知识图谱` 标签与其编译状态、文档数、`重建中` / `重建失败` 标记。
- 编译状态文案：`pending` 为 `尚未产出`，旁注 `解析完成后长时间没有变化，可能是知识库对话模型不可用，请联系管理员`；`running` 为 `编译中`；`done` 为 `已完成`；`failed` 为 `有文档失败`；`compile` 为 `null` 时为 `状态未知`。这些文案 SHALL NOT 含 `编译失败`：`pending` 没有失败信号，`failed` 来自文档。
- 点行进入详情。
- 没有知识库时显示空态 `还没有知识库`。

**`新建知识库` 对话框**：
- 字段：名称；模板（十一种，每项带 demo 的说明文案）；`RAPTOR` 与 `知识图谱` 复选，只在 `compileReady` 为真时渲染，十一种模板都一样。
- 提交恰调用一次 `createKnowledgeBase`；失败时在对话框内以 `role="alert"` 显示信封文案。

**详情**：
- **文档表**，每行：
  - 名称。
  - 来源：工作空间来源显示 `<空间名>/<路径>`，本地上传显示 `本地上传`。
  - 大小。
  - 状态：`排队中` / `解析中` / `已切片 N` / `解析失败` / `已取消` / `未解析` / `已丢失`。
  - `源文件已变更` 标记：只在 `sourceChanged` 为 `true` 时显示。
  - 每个工作空间来源的行都有 `重新入库` 按钮。
  - `移出`。409 `kb_document_busy` 时行内显示信封文案，行仍在。
- **`从工作空间入库` 对话框**：选工作空间，逐级浏览目录树并勾选文件，至多 `uploadMaxFiles` 个；提交恰调用一次 `ingestFromWorkspace`；结果里被拒的条目逐条显示 `message`。
- **`上传文件`**：文件选择，一次至多 `uploadMaxFiles` 个；单个超过 `uploadMaxBytes` 在客户端就地拒绝；逐个调用 `uploadToKnowledgeBase`，失败逐个显示信封文案（含 `kb_file_unsupported`）。
- **`删除知识库`**：先弹确认对话框。
- 知识库 `state` 不是 `ready` 时，入库、上传与重新入库按钮不渲染；`rebuild_failed` 时 `移出` 仍渲染，`rebuilding` 时不渲染。

**刷新**：详情里存在 `queued` / `parsing` 文档且页面可见时，每 3 秒重取文档列表；页面隐藏时停止。`unparsed` 不触发刷新。

**API 客户端** `web/src/lib/api-kb.ts` SHALL 按上面各端点的应答形状严格解析全部应答（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型与方法。

#### Scenario: 不可用与未就绪
- **WHEN** 状态为 `{enabled:true, available:false, …}` 时打开 tab；点 `重试` 后状态变为可用，但 `embeddingReady:false`
- **THEN** 先看到 `知识库服务暂不可用` 与 `重试`，没有 `新建知识库`；重试后看到 `管理员尚未配置知识库嵌入模型`，仍没有 `新建知识库`

#### Scenario: 解析中自动刷新
- **WHEN** 详情的第一次列表里有一份 `parsing`，第二次全部为 `done`
- **THEN** 3 秒后恰重取一次；之后不再重取；`已切片 N` 显示 RAGFlow 给出的切片数

#### Scenario: 编译开关按对话模型显示
- **WHEN** `compileReady:true` 时在新建对话框选 `manual`，再选 `table`；`compileReady:false` 时选 `manual`
- **THEN** 前两次都显示两个复选；`compileReady:false` 时两个都不显示

#### Scenario: 编译状态文案
- **WHEN** 列表里的库 `compile` 依次为 `{raptor:"pending", graph:"off"}`、`{raptor:"running", graph:"done"}`、`{raptor:"failed", graph:"failed"}`、`null`
- **THEN** 依次显示 `尚未产出` 与旁注；`编译中`、`已完成`；两个 `有文档失败`；`状态未知`；页面任何位置都不出现 `编译失败`

#### Scenario: 已切片 0
- **WHEN** 详情里一份文档为 `{status:"done", chunkCount:0}`
- **THEN** 显示 `已切片 0`
