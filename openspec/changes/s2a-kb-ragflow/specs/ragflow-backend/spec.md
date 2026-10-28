## ADDED Requirements

### Requirement: RAGFlow 接口实测记录
仓库 SHALL 有一份 `docs/reviews/2026-10-28-ragflow-rc2-api.md`，记录对运行中的 RAGFlow `v1.0.0-rc2` 用 API key 实测得到的事实，每条附请求与应答摘录（不含 key 与文件内容）：版本接口的应答字段；建数据集时十二种模板的取值与字段名（`chunk_method` 或 `parser_id`）、`embedding_model` 的格式、RAPTOR 与知识图谱的开启方式（数据集字段或 knowledge compilation 模板）与是否需要显式触发；`chunk_count` 非 0 时改 `embedding_model` 的结果；multipart 上传的字段名、是否接受带 `Content-Length` 的流式体；解析触发、文档列表的分页参数与运行状态取值、切片数字段；原件下载是否带 `Content-Length`；文档与数据集删除对不存在 id 的应答；模型提供方与账号缺省模型能否用 API key 配置；以及 HTTP 状态与 body `code` 的组合。本记录 SHALL 是假 RAGFlow 夹具协议的唯一来源；记录每一节写明结论「支持」或「不支持」，D7 的退路与 D14 的停止条件以它为准。

#### Scenario: 夹具与记录一致
- **WHEN** 评审 `server/test/support/fake-ragflow.mjs` 的任一路由、字段名或状态值
- **THEN** 它在实测记录里有对应条目；记录里没有的接口不出现在夹具里

