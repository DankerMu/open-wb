# Tasks: s2a-kb-ragflow

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组（或宽度门禁拆出的切片）一个子 issue、一个 PR。
>
> 外部前提 P（owner 持有；Stage 5 建为独立 issue，正文写一行 `Depends on #<Epic>`——picker 只跳过 epic 与 `Depends on` 仍开着的 issue、不认标签，这一行让 agent 永远选不中 P；owner 做完后手动关闭）：
> - dsh-team 的共用栈运行 `v1.0.0-rc2`；
> - 在其 RAGFlow 界面注册 open-workbuddy 专用账号并生成 API key，key 文件 `0600` 放在仓库之外；
> - 本机 `CLAUDE.local.md` 新建「RAGFlow 共用栈」一节，记 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` 与实测用嵌入上游的变量名，并在 shell 环境 export。
>
> 依赖（真实依赖）：
> - 无前置：组 2、3、4、7。
> - 组 1 ← P。组 5 ← 1（夹具协议以实测记录为准）。组 6 ← 4、5、7 首刀。组 8 ← 6、7 首刀、7 剩余（锁）。组 9 ← 1、8。
> - 组 10 ← 9。组 11 ← 10（复用 `kb/source-file.ts` 与 `kb/documents.ts`）。组 12 ← 10（复用 `kb/multipart.ts`）。组 13 ← 10。组 14 ← 8、10、12、13（14.2 的「锁被重建器持有时立即 409」要用到组 13 剩余部分注册的重新入库路由）。
> - 组 15 首刀（`api-kb.ts`）← 1：不依赖服务端代码，只按 spec 写明的应答形状，但应答形状可能随组 1 的结论修订（1.4）；组 15 剩余 ← 9、15 首刀。组 16 首刀 ← 11、13、15；剩余 ← 10、12、16 首刀。组 17 ← 8、14、15 首刀。
> - 组 18 首刀 ← 3 及 5–17 全部；18.4（ui-walk 分支）← 组 15 剩余；18.5（收口）← 组 18 首刀。组 18 不依赖 P：真实 RAGFlow 运行是 owner 执行的验收行 CK-11。
>
> Epic 正文另列 design「Grill 结论」里标「待 owner 复核」的三处细化（第 4、13、27 行），等 owner 确认。
>
> 通用纪律：
> - 测试先行；每组第一个任务核对 design「Context」的行号与事实（主干在本 change 开工后可能已移动）。
> - 密钥、文件内容与 RAGFlow 应答原文不进任何响应、审计、日志；被跟踪文件、issue 与 PR 正文里 RAGFlow 地址一律写 `<RAGFLOW_BASE_URL>`。
> - 产品与测试文件单文件均 ≤800 行（`size-guard.sh` 两者都扫）。`server.ts` 的行数预算见 design D18：组 4 先移出一段既有函数，组 4、6、14 再各加自己的几行。
> - 不新增 `.css`。
> - 需要真实 RAGFlow 的只有组 1，执行前按 design D16 检测；`RAGFlow 私有配置缺失` 与 `共用 RAGFlow 栈未运行或版本不符` 两种停止都在 issue 评论里报告、不开 PR、不拉起任何容器，并在本 issue 正文加一行 `Depends on #<P>`、重开 P（写明要 owner 做什么），让 picker 跳过本 issue。
> - 假 RAGFlow 夹具按组扩展（design D17）：每组只加本组用到、且实测记录里有的接口。
> - 每个注册新知识库路由的组，在同一 PR 里：
>   - 把这些路由加进 `server/test/kb-disabled.test.ts` 的路由表（组 8 新建；ragflow-backend「未配置即关闭」）；
>   - 带 body 的路由加进 `http-parser-owners` 的真实路由用例（http-service-skeleton「知识库的归属路由」）。
> - 改变用户可见行为的组在同一 PR 增改验收行并写 `待签`（AGENTS.md:169-170）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（RAGFlow 密钥、嵌入 / 对话上游密钥进响应、审计、日志、omp 环境；共用栈地址进公开仓库） | 是 | 组 1 脱敏、组 4 密钥文件与 omp 环境用例、组 5 请求记录、组 8 视图与审计哨兵 |
| 沙箱越界（入库读取绕过 `resolve`、跟随符号链接、读挂载离线；被动读取伪造越界审计） | 是 | 组 10、组 11（无审计解析）、组 13 |
| 两份真相（本地映射 vs RAGFlow 数据集 / 文档） | 是 | 组 5 not-found 结果、组 9 建库失败回滚、组 10–13 失败补偿删除、组 11 `missing`、组 14 重建切换、跳过与续做 |
| 并发（同库写操作与重建交错、并发设置下发） | 是 | 组 7 锁、组 8 设置锁用例、组 10 同路径并发与入库中删库、组 14 上传与确认重建交错 |
| 外部接口漂移（rc2 文档自相矛盾、预发行版） | 是 | 组 1 实测、组 5 夹具只按记录写、组 6 版本钉住 |
| 权限（他人知识库可探测、非管理员写设置） | 是 | 组 8、组 9 的 403 / 404 矩阵，组 10 他人工作空间 |
| 迁移与 DB 约束 | 是 | 组 7 |
| 共用外部资源（dsh-team 的栈被拉起、停止或改配置） | 是 | 组 1、组 18 的检测与「不拉起」断言 |
| 控制面漂移（退役后 oracle 与 CI 不一致；新增 `smoke-kb`） | 是 | 组 3、组 18 |

## 1. rc2 接口实测（ragflow-backend「RAGFlow 接口实测记录」「共用开发栈的使用纪律」）

- [ ] 1.1 按 design D16 检测：
  - 从 shell 环境读 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE`。未设置或 key 文件不存在 → 报告 `RAGFlow 私有配置缺失`。
  - `curl "$RAGFLOW_BASE_URL/api/v1/system/version"` 不可达或不是 `v1.0.0-rc2` → 报告 `共用 RAGFlow 栈未运行或版本不符`。
  - 另执行一次只读的 `docker compose ls`，结果写进 issue 评论（只作观察，不作放行判据）。
  - 任一停止：issue 评论报告原因、本组不继续、不开 PR；在本 issue 正文加一行 `Depends on #<P>` 并重开 P（评论写明要 owner 做什么）。全程不执行任何 `docker` 写操作。
