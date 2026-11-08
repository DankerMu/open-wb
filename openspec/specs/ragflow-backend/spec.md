# ragflow-backend Specification

## Purpose
定义以运行中的 RAGFlow `v1.0.0-rc2` 服务为知识库后端的接法（ADR-0016）：接口实测记录作为唯一事实来源，配置键与密钥文件，可用性与版本钉住，出站请求的纪律与错误映射，状态端点，知识库嵌入模型与对话模型的设置、下发与探活，嵌入模型更换时的全量重建，以及共用开发栈的使用纪律。

## Requirements

### Requirement: RAGFlow 接口实测记录
仓库 SHALL 有 `docs/reviews/2026-10-28-ragflow-rc2-api.md` 及其续篇 `docs/reviews/2026-11-08-ragflow-rc2-retrieval.md`（节号从 §19 起，S2b），记录用 API key 实测运行中的 RAGFlow `v1.0.0-rc2` 得到的事实。每节附请求与应答摘录，并写明结论「支持」或「不支持」。两份记录合起来 SHALL 覆盖：
- **版本接口**：应答字段。
- **建数据集**：模板字段（`parser_id` 与 `parse_type`）的全部取值；`embedding_model` 的格式；同名数据集的应答。
- **RAPTOR 与知识图谱**：开启方式（模板组、画布与 pipeline 数据集，含 DSL）；是否需要显式触发；编译状态接口及其全部状态取值；任务日志的形状与分页、批次的 `dsl.entries`、只开一种编译时的 `task_type`；两种编译对每种模板是否可用；失败时的信号；删除有无引用保护。
- **改嵌入模型**：`chunk_count` 非 0 时改 `embedding_model` 的应答。
- **multipart 上传**：字段名；是否接受带 `Content-Length` 的流式请求体；不支持的后缀；文件类型与模板不匹配时的行为。
- **解析与文档列表**：解析触发与停止接口，`success_count` 的含义；文档列表的分页参数；运行状态的全部取值（含未开始），以及到本系统文档状态的映射；切片数字段；文档删除在各运行状态下的应答。
- **原件下载**：应答是否带 `Content-Length`，或是否用分块传输；区分 not-found 与文件字节的判据；0 字节文件。
- **不存在的 id**：数据集与文档 id 不存在时，各路由的 HTTP 状态与 body `code`，以及它们能否与「参数非法」区分。
- **模型下发**：能否用 API key 配置模型提供方 instance 与账号缺省模型；配置后能否以 `embedding_model` 引用；能否删除已下发的配置；删除有无保护。
- **错误组合**：鉴权失败、参数非法、权限不足各自的 HTTP 状态与 body `code`。
- **检索**（续篇 §19，S2b）：`POST /api/v1/retrieval` 的请求参数是否生效、应答与切片字段（含零命中时的应答原样）、分数的构成，参数非法与数据集不存在时的组合；数据集上的检索字段能否经 `PUT` 改写；重排模型的下发、`rerank_id` 的格式、重排失败的信号与直连上游的形状；`use_kg` 是否有可观察的效果。

这两份记录 SHALL 是假 RAGFlow 夹具协议的唯一来源。夹具的行为分两类：
- **协议应答**：路径、字段、状态值与错误 code，SHALL 在本记录里有对应条目。
- **故障注入**：用例显式脚本化的异常，可以不在记录里，SHALL 只限四种：
  - 传输层失败：挂起、挂起后放行、超时、连接失败、中途断开。
  - HTTP 层：3xx、5xx、非 JSON、超出体积。
  - 漂移值：不符的版本串、八种之外的 `ingestion_status`。
  - 防御性组合：未观察到的路由上的 `code:403`；同一路由上别的 `100`、`101`、`102`；`DELETE /datasets` 的 `{code:0, data:{deleted:[]}}`；不带 `graph` 或不是恰一个 chunker 的内置 pipeline；`GET /models/default` 的 `data.models` 只有一种缺省；成功应答缺字段；HTTP 200 的 `code:401`。

仓库是 public，记录 SHALL 脱敏：
- RAGFlow 的地址一律写作 `<RAGFLOW_BASE_URL>`。
- 租户、用户、数据集与文档 id 一律以占位符代替；邮箱、昵称与账号名同样代替。
- 密钥、密钥文件路径与文件内容 SHALL NOT 出现。

#### Scenario: 夹具与记录一致
- **WHEN** 评审 `server/test/support/fake-ragflow.mjs` 的任一路由、字段名或状态值
- **THEN** 协议应答在两份实测记录之一里有对应条目；记录里没有的接口、字段与状态值，只以上面列出的故障注入出现，并由用例显式脚本化

#### Scenario: 记录已脱敏
- **WHEN** 对两份实测记录运行 gitleaks，并用 grep 搜实测时所用的 RAGFlow 主机名或 IP、端口与专用账号名
- **THEN** gitleaks 无发现，grep 零命中；文中出现的地址只有 `<RAGFLOW_BASE_URL>`

### Requirement: 知识库配置与密钥文件
app-server SHALL 解析四个键：`RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE`、`KB_UPLOAD_MAX_BYTES` 与 `KB_UPLOAD_MAX_FILES`，规则见 http-service-skeleton「服务启动与装配」。

配置了 `RAGFLOW_BASE_URL` 时，启动阶段 `kb_key` SHALL 读取 `RAGFLOW_API_KEY_FILE`，读法与校验如下：
- 以 `O_NOFOLLOW` 打开（符号链接即失败），对同一个 fd 做 `fstat`，再从该 fd 读取。
- 文件须为普通文件，属主为本进程 uid，`mode & 0o077` 为 0，大小 1–4096 字节。
- 内容去掉恰一个结尾 `\n` 后须非空，且可作 HTTP 头值。

任一条不满足即启动失败：失败记录的 `reason` 为 `kb_key`，错误信息只点名键，不含文件内容。

密钥 SHALL 只留在 `kb` 模块的内存里，不出现在任何响应、审计 detail、日志行与子进程环境中。未配置 `RAGFLOW_BASE_URL` 时 SHALL 不读任何密钥文件。

#### Scenario: 密钥文件不合规即启动失败
- **WHEN** 分别以下列文件作为 `RAGFLOW_API_KEY_FILE` 启动编译入口：mode 为 `0644` 的文件、指向合规文件的符号链接、空文件、内容含 `\r` 的文件、4097 字节的文件、内容恰为 `\n\n` 的文件
- **THEN** 每次都启动失败，失败记录的 `reason` 为 `kb_key`，stderr 与 stdout 都不含文件内容；以合规的 `0600` 文件启动则成功

#### Scenario: 属主不符
- **WHEN** 在单元层经注入的 `getuid` 缝，让密钥文件的属主不等于本进程 uid（非特权的编译入口造不出别的属主，所以这一例只在单元层验证，同 `sandbox_root` 先例）
- **THEN** 校验失败，错误只点名 `RAGFLOW_API_KEY_FILE`

