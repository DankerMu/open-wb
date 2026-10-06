# 实现计划 — 清单与阶段

> 2026-08-30。stage-change-pipeline Stage 1 的首选输入：每个阶段 = 一次流水线运行 =
> 一个 OpenSpec change + 一批实现就绪 issue。里程碑沿用 `PLAN.md` §4 的 P0–P4；
> 本文把它们切成流水线粒度的子阶段。架构事实一律以 `docs/architecture/system.md` 为准。

## Goal

按阶段交付 `PLAN.md` §1 定义的内网多用户 AI Agent Web 服务；demo
（`resource/workbuddy-live-demo.html`）能点出来的行为全部等价可用。

> 2026-10-04 修订（ADR-0013）：demo 只作功能清单来源，不再约束界面呈现；前端改用 assistant-ui + shadcn/Tailwind 重建（S1f）。

## Scope

- 功能实现清单（稳定 ID，源自 demo/PLAN §3）与 16 个实现子阶段的任务包、依赖、验收。
- AGENTS.md 两个 READINESS GAP（HTTP smoke / UI 走查）的接入排期（S0a）。

## Not In Scope

- 详细 spec 与 tasks 拆分（流水线 Stage 2 的职责）；本文任务包只到"issue 群的边界"粒度。
- omp fork 仓的减肥实现细节（`resource/backend-research.md` §2.2 已定稿，S4a 只引用）。
- PLAN.md 内容修订（仅互加交叉引用）。

## What Already Exists

> 2026-09-26 更新（S0a/S0b/S1a/S1e 关闭后）。原 2026-08-30 版只记脚手架；本节以已晋升 spec（`openspec/specs/`，19 份）为事实源。

- 工程控制面：`make check`（lint/typecheck/test/anti-drift）、`make test-guardrails`、`make omp-fetch`；CI `ci.yml` 九个 job
  （fast-checks / unit-tests / anti-drift / secret-scan / sast / smoke / ui-walk / uid-isolation / all-checks-passed）+ 分支保护。
- 运行时验证 harness（调用方拥有已运行服务）：`make smoke`（`smoke/{public,auth,chat,files,session-meta}.hurl`）、`make smoke-live`（真实上游）、
  `make ui-walk`（Playwright 双 project：1440 亮 / 390 暗）、`make ui-shots`（六格 × 五态 demo-vs-app 截图对，人工签收输入）；
  控制面同步由 `scripts/test-ci-harness.sh` oracle 守住。
- app-server（S0a/S0b/S1a）：Fastify 装配与错误信封、dev-stub 认证 + session cookie、SQLite WAL + 迁移（`002`–`033`）、
  `core/sandbox`（resolve/越界拒绝 + `sandbox.reject` 审计）、`core/audit`（只追加 + 游标分页 + 只读端点）、
  `workspaces`（CRUD/树/新建目录/预览）、`sessions`（omp `--mode rpc` 子进程、SSE + 序号回放 + 环形缓冲、
  SQLite 会话/消息/步骤含 args/output 双字段、`--resume`、空闲回收 `idleMs`）、`model-proxy`（omp 环境零凭证）、
  Linux 专用 omp uid（sudo + `setpriv --pdeathsig`，CI `uid-isolation` 证明）。**尚无**：中断/fork 端点、会话数上限、场景/分组字段、挂载。
- web SPA（S0a/S0b/S1a/S1e）：React + Vite，四路由（`/`、`/files`、`/center` 占位、`/settings`）；`web/src/ui` 基元层
  （token 全集亮/暗、按钮/输入/开关/标签/chip/Dialog/ConfirmDialog/Drawer/Menu/Popover/Tooltip/Toast/空态/分段控件/图标/品牌 mark）；
  外壳（侧栏折叠 + 用户菜单、顶栏三态、900/760 两档响应式）；会话页（欢迎态、Markdown 消息 + 流式光标、步骤卡、回到最新、复制）；
  文件页（逻辑路径、条目元数据、空态、创建对话框）；登录页与设置页对齐 demo。demo 一致性清单 81/81 签收（`docs/acceptance/`）。
