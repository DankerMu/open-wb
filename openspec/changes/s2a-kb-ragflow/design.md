# Design: s2a-kb-ragflow

## Context

### 方向变更

ADR-0002（2026-08-29）定的是吸收 RAGFlow v0.27.1 的 Python 线（deepdoc、`rag/app` 模板、`rag/nlp` 检索、agentic 环）进本仓 `kbservice/`，S2a 先做 spike。2026-10-28 grill 由 owner 拍板改为对接运行中的 RAGFlow 服务（见下方「Grill 结论」）。`IMPLEMENTATION_PLAN.md` S2a 一节与 ADR-0002 是本 change 之前的 oracle；本 change 经 owner 拍板改写它们，改写本身是任务组 2 的产物，不是为了让 change 过审而拧的旋钮。

### RAGFlow v1.0.0-rc2 的已知事实（2026-10-28 读 `v1.0.0-rc2` tag 源码与 `docs/references/http_api_reference.md`；第一组任务对运行中的实例逐条复核）

- v1.0 起服务端是 Go 重写（`cmd/ragflow_server.go`、`internal/`），Python `api/` 层不复存在；消息队列换 NATS，缓存换 Kvrocks。rc2 起有 arm64 镜像（`infiniflow/ragflow:v1.0.0-rc2` 多架构；rc1 与 v0.27.x 只有 amd64）。
- `GET /api/v1/system/version`、`/system/healthz` 在无鉴权分组（`internal/router/router.go:153-158`）；数据集、文档、模型提供方等路由在 `AuthMiddleware` 分组（`:238-239`），API key 以 `Authorization: Bearer` 传。
- 业务结果在 body `code`：`0` 成功、`101` 参数非法、`102` 数据无效或缺失、`103` 操作错误、`105` 连接错误、`108` 权限错误、`109` 鉴权错误等；HTTP 200 加非零 `code` 是常态。dsh-team 对 rc1 的实测（检索列表里一个无效库 ID 整次失败、空 `dataset_ids` 为 `101`）与之一致。
- 数据集：`POST /api/v1/datasets`（`name` 不区分大小写、≤128 字符，文档称重名自动加后缀——未实测，本 change 的命名不依赖它；`embedding_model` 形如 `model@factory`；`chunk_method` 取 `naive`/`book`/`email`/`laws`/`manual`/`one`/`paper`/`picture`/`presentation`/`qa`/`table`/`tag` 十二种；「Migrate to 1.0」一节另说 Go 侧改用 `parser_id`、`naive` 规范为 `general`——文档自相矛盾，须实测）；`PUT /api/v1/datasets/{id}` 改 `embedding_model` 要求 `chunk_count` 为 0；`DELETE /api/v1/datasets`。
- 文档：上传 `POST /api/v1/datasets/{id}/documents`（multipart）、下载、列表、删除、解析 `POST …/documents/parse`、停止解析；列表带解析状态与切片数。
- RAPTOR / 知识图谱在 rc2 归入「knowledge compilation」（`internal/entity/dataset.go:85-86` 的 `PipelineTaskTypeRAPTOR` / `GraphRAG`，`GET /:dataset_id/compilation/status`，`compilation-templates`）；HTTP 参考文档没有写数据集级的开启方式。
- 模型提供方：`/providers/:provider/instances/:instance/models`（增删改查）、`GET` / `PATCH /me/models`（账号缺省模型）。是否接受 API key 鉴权须实测。

### 共用开发栈（dsh-team）

- dsh-team 的 `stage-2-dsh-ragflow-office` change 把 RAGFlow 当外部常驻测试栈：地址与密钥只在 0600 私有配置文件，用例跑完「RAGFlow 测试栈不变」，`docker info` MemTotal ≥14 GiB（`design.md` 决定 13、tasks 10.1–10.3，尚未实施）。其设计实测的是 rc1；owner 已定两边统一到 rc2，由 owner 在 dsh-team 侧推动。
- 本机 Docker 分配 15.6 GiB（`docker info` MemTotal 16747859968），放不下两套 RAGFlow。2026-10-28 本机没有任何 RAGFlow 容器或 compose 项目。

### 主干现状（c24ac7dd）

- `server/src/server.ts` 799 行（上限 800；`size-guard.sh` 同样扫描 `server/test`，`server-assembly.test.ts` 与 `omp-process.test.ts` 各 798 行）；`startup-registry.ts` 是为行数预算抽出的阶段函数落点。`STARTUP_MODULES` 十一项、`StartupStage` 十三项（`server.ts:107-119`、`:330-344`）。配置四十二项（`resolveServerConfig`，`server.ts:129-146`）。
- 错误码二十五个（`core/errors/index.ts:6-31`；409 九个，其中 `conflict` 的文案是 `同名资源已存在`、`model_in_use` 的文案专指缺省模型），content-parser 归属身份三十一条（`http/errors.ts`；所有 POST / PUT / PATCH 路由都在集合内，含 bodyless 的 POST）。
- `models` 表只有对话模型，无类型列（`046_models.sql`）；模型上游密钥存 DB（与 0600 的 DB 文件同一信任级别）。仓库没有「密钥从文件读」的配置先例。
- 上传是裸 `application/octet-stream`、文件名走查询参数、`Transform` 计数超限即拒（`workspaces/rest.ts:455-520`、`upload.ts`）；没有 multipart 依赖。
- 读工作空间文件：`sandbox.resolve(principal, workspaceId, path, "read")` → 挂载内走 `mountToRead` / `openMountFile` / `mountRangeStream`（离线 `mount_offline`），挂载外走 `lstatExisting` / `openRegularFile`（`O_NOFOLLOW`）（`workspaces/rest.ts:412`、`rest-archive.ts:108-146`、`mounts/files.ts`、`regular-file.ts:55`）。
- 出站 HTTP 一律 node `http(s).request`、`agent:false`、不跟随重定向，连接 10 s / 总 15 s，错误体经 `readErrorBody` + `upstreamExcerpt`（`models/probe.ts`、`connectors/probe.ts`）。
- `assertHeaderSafeKey`（`agent-config.ts:237`）与 `parseUploadName`（`workspaces/rest.ts:160`）都是模块内私有函数，复用要先经模块入口导出。
- `audit_events.actor_id` 为 `NOT NULL` 且外键指向 `accounts`（`030_audit_events.sql:8,13,15`）。
- 中心 tab 五项（`web/src/features/center/tabs.ts:16-22`），描述 `专家、技能与连接器`（`web/src/routes/manifest.ts:29-37`）。
- `kbservice/` 只有骨架（5 个跟踪文件，`dependencies = []`），引用遍布 Makefile、CI 两个 job、控制面 oracle、size-guard、jscpd、`AGENTS.md`、`constraints.yaml`、`project-profile.md`。
- 迁移最后为 049。

