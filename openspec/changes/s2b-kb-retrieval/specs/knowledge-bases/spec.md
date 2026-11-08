## MODIFIED Requirements

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
- **检索测试**：文档表下方、标题 `检索测试` 的一块，只在 `state` 为 `ready` 时渲染。
  - 控件：问句输入框（placeholder `例如 销售额口径 / 弹窗 / 工单超时`）；`相似度阈值` 与 `向量权重` 两个数字输入（0–1，步长 0.01，初值取 `BaseView.retrieval`）；`检索` 按钮。问句为空白或数字越界时 `检索` 禁用，越界的字段旁显示原因；在途时禁用，文字为 `正在检索`。
  - 点 `检索` 恰调用一次 `retrieveFromKnowledgeBase`，body 为问句与两个数字的当前值。成功后面板的两个数字取应答的 `retrieval`，列表里该库的 `retrieval` 同步更新，不重取列表。
  - 还没检索时显示 `输入问题后检索，命中的切片会带出所属文档`；`hits` 为空时显示 `没有命中，换个说法或先把相关文档入库`。
  - 每条命中显示 `#<序号>`（从 1 起）、文档名、`相似度 <similarity 保留两位小数>` 与切片原文（保留换行）。SHALL NOT 显示来源路径与切片序号（owner 2026-11-07 授权偏离 demo；rc2 的应答没有切片序号）。
  - 失败时在面板内以 `role="alert"` 显示信封文案，问句与两个数字保持用户输入。

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
- **THEN** 先显示 `输入问题后检索，命中的切片会带出所属文档`；第一次恰一次 `retrieveFromKnowledgeBase(id, {question:"销售额怎么统计", threshold:0.2, vectorWeight:0.7})`，显示 `#1`、`#2`、两个文档名与 `相似度 0.68` 这样两位小数的分数，页面不出现来源路径与 `切片`；第二次显示 `没有命中，换个说法或先把相关文档入库`

#### Scenario: 检索测试的参数与禁用
- **WHEN** 用户把 `相似度阈值` 改为 `1.5`；改回 `0.1` 并把问句清成空白；再填问句点 `检索`，假客户端在应答前挂起；放行后应答的 `retrieval` 为 `{threshold:0.1, vectorWeight:0.7}`
- **THEN** 前两种情况 `检索` 禁用，`1.5` 时字段旁有原因；挂起期间按钮为 `正在检索` 且禁用；放行后面板显示 `0.1`，列表里该库的 `retrieval` 为新值，没有重取列表

#### Scenario: 检索测试只在 ready 时出现
- **WHEN** 详情的库 `state` 依次为 `ready`、`rebuilding`、`rebuild_failed`
- **THEN** 只有第一次渲染 `检索测试`

#### Scenario: 检索失败
- **WHEN** `retrieveFromKnowledgeBase` 返回 503 `kb_unavailable` 信封
- **THEN** 面板内 `role="alert"` 显示 `知识库服务暂不可用`，问句与两个数字保持用户输入

## ADDED Requirements

### Requirement: 迁移 051 检索参数与重排模型
`server/src/core/db/migrations/051_kb_retrieval.sql` SHALL 只用 `ALTER TABLE … ADD COLUMN` 给两张既有表加列，不改其它表，不插入、不改写任何行：
- `knowledge_bases.retrieval_threshold REAL NOT NULL DEFAULT 0.2`、`knowledge_bases.retrieval_vector_weight REAL NOT NULL DEFAULT 0.7`：各带 CHECK，`typeof` 为 `real` 且取值在 0 与 1 之间（含两端）。既有行取列缺省。
- `kb_settings.rerank_name`、`rerank_base_url`、`rerank_api_key`：`TEXT NULL`。三列同为 NULL 或同为非 NULL，由写入路径整组写入保证（`ADD COLUMN` 加不了表级 CHECK）。
- `kb_settings.rerank_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (… IN ('never','ok','failed'))`、`rerank_probe_at INTEGER NULL`、`rerank_probe_message TEXT NULL`。

`server/test/core-db-helpers.ts` 的跟踪清单 SHALL 加入 `MIGRATION_051`。

#### Scenario: 列与约束
- **WHEN** 在已有一个知识库行的 050 库上应用 051；随后把该库的 `retrieval_threshold` 改为 `1.5`、`-0.1`、`'0.3'`（文本）；把 `retrieval_vector_weight` 改为 `1`
- **THEN** 应用后该行为 `0.2` 与 `0.7`，`kb_settings` 的重排三列为 NULL、`rerank_probe_status` 为 `never`；前三次更新被约束拒绝；最后一次成功且 `typeof` 为 `real`

#### Scenario: 重排三列整组写入
- **WHEN** 经 store 保存、更换与清除一次重排模型
- **THEN** 每一步之后三列同为 NULL 或同为非 NULL