### Requirement: 知识库配置与密钥文件
app-server SHALL 解析 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE`、`KB_UPLOAD_MAX_BYTES`、`KB_UPLOAD_MAX_FILES` 四个键（规则见 http-service-skeleton「服务启动与装配」）。配置了 `RAGFLOW_BASE_URL` 时，启动阶段 `kb_key` SHALL 读取 `RAGFLOW_API_KEY_FILE`：该路径须为普通文件（`lstat`，不跟随符号链接）、属主为本进程 uid、`mode & 0o077` 为 0、大小 1–4096 字节，内容去掉恰一个结尾 `\n` 后非空且可作 HTTP 头值；任一不满足即启动失败，失败记录的 `reason` 为 `kb_key`，错误信息只点名键、不含文件内容。密钥 SHALL 只留在 `kb` 模块内存中，不出现在任何响应、审计 detail、日志行与子进程环境里。未配置 `RAGFLOW_BASE_URL` 时 SHALL 不读任何密钥文件。

#### Scenario: 密钥文件不合规即启动失败
- **WHEN** 分别以 mode `0644` 的文件、指向合规文件的符号链接、空文件、属主为别的 uid 的文件、内容含 `\r` 的文件作为 `RAGFLOW_API_KEY_FILE` 启动编译入口
- **THEN** 每次都启动失败，失败记录 `reason` 为 `kb_key`，stderr 与 stdout 不含文件内容；以合规的 `0600` 文件启动则成功

#### Scenario: 密钥不进 omp 环境
- **WHEN** 知识库已配置，任一会话 spawn omp 子进程
- **THEN** 子进程环境里没有任何值等于密钥，也没有名为 `RAGFLOW_API_KEY_FILE` 或 `RAGFLOW_BASE_URL` 的键

### Requirement: 知识库可用性
未配置 `RAGFLOW_BASE_URL` 时知识库 SHALL 关闭：除 `GET /api/kb/status` 返回 `{enabled:false}` 外，全部 `/api/kb/*` 端点（含管理员端点）SHALL 返回 503 `kb_disabled`，且不发任何出站请求。配置了之后 SHALL 照常启动而不在启动时连接 RAGFlow；之后任何一次 RAGFlow 请求失败只影响当次请求（按「RAGFlow 出站请求」映射），会话、文件等其它功能不受影响。

#### Scenario: 未配置即关闭
- **WHEN** 未配置 `RAGFLOW_BASE_URL` 时请求 `GET /api/kb/bases`、`POST /api/kb/bases`、`GET /api/kb/settings`
- **THEN** 三次都是 503 `kb_disabled` 信封，假 RAGFlow 收到零个请求

#### Scenario: 不可达不阻断
- **WHEN** `RAGFLOW_BASE_URL` 指向一个已关闭的端口时启动服务，随后创建会话并请求 `GET /api/kb/bases`
- **THEN** 启动成功；会话创建成功；`GET /api/kb/bases` 为 503 `kb_unavailable`

### Requirement: RAGFlow 出站请求
`kb` 模块对 RAGFlow 的全部请求 SHALL 经同一个客户端发出：`agent:false`、不跟随重定向、不重试；JSON 请求连接期限 10 s、总期限 30 s、响应体至多 1 MiB；上传与下载连接期限 10 s、空闲期限 60 s；除 `/api/v1/system/version` 外每个请求带 `Authorization: Bearer <密钥>`。结果 SHALL 映射为：HTTP 2xx 且 body `code` 为 0 → 成功；body `code` 为 101 或 102 → `kb_rejected`（400）；HTTP 401 / 403 或 body `code` 为 108 / 109 → `kb_unavailable`（503）并经受管 stderr writer 写一行恰为 `{"event":"kb_upstream_auth_failed"}` 的记录（同一进程 60 秒内至多一行）；其它非零 `code`、非 2xx、3xx、非 JSON、超体积、超时、连接失败 → `kb_unavailable`。RAGFlow 应答的 message 与正文 SHALL NOT 进入本系统的响应、审计或日志。

#### Scenario: 结果映射
- **WHEN** 假 RAGFlow 对建库请求依次应答：HTTP 200 `code:0`；HTTP 200 `code:101`；HTTP 200 `code:109`；HTTP 302；HTTP 200 非 JSON；挂起超过总期限（期限经装配注入缩短）
- **THEN** `POST /api/kb/bases` 依次得到 201、400 `kb_rejected`、503 `kb_unavailable`（并恰一行 `kb_upstream_auth_failed`）、503、503、503；后五次都不插知识库行；任何响应与 stderr 都不含假 RAGFlow 返回的 message 文本

#### Scenario: 每个请求带密钥
- **WHEN** 知识库端点触发对假 RAGFlow 的建库、上传、列表、删除与版本请求
- **THEN** 除版本请求外每个请求的 `Authorization` 恰为 `Bearer <密钥>`；版本请求不带 `Authorization`；没有请求跟随重定向

### Requirement: 知识库状态端点
`GET /api/kb/status` SHALL 对任何已登录用户可用（未登录 401）。知识库关闭时应答恰为 `{enabled:false}`；开启时 SHALL 请求一次 RAGFlow 版本接口（总期限 5 s，不带密钥），应答恰为 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`：`available` 当且仅当版本接口可达且版本串恰为 `v1.0.0-rc2`；版本不符时写一行恰为 `{"event":"kb_version_mismatch"}` 的 stderr 记录（同一进程 60 秒内至多一行）；`embeddingReady` 为已配置知识库嵌入模型；`compileReady` 为已指定知识库对话模型；后两个数为两个上传上限的配置值。应答带 `Cache-Control: no-store`。

#### Scenario: 版本钉住
- **WHEN** 假 RAGFlow 的版本串依次为 `v1.0.0-rc2`、`v1.0.0-rc1`，再关闭假 RAGFlow
- **THEN** `available` 依次为 `true`、`false`（并恰一行 `kb_version_mismatch`）、`false`；三次都是 200

### Requirement: 知识库模型设置
管理员 SHALL 能经 `GET /api/kb/settings` 读、`PUT /api/kb/settings` 写知识库模型设置，经 `POST /api/kb/settings/probe` 探活嵌入模型；非管理员 403 `forbidden`，未登录 401。读视图恰为 `{embedding: {name, baseUrl, probe: {status, message, at}} | null, chatModelId: string | null, bases, documents, rebuilding, rebuildFailed}`（后四个为知识库总数、文档总数与两种重建状态的知识库数），永不包含嵌入密钥。`PUT` body 键集 SHALL 为 `embedding`、`chatModelId`、`confirmRebuild` 的子集：`embedding` 为 `{name, baseUrl, apiKey?}`（`name` 1–128 字节无控制字符；`baseUrl` 与模型上游地址同一规则；首次配置必须带 `apiKey`，之后省略即保留），`chatModelId` 为 `models` 中存在的 id 或 `null`；其它键、类型不符或 id 不存在 400。保存 SHALL 先把嵌入模型与知识库对话模型（取其上游地址与密钥）下发到 RAGFlow 服务账号，下发失败按「RAGFlow 出站请求」映射且本地设置不变；下发成功后在同一事务里写设置并审计 `kb.settings`。删除被指定为知识库对话模型的 `models` 行 SHALL 把 `chatModelId` 置为 `null`。探活向嵌入上游 `POST <baseUrl>/embeddings`（body `{model, input:"ping"}`，期限与模型探活相同），2xx 且应答 `data[0].embedding` 为非空数字数组为 `ok`，结果写回设置并审计；探活不下发、不改嵌入身份。

#### Scenario: 下发失败不改设置
- **WHEN** 管理员首次 `PUT` 嵌入模型而假 RAGFlow 对模型下发应答 HTTP 500；随后假 RAGFlow 恢复再 `PUT` 同一 body
- **THEN** 第一次 503 `kb_unavailable`，`GET` 仍为 `embedding:null`，无 `kb.settings` 审计；第二次 200，`GET` 显示名称与地址、不含密钥，恰一条 `kb.settings` 审计

#### Scenario: 非管理员
- **WHEN** 普通用户请求 `GET /api/kb/settings`、`PUT /api/kb/settings`、`POST /api/kb/settings/probe`、`POST /api/kb/settings/rebuild`
- **THEN** 四次都是 403 `forbidden`，假 RAGFlow 收到零个请求

### Requirement: 运维手配退路
当且仅当「RAGFlow 接口实测记录」的模型下发一节结论为「不支持」时，本 requirement SHALL 取代「知识库模型设置」中关于嵌入模型的写入与下发部分：`PUT /api/kb/settings` 不接受 `embedding` 键（400）；读视图的 `embedding` 为 RAGFlow 服务账号当前缺省嵌入模型的名称（`{name, baseUrl:null, probe:null}`，读不到为 `null`）；`embeddingReady` 为该名称存在；嵌入身份变化 SHALL 在读视图里以 `rebuildNeeded: true` 体现（存在任一知识库的嵌入名称与当前缺省不同），管理员经 `POST /api/kb/settings/rebuild` 带 `{confirm:true}` 发起全量重建，其后流程与「嵌入模型更换与全量重建」相同。结论为「支持」时本 requirement 不实施，其场景不进用例。

#### Scenario: 退路下的重建
- **WHEN**（仅退路启用时）假 RAGFlow 的缺省嵌入模型由 `bge-m3@x` 改为 `text-embedding-3-small@x`，管理员读设置后带 `{confirm:true}` 请求重建
- **THEN** 读视图 `rebuildNeeded:true`；重建后全部知识库 `state` 为 `ready`，`rebuildNeeded:false`

### Requirement: 嵌入模型更换与全量重建
嵌入身份为 `(name, baseUrl)`。`PUT /api/kb/settings` 改变嵌入身份且存在任一知识库时：body 未带 `confirmRebuild:true` SHALL 409 `kb_rebuild_required`，不下发不保存；带了则保存、嵌入代数加一、全部知识库置 `rebuilding`、审计 `kb.rebuild`（detail `{bases, documents}`）并唤醒重建器。已有知识库处于 `rebuilding` 时改嵌入身份 SHALL 409 `kb_rebuilding`。只改密钥不是身份变化。重建器 SHALL 在进程内一次处理一个知识库：删除残留的 `rebuild_dataset_id` 数据集 → 以原模板与开关、新嵌入模型建新数据集 → 逐份从旧数据集下载入库原件并上传到新数据集（下载应答无 `Content-Length` 即该库失败）→ 对新数据集触发解析 → 单事务切换文档 id、`dataset_id` 与代数并置 `ready` → 删除旧数据集（失败只写一行带数据集 id 的 `{"event":"kb_dataset_leak", ...}`）。任一步失败 SHALL 置 `rebuild_failed`（`state_message` 为固定中文句子）并审计 `kb.rebuild`（`result: "failed"`）；成功审计 `result: "ok"`。服务启动后 SHALL 对仍为 `rebuilding` 的库从第一步续做。`POST /api/kb/settings/rebuild`（管理员，bodyless）SHALL 把全部 `rebuild_failed` 置回 `rebuilding` 并唤醒重建器，审计 `kb.rebuild`。

#### Scenario: 未确认不保存
- **WHEN** 已有一个知识库，管理员 `PUT` 一个新的嵌入名称而不带 `confirmRebuild`
- **THEN** 409 `kb_rebuild_required`；设置不变；假 RAGFlow 没有收到模型下发

#### Scenario: 确认后重建
- **WHEN** 有两个知识库共三份文档，管理员带 `confirmRebuild:true` 换嵌入模型
- **THEN** 假 RAGFlow 依次收到：两次建数据集、三次下载与三次上传、两次解析触发、两次删除旧数据集；两个知识库最终 `ready`，`dataset_id` 为新数据集，文档的 RAGFlow id 为新 id；审计含一条 `{bases:2, documents:3}` 与两条 `result:"ok"`

#### Scenario: 中途失败与重试
- **WHEN** 重建第二个知识库时假 RAGFlow 的上传返回 HTTP 500；随后假 RAGFlow 恢复，管理员 `POST /api/kb/settings/rebuild`
- **THEN** 第一个库 `ready`、第二个库 `rebuild_failed` 且对它入库得 409 `kb_rebuilding`；重试后第二个库先删残留的新数据集再重建，最终 `ready`

#### Scenario: 崩溃后续做
- **WHEN** 一个知识库处于 `rebuilding` 且 `rebuild_dataset_id` 非空时进程退出，随后重启
- **THEN** 重启后重建器先删除该残留数据集，再从建新数据集开始，最终 `ready`

### Requirement: 共用开发栈的使用纪律
仓库 SHALL NOT 提交任何 RAGFlow 栈定义（compose 文件、镜像构建或启动脚本），本仓的 Makefile 目标、脚本与测试 SHALL NOT 执行 `docker compose up` / `down` / `restart` 或修改 RAGFlow 栈的配置。需要真实 RAGFlow 的任务与 `make smoke-kb` SHALL 先检测 `RAGFLOW_BASE_URL` 的版本接口可达且版本串恰为 `v1.0.0-rc2`，不满足即以非零退出并报告「共用 RAGFlow 栈未运行或版本不符」，不尝试拉起。在共用栈上只使用 open-workbuddy 专用账号；实测与冒烟只删除自己创建的、名称前缀为 `owb-` 的数据集。RAGFlow 地址、账号与密钥文件路径 SHALL 只出现在本机未跟踪的私有配置里。

#### Scenario: 栈未运行
- **WHEN** 共用栈没有运行时执行 `make smoke-kb`
- **THEN** 命令在发出任何知识库请求之前以非零退出，输出含 `共用 RAGFlow 栈未运行或版本不符`；本机没有新增任何容器