## Grill 结论（2026-10-28，owner 逐分支拍板；#26–#29 为 Stage 4 补问）

「结论」列为 grill 账本原文；Stage 4 的细化写在「落点」列。

| # | 分支 | 结论 | 落点 |
|---|---|---|---|
| 1 | RAGFlow 角色 | 重议 ADR-0002：知识库以运行中的 RAGFlow 为后端，新 ADR 取代 0002 | D1、组 2 |
| 2 | change 切分 | 一个 change 全包；rc2 接口实测为第一组，后续组依赖它 | tasks 组 1 |
| 3 | 版本 | v1.0.0-rc2 | D4、D5 |
| 4 | 共用栈 | 栈归 dsh-team；我方任务执行时检测 docker compose ls + 版本接口=rc2；在跑只复用、绝不 up/down/改配置；未在跑或版本不符停下报告、不自起 | D16。细化（agent 判断，待 owner 复核）：`docker compose ls` 作为只读观察，放在需要真实栈的 agent 任务里（组 1、组 18），不进 `make smoke-kb`——该目标可能指向远端栈，本机未必有 docker；放行判据只有版本接口 |
| 5 | kbservice | 退役，app-server `kb` 模块直连 | D1、组 3 |
| 6 | 租户 | 单一 RAGFlow 服务账号；映射存 SQLite | D2 |
| 7 | 入库路径 | 经 `resolve(read)` 读后上传字节，入库审计 | D10 |
| 8 | 模型配置 | 注册表增嵌入类型，app-server 下发到 RAGFlow 服务账号；rc2 不支持下发时自动退到运维手配，app-server 只探活与显示 | D7。前半按 #26 细化，后半按 #27 细化 |
| 9 | RAPTOR / 知识图谱 | S2a 实做；对话模型由注册表指定「知识库用」，未指定则开关不渲染 | D14；生命周期见 #28 |
| 10 | 存储引擎 | 生产 Infinity（经 `DOC_ENGINE`） | ADR-0005 补充 |
| 11 | 部署 | S4b 单机包带 RAGFlow 全栈；门槛与许可义务写进新 ADR | 组 2 |
| 12 | 测试 | CI 打假 RAGFlow；真 RAGFlow 只在本机 smoke 与验收 | D17 |
| 13 | 可用性 | 未配即关（不渲染 tab）；不可达照常启动，端点 503，页面就地提示可重试 | D3、D5。细化（agent 判断，待 owner 复核）：知识库列表只读本地行，RAGFlow 不可达时仍为 200（编译状态为 `null`），其余要访问 RAGFlow 的端点 503；可用性信号以 `GET /api/kb/status` 为准 |
| 14 | 状态源 | RAGFlow 为准，按需读；解析中定时刷新；无后台轮询 | D12 |
| 15 | 来源 | 工作空间（含只读挂载）+ 本地上传 | D10、D11 |
| 16 | 上传存放 | 只存 RAGFlow；上限可配（100 MB / 10 个）；移出即删 | D11 |
| 17 | 生命周期 | 入库即快照；记大小/修改时间，列表对比标「源文件已变更」并给重新入库；移出只删 RAGFlow 文档；删库删 dataset | D12、D13 |
| 18 | 可见范围 | S2a 仅所有者，不加 scope 列 | Non-Goals |
| 19 | 嵌入绑定 | 全局唯一；更换经确认后自动全量重建，重建中暂停入库、失败可重试、记审计 | D8 |
| 20 | 重建原件 | 一律用 RAGFlow 内的入库原件 | D8；原件缺失见 #29 |
| 21 | 模板 | 建库时固定 | D9 |
| 22 | 开发账号 | 共用栈上自建 open-workbuddy 专用账号与 API key，只在本机私有配置 | D16 |
| 23–25 | 事实核查 | rc2 / Infinity 有 arm64 镜像；DMXAPI 有 `bge-m3`、`qwen3-rerank`；deepdoc 形态问题作废 | Context |
| 26 | 嵌入模型存放 | 嵌入模型存 `kb_settings`，不进 `models` 表；管理入口仍在模型 tab 的「知识库模型」段 | D7 |
| 27 | 手配退路的落地方式 | spec 只写下发主路径；退路作为 design 应急预案（含只探活）。组 1 实测「不支持」时，先按预案修订本 change 的 spec 并重过审核，再放行依赖它的组；「自动」解读为预案已定、不再问 owner | D7「应急预案」 |
| 28 | 知识库对话模型生命周期 | 引用 `models` 行并联动：被指定时不能删（409）；改其上游或密钥时同步重新下发，下发失败则该次修改失败 | D7、model-registry「模型管理端点」 |
| 29 | 重建遇原件缺失 | 跳过并移除该文档行，记入 `kb.rebuild` 的 `skipped`；`rebuild_failed` 下也允许移出文档 | D8、D13 |

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
- 源文件变更后的自动同步；知识库内文档的切片浏览与编辑；建库后修改模板或开关；对本地上传文档的重新解析入口（失败或未解析的上传文档只能移出后重传）。
- RAGFlow 的多用户、团队与 `permission: team`。
- 向 RAGFlow 推送重排模型（S2b）。

