# 知识库运维说明

`system.md` §9.13 的正文（S2a，change `s2a-kb-ragflow`）。单独成文件，`system.md` 那一节只留指引。

本节随任务组落地。组 4：配置键、密钥文件要求与 `kb_key` 阶段。组 6：`kb` 模块装配、关闭判定、状态端点与版本钉住。组 8：知识库模型设置、下发到 RAGFlow、探活与 `models` 联动。组 9 首刀：普通模板的建库、列表与删库，模板表。组 9 第二刀：开了 RAPTOR / 知识图谱的建库与删库，模板组与画布的生命周期。组 9 第三刀：列表里的编译状态。组 10：工作空间来源入库与 RAGFlow 文档的删除写法。组 11：文档列表。组 12：本地上传。组 13：移出与重新入库。组 14：嵌入模型更换与全量重建。组 18：部署要求、回滚与 `make smoke-kb`（文末）。web 侧（组 15–17）的界面契约在 spec，不在本文。

**配置键**（`server/src/kb/config.ts`；四项都可选，下面的配对规则另算）：

| 键 | 缺省 | 规则 |
|---|---|---|
| `RAGFLOW_BASE_URL` | 未配置，即知识库关闭 | 只有协议与 authority（`http` 或 `https`），无路径、无结尾斜杠、无查询与片段；不接受 userinfo（不能含 `@`，这一点与 `PREVIEW_ORIGIN` 不同）；空串非法 |
| `RAGFLOW_API_KEY_FILE` | 未配置 | 绝对路径；空串非法。配置解析时不读这个文件 |
| `KB_UPLOAD_MAX_BYTES` | `104857600` | 单个文件的字节上限，与 `UPLOAD_MAX_BYTES` 同一解析纪律（canonical 十进制正整数，`1..2147483647`） |
| `KB_UPLOAD_MAX_FILES` | `10` | 一次上传的文件数上限，解析纪律同上（`1..2147483647`） |

`RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE` 必须成对：只配一个是配置错误。任一项非法，服务启动失败：退出码 1，标准错误只有一行 `{"event":"server_start_failed","reason":"config"}`，不指出是哪一项、也不回显取值。

**密钥文件**（`server/src/kb/key-file.ts`）。RAGFlow 的 API key 放文件、不放环境变量：key 一旦泄露，就能读写全部账号的知识库；放在 `0600` 文件里，它不进 `/proc/<pid>/environ`，也不被 app-server 派生的进程继承。要求：

- 是普通文件本身：符号链接、目录、FIFO 都不行（以 `O_NOFOLLOW` 打开，判定与读取都走同一个描述符）。
- 属主是服务进程的 uid，组与其它用户没有任何权限位（`mode & 0o077` 为 0，`0600`、`0400` 都合规）。
- 大小 1–4096 字节。
- 内容去掉恰一个结尾 `\n` 后非空，且能作 HTTP 头值：不含 `\r`、NUL、第二个 `\n`，没有 U+00FF 之上的字符。

部署时这样写出：

```sh
install -m 600 -o <服务用户> /dev/null <密钥文件路径>
printf '%s\n' "$KEY" > <密钥文件路径>
```

**`kb_key` 阶段**：紧接配置解析、先于建 DB 父目录。配置了 `RAGFLOW_BASE_URL` 才读文件，未配置时不读任何文件。任一条要求不满足，服务启动失败：退出码 1，标准错误只有一行 `{"event":"server_start_failed","reason":"kb_key"}`，不带路径、文件内容与原始错误，此时没有建目录、没有开 DB、没有 listen。补救：逐条核对上面四项要求。

启动不连接 RAGFlow：地址写错或 RAGFlow 没起来都不影响启动。

**密钥的去向**：读出的 key 只留在一个只读句柄的闭包里，入口把句柄经 `createApp` 的 `kb` 字段交给 `kb` 模块，不进日志、审计、响应与任何子进程环境。omp 的 spawn 环境是白名单（`server/src/sessions/omp/spawn-env.ts`），`RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` 都不在其中。文件**路径**仍在 app-server 的环境里：同 uid 部署（未配置 `OMP_USER`）时 omp 能以同 uid 读这个文件，与 S0b 已登记的同 uid 风险是同一项，按 ADR-0010 的专用 uid 部署关闭。

**`kb` 模块**（`server/src/kb/index.ts`、`kb/rest.ts`）：createApp 的第十二个模块，注册与启动记录的 `modules` 都紧随 `connectors`。未配置 `RAGFLOW_BASE_URL` 时模块照常注册，只是不建客户端。配置了时只建一个 RAGFlow 客户端实例：下面的限频状态在实例里。

**知识库关闭**（未配置 `RAGFLOW_BASE_URL`）：`GET /api/kb/status` 返回 `{enabled:false}`；其余已注册的 `/api/kb/*` 路由返回 503 `kb_disabled`，带 `Cache-Control: no-store`，不发任何出站请求。这个判定是 root `preParsing` 钩子，次序：未登录 401 → 503 `kb_disabled` → 管理员 403 → body 解析。所以坏 JSON 与非管理员拿到的也是 503。没有注册的 `/api/kb/…` 路径仍是 404 `not_found`。

**`GET /api/kb/status`**：任何已登录用户可调，未登录 401，应答都带 `Cache-Control: no-store`。开启时应答恰为 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`：

| 字段 | 含义 |
|---|---|
| `available` | 版本接口可达，且版本串恰为 `v1.0.0-rc2` |
| `embeddingReady` | 已配置知识库嵌入模型（`kb_settings`） |
| `compileReady` | 已指定知识库对话模型（`kb_settings`） |
| `uploadMaxBytes`、`uploadMaxFiles` | `KB_UPLOAD_MAX_BYTES`、`KB_UPLOAD_MAX_FILES` 的配置值 |

**版本钉住**：每次状态请求发一次 `GET <RAGFLOW_BASE_URL>/api/v1/system/version`，总期限 5 s，不带密钥。RAGFlow 不可达或版本不符都是 200 加 `available:false`，不是错误。版本钉住只决定 `available`，其它知识库端点不因版本不符而拒绝请求。升级 RAGFlow 是一次代码变更（`kb/rest.ts` 的常量），要重跑实测。

**两条限频的 stderr 记录**，都恰只有 `event` 一个键，经同一受管 writer 写出，同一进程 60 秒内各至多一行：

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_version_mismatch"}` | 版本接口可达，版本串不是 `v1.0.0-rc2`。不可达时不写 | 把 RAGFlow 换回钉住的版本，或按升级流程改钉住的版本 |
| `{"event":"kb_upstream_auth_failed"}` | RAGFlow 应答 HTTP 401，或 body `code` 为 401 / 403（`DELETE /datasets` 的 `code:403` 是「不存在」，不算） | 核对密钥文件里的 key 是否仍有效；换 key 要重启服务 |

**知识库模型设置**（`server/src/kb/settings.ts`）：四个端点都只给管理员，次序是未登录 401 → 关闭时 503 `kb_disabled` → 非管理员 403 → body 解析；成功应答都是 200 加读视图，带 `Cache-Control: no-store`。

