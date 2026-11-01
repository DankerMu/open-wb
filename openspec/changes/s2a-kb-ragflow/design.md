# Design: s2a-kb-ragflow

## Context

### 方向变更

ADR-0002（2026-08-29）定的是吸收 RAGFlow v0.27.1 的 Python 线（deepdoc、`rag/app` 模板、`rag/nlp` 检索、agentic 环）进本仓 `kbservice/`，S2a 先做 spike。2026-10-28 grill 由 owner 拍板改为对接运行中的 RAGFlow 服务（见下方「Grill 结论」）。`IMPLEMENTATION_PLAN.md` S2a 一节与 ADR-0002 是本 change 之前的 oracle；本 change 经 owner 拍板改写它们，改写本身是任务组 2 的产物，不是为了让 change 过审而拧的旋钮。

### RAGFlow v1.0.0-rc2 的已知事实（2026-10-28 读 `v1.0.0-rc2` tag 源码与 `docs/references/http_api_reference.md`；2026-11-01 按组 1 的实测记录 `docs/reviews/2026-10-28-ragflow-rc2-api.md` 修订，两者不符时以记录为准）

- v1.0 起服务端是 Go 重写（`cmd/ragflow_server.go`、`internal/`），Python `api/` 层不复存在；消息队列换 NATS，缓存换 Kvrocks。rc2 起有 arm64 镜像（`infiniflow/ragflow:v1.0.0-rc2` 多架构；rc1 与 v0.27.x 只有 amd64）。Infinity 的 arm64 tag 存在但起不来（2026-11-01 部署实测：`v0.7.4-arm64` / `v0.7.3-arm64` / `nightly-arm64` 的二进制要 glibc 2.38，底座 Ubuntu 22.04），arm64 开发机用 `v0.7.4-x64-v2` 走 `linux/amd64` 模拟。
- `GET /api/v1/system/version`、`/system/healthz` 在无鉴权分组（`internal/router/router.go:153-158`）；数据集、文档、模型提供方等路由在 `AuthMiddleware` 分组（`:238-239`），API key 以 `Authorization: Bearer` 传。`GET /api/v1/pipelines/<parser_id>` 也无须鉴权（记录 §15）。
- 业务结果在 body `code`。实测观察到 `0`、`100`、`101`、`102`、`103`、`400`、`401`、`403`、`404`、`409`、`500`、`501`；文档列出的 `105`、`108`、`109` 未观察到（记录 §12、§14、§15）。HTTP 200 加非零 `code` 是常态；鉴权失败是 HTTP 401 + `code:401`；`code:0` 也不代表操作生效（`success_count:0`、`deleted:0`，记录 §8）。dsh-team 对 rc1 的实测（检索列表里一个无效库 ID 整次失败、空 `dataset_ids` 为 `101`）与之一致。
- 数据集：`POST /api/v1/datasets` 的模板字段是 `parser_id`，必须同时带 `parse_type`（`1` 内置；`2` pipeline，改带 `pipeline_id`）；`chunk_method` 回 `101`；`naive` 是 `general` 的别名；`tag` 回 `102`，不可建；`audio` 可建。`embedding_model` 是三段式 `模型@实例@提供方`，两段式只在实例名为 `default` 时可用，不传时回落到账号缺省甚至空值。`name` 不区分大小写、≤128 字符，重名自动加后缀。`PUT /api/v1/datasets/{id}` 改 `embedding_model` 在 `chunk_count` 非 0 时也成功，但不重算向量（记录 §6）。`DELETE /api/v1/datasets` 对不存在的 id 回 `code:403`。
- 文档：上传 `POST /api/v1/datasets/{id}/documents`（multipart，字段 `file`）、下载、列表、删除、解析 `POST …/documents/parse`、停止解析 `POST …/documents/stop`。运行状态字段是 `ingestion_status`（八种取值），切片数字段是 `chunk_count`；`status` 恒为 `"1"`，不是运行状态。后缀不归模板管时静默换解析器（记录 §7.4），不支持的后缀回 `code:500`（§7.1），同名上传改名为 `a(1).txt`（§7.1）。
- RAPTOR / 知识图谱不是数据集字段，`parser_config` 里的开关被静默丢弃。开启方式是模板组 + 画布 + `parse_type:2` 数据集（`compilation-template-groups`、`POST /agents`），解析时自动编译，没有也不需要单独的触发接口（记录 §5.1、§5.2）。`GET /:dataset_id/compilation/status` 按类型没有终态；任务日志 `GET /:dataset_id/ingestions` 有 `task_type` 与 `operation_status`（§5.3）。Compiler 的 `llm_id` 建库时固化为账号当时的缺省对话模型；文档阶段依赖账号缺省嵌入模型；数据集级合并依赖账号缺省对话模型，没有缺省时全栈唯一的入库进程崩溃循环（§5.5、§13）。
- 模型提供方：`/providers/:provider/instances/:instance/models`（增删改查，API key 可用，记录 §11）。账号缺省模型读写走 `GET` / `PATCH /api/v1/models/default`。`GET /api/v1/me/models` 不存在；`PATCH /api/v1/users/me/models` 不校验租户归属，不用（§11.2、§15）。`GET …/instances/<实例>` 明文回显上游密钥（§11.1）。

### 共用开发栈（dsh-team）

- 共用栈已存在：运行 `v1.0.0-rc2`，`DOC_ENGINE=infinity`，arm64 开发机的 Infinity 走 x64 模拟。它由 agent 按 owner 授权部署过一次（2026-11-01，grill #33）；此后 agent 任务仍不 up / down / restart / 改配置（D16）。
- dsh-team 的 `stage-2-dsh-ragflow-office` change 把 RAGFlow 当外部常驻测试栈：地址与密钥只在 0600 私有配置文件，用例跑完「RAGFlow 测试栈不变」，`docker info` MemTotal ≥14 GiB（`design.md` 决定 13、tasks 10.1–10.3，尚未实施）。其设计实测的是 rc1；owner 已定两边统一到 rc2，由 owner 在 dsh-team 侧推动。
- 本机 Docker 分配 15.6 GiB（`docker info` MemTotal 16747859968），放不下两套 RAGFlow。
- 入库 worker 全栈只有 1 个，解析串行；入库进程崩溃循环时，栈上所有账号的入库都受影响（记录 §8.4、§13）。

### 主干现状（41455b5c）

- `server/src/server.ts` 755 行（上限 800；`size-guard.sh` 同样扫描 `server/test`：`omp-process.test.ts` 798 行、`auth-lifecycle.test.ts` 797 行，`server-assembly.test.ts` 已由 #1835 拆出 `server-assembly-modules.test.ts`，现 529 与 322 行）。DB 文件准备函数已由 #1835 移进 `startup-registry.ts`。`STARTUP_MODULES` 十一项、`StartupStage` 十四项，含 `kb_key`（`server.ts:101-113`、`:325-339`）。配置四十六项（`resolveServerConfig`，注释在 `server.ts:123`）。
- 错误码二十五个（`core/errors/index.ts:6-31`；409 九个，其中 `conflict` 的文案是 `同名资源已存在`、`model_in_use` 的文案专指缺省模型），content-parser 归属身份三十一条（`http/errors.ts`；所有 POST / PUT / PATCH 路由都在集合内，含 bodyless 的 POST）。
- `models` 表只有对话模型，无类型列（`046_models.sql`）；模型上游密钥存 DB（与 0600 的 DB 文件同一信任级别）。仓库没有「密钥从文件读」的配置先例。
- 上传是裸 `application/octet-stream`、文件名走查询参数、`Transform` 计数超限即拒（`workspaces/rest.ts:455-520`、`upload.ts`）；没有 multipart 依赖。
- 读工作空间文件：`sandbox.resolve(principal, workspaceId, path, "read")` → 挂载内走 `mountToRead` / `openMountFile` / `mountRangeStream`（离线 `mount_offline`），挂载外走 `lstatExisting` / `openRegularFile`（`O_NOFOLLOW`）（`workspaces/rest.ts:412`、`rest-archive.ts:108-146`、`mounts/files.ts`、`regular-file.ts:55`）。
- 出站 HTTP 一律 node `http(s).request`、`agent:false`、不跟随重定向，连接 10 s / 总 15 s，错误体经 `readErrorBody` + `upstreamExcerpt`（`models/probe.ts`、`connectors/probe.ts`）。
- `assertHeaderSafeKey` 已由 #1839 导出（`agent-config.ts:239`）。`parseUploadName`（`workspaces/rest.ts:160`）仍是模块内私有函数，复用要先经模块入口导出。
- `audit_events.actor_id` 为 `NOT NULL` 且外键指向 `accounts`（`030_audit_events.sql:8,13,15`）。
- 中心 tab 五项（`web/src/features/center/tabs.ts:16-22`），描述 `专家、技能与连接器`（`web/src/routes/manifest.ts:29-37`）。
- `kbservice/` 与 Python 工具链已由 #1834 退役。
- 已落地的知识库代码：`kb/config.ts`、`kb/key-file.ts`（#1839，组 4）与 `kb/locks.ts`（#1837，组 7）。`kb_key` 读出的只读句柄由入口持有（`OwnedResources.kbKey`），组 6 交给 `kb` 模块。
- 迁移最后为 049。

## Grill 结论（2026-10-28，owner 逐分支拍板；#26–#29 为 Stage 4 补问；#30–#36 为 2026-11-01 实测后的 owner 决定）

「结论」列摘自 grill 账本：第 4、8、26–29 行逐字照录，其余行为缩写，原文见 grill 凭证；第 30–36 行是修订 #1863 时 owner 的决定，决定人 owner。Stage 4 的细化写在「落点」列；标「待 owner 复核」的两处（第 4、13 行）由 Stage 5 写进 Epic 正文，等 owner 确认。