- kbservice：仍为包骨架（`dependencies = []`），S2a 起填。
- 决策资产：`docs/adr/0001`–`0011`（0010 专用 omp uid、0011 沙箱路径非浏览器秘密）、`docs/architecture/system.md`、
  `resource/backend-research.md`；`docs/stage-pipeline-log.jsonl` 四阶段账本。
- 环境：测试 VPS（Ubuntu 24.04，fuse3/docker 就绪，rclone/sshfs 未装；连接信息在本地 `CLAUDE.local.md`）；
  开发期模型上游为公网 OpenAI 兼容替身，单测/CI 打仓库假上游 `server/test/support/fake-upstream.mjs`。
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
| ~~omp 子进程与 app-server 的 uid 分离~~ 已关闭 2026-09-18：ADR-0010 单一专用 omp uid | S1a 启动前 | S1a |
| ~~S0b omp 二进制供给~~ 已关闭 2026-09-18：官方 release v18.0.10（ADR-0001 补充） | S0b 启动前 | S0b |
| ~~S0b 开发期模型上游~~ 已关闭 2026-09-18：公网 OpenAI 兼容替身，单测打假上游（ADR-0008 补充） | S0b 启动前 | S0b |
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
| F-CHAT-5 | 附件双语义：知识库（切片）vs 工作空间（整文件）。2026-10-04 拆为 5a 工作空间附件（整文件上传进会话空间）与 5b 知识库附件（切片） |
| F-CHAT-6 | 会话落盘、resume/fork |
| F-CHAT-7 | 生成中断/继续 |
| F-CHAT-8 | 断线/刷新续流（Last-Event-ID 回放） |
| F-CHAT-9 | 回合产物呈现：逐回复产物卡 / 文件变更卡 + 顶栏产物面板（同一特性、同批交付；2026-09-26 #403 拍板） |
| F-CHAT-10 | 深度思考折叠：上游 reasoning 以独立事件流式呈现，模型无 reasoning 时不渲染（2026-09-26 #404 拍板） |
| F-CHAT-11 | 输入框能力栏（2026-10-04，ADR-0013）：任何会话状态下可达的工作空间选择、权限设置、「+」菜单（技能/命令、上传文件、专家）。分三项：11a 能力栏本体 + 空间选择 + 技能/命令；11b 权限设置 + 上传文件；11c 专家 |
| F-CHAT-12 | 会话权限设置（2026-10-04，ADR-0013）：输入框里的权限设置所对应的后端。语义 2026-10-06 由 owner 确定为「本会话的工具审批档位」：三档（每次都问 / 只问命令 / 全部自动，对应 omp 的 `always-ask` / `write` / `yolo`），管理员可配允许的最高档，默认只问命令，按会话保存、新会话沿用上次选择，生成中可改、下一条消息生效，超时自动允许不变，改档记审计 |

### 文件页 `/files`
| ID | 行为 |
|---|---|
| F-FILE-1 | 工作空间一等实体，多根目录树 |
| F-FILE-2 | 空间根目录、新建目录、新建工作空间 |
| F-FILE-3 | 挂载/卸载 SFTP/NFS/SMB（只读标记、在线状态） |
| F-FILE-4 | 文件预览（文本/代码/图片）。2026-10-06（#913）扩展：HTML 渲染预览、更多代码与文本（带语法高亮）、tsv、更多图片、PDF、办公文档、音视频、Notebook、压缩包列表；所有文件可下载；文件与目录的删除、重命名、同空间内移动 |
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

### 前端基准对齐（demo 呈现层，跨页面）

> 2026-09-24 增补，依据 `docs/reviews/2026-09-24-demo-parity-audit.md`：功能类 F-ID 不覆盖外壳/组件/响应式/验收方法，
> 已交付页面的呈现偏差与计划遗漏在此独立登记，避免"默认未来阶段会顺手补齐"。

