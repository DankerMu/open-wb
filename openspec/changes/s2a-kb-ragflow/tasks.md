# Tasks: s2a-kb-ragflow

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组（或宽度门禁拆出的切片）一个子 issue、一个 PR。
>
> 外部前提 P（owner 持有；Stage 5 建为独立 issue，正文写一行 `Depends on #<Epic>`——picker 只跳过 epic 与 `Depends on` 仍开着的 issue、不认标签，这一行让 agent 永远选不中 P；owner 做完后手动关闭）：
> - dsh-team 的共用栈运行 `v1.0.0-rc2`；
> - 在其 RAGFlow 界面注册 open-workbuddy 专用账号并生成 API key，key 文件 `0600` 放在仓库之外；
> - 本机 `CLAUDE.local.md` 新建「RAGFlow 共用栈」一节，记 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` 与实测用嵌入上游的变量名，并在 shell 环境 export。
>
> 依赖（真实依赖）：
> - 已合入：组 1（含 1.5）、2、3、4，组 7 的锁（7.4，#1837）。下面不再列它们。
> - 无未合入前置：组 5（夹具协议以实测记录为准）、组 7 首刀、组 15 首刀（`api-kb.ts`，不依赖服务端代码，只按 spec 写明的应答形状）。
> - 组 6 ← 5、7 首刀。组 8 ← 6、7 首刀。组 9 首刀 ← 8。
> - 组 10 ← 9 首刀（`kb/templates.ts` 的后缀表）。组 11 ← 10（复用 `kb/source-file.ts` 与 `kb/documents.ts`）。组 12 ← 10（复用 `kb/multipart.ts`）。组 13 ← 10。
> - 组 9 第二刀（pipeline：DSL、模板组、画布、开关开放）← 9 首刀，不依赖组 11。组 9 第三刀（`compile-status`）← 9 第二刀、11（编译状态复用文档列表的读取）。
> - 组 14 ← 8、9 第二刀、10、11、12、13（重建要建编译资源；组 11 的路由合入后才能断言路由表恰十二条；14.2 的「锁被重建器持有时立即 409」要用到组 13 剩余部分注册的重新入库路由）。
> - 组 15 剩余 ← 9 全部三刀、15 首刀。组 16 首刀 ← 11、13、15；剩余 ← 10、12、16 首刀。组 17 ← 8、14、15 全部（CK 节由组 15 剩余的 15.4 新建）。
> - 组 18 首刀 ← 5–17 全部；18.4（ui-walk 分支）← 组 15 剩余；18.5（收口）← 组 18 首刀。组 18 不依赖 P：真实 RAGFlow 运行是 owner 执行的验收行 CK-11。
>
> Epic 正文另列 design「Grill 结论」里标「待 owner 复核」的两处细化（第 4、13 行），等 owner 确认。
>
> 通用纪律：
> - 测试先行；每组第一个任务核对 design「Context」的行号与事实（主干在本 change 开工后可能已移动）。
> - 密钥、文件内容与 RAGFlow 应答原文不进任何响应、审计、日志；被跟踪文件、issue 与 PR 正文里 RAGFlow 地址一律写 `<RAGFLOW_BASE_URL>`。
> - 产品与测试文件单文件均 ≤800 行（`size-guard.sh` 两者都扫）。行数预算见 design D18：`server.ts` 现 755 行，组 6、14 各加自己的几行；`auth-lifecycle.test.ts` 797 行，组 6 先移出码表用例（6.2）。
> - 不新增 `.css`。
> - 需要真实 RAGFlow 的只有组 1（含 1.5），执行前按 design D16 检测；`RAGFlow 私有配置缺失` 与 `共用 RAGFlow 栈未运行或版本不符` 两种停止都在 issue 评论里报告、不开 PR、不拉起任何容器，并在本 issue 正文加一行 `Depends on #<P>`、重开 P（写明要 owner 做什么），让 picker 跳过本 issue。
> - 假 RAGFlow 夹具按组扩展（design D17），每组只加本组用到的接口，行为分两类：
>   - 协议应答：路径、字段、状态值与 code 必须在实测记录里有对应条目。
>   - 故障注入：用例显式脚本化，只限四种：传输层失败（挂起、挂起后放行、超时、连接失败、中途断开）；HTTP 层（3xx、5xx、非 JSON、超体积）；漂移值（不符的版本串、八种之外的 `ingestion_status`）；防御性组合（未观察到的路由上的 `code:403`；同一路由上别的 `100`、`101`、`102`；`DELETE /datasets` 的 `{code:0, data:{deleted:[]}}`；不带 `graph` 或不是恰一个 chunker 的内置 pipeline；`GET /models/default` 的 `data.models` 只有一种缺省；成功应答缺字段；HTTP 200 的 `code:401`）。
>   - `108`、`109` 与分块下载不进夹具。
> - 每个注册新知识库路由的组，在同一 PR 里：
>   - 把这些路由加进 `server/test/kb-disabled.test.ts` 的路由表（组 8 新建；ragflow-backend「未配置即关闭」）；
>   - 带 body 的路由加进 `http-parser-owners` 的真实路由用例（http-service-skeleton「知识库的归属路由」）。
> - 改变用户可见行为的组在同一 PR 增改验收行并写 `待签`（AGENTS.md:169-170）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（RAGFlow 密钥、嵌入 / 对话上游密钥进响应、审计、日志、omp 环境；`GET` 单实例回显密钥；共用栈地址进公开仓库） | 是 | 组 1 脱敏、组 4 密钥文件与 omp 环境用例、组 5 请求记录与不提供单实例读取、组 8 视图与审计哨兵 |
| 沙箱越界（入库读取绕过 `resolve`、跟随符号链接、读挂载离线；被动读取伪造越界审计） | 是 | 组 10、组 11（无审计解析）、组 13 |
| 两份真相（本地映射 vs RAGFlow 数据集 / 画布 / 模板组 / 文档） | 是 | 组 5 按路由的类型化结果、组 9 逐步回滚与删除次序、组 10–13 失败补偿删除与 `deleted:0`、组 11 `missing`、组 14 重建切换、跳过与续做 |
| 并发（同库写操作与重建交错、并发设置下发） | 是 | 组 7 锁、组 8 设置锁用例、组 9 第二刀建库与设置交错、组 10 同路径并发与入库中删库、组 14 上传与确认重建交错 |
| 外部接口漂移（rc2 文档与实例不符、预发行版） | 是 | 组 1 实测、组 5 夹具只按记录写、组 6 版本钉住、组 18 含编译的真实冒烟 |
| `code:0` 下的静默失败（`success_count:0`、`deleted:0`、DSL 省 `graph`、静默换解析器、RAPTOR 无信号） | 是 | 组 5 类型化结果、组 9 DSL 校验与编译状态、组 10 后缀判定与 `deleted:0` 的删除写法、组 13 调用方处理、组 15 文案 |
| 权限（他人知识库可探测、非管理员写设置） | 是 | 组 8、组 9 的 403 / 404 矩阵，组 10、11、12、13 各路由的他人与不存在 id 用例，组 10 他人工作空间 |
| 迁移与 DB 约束 | 是 | 组 7 |
| 共用外部资源（共用栈被拉起、停止或改配置；清空账号缺省使全栈入库进程崩溃循环） | 是 | 组 1、组 18 的检测与「不拉起」断言；组 5（5.3）的客户端无清空调用；组 8 的账号缺省不变量与对话模型锁定；组 9 第二刀与组 14 的 `GET /models/default` 前置读取 |
| 控制面漂移（退役后 oracle 与 CI 不一致；新增 `smoke-kb`） | 是 | 组 3、组 18 |

## 1. rc2 接口实测（ragflow-backend「RAGFlow 接口实测记录」「共用开发栈的使用纪律」）

- [x] 1.1 按 design D16 检测：
  - 从 shell 环境读 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE`。未设置或 key 文件不存在 → 报告 `RAGFlow 私有配置缺失`。
  - `curl "$RAGFLOW_BASE_URL/api/v1/system/version"` 不可达或不是 `v1.0.0-rc2` → 报告 `共用 RAGFlow 栈未运行或版本不符`。
  - 另执行一次只读的 `docker compose ls`，结果写进 issue 评论（只作观察，不作放行判据）。
  - 任一停止：issue 评论报告原因、本组不继续、不开 PR；在本 issue 正文加一行 `Depends on #<P>` 并重开 P（评论写明要 owner 做什么）。全程不执行任何 `docker` 写操作。