- [ ] 1.2 用专用账号的 API key，按 spec 列出的十项逐项实测，写 `docs/reviews/2026-10-28-ragflow-rc2-api.md`。每节写请求与应答摘录和结论「支持 / 不支持」。另记三张表：运行状态到本系统 `status` 的映射表、「不存在」组合表、RAPTOR / 知识图谱的模板支持表。
- [ ] 1.3 脱敏：地址写 `<RAGFLOW_BASE_URL>`；id、邮箱、昵称、账号名换占位符；不出现 key、key 路径与文件内容。对文档跑 `gitleaks detect --no-git --source docs/reviews/2026-10-28-ragflow-rc2-api.md`，并 grep 本机实际地址与账号名，两者零命中的输出附 PR 说明（输出本身也脱敏）。只删除本组建的 `owb-` 前缀数据集，在记录末尾写清理结果。
- [ ] 1.4 结论的后果写进记录末尾，并在 Epic 下评论：
  - 「模型下发」不支持：按 design D7 的应急预案修订本 change（不再询问 owner），重过 Stage 3–4.5。修订过审前，组 6 及其后全部（组 7 除外）不开工。
  - 「编译开启或触发」不支持：按 design D14，组 9 及其全部下游与组 15 首刀等 owner 修订本 change；组 2–8 不受影响。
  - 模板支持表与 design D9 不符：修订本 change 后再开组 9。
  
  任一项触发时，本组在合入前建一个修订 issue R（标题「修订 s2a-kb-ragflow：<哪一节不支持>」，正文写一行 `Depends on #<Epic>`，picker 选不中它；修订以 stage-change-pipeline 进行：「模型下发」一项按 design D7 的预案修订，不需要 owner 的决定，由主会话在组 1 合入后启动；「编译」或「模板表」一项先等 owner 的决定再修订；过审后关闭），并在被停各组的根 issue 正文加一行 `Depends on #<R>`：模型下发为组 6 与组 15 首刀；编译或模板表为组 9 与组 15 首刀。其余被停的组本就（传递）依赖这些根，picker 不会选中。
  
  本组 PR 照常合入记录，不因结论为「不支持」而不合。

Suggested fixture level: compact - 只产出一份被跟踪的实测记录，不改产品代码；但它与凭证、共用栈地址邻接（须脱敏），又是组 5 夹具的唯一协议来源。
Minimal mergeable slice: atomic - 一份记录、一次对同一实例的实测；拆开会让夹具协议来自两次不同的观察。

## 2. 方向变更文档（Grill 结论 1、10、11；design Context「方向变更」）

- [ ] 2.1 核对 Context：
  - ADR-0002、ADR-0005；`ATTRIBUTION.md:24-26`；
  - `CONTEXT.md:9,38,45,53`；`PLAN.md:21,32,47,94`；
  - `IMPLEMENTATION_PLAN.md`：S2a / S2b / S2c / S4a / S4b 各节、覆盖表、Open Decisions、Next Step、What Already Exists；
  - `resource/backend-research.md:63,155-165`；`README.md:4,22`；
  - `docs/architecture/system.md`：`:9`（§1）、`:17`（§2 约束）、`:43-53`（§3.2）、`:87-88`（§4 规则 4、5）、`:123`、`:128`（§5 目录树）、`:152`（§6.1 时序图）、§7。
- [ ] 2.2 新 `docs/adr/0016-ragflow-service-backend.md`：
  - 决策：知识库以运行中的 RAGFlow 服务为后端，取代 ADR-0002。
  - 理由：v1.0 的 Go 重写与资源占用；rc2 的 arm64 镜像；多租户留在 app-server。
  - 后果：
    - 单一服务账号；密钥文件。
    - RAGFlow 持有嵌入与知识库对话模型的上游密钥（与 ADR-0008 的区别）；删除与轮换经联动同步。
    - RAGFlow 不对用户网络暴露。
    - S4b 带 RAGFlow 全栈（Docker、内存门槛以官方要求为准）；Apache-2.0 / NOTICE 义务随部署包。
    - 版本钉住 `v1.0.0-rc2`。
  - 被否决的备选：吸收源码；保留 kbservice 薄层。
  
  另做：ADR-0002 头部加「已被 ADR-0016 取代」；ADR-0005 补充一段（Infinity 经 RAGFlow 的 `DOC_ENGINE`，ES 退路仍在 RAGFlow 侧）。
- [ ] 2.3 `docs/architecture/system.md` 改写：
  - §1 组件说明与 §3.2 整节：把 kb-service 改为「外部 RAGFlow 服务 + app-server `kb` 模块」；
  - §2 约束：「omp 与 kb-service 不感知租户」改为「omp 与 RAGFlow 不感知租户」；
  - §3.1 的 `kb` 行：「先过滤 kb_ids 再调 kb-service」改为调 RAGFlow（组 6 只补端点细节）；
  - §4 规则 4、5：kb-service 相关规则改为 `kb` 模块的依赖规则，具体规则由组 8、10 落；
  - §5 目录树：删 `kbservice/src/kbservice/`；既有 `server/src/kb/` 一行的注释「kb-service 客户端」改为「RAGFlow 客户端与知识库端点」；
  - §6.2 摄取一行：「→ kb-service ingest」改为「app-server `kb` → RAGFlow」；
  - §6.1 时序图：参与者 kb-service 改为 RAGFlow；
  - §7 决策索引：加 0016。
- [ ] 2.4 `ATTRIBUTION.md` 的 RAGFlow 条目改为「以服务形态部署，不吸收源码」；义务写为：发行物含 RAGFlow 镜像时附其 LICENSE 与 NOTICE。
- [ ] 2.5 `CONTEXT.md`：
  - 项目本质里三个组件改为 app-server、web SPA 与外部 RAGFlow 服务；
  - 限界上下文「知识库」改为「app-server `kb` 模块 + RAGFlow」；
  - `:38`「kb-service 嵌入调用不经它」改为 RAGFlow 的说法；
  - 不变量 4 改为「RAGFlow API 密钥与模型网关密钥不得出现在 omp 子进程可读环境」。
- [ ] 2.6 `PLAN.md` 的知识库四处（`:21,32,47,94`）改写，并互加对 ADR-0016 的引用。`IMPLEMENTATION_PLAN.md`：
  - S2a 一节改写为本 change（覆盖 F-CTR-KB1 / KB2 不变）；
  - S2b / S2c 的 kbservice 措辞改为 app-server `kb` 模块；
  - S4a 的回归对象去掉 kbservice；S4b 部署要求加 RAGFlow 全栈；
  - Open Decisions 的 deepdoc 一行关闭（随 ADR-0016 作废）；
  - What Already Exists 的 kbservice 一行改为「已退役（change s2a-kb-ragflow）」；
  - Next Step 更新到当天：P0 + P1 已交付，S2a 进行中。
- [ ] 2.7 `resource/backend-research.md` 头部加一行「§1 的吸收方案已被 ADR-0016 取代」；`README.md` 两处同步。合入前 `grep -rn "kb-service\|kbservice" docs/architecture/system.md CONTEXT.md PLAN.md README.md` 只剩指向 ADR-0002 的历史引用，结果附 PR 说明。

Suggested fixture level: none - 只改文档与 ADR。
Width exception: merged-tasks - 七个任务写的是同一个方向变更；分开合入会让主干在一段时间里同时有两套互相矛盾的知识库架构说明。
Minimal mergeable slice: atomic - 理由同上。

## 3. kbservice 退役（verification-harness「CI 接线与控制面同步」「第三方 CI action 使用 Node 24 runtime」）

- [ ] 3.1 核对 Context：
  - Makefile:10,17-19,23,28,30,35；
  - `.github/workflows/ci.yml:15,17,19,30,32,34,56,75`；
  - `scripts/inspect-ci-workflow.js:11,17`；`scripts/test-ci-harness.sh` 中的 uv / kbservice 变异；
  - `scripts/size-guard.sh:13,25`；`scripts/test-guardrails.sh:42-50`；`.jscpd.json:3,7`；
  - `.gitignore:26-27`；`constraints.yaml:66,77,93`；`deploy/app/Dockerfile.dockerignore:10`；
  - `AGENTS.md:36,38,47,57,143,145,146,175`；`openspec/project-profile.md:5,10,22,33,37,42`；
  - `server/test/omp-process.test.ts:43,56`。
