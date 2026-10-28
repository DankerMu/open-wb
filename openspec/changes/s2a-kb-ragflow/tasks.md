# Tasks: s2a-kb-ragflow

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组一个子 issue、一个 PR（宽度门禁另拆的除外）。
> 依赖（真实依赖）：
> - 无前置：组 1、2、3、4、7。组 1 另有外部前提：dsh-team 的共用栈已运行 `v1.0.0-rc2`，且 open-workbuddy 专用账号与密钥文件已就绪。
> - 组 5 ← 1（夹具协议以实测记录为准）。组 6 ← 4、5。组 8 ← 6、7。组 9 ← 1、8。
> - 组 10 ← 9。组 11 ← 9。组 12 ← 10（复用出站 multipart）。组 13 ← 10。组 14 ← 8、10。
> - 组 15 ← 9。组 16 ← 10、11、12、13、15。组 17 ← 8、14、15。
> - 组 18 ← 3 及 5–17 全部。
>
> 通用纪律：
> - 测试先行；每组第一个任务核对 design「Context」的行号与事实（主干在本 change 开工后可能已移动）。
> - 密钥、文件内容与 RAGFlow 应答原文不进任何响应、审计、日志。
> - 产品代码单文件 ≤800 行，`server.ts` 现 799 行：新增装配一律落在 `startup-registry.ts` 或 `kb/`，`server.ts` 只加必需的展开与调用；余量不足时先把一段既有装配挪出去，同 PR 说明。
> - 不新增 `.css`。
> - 需要真实 RAGFlow 的只有组 1 与组 18，执行前按 design D16 检测共用栈；不满足即停下，在 issue 里报告，不拉起任何容器。
> - 改变用户可见行为的组在同一 PR 增改验收行并写 `待签`（AGENTS.md:169-170）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（RAGFlow 密钥、嵌入 / 对话上游密钥进响应、审计、日志、omp 环境） | 是 | 组 4 密钥文件与 omp 环境用例、组 5 请求记录、组 8 视图与审计哨兵 |
| 沙箱越界（入库读取绕过 `resolve`、跟随符号链接、读挂载离线） | 是 | 组 10、组 11、组 13 |
| 两份真相（本地映射 vs RAGFlow 数据集 / 文档） | 是 | 组 9 建库失败回滚、组 11 `missing`、组 14 重建切换与续做 |
| 外部接口漂移（rc2 文档自相矛盾、预发行版） | 是 | 组 1 实测、组 5 夹具只按记录写、组 6 版本钉住 |
| 权限（他人知识库可探测、非管理员写设置） | 是 | 组 8、组 9 的 403 / 404 矩阵 |
| 迁移与 DB 约束 | 是 | 组 7 |
| 共用外部资源（dsh-team 的栈被拉起、停止或改配置） | 是 | 组 1、组 18 的检测与「不拉起」断言 |
| 控制面漂移（退役后 oracle 与 CI 不一致） | 是 | 组 3 |

## 1. rc2 接口实测（ragflow-backend「RAGFlow 接口实测记录」「共用开发栈的使用纪律」）

- [ ] 1.1 按 design D16 检测共用栈：`curl <RAGFLOW_BASE_URL>/api/v1/system/version` 可达且为 `v1.0.0-rc2`；专用账号的密钥文件为 `0600`。不满足即停下，在 issue 评论里报告「共用 RAGFlow 栈未运行或版本不符」，本组不继续。全程不执行任何 `docker` 写操作。
- [ ] 1.2 用专用账号的 API key 逐项实测并写 `docs/reviews/2026-10-28-ragflow-rc2-api.md`。每节写请求与应答摘录（去掉 key 与文件内容），并写结论「支持」或「不支持」：
  - 版本接口的应答字段；
  - 建数据集：十二种模板各建一次，记录字段名（`chunk_method` 还是 `parser_id`）与取值、`embedding_model` 的格式、RAPTOR 与知识图谱的开启方式与是否要显式触发、编译状态接口与状态取值；
  - `chunk_count` 非 0 时改 `embedding_model` 的应答；
  - multipart 上传：字段名，带 `Content-Length` 的流式体是否被接受；
  - 解析触发；文档列表的分页参数、运行状态取值与切片数字段；
  - 原件下载是否带 `Content-Length`；
  - 对不存在的文档 / 数据集删除与读取的应答；
  - 模型提供方 instance 与 `/me/models` 能否用 API key 配置，以及配置后能否以 `embedding_model` 引用；
  - 鉴权失败、参数非法、权限不足的 HTTP 状态与 body `code` 组合。
- [ ] 1.3 只删除本组建的 `owb-` 前缀数据集；在记录末尾写清理结果。记录里的「模型下发」与「编译开启」两节结论分别决定 design D7 的退路是否启用、D14 的停止条件是否触发：
  - 模型下发「不支持」：在 Epic 下评论，组 8 与组 17 按 D7 的退路实施（并实施 ragflow-backend「运维手配退路」）。
  - 编译开启「不支持」：停在本组并报告 owner（D14），组 9 的开关部分不开工。

