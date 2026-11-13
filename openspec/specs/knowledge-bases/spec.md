# knowledge-bases Specification

## Purpose
定义每个账号自己的知识库：迁移 050 的三张表，同一知识库写操作的串行，建库、列表与删库端点（含 RAPTOR / 知识图谱的编译资源与编译状态），从工作空间（含只读挂载）与本地上传入库，文档列表与状态，重新入库与移出，知识库审计，以及中心「知识库」tab 的列表、建库、详情、入库与上传界面。RAGFlow 作为后端的接法见 ragflow-backend。

## Requirements

### Requirement: 迁移 050 知识库 schema
`server/src/core/db/migrations/050_knowledge_bases.sql` SHALL 建三张表，并只插入一行数据。

**`kb_settings`**：迁移插入 `id = 'kb'` 的唯一一行。列：
- `id TEXT NOT NULL PRIMARY KEY CHECK (id = 'kb')`。
- `embedding_name`、`embedding_base_url`、`embedding_api_key`：三列同为 NULL 或同为非 NULL。
- `embedding_generation INTEGER NOT NULL DEFAULT 0`。
- `embedding_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (… IN ('never','ok','failed'))`、`embedding_probe_at INTEGER NULL`、`embedding_probe_message TEXT NULL`。
- `chat_model_id TEXT NULL REFERENCES models(id) ON DELETE SET NULL`。
- `rebuild_actor_id TEXT NULL REFERENCES accounts(id)`：最近一次发起或重试重建的管理员。
- `updated_at INTEGER NOT NULL`，迁移种子值为 `0`，表示还没保存过。

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
- `workspace_id TEXT NULL`、`source_path TEXT NULL`、`source_mtime_ms INTEGER NULL`（INTEGER 亲和性保留小数毫秒，不加 `typeof`）；`workspace` 时三列均非 NULL，`upload` 时三列均 NULL。
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
- 检索测试的参数写回：只在提交的参数与已存值不同时取锁，持有到两列的写入提交为止（「检索测试端点」）；检索本身在锁外执行。

写操作 SHALL 在取得锁之后重新判定：该库是否存在、`state` 是否允许本操作、本操作涉及的文档数上限。检索写回另在锁内用重读的值重新比较参数，相同即不写。锁正被重建器持有时，写操作不等待，立即 409 `kb_rebuilding`。

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
知识库开启后，已登录用户 SHALL 能管理自己的知识库。别人的或不存在的 id 一律 404 `not_found`，不可探测：这条对本 Requirement 与下面的入库、上传、文档列表、重新入库、移出与检索测试路由都成立，判定先于 body 解析、`doc` 参数与 `state` 判定，SHALL NOT 发出站请求，SHALL NOT 写审计。全部应答带 no-store。

**视图** `BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, retrieval, createdAt}`：
- `retrieval`：该库的检索参数 `{threshold, vectorWeight}`，取迁移 051 的两列，两者都是 0–1 的数字；只依赖本地行。
- `raptor`、`graph`：布尔，与建库 body 同型，库列的 0 / 1 在视图层转换。
- `createdAt`：`created_at` 的 epoch 毫秒，非负整数。
- `documents`：本地文档行数。
- `compile`：
  - 两个开关都为 0 的库：恒为 `{raptor:"off", graph:"off"}`，不发出站请求。
  - 其余的库：为 `{raptor, graph}`，关着的类型为 `off`，开着的类型按下面的规则从 RAGFlow 现读，各取 `pending` / `running` / `done` / `failed`。

**编译状态的判定**：SHALL NOT 读 `GET …/compilation/status`。每次读该库的文档列表，以及任务日志 `GET /api/v1/datasets/<id>/ingestions`（`orderby=id`、`page_size=100`，逐页读到 `total`）；文档列表已判定为下面第 1 步的 `running` 时不读任务日志。读全后在客户端按日志的 `task_type` 判定类型：RAPTOR 为 `Tree`，知识图谱为 `Graph`；SHALL NOT 用 `dsl.entries[].variants` 判类型，SHALL NOT 用 `keywords` 或 `log_type=file`。对开着的每种类型，按次序：
1. 有本地文档在 RAGFlow 处于 `CREATED` / `SCHEDULED` / `RUNNING` / `STOPPING`，或该类型有 `operation_status` 为 `RUNNING` 的日志：`running`。
2. 有本地文档为 `FAILED`：`failed`。
3. 除 `COMPLETED` 且 `chunk_count` 为 0 的文档外，其余本地文档非空，且每份的 id 都出现在该类型 `operation_status` 为 `DONE` 的全部日志的 `dsl.entries[].doc_id` 并集里：`done`。
4. 其它：`pending`。

`failed` SHALL 只来自文档 `FAILED`。文档已 `COMPLETED` 而该类型没有日志时（RAPTOR 在对话模型失败时没有任何信号）SHALL 保持 `pending`，不得显示 `failed` 或 `done`。文档列表判定该库的数据集为 not-found 时，按读取失败处理。

**`GET /api/kb/bases`**：200 `{bases: BaseView[]}`，按 `created_at` 升序。
- 列表只依赖本地行。
- 各库的编译状态读取并发发出，共用一个 5 s 总期限；没有在期限内读完的库 `compile` 为 `null`，读取失败同此。
- RAGFlow 不可达时列表照常 200。

**`POST /api/kb/bases`**：body 键集为 `name`、`template`、`raptor?`、`graph?`。依次判定：
1. 键集、类型、名称或模板不合规：400 `bad_request`。这一步不读库。
2. 嵌入模型未就绪：409 `kb_not_ready`。
3. 开关为真而知识库对话模型未指定：400 `bad_request`。RAPTOR 与知识图谱对十一种模板都可用，没有按模板的限制。
4. 同账号重名：409 `conflict`。已有 50 个知识库：409 `kb_limit`。

判定 2–4 SHALL 在取得进程级设置锁之后进行，读到的是锁内的设置行与知识库行；建库全程持有这把锁。

下文的「代数」为当前嵌入代数，`<名字>` 为 `owb-<id 前 16 位>-g<代数>`：`<id>` 是知识库 id（32 位小写十六进制），取其前 16 个字符。数据集、模板组与画布 SHALL 同名，由同一处函数生成（建库与重建共用）。`<名字>` 的长度 SHALL 不超过 32 个字符（代数不超过 10 位时成立）：RAGFlow 建入库任务时把画布标题拷进 `pipeline_operation_log.pipeline_title`（`varchar(32)`），超长时任务建不出来，解析触发回 `code:0`、`success_count:0`，日志里没有记录。

两个开关都为 0：
1. `POST /api/v1/datasets`，body `{name:<名字>, parser_id, parse_type:1, embedding_model}`。`parser_id` 在 `naive` 时为 `general`，其余等于模板名。

任一开关为真：
1. `GET /api/v1/models/default` 读账号缺省：`data.models` SHALL 同时有 `model_type` 为 `chat` 与 `embedding`、`model_name` 非空的项。缺任一项：409 `kb_not_ready`，SHALL NOT 发后续请求。
2. `GET /api/v1/compilation-templates/builtins` 取内置 `config`。RAPTOR 用 `id:"tree"`，SHALL 删掉 `entity`、`relation` 与 `llm_id`；知识图谱用 `id:"knowledge_graph"`，SHALL 删掉 `llm_id`。
3. `POST /api/v1/compilation-template-groups`，名为 `<名字>`，`templates` 含开着的类型（`kind` 为 `tree` / `knowledge_graph`）。RAGFlow 对同名组自动加后缀（实测记录 §5.1）；本系统只按 id 引用，SHALL NOT 依赖组名。
4. `GET /api/v1/pipelines/<parser_id>` 取内置 DSL，插入 Compiler 节点（见下），`POST /api/v1/agents`，`title` 为 `<名字>`，`canvas_category` 为 `dataflow_canvas`。
5. `POST /api/v1/datasets`，body `{name:<名字>, parse_type:2, pipeline_id:<画布 id>, embedding_model}`。

