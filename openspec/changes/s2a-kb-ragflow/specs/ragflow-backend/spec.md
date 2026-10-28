## ADDED Requirements

### Requirement: RAGFlow 接口实测记录
仓库 SHALL 有一份 `docs/reviews/2026-10-28-ragflow-rc2-api.md`，记录用 API key 实测运行中的 RAGFlow `v1.0.0-rc2` 得到的事实。每节附请求与应答摘录，并写明结论「支持」或「不支持」。记录 SHALL 覆盖：
- **版本接口**：应答字段。
- **建数据集**：十二种模板的字段名（`chunk_method` 或 `parser_id`）与取值；`embedding_model` 的格式；同名数据集的应答（是否自动加后缀）。
- **RAPTOR 与知识图谱**：开启方式（数据集字段或 knowledge compilation 模板）；是否需要显式触发，需要时的触发接口；编译状态接口及其全部状态取值；知识图谱对每种模板是否可用。
- **改嵌入模型**：`chunk_count` 非 0 时改 `embedding_model` 的应答。
- **multipart 上传**：字段名；是否接受带 `Content-Length` 的流式请求体。
- **解析与文档列表**：解析触发接口；文档列表的分页参数；运行状态的全部取值（含未开始），以及到本系统文档状态的映射；切片数字段。
- **原件下载**：应答是否带 `Content-Length`，或是否用分块传输。
- **不存在的 id**：数据集与文档 id 不存在时，删除、列表与下载各自的 HTTP 状态与 body `code`，以及它们能否与「参数非法」区分。
- **模型下发**：能否用 API key 配置模型提供方 instance 与账号缺省模型；配置后能否以 `embedding_model` 引用；能否删除已下发的配置。
- **错误组合**：鉴权失败、参数非法、权限不足各自的 HTTP 状态与 body `code`。

本记录 SHALL 是假 RAGFlow 夹具协议的唯一来源。

仓库是 public，记录 SHALL 脱敏：
- RAGFlow 的地址一律写作 `<RAGFLOW_BASE_URL>`。
- 租户、用户、数据集与文档 id 一律以占位符代替；邮箱、昵称与账号名同样代替。
- 密钥、密钥文件路径与文件内容 SHALL NOT 出现。

#### Scenario: 夹具与记录一致
- **WHEN** 评审 `server/test/support/fake-ragflow.mjs` 的任一路由、字段名或状态值
- **THEN** 它在实测记录里有对应条目；记录里没有的接口不出现在夹具里

#### Scenario: 记录已脱敏
- **WHEN** 对实测记录运行 gitleaks，并用 grep 搜实测时所用的 RAGFlow 主机名或 IP、端口与专用账号名
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
- 版本钉住只决定 `GET /api/kb/status` 的 `available`，其它知识库端点不因版本不符而拒绝请求；web 在 `available:false` 时不渲染知识库控件。

#### Scenario: 未配置即关闭
- **WHEN** 未配置 `RAGFLOW_BASE_URL` 时，管理员逐个请求 `GET /api/kb/status` 之外的十二条知识库路由，`POST` / `PUT` 路由带 malformed JSON body；再以匿名身份请求其中一条
- **THEN** 管理员的十二次都是 503 `kb_disabled` 信封；匿名那次是 401；假 RAGFlow 收到零个请求

#### Scenario: 不可达不阻断
- **WHEN** `RAGFLOW_BASE_URL` 指向一个已关闭的端口时启动服务（store 里预置一个知识库行）；随后依次创建会话、请求 `GET /api/kb/status`、`GET /api/kb/bases` 与 `DELETE /api/kb/bases/:id`
- **THEN** 启动成功，会话创建成功；状态为 `available:false`；列表为 200，含该库；删除为 503 `kb_unavailable`，库行仍在

### Requirement: RAGFlow 出站请求
`kb` 模块对 RAGFlow 的全部请求 SHALL 经同一个客户端发出：
- `agent:false`，不跟随重定向，不重试。
- JSON 请求：连接期限 10 s，总期限 30 s，响应体至多 1 MiB。
- 上传与下载：连接期限 10 s，空闲期限 60 s。
- 除 `/api/v1/system/version` 外，每个请求都带 `Authorization: Bearer <密钥>`。