## Decisions

### D1 `kb` 模块直连 RAGFlow，`kbservice/` 退役

app-server 新模块 `server/src/kb/` 是第十二个启动模块，注册在 `connectors` 之后，持有 RAGFlow 客户端、store、两种锁（D20）与全部知识库端点。

依赖规则：
- `system.md` §4 的「`sessions → kb`、`kb → accounts`」不变（`sessions → kb` 到 S2c 才有）。
- 本 change 新增 `kb → workspaces`（读工作空间文件，经 `workspaces` 入口导出的读取函数与 `core/sandbox`）与 `kb → models`（读知识库对话模型的上游）。
- `models` 不依赖 `kb`。#28 的联动走反向注入：`AssemblyDependencies` 里有一个可选的 `modelWriteGuard` 钩子，`kb` 注册时把它交给 `models`；`models` 在删除与改上游之前调用它。知识库关闭时钩子为空，`models` 的行为与本 change 之前一致。

备选：保留 `kbservice/` 作薄适配层——多一个进程、一套 Python 工具链和一条跨服务契约，换来的只是把 HTTP 调用挪个地方；S2b 的 agentic 环若需要代码，届时按 S2b 的结论放。

### D2 单一服务账号与映射

- 整个服务用一个 RAGFlow 账号的 API key。
- RAGFlow 里的数据集名为 `owb-<知识库 id>-g<嵌入代数>`（id 为 32 位小写十六进制）。建库时代数为当时的 `embedding_generation`，重建时为新代数。所以同一知识库的新旧两份数据集名字不同，不依赖 RAGFlow 对重名的处理，也能从名字对账。
- 用户可见的知识库名只存在 SQLite；RAGFlow 的文档 id 存 `kb_documents.ragflow_document_id`。
- 所有权与可见性（S2a 只有所有者）只在 app-server 判定；别人的知识库 id 一律 `not_found`，不可探测。

### D3 配置与密钥文件

四个键经 pure config seam 解析：

| 键 | 缺省 | 规则 |
|---|---|---|
| `RAGFLOW_BASE_URL` | 未配置（知识库关闭） | `^https?://[^/?#\s]+$`（只有协议与 authority，同 `PREVIEW_ORIGIN` 的写法）；显式 empty 非法 |
| `RAGFLOW_API_KEY_FILE` | 未配置 | 配了 `RAGFLOW_BASE_URL` 时必填，否则必须不设；绝对路径；显式 empty 非法 |
| `KB_UPLOAD_MAX_BYTES` | `104857600` | 与 `UPLOAD_MAX_BYTES` 同一解析纪律（canonical 正整数） |
| `KB_UPLOAD_MAX_FILES` | `10` | 同上 |

新启动阶段 `kb_key` 位于 `config` 之后、`db` 之前，实体函数在 `startup-registry.ts`（行数预算见 D18）。它只在配置了地址时读密钥文件，读法：
- 以 `O_NOFOLLOW` 打开，对同一 fd 做 `fstat` 并从该 fd 读取，写法同 `regular-file.ts` 的 `openRegularFile`。
- 校验：普通文件；属主为本进程 uid；`mode & 0o077 === 0`；1–4096 字节；去掉恰一个结尾 `\n` 后非空，且能作 HTTP 头值（复用 `assertHeaderSafeKey`，由 `agent-config.ts` 导出）。
- 任一不满足即启动失败，`reason` 为 `kb_key`；错误只点名键，不含密钥字节与文件内容。

密钥只留在 `kb` 模块的闭包里：不写日志、审计、响应，不进任何子进程环境（omp spawn 环境是白名单，`OMP_CHILD_ENV_NAMES` 不含它）。

为什么用文件而不是环境变量：`MODEL_UPSTREAM_API_KEY` 走环境变量是 S0b 的历史写法。RAGFlow key 一旦泄露，就能读写全部账号的知识库；用 0600 文件，密钥值不进 `/proc/<pid>/environ`，也不会被 app-server 派生的进程继承（owner 2026-10-28 grill 选定）。文件**路径**仍在环境里：同 uid 部署（`OMP_USER` 未配置）时，omp 能读到路径并以同 uid 读文件。这与 S0b 已登记的同 uid 风险是同一项，按 ADR-0010 的专用 uid 部署关闭。

不可达不阻断：启动阶段不连 RAGFlow。

### D4 RAGFlow 客户端与结果映射

`kb/ragflow-client.ts` 是唯一出站点：
- node `http(s).request`，`agent:false`，不跟随重定向（3xx 当失败），不重试。
- JSON 调用：连接 10 s，总 30 s，响应体上限 1 MiB（超出即失败）。
- 上传与下载：连接 10 s，空闲 60 s，没有总期限（体积由 `KB_UPLOAD_MAX_BYTES` 约束）。
- 期限经 `AssemblyDependencies` 注入，便于测试。
- 每个请求带 `Authorization: Bearer <key>`，`/system/version` 除外。

客户端返回类型化结果，REST 层再映射为错误信封。按次序判定：

| RAGFlow 结果 | 本系统 |
|---|---|
| 实测记录给出的「不存在」组合（HTTP 状态加 code，可能与 `102` 重叠，所以先判） | 类型化 `not_found` 结果，由调用点决定：删除视为已删；读文档视为 `missing`；读数据集视为该库数据集丢失 |
| HTTP 2xx 且 body `code === 0` | 成功 |
| body `code` 为 `101` 或 `102` | `kb_rejected`（400） |
| HTTP 401 / 403，或 body `code` 为 `108` / `109` | `kb_unavailable`（503），并经受管 stderr writer 写一行 `{"event":"kb_upstream_auth_failed"}`（每进程每分钟至多一行） |
| 其它非零 `code`、非 2xx、非 JSON、超体积、超时、连接失败、3xx | `kb_unavailable`（503） |