- [x] 1.2 用专用账号的 API key，按 spec 列出的十项逐项实测，写 `docs/reviews/2026-10-28-ragflow-rc2-api.md`。每节写请求与应答摘录和结论「支持 / 不支持」。另记三张表：运行状态到本系统 `status` 的映射表、「不存在」组合表、RAPTOR / 知识图谱的模板支持表。
- [x] 1.3 脱敏：地址写 `<RAGFLOW_BASE_URL>`；id、邮箱、昵称、账号名换占位符；不出现 key、key 路径与文件内容。对文档跑 `gitleaks detect --no-git --source docs/reviews/2026-10-28-ragflow-rc2-api.md`，并 grep 本机实际地址与账号名，两者零命中的输出附 PR 说明（输出本身也脱敏）。只删除本组建的 `owb-` 前缀数据集，在记录末尾写清理结果。
- [x] 1.4 结论的后果写进记录末尾，并在 Epic 下评论：
  - 「模型下发」不支持：按 design D7 的应急预案修订本 change（不再询问 owner），重过 Stage 3–4.5。修订过审前，组 6 及其后全部（组 7 除外）不开工。
  - 「编译开启或触发」不支持：按 design D14，组 9 及其全部下游与组 15 首刀等 owner 修订本 change；组 2–8 不受影响。
  - 模板支持表与 design D9 不符：修订本 change 后再开组 9。
  
  任一项触发时，本组在合入前建一个修订 issue R（标题「修订 s2a-kb-ragflow：<哪一节不支持>」，正文写一行 `Depends on #<Epic>`，picker 选不中它；修订以 stage-change-pipeline 进行：「模型下发」一项按 design D7 的预案修订，不需要 owner 的决定，由主会话在组 1 合入后启动；「编译」或「模板表」一项先等 owner 的决定再修订；过审后关闭），并在被停各组的根 issue 正文加一行 `Depends on #<R>`：模型下发为组 6 与组 15 首刀；编译或模板表为组 9 与组 15 首刀。其余被停的组本就（传递）依赖这些根，picker 不会选中。
  
  本组 PR 照常合入记录，不因结论为「不支持」而不合。
- [x] 1.5 补测（修订 #1863 追加，已完成）。结果在实测记录的 §5.3、§7.4、§8.2、§8.3、§14、§16 与 §18 #26–#32：
  - `GET /datasets/<id>/ingestions`：`total` 是日志行数；`page_size` 缺省 30，到 200 行没有测到上限；越界页回空 `logs`；缺省次序翻页丢行，`orderby=id` 加 `page_size=100` 可靠；没有按 `task_type` 过滤的参数。
  - `dsl.entries[]`：216 条日志都恰 1 项，按同一类型的并集读。
  - `task_type`：只开 RAPTOR 为 `Tree`，只开知识图谱为 `Graph`。
  - 应答字节：文档列表最坏 858 470，`compilation-templates/builtins` 32 202，任务日志一页 87 096，1 MiB 上限不变；`log_type=file` 一页 1 244 342，超限，不用。

  沿用 1.1 的检测与 1.3 的脱敏。只建 `owb-` 前缀的对象。建 pipeline 数据集之前确认两个缺省都在；清理照 §16 的次序：账号缺省保持不动，先删数据集、画布、模板组，静默到没有编译活动，才清缺省、删实例与提供方。没有 `docker` 写操作。

Suggested fixture level: compact - 只产出一份被跟踪的实测记录，不改产品代码；但它与凭证、共用栈地址邻接（须脱敏），又是组 5 夹具的唯一协议来源。
Minimal mergeable slice: atomic - 一份记录、一次对同一实例的实测；拆开会让夹具协议来自两次不同的观察。1.5 是修订追加的补测，已完成，随修订 #1863 提交。

## 2. 方向变更文档（Grill 结论 1、10、11；design Context「方向变更」）

- [x] 2.1 核对 Context：
  - ADR-0002、ADR-0005；`ATTRIBUTION.md:24-26`；
  - `CONTEXT.md:9,38,45,53`；`PLAN.md:21,32,47,94`；
  - `IMPLEMENTATION_PLAN.md`：S2a / S2b / S2c / S4a / S4b 各节、覆盖表、Open Decisions、Next Step、What Already Exists；
  - `resource/backend-research.md:63,155-165`；`README.md:4,22`；
  - `docs/architecture/system.md`：`:9`（§1）、`:17`（§2 约束）、`:43-53`（§3.2）、`:87-88`（§4 规则 4、5）、`:123`、`:128`（§5 目录树）、`:152`（§6.1 时序图）、§7。
- [x] 2.2 新 `docs/adr/0016-ragflow-service-backend.md`：
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
- [x] 2.3 `docs/architecture/system.md` 改写：
  - §1 组件说明与 §3.2 整节：把 kb-service 改为「外部 RAGFlow 服务 + app-server `kb` 模块」；
  - §2 约束：「omp 与 kb-service 不感知租户」改为「omp 与 RAGFlow 不感知租户」；
  - §3.1 的 `kb` 行：「先过滤 kb_ids 再调 kb-service」改为调 RAGFlow（组 6 只补端点细节）；
  - §4 规则 4、5：kb-service 相关规则改为 `kb` 模块的依赖规则，具体规则由组 8、10 落；
  - §5 目录树：删 `kbservice/src/kbservice/`；既有 `server/src/kb/` 一行的注释「kb-service 客户端」改为「RAGFlow 客户端与知识库端点」；
  - §6.2 摄取一行：「→ kb-service ingest」改为「app-server `kb` → RAGFlow」；
  - §6.1 时序图：参与者 kb-service 改为 RAGFlow；
  - §7 决策索引：加 0016。
- [x] 2.4 `ATTRIBUTION.md` 的 RAGFlow 条目改为「以服务形态部署，不吸收源码」；义务写为：发行物含 RAGFlow 镜像时附其 LICENSE 与 NOTICE。
- [x] 2.5 `CONTEXT.md`：
  - 项目本质里三个组件改为 app-server、web SPA 与外部 RAGFlow 服务；
  - 限界上下文「知识库」改为「app-server `kb` 模块 + RAGFlow」；
  - `:38`「kb-service 嵌入调用不经它」改为 RAGFlow 的说法；
  - 不变量 4 改为「RAGFlow API 密钥与模型网关密钥不得出现在 omp 子进程可读环境」。
- [x] 2.6 `PLAN.md` 的知识库四处（`:21,32,47,94`）改写，并互加对 ADR-0016 的引用。`IMPLEMENTATION_PLAN.md`：
  - S2a 一节改写为本 change（覆盖 F-CTR-KB1 / KB2 不变）；
  - S2b / S2c 的 kbservice 措辞改为 app-server `kb` 模块；
  - S4a 的回归对象去掉 kbservice；S4b 部署要求加 RAGFlow 全栈；
  - Open Decisions 的 deepdoc 一行关闭（随 ADR-0016 作废）；
  - What Already Exists 的 kbservice 一行改为「已退役（change s2a-kb-ragflow）」；
  - Next Step 更新到当天：P0 + P1 已交付，S2a 进行中。
- [x] 2.7 `resource/backend-research.md` 头部加一行「§1 的吸收方案已被 ADR-0016 取代」；`README.md` 两处同步。合入前 `grep -rn "kb-service\|kbservice" docs/architecture/system.md CONTEXT.md PLAN.md README.md` 只剩指向 ADR-0002 的历史引用，结果附 PR 说明。

Suggested fixture level: none - 只改文档与 ADR。
Width exception: merged-tasks - 七个任务写的是同一个方向变更；分开合入会让主干在一段时间里同时有两套互相矛盾的知识库架构说明。
Minimal mergeable slice: atomic - 理由同上。

## 3. kbservice 退役（verification-harness「CI 接线与控制面同步」「第三方 CI action 使用 Node 24 runtime」）

- [x] 3.1 核对 Context：
  - Makefile:10,17-19,23,28,30,35；
  - `.github/workflows/ci.yml:15,17,19,30,32,34,56,75`；
  - `scripts/inspect-ci-workflow.js:11,17`；`scripts/test-ci-harness.sh` 中的 uv / kbservice 变异；
  - `scripts/size-guard.sh:13,25`；`scripts/test-guardrails.sh:42-50`；`.jscpd.json:3,7`；
  - `.gitignore:26-27`；`constraints.yaml:66,77,93`；`deploy/app/Dockerfile.dockerignore:10`；
  - `AGENTS.md:36,38,47,57,143,145,146,175`；`openspec/project-profile.md:5,10,22,33,37,42`；
  - `server/test/omp-process.test.ts:43,56`。
- [x] 3.2 测试先行：`scripts/test-ci-harness.sh` 改写 oracle 期望：
  - setup-uv 计数为 0；`unit-tests` 与 `fast-checks` 的步骤序列去掉 uv / ruff / pytest。
  - 加 verification-harness「Python 工具链退役后不可回潮」的变异，各须非零：加回 setup-uv 加 ruff；加回 pytest；naming-guard、semgrep、size-guard、jscpd 的路径加回 `kbservice`。
  
  `scripts/test-guardrails.sh` 的 `.py` 样例改为 `.ts` / `.mjs` 样例，size-guard 的守卫能力不降。
- [x] 3.3 删除 `kbservice/`。同步删改：
  - Makefile、`ci.yml`、`inspect-ci-workflow.js`；
  - size-guard（路径与 `*.py`）、jscpd、`.gitignore`；
  - `constraints.yaml`：复杂度、覆盖率、死代码三行只留 Biome / vitest / knip；
  - dockerignore；
  - `AGENTS.md`：栈表、工具、目录树、模块边界两行、验证矩阵三行；
  - `project-profile.md`。
  
  `omp-process.test.ts` 的哨兵名改为 `RAGFLOW_API_KEY_FILE`，断言语义不变，行数不增。
- [x] 3.4 `make check`、`make test-guardrails` 本机全绿；PR CI 全绿，`all-checks-passed` 的 needs 不变。