| # | 分支 | 结论 | 落点 |
|---|---|---|---|
| 1 | RAGFlow 角色 | 重议 ADR-0002：知识库以运行中的 RAGFlow 为后端，新 ADR 取代 0002 | D1、组 2 |
| 2 | change 切分 | 一个 change 全包；rc2 接口实测为第一组，后续组依赖它 | tasks 组 1 |
| 3 | 版本 | v1.0.0-rc2 | D4、D5 |
| 4 | 共用栈 | 栈归 dsh-team；我方任务执行时检测 docker compose ls + 版本接口=rc2；在跑只复用、绝不 up/down/改配置；未在跑或版本不符停下报告、不自起 | D16。细化（agent 判断，待 owner 复核）：`docker compose ls` 作为只读观察，放在需要真实栈的 agent 任务里（组 1），不进 `make smoke-kb`——该目标可能指向远端栈，本机未必有 docker；放行判据只有版本接口 |
| 5 | kbservice | 退役，app-server `kb` 模块直连 | D1、组 3 |
| 6 | 租户 | 单一 RAGFlow 服务账号；映射存 SQLite | D2 |
| 7 | 入库路径 | 经 `resolve(read)` 读后上传字节，入库审计 | D10 |
| 8 | 模型配置 | 注册表增嵌入类型，app-server 下发到 RAGFlow 服务账号；rc2 不支持下发时自动退到运维手配，app-server 只探活与显示 | D7。前半按 #26 细化；后半的退路由 #27 写成预案，组 1 结论为「支持」（记录 §11），未触发，已删去 |
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
| 23–25 | 事实核查 | rc2 / Infinity 有 arm64 镜像；DMXAPI 有 `bge-m3`、`qwen3-rerank`；deepdoc 形态问题作废 | Context。注：Infinity 的 arm64 tag 存在但起不来，2026-11-01 部署实测后 arm64 开发机走 x64 模拟（#33） |
| 26 | 嵌入模型存放 | 嵌入模型存 kb_settings，不进 models 表；管理入口仍在中心模型 tab 的「知识库模型」段 | D7 |
| 27 | 手配退路的落地方式 | spec 只写下发主路径；退路作为 design 应急预案（含只探活）。组 1 实测「不支持」时先按预案改本 change 的 spec 并重过审核，再放行组 8/14/17；「自动」解读为预案已定、不再问 owner | 未触发：组 1 结论为「支持」（记录 §11），预案已从 D7 删去，这一行没有后续动作 |
| 28 | 知识库对话模型生命周期 | 引用 models 行 + 联动：被指定时不能删（409）；改其上游或密钥时同步重新下发到 RAGFlow，下发失败则该次修改失败；改 models 注册表既有端点规格 | D7、model-registry「模型管理端点」 |
| 29 | 重建遇原件缺失 | 跳过并移除该文档行，写进 kb.rebuild 审计的 skipped 列表，库照常完成；rebuild_failed 状态下也允许移出文档 | D8、D13 |
| 30 | 修订范围 | 修订覆盖实测记录 §18 全部事实，不只模板表（决定人 owner，2026-11-01） | D2、D4、D6–D14、组 5–17 |
| 31 | 模板表 | 按实测放开：RAPTOR 与知识图谱对 11 种模板都可用；删除 `tag`；不加 `audio`。偏离 demo 的「RAPTOR 六种」（决定人 owner，2026-11-01） | D9、Goals / Non-Goals、knowledge-bases |
| 32 | 编译开关 | RAPTOR / 知识图谱开关留在 S2a，实现为模板组 + 画布 + `parse_type:2` pipeline 数据集（决定人 owner，2026-11-01） | D9、D14 |
| 33 | 文档存储与共用栈 | `DOC_ENGINE=infinity`；arm64 开发机 Infinity 走 x64 模拟；共用栈已由 owner 授权部署，此后 agent 任务仍不 up / down / restart / 改配置（决定人 owner，2026-11-01） | D16、Context |
| 34 | 对话模型锁定 | 有开编译的库时 `chatModelId` 不能清空也不能改，回 409 `kb_chat_model_locked`；模型下线只能先删编译库（决定人 owner，2026-11-01） | D7 |
| 35 | 重建与画布 | 重建时新建模板组与画布，`knowledge_bases` 加四列，不复用旧的（决定人 owner，2026-11-01） | D6、D8、D9 |
| 36 | 后缀判定 | 入库的后缀判定对全部知识库生效，不只开编译的库（决定人 owner，2026-11-01） | D10、D11 |

开放项与落点：rc2 接口能力 → 组 1（已完成，见实测记录）；共用栈版本与 `DOC_ENGINE` → #33；S2b agentic 环落点 → Non-Goals；规划文档改写 → 组 2。

## Goals / Non-Goals

**Goals**
- 所有者在中心「知识库」tab 建库（11 种模板 + RAPTOR / 知识图谱开关）、从工作空间或本地上传入库、看到解析状态与切片数、移出文档、删库。
- 管理员在模型 tab 配置唯一的知识库嵌入模型与知识库对话模型，并能安全地更换嵌入模型（确认 + 全量重建）。
- RAGFlow 的 API key 只在 app-server 进程内存里；RAGFlow 不感知本系统的用户。
- `kbservice/` 与 Python 工具链从仓库移除，CI 与控制面 oracle 同步。

**Non-Goals**
- 检索、检索测试 tab、重排、agentic 环（S2b；agentic 环放 app-server 还是用 RAGFlow 自带能力由 S2b 定）。
- 会话内知识库引用、`host_tool_call`、附件的知识库语义（S2c）。
- 可见范围四档、共享只读、跨账号检索审计、`scope` 列（S2c）。
- 部署包、RAGFlow 栈的打包与运维脚本（S4b）。
- 拉起、停止或配置 RAGFlow 栈；本仓任何脚本与测试都不执行 `docker compose up` / `down`。
- 标签集模板 `tag`：rc2 回 `102`，不可建，随之没有 `tag_kb_ids` 关联。
- `audio` 模板：rc2 可建，但要语音模型，编译未测成（记录表 C），不提供。
- 源文件变更后的自动同步；知识库内文档的切片浏览与编辑；建库后修改模板或开关；对本地上传文档的重新解析入口（失败或未解析的上传文档只能移出后重传）。
- RAGFlow 的多用户、团队与 `permission: team`。
- 向 RAGFlow 推送重排模型（S2b）。

## Decisions

### D1 `kb` 模块直连 RAGFlow，`kbservice/` 退役

app-server 新模块 `server/src/kb/` 是第十二个启动模块，注册在 `connectors` 之后，持有 RAGFlow 客户端、store、两种锁（D20）与全部知识库端点。

依赖规则：
- `system.md` §4 的「`sessions → kb`、`kb → accounts`」不变（`sessions → kb` 到 S2c 才有）。
- 本 change 新增 `kb → workspaces`（读工作空间文件，经 `workspaces` 入口导出的读取函数与 `core/sandbox`）与 `kb → models`（读知识库对话模型的上游）。
- `models` 不依赖 `kb`。#28 的联动走反向注入：`AssemblyDependencies` 里有一个可选的 `modelWriteGuard` 钩子，`kb` 注册时把它交给 `models`。`models` 的 `DELETE` 与 `PUT` 把各自的写入作为回调交给它包住；`PUT` 另交一个 `plan`：`models/store.ts` 拆出的纯函数，校验 body，算出候选上游与 `upstreamChanged`，不写库。钩子在设置锁内依次调用 `plan`、做引用判定、需要时按候选上游重新下发、再执行写入回调。`plan` 排在第一步，所以校验先于下发：body 非法即 400，不发 RAGFlow 请求。知识库关闭时钩子为空，`models` 的行为与本 change 之前一致。

备选：保留 `kbservice/` 作薄适配层——多一个进程、一套 Python 工具链和一条跨服务契约，换来的只是把 HTTP 调用挪个地方；S2b 的 agentic 环若需要代码，届时按 S2b 的结论放。

### D2 单一服务账号与映射

- 整个服务用一个 RAGFlow 账号的 API key。
- RAGFlow 里的数据集名为 `owb-<知识库 id>-g<嵌入代数>`（id 为 32 位小写十六进制）。建库时代数为当时的 `embedding_generation`，重建时为新代数。所以同一知识库的新旧两份数据集名字不同，不依赖 RAGFlow 对重名的处理，也能从名字对账。开了开关的库，模板组与画布用同一个名字（D9）。
- 用户可见的知识库名只存在 SQLite；RAGFlow 的文档 id 存 `kb_documents.ragflow_document_id`。
- 所有权与可见性（S2a 只有所有者）只在 app-server 判定；别人的知识库 id 一律 `not_found`，不可探测。

### D3 配置与密钥文件

四个键经 pure config seam 解析：

| 键 | 缺省 | 规则 |
|---|---|---|
| `RAGFLOW_BASE_URL` | 未配置（知识库关闭） | `^https?://[^/?#\s@]+$`（只有协议与 authority；与 `UPSTREAM_BASE_URL` 一样不接受 userinfo）；显式 empty 非法 |
| `RAGFLOW_API_KEY_FILE` | 未配置 | 配了 `RAGFLOW_BASE_URL` 时必填，否则必须不设；绝对路径；显式 empty 非法 |
| `KB_UPLOAD_MAX_BYTES` | `104857600` | 与 `UPLOAD_MAX_BYTES` 同一解析纪律（canonical 正整数） |
| `KB_UPLOAD_MAX_FILES` | `10` | 同上 |

#1839 合入的 `kb/config.ts` 与 `PREVIEW_ORIGIN` 共用 `SCHEME_AND_AUTHORITY`，还接受 userinfo，组 5 收紧（tasks 5.4）。收紧只在 `kb/config.ts`，共用常量与 `PREVIEW_ORIGIN` 的规则不动。

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
- 客户端不提供 `GET …/instances/<实例>`：它明文回显上游密钥。实例是否存在读 `GET /api/v1/models`（D7）。
- 客户端不提供任何删除或清空 RAGFlow 模型配置的调用（D7 的不变量）。

客户端返回类型化结果，REST 层再映射为错误信封。按次序判定：

| 次序 | RAGFlow 结果 | 本系统 |
|---|---|---|
| 1 | 下表的路由专属组合（与下面各行重叠，所以先判） | 类型化结果，由调用点决定 |
| 2 | HTTP 2xx 且 body `code === 0` | 成功 |
| 3 | body `code` 为 `101` 或 `102` | `kb_rejected`（400） |
| 4 | HTTP 401，或 body `code` 为 `401` / `403` | `kb_unavailable`（503），并经受管 stderr writer 写一行 `{"event":"kb_upstream_auth_failed"}`（每进程每分钟至多一行） |
| 5 | 其它非零 `code`、非 2xx、非 JSON、超体积、超时、连接失败、3xx、成功应答缺少调用点要读的字段 | `kb_unavailable`（503） |

路由专属组合（记录表 B、§7.1、§8、§9.1）：

| 路由 | 组合 | 类型化结果 |
|---|---|---|
| `GET /datasets/<id>/documents` | `code:404` | `not_found` |
| `POST /datasets/<id>/documents` | `code:102` 且 message 以 `Can't find the dataset with ID` 开头 | `not_found` |
| `POST /datasets/<id>/documents` | `code:500` 且 message 含 `This type of file has not been supported yet!` | `unsupported_file` |
| `POST …/documents/parse` | `code:404` | `not_found` |
| `POST …/documents/parse` | `code:0` 且 `data.success_count` 为 0 | `parse_not_started` |
| `POST …/documents/stop` | `code:404`；`code:100` 且 message 以 `Documents not found:` 开头 | `not_found` |
| `DELETE …/documents` | `code:404`；`code:102` 且 message 以 `These documents do not belong to dataset` 开头 | `not_found` |
| `DELETE …/documents` | `code:0` 且 `data.deleted` 为 0 | `not_deleted` |
| `DELETE /datasets` | `code:403` | `not_found` |
| `GET …/documents/<doc>`（下载） | D8 的下载判别 | 文件流或 `not_found` |
| `DELETE /agents/<id>` | `code:103` | `not_found` |
| `DELETE /compilation-template-groups/<id>` | `code:404` | `not_found` |