Suggested fixture level: none - 只产出实测记录文档，不改产品代码；它是组 5 夹具的唯一协议来源。
Minimal mergeable slice: atomic - 一份记录、一次对同一实例的实测；拆开会让夹具协议来自两次不同的观察。

## 2. 方向变更文档（Grill 结论 1、10、11；design Context「方向变更」）

- [ ] 2.1 核对 Context：ADR-0002、ADR-0005、`ATTRIBUTION.md:24-26`、`CONTEXT.md:9,38,45,53`、`PLAN.md:21,32,47,94`、`IMPLEMENTATION_PLAN.md`（S2a / S2b / S2c / S4a / S4b 各节、覆盖表、Open Decisions、Next Step、What Already Exists）、`resource/backend-research.md:63,155-165`、`README.md:4,22`、`docs/architecture/system.md` §1–§7。
- [ ] 2.2 新 `docs/adr/0016-ragflow-service-backend.md`：
  - 决策：知识库以运行中的 RAGFlow 服务为后端，取代 ADR-0002；
  - 理由：v1.0 的 Go 重写与资源占用、rc2 的 arm64 镜像、多租户留在 app-server；
  - 后果：单一服务账号；密钥文件；RAGFlow 持有嵌入与知识库对话模型的上游密钥（与 ADR-0008 的区别）；RAGFlow 不对用户网络暴露；S4b 带 RAGFlow 全栈（Docker、内存门槛以官方要求为准）；Apache-2.0 / NOTICE 义务随部署包；版本钉住 `v1.0.0-rc2`；
  - 被否决的备选：吸收源码、保留 kbservice 薄层。
  
  另做：ADR-0002 头部加「已被 ADR-0016 取代」；ADR-0005 补充一段（Infinity 经 RAGFlow 的 `DOC_ENGINE`，ES 退路仍在 RAGFlow 侧）；`docs/architecture/system.md` §7 决策索引加 0016。
- [ ] 2.3 `ATTRIBUTION.md` 的 RAGFlow 条目改为「以服务形态部署，不吸收源码」，义务写为发行物含 RAGFlow 镜像时附其 LICENSE 与 NOTICE。
- [ ] 2.4 `CONTEXT.md`：
  - 项目本质里三个组件改为 app-server、web SPA 与外部 RAGFlow 服务；
  - 限界上下文「知识库」改为「app-server `kb` 模块 + RAGFlow」；
  - 不变量 4 改为「RAGFlow API 密钥与模型网关密钥不得出现在 omp 子进程可读环境」。
- [ ] 2.5 `PLAN.md` 的知识库三处改写，并互加对 ADR-0016 的引用。`IMPLEMENTATION_PLAN.md`：
  - S2a 一节改写为本 change（覆盖 F-CTR-KB1 / KB2 不变）；
  - S2b / S2c 的 kbservice 措辞改为 app-server `kb` 模块；
  - S4a 的回归对象去掉 kbservice；S4b 部署要求加 RAGFlow 全栈；
  - Open Decisions 的 deepdoc 一行关闭（随 ADR-0016 作废）；
  - What Already Exists 的 kbservice 一行改为「已退役（change s2a-kb-ragflow）」；
  - Next Step 更新到 2026-10-28：S1b、S1d 已交付，S2a 进行中。
- [ ] 2.6 `resource/backend-research.md` 头部加一行「§1 的吸收方案已被 ADR-0016 取代」；`README.md` 两处同步。

Suggested fixture level: none - 只改文档与 ADR。
Width exception: merged-tasks - 六个任务写的是同一个方向变更；分开合入会让主干在一段时间里同时有两套互相矛盾的知识库架构说明。
Minimal mergeable slice: atomic - 理由同上。

## 3. kbservice 退役（verification-harness「CI 接线与控制面同步」「第三方 CI action 使用 Node 24 runtime」）

