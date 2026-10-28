# Design: s2a-kb-ragflow

## Context

### 方向变更

ADR-0002（2026-08-29）定的是吸收 RAGFlow v0.27.1 的 Python 线（deepdoc、`rag/app` 模板、`rag/nlp` 检索、agentic 环）进本仓 `kbservice/`，S2a 先做 spike。2026-10-28 grill 由 owner 拍板改为对接运行中的 RAGFlow 服务（见下方「Grill 结论」）。`IMPLEMENTATION_PLAN.md` S2a 一节与 ADR-0002 是本 change 之前的 oracle；本 change 经 owner 拍板改写它们，改写本身是任务组 2 的产物，不是为了让 change 过审而拧的旋钮。

### RAGFlow v1.0.0-rc2 的已知事实（2026-10-28 读 `v1.0.0-rc2` tag 源码与 `docs/references/http_api_reference.md`；第一组任务对运行中的实例逐条复核）

- v1.0 起服务端是 Go 重写（`cmd/ragflow_server.go`、`internal/`），Python `api/` 层不复存在；消息队列换 NATS，缓存换 Kvrocks。rc2 起有 arm64 镜像（`infiniflow/ragflow:v1.0.0-rc2` 多架构；rc1 与 v0.27.x 只有 amd64）。
- `GET /api/v1/system/version`、`/system/healthz` 在无鉴权分组（`internal/router/router.go:153-158`）；数据集、文档、模型提供方等路由在 `AuthMiddleware` 分组（`:238-239`），API key 以 `Authorization: Bearer` 传。
- 业务结果在 body `code`：`0` 成功、`101` 参数非法、`102` 数据无效或缺失、`103` 操作错误、`105` 连接错误、`108` 权限错误、`109` 鉴权错误等；HTTP 200 加非零 `code` 是常态。dsh-team 对 rc1 的实测（检索列表里一个无效库 ID 整次失败、空 `dataset_ids` 为 `101`）与之一致。
- 数据集：`POST /api/v1/datasets`（`name` 不区分大小写、重名自动加后缀、≤128 字符；`embedding_model` 形如 `model@factory`；`chunk_method` 取 `naive`/`book`/`email`/`laws`/`manual`/`one`/`paper`/`picture`/`presentation`/`qa`/`table`/`tag` 十二种；「Migrate to 1.0」一节另说 Go 侧改用 `parser_id`、`naive` 规范为 `general`——文档自相矛盾，须实测）；`PUT /api/v1/datasets/{id}` 改 `embedding_model` 要求 `chunk_count` 为 0；`DELETE /api/v1/datasets`。
- 文档：上传 `POST /api/v1/datasets/{id}/documents`（multipart）、下载、列表、删除、解析 `POST …/documents/parse`、停止解析；列表带解析状态与切片数。
- RAPTOR / 知识图谱在 rc2 归入「knowledge compilation」（`internal/entity/dataset.go:85-86` 的 `PipelineTaskTypeRAPTOR` / `GraphRAG`，`GET /:dataset_id/compilation/status`，`compilation-templates`）；HTTP 参考文档没有写数据集级的开启方式。
- 模型提供方：`/providers/:provider/instances/:instance/models`（增删改查）、`GET` / `PATCH /me/models`（账号缺省模型）。是否接受 API key 鉴权须实测。

### 共用开发栈（dsh-team）

- dsh-team 的 `stage-2-dsh-ragflow-office` change 把 RAGFlow 当外部常驻测试栈：地址与密钥只在 0600 私有配置文件，用例跑完「RAGFlow 测试栈不变」，`docker info` MemTotal ≥14 GiB（`design.md` 决定 13、tasks 10.1–10.3，尚未实施）。其设计实测的是 rc1；owner 已定两边统一到 rc2，由 owner 在 dsh-team 侧推动。
- 本机 Docker 分配 15.6 GiB（`docker info` MemTotal 16747859968），放不下两套 RAGFlow。2026-10-28 本机没有任何 RAGFlow 容器或 compose 项目。

### 主干现状（c24ac7dd）