RAGFlow 的 message 与响应体不进响应、审计与日志，防止回显密钥或文件内容。

### D5 `GET /api/kb/status` 与版本钉住

登录用户可调。
- 知识库关闭时返回 `{enabled:false}`。
- 开启时每次调用 `GET <base>/api/v1/system/version`（5 s 总期限，不带 key）。版本串恰为 `v1.0.0-rc2`（实测记录给出确切字段）才算 `available:true`。版本不符时写一行 `{"event":"kb_version_mismatch"}`（每进程每分钟至多一行），并为 `available:false`。
- 应答 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`：`embeddingReady` 为已配置嵌入模型，`compileReady` 为已指定知识库对话模型。

版本钉住意味着升级 RAGFlow 是一次代码变更，与 omp 钉版同一纪律。它只决定 `available`；其它端点不因版本不符而拒绝，web 在 `available:false` 时不渲染知识库控件。

### D6 迁移 050

`050_knowledge_bases.sql`，头注照 049 的惯例。三张表的列见 knowledge-bases「迁移 050 知识库 schema」，要点：
- `kb_settings` 只有一行；`rebuild_actor_id` 记最近一次发起或重试重建的管理员，供重建器续做时写审计（`audit_events.actor_id NOT NULL`）。
- `chat_model_id … ON DELETE SET NULL`：知识库开启时，删除被引用的模型已在端点层以 409 `kb_model_in_use` 拦住（D7）。外键置空只在知识库关闭时生效。
- `kb_documents.workspace_id` 不加外键：工作空间删除后，文档是入库快照，照常保留。

上限：
- 每账号 50 个知识库，第 51 个 409 `kb_limit`。
- 每个知识库 500 份文档：工作空间入库逐条以 `reason: limit` 拒绝，本地上传 409 `kb_limit`。
- 计数在该库的写锁下、插行之前做（D20）。所以上限是硬的，文档列表的 5 页 × 100 足够读全。

### D7 知识库模型与下发

**存放（#26）**：嵌入模型全局唯一，存在 `kb_settings`，不进 `models` 表。`models` 是对话模型白名单的唯一来源，进 `models.yml` 与输入框的模型选择；嵌入模型混进去，要给每条既有规则加排除。知识库对话模型是对 `models` 某一行的引用，只能选带上游的行。

**保存**：`PUT /api/kb/settings`（管理员）的 body 为 `{embedding?: {name, baseUrl, apiKey?}, chatModelId?: string|null, confirmRebuild?: true}`，在进程级设置锁（D20）下执行：
1. 先把模型配置下发到 RAGFlow 服务账号，接口以实测记录为准：一个 OpenAI 兼容的 provider instance 承载嵌入模型；知识库对话模型若上游不同，则另一个 instance，并把对话模型设为账号缺省，供 knowledge compilation 使用。`chatModelId` 改为 `null` 时，撤销对话模型的下发。
2. 下发失败：按 D4 映射，不改本地设置。
3. 下发成功：在同一事务里写设置与 `kb.settings` 审计。

三个设置端点的成功应答都是 200 加设置读视图（ragflow-backend「知识库模型设置」）。

**嵌入身份**为 `(name, baseUrl)`，只改密钥不算身份变化。身份变化且存在任一知识库时：
- 未带 `confirmRebuild:true`：409 `kb_rebuild_required`，不下发，不保存。
- 带了：保存；`embedding_generation + 1`；全部知识库置 `rebuilding`；写 `rebuild_actor_id`；审计 `kb.rebuild`；唤醒重建（D8）。
- 任一知识库处于 `rebuilding` 时再改嵌入身份：409 `kb_rebuilding`。

**与 models 的联动（#28）**：知识库开启且某行是知识库对话模型时，`models` 经 D1 的钩子请 `kb` 判定：
- `DELETE` 该行，或 `PUT` 把它的 `upstream` 置为 `null`：409 `kb_model_in_use`（新码；`model_in_use` 的文案专指缺省模型，不改它）。
- `PUT` 且 `upstreamChanged` 为真：在设置锁下先把新上游重新下发到 RAGFlow，成功后 `models` 才写库；失败则该次 `PUT` 按 D4 映射失败，行、审计与 `models.yml` 都不变。

这样，删除或轮换上游后，RAGFlow 侧不会残留已作废的凭证。

**应急预案：rc2 不能用 API key 下发模型（#27）**

本段不进 spec。组 1 的实测记录若在「模型下发」一节结论为「不支持」：
1. 组 1 照常合入记录，并在 Epic 下报告。
2. 由 owner 授权，按本预案修订本 change 的 spec delta，重过 Stage 3–4.5。
3. 修订过审之前，组 6 及其后全部任务组（组 7 除外）不开工。不再就「是否启用退路」询问 owner。

预案内容，即修订时要改的地方：
- **嵌入模型来源**：由运维在 RAGFlow 后台给服务账号配置缺省嵌入模型与缺省对话模型；`PUT /api/kb/settings` 不再接受 `embedding`，也不再下发对话模型（`chatModelId` 只作 `compileReady` 的开关）。
- **读视图**：`embedding` 变为 `{name, baseUrl:null, probe}`，`name` 从 RAGFlow 账号的缺省嵌入模型读出；视图加 `rebuildNeeded`。
- **探活（「只探活与显示」）**：`POST /api/kb/settings/probe` 改为经 RAGFlow 读账号缺省模型并确认其存在，结果写回 `probe`。
- **状态端点**：`embeddingReady` 改为「RAGFlow 账号有缺省嵌入模型」。
- **嵌入身份**：迁移 051 给 `knowledge_bases` 加 `embedding_name`，建库时记下当时的缺省名。任一库的记录与当前缺省不同，即 `rebuildNeeded:true`。
- **重建入口**：管理员在模型 tab 点 `重建全部知识库` 并确认后，走 D8 的流程。重建路由不再 bodyless，要么改为带 `{confirm:true}`，要么另开路由；http-service-skeleton 的归属集同步。
- **web**：model-registry「模型 tab」加上述只读显示与重建按钮的变体。

### D8 嵌入模型更换与全量重建

重建在进程内单线程串行执行，一次一个知识库，处理期间持有该库的写锁（D20）。重建器由 `kb` 模块在 `server_started` 之后不等待地启动；启动时，对仍是 `rebuilding` 的库从第一步续做。每个库的步骤：
1. 若 `rebuild_dataset_id` 非空，先删它；不存在视为已删。
2. 按原模板与开关、新嵌入模型建新数据集 `owb-<id>-g<新代数>`，写回 `rebuild_dataset_id`。
3. 逐份文档，从旧数据集流式下载入库原件，上传到新数据集，记下新文档 id：
   - multipart 长度按本地 `kb_documents.size` 计算。rc2 的下载 handler 以 gin `c.Data` 应答（`internal/handler/document.go:1179-1222`），大于 2 KiB 的文件很可能走分块传输，所以不依赖 `Content-Length`。
   - 下载为 not-found：该文档记为跳过（#29）。
   - 实际字节数与 `size` 不符：该库失败。
4. 对新数据集的全部文档触发解析；按 D14 需要时再触发编译。
5. 单事务切换：删除被跳过的行；其余行换成新 id；`dataset_id = rebuild_dataset_id`；`rebuild_dataset_id = NULL`；`embedding_generation` 设为当前代数；`state = ready`；审计 `kb.rebuild {id, result:"ok", skipped}`。
6. 删旧数据集。删除失败只写一行 `{"event":"kb_dataset_leak","datasetId":<id>}`，不带名称与内容，不影响状态。

任一步失败：`state = rebuild_failed`，`state_message` 为 `重建失败，可在模型设置里重试`（不含 RAGFlow 原文），审计 `kb.rebuild {id, result:"failed"}`。重建器写的审计，actor 一律取 `kb_settings.rebuild_actor_id`。

`POST /api/kb/settings/rebuild`（管理员，bodyless）把全部 `rebuild_failed` 置回 `rebuilding`，`rebuild_actor_id` 改为本次请求者，审计后唤醒，返回 200 读视图。

处于 `rebuilding` 或 `rebuild_failed` 的库，各操作的处理：
- 入库、重新入库、上传：409 `kb_rebuilding`。
- 移出：`rebuilding` 时 409；`rebuild_failed` 时允许（#29），它删的是 `dataset_id` 里的文档；`rebuild_dataset_id` 里的副本由重试的第 1 步整体删掉。
- 删库：`rebuilding` 时 409 `kb_rebuilding`；`rebuild_failed` 时可以删，两份数据集都删。

不等新数据集解析完成就切换：S2a 没有检索，文档列表从新数据集读状态。

### D9 建库与删库

`POST /api/kb/bases` 的校验次序与应答见 knowledge-bases「知识库端点」。
- 建库在设置锁下进行，以免与嵌入更换交错，建出代数过期的库。
- 先在 RAGFlow 建数据集，模板字段与开关字段以实测记录为准；成功后插行，并在同一事务里审计 `kb.create`。插行失败则删掉刚建的数据集。
- 建库超时但 RAGFlow 侧实际已建成，或数据集建好后进程崩溃：会留下无法自动对账的孤儿，归「Not yet specified」的长期对账。
- 模板与开关之后不可改（无更新端点）。

`DELETE /api/kb/bases/:id`：在该库的写锁下，先删 RAGFlow 数据集（不存在视为已删；不可达 503，行不动），再删行（文档行级联），并审计 `kb.delete`。

模板支持表：RAPTOR 只对 `qa`、`manual`、`paper`、`book`、`laws`、`presentation` 可用，取自 demo 的 `kbMethods`（`resource/workbuddy-live-demo.html:1473-1486`，demo 只有 `raptor` 标志）。知识图谱对 `tag` 之外的十一种可用，这一条没有 demo 出处，由组 1 实测逐模板核对。两张表与实测不符时，先修订本 change。

列表只读本地行；开了开关的库，编译状态读取并发发出，共用一个 5 s 总期限，读不到为 `null`（grill #13 的细化）。

### D10 工作空间来源入库

`POST /api/kb/bases/:id/documents` 的 body 为 `{workspaceId, paths}`，`paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个工作空间内相对路径。`workspaceId` 不可见时，整个请求 404，不发出站请求。