| ID | 行为 |
|---|---|
| F-UI-1 | 设计 token 全集（调色板 + 语义层，亮/暗）与基元组件库：按钮/输入/开关/标签/chip/Modal 栈/confirm/Drawer/Menu/锚定 Pop/Toast/空态/图标集/动效；全部页面只经基元取样式 |
| F-UI-2 | 应用外壳：侧栏（图标 + 副标签 + 折叠 288→48 + 底部铃铛/设置/用户菜单展示形态）、顶栏三态（欢迎页隐藏 / 任务面包屑 / 页面标题 + 操作位）、响应式 1100/900/760 三档（760 以下侧栏覆盖层） |
| F-UI-3 | 会话页对齐（已交付范围）：欢迎页 hero + 最佳实践卡 + 免责声明、composer 卡片形态（未交付控件不渲染）、用户/助手消息形态、Markdown 正文 + 流式光标、步骤卡结构化摘要（不倒 JSON）、回到最新、消息操作条（复制） |
| F-UI-4 | 文件页对齐：树图标/大小/修改时间、根行形态、切换器弹层形态、预览头与不支持态/空目录文案、逻辑路径展示（不暴露服务器绝对路径） |
| F-UI-5 | 登录页与设置页对齐：登录卡结构（自有品牌位 + 副标题 + 自动聚焦）、外观分段控件 + 当前生效卡、关于卡图标 |
| F-UI-7 | 前端重建（2026-10-04，ADR-0013）：全部页面改用 assistant-ui（会话面）+ shadcn/ui + Tailwind；现有 token 映射进 Tailwind 主题；`web/src/ui` 自有基元退役。取代 F-UI-1–F-UI-5 的呈现约定 |
| F-UI-8 | 功能验收 harness（2026-10-04，ADR-0013）：按功能的验收清单取代 demo 逐组件清单与 demo-vs-app 截图对；`make ui-walk` 视口矩阵与 error oracle 保留。取代 F-UI-6 |
| F-UI-6 | demo 一致性验收 harness：Playwright 视口矩阵（1440/1024/390 × 亮/暗）、逐页 demo-vs-app 截图对产物（`make ui-shots`，人工验收输入）、肉眼可辨夹具（≥128px 图片 + 多段 md + 多行 csv）、逐页逐组件验收清单文档 |

## Phases（16 子阶段）

通用契约：每阶段 Verify 至少含 `make check` 绿 + 阶段专属验收；改动触碰 AGENTS.md
Critical Paths（沙箱/omp 治理）的必须白盒审查。必读文档所有阶段共有：`AGENTS.md`、
`CONTEXT.md`、`docs/architecture/system.md` §3–§6——下表只列增量。

前端通用契约（2026-09-24 增补；2026-10-04 按 ADR-0013 修订）：
- 凡触碰 `web/` 的阶段：Verify 必含该阶段页面的功能验收清单签收与 `make ui-walk`；
  Stage 5 对 web 任务的 `Suggested fixture level` 不得只以 jsdom/mock 收口，涉及呈现的任务至少 `expanded`（真实浏览器 + 视口矩阵）。
  S1f 关闭前已交付的阶段沿用原约定（demo-vs-app 截图对 + 逐组件清单），S1f 起不再产出截图对。
- 新页面与新组件一律用 shadcn/ui + Tailwind（会话面用 assistant-ui），不再新增 `web/src/ui` 基元，也不再对照 demo 的布局与文案。
- 无后端契约支撑的控件在其后端落地前**不渲染**；不得以禁用态/占位按钮"先摆上"。需要某个控件时，把它的后端排到同一批。
- 明确不做（2026-09-24 S1e grill 拍板，不列入任何阶段、不进验收清单）：麦克风语音输入、⌘K 命令面板、消息赞/踩、导出对话记录、通知铃铛；demo 快捷登录卡仅在 `dev-stub` 认证适配器下渲染（生产 OIDC 无此面）。
  2026-09-26 追加：追问建议 chip（无数据生成契约；omp `followUp` 是排队语义，不作来源，#404）；顶栏「更多」菜单（其 `切换主题`/`设置` 已由设置页与侧栏覆盖，`历史提问` 如需另立项，#403）；产物卡「在编辑器中打开」（本仓无内嵌编辑器，#403）。

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