Suggested fixture level: expanded - 改 CI workflow、控制面 oracle 与 `constraints.yaml`（CI/production configuration 触发项），并删除一个包目录；oracle 一旦改错会卡住全部合入。
Minimal mergeable slice: atomic - 删目录与删 CI 步骤必须同 PR：只删目录则 CI 的 `uv sync` 失败，只删步骤则 oracle 拒绝。

## 4. 配置键与密钥文件阶段（http-service-skeleton「服务启动与装配」的知识库键与 `kb_key`；ragflow-backend「知识库配置与密钥文件」）

- [x] 4.1 核对 Context：
  - `resolveServerConfig` 与四十二项（`server.ts:129-146`）；`preview-config.ts` 中 `PREVIEW_ORIGIN` 的正则；
  - `agent-config.ts` 中 `resolvePositiveInteger` / `assertHeaderSafeKey`（`:237`，未导出）/ `resolveOwnedPath`；
  - `StartupStage`（`server.ts:330-344`）与 `server-startup-failure-reason.test.ts`；
  - `startup-registry.ts` 的阶段函数写法；`regular-file.ts:55` 的 `openRegularFile`；
  - `OMP_CHILD_ENV_NAMES`（`spawn-env.ts`）；
  - `server.ts:756-799` 的 DB 文件准备函数。
- [x] 4.2 先做无行为变化的移动：把 `preparePrivateDbFiles`、`preparePrivateDbMain`、`prepareExistingSidecar`、`chmodExistingPrivateFile`（`server.ts:756-799`）移进 `startup-registry.ts` 并从那里导出，`server.ts` 改为导入。同一刀把 `server-assembly.test.ts`（798 行）的启动记录与注册次序用例原样移到新 `server/test/server-assembly-modules.test.ts`。两处都是纯移动：既有测试不改断言即全绿；PR 说明附移动前后的 `wc -l`。`server-config.test.ts` 正好 800 行，本 change 不往里加用例。
- [x] 4.3 测试先行。
  - 新 `server/test/kb-config.test.ts`：四键的缺省、配对规则、正则、正整数纪律；message 只含键名。
  - 新 `server/test/kb-key-file.test.ts`（单元层）：普通文件、符号链接、`0644`、`0640`、空文件、4097 字节、恰为 `\n\n`、去掉结尾 `\n`、含 `\r`；ragflow-backend「属主不符」（注入的 `getuid` 缝）。
  - 编译入口用例：新 `server/test/server-startup-kb.test.ts`。
    - ragflow-backend「密钥文件不合规即启动失败」的六例与合规一例；
    - http-service-skeleton「知识库键与密钥文件阶段」的前六例；`kb_key` 失败时 DB 文件不存在；
    - 最后一例（指向关闭端口、正常启动）本组只断言启动成功，模块仍为十一项，「十二项且最后是 `kb`」由组 6 断言。
  - 新 `server/test/kb-omp-env.test.ts`：ragflow-backend「密钥不进 omp 环境」，用假 omp 记录 spawn 环境。不加到 798 行的 `omp-process.test.ts`。
  - 同 PR 改钉住配置项数与阶段表的既有用例（4.1 核对时列全）。
- [x] 4.4 实现：
  - 新 `server/src/kb/config.ts` 与 `server/src/kb/key-file.ts`；`agent-config.ts` 导出 `assertHeaderSafeKey`；
  - `resolveServerConfig` 展开四键，注释里的项数改为四十六；`StartupStage` 加 `kb_key`；
  - 阶段函数放在 `startup-registry.ts`。
  
  读出的密钥经装配传给组 6 的 `kb` 模块：本组只把它存进一个只读句柄，暂无消费者，用 `knip` 豁免注释说明，组 6 删掉该注释。
- [x] 4.5 `docs/architecture/system.md` §9.13「知识库」新建，本组写配置键、密钥文件要求与 `kb_key` 阶段；§9.3 启动次序文字加 `kb_key`。

Suggested fixture level: expanded - 新配置键与凭证读取（credentials + production configuration）、新启动阶段。
Minimal mergeable slice: 4.2 的函数与用例移动——纯重构，不改行为，既有测试即验证。剩余部分（配置解析与 `kb_key` 阶段）依赖它；剩余部分本身 atomic：配置解析与 `kb_key` 阶段是同一对键的两半，只有解析没有阶段则密钥文件从不被校验，只有阶段没有解析则无从得到路径。

## 5. 假 RAGFlow 夹具与 RAGFlow 客户端（ragflow-backend「RAGFlow 出站请求」）

- [x] 5.1 核对 Context：
  - 组 1 的实测记录（全部路由、字段、状态值、code，表 A、表 B、§7.1、§8、§9.1）；
  - `models/probe.ts` 与 `connectors/probe.ts` 的传输骨架；`core/error-body.ts`、`core/upstream-failure.ts`；
  - `server/test/support/fake-upstream.mjs` 与 `fake-mcp-http.mjs` 的写法，及其 `.d.mts`；
  - `models-probe-helpers.ts` 的 `holdServer()` / `closedPort()`。
- [x] 5.2 测试先行：新 `server/test/support/fake-ragflow.mjs` 加 `.d.mts`。
  - 本组只实现：版本接口（`data` 为版本串）；数据集的建（校验 `parser_id` + `parse_type`，`chunk_method` 回 `101`，`tag` 回 `102`，`embedding_model` 传了但非三段式回 `102`，不传时成功）与删（`success_count`，不存在回 `code:403`）；文档的上传（字段 `file`，不支持的后缀回 `code:500`，同名改名 `a(1).txt`）、删除（`RUNNING`、`STOPPING` 回 `deleted:0`）、解析触发（`success_count`）、停止；下载（§9.1 的响应头：成功带 `Content-Disposition`，not-found 与 0 字节不带）。
  - 协议应答可脚本化：记录里出现过的 code；表 B 的全部「不存在」组合；下载内容设为恰等于 not-found 正文；中断的上传不留文档。
  - 故障注入按头部的四种：版本串；按路由挂起、挂起后放行、3xx、5xx、非 JSON、超体积；防御性组合。
  - 记录请求：方法、路径、查询串、是否带 key、JSON body、multipart 字段名、文件字节数与请求头 `Content-Length`。未知路由回 404 并记录，用例可断言没有发生。
  - 附夹具自测。

  新 `server/test/kb-ragflow-client.test.ts`（期望值取自实测记录）：
  - ragflow-backend「RAGFlow 出站请求」五条映射各一例；
  - 路由专属组合表逐行一例，含「路由各异的不存在组合」「成功码下的失败」与同路由别的 `102` / `100` 不被误判；
  - 「权限错误的防御性映射」：HTTP 401、`code:403` 写 `kb_upstream_auth_failed`，`DELETE /datasets` 的 `code:403` 不写；`kb_upstream_auth_failed` 在 60 秒内至多一行（注入时钟）；
  - 下载判别：带头时内容恰为 not-found 正文也是文件；不带头时 `code:404` 为 not-found，`code:500` 为 `kb_unavailable`；
  - 3xx 不跟随；响应体 1 MiB + 1 字节失败；
  - 版本请求不带 key、其余都带；空 id 的 `DELETE /datasets` 不发出；空 `api_key` 的请求不发出；
  - 结果对象与 stderr 不含假 RAGFlow 返回的 message 哨兵。
- [x] 5.3 新 `server/src/kb/ragflow-client.ts`：按 design D4 提供 JSON 请求、流式上传、流式下载三种调用，返回类型化结果（`not_found`、`unsupported_file`、`parse_not_started`、`not_deleted`），期限可注入。客户端不提供 `GET …/instances/<实例>`，也不提供清空缺省与 `/providers` 下的删除。本组只交付客户端，不挂路由。
- [x] 5.4 `RAGFLOW_BASE_URL` 拒绝 userinfo（http-service-skeleton「RAGFLOW_BASE_URL 不接受 userinfo」）。#1839 合入的写法与 `PREVIEW_ORIGIN` 共用 `SCHEME_AND_AUTHORITY`，接受 `https://u:p@h`。
  - 测试先行：`server/test/kb-config.test.ts` 加 `https://u:p@h`、`https://h@i:9380` 两例，message 含键名、不含输入值，先看到红。
  - 实现：`server/src/kb/config.ts` 在 `SCHEME_AND_AUTHORITY` 之外另判 `@`。共用常量与 `PREVIEW_ORIGIN` 的规则不动。
  - `docs/architecture/system.md` §9.13 的键表同步：现写「写法同 `PREVIEW_ORIGIN`」，改为另写明不接受 userinfo。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials），并定下全部知识库端点共用的失败映射。
Minimal mergeable slice: atomic - 夹具没有客户端就没有消费者，客户端没有夹具无法按规格验证；共一条验证路径。5.4 是对同一个出站地址的配置收紧，放在客户端落地的这一刀，同 PR。

## 6. 错误码、`kb` 模块装配与状态端点（http-service-skeleton「统一错误信封」「Shared agent module assembly」；ragflow-backend「知识库状态端点」「知识库可用性」的状态部分）