| 端点 | 作用 |
|---|---|
| `GET /api/kb/settings` | 读 |
| `PUT /api/kb/settings` | 保存：先下发到 RAGFlow，成功后在同一事务里写 `kb_settings` 与审计；下发失败本地不变 |
| `POST /api/kb/settings/probe` | 探活嵌入模型（bodyless），不下发，不改嵌入身份 |
| `POST /api/kb/settings/rebuild` | 重试失败的重建（bodyless），见下面的「嵌入模型更换与全量重建」 |

读视图恰为 `{embedding, chatModelId, bases, compileBases, documents, rebuilding, rebuildFailed}`，不含任何密钥。`embedding` 是 `{name, baseUrl, probe}` 或 `null`；`compileBases` 是 `raptor` 或 `graph` 为 1 的库数，含重建中与重建失败的库。

`PUT` 的 body 键集是 `embedding`、`chatModelId`、`confirmRebuild` 的子集，且至少含前两者之一。`embedding` 是 `{name, baseUrl, apiKey?}`：`name` 1–128 字节、无控制字符、不含 `@`；首次配置必须带 `apiKey`，之后省略即保留已存的值，空串或纯空白是 400。`chatModelId` 是 `models` 里带上游的 id（不含 `@`）或 `null`。`embedding.name` 与 `chatModelId` 不含 `@`，是因为 RAGFlow 用三段式 `<名称>@<实例>@<提供方>` 引用它们。

当前值非 `null` 且有开编译的知识库时，`chatModelId` 改为 `null` 或别的 id 都是 409 `kb_chat_model_locked`，同 id 照常下发：Compiler 的 `llm_id` 建库时固化，换模型会让旧库打到新上游。没有开编译的库时，改为 `null` 只改本地；已是 `null` 再设 `null` 是无操作，不写库、不审计。

嵌入身份是 `(name, baseUrl)`，只换密钥不算身份变化。身份变化且已有知识库时：有库处于 `rebuilding` 即 409 `kb_rebuilding`（带不带 `confirmRebuild` 都一样）；没带 `confirmRebuild:true` 即 409 `kb_rebuild_required`，不下发、不保存；带了就照常下发并保存，同时发起全量重建（见下面的「嵌入模型更换与全量重建」）。

**下发的固定序列**：两个实例名是常量，`owb-embed` 承载嵌入模型，`owb-chat` 承载知识库对话模型，提供方都是 `OpenAI-API-Compatible`。一个实例的一轮下发：

1. `PUT /api/v1/providers`，body `{provider_name}`（幂等）。
2. `GET /api/v1/models`，按 `provider_name` 与 `instance_name` 判断实例是否存在。
3. 不存在：`POST …/instances`，body `{instance_name, api_key, base_url, model_info}`。存在：`GET …/instances/<实例>/models`，再 `PUT …/instances/<实例>`，body 同样四个键，`model_info` 为现有模型加本次的模型，同名项以本次为准。
4. `PATCH /api/v1/models/default`，body `{model_provider, model_instance, model_name, model_type}`。

body 含 `embedding` 时先下发嵌入模型，再重发当时指定的对话模型（该行没有上游时跳过），所以管理员保存一次嵌入模型就能把两种缺省都补回来。只含 `chatModelId` 时只下发对话模型。`api_key` 恒为实际密钥：RAGFlow 按 trim 后的值写入，空串或纯空白会清空实例密钥，所以都不发出。不用 `PATCH /api/v1/users/me/models`，也不用 `GET …/instances/<实例>`：它明文回显上游密钥。下发不是原子的，第 3 步成功、第 4 步失败时 RAGFlow 已是新值、本地仍是旧值；重试同一次保存即收敛。

**账号缺省不变量**：`kb` 模块不发清空缺省的 `PATCH /api/v1/models/default`（只带 `model_type`，或名字为空串），也不调用 `/api/v1/providers` 下的任何 `DELETE`。RAGFlow 里的模型配置只增、只覆盖。账号没有缺省对话模型而有 pipeline 数据集时，数据集级合并任务会让全栈唯一的入库进程崩溃循环，影响栈上全部账号（实测记录 §13）。客户端没有这些调用的写法，`setDefaultModel` 拒绝发出空名字。

**取消指定不撤销**：`chatModelId` 改为 `null` 只改本地，账号缺省仍指向 `owb-chat`。上游密钥留在 RAGFlow 里，直到下一次下发覆盖或运维清理。运维清理要按实测记录 §16 的次序：账号缺省保持不动，先删数据集、画布、模板组，静默到没有编译活动，才清缺省、删实例。

**与 `models` 的联动**（`modelWriteGuard`，D1、D7）：`kb` 注册时给出钩子，`app.ts` 把它绑给 `models`（`kb` 注册晚于 `models`，钩子在写入时才读）；知识库关闭时没有钩子，`models` 直接写，删除经外键把 `chat_model_id` 置空，已下发的副本不撤销，重新开启后保存一次设置即覆盖。开启时 `DELETE /api/models` 与 `PUT /api/models` 的写入整段由钩子包住，在设置锁内依次：`plan`（`models/store.ts` 的 `planUpdate`，校验 body，算候选上游与 `upstreamChanged`，不写库，所以非法 body 400、不发 RAGFlow 请求）→ 引用判定 → 需要时重新下发 → 写入回调。这一行是 `kb_settings.chat_model_id` 时：

| 写入 | 结果 |
|---|---|
| `DELETE` | 409 `kb_model_in_use`，行不变；这一行同时是缺省模型时也是这个码，取消指定之后才是 `model_in_use` |
| `PUT` 且 `upstream: null` | 409 `kb_model_in_use`，行不变；这一行的上游已经是空的也是 409（知识库关闭期间清空过），要先配上上游或取消指定 |
| `PUT` 且 `upstreamChanged` 为真 | 候选密钥纯空白时 400 `bad_request`，不发 RAGFlow 请求，行不变。否则按候选上游把 `owb-chat` 重新下发一轮（序列同上，`max_tokens` 取这次修改之后的值），成功后才写库；下发失败按映射回 503 `kb_unavailable` / 400 `kb_rejected`，行、审计与 `models.yml` 都不变，但 `owb-chat` 可能已是候选上游（第 3 步成功、第 4 步失败）。重试同一次修改即收敛；放弃修改时保存一次知识库模型设置，用本地的行覆盖 |
| `PUT` 且 `upstreamChanged` 为假 | 不下发，直接写：只改名或只改 `maxTokens` 不碰 RAGFlow，`model_info` 里的 `max_tokens` 留到下一次下发更新 |

开编译的库不影响这张表：同一行轮换密钥或改地址照常下发。没有被引用的行不碰 RAGFlow，删除也一样，账号缺省仍指向已下发的配置。引用判定与写入在同一次设置锁内，所以与一次并发的保存只有两种次序：保存在前，修改判定为已引用并重新下发，删除得 409；修改或删除在前，保存读到写入之后的行。发布（`registry.refresh()` 与 `models.yml`）在钩子之外，不占设置锁。

**探活**：向嵌入上游发 `POST <baseUrl>/embeddings`，body `{model, input:"ping"}`，期限同模型探活（连接 10 s、总 15 s），不跟随重定向。2xx 且 `data[0].embedding` 为非空数字数组是 `ok`，否则是 `failed`。未配置嵌入模型时 409 `kb_not_ready`。保存时名称、地址或密钥任一变化，探活状态在同一事务里重置为 `never`；三者都不变时保留。