调用点的处理：
- `not_found`：删除视为已删；文档列表视为该库数据集丢失，全部 `missing`；上传与解析触发按 `kb_unavailable` 处理（数据集没了，后面的条目也不会好）。
- `parse_not_started`：`code` 是 0，但文档没有启动解析（文档不存在、已在运行、已完成都是这个应答，§8.1）。对刚上传的文档按 `kb_rejected` 处理，单条失败，不中止整批。
- `unsupported_file`：按 `unsupported_type` 拒绝这一条，不中止整批（D10）。
- `not_deleted`：文档在 `RUNNING` 或 `STOPPING`，行仍在，按 D13 的删除写法处理，不算已删。

几条依据：
- `DELETE /datasets` 一次只发一个 id：混合批次回 `403` 且全部不删（§10）；`{"ids":[]}` 回 `code:0` 什么也不删（§4.6），所以客户端拒绝空 id，成功以 `data.success_count === 1` 为准。
- `code:403` 只有 `DELETE /datasets` 上才是「不存在」，不能反过来把 `403` 当不存在（§12）。作为权限错误它只在一条路由上观察到，单账号造不出真实权限错误，别的路由上的形状未知，所以第 4 行是防御性判定：HTTP 200 + `code:403` 也写 `kb_upstream_auth_failed`。
- `108`、`109` 未观察到，不进映射与夹具；万一出现，落入第 5 行。
- JSON 上限 1 MiB 不变，实测够用（§8.3）：文档列表最坏 858 470 字节（81.9%），`builtins` 32 202 字节（3.1%），任务日志一页 87 096 字节（8.3%）。文档级日志 `log_type=file` 一页 1 244 342 字节，超限，不用（D14）。

RAGFlow 的 message 与响应体不进响应、审计与日志，防止回显密钥或文件内容；失败消息还可能带上游 request id（§5.4）。上表的前缀判定是 message 唯一的用处。

### D5 `GET /api/kb/status` 与版本钉住

登录用户可调。
- 知识库关闭时返回 `{enabled:false}`。
- 开启时每次调用 `GET <base>/api/v1/system/version`（5 s 总期限，不带 key）。版本串（应答的 `data` 字段）恰为 `v1.0.0-rc2` 才算 `available:true`。版本不符时写一行 `{"event":"kb_version_mismatch"}`（每进程每分钟至多一行），并为 `available:false`。
- 应答 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`：`embeddingReady` 为已配置嵌入模型，`compileReady` 为已指定知识库对话模型。

版本钉住意味着升级 RAGFlow 是一次代码变更，与 omp 钉版同一纪律。它只决定 `available`；其它端点不因版本不符而拒绝。web 对 `available:false` 的处理见 D19。

### D6 迁移 050

`050_knowledge_bases.sql`，头注照 049 的惯例。三张表的列见 knowledge-bases「迁移 050 知识库 schema」，要点：
- `kb_settings` 只有一行；`rebuild_actor_id` 记最近一次发起或重试重建的管理员，供重建器续做时写审计（`audit_events.actor_id NOT NULL`）。`kb_settings` 不为 RAGFlow 加列：模型实例名是常量（D7）。
- `chat_model_id … ON DELETE SET NULL`：知识库开启时，删除被引用的模型已在端点层以 409 `kb_model_in_use` 拦住（D7）。外键置空只在知识库关闭时生效。
- `knowledge_bases` 存两组 RAGFlow id：当前一代的 `dataset_id`、`canvas_id`、`template_group_id`，重建中新一代的 `rebuild_dataset_id`、`rebuild_canvas_id`、`rebuild_template_group_id`（D8、D9）。两个开关都为 0 的库，画布与模板组的列都是 NULL，由 CHECK 钉住。
- `template` 的 CHECK 是十一种模板，不含 `tag` 与 `audio`（D9）。
- `kb_documents.workspace_id` 不加外键：工作空间删除后，文档是入库快照，照常保留。

上限：
- 每账号 50 个知识库，第 51 个 409 `kb_limit`。
- 每个知识库 500 份文档：工作空间入库逐条以 `reason: limit` 拒绝，本地上传 409 `kb_limit`。
- 计数在该库的写锁下、插行之前做（D20）。所以本地行的上限是硬的。

### D7 知识库模型与下发

**存放（#26）**：嵌入模型全局唯一，存在 `kb_settings`，不进 `models` 表。`models` 是对话模型白名单的唯一来源，进 `models.yml` 与输入框的模型选择；嵌入模型混进去，要给每条既有规则加排除。知识库对话模型是对 `models` 某一行的引用，只能选带上游的行。

**保存**：`PUT /api/kb/settings`（管理员）的 body 为 `{embedding?: {name, baseUrl, apiKey?}, chatModelId?: string|null, confirmRebuild?: true}`，在进程级设置锁（D20）下执行：
1. 判定 `chatModelId` 的取值规则（见下）。
2. 把模型配置下发到 RAGFlow 服务账号（见下）：
   - body 含 `embedding`：先下发嵌入模型，再重发当时指定的对话模型（本次的 `chatModelId`，否则已存的值；没有指定、或该行没有上游时跳过这一步）。
   - body 只含 `chatModelId`：只下发对话模型；取值为 `null` 时没有下发。
3. 下发失败：按 D4 映射，不改本地设置。
4. 下发成功：在同一事务里写设置与 `kb.settings` 审计。

三个设置端点的成功应答都是 200 加设置读视图（ragflow-backend「知识库模型设置」）。

只含 `embedding` 的 `PUT` 也重发对话模型，是为了留一条界面上的修复路径：有开编译的库时对话模型下拉被禁用（D19），账号缺省在 RAGFlow 侧被人手工清空后，管理员保存一次嵌入模型就能把两种缺省都补回来。身份不变时不触发重建；下发是幂等的，多出来的只是一轮请求。

**下发**（记录 §11，全部用 API key）：两个实例名是常量，`owb-embed` 承载嵌入模型，`owb-chat` 承载知识库对话模型，提供方都是 `OpenAI-API-Compatible`。不按「上游是否相同」分支，也不用存任何 RAGFlow 侧的 id。每次下发一个实例，步骤固定：
1. `PUT /api/v1/providers`，带 `provider_name`（幂等）。
2. `GET /api/v1/models`，按 `provider_name` 与 `instance_name` 看实例是否存在。这个列表不含密钥，账号没有模型时回空列表（§11.1、§16）。本系统的实例建出来就有模型，也从不删模型，所以有实例就一定在这个列表里。
3. 不存在：`POST …/instances`，带 `instance_name`、`api_key`、`base_url`、`model_info`。存在：先 `GET …/instances/<实例>/models` 读现有模型，再 `PUT …/instances/<实例>`，带同样四个字段，`model_info` 为现有项加本次的模型。
4. `PATCH /api/v1/models/default`，带 `model_provider`、`model_instance`、`model_name`、`model_type`。

实测带来的约束：
- 重复 `POST` 同名实例回 `code:500`，所以先读模型列表，不盲发；`PUT` 不带 `model_info` 回 HTTP 400，所以总是带。
- `model_info` 只增不减，同名项以本次为准：模型从 `model_info` 里消失的效果未测，本设计不依赖它。
- `api_key` 恒为实际密钥。空串会清空实例密钥（§11.4）：`embedding.apiKey` 省略时取 `kb_settings` 已存的值，对话模型取 `models` 行的密钥，客户端拒绝发出空 `api_key`。
- `embedding.apiKey` 的规则与模型上游密钥相同（`validateUpstreamKey`：非空、能作 HTTP 头值）。`apiKey:""` 是 400，不是「保留已存密钥」：保留只靠省略这个键。
- `model_info` 项为 `{model_name, model_type, max_tokens}`：嵌入模型 `model_type` 为 `["embedding"]`、`max_tokens` 固定 `8192`（实测值）；对话模型为 `["chat"]`、`max_tokens` 取该行的 `maxTokens`。
- 第 4 步对嵌入与对话都要做：数据集的 `embedding_model` 显式传，但文档阶段的 Compiler 读账号缺省嵌入模型（§5.5）。
- `embedding_model` 恒为 `<name>@owb-embed@OpenAI-API-Compatible`，`llm_id` 由 RAGFlow 固化成同样的三段式，所以 `embedding.name` 与 `chatModelId` 含 `@` 即 400。
- 不用 `PATCH /api/v1/users/me/models`（§11.2）。
- `GET …/instances/<实例>` 明文回显密钥，客户端不提供这个调用（D4）；`PUT` 的请求体含密钥，只进出站请求，不进日志。

下发不是原子的：第 3 步成功、第 4 步失败时 RAGFlow 已是新值，本地仍是旧值。重试同一次保存即收敛，上面的步骤是幂等的。

**账号缺省不变量（§13，最高优先）**：系统的任何路径都不得让服务账号处于「没有缺省对话模型，而可能有 pipeline 数据集或待合并任务」的状态。清空缺省后，已开编译的库下一次入库就会让全栈唯一的入库进程崩溃循环，影响栈上全部账号。落法：
- app-server 不调用清空缺省的 `PATCH /models/default`（`{"model_type":"chat"}` 或三个名字为空串），也不调用 `/providers` 下的任何 `DELETE`。RAGFlow 里的模型配置只增、只覆盖，客户端根本没有这些调用。
- 所以「删除被账号缺省引用的模型」这条路径不存在，本系统不会让缺省悬空。记录 §14 与 #1863 评论留下的问题（缺省悬空时数据集级合并是否同样崩溃）不再需要回答，不加补测。RAGFlow 侧被人手工造成的悬空，也被下一条的前置读取挡住：悬空时 `GET /models/default` 的 `models` 为空（§11.4）。
- 建 pipeline 之前先读：`createPipeline` 第一步只读 `GET /api/v1/models/default`，要求 `data.models` 里 `chat` 与 `embedding` 两种都在且 `model_name` 非空，缺一种即不发后续请求。建库 409 `kb_not_ready`，重建该库 `rebuild_failed`（D8、D9）。本系统自己走不到这一步，它挡的是 RAGFlow 侧被人手工改动。修复：管理员保存一次嵌入模型，两种缺省都会重新下发（见「保存」）。
- 嵌入模型配置后没有清空入口：`PUT` 的 `embedding` 只能换，不能置空。更换时第 4 步把账号缺省切到新模型，切换是一次 `PATCH`，中间没有空窗。
- 删除 `models` 行、取消指定都只改本地，不碰 RAGFlow（见下）。

**`chatModelId` 的取值规则**：「开编译的库」指 `raptor = 1` 或 `graph = 1` 的行，含 `rebuilding` 与 `rebuild_failed`。

| 本次 `chatModelId` | 当前值为 `null` | 当前值非 `null`，有开编译的库 | 当前值非 `null`，没有开编译的库 |
|---|---|---|---|
| 与当前值相同的 id | 不适用 | 下发（幂等）并保存 | 下发（幂等）并保存 |
| 别的 id | 下发并保存 | 409 `kb_chat_model_locked` | 下发并保存 |
| `null` | 无操作 | 409 `kb_chat_model_locked` | 只改本地，不发 RAGFlow 请求 |

「无操作」同 `POST /api/models/default` 已是缺省时的先例：200，不写库，不审计。body 里还有 `embedding` 时照常处理嵌入模型，审计 detail 只含实际变化的键。

判定在设置锁内做。建库的模型、重名与数量判定同样在设置锁内（D9），两者按到达次序串行，不会交错。

不只禁止置 `null`，也禁止换成别的模型：Compiler 的 `llm_id` 建库时固化（§5.5），而 `owb-chat` 是固定实例，换模型会把它的上游覆盖掉，旧库的 `旧模型@owb-chat` 随之打到新上游。新上游不服务旧模型名时，图谱文档 `FAILED`，RAPTOR 完全无信号（§5.4）。要让旧库用上新模型只能重建数据集，S2a 不做（Not yet specified）。同一行轮换密钥或改地址不受影响，走下面的联动。

**撤销只是本地取消指定**：`chatModelId` 改为 `null` 后，`compileReady` 变假，建库表单不再显示开关。RAGFlow 里已下发的配置不动，账号缺省仍指向它，下一次下发时覆盖。

这改变了 ADR-0016 的「删除与轮换经联动同步」：轮换仍同步；取消指定之后，上游密钥留在 `owb-chat` 里，直到被覆盖或运维清理，这期间删除那一行 `models` 也不同步。ADR-0016 的这一条由组 8 同 PR 改写（tasks 8.6）。运维清理要按记录 §16 的次序：先删数据集、画布、模板组，静默到没有编译活动，才清缺省、删实例。

**嵌入身份**为 `(name, baseUrl)`，只改密钥不算身份变化。身份变化且存在任一知识库时，按次序判定：
1. 任一知识库处于 `rebuilding`：409 `kb_rebuilding`，带不带 `confirmRebuild` 都一样。重建进行中确认没有意义，所以排在最前。
2. 未带 `confirmRebuild:true`：409 `kb_rebuild_required`，不下发，不保存。
3. 带了：保存；`embedding_generation + 1`；全部知识库置 `rebuilding`；写 `rebuild_actor_id`；审计 `kb.rebuild`；唤醒重建（D8）。

**与 models 的联动（#28）**：知识库开启且某行是知识库对话模型时，`models` 经 D1 的钩子请 `kb` 判定。`PUT` 的 body 校验在最前面，非法 body 400，不发 RAGFlow 请求（D1 的 `plan`）。之后：
- `DELETE` 该行，或 `PUT` 把它的 `upstream` 置为 `null`：409 `kb_model_in_use`（新码；`model_in_use` 的文案专指缺省模型，不改它）。
- `PUT` 且 `upstreamChanged` 为真：先把新上游重新下发到 `owb-chat`，成功后 `models` 才写库；失败则该次 `PUT` 按 D4 映射失败，行、审计与 `models.yml` 都不变。

引用判定、重新下发与 `models` 的那次写入都在设置锁内完成（删除时的引用判定同样在锁内），所以不会与一次并发的 `PUT /api/kb/settings {chatModelId}` 交错。这样，在知识库开启期间，被指定模型的上游一改就同步到 RAGFlow。知识库关闭期间删除或轮换不联动，之前下发到 RAGFlow 的副本不会被撤销；重新开启后，管理员保存一次知识库模型设置即覆盖它。

知识库关闭期间删除被引用的模型，外键把 `chat_model_id` 置空，开编译的库可能还在。这时账号缺省仍在 RAGFlow 里，入库不会崩；`compileReady` 为假，管理员指定一个新模型即恢复（上表第一列）。旧库的 `llm_id` 还是旧名字，这是关闭期间绕过联动的已知后果。

### D8 嵌入模型更换与全量重建

重建在进程内单线程串行执行，一次一个知识库，处理期间持有该库的写锁（D20）。重建器由 `kb` 模块在 `server_started` 之后不等待地启动；启动时，对仍是 `rebuilding` 的库从第一步续做。每个库的步骤：
1. `rebuild_dataset_id` 非空时，按 D9 的删除次序删掉残留的一代，不存在视为已删，再把三个 `rebuild_*` 列置空。
2. 按原模板与开关、新嵌入模型，经 `createPipeline` 建新一代（D9），名为 `owb-<id>-g<新代数>`，写回三个 `rebuild_*` 列。账号缺省缺失时开了开关的库在这里失败，不发后续请求（D7）。
3. 逐份文档，从旧数据集流式下载入库原件，上传到新数据集，再触发这份文档的解析（`parse_not_started` 即该库失败），记下新文档 id：
   - multipart 长度按本地 `kb_documents.size` 计算。
   - 下载为 not-found：该文档记为跳过（#29）。
   - 实际字节数与 `size` 不符：该库失败。
4. 单事务切换：删除被跳过的行；其余行换成新 id；`dataset_id`、`canvas_id`、`template_group_id` 换成 `rebuild_*` 的值，三个 `rebuild_*` 列置空；`embedding_generation` 设为当前代数；`state = ready`；审计 `kb.rebuild {id, result:"ok", skipped}`。
5. 按 D9 的删除次序删旧一代。数据集删除失败写一行 `{"event":"kb_dataset_leak","datasetId":<id>}`，并且不再删它的画布与模板组；画布或模板组删除失败写一行 `{"event":"kb_pipeline_leak","canvasId":<id|null>,"groupId":<id|null>}`：画布删除失败时两个 id 都在，模板组删除失败时画布已删，`canvasId` 为 `null`。都不带名称与内容，不影响状态。

逐份触发解析而不是一次传全部 id：批量上限只验证到 40 份（§8.5），逐份还能和 D10 共用同一段上传加解析。

**模板组与画布重建时新建，不复用。** 重建开始时旧数据集里的文档可能还在排队或解析：解析是 RAGFlow 异步跑的，写锁管不到它。而两个数据集在同一画布上解析从未验证过（§5.1 (5)、§14）。建与删走同一对函数，重建器不多一条分支。代价是比复用旧资源多 `rebuild_canvas_id`、`rebuild_template_group_id` 两列（#35 的四列里，另两列是当前一代的 `canvas_id`、`template_group_id`，不管复用与否都要有）。

**下载判别**（§9.1）：not-found 也是 HTTP 200，文件内容可以恰好等于 not-found 正文，所以不能解析正文判成败。
- HTTP 200 且带 `Content-Disposition`：是文件字节，正文一律不解析，也不看 `Content-Type`、`Content-Length` 与后缀。这个头的值不解析：非 ASCII 名是原始 UTF-8，`"` 不转义（§9.2）。
- HTTP 200 且不带：按 JSON 解析（受 1 MiB 上限），body `code` 为 `404` 是 not-found，其余按 D4 的通用行判定。
- 非 200：按 D4 的通用行判定。

