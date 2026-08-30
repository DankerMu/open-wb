# 实现计划 — 清单与阶段

> 2026-08-30。stage-change-pipeline Stage 1 的首选输入：每个阶段 = 一次流水线运行 =
> 一个 OpenSpec change + 一批实现就绪 issue。里程碑沿用 `PLAN.md` §4 的 P0–P4；
> 本文把它们切成流水线粒度的子阶段。架构事实一律以 `docs/architecture/system.md` 为准。

## Goal

按阶段交付 `PLAN.md` §1 定义的内网多用户 AI Agent Web 服务；demo
（`resource/workbuddy-live-demo.html`）能点出来的行为全部等价可用。

## Scope

- 功能实现清单（稳定 ID，源自 demo/PLAN §3）与 13 个实现子阶段的任务包、依赖、验收。
- AGENTS.md 两个 READINESS GAP（HTTP smoke / UI 走查）的接入排期（S0a）。

## Not In Scope

- 详细 spec 与 tasks 拆分（流水线 Stage 2 的职责）；本文任务包只到"issue 群的边界"粒度。
- omp fork 仓的减肥实现细节（`resource/backend-research.md` §2.2 已定稿，S4a 只引用）。
- PLAN.md 内容修订（仅互加交叉引用）。

## What Already Exists

- 工程控制面全绿：`make check`、守卫、CI 聚合器、分支保护（AGENTS.md Enforcement Index）。
- 脚手架：`server/`（service-info）、`web/`（theme）、`kbservice/`（包骨架），各带测试与 80% 覆盖率门禁。
- 决策资产：`docs/adr/0001`–`0008`、`docs/architecture/system.md`（模块图/依赖规则/目录结构）、
  `resource/backend-research.md`（RAGFlow 吸收清单、omp 减肥五阶段）。
- 行为基准：live demo 全路由可交互。

## Constraints

- 内网单机部署，无公网依赖；`app-reference/` 内容不进产物。
- omp fork 冻结 v18.0.10；P0–P3 用官方全量二进制，减肥推迟到 S4a（先链路后体积）。
- CONTEXT.md 五条不变量（尤其凭证不进 omp 环境、越界拒绝+审计）。
- 每阶段结束系统可运行、`make check` 绿、master 经分支保护合入。
- 开发机 macOS 而部署目标 Linux：FUSE（S1b）本地验证受限（macFUSE 内核扩展）。
  已指定专用测试 VPS（Ubuntu 24.04 x86_64，fuse3/docker 就绪；连接信息在本地
  `CLAUDE.local.md`，不入库——仓库为 public）承担挂载验证、Linux smoke 与部署演练。

## Success Criteria

- 清单覆盖表中每个 F-ID 恰好落在一个阶段；P3 结束双账号实测互不可见（PLAN §4 验收）。
- P4 结束：无公网机器全新部署跑通 + 冒烟全绿 + 减肥验收指标达标。

## Assumptions

- 内网模型注册表提供 OpenAI 兼容端点（P0 即需）。
- OIDC IdP 在 S3a 前可拿到测试租户；此前 auth 走 dev-stub 适配器（ADR-0007）。
- RAGFlow `DocStoreConnection` 接缝足以承载 Infinity 适配（S2a spike 首周验证）。

## Open Decisions

| 决策 | 关闭期限 | 归属阶段 grill |
|---|---|---|
| omp 子进程与 app-server 的 uid 分离 | S1a 启动前 | S1a |
| omp 池参数（上限/内存/空闲回收） | S1c 实测定参 | S1c |
| deepdoc 模型内网分发清单与体积 | S2a spike 输出 | S2a |
| IdP 是否带组声明（项目组自建 vs 同步） | S3a 启动前 | S3a |
| dependency-cruiser 接入时机（import 边界机械化） | 出现跨模块违规即接 | 任意 |

## 功能实现清单（稳定 ID）

来源：demo 各路由（行为基准）+ PLAN §3。**每 ID 恰好属于一个阶段**（见覆盖表）。

### 会话页 `/`
| ID | 行为 |
|---|---|
| F-CHAT-1 | 三场景（日常办公/代码开发/创意设计），决定默认专家与工具面 |
| F-CHAT-2 | 会话分组侧栏（项目/工作空间/专家团），会话按账号隔离 |
| F-CHAT-3 | 流式对话 + 执行步骤卡片 |
| F-CHAT-4 | agentic 检索卡（改写→召回→判定→二轮→仅切片入上下文） |
| F-CHAT-5 | 附件双语义：知识库（切片）vs 工作空间（整文件） |
| F-CHAT-6 | 会话落盘、resume/fork |
| F-CHAT-7 | 生成中断/继续 |
| F-CHAT-8 | 断线/刷新续流（Last-Event-ID 回放） |