**S1e 前端基准对齐（已交付页面）**
- Outcome：把 S0a/S0b/S1a 已交付的四页（登录、`/`、`/files`、`/settings`）按 demo 逐页逐组件对齐；建立基元组件库与 token 全集；接入视口矩阵与截图对产物；人工联合验收以截图对 + 清单签收。**不新增任何后端能力；demo 中无后端支撑的控件一律不渲染。**
- Files/components：`web/src/ui/*`（基元）、`web/src/styles/tokens.css`、`web/src/routes`（外壳）、四个 feature 目录的呈现层、`web/e2e`、`web/playwright.config.ts`、`smoke/fixtures/sandbox`、`docs/acceptance/demo-parity-checklist.md`。
- 覆盖：F-UI-1、F-UI-2、F-UI-3、F-UI-4、F-UI-5、F-UI-6。
- 必读增量：`docs/reviews/2026-09-24-demo-parity-audit.md` §4（逐页 demo 行号）；demo 全局组件节（demo:570-634, 934-1142）；ATTRIBUTION.md §4（token 可用、品牌图形不可用）。
- Verify：`make check` + `make ui-walk`（矩阵内每格无横向溢出、无 console error）+ `make ui-shots` 产物经人工按清单逐项签收（清单每项写"demo:行号 → 页面元素 → 通过/不通过"）。
- Depends on：S0b、S1a。
- Review attention：decision-dense（组件边界与 token 分层一次定调；之后所有 web 阶段只消费不重建）。

**S1c 会话治理与分组**
- Outcome：omp-supervisor 完整治理（每活跃会话一个、空闲回收、数量上限——池参数在此实测定参）；会话分组侧栏、三场景、fork、中断。另按 2026-09-24 S1e grill 裁定归入本阶段：**重新生成**（与中断/继续同批，复用回合语义）、**审批条**（允许/拒绝/超时自动通过——需 omp 退出 yolo 的权限模型，与 F-OPS-1 同批定）、**对话内搜索**（纯前端，落在对齐后的消息呈现层上）。另按 2026-09-26 #403/#404 拍板归入本阶段（与回合语义同批）：
  - **回合产物呈现（F-CHAT-9）**：唯一数据源是 S1a 已有的文件面与沙箱审计——写/编辑类工具的 `tool_execution_end` 结合审计写记录，由服务端归纳为新事件（如 `files.changed`：逻辑路径 + 增删行数，路径形态遵循 #386 / ADR-0011），只为实际落在工作空间内的文件渲染；卡片 `打开`/`查看详情` 跳 `/files` 预览，不内嵌编辑器。omp 的 `artifact://`（工具输出存储）不是产物来源。
  - **深度思考折叠（F-CHAT-10）**：服务端把上游 `thinking_delta` 映射为独立事件（如 `thinking.delta`），持久化与回放缓冲规则与 step detail 一致（对齐 #367 的结论）；模型无 reasoning 时不渲染折叠块。
  - 本阶段 change 须写明上述事件名与形状、持久化/回放策略。