#### Scenario: 密钥不进 omp 环境
- **WHEN** 知识库已配置，任一会话 spawn omp 子进程
- **THEN** 子进程环境里没有任何值等于密钥，也没有名为 `RAGFLOW_API_KEY_FILE` 或 `RAGFLOW_BASE_URL` 的键

### Requirement: 知识库可用性
未配置 `RAGFLOW_BASE_URL` 时知识库 SHALL 关闭：
- `GET /api/kb/status` 返回 `{enabled:false}`。
- 其余全部 `/api/kb/*` 端点（含管理员端点）返回 503 `kb_disabled`，不发任何出站请求。
- 判定次序：cookie guard 的 401 在前，`kb_disabled` 其次，之后才是管理员 403 与 body 解析。

配置了 `RAGFLOW_BASE_URL` 时：
- 服务 SHALL 照常启动，启动时不连接 RAGFlow。
- 之后任何一次 RAGFlow 请求失败只影响当次请求，按「RAGFlow 出站请求」映射；会话、文件等其它功能不受影响。
- 版本钉住只决定 `GET /api/kb/status` 的 `available`，其它知识库端点不因版本不符而拒绝请求。
- `available:false` 时，中心「知识库」tab 只显示不可用提示与 `重试`（knowledge-bases「中心「知识库」tab」）；模型 tab 的「知识库模型」段不看 `available`，只看 `enabled`：它读本地设置，RAGFlow 不可达时保存失败，显示信封文案。

#### Scenario: 未配置即关闭
- **WHEN** 未配置 `RAGFLOW_BASE_URL` 时，管理员逐个请求 `GET /api/kb/status` 之外的十三条知识库路由，`POST` / `PUT` 路由带 malformed JSON body；再以匿名身份请求其中一条
- **THEN** 管理员的十三次都是 503 `kb_disabled` 信封；匿名那次是 401；假 RAGFlow 收到零个请求

#### Scenario: 不可达不阻断
- **WHEN** `RAGFLOW_BASE_URL` 指向一个已关闭的端口时启动服务（store 里预置一个知识库行）；随后依次创建会话、请求 `GET /api/kb/status`、`GET /api/kb/bases` 与 `DELETE /api/kb/bases/:id`
- **THEN** 启动成功，会话创建成功；状态为 `available:false`；列表为 200，含该库；删除为 503 `kb_unavailable`，库行仍在

### Requirement: RAGFlow 出站请求
`kb` 模块对 RAGFlow 的全部请求 SHALL 经同一个客户端发出：
- `agent:false`，不跟随重定向，不重试。唯一的例外是检索的重排降级（见下面「调用点对类型化结果的处理」），它恰重试一次。
- JSON 请求：连接期限 10 s，总期限 30 s，响应体至多 1 MiB。
- 上传与下载：连接期限 10 s，空闲期限 60 s。
- 除 `/api/v1/system/version` 外，每个请求都带 `Authorization: Bearer <密钥>`。

结果映射 SHALL 按以下次序判定：
1. 下表的路由专属组合先于下面各条，识别为类型化结果，由调用点处理：
   | 路由 | 组合 | 类型化结果 |
   |---|---|---|
   | `GET /datasets/<id>/documents` | `code:404` | not-found |
   | `POST /datasets/<id>/documents` | `code:102` 且 message 以 `Can't find the dataset with ID` 开头 | not-found |
   | `POST /datasets/<id>/documents` | `code:500` 且 message 含 `This type of file has not been supported yet!` | 不支持的文件 |
   | `POST …/documents/parse` | `code:404` | not-found |
   | `POST …/documents/parse` | `code:0` 且 `success_count` 为 0 | 解析未启动 |
   | `POST …/documents/stop` | `code:404`；`code:100` 且 message 以 `Documents not found:` 开头 | not-found |
   | `DELETE …/documents` | `code:404`；`code:102` 且 message 以 `These documents do not belong to dataset` 开头 | not-found |
   | `DELETE …/documents` | `code:0` 且 `deleted` 为 0 | 未删除 |
   | `DELETE /datasets` | `code:403` | not-found |
   | `DELETE /agents/<id>` | `code:103` | not-found |
   | `DELETE /compilation-template-groups/<id>` | `code:404` | not-found |
   | `GET …/documents/<doc>` | 见「嵌入模型更换与全量重建」的下载判别 | 文件流或 not-found |
   | `POST /retrieval` | `code:102` | 检索失败 |
2. HTTP 2xx 且 body `code` 为 0：成功。
3. body `code` 为 101 或 102：`kb_rejected`（400）。
4. HTTP 401，或 body `code` 为 401 / 403：`kb_unavailable`（503），并经受管 stderr writer 写一行，恰为 `{"event":"kb_upstream_auth_failed"}`；同一进程 60 秒内至多一行。
5. 其余（其它非零 `code`、非 2xx、3xx、非 JSON、超出体积、超时、连接失败、成功应答缺少调用点要读的字段）：`kb_unavailable`。

调用点对类型化结果的处理：
- not-found：删除视为已删除；文档列表视为该库的数据集已丢失，全部文档 `missing`；上传与解析触发按 `kb_unavailable` 处理。
- 解析未启动：SHALL 视为解析触发失败，不得当作成功。
- 不支持的文件、未删除：见 knowledge-bases 各端点。
- 检索失败（实测记录 §19.4：重排端点不通、上游密钥无效、重排模型不存在都是这个组合；它区分不出失败是否来自重排）：
  - 这次请求带了 `rerank_id`：SHALL 去掉 `rerank_id`、其余字段不变，再发恰一次；并经受管 stderr writer 写一行，恰为 `{"event":"kb_rerank_degraded"}`，同一进程 60 秒内至多一行。重试的结果按普通检索处理，应答里没有降级的标记。
  - 这次请求没带 `rerank_id`（含上面那次重试）：`kb_unavailable`。
  - 结果：不是重排引起的检索失败，也会先触发一次不带重排的重试，再以 `kb_unavailable` 结束。

`DELETE /datasets` 的 `ids` SHALL 恰含一个非空 id，成功 SHALL 以 `success_count` 为 1 为准。客户端 SHALL NOT 提供 `GET /providers/<提供方>/instances/<实例>`：该应答明文回显上游密钥。

RAGFlow 应答的 message 与错误应答的正文 SHALL NOT 进入本系统的响应、审计或日志，message 只用于上面的前缀判定。唯一的例外是成功检索应答里命中切片的 `content` 与 `similarity`：它们作为数据进入检索测试的 200 应答（knowledge-bases「单轮检索」），仍 SHALL NOT 进入审计或日志。

#### Scenario: 结果映射
- **WHEN** 假 RAGFlow 对建库请求依次应答：HTTP 200 `code:0`；HTTP 200 `code:101`；HTTP 401 `code:401`；HTTP 302；HTTP 200 非 JSON；挂起超过总期限（期限经装配注入缩短）
- **THEN** `POST /api/kb/bases` 依次得到 201、400 `kb_rejected`、503 `kb_unavailable`（并恰一行 `kb_upstream_auth_failed`）、503、503、503；后五次都不插知识库行；任何响应与 stderr 都不含假 RAGFlow 返回的 message 文本