### 文件页 `/files`
| ID | 行为 |
|---|---|
| F-FILE-1 | 工作空间一等实体，多根目录树 |
| F-FILE-2 | 空间根目录、新建目录、新建工作空间 |
| F-FILE-3 | 挂载/卸载 SFTP/NFS/SMB（只读标记、在线状态） |
| F-FILE-4 | 文件预览（文本/代码/图片） |
| F-FILE-5 | 沙箱强制：越界写拒绝并入审计 |

### 中心 `/center`
| ID | 行为 |
|---|---|
| F-CTR-EXP | 专家卡片（分类/标签）、加入会话 |
| F-CTR-SKL | 技能清单与启停 |
| F-CTR-CON | MCP 连接器（仅显式配置） |
| F-CTR-KB1 | 12 种切片模板 + RAPTOR/知识图谱开关 |
| F-CTR-KB2 | 文档摄取与状态 |
| F-CTR-KB3 | 检索测试 |
| F-CTR-KB4 | 可见范围四档、共享只读、跨账号检索审计 |
| F-CTR-MOD | 模型注册表（登记 + 探活） |
| F-CTR-PERM | 沙箱根目录、白名单派生、越界拦截记录 |
| F-CTR-AUD | 审计页（权限/共享检索/账号操作，按账号隔离） |
| F-CTR-ACC | 账号管理（管理员）+ 跨部门项目组 |

### 设置 `/settings` 与运行时
| ID | 行为 |
|---|---|
| F-SET-1 | 主题/通用/关于 |
| F-SET-2 | 登录态与退出（内网统一身份） |
| F-OPS-1 | omp 子进程池治理（每活跃会话一个、空闲回收、上限） |
| F-OPS-2 | 模型代理（omp 环境零凭证，ADR-0008） |
| F-OPS-3 | omp 减肥（backend-research §2.2 阶段 1→4） |
| F-OPS-4 | 单机部署包（fuse3+rclone+模型捆包） |

## Phases（13 子阶段）

通用契约：每阶段 Verify 至少含 `make check` 绿 + 阶段专属验收；改动触碰 AGENTS.md
Critical Paths（沙箱/omp 治理）的必须白盒审查。必读文档所有阶段共有：`AGENTS.md`、
`CONTEXT.md`、`docs/architecture/system.md` §3–§6——下表只列增量。

### 里程碑 P0 — 链路骨架

**S0a 服务骨架与验证 harness**
- Outcome：app-server 起 HTTP（auth dev-stub 登录、静态 SPA 托管）；SPA 壳（路由镜像 demo IA + 主题）；**hurl smoke 与 Playwright 走查接入 `make`/CI，AGENTS.md 两条 READINESS GAP 行关闭**。
- Files/components：`server/src/{app,http,core/db,auth}`、`web/src/{routes,lib}`、`smoke/*.hurl`、Playwright 基线、Makefile/CI 增目标。
- 覆盖：F-SET-1。
- 必读增量：demo `/settings` 路由；ADR-0006、0007。
- Verify：`make check` + 新增 smoke/UI 目标绿；浏览器登录（stub）后四个路由可达。
- Depends on：—
- Review attention：decision-dense（HTTP 骨架、SPA 结构、验证 harness 形态定调）。

**S0b 最小对话链路**
- Outcome：spawn 官方全量 `omp --mode rpc`（cwd=沙箱雏形目录）；model-proxy 接内网网关；SSE 流 + 事件序号回放；会话落盘可 resume。**P0 里程碑验收：浏览器一次流式对话渲染完整。**
- Files/components：`server/src/{sessions,model-proxy,models(最小登记)}`、`web/src/features/chat`。
- 覆盖：F-CHAT-3、F-CHAT-6、F-CHAT-8、F-OPS-2。
- 必读增量：`resource/backend-research.md` §2.1（RPC 协议行号引用）；ADR-0001、0006、0008；`resource/oh-my-pi/docs/rpc.md`。
- Verify：smoke 打通对话端点；断流重连回放测试；kill omp 子进程后 resume 成功。
- Depends on：S0a。
- Review attention：decision-dense（RPC 编解码、事件契约、代理凭证——Critical Path 白盒）。

### 里程碑 P1 — 会话与工作空间

**S1a 沙箱与审计内核 + 本地文件面**
- Outcome：`core/sandbox`（resolve/白名单推导）+ `core/audit` 落地；工作空间 CRUD、树列举、新建目录、文件预览；越界写拒绝且入审计。
- 覆盖：F-FILE-1、F-FILE-2、F-FILE-4、F-FILE-5。
- 必读增量：demo `/files`；CONTEXT.md 不变量 3；system.md §4 依赖规则（一切路径过 resolve）。
- Verify：路径逃逸用例集（symlink/../绝对路径）全拒且审计有记录。
- Depends on：S0a。
- Review attention：decision-dense（Critical Path 白盒；uid 分离决策先关闭）。