- [ ] 3.1 核对 Context：design Context「主干现状」与 explorer 清单——Makefile:10,17-19,23,28,30,35；`.github/workflows/ci.yml:15,17,19,30,32,34,56,75`；`scripts/inspect-ci-workflow.js:11,17`；`scripts/test-ci-harness.sh` 中的 uv / kbservice 变异；`scripts/size-guard.sh:13,25`；`scripts/test-guardrails.sh:42-50`；`.jscpd.json:3,7`；`.gitignore:26-27`；`constraints.yaml:66,77,93`；`deploy/app/Dockerfile.dockerignore:10`；`AGENTS.md:36,38,47,57,143,145,146,175`；`openspec/project-profile.md:5,10,22,33,37,42`；`server/test/omp-process.test.ts:43,56`。
- [ ] 3.2 测试先行：`scripts/test-ci-harness.sh` 改写 oracle 期望——setup-uv 计数为 0；`unit-tests` 与 `fast-checks` 的步骤序列去掉 uv / ruff / pytest；加 verification-harness「Python 工具链退役后不可回潮」的三条变异（加回 setup-uv 加 ruff、加回 pytest、naming-guard / semgrep 路径加回 `kbservice`），各须非零。`scripts/test-guardrails.sh` 的 `.py` 样例改为 `.ts` / `.mjs` 样例，size-guard 的守卫能力不降。
- [ ] 3.3 删除 `kbservice/`。同步删改：Makefile、`ci.yml`、`inspect-ci-workflow.js`、size-guard（路径与 `*.py`）、jscpd、`.gitignore`、`constraints.yaml`（复杂度、覆盖率、死代码三行只留 Biome / vitest / knip）、dockerignore、`AGENTS.md`（栈表、工具、目录树、模块边界两行、验证矩阵三行）、`project-profile.md`。`omp-process.test.ts` 的哨兵名改为 `RAGFLOW_API_KEY_FILE`，断言语义不变。
- [ ] 3.4 `make check`、`make test-guardrails` 本机全绿；PR CI 全绿，`all-checks-passed` 的 needs 不变。

Suggested fixture level: compact - 改 CI 与控制面 oracle（CI/production configuration 触发项），但没有运行时行为变化。
Minimal mergeable slice: atomic - 删目录与删 CI 步骤必须同 PR：只删目录则 CI 的 `uv sync` 失败，只删步骤则 oracle 拒绝。

## 4. 配置键与密钥文件阶段（http-service-skeleton「服务启动与装配」的知识库键与 `kb_key`；ragflow-backend「知识库配置与密钥文件」）

- [ ] 4.1 核对 Context：
  - `resolveServerConfig` 与四十二项（`server.ts:129-146`）、`preview-config.ts` 中 `PREVIEW_ORIGIN` 的正则、`agent-config.ts` 中 `resolvePositiveInteger` / `assertHeaderSafeKey` / `resolveOwnedPath`；
  - `StartupStage`（`server.ts:330-344`）与 `server-startup-failure-reason.test.ts`；
  - `startup-registry.ts` 的阶段函数写法；`trash.ts:146` 的 mode 检查写法；
  - `OMP_CHILD_ENV_NAMES`（`spawn-env.ts`）。
- [ ] 4.2 测试先行。新 `server/test/kb-config.test.ts`：四键的缺省、配对规则、正则、正整数纪律，message 只含键名。新 `server/test/kb-key-file.test.ts`：普通文件、符号链接、`0644`、`0640`、空文件、4097 字节、去掉结尾 `\n`、含 `\r`、属主不符（无法造时用注入的 `getuid` 缝）。
  
  编译入口用例：
  - 加到 `server-startup-failure-reason.test.ts` 或新文件 `server-startup-kb.test.ts`：http-service-skeleton「知识库键与密钥文件阶段」的七例；`kb_key` 失败时 DB 文件不存在。
  - 加 ragflow-backend「密钥不进 omp 环境」：假 omp 记录 spawn 环境，断言没有任何值等于密钥、没有两个键名。
  
  同 PR 改钉住配置项数与阶段表的既有用例（4.1 核对时列全）。
- [ ] 4.3 新 `server/src/kb/config.ts` 与 `server/src/kb/key-file.ts`；`resolveServerConfig` 展开四键（注释的项数改为四十六）；`StartupStage` 加 `kb_key`；阶段函数放在 `startup-registry.ts`；`server.ts` 净增 ≤3 行。读出的密钥经装配传给组 6 的 `kb` 模块；本组只把它存进一个只读句柄，暂无消费者，用 `knip` 豁免注释说明，组 6 删掉该注释。
- [ ] 4.4 `docs/architecture/system.md` §9.13「知识库」新建，本组写配置键、密钥文件要求与 `kb_key` 阶段；§9.3 启动次序文字加 `kb_key`。

Suggested fixture level: expanded - 新配置键与凭证读取（credentials + production configuration）、新启动阶段。
Minimal mergeable slice: atomic - 配置解析与 `kb_key` 阶段是同一对键的两半：只有解析没有阶段，密钥文件从不被校验；只有阶段没有解析则无从得到路径。

## 5. 假 RAGFlow 夹具与 RAGFlow 客户端（ragflow-backend「RAGFlow 出站请求」）

- [ ] 5.1 核对 Context：
  - 组 1 的实测记录（全部路由、字段、状态值、code）；
  - `models/probe.ts` 与 `connectors/probe.ts` 的传输骨架；
  - `core/error-body.ts`、`core/upstream-failure.ts`；
  - `server/test/support/fake-upstream.mjs` 与 `fake-mcp-http.mjs` 的写法，及其 `.d.mts`；
  - `models-probe-helpers.ts` 的 `holdServer()` / `closedPort()`。