- [x] 6.1 核对 Context：
  - 组 1 实测记录版本接口一节（`data` 字段）；
  - `core/errors/index.ts` 的二十五码；`http/errors.ts` 的状态映射与三十一条归属身份；
  - `http-parser-owners.test.ts:28,174-178`、`http-typed-errors.test.ts:132-134`、`auth-lifecycle.test.ts:705` 的计数；
  - `STARTUP_MODULES` 与模块列表断言的实际清单：`server-assembly-modules.test.ts`（两处）、`connectors-rest-restart`、`models-rest-restart`、`server-startup-model-seed`、`server-startup-mounts`、`server-startup-order`、`server-startup-preview`，另有 #1839 加的 `server-startup-kb` 的 `ELEVEN_MODULES`；
  - `server-assembly-modules.test.ts` 的 `spyRegistrationOrder`；
  - `app.ts` 的 `registerConnectors` 位置与 `AssemblyDependencies`。
- [x] 6.2 测试先行（首刀）：
  - 先做纯移动：`auth-lifecycle.test.ts` 797 行，加 12 码必超 800。把它的码表 `describe`（`:705-770`，含 `codes` 表、两个穷尽守卫与信封用例）连同所需导入移到新 `server/test/http-error-codes.test.ts`，断言不改，移动后全绿；PR 说明附移动前后的 `wc -l`。
  - 新 `server/test/http-typed-errors-kb.test.ts`：「十二个知识库码」。
  - `http-parser-owners.test.ts`：三十八条，七条 PUT、三十条 POST、一条 PATCH。七条新身份在本组先登记，路由由组 8–14 注册；先例见 `http/errors.ts` 注释里的 `POST /api/models/probe`。
  - 同 PR 把 `http-typed-errors.test.ts`、`http-error-codes.test.ts` 的「二十五码」改为三十七，`codes` 表加 12 码。
- [x] 6.3 实现（首刀）：`core/errors` 加十二码；`http/errors.ts` 的状态映射、归属集与计数措辞。
- [ ] 6.4 测试先行（剩余部分）：
  - 把 6.1 清单里的模块列表断言改为十二项、最后为 `kb`，在 `spyRegistrationOrder` 加 `registerKb`；
  - `server-startup-kb.test.ts` 的「知识库键与密钥文件阶段」最后一例改为模块恰为十二项且最后是 `kb`，删掉 `ELEVEN_MODULES`。
  
  新 `server/test/kb-status.test.ts`（`app.inject()` + 假 RAGFlow）：
  - 「版本钉住」；未配置时 `{enabled:false}`；
  - `embeddingReady` 与 `compileReady` 随 `kb_settings` 变化（store 直接写入）；
  - 未登录 401；no-store。
- [ ] 6.5 实现（剩余部分）：
  - 新 `server/src/kb/index.ts` 与 `kb/rest.ts`：本组只有 `GET /api/kb/status`，以及 `/api/kb/*` 的关闭判定——preParsing 在 cookie guard 之后、管理员判定与 body 解析之前返回 503 `kb_disabled`；关闭判定由后续各组的路由用例验证。
  - `app.ts` 在 `registerConnectors` 之后注册 `kb`；`STARTUP_MODULES` 加 `kb`（`server.ts` +1 行）。
  - 组 4 的密钥句柄经 `createApp` 交给 `kb` 模块（`server.ts` +1 行），删掉 knip 豁免注释。
  - `AssemblyDependencies` 加一个 `kb` 字段，类型 `KbDependencies` 由 `kb/index.ts` 导出：密钥句柄、地址、两个上传上限，期限与测试缝可选（测试注入）；后续各组只扩这个类型；`app.ts` 除组 8 剩余的 `modelWriteGuard` 接线外不再改。
- [ ] 6.6 `system.md` §3.1 的 `kb` 行补状态端点，`core/errors` 行改为三十七码；§9.13 加状态端点、版本钉住与两条 stderr 记录。

Suggested fixture level: expanded - 改共享错误信封与装配（Fastify assembly/routes/hooks 触发项）。
Minimal mergeable slice: 6.2–6.3 的码表用例移动、十二码与七条归属身份登记——码表与归属集是纯数据，先合不改变任何已注册路由的行为，带「十二个知识库码」与三十八条计数用例。剩余部分（`kb` 模块装配、关闭判定与状态端点）依赖它；剩余部分 atomic：模块一注册就必须进启动记录，启动记录与注册次序断言要同 PR 改。

## 7. 迁移 050、store 与锁（knowledge-bases「迁移 050 知识库 schema」「同一知识库的写操作串行」的锁本身）

- [x] 7.1 核对 Context：
  - 迁移目录最后为 049；049 头注的写法；
  - `server/test/core-db-helpers.ts` 的 `TRACKED_MIGRATION_FILENAMES`、`COMPLETE_CATALOG`（回执与 `sequenceRows`）；
  - `auth-schema.test.ts:496-515` 业务表清单；`core-db-session-fixture.ts:311` 的索引排除清单；
  - `core-db-chat-step-output.test.ts:75-93` 与 `migration-034.test.ts` 的 seed 过滤清单。
- [x] 7.2 测试先行。
  - 新 `server/test/kb-store.test.ts`（`:memory:` + 真实迁移；表形状与逐列约束在 `kb-schema.test.ts`，设置读写在 `kb-store-settings.test.ts`，夹具在 `kb-store-helpers.ts`）：
    - 「约束」场景的九例（含 `tag`、`audio` 被拒与画布、模板组两组列的 CHECK）；`kb_settings` 唯一行；
    - store 的设置读写（含 `rebuild_actor_id`）；
    - 知识库增删查（按 owner；计数供 50 上限用；开编译的库数供 `compileBases` 与 `kb_chat_model_locked` 用）；
    - 文档增删查（计数供 500 上限用）；
    - `(kb_id, workspace_id, source_path)` 唯一；
    - 重建状态与 `rebuild_dataset_id`、`rebuild_canvas_id`、`rebuild_template_group_id` 的读写，切换时三列整体换入并置空；级联。
  - 同 PR 改 7.1 列出的既有快照用例（属首刀：它们随迁移 050 变化）。
- [x] 7.3 实现：`050_knowledge_bases.sql`；新 `server/src/kb/store.ts`（只读写本地三张表，不发出站请求）。
- [x] 7.4 锁（design D20）已由 #1837 落地：`server/src/kb/locks.ts` 与 `server/test/kb-locks.test.ts`。覆盖：
  - 同一知识库的两个写操作串行、不同知识库并行；
  - 锁被重建器持有时写操作立即得到「重建中」结果而不排队；
  - 设置锁串行；锁在异常路径上释放；
  - 两把锁都按到达次序交锁（FIFO）：持锁期间依次排入三个等待者，放行后执行次序与排队次序相同；等待者计数随排队与交锁增减。

Suggested fixture level: expanded - 新迁移与凭证落库（persisted schema + credentials at rest），以及全部写路径共用的并发原语。
Minimal mergeable slice: 迁移 050 与 store（7.2、7.3）——迁移没有 store 就没有读者，store 是三张表唯一的写入口。锁（7.4）已合入。组 6、组 8 依赖这一刀。

## 8. 知识库模型设置、下发与 models 联动（ragflow-backend「知识库模型设置」；model-registry「模型管理端点」）

- [ ] 8.1 核对 Context：
  - 组 1 实测记录的 §11（请求形状）、§13（崩溃循环）、§5.5（`llm_id` 固化与缺省嵌入模型）；
  - `models/rest.ts` 的 `adminOnly` preParsing、`perIdChain`、审计包装、`upstreamChanged` 的判定；
  - `models/probe.ts` 的探活写法；组 6 的 `kb/rest.ts`；组 7 的 store 与锁。
- [ ] 8.2 测试先行（首刀）：新 `server/test/kb-settings.test.ts`（`app.inject()` + 假 RAGFlow + 假嵌入上游；假嵌入上游复用 `fake-upstream.mjs`，或在本组给它加 `/embeddings`）。
  - 「下发失败不改设置」；
  - 「下发的请求序列」「换模型时 model_info 只增不减」：首次 `POST`、再次先读模型列表再 `PUT`；省略 `apiKey` 时 `PUT` 带已存密钥；重复下发不发 `POST`；
  - 「名称不能含 @」；
  - 「账号缺省不被清空」的设置路径：断言请求记录里没有 `/providers` 下的 `DELETE`、没有空名字的 `PATCH /models/default`；`chatModelId:null` 时假 RAGFlow 收到零个请求；
  - 「开编译的库锁定对话模型」的设置一腿：置 `null`、换 id 都 409 `kb_chat_model_locked`，同 id 照常下发，库行由 store 直接插入；
  - 「非管理员」：本组的三条路由；`POST /api/kb/settings/rebuild` 的一腿留到组 14；
  - 「并发设置写入」（夹具的挂起后放行）；
  - 键集与类型 400；`{}` 400；`chatModelId` 不存在或无上游 400；「嵌入模型密钥的取值」（含 `apiKey:""` 400）；
  - 「只含嵌入模型的保存重发对话模型」，含该行没有上游时跳过与 `owb-chat` 下发失败；
  - 「取消指定的无操作」；
  - 「compileBases 的口径」（库行由 store 直接插入）；
  - 读视图的精确键集（含 `compileBases`），不含密钥哨兵；审计 detail 不含哨兵，键集同 knowledge-bases「知识库审计」；
  - 「探活」：`ok` / `failed` 与写回、`kb.settings {probe}`；未配置时 409 `kb_not_ready`；
  - 嵌入身份变化且已有知识库时一律 409 `kb_rebuild_required`：`confirmRebuild` 由组 14 开放，本组带了也 409，用例写明这一点。

  本组三条路由加进新建的 `server/test/kb-disabled.test.ts`；`PUT /api/kb/settings` 与 `POST /api/kb/settings/probe` 加进归属路由用例。假 RAGFlow 加 `PUT /providers`、`GET /models`、实例的建与改、实例的模型列表与账号缺省模型的 `PATCH` / `GET`（§11.1、§11.2、§11.4，`GET` 的 `data.models` 可脚本化为空或缺一种，组 9、14 用），重复 `POST` 实例回 `code:500`，`PUT` 不带 `model_info` 回 HTTP 400，`api_key` 空串清空密钥；不加单实例 `GET`。
