## MODIFIED Requirements

### Requirement: 知识库端点
知识库开启后，已登录用户 SHALL 能管理自己的知识库。别人的或不存在的 id 一律 404 `not_found`，不可探测：这条对本 Requirement 与下面的入库、上传、文档列表、重新入库、移出路由都成立，判定先于 body 解析、`doc` 参数与 `state` 判定，SHALL NOT 发出站请求，SHALL NOT 写审计。全部应答带 no-store。

**视图** `BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`：
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
- 全部成功后插行，并在同一事务里审计 `kb.create`；成功应答为 201 `BaseView`，SHALL NOT 为这个应答读 RAGFlow：`state` 为 `ready`，`stateMessage` 为 `null`，`documents` 为 0，`compile` 里开着的类型为 `pending`，关着的为 `off`。
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
- **WHEN** 用户 B 以 A 的知识库 id，再以一个不存在的 id，分别请求 `POST …/documents`（合法 body）、`GET …/documents`、`DELETE …/documents?doc=<A 的文档 id>`、`POST …/documents/reingest?doc=<A 的文档 id>` 与 `POST …/uploads?name=a.md`（`application/octet-stream`）
- **THEN** 十次都是 404 `not_found`；假 RAGFlow 收到零个请求；没有新增审计；A 的文档行不变

#### Scenario: 建库应答不读 RAGFlow
- **WHEN** 知识库对话模型已指定，建一个 `raptor:true` 的库；再建一个两开关都为 0 的库
- **THEN** 两次 201；第一个的应答含 `state:"ready"`、`stateMessage:null`、`documents:0`、`compile:{raptor:"pending", graph:"off"}`，第二个的 `compile` 为 `{raptor:"off", graph:"off"}`；假 RAGFlow 没有收到文档列表与任务日志请求

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