- [ ] 3.2 测试先行：`scripts/test-ci-harness.sh` 改写 oracle 期望：
  - setup-uv 计数为 0；`unit-tests` 与 `fast-checks` 的步骤序列去掉 uv / ruff / pytest。
  - 加 verification-harness「Python 工具链退役后不可回潮」的变异，各须非零：加回 setup-uv 加 ruff；加回 pytest；naming-guard、semgrep、size-guard、jscpd 的路径加回 `kbservice`。
  
  `scripts/test-guardrails.sh` 的 `.py` 样例改为 `.ts` / `.mjs` 样例，size-guard 的守卫能力不降。
- [ ] 3.3 删除 `kbservice/`。同步删改：
  - Makefile、`ci.yml`、`inspect-ci-workflow.js`；
  - size-guard（路径与 `*.py`）、jscpd、`.gitignore`；
  - `constraints.yaml`：复杂度、覆盖率、死代码三行只留 Biome / vitest / knip；
  - dockerignore；
  - `AGENTS.md`：栈表、工具、目录树、模块边界两行、验证矩阵三行；
  - `project-profile.md`。
  
  `omp-process.test.ts` 的哨兵名改为 `RAGFLOW_API_KEY_FILE`，断言语义不变，行数不增。
- [ ] 3.4 `make check`、`make test-guardrails` 本机全绿；PR CI 全绿，`all-checks-passed` 的 needs 不变。

Suggested fixture level: expanded - 改 CI workflow、控制面 oracle 与 `constraints.yaml`（CI/production configuration 触发项），并删除一个包目录；oracle 一旦改错会卡住全部合入。
Minimal mergeable slice: atomic - 删目录与删 CI 步骤必须同 PR：只删目录则 CI 的 `uv sync` 失败，只删步骤则 oracle 拒绝。

## 4. 配置键与密钥文件阶段（http-service-skeleton「服务启动与装配」的知识库键与 `kb_key`；ragflow-backend「知识库配置与密钥文件」）

- [ ] 4.1 核对 Context：
  - `resolveServerConfig` 与四十二项（`server.ts:129-146`）；`preview-config.ts` 中 `PREVIEW_ORIGIN` 的正则；
  - `agent-config.ts` 中 `resolvePositiveInteger` / `assertHeaderSafeKey`（`:237`，未导出）/ `resolveOwnedPath`；
  - `StartupStage`（`server.ts:330-344`）与 `server-startup-failure-reason.test.ts`；
  - `startup-registry.ts` 的阶段函数写法；`regular-file.ts:55` 的 `openRegularFile`；
  - `OMP_CHILD_ENV_NAMES`（`spawn-env.ts`）；
  - `server.ts:756-799` 的 DB 文件准备函数。
- [ ] 4.2 先做无行为变化的移动：把 `preparePrivateDbFiles`、`preparePrivateDbMain`、`prepareExistingSidecar`、`chmodExistingPrivateFile`（`server.ts:756-799`）移进 `startup-registry.ts` 并从那里导出，`server.ts` 改为导入。同一刀把 `server-assembly.test.ts`（798 行）的启动记录与注册次序用例原样移到新 `server/test/server-assembly-modules.test.ts`。两处都是纯移动：既有测试不改断言即全绿；PR 说明附移动前后的 `wc -l`。`server-config.test.ts` 正好 800 行，本 change 不往里加用例。
- [ ] 4.3 测试先行。
  - 新 `server/test/kb-config.test.ts`：四键的缺省、配对规则、正则、正整数纪律；message 只含键名。
  - 新 `server/test/kb-key-file.test.ts`（单元层）：普通文件、符号链接、`0644`、`0640`、空文件、4097 字节、恰为 `\n\n`、去掉结尾 `\n`、含 `\r`；ragflow-backend「属主不符」（注入的 `getuid` 缝）。
  - 编译入口用例：新 `server/test/server-startup-kb.test.ts`。
    - ragflow-backend「密钥文件不合规即启动失败」的六例与合规一例；
    - http-service-skeleton「知识库键与密钥文件阶段」的前六例；`kb_key` 失败时 DB 文件不存在；
    - 最后一例（指向关闭端口、正常启动）本组只断言启动成功，模块仍为十一项，「十二项且最后是 `kb`」由组 6 断言。
  - 新 `server/test/kb-omp-env.test.ts`：ragflow-backend「密钥不进 omp 环境」，用假 omp 记录 spawn 环境。不加到 798 行的 `omp-process.test.ts`。
  - 同 PR 改钉住配置项数与阶段表的既有用例（4.1 核对时列全）。
- [ ] 4.4 实现：
  - 新 `server/src/kb/config.ts` 与 `server/src/kb/key-file.ts`；`agent-config.ts` 导出 `assertHeaderSafeKey`；
  - `resolveServerConfig` 展开四键，注释里的项数改为四十六；`StartupStage` 加 `kb_key`；
  - 阶段函数放在 `startup-registry.ts`。
  
  读出的密钥经装配传给组 6 的 `kb` 模块：本组只把它存进一个只读句柄，暂无消费者，用 `knip` 豁免注释说明，组 6 删掉该注释。
- [ ] 4.5 `docs/architecture/system.md` §9.13「知识库」新建，本组写配置键、密钥文件要求与 `kb_key` 阶段；§9.3 启动次序文字加 `kb_key`。

Suggested fixture level: expanded - 新配置键与凭证读取（credentials + production configuration）、新启动阶段。
Minimal mergeable slice: 4.2 的函数与用例移动——纯重构，不改行为，既有测试即验证。剩余部分（配置解析与 `kb_key` 阶段）依赖它；剩余部分本身 atomic：配置解析与 `kb_key` 阶段是同一对键的两半，只有解析没有阶段则密钥文件从不被校验，只有阶段没有解析则无从得到路径。

## 5. 假 RAGFlow 夹具与 RAGFlow 客户端（ragflow-backend「RAGFlow 出站请求」）

- [ ] 5.1 核对 Context：
  - 组 1 的实测记录（全部路由、字段、状态值、code 与「不存在」组合表）；
  - `models/probe.ts` 与 `connectors/probe.ts` 的传输骨架；`core/error-body.ts`、`core/upstream-failure.ts`；
  - `server/test/support/fake-upstream.mjs` 与 `fake-mcp-http.mjs` 的写法，及其 `.d.mts`；
  - `models-probe-helpers.ts` 的 `holdServer()` / `closedPort()`。
- [ ] 5.2 测试先行：新 `server/test/support/fake-ragflow.mjs` 加 `.d.mts`。
  - 本组只实现：版本接口、数据集的建与删、文档的上传与删除、解析触发。
  - 可脚本化：版本串；按路由给 code / HTTP 状态 / 挂起 / 挂起后放行 / 3xx / 非 JSON / 超体积；「不存在」组合。
  - 记录请求：方法、路径、是否带 key、JSON body、multipart 字段名与文件字节数。
  - 附夹具自测。
  
  新 `server/test/kb-ragflow-client.test.ts`：
  - ragflow-backend「RAGFlow 出站请求」五条映射各一例，含「不存在」组合先于 `102` 识别为 `not_found`（期限经注入缩短）；
  - `kb_upstream_auth_failed` 在 60 秒内至多一行（注入时钟）；
  - 3xx 不跟随；响应体 1 MiB + 1 字节失败；
  - 版本请求不带 key、其余都带；
  - 结果对象与 stderr 不含假 RAGFlow 返回的 message 哨兵。