- [ ] 8.3 实现（首刀）：新 `server/src/kb/settings.ts`（读视图、校验、`chatModelId` 取值规则、下发的固定序列、身份判定，全部写入经设置锁）；`kb/rest.ts` 加 `GET` / `PUT /api/kb/settings` 与 `POST /api/kb/settings/probe`。
- [ ] 8.4 测试先行（剩余部分）：
  - ragflow-backend「对话模型联动」「开编译的库锁定对话模型」的轮换一腿「联动与设置交错」「删除与设置交错」（夹具的挂起后放行；两种进锁次序各一例：A 先持锁；或先让第三个持锁者 C 的嵌入设置 PUT 挂起，再让 B、A 依次排队——用 `locks.ts` 的等待者计数确认 B 已在排队后再发出 A）；
  - model-registry「知识库对话模型受保护」「校验先于下发」「删除不碰 RAGFlow」，写进新 `server/test/kb-models-guard.test.ts`；
  - 知识库关闭时 `models` 的删除与修改行为与本 change 之前一致（既有 `models-*.test.ts` 不改即绿）。
- [ ] 8.5 实现（剩余部分）：
  - `models/store.ts`：从 `update` 拆出纯函数 `planUpdate(id, body)`，做 `parseUpdate`、未知 id 判定与候选上游的计算（含 userinfo 沿用），返回候选上游 `next` 与 `changed`，不写库；`update` 在事务里复用它，行为不变。`upstreamChanged` 的判定式不变，从 `rest.ts` 挪到这里；
  - `AssemblyDependencies` 加可选 `modelWriteGuard`（`kb` 注册晚于 `models`，由 `app.ts` 把钩子绑给 `models`）：`DELETE` 交写入回调；`PUT` 交写入回调与 `plan`（绑定了 id 与 body 的 `planUpdate`）。钩子在设置锁内依次调用 `plan`（校验先于下发，候选上游与是否变化由它给出，放在锁内是为了读到锁内的行）、做引用判定、需要时按 `next` 重新下发、再执行回调。钩子为空时直接执行；
  - `kb` 注册时提供该钩子；`models/rest.ts:185` 注释里「判定与写入之间没有 await」的前提随之改为「判定与写入在设置锁内」，同 PR 改注释；
  - `core/errors` 的 `kb_model_in_use`、`kb_chat_model_locked` 由组 6 登记。
- [ ] 8.6 文档，各随所在切片的 PR：
  - 首刀：`system.md` §9.13 加设置端点、下发的固定序列、账号缺省不变量与「取消指定不撤销：上游密钥留到下一次下发覆盖或运维清理」。`docs/adr/0016-ragflow-service-backend.md` Consequences「RAGFlow 持有嵌入与知识库对话模型的上游密钥」一条写明取消指定不撤销，并删去「组 1 实测 rc2 不能用 API key 下发模型时」那句（组 1 结论为支持）。
  - 剩余：`system.md` §4 依赖规则加 `models` 经注入钩子回调 `kb`、不形成反向依赖；§9.13 加对话模型的轮换联动。ADR-0016 同一条的「删除与轮换经联动同步」改写为轮换联动（design D7）。

Suggested fixture level: expanded - 管理员写路径与凭证（Auth / credentials 触发项），并向外部服务推送凭证；剩余部分改既有 `models` 端点的写入路径。
Minimal mergeable slice: 8.2–8.3 的设置读写、下发与探活，连同 8.6 的首刀部分——三条新路由、一个用例文件，能独立保绿。剩余部分（`models` 联动钩子，8.4–8.5 与 8.6 的剩余部分）依赖它；剩余部分 atomic：钩子只有删除与改上游两个调用点，共用一次引用判定。

## 9. 建库、删库与编译资源（knowledge-bases「知识库端点」；ragflow-backend「RAGFlow 出站请求」的端点级场景、「知识库可用性」的「不可达不阻断」）

- [ ] 9.1 核对 Context：
  - 组 1 实测记录的 §4、§5（含 §5.1 (3) 的节点表、§5.3 的任务日志读法）、§11.2、表 B、表 C；
  - 组 8 的设置读取（嵌入就绪、对话模型就绪）与设置锁；
  - demo 的 `kbMethods`（`resource/workbuddy-live-demo.html:1473-1486`）：说明文案沿用，`raptor` 标志与 `tag` 项不用。
- [ ] 9.2 测试先行（首刀）：新 `server/test/kb-bases.test.ts`。
  - knowledge-bases：「普通模板的建库请求」「普通模板的隔离」「开关校验」「删库」「知识库数上限」；
  - 两开关都为 0 时 201 的 `BaseView`：`state`、`stateMessage`、`documents`、`compile` 的取值（「建库应答不读 RAGFlow」的这一腿）；
  - 判定 2–4 在设置锁内：设置锁被占用时建库排队，放行后读到锁内的设置行；
  - ragflow-backend：「结果映射」（经 `POST /api/kb/bases`）、「不存在视为已删」的删库一腿（`DELETE /datasets` 的 `code:403`）、「不可达不阻断」；
  - 名称规则；重名 409 `conflict`；
  - 插行失败时删掉刚建的数据集（注入 store 失败），且没有 `kb.create`（knowledge-bases「写入失败不留审计」的建库一腿）；
  - `rebuilding` 时删库 409；`rebuild_failed` 时两开关都为 0 的库删两代的数据集（状态由 store 直接设置）；
  - 列表 `{bases}` 精确键集、按 `created_at` 升序、no-store；两开关为 0 的库不发编译请求；
  - 审计 `kb.create` / `kb.delete` 的 detail 键集；
  - 本刀里 `raptor` 或 `graph` 为真一律 400 `bad_request`，用例写明这一点，第二刀开放。

  本组三条路由加进 `kb-disabled.test.ts`，`POST /api/kb/bases` 加进归属路由用例。
- [ ] 9.3 实现（首刀）：新 `server/src/kb/bases.ts`（建库经设置锁，删库经该库写锁）与 `kb/templates.ts`（十一种模板、`parser_id` 映射、抄自表 C 末列的后缀表；web 只用模板与说明文案，见组 15）；`kb/rest.ts` 加 `GET` / `POST /api/kb/bases` 与 `DELETE /api/kb/bases/:id`。
- [ ] 9.4 `system.md` §9.13 加知识库端点、数据集命名 `owb-<id>-g<代数>` 与模板表。已合入的规划文档同 PR 改口径：`PLAN.md:68`、`CONTEXT.md:29`、`IMPLEMENTATION_PLAN.md:118,415` 的「12 种」改为 11 种，`chunk_method` 改为 `parser_id`（行号先核对）。
- [ ] 9.5 测试先行（第二刀，pipeline）：
  - 新 `server/test/kb-pipeline.test.ts`（纯函数，design「Sketch seams」）：DSL 生成的输入是内置 DSL，期望值取自实测记录 §5.1 (6) 手写 DSL 的 `components` 与 `graph`：节点、`upstream` / `downstream` 改写、`graph.nodes` 的 `compilationNode`、边净增一条且原边不保留、`graph` 必在。按 `component_name` 查 chunker，十一种模板的节点名与下游全部取自 §5.1 (3)（`qa`、`table` 的下游是 Tokenizer，其余九种是 Extractor）。没有 `graph`、零个或两个 chunker 即失败（故障注入）。`tree` 的 `config` 去掉 `entity`、`relation`、`llm_id`，`knowledge_graph` 的去掉 `llm_id`。
  - 新 `server/test/kb-bases-compile.test.ts`（`app.inject()` + 假 RAGFlow）：knowledge-bases「建库与列表隔离」「建库应答不读 RAGFlow」「账号缺省缺失时不建编译资源」「建库与设置交错」「十一种模板都能开两个开关」「只开一种编译」「建库中途失败逐步回滚」「回滚里的删除失败」「DSL 无法改写」「删除次序」「重建失败时删库」。列表里开了开关的库，本刀 `compile` 为 `null`，不发编译读取，用例写明这一点，第三刀接上。
  - 假 RAGFlow 加内置模板、模板组的建与删、`GET /pipelines/<parser_id>`（十一种模板的节点名与下游取自 §5.1 (3)；`tag` 回 `102`）、画布的建与删、`parse_type:2` 数据集。夹具的 Compiler 不校验 DSL：DSL 的正确性由纯函数用例与 `make smoke-kb` 负责。