在该库的写锁下逐条顺序处理，每条依次：
1. `sandbox.resolve(principal, workspaceId, path, "read")`。被拒为 `outside`，facade 照常写 `sandbox.reject`。路径上任一分量是符号链接时 `resolve` 也拒绝，所以同样归 `outside`。
2. 查重（`duplicate`）与 500 上限（`limit`）。
3. 打开：挂载内用 `mountToRead` + `openMountFile`，离线即 `offline`；挂载外用 `lstatExisting` + `openRegularFile`，非普通文件即 `not_file`。之后对同一 fd 做 `fstat`，取 `size` 与 `mtimeMs`。
4. 大小不超过 `KB_UPLOAD_MAX_BYTES`，超出为 `too_large`。
5. 以 multipart 流式上传。`Content-Length` 由前后缀长度加 `fstat` 大小算出，不落临时文件。流里加计数 `Transform`，读出字节与 `size` 不等时立即中止该条的出站请求，删除 RAGFlow 上的半成品，记为 `changed`。这不当作 RAGFlow 不可达处理。
6. 触发该文档的解析，按 D14 需要时再触发编译。
7. 在同一事务里插行与 `kb.ingest`。

逐条触发解析而不是整批一次：这样「上传成功、解析未触发」只会出现在单条上，可以按条回滚，不会留下永远不解析的文档。