这个判据只在直连实例上验证过。中间若有代理剥掉这个头，下载判为失败，该库 `rebuild_failed`，不会把错误应答当文件上传。

实测下载始终带 `Content-Length`，未观察到分块（§9）。本系统不依赖这一点：multipart 长度只看本地 `size`，读到的字节数在流上核对。

0 字节文件的下载是 `code:500`，重试也不会好（§9）。这种文件在入库时就被拒绝（D10、D11），所以 `kb_documents` 里没有 `size = 0` 的行，重建不会碰到它。

`PUT /datasets/<id>` 改 `embedding_model` 不重算向量（§6），不用它代替重建。

任一步失败：`state = rebuild_failed`，`state_message` 为 `重建失败，可在模型设置里重试`（不含 RAGFlow 原文），审计 `kb.rebuild {id, result:"failed"}`。重建器写的审计，actor 一律取 `kb_settings.rebuild_actor_id`。

`POST /api/kb/settings/rebuild`（管理员，bodyless）把全部 `rebuild_failed` 置回 `rebuilding`，`rebuild_actor_id` 改为本次请求者，审计后唤醒，返回 200 读视图。

**关停与崩溃**：第 4 步提交之前被中止或崩溃，该库保持 `rebuilding`，下次启动从第一步续做。第 4 步提交之后库已是 `ready`，旧一代的 id 已从库行换掉：第 5 步被中止或崩溃时，没删完的旧一代成为孤儿，不续删，归「Not yet specified」的长期对账。不为这个窗口持久化旧 id：多三列，只换来一个很窄的窗口。

**知识库关闭**：未配置 `RAGFLOW_BASE_URL` 时重建器不启动。`rebuilding` 的库保持原状，不改成 `rebuild_failed`；重新配置后，下次启动续做。

处于 `rebuilding` 或 `rebuild_failed` 的库，各操作的处理：
- 入库、重新入库、上传：409 `kb_rebuilding`。
- 移出：`rebuilding` 时 409；`rebuild_failed` 时允许（#29），它删的是 `dataset_id` 里的文档；`rebuild_dataset_id` 里的副本由重试的第 1 步整体删掉。
- 删库：`rebuilding` 时 409 `kb_rebuilding`；`rebuild_failed` 时可以删，两代都删。

不等新数据集解析完成就切换：S2a 没有检索，文档列表从新数据集读状态。

### D9 建库、删库与编译资源

`POST /api/kb/bases` 的校验次序与应答见 knowledge-bases「知识库端点」。键集、类型、名称与模板在取锁之前判定，不读库。嵌入模型就绪、对话模型已指定、重名与数量上限都在取得设置锁之后判定，读的是锁内的行；建库全程持有这把锁。这样不会建出代数过期的库，也不会与一次并发的设置保存交错：A 建库排在 B 取消指定之后，A 读到 `null`，400；排在之前，B 读到已有开编译的库，409 `kb_chat_model_locked`。模板与开关之后不可改（无更新端点）。