两种情形：
- `embedding_model` SHALL 恒显式传三段式 `<名称>@owb-embed@OpenAI-API-Compatible`。
- SHALL NOT 发送 `chunk_method`，也不在 `parser_config` 里发送 RAPTOR 或知识图谱字段。
- 全部成功后插行，并在同一事务里审计 `kb.create`；成功应答为 201 `BaseView`，SHALL NOT 为这个应答读 RAGFlow：`state` 为 `ready`，`stateMessage` 为 `null`，`documents` 为 0，`compile` 里开着的类型为 `pending`，关着的为 `off`，`retrieval` 为 `{threshold:0.2, vectorWeight:0.7}`。
- 任一步失败或插行失败：SHALL 逆序删除这一次已建的资源（数据集 → 画布 → 模板组），按「RAGFlow 出站请求」映射返回。回滚里某一步删除失败即停，SHALL NOT 再删后面的资源，并写一行 stderr 记录（`kb_dataset_leak` 或 `kb_pipeline_leak`，形状见 ragflow-backend「嵌入模型更换与全量重建」），不改变应答。

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
- **THEN** A 得 201 `BaseView`，假 RAGFlow 依次收到读账号缺省、读内置模板、建模板组、读内置 pipeline、建画布与建数据集，名字都是 `owb-<id 前 16 位>-g0`，数据集 body 为 `parse_type:2`、`pipeline_id` 为该画布；B 的列表为 `{bases:[]}`，`DELETE` 为 404 `not_found`，假 RAGFlow 没有收到删除请求

#### Scenario: 普通模板的隔离
- **WHEN** 用户 A 建一个两开关都为 0 的知识库；用户 B 请求列表，并 `DELETE` A 的库 id
- **THEN** B 的列表为 `{bases:[]}`，`DELETE` 为 404 `not_found`；建库之后假 RAGFlow 没有收到任何请求

#### Scenario: 文档路由的所有权
- **WHEN** 用户 B 以 A 的知识库 id，再以一个不存在的 id，分别请求 `POST …/documents`（合法 body）、`GET …/documents`、`DELETE …/documents?doc=<A 的文档 id>`、`POST …/documents/reingest?doc=<A 的文档 id>`、`POST …/uploads?name=a.md`（`application/octet-stream`）与 `POST …/retrieval`（合法 body，参数与 A 的已存值不同）
- **THEN** 十二次都是 404 `not_found`；假 RAGFlow 收到零个请求；没有新增审计；A 的文档行与检索参数不变

#### Scenario: 建库应答不读 RAGFlow
- **WHEN** 知识库对话模型已指定，建一个 `raptor:true` 的库；再建一个两开关都为 0 的库
- **THEN** 两次 201；第一个的应答含 `state:"ready"`、`stateMessage:null`、`documents:0`、`compile:{raptor:"pending", graph:"off"}`、`retrieval:{threshold:0.2, vectorWeight:0.7}`，第二个的 `compile` 为 `{raptor:"off", graph:"off"}`；假 RAGFlow 没有收到文档列表与任务日志请求

#### Scenario: 账号缺省缺失时不建编译资源
- **WHEN** 知识库对话模型已指定，假 RAGFlow 的 `GET /api/v1/models/default` 依次应答：`models` 为空（实测记录 §11.4，悬空时也是这个应答）；只有 `embedding`；只有 `chat`；两种都在；各建一个 `raptor:true` 的库；另一次该读取应答 HTTP 503
- **THEN** 前三次 409 `kb_not_ready`，第四次 201，HTTP 503 那次 503 `kb_unavailable`；除第四次外，假 RAGFlow 都只收到这一次读取，没有建模板组、建画布与建数据集，也没有知识库行

#### Scenario: 建库与设置交错
- **WHEN** 没有开编译的库，知识库对话模型为 `m2`；管理员 C 的嵌入设置 `PUT` 持有设置锁，假 RAGFlow 挂起它的下发；B `PUT /api/kb/settings {chatModelId:null}` 与 A 建 `raptor:true` 的库依次排在锁后，然后放行
- **THEN** B 200；A 400 `bad_request`，它在锁内读到未指定，假 RAGFlow 没有收到 A 的任何请求
- **WHEN** 次序相反：A 与 B 依次排在锁后，然后放行
- **THEN** A 201；B 409 `kb_chat_model_locked`，`chatModelId` 仍为 `m2`

#### Scenario: 普通模板的建库请求
- **WHEN** 两个开关都为 0 时，分别建 `naive` 与 `manual` 模板的库
- **THEN** 假 RAGFlow 只收到两次建数据集，`parser_id` 依次为 `general`、`manual`，都带 `parse_type:1` 与三段式 `embedding_model`；没有模板组、画布请求，body 不含 `chunk_method`

#### Scenario: 十一种模板都能开两个开关
- **WHEN** 知识库对话模型已指定，对十一种模板各建一个 `raptor:true`、`graph:true` 的库，假 RAGFlow 的内置 pipeline 按实测记录 §5.1 (3) 的节点名与下游给出（`qa`、`table` 的 chunker 下游是 Tokenizer，其余九种是 Extractor）
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

#### Scenario: 回滚里的删除失败
- **WHEN** 开了开关的建库，假 RAGFlow 在建数据集时应答 HTTP 503，删画布也应答 HTTP 503；另一次建画布时应答 HTTP 503，删模板组也应答 HTTP 503；再一次全部建成后经注入让插行失败，删数据集应答 HTTP 503
- **THEN** 第一次 stderr 恰一行 `kb_pipeline_leak`，`canvasId`、`groupId` 都非空，没有发出删模板组；第二次恰一行 `kb_pipeline_leak`，`canvasId` 为 `null`、`groupId` 非空；第三次恰一行 `kb_dataset_leak`，没有发出删画布与删模板组；三次的应答都与回滚成功时相同，没有知识库行，没有 `kb.create`

#### Scenario: DSL 无法改写
- **WHEN** 经故障注入，假 RAGFlow 的内置 pipeline 不带 `graph`；另一次带两个 chunker 节点（实测记录里全部内置模板都带 `graph`、都恰一个 chunker，这条校验是防御性的）
- **THEN** 两次都是 503 `kb_unavailable`；假 RAGFlow 没有收到建画布与建数据集，建好的模板组已删除

#### Scenario: 删库
- **WHEN** 删除一个两开关都为 0、有两份文档的知识库；另一次删除时假 RAGFlow 不可达
- **THEN** 第一次 204，假 RAGFlow 收到一次删数据集请求，库与文档行都不在，恰一条 `kb.delete`；第二次 503 `kb_unavailable`，行仍在

#### Scenario: 重建失败时删库
- **WHEN** 一个开了 RAPTOR 的知识库处于 `rebuild_failed`，三个 `rebuild_*` 列非空，所有者删除它；另一个同样的库，假 RAGFlow 对新一代的删数据集应答 `code:403`
- **THEN** 第一次假 RAGFlow 依次收到新一代的删数据集、删画布、删模板组，再收到当前一代的同样三步，204；第二次同样 204，两代都发过删除，恰一条 `kb.delete`

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