**写操作串行**：保存全程持进程级设置锁，取值规则与身份判定在锁内做，读到的是锁内的行。探活的请求在锁外，只有写回在锁内：结果只写回发起时的同一身份（名称、地址、密钥），身份已变时丢弃、不审计，应答回当前读视图。探活逐次串行：一条进程级链把「读身份 → 发请求 → 取锁写回」整段排队，后发的排在在途的之后，身份在排到时读取，前一个失败不影响后一个。这条链不并进设置锁，探活不能占锁 15 s。

每次保存写一条 `kb.settings` 审计，detail 只含实际变化的键（`embedding` 为模型名，`chatModelId`），可以为空；探活写一条，detail 是 `{probe}`。

**知识库端点**（`server/src/kb/bases.ts`，组 9 首刀与第二刀；编译状态在 `server/src/kb/compile-status.ts`，第三刀）：三条路由对任何已登录用户开放，只操作自己的库，全部应答带 `Cache-Control: no-store`。别人的或不存在的 id 一律 404 `not_found`，两者不可区分，判定先于 body 解析与 `state`，不发出站请求，不写审计。管理员没有例外。

| 端点 | 作用 |
|---|---|
| `GET /api/kb/bases` | 200 `{bases: BaseView[]}`，按 `created_at` 升序。库与文档数只读本地行；开了开关的库另现读编译状态，读不到为 `null`，RAGFlow 不可达时照常 200 |
| `POST /api/kb/bases` | 建库，201 `BaseView` |
| `DELETE /api/kb/bases/:id` | 删库，204 |

`BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`：`raptor`、`graph` 是布尔；`documents` 是本地文档行数；`createdAt` 是 epoch 毫秒整数；两个开关都为 0 的库 `compile` 恒为 `{raptor:"off", graph:"off"}`，不发出站请求。开了开关的库：建库的 201 不读 RAGFlow，开着的类型为 `pending`、关着的为 `off`；列表里关着的类型为 `off`，开着的按下面的「编译状态」现读，取 `pending` / `running` / `done` / `failed`，整库读不到时 `compile` 为 `null`。

**建库**：body 键集是 `name`、`template`、`raptor?`、`graph?`。`name` 1–64 码点，无 C0 与 DEL，不 trim。依次判定：

1. 键集、类型、名称或模板不合规：400 `bad_request`。这一步不读库。
2. 嵌入模型未配置：409 `kb_not_ready`。
3. `raptor` 或 `graph` 为真而知识库对话模型未指定：400 `bad_request`。RAPTOR 与知识图谱对十一种模板都可用，没有按模板的限制。
4. 同账号重名：409 `conflict`。这个账号已有 50 个知识库：409 `kb_limit`。

第 2–4 步在进程级设置锁内做，建库全程持锁，所以不会建出代数过期的库，也不会与一次设置保存交错：保存排在建库之后，读到新建的库，换嵌入身份得 409 `kb_rebuild_required`，取消指定或更换对话模型得 409 `kb_chat_model_locked`；取消指定排在建库之前，建库读到未指定，400。

通过之后建 RAGFlow 资源，然后在同一事务里插行与写 `kb.create`。201 的 `BaseView` 不读 RAGFlow。两个开关都关：`POST /api/v1/datasets`，body `{name, parser_id, parse_type:1, embedding_model}`，没有模板组与画布。任一开关开：见下面的「编译资源」，数据集是 `parse_type:2`。

- 数据集名 `owb-<id 前 16 位>-g<代数>`：`<id>` 是知识库 id（32 位小写十六进制），取前 16 个字符；`<代数>` 是锁内读到的当前嵌入代数。开了开关的库，模板组与画布用同一个名字，建库与重建都经 `kb/pipeline.ts` 的 `resourceName` 生成。名字不超过 32 个字符（代数不超过 10 位时）：RAGFlow 建入库任务时把画布标题拷进 `pipeline_operation_log.pipeline_title`（`varchar(32)`），超长时任务建不出来，解析触发回 `code:0`、`success_count:0`，日志里没有记录（#1900）。用户可见的名称只存在本地，RAGFlow 不感知用户。
- `embedding_model` 恒显式传三段式 `<名称>@owb-embed@OpenAI-API-Compatible`：不传时回落到账号缺省甚至空值，缺省悬空时建库成功、到解析才失败。不发 `chunk_method`，RAGFlow 回 `101`。
- RAGFlow 的结果按客户端的映射返回（400 `kb_rejected` 或 503 `kb_unavailable`），不插行。
- 插行或审计写入失败：按删除次序删掉这一次建的资源（数据集 → 画布 → 模板组），应答 500。删除失败即停，写一行 leak，不改变应答。

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_dataset_leak","datasetId":<id>}` | 回滚删不掉数据集：RAGFlow 里留下一个本地没有行的数据集。开了开关的库，它的画布与模板组没有去删，也还在 | 按 `datasetId` 在 RAGFlow 里手工删除；开了开关的，再按数据集名（`owb-<id 前 16 位>-g<代数>`，画布与模板组同名）先删画布、再删模板组。这条记录不限频 |
| `{"event":"kb_pipeline_leak","canvasId":<id\|null>,"groupId":<id\|null>}` | 回滚删不掉画布（两个 id 都在，模板组没有去删）或模板组（画布已删，`canvasId` 为 `null`） | 按 id 在 RAGFlow 里先删画布、再删模板组。这条记录不限频 |

**编译资源**（`server/src/kb/pipeline.ts`，组 9 第二刀）。RAPTOR 与知识图谱不是数据集字段：`parser_config` 里的开关被 RAGFlow 静默丢弃。开了开关的库是三样资源：一个模板组、一个引用它的画布（ingestion pipeline），以及以这个画布建的 `parse_type:2` 数据集。每个库每一代一套，不共用。建库时建第 0 代；重建时新建一代，`rebuild_*` 三列记新一代（见下面的「嵌入模型更换与全量重建」）。解析时 Compiler 节点在 pipeline 里自动运行，没有单独的编译触发。

建一代（`createPipeline`，建库与重建共用；调用方持锁，它自己不取锁）：

1. `GET /api/v1/models/default`，只读。`data.models` 里 `chat` 与 `embedding` 两种都在、`model_name` 非空才继续；缺一种即 409 `kb_not_ready`，不发后续请求；重建时是该库 `rebuild_failed`。这一步挡的是 RAGFlow 侧被人手工清空缺省：没有缺省对话模型时，pipeline 数据集的数据集级合并会让全栈唯一的入库进程崩溃循环。本系统自己从不清空缺省（见上面的「账号缺省不变量」）。补救：管理员保存一次嵌入模型，两种缺省都会重新下发。
2. `GET /api/v1/compilation-templates/builtins` 取内置 `config`。RAPTOR 用 `tree`，删掉 `entity`、`relation`、`llm_id`（内置 `entity.fields` 带一条空 `type`，原样提交回 `102`）；知识图谱用 `knowledge_graph`，删掉 `llm_id`。
3. `POST /api/v1/compilation-template-groups`，名为 `owb-<id 前 16 位>-g<代数>`，`templates` 是开着的类型各一项。RAGFlow 对同名组自动加后缀，本系统只按应答里的 id 引用。
4. `GET /api/v1/pipelines/<parser_id>` 取内置 DSL，插一个 `Compiler:Owb` 节点：按 `obj.component_name` 含 `Chunker` 找 chunker（各模板节点名不同），插在它与原下游之间，`components` 与 `graph` 两处都改，`graph.edges` 里 chunker 的出边改从 Compiler 出发、原边不留，再加 chunker → Compiler 一条。Compiler 的 `llm_id` 留空，建数据集时 RAGFlow 把它固化成账号当时的缺省对话模型。然后 `POST /api/v1/agents`，`title` 同名，`canvas_category` 为 `dataflow_canvas`。内置 DSL 没有 `graph`，或 chunker 不是恰一个：503 `kb_unavailable`，不提交。`graph` 不能省：省掉时建画布、建库都回 `code:0`，文档静默换解析器、编译不运行。
5. `POST /api/v1/datasets`，body `{name, parse_type:2, pipeline_id:<画布 id>, embedding_model}`。