- `server/src/server.ts` 799 行（上限 800）；`startup-registry.ts` 是为行数预算抽出的阶段函数落点。`STARTUP_MODULES` 十一项、`StartupStage` 十三项（`server.ts:107-119`、`:330-344`）。配置四十二项（`resolveServerConfig`，`server.ts:129-146`）。
- 错误码二十五个（`core/errors/index.ts:6-31`），content-parser 归属身份三十一条（`http/errors.ts`；所有 POST / PUT / PATCH 路由都在集合内，含 bodyless 的 POST）。
- `models` 表只有对话模型，无类型列（`046_models.sql`）；模型上游密钥存 DB（与 0600 的 DB 文件同一信任级别）。仓库没有「密钥从文件读」的配置先例。
- 上传是裸 `application/octet-stream`、文件名走查询参数、`Transform` 计数超限即拒（`workspaces/rest.ts:455-520`、`upload.ts`）；没有 multipart 依赖。
- 读工作空间文件：`sandbox.resolve(principal, workspaceId, path, "read")` → 挂载内走 `mountToRead` / `openMountFile` / `mountRangeStream`（离线 `mount_offline`），挂载外走 `lstatExisting` / `openRegularFile`（`O_NOFOLLOW`）（`workspaces/rest.ts:412`、`rest-archive.ts:108-146`、`mounts/files.ts`、`regular-file.ts:55`）。
- 出站 HTTP 一律 node `http(s).request`、`agent:false`、不跟随重定向，连接 10 s / 总 15 s，错误体经 `readErrorBody` + `upstreamExcerpt`（`models/probe.ts`、`connectors/probe.ts`）。
- 中心 tab 五项（`web/src/features/center/tabs.ts:16-22`），描述 `专家、技能与连接器`（`web/src/routes/manifest.ts:29-37`）。
- `kbservice/` 只有骨架（5 个跟踪文件，`dependencies = []`），引用遍布 Makefile、CI 两个 job、控制面 oracle、size-guard、jscpd、`AGENTS.md`、`constraints.yaml`、`project-profile.md`。
- 迁移最后为 049。

## Grill 结论（2026-10-28，owner 逐分支拍板）

| # | 分支 | 结论 | 落点 |
|---|---|---|---|
| 1 | RAGFlow 角色 | 重议 ADR-0002：知识库以运行中的 RAGFlow 为后端，新 ADR 取代 0002 | D1、组 2 |
| 2 | change 切分 | 一个 change 全包；rc2 接口实测为第一组，后续组依赖它 | tasks 组 1 |
| 3 | 版本 | v1.0.0-rc2 | D4、D5 |
| 4 | 共用栈 | 归 dsh-team；执行时检测，在跑只复用、绝不 up/down/改配置；未在跑或版本不符停下报告、不自起 | D16 |
| 5 | kbservice | 退役，app-server `kb` 模块直连 | D1、组 3 |
| 6 | 租户 | 单一 RAGFlow 服务账号；映射存 SQLite | D2 |
| 7 | 入库路径 | 经 `resolve(read)` 读后上传字节，入库审计 | D10 |
| 8 | 模型配置 | 嵌入模型归注册表（模型 tab 的知识库模型段），app-server 下发到 RAGFlow；rc2 不支持下发时自动退到运维手配 | D7 |
| 9 | RAPTOR / 知识图谱 | S2a 实做；对话模型由注册表指定「知识库用」，未指定则开关不渲染 | D14 |
| 10 | 存储引擎 | 生产 Infinity（经 `DOC_ENGINE`） | ADR-0005 补充 |
| 11 | 部署 | S4b 单机包带 RAGFlow 全栈；门槛与许可义务写进新 ADR | 组 2 |
| 12 | 测试 | CI 打假 RAGFlow；真 RAGFlow 只在本机 smoke 与验收 | D17 |
| 13 | 可用性 | 未配即关（不渲染 tab）；不可达照常启动，端点 503，页面就地提示可重试 | D3、D5 |
| 14 | 状态源 | RAGFlow 为准，按需读；解析中定时刷新；无后台轮询 | D12 |
| 15 | 来源 | 工作空间（含只读挂载）+ 本地上传 | D10、D11 |
| 16 | 上传存放 | 只存 RAGFlow；上限可配（100 MB / 10 个）；移出即删 | D11 |
| 17 | 生命周期 | 入库即快照；记大小/修改时间，列表对比标「源文件已变更」并给重新入库；移出只删 RAGFlow 文档；删库删 dataset | D12、D13 |
| 18 | 可见范围 | S2a 仅所有者，不加 scope 列 | Non-Goals |
| 19 | 嵌入绑定 | 全局唯一；更换经确认后自动全量重建，重建中暂停入库、失败可重试、记审计 | D8 |
| 20 | 重建原件 | 一律用 RAGFlow 内的入库原件 | D8 |
| 21 | 模板 | 建库时固定 | D9 |
| 22 | 开发账号 | 共用栈上自建 open-workbuddy 专用账号与 API key，只在本机私有配置 | D16 |
| 23–25 | 事实核查 | rc2 / Infinity 有 arm64 镜像；DMXAPI 有 `bge-m3`、`qwen3-rerank`；deepdoc 形态问题作废 | Context |