**模板（#31）**：十一种，`naive`、`book`、`email`、`laws`、`manual`、`one`、`paper`、`picture`、`presentation`、`qa`、`table`。本地存 `naive`，发给 RAGFlow 的 `parser_id` 是 `general`，其余同名。RAPTOR 与知识图谱对全部十一种可用，都实际跑通（记录表 C），不再有按模板的开关表。这偏离 demo 的「RAPTOR 六种」，owner 拍板。各模板管的后缀抄自表 C 末列，放在 `kb/templates.ts`（D10）。

**两种数据集**：
- 两个开关都关：`POST /datasets {name, parser_id, parse_type:1, embedding_model}`，不建模板组与画布。
- 任一开关开（#32）：建模板组 → 建画布 → `POST /datasets {name, parse_type:2, pipeline_id:<画布 id>, embedding_model}`。

`embedding_model` 恒显式传三段式（D7）：不传时回落到账号缺省甚至空值，缺省悬空时建库成功、到解析才 `FAILED`（§4.4）。`parser_config` 里的 `raptor`、`graphrag` 被静默丢弃（§5.1），不发。

**每库一套，一代一套**：每个开了开关的知识库有自己的模板组和画布，不共用（理由见 D8）。

**建库**，`kb/pipeline.ts` 的 `createPipeline`，建库与重建共用：
1. `GET /api/v1/models/default`，要求 `chat` 与 `embedding` 都在（D7）。缺失时不发后续请求：建库 409 `kb_not_ready`，重建该库 `rebuild_failed`。
2. `GET /compilation-templates/builtins` 取内置 `config`。RAPTOR 用 `tree`，删掉 `entity`、`relation`、`llm_id`（内置 `entity.fields` 带一条空 `type`，原样提交回 `102`）；知识图谱用 `knowledge_graph`，删掉 `llm_id`。
3. `POST /compilation-template-groups`，名为 `owb-<id>-g<代数>`，`templates` 按开关含一项或两项，body 形状见记录 §5.1 (2)。
4. `GET /pipelines/<parser_id>` 取内置 DSL，按下面的写法插入 Compiler 节点，`POST /agents`，`title` 同名，`canvas_category` 为 `dataflow_canvas`。
5. 建数据集。

RAGFlow 对同名模板组自动加 `(1)` 后缀，不区分大小写（§5.1，#30）。本系统只按 id 引用，命名不依赖它：崩溃后续做时再建同名组，得到带后缀的新组，照常能用，不需要先清理重名。单模板组的模板 `name` 被改写成组名，同样没有影响。

任一步失败，逆序删除这一次已建的资源（走下面的删除次序），按 D4 返回。回滚同样即停：某一步删除失败就不再删后面的资源，写一行 leak（数据集 `kb_dataset_leak`，画布或模板组 `kb_pipeline_leak`，形状见 D8），不改变应答。全部成功后插行，并在同一事务里审计 `kb.create`。插行失败同样删除这一代。

成功应答 201 `BaseView` 不读 RAGFlow：`state` 为 `ready`，`stateMessage` 为 `null`，`documents` 为 0；`compile` 里开着的类型为 `pending`，关着的为 `off`。

建库超时但 RAGFlow 侧实际已建成，或资源建好后进程崩溃：会留下无法自动对账的孤儿，归「Not yet specified」的长期对账。

**DSL**（§5.1 (3)、(6)）：改内置 DSL，插一个 `Compiler:Owb` 节点。
- 按 `obj.component_name` 含 `Chunker` 查 chunker 节点，各模板节点名不同。查到的不是恰一个即失败（`kb_unavailable`），不提交。
- `components` 加 `Compiler:Owb`：`upstream` 为 chunker，`downstream` 为 chunker 原来的下游，`obj` 为 `{component_name:"Compiler", params:{compilation_template_group_id, llm_id:"", plan:false, outputs:{chunks:{type:"Array<Object>", value:[]}}}}`。
- chunker 的 `downstream` 改为 `Compiler:Owb`；原下游的 `upstream` 里 chunker 换成 `Compiler:Owb`。
- `graph.nodes` 加 `{id:"Compiler:Owb", type:"compilationNode", data:{label:"Compiler", name:"Compiler", form:<同 params>}, position, sourcePosition:"right", targetPosition:"left"}`。
- `graph.edges`：chunker 原来的出边把 `source` 改为 `Compiler:Owb`，原边不保留；再加一条 chunker → `Compiler:Owb`，`sourceHandle:"start"`、`targetHandle:"end"`。净增一条。
- `graph` 不能省（§18 #25）：省掉时建画布、建库都回 `code:0`，`.txt` 文档静默换到 `general`，编译不运行，没有任何提示。内置 DSL 不带 `graph` 即失败，不提交。

`llm_id` 留空：建数据集时 RAGFlow 把它固化成账号当时的缺省对话模型（D7）。

**删除**，`kb/pipeline.ts` 的 `deletePipeline`，次序固定为数据集 → 画布 → 模板组。这两个删除接口没有引用保护：删了在用的画布或模板组，RAGFlow 回 `code:0`，之后解析 `FAILED`（§5.1 (7)）。次序由 `pipeline.ts` 保证：
- `ragflow-client` 的删画布与删模板组只有它调用。
- 上一步确认已删（成功或 `not_found`）之前不发下一步；任一步失败即停。
- 调用方持有该库写锁（建库回滚时这一代还没有行，别的请求碰不到）。

`DELETE /api/kb/bases/:id`：在该库的写锁下调用 `deletePipeline`；`rebuild_failed` 时先删新一代，再删当前一代。任一步不可达即 503，行不动；重试从头走一遍，已删的按 `not_found` 跳过，所以不留孤儿。都删完后删行（文档行级联），并审计 `kb.delete`。

列表只读本地行；开了开关的库，编译状态读取并发发出，共用一个 5 s 总期限，读不到为 `null`（grill #13 的细化，判定见 D14）。

### D10 工作空间来源入库

