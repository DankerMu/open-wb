# Proposal: s1d-experts-skills

> Issue type: feature（S1d 中心能力面第二刀：专家 + 技能，含输入框「+」菜单的专家项 F-CHAT-11c 与「能力」弹层）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明——组 4、7、8、9、10 为 compact）
> Blast radius: omp 子进程 argv（每次 spawn 多一个 `--config` 与可选的 `--append-system-prompt`）、`OMP_STATE_DIR` 托管布局（新目录 `session-config/`，`2710`）与服务启动的 `state_layout` 阶段（启动清扫）、派发前对齐的重启判据、`POST /api/sessions` 的 body 键集、迁移 047（新表两张 + `chat_sessions` 两列）、`/center` 对普通用户从空态变为有 tab、输入框能力行多出专家与「能力」两个控件
> Evidence floor: `npm test --workspace server`（含 `WORKBUDDY_OMP_TEST=1` 官方用例）、`npm test --workspace web`、typecheck、size-guard、`make check`、`make test-guardrails`、`make ui-walk`、PR CI `uid-isolation`
> 依赖：建在 change `s1d-model-registry`（Epic #1640）之上——错误码 `forbidden`（#1641）、迁移 046（#1645，本 change 用 047）、启动装配阶段表（#1647，`state_layout` 阶段加启动清扫）、存活进程模型集合（#1648，同改 `sessionRuntimeOpts`、新准入与派发前对齐第 1 步）、模型管理端点（#1649，启动模块记录与 content-parser 归属身份清单在其上再加）、中心页外壳与模型 tab（#1643、#1651）。归档顺序：`s1d-model-registry` 先于本 change。
> 迁移编号预留：本 change 047；`s1d-connectors` 048；S1b 挂载 049。

## Why

`IMPLEMENTATION_PLAN.md` S1d 要求中心页的专家（F-CTR-EXP：专家卡片、分类 / 标签、加入会话）与技能（F-CTR-SKL：技能清单与启停）两个 tab，以及输入框「+」菜单的专家项（F-CHAT-11 的 11c）；Verify 一行是「专家加入后系统提示词 / 工具面变化可观察」。今天会话没有专家概念，chat-web 规格明写「专家与麦克风 SHALL NOT 渲染」；技能只能由运维往托管目录放文件，全部会话一律加载，用户既不能关也看不到开关。

grill（2026-10-21，owner 逐分支拍板）定了方向：专家**人人可自建**（自建只自己可见）+ 仓库内置清单；每会话至多一个专家，欢迎态定初值、会话中可换，下一条消息生效（复用派发前对齐的重启路径）；专家经每次 spawn 的 `--append-system-prompt`（app 持有的文件）注入；专家声明一组技能，加入会话时与会话技能集合取并集；技能按**会话**启停，经会话专属的第二个 `--config` 文件（app 持有、进程退出即删）写给 omp；中心 tab 改的是**账号缺省**，输入框新的「能力」弹层改的是**当前会话**；F-CHAT-1「场景决定默认专家」正式作废。

## What Changes

- **会话配置文件**（omp-runtime）：每次 spawn 前在 `<state>/session-config/`（`2710`：omp uid 能按路径读、不能列举）写一份本进程专属的 YAML（恰一行 `disabledExtensions: [...]`，元素为 `skill:<名称>`，每个写作 JSON 字符串）与可选的专家提示词文件；argv 在宿主 overlay 的 `--config` 之后追加 `--config <该 YAML>`，有专家时再追加 `--append-system-prompt <提示词文件>`。文件在子进程退出时删除，启动的 `state_layout` 阶段由单独的 `sweepSessionConfig` 清扫残留（不在每次 spawn 的布局校正里）；CI `uid-isolation` 证明 omp uid 能读这些文件（假 omp 新增 `read:` / `list:` 探针）。写出器是通用的（`disabledExtensions` 列表 + 可选提示词），`s1d-connectors` 往同一列表加 `mcp:<名称>`。用 `disabledExtensions` 的拒绝列表而不是 grill 字面上的 `skills.includeSkills`：omp 把空的 `includeSkills` 当作「全部技能」，「一个技能都不开」无法表达；拒绝列表与连接器的 `mcp:<名称>` 同键（design D1）。
- **迁移 047**（`047_experts_skills.sql`）：`experts`（自建专家，属主外键级联删除）、`account_skill_prefs`（账号缺省停用的技能名列表）、`chat_sessions.expert_id`、`chat_sessions.disabled_skills`。
- **内置专家**：仓库内四位（取 demo 的 `前端架构师`、`数据分析师`、`品牌视觉设计师`、`测试工程师`），各有一段真实撰写的系统提示词；id 形如 `builtin:<slug>`，不可改、不可删。
- **专家端点** `/api/experts`：`GET` 列出对本账号可见的专家（内置 + 自建）；`POST` 新建自建专家；`PUT ?id=` / `DELETE ?id=` 只对自己的专家，判定次序 401 → `id` 400 → 改内置 403 `forbidden` → 别人的或不存在 404 → body 400（前四者先于 body 解析）；带 body 的两条 body limit 64 KiB；删除在同一事务里把引用它的会话的专家清空。审计 `expert.create` / `expert.update` / `expert.delete`。
- **技能端点**：`GET /api/skills` 返回 `{skills, disabledSkills}`——平台技能（托管 `skills/` 目录，与 `/api/commands` 同一读取规则）及其缺省启停，加上本账号缺省停用列表原样（含列表外的名称）；`PUT /api/skills/defaults` 整体替换账号缺省停用列表，应答同 GET。
- **会话能力**：`POST /api/sessions` 可选带 `expertId`、`disabledSkills`（**BREAKING** 对 body 键集只是放宽）；新端点 `GET` / `PUT /api/sessions/:id/capabilities` 读改当前会话的专家与停用技能——会话视图的十四键不变。新会话的停用列表缺省取账号缺省；一个 body 只要设了专家，就从（给出的或当前的）停用列表里去掉该专家声明的技能（并集规则）。fork 继承两列。
- **派发前对齐**（chat-sessions）：slot 记下启动时会话配置文件的内容指纹；有效能力（专家、其提示词、停用列表）与之不同 → 退役重启，与换档位、换到未加载模型同一条路径。改专家、改提示词、改停用列表都在下一条消息生效，不打断在途回合。
- **中心「专家」与「技能」tab**（人人可见，排在 `模型` 之前）：专家卡片（分类 chip `全部/开发/办公/设计/产品`、搜索、内置 / 自建标记、`开始会话`、自建的 `编辑` / `删除`、`新建专家` 对话框）；技能列表（平台技能与 `默认启用` 开关）。普通用户的 `/center` 不再是空态，验收 SH-01、CM-04 随之改写。
- **输入框**：「+」菜单加 `选择专家…`（F-CHAT-11c），选中后能力行出现 `专家` 标签（可清除）；能力行加 `能力` 按钮，弹层列出本会话可用的技能（平台 + 项目）及开关，注明从下一条消息起生效；欢迎态的选择随首次发送的 `POST /api/sessions` 带上；斜杠候选与「+」菜单不再列出本会话停用的技能。chat-web「专家与麦克风 SHALL NOT 渲染」改为只禁麦克风。
- **作废 F-CHAT-1 的「场景决定默认专家」**：场景只决定快捷任务；`IMPLEMENTATION_PLAN.md` 相应行注明。