开放项与落点：rc2 接口能力 → 组 1；dsh-team 升 rc2 的时间与其 `DOC_ENGINE` → Open Questions；S2b agentic 环落点 → Non-Goals；规划文档改写 → 组 2。

## Goals / Non-Goals

**Goals**
- 所有者在中心「知识库」tab 建库（12 种模板 + RAPTOR / 知识图谱开关）、从工作空间或本地上传入库、看到解析状态与切片数、移出文档、删库。
- 管理员在模型 tab 配置唯一的知识库嵌入模型与知识库对话模型，并能安全地更换嵌入模型（确认 + 全量重建）。
- RAGFlow 的 API key 只在 app-server 进程内存里；RAGFlow 不感知本系统的用户。
- `kbservice/` 与 Python 工具链从仓库移除，CI 与控制面 oracle 同步。

**Non-Goals**
- 检索、检索测试 tab、重排、agentic 环（S2b；agentic 环放 app-server 还是用 RAGFlow 自带能力由 S2b 定）。
- 会话内知识库引用、`host_tool_call`、附件的知识库语义（S2c）。
- 可见范围四档、共享只读、跨账号检索审计、`scope` 列（S2c）。
- 部署包、RAGFlow 栈的打包与运维脚本（S4b）。
- 拉起、停止或配置 RAGFlow 栈；本仓任何脚本与测试都不执行 `docker compose up` / `down`。
- 标签集模板 `tag` 与其它库的关联（`tag_kb_ids`）：可以建 `tag` 模板的库并入库，不提供把它关联到其它库的入口。
- 源文件变更后的自动同步；知识库内文档的切片浏览与编辑；建库后修改模板或开关。
- RAGFlow 的多用户、团队与 `permission: team`。
- 向 RAGFlow 推送重排模型（S2b）。

## Decisions

### D1 `kb` 模块直连 RAGFlow，`kbservice/` 退役

app-server 新模块 `server/src/kb/`（第十二个启动模块，注册在 `connectors` 之后）持有 RAGFlow 客户端、store 与全部知识库端点。`system.md` §4 依赖规则「`sessions → kb`、`kb → accounts`」不变（S2c 才有 `sessions → kb`）；本 change 新增 `kb → workspaces`（读工作空间文件，经 `workspaces` 已导出的读取函数与 `core/sandbox`）与 `kb → models`（读知识库对话模型的上游）。

备选：保留 `kbservice/` 作薄适配层——多一个进程、一套 Python 工具链和一条跨服务契约，换来的只是把 HTTP 调用挪个地方；S2b 的 agentic 环若需要代码，届时按 S2b 的结论放。

### D2 单一服务账号与映射

整个服务用一个 RAGFlow 账号的 API key。RAGFlow 里的数据集名为 `owb-<知识库 id>`（32 位小写十六进制 id；名称不区分大小写、重名会被 RAGFlow 自动加后缀，用 id 保证唯一且可对账）。用户可见的知识库名只存在 SQLite。RAGFlow 的文档 id 存 `kb_documents.ragflow_document_id`。所有权与可见性（S2a：只有所有者）只在 app-server 判定；别人的知识库 id 一律 `not_found`，不可探测。

### D3 配置与密钥文件

四个键经 pure config seam 解析：

| 键 | 缺省 | 规则 |
|---|---|---|
| `RAGFLOW_BASE_URL` | 未配置（知识库关闭） | `^https?://[^/?#\s]+$`（只有协议与 authority，同 `PREVIEW_ORIGIN` 的写法）；显式 empty 非法 |
| `RAGFLOW_API_KEY_FILE` | 未配置 | 配了 `RAGFLOW_BASE_URL` 时必填，否则必须不设；绝对路径；显式 empty 非法 |
| `KB_UPLOAD_MAX_BYTES` | `104857600` | 与 `UPLOAD_MAX_BYTES` 同一解析纪律（canonical 正整数） |
| `KB_UPLOAD_MAX_FILES` | `10` | 同上 |