结果映射 SHALL 按以下次序判定：
1. 实测记录给出的「不存在」组合（数据集或文档 id 不存在时的 HTTP 状态与 body `code`）先于下面各条，识别为类型化的 not-found 结果，由调用点处理：删除视为已删除；文档读取视为 `missing`；数据集读取视为该库的数据集已丢失。
2. HTTP 2xx 且 body `code` 为 0：成功。
3. body `code` 为 101 或 102：`kb_rejected`（400）。
4. HTTP 401 / 403，或 body `code` 为 108 / 109：`kb_unavailable`（503），并经受管 stderr writer 写一行，恰为 `{"event":"kb_upstream_auth_failed"}`；同一进程 60 秒内至多一行。
5. 其余（其它非零 `code`、非 2xx、3xx、非 JSON、超出体积、超时、连接失败）：`kb_unavailable`。

RAGFlow 应答的 message 与正文 SHALL NOT 进入本系统的响应、审计或日志。

#### Scenario: 结果映射
- **WHEN** 假 RAGFlow 对建库请求依次应答：HTTP 200 `code:0`；HTTP 200 `code:101`；HTTP 200 `code:109`；HTTP 302；HTTP 200 非 JSON；挂起超过总期限（期限经装配注入缩短）
- **THEN** `POST /api/kb/bases` 依次得到 201、400 `kb_rejected`、503 `kb_unavailable`（并恰一行 `kb_upstream_auth_failed`）、503、503、503；后五次都不插知识库行；任何响应与 stderr 都不含假 RAGFlow 返回的 message 文本

#### Scenario: 不存在视为已删
- **WHEN** 假 RAGFlow 对删数据集与删文档请求都应答实测记录给出的「不存在」组合，用户先移出一份文档，再删除该知识库
- **THEN** 两次分别为 204；文档行与知识库行都已删除；各有一条 `kb.document_delete` 与 `kb.delete`

#### Scenario: 每个请求带密钥
- **WHEN** 知识库端点触发对假 RAGFlow 的建库、上传、列表、删除与版本请求
- **THEN** 除版本请求外，每个请求的 `Authorization` 恰为 `Bearer <密钥>`；版本请求不带 `Authorization`；没有请求跟随重定向

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
- `POST /api/kb/settings/probe`：探活嵌入模型。

三者的成功应答都是 200 加设置读视图，带 no-store。

**读视图**恰为 `{embedding, chatModelId, bases, documents, rebuilding, rebuildFailed}`，永不包含任何密钥：
- `embedding` 为 `{name, baseUrl, probe: {status, message, at}}` 或 `null`。
- `chatModelId` 为字符串或 `null`。
- `bases`、`documents`：知识库总数与文档总数。
- `rebuilding`、`rebuildFailed`：处于这两种重建状态的知识库数。

**PUT 的 body** 键集 SHALL 是 `embedding`、`chatModelId`、`confirmRebuild` 的非空子集，且至少含 `embedding` 与 `chatModelId` 之一：
- `embedding` 为 `{name, baseUrl, apiKey?}`：`name` 为 1–128 字节、无控制字符；`baseUrl` 与模型上游地址同一规则；首次配置必须带 `apiKey`，之后省略即保留。
- `chatModelId` 为 `models` 中**带上游**的 id，或 `null`。
- 其它键、类型不符、id 不存在或该模型没有上游：400。

**保存流程**：
1. 先把配置下发到 RAGFlow 服务账号：嵌入模型；以及知识库对话模型（取该 `models` 行的上游地址与密钥）。`chatModelId` 由非空改为 `null` 时，撤销 RAGFlow 侧的对话模型配置。
2. 下发或撤销失败：按「RAGFlow 出站请求」映射，本地设置不变。
3. 成功后：在同一事务里写设置，并审计 `kb.settings`。

**与 models 的联动**：知识库对话模型引用 `models` 的一行。知识库开启时：
- 该行不能删除，也不能把上游清空：409 `kb_model_in_use`。
- 修改该行的上游地址或密钥（model-registry 的 `upstreamChanged` 为真），SHALL 在本地写入之前把新上游重新下发到 RAGFlow；下发失败则这次修改失败（按映射），行不变，不审计，不发布。

知识库关闭时联动不生效：删除照常进行，经外键把 `chat_model_id` 置空。`models` 模块经装配注入的钩子调用这些检查，不反向依赖 `kb`。

**探活**：向嵌入上游发 `POST <baseUrl>/embeddings`，body `{model, input:"ping"}`，期限与模型探活相同。
- 结果：2xx 且应答 `data[0].embedding` 为非空数字数组为 `ok`，否则为 `failed`。
- 结果写回设置，并审计 `kb.settings`（detail `{probe}`）。
- 嵌入模型未配置时：409 `kb_not_ready`。
- 探活不下发，也不改嵌入身份。