#### Scenario: 开编译的库能入库（画布名不超过 32 字符）
- **WHEN** 知识库对话模型已指定；用户建 `{"template":"naive","raptor":true}` 与 `{"template":"naive","graph":true}` 各一个库，并各自从工作空间入库一份 `notes.md`；假 RAGFlow 照真实行为，对绑定画布标题超过 32 个字符的文档触发解析时回 `code:0`、`success_count:0`、不建任务
- **THEN** 两次建库都是 201，假 RAGFlow 收到的数据集名、模板组名与画布标题都等于 `owb-<id 前 16 位>-g0`，长度不超过 32；两次入库都是 201，`documents` 各 1 份、`rejected` 为空；对 32 位 id 与 10 位代数生成的名字长度仍不超过 32

### Requirement: 工作空间来源入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/documents` 把自己工作空间里的文件入库。

**请求**：body `{workspaceId, paths}`。
- `paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个相对路径；空数组或超出个数：400。任一路径的 UTF-8 编码超过 4096 字节：整个请求 400，不写 `sandbox.reject`、`kb.ingest_reject`，路径原文不进审计。
- `workspaceId` 不是当前用户可见的工作空间（别人的或已删除）：整个请求 404 `not_found`，不发出站请求。
- 知识库 `state` 不是 `ready`：整个请求 409 `kb_rebuilding`。

**逐条处理**：在该库的写锁下，每条路径依次经过以下步骤；被拒的条目以括号里的 `reason` 记录：
1. 经 `sandbox.resolve(principal, workspaceId, path, "read")` 解析。被拒为 `outside`；越界照常由 facade 写 `sandbox.reject`。路径上任一分量是符号链接时，`resolve` 拒绝，同样记为 `outside`。
2. 查重与计数：该库已有同一 `(workspaceId, path)`（`duplicate`）；该库已有 500 份文档（`limit`）。
3. 后缀判定：路径 basename 最后一个 `.` 之后的部分转小写，不在该模板的后缀表（实测记录表 C 末列）里，或没有后缀（`unsupported_type`）。这条对全部知识库生效，不分是否开了编译。转小写只用于判定，上传的文件名不改。
4. 打开文件：挂载内经挂载读取，离线即被拒（`offline`）；挂载外以 `O_NOFOLLOW` 打开。不是普通文件或路径不存在即被拒（`not_file`），挂载内外一样。之后对同一 fd 做 `fstat`，得到 `size` 与 `mtimeMs`。
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

**本地失败**：第 8 步的事务失败时，删除这一份已建的文档，整个请求 500，其后条目不再处理；此前已提交的条目保留。

**应答**：只要请求本身合法且本地写入没有失败，即为 201 `{documents: DocumentView[], rejected: {path, reason, message}[]}`。`documents` 的每一条 SHALL 不经读取 RAGFlow 得出：`status` 为 `queued`，`chunkCount`、`message` 为 `null`，`sourceChanged` 为 `false`。`message` 按 `reason` 固定：

| `reason` | `message` |
|---|---|
| `outside` | `目标路径不在你的沙箱内` |
| `not_file` | `不是普通文件，或文件不存在` |
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
- **WHEN** 一个 `naive` 模板的知识库，一批路径依次为：普通文件 `a.md`、只读挂载 `docs/` 下的 `b.pdf`、`../x`、目录 `dir.md`、超过上限的 `big.pdf`、已入库过的 `a.md`、以符号链接为分量的 `link/c.md`
- **THEN** 201；`documents` 为 `a.md` 与 `docs/b.pdf` 两条，每条都是 `status:"queued"`、`chunkCount:null`、`message:null`、`sourceChanged:false`；`rejected` 五条，`reason` 依次为 `outside`、`not_file`、`too_large`、`duplicate`、`outside`；审计有五条 `kb.ingest_reject`、两条 `kb.ingest`、两条 `sandbox.reject`；假 RAGFlow 收到两次上传（字节与源文件一致）与两次解析触发，没有收到文档列表请求

#### Scenario: 路径不存在
- **WHEN** 一个 `naive` 模板的知识库，一批路径依次为：不存在的 `missing.md`、普通文件 `a.md`、在线挂载 `docs/` 下不存在的 `gone.pdf`、不存在且没有后缀的 `missing`
- **THEN** 201；`documents` 只有 `a.md`；`rejected` 依次为 `missing.md`（`not_file`）、`docs/gone.pdf`（`not_file`）、`missing`（`unsupported_type`，后缀判定在打开之前）；没有 `sandbox.reject`；假 RAGFlow 恰收到一次上传

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

#### Scenario: 路径过长
- **WHEN** 一批路径里有一条的 UTF-8 编码是 4097 字节
- **THEN** 整个请求 400，没有上传，没有 `sandbox.reject`，没有 `kb.ingest_reject`；恰 4096 字节的路径不是请求错误，按逐条处理走

#### Scenario: 插行或审计失败
- **WHEN** 文件已上传并触发解析，第 8 步的事务失败
- **THEN** 这一份文档被删除，整个请求 500，没有文档行，没有 `kb.ingest`；此前已提交的条目保留

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
3. 客户端中途断开，发送的字节少于 `Content-Length`，或读请求体超过期限：中止出站请求；不插行，不写 `kb.ingest`。期限从取到写锁起算，按 `Content-Length` 以每秒 64 KiB 折算，不少于 60 秒；到期回 400 `bad_request`。排队时间不算。
4. 上传回 `code:500` 且 message 表明不支持这种文件：400 `kb_file_unsupported`，并审计 `kb.ingest_reject`（`reason: unsupported_type`）。
5. 上传成功后，触发该文档的解析。
6. 解析触发失败：删除该文档，按「RAGFlow 出站请求」映射返回；回 `code:0` 而 `success_count` 为 0 时同样删除该文档，返回 400 `kb_rejected`。
7. 都成功后，在同一事务里插行并审计 `kb.ingest`。

**成功应答**：201 `DocumentView`，SHALL 不经读取 RAGFlow 得出：`source` 为 `upload`，`workspaceId`、`path` 与 `sourceChanged` 为 `null`，`status` 为 `queued`，`chunkCount`、`message` 为 `null`。

#### Scenario: 上传不落盘
- **WHEN** 上传一个 1 MiB 的文件
- **THEN** 201，应答 `status:"queued"`、`chunkCount:null`、`message:null`、`sourceChanged:null`；假 RAGFlow 收到的文件字节与请求体一致，multipart 的 `Content-Length` 与实际字节数相等，没有收到文档列表请求；上传期间与之后，`SANDBOX_ROOT`、`OMP_STATE_DIR` 与系统临时目录里都没有新增文件

#### Scenario: 超限与缺少长度
- **WHEN** 以 `KB_UPLOAD_MAX_BYTES + 1` 的 `Content-Length` 上传；另一次以分块传输、不带 `Content-Length` 上传
- **THEN** 第一次 413 `upload_too_large`，一条 `kb.ingest_reject`；第二次 400 `bad_request`；两次都没有出站请求

#### Scenario: 上传的后缀与空文件
- **WHEN** 向 `paper` 模板的库上传 `a.txt`；再上传一个 `Content-Length: 0` 的 `b.pdf`
- **THEN** 两次都是 400 `kb_file_unsupported`，没有出站请求；两条 `kb.ingest_reject`，`reason` 依次为 `unsupported_type`、`empty`

#### Scenario: 上传回不支持的文件
- **WHEN** 上传后缀在模板表里的 `a.pdf`，假 RAGFlow 应答 HTTP 200 `code:500` 与实测记录里不支持文件的 message
- **THEN** 400 `kb_file_unsupported`；一条 `kb.ingest_reject`（`reason: unsupported_type`）；没有文档行，没有 `kb.ingest`；假 RAGFlow 没有收到解析触发与删除

#### Scenario: 上传的文档数上限
- **WHEN** 知识库已有 500 份文档时上传；另一次已有 499 份时两个上传并发
- **THEN** 第一次 409 `kb_limit`，一条 `kb.ingest_reject`（`reason: limit`），没有出站请求；第二次恰一个 201、一个 409 `kb_limit`，最终恰 500 行

#### Scenario: 客户端中断
- **WHEN** 请求声明 1 MiB，发送 512 KiB 后断开连接
- **THEN** 出站上传被中止；没有文档行，没有 `kb.ingest`；假 RAGFlow 上没有留下这份文档

#### Scenario: 请求体太慢
- **WHEN** 请求声明 1 MiB，以低于期限折算的速度持续发送，每次间隔都短于出站空闲期限
- **THEN** 期限到时 400 `bad_request`，出站上传被中止，写锁放开，排队的写操作继续；没有文档行，没有 `kb.ingest`；假 RAGFlow 上没有留下这份文档

#### Scenario: 解析触发失败
- **WHEN** 上传成功，但假 RAGFlow 对解析触发应答 HTTP 503；另一次应答 `code:0` 且 `success_count:0`
- **THEN** 第一次 503 `kb_unavailable`，第二次 400 `kb_rejected`；两次假 RAGFlow 都收到删除该文档的请求；没有文档行

### Requirement: 文档列表与状态
所有者 SHALL 能经 `GET /api/kb/bases/:id/documents` 读文档列表，应答 200 `{documents: DocumentView[]}`，按 `created_at` 升序，带 no-store。
- 状态以 RAGFlow 为准，每次请求时读取：先读本地行，再分页读取该数据集的全部文档（`page_size` 为 100，`orderby=create_time`，`desc=false`，读到 `total` 为止，不设页数上限），按 RAGFlow 文档 id 关联；不起后台轮询。翻页期间的写入可能让这次读漏掉一行，该条显示 `missing`，下一次读取修正。
- 数据集本身为 not-found 时，全部文档为 `missing`。
- RAGFlow 不可达：503 `kb_unavailable`。

**视图** `DocumentView` 恰为 `{id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：
- `size`：字节数，非负整数。
- `createdAt`：`created_at` 的 epoch 毫秒，非负整数。
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

#### Scenario: 数据集丢失
- **WHEN** 一个有两份文档的知识库，假 RAGFlow 对文档列表应答 `code:404`
- **THEN** 200；两条的 `status` 都是 `missing`，`chunkCount`、`message` 为 `null`

#### Scenario: 0 切片
- **WHEN** 假 RAGFlow 报告一份文档 `COMPLETED` 且 `chunk_count` 为 0
- **THEN** 该条 `status` 为 `done`，`chunkCount` 为 0

#### Scenario: 未知运行状态
- **WHEN** 经故障注入，假 RAGFlow 的列表里有一份文档的 `ingestion_status` 不在记录的八种之内
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
- 上传失败：`kb_rejected` 时 400 `kb_rejected`；不支持的文件时 400 `kb_file_unsupported`；不可达或数据集不存在时 503 `kb_unavailable`。行不变，没有新文档要删。
- 解析触发失败：删除新文档，行不变。`kb_rejected` 或 `code:0` 而 `success_count` 为 0 时 400 `kb_rejected`；不可达或数据集不存在时 503 `kb_unavailable`。
- 成功：在单事务里更新该行的 RAGFlow 文档 id、`size` 与 `source_mtime_ms`，并审计 `kb.ingest`；再按下面的删除写法删除旧的 RAGFlow 文档，失败只写一行 `{"event":"kb_document_leak","documentId":<id>}`。应答 200 `DocumentView`，SHALL 不经读取 RAGFlow 得出：`status` 为 `queued`，`chunkCount`、`message` 为 `null`，`sourceChanged` 为 `false`。

**移出**：所有者 SHALL 能经 `DELETE /api/kb/bases/:id/documents?doc=<文档 id>` 移出文档，在该库的写锁下进行。
- 允许的 `state`：`ready` 与 `rebuild_failed`；`rebuilding` 时 409 `kb_rebuilding`。
- 先按下面的删除写法删 RAGFlow 文档：不存在视为已删；结果为 `failed` 时按「RAGFlow 出站请求」映射（不可达 503），行不变；结果为 `busy` 时 409 `kb_document_busy`，行不变。
- 再删行，并审计 `kb.document_delete`，应答 204。源文件不动。

**RAGFlow 文档的删除写法**：`code:0` 不代表删成了，RAGFlow 对 `RUNNING`、`STOPPING` 的文档回 `deleted:0` 且行仍在。SHALL 检查 `deleted`：
1. 发删除。`deleted:1` 或不存在：完成。
2. `deleted:0`：发一次停止解析，整个写法里只发这一次（`STOPPING` 时重复停止是空操作）。结果：
   - `code:0`，不论 `success_count`，或不存在：继续第 3 步。
   - 其余（不可达、被拒）：结果为 `failed`，SHALL NOT 重试。
3. 每 500 ms 重发删除，至多 5 s（期限经装配注入）。`deleted:1` 或不存在：完成。`deleted:0`：继续。不可达或被拒：结果立即为 `failed`。
4. 到期仍为 `deleted:0`：结果为 `busy`。

第 1 步的删除不可达或被拒，结果同样为 `failed`。

SHALL NOT 在 `deleted:0` 时删除本地行。

**两者共用的校验**：`doc` 缺失、为空或多值：400；文档不属于该库：404。

#### Scenario: 重新入库
- **WHEN** 源文件改写后对该文档重新入库
- **THEN** 200 返回新的 `DocumentView`（`sourceChanged: false`）；假 RAGFlow 依次收到上传、解析触发、删除旧文档

#### Scenario: 源不可读
- **WHEN** 源文件已被删除后对该文档重新入库
- **THEN** 409 `kb_source_unreadable`；该行不变；假 RAGFlow 没有收到上传

#### Scenario: 重新入库的失败不动行
- **WHEN** 对同一份文档依次重新入库五次，假 RAGFlow 分别应答：上传 `code:101`；上传 `code:500` 与不支持文件的 message；上传 HTTP 503；上传成功、解析触发 HTTP 503；上传成功、解析触发 `code:0` 且 `success_count:0`
- **THEN** 依次 400 `kb_rejected`、400 `kb_file_unsupported`、503 `kb_unavailable`、503 `kb_unavailable`、400 `kb_rejected`；后两次假 RAGFlow 收到删除新文档的请求，前三次没有；五次该行都不变，旧文档都没有被删，没有 `kb.ingest`

#### Scenario: 移出不动源文件
- **WHEN** 移出一份工作空间来源的文档
- **THEN** 204；工作空间里的源文件字节不变；恰一条 `kb.document_delete`

#### Scenario: 移出解析中的文档
- **WHEN** 假 RAGFlow 对一份文档的删除先应答 `code:0`、`deleted:0`，收到停止解析之后应答 `deleted:1`
- **THEN** 204；假 RAGFlow 依次收到删除、停止、删除；行已删除，恰一条 `kb.document_delete`

#### Scenario: 停止已在 STOPPING 的文档
- **WHEN** 一份文档处于 `STOPPING`：假 RAGFlow 对删除应答 `deleted:0`，对停止应答 `code:0`、`success_count:1` 且状态不变；再两次删除仍是 `deleted:0`，随后文档变为 `STOPPED`，删除应答 `deleted:1`
- **THEN** 204；假 RAGFlow 恰收到一次停止解析与四次删除

#### Scenario: 停止解析的其余结果
- **WHEN** 删除应答 `deleted:0` 之后，假 RAGFlow 对停止解析依次在三次移出里应答：`code:0`、`success_count:0`；`code:100` 与 `Documents not found: ['<id>']`；HTTP 503
- **THEN** 前两次继续重发删除，得到 `deleted:1` 或不存在，204；第三次 503 `kb_unavailable`，行不变，没有再发删除

#### Scenario: 重试期间不可达
- **WHEN** 删除应答 `deleted:0`，停止解析成功，重发的删除应答 HTTP 503
- **THEN** 立即 503 `kb_unavailable`，不等到期；行不变，没有 `kb.document_delete`

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
知识库相关审计 SHALL 只用下表八种 kind。标题为中文短句；detail 的键集恰如下表，SHALL NOT 含密钥、文件内容或 RAGFlow 应答原文。

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
| `kb.settings` | 保存设置 | `{embedding?: <名称>, chatModelId?: string \| null, rerank?: <名称> \| null}` |
| `kb.settings` | 探活嵌入模型 | `{probe: "ok" \| "failed"}` |
| `kb.settings` | 探活重排模型 | `{rerankProbe: "ok" \| "failed"}` |
| `kb.rebuild` | 确认重建 | `{bases, documents}` |
| `kb.rebuild` | 重试 | `{bases, documents, retry:true}` |
| `kb.rebuild` | 单库结束 | `{id, result:"ok", skipped: string[]}` 或 `{id, result:"failed"}` |
| `kb.retrieval_settings` | 检索测试写回检索参数 | `{id, before:{threshold, vectorWeight}, after:{threshold, vectorWeight}}` |

规则：
- actor 为请求的 principal；重建器写的单库记录，actor 为 `kb_settings.rebuild_actor_id`。
- 工作空间来源的记录，`workspaceId` 列为该工作空间；其余为 null。
- 每条成功审计与它对应的那一次本地写入在同一事务内；本地写入失败时不留审计。确认重建的那次保存写 `kb.settings` 与 `kb.rebuild` 两条，其余每次写入一条。
- `kb.ingest_reject` 没有对应的本地写入，单独写入。
- 设置保存没有实际写入时（`chatModelId` 或 `rerank` 由 `null` 到 `null`）不写审计；检索测试的参数与已存值相同时不写回，也不写审计。检索本身不写审计。同身份重存嵌入模型也是一次写入，写一条；`kb.settings` 的 detail 只含实际变化的键，可以为空。

#### Scenario: detail 不含敏感内容
- **WHEN** 以内容含哨兵串的文件完成一次工作空间入库、一次本地上传、一次重新入库与一次移出，以带密钥哨兵的 body 保存一次知识库模型设置（含 `embedding` 与 `rerank`），并以含哨兵串的问句完成一次带写回的检索测试
- **THEN** 全部审计行的 `title` 与 `detail` 都不含任一哨兵；各行的 detail 键集与上表一致

#### Scenario: 写入失败不留审计
- **WHEN** 经注入让文档行插入失败
- **THEN** 没有 `kb.ingest` 审计；假 RAGFlow 收到删除刚上传文档的请求

### Requirement: 中心「知识库」tab
`/center?tab=knowledge-bases` SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时对所有用户可见（见 model-registry「中心页外壳」），渲染当前用户的知识库。

**状态行**：
- `available:false`：页顶以 `role="alert"` 显示 `知识库服务暂不可用` 与 `重试` 按钮（重取状态与列表），本 tab 其余控件不渲染。模型 tab 的「知识库模型」段不受影响（ragflow-backend「知识库可用性」）。
- `embeddingReady:false`：显示 `管理员尚未配置知识库嵌入模型`，不渲染 `新建知识库`。

**列表**：
- 每个知识库一行：名称、模板中文名、`RAPTOR` / `知识图谱` 标签与其编译状态、文档数、`重建中` / `重建失败` 标记。
- 编译状态文案：`pending` 为 `尚未产出`，旁注 `解析完成后长时间没有变化，可能是知识库对话模型不可用，请联系管理员`；`running` 为 `编译中`；`done` 为 `已完成`；`failed` 为 `有文档失败`；`compile` 为 `null` 时为 `状态未知`。这些文案 SHALL NOT 含 `编译失败`：`pending` 没有失败信号，`failed` 来自文档。
- 点行进入详情。
- 每行有 `删除知识库`，先弹确认对话框，确认后恰调用一次 `deleteKnowledgeBase`；`state` 为 `rebuilding` 时不渲染，`rebuild_failed` 时渲染。
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
- 知识库 `state` 不是 `ready` 时，入库、上传与重新入库按钮不渲染；`rebuild_failed` 时 `移出` 仍渲染，`rebuilding` 时不渲染。
- **检索测试**：文档表下方、标题 `检索测试` 的一块，只在 `state` 为 `ready` 时渲染；SHALL NOT 渲染 demo 面板头的 `召回 → 重排 → 引用` 标签（重排是可选的）。
  - 控件：问句输入框（placeholder `例如 销售额口径 / 弹窗 / 工单超时`）；`相似度阈值` 与 `向量权重` 两个数字输入（0–1，步长 0.01，初值取 `BaseView.retrieval`）；`检索` 按钮。问句为空白，或任一数字字段为空、不是数字、越界时 `检索` 禁用；数字字段无效时该字段旁显示原因（问句空白只禁用、不显示原因：初始态即为空白）；在途时禁用，文字为 `正在检索`。
  - 点 `检索`，或在问句框按 Enter，恰调用一次 `retrieveFromKnowledgeBase`，body 为问句与两个数字的当前值；按钮禁用时 Enter 不发请求。成功后面板的两个数字取应答的 `retrieval`，列表里该库的 `retrieval` 同步更新，不重取列表。
  - 还没检索时显示 `输入问题后检索，命中切片会带出所属文档`；`hits` 为空时显示 `没有命中，换个说法或先把相关文档入库`。
  - 每条命中显示 `#<序号>`（从 1 起）、文档名、`相似度 <similarity 保留两位小数>` 与切片原文（保留换行）。SHALL NOT 显示来源路径与切片序号（owner 2026-11-07 授权偏离 demo；rc2 的应答没有切片序号）。
  - 失败时在面板内以 `role="alert"` 显示信封文案，问句与两个数字保持用户输入。这次提交的参数与面板初值（打开详情时的 `BaseView.retrieval`，或上一次成功应答的 `retrieval`）或列表里该库当前的 `retrieval` 任一不同时，SHALL 重取一次知识库列表：写回可能已成功（「检索测试端点」第 5 步）。

**刷新**：详情里存在 `queued` / `parsing` 文档且页面可见时，每 3 秒重取文档列表；页面隐藏时停止。`unparsed` 不触发刷新。入库、上传与重新入库成功后重取一次文档列表，写端点返回的 `queued` 由此进入 3 秒刷新。

**API 客户端** `web/src/lib/api-kb.ts` SHALL 提供 `retrieveFromKnowledgeBase(id, {question, threshold, vectorWeight})`，并按上面各端点的应答形状严格解析全部应答（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型与方法。

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

#### Scenario: 检索测试的命中与空态
- **WHEN** 详情的库为 `ready`、`retrieval:{threshold:0.2, vectorWeight:0.7}`；用户先不检索；再输入 `销售额怎么统计` 点 `检索`，假客户端返回两条命中；再检索一次，返回 `hits:[]`
- **THEN** 先显示 `输入问题后检索，命中切片会带出所属文档`；第一次恰一次 `retrieveFromKnowledgeBase(id, {question:"销售额怎么统计", threshold:0.2, vectorWeight:0.7})`，显示 `#1`、`#2`、两个文档名与 `相似度 0.68` 这样两位小数的分数，检索结果里不出现来源路径与 `切片`（文档表本身显示 `已切片 N` 与来源路径，不在此列）；第二次显示 `没有命中，换个说法或先把相关文档入库`

#### Scenario: 检索测试的参数与禁用
- **WHEN** 用户把 `相似度阈值` 改为 `1.5`；改回 `0.1` 并把问句清成空白；再填问句点 `检索`，假客户端在应答前挂起；放行后应答的 `retrieval` 为 `{threshold:0.1, vectorWeight:0.7}`
- **THEN** 前两种情况 `检索` 禁用，`1.5` 时字段旁有原因；挂起期间按钮为 `正在检索` 且禁用；放行后面板显示 `0.1`，列表里该库的 `retrieval` 为新值，没有重取列表

#### Scenario: 清空数字字段
- **WHEN** 用户清空 `相似度阈值`；再在 `向量权重` 里填 `abc`
- **THEN** 两次 `检索` 都禁用，该字段旁有原因；`retrieveFromKnowledgeBase` 零次调用

#### Scenario: Enter 检索
- **WHEN** 问句为 `工单超时` 时在问句框按 Enter；再把问句清成空白后按 Enter
- **THEN** 第一次恰一次 `retrieveFromKnowledgeBase`；第二次零次

#### Scenario: 检索测试只在 ready 时出现
- **WHEN** 详情的库 `state` 依次为 `ready`、`rebuilding`、`rebuild_failed`
- **THEN** 只有第一次渲染 `检索测试`

#### Scenario: 检索失败
- **WHEN** `retrieveFromKnowledgeBase` 返回 503 `kb_unavailable` 信封
- **THEN** 面板内 `role="alert"` 显示 `知识库服务暂不可用`，问句与两个数字保持用户输入

#### Scenario: 失败后列表与服务端一致
- **WHEN** 库的 `retrieval` 为 `{0.2, 0.7}`；用户改为 `{0.1, 0.7}` 检索，`retrieveFromKnowledgeBase` 返回 503 `kb_unavailable`，随后 `listKnowledgeBases` 返回该库 `retrieval:{0.1, 0.7}`；另一次以未改动的参数检索失败
- **THEN** 第一次失败后恰一次 `listKnowledgeBases`，切到别的库再切回来时面板初值为 `0.1`；第二次失败后没有重取列表

### Requirement: 迁移 051 检索参数与重排模型
`server/src/core/db/migrations/051_kb_retrieval.sql` SHALL 只用 `ALTER TABLE … ADD COLUMN` 给两张既有表加列，不改其它表，不插入、不改写任何行：
- `knowledge_bases.retrieval_threshold REAL NOT NULL DEFAULT 0.2`、`knowledge_bases.retrieval_vector_weight REAL NOT NULL DEFAULT 0.7`：各带 CHECK，`typeof` 为 `real` 且取值在 0 与 1 之间（含两端）。既有行取列缺省。
- `kb_settings.rerank_name`、`rerank_base_url`、`rerank_api_key`：`TEXT NULL`。三列同为 NULL 或同为非 NULL，由写入路径整组写入保证（`ADD COLUMN` 加不了表级 CHECK）。
- `kb_settings.rerank_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (… IN ('never','ok','failed'))`、`rerank_probe_at INTEGER NULL`、`rerank_probe_message TEXT NULL`。

`server/test/core-db-helpers.ts` 的跟踪清单 SHALL 加入 `MIGRATION_051`。

#### Scenario: 列与约束
- **WHEN** 在已有一个知识库行的 050 库上应用 051；随后把该库的 `retrieval_threshold` 改为 `1.5`、`-0.1`、`'abc'`（非数字文本；数字形态的文本如 `'0.3'` 会被 `REAL` 亲和性转成 `real`，不在此列）；把 `retrieval_vector_weight` 改为 `1`
- **THEN** 应用后该行为 `0.2` 与 `0.7`，`kb_settings` 的重排三列为 NULL、`rerank_probe_status` 为 `never`；前三次更新被约束拒绝；最后一次成功且 `typeof` 为 `real`

#### Scenario: 重排三列整组写入
- **WHEN** 经 store 保存、更换与清除一次重排模型
- **THEN** 每一步之后三列同为 NULL 或同为非 NULL

### Requirement: 单轮检索
`kb` 模块 SHALL 只有一处检索实现（「单轮检索」，ADR-0017）：对一个知识库的当前 `dataset_id` 发一次 `POST /api/v1/retrieval`。检索测试端点与会话检索 `kb_search`（「会话检索 `kb_search`」）都只经它检索。`kb` 模块 SHALL NOT 含改写问句、判定证据是否充分或发起第二轮检索的逻辑。

请求 body 恰为 `{question, dataset_ids, similarity_threshold, vector_similarity_weight, page, page_size}`，配置了重排模型时另带 `rerank_id`：
- `dataset_ids` 恰含该库的 `dataset_id`（不是 `rebuild_dataset_id`）。
- `similarity_threshold`、`vector_similarity_weight` SHALL 恒显式传该库的检索参数：RAGFlow 数据集上的同名字段经 API 不可写（实测记录 §19.2），不传即落到 RAGFlow 的缺省值。
- `page` 为 1，`page_size` 为 6。
- SHALL NOT 发送 `top_k`、`keyword`、`highlight`、`use_kg`、`document_ids`。
- `rerank_id` 为 `<重排模型名称>@owb-rerank@OpenAI-API-Compatible`。

结果：
- `code:0` 时读 `data.chunks`：它 SHALL 是数组（零命中时为 `[]`，实测记录 §19.1），每项须有字符串 `document_id`、字符串 `content` 与数字 `similarity`；`chunks` 不是数组或某项缺字段即 `kb_unavailable`。
- 每条按 `document_id` 关联该库本地文档行的 `ragflow_document_id`；关联不上的 SHALL 丢弃。零候选或全部丢弃时结果为空数组，不是错误。命中视图 `RetrievalHit` 恰为 `{documentId, name, similarity, content}`：
  - `documentId` 为本地文档 id。
  - `name` 取本地记录。
  - `similarity` 与 `content` 原样取 RAGFlow 的值。
- 次序同 RAGFlow 应答。
- 失败映射与重排降级见 ragflow-backend「RAGFlow 出站请求」。
单轮检索 SHALL 接受一个可选的中止信号，并把它传给检索请求与重排降级的那一次重试。信号已中止时 SHALL NOT 发出请求；请求进行中被中止时，结果与期限到期相同，为 `kb_unavailable`（ragflow-backend「RAGFlow 出站请求」）。检索测试端点不传信号。

#### Scenario: 参数显式传
- **WHEN** 一个库的检索参数为 `{threshold:0.35, vectorWeight:0.5}`，未配置重排模型，检索 `工单超时`
- **THEN** 假 RAGFlow 恰收到一次 `/api/v1/retrieval`，body 恰为 `{question:"工单超时", dataset_ids:[<该库 dataset_id>], similarity_threshold:0.35, vector_similarity_weight:0.5, page:1, page_size:6}`

#### Scenario: 带重排
- **WHEN** 管理员配置了名为 `qwen3-rerank` 的重排模型，检索任一问句
- **THEN** 请求 body 另含 `rerank_id:"qwen3-rerank@owb-rerank@OpenAI-API-Compatible"`

#### Scenario: 命中关联本地文档
- **WHEN** 假 RAGFlow 回三条切片：第一条的 `document_id` 属于本地文档 `notes.md`（RAGFlow 侧 `document_keyword` 为 `notes(1).md`），第二条属于本地文档 `brief.pdf`，第三条的 `document_id` 没有本地行
- **THEN** 命中恰两条，依次为 `{documentId:<notes 的本地 id>, name:"notes.md", …}` 与 `brief.pdf` 那条，`similarity` 与 `content` 等于 RAGFlow 的值

#### Scenario: 应答缺字段
- **WHEN** 假 RAGFlow 的某条切片缺 `similarity`（故障注入）
- **THEN** 503 `kb_unavailable`

#### Scenario: 零命中
- **WHEN** 假 RAGFlow 按实测记录 §19.1 回零命中 `{code:0, data:{chunks:[], doc_aggs:[], labels:null, total:0}, message:null}`
- **THEN** 单轮检索的结果为空数组，不是 `kb_unavailable`

#### Scenario: 只有一处检索实现
- **WHEN** 检索测试端点处理一次检索；会话检索处理一次 `kb_search`；另扫描 `server/src`
- **THEN** 两者都经单轮检索那一个函数发出请求；客户端的检索方法只在 `kb/retrieval.ts` 里被调用，RAGFlow 的检索路由片段（`${API}/retrieval` 或 `/api/v1/retrieval`）只出现在 `kb/ragflow-retrieval.ts`；本系统自己的 `/api/kb/bases/:id/retrieval` 不算

#### Scenario: 中止
- **WHEN** 假 RAGFlow 挂起检索应答，调用方中止信号；另一例在调用之前信号已中止
- **THEN** 前者结果为 `kb_unavailable`，假 RAGFlow 观察到连接被放弃；后者结果为 `kb_unavailable`，假 RAGFlow 没有收到请求
- **WHEN** 配置了重排模型，带重排的检索回 `code:102`，降级重试发出之前信号被中止
- **THEN** 结果为 `kb_unavailable`，假 RAGFlow 只收到一次检索请求

### Requirement: 检索测试端点
知识库开启后，所有者 SHALL 能经 `POST /api/kb/bases/:id/retrieval` 对自己的一个知识库做单轮检索，并在检索时写回该库的检索参数。body limit 16 KiB，应答带 no-store。

依次判定：
1. 所有权（见「知识库端点」）：别人的或不存在的 id 404 `not_found`，先于 body 解析，不发出站请求，不写审计。
2. body 键集恰为 `question`、`threshold`、`vectorWeight`：
   - `question`：去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL 的字符串；原样发出，不去空白。
   - `threshold`、`vectorWeight`：0–1 的有限数字（含两端）。
   - 不符：400 `bad_request`，不发出站请求。
3. `state` 不是 `ready`（含 `rebuild_failed`）：409 `kb_rebuilding`，不发出站请求。
4. 两个参数与已存值逐个比较：
   - **都相同**：不写库，不审计，直接检索。
   - **有不同**：取该库的写锁（「同一知识库的写操作串行」，FIFO）。锁被重建器持有即 409 `kb_rebuilding`。取锁后重读该库：不存在 404 `not_found`，不发检索；`state` 不是 `ready` 409 `kb_rebuilding`。
     SHALL 用重读的值再比较一次：已相同则释放锁，不写、不审计，直接检索；仍不同则在同一事务里写两列，并审计 `kb.retrieval_settings`（detail 的 `before` 取锁内重读的值，`after` 为提交的值），然后释放锁再检索。
     写入失败：不审计、不检索，通用 500，body SHALL NOT 声称任何 typed code。
5. 检索（「单轮检索」）。写回成功之后检索失败时，参数已保存，应答为检索的失败。

成功应答 200 恰为 `{hits: RetrievalHit[], retrieval: {threshold, vectorWeight}}`。`retrieval` 为这次检索实际使用的参数，即写回后的已存值。检索本身 SHALL NOT 写审计。

#### Scenario: 参数不变只检索
- **WHEN** 一个库的检索参数为缺省 `{0.2, 0.7}`，所有者以 `{question:"销售额", threshold:0.2, vectorWeight:0.7}` 检索
- **THEN** 200，`retrieval` 为 `{threshold:0.2, vectorWeight:0.7}`；没有新增审计；`knowledge_bases` 的 `updated_at` 不变

#### Scenario: 参数变了先写回
- **WHEN** 同一库以 `{question:"销售额", threshold:0.1, vectorWeight:0.9}` 检索；随后 `GET /api/kb/bases`
- **THEN** 200，`retrieval` 为 `{0.1, 0.9}`，假 RAGFlow 收到的 body 带 `similarity_threshold:0.1`、`vector_similarity_weight:0.9`；恰一条 `kb.retrieval_settings`，detail 为 `{id, before:{threshold:0.2, vectorWeight:0.7}, after:{threshold:0.1, vectorWeight:0.9}}`；列表里该库的 `retrieval` 为新值

#### Scenario: 写回失败不检索
- **WHEN** 经注入让参数写入失败，以与已存值不同的参数检索
- **THEN** 500，body 不声称任何 typed code；假 RAGFlow 没有收到检索请求；没有 `kb.retrieval_settings`；已存参数不变

#### Scenario: 零命中与全部关联不上
- **WHEN** 以已存参数检索，假 RAGFlow 回零命中；另一次回两条切片，`document_id` 都没有本地行
- **THEN** 两次都是 200 `{hits:[], retrieval:{threshold:0.2, vectorWeight:0.7}}`

#### Scenario: 写回排在入库之后
- **WHEN** 一批工作空间入库持有该库的写锁（假 RAGFlow 挂起上传），所有者以与已存值不同的参数检索；随后放行上传
- **THEN** 入库结束之后写回才执行，检索 200；假 RAGFlow 收到的检索请求在上传之后，带新参数；恰一条 `kb.retrieval_settings`

#### Scenario: 排队时库被删除
- **WHEN** 删库持有该库的写锁（假 RAGFlow 挂起删数据集），所有者以与已存值不同的参数检索；随后放行
- **THEN** 删库 204；检索 404 `not_found`；假 RAGFlow 没有收到检索请求；没有 `kb.retrieval_settings`

#### Scenario: 并发的相同提交
- **WHEN** 已存 `{0.2, 0.7}`，同一所有者并发提交两次 `{threshold:0.1, vectorWeight:0.7}`
- **THEN** 两次都是 200；恰一条 `kb.retrieval_settings`，`before` 为 `{0.2, 0.7}`，`after` 为 `{0.1, 0.7}`

#### Scenario: 写回后检索失败
- **WHEN** 以与已存值不同的参数检索，假 RAGFlow 对检索应答 HTTP 503
- **THEN** 503 `kb_unavailable`；参数已是新值，恰一条 `kb.retrieval_settings`

#### Scenario: body 校验
- **WHEN** 所有者依次以 `question:"   "`、1001 码点的问句、含 `\u0007` 的问句、`threshold:1.5`、`vectorWeight:-0.1`、`threshold:"0.3"`、`threshold:1e999`（解析为无穷大）、多一个 `topK` 键、缺 `vectorWeight` 键检索
- **THEN** 九次都是 400 `bad_request`；假 RAGFlow 收到零个请求；没有审计

#### Scenario: 非 ready 的库
- **WHEN** 一个 `rebuilding` 的库与一个 `rebuild_failed` 的库，所有者以与已存值相同的参数检索
- **THEN** 两次都是 409 `kb_rebuilding`；假 RAGFlow 收到零个请求

#### Scenario: 写回与重建交错
- **WHEN** 重建器正持有该库的写锁，所有者以与已存值不同的参数检索；另一次以相同的参数检索时，该库在检索开始前已被置为 `rebuilding`
- **THEN** 两次都是 409 `kb_rebuilding`，参数不变，假 RAGFlow 没有收到检索请求

### Requirement: 会话检索 `kb_search`
知识库开启时，kb 模块 SHALL 为会话提供宿主工具 `kb_search` 的定义与执行（omp-runtime「`kb_search` 的注册」「宿主工具协议」）。本要求中，一个账号「可见的库」就是它拥有的库（可见范围四档在后续 change）。

**定义**：只读本地库表，不访问 RAGFlow。账号一个库都没有时没有定义。否则定义恰为：
- `name:"kb_search"`、`label:"知识库检索"`、`loadMode:"essential"`。
- 参数 schema `{type:"object", properties:{question:{type:"string"}, kb_ids:{type:"array", items:{type:"string"}, minItems:1, maxItems:5}}, required:["question","kb_ids"], additionalProperties:false}`。
- `description` 为固定的中文说明，之后逐行列出该账号的全部库：`- <名称>（<id>）`，按建库时间升序。固定说明 SHALL 讲清三件事：
  - 返回的是切片与出处。
  - 一次至多 5 个库，每库至多 6 条。
  - 证据不足时可以改写问句或换库再次调用。
- 注册比较的「库清单」即 `[{id, name}]` 依同一次序排列。

**执行**：输入为调用者的账号 id、参数与中止信号，依次判定：
1. **参数**：
   - 键集恰为 `question`、`kb_ids`。
   - `question` 按检索测试端点同一条规则判定：去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL；原样检索，不去空白。
   - `kb_ids` 为数组，元素为非空字符串，按首次出现去重后为 1–5 个。
   - 不符：`isError`，文本说明不符之处；去重后超过 5 个时，文本恰为 `一次至多检索 5 个知识库`。不访问 RAGFlow。
2. **逐库**（按去重后的次序）：
   - 不存在或不是调用者的库：状态 `not_found`。两种情形的文本与 `details` 完全相同，不回显任何名称，SHALL NOT 能据此探测别人的库。
   - `state` 不是 `ready`：状态 `not_ready`，不检索。
   - 其余库各做一次单轮检索（「单轮检索」，参数取该库已存的检索参数，带上中止信号），彼此并发：成功为 `ok`（命中可以为零条），`kb_unavailable` 或 `kb_rejected` 为 `failed`。
3. **结果**：
   - **给模型的文本**：各库按次序分段，段间空一行。
     - `ok`：首行 `知识库「<名称>」（<id>）：命中 <n> 条`，其后每条命中两行：`[<序号>] <文档名>（相似度 <similarity 保留四位小数>）` 与切片原文。
     - `not_found`：恰一行 `知识库 <id>：未找到该知识库`。
     - `not_ready`：恰一行 `知识库「<名称>」（<id>）：正在重建，本轮未检索`。
     - `failed`：恰一行 `知识库「<名称>」（<id>）：检索失败`。
     - 文本里只有切片原文与出处（库、文档名、相似度），SHALL NOT 有整篇文档（CONTEXT.md 不变量 2）。
   - **`details`**：恰为 `{bases:[{kbId, name, status, hits}]}`，次序同上。
     - `name` 在 `not_found` 时为 `null`，其余为本地名称。
     - `status ∈ {ok, not_found, not_ready, failed}`。
     - `hits` 在 `ok` 时为该库的 `RetrievalHit` 数组，其余为 `[]`。
   - **`isError`**：当且仅当没有任何一个库是 `ok`。
4. **不做的事**：不写回检索参数，不写审计；切片原文 SHALL NOT 进入日志或 stderr。

#### Scenario: 定义
- **WHEN** 账号依次建了库 `产品文档`（id `k1`）与 `客服问答`（id `k2`），取定义；另一账号没有库
- **THEN** 前者的定义 `loadMode` 为 `essential`，描述末尾两行依次为 `- 产品文档（k1）` 与 `- 客服问答（k2）`，库清单为 `[{id:"k1",name:"产品文档"},{id:"k2",name:"客服问答"}]`；后者没有定义；两次取定义假 RAGFlow 都没有收到请求

#### Scenario: 两个库都命中
- **WHEN** 以 `{question:"工单超时", kb_ids:["k1","k2"]}` 执行，假 RAGFlow 对 k1 回两条切片、对 k2 回一条
- **THEN** 假 RAGFlow 恰收到两次检索，各带该库的 `dataset_id` 与已存参数；`isError` 为假；文本两段，第一段首行为 `知识库「产品文档」（k1）：命中 2 条`；`details.bases` 依次为 k1（`ok`，两条命中）与 k2（`ok`，一条）；`knowledge_bases` 的检索参数与 `updated_at` 不变，没有新增审计

#### Scenario: 部分失败与不可探测
- **WHEN** 以 `kb_ids:["k1","nope","other-owner-kb","k3"]` 执行：`nope` 不存在，`other-owner-kb` 属于另一账号，k3 处于 `rebuilding`，k1 的检索被假 RAGFlow 以 HTTP 503 应答
- **THEN** `isError` 为真；文本依次为 `知识库「产品文档」（k1）：检索失败`、`知识库 nope：未找到该知识库`、`知识库 other-owner-kb：未找到该知识库`、`知识库「<k3 的名称>」（k3）：正在重建，本轮未检索`；`nope` 与 `other-owner-kb` 两项的 `details` 除 `kbId` 外完全相同（`name:null`、`status:"not_found"`、`hits:[]`）；假 RAGFlow 只收到 k1 的一次检索
- **WHEN** 同一调用里 k1 改为正常命中零条
- **THEN** `isError` 为假，k1 的段为 `知识库「产品文档」（k1）：命中 0 条`

#### Scenario: 参数校验
- **WHEN** 依次以缺 `kb_ids`、多一个键 `top_k`、`kb_ids:[]`、`kb_ids:[""]`、去重后六个 kb_id、`question:"   "`、1001 码点的问句执行
- **THEN** 七次都是 `isError`，假 RAGFlow 收到零个请求；去重后六个时文本恰为 `一次至多检索 5 个知识库`
- **WHEN** 以 `kb_ids:["k1","k1"]` 执行
- **THEN** 只检索 k1 一次，`details.bases` 一项

#### Scenario: 中止
- **WHEN** 假 RAGFlow 挂起检索，执行中止信号
- **THEN** 该库为 `failed`；执行在信号中止后结束，不再等待假 RAGFlow