- [ ] 5.2 测试先行：新 `server/test/support/fake-ragflow.mjs` 加 `.d.mts`，只实现实测记录里出现的接口。可脚本化：版本串、按路由给 code / HTTP 状态 / 挂起 / 3xx / 非 JSON / 超体积；记录请求（方法、路径、是否带 key、JSON body、multipart 字段名与文件字节数）。附夹具自测。
  
  新 `server/test/kb-ragflow-client.test.ts`：
  - 「结果映射」表每一行各一例（期限经注入缩短）；
  - `kb_upstream_auth_failed` 在 60 秒内至多一行（注入时钟）；
  - 3xx 不跟随；响应体 1 MiB + 1 字节失败；
  - 版本请求不带 key、其余都带；
  - 结果对象与 stderr 不含假 RAGFlow 返回的 message 哨兵。
- [ ] 5.3 新 `server/src/kb/ragflow-client.ts`：JSON 请求、流式上传、流式下载三种调用，按 design D4；类型化结果；期限可注入。本组只交付客户端，不挂路由。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials），并定下全部知识库端点共用的失败映射。
Minimal mergeable slice: atomic - 夹具没有客户端就没有消费者，客户端没有夹具无法按规格验证；共一条验证路径。

## 6. `kb` 模块装配、状态端点与错误码（ragflow-backend「知识库可用性」「知识库状态端点」；http-service-skeleton「统一错误信封」）

- [ ] 6.1 核对 Context：
  - `core/errors/index.ts` 的二十五码与 `http/errors.ts` 的状态映射与三十一条归属身份；
  - `http-parser-owners.test.ts:28,174-178`、`http-typed-errors.test.ts:132-134`、`auth-lifecycle.test.ts:705` 的计数；
  - `STARTUP_MODULES` 与 design Context 列出的七处模块列表断言及 `server-assembly.test.ts` 的 `spyRegistrationOrder`；
  - `app.ts` 的 `registerConnectors` 位置与 `AssemblyDependencies`。
- [ ] 6.2 测试先行。
  - 新 `server/test/http-typed-errors-kb.test.ts`：「六个知识库码」。
  - `http-parser-owners.test.ts`：三十八条，含「知识库的归属路由」。七条身份在本组先登记，路由由组 8–13 注册；先例见 `http/errors.ts` 注释里 `POST /api/models/probe`。本组的用例只覆盖已注册的路由。
  - 新 `server/test/kb-status.test.ts`（`app.inject()` + 假 RAGFlow）：「未配置即关闭」「不可达不阻断」「版本钉住」；未登录 401；no-store。
  - 同 PR 改七处模块列表断言为十二项、最后为 `kb`，并在 `spyRegistrationOrder` 加 `registerKb`。
- [ ] 6.3 `core/errors` 加六码；`http/errors.ts` 的状态映射、归属集与计数措辞；新 `server/src/kb/index.ts` 与 `kb/rest.ts`。
  - `kb/rest.ts` 本组只有 `GET /api/kb/status`，以及 `/api/kb/*` 的关闭判定：preParsing 先于 body 解析返回 503 `kb_disabled`。
  - `app.ts` 在 `registerConnectors` 之后注册 `kb`；`STARTUP_MODULES` 加 `kb`。
  - 组 4 的密钥句柄交给 `kb` 模块，删掉 knip 豁免注释。
- [ ] 6.4 `system.md` §3.1 的 `kb` 行与 `core/errors` 行（三十一码）；§9.13 加状态端点、版本钉住与两条 stderr 记录。

Suggested fixture level: expanded - 改共享错误信封与装配（Fastify assembly/routes/hooks 触发项）。
Minimal mergeable slice: 六码与七条归属身份的登记（`core/errors` 加 `http/errors.ts`，带「六个知识库码」与三十八条计数用例）——码表与归属集是纯数据，先合不改变任何已注册路由的行为。剩余部分（`kb` 模块装配、关闭判定与状态端点，含七处模块列表断言）依赖它。

## 7. 迁移 050 与知识库 store（knowledge-bases「迁移 050 知识库 schema」）

- [ ] 7.1 核对 Context：
  - 迁移目录最后为 049；
  - `server/test/core-db-helpers.ts` 的 `TRACKED_MIGRATION_FILENAMES`、`COMPLETE_CATALOG`（回执与 `sequenceRows`）；
  - `auth-schema.test.ts:496-515` 业务表清单；
  - `core-db-session-fixture.ts:311` 的索引排除清单；
  - `core-db-chat-step-output.test.ts:75-93` 与 `migration-034.test.ts` 的 seed 过滤清单；
  - 049 头注的写法。
- [ ] 7.2 测试先行：新 `server/test/kb-store.test.ts`（`:memory:` + 真实迁移）。
  - 「约束」场景的五例；`kb_settings` 唯一行。
  - store 的：设置读写；知识库增删查（按 owner；50 上限）；文档增删查（500 上限）；`(kb_id, workspace_id, source_path)` 唯一；重建状态与 `rebuild_dataset_id` 读写；级联。
  - 同 PR 改上面列出的既有快照用例。