- [ ] 5.3 新 `server/src/kb/ragflow-client.ts`：按 design D4 提供 JSON 请求、流式上传、流式下载三种调用，返回类型化结果（含 `not_found`），期限可注入。本组只交付客户端，不挂路由。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials），并定下全部知识库端点共用的失败映射。
Minimal mergeable slice: atomic - 夹具没有客户端就没有消费者，客户端没有夹具无法按规格验证；共一条验证路径。

## 6. 错误码、`kb` 模块装配与状态端点（http-service-skeleton「统一错误信封」「Shared agent module assembly」；ragflow-backend「知识库状态端点」「知识库可用性」的状态部分）

- [ ] 6.1 核对 Context：
  - 组 1 实测记录「模型下发」一节的结论；为「不支持」时本 issue 已带 `Depends on #<R>`（1.4），不应被选中，被选中即说明 1.4 漏做，停下并在 Epic 下报告；
  - `core/errors/index.ts` 的二十五码；`http/errors.ts` 的状态映射与三十一条归属身份；
  - `http-parser-owners.test.ts:28,174-178`、`http-typed-errors.test.ts:132-134`、`auth-lifecycle.test.ts:705` 的计数；
  - `STARTUP_MODULES` 与 design Context 列出的七处模块列表断言；
  - `server-assembly.test.ts`（798 行）的 `spyRegistrationOrder`；
  - `app.ts` 的 `registerConnectors` 位置与 `AssemblyDependencies`。
- [ ] 6.2 测试先行（首刀）：
  - 新 `server/test/http-typed-errors-kb.test.ts`：「九个知识库码」。
  - `http-parser-owners.test.ts`：三十八条，七条 PUT、三十条 POST、一条 PATCH。七条新身份在本组先登记，路由由组 8–14 注册；先例见 `http/errors.ts` 注释里的 `POST /api/models/probe`。
  - 同 PR 把 `http-typed-errors.test.ts`、`auth-lifecycle.test.ts` 的「二十五码」改为三十四。
- [ ] 6.3 实现（首刀）：`core/errors` 加九码；`http/errors.ts` 的状态映射、归属集与计数措辞。
- [ ] 6.4 测试先行（剩余部分）：
  - 把七处模块列表断言（含组 4 移到 `server-assembly-modules.test.ts` 的那几处）改为十二项、最后为 `kb`，在 `spyRegistrationOrder` 加 `registerKb`；
  - `server-startup-kb.test.ts` 加「知识库键与密钥文件阶段」的最后一例（模块恰为十二项且最后是 `kb`）。
  
  新 `server/test/kb-status.test.ts`（`app.inject()` + 假 RAGFlow）：
  - 「版本钉住」；未配置时 `{enabled:false}`；
  - `embeddingReady` 与 `compileReady` 随 `kb_settings` 变化（store 直接写入）；
  - 未登录 401；no-store。
- [ ] 6.5 实现（剩余部分）：
  - 新 `server/src/kb/index.ts` 与 `kb/rest.ts`：本组只有 `GET /api/kb/status`，以及 `/api/kb/*` 的关闭判定——preParsing 在 cookie guard 之后、管理员判定与 body 解析之前返回 503 `kb_disabled`；关闭判定由后续各组的路由用例验证。
  - `app.ts` 在 `registerConnectors` 之后注册 `kb`；`STARTUP_MODULES` 加 `kb`（`server.ts` +1 行）。
  - 组 4 的密钥句柄交给 `kb` 模块，删掉 knip 豁免注释。
- [ ] 6.6 `system.md` §3.1 的 `kb` 行补状态端点，`core/errors` 行改为三十四码；§9.13 加状态端点、版本钉住与两条 stderr 记录。

Suggested fixture level: expanded - 改共享错误信封与装配（Fastify assembly/routes/hooks 触发项）。
Minimal mergeable slice: 6.2–6.3 的九码与七条归属身份登记——码表与归属集是纯数据，先合不改变任何已注册路由的行为，带「九个知识库码」与三十八条计数用例。剩余部分（`kb` 模块装配、关闭判定与状态端点）依赖它；剩余部分 atomic：模块一注册就必须进启动记录，启动记录与注册次序断言要同 PR 改。

## 7. 迁移 050、store 与锁（knowledge-bases「迁移 050 知识库 schema」「同一知识库的写操作串行」的锁本身）

- [ ] 7.1 核对 Context：
  - 迁移目录最后为 049；049 头注的写法；
  - `server/test/core-db-helpers.ts` 的 `TRACKED_MIGRATION_FILENAMES`、`COMPLETE_CATALOG`（回执与 `sequenceRows`）；
  - `auth-schema.test.ts:496-515` 业务表清单；`core-db-session-fixture.ts:311` 的索引排除清单；
  - `core-db-chat-step-output.test.ts:75-93` 与 `migration-034.test.ts` 的 seed 过滤清单。
- [ ] 7.2 测试先行。
  - 新 `server/test/kb-store.test.ts`（`:memory:` + 真实迁移）：
    - 「约束」场景的五例；`kb_settings` 唯一行；
    - store 的设置读写（含 `rebuild_actor_id`）；
    - 知识库增删查（按 owner；计数供 50 上限用）；
    - 文档增删查（计数供 500 上限用）；
    - `(kb_id, workspace_id, source_path)` 唯一；
    - 重建状态与 `rebuild_dataset_id` 读写；级联。
  - 新 `server/test/kb-locks.test.ts`：
    - 同一知识库的两个写操作串行、不同知识库并行；
    - 锁被重建器持有时写操作立即得到「重建中」结果而不排队；
    - 设置锁串行；锁在异常路径上释放。
  - 同 PR 改 7.1 列出的既有快照用例（属首刀：它们随迁移 050 变化）。
- [ ] 7.3 实现：`050_knowledge_bases.sql`；新 `server/src/kb/store.ts`（只读写本地三张表，不发出站请求）；新 `server/src/kb/locks.ts`（design D20）。

Suggested fixture level: expanded - 新迁移与凭证落库（persisted schema + credentials at rest），以及全部写路径共用的并发原语。
Minimal mergeable slice: 迁移 050 与 store（7.2 的 `kb-store.test.ts` 与 7.3 的迁移、`store.ts`）——迁移没有 store 就没有读者，store 是三张表唯一的写入口。剩余部分（`kb-locks.test.ts` 与 `locks.ts`）与首刀没有依赖，可并行；它本身 atomic，一个文件一组单元用例。组 6 只依赖首刀，组 8 依赖两刀。

## 8. 知识库模型设置、下发与 models 联动（ragflow-backend「知识库模型设置」；model-registry「模型管理端点」）