新启动阶段 `kb_key`（`config` 之后、`db` 之前，实体函数在 `startup-registry.ts`，`server.ts` 净增 ≤3 行，余量不足时先把一段既有装配挪进 `startup-registry.ts`）：只在配置了地址时读密钥文件——`lstat` 为普通文件（不跟随符号链接）、属主为本进程 uid、`mode & 0o077 === 0`、1–4096 字节、去掉恰一个结尾 `\n` 后非空且能作 HTTP 头值（复用 `assertHeaderSafeKey`）；任一不满足即启动失败，`reason` 为 `kb_key`，错误只点名键，不含路径之外的任何内容与密钥字节。密钥只留在 `kb` 模块的闭包里，不写日志、审计、响应，不进任何子进程环境（omp spawn 环境是白名单，`OMP_CHILD_ENV_NAMES` 不含它）。

为什么用文件而不是环境变量：`MODEL_UPSTREAM_API_KEY` 走环境变量是 S0b 的历史写法；RAGFlow key 一旦泄露即可读写全部账号的知识库，用 0600 文件可以不进 `/proc/<pid>/environ`、不被任何由 app-server 派生的进程继承（owner 2026-10-28 grill 选定）。

不可达不阻断：启动阶段不连 RAGFlow。

### D4 RAGFlow 客户端与结果映射

`kb/ragflow-client.ts` 是唯一出站点：node `http(s).request`、`agent:false`、不跟随重定向（3xx 当失败）、不重试；JSON 调用连接 10 s / 总 30 s，响应体上限 1 MiB（超出即失败）；上传与下载连接 10 s、空闲 60 s（无总期限，体积由 `KB_UPLOAD_MAX_BYTES` 约束）。期限经 `AssemblyDependencies` 注入以便测试。每个请求带 `Authorization: Bearer <key>`，`/system/version` 除外。

结果映射（客户端返回类型化结果，REST 层再映射为错误信封）：

| RAGFlow 结果 | 本系统 |
|---|---|
| HTTP 2xx 且 body `code === 0` | 成功 |
| body `code` 为 `101` 或 `102` | `kb_rejected`（400） |
| HTTP 401 / 403 或 body `code` 为 `108` / `109` | `kb_unavailable`（503），并经受管 stderr writer 写一行 `{"event":"kb_upstream_auth_failed"}`（每进程每分钟至多一行） |
| 其它非零 `code`、非 2xx、非 JSON、超体积、超时、连接失败、3xx | `kb_unavailable`（503） |
| 数据集或文档不存在（实测记录给出的 code / 状态） | 由调用点决定：删除视为已删，读取视为 `丢失` |

RAGFlow 的 message 与响应体不进响应、审计与日志（防止回显密钥或文件内容）。

### D5 `GET /api/kb/status` 与版本钉住