**写操作串行**：设置写入、探活写回、重建发起、建库，以及上面的联动（引用判定、重新下发与 `models` 的那次写入，删除时的引用判定同样在内）SHALL 由同一把进程级设置锁串行执行，保证本地设置、`models` 行与 RAGFlow 侧下发结果一致。`PUT /api/kb/settings` 对 `chatModelId` 的存在与上游校验 SHALL 在取得设置锁之后进行，读到的是锁内的 `models` 行。

#### Scenario: 下发失败不改设置
- **WHEN** 管理员首次 `PUT` 嵌入模型，假 RAGFlow 对模型下发应答 HTTP 500；随后假 RAGFlow 恢复，管理员再 `PUT` 同一 body
- **THEN** 第一次 503 `kb_unavailable`，`GET` 仍为 `embedding:null`，没有 `kb.settings` 审计；第二次 200，返回读视图（显示名称与地址，不含密钥），恰一条 `kb.settings` 审计

#### Scenario: 非管理员
- **WHEN** 普通用户请求 `GET /api/kb/settings`、`PUT /api/kb/settings`、`POST /api/kb/settings/probe` 与 `POST /api/kb/settings/rebuild`
- **THEN** 四次都是 403 `forbidden`，假 RAGFlow 收到零个请求

#### Scenario: 对话模型联动
- **WHEN** 知识库对话模型为 `m2`；管理员依次执行：`DELETE /api/models?id=m2`；`PUT` `m2` 并把 `upstream` 置为 `null`；假 RAGFlow 对下发应答 HTTP 500 时 `PUT` `m2` 换新密钥；假 RAGFlow 恢复后再 `PUT` 同一新密钥；`PUT /api/kb/settings` 以一个无上游的模型作 `chatModelId`；`PUT /api/kb/settings {chatModelId:null}`；再 `DELETE /api/models?id=m2`
- **THEN** 依次为：409 `kb_model_in_use`；409 `kb_model_in_use`；503 `kb_unavailable`（密钥未变，没有 `model.update` 审计）；200（假 RAGFlow 收到带新密钥的下发）；400；200（假 RAGFlow 收到撤销，`chatModelId` 为 `null`）；204

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

### Requirement: 嵌入模型更换与全量重建
嵌入身份 SHALL 为 `(name, baseUrl)`；只改密钥不是身份变化。

`PUT /api/kb/settings` 改变嵌入身份且存在任一知识库时：
- body 未带 `confirmRebuild:true`：SHALL 409 `kb_rebuild_required`，不下发，不保存。
- body 带了：下发并保存；嵌入代数加一；全部知识库置为 `rebuilding`；`kb_settings.rebuild_actor_id` 记为本次请求的 principal；在同一事务里审计 `kb.settings` 与 `kb.rebuild`（detail `{bases, documents}`）两条；唤醒重建器。
- 已有知识库处于 `rebuilding` 时改嵌入身份：SHALL 409 `kb_rebuilding`。

**重建器**在进程内一次处理一个知识库，处理期间持有该库的写锁（见 knowledge-bases「同一知识库的写操作串行」）。取得锁后先重读该库的行：库已被删除或 `state` 不再是 `rebuilding` 即跳过该库。每个库的步骤：
1. 若 `rebuild_dataset_id` 非空，先删除该数据集；不存在视为已删除。
2. 以原模板与开关、新嵌入模型建新数据集，名为 `owb-<id>-g<当前代数>`，写回 `rebuild_dataset_id`。
3. 逐份文档，从旧数据集流式下载入库原件，上传到新数据集。multipart 长度按本地 `size` 计算，不依赖下载应答的 `Content-Length`。下载结果为 not-found 的文档记为跳过；下载字节数与本地 `size` 不符时该库失败。
4. 对新数据集触发解析；实测记录要求显式触发编译、且该库开了 RAPTOR 或知识图谱时，再触发一次编译。
5. 在单事务里完成切换：删除被跳过的文档行；其余行换成新的 RAGFlow 文档 id；`dataset_id` 设为 `rebuild_dataset_id`，`rebuild_dataset_id` 置空；`embedding_generation` 设为当前代数；`state` 置为 `ready`；审计 `kb.rebuild`（detail `{id, result:"ok", skipped}`）。
6. 删除旧数据集。删除失败只写一行 `{"event":"kb_dataset_leak","datasetId":<id>}`，不影响状态。

任一步失败 SHALL 置 `rebuild_failed`（`state_message` 为 `重建失败，可在模型设置里重试`），并审计 `kb.rebuild`（detail `{id, result:"failed"}`）。重建器写的审计 actor 为 `kb_settings.rebuild_actor_id`。