## Capabilities

### New Capabilities
- `experts`: 内置与自建专家的数据、可见性、管理端点、提示词注入规则、中心「专家」tab 与输入框的专家选择。
- `skill-switches`: 账号缺省与会话级技能停用、会话能力端点、中心「技能」tab 与输入框「能力」弹层。

### Modified Capabilities
- `omp-runtime`: 「子进程 spawn 契约」（argv 追加会话配置）、「OMP_STATE_DIR 托管布局」（`session-config/` 目录）。
- `chat-sessions`: 「派发前按会话设置对齐进程」第 1 步加会话能力判据（以 `s1d-model-registry` 的版本为底）。
- `session-metadata`: 「会话创建与空间绑定」（body 键集加 `expertId`、`disabledSkills`）、「fork 继承会话元数据」（继承两列）。
- `chat-web`: 「输入框与能力栏」（专家项、专家标签、`能力` 按钮、停用技能不进候选；以 `s1d-model-registry` 的版本为底）。
- `session-sidebar`: 「欢迎页场景胶囊与场景化快捷任务」（首次发送的 body 可带两键；场景不决定专家）、「composer footer 工作空间选择」（能力行不再禁止专家控件）、「会话 DTO 严格解析」（`createSession` input 加两键，会话对象十四键不变）。
- `http-service-skeleton`（以 `s1d-model-registry` 的版本为底）: 「服务启动与装配」（启动记录十个模块）、「统一错误信封」（归属身份二十一 → 二十五条）、「Shared agent module assembly」（注册次序 models 之后 experts、skills）。
- `session-permission-tier`: 「权限档位控件」（位置由「左组第三项」改为「紧随工作空间之后」）。
- `omp-uid-isolation`: 「Linux 隔离证明」（托管布局用例加 `session-config/`：omp uid 能读、不能列举 / 新建 / 改名）。
- `omp-test-harness`: 「假 omp probe 回报」（加 `read:` / `list:` 两种探针提示）。
- `model-registry`（由 `s1d-model-registry` 新建）: 「中心页外壳」（tab 表次序与 routeManifest 描述）。

## Impact

- 服务端：`server/src/sessions/omp/`（新 `session-config.ts`、`process.ts` argv、`state-layout.ts` 与 `sweepSessionConfig`）、`server/src/server.ts`（`state_layout` 阶段调清扫）、`server/test/support/fake-omp.mjs`（`read:` / `list:`）、`server/test/linux/uid-isolation.test.ts`、`sessions/pool.ts`、`sessions/composer-align.ts`、`sessions/supervisor.ts`、`sessions/rest-metadata.ts` 与 store、新 `server/src/experts/`、新 `server/src/skills/`、`app.ts` 注册两个模块。
- 前端：新 `web/src/features/center/experts/`、`web/src/features/center/skills/`、`features/center/tabs.ts`、`features/chat/` 的能力行、「+」菜单、新专家选择与能力弹层组件、`welcome-options.ts`、新 API 客户端 `api-experts.ts`、`api-skills.ts`、`api-session-capabilities.ts`。
- 文档与验收：`docs/architecture/system.md`、ADR-0010 布局表、`IMPLEMENTATION_PLAN.md`（F-CHAT-1、F-CTR-EXP、F-CTR-SKL 行）、验收清单 SH-01、CM-04、CH-11、CH-66 改写与新增「中心·专家（CE）」「中心·技能（CS）」两节。
- 不新增依赖、不新增 `.css`；拷入层若缺 `switch`、`textarea`、`popover` 按 ADR-0013 拷入。