登录用户可调。知识库关闭时返回 `{enabled:false}`；开启时每次调用 `GET <base>/api/v1/system/version`（5 s 总期限、不带 key）：版本串恰为 `v1.0.0-rc2`（实测记录给出的确切字段）才算 `available:true`；版本不符写一行 `{"event":"kb_version_mismatch"}`（每进程每分钟至多一行）并 `available:false`。应答 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`：`embeddingReady` = 已配置嵌入模型；`compileReady` = 已指定知识库对话模型。版本钉住意味着升级 RAGFlow 是一次代码变更（与 omp 钉版同一纪律）。

### D6 迁移 050

`050_knowledge_bases.sql`（头注照 049 的惯例）：

- `kb_settings`：`id TEXT NOT NULL PRIMARY KEY CHECK (id = 'kb')`；`embedding_name`、`embedding_base_url`、`embedding_api_key` 三列同 NULL 或同非 NULL；`embedding_generation INTEGER NOT NULL DEFAULT 0`；`embedding_probe_status`（`never`/`ok`/`failed`）、`embedding_probe_at`、`embedding_probe_message`；`chat_model_id TEXT NULL REFERENCES models(id) ON DELETE SET NULL`；`updated_at`。迁移插入唯一一行（嵌入未配置、代数 0）。
- `knowledge_bases`：`id`（32 位十六进制）、`owner_id REFERENCES accounts(id) ON DELETE RESTRICT`、`name`（1–64 码点、无控制字符）、`template`（十二值 CHECK）、`raptor`、`graph`（0/1）、`dataset_id TEXT NOT NULL`、`rebuild_dataset_id TEXT NULL`、`embedding_generation INTEGER NOT NULL`、`state`（`ready`/`rebuilding`/`rebuild_failed`）、`state_message TEXT NULL`、`created_at`、`updated_at`；`UNIQUE (owner_id, name)`。
- `kb_documents`：`id`、`kb_id REFERENCES knowledge_bases(id) ON DELETE CASCADE`、`ragflow_document_id TEXT NOT NULL`、`name`、`size INTEGER NOT NULL`、`source`（`workspace`/`upload`）、`workspace_id TEXT NULL`（不加外键：工作空间删除后文档是入库快照，照常保留）、`source_path TEXT NULL`、`source_mtime_ms INTEGER NULL`、`created_at`；`source = 'workspace'` 与三列非 NULL 等价的 CHECK；`UNIQUE (kb_id, workspace_id, source_path)`。

上限由 store 在插入前计数：每账号 50 个知识库，每个知识库 500 份文档（超出 `kb_rejected` 不适用——是本系统的上限，用 409 `conflict`）。

### D7 知识库模型与下发

嵌入模型全局唯一，存在 `kb_settings`，不进 `models` 表（`models` 是对话模型白名单的唯一来源，进 `models.yml` 与输入框模型选择；嵌入模型混进去要给每条既有规则加排除）。知识库对话模型是对 `models` 某一行的引用。

`PUT /api/kb/settings`（管理员）body `{embedding?: {name, baseUrl, apiKey?}, chatModelId?: string|null, confirmRebuild?: true}`：保存前先把模型配置下发到 RAGFlow 服务账号（实测记录给出的接口：一个 OpenAI 兼容的 provider instance 承载嵌入模型，知识库对话模型若上游不同则另一个 instance，并把对话模型设为账号缺省以供 knowledge compilation 使用），下发失败按 D4 映射且不改本地设置；下发成功再在同一事务里写设置与 `kb.settings` 审计。

嵌入身份 = `(name, baseUrl)`。身份变化且存在任一知识库时：未带 `confirmRebuild:true` → 409 `kb_rebuild_required`，不下发不保存；带了 → 保存、`embedding_generation + 1`、全部知识库置 `rebuilding`、审计 `kb.rebuild`（detail 含受影响的知识库数与文档数），然后唤醒重建（D8）。任一知识库处于 `rebuilding` 时再改嵌入身份 → 409 `kb_rebuilding`。只改密钥不算身份变化。

**退路（仅当组 1 实测证明 rc2 不能用 API key 下发模型配置时启用，由组 1 的结论决定，不在运行期切换）**：`kb_settings.embedding_*` 不再由管理员填写，改为由运维在 RAGFlow 后台给服务账号配置缺省嵌入模型与缺省对话模型；`GET /api/kb/settings` 从 RAGFlow 读出当前缺省嵌入模型名作只读显示；`embeddingReady` = RAGFlow 账号有缺省嵌入模型；建库时 `embedding_model` 用该名；嵌入身份变化在 `GET /api/kb/settings` 时被发现（与库内记录的身份不同），管理员在模型 tab 点 `重建全部知识库` 并确认后走同一重建流程。启用退路时，组 8 与组 15 的任务按本段改写并在 PR 说明里引用组 1 的结论。

### D8 嵌入模型更换与全量重建

重建在进程内单线程串行执行（一次一个知识库），由 `kb` 模块在 listen 之后启动；启动时对仍是 `rebuilding` 的库从头续做。每个库：

1. 若 `rebuild_dataset_id` 非空，先删它（不存在视为已删）。
2. 按原模板与开关、新嵌入模型建新数据集，写回 `rebuild_dataset_id`。
3. 逐份文档：从旧数据集下载入库原件（流式），以下载应答的 `Content-Length` 上传到新数据集（没有 `Content-Length` 即该库失败），记下新文档 id。
4. 对新数据集的全部文档触发解析。
5. 单事务：各文档换成新 id、`dataset_id = rebuild_dataset_id`、`rebuild_dataset_id = NULL`、`embedding_generation` = 当前代数、`state = ready`。
6. 删旧数据集；失败只写一行 `{"event":"kb_dataset_leak"}`（带数据集 id，不带名称与内容），不影响状态。

任一步失败 → `state = rebuild_failed`、`state_message` 为固定中文句子（不含 RAGFlow 原文），审计 `kb.rebuild`（结果失败）。`POST /api/kb/settings/rebuild`（管理员）把全部 `rebuild_failed` 置回 `rebuilding` 并唤醒。处于 `rebuilding` 或 `rebuild_failed` 的库：入库、重新入库、上传 → 409 `kb_rebuilding`；`rebuilding` 时删库 → 409 `kb_rebuilding`，`rebuild_failed` 时可以删（两份数据集都删）。不等新数据集解析完成就换（S2a 没有检索，文档列表从新数据集读状态）。

### D9 建库与删库

`POST /api/kb/bases` body `{name, template, raptor?, graph?}`：嵌入未就绪 → 409 `kb_not_ready`；`raptor` / `graph` 为真但模板不支持或 `compileReady` 为假 → 400 `bad_request`；同账号重名 → 409 `conflict`。先在 RAGFlow 建数据集（D2 命名、实测记录给出的模板字段与开关字段），成功后插行并审计 `kb.create`；插行失败则删掉刚建的数据集。模板与开关之后不可改（无更新端点）。

`DELETE /api/kb/bases/:id`：先删 RAGFlow 数据集（不存在视为已删；不可达 → 503，行不动），再删行（文档行级联）并审计 `kb.delete`。

模板支持表（取自 demo 的 `kbMethods`）：RAPTOR 只对 `qa`、`manual`、`paper`、`book`、`laws`、`presentation` 可用；知识图谱对 `tag` 之外的十一种可用。

### D10 工作空间来源入库

`POST /api/kb/bases/:id/documents` body `{workspaceId, paths}`，`paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个工作空间内相对路径。逐条顺序处理：`sandbox.resolve(principal, workspaceId, path, "read")`（越界照常 `sandbox.reject` 审计）→ 挂载内用 `mountToRead` + `openMountFile`（离线即该条被拒），挂载外 `lstatExisting` + `openRegularFile`（非普通文件即被拒）→ 大小 ≤ `KB_UPLOAD_MAX_BYTES` → 以 multipart 流式上传到 RAGFlow（`Content-Length` 由前后缀长度加文件大小算出，不落临时文件）→ 插文档行（大小与 `mtimeMs` 取自上传前的那次 stat）→ 本条完成。全部处理完后对本批成功的文档触发一次解析。