**续做与关停**：
- 服务在 `server_started` 之后，不等待地对仍为 `rebuilding` 的库从第一步续做；续做中的失败只改变知识库状态，不输出 failure record，不改变退出码。
- 关停时重建器在关闭 DB 之前停止：在途请求被中止，该库保持 `rebuilding`。

**重试**：`POST /api/kb/settings/rebuild`（管理员，bodyless）SHALL 把全部 `rebuild_failed` 置回 `rebuilding`，把 `rebuild_actor_id` 记为本次请求的 principal，审计 `kb.rebuild`（detail `{bases, documents, retry:true}`），唤醒重建器，返回 200 加设置读视图。没有 `rebuild_failed` 的库时返回 200，不写审计。

#### Scenario: 未确认不保存
- **WHEN** 已有一个知识库，管理员 `PUT` 一个新的嵌入名称，不带 `confirmRebuild`
- **THEN** 409 `kb_rebuild_required`；设置不变；假 RAGFlow 没有收到模型下发

#### Scenario: 确认后重建
- **WHEN** 有两个知识库共三份文档，管理员带 `confirmRebuild:true` 换嵌入模型
- **THEN** 假 RAGFlow 依次收到：两次建数据集（名为 `owb-<id>-g1`）、三次下载与三次上传、两次解析触发、两次删除旧数据集；两个知识库最终都是 `ready`，`dataset_id` 为新数据集，文档的 RAGFlow id 为新 id；审计含一条 `kb.settings`、一条 `{bases:2, documents:3}` 与两条 `result:"ok"`，actor 都是该管理员

#### Scenario: 原件缺失与分块下载
- **WHEN** 一个知识库有三份文档：第一份下载为 not-found；第二份的下载应答不带 `Content-Length`、以分块传输；第三份的下载字节比本地 `size` 少一个字节（在另一次重建里）
- **THEN** 第一次重建 `ready`：第一份的行已删除，`kb.rebuild` 的 `skipped` 恰为它的文档 id，第二份上传的 multipart 长度按本地 `size` 计算；另一次重建该库为 `rebuild_failed`

#### Scenario: 中途失败与重试
- **WHEN** 重建第二个知识库时假 RAGFlow 的上传返回 HTTP 500；随后假 RAGFlow 恢复，管理员 `POST /api/kb/settings/rebuild`
- **THEN** 第一个库 `ready`；第二个库 `rebuild_failed`，对它入库得 409 `kb_rebuilding`，移出文档仍可成功；重试返回 200 读视图，第二个库先删残留的新数据集再重建，最终 `ready`

#### Scenario: 崩溃后续做
- **WHEN** 一个知识库处于 `rebuilding`、`rebuild_dataset_id` 非空时进程退出，随后重启
- **THEN** 重启后重建器先删除该残留数据集，再从建新数据集开始，最终 `ready`；这一条 `kb.rebuild` 的 actor 为原发起人

### Requirement: 共用开发栈的使用纪律
仓库 SHALL NOT 提交任何 RAGFlow 栈定义（compose 文件、镜像构建或启动脚本）。本仓的 Makefile 目标、脚本与测试 SHALL NOT 执行 `docker compose up` / `down` / `restart`，也不修改 RAGFlow 栈的配置。

需要真实 RAGFlow 的任务与 `make smoke-kb` SHALL 从调用方 shell 环境读 `RAGFLOW_BASE_URL`（任务另读 `RAGFLOW_API_KEY_FILE`），并区分两种停止：
- **私有配置缺失**：变量未设置，或密钥文件不存在。报告 `RAGFlow 私有配置缺失`。
- **栈未就绪**：版本接口不可达，或版本串不是 `v1.0.0-rc2`。报告 `共用 RAGFlow 栈未运行或版本不符`。

两种情况都以非零退出，SHALL NOT 尝试拉起。

在共用栈上的使用规则：
- 只使用 open-workbuddy 专用账号。
- 只删除本仓创建的数据集（名称前缀为 `owb-`）：实测只删本次运行建的；冒烟只经 app-server 删除名为 `smoke-kb` 的知识库（含上一次中断留下的同名库）。

RAGFlow 地址、账号名与密钥文件路径 SHALL 只出现在本机未跟踪的私有配置里；被跟踪的文件、issue 与 PR 正文一律写作 `<RAGFLOW_BASE_URL>`。

#### Scenario: 栈未运行
- **WHEN** `RAGFLOW_BASE_URL` 指向一个已关闭的端口时执行 `make smoke-kb`
- **THEN** 命令在发出任何知识库请求之前以非零退出，输出含 `共用 RAGFlow 栈未运行或版本不符`；执行前后 `docker ps -a` 的容器清单相同