**S1b FUSE 挂载**
- Outcome：mount-manager（rclone/sshfs 生命周期、凭证经受权限保护的配置文件注入、崩溃重挂、在线状态）；挂载点入白名单推导。首任务 = 在测试 VPS 上装 rclone/sshfs 并打通挂载验证路径（macOS 开发机不可信）。
- 覆盖：F-FILE-3。
- 必读增量：ADR-0003（含凭证不上命令行的 Consequences）。
- Verify：SFTP 真实挂载读写 + 断连状态呈现 + 卸载后白名单收回（测试 VPS 上跑）。
- Depends on：S1a。
- Review attention：decision-dense（Critical Path：挂载凭证存取）。

**S1c 会话治理与分组**
- Outcome：omp-supervisor 完整治理（每活跃会话一个、空闲回收、数量上限——池参数在此实测定参）；会话分组侧栏、三场景、fork、中断。
- 覆盖：F-CHAT-1、F-CHAT-2、F-CHAT-7、F-OPS-1。
- 必读增量：demo `/` 侧栏与场景交互；PLAN §5 并发资源治理。
- Verify：并发多会话压测（回收/上限生效）；双账号会话互不可见（初步）。
- Depends on：S0b、S1a。
- Review attention：decision-dense（Critical Path：spawn/回收/限额）。

**S1d 中心能力面（专家/技能/连接器/模型）**
- Outcome：`/center` 的专家、技能、连接器、模型四个 tab：专家卡入会话、技能启停映射 omp 工具面、MCP 显式配置、模型注册表 UI+探活。
- 覆盖：F-CTR-EXP、F-CTR-SKL、F-CTR-CON、F-CTR-MOD。
- 必读增量：demo `/center` 对应 tab；`resource/oh-my-pi/docs/`（工具面与 MCP 配置面）。
- Verify：专家加入后系统提示词/工具面变化可观察；探活状态真实反映端点可用性。
- Depends on：S1c。
- Review attention：mechanical 为主（UI+配置透传；MCP 配置注入 omp 需一眼白盒）。
- 注：PLAN §4 阶段表未给这四个 tab 安家，本阶段是对 PLAN 的补全（不矛盾）。

### 里程碑 P2 — 知识库

**S2a kb-service 骨架与摄取线（含 RAGFlow 吸收 spike）**
- Outcome：spike 先行（≤1 周）：api.db 解耦可行性、Infinity 经 DocStoreConnection 的 PoC、deepdoc 模型本地化清单——输出决策与清单。随后：kbservice `api`（bearer 每请求鉴权）、`ingest`（deepdoc+12 模板）、`store`（Infinity）；摄取状态 UI。文档存所有者沙箱。
- 覆盖：F-CTR-KB1、F-CTR-KB2。
- 必读增量：`resource/backend-research.md` §1（吸收/跳过清单）；ADR-0002、0005；ATTRIBUTION.md §3（义务在此生效：LICENSE-RAGFlow/NOTICE/文件头）。
- Verify：一批真实混合格式文档摄取成功、状态流转正确；kbservice 覆盖率门禁绿。
- Depends on：S1a。
- Review attention：decision-dense（spike 结论决定后两阶段形态）。

**S2b 检索线**
- Outcome：混合检索+重排+agentic 环（改写→召回→充分性→二轮）；`/center` 检索测试 tab。
- 覆盖：F-CTR-KB3。
- 必读增量：backend-research §1 agentic_rag 环行号引用。
- Verify：检索测试返回带出处切片；agentic 二轮在构造的不充分场景下真实触发。
- Depends on：S2a。
- Review attention：decision-dense（检索质量参数与环终止条件）。

**S2c 会话接入与可见范围**
- Outcome：`host_tool_call`→app-server `kb` 模块转发（先过滤 kb_ids 再调 kbservice）；附件双语义；可见范围四档模型落库（部门/项目组字段就位，真实组数据 S3a 接入）；共享只读+跨账号检索审计。**P2 里程碑验收：会话内 KB 引用给出带出处切片，共享检索入审计。**
- 覆盖：F-CHAT-4、F-CHAT-5、F-CTR-KB4。
- 必读增量：system.md §6.1 时序图；CONTEXT.md 不变量 1、2、4。
- Verify：整篇文档绝不入上下文（不变量 2 用例）；无权 kb_id 检索被过滤且不可探测。
- Depends on：S2b、S1c。
- Review attention：decision-dense（多租户过滤是灰盒决定的例外候选——出事故重议）。

### 里程碑 P3 — 账号权限审计