- [ ] 7.3 `050_knowledge_bases.sql` 与新 `server/src/kb/store.ts`（只读写本地三张表，不发出站请求）。

Suggested fixture level: expanded - 新迁移与凭证落库（persisted schema + credentials at rest）。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者，store 是三张表唯一的写入口。

## 8. 知识库模型设置与下发（ragflow-backend「知识库模型设置」，及组 1 结论为不支持时的「运维手配退路」）

- [ ] 8.1 核对 Context：
  - 组 1 实测记录的「模型下发」一节（决定实施主路径还是退路）；
  - `models/rest.ts` 的 `adminOnly` preParsing、`perIdChain`、审计包装；
  - `models/probe.ts` 的探活写法；
  - 组 6 的 `kb/rest.ts`、组 7 的 store。
- [ ] 8.2 测试先行：新 `server/test/kb-settings.test.ts`（`app.inject()` + 假 RAGFlow + 假嵌入上游；假嵌入上游复用 `fake-upstream.mjs`，或在本组给它加 `/embeddings`）。
  - 「下发失败不改设置」「非管理员」（`POST /api/kb/settings/rebuild` 本组先登记为 404 或不注册，403 一腿留到组 14）；
  - 键集与类型 400；首次缺 `apiKey` 400；`chatModelId` 不存在 400；
  - 视图不含密钥哨兵；审计 detail 不含哨兵；
  - 删除被引用的对话模型后 `chatModelId` 为 `null`；
  - 嵌入探活的 `ok` / `failed` 与写回；
  - 嵌入身份变化且已有知识库：一律 409 `kb_rebuild_required`。`confirmRebuild` 由组 14 开放，本组带了也 409，用例写明这一点。
  
  退路启用时改测 ragflow-backend「运维手配退路」除重建以外的部分。
- [ ] 8.3 新 `server/src/kb/settings.ts`（读视图、校验、下发、身份判定）；`kb/rest.ts` 加 `GET` / `PUT /api/kb/settings` 与 `POST /api/kb/settings/probe`。
- [ ] 8.4 `system.md` §9.13 加设置端点、下发内容与「RAGFlow 持有上游密钥」一句。

Suggested fixture level: expanded - 管理员写路径与凭证（Auth / credentials 触发项），并向外部服务推送凭证。
Minimal mergeable slice: atomic - 读视图、写入与下发共用同一套校验与审计骨架和一个用例文件；探活只多一条路由，复用模型探活的传输。

## 9. 建库与删库（knowledge-bases「知识库端点」）

- [ ] 9.1 核对 Context：组 1 实测记录的建库与编译两节；组 8 的设置读取（嵌入就绪、对话模型就绪）；demo 的 `kbMethods`（`resource/workbuddy-live-demo.html:1473-1486`）。
- [ ] 9.2 测试先行：新 `server/test/kb-bases.test.ts`。
  - 「建库与列表隔离」「开关校验」「删库」三个场景；
  - 名称规则；50 上限；重名 409；
  - 插行失败时删掉刚建的数据集（注入 store 失败）；
  - `rebuilding` 时删库 409；`rebuild_failed` 时删两份数据集；
  - `compile` 字段按实测的状态接口映射，读不到为 `null`；
  - 审计 `kb.create` / `kb.delete` 的 detail。
- [ ] 9.3 新 `server/src/kb/bases.ts`；`kb/rest.ts` 加 `GET` / `POST /api/kb/bases` 与 `DELETE /api/kb/bases/:id`；模板与编译支持表放 `kb/templates.ts`（web 用同一份数据另写一份常量，见组 15）。
- [ ] 9.4 `system.md` §9.13 加知识库端点与数据集命名 `owb-<id>`。

Suggested fixture level: expanded - 两份真相（本地行与 RAGFlow 数据集）的创建与删除顺序，以及所有权判定。
Minimal mergeable slice: atomic - 建库、列表与删库共用所有权判定、数据集命名与一个用例文件；编译字段是建库请求与视图的一部分，拆开会出现「能建带开关的库却读不到编译状态」。

## 10. 工作空间来源入库（knowledge-bases「工作空间来源入库」）

- [ ] 10.1 核对 Context：
  - 读文件链路：`workspaces/rest.ts:412`、`rest-archive.ts:108-146`、`mounts/path-rule.ts:43`、`mounts/files.ts:80,94,135,166`、`regular-file.ts:55`；
  - `workspaces` 模块现有的导出（只从入口导入，不深入子目录；缺读取函数就在 `workspaces/index.ts` 加最小导出，同 PR 说明）；
  - 组 1 的 multipart 字段与解析触发；
  - 如实测要求显式触发编译，记下触发点。