- [ ] 8.1 核对 Context：
  - 组 1 实测记录的「模型下发」一节；若为「不支持」，组 6 的 issue 已经带 `Depends on #<R>`（1.4），本组随之被跳过；
  - `models/rest.ts` 的 `adminOnly` preParsing、`perIdChain`、审计包装、`upstreamChanged` 的判定；
  - `models/probe.ts` 的探活写法；组 6 的 `kb/rest.ts`；组 7 的 store 与锁。
- [ ] 8.2 测试先行（首刀）：新 `server/test/kb-settings.test.ts`（`app.inject()` + 假 RAGFlow + 假嵌入上游；假嵌入上游复用 `fake-upstream.mjs`，或在本组给它加 `/embeddings`）。
  - 「下发失败不改设置」；
  - 「非管理员」：本组的三条路由；`POST /api/kb/settings/rebuild` 的一腿留到组 14；
  - 「并发设置写入」（夹具的挂起后放行）；
  - 键集与类型 400；`{}` 400；首次缺 `apiKey` 400；`chatModelId` 不存在或无上游 400；`chatModelId:null` 时假 RAGFlow 收到撤销；
  - 读视图的精确键集，不含密钥哨兵；审计 detail 不含哨兵，键集同 knowledge-bases「知识库审计」；
  - 嵌入探活的 `ok` / `failed` 与写回、`kb.settings {probe}`；未配置时 409 `kb_not_ready`；
  - 嵌入身份变化且已有知识库时一律 409 `kb_rebuild_required`：`confirmRebuild` 由组 14 开放，本组带了也 409，用例写明这一点。
  
  本组三条路由加进新建的 `server/test/kb-disabled.test.ts`；`PUT /api/kb/settings` 与 `POST /api/kb/settings/probe` 加进归属路由用例。假 RAGFlow 加模型提供方与账号缺省模型接口。
- [ ] 8.3 实现（首刀）：新 `server/src/kb/settings.ts`（读视图、校验、下发与撤销、身份判定，全部写入经设置锁）；`kb/rest.ts` 加 `GET` / `PUT /api/kb/settings` 与 `POST /api/kb/settings/probe`。
- [ ] 8.4 测试先行（剩余部分）：
  - ragflow-backend「对话模型联动」「联动与设置交错」「删除与设置交错」（夹具的挂起后放行；两种进锁次序各一例：A 先持锁；或先让第三个持锁者 C 的嵌入设置 PUT 挂起，再让 B、A 依次排队）；model-registry「知识库对话模型受保护」，写进新 `server/test/kb-models-guard.test.ts`；
  - 知识库关闭时 `models` 的删除与修改行为与本 change 之前一致（既有 `models-*.test.ts` 不改即绿）。
- [ ] 8.5 实现（剩余部分）：
  - `AssemblyDependencies` 加可选 `modelWriteGuard`：它接收一个执行 `models` 那次写入或删除的回调，在设置锁内依次做引用判定、需要时重新下发、再执行回调；`models/rest.ts` 的 `DELETE` 与 `PUT` 把各自的写入交给它包住，钩子为空时直接执行；
  - `kb` 注册时提供该钩子；`models/rest.ts:185` 注释里「判定与写入之间没有 await」的前提随之改为「判定与写入在设置锁内」，同 PR 改注释；
  - `core/errors` 的 `kb_model_in_use` 由组 6 登记。
- [ ] 8.6 `system.md` §9.13 加设置端点、下发与撤销内容、「RAGFlow 持有上游密钥，删除与轮换经联动同步」一句；§4 依赖规则加 `models` 经注入钩子回调 `kb`、不形成反向依赖。

Suggested fixture level: expanded - 管理员写路径与凭证（Auth / credentials 触发项），并向外部服务推送凭证；剩余部分改既有 `models` 端点的写入路径。
Minimal mergeable slice: 8.2–8.3 的设置读写、下发与探活——三条新路由、一个用例文件，能独立保绿。剩余部分（`models` 联动钩子，8.4–8.5）依赖它；剩余部分 atomic：钩子只有删除与改上游两个调用点，共用一次引用判定。

## 9. 建库与删库（knowledge-bases「知识库端点」；ragflow-backend「RAGFlow 出站请求」的端点级场景、「知识库可用性」的「不可达不阻断」）

- [ ] 9.1 核对 Context：
  - 组 1 实测记录的建库、编译与模板支持表三节；「编译开启或触发」不支持或模板表与 design D9 不符时，本组 issue 已经带 `Depends on #<R>`（1.4）；
  - 组 8 的设置读取（嵌入就绪、对话模型就绪）与设置锁；
  - demo 的 `kbMethods`（`resource/workbuddy-live-demo.html:1473-1486`）。
- [ ] 9.2 测试先行：新 `server/test/kb-bases.test.ts`。
  - knowledge-bases：「建库与列表隔离」「开关校验」「删库」「编译状态读取有界」「知识库数上限」；
  - ragflow-backend：「结果映射」（经 `POST /api/kb/bases`）、「不存在视为已删」的删库一腿、「不可达不阻断」；
  - 名称规则；重名 409 `conflict`；
  - 插行失败时删掉刚建的数据集（注入 store 失败），且没有 `kb.create`（knowledge-bases「写入失败不留审计」的建库一腿）；
  - `rebuilding` 时删库 409；`rebuild_failed` 时删两份数据集（状态由 store 直接设置）；
  - 列表 `{bases}` 精确键集、按 `created_at` 升序、no-store；两开关为 0 的库不发编译状态请求；
  - 审计 `kb.create` / `kb.delete` 的 detail 键集。
  
  本组三条路由加进 `kb-disabled.test.ts`，`POST /api/kb/bases` 加进归属路由用例；假 RAGFlow 加编译状态接口。
- [ ] 9.3 实现：新 `server/src/kb/bases.ts`（建库经设置锁，删库经该库写锁）与 `kb/templates.ts`（模板与编译支持表；web 用同一份数据另写一份常量，见组 15）；`kb/rest.ts` 加 `GET` / `POST /api/kb/bases` 与 `DELETE /api/kb/bases/:id`。实测记录要求显式触发编译时，本组只记录建库字段；触发点在组 10、12、13、14。
- [ ] 9.4 `system.md` §9.13 加知识库端点与数据集命名 `owb-<id>-g<代数>`。

Suggested fixture level: expanded - 两份真相（本地行与 RAGFlow 数据集）的创建与删除顺序，以及所有权判定。
Minimal mergeable slice: atomic - 建库、列表与删库共用所有权判定、数据集命名与一个用例文件；编译字段是建库请求与视图的一部分，拆开会出现「能建带开关的库却读不到编译状态」。

## 10. 工作空间来源入库（knowledge-bases「工作空间来源入库」「同一知识库的写操作串行」的入库场景）

- [ ] 10.1 核对 Context：
  - 读文件链路：`workspaces/rest.ts:412`、`rest-archive.ts:108-146`、`mounts/path-rule.ts:43`、`mounts/files.ts:80,94,135,166`、`regular-file.ts:55`；
  - `workspaces` 模块现有的导出：只从入口导入，不深入子目录；缺读取函数就在 `workspaces/index.ts` 加最小导出，同 PR 说明；
  - 组 1 的 multipart 字段、解析触发与编译触发结论；
  - 组 7 的锁。