- 覆盖：F-CHAT-1、F-CHAT-2、F-CHAT-7、F-CHAT-9、F-CHAT-10、F-OPS-1。
- Change 归属（2026-09-28 留痕）：本阶段按 2026-09-26 grill 切为两个 change。
  - **change A `s1c-turn-control-governance`**（epic #448，已交付）：F-OPS-1（进程池上限 / 最久空闲驱逐 / 空闲回收；`OMP_MAX_PROCESSES` 默认 16 经测试 VPS 实测保留，#494）、F-CHAT-7 中断（停止 → `stopped`）、F-CHAT-6 的 fork 子项、重新生成、审批条。
  - **change B `s1c-session-metadata-presentation`**（epic #509）：F-CHAT-1（三场景）、F-CHAT-2（会话分组侧栏）、F-CHAT-9（回合产物呈现）、F-CHAT-10（深度思考折叠）；承接 S1e 移交的对话内搜索、重命名、置顶、删除、composer footer 与场景胶囊；另含 slash 命令白名单与 `GET /api/commands`（原 #497，2026-09-26 拍板并入）。
  - change A proposal「功能覆盖声明」记录了与上文 Outcome 的偏离；「与 demo 的有意偏差」记录了四条留痕：
    1. 审批超时 60s 自动允许（demo 15s）；
    2. `stopped` 为独立终态；
    3. fork 入口在用户消息；
    4. 审批条只在真实 exec 调用时出现。
  - change B proposal「功能覆盖声明」记录了覆盖范围与「与 IMPLEMENTATION_PLAN S1c 的偏离」（对上文 F-CHAT-9 一条）：
    1. 文件变更只从 `edit` / `write` 工具帧推导，不结合沙箱审计（审计不记 omp 的写入）；
    2. html 产物卡在会话内以 sandbox iframe 预览；`查看详情` 跳 `/files?ws=<workspaceId>`，不定位到具体文件。
  - change B design Context「Oracle 差异」另记对上文 F-CHAT-10 一条的偏离：thinking 取与 step detail 相同的「有界 + 截断标记」原则，但上限为 32768 码点（step detail 为 4096），发布按 2048 B / 2 s 合并。
  - change B proposal「与 demo 的有意偏差」记录了六条留痕：
    1. 对话内搜索跳转时滚动并做消息级高亮，计数为匹配的消息数；
    2. composer footer 只显示空间，不显示权限；
    3. `助理任务` 分区、`导出记录`、产物卡 `在编辑器中打开`、顶栏 `更多` 不渲染；
    4. write 工具的文件变更行只标「写入」、无行数；
    5. 场景切换只改会话标记与欢迎页快捷任务，不切换模型与工具面；
    6. slash 命令的回复正文是 omp 英文原文，白名单外的 `/…` 文本当普通文本送模型。
  - 已修复：派发后约 1ms 内写入的 abort 曾使真实 omp 静默丢弃整轮；D2 修订后 `abort` 只在回合开始后写出（#650，change `stop-after-agent-start`，真 omp 复测 10/10）。回合在 grace 内一直没有开始时，用户消息仍不入 omp 历史，见 D2 修订段。
  - 已知限制：突发并发冷启动会触发握手超时 502（#652）。
- 必读增量：demo `/` 侧栏与场景交互；PLAN §5 并发资源治理。
- Verify：并发多会话压测（回收/上限生效）；双账号会话互不可见（初步）。
- Depends on：S0b、S1a、S1e（侧栏分组与场景要落在对齐后的外壳与基元上，避免二次返工）。
- Review attention：decision-dense（Critical Path：spawn/回收/限额）。

**S1d 中心能力面（专家/技能/连接器/模型）**
- Outcome：`/center` 的专家、技能、连接器、模型四个 tab：专家卡入会话、技能启停映射 omp 工具面、MCP 显式配置、模型注册表 UI+探活。
- 覆盖：F-CTR-EXP、F-CTR-SKL、F-CTR-CON、F-CTR-MOD、F-CHAT-11c。
- 必读增量：demo `/center` 对应 tab；`resource/oh-my-pi/docs/`（工具面与 MCP 配置面）。
- Verify：专家加入后系统提示词/工具面变化可观察；探活状态真实反映端点可用性。
- Depends on：S1c、S1f（中心页直接建在新组件体系上；专家入会话接输入框「+」菜单，即 F-CHAT-11c）。
- Review attention：mechanical 为主（UI+配置透传；MCP 配置注入 omp 需一眼白盒）。
- 注：PLAN §4 阶段表未给这四个 tab 安家，本阶段是对 PLAN 的补全（不矛盾）。