- [ ] 10.2 测试先行：新 `server/test/kb-ingest-workspace.test.ts`。
  - 「混合批次」「挂载离线」两个场景（挂载用 S1b 的测试缝）；
  - 符号链接被拒；`paths` 为空或超过上限 400；
  - RAGFlow 中途不可达时已上传的保留、其余列入 `rejected`；
  - 知识库非 `ready` 时 409；
  - 上传字节与源文件一致，multipart 的 `Content-Length` 等于实际字节；
  - 审计种类与 `reason` 枚举。
  
  新 `server/test/kb-multipart.test.ts`：长度计算与流拼接，含非 ASCII 文件名。
- [ ] 10.3 新 `server/src/kb/multipart.ts` 与 `kb/documents.ts`（入库部分）；`kb/rest.ts` 加 `POST /api/kb/bases/:id/documents`。实测记录要求显式触发编译时，在本组的解析触发之后对数据集触发一次。
- [ ] 10.4 `system.md` §4 依赖规则加 `kb → workspaces`（经入口）、`kb → models`；§9.13 加入库流程与拒绝原因。

Suggested fixture level: expanded - 读路径经沙箱 `resolve` 与挂载（Critical Path：沙箱越界），并向外部服务上传用户文件。
Minimal mergeable slice: atomic - multipart 只有入库一个消费者（组 12 复用它在后），入库没有 multipart 就无法上传。

## 11. 文档列表与状态（knowledge-bases「文档列表与状态」）

- [ ] 11.1 核对 Context：组 1 的文档列表分页与运行状态取值；组 10 若已合入，复用其读取链路的 stat 部分（未合入则本组先抽出 stat 函数，组 10 复用）。
- [ ] 11.2 测试先行：新 `server/test/kb-documents-list.test.ts`。
  - 文档行由 store 直接插入；
  - 「状态映射」「源文件变更」两个场景；
  - 挂载离线时 `sourceChanged: null`；
  - 超过一页时分页读全；
  - RAGFlow 不可达 503；
  - 读取不产生审计。
- [ ] 11.3 `kb/documents.ts` 加列表与 `sourceChanged`；`kb/rest.ts` 加 `GET /api/kb/bases/:id/documents`。

Suggested fixture level: expanded - 读路径经沙箱 `resolve` 与挂载（stat），且是本地映射与 RAGFlow 状态的关联点。
Minimal mergeable slice: atomic - 一条路由、一个视图，状态映射与源文件变更都是同一个 `DocumentView` 的字段。

## 12. 本地上传入库（knowledge-bases「本地上传入库」）

- [ ] 12.1 核对 Context：`workspaces/rest.ts:455-520`（独立 scope、octet-stream parser、`parseUploadName`、提前拒与流中拒）、`upload.ts` 的计数 `Transform`、组 10 的 `multipart.ts`。
- [ ] 12.2 测试先行：新 `server/test/kb-upload.test.ts`。
  - 「上传不落盘」：断言 `SANDBOX_ROOT`、`OMP_STATE_DIR`、`os.tmpdir()` 前后目录清单相同；
  - 「超限」；缺 `Content-Length` 400；文件名规则 400；`text/plain` 400；
  - 知识库非 `ready` 时 409；
  - 审计 detail。
- [ ] 12.3 新 `server/src/kb/uploads.ts`；`kb/rest.ts` 加 `POST /api/kb/bases/:id/uploads`。

Suggested fixture level: expanded - 流式转发用户上传到外部服务，且有不落盘的硬约束。
Minimal mergeable slice: atomic - 一条路由，与工作空间上传同一写法。

## 13. 重新入库与移出（knowledge-bases「重新入库与移出」）

- [ ] 13.1 核对 Context：组 10 的读取与上传链路；组 1 的文档删除应答。
- [ ] 13.2 测试先行：新 `server/test/kb-documents-reingest.test.ts`。
  - 「重新入库」「移出不动源文件」两个场景；
  - 源不可读 409 且行不变；本地上传的文档 reingest 400；
  - 旧文档删除失败只写 `kb_document_leak`；
  - `doc` 参数缺失 / 多值 400；不属于该库 404；
  - 非 `ready` 409。
- [ ] 13.3 `kb/documents.ts` 加 reingest 与 remove；`kb/rest.ts` 加两条路由。

Suggested fixture level: expanded - 两份真相的替换顺序（新文档先建、旧文档后删）与沙箱读取。
Minimal mergeable slice: atomic - 两条路由共用文档查找、所有权与状态判定和一个用例文件，各只有几十行。
Width exception: merged-tasks - 移出单独成 issue 只有一条路由加一次删除调用，审阅价值低于拆分成本；两者的 404 / 400 / 409 矩阵完全相同。

## 14. 嵌入模型更换与全量重建（ragflow-backend「嵌入模型更换与全量重建」）