### Requirement: 单轮检索
`kb` 模块 SHALL 只有一处检索实现（「单轮检索」，ADR-0017）：对一个知识库的当前 `dataset_id` 发一次 `POST /api/v1/retrieval`。检索测试端点经它检索，S2c 的 `kb_search` 也只经它检索。`kb` 模块 SHALL NOT 含改写问句、判定证据是否充分或发起第二轮检索的逻辑。

请求 body 恰为 `{question, dataset_ids, similarity_threshold, vector_similarity_weight, page, page_size}`，配置了重排模型时另带 `rerank_id`：
- `dataset_ids` 恰含该库的 `dataset_id`（不是 `rebuild_dataset_id`）。
- `similarity_threshold`、`vector_similarity_weight` SHALL 恒显式传该库的检索参数：RAGFlow 数据集上的同名字段经 API 不可写（实测记录 §19.2），不传即落到 RAGFlow 的缺省值。
- `page` 为 1，`page_size` 为 6。
- SHALL NOT 发送 `top_k`、`keyword`、`highlight`、`use_kg`、`document_ids`。
- `rerank_id` 为 `<重排模型名称>@owb-rerank@OpenAI-API-Compatible`。

结果：
- `code:0` 时读 `data.chunks`：每项须有字符串 `document_id`、字符串 `content` 与数字 `similarity`；缺任一即 `kb_unavailable`。
- 每条按 `document_id` 关联该库本地文档行的 `ragflow_document_id`；关联不上的 SHALL 丢弃。命中视图 `RetrievalHit` 恰为 `{documentId, name, similarity, content}`：
  - `documentId` 为本地文档 id。
  - `name` 取本地记录。
  - `similarity` 与 `content` 原样取 RAGFlow 的值。
- 次序同 RAGFlow 应答。
- 失败映射与重排降级见 ragflow-backend「RAGFlow 出站请求」。

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

#### Scenario: 只有一处检索实现
- **WHEN** 检索测试端点处理一次检索
- **THEN** 它经单轮检索那一个函数发出请求；`server/src` 里没有其它对 `/api/v1/retrieval` 的调用

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
   - **有不同**：取该库的写锁（「同一知识库的写操作串行」）。锁被重建器持有即 409 `kb_rebuilding`。取锁后重读该库：不存在 404，`state` 不是 `ready` 409 `kb_rebuilding`。在同一事务里写两列，并审计 `kb.retrieval_settings`（detail 为写入前后的两组值），然后释放锁再检索。写入失败：不审计、不检索，按通用错误返回。
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
- **THEN** 失败应答；假 RAGFlow 没有收到检索请求；没有 `kb.retrieval_settings`；已存参数不变

#### Scenario: 写回后检索失败
- **WHEN** 以与已存值不同的参数检索，假 RAGFlow 对检索应答 HTTP 503
- **THEN** 503 `kb_unavailable`；参数已是新值，恰一条 `kb.retrieval_settings`

#### Scenario: body 校验
- **WHEN** 所有者依次以 `question:"   "`、1001 码点的问句、含 `\u0007` 的问句、`threshold:1.5`、`vectorWeight:-0.1`、`threshold:"0.3"`、`threshold:1e999`（解析为无穷大）、多一个 `topK` 键检索
- **THEN** 八次都是 400 `bad_request`；假 RAGFlow 收到零个请求；没有审计

#### Scenario: 非 ready 的库
- **WHEN** 一个 `rebuilding` 的库与一个 `rebuild_failed` 的库，所有者以与已存值相同的参数检索
- **THEN** 两次都是 409 `kb_rebuilding`；假 RAGFlow 收到零个请求

#### Scenario: 写回与重建交错
- **WHEN** 重建器正持有该库的写锁，所有者以与已存值不同的参数检索；另一次以相同的参数检索时，该库在检索开始前已被置为 `rebuilding`
- **THEN** 两次都是 409 `kb_rebuilding`，参数不变，假 RAGFlow 没有收到检索请求

### Requirement: `kb_search` 工具契约
S2c 的会话内 `kb_search`（omp 经 `host_tool_call` 调用）SHALL 遵守以下契约，本 change 只定义契约，不注册工具，也不实现分派：
- 输入为问句与一组 kb_ids。
- 对每个调用者可见的知识库各执行一次「单轮检索」，参数取该库已存的检索参数；调用方 SHALL NOT 逐次覆盖检索参数，也 SHALL NOT 写回。
- 每条命中与 `RetrievalHit` 同形；进入模型上下文的只有命中切片与出处，SHALL NOT 有整篇文档（CONTEXT.md 不变量 2）。
- 一次调用只检索一轮：要不要再查、怎么改写问句，由模型以再次调用表达（ADR-0017）。
- 多库命中如何标注所属库、合并与条数，可见范围的过滤与跨账号检索审计，由 S2c 定。

#### Scenario: 契约与检索测试同源
- **WHEN** 评审本 change 合入后的 `server/src`
- **THEN** 没有名为 `kb_search` 的工具注册或 `host_tool_call` 分派；单轮检索是 `/api/v1/retrieval` 的唯一调用点，检索测试端点经它检索