**S1f 前端重建（assistant-ui + shadcn/Tailwind）**
- Outcome：按 ADR-0013 重建已交付的全部页面（登录、外壳、`/`、`/files`、`/settings`）。会话面经 `useExternalStoreRuntime` 接现有
  REST + SSE；输入框带能力栏中后端已有的两项（工作空间选择、技能/命令选择）。
- 已定（2026-10-04 grill，owner 逐条拍板）：
  1. 逐页替换：每个 PR 合入后主干可运行，过渡期新旧页面并存。
  2. 沿用现有配色体系：颜色/圆角/字号映射进 Tailwind 主题，组件换、配色不换。
  3. 点「新建会话」只回到欢迎态；发送第一条消息时才创建会话（取代 #826 的修法，#825 随之消失）。
  4. 会话开始后工作空间锁定。
  5. 未选空间就发送 → 会话专属临时空间：产物照常记录；随会话删除而删除；可另存为正式空间；文件页不列出，从会话进入。
  6. 三场景只保留为欢迎页的建议分组，切换不弹提示（#824），会话开始后不显示。
  7. 会话列表参考 Claude Code 桌面版：按工作空间分组可折叠（可切换按时间）、置顶区、状态标记（运行中 / 等待审批 / 未读）、搜索、更多菜单、归档。
  8. 工具调用默认折叠成一行摘要；文件变更卡与产物卡在折叠之外；失败步骤自动展开。
  9. 挂起审批固定在输入框上方（ADR-0013 第 4 条）。
- Change 切分与顺序（每个 change 一次流水线运行）：
  - **A `s1f-ui-foundation`**：Tailwind + shadcn/ui 基础组件 + 主题（现有 token 映射）+ 新分层与 guardrails；外壳、登录页、设置页重写；
    验收方式切换（功能验收清单取代 demo 清单，`make ui-shots` 退役）。纯前端。
  - **B `s1f-chat-surface`**：会话页——消息线程、思考、工具调用折叠、输入框能力栏（空间选择、技能/命令）、输入框上方审批条、
    首次发送时创建会话、停止/重新生成/fork、文件变更卡、产物卡与产物面板、对话内搜索、项目配置入口、欢迎页与场景；
    输入框上方的任务清单面板。**含后端**：任务清单状态经 `todo.updated` 事件与快照字段下发（迁移 036）。
    2026-10-04 设计阶段 owner 另定：待决审批做成输入框上方的提问卡（参照 Claude Code 桌面版），答完在消息内留已结算记录；
    任务清单面板同样停靠在输入框上方；助手正文改用 `@assistant-ui/react-markdown`；会话页不再弹轻提示（成功/信息类删除，失败就地显示）；
    不做代码分割，只量并记录包体；#824、#825、#826 在新会话页上解决。
  - **C `s1f-session-list-temp-space`**：会话列表（分组/置顶/状态/搜索/归档）与临时空间。**含后端**：临时空间的创建/删除/另存、
    归档字段、列表所需的「等待审批」「未读」状态。
  - **D `s1f-files-page`**：文件页重写。纯前端。
- 覆盖：F-UI-7、F-UI-8、F-CHAT-11a。
- 必读增量：ADR-0013（含试验结论与未覆盖项）；assistant-ui 文档 ExternalStoreRuntime / Thread / ThreadList / Attachment。
- Verify：`make check` + `make ui-walk`（视口矩阵无横向溢出、无 console error）+ 功能验收清单签收；真实端点走一轮含审批的回合；
  断线/刷新续流（F-CHAT-8）在新会话面上复测。
- Depends on：S1c。
- Review attention：decision-dense（组件分层、token 映射、SSE 接入方式一次定调）。
- 留给各 change 设计阶段的开放项：未读标记存服务端还是浏览器本地（C）；已结算审批是否在消息内标注，需要审批与步骤的关联键（B）；
  包体积与代码分割（A/B）。