任一步失败，逆序删掉这一次已建的资源再返回这一步的结果：建画布失败删模板组，建数据集失败先删画布再删模板组。回滚同样即停，删除失败写上表的 leak。超时而 RAGFlow 实际已建成、或资源建好后进程崩溃，会留下无法自动对账的孤儿，只能按名字前缀 `owb-` 手工清理。

删一代（`deletePipeline`）：次序固定为数据集 → 画布 → 模板组，上一步确认已删（成功或不存在）之前不发下一步，任一步失败即停。这两个删除接口没有引用保护：删了在用的画布或模板组，RAGFlow 回 `code:0`，之后解析 `FAILED`，所以次序只能由本系统保证。客户端的删画布与删模板组只有 `pipeline.ts` 调用。「不存在」视为已删：删数据集 `code:403`、删画布 `code:103`、删模板组 `code:404`。普通库的这一代只有数据集。

**编译状态**（`server/src/kb/compile-status.ts`，组 9 第三刀）。`GET /api/kb/bases` 对每个开了开关的库现读两份数据，不缓存，没有后台轮询：

- 该库在 RAGFlow 的全部文档：与文档列表同一个读法（`GET …/documents?page=<n>&page_size=100&orderby=create_time&desc=false`，读到 `total` 或空页），按 RAGFlow 文档 id 关联本地文档行。RAGFlow 里没有本地行的文档（`kb_document_leak` 留下的）不参与判定。
- 数据集任务日志 `GET /api/v1/datasets/<id>/ingestions?page=<n>&page_size=100&orderby=id`，逐页读到 `total`，读到空页也停（`total` 是那一页说的，翻页期间可能变）。读全之后按每行的 `task_type` 分类型：RAPTOR 为 `Tree`，知识图谱为 `Graph`。`total` 是日志行数（一份文档一种类型一条），不是文档数。

读法的依据（实测记录 §5.3、§18 #26–#29）：

- 不读 `GET …/compilation/status`：按类型读没有终态，跑完之后与「从未编译」同为 `idle`；不带类型的 `state` 在多文档时往返，文档还在排队时也可能是 `completed`。
- `orderby=id` 不能省：缺省的 `create_time` 次序里 `Tree`、`Graph` 两条常在同一毫秒建出，翻页会重复一行、丢一行，重读结果相同，读不回来。
- 不发 `task_type=`（静默忽略，回全部行）、`keywords=`（关键字匹配，不是类型过滤）、`log_type=file`（文档级日志，一页约 1.2 MB，超过客户端 1 MiB 的上限）。
- 不用 `dsl.entries[].variants` 判类型：两种都开时两条日志都是 `["structure","tree"]`。

对开着的每种类型按次序判定，关着的为 `off`：

1. 有本地文档在 RAGFlow 处于 `CREATED` / `SCHEDULED` / `RUNNING` / `STOPPING`，或该类型有 `operation_status` 为 `RUNNING` 的日志：`running`。文档这一半由文档列表就能定，这时两种都是 `running`，不读任务日志。
2. 有本地文档 `FAILED`：`failed`。图谱失败、模板组缺失、缺省嵌入模型缺失都表现为文档 `FAILED`；失败分不出类型，两种都算，解析器失败也算。`failed` 只有这一个来源。
3. 除 `COMPLETED` 且 0 切片的文档外（这种文档编译不运行），其余本地文档非空，且每份都出现在该类型 `DONE` 日志的 `dsl.entries[].doc_id` 并集里：`done`。要看到每份文档，所以日志读全才判定，不提前停。
4. 其它：`pending`。`operation_status` 的未知取值落在这里。

读不到时该库的 `compile` 整体为 `null`（spec 给 web 的文案是「状态未知」，组 15 剩余渲染），不影响列表本身，也不影响别的库：

- 文档列表回数据集不存在（`code:404`）；文档列表或任务日志的任何一页失败、超时或缺字段；`DONE` 日志读不出 `dsl.entries[].doc_id`。
- 本地文档的 `ingestion_status` 在八种之外：协议漂移，不知道它是不是还在跑，不能判 `done`。文档列表端点对同一情形回 503，这里只让这个库读不到。
- 总期限：一次列表里各库的读取并发发出，共用一个 5 s 的总期限；到期没读完的库为 `null`，之后不再发任何一页。在途的那个请求照走客户端自己的期限，结果丢弃。

代价：每个开了开关的库一次列表读一次文档列表；没有文档在排队或解析时，再逐页读任务日志。一份文档一种类型一条日志，500 份文档两种都开是 1000 行、10 页，一页约 87 KB。

已知限制：

- **RAPTOR 可能完全没有信号。** 对话模型失败（密钥无效、实例已删除）时，文档照常 `COMPLETED`、有切片，任务日志没有 `Tree` 记录（实测记录 §5.4）。这时 `raptor` 停在 `pending`：没有失败信号，所以不显示 `failed`；也没有完成记录，所以不显示 `done`。第 3 步要逐份覆盖，中途才坏掉的情形同样不会显示 `done`。文档阶段的这个失败在 RAGFlow 里只有容器日志，本系统读不到。spec 给 web 的 `pending` 文案是「尚未产出」，旁注写明可能是知识库对话模型不可用（组 15 剩余渲染）。
- 翻页期间有新日志写入：`id` 不随时间递增，新日志可能插到已读的页之前，这次可能漏读一行。结果是第 3 步少覆盖一份、显示 `pending`，不会错报 `done`，下一次读取修正。
- `page_size` 在 200 行以上的上限未测，取 100 不依赖它；`dsl.entries` 观察到恒为 1 项，按并集读，多项时同样成立。

**删库**：`state` 为 `rebuilding` 时 409 `kb_rebuilding`；写锁正被重建器持有时同样 409，不排队。否则在该库的写锁下逐代走上面的删一代：`rebuild_failed` 且新一代已建时先删新一代，再删当前一代。上一步确认已删之前不发下一步。取锁之后重判存在性与 `state`：排队期间库可能已删除（404）或转入重建（409）。

- `DELETE /api/v1/datasets` 的 `code:403` 是「不存在」（实测记录表 B），视为已删，不写 `kb_upstream_auth_failed`；删画布的 `code:103`、删模板组的 `code:404` 同样。
- 不可达或别的失败：503 `kb_unavailable` 或 400 `kb_rejected`，行不动。重试从头走一遍，已删的按「不存在」跳过，所以不留孤儿。
- 都删完后删行（文档行级联），在同一事务里写 `kb.delete`。