RAGFlow 的失败：
- 某条得到 `kb_rejected`：删除已建的文档，该条记为 `rejected`，继续下一条。
- 得到 `kb_unavailable`：删除已建的文档（尽力而为），该条与其后全部记为 `unavailable`，不再发请求。

应答 201 `{documents, rejected: {path, reason, message}[]}`，`message` 按 `reason` 固定（knowledge-bases「工作空间来源入库」的表）。审计为每份成功文档一条 `kb.ingest`、每个被拒条目一条 `kb.ingest_reject`；detail 形状以 knowledge-bases「知识库审计」为准。

读取链路的 stat 与打开函数由本组在 `kb/source-file.ts` 实现，组 11 的 `sourceChanged` 与组 13 的重新入库复用它（D18）。

### D11 本地上传

`POST /api/kb/bases/:id/uploads?name=<文件名>` 与 `POST /api/workspaces/:id/uploads` 同一写法：独立 scope，只注册 `application/octet-stream`，文件名规则与 255 字节上限复用 `parseUploadName`（由 `workspaces` 入口导出）。

规则：
- 必须带 `Content-Length`，缺失或分块传输即 400。在 Content-Length 分帧下，「流中多于声明」到不了 handler，所以只在入口判一次：`Content-Length > KB_UPLOAD_MAX_BYTES` 即 413 `upload_too_large`。
- 请求体直接拼进出站 multipart，不落盘，不留副本。
- 客户端中途断开或短体：中止出站，删除 RAGFlow 上的半成品，不插行，不审计 `kb.ingest`。
- 上传成功后触发该文档的解析（按 D14 需要时再触发编译）。解析触发失败则删除文档并按 D4 返回。
- 都成功后，单事务插行并审计 `kb.ingest`，应答 201 `DocumentView`。
- 被拒（超限、上限）时审计 `kb.ingest_reject`。

一次最多选 `KB_UPLOAD_MAX_FILES` 个，由 web 约束（逐个请求）。

### D12 文档列表、状态与源文件变更

`GET /api/kb/bases/:id/documents` 应答 200 `{documents}`。一次分页读取该数据集在 RAGFlow 的全部文档（每页至多 100，最多 5 页，与硬上限 500 对应），按 `ragflow_document_id` 关联。数据集为 not-found 时，全部为 `missing`。

`DocumentView = {id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：
- `status` 取 `queued` / `parsing` / `done` / `failed` / `cancelled` / `unparsed` / `missing`。实测记录给出 RAGFlow 运行状态到前六值的映射：未开始为 `unparsed`，不触发 web 刷新；RAGFlow 列表里没有该 id 即 `missing`。
- `message` 只在 `failed` 时为固定句子 `解析失败`；`chunkCount` 只在 `done` 时为数字。
- `sourceChanged` 只对工作空间来源计算：
  - 用 `rootOf` 加 core 的纯函数 `resolve(root, rel, "read")`，即**无审计**版本，再 stat；挂载内经挂载的 stat。
  - 解析被拒、工作空间不可见、离线时为 `null`，即「不知道」；大小或 `mtimeMs` 与入库记录不同、或文件已不存在为 `true`。
  - 这样，源路径被换成符号链接后，每 3 秒一次的刷新也不会写 `sandbox.reject`。

没有后台轮询；web 在有 `queued` / `parsing` 文档且页面可见时每 3 秒重取。

### D13 重新入库、移出与删除

**重新入库**：`POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>`，只对工作空间来源，在该库的写锁下进行。
1. 按 D10 的读取规则重读源文件。读取被拒（含工作空间已不可见）即 409 `kb_source_unreadable`（新码，`conflict` 的文案是「同名资源已存在」，不适用），行不变。
2. 上传为新文档，触发解析（按 D14 需要时再触发编译）。失败则删除新文档并按 D4 返回。
3. 成功后，单事务换行内的 RAGFlow id、大小与 `mtimeMs`，并审计 `kb.ingest`。
4. 再删旧的 RAGFlow 文档；失败只写 `{"event":"kb_document_leak","documentId":<id>}`。

应答 200 `DocumentView`。

**移出**：`DELETE /api/kb/bases/:id/documents?doc=<文档 id>`，在该库的写锁下进行，`ready` 与 `rebuild_failed` 时允许。先删 RAGFlow 文档（不存在视为已删），再删行，并审计 `kb.document_delete`，应答 204；源文件不动。

### D14 RAPTOR 与知识图谱

开关在建库时随数据集配置一起写入；rc2 的确切形状（数据集级字段或 knowledge compilation 模板）由组 1 实测给出。若实测证明需要显式触发，则在**每一个**触发解析的地方，即工作空间入库、本地上传、重新入库与重建第 4 步，对开了 RAPTOR 或知识图谱的库再触发一次编译。

知识库视图带 `compile: {raptor, graph}`，各取 `off` / `pending` / `running` / `done` / `failed`，从实测记录给出的编译状态接口按需读取，读取失败为 `null`。

知识库对话模型被指定期间，不能删除，也不能清空它的上游（D7 #28）。它的上游一改，就同步重新下发，所以 RAGFlow 侧的编译始终用注册表里的当前凭证。管理员把 `chatModelId` 改为 `null` 时，RAGFlow 侧的对话模型配置被撤销：已开启开关的库照旧显示开关，此后的编译会在 RAGFlow 侧失败并显示 `failed`；同时 `compileReady` 变假，建库表单不再显示开关。

停止条件：组 1 若证明 rc2 无法用 API key 开启或触发编译，组 1 照常合入记录，并在 Epic 下报告 owner。组 9 及其全部下游（组 10–18）等 owner 修订本 change 后再开工；组 2–8 不受影响。与 D7 的预案不同，这一项没有预定的替代方案。

### D15 审计

七种 kind 与各自 detail 的精确键集以 knowledge-bases「知识库审计」的表为准，本节不另写一份。要点：
- 每条成功审计与它对应的那一次本地写入同事务：工作空间入库按文档逐条，不写整批汇总。
- 探活归 `kb.settings`（`{probe}`）。
- 重建器写的单库记录，actor 为 `kb_settings.rebuild_actor_id`。

### D16 共用开发栈的使用纪律

- 本仓不提交任何 RAGFlow 栈定义，不执行 `docker compose up` / `down` / `restart`，不改栈的配置文件与环境。
- **owner 前置**：Stage 5 建一个由 owner 持有的前置 issue（tasks「外部前提」），内容是：共用栈运行 `v1.0.0-rc2`；在 RAGFlow 界面注册 open-workbuddy 专用账号并生成 API key；key 文件以 `0600` 放在仓库之外；在本机 `CLAUDE.local.md` 新建一节，记下 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` 与实测用的嵌入上游变量名，并在 shell 环境里 export 它们。组 1 与组 18 `Depends on` 它。
- **执行时检测**：需要真实 RAGFlow 的任务（组 1、组 18）从 shell 环境读这两个变量，区分两种停止：
  - 变量未设置或 key 文件不存在：报告 `RAGFlow 私有配置缺失`。
  - 版本接口不可达或不是 `v1.0.0-rc2`：报告 `共用 RAGFlow 栈未运行或版本不符`。
  
  两种都在 issue 评论里报告，给 issue 打 `blocked` 标签，不开 PR，不自己拉起任何容器。检测时另执行一次只读的 `docker compose ls`，结果记进评论（grill #4，只作观察）。