- 2026-10-06 owner 决定（验收 B 之后；逐条压测记录随各 change 的 design 落库）：
  1. **推翻「已定」第 8 条的后半句与 B 的一处设计**（#911）：工具调用组一律默认收起，**失败步骤不再自动展开**，摘要行保持现状；
     确认处理完之后**不再在消息内留已结算记录卡**，超时自动允许与已拒绝并入对应步骤卡的小标记。#911 独立交付，不属于 C / D。
  2. **「已定」第 7 条去掉「未读」**：会话列表不做未读；状态标记只有运行中 / 等待确认 / 失败三种，由服务端推送刷新；
     取消原有的状态与时间筛选；搜索只搜标题；更多菜单为重命名、置顶、归档、删除、另存为工作空间、导出记录（Markdown）。
     开放项「未读标记存服务端还是浏览器本地」随之取消。
  3. **C 的范围扩大**：并入 #907 用户消息撤回（这条及之后的消息从当前会话移除并回填输入框；每个回合开始前给工作空间做快照，
     撤回时还原文件；没有快照的轮次不能撤回）。临时空间补充：另存为工作空间 = 原地转正；分叉与原会话共用同一个临时空间，
     最后一个使用它的会话删除时才删目录；已有的未绑定会话保持原样。
  4. **D 的范围扩大，不再是纯前端**：并入 #913——F-FILE-4 的扩展格式、所有文件可下载、文件与目录的删除 / 重命名 / 同空间内移动、
     HTML 预览经独立端口的隔离来源提供（相对资源可加载）、办公文档经服务端转 PDF、预览器允许按需加载（只对预览器放开代码分割）；
     会话页右侧的工作空间侧边栏（文件树 + 预览，可拖宽）取代产物面板与网页预览弹窗。
  5. 其它独立 issue，不属于 C / D：#908（消息操作行悬停显示、用户消息加复制）、#909（上游拒绝时显示错误）、
     #910（等待与思考呈现，思考与正文事件按 250 毫秒时间窗合并）、#912（接入 omp 浏览器能力）。
  6. C、D 各自一次流水线运行，顺序 C → S1g → D（S1g 只依赖已交付的 B，不被 C、D 阻塞）。

**S1g 输入框能力（权限档 + 工作空间附件 + 模型与推理强度）**
- Outcome：会话权限设置（语义待 grill：暂按审批档位理解——档位集合、默认档、与宿主 overlay 钉住的审批键的关系、审计）与工作空间附件上传（整文件写入会话空间，过沙箱 resolve、
  大小/类型上限、审计）；输入框能力栏的权限设置与「+」上传文件两项随之上线。
- 覆盖：F-CHAT-12、F-CHAT-5a、F-CHAT-11b。
- 必读增量：ADR-0012（overlay 钉住的审批键）；tool-approval 规格；CONTEXT.md 不变量 3（一切路径过 resolve）。
- Verify：各档位下审批是否出现与规格一致（真 omp）；上传的越界/超限用例全拒且入审计；双账号互不可见。
- Depends on：S1f。
- 2026-10-06 owner 决定：
  1. 权限设置的语义见 F-CHAT-12（三档、默认只问命令、按会话、下一条生效、超时自动允许不变、改档记审计；选「全部自动」时弹一次确认）。
     omp 没有运行期切换审批模式的命令，换档在两个回合之间重启该会话的进程——由此要改 omp-runtime 规格里
     「`write` 是唯一允许值、不得运行期切换」一句与 ADR-0012 的相应说明。
  2. 工作空间附件：任意类型，单个文件上限 500 MB，一次最多 10 个，数值可配；放进工作空间根下的 `uploads` 目录，同名自动编号；
     输入框显示附件标签并随消息告知路径；欢迎页可选文件、发送时上传；支持拖拽与粘贴。
  3. **范围扩大**：并入 #906——输入框下方一行右侧显示模型名与推理强度，各自可点击切换；可用模型来自服务端白名单；
     按会话保存、新会话沿用上次选择；生成中可改、下一条生效；强度按 omp 支持的全部档位；不按消息记录模型。
     布局参照 Claude Code 桌面版：左侧「+」、工作空间与权限档位，右侧模型名与强度。