- [ ] 9.6 实现（第二刀）：新 `server/src/kb/pipeline.ts`（`createPipeline`，第一步读账号缺省；`deletePipeline`；DSL 生成；删画布与删模板组只有它调用）；`POST /api/kb/bases` 开放两个开关；删库改走 `deletePipeline`。
- [ ] 9.7 `system.md` §9.13 加模板组与画布的生命周期、账号缺省的前置读取与删除次序。
- [ ] 9.8 测试先行（第三刀，`compile-status`）：新 `server/test/kb-compile-status.test.ts`（`app.inject()` + 假 RAGFlow）。
  - knowledge-bases「编译状态读取有界」「编译状态按任务日志判定」「只有 0 切片的文档」「类型只看 task_type」；
  - 读法：任务日志请求都带 `orderby=id` 与 `page_size=100`，不带 `task_type=`、`keywords=`、`log_type=`；日志超过一页时读全，`done` 依赖后面的页；`dsl.entries[].doc_id` 取同一类型的并集；
  - 有文档在解析时假 RAGFlow 没有收到任务日志请求；文档列表 `code:404` 时该库 `compile` 为 `null`。

  假 RAGFlow 加任务日志，按 §5.3：`orderby=id`、`page_size`、`total` 是日志行数、越界页回空 `logs`，`task_type=` 不过滤。
- [ ] 9.9 实现（第三刀）：新 `server/src/kb/compile-status.ts`（design D14 的判定，复用组 11 的文档列表读取）；列表接上编译状态。
- [ ] 9.10 `system.md` §9.13 加编译状态的判定，含 RAPTOR 无信号的已知限制。

Suggested fixture level: expanded - 两份真相（本地行与 RAGFlow 数据集、画布、模板组）的创建与删除顺序，以及所有权判定。
Minimal mergeable slice: 9.2–9.4 的普通模板建库、列表与删库——走 `parse_type:1`，组 10–13 都能在它上面开工，能独立保绿。剩余部分拆成两刀，各一条验证路径：第二刀（9.5–9.7）是 pipeline，依赖首刀，不依赖组 11，atomic：DSL、模板组、画布与开关开放是同一条静默失败路径；合入后开了开关的库在列表里 `compile` 为 `null`，web 在组 15 剩余才渲染，用户看不到。第三刀（9.8–9.10）是 `compile-status`，依赖第二刀与组 11，atomic：一个判定函数接到列表上。

## 10. 工作空间来源入库（knowledge-bases「工作空间来源入库」「同一知识库的写操作串行」的入库场景；「重新入库与移出」的删除写法）

- [ ] 10.1 核对 Context：
  - 读文件链路：`workspaces/rest.ts:412`、`rest-archive.ts:108-146`、`mounts/path-rule.ts:43`、`mounts/files.ts:80,94,135,166`、`regular-file.ts:55`；
  - `workspaces` 模块现有的导出：只从入口导入，不深入子目录；缺读取函数就在 `workspaces/index.ts` 加最小导出，同 PR 说明；
  - 组 1 的 §7（multipart 字段、文件名写法、中断的上传、后缀与模板）、§8.1、§8.5；
  - 组 7 的锁；组 9 的 `kb/templates.ts` 后缀表。
- [ ] 10.2 测试先行：新 `server/test/kb-ingest-workspace.test.ts`。
  - knowledge-bases：「混合批次」「路径不存在」「挂载离线」（S1b 的测试缝）「中途不可达」「逐条被拒」「读取期间文件变化」（测试缝在 `fstat` 之后追加字节）「文档数上限」「别人的工作空间」；
  - 「文档路由的所有权」的 `POST …/documents` 一腿：他人与不存在的 id 404，零出站，无审计；
  - 成功条目的视图：`queued`、`chunkCount:null`、`message:null`、`sourceChanged:false`，假 RAGFlow 没有收到文档列表请求；
  - 「后缀与空文件」（含大写后缀、无后缀、0 字节）「不支持的后缀不中止整批」；
  - 「同一路径并发入库」「入库中删库」（夹具的挂起后放行）；
  - 「解析触发失败」（HTTP 503、`code:101`、`success_count:0` 三种）；补偿删除失败时恰一行 `kb_document_leak`、该条结果不变；
  - `paths` 为空或超过上限 400；知识库非 `ready` 时 409；
  - 上传字节与源文件一致，multipart 的 `Content-Length` 等于实际字节，字段名为 `file`；
  - 每份文档一条 `kb.ingest`、每个被拒条目一条 `kb.ingest_reject`，detail 键集同审计表；注入插行失败时没有 `kb.ingest` 且假 RAGFlow 收到删除；
  - 审计哨兵（knowledge-bases「detail 不含敏感内容」的工作空间入库一腿）；
  - 全程没有编译相关请求。

  新 `server/test/kb-multipart.test.ts`：长度计算、流拼接与字节计数中止，含非 ASCII 文件名（断言原始 UTF-8 或 `filename*`，不是百分号编码）。新 `server/test/kb-delete-document.test.ts`：D13 的删除写法，结果逐项：`deleted:1`、`not_found`、`deleted:0` 后停止再成功、到期 `busy`（期限经注入缩短）；停止回 `success_count:0` 继续；停止 `not_found` 继续；停止不可达 `failed` 且不再删；重试期间不可达立即 `failed`；`STOPPING` 时恰一次停止（knowledge-bases「停止已在 STOPPING 的文档」「停止解析的其余结果」「重试期间不可达」，这里在 helper 层，端点层在组 13）。路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 10.3 实现：
  - 新 `server/src/kb/source-file.ts`：按 design D10 的第 1、4 步打开文件，返回 fd、`size` 与 `mtimeMs`；另给组 11 一个只 stat 的无审计变体。
  - 新 `kb/multipart.ts`。
  - 新 `kb/documents.ts`（入库部分，整批经该库写锁；design D13 的文档删除写法在这里实现，组 12、13、14 复用）。
  - `kb/rest.ts` 加 `POST /api/kb/bases/:id/documents`。
- [ ] 10.4 `system.md` §4 依赖规则加 `kb → workspaces`（经入口）与 `kb → models`；§9.13 加入库流程、逐条解析、后缀判定与拒绝原因表。

Suggested fixture level: expanded - 读路径经沙箱 `resolve` 与挂载（Critical Path：沙箱越界），并向外部服务上传用户文件。
Minimal mergeable slice: atomic - multipart 与 `source-file.ts` 只有入库一个消费者（组 11、12、13 复用在后），入库没有它们就无法上传。

## 11. 文档列表与状态（knowledge-bases「文档列表与状态」）

- [ ] 11.1 核对 Context：
  - 组 1 的 §8.3、§8.4 与表 A（`ingestion_status`、`chunk_count`、`page_size` 超限回落）、表 B 的文档列表一行；
  - 组 10 的 `source-file.ts` 与 `documents.ts`；
  - `core/sandbox` 的纯函数 `resolve`、facade 的 `mountNamesOf` 与 `store.rootOf`（`app.ts:295-297`）。
- [ ] 11.2 测试先行：新 `server/test/kb-documents-list.test.ts`。
  - 文档行由 store 直接插入；
  - 「状态映射」（八种取值加 `missing`）「0 切片」「未知运行状态」「源文件变更」「挂载来源的变更」（用 S1b 的挂载测试缝断言没有对挂载路径的同步调用）「源路径变成符号链接」；
  - 「数据集丢失」（`code:404`）；
  - 「文档路由的所有权」的 `GET …/documents` 一腿；
  - 挂载离线、工作空间已删除时 `sourceChanged: null`；
  - 超过一页时分页读全，请求都带 `page_size=100`、`orderby=create_time`、`desc=false`；`total` 大于 500 时不截断；RAGFlow 不可达 503；
  - `name` 取本地记录：假 RAGFlow 列表里是 `a(1).txt` 时视图仍为本地名；
  - `{documents}` 精确键集、no-store；读取不产生任何审计；
  - ragflow-backend「每个请求带密钥」：本组时建库、上传、列表、删除与版本请求都已可经端点触发，在这里做端点级断言。

  路由加进 `kb-disabled.test.ts`；假 RAGFlow 加分页与八种运行状态。
- [ ] 11.3 实现：`kb/documents.ts` 加列表（读全 RAGFlow 文档的函数，组 9 第三刀复用）与 `sourceChanged`（用 `source-file.ts` 的无审计 stat 变体）；`kb/rest.ts` 加 `GET /api/kb/bases/:id/documents`。

Suggested fixture level: expanded - 读路径经沙箱解析与挂载（stat），且是本地映射与 RAGFlow 状态的关联点。
Minimal mergeable slice: atomic - 一条路由、一个视图，状态映射与源文件变更都是同一个 `DocumentView` 的字段。

## 12. 本地上传入库（knowledge-bases「本地上传入库」）

- [ ] 12.1 核对 Context：
  - `workspaces/rest.ts:455-520`：独立 scope、octet-stream parser、`parseUploadName`（`:160`）、`assertUploadName`（`:175`）与路由内联的 255 字节判定（都未导出）、提前拒；
  - `upload.ts` 的计数 `Transform`；
  - 组 10 的 `multipart.ts`。