应答 201 `{documents: DocumentView[], rejected: {path, message}[]}`；每条被拒写一条 `kb.ingest_reject`（detail `{path, reason}`，`reason` 取固定枚举 `outside`/`not_file`/`too_large`/`offline`/`duplicate`/`rejected`），成功的整批写一条 `kb.ingest`（detail `{workspaceId, count}`）。RAGFlow 不可达时中止本批：已上传的保留、其余条目以 `rejected`（message `知识库服务暂不可用`）返回。

### D11 本地上传

`POST /api/kb/bases/:id/uploads?name=<文件名>`：与 `POST /api/workspaces/:id/uploads` 同一写法（独立 scope、只注册 `application/octet-stream`、文件名规则与 255 字节上限复用 `parseUploadName`），另外要求请求带 `Content-Length`（缺失 400）；`Content-Length > KB_UPLOAD_MAX_BYTES` 先拒 413 `upload_too_large`，流中超限同样拒。请求体直接拼进出站 multipart，不落盘、不留副本。成功 201 返回 `DocumentView`，触发该文档的解析，审计 `kb.ingest`（detail `{source:"upload", name, size}`）；超限审计 `kb.ingest_reject`（`reason: too_large`）。一次最多选 `KB_UPLOAD_MAX_FILES` 个由 web 约束（逐个请求）。

### D12 文档列表、状态与源文件变更