- [ ] 10.2 测试先行：新 `server/test/kb-ingest-workspace.test.ts`。
  - knowledge-bases：「混合批次」「挂载离线」（S1b 的测试缝）「中途不可达」「逐条被拒」「读取期间文件变化」（测试缝在 `fstat` 之后追加字节）「文档数上限」「别人的工作空间」；
  - 「同一路径并发入库」「入库中删库」（夹具的挂起后放行）；
  - 「解析触发失败」；补偿删除失败时恰一行 `kb_document_leak`、该条结果不变；
  - `paths` 为空或超过上限 400；知识库非 `ready` 时 409；
  - 上传字节与源文件一致，multipart 的 `Content-Length` 等于实际字节；
  - 每份文档一条 `kb.ingest`、每个被拒条目一条 `kb.ingest_reject`，detail 键集同审计表；注入插行失败时没有 `kb.ingest` 且假 RAGFlow 收到删除；
  - 审计哨兵（knowledge-bases「detail 不含敏感内容」的工作空间入库一腿）；
  - 实测要求显式触发编译时：开了开关的库每份文档后有一次编译触发，两开关为 0 的库没有。
  
  新 `server/test/kb-multipart.test.ts`：长度计算、流拼接与字节计数中止，含非 ASCII 文件名。假 RAGFlow 加编译触发接口（实测要求显式触发时）。路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 10.3 实现：
  - 新 `server/src/kb/source-file.ts`：按 design D10 的第 1、3 步打开文件，返回 fd、`size` 与 `mtimeMs`；另给组 11 一个只 stat 的无审计变体。
  - 新 `kb/multipart.ts`。
  - 新 `kb/documents.ts`（入库部分，整批经该库写锁）。
  - `kb/rest.ts` 加 `POST /api/kb/bases/:id/documents`。
- [ ] 10.4 `system.md` §4 依赖规则加 `kb → workspaces`（经入口）与 `kb → models`；§9.13 加入库流程、逐条解析与拒绝原因表。

Suggested fixture level: expanded - 读路径经沙箱 `resolve` 与挂载（Critical Path：沙箱越界），并向外部服务上传用户文件。
Minimal mergeable slice: atomic - multipart 与 `source-file.ts` 只有入库一个消费者（组 11、12、13 复用在后），入库没有它们就无法上传。

## 11. 文档列表与状态（knowledge-bases「文档列表与状态」）

- [ ] 11.1 核对 Context：
  - 组 1 的文档列表分页、运行状态映射表与「不存在」组合；
  - 组 10 的 `source-file.ts` 与 `documents.ts`；
  - `core/sandbox` 的纯函数 `resolve`、facade 的 `mountNamesOf` 与 `store.rootOf`（`app.ts:295-297`）。
- [ ] 11.2 测试先行：新 `server/test/kb-documents-list.test.ts`。
  - 文档行由 store 直接插入；
  - 「状态映射」「源文件变更」「挂载来源的变更」（用 S1b 的挂载测试缝断言没有对挂载路径的同步调用）「源路径变成符号链接」；
  - 数据集 not-found 时全部 `missing`；
  - 挂载离线、工作空间已删除时 `sourceChanged: null`；
  - 超过一页时分页读全；RAGFlow 不可达 503；
  - `{documents}` 精确键集、no-store；读取不产生任何审计；
  - ragflow-backend「每个请求带密钥」：本组时建库、上传、列表、删除与版本请求都已可经端点触发，在这里做端点级断言。
  
  路由加进 `kb-disabled.test.ts`；假 RAGFlow 加分页与运行状态全集。
- [ ] 11.3 实现：`kb/documents.ts` 加列表与 `sourceChanged`（用 `source-file.ts` 的无审计 stat 变体）；`kb/rest.ts` 加 `GET /api/kb/bases/:id/documents`。

Suggested fixture level: expanded - 读路径经沙箱解析与挂载（stat），且是本地映射与 RAGFlow 状态的关联点。
Minimal mergeable slice: atomic - 一条路由、一个视图，状态映射与源文件变更都是同一个 `DocumentView` 的字段。

## 12. 本地上传入库（knowledge-bases「本地上传入库」）

- [ ] 12.1 核对 Context：
  - `workspaces/rest.ts:455-520`：独立 scope、octet-stream parser、`parseUploadName`（`:160`，未导出）、提前拒；
  - `upload.ts` 的计数 `Transform`；
  - 组 10 的 `multipart.ts`。
- [ ] 12.2 测试先行：新 `server/test/kb-upload.test.ts`。
  - 「上传不落盘」：断言 `SANDBOX_ROOT`、`OMP_STATE_DIR`、`os.tmpdir()` 前后目录清单相同；
  - 「超限与缺少长度」「客户端中断」「解析触发失败」；
  - 第 501 份 409 `kb_limit` 并有 `kb.ingest_reject`；499 份时两个上传并发（夹具的挂起后放行）：恰一个 201、一个 409 `kb_limit`，最终恰 500 行；
  - 文件名规则 400；`text/plain` 400；知识库非 `ready` 时 409；
  - 审计 detail 键集与哨兵（knowledge-bases「detail 不含敏感内容」的上传一腿）；
  - 实测要求显式触发编译时的触发分支。
  
  路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 12.3 实现：`workspaces` 入口导出 `parseUploadName`；新 `server/src/kb/uploads.ts`（经该库写锁）；`kb/rest.ts` 加 `POST /api/kb/bases/:id/uploads`。

Suggested fixture level: expanded - 流式转发用户上传到外部服务，且有不落盘的硬约束。
Minimal mergeable slice: atomic - 一条路由，与工作空间上传同一写法。

## 13. 移出与重新入库（knowledge-bases「重新入库与移出」）

- [ ] 13.1 核对 Context：组 10 的 `source-file.ts`、读取与上传链路；组 1 的文档删除应答与「不存在」组合。
- [ ] 13.2 测试先行（首刀，移出）：新 `server/test/kb-documents-remove.test.ts`。
  - 「移出不动源文件」；
  - ragflow-backend「不存在视为已删」的移出一腿；
  - 「重建失败后移出」的移出一腿（状态由 store 直接设置）；`rebuilding` 时 409；
  - RAGFlow 不可达 503 且行不变；
  - `doc` 参数缺失 / 为空 / 多值 400；不属于该库 404；
  - 审计哨兵（knowledge-bases「detail 不含敏感内容」的移出一腿）。
  
  路由加进 `kb-disabled.test.ts`。
- [ ] 13.3 实现（首刀）：`kb/documents.ts` 加 remove（经该库写锁）；`kb/rest.ts` 加 `DELETE /api/kb/bases/:id/documents`。
- [ ] 13.4 测试先行（剩余部分，重新入库）：新 `server/test/kb-documents-reingest.test.ts`。
  - 「重新入库」「源不可读」；
  - 「重建失败后移出」的重新入库一腿；
  - 工作空间已删除、`outside`、`offline`、`changed` 各一例 409 `kb_source_unreadable`；
  - 本地上传的文档 400；上传或解析触发失败时新文档被删除、行不变；
  - 旧文档删除失败只写 `kb_document_leak`；
  - 审计哨兵（重新入库一腿）；
  - 实测要求显式触发编译时的触发分支。
  
  路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 13.5 实现（剩余部分）：`kb/documents.ts` 加 reingest（经该库写锁）；`kb/rest.ts` 加 `POST /api/kb/bases/:id/documents/reingest`。