- [ ] 14.1 核对 Context：
  - 组 8 的身份判定；组 10 的上传与组 1 的下载；
  - `server.ts` 里挂载恢复「`server_started` 之后不等待」的写法，以及关停次序；
  - `workspaces/mounts` 的恢复测试写法。
- [ ] 14.2 测试先行：新 `server/test/kb-rebuild.test.ts`（假 RAGFlow；重建器经注入的调度缝同步驱动）。
  - 「未确认不保存」「确认后重建」「中途失败与重试」三个场景；
  - 下载无 `Content-Length` 即失败；旧数据集删除失败只写 `kb_dataset_leak`；
  - 重建中再改嵌入身份 409 `kb_rebuilding`；只改密钥不触发；
  - `POST /api/kb/settings/rebuild` 的 403 / 401；
  - 审计三种 detail。
  
  编译入口用例（新 `server/test/kb-rebuild-restart.test.ts`）：「崩溃后续做」；关停时在途请求被中止、库仍为 `rebuilding`。
  
  退路启用时加「退路下的重建」。
- [ ] 14.3 新 `server/src/kb/rebuild.ts`；组 8 的 PUT 开放 `confirmRebuild`；`kb/rest.ts` 加 `POST /api/kb/settings/rebuild`；重建器的启动与关停接进 `startup-registry.ts`（`server.ts` 只加一次调用）。
- [ ] 14.4 `system.md` §9.13 加重建流程、续做与 `kb_dataset_leak`。

Suggested fixture level: expanded - 后台进程内任务、跨重启的续做与关停次序（process lifecycle + persisted state）。
Minimal mergeable slice: atomic - 确认开关一旦开放就必须有重建器，否则库永远停在 `rebuilding`；重建器没有确认入口就没有触发点。

## 15. web：API 客户端与中心「知识库」tab 的列表、建库、删库（model-registry「中心页外壳」；knowledge-bases「中心「知识库」tab」的状态行、列表与新建对话框）

- [ ] 15.1 核对 Context：
  - `web/src/features/center/tabs.ts:16-22` 与 `CenterPage` 的可见 tab 计算；
  - `web/test/center-page.test.tsx` 中钉住 tab 条与描述的行号；
  - `web/src/lib/api-connectors.ts` 的严格解析写法；
  - `api.ts` 的 `ApiClient` 类型与再导出；
  - `web/test/api-files-archive.test.ts` 的 `OTHER_CLIENT_METHODS` 与精确键集；
  - `web/test/support.ts` 的 `centerRoutes()`。
- [ ] 15.2 测试先行。
  - `center-page.test.tsx`：「知识库 tab 随开关显隐」，以及既有场景的假状态 `{enabled:false}`；`support.ts` 的 `centerRoutes()` 加 `GET /api/kb/status` 缺省应答 `{enabled:false}`。
  - 新 `web/test/center-kb-list.test.tsx`（假 `ApiClient`）：「不可用与未就绪」「编译开关按模板显示」；建库恰一次请求与失败 alert；空态；删除确认。
  - 新 `web/test/api-kb.test.ts`：每个应答形状的严格解析。