- Review attention：decision-dense（Critical Path：审批策略放宽与写入沙箱）。

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
- 覆盖：F-CHAT-4、F-CHAT-5b、F-CTR-KB4。
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
| S0b | F-CHAT-3/6/8、F-OPS-2（F-CHAT-6 的 fork 子项按 2026-09-18 grill 裁定归 S1c，与 S1c Outcome 原文一致）|
| S1a | F-FILE-1/2/4/5 |
| S1b | F-FILE-3 |
| S1c | F-CHAT-1/2/7/9/10、F-OPS-1 |
| S1d | F-CTR-EXP/SKL/CON/MOD、F-CHAT-11c |
| S1e | F-UI-1/2/3/4/5/6（呈现约定由 S1f 的 F-UI-7/8 取代）|
| S1f | F-UI-7/8、F-CHAT-11a |
| S1g | F-CHAT-12、F-CHAT-5a、F-CHAT-11b |
| S2a | F-CTR-KB1/KB2 |
| S2b | F-CTR-KB3 |
| S2c | F-CHAT-4/5b、F-CTR-KB4 |
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

> 2026-10-04 更新（ADR-0013）。S1c 的实现已全部合入；其 demo 逐组件签收（25 项待签）不再进行。
> 2026-10-06 更新：S1f 的 A、B 已交付并归档（B 的功能验收清单 CH-01…CH-57 待 owner 签）。余下三次流水线运行按 C → S1g → D 的顺序进行，
> 范围见上文 S1f 与 S1g 两节的「2026-10-06 owner 决定」；验收中另开的独立 issue 为 #908–#912。
> **主线改为 S1f**：对其跑 `/stage-change-pipeline`，随后 S1g，再回到 S1d。S1b、S2a 不依赖前端，仍可并行。
> #824、#825、#826 并入 S1f 的设计，不按旧界面单独修。以下为 2026-09-26 的原记录。

> 2026-09-26 更新。已关闭：S0a、S0b（#81）、S1a（#111）、S1e（#274），账本见 `docs/stage-pipeline-log.jsonl`。

依赖已满足、可启动的子阶段：S1c（依赖 S0b/S1a/S1e）、S1b（依赖 S1a）、S2a（依赖 S1a）。其余全部链在这三者之后。

- **主线 S1c**：对其跑 `/stage-change-pipeline`。grill 种子：本文 Open Decisions 的 omp 池参数；
  S1c 现承载 F-CHAT-1/2/7/9/10 + F-OPS-1 加 S0b/S1e 移交项（fork、重新生成、审批条、对话内搜索、场景胶囊、
  分组侧栏与条目菜单、停止生成、composer footer、顶栏重命名），宽度已触及 Risks「切片过宽」一条——grill 首问是否按
  后端契约切为治理侧（池上限/回收、中断/继续、重新生成、审批条、fork）与呈现侧（分组/场景/搜索/产物卡/思考折叠）两个 change。
  需先核实的事实：omp v18.0.10 非 yolo 审批模式下工具审批提示在 rpc 模式是否经 `extension_ui_request confirm` 帧下发（已核实：经 `extension_ui_request` 的 `select` 帧下发，选项 Approve/Deny，见 #481、#495）；
  F-CHAT-9 不能依赖"审计写记录"——审计现只发 `sandbox.reject` 与 `workspace.create`，omp 写文件不经 `sandbox.resolve`，
  文件变更只能从工具帧推导或新建机制。
- **并行 S2a spike**：研究性质，无需 grill 门禁，独立 worktree 起；产出 api.db 解耦可行性、Infinity PoC、deepdoc 模型清单三项结论。
- **S1b 前置**：测试 VPS 尚无 rclone/sshfs；首任务在 VPS 验证 app-server uid 挂载 + omp uid 可读写（`allow_other`）+
  rclone 配置对 omp 不可读三者同时成立，结论决定 ADR-0003 是否需补充，之后再排 S1b 流水线。

单 issue 的实现/修复/合并走 `/subagent-workflow`。