- **账号隔离**：在共用栈上只用专用账号，所以 dsh-team 的库与模型配置天然隔离。实测与 smoke 只清理本次运行自己建的数据集（名称前缀 `owb-`）。
- **脱敏**：仓库是 public。实测记录、PR 与 issue 正文中，地址一律写 `<RAGFLOW_BASE_URL>`；id、邮箱、昵称、账号名与 key 路径全部替换。组 1 的 PR 附 gitleaks 与 grep（本机地址、账号名）零命中的输出。

### D17 测试与夹具

`server/test/support/fake-ragflow.mjs`（+ `.d.mts`）是进程内可起的假 RAGFlow，协议以组 1 的实测记录为准：路径、字段、状态值与错误 code（含「不存在」组合）。
- 可脚本化：版本串；某路由返回指定 code 或 HTTP 状态；挂起与「挂起后放行」（并发用例用）；超时；3xx；非 JSON；超体积；下载用分块传输或带 `Content-Length`。
- 记录请求：方法、路径、是否带 key、JSON body、multipart 字段与字节数。
- 能力按组逐步加：组 5 建骨架与数据集 / 文档 / 版本接口；组 8 加模型提供方接口；组 9 加编译状态；组 11 加分页与运行状态全集；组 14 加下载与分块传输。每组的任务写明它加什么，加的东西都要在实测记录里有对应条目。

单元与集成用例全部打假 RAGFlow。真实 RAGFlow 只进 `make smoke-kb`（`smoke/kb.hurl`，变量照 `smoke-live` 的写法：调用方自带已接上真实 RAGFlow 的运行中服务）与验收清单。

### D18 模块划分与行数

`server/src/kb/` 下的文件，每个 ≤800 行：

| 文件 | 内容 |
|---|---|
| `config.ts` | 四键解析 |
| `key-file.ts` | `kb_key` 阶段的读取与校验 |
| `ragflow-client.ts` | 唯一出站点 |
| `multipart.ts` | 出站 multipart 的长度计算与流拼接 |
| `store.ts` | 本地三张表 |
| `locks.ts` | 写锁与设置锁 |
| `settings.ts` | 设置、下发、身份判定、models 钩子 |
| `rebuild.ts` | 重建器 |
| `bases.ts` | 建库与删库 |
| `source-file.ts` | 工作空间来源的打开与 stat，组 10 建 |
| `documents.ts` | 组 10 建；组 11、13 扩展 |
| `uploads.ts` | 本地上传 |
| `templates.ts` | 模板与编译支持表 |
| `rest.ts` | 路由与归属身份 |
| `index.ts` | 模块入口 |

800 行上限同样适用于测试文件（`size-guard.sh` 扫描 `server/test`）。

`server.ts` 现为 799 行，本 change 要往里加的有：
- 四键配置展开、`StartupStage` 成员与一次 `kb_key` 阶段调用（组 4）。
- `STARTUP_MODULES` 加 `kb`（组 6）。
- 重建器的启动与关停各一次调用（组 14）。

合计约 7 行。所以组 4 第一步先把 `preparePrivateDbFiles` 到 `chmodExistingPrivateFile`（`server.ts:756-799`，DB 文件准备的四个函数）整体移进 `startup-registry.ts`，腾出约 40 行，再做其余改动。

`server-assembly.test.ts`（798 行）要加两处模块数组、一次 `spyRegistrationOrder` 与一行 import，组 6 先把它的启动记录相关用例拆到新文件 `server-assembly-modules.test.ts`。

`app.ts` 只加一次注册与 `modelWriteGuard` 的传递。

### D19 web

- `web/src/lib/api-kb.ts`：状态、设置、知识库、文档、上传的客户端，全部严格解析（`hasExactlyKeys`），形状以两份 spec 写明的应答为准。
- 中心「知识库」tab：`key: "knowledge-bases"`，`adminOnly: false`，排在 `连接器` 之后、`模型` 之前。只在 `GET /api/kb/status` 为 `enabled:true` 时进入可见 tab 表；描述不变，只连接无条件对所有人可见的 tab。
- 模型 tab 加「知识库模型」段：
  - 嵌入模型：名称、上游地址、密钥、探活。
  - 知识库对话模型：从带上游的对话模型里选，或选 `不使用`。
  - 重建状态与 `重试失败的重建`。
  - 更换嵌入模型时先弹确认，写明受影响的知识库数与文档数；确认后带 `confirmRebuild:true` 再保存。