**审计**：`kb.create` 的 detail 恰为 `{id, template, raptor, graph}`，`kb.delete` 的恰为 `{id}`，标题是固定短句，不带用户文本。

**模板**（`server/src/kb/templates.ts`）：十一种，建库时固定，没有修改模板的端点。本地存模板名，发给 RAGFlow 的是 `parser_id`。`tag` 与 `audio` 都不提供：RAGFlow 回 `tag` 的建库 `102`，`audio` 要语音模型、编译未测成。后缀抄自实测记录表 C 末列，取自各模板 pipeline 的 Parser 节点，不是逐个上传验证的；入库的后缀判定见下面的「工作空间来源入库」。

| 模板 | `parser_id` | 后缀 |
|---|---|---|
| `naive` | `general` | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、csv、txt、py、js、java、c、cpp、h、php、go、ts、sh、cs、kt、sql |
| `book` | `book` | doc、docx、htm、html、pdf、txt |
| `email` | `email` | eml |
| `laws` | `laws` | doc、docx、htm、html、md、markdown、mdx、pdf、txt |
| `manual` | `manual` | doc、docx、pdf |
| `one` | `one` | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、txt |
| `paper` | `paper` | pdf |
| `picture` | `picture` | bmp、gif、jpeg、jpg、png、svg、tif、tiff、webp、3gp、3gpp、avi、flv、mkv、mov、mp4、mpeg、mpg、webm、wmv |
| `presentation` | `presentation` | pdf、pptx、ppt |
| `qa` | `qa` | docx、md、markdown、mdx、pdf、xls、xlsx、csv、txt |
| `table` | `table` | xls、xlsx、csv、txt |

**工作空间来源入库**（`server/src/kb/documents.ts`、`kb/source-file.ts`、`kb/multipart.ts`，组 10）：`POST /api/kb/bases/:id/documents`，body 恰为 `{workspaceId, paths}`，带 `Cache-Control: no-store`。

请求层依次判定，任一不过都是整个请求失败，不发出站请求：

1. 别人的或不存在的知识库 id：404 `not_found`，先于 body 解析。
2. 键集或类型不对，`paths` 为空或超过 `KB_UPLOAD_MAX_FILES`，任一路径的 UTF-8 编码超过 4096 字节：400 `bad_request`。过长的路径不写 `sandbox.reject`、`kb.ingest_reject`，原文不进审计。恰 4096 字节的按逐条处理走。
3. `workspaceId` 不是当前用户可见的工作空间：404 `not_found`，判定同工作空间文件路由（别人的、已删除的、根被占据或不在了）。
4. 知识库 `state` 不是 `ready`，或写锁正被重建器持有：409 `kb_rebuilding`。

之后在该库的写锁下顺序处理每条路径。快判到取锁之间没有 `await`，取锁后重判 1、3、4：排队期间库可能已删除或转入重建。请求合法且本地写入没有失败即 201 `{documents, rejected}`。

客户端断开不中止这一批：条目逐条提交，整批跑到底。

| 步 | 处理 | 被拒的 `reason` |
|---|---|---|
| 1 | `sandbox.resolve(principal, workspaceId, path, "read")`，越界照常写 `sandbox.reject` | `outside`（含 `..`、绝对路径、NUL、任一分量是符号链接） |
| 2 | 查重，再数该库的文档，都在锁内逐条算，批内的上一条算数 | `duplicate`；已有 500 份时 `limit` |
| 3 | 后缀：basename 最后一个 `.` 之后的部分转小写，查该模板的表。对全部知识库生效 | `unsupported_type`（含没有后缀） |
| 4 | 挂载内经挂载读取，挂载外 lstat 后以 `O_NOFOLLOW` 打开，再对同一 fd 取 `fstat` | `offline`；`not_file`（目录、FIFO、不存在、打不开） |
| 5 | 看 `fstat` 的大小 | `empty`；超过 `KB_UPLOAD_MAX_BYTES` 时 `too_large` |
| 6 | multipart 流式上传 | 见下 |
| 7 | 解析触发，`document_ids` 只有这一个 id | 见下 |
| 8 | 同一事务里插文档行与 `kb.ingest` | 见下 |

路径先规范化：去掉空段与 `.` 段，`./a.md`、`a.md/` 与 `a.md` 是同一条路径。文档行、`kb.ingest` 与应答的 `documents` 用规范写法，`rejected` 与 `kb.ingest_reject` 用请求里的原文。只读挂载里的文件可以入库。入库不发任何编译请求：编译随解析自动运行。

**上传**：字段名 `file`，文件名只写 `filename*=UTF-8''…`，不用 `filename="…"`：文件名是用户的，`"`、CR、LF 写进带引号的值就是头注入。`Content-Length` 由 `fstat` 的大小加 multipart 的头尾算出，字节边读边发，不落临时文件。

读取一路读到 EOF，不按 `fstat` 的大小截断，文件长大了才看得出来。读到的多于或少于 `fstat` 的大小时立即中止出站请求，结束边界不发，RAGFlow 不留文档，也就不发删除。这时客户端只知道请求体坏了，回 `kb_unavailable`，所以调用点先看字节计数的结果：该条记为 `changed`，继续下一条。读到一半挂载到期记为 `offline`；别的读取错误同样记为 `changed`。

**RAGFlow 的失败**：

| 结果 | 该条 | 其后的条目 | 删除刚上传的文档 |
|---|---|---|---|
| 上传 `kb_rejected` | `rejected` | 继续 | 没有文档 |
| 上传 `code:500` 且 message 表明不支持这种文件 | `unsupported_type` | 继续 | 没有文档 |
| 解析触发 `kb_rejected`，或 `code:0` 而 `success_count` 为 0 | `rejected` | 继续 | 删 |
| 上传或解析触发 `kb_unavailable`，或得知数据集不存在 | `unavailable` | 全部 `unavailable`，不再解析路径、不发请求、不写 `sandbox.reject` | 上传已成功时删 |

`success_count` 为 0 除了 rc2 实测记录 §8.1 表里列的情形，还有一种：RAGFlow 建入库任务失败（如画布标题超过 `pipeline_operation_log.pipeline_title` 的 32 字符），这时 `code` 仍为 0，RAGFlow 日志里没有记录（2026-11-07 S2a 验收 CK-11 实测，#1900）。

第 8 步的插行或审计失败是本地的失败：删掉这一份刚上传的文档，整个请求 500，其后的条目不再处理，这一批前面已提交的行留着，重试时它们是 `duplicate`。

**拒绝原因**：`rejected` 的每条是 `{path, reason, message}`，`message` 按 `reason` 固定。

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

`documents` 的每条是 `DocumentView`，不读 RAGFlow：`status` 为 `queued`，`chunkCount`、`message` 为 `null`，`sourceChanged` 为 `false`。文档名取本地记录，RAGFlow 对同名文件的改名（`a(1).txt`）不影响它。

**RAGFlow 文档的删除写法**（`removeRagflowDocument`）：`code:0` 不代表删成了，`RUNNING`、`STOPPING` 的文档回 `deleted:0` 且行仍在。