`GET /api/kb/bases/:id/documents`：一次分页读取该数据集在 RAGFlow 的全部文档（每页至多 100，最多 5 页，与 500 上限对应），按 `ragflow_document_id` 关联。`DocumentView = {id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：

- `status` 取 `queued` / `parsing` / `done` / `failed` / `cancelled` / `missing`（实测记录给出 RAGFlow 运行状态到这六值的映射；RAGFlow 列表里没有该 id 即 `missing`）；`message` 只在 `failed` 时为固定句子 `解析失败`；`chunkCount` 只在 `done` 时为数字。
- `sourceChanged`：只对工作空间来源计算——对源路径做一次 `resolve(read)` 加 stat（挂载内经挂载的 stat；离线或越界时为 `null`，即「不知道」），大小或 `mtimeMs` 与入库记录不同、或文件已不存在为 `true`。读不触发审计（`resolve` 只在越界时审计）。

没有后台轮询；web 在有 `queued` / `parsing` 文档且页面可见时每 3 秒重取。

### D13 重新入库、移出与删除

- `POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>`：只对工作空间来源；按 D10 的读取规则重读源文件并上传为新文档、触发解析，成功后单事务换行内的 RAGFlow id、大小与 `mtimeMs`，再删旧的 RAGFlow 文档（失败只写 `{"event":"kb_document_leak"}`）；审计 `kb.ingest`（detail `{reingest: true}`）。源不可读按 D10 的拒绝原因返回 409 `conflict`（不改行）。
- `DELETE /api/kb/bases/:id/documents?doc=<文档 id>`：先删 RAGFlow 文档（不存在视为已删），再删行，审计 `kb.document_delete`；源文件不动。

### D14 RAPTOR 与知识图谱

开关在建库时随数据集配置一起写入（组 1 实测给出 rc2 的确切形状：数据集级字段或 knowledge compilation 模板）。若实测证明它们需要显式触发，则在每次触发解析之后对该数据集触发一次。知识库视图带 `compile: {raptor, graph}`，各取 `off` / `pending` / `running` / `done` / `failed`，从 `GET /api/v1/datasets/{id}/compilation/status`（或实测记录给出的接口）按需读取；读取失败为 `null`。知识库对话模型被删除（`chat_model_id` 置 NULL）后，已开启的库照旧显示开关，新的编译会在 RAGFlow 侧失败并显示 `failed`；`compileReady` 变假，建库表单不再显示开关。

若组 1 证明 rc2 无法用 API key 开启或触发编译，组 1 停在该任务并报告 owner，依赖它的组 12 不开工（与 D7 的退路不同，这一项没有预定退路）。

### D15 审计

| kind | 时机 | detail（不含密钥、文件内容与 RAGFlow 原文） |
|---|---|---|
| `kb.create` | 建库成功 | `{id, template, raptor, graph}` |
| `kb.delete` | 删库成功 | `{id}` |
| `kb.ingest` | 入库 / 上传 / 重新入库成功 | `{id, source, count}` 或 `{id, source:"upload", name, size}` 或 `{id, reingest:true}` |
| `kb.ingest_reject` | 单条被拒 | `{id, path?, name?, reason}` |
| `kb.document_delete` | 移出成功 | `{id, documentId}` |
| `kb.settings` | 保存知识库模型设置 | `{embedding?: name, chatModelId?}` |
| `kb.rebuild` | 确认重建 / 重试 / 单库重建结束 | `{bases, documents}` 或 `{id, result}` |

`kb.rebuild` 的单库结束记录由重建器写，`actorId` 为发起重建的管理员。

### D16 共用开发栈的使用纪律

- 本仓不提交任何 RAGFlow 栈定义，不执行 `docker compose up` / `down` / `restart`，不改栈的配置文件与环境。
- 需要真实 RAGFlow 的任务（组 1、组 16）先检测：`RAGFLOW_BASE_URL` 指向的 `/api/v1/system/version` 可达且恰为 `v1.0.0-rc2`；不满足即停下，在 issue 里报告「共用栈未运行或版本不符」，不自己拉起任何 RAGFlow 容器。
- 在共用栈上只用 open-workbuddy 专用账号（owner 在 RAGFlow 界面注册并生成 API key；地址与 key 文件路径只记在本机 `CLAUDE.local.md`，key 文件 0600 放在仓库之外），因此 dsh-team 的库与模型配置天然隔离；实测与 smoke 只清理自己建的数据集（名称前缀 `owb-`）。

### D17 测试与夹具

- `server/test/support/fake-ragflow.mjs`（+ `.d.mts`）：进程内可起的假 RAGFlow，协议以组 1 的实测记录为准（路径、字段、状态值、错误 code）；可脚本化：版本串、某路由返回指定 code、HTTP 状态、挂起、超时、3xx；记录请求（含是否带 key、multipart 字段与字节数）。
- 单元 / 集成用例全部打假 RAGFlow，真实 RAGFlow 只进 `make smoke-kb`（`smoke/kb.hurl`，变量照 `smoke-live` 的写法：调用方自带已接上真实 RAGFlow 的运行中服务）与验收清单。

### D18 模块划分与行数

`server/src/kb/`：`config.ts`（四键解析）、`key-file.ts`（`kb_key` 阶段的读取与校验）、`ragflow-client.ts`、`multipart.ts`（出站 multipart 的长度计算与流拼接）、`store.ts`、`settings.ts`（设置、下发、身份判定）、`rebuild.ts`、`bases.ts`、`documents.ts`、`uploads.ts`、`rest.ts`（路由与归属身份）、`index.ts`。每文件 ≤800 行；`server.ts` 只加配置展开、`StartupStage` 成员与一次阶段调用，`app.ts` 只加一次注册。

### D19 web

- `web/src/lib/api-kb.ts`：状态、设置、知识库、文档、上传的客户端，全部严格解析（`hasExactlyKeys`）。
- 中心「知识库」tab（`key: "knowledge-bases"`，`adminOnly: false`，排在 `连接器` 之后、`模型` 之前）：只在 `GET /api/kb/status` 为 `enabled:true` 时进入可见 tab 表；描述不变（只连接无条件对所有人可见的 tab）。
- 模型 tab 加「知识库模型」段：嵌入模型（名称、上游地址、密钥、探活）、知识库对话模型（从对话模型里选或 `不使用`）、重建状态与 `重试失败的重建`；更换嵌入模型时先弹确认（写明受影响的知识库数与文档数），确认后带 `confirmRebuild:true` 再保存。

### Sketch seams under test

| Seam | 理由 |
|---|---|
| app-server HTTP 应用（`buildApp` + `app.inject()`，真实 SQLite，接假 RAGFlow） | 知识库端点、权限、审计、错误信封与 RAGFlow 结果映射都在这一层可观察，是 S1d / S1b 已用的最高 seam |
| 编译入口（`server.ts` 子进程） | `kb_key` 阶段、配置错误的启动失败与 `server_started.modules` 只在真实入口可证 |
| 假 RAGFlow HTTP 服务（`fake-ragflow.mjs`） | 出站请求的形状（multipart、key、期限、重定向）由它记录；协议以组 1 的实测为准 |
| web 组件（jsdom + 假 `ApiClient`） | 中心「知识库」tab 与模型 tab 的知识库模型段 |
| `make smoke-kb`（真实 RAGFlow） | 唯一证明对 rc2 的映射成立的 seam；只在本机与验收 |

## Not yet specified

- 大批量入库（一次几十上百个文件、目录整体入库）的交互与限流。S2a 只给逐个选文件、每次至多 `KB_UPLOAD_MAX_FILES` 个。
- RAGFlow 数据集与本地映射长期漂移（RAGFlow 侧被人手工删改）的对账手段。S2a 只在列表时把找不到的文档标 `missing`。

## Risks / Trade-offs

- [rc2 是预发行版，rc3 / GA 可能改接口] → 版本钉住（D5），升级是代码变更，重跑组 1 的实测与 `make smoke-kb`。
- [HTTP 参考文档自相矛盾（`chunk_method` vs `parser_id`；编译开关未写）] → 组 1 以运行实例为准，假 RAGFlow 协议只按实测记录写。
- [共用栈由 dsh-team 所有，可能不在跑、版本不同或被重置] → 只有组 1 与组 16 依赖它，检测不满足就停下报告；CI 不依赖它。
- [RAGFlow key 权限覆盖全部知识库] → key 只在 0600 文件与进程内存；RAGFlow 只在内网，部署要求它不对用户网络暴露（ADR-0016）。omp 的 bash 能直连本机端口，没有 key 也就调不动 RAGFlow 的鉴权接口；`/system/version` 无鉴权，暴露的只有版本串。
- [嵌入模型更换的全量重建耗时长、期间不能入库] → 确认对话写明影响面；失败可重试；可以删失败的库。
- [重建中途进程崩溃] → 启动时从头续做该库，先删残留的新数据集。
- [模型上游密钥下发后存在 RAGFlow 的库里] → 与 ADR-0008「omp 环境零凭证」不冲突（RAGFlow 不是 omp）；ADR-0016 写明。
- [rc2 不能用 API key 下发模型] → D7 的退路，由组 1 结论启用。
- [rc2 不能用 API key 开启编译] → 组 1 停下报告（D14）。

## Migration Plan

- 迁移 050 只建三张表并插入 `kb_settings` 的唯一一行；不改既有表。回退代码时保留迁移文件（账本拒收多出的回执，规则同 049）。
- 部署：未配 `RAGFLOW_BASE_URL` 时行为与本 change 之前一致（知识库 tab 不出现、端点 503 `kb_disabled`）。
- 回滚：去掉两个 RAGFlow 键即关闭知识库；RAGFlow 里的 `owb-` 数据集由运维按需清理。
- `kbservice/` 删除不可由配置回退；需要时从 git 历史恢复。

## Open Questions

- dsh-team 的共用栈何时升到 rc2、用哪个 `DOC_ENGINE`：由 owner 在 dsh-team 侧推动。组 1 在它就绪前不能开工；开发期引擎与生产（Infinity）不同只影响检索（S2b），不影响 S2a 的摄取。