Suggested fixture level: expanded - 两份真相的替换顺序（新文档先建、旧文档后删）与沙箱读取。
Minimal mergeable slice: 13.2–13.3 的移出——一条不读沙箱的独立路由，组 16 的首刀与 `make smoke-kb` 都要用它，能独立保绿。剩余部分（重新入库，13.4–13.5）依赖它；剩余部分 atomic：一条路由。

## 14. 嵌入模型更换与全量重建（ragflow-backend「嵌入模型更换与全量重建」；knowledge-bases「同一知识库的写操作串行」的「上传与确认重建交错」）

- [ ] 14.1 核对 Context：
  - 组 8 的身份判定与设置锁；组 10 的上传；组 12 的本地上传；组 1 的下载与分块传输结论；
  - `server.ts` 里挂载恢复「`server_started` 之后不等待」的写法，以及关停次序；
  - `workspaces/mounts` 的恢复测试写法。
- [ ] 14.2 测试先行：新 `server/test/kb-rebuild.test.ts`（假 RAGFlow；重建器经注入的调度缝同步驱动）。
  - 「未确认不保存」「确认后重建」「原件缺失与分块下载」「中途失败与重试」；
  - knowledge-bases「上传与确认重建交错」；
  - 旧数据集删除失败只写 `kb_dataset_leak`；
  - ragflow-backend「不存在视为已删」的重建一腿：第 1 步删残留数据集得到「不存在」组合时照常继续；`rebuild_failed` 删库时两份数据集之一为「不存在」仍 204；
  - 重建器取锁后发现库已删除即跳过，不建数据集；
  - 重建中再改嵌入身份 409 `kb_rebuilding`；只改密钥不触发；
  - 锁被重建器持有时，入库、上传与重新入库立即 409；
  - `POST /api/kb/settings/rebuild` 的 403 / 401、bodyless 带 `{}` 400、无失败库时 200 且不写审计；
  - 审计的 detail 键集；确认重建那次保存恰写 `kb.settings` 与 `kb.rebuild` 两条；actor 等于 `rebuild_actor_id`；
  - 实测要求显式触发编译时，第 4 步的触发分支。
  
  编译入口用例：新 `server/test/kb-rebuild-restart.test.ts`。
  - 「崩溃后续做」，含 actor 断言；
  - 关停时在途请求被中止、库仍为 `rebuilding`；
  - 续做中的失败不输出 failure record、不改退出码。
  
  路由加进 `kb-disabled.test.ts` 与归属路由用例；假 RAGFlow 加原件下载（分块传输与带 `Content-Length` 两种）。
- [ ] 14.3 实现：
  - 新 `server/src/kb/rebuild.ts`（处理每库期间持有该库写锁）；
  - 组 8 的 PUT 开放 `confirmRebuild` 并写 `rebuild_actor_id`；`kb/rest.ts` 加 `POST /api/kb/settings/rebuild`；
  - 重建器的启动与关停接进 `startup-registry.ts`，`server.ts` 只加两次调用。
- [ ] 14.4 `system.md` §9.13 加重建流程、跳过规则、续做与 `kb_dataset_leak`。

Suggested fixture level: expanded - 后台进程内任务、跨重启的续做与关停次序（process lifecycle + persisted state），并与在途写操作交错。
Minimal mergeable slice: atomic - 确认开关一旦开放就必须有重建器，否则库永远停在 `rebuilding`；重建器没有确认入口就没有触发点。

## 15. web：API 客户端与中心「知识库」tab 的列表、建库、删库（model-registry「中心页外壳」；knowledge-bases「中心「知识库」tab」的状态行、列表与新建对话框）

- [ ] 15.1 核对 Context：
  - `web/src/features/center/tabs.ts:16-22` 与 `CenterPage` 的可见 tab 计算；
  - `web/test/center-page.test.tsx` 中钉住 tab 条与描述的行号；
  - `web/src/lib/api-connectors.ts` 的严格解析写法；`api.ts` 的 `ApiClient` 类型与再导出；
  - `web/test/api-files-archive.test.ts` 的 `OTHER_CLIENT_METHODS` 与精确键集；
  - `web/test/support.ts` 的 `centerRoutes()`。
- [ ] 15.2 测试先行。
  - `center-page.test.tsx`：「知识库 tab 随开关显隐」，以及既有场景的假状态 `{enabled:false}`；`support.ts` 的 `centerRoutes()` 加 `GET /api/kb/status` 缺省应答 `{enabled:false}`。
  - 新 `web/test/center-kb-list.test.tsx`（假 `ApiClient`）：
    - 「不可用与未就绪」「编译开关按模板显示」；
    - 建库恰一次请求与失败 alert；空态；删除确认；
    - `compile:null` 显示 `状态未知`。
  - 新 `web/test/api-kb.test.ts`：两份 spec 写明的每个应答形状的严格解析（多键、少键、类型不符即 `requestFailed`）。
- [ ] 15.3 实现：
  - 新 `web/src/lib/api-kb.ts`（全部知识库方法，含组 16、17 用到的）；`api.ts` 接线，同一刀更新 `web/test/api-files-archive.test.ts` 的 `OTHER_CLIENT_METHODS` 精确键集；
  - `tabs.ts` 加 `{key:"knowledge-bases", label:"知识库", adminOnly:false, requiresKb:true}` 与可见性计算；
  - 新 `web/src/features/center/kb/{panel.tsx,list.tsx,create-dialog.tsx,use-kb.ts,templates.ts}`。
- [ ] 15.4 验收清单新节「中心·知识库（CK）」，结论 `待签`，`web/test/functional-checklist.test.ts` 通过：
  - CK-01 未配置知识库时没有知识库 tab；
  - CK-02 建库并选模板；
  - CK-03 RAPTOR / 知识图谱开关按模板与对话模型显示；
  - CK-04 删库。

Suggested fixture level: expanded - 新 tab 与可见性规则（presentation + route guard）；按前端通用契约须有真实浏览器走查，组 18 补 ui-walk 分支。
Minimal mergeable slice: `api-kb.ts` 与 `web/test/api-kb.test.ts`（15.2 的第三项与 15.3 的第一项）——客户端与严格解析按 spec 写明的应答形状独立可测，组 17 只依赖它；被测试 entry 导入，knip 不报无用。剩余部分（tab 可见性、列表、建库、删库与 CK-01–04）依赖它；剩余部分 atomic：tab 一出现就必须有列表与建库，只有状态行的面板是无功能的占位 tab。

## 16. web：知识库详情（knowledge-bases「中心「知识库」tab」的详情、入库、上传、移出、重新入库与刷新）

- [ ] 16.1 核对 Context：
  - 文件页树组件与 `api-workspaces` 的目录列举；
  - S1g 上传的客户端 `web/src/lib/api-upload.ts`；
  - 组 15 的面板结构与 `api-kb.ts`。