1. 发删除。`deleted:1` 或不存在：完成。不可达或被拒：`failed`。
2. `deleted:0`：发一次停止解析，只发这一次。`code:0`（不论 `success_count`）或不存在：继续。其余：`failed`，不再删。
3. 每 500 ms 重发删除，至多 5 s。`deleted:1` 或不存在：完成。不可达或被拒：立即 `failed`。
4. 到期仍是 `deleted:0`：`busy`。

入库的补偿删除与重新入库删旧文档走这个写法，`failed`、`busy` 都只写一行 `kb_document_leak`，不改变该条的结果。移出按结果映射应答（见下面的「移出文档」）。这个函数不碰本地行。

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_document_leak","documentId":<id>}` | 补偿删除失败：RAGFlow 里留下一份本地没有行的文档。`documentId` 是 RAGFlow 的文档 id | 按 id 在 RAGFlow 里手工删除，文档还在解析时先停止。这条记录不限频 |

**审计**：每份文档一条 `kb.ingest`，detail 恰为 `{id, source:"workspace", workspaceId, path, documentId}`，`documentId` 是本地文档 id，与插行同一事务；每个被拒条目一条 `kb.ingest_reject`，detail 恰为 `{id, source:"workspace", workspaceId, path, reason}`，单独写入。两者的 `workspace_id` 列都是该工作空间，标题是固定短句，不带用户文本与文件内容。

**本地上传**（`server/src/kb/uploads.ts`，组 12）：`POST /api/kb/bases/:id/uploads?name=<文件名>`，请求体是 `application/octet-stream`，带 `Cache-Control: no-store`。请求体直接拼进出站 multipart，不落盘，不留副本。这条路由不经沙箱，文件名规则是 `workspaces` 的 `parseUploadFileName`：恰一个、非空、不含 `/`、无拒绝字符、无临时前缀、不超过 255 字节。失败的应答都带 `Connection: close`。

取锁之前依次判定，都不读请求体，不发出站请求：

| 判定 | 应答 | `kb.ingest_reject` 的 `reason` |
|---|---|---|
| 别人的或不存在的 id | 404 `not_found` | 不写 |
| 媒体类型不是 octet-stream，文件名规则不过，没有 `Content-Length`（含分块传输） | 400 `bad_request` | 不写 |
| `Content-Length` 超过 `KB_UPLOAD_MAX_BYTES` | 413 `upload_too_large` | `too_large` |
| 后缀不在模板的表里，判定同工作空间来源 | 400 `kb_file_unsupported` | `unsupported_type` |
| `Content-Length` 为 0 | 400 `kb_file_unsupported` | `empty` |
| `state` 不是 `ready` | 409 `kb_rebuilding` | 不写 |

之后在该库的写锁下：重判库与 `state`；已有 500 份时 409 `kb_limit`，审计 `limit`；排队期间已察觉连接断开的什么都不发，socket 已停读时要读到才察觉，这时走中止，不留文档；然后上传、触发解析、同事务插行与 `kb.ingest`，应答 201 `DocumentView`，不读 RAGFlow：`source` 为 `upload`，`workspaceId`、`path`、`sourceChanged` 为 `null`，`status` 为 `queued`，`chunkCount`、`message` 为 `null`。

| 结果 | 应答 | 删除刚上传的文档 |
|---|---|---|
| 客户端断开、短体或超过读请求体期限 | 中止出站，400 `bad_request`，不写审计 | 没有文档（§7.2） |
| 上传 `code:500` 且 message 表明不支持这种文件 | 400 `kb_file_unsupported`，审计 `unsupported_type` | 没有文档 |
| 上传 `kb_rejected` | 400 `kb_rejected` | 没有文档 |
| 上传不可达或数据集不存在 | 503 `kb_unavailable` | 没有文档 |
| 解析触发 `kb_rejected` 或 `success_count:0` | 400 `kb_rejected` | 删 |
| 解析触发不可达或数据集不存在 | 503 `kb_unavailable` | 删 |
| 插行或审计失败 | 500 | 删 |

删除走上面的写法，失败只写一行 `kb_document_leak`。写锁持到请求体读完，时长不由客户端决定：读请求体的总期限从取到写锁起算，排队时间不算，`max(60 s, Content-Length ÷ 64 KiB/s)`，缺省上限下约 27 分钟，持续滴发也逃不过。请求体停着不发时，这条期限与出站 60 s 空闲期限谁先到算谁：总期限 400 `bad_request`，空闲 503 `kb_unavailable`。

审计：`kb.ingest` 的 detail 恰为 `{id, source:"upload", name, size, documentId}`，`kb.ingest_reject` 恰为 `{id, source:"upload", name, reason}`，只写上面两张表里列出的 `reason`。`workspace_id` 列是 null。

**文档列表**（`server/src/kb/documents.ts`，组 11）：`GET /api/kb/bases/:id/documents`，200 `{documents: DocumentView[]}`，按 `created_at` 升序，带 `Cache-Control: no-store`，不写审计。别人的或不存在的 id 404 `not_found`，不发出站请求。不取写锁，不判 `state`。

状态以 RAGFlow 为准，每次请求现读，不起后台轮询：先读本地行，再读全该数据集的文档（`page_size=100`、`orderby=create_time`、`desc=false`，读到 `total` 或空页为止，不设页数上限），按 RAGFlow 文档 id 关联。`name` 取本地记录。

| `ingestion_status` | `status` | `chunkCount` | `message` |
|---|---|---|---|
| `UNSTART` | `unparsed` | `null` | `null` |
| `CREATED`、`SCHEDULED` | `queued` | `null` | `null` |
| `RUNNING`、`STOPPING` | `parsing` | `null` | `null` |
| `STOPPED` | `cancelled` | `null` | `null` |
| `COMPLETED` | `done` | `chunk_count`，可以是 0 | `null` |
| `FAILED` | `failed` | `null` | `解析失败` |
| 列表里没有该 id，或数据集 not-found | `missing` | `null` | `null` |
| 其它取值，这一行有没有本地行都一样 | 整个请求 503 `kb_unavailable` | | |

RAGFlow 不可达 503 `kb_unavailable`，翻页到一半也是，不给半张表。`code:101`、`102` 走通用映射 400 `kb_rejected`。

`sourceChanged` 只对工作空间来源计算，上传来源为 `null`。用工作空间根加纯函数 `resolve`，不经 facade，所以读不到不写 `sandbox.reject`，再 stat，挂载内经挂载的适配器：

| 情形 | `sourceChanged` |
|---|---|
| 大小与修改时间都和入库记录相同 | `false` |
| 任一不同，文件已不存在，或已不是普通文件 | `true` |
| 解析被拒（含路径上的符号链接）、工作空间不可见、挂载离线 | `null` |

**移出文档**（`server/src/kb/documents.ts`，组 13 首刀）：`DELETE /api/kb/bases/:id/documents?doc=<文档 id>`，`doc` 是本地文档 id，带 `Cache-Control: no-store`。不读 body，不读沙箱，源文件不动。取锁之前依次判定，都不发出站请求、不写审计：

| 判定 | 应答 |
|---|---|
| 别人的或不存在的知识库 id（先于 body 与 `doc`） | 404 `not_found` |
| `doc` 缺失、为空或多值 | 400 `bad_request` |
| `state` 为 `rebuilding`，或写锁正被重建器持有（不排队）；`rebuild_failed` 照常移出 | 409 `kb_rebuilding` |
| `doc` 不是这个库的文档 | 404 `not_found` |

