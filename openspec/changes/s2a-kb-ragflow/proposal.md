# Proposal: s2a-kb-ragflow

> Issue type: feature（P2 第一刀：知识库建库与摄取；方向变更：知识库后端由「吸收 RAGFlow 源码组装 kb-service」改为「对接运行中的 RAGFlow 服务」）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明）
> Blast radius: 新增出站依赖 RAGFlow v1.0.0-rc2（HTTP API，单一服务账号）；`kbservice/` 包与 Python 工具链整体退役（Makefile、CI 两个 job 的 uv / ruff / pytest 步骤、控制面 oracle、size-guard / jscpd 路径）；迁移 050；四个配置键与一个读密钥文件的启动阶段；第十二个启动模块 `kb`；六个错误码；七条 content-parser 归属身份；`/center` 多一个对所有人可见的「知识库」tab；`模型` tab 多「知识库模型」一段
> Evidence floor: `npm test --workspace server`、`npm test --workspace web`、typecheck、size-guard、`make check`、`make test-guardrails`、`make ui-walk`；真实 RAGFlow 只在本机 `make smoke-kb` 与验收走一轮（不进 CI 必需检查）
> 依赖：建在 `s1d-model-registry`（`models` 表、管理员端点与探活的写法）、`s1b-workspace-mounts`（挂载内文件的读取与离线判定）与 S1g 上传（裸 octet-stream 流式上传的写法）之上；迁移编号 050。

## Why

`IMPLEMENTATION_PLAN.md` S2a 要求知识库的建库、12 种切片模板加 RAPTOR / 知识图谱开关（F-CTR-KB1）与文档摄取及状态（F-CTR-KB2）。原计划（ADR-0002）是把 RAGFlow 的 Python 线吸收进本仓 `kbservice/`，先做一周 spike 验证 api.db 解耦、Infinity 接入与 deepdoc 模型本地化。

2026-10-28 grill（owner 逐分支拍板，凭证见 design「Grill 结论」）推翻了这条路：RAGFlow v1.0 已经用 Go 重写（rc1 起），资源占用大幅下降，rc2 有 arm64 原生镜像；另一个本机项目 dsh-team 也要跑 RAGFlow。改为把 RAGFlow 当作外部服务：app-server 的 `kb` 模块用单一服务账号直连它的 HTTP API，租户、可见范围与审计仍全在 app-server；`kbservice/` 退役。吸收源码的 spike 随之作废，换成对 rc2 接口的实测（第一组任务），其结论钉住假 RAGFlow 夹具的协议。

## What Changes