- [ ] 12.2 测试先行：新 `server/test/kb-upload.test.ts`。
  - 「上传不落盘」：断言 `SANDBOX_ROOT`、`OMP_STATE_DIR`、`os.tmpdir()` 前后目录清单相同；
  - 「超限与缺少长度」「客户端中断」「解析触发失败」（含 `success_count:0`）；
  - 「上传的后缀与空文件」：400 `kb_file_unsupported`，没有出站请求，`kb.ingest_reject` 的 `reason`；假 RAGFlow 回 `code:500` 时同样 400 `kb_file_unsupported`；
  - 「上传回不支持的文件」；
  - 「上传的文档数上限」：第 501 份 409 `kb_limit` 并有 `kb.ingest_reject`；499 份时两个上传并发（夹具的挂起后放行）：恰一个 201、一个 409 `kb_limit`，最终恰 500 行；
  - 「文档路由的所有权」的 `POST …/uploads` 一腿：请求体不被读取，404，零出站，无审计；
  - 201 的视图：`queued`、`chunkCount:null`、`message:null`、`sourceChanged:null`，没有文档列表请求；
  - 文件名规则 400：缺失、重复、空串、含 `/`、拒绝字符、临时前缀、超 255 字节各一例，都没有出站请求；`text/plain` 400；知识库非 `ready` 时 409；
  - 审计 detail 键集与哨兵（knowledge-bases「detail 不含敏感内容」的上传一腿）。

  路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 12.3 实现：`workspaces` 加合并上述规则的 `parseUploadFileName` 并从入口导出，既有上传路由不改；新 `server/src/kb/uploads.ts`（经该库写锁）；`kb/rest.ts` 加 `POST /api/kb/bases/:id/uploads`。

Suggested fixture level: expanded - 流式转发用户上传到外部服务，且有不落盘的硬约束。
Minimal mergeable slice: atomic - 一条路由，与工作空间上传同一写法。

## 13. 移出与重新入库（knowledge-bases「重新入库与移出」）

- [ ] 13.1 核对 Context：组 10 的 `source-file.ts`、读取与上传链路、文档删除写法；组 1 的 §8.5 与表 B 的文档一节。
- [ ] 13.2 测试先行（首刀，移出）：新 `server/test/kb-documents-remove.test.ts`。
  - 「移出不动源文件」；
  - 「移出解析中的文档」「停不下来的文档」：`deleted:0` 时不删本地行，409 `kb_document_busy`；
  - 「停止已在 STOPPING 的文档」「停止解析的其余结果」「重试期间不可达」；
  - 「文档路由的所有权」的 `DELETE …/documents` 一腿；
  - ragflow-backend「不存在视为已删」的移出一腿（`code:102` 加前缀）；
  - 「重建失败后移出」的移出一腿（状态由 store 直接设置）；`rebuilding` 时 409；
  - RAGFlow 不可达 503 且行不变；
  - `doc` 参数缺失 / 为空 / 多值 400；不属于该库 404；
  - 审计哨兵（knowledge-bases「detail 不含敏感内容」的移出一腿）。

  路由加进 `kb-disabled.test.ts`。
- [ ] 13.3 实现（首刀）：`kb/documents.ts` 加 remove（经该库写锁，复用组 10 的删除写法）；`kb/rest.ts` 加 `DELETE /api/kb/bases/:id/documents`。
- [ ] 13.4 测试先行（剩余部分，重新入库）：新 `server/test/kb-documents-reingest.test.ts`。
  - 「重新入库」（200，`status:"queued"`、`sourceChanged:false`，没有文档列表请求）「源不可读」「重新入库时旧文档在解析」；
  - 「文档路由的所有权」的 `POST …/documents/reingest` 一腿；
  - 「重建失败后移出」的重新入库一腿；
  - 工作空间已删除、`outside`、`offline`、`empty`、`changed` 各一例 409 `kb_source_unreadable`；
  - 本地上传的文档 400；
  - 「重新入库的失败不动行」：上传 `code:101` 400 `kb_rejected`；上传 `code:500` 加不支持文件的 message 400 `kb_file_unsupported`；上传 HTTP 503 为 503 `kb_unavailable`；解析触发 HTTP 503 为 503 `kb_unavailable`；解析触发 `success_count:0` 为 400 `kb_rejected`。后两种新文档被删除；五种行都不变；
  - 旧文档删除失败只写 `kb_document_leak`；
  - 审计哨兵（重新入库一腿）。

  路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 13.5 实现（剩余部分）：`kb/store.ts` 加单事务替换同一行的 RAGFlow id、大小与 `mtimeMs`；`kb/documents.ts` 加 reingest（经该库写锁）；`kb/rest.ts` 加 `POST /api/kb/bases/:id/documents/reingest`。

Suggested fixture level: expanded - 两份真相的替换顺序（新文档先建、旧文档后删）与沙箱读取。
Minimal mergeable slice: 13.2–13.3 的移出——一条不读沙箱的独立路由，组 16 的首刀与 `make smoke-kb` 都要用它，能独立保绿。剩余部分（重新入库，13.4–13.5）依赖它；剩余部分 atomic：一条路由。

## 14. 嵌入模型更换与全量重建（ragflow-backend「嵌入模型更换与全量重建」；knowledge-bases「同一知识库的写操作串行」的「上传与确认重建交错」）

- [ ] 14.1 核对 Context：
  - 组 8 的身份判定与设置锁；组 9 的 `createPipeline` / `deletePipeline`；组 10 的上传；组 12 的本地上传；组 1 的 §9.1 下载判据；
  - `server.ts` 里挂载恢复「`server_started` 之后不等待」的写法，以及关停次序；
  - `workspaces/mounts` 的恢复测试写法。
- [ ] 14.2 测试先行：新 `server/test/kb-rebuild.test.ts`（假 RAGFlow；重建器经注入的调度缝同步驱动）。
  - 「未确认不保存」「确认后重建」「开编译的库重建」「账号缺省缺失时重建失败」「旧一代删除失败」「原件缺失与下载判别」「不带头的错误应答」「中途失败与重试」「重建中改嵌入身份」「没有失败库时重试」；
  - 普通库重建不读账号缺省；
  - knowledge-bases「上传与确认重建交错」；
  - ragflow-backend「不存在视为已删」的重建一腿：第 1 步删残留的一代得到「不存在」组合时照常继续；`rebuild_failed` 删库时两代之一为「不存在」仍 204；
  - 重建器取锁后发现库已删除即跳过，不建数据集；
  - 重建中改 `chatModelId` 仍按 D7 锁定；
  - 解析未启动（`success_count:0`）时该库 `rebuild_failed`；
  - 锁被重建器持有时，入库、上传与重新入库立即 409；
  - `POST /api/kb/settings/rebuild` 的 403 / 401、bodyless 带 `{}` 400；
  - 审计的 detail 键集；确认重建那次保存恰写 `kb.settings` 与 `kb.rebuild` 两条；actor 等于 `rebuild_actor_id`。

  编译入口用例：新 `server/test/kb-rebuild-restart.test.ts`。
  - 「崩溃后续做」，含 actor 断言；
  - 「编译库的残留清理」；
  - 「关停时在途重建」：切换之前与切换之后各一例；
  - 「续做失败不影响进程」；
  - 「知识库关闭时不动重建状态」。
  - 本组是最后一个注册路由的组：`kb-disabled.test.ts` 断言路由表恰十二条。

  路由加进 `kb-disabled.test.ts` 与归属路由用例。
- [ ] 14.3 实现：
  - 新 `server/src/kb/rebuild.ts`（处理每库期间持有该库写锁；建新一代：开了开关的库走 `createPipeline`，普通库走组 9 首刀的 `parse_type:1` 建库，不读账号缺省；删走 `deletePipeline`）；
  - 组 8 的 PUT 开放 `confirmRebuild` 并写 `rebuild_actor_id`；`kb/rest.ts` 加 `POST /api/kb/settings/rebuild`；
  - 重建器的启动与关停接进 `startup-registry.ts`，`server.ts` 只加两次调用。
- [ ] 14.4 `system.md` §9.13 加重建流程、下载判别、跳过规则、续做与 `kb_dataset_leak`、`kb_pipeline_leak`。

Suggested fixture level: expanded - 后台进程内任务、跨重启的续做与关停次序（process lifecycle + persisted state），并与在途写操作交错。
Minimal mergeable slice: atomic - 确认开关一旦开放就必须有重建器，否则库永远停在 `rebuilding`；重建器没有确认入口就没有触发点。

## 15. web：API 客户端与中心「知识库」tab 的列表、建库、删库（model-registry「中心页外壳」；knowledge-bases「中心「知识库」tab」的状态行、列表、列表行的 `删除知识库` 与新建对话框）

- [ ] 15.1 核对 Context：
  - `web/src/features/center/tabs.ts:16-22` 与 `CenterPage` 的可见 tab 计算；
  - `web/test/center-page.test.tsx` 中钉住 tab 条与描述的行号；
  - `web/src/lib/api-connectors.ts` 的严格解析写法；`api.ts` 的 `ApiClient` 类型与再导出；
  - `web/test/api-files-archive.test.ts` 的 `OTHER_CLIENT_METHODS` 与精确键集；
  - `web/test/support.ts` 的 `centerRoutes()`。