- 删除被引用的对话模型时，409 `kb_model_in_use` 的信封文案沿用模型表既有的行内 409 显示。

### D20 写锁与设置锁

app-server 是单进程，也是 SQLite 的唯一写者，所以进程内锁足以串行化。

**每库写锁**（`kb/locks.ts`）：
- 持锁的操作：工作空间入库整批、本地上传、重新入库、移出、删库，以及重建器处理该库的全程。
- 写操作先做一次不持锁的状态快判（`rebuilding` / `rebuild_failed` 即时 409）。取锁后再重判存在性与 `state`。
- 锁正被重建器持有时，不排队，直接 409 `kb_rebuilding`。

**进程级设置锁**：
- 持锁的操作：`PUT /api/kb/settings`、探活写回、重试重建、建库，以及 `models` 钩子触发的重新下发。
- 保证「先下发、后写库」的两步不与另一个写者交错（R2-19e）。

这样处理掉的竞态：
- 上传与确认重建交错：重建器取锁时等在途写操作结束，再枚举文档，所以新文档进入新数据集，不会被旧数据集的删除带走（R2-01）。
- 同路径并发入库、入库中删库、重新入库中移出、并发重新入库：同库串行后不再出现。
- 两个管理员并发保存设置：设置锁串行。

备选：插行事务里重判 `state` 与代数，不满足则补偿删除刚上传的 RAGFlow 文档。它能处理 R2-01，但同库并发的其余几种要各写一套补偿；锁一次覆盖全部。

### Sketch seams under test

| Seam | 理由 |
|---|---|
| app-server HTTP 应用（`buildApp` + `app.inject()`，真实 SQLite，接假 RAGFlow） | 知识库端点、权限、审计、错误信封与 RAGFlow 结果映射都在这一层可观察，是 S1d / S1b 已用的最高 seam |
| 编译入口（`server.ts` 子进程） | `kb_key` 阶段、配置错误的启动失败、`server_started.modules` 与重建续做只在真实入口可证 |
| 假 RAGFlow HTTP 服务（`fake-ragflow.mjs`） | 出站请求的形状（multipart、key、期限、重定向、分块下载）与并发交错（挂起后放行）由它记录与驱动；协议以组 1 的实测为准 |
| web 组件（jsdom + 假 `ApiClient`） | 中心「知识库」tab 与模型 tab 的知识库模型段 |
| `make smoke-kb`（真实 RAGFlow） | 唯一证明对 rc2 的映射成立的 seam；只在本机与验收 |

## Not yet specified

- 大批量入库（一次几十上百个文件、目录整体入库）的交互与限流。S2a 只给逐个选文件、每次至多 `KB_UPLOAD_MAX_FILES` 个。
- RAGFlow 数据集与本地映射长期漂移的对账手段，包括 RAGFlow 侧被人手工删改，以及建数据集或上传后、插行前进程崩溃留下的孤儿。S2a 只在列表时把找不到的文档标 `missing`，并在重建时跳过缺失的原件。

## Risks / Trade-offs

- [rc2 是预发行版，rc3 / GA 可能改接口] → 版本钉住（D5），升级是代码变更，重跑组 1 的实测与 `make smoke-kb`。
- [HTTP 参考文档自相矛盾（`chunk_method` vs `parser_id`；编译开关未写）] → 组 1 以运行实例为准，假 RAGFlow 协议只按实测记录写。
- [共用栈由 dsh-team 所有，可能不在跑、版本不同或被重置] → 只有组 1 与组 18 依赖它，两者 `Depends on` owner 前置 issue；检测不满足就停下、打 `blocked`；CI 不依赖它。
- [RAGFlow key 权限覆盖全部知识库] → key 只在 0600 文件与进程内存。RAGFlow 只在内网，部署要求它不对用户网络暴露（ADR-0016）。omp 的 bash 能直连本机端口，但没有 key 就调不动 RAGFlow 的鉴权接口；`/system/version` 无鉴权，暴露的只有版本串。
- [嵌入模型更换的全量重建耗时长，期间不能入库] → 确认对话写明影响面；失败可重试；可以删失败的库，也可以先移出出问题的文档。
- [重建中途进程崩溃] → 启动时从头续做该库，先删残留的新数据集；actor 取持久化的 `rebuild_actor_id`。
- [模型上游密钥下发后存在 RAGFlow 的库里] → 与 ADR-0008「omp 环境零凭证」不冲突（RAGFlow 不是 omp）；删除与轮换经 #28 的联动同步到 RAGFlow；ADR-0016 写明。
- [重建持有每库写锁，期间该库的写请求一律 409] → 这正是 grill #19 的「重建中暂停入库」。
- [rc2 不能用 API key 下发模型] → D7 的应急预案，由组 1 结论触发。
- [rc2 不能用 API key 开启编译] → 组 1 报告，组 9 及下游等修订（D14）。

## Migration Plan

- 迁移 050 只建三张表并插入 `kb_settings` 的唯一一行；不改既有表。回退代码时保留迁移文件（账本拒收多出的回执，规则同 049）。
- 部署：未配 `RAGFLOW_BASE_URL` 时，行为与本 change 之前一致：知识库 tab 不出现，端点 503 `kb_disabled`，`models` 的删除与修改不受联动影响。
- 回滚：去掉两个 RAGFlow 键即关闭知识库；RAGFlow 里的 `owb-` 数据集由运维按需清理。
- `kbservice/` 删除不可由配置回退；需要时从 git 历史恢复。

## Open Questions

- dsh-team 的共用栈何时升到 rc2、用哪个 `DOC_ENGINE`：由 owner 在 dsh-team 侧推动。组 1 在它就绪前不能开工（owner 前置 issue）；开发期引擎与生产（Infinity）不同只影响检索（S2b），不影响 S2a 的摄取。