- **方向变更文档**：新 ADR-0016「知识库以 RAGFlow 服务为后端」取代 ADR-0002；ADR-0005 补充（Infinity 经 RAGFlow 的 `DOC_ENGINE` 配置）；`ATTRIBUTION.md` 的 RAGFlow 条目改为「部署而非吸收」；`CONTEXT.md`（kbservice 术语、不变量 4 的措辞）、`PLAN.md`、`IMPLEMENTATION_PLAN.md`（S2a 改写、S2b / S2c / S4b 的连带调整、Next Step 更新）、`docs/architecture/system.md`。
- **rc2 接口实测**：对 dsh-team 所有的共用 RAGFlow 栈（只复用，绝不 up / down / 改配置）核实建库、12 种模板、上传、解析、状态、原件下载、删除、嵌入模型约束、模型下发、RAPTOR / 知识图谱触发与错误码；结论写成接口实测记录，钉住假 RAGFlow 协议。
- **kbservice 退役**：删 `kbservice/` 与全部 Python 工具链引用（`verification-harness` 的 CI 接线与 action 清单随之改）。
- **配置**（四键）：`RAGFLOW_BASE_URL`（缺省未配置，即知识库关闭）、`RAGFLOW_API_KEY_FILE`（配了地址必填；属主为本进程 uid、mode `0600` 的普通文件）、`KB_UPLOAD_MAX_BYTES`（缺省 104857600）、`KB_UPLOAD_MAX_FILES`（缺省 10）。新启动阶段 `kb_key` 读密钥文件；配置错误启动失败，RAGFlow 不可达不阻断启动。
- **迁移 050**：`kb_settings`（单行：知识库嵌入模型的名称、上游地址与密钥、嵌入代数、知识库对话模型 → `models(id)`）、`knowledge_bases`、`kb_documents`。
- **`kb` 模块**（第十二个启动模块）与 RAGFlow 客户端：出站规则（期限、不跟随重定向、响应体上限、按 body `code` 判成败）、`GET /api/kb/status`。
- **知识库模型设置**（管理员）：`GET` / `PUT /api/kb/settings`、`POST /api/kb/settings/probe`；嵌入模型全局唯一，由 app-server 下发到 RAGFlow 服务账号（rc2 不支持下发时按 design D7 的退路改为运维在 RAGFlow 手配）；更换嵌入模型须确认，确认后自动全量重建（`POST /api/kb/settings/rebuild` 重试失败的库）。
- **知识库端点**：`GET` / `POST /api/kb/bases`、`DELETE /api/kb/bases/:id`；模板与 RAPTOR / 知识图谱开关建库时固定；S2a 的知识库只对所有者可见。
- **文档端点**：`GET` / `POST /api/kb/bases/:id/documents`（工作空间来源，经沙箱 `resolve(read)` 读后上传，含只读挂载）、`POST /api/kb/bases/:id/uploads`（本地上传，只存 RAGFlow）、`POST /api/kb/bases/:id/documents/reingest`、`DELETE /api/kb/bases/:id/documents`；状态以 RAGFlow 为准、列表时按需读取；工作空间来源记入库时的大小与修改时间，变了就标「源文件已变更」。
- **审计**：`kb.create`、`kb.delete`、`kb.ingest`、`kb.ingest_reject`、`kb.document_delete`、`kb.settings`、`kb.rebuild`。
- **web**：中心「知识库」tab（知识库未配置时不渲染）；`模型` tab 的「知识库模型」段。
- **验证**：仓库自有假 RAGFlow 夹具；`make smoke-kb`（对调用方已运行、已接上真实 RAGFlow 的服务）；验收清单新节「中心·知识库（CK）」。

## Capabilities

### New Capabilities
- `ragflow-backend`: RAGFlow 接入——配置与密钥文件、可用性（未配即关、不可达不阻断）、出站规则与结果映射、`GET /api/kb/status`、共用开发栈的使用纪律、知识库模型设置与下发、嵌入模型更换与全量重建。
- `knowledge-bases`: 知识库与文档——迁移 050、知识库端点、模板与 RAPTOR / 知识图谱开关、工作空间来源入库与本地上传、状态读取、源文件变更提示、移出与删除、审计、中心「知识库」tab。

### Modified Capabilities
- `model-registry`: 「中心页外壳」（tab 表加 `knowledge-bases`，按知识库开关显隐；描述规则不变）、「模型 tab」（加「知识库模型」段）。
- `http-service-skeleton`: 「服务启动与装配」（四个配置键、阶段 `kb_key`、模块 `kb`）、「统一错误信封」（六个错误码、七条归属身份）。
- `verification-harness`: 「CI 接线与控制面同步」（`fast-checks` 与 `unit-tests` 去掉 uv / ruff / pytest 步骤）、「第三方 CI action 使用 Node 24 runtime」（action 清单去掉 `astral-sh/setup-uv@v7`）；新增「知识库真实端点冒烟」。

## Impact

- 服务端：新 `server/src/kb/`（config、ragflow-client、store、settings、bases、documents、uploads、rebuild、rest）、迁移 050、`startup-registry.ts` 的 `kb_key` 阶段、`app.ts` 注册第十二个模块、`core/errors` 六码、`http/errors.ts` 归属集。
- 前端：新 `web/src/features/center/kb/`、`web/src/lib/api-kb.ts`、`tabs.ts`、模型 tab 加一段。
- 测试夹具：`server/test/support/fake-ragflow.mjs`（协议以第一组的实测记录为准）。
- 退役：`kbservice/`、Makefile / CI / 控制面 oracle / size-guard / jscpd / `.gitignore` / `constraints.yaml` / `AGENTS.md` / `openspec/project-profile.md` 中的 Python 工具链引用。
- 部署：S4b 单机包改为带 RAGFlow 全栈（Docker、内存门槛与 Apache-2.0 / NOTICE 义务见 ADR-0016）。
- 外部：开发期依赖 dsh-team 所有的共用 RAGFlow 栈（rc2）；本仓任何脚本都不拉起、不停止它。