之后在该库的写锁下重判库、`state` 与文档行，按上面的删除写法删当前数据集里的 RAGFlow 文档，用锁内读到的 RAGFlow 文档 id：

| 删除写法的结果 | 应答 | 本地行 |
|---|---|---|
| 已删，含「不存在」（`code:102` 加 `These documents do not belong to dataset` 前缀，或数据集不存在） | 204 | 删除，同一事务写 `kb.document_delete` |
| `busy`：到期仍是 `deleted:0` | 409 `kb_document_busy`，稍后再试 | 不动 |
| `failed` | 不可达 503 `kb_unavailable`，被拒 400 `kb_rejected` | 不动 |

审计：`kb.document_delete` 的 detail 恰为 `{id, documentId}`，`documentId` 是本地文档 id；工作空间来源的文档 `workspace_id` 列是该工作空间，上传来源是 null。

**重新入库**（`server/src/kb/documents.ts`，组 13）：`POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>`，只对工作空间来源，带 `Cache-Control: no-store`。bodyless：任意 body（含 `{}`）400 `bad_request`，在所有权判定之后。取锁之前依次判定，都不发出站请求、不写审计：

| 判定 | 应答 |
|---|---|
| 别人的或不存在的知识库 id（先于 body 与 `doc`） | 404 `not_found` |
| `doc` 缺失、为空或多值 | 400 `bad_request` |
| `state` 不是 `ready`（`rebuild_failed` 也拒），或写锁正被重建器持有（不排队） | 409 `kb_rebuilding` |
| `doc` 不是这个库的文档 | 404 `not_found` |
| 本地上传来源的文档 | 400 `bad_request` |

之后在该库的写锁下重判，旧的 RAGFlow 文档 id 取锁内读到的。按工作空间来源入库的第 1 步与第 4–7 步重读源文件并上传（查重、上限与后缀不判），先建新文档、后删旧文档：

| 结果 | 应答 | 本地行 | 新文档 |
|---|---|---|---|
| 读取被拒：工作空间已不可见、`outside`（facade 照常写 `sandbox.reject`）、`not_file`、`offline`、`empty`、`too_large`、`changed` | 409 `kb_source_unreadable` | 不动 | 没有 |
| 上传 `kb_rejected` | 400 `kb_rejected` | 不动 | 没有 |
| 上传 `code:500` 且 message 表明不支持这种文件 | 400 `kb_file_unsupported` | 不动 | 没有 |
| 上传不可达或数据集不存在 | 503 `kb_unavailable` | 不动 | 没有 |
| 解析触发 `kb_rejected` 或 `success_count:0` | 400 `kb_rejected` | 不动 | 删 |
| 解析触发不可达或数据集不存在 | 503 `kb_unavailable` | 不动 | 删 |
| 换行或审计失败 | 500 | 不动 | 删 |
| 成功 | 200 `DocumentView`，不读 RAGFlow：`status` 为 `queued`，`chunkCount`、`message` 为 `null`，`sourceChanged` 为 `false` | 单事务换 RAGFlow 文档 id、`size` 与 `source_mtime_ms`，`id`、`name`、`createdAt` 不变 | 留下；再按上面的写法删旧文档，旧文档还在解析（`busy`）或删除失败只写一行 `kb_document_leak`，应答不变 |

审计：成功时与换行同一事务写 `kb.ingest`，detail 恰为 `{id, source:"workspace", reingest:true, documentId}`，`documentId` 是本地文档 id，`workspace_id` 列是该工作空间。读取被拒不写 `kb.ingest_reject`。

**嵌入模型更换与全量重建**（`server/src/kb/rebuild.ts`、`kb/settings.ts`，组 14）。换嵌入模型的数据集不能就地改：`PUT /datasets/<id>` 改 `embedding_model` 不重算向量（实测记录 §6），所以每个库建一代新数据集，把入库原件从旧数据集搬过去。

确认：`PUT /api/kb/settings` 带 `confirmRebuild:true` 换嵌入身份，下发成功后在同一事务里写设置、嵌入代数加一、全部知识库置 `rebuilding`、`kb_settings.rebuild_actor_id` 记为这次的管理员，并审计两条：`kb.settings` 与 `kb.rebuild`（detail 恰为 `{bases, documents}`，受影响的库数与文档数）。提交之后唤醒重建器。重建期间：入库、上传、重新入库与删库都 409 `kb_rebuilding`，移出也 409；再换嵌入身份 409 `kb_rebuilding`，只换密钥照常；有开编译的库时 `chatModelId` 照旧锁定。

重建器在进程内一次处理一个库，按 `created_at`、`id` 的次序，处理期间持有该库的写锁：锁正被它持有时写操作立即 409，不排队；它自己排在在途写操作之后，拿到锁才读文档清单，所以排在前面的上传进入新数据集。拿到锁先重读库行，库已删除或不再是 `rebuilding` 即跳过，什么都不建。每个库：

1. 有残留的一代（`rebuild_dataset_id` 非空：上次失败或崩溃留下的）就按删除次序删掉它，「不存在」视为已删，再置空三个 `rebuild_*` 列。
2. 以原模板与开关、新嵌入模型建新一代，名为 `owb-<id 前 16 位>-g<新代数>`，写回 `rebuild_*`。两个开关都关的库只建 `parse_type:1` 数据集，不读账号缺省；开了开关的库新建模板组与画布，不复用旧的，账号缺省缺失即失败、不发后续请求。
3. 逐份文档：从旧数据集下载入库原件，原样拼进 multipart 上传到新数据集（不落盘），再触发这一份的解析。multipart 长度按本地记录的 `size` 算，字节在流上数：多出一个字节当场中止上传并销毁下载流，少了不发结束边界，RAGFlow 都不留文档。下载判为 not-found 的文档跳过；字节不符、上传失败、解析触发失败（含 `success_count:0`）都让这个库失败。
4. 单事务切换：删掉被跳过的文档行，其余行换成新的 RAGFlow 文档 id；当前一代的三个 id 换成新一代，`rebuild_*` 置空，代数换成新代数，`state` 为 `ready`；同事务审计 `kb.rebuild`，detail 恰为 `{id, result:"ok", skipped}`，`skipped` 是被跳过的本地文档 id。
5. 按删除次序删旧一代。删不掉不影响状态，只写一行（同上面的 leak 表）：数据集删不掉写 `kb_dataset_leak`，它的画布与模板组不再去删；画布删不掉写 `kb_pipeline_leak`（两个 id 都在）；模板组删不掉同样写 `kb_pipeline_leak`（`canvasId` 为 `null`）。补救同 leak 表。

任一步失败：该库 `rebuild_failed`，`stateMessage` 为 `重建失败，可在模型设置里重试`，不带 RAGFlow 原文；同事务审计 `kb.rebuild {id, result:"failed"}`。`rebuild_*` 留着，重试的第 1 步删掉它们。`rebuild_failed` 的库可以移出文档（删的是当前一代里的文档），可以删库（先删新一代再删当前一代），不能入库、上传与重新入库。重建器写的审计，actor 一律是 `rebuild_actor_id`。