#### Scenario: 权限错误的防御性映射
- **WHEN** 假 RAGFlow 对文档列表应答 HTTP 200 `code:403`；另一次对 `DELETE /datasets` 应答同样的组合
- **THEN** 文档列表为 503 `kb_unavailable`，并恰一行 `kb_upstream_auth_failed`；删数据集视为已删除，不写这一行

#### Scenario: 成功码下的失败
- **WHEN** 客户端收到 `POST …/documents/parse` 的 `{code:0, data:{success_count:0}}`；`DELETE …/documents` 的 `{code:0, data:{deleted:0}}`；经故障注入，`DELETE /datasets` 的 `{code:0, data:{deleted:[]}}`（实测记录 §4.6 里空 `ids` 的形状，没有 `success_count`；本系统不发空 id，这条是防御性判定）
- **THEN** 三者都不是成功：依次为解析未启动、未删除与 `kb_unavailable`

#### Scenario: 路由各异的不存在组合
- **WHEN** 假 RAGFlow 按实测记录表 B 应答：`DELETE /datasets` 的 `code:403`；`POST /datasets/<id>/documents` 的 `code:102` 与 `Can't find the dataset with ID <id>!`；`DELETE …/documents` 的 `code:102` 与 `These documents do not belong to dataset <id> or Document not found: <id>`；`POST …/documents/stop` 的 `code:100` 与 `Documents not found: ['<id>']`；`DELETE /agents/<id>` 的 `code:103`；`DELETE /compilation-template-groups/<id>` 的 `code:404`
- **THEN** 六者都是 not-found；同一路由上别的 `102` 或 `100` 不是，分别按 `kb_rejected` 与 `kb_unavailable` 映射

#### Scenario: 不存在视为已删
- **WHEN** 假 RAGFlow 对删数据集与删文档请求都应答实测记录给出的「不存在」组合，用户先移出一份文档，再删除该知识库
- **THEN** 两次分别为 204；文档行与知识库行都已删除；各有一条 `kb.document_delete` 与 `kb.delete`

#### Scenario: 每个请求带密钥
- **WHEN** 知识库端点触发对假 RAGFlow 的建库、上传、列表、删除与版本请求
- **THEN** 除版本请求外，每个请求的 `Authorization` 恰为 `Bearer <密钥>`；版本请求不带 `Authorization`；没有请求跟随重定向

#### Scenario: 重排降级
- **WHEN** 配置了重排模型；假 RAGFlow 对带 `rerank_id` 的检索回 HTTP 200 `code:102`、message 为 `retrieval search failed: vLLM rerank API error: 401 Unauthorized, body: {…}`，对不带的回两条切片；连续检索三次
- **THEN** 三次都是 200 且各两条命中，应答与无重排时同形；假 RAGFlow 每次检索都恰收到两次请求，第二次不含 `rerank_id`、其余字段与第一次相同；stderr 恰一行 `{"event":"kb_rerank_degraded"}`；任何响应与 stderr 都不含 message 文本

#### Scenario: 检索失败的映射
- **WHEN** 未配置重排模型，假 RAGFlow 对检索依次回 `code:102`、`code:404`（`Resource not found`）、`code:101`；另一次配置了重排模型，带与不带 `rerank_id` 都回 `code:102`
- **THEN** 依次 503 `kb_unavailable`、503 `kb_unavailable`、400 `kb_rejected`，每次假 RAGFlow 只收到一次请求，没有 `kb_rerank_degraded`；配置了重排的那次 503 `kb_unavailable`，假 RAGFlow 收到恰两次请求

#### Scenario: 超时不降级
- **WHEN** 配置了重排模型，假 RAGFlow 挂起带 `rerank_id` 的检索超过总期限（期限经装配注入缩短）
- **THEN** 503 `kb_unavailable`；假 RAGFlow 只收到这一次请求