- [ ] 15.2 测试先行。
  - `center-page.test.tsx`：「知识库 tab 随开关显隐」，以及既有场景的假状态 `{enabled:false}`；`support.ts` 的 `centerRoutes()` 加 `GET /api/kb/status` 缺省应答 `{enabled:false}`。
  - 新 `web/test/center-kb-list.test.tsx`（假 `ApiClient`）：
    - 「不可用与未就绪」「编译开关按对话模型显示」；
    - 模板恰十一种，没有 `Tag`；
    - 建库恰一次请求与失败 alert；空态；
    - 列表行的 `删除知识库`：先弹确认，确认后恰一次 `deleteKnowledgeBase`；`rebuilding` 时不渲染，`rebuild_failed` 时渲染；
    - 「编译状态文案」：含 `pending` 的 `尚未产出` 与旁注、`compile:null` 显示 `状态未知`，页面不出现 `编译失败`。
  - 新 `web/test/api-kb.test.ts`：两份 spec 写明的每个应答形状的严格解析（多键、少键、类型不符即 `requestFailed`）。（已随 #1841 落地）
- [ ] 15.3 实现：
  - 新 `web/src/lib/api-kb.ts`（全部知识库方法，含组 16、17 用到的）；`api.ts` 接线，同一刀更新 `web/test/api-files-archive.test.ts` 的 `OTHER_CLIENT_METHODS` 精确键集（已随 #1841 落地）；
  - `tabs.ts` 加 `{key:"knowledge-bases", label:"知识库", adminOnly:false, requiresKb:true}` 与可见性计算；
  - 新 `web/src/features/center/kb/{panel.tsx,list.tsx,create-dialog.tsx,use-kb.ts,templates.ts}`；`templates.ts` 只有十一种模板的中文名与 demo 说明文案，没有编译支持表。
- [ ] 15.4 验收清单新节「中心·知识库（CK）」，结论 `待签`，`web/test/functional-checklist.test.ts` 通过：
  - CK-01 未配置知识库时没有知识库 tab；
  - CK-02 建库并选模板；
  - CK-03 RAPTOR / 知识图谱开关随知识库对话模型显示，十一种模板都一样；
  - CK-04 删库。

Suggested fixture level: expanded - 新 tab 与可见性规则（presentation + route guard）；按前端通用契约须有真实浏览器走查，组 18 补 ui-walk 分支。
Minimal mergeable slice: `api-kb.ts` 与 `web/test/api-kb.test.ts`（15.2 的第三项与 15.3 的第一项）——客户端与严格解析按 spec 写明的应答形状独立可测，组 17 依赖它与组 15 剩余（CK 节）；被测试 entry 导入，knip 不报无用。剩余部分（tab 可见性、列表、建库、删库与 CK-01–04）依赖它与组 9 全部三刀；剩余部分 atomic：tab 一出现就必须有列表与建库，只有状态行的面板是无功能的占位 tab。

## 16. web：知识库详情（knowledge-bases「中心「知识库」tab」的详情、入库、上传、移出、重新入库与刷新）

- [ ] 16.1 核对 Context：
  - 文件页树组件与 `api-workspaces` 的目录列举；
  - S1g 上传的客户端 `web/src/lib/api-upload.ts`；
  - 组 15 的面板结构与 `api-kb.ts`。
- [ ] 16.2 测试先行（首刀）：新 `web/test/center-kb-detail.test.tsx`。
  - 点行进入详情：渲染 `panel.tsx`，从列表行走到详情；
  - 「解析中自动刷新」：假时钟；页面隐藏时停；`unparsed` 不触发刷新；
  - 状态文案七种；`已切片 0`；
  - `源文件已变更` 只在 `true` 时显示；工作空间来源行都有 `重新入库`；
  - 移出；409 `kb_document_busy` 时行内显示信封文案、行仍在；
  - 非 `ready` 时 `重新入库` 不渲染；`rebuild_failed` 时 `移出` 仍渲染，`rebuilding` 时不渲染（入库与上传按钮的同一规则由 16.4 断言，它们在剩余部分才建出来）。
- [ ] 16.3 实现（首刀）：新 `web/src/features/center/kb/{detail.tsx,documents-table.tsx}`；改 `list.tsx`、`panel.tsx`，点行进入详情。
- [ ] 16.4 测试先行（剩余部分）：`center-kb-ingest.test.tsx`。
  - 两个入口挂在详情里，从 `detail.tsx` 渲染；
  - 入库对话框：选空间、浏览目录、勾选上限、提交恰一次、被拒条目逐条显示 `message`（含 `unsupported_type` 与 `empty` 的文案）；成功后重取一次文档列表，`queued` 进入 3 秒刷新；
  - 上传：超数与超大在客户端就地拒绝，逐个请求；400 `kb_file_unsupported` 逐个显示信封文案，其余文件继续；
  - 非 `ready` 时 `从工作空间入库` 与 `上传文件` 不渲染（knowledge-bases「中心「知识库」tab」）。
- [ ] 16.5 实现（剩余部分）：新 `web/src/features/center/kb/{ingest-dialog.tsx,upload-button.tsx}`；改 `detail.tsx`，两个入口挂在详情里。
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
  - model-registry「开编译的库锁定对话模型下拉」：已指定且 `compileBases` 大于 0 时禁用并显示旁注；服务端 409 `kb_chat_model_locked` 的信封文案作兜底显示；
  - 重建状态与 `重试失败的重建`；设置读取失败时的 `重试`；
  - 知识库关闭时整段不渲染；
  - 删除被引用的对话模型得到 409 `kb_model_in_use` 时，模型表行内显示信封文案、行仍在。
- [ ] 17.3 实现：新 `web/src/features/center/models/kb-section.tsx` 与 `kb-embedding-dialog.tsx`；`panel.tsx` 挂载该段。
- [ ] 17.4 验收清单，结论 `待签`：
  - CK-09 管理员配置嵌入模型与知识库对话模型；有开编译的库时对话模型下拉禁用；
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
  - 加三个可复跑用例：以未设置的 `RAGFLOW_BASE_URL` 跑 `make smoke-kb`，非零且输出含 `RAGFlow 私有配置缺失`；以指向关闭端口的 `RAGFLOW_BASE_URL` 跑，非零且输出含 `共用 RAGFlow 栈未运行或版本不符`。以指向本地桩（版本接口回 `v1.0.0-rc1`）的 `RAGFLOW_BASE_URL` 跑，非零且输出含 `共用 RAGFlow 栈未运行或版本不符`，桩只收到版本请求（verification-harness「版本不符」）。三例都在发出任何知识库请求之前退出，且 Makefile 目标的文本不含 `docker`，这是文本断言，不跑 `docker` 命令。
- [ ] 18.3 实现（首刀）：
  - 新 `smoke/kb.hurl` 与 `smoke/kb-cleanup.hurl`：含一个 `raptor` 与 `graph` 都为真的 `smoke-kb-compile` 库，轮询到两种编译都 `done`，这是 DSL 对真实 RAGFlow 的唯一验证；清理覆盖 `smoke-kb` 与 `smoke-kb-compile`；
  - 新夹具工作空间 `smoke/fixtures/sandbox/u1/smoke-kb/`（一个小 Markdown 文件与一个小 PDF 文件，自制，无第三方版权），同步 `smoke/fixtures/README.md`，写明前提：调用方已把夹具复制到服务的 `SANDBOX_ROOT/u1`，`make smoke-kb` 不替它复制；
  - Makefile 加 `smoke-kb`：两步前置检测；hurl 前后的清理；轮询上限变量 `SMOKE_KB_POLL_SECONDS`（缺省 300）；登录方式同 `smoke/chat.hurl`；
  - `AGENTS.md`、`constraints.yaml`、`.PHONY` 同步登记。
- [ ] 18.4 `make ui-walk` 的 `/center` 分支：知识库关闭（CI 的缺省配置）时 tab 条不含 `知识库`。
- [ ] 18.5 收口：
  - `docs/architecture/system.md` §9.13 收口（部署要求、回滚、`smoke-kb`）；§6.2 摄取流按最终实现补细节（逐条解析、拒绝原因）；
  - 验收清单 CK 节复核，并新增两行（结论 `待签`，由 owner 执行）：
    - CK-11 对接上共用栈的本机服务（已配置知识库嵌入模型与知识库对话模型）跑 `make smoke-kb` 通过，开编译的库两种编译都 `done`，输出脱敏后附在签字记录；再以 `SMOKE_KB_POLL_SECONDS=1` 跑一次，确认非零退出且 `smoke-kb`、`smoke-kb-compile` 都已被清理（verification-harness「失败后清理」）；
    - CK-12 知识库开启时的中心「知识库」tab 手动走查。

Suggested fixture level: expanded - 真实外部服务冒烟与 harness 接线（smoke/UI harness + CI/production configuration）。
Minimal mergeable slice: 18.2–18.3 的 `smoke-kb` 目标、夹具与控制面同步——验证路径是 `make test-guardrails`；对真实 RAGFlow 的运行移到验收清单（CK-11），不是本组的合入条件。剩余部分拆成两刀，各一条验证路径：18.4 的 ui-walk 分支（`make ui-walk`），只依赖组 15，与首刀无依赖；18.5 的文档收口与 CK-11 / CK-12（`web/test/functional-checklist.test.ts`），依赖首刀，因为它要引用 `smoke-kb` 的写法。两刀各自 atomic：前者是一条断言，后者是同一次收口的文档与验收行。