**下载判别**（实测记录 §9.1）：not-found 也是 HTTP 200，文件内容又可以恰好等于 not-found 的正文，所以只看响应头：HTTP 200 且带 `Content-Disposition` 是文件字节，正文一律不解析，不看 `Content-Type`、`Content-Length` 与后缀；HTTP 200 不带这个头才按 JSON 读，`code:404` 是 not-found（跳过），别的按 RAGFlow 出站请求的通用映射（这个库失败）；非 200 同样走通用映射。0 字节文件的下载是不带头的 `code:500`，入库时就拒绝了空文件，重建碰不到它。这个判据只在直连实例上验证过：中间若有代理剥掉这个头，下载判为失败，该库 `rebuild_failed`，不会把错误应答当文件上传。

**重试**：`POST /api/kb/settings/rebuild`，管理员专用（非管理员 403，未登录 401），bodyless（任意 body，含 `{}`，400）。在设置锁内把全部 `rebuild_failed` 置回 `rebuilding`，`rebuild_actor_id` 改为这次的管理员，审计 `kb.rebuild {bases, documents, retry:true}`（重试的库数与它们的文档数），唤醒重建器，应答 200 加读视图。没有失败库时 200，不写库、不审计、不发任何请求。

**续做与关停**：入口在写出 `server_started` 之后、不等待地启动重建器，对仍是 `rebuilding` 的库从第 1 步做起。续做中的失败只改变知识库状态，不写 failure record，不改变退出码（RAGFlow 不可达时该库 `rebuild_failed`，重试即可）。关停时，在关闭主实例与 DB 之前停住重建器：在途的 RAGFlow 请求被中止，只等正在持锁处理的那一个库收尾，不等排在写锁队列里的（一个在途的本地上传最长约 27 分钟，等它会拖住关停）。中止不算失败：第 4 步提交之前该库保持 `rebuilding`，下次启动续做；提交之后已是 `ready`，第 5 步没删完的旧一代不续删，成为孤儿，那一步中止的删除照样写一行 leak，按 leak 表手工清理。未配置 `RAGFLOW_BASE_URL` 时重建器不启动，`rebuilding` 的库保持原状、不改成 `rebuild_failed`，重新配置之后下次启动续做。

**部署要求**（组 18）：

- 一个已在运行的 RAGFlow 服务，版本恰为 `v1.0.0-rc2`（`kb/rest.ts` 的常量，见上面的「版本钉住」），`DOC_ENGINE=infinity`（ADR-0005）。本系统只当客户端用它：不启动、不停止、不配置它的容器（D16）。共用栈上别的账号的数据集与模型配置不归本系统管。
- 专用的 RAGFlow 账号和它的 API key。key 写进 `0600` 的普通文件，按上面「密钥文件」的四条要求放好，`RAGFLOW_API_KEY_FILE` 指向它；`RAGFLOW_BASE_URL` 与它成对配置。
- 网络：app-server 能访问 `<RAGFLOW_BASE_URL>`；RAGFlow 能访问嵌入模型与知识库对话模型的上游（嵌入请求由 RAGFlow 直接发出，不经 app-server 的模型代理）。
- 迁移 050 随启动自动执行，只建三张表、插入 `kb_settings` 的唯一一行，不改既有表。
- 启动后，管理员在「中心」的「模型」tab 的「知识库模型」段保存嵌入模型；要开 RAPTOR / 知识图谱，还要指定知识库对话模型。保存会把两个模型下发到这个账号并设为账号缺省（见上面「下发的固定序列」）。之后 `GET /api/kb/status` 应为 `available:true`、`embeddingReady:true`，指定了对话模型时 `compileReady:true`。
- 单次上传的大小与文件数上限按需调整 `KB_UPLOAD_MAX_BYTES`、`KB_UPLOAD_MAX_FILES`。

**回滚**：

- 去掉 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE` 两个键并重启，知识库即关闭：tab 不出现，`/api/kb/*` 返回 503 `kb_disabled`（`/api/kb/status` 除外），`models` 的删除与修改不再受联动约束。本地的三张表与行保留，重新配置后照常可用；仍是 `rebuilding` 的库在下次启动时续做。
- 回退代码时迁移文件保留：迁移账本拒收多出的回执，规则同 049。
- RAGFlow 里的 `owb-` 数据集、画布与模板组由运维按需清理。次序按实测记录 §16：账号缺省模型保持不动，先删数据集、画布与模板组，等到没有编译活动，才清缺省、删模型实例。账号上还有 pipeline 数据集时清空缺省对话模型，会让全栈唯一的入库进程崩溃循环（上面的「账号缺省不变量」）。
- 删除的 `kbservice/` 不能靠配置恢复，需要时从 git 历史恢复。

**真实端点冒烟 `make smoke-kb`**（`Makefile`、`smoke/kb.hurl`、`smoke/kb-cleanup.hurl`，组 18 首刀）。它在验证矩阵里是 `review-only` / `required_at: manual`：`make smoke` 与 CI 都不调用它，真实运行是 owner 的验收行 CK-11。前提：

- 调用方的服务已在运行，已按上面的部署要求接上 RAGFlow，两个模型都已配置（状态四项都为 true）。
- 启动服务前，调用方已把 `smoke/fixtures/sandbox/u1/` 复制到该服务的 `SANDBOX_ROOT/u1`（`smoke/fixtures/README.md`）。`make smoke-kb` 不替它复制，也不启动、停止或配置服务与 RAGFlow。
- 本机有 hurl 8.0.1 与 Node 18 或更高版本。

运行：`SMOKE_BASE_URL=<服务地址> make smoke-kb`。它先依次做三项检测，任一不过就退出，不发任何知识库请求，也不执行任何 `docker` 命令：

1. 没有设置 `RAGFLOW_BASE_URL`：「RAGFlow 私有配置缺失」。
2. 本机没有 Node 18+：「未找到 Node 18+（版本检测需要 fetch）」。
3. `GET <RAGFLOW_BASE_URL>/api/v1/system/version` 不通，或版本不是 `v1.0.0-rc2`：「共用 RAGFlow 栈未运行或版本不符」。判据与服务端的状态端点相同：不带密钥，总期限 5 s，不跟随重定向。

之后，`kb-cleanup.hurl` 先删掉上次残留的 `smoke-kb` 与 `smoke-kb-compile`。接着 `kb.hurl` 以成员账号走完整条流程：

1. 状态检查。
2. 采用工作空间 `smoke-kb`，建普通库 `smoke-kb`，入库 `notes.md` 与 `brief.pdf`，轮询到两份都 `done` 且切片数大于 0。
3. 上传一份文本，轮询到 `done` 后移出它，然后删库。
4. 建两个开关都开的 `smoke-kb-compile`，入库 `notes.md`，轮询到 RAPTOR 与知识图谱都是 `done`，然后删库。这是编译 DSL 对真实 RAGFlow 的唯一验证。
5. 确认列表里两个库都不在。

轮询上限是 `SMOKE_KB_POLL_SECONDS`（缺省 300），按 5 秒一次重试向上取整，不计单次请求的耗时。`kb.hurl` 失败时再跑一次清理，退出码保持 hurl 的原值；清理本身失败不改变退出码，下一次运行前的清理会再试。`brief.pdf` 是手写的极简 PDF，如果卡在它的切片数上，先换一份正常排版的小 PDF（文件名不变）再跑。