### Requirement: 知识库状态端点
`GET /api/kb/status` SHALL 对任何已登录用户可用，未登录 401。
- 知识库关闭时，应答恰为 `{enabled:false}`。
- 开启时，SHALL 请求一次 RAGFlow 版本接口（总期限 5 s，不带密钥），应答恰为 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`。各字段：
  - `available`：当且仅当版本接口可达，且版本串恰为 `v1.0.0-rc2`。版本不符时写一行 stderr 记录，恰为 `{"event":"kb_version_mismatch"}`；同一进程 60 秒内至多一行。
  - `embeddingReady`：已配置知识库嵌入模型。
  - `compileReady`：已指定知识库对话模型。
  - `uploadMaxBytes`、`uploadMaxFiles`：两个上传上限的配置值。

应答带 `Cache-Control: no-store`。

#### Scenario: 版本钉住
- **WHEN** 假 RAGFlow 的版本串依次为 `v1.0.0-rc2`、`v1.0.0-rc1`，然后关闭假 RAGFlow
- **THEN** `available` 依次为 `true`、`false`（并恰一行 `kb_version_mismatch`）、`false`；三次都是 200

### Requirement: 知识库模型设置
管理员 SHALL 能管理知识库模型设置；非管理员 403 `forbidden`，未登录 401。三个端点：
- `GET /api/kb/settings`：读。
- `PUT /api/kb/settings`：写。
- `POST /api/kb/settings/probe`：探活。查询参数 `target` 缺省或为 `embedding` 时探嵌入模型，为 `rerank` 时探重排模型；其它取值、空值或重复：400 `bad_request`。

三者的成功应答都是 200 加设置读视图，带 no-store。

**读视图**恰为 `{embedding, chatModelId, rerank, bases, compileBases, documents, rebuilding, rebuildFailed}`，永不包含任何密钥：
- `embedding` 为 `{name, baseUrl, probe: {status, message, at}}` 或 `null`。`status` 取 `never` / `ok` / `failed`，`message` 为字符串或 `null`，`at` 为 epoch 毫秒或 `null`，同 `ModelView.probe`。
- `chatModelId` 为字符串或 `null`。
- `rerank` 为 `{name, baseUrl, probe: {status, message, at}}` 或 `null`，各字段同 `embedding`。
- `bases`、`documents`：知识库总数与文档总数。
- `compileBases`：开编译的知识库数，即 `raptor` 或 `graph` 为 1 的行，含重建中与重建失败的库。
- `rebuilding`、`rebuildFailed`：处于这两种重建状态的知识库数。

**PUT 的 body** 键集 SHALL 是 `embedding`、`chatModelId`、`rerank`、`confirmRebuild` 的非空子集，且至少含 `embedding`、`chatModelId` 与 `rerank` 之一：
- `embedding` 为 `{name, baseUrl, apiKey?}`：`name` 为 1–128 字节、无控制字符、不含 `@`；`baseUrl` 与模型上游地址同一规则；首次配置必须带 `apiKey`，之后省略即保留。`apiKey` 与模型上游密钥同一规则：非空且不是纯空白，可作 HTTP 头值；`apiKey:""` SHALL 是 400，不是保留。
- `chatModelId` 为 `models` 中**带上游**的 id（不含 `@`），或 `null`。
- `rerank` 为 `{name, baseUrl, apiKey?}` 或 `null`：三个字段的规则与 `embedding` 相同（首次配置必须带 `apiKey`，之后省略即保留，`apiKey:""` 为 400）。重排模型不是嵌入身份的一部分：更换它不产生 `kb_rebuild_required`，也不发起重建。
- 其它键、类型不符、id 不存在或该模型没有上游：400。

**保存流程**：
1. 判定 `chatModelId` 的取值规则。
2. 把配置下发到 RAGFlow 服务账号（对话模型取该 `models` 行的上游地址与密钥）：
   - body 含对象形式的 `rerank`：SHALL 最先下发重排模型，再按下面两条下发。重排一轮没有账号缺省这一步，它失败时 RAGFlow 侧尚未改动任何账号缺省。`rerank` 为 `null` 时没有下发，只把本地重排三列置空；已是 `null` 时再设 `null` 是无操作。
   - body 含 `embedding`：先下发嵌入模型，再重发当时指定的对话模型（本次的 `chatModelId`，否则已存的值）；没有指定、或该行没有上游时跳过这一步。
   - 除 `rerank` 外只含 `chatModelId`：在重排那一轮（如有）之后只下发对话模型；取值为 `null` 时这一轮没有下发。
3. 下发失败：按「RAGFlow 出站请求」映射，本地设置不变；失败那一轮之后的各轮 SHALL NOT 再发。
4. 成功后：在同一事务里写设置，并审计 `kb.settings`。

**`chatModelId` 的取值规则**：当前值非 `null` 且存在开编译的知识库时：
- 改为 `null` 或别的 id：SHALL 409 `kb_chat_model_locked`，不下发，不保存。
- 与当前值相同的 id：照常下发并保存。

其余情形：改为 `null` 时只改本地，SHALL NOT 发任何 RAGFlow 请求；改为某个 id 时下发并保存。当前值已是 `null` 时再设 `null` 是无操作：200，不写库，不审计。

**下发**：三个实例名是常量，`owb-embed` 承载嵌入模型，`owb-chat` 承载知识库对话模型，`owb-rerank` 承载重排模型，提供方都是 `OpenAI-API-Compatible`。下发一个实例的请求序列 SHALL 为：
1. `PUT /api/v1/providers`，body `{provider_name}`。
2. `GET /api/v1/models`，按 `provider_name` 与 `instance_name` 判断实例是否存在。
3. 实例不存在：`POST …/instances`，body `{instance_name, api_key, base_url, model_info}`。实例存在：`GET …/instances/<实例>/models`，再 `PUT …/instances/<实例>`，body 同样四个键，`model_info` 为现有模型加本次的模型，同名项以本次为准。
4. `PATCH /api/v1/models/default`，body `{model_provider, model_instance, model_name, model_type}`，`model_type` 为 `embedding` 或 `chat`。下发 `owb-rerank` 时 SHALL NOT 发这一步。

规则：
- `api_key` SHALL 恒为实际密钥：`embedding.apiKey` 省略时取已存的值；SHALL NOT 发出空串或纯空白（RAGFlow 按 trim 后的值写入，空值会清空实例密钥）。
- `model_info` 项为 `{model_name, model_type, max_tokens}`。嵌入模型 `model_type` 为 `["embedding"]`，`max_tokens` 为 `8192`；对话模型为 `["chat"]`，`max_tokens` 取该行的 `maxTokens`；重排模型为 `["rerank"]`，`max_tokens` 为 `8192`（实测记录 §19.3）。
- 嵌入与对话模型都 SHALL 设为账号缺省：Compiler 读账号缺省嵌入模型。重排模型 SHALL NOT 设为账号缺省：只按检索请求的 `rerank_id` 引用。
- SHALL NOT 使用 `PATCH /api/v1/users/me/models`。

**账号缺省不变量**：系统的任何路径 SHALL NOT 让服务账号处于「没有缺省对话模型，而可能有 pipeline 数据集或待合并任务」的状态。`kb` 模块 SHALL NOT 发送清空缺省的 `PATCH /api/v1/models/default`（只带 `model_type`，或名字为空串），SHALL NOT 调用 `/api/v1/providers` 下的任何 `DELETE`。RAGFlow 里的模型配置只增、只覆盖；取消指定、清除重排模型与删除 `models` 行都只改本地，已下发的配置（含上游密钥）留到下一次下发时覆盖。嵌入模型配置后没有清空入口。

建 pipeline 数据集之前 SHALL 先只读 `GET /api/v1/models/default`，`chat` 与 `embedding` 两种都在才继续：缺失时建库 409 `kb_not_ready`，重建该库 `rebuild_failed`，都 SHALL NOT 发后续请求（knowledge-bases「知识库端点」）。

**与 models 的联动**：知识库对话模型引用 `models` 的一行。知识库开启时：
- 该行不能删除，也不能把上游清空：409 `kb_model_in_use`。
- 修改该行的上游地址或密钥（model-registry 的 `upstreamChanged` 为真），SHALL 在本地写入之前把新上游重新下发到 `owb-chat`；下发失败则这次修改失败（按映射），行不变，不审计，不发布。body 校验 SHALL 先于下发：非法 body 400，不发 RAGFlow 请求。

知识库关闭时联动不生效：删除照常进行，经外键把 `chat_model_id` 置空。`models` 模块经装配注入的钩子调用这些检查，不反向依赖 `kb`。

**探活**：向嵌入上游发 `POST <baseUrl>/embeddings`，body `{model, input:"ping"}`，期限与模型探活相同。
- 结果：2xx 且应答 `data[0].embedding` 为非空数字数组为 `ok`，否则为 `failed`。
- 结果只写回发起时的同一身份（名称、地址、密钥），并审计 `kb.settings`（detail `{probe}`）。发起后嵌入模型已被改：丢弃这次结果，不写回、不审计，应答回当前读视图。
- 探活逐次串行，后发的排在在途的之后；身份在排到时读取。
- 保存时名称、地址或密钥任一变化，探活重置为 `never`；三者不变时保留。
- 嵌入模型未配置时：409 `kb_not_ready`。
- 探活不下发，也不改嵌入身份。

**重排模型的探活**（`target=rerank`）与上面同一套规则，只有这几处不同：
- 请求为 `POST <baseUrl>/rerank`，body `{model, query:"ping", documents:["ping"]}`（实测记录 §19.4）。
- 2xx 且应答 `results[0].relevance_score` 为数字为 `ok`，否则为 `failed`。
- 审计 `kb.settings` 的 detail 为 `{rerankProbe}`。
- 重排模型未配置：400 `bad_request`。
- 保存时重排的名称、地址或密钥任一变化，重排探活重置为 `never`。
- 两种探活排在同一条串行链上。

**写操作串行**：设置写入、探活写回、重建发起、建库，以及上面的联动（引用判定、重新下发与 `models` 的那次写入，删除时的引用判定同样在内）SHALL 由同一把进程级设置锁串行执行，保证本地设置、`models` 行与 RAGFlow 侧下发结果一致。`PUT /api/kb/settings` 对 `chatModelId` 的存在、上游与取值规则的判定 SHALL 在取得设置锁之后进行，读到的是锁内的 `models` 行与知识库行。设置锁 SHALL 按请求到达锁的先后次序交锁（FIFO），所以排在锁后的写者按排队次序执行。

#### Scenario: 下发失败不改设置
- **WHEN** 管理员首次 `PUT` 嵌入模型，假 RAGFlow 对模型下发应答 HTTP 500；随后假 RAGFlow 恢复，管理员再 `PUT` 同一 body
- **THEN** 第一次 503 `kb_unavailable`，`GET` 仍为 `embedding:null`，没有 `kb.settings` 审计；第二次 200，返回读视图（显示名称与地址，不含密钥），恰一条 `kb.settings` 审计

#### Scenario: 非管理员
- **WHEN** 普通用户请求 `GET /api/kb/settings`、`PUT /api/kb/settings`、`POST /api/kb/settings/probe` 与 `POST /api/kb/settings/rebuild`
- **THEN** 四次都是 403 `forbidden`，假 RAGFlow 收到零个请求

#### Scenario: 下发的请求序列
- **WHEN** 管理员首次 `PUT` 嵌入模型；再 `PUT` 只改 `baseUrl` 而省略 `apiKey`（没有知识库）；再 `PUT {chatModelId:"m2"}`
- **THEN** 第一次假 RAGFlow 依次收到 `PUT /providers`、`GET /models`、`POST` 实例（`model_type:["embedding"]`）、`PATCH /models/default`（`model_type:"embedding"`）；第二次依次收到 `PUT /providers`、`GET /models`、读实例的模型列表、`PUT` 实例（`api_key` 等于首次的密钥，`model_info` 非空）、`PATCH /models/default`；第三次的实例名为 `owb-chat`，`PATCH /models/default` 的 `model_type` 为 `chat`；三次都没有 `GET …/instances/<实例>`，也没有 `PATCH /users/me/models`

#### Scenario: 只含嵌入模型的保存重发对话模型
- **WHEN** 知识库对话模型为 `m2`，管理员 `PUT {embedding:{name, baseUrl}}`（同名同址，省略 `apiKey`）；另一次 `m2` 的上游在知识库关闭期间已被清空（store 直接写入）后同样 `PUT`；再一次假 RAGFlow 对 `owb-chat` 的下发应答 HTTP 503
- **THEN** 第一次 200，假 RAGFlow 依次收到 `owb-embed` 一轮与 `owb-chat` 一轮，两次 `PATCH /models/default` 的 `model_type` 依次为 `embedding`、`chat`；第二次 200，只有 `owb-embed` 一轮；第三次 503 `kb_unavailable`，本地设置不变，没有 `kb.settings` 审计

#### Scenario: 换模型时 model_info 只增不减
- **WHEN** `owb-embed` 里已有 `bge-m3`，管理员带 `confirmRebuild:true` 把名称换成 `text-embedding-3-small`
- **THEN** `PUT` 实例的 `model_info` 同时含两个模型；`PATCH /models/default` 的 `model_name` 为新模型；请求序列里没有任何 `DELETE`

#### Scenario: 名称不能含 @
- **WHEN** 管理员 `PUT` 的 `embedding.name` 为 `a@b`；`chatModelId` 为一个 id 含 `@` 的带上游模型
- **THEN** 两次都是 400，假 RAGFlow 收到零个请求

#### Scenario: 嵌入模型密钥的取值
- **WHEN** 已配置嵌入模型时 `PUT` 的 `embedding.apiKey` 为 `""`；为含换行的值；首次配置时省略 `apiKey`
- **THEN** 三次都是 400，假 RAGFlow 收到零个请求，设置不变

#### Scenario: 取消指定的无操作
- **WHEN** `chatModelId` 已是 `null`，管理员 `PUT {chatModelId:null}`
- **THEN** 200；假 RAGFlow 收到零个请求；没有 `kb.settings` 审计，`kb_settings.updated_at` 不变

#### Scenario: 探活期间嵌入模型被改
- **WHEN** 探活请求在途（假上游挂起），管理员保存了另一个嵌入模型，然后放行探活
- **THEN** 探活应答 200，为当前读视图，`embedding.probe` 是新模型的状态；没有这次探活的 `kb.settings` 审计

#### Scenario: 探活
- **WHEN** 已配置嵌入模型，假上游对 `POST <baseUrl>/embeddings` 依次应答：2xx 且 `data[0].embedding` 为非空数字数组；HTTP 500；2xx 且 `data[0].embedding` 为空数组；另一个实例未配置嵌入模型时探活
- **THEN** 前三次 200，`embedding.probe.status` 依次为 `ok`、`failed`、`failed`，各一条 `kb.settings`（detail `{probe}`），假 RAGFlow 收到零个请求，嵌入身份不变；最后一次 409 `kb_not_ready`，没有审计

#### Scenario: compileBases 的口径
- **WHEN** 有四个知识库：开 RAPTOR 的 `ready`、开知识图谱的 `rebuilding`、两个开关都开的 `rebuild_failed`、两个开关都关的 `ready`
- **THEN** 读视图的 `bases` 为 4，`compileBases` 为 3，`rebuilding` 为 1，`rebuildFailed` 为 1

#### Scenario: 对话模型联动
- **WHEN** 没有开编译的知识库，知识库对话模型为 `m2`；管理员依次执行：`DELETE /api/models?id=m2`；`PUT` `m2` 并把 `upstream` 置为 `null`；假 RAGFlow 对下发应答 HTTP 500 时 `PUT` `m2` 换新密钥；假 RAGFlow 恢复后再 `PUT` 同一新密钥；`PUT /api/kb/settings` 以一个无上游的模型作 `chatModelId`；`PUT /api/kb/settings {chatModelId:null}`；再 `DELETE /api/models?id=m2`
- **THEN** 依次为：409 `kb_model_in_use`；409 `kb_model_in_use`；503 `kb_unavailable`（密钥未变，没有 `model.update` 审计）；200（假 RAGFlow 收到带新密钥的下发）；400；200（`chatModelId` 为 `null`，假 RAGFlow 没有收到新请求）；204（假 RAGFlow 没有收到新请求）

#### Scenario: 开编译的库锁定对话模型
- **WHEN** 存在一个开了 RAPTOR 的知识库，知识库对话模型为 `m2`；管理员依次 `PUT /api/kb/settings {chatModelId:null}`；`PUT {chatModelId:"m3"}`；`PUT {chatModelId:"m2"}`；`PUT /api/models?id=m2` 换新密钥；然后删除该知识库，再 `PUT {chatModelId:null}`
- **THEN** 依次为 409 `kb_chat_model_locked`、409 `kb_chat_model_locked`（两次都没有下发，设置不变）；200（照常下发）；200（新密钥下发到 `owb-chat`）；最后一次 200 且没有 RAGFlow 请求

#### Scenario: 账号缺省不被清空
- **WHEN** 走完嵌入与对话模型的配置、取消指定、删除 `models` 行与更换嵌入模型的全部路径
- **THEN** 假 RAGFlow 的请求记录里没有 `/api/v1/providers` 下的 `DELETE`，每个 `PATCH /api/v1/models/default` 都带非空的 `model_provider`、`model_instance` 与 `model_name`

#### Scenario: 联动与设置交错
- **WHEN** 管理员 A `PUT /api/kb/settings {chatModelId:"m2"}`，假 RAGFlow 挂起这次下发；同时管理员 B `PUT /api/models?id=m2` 换成新密钥；然后假 RAGFlow 放行
- **THEN** B 的修改在 A 的本地写入完成之后才做引用判定，判定 `m2` 已被引用，于是在写库前重新下发；假 RAGFlow 最后收到的对话模型下发带新密钥；`models` 里 `m2` 的密钥为新值
- **WHEN** 次序相反：C 的嵌入设置 PUT 持锁且下发被挂起，B 的换密钥与 A 的 `chatModelId:"m2"` 依次排在锁后，然后放行
- **THEN** B 判定 `m2` 未被引用，不下发，直接写入新密钥；A 取锁后读到新密钥并下发；假 RAGFlow 最后收到的对话模型下发带新密钥

#### Scenario: 删除与设置交错
- **WHEN** 管理员 C 的一次 `PUT /api/kb/settings`（嵌入设置）持有设置锁，假 RAGFlow 挂起它的下发；B `DELETE /api/models?id=m2` 与 A `PUT /api/kb/settings {chatModelId:"m2"}` 依次排在锁后，然后假 RAGFlow 放行；另一次次序相反：A 先持锁且下发被挂起，B 随后删除
- **THEN** 第一种：B 删除 204，A 随后 400（`m2` 已不存在），假 RAGFlow 没有收到 `m2` 的下发；第二种：A 200 之后 B 的删除得 409 `kb_model_in_use`，行仍在

#### Scenario: 并发设置写入
- **WHEN** 两个管理员并发 `PUT` 不同的 `chatModelId`，假 RAGFlow 把第一个下发挂起一段时间后才应答
- **THEN** 假 RAGFlow 收到的两次下发不重叠：第二次在第一次的本地写入完成之后才发出；最终 `GET` 的 `chatModelId` 等于最后一次下发的模型

#### Scenario: 重排模型的下发序列
- **WHEN** 管理员首次 `PUT {rerank:{name:"qwen3-rerank", baseUrl, apiKey}}`；再 `PUT` 换成 `bge-reranker` 并省略 `apiKey`
- **THEN** 第一次假 RAGFlow 依次收到 `PUT /providers`、`GET /models`、`POST` 实例 `owb-rerank`（`model_info` 为 `[{model_name:"qwen3-rerank", model_type:["rerank"], max_tokens:8192}]`），没有 `PATCH /models/default`；第二次依次收到 `PUT /providers`、`GET /models`、读 `owb-rerank` 的模型列表、`PUT` 实例（`api_key` 等于首次的密钥，`model_info` 同时含两个模型），同样没有 `PATCH /models/default`；读视图的 `rerank.name` 为 `bge-reranker`，`rerank.probe.status` 为 `never`；各一条 `kb.settings`，detail 依次为 `{rerank:"qwen3-rerank"}`、`{rerank:"bge-reranker"}`

#### Scenario: 换重排模型不重建
- **WHEN** 已有两个知识库，管理员 `PUT {rerank:{name:"qwen3-rerank", baseUrl, apiKey}}`，不带 `confirmRebuild`
- **THEN** 200；没有知识库进入 `rebuilding`，没有 `kb.rebuild` 审计

#### Scenario: 清除重排模型
- **WHEN** 已配置重排模型，管理员 `PUT {rerank:null}`；再 `PUT {rerank:null}`
- **THEN** 第一次 200，读视图 `rerank` 为 `null`，假 RAGFlow 收到零个请求，恰一条 `kb.settings`（detail `{rerank:null}`）；第二次 200，没有审计，`kb_settings.updated_at` 不变；之后的检索不带 `rerank_id`

#### Scenario: 重排模型的密钥与名称
- **WHEN** 首次配置重排模型时省略 `apiKey`；`rerank.name` 为 `a@b`；已配置时 `rerank.apiKey` 为 `""`
- **THEN** 三次都是 400，假 RAGFlow 收到零个请求，设置不变

#### Scenario: 重排探活
- **WHEN** 已配置重排模型，假上游对 `POST <baseUrl>/rerank` 依次应答：2xx 且 `results[0].relevance_score` 为数字；HTTP 401；2xx 且 `results` 为空数组；另一个实例未配置重排模型时 `POST /api/kb/settings/probe?target=rerank`；再一次 `target=nope`
- **THEN** 前三次 200，`rerank.probe.status` 依次为 `ok`、`failed`、`failed`，各一条 `kb.settings`（detail `{rerankProbe}`），假 RAGFlow 收到零个请求，`embedding.probe` 不变；未配置那次与 `target=nope` 都是 400 `bad_request`，没有审计；假上游收到的 body 恰为 `{model, query:"ping", documents:["ping"]}`

#### Scenario: 探活目标的取值
- **WHEN** 已配置两种模型，管理员请求 `POST /api/kb/settings/probe?target=`；`?target=rerank&target=embedding`；`?target=embedding`
- **THEN** 前两次 400 `bad_request`，假上游收到零个请求，没有审计；第三次探嵌入模型，与不带 `target` 时相同

#### Scenario: 重排模型下发失败
- **WHEN** 已配置重排模型 `qwen3-rerank` 且探活为 `ok`；管理员 `PUT {rerank:{name:"bge-reranker", baseUrl, apiKey}}`，假 RAGFlow 对 `owb-rerank` 的实例 `PUT` 应答 HTTP 503
- **THEN** 503 `kb_unavailable`；`GET` 的 `rerank.name` 仍为 `qwen3-rerank`、`rerank.probe.status` 仍为 `ok`；没有 `kb.settings` 审计

#### Scenario: 组合保存时重排失败
- **WHEN** 已配置嵌入模型 `bge-m3`，有两个知识库；管理员 `PUT {embedding:{name:"text-embedding-3-small", baseUrl}, rerank:{name:"qwen3-rerank", baseUrl, apiKey}, confirmRebuild:true}`，假 RAGFlow 对 `owb-rerank` 的建实例应答 HTTP 503
- **THEN** 503 `kb_unavailable`；假 RAGFlow 只收到 `owb-rerank` 一轮的 `PUT /providers`、`GET /models` 与建实例，没有 `owb-embed` 的请求，也没有 `PATCH /models/default`；本地嵌入仍为 `bge-m3`，`rerank` 仍为 `null`；没有知识库进入 `rebuilding`；没有 `kb.settings` 与 `kb.rebuild` 审计

### Requirement: 嵌入模型更换与全量重建
嵌入身份 SHALL 为 `(name, baseUrl)`；只改密钥不是身份变化。

`PUT /api/kb/settings` 改变嵌入身份且存在任一知识库时，按次序判定：
1. 已有知识库处于 `rebuilding`：SHALL 409 `kb_rebuilding`，带不带 `confirmRebuild` 都一样，先于 `kb_rebuild_required`。
2. body 未带 `confirmRebuild:true`：SHALL 409 `kb_rebuild_required`，不下发，不保存。
3. body 带了：下发并保存；嵌入代数加一；全部知识库置为 `rebuilding`；`kb_settings.rebuild_actor_id` 记为本次请求的 principal；在同一事务里审计 `kb.settings` 与 `kb.rebuild`（detail `{bases, documents}`）两条；唤醒重建器。

**重建器**在进程内一次处理一个知识库，处理期间持有该库的写锁（见 knowledge-bases「同一知识库的写操作串行」）。取得锁后先重读该库的行：库已被删除或 `state` 不再是 `rebuilding` 即跳过该库。每个库的步骤：
1. 若 `rebuild_dataset_id` 非空，先按 knowledge-bases「知识库端点」的删除次序删掉残留的一代；不存在视为已删除；再把三个 `rebuild_*` 列置空。
2. 以原模板与开关、新嵌入模型，按 knowledge-bases「知识库端点」的建库流程建新一代，名为 `owb-<id 前 16 位>-g<当前代数>`（命名规则见 knowledge-bases「知识库端点」），写回 `rebuild_dataset_id`；开了开关的库另写回 `rebuild_canvas_id`、`rebuild_template_group_id`。模板组与画布 SHALL 新建，不复用旧的。账号缺省缺失时开了开关的库在这一步失败，不发后续请求。
3. 逐份文档，从旧数据集流式下载入库原件，上传到新数据集，再触发这份文档的解析。multipart 长度按本地 `size` 计算。下载结果为 not-found 的文档记为跳过；下载字节数与本地 `size` 不符、或解析未启动时该库失败。
4. 在单事务里完成切换：删除被跳过的文档行；其余行换成新的 RAGFlow 文档 id；`dataset_id`、`canvas_id`、`template_group_id` 设为对应的 `rebuild_*` 值，三个 `rebuild_*` 列置空；`embedding_generation` 设为当前代数；`state` 置为 `ready`；审计 `kb.rebuild`（detail `{id, result:"ok", skipped}`）。
5. 按同一删除次序删除旧一代。数据集删除失败写一行 `{"event":"kb_dataset_leak","datasetId":<id>}`，SHALL NOT 再删它的画布与模板组；画布或模板组删除失败写一行 `{"event":"kb_pipeline_leak","canvasId":<id|null>,"groupId":<id|null>}`，模板组删除失败时画布已删，`canvasId` 为 `null`。都不影响状态。

**下载判别**：not-found 也是 HTTP 200，文件内容可以恰好等于 not-found 正文。下载应答 SHALL 按响应头判定，不解析正文判成败：
- HTTP 200 且带 `Content-Disposition`：文件字节，正文一律不解析，不看 `Content-Type`、`Content-Length` 与文件后缀。
- HTTP 200 且不带 `Content-Disposition`：按 JSON 解析，body `code` 为 404 是 not-found，其余按「RAGFlow 出站请求」的通用行判定。
- 非 200：按通用行判定。

任一步失败 SHALL 置 `rebuild_failed`（`state_message` 为 `重建失败，可在模型设置里重试`），并审计 `kb.rebuild`（detail `{id, result:"failed"}`）。重建器写的审计 actor 为 `kb_settings.rebuild_actor_id`。

**续做与关停**：
- 服务在 `server_started` 之后，不等待地对仍为 `rebuilding` 的库从第一步续做；续做中的失败只改变知识库状态，不输出 failure record，不改变退出码。
- 关停时重建器在关闭 DB 之前停止，在途请求被中止。第 4 步提交之前，该库保持 `rebuilding`，下次启动续做。第 4 步提交之后，库已是 `ready`，第 5 步没删完的旧一代 SHALL NOT 续删，成为孤儿。
- 未配置 `RAGFLOW_BASE_URL` 时重建器不启动，`rebuilding` 的库保持原状，SHALL NOT 改成 `rebuild_failed`；重新配置后，下次启动续做。

**重试**：`POST /api/kb/settings/rebuild`（管理员，bodyless）SHALL 把全部 `rebuild_failed` 置回 `rebuilding`，把 `rebuild_actor_id` 记为本次请求的 principal，审计 `kb.rebuild`（detail `{bases, documents, retry:true}`），唤醒重建器，返回 200 加设置读视图。没有 `rebuild_failed` 的库时返回 200，不写审计。

#### Scenario: 未确认不保存
- **WHEN** 已有一个知识库，管理员 `PUT` 一个新的嵌入名称，不带 `confirmRebuild`
- **THEN** 409 `kb_rebuild_required`；设置不变；假 RAGFlow 没有收到模型下发

#### Scenario: 确认后重建
- **WHEN** 有两个知识库共三份文档，管理员带 `confirmRebuild:true` 换嵌入模型
- **THEN** 假 RAGFlow 依次收到：两次建数据集（名为 `owb-<id 前 16 位>-g1`）、三次下载、三次上传与三次解析触发、两次删除旧数据集；两个知识库最终都是 `ready`，`dataset_id` 为新数据集，文档的 RAGFlow id 为新 id；审计含一条 `kb.settings`、一条 `{bases:2, documents:3}` 与两条 `result:"ok"`，actor 都是该管理员

#### Scenario: 开编译的库重建
- **WHEN** 一个开了两种编译的知识库，管理员带 `confirmRebuild:true` 换嵌入模型
- **THEN** 假 RAGFlow 为新一代依次收到读账号缺省、读内置模板、建模板组、读内置 pipeline、建画布与建数据集（`pipeline_id` 为新画布），都名为 `owb-<id 前 16 位>-g1`；切换之后依次收到删旧数据集、删旧画布、删旧模板组；库行的三个 id 都是新一代，三个 `rebuild_*` 列为 NULL

#### Scenario: 账号缺省缺失时重建失败
- **WHEN** 一个开了 RAPTOR 的知识库重建，假 RAGFlow 的 `GET /api/v1/models/default` 应答 `models` 为空
- **THEN** 该库 `rebuild_failed`，审计 `kb.rebuild {id, result:"failed"}`；假 RAGFlow 没有收到建模板组、建画布与建数据集

#### Scenario: 旧一代删除失败
- **WHEN** 重建切换之后，假 RAGFlow 对删旧数据集应答 HTTP 503；另一次对删旧画布应答 HTTP 503；再一次对删旧模板组应答 HTTP 503
- **THEN** 第一次 stderr 恰一行 `kb_dataset_leak`，没有发出删画布与删模板组；第二次恰一行 `kb_pipeline_leak`，`canvasId` 与 `groupId` 都非空，没有发出删模板组；第三次恰一行 `kb_pipeline_leak`，`canvasId` 为 `null`、`groupId` 非空；三次该库都是 `ready`

#### Scenario: 原件缺失与下载判别
- **WHEN** 一个知识库有三份文档：第一份下载应答 HTTP 200、不带 `Content-Disposition`、`Content-Type` 为 JSON、正文 `{"code":404,"message":"Resource not found"}`；第二份下载应答 HTTP 200、带 `Content-Disposition`，文件内容恰为同一段正文；第三份的下载字节比本地 `size` 少一个字节（在另一次重建里）
- **THEN** 第一次重建 `ready`：第一份的行已删除，`kb.rebuild` 的 `skipped` 恰为它的文档 id，第二份作为文件上传且字节不变，multipart 长度按本地 `size` 计算；另一次重建该库为 `rebuild_failed`

#### Scenario: 不带头的错误应答
- **WHEN** 重建中一份文档的下载应答 HTTP 200、不带 `Content-Disposition`、正文 `{"code":500,"message":"Failed to download document"}`
- **THEN** 该库 `rebuild_failed`；假 RAGFlow 没有收到这份内容的上传

#### Scenario: 中途失败与重试
- **WHEN** 重建第二个知识库时假 RAGFlow 的上传返回 HTTP 500；随后假 RAGFlow 恢复，管理员 `POST /api/kb/settings/rebuild`
- **THEN** 第一个库 `ready`；第二个库 `rebuild_failed`，对它入库得 409 `kb_rebuilding`，移出文档仍可成功；重试返回 200 读视图，第二个库先删残留的新数据集再重建，最终 `ready`

#### Scenario: 重建中改嵌入身份
- **WHEN** 一个知识库处于 `rebuilding`，管理员 `PUT` 新的嵌入名称，不带 `confirmRebuild`；再带 `confirmRebuild:true`；再只换 `apiKey`
- **THEN** 前两次都是 409 `kb_rebuilding`，假 RAGFlow 没有收到下发，设置不变；第三次 200，照常下发

#### Scenario: 没有失败库时重试
- **WHEN** 没有 `rebuild_failed` 的知识库，管理员 `POST /api/kb/settings/rebuild`
- **THEN** 200 读视图；没有 `kb.rebuild` 审计，`rebuild_actor_id` 不变，假 RAGFlow 收到零个请求

#### Scenario: 崩溃后续做
- **WHEN** 一个知识库处于 `rebuilding`、`rebuild_dataset_id` 非空时进程退出，随后重启
- **THEN** 重启后重建器先删除该残留数据集，再从建新数据集开始，最终 `ready`；这一条 `kb.rebuild` 的 actor 为原发起人

#### Scenario: 编译库的残留清理
- **WHEN** 一个开了 RAPTOR 的知识库处于 `rebuilding`，三个 `rebuild_*` 列都非空时进程退出，随后重启
- **THEN** 重启后假 RAGFlow 先依次收到残留一代的删数据集、删画布、删模板组，再收到新一代的建库序列；最终 `ready`

#### Scenario: 关停时在途重建
- **WHEN** 重建器在下载或上传时被挂起，服务收到 SIGTERM；另一次重建器已完成切换，在删旧一代时被挂起，服务收到 SIGTERM
- **THEN** 两次进程都以 0 退出，在途请求被中止，DB 已关闭；第一次该库仍为 `rebuilding`，重启后续做；第二次该库为 `ready`，重启后假 RAGFlow 没有收到旧一代的删除

#### Scenario: 续做失败不影响进程
- **WHEN** 一个知识库处于 `rebuilding`，重启时 RAGFlow 不可达
- **THEN** 启动成功，success record 照常写出，没有 failure record，退出码不变；该库 `rebuild_failed`

#### Scenario: 知识库关闭时不动重建状态
- **WHEN** 一个知识库处于 `rebuilding`，服务以未配置 `RAGFLOW_BASE_URL` 启动，随后以配置了的状态重启
- **THEN** 第一次启动后该库仍为 `rebuilding`，没有 `kb.rebuild` 审计；第二次启动后续做，最终 `ready`

### Requirement: 共用开发栈的使用纪律
仓库 SHALL NOT 提交任何 RAGFlow 栈定义（compose 文件、镜像构建或启动脚本）。本仓的 Makefile 目标、脚本与测试 SHALL NOT 执行 `docker compose up` / `down` / `restart`，也不修改 RAGFlow 栈的配置。

需要真实 RAGFlow 的任务与 `make smoke-kb` SHALL 从调用方 shell 环境读 `RAGFLOW_BASE_URL`（任务另读 `RAGFLOW_API_KEY_FILE`），并区分两种停止：
- **私有配置缺失**：变量未设置，或密钥文件不存在。报告 `RAGFlow 私有配置缺失`。
- **栈未就绪**：版本接口不可达，或版本串不是 `v1.0.0-rc2`。报告 `共用 RAGFlow 栈未运行或版本不符`。

两种情况都以非零退出，SHALL NOT 尝试拉起。

在共用栈上的使用规则：
- 只使用 open-workbuddy 专用账号。
- 只删除本仓创建的对象（数据集、画布与模板组，名称前缀为 `owb-`）：实测只删本次运行建的；冒烟只经 app-server 删除它自己建的知识库（含上一次中断留下的同名库）。
- 建 pipeline 数据集之前 SHALL 确认 `GET /api/v1/models/default` 的 `chat` 与 `embedding` 两种都在。
- 清理次序照实测记录 §16：账号缺省保持不动，先删数据集、画布、模板组，静默到没有编译活动，才清账号缺省、删模型实例与提供方。有 pipeline 数据集或待合并任务时 SHALL NOT 清空账号缺省对话模型。

RAGFlow 地址、账号名与密钥文件路径 SHALL 只出现在本机未跟踪的私有配置里；被跟踪的文件、issue 与 PR 正文一律写作 `<RAGFLOW_BASE_URL>`。

#### Scenario: 栈未运行
- **WHEN** `RAGFLOW_BASE_URL` 指向一个已关闭的端口时执行 `make smoke-kb`
- **THEN** 命令在发出任何知识库请求之前以非零退出，输出含 `共用 RAGFlow 栈未运行或版本不符`；Makefile 的 `smoke-kb` 目标文本不含 `docker`