**S3a OIDC 与账号治理**
- Outcome：OIDC 真对接（替换 dev-stub，接缝不动）；首登 provisioning；项目组（自建或同步——启动前关闭 IdP 组声明决策）；`/center` 账号 tab。
- 覆盖：F-SET-2、F-CTR-ACC。
- 必读增量：ADR-0007；demo `/center` 账号 tab（身份字段只读语义）。
- Verify：真实 IdP 登录/登出/过期；非管理员不见账号 tab。
- Depends on：S2c。
- Review attention：decision-dense（灰盒例外候选：认证是安全面）。

**S3b 权限与审计完整面**
- Outcome：`/center` 权限、审计两 tab 完整（白名单派生展示、拦截记录、三类审计事件查询）；**P3 里程碑验收：双浏览器双账号实测——会话/文件/私有库互不可见，共享库只读。**
- 覆盖：F-CTR-PERM、F-CTR-AUD。
- 必读增量：demo `/center` 权限/审计 tab。
- Verify：双账号验收脚本化进 Playwright 走查。
- Depends on：S3a。
- Review attention：mechanical 为主（数据已在，呈现与查询）。

### 里程碑 P4 — 减肥与部署

**S4a omp 减肥（fork 仓执行）**
- Outcome：backend-research §2.2 阶段 1→4（冻结基线→rpc 入口树摇→依赖裁剪→natives 特性裁剪）；验收指标达标。**代码落 omp fork 仓，本仓 change/issue 只做追踪与验收记录。**
- 覆盖：F-OPS-3。
- 必读增量：backend-research §2.2（定稿五阶段）。
- Verify：减肥后二进制回归 S0b/S1c/S2c 的全部 smoke；体积/启动指标对比基线。
- Depends on：S2c（链路全量证明后才动刀）。
- Review attention：mechanical 为主（策略已定稿，执行照单）。

**S4b 单机部署包**
- Outcome：部署产物（app-server+SPA+kbservice+减肥 omp+fuse3/rclone+onnx 与嵌入模型捆包）；冒烟脚本全绿。**P4 里程碑验收：无公网服务器全新部署跑通。**
- 覆盖：F-OPS-4。
- 必读增量：已定决策"模型分发=捆进部署包"（backend-research §3）。
- Verify：干净 Linux 环境（测试 VPS 的全新 docker 容器）一键部署 + 全量 smoke + 双账号走查。
- Depends on：S4a、S3b。
- Review attention：mechanical 为主。

## 覆盖表（F-ID → 阶段）

| 阶段 | 覆盖 ID |
|---|---|
| S0a | F-SET-1 |
| S0b | F-CHAT-3/6/8、F-OPS-2 |
| S1a | F-FILE-1/2/4/5 |
| S1b | F-FILE-3 |
| S1c | F-CHAT-1/2/7、F-OPS-1 |
| S1d | F-CTR-EXP/SKL/CON/MOD |
| S2a | F-CTR-KB1/KB2 |
| S2b | F-CTR-KB3 |
| S2c | F-CHAT-4/5、F-CTR-KB4 |
| S3a | F-SET-2、F-CTR-ACC |
| S3b | F-CTR-PERM、F-CTR-AUD |
| S4a | F-OPS-3 |
| S4b | F-OPS-4 |

无孤儿 ID；F-CTR-PERM/AUD 的底层事件自 S1a 起持续产生，S3b 只补呈现完整面。

## Risks

- **RAGFlow 吸收成本失控**（PLAN §5 已列）→ S2a spike 先行，spike 结论可缩 S2b/S2c 范围。
- **FUSE 开发环境断层**（macOS 本地无法可信验证）→ S1b 首任务建 Linux 验证路径；失败则回退 ADR-0003 备选（管理员 OS 级挂载，需重新拍板）。
- **omp 冻结 CVE**→ 季度 osv-scanner；例外 cherry-pick 已授权（backend-research §3）。
- **Infinity 成熟度**→ DocStoreConnection 接缝保留 ES 退路（ADR-0005）。
- **切片过宽反噬**→ 流水线 Stage 5 宽度门禁 + sizing-retro 回流会暴露；连续出现即回本文重切阶段。

## Rollback Or Containment

- 每阶段 = feature 分支 + CI 门禁 + 分支保护合入；坏了 `git revert`，master 始终可运行。
- S1b：挂载功能独立 feature-flag，故障不阻塞空间根目录使用。
- S2x：kbservice 独立进程，故障降级为"无 KB 的会话服务"（host tool 返回明确错误）。
- S4a：减肥二进制回归不过即回官方全量二进制，部署包两者可切。

## Next Step

对首个阶段跑 `/stage-change-pipeline`（S0a）：Stage 1 读本文对应节收集上下文，
压测门禁的 grill 分支种子 = 本文 Open Decisions 表 + 该阶段 Review attention 标注；
单 issue 的实现/修复/合并走 `/subagent-workflow`。