`POST /api/kb/bases/:id/documents` 的 body 为 `{workspaceId, paths}`，`paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个工作空间内相对路径。`workspaceId` 不可见时，整个请求 404，不发出站请求。

在该库的写锁下逐条顺序处理，每条依次：
1. `sandbox.resolve(principal, workspaceId, path, "read")`。被拒为 `outside`，facade 照常写 `sandbox.reject`。路径上任一分量是符号链接时 `resolve` 也拒绝，所以同样归 `outside`。
2. 查重（`duplicate`）与 500 上限（`limit`）。
3. 后缀判定：路径 basename 最后一个 `.` 之后的部分转小写，不在该模板的后缀表里即 `unsupported_type`；没有后缀同样。
4. 打开：挂载内用 `mountToRead` + `openMountFile`，离线即 `offline`；挂载外用 `lstatExisting` + `openRegularFile`。非普通文件或路径不存在即 `not_file`，挂载内外一样：`resolve(read)` 不拒绝不存在的路径，到这一步 `lstatExisting` 才返回空。之后对同一 fd 做 `fstat`，取 `size` 与 `mtimeMs`。
5. 大小为 0 即 `empty`；超过 `KB_UPLOAD_MAX_BYTES` 即 `too_large`。
6. 以 multipart 流式上传，字段名 `file`。文件名用原始 UTF-8 或 `filename*`，不放百分号编码（§7.3）。`Content-Length` 由前后缀长度加 `fstat` 大小算出，不落临时文件。流里加计数 `Transform`，读出字节与 `size` 不等时立即中止该条的出站请求，记为 `changed`，这不当作 RAGFlow 不可达处理。中断的上传不留文档（§7.2），不发补偿删除。
7. 触发该文档的解析，`document_ids` 只有这一个 id。
8. 在同一事务里插行与 `kb.ingest`。

逐条触发解析而不是整批一次：这样「上传成功、解析未触发」只会出现在单条上，可以按条回滚，不会留下永远不解析的文档。

**后缀判定**：后缀不归模板管时，RAGFlow 不报错，把这份文档改走别的内置解析器并脱离数据集的 pipeline，编译不运行，没有任何提示（§7.4）。入库之后用户没有办法发现，所以在上传之前拒绝。规则对全部知识库一样，不分开没开编译：一张表、一次判定。开了编译的库这是必需；没开的库，也不该让用户以为文档走了所选模板。后缀表来自 Parser 节点，不是逐个上传验证的（表 C 注），实际不一致时由下面的 `unsupported_file` 兜底。

判定时后缀转小写，只用于判定，上传的文件名不改。记录 §7.4 已证实大写后缀走 pipeline、编译照常运行（#31）。RAGFlow 列表的 `suffix` 保留原大小写、`type` 是小写，这两个字段本系统都不读，不影响判定。

**0 字节**：空文件上传成功、解析后 `COMPLETED`，但下载回 `code:500`，重建时该库必败且重试不会好（§7.1、§9）。所以入库时拒绝。

RAGFlow 的失败：
- 上传或解析触发得到 `kb_rejected`：删除已建的文档，该条记为 `rejected`，继续下一条。
- 解析触发得到 `parse_not_started`：同上，不中止整批。
- 上传得到 `unsupported_file`：该条记为 `unsupported_type`，继续下一条。按通用映射它是 `kb_unavailable`，会中止整批，所以 D4 先判。
- 得到 `kb_unavailable` 或 `not_found`：删除已建的文档（尽力而为），该条与其后全部记为 `unavailable`，不再发请求。
- 补偿删除按 D13 的写法；失败只写一行 `{"event":"kb_document_leak","documentId":<id>}`，本地上传与重新入库同此。

同一文件名再次上传时 RAGFlow 改名为 `a(1).txt`（§7.1）。本系统不读 RAGFlow 的 `name`，文档名只来自本地 `kb_documents.name`，所以同名、重新入库与重建都不受影响。

应答 201 `{documents, rejected: {path, reason, message}[]}`，`message` 按 `reason` 固定（knowledge-bases「工作空间来源入库」的表）。

写端点返回的 `DocumentView` 不读 RAGFlow，也不在末尾读一次列表：解析刚触发成功，`status` 恒为 `queued`，`chunkCount`、`message` 为 `null`；`sourceChanged` 为 `false`，字节刚从源文件读出，大小与 `mtimeMs` 就是入库记录。D11、D13 同此，本地上传的 `sourceChanged` 为 `null`。web 看到 `queued` 就进入 3 秒刷新（D12），真实状态由下一次列表给出。

审计为每份成功文档一条 `kb.ingest`、每个被拒条目一条 `kb.ingest_reject`；detail 形状以 knowledge-bases「知识库审计」为准。

读取链路的 stat 与打开函数由本组在 `kb/source-file.ts` 实现，组 11 的 `sourceChanged` 与组 13 的重新入库复用它（D18）。

### D11 本地上传

`POST /api/kb/bases/:id/uploads?name=<文件名>` 与 `POST /api/workspaces/:id/uploads` 同一写法：独立 scope，只注册 `application/octet-stream`，文件名规则与 255 字节上限复用 `parseUploadName`（由 `workspaces` 入口导出）。

规则：
- 必须带 `Content-Length`，缺失或分块传输即 400。在 Content-Length 分帧下，「流中多于声明」到不了 handler，所以只在入口判一次：`Content-Length > KB_UPLOAD_MAX_BYTES` 即 413 `upload_too_large`。
- 文件名后缀按 D10 判定；`Content-Length` 为 0 同样拒绝。两者都是 400 `kb_file_unsupported`，不发出站请求，审计 `kb.ingest_reject`（`reason` 分别为 `unsupported_type`、`empty`）。
- 请求体直接拼进出站 multipart，不落盘，不留副本。文件名写法同 D10。
- 客户端中途断开或短体：中止出站，不插行，不审计 `kb.ingest`。中断的上传不留文档（§7.2）。
- 上传成功后触发该文档的解析。`kb_rejected`、`parse_not_started` 或 `kb_unavailable`：按 D13 的写法删除文档，分别返回 400 `kb_rejected`、400 `kb_rejected`、503 `kb_unavailable`。上传本身得到 `unsupported_file`：400 `kb_file_unsupported`。
- 都成功后，单事务插行并审计 `kb.ingest`，应答 201 `DocumentView`（字段规则见 D10，`sourceChanged` 为 `null`）。
- 被拒（超限、上限）时审计 `kb.ingest_reject`。

一次最多选 `KB_UPLOAD_MAX_FILES` 个，由 web 约束（逐个请求）。

### D12 文档列表、状态与源文件变更

`GET /api/kb/bases/:id/documents` 应答 200 `{documents}`。先读本地行，再分页读取该数据集在 RAGFlow 的全部文档，请求为 `GET …/documents?page=<n>&page_size=100&orderby=create_time&desc=false`，读到 `total` 为止，按 `ragflow_document_id` 关联。`page_size` 超过 100 时 RAGFlow 静默回落到 10 条（§8.3），所以不传更大的值。数据集为 not-found 时，全部为 `missing`。

本地行上限 500，对应 5 页。不设页数上限：补偿删除失败留下的文档（`kb_document_leak`）只在 RAGFlow 里，`total` 可以略大于 500，截断会把真实文档标成 `missing`。

**次序**：用 `create_time` 升序。入库在写锁下逐份上传，`create_time` 造不出并列（§8.3；并列时的翻页未测，§14），翻页期间新上传的文档落在末尾，不挪动已读的页。`update_time` 在解析中一直变，不用。`name` 的唯一性只来自 RAGFlow 的改名规则，不用。

**翻页期间有写入**（§14 未测）：列表不取写锁。新文档还没有本地行，被忽略；有文档被删时后面的行前移，这次读可能漏一行，该条显示 `missing`，下一次读取修正。不重试。

`DocumentView = {id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：
- `status` 取 `queued` / `parsing` / `done` / `failed` / `cancelled` / `unparsed` / `missing`，映射见下表（记录表 A）。运行状态读 `ingestion_status`，不读 `status`（恒为 `"1"`）。

| `ingestion_status` | `status` | web 刷新 |
|---|---|---|
| `UNSTART` | `unparsed` | 否 |
| `CREATED`、`SCHEDULED` | `queued` | 是 |
| `RUNNING`、`STOPPING` | `parsing` | 是 |
| `STOPPED` | `cancelled` | 否 |
| `COMPLETED` | `done` | 否 |
| `FAILED` | `failed` | 否 |
| RAGFlow 列表里没有该 id | `missing` | 否 |

- 八种之外的取值是协议漂移：整个请求 503 `kb_unavailable`（版本钉住之下不该出现）。
- `message` 只在 `failed` 时为固定句子 `解析失败`。失败原因在 `latest_ingestion_event.message`，是 RAGFlow 原文，不透出（D4）。
- `chunkCount` 只在 `done` 时为数字，取列表的 `chunk_count`，可以是 0：有些内容切不出切片（表 C 的 `qa` `.md`）。web 照常显示 `已切片 0`。
- `sourceChanged` 只对工作空间来源计算：
  - 用 `rootOf` 加 core 的纯函数 `resolve(root, rel, "read", mountNames)`，即**无审计**版本，再 stat；挂载内经挂载的 stat。`mountNames` 是该工作空间的挂载名集合，与 facade 注入的 `mountNamesOf` 同一来源；不传它，纯函数会对挂载点与其下路径逐级同步 `lstat`，违反 workspace-mounts 对挂载路径的约束。
  - 解析被拒、工作空间不可见、离线时为 `null`，即「不知道」；大小或 `mtimeMs` 与入库记录不同、或文件已不存在为 `true`。
  - 这样，源路径被换成符号链接后，每 3 秒一次的刷新也不会写 `sandbox.reject`。

没有后台轮询；web 在有 `queued` / `parsing` 文档且页面可见时每 3 秒重取。

### D13 重新入库、移出与删除

**RAGFlow 文档的删除**：`code:0` 不代表删成了，`RUNNING`、`STOPPING` 时回 `deleted:0`，行仍在（§8.5）。按原来的流程本地行被删，RAGFlow 留下孤儿。`kb/documents.ts` 有一个共用写法，D10、D11、D13 都走它：
1. `DELETE …/documents`，`ids` 只有这一个 id。`deleted:1` 或 `not_found`：完成。
2. `not_deleted`：发一次 `POST …/documents/stop`，只发这一次：`STOPPING` 时重复 `stop` 回 `success_count:1`，是空操作（§8.2），重发没有用。按结果：
   - `code:0`，不论 `success_count`：继续。`success_count:0` 是文档已不在运行（§8.2），下一次删除会成功。
   - `not_found`：继续，下一次删除得到 `not_found` 即完成。
   - 其它（`kb_unavailable`、`kb_rejected`）：返回 `failed`，不再重试。
3. 每 500 ms 重发一次 `DELETE`，至多 5 s（期限经装配注入；`STOPPING` 实测约 0.5 秒，§8.4）。`deleted:1` 或 `not_found`：完成。`not_deleted`：继续重试，`STOPPING` 时就是这个应答，行还在（§8.5）。重试期间不可达：立即返回 `failed`，不等到期。
4. 到期仍是 `not_deleted`：返回 `busy`。

第 1 步的删除不可达同样返回 `failed`。调用方的处理：
- 移出：`failed` 按 D4 映射（不可达 503），`busy` 得 409 `kb_document_busy`，行都不变，用户稍后再试。
- 补偿删除与重新入库删旧文档：`failed`、`busy` 都写 `kb_document_leak`。

**重新入库**：`POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>`，只对工作空间来源，在该库的写锁下进行。
1. 按 D10 的读取规则重读源文件。读取被拒（含工作空间已不可见、文件变成 0 字节）即 409 `kb_source_unreadable`（新码，`conflict` 的文案是「同名资源已存在」，不适用），行不变。
2. 上传为新文档，触发解析。失败时的类型化结果与 D11 相同，行不变：
   - 上传 `kb_rejected`：400 `kb_rejected`。上传 `unsupported_file`：400 `kb_file_unsupported`。上传 `kb_unavailable` 或 `not_found`：503 `kb_unavailable`。这三种都没有新文档要删。
   - 解析触发 `kb_rejected` 或 `parse_not_started`：删除新文档，400 `kb_rejected`。解析触发 `kb_unavailable` 或 `not_found`：删除新文档，503 `kb_unavailable`。
3. 成功后，单事务换行内的 RAGFlow id、大小与 `mtimeMs`，并审计 `kb.ingest`。
4. 再删旧的 RAGFlow 文档；旧文档可能还在解析，走上面的写法，失败只写 `{"event":"kb_document_leak","documentId":<id>}`。

应答 200 `DocumentView`（字段规则见 D10，`sourceChanged` 为 `false`）。

**移出**：`DELETE /api/kb/bases/:id/documents?doc=<文档 id>`，在该库的写锁下进行，`ready` 与 `rebuild_failed` 时允许。先删 RAGFlow 文档（不存在视为已删），再删行，并审计 `kb.document_delete`，应答 204；源文件不动。不可达 503、`busy` 409，行都不变。

### D14 RAPTOR 与知识图谱

**开启**：见 D9。解析时 Compiler 节点在 pipeline 内自动运行，解析完成后 RAGFlow 自动建数据集级合并任务，没有也不需要单独的编译触发（§5.2）。所以入库、上传、重新入库与重建都只触发解析。

**模型依赖**（§5.5、§13）：
- 文档阶段的 Compiler 用建库时固化的 `llm_id`，之后账号缺省变了也不影响它。
- 文档阶段另依赖账号缺省嵌入模型，不是数据集的 `embedding_model`。
- 数据集级合并用账号缺省对话模型，没有缺省时入库进程退出。

这几条都靠 D7 的不变量保住：账号缺省下发之后不会被清空。知识库对话模型被指定期间，不能删除，也不能清空它的上游（D7 #28）；有开编译的库时，`chatModelId` 不能取消也不能更换（D7）。

**状态**：知识库视图带 `compile: {raptor, graph}`，各取 `off` / `pending` / `running` / `done` / `failed`。按需读取，读取失败或超时 `compile` 为 `null`。

不用 `GET compilation/status`：按类型读取没有终态，跑完之后与「从未编译」同为 `idle`，`last_completed_at` 不分类型；不带 `kind` 的 `state` 在多文档时往返，文档还在排队时也可能是 `completed`（§5.3）。它能给的 `running` 下面两份数据也能给，少两个请求，5 s 总期限更够用。状态由两份数据推出，都是每次现读：
- 文档列表（D12）：该库本地文档的 `ingestion_status` 与 `chunk_count`。
- 任务日志 `GET /datasets/<id>/ingestions?page=<n>&page_size=100&orderby=id`：逐页读到 `total`，读全后在客户端按 `task_type` 判定，RAPTOR 是 `Tree`，知识图谱是 `Graph`。`total` 是日志行数，不是文档数；越界页回空 `logs`。

读法的依据（§5.3、§18 #26–#29）：
- `orderby=id` 不能省：缺省的 `create_time` 次序里 `Tree`、`Graph` 常在同一毫秒建出，翻页丢行，重试也读不回来。
- `task_type=` 是静默忽略的参数，没有服务端过滤。`keywords` 是关键字匹配，不是类型过滤，不用。
- `log_type=file` 是文档级日志，一页 1 244 342 字节，超过 D4 的上限，不用。
- `dsl.entries` 观察到恒为 1 项，多于 1 项未观察到（§14）。一律取同一类型全部日志的 `entries[].doc_id` 并集，两种情形都成立。
- `dsl.entries[].variants` 随配置变，两种都开时都是 `["structure","tree"]`，不用来判类型。

对开着的每种类型，按次序判定：
1. 有文档处于 `CREATED` / `SCHEDULED` / `RUNNING` / `STOPPING`，或该类型有 `operation_status` 为 `RUNNING` 的日志：`running`。
2. 有文档 `FAILED`：`failed`。
3. 除 `COMPLETED` 且 0 切片的文档外（这种文档编译不运行，表 C），其余文档非空，且每份都出现在该类型 `DONE` 日志的 `dsl.entries[].doc_id` 并集里：`done`。
4. 其它：`pending`。

`failed` 只来自文档 `FAILED`。图谱失败、模板组缺失、缺省嵌入模型缺失都表现为文档 `FAILED`（§5.4）。失败文档分不出类型，所以两个开着的类型都 `failed`；解析器失败也算，这份文档确实没有编译。`operation_status` 的失败值未观察到（§14），不判定；未知取值落入 `pending`。

**已知限制：RAPTOR 可能完全无信号。** 对话模型失败（密钥无效、实例已删除）时，文档照常 `COMPLETED`、有切片，编译状态 `idle`，任务日志没有记录（§5.4）。这时 `raptor` 停在 `pending`：没有信号所以不声称 `failed`，也不声称 `done`。第 3 步要求逐份文档被覆盖，所以中途才坏掉的情形同样不会显示 `done`。web 显示 `尚未产出`，并如实写明可能的原因（D19）。文档阶段的这个失败在 RAGFlow 里只有容器日志，本系统读不到。

**代价**：每个开编译的库读一次文档列表；有文档在排队或解析时第 1 步已定，不读任务日志；否则逐页读完。一份文档一种类型一条日志，500 份两种类型 1000 行，约 10 页，一页 87 096 字节（§5.3、§8.3）。判定 `done` 要看到每份文档，所以不能提前停。这些读取共用列表的 5 s 总期限，读不完时 `compile` 为 `null`，web 显示 `状态未知`，不影响列表本身。

**翻页期间有写入**（§14 未测）：`id` 不随时间递增，新日志可能插到已读的页之前，这次读可能漏一行。漏掉的结果是第 3 步少覆盖一份，显示 `pending`，不会错报 `done`，下一次读取修正。`page_size` 在 200 行以上的上限未测（§14），取 100 不依赖它。

组 1 结论为「支持」（记录 §5），D14 原有的停止条件未触发，已删去。

### D15 审计

七种 kind 与各自 detail 的精确键集以 knowledge-bases「知识库审计」的表为准，本节不另写一份。要点：
- 每条成功审计与它对应的那一次本地写入同事务：工作空间入库按文档逐条，不写整批汇总。
- 探活归 `kb.settings`（`{probe}`）。
- 重建器写的单库记录，actor 为 `kb_settings.rebuild_actor_id`。

### D16 共用开发栈的使用纪律

- 共用栈已存在：运行 `v1.0.0-rc2`，`DOC_ENGINE=infinity`，arm64 开发机的 Infinity 走 x64 模拟。它由 agent 按 owner 授权部署过一次（2026-11-01，#33），授权只覆盖那一次。
- 本仓不提交任何 RAGFlow 栈定义，agent 任务与本仓脚本不执行 `docker compose up` / `down` / `restart`，不改栈的配置文件与环境。
- **owner 前置**：Stage 5 建了一个由 owner 持有的前置 issue P（tasks「外部前提 P」，已完成），内容是：共用栈运行 `v1.0.0-rc2`；在 RAGFlow 界面注册 open-workbuddy 专用账号并生成 API key；key 文件以 `0600` 放在仓库之外；在本机 `CLAUDE.local.md` 新建一节，记下 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` 与实测用的嵌入上游变量名，并在 shell 环境里 export 它们。picker 只跳过 epic 与 `Depends on` 仍开着的 issue，不认标签，所以 P 的正文写一行 `Depends on #<Epic>`：agent 永远选不中 P，由 owner 做完后手动关闭。组 1 `Depends on` P。
- **执行时检测**：需要真实 RAGFlow 的任务只有组 1，含 1.5（组 18 的 `smoke-kb` 接线只需 harness 验证，真实运行是 owner 执行的验收行 CK-11）。组 1 从 shell 环境读这两个变量，区分两种停止：
  - 变量未设置或 key 文件不存在：报告 `RAGFlow 私有配置缺失`。
  - 版本接口不可达或不是 `v1.0.0-rc2`：报告 `共用 RAGFlow 栈未运行或版本不符`。
  
  两种都在 issue 评论里报告原因，不开 PR，不自己拉起任何容器；同时在本 issue 正文加一行 `Depends on #<P>` 并重开 P（评论写明要 owner 做什么），picker 随即跳过本 issue，直到 owner 再次关闭 P。检测时另执行一次只读的 `docker compose ls`，结果记进评论（grill #4，只作观察）。
- **账号隔离**：在共用栈上只用专用账号，所以 dsh-team 的库与模型配置天然隔离。实测只清理本次运行自己建的数据集、画布与模板组（名称前缀 `owb-`）；smoke 只经 app-server 删除它自己建的知识库，含上一次中断留下的同名库。
- **清理次序**（§13、§16）：先删数据集、画布、模板组，静默到没有编译活动，才清账号缺省、删实例与提供方。实测里曾在账号缺省已清空时解析文档，使全栈唯一的入库进程崩溃循环。此后任何实测都不得在有 pipeline 数据集或待合并任务时清空缺省。建 pipeline 数据集之前要确认两个缺省都在（`GET /api/v1/models/default` 同时有 `chat` 与 `embedding`）。补测的清理次序照记录 §16：账号缺省保持不动，先删数据集、画布、模板组，静默之后才清缺省、删实例与提供方。
- **脱敏**：仓库是 public。实测记录、PR 与 issue 正文中，地址一律写 `<RAGFLOW_BASE_URL>`；id、邮箱、昵称、账号名与 key 路径全部替换。组 1 的 PR 附 gitleaks 与 grep（本机地址、账号名）零命中的输出。

### D17 测试与夹具

`server/test/support/fake-ragflow.mjs`（+ `.d.mts`）是进程内可起的假 RAGFlow。它的行为分两类，评审时分开看：
- **协议应答**：路径、字段、状态值与错误 code（含表 B 的「不存在」组合），都以组 1 的实测记录为准，在记录里有对应条目。下载的文件内容可设为恰等于 not-found 正文，这也是协议应答（§9.1）。
- **故障注入**：用例显式脚本化的异常，可以不在记录里，只限四种：
  - 传输层失败：挂起、「挂起后放行」（并发用例用）、超时、连接失败、中途断开。
  - HTTP 层：3xx、5xx、非 JSON、超体积。
  - 漂移值：不符的版本串、八种之外的 `ingestion_status`。
  - 防御性组合，记录里没有、本系统按防御写法处理的情形：
    - 未观察到的路由上的 `code:403`（D4）；
    - 同一路由上别的 `100`、`101`、`102`；
    - `DELETE /datasets` 回 `{code:0, data:{deleted:[]}}`：这是 §4.6 里空 `ids` 的应答形状，本系统不发空 id，到不了这里，缺 `success_count` 走 `kb_unavailable`；
    - 内置 pipeline 不带 `graph`，或不是恰一个 chunker：记录里全部内置模板都带 `graph`、都恰一个 chunker（§5.1 (3)），D9 的校验是防御性的。

记录请求：方法、路径、查询串、是否带 key、JSON body、multipart 字段与字节数。

能力按组逐步加：
- 组 5：骨架，版本、数据集的建与删、文档的上传 / 删除 / 解析 / 停止 / 下载，含 `code:500`、`success_count:0`、`deleted:0`、表 B 组合与 §9.1 的响应头。
- 组 8：模型提供方接口与账号缺省模型。
- 组 9 第二刀：内置模板、模板组、内置 pipeline（各模板的节点名与下游取自 §5.1 (3)）、画布与 `parse_type:2` 数据集。
- 组 11：文档列表的分页、`orderby` 与八种运行状态。
- 组 9 第三刀：任务日志，按 §5.3 实现 `orderby=id`、`page_size`、`total`、越界页回空 `logs`，`task_type=` 不过滤。

每组的任务写明它加什么，协议应答都要在实测记录里有对应条目。下载始终带 `Content-Length`，夹具不做分块传输：记录里没有，且本系统不依赖它（D8）。夹具不实现清空缺省与删除模型配置的路由；这些路径的请求会落到夹具的未知路由并使用例失败，这正是 D7 不变量的断言方式之一。

单元与集成用例全部打假 RAGFlow。真实 RAGFlow 只进 `make smoke-kb`（`smoke/kb.hurl`，变量照 `smoke-live` 的写法：调用方自带已接上真实 RAGFlow 的运行中服务）与验收清单。

### D18 模块划分与行数

`server/src/kb/` 下的文件，每个 ≤800 行：

| 文件 | 内容 |
|---|---|
| `config.ts` | 四键解析，#1839 已落地 |
| `key-file.ts` | `kb_key` 阶段的读取与校验，#1839 已落地 |
| `ragflow-client.ts` | 唯一出站点 |
| `multipart.ts` | 出站 multipart 的长度计算与流拼接 |
| `store.ts` | 本地三张表 |
| `locks.ts` | 写锁与设置锁，#1837 已落地 |
| `settings.ts` | 设置、下发、身份判定、models 钩子 |
| `rebuild.ts` | 重建器 |
| `bases.ts` | 建库与删库 |
| `source-file.ts` | 工作空间来源的打开与 stat，组 10 建 |
| `documents.ts` | 组 10 建（含 D13 的文档删除写法）；组 11、13 扩展 |
| `uploads.ts` | 本地上传 |
| `templates.ts` | 十一种模板、`parser_id` 映射与后缀表 |
| `pipeline.ts` | 模板组与画布的建与删、DSL 生成，组 9 第二刀建 |
| `compile-status.ts` | 编译状态判定，组 9 第三刀建 |
| `rest.ts` | 路由与归属身份 |
| `index.ts` | 模块入口 |

800 行上限同样适用于测试文件（`size-guard.sh` 扫描 `server/test`）。

`server.ts` 现为 755 行：#1835 已把 DB 文件准备函数移进 `startup-registry.ts`，#1839 已加四键配置与 `kb_key`。本 change 还要往里加：
- `STARTUP_MODULES` 加 `kb`（组 6）。
- 重建器的启动与关停各一次调用（组 14）。

合计约 3 行，余量足够。`server-config.test.ts` 正好 800 行，本 change 不往里加用例，四键的解析用例在 `kb-config.test.ts`。

`server-assembly.test.ts` 已由 #1835 拆出 `server-assembly-modules.test.ts`（529 与 322 行），组 6 改后者。

`auth-lifecycle.test.ts` 797 行，它的码表 `describe`（`:705-770`）加 12 码必超 800。组 6 首刀先把这段 `describe` 纯移动到新文件 `server/test/http-error-codes.test.ts`，断言不改，再加码（tasks 6.2）。

`app.ts` 只加一次注册与 `modelWriteGuard` 的传递。

### D19 web

- `web/src/lib/api-kb.ts`：状态、设置、知识库、文档、上传的客户端，全部严格解析（`hasExactlyKeys`），形状以两份 spec 写明的应答为准。
- 中心「知识库」tab：`key: "knowledge-bases"`，`adminOnly: false`，排在 `连接器` 之后、`模型` 之前。只在 `GET /api/kb/status` 为 `enabled:true` 时进入可见 tab 表；描述不变，只连接无条件对所有人可见的 tab。
- `available:false` 只有一条规则：中心「知识库」tab 只显示不可用提示与 `重试`。模型 tab 的「知识库模型」段不看 `available`，只看 `enabled`：它读本地设置，RAGFlow 不可达时保存失败，显示信封文案。
- `删除知识库` 在列表行上，由组 15 交付，`rebuilding` 时不渲染。
- 新建对话框：模板十一种；`RAPTOR` 与 `知识图谱` 复选只看 `compileReady`，不再按模板区分。
- 编译状态文案：`pending` 为 `尚未产出`，`running` 为 `编译中`，`done` 为 `已完成`，`failed` 为 `有文档失败`，`null` 为 `状态未知`。`尚未产出` 旁注 `解析完成后长时间没有变化，可能是知识库对话模型不可用，请联系管理员`（D14 的已知限制）。不写「编译失败」：这个状态没有失败信号。
- 模型 tab 加「知识库模型」段：
  - 嵌入模型：名称、上游地址、密钥、探活。
  - 知识库对话模型：从带上游的对话模型里选，或选 `不使用`。有开编译的库且已指定时，下拉禁用，旁注写明原因（D7）。这时重发对话模型的入口是保存一次嵌入模型（D7「保存」）。
  - 重建状态与 `重试失败的重建`。
  - 更换嵌入模型时先弹确认，写明受影响的知识库数与文档数；确认后带 `confirmRebuild:true` 再保存。
- 删除被引用的对话模型时，409 `kb_model_in_use` 的信封文案沿用模型表既有的行内 409 显示。
- 移出得到 409 `kb_document_busy` 时，行内显示信封文案，行仍在。

### D20 写锁与设置锁

app-server 是单进程，也是 SQLite 的唯一写者，所以进程内锁足以串行化。

**每库写锁**（`kb/locks.ts`，#1837 已落地）：
- 持锁的操作：工作空间入库整批、本地上传、重新入库、移出、删库，以及重建器处理该库的全程。
- 写操作先做一次不持锁的状态快判：当前 `state` 不允许本操作即时 409 `kb_rebuilding`（移出与删库在 `rebuild_failed` 时允许，见 D8）。取锁后再重判存在性、`state` 与文档数上限。
- 快判到取锁之间不得 `await`：`locks.ts` 的准入是同步的，到达次序就是调用次序。中间让出事件循环，别的请求可以插到前面，先到先得与「重建中立即拒绝」都不再成立。
- 锁正被重建器持有时，不排队，直接 409 `kb_rebuilding`。
- 重建器取锁后先重读库行：库已删除或不再是 `rebuilding` 即跳过，不会为已删的库建数据集。

**进程级设置锁**：
- 持锁的操作：`PUT /api/kb/settings`、探活写回、重试重建、建库，以及 `models` 钩子的整段（引用判定、重新下发与 `models` 写入；删除的引用判定同样在内）。
- 保证「先下发、后写库」的两步不与另一个写者交错（R2-19e）。
- 两把锁都按到达次序交锁（FIFO）：「联动与设置交错」「删除与设置交错」中 B、A 依次排在锁后的次序由此确定；`locks.ts` 暴露当前等待者计数供测试确认 B 已在排队、再发出 A。

**调用方纪律**：
- 锁不可重入。持锁期间调用的函数（`createPipeline`、`deletePipeline`、D13 的文档删除写法、下发序列）都不再取同一把锁，否则自己排到自己后面，永远等不到。
- 两把锁不嵌套：持设置锁的路径不取写锁，持写锁的路径不取设置锁，所以没有锁序问题。

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
| 假 RAGFlow HTTP 服务（`fake-ragflow.mjs`） | 出站请求的形状（multipart、key、期限、重定向、下载判别、三段式 `embedding_model`、模型下发的请求序列）与并发交错（挂起后放行）由它记录与驱动；协议以组 1 的实测为准 |
| DSL 生成函数（`kb/pipeline.ts`，输入内置 DSL 与模板组 id，输出画布 DSL） | 省掉 `graph` 或改错边时 RAGFlow 回 `code:0`、编译静默不运行（§18 #25），假 RAGFlow 也不会替你报错；期望值取自记录 §5.1 (6) 手写 DSL 的 `components` 与 `graph` |
| web 组件（jsdom + 假 `ApiClient`） | 中心「知识库」tab 与模型 tab 的知识库模型段 |
| `make smoke-kb`（真实 RAGFlow） | 唯一证明对 rc2 的映射成立的 seam，含一个开编译的库，是 DSL 对真实 RAGFlow 的唯一验证；只在本机与验收 |

## Not yet specified

- 大批量入库（一次几十上百个文件、目录整体入库）的交互与限流。S2a 只给逐个选文件、每次至多 `KB_UPLOAD_MAX_FILES` 个。
- RAGFlow 数据集与本地映射长期漂移的对账手段，包括 RAGFlow 侧被人手工删改，以及建数据集、画布、模板组或上传后、插行前进程崩溃留下的孤儿。切换提交之后、旧一代删完之前崩溃留下的旧一代同属此类（D8）。S2a 只在列表时把找不到的文档标 `missing`，并在重建时跳过缺失的原件。
- 保留开编译的库而更换知识库对话模型：要重新固化 `llm_id`，需要一次针对这些库的重建。S2a 里 `chatModelId` 被锁定，要换只能先删掉这些库（D7）。
- 对话模型失败时 RAPTOR 的显式信号：rc2 没有，S2a 只保持 `pending`（D14）。
- 取消指定之后，RAGFlow 里残留上游密钥的清理入口。S2a 留给下一次下发或运维（D7）。
- 已有 pipeline 数据集时，账号缺省在 RAGFlow 侧被人手工清空。`createPipeline` 的前置读取只挡建库与重建（D7），对已有 pipeline 库的入库、上传与重新入库不读缺省，这时触发解析仍会走到 §13 的崩溃循环。D16 的清理次序是这条路上唯一的防线。
- 真实权限错误的形状：单账号造不出（§14），D4 的 `code:403` 是防御性判定。

## Risks / Trade-offs

- [rc2 是预发行版，rc3 / GA 可能改接口] → 版本钉住（D5），升级是代码变更，重跑组 1 的实测与 `make smoke-kb`。
- [HTTP 参考文档与运行实例不符（`chunk_method`、`chunk_count`、`/me/models`、编译开关）] → 以实测记录为准，假 RAGFlow 协议只按记录写。
- [清空账号缺省对话模型使全栈唯一的入库进程崩溃循环，外部看不出异常] → D7 的不变量：客户端没有清空与删除调用，用例断言请求序列；`createPipeline` 先读账号缺省，缺失时不建；D16 的清理次序约束实测与运维。已有 pipeline 库的入库路径没有这层读取，见 Not yet specified。
- [`code:0` 掩盖失败（`success_count:0`、`deleted:0`、DSL 省 `graph`、`parser_config` 开关被丢弃、静默换解析器）] → D4 的路由专属组合、D9 的 DSL 校验、D10 的后缀判定；`make smoke-kb` 对真实 RAGFlow 走一遍编译。
- [对话模型失败时 RAPTOR 完全无信号] → `pending` 加如实的文案（D14、D19），已知限制，不声称失败或完成。
- [`chatModelId` 被开编译的库锁定，模型下线时只能删库重建] → 明确的 409 与界面旁注；更换路径列入 Not yet specified。
- [共用栈可能不在跑、版本不同或被重置] → 只有组 1 依赖它，检测不满足就停下，并以 `Depends on #<P>` 加重开 P 让 picker 跳过；`make smoke-kb` 的真实运行是 owner 的验收行；CI 不依赖它。
- [RAGFlow key 权限覆盖全部知识库] → key 只在 0600 文件与进程内存。RAGFlow 只在内网，部署要求它不对用户网络暴露（ADR-0016）。omp 的 bash 能直连本机端口，但没有 key 就调不动 RAGFlow 的鉴权接口；`/system/version` 无鉴权，暴露的只有版本串。
- [嵌入模型更换的全量重建耗时长，期间不能入库] → 确认对话写明影响面；失败可重试；可以删失败的库，也可以先移出出问题的文档。开编译的库重建时重跑编译，入库 worker 只有 1 个，耗时更长。
- [重建中途进程崩溃] → 启动时从头续做该库，先删残留的新一代；actor 取持久化的 `rebuild_actor_id`。
- [模型上游密钥下发后存在 RAGFlow 的库里] → 与 ADR-0008「omp 环境零凭证」不冲突（RAGFlow 不是 omp）；轮换经 #28 的联动同步；取消指定后密钥留在 RAGFlow，直到被覆盖或运维清理（D7）；ADR-0016 随组 8 改写。
- [重建持有每库写锁，期间该库的写请求一律 409] → 这正是 grill #19 的「重建中暂停入库」。
- [下载判据只在直连实例上验证过] → 中间代理剥掉 `Content-Disposition` 时下载判为失败，不会把错误应答当文件上传（D8）。
- [后缀表来自 Parser 节点，不是逐个上传验证的] → RAGFlow 回 `code:500` 时单条拒绝，不中止整批；升级版本时重核表 C。

## Migration Plan

- 迁移 050 只建三张表并插入 `kb_settings` 的唯一一行；不改既有表。回退代码时保留迁移文件（账本拒收多出的回执，规则同 049）。
- 部署：未配 `RAGFLOW_BASE_URL` 时，行为与本 change 之前一致：知识库 tab 不出现，端点 503 `kb_disabled`，`models` 的删除与修改不受联动影响。
- 回滚：去掉两个 RAGFlow 键即关闭知识库；RAGFlow 里的 `owb-` 数据集、画布与模板组由运维按需清理，账号缺省模型要等它们删完、编译静默之后才能清（D16）。
- `kbservice/` 删除不可由配置回退；需要时从 git 历史恢复。

## Open Questions

无。dsh-team 共用栈的版本与 `DOC_ENGINE` 已由 #33 定：`v1.0.0-rc2`、`infinity`。