- [ ] 16.2 测试先行（首刀）：新 `web/test/center-kb-detail.test.tsx`。
  - 「解析中自动刷新」：假时钟；页面隐藏时停；`unparsed` 不触发刷新；
  - 状态文案七种；
  - `源文件已变更` 只在 `true` 时显示；工作空间来源行都有 `重新入库`；
  - 移出；
  - 非 `ready` 时入库、上传与重新入库按钮不渲染；`rebuild_failed` 时 `移出` 仍渲染。
- [ ] 16.3 实现（首刀）：新 `web/src/features/center/kb/{detail.tsx,documents-table.tsx}`。
- [ ] 16.4 测试先行（剩余部分）：`center-kb-ingest.test.tsx`。
  - 入库对话框：选空间、浏览目录、勾选上限、提交恰一次、被拒条目逐条显示 `message`；
  - 上传：超数与超大在客户端就地拒绝，逐个请求。
- [ ] 16.5 实现（剩余部分）：新 `web/src/features/center/kb/{ingest-dialog.tsx,upload-button.tsx}`。
- [ ] 16.6 验收清单（各随所在切片的 PR），结论 `待签`：
  - CK-05 从工作空间入库后看到解析中，并自动变为已切片；
  - CK-06 本地上传入库；
  - CK-07 改写源文件后出现「源文件已变更」，重新入库后消失；
  - CK-08 移出文档后源文件仍在。

Suggested fixture level: expanded - 用户可见的入库流程与定时刷新（presentation + timers），组 18 的 ui-walk 走一遍。
Minimal mergeable slice: 16.2–16.3 的文档表、状态文案、定时刷新与行内操作（`移出`、`重新入库`）——只读写已有文档，能独立保绿，依赖组 11、13、15。剩余部分（`从工作空间入库` 对话框与 `上传文件`，16.4–16.5）依赖它与组 10、12；剩余部分 atomic：两个入口共用同一个入库结果显示。

## 17. web：模型 tab 的「知识库模型」段（model-registry「模型 tab」）

- [ ] 17.1 核对 Context：`web/src/features/center/models/{panel.tsx,form-dialog.tsx,list.tsx}` 的对话框、确认框与探活写法；组 15 的 `api-kb.ts`。
- [ ] 17.2 测试先行：新 `web/test/center-models-kb.test.tsx`。
  - 「更换嵌入模型需确认」；
  - 首次配置密钥必填；
  - 对话模型下拉只列带上游的模型加 `不使用`，改动恰一次请求；
  - 重建状态与 `重试失败的重建`；设置读取失败时的 `重试`；
  - 知识库关闭时整段不渲染；
  - 删除被引用的对话模型得到 409 `kb_model_in_use` 时，模型表行内显示信封文案、行仍在。
- [ ] 17.3 实现：新 `web/src/features/center/models/kb-section.tsx` 与 `kb-embedding-dialog.tsx`；`panel.tsx` 挂载该段。
- [ ] 17.4 验收清单，结论 `待签`：
  - CK-09 管理员配置嵌入模型与知识库对话模型；
  - CK-10 更换嵌入模型时弹确认，确认后各知识库重建完成。

Suggested fixture level: expanded - 管理员录入上游凭证的表单（credentials 触发项）与破坏性确认。
Minimal mergeable slice: atomic - 一段表单与它的确认框，一个组件用例文件。

## 18. 真实端点冒烟、走查与收口（verification-harness「知识库真实端点冒烟」「CI 接线与控制面同步」的 `smoke-kb` 登记；ragflow-backend「共用开发栈的使用纪律」）

- [ ] 18.1 核对 Context：
  - Makefile 的 `smoke-live` 写法与 `.PHONY`；
  - `smoke/fixtures/README.md` 与夹具复制脚本，以及现有 hurl 与 ui-walk 对 `u1/` 下工作空间列表的断言（新增工作空间目录是否影响它们）；
  - `web/e2e/ui-walk-layout.ts` 的 `/center` 分支；
  - `AGENTS.md` 验证矩阵与 Enforcement Index、`constraints.yaml` 的 verification 段；
  - `scripts/test-ci-harness.sh` 对 Makefile 目标、`.PHONY` 与 surface 数的同步检查。
- [ ] 18.2 测试先行（首刀）：`scripts/test-ci-harness.sh`。
  - 期望改为十一个 surface、五个同名 target，`smoke-kb` 的 Enforcement 为 `review-only`、`required_at: manual`；
  - 加 `smoke-kb` 的 spaced duplicate 变异，以及「`smoke-kb` 缺登记即非零」一例；
  - 加两个可复跑用例：以未设置的 `RAGFLOW_BASE_URL` 跑 `make smoke-kb`，非零且输出含 `RAGFlow 私有配置缺失`；以指向关闭端口的 `RAGFLOW_BASE_URL` 跑，非零且输出含 `共用 RAGFlow 栈未运行或版本不符`。两例都在发出任何知识库请求之前退出，且 Makefile 目标的文本不含 `docker`。
- [ ] 18.3 实现（首刀）：
  - 新 `smoke/kb.hurl` 与 `smoke/kb-cleanup.hurl`；
  - 新夹具工作空间 `smoke/fixtures/sandbox/u1/smoke-kb/`（一个小 Markdown 文件与一个小 PDF 文件，自制，无第三方版权），同步 `smoke/fixtures/README.md`；
  - Makefile 加 `smoke-kb`：两步前置检测；hurl 前后的清理；轮询上限变量 `SMOKE_KB_POLL_SECONDS`（缺省 300）；登录方式同 `smoke/chat.hurl`；
  - `AGENTS.md`、`constraints.yaml`、`.PHONY` 同步登记。
- [ ] 18.4 `make ui-walk` 的 `/center` 分支：知识库关闭（CI 的缺省配置）时 tab 条不含 `知识库`。
- [ ] 18.5 收口：
  - `docs/architecture/system.md` §9.13 收口（部署要求、回滚、`smoke-kb`）；§6.2 摄取流按最终实现补细节（逐条解析、拒绝原因）；
  - 验收清单 CK 节复核，并新增两行（结论 `待签`，由 owner 执行）：
    - CK-11 对接上共用栈的本机服务跑 `make smoke-kb` 通过，输出脱敏后附在签字记录；再以 `SMOKE_KB_POLL_SECONDS=1` 跑一次，确认非零退出且 `smoke-kb` 知识库已被清理（verification-harness「失败后清理」）；
    - CK-12 知识库开启时的中心「知识库」tab 手动走查。

Suggested fixture level: expanded - 真实外部服务冒烟与 harness 接线（smoke/UI harness + CI/production configuration）。
Minimal mergeable slice: 18.2–18.3 的 `smoke-kb` 目标、夹具与控制面同步——验证路径是 `make test-guardrails`；对真实 RAGFlow 的运行移到验收清单（CK-11），不是本组的合入条件。剩余部分拆成两刀，各一条验证路径：18.4 的 ui-walk 分支（`make ui-walk`），只依赖组 15，与首刀无依赖；18.5 的文档收口与 CK-11 / CK-12（`web/test/functional-checklist.test.ts`），依赖首刀，因为它要引用 `smoke-kb` 的写法。两刀各自 atomic：前者是一条断言，后者是同一次收口的文档与验收行。