- [ ] 15.3 新 `web/src/lib/api-kb.ts`（全部知识库方法，含组 16、17 用到的）；`api.ts` 接线；`tabs.ts` 加 `{key:"knowledge-bases", label:"知识库", adminOnly:false, requiresKb:true}` 与可见性计算；新 `web/src/features/center/kb/{panel.tsx,list.tsx,create-dialog.tsx,use-kb.ts,templates.ts}`。
- [ ] 15.4 验收清单新节「中心·知识库（CK）」：CK-01 未配置知识库时没有知识库 tab；CK-02 建库并选模板；CK-03 RAPTOR / 知识图谱开关按模板与对话模型显示；CK-04 删库。结论 `待签`。`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: expanded - 新 tab 与可见性规则（presentation + route guard），按前端通用契约须有真实浏览器走查，组 18 补 ui-walk 分支。
Minimal mergeable slice: `api-kb.ts` 加 `tabs.ts` 可见性（tab 指向一个只有状态行的面板）——它能独立合入保绿。剩余部分（列表、建库、删库）依赖它。
Width exception: slice-deferred - 只有状态行的面板是无功能的占位 tab，违反「无后端支撑的控件不渲染」的同类精神；列表与建库是该 tab 的最小可用形态。

## 16. web：知识库详情（knowledge-bases「中心「知识库」tab」的详情、入库、上传、移出、重新入库与刷新）

- [ ] 16.1 核对 Context：
  - 文件页树组件与 `api-workspaces` 的目录列举；
  - S1g 上传的客户端 `web/src/lib/api-upload.ts`；
  - 组 15 的面板结构。
- [ ] 16.2 测试先行：新 `web/test/center-kb-detail.test.tsx`。
  - 「解析中自动刷新」（假时钟，页面隐藏时停）；
  - 状态文案六种；`源文件已变更` 与 `重新入库`；移出；
  - 入库对话框：选空间、浏览目录、勾选上限、提交恰一次、被拒条目逐条显示；
  - 上传：超数与超大在客户端就地拒绝，逐个请求；
  - 非 `ready` 时三类按钮不渲染。
- [ ] 16.3 新 `web/src/features/center/kb/{detail.tsx,documents-table.tsx,ingest-dialog.tsx,upload-button.tsx}`。
- [ ] 16.4 验收清单 CK-05 从工作空间入库后看到解析中并自动变为已切片；CK-06 本地上传入库；CK-07 改写源文件后出现「源文件已变更」，重新入库后消失；CK-08 移出文档后源文件仍在。结论 `待签`。

Suggested fixture level: expanded - 用户可见的入库流程与定时刷新（presentation + timers），组 18 的 ui-walk 走一遍。
Minimal mergeable slice: 详情的文档表、状态文案、定时刷新与行内操作（`移出`、`重新入库`）先合——它们只读写已有文档，能独立保绿。剩余部分（`从工作空间入库` 对话框与 `上传文件`）依赖它。

## 17. web：模型 tab 的「知识库模型」段（model-registry「模型 tab」）

- [ ] 17.1 核对 Context：`web/src/features/center/models/{panel.tsx,form-dialog.tsx,list.tsx}` 的对话框、确认框与探活写法；组 15 的 `api-kb.ts`；组 1 的退路结论。
- [ ] 17.2 测试先行：新 `web/test/center-models-kb.test.tsx`。
  - 「更换嵌入模型需确认」；
  - 首次配置密钥必填；对话模型下拉改动恰一次请求；
  - 重建状态与 `重试失败的重建`；设置读取失败时的 `重试`；
  - 知识库关闭时整段不渲染。
  
  退路启用时：嵌入模型只读，按 `rebuildNeeded` 显示 `重建全部知识库` 与确认。
- [ ] 17.3 新 `web/src/features/center/models/kb-section.tsx` 与 `kb-embedding-dialog.tsx`；`panel.tsx` 挂载该段。
- [ ] 17.4 验收清单 CK-09 管理员配置嵌入模型与知识库对话模型；CK-10 更换嵌入模型时弹确认，确认后各知识库重建完成。结论 `待签`。

Suggested fixture level: expanded - 管理员录入上游凭证的表单（credentials 触发项）与破坏性确认。
Minimal mergeable slice: atomic - 一段表单与它的确认框，一个组件用例文件。

## 18. 真实端点冒烟、走查与收口（verification-harness「知识库真实端点冒烟」；ragflow-backend「共用开发栈的使用纪律」）

- [ ] 18.1 核对 Context：Makefile 的 `smoke-live` 写法与 `.PHONY`；`smoke/fixtures/README.md` 与夹具复制脚本；`web/e2e/ui-walk-layout.ts` 的 `/center` 分支；`AGENTS.md` 验证矩阵与 `constraints.yaml` 的 verification 段；`scripts/test-ci-harness.sh` 对 Makefile 目标的同步检查。
- [ ] 18.2 新 `smoke/kb.hurl` 与夹具：在 `smoke/fixtures/sandbox/u1/` 加一个小 Markdown 文件与一个小 PDF 文件（自制，无第三方版权）。Makefile 加 `smoke-kb`：先检测版本，不满足即输出 `共用 RAGFlow 栈未运行或版本不符` 并非零退出。`AGENTS.md`、`constraints.yaml` 同步，控制面 oracle 同步。验证「栈未运行」场景：对一个关闭的端口跑一次，非零退出，`docker ps` 前后容器清单相同。
- [ ] 18.3 `make ui-walk` 的 `/center` 分支：知识库关闭（CI 的缺省配置）时 tab 条不含 `知识库`。开启时的走查只在本机对共用栈手动跑一次，截图附在 PR 说明。
- [ ] 18.4 按 D16 检测共用栈后，对接上专用账号的本机服务跑 `make smoke-kb`，输出附 PR 说明。确认共用栈里没有残留的 `owb-` 数据集。
- [ ] 18.5 `docs/architecture/system.md` §9.13 收口（部署要求、回滚、smoke-kb）；§6.2 摄取流改为「app-server `kb` → RAGFlow」；验收清单 CK 节复核。

Suggested fixture level: expanded - 真实外部服务冒烟与 harness 接线（smoke/UI harness + CI/production configuration）。
Minimal mergeable slice: `smoke-kb` 目标、夹具加控制面同步先合。剩余部分（ui-walk 分支与文档收口）依赖它。
Width exception: multi-path - 冒烟（hurl 对真实 RAGFlow）与 ui-walk（Playwright 对 CI 缺省配置）是两条验证路径，但 ui-walk 只多一条「没有知识库 tab」的断言，文档收口要引用冒烟的结果；拆开只会多一个几行的 PR。
