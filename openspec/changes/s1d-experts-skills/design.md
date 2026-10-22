# Design: s1d-experts-skills

## Context

事实基线（worktree 基于 origin/master `c3c6bb53`，2026-10-22 读码；omp 语义读冻结源码 `resource/oh-my-pi`（v18.0.10，唯一在库源码）并对钉住二进制 `var/omp/omp`（v18.12.3）做字符串核对；每组第一个任务仍核对行号）：

- **spawn argv**：`server/src/sessions/omp/process.ts:93-112` 依次 `--mode rpc-ui --cwd --session-dir --model workbuddy/<id> --approval-mode --no-extensions --no-lsp --no-pty --no-title --config <host-overlay>`，:113-115 仅在有会话文件时追加 `--resume`；恰一个 `--config`，没有 `--skills` / `--append-system-prompt`。`SpawnOmpOpts`（:41-56）没有额外 argv 字段。`spawn-env.ts:31` 另把 overlay 路径放进 `PI_CONFIG_FILES`。两条 spawn 路径都经 `pool.ts:222` `sessionRuntimeOpts`：`supervisor.ts:503`（会话 slot）与 `branch-temp.ts:99`（fork / branch 临时进程）。`state-layout.ts:29-31` overlay 在 `<state>/home/.omp/agent/host-overlay.yml`，:96-100 拒绝含 `:` 的状态目录（`PI_CONFIG_FILES` 以 `:` 分隔）；`replace-file.ts:12-18` 原子替换、终态 0640。
- **omp 语义**（v18.0.10 源码；二进制核对处标注）：
  - `--config` 可重复（`cli/flag-tables.ts:117-119`）；配置文件 = `PI_CONFIG_FILES` 各项在前、`--config` 各项在后（`config/settings.ts:501-503`），按序深合并、后者胜（:1559-1567）；只递归普通对象，数组 / `null` / 标量整体替换（:2667-2688）；层次 global < project < config overlays < overrides（:2649-2652）；缺失或不可解析的 `--config` 文件是硬错误（:1576-1587，二进制有同一字符串）。
  - `--append-system-prompt` 单值、后者胜（`flag-tables.ts:169-171`）；`resolvePromptInput`（`system-prompt.ts:387-400`）：取值不含换行即当路径读文件，ENOENT 时退回把取值当字面文本；启动时解析一次（`main.ts:1099-1104`）；拼在 omp 自己的追加段（MCP 说明）之后（`sdk.ts:3086-3089`）。**未给该参数时** omp 自行发现 `APPEND_SYSTEM.md`（先项目、后用户，`main.ts:1046-1056`）。
  - 技能：`skills.includeSkills` 缺省 `[]`，**空数组 = 全部技能**（`extensibility/skills.ts:196-199`，二进制核对一致），元素为 glob；`disabledExtensions` 数组（`settings-schema.ts:642`），元素 `skill:<名称>` 精确匹配去掉该技能（`skills.ts:207-209`），对平台与项目技能同样生效（:265-270）；`--no-extensions` 不影响技能发现（`sdk.ts:1389-1401`）。技能目录：`<祖先>/.omp/skills`（项目，近者胜）与 `<agentDir>/skills`（用户 / 平台）。
- **派发对齐**：`composer-align.ts:29-34` `reusable()` 只比档位（#1648 加模型集合）；:45-61 `set_model` / `set_thinking_level`。`supervisor.ts:435-467` 不可复用即 `#retireSlot` 后走新准入；:757-781 退役不删任何文件；`runtime.ts:206-220` `shutdown()` 也不删文件。`pool.ts:28-47` `Slot` 字段（含 `approvalMode`），:14-26 `Generation.applied`。主规格 chat-sessions「派发前按会话设置对齐进程」:640-；`s1d-model-registry` 的 delta 已改其第 1 步（「…时 SHALL 复用存活进程，不因本条多一次重启」——本 change 必须改同一句）。
- **会话设置**：`rest-metadata.ts:55-63` `CREATE_KEYS = {workspaceId, scene, …composer}`、`PATCH_KEYS`；:200-207 未知键 400。`store-composer.ts` 读写 composer 三列；`account_composer_prefs`（041）是账号最近选择的先例。`chat_sessions` 最后一次被迁移改是 040；迁移止于 045，046 归 `s1d-model-registry`。会话视图恰十四键（session-metadata「会话视图扩展键」，并被 chat-web「API 客户端扩展」、session-sidebar「会话 DTO 严格解析」、turn-control 等八处规格引用；web `session-contract.ts:274-289` 严格解析）。
- **技能清单**：`slash-commands.ts:115` `listSkills(agentDir)` 读 `<agentDir>/skills/<entry>/SKILL.md`；:139 `listProjectSkills(cwd, sandboxRoot)`；`GET /api/commands`（`rest-commands.ts:36-56`）按 `?workspaceId=` 解析 cwd，条目 `name` 为 `skill:<名称>`、`source` 为 `skill|project`；宿主列不全 omp 加载的全部技能（`slash-commands.ts:18-19`）。托管 `skills/` 由运维安装（omp-runtime 布局表 :365，`state-layout.ts:72-85` 不建它）。
- **web**：`capability-bar.tsx`（319 行）:1-3 注释「专家、麦克风等控件不渲染」，:100-172 「+」菜单；`conversation-view.tsx`（351）承载 `ModelPicker` 与 `CapabilityBar`；会话内设置修改经 `session-actions.ts:476` `patchComposer`（不在 `use-chat-session.ts`）；欢迎态首次发送的 body 由 `welcome-options.ts`（69 行）:47-53 `createBody()` 产出。拷入层已有 `popover`、`textarea`、`dialog`、`alert-dialog`、`dropdown-menu`、`input`、`label`、`card`；没有 `switch`、`badge`、`select`（`select` 由 `s1d-model-registry` 组 10 拷入）。
- **规格中的禁止句**：chat-web「输入框与能力栏」:674「专家与麦克风 SHALL NOT 渲染」；session-sidebar :80「会话内切换场景的入口不渲染（归 S1d）」、:107 与 :119 能力行没有专家控件。验收清单 SH-01 :53、CH-11 :78（菜单里没有专家）、CH-66 :133（这一行没有专家）。
- **计划与 demo**：`IMPLEMENTATION_PLAN.md:90` F-CHAT-1「决定默认专家与工具面」、:100 F-CHAT-11（11c 专家）、:115 F-CTR-EXP、:116 F-CTR-SKL、:247-255 S1d。demo `resource/workbuddy-live-demo.html`：专家 `{id,name,sub:'内置专家'|'本地自建',desc,tags[],category}`（:1592-1599，内置四位：前端架构师 / 数据分析师 / 品牌视觉设计师 / 测试工程师），分类 `['全部','开发','办公','设计','产品']`（:3168），卡片按钮「召唤」（:3176-3186）；技能卡（:3189-3205）为安装 / 卸载语义；demo 输入框没有「+」菜单（:2590）。
- **行数**（size-guard 800）：`process.ts` 787、`supervisor.ts` 785（#1648 另有增量）、`pool.ts` 383、`composer-align.ts` 61、`rest-metadata.ts` 263、`app.ts` 491（#1642/#1647/#1649 之后约 530）、`capability-bar.tsx` 319、`conversation-view.tsx` 351、`use-chat-session.ts` 795（#1644 之后 796，本 change 不碰）、`api.ts` 503。

## Goals / Non-Goals

**Goals:**

- 专家：内置四位 + 人人自建（只自己可见）；一个会话至多一个专家；欢迎态与会话中都能选、能换，下一条消息生效；专家提示词进入 omp 系统提示词（官方 omp 用例在发往上游的请求里观察到）。
- 技能：每个会话有自己的停用技能集合；新会话的初值来自账号缺省；omp 真的不加载被停用的技能（官方 omp 用例观察到）；斜杠候选与「+」菜单不再列出停用的技能。
- 中心「专家」「技能」两个 tab 对所有人可见；输入框「+」菜单的专家项与「能力」弹层。
- 会话专属配置文件机制可被 `s1d-connectors` 复用（同一 `disabledExtensions` 列表加 `mcp:<名称>`）。

**Non-Goals:**

- 技能的安装 / 卸载 / 上传（demo 的「安装」「卸载」）：平台技能仍由运维放进托管 `skills/`；本 change 只做启停。
- 专家共享给他人、部门可见、管理员审核；专家头像图片；专家团（demo 侧栏「专家团」分组）。
- 账号缺省专家（中心「专家」tab 的 `开始会话` 只是带着该专家回到欢迎态）。
- 会话内切换场景：F-CHAT-1 作废后场景只决定欢迎页快捷任务，会话里改它没有效果，不提供入口。
- 专家声明连接器（`s1d-connectors` 的事）；`--tools` 工具过滤（grill 开放项 3）。
- 让宿主列出 omp 能加载的全部技能（其它 provider、托管 HOME 里的技能）：弹层与中心只列宿主能读到的平台 + 项目技能。
- 技能 `includeSkills` 允许列表、按 glob 停用。

## Decisions

### owner 的裁定（2026-10-21，grill，已定，不是选项）

| 分支 | 结论 | 由谁定 |
|---|---|---|
| 专家来源与可见性 | 人人可自建（仅自己可见）+ 仓库内置清单 | owner |
| 专家注入 | 每次 spawn `--append-system-prompt`，app 持有的文件 | owner |
| 每会话专家数与时机 | 至多一个；欢迎态定初值，会话中可换，下一条消息生效（复用对齐重启） | owner |
| 专家与技能 | 专家声明技能集合，加入时与会话技能集合取并集 | owner |
| F-CHAT-1「场景决定默认专家」 | 正式作废（Non-Goal） | owner |
| 技能启停粒度与载体 | 会话级，经会话 overlay（第二个 `--config`，app 持有，退役即删） | owner |
| 中心 tab 与会话入口 | 中心 tab 改账号缺省；输入框新增「能力」弹层改会话 | owner R5 |
| 事实（fact-check） | omp 18.12.3 有 `--append-system-prompt`、可重复 `--config`、`disabledExtensions`、`skills.includeSkills` | 核查 |

### 起草者的技术决定

- **D1 会话配置文件**（`server/src/sessions/omp/session-config.ts`）：`writeSessionConfig(stateDir, {disabledExtensions: readonly string[], appendSystemPrompt: string | null}) → {args: string[], key: string, remove(): void}`。每次 spawn 前（`spawnOmp` 内、取 argv 之前）写 `<state>/session-config/<key>.yml`（恰一个顶层键 `disabledExtensions`，元素按字典序去重，空时写 `[]`——数组整体替换，所以项目层的同名键永远被覆盖）与有提示词时的 `<key>.md`（提示词原文，UTF-8），两者经 `replaceFile` 原子写、0640；`key` 为每次 spawn 新生成的随机 hex，与会话 id 无关（fork 临时进程也走同一路径）。argv 在宿主 overlay 的 `--config` 之后追加 `--config <yml>`，有提示词时再追加 `--append-system-prompt <md 绝对路径>`（路径不含换行，omp 一定按文件读）。`remove()` 在该子进程退出时调用（`process.ts` 的子进程 exit 观察处；无论原因），删除失败只记日志；`ensureOmpStateLayout` 建 `session-config/`（app 所有、组 omp、2750，与 `agent/` 同一规则）并在启动阶段 `state_layout` 清空其中残留文件。`s1d-connectors` 往同一 `disabledExtensions` 加 `mcp:<名称>`。写出失败按目录准备失败处理（不 spawn、已写的文件删掉）；启动清扫删不掉残留时启动以 `state_layout` 失败；每次 spawn 的 `ensureOmpStateLayout` 不清扫（会删掉存活子进程的文件）。
  - 为什么不用 `--skills` / `includeSkills`：空 `includeSkills` = 全部技能，「全部停用」无法表达；`--skills` 是 override 层、只接受非空列表。拒绝列表还让运维新装的技能对既有会话默认可用，与「平台技能由运维安装」的现状一致。
  - 为什么不放进宿主 overlay：overlay 是部署配置的纯函数（omp-runtime「宿主 overlay」），会话差异不进它。
- **D2 迁移 047**（`server/src/core/db/migrations/047_experts_skills.sql`）：
  - `experts(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('开发','办公','设计','产品')), tags TEXT NOT NULL, prompt TEXT NOT NULL, skills TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` + `CREATE INDEX experts_owner ON experts(owner_id, created_at)`；`tags` / `skills` 为 JSON 字符串数组文本。
  - `account_skill_prefs(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, disabled_skills TEXT NOT NULL, updated_at INTEGER NOT NULL)`。
  - `ALTER TABLE chat_sessions ADD COLUMN expert_id TEXT NULL`；`ALTER TABLE chat_sessions ADD COLUMN disabled_skills TEXT NOT NULL DEFAULT '[]'`（既有会话 = 无专家、无停用，行为不变）。`expert_id` 不设外键（内置专家不在表里）。
- **D3 内置专家**（`server/src/experts/builtin.ts`）：四位，id `builtin:frontend-architect` / `builtin:data-analyst` / `builtin:brand-designer` / `builtin:test-engineer`，名称、分类、标签、描述取 demo，`prompt` 为本仓库撰写的真实中文系统提示词（每段 300–1500 码点，写清角色、工作方式、输出要求，不提及不存在的工具），`skills: []`（平台技能由运维决定，内置专家不预设）。代码常量，不进 DB。
- **D4 专家校验与可见性**（`server/src/experts/store.ts`）：`name` trim 后 1..32 码点；`description` 0..200 码点；`category` 四选一；`tags` ≤5 项、每项 trim 后 1..12 码点、去重；`prompt` trim 后 1..8000 码点（原样保存 trim 后文本）；`skills` ≤32 项、每项为技能名（1..128 UTF-8 字节、无控制字符、无 `,`）、去重排序；每账号自建 ≤50 个。可见集合 = 内置 ∪ `owner_id = 本账号`；对他人专家的任何操作与不存在同样 404。id 由服务端生成（32 位小写 hex）。
- **D5 专家端点**（`server/src/experts/rest.ts`，模块 `experts`）：
  - `GET /api/experts` → 200 `{experts: ExpertView[]}`，`ExpertView = {id, name, description, category, tags, prompt, skills, builtin}`；内置在前（固定次序），其后自建按 `created_at, id`。
  - `POST /api/experts` body `{name, description?, category, tags?, prompt, skills?}`（键集严格）→ 201 视图；第 51 个 400。
  - `PUT /api/experts?id=` body 同 POST（整体替换）→ 200；`DELETE /api/experts?id=` → 204，同一事务把 `chat_sessions.expert_id = id` 的行置 NULL。
  - 401 → 内置 id 的写 403 `forbidden`（码来自 `s1d-model-registry` #1641）→ `id` 缺失 / 空 / 多值 400 → 不可见 404 → body 400；no-store；两个带 body 的路由进 content-parser 归属集。id 走查询串与 `/api/models` 一致。
  - 审计 `expert.create` / `expert.update` / `expert.delete`，与写入同一事务，detail `{expertId, name}`（不含提示词）。
- **D6 技能端点**（`server/src/skills/rest.ts`，模块 `skills`）：`GET /api/skills` → 200 `{skills: [{name, description, enabledByDefault}]}`——平台技能（`listSkills(agentDir)`，与 `/api/commands` 同一读取规则与次序），`enabledByDefault` = 不在本账号 `account_skill_prefs.disabled_skills` 里；`PUT /api/skills/defaults` body `{disabledSkills: string[]}`（≤128 项、技能名规则同 D4、去重排序；不要求名称当前已安装——停用一个暂时缺席的技能是合法的）→ 200 同 GET 的 body；不审计（与账号最近选择同级）。
- **D7 会话能力**（`server/src/sessions/rest-capabilities.ts` + store）：
  - `POST /api/sessions` 键集加 `expertId`（字符串，须对本账号可见，否则 400）与 `disabledSkills`（同 D6 规则，否则 400）。初值：`disabled = body.disabledSkills ?? 账号缺省 ?? []`；给了 `expertId` 且 body 没给 `disabledSkills` 时，再从 `disabled` 里去掉该专家声明的技能（并集规则：专家需要的技能一定开着）。
  - `GET /api/sessions/:id/capabilities` → 200 `{expertId: string | null, disabledSkills: string[]}`（`expertId` 为有效值：引用的专家已不可见时报 null）；`PUT /api/sessions/:id/capabilities` body 为 `{expertId?: string | null, disabledSkills?: string[]}` 的非空子集 → 200 同 GET。`expertId` 改为某专家且同一 body 没给 `disabledSkills` → 停用列表去掉该专家的技能；清空专家不恢复任何停用。owner 预检 401 / 404 先于 body；已归档会话 409 `session_archived`；在途回合期间允许修改（不通知 supervisor，下一次派发对齐）。
  - fork 复制两列原值（session-metadata「fork 继承会话元数据」）。
  - 会话视图十四键**不变**：两项能力只经本端点读写（避免改动八处引用十四键的规格与严格解析）。
- **D8 派发对齐**：supervisor 在每次派发算有效能力 `{expertPrompt, disabledExtensions}`——`expertPrompt` = 有效专家的 `prompt`（无专家为 null），`disabledExtensions` = 停用技能各加前缀 `skill:`——交给 spawn（D1）；slot 记下其进程启动时的「能力指纹」（D1 两份文件内容的 SHA-256）；派发前第 1 步在档位、模型集合之外加「有效能力指纹与 slot 的不同」→ 退役 + 新准入（既有路径）。所以改专家、自建专家的提示词被属主改了、改停用列表，都在该会话下一条消息时重启生效；不同则复用。fork / branch 临时进程用源会话的有效能力。`supervisor.ts` 增量超出 800 行时把新准入的参数组装移进 `pool.ts`。
- **D9 输入框**：
  - 「+」菜单在 `上传文件` 之后、命令之前加 `选择专家…`（生成中与其它项同样禁用）；打开专家对话框（`dialog`）：搜索框、按分类分组的列表（名称、`内置` / `自建`、描述）、顶部 `不使用专家`；选中即关闭。
  - 能力行左组 `+` 之后渲染 `专家 · <名称>` 标签（有专家时），带清除按钮（accessible name `移除专家`）；权限档位之后渲染 `能力` 按钮（`popover`），列出本会话可用技能（平台 + 项目，`/api/commands` 的同一批），每项一个开关（拷入 `switch`），底部注明 `改动从下一条消息起生效`。
  - 欢迎态：选择存在 `welcome-options` 的状态里，首次发送的 `createBody()` 只在用户动过时带 `expertId` / `disabledSkills`。会话中：经新 `api-session-capabilities.ts` 的 `PUT` 修改，选中会话时 `GET` 一次；不碰 `use-chat-session.ts`。
  - 欢迎态选 `不使用专家` 时 `createBody()` 不带 `expertId` 键（`POST /api/sessions` 不接受 null，`PUT …/capabilities` 接受）。
  - 斜杠候选与「+」菜单的命令段在客户端过滤掉 `skill:<停用名>`（`/api/commands` 不知道会话，不改它）。
- **D10 中心**：`CENTER_TABS` 次序 `experts`（`专家`）、`skills`（`技能`）、`models`（`模型`，adminOnly）；routeManifest `/center` 描述改为 `专家与技能`（模型 tab 只对管理员可见，描述不对普通用户宣传它）。「专家」tab：分类 chip（`全部` + 四类）、搜索（名称 / 描述 / 标签子串，不区分大小写）、卡片（名称、`内置` / `自建`、描述、标签）、`开始会话`（`navigate("/", {state: {expertId}})`，欢迎态读一次并选中）、自建卡的 `编辑` / `删除`（确认）、`新建专家`（对话框：名称、分类 `select`、标签、描述、提示词 `textarea`、技能多选取自 `GET /api/skills`）。「技能」tab：平台技能列表 + `默认启用` 开关（改即 `PUT /api/skills/defaults` 整表），说明 `只影响新会话；已有会话在输入框的「能力」里改`；没有平台技能时空态 `尚未安装平台技能`。
- **D11 F-CHAT-1**：场景不决定专家（作废）；`IMPLEMENTATION_PLAN.md:90` 行注明，session-sidebar 的「（归 S1d）」改为不提供。
- **D12 文档**：`system.md` 加「专家与技能」一节（两个模块、会话配置文件、指纹判据）；omp-runtime 布局表加 `session-config/`；ADR 不新增（无难回退的决策：拒绝列表是可替换的写出细节）。

### 通用纪律

- 测试先行；每组第一个任务核对本节「Context」的行号与事实，出入先改 design 再继续。
- 专家提示词不进审计、不进日志；会话配置文件只在 `<state>/session-config/`，0640。
- 产品代码单文件 ≤800 行；`use-chat-session.ts` 不改；`process.ts` 超过 795 行时把 argv 组装抽到 `omp/argv.ts`。
- 不新增 `.css`；缺的组件按 ADR-0013 拷入（`switch`；`select` 若 `s1d-model-registry` 组 10 尚未合入则由先到的组拷入）。
- 规格 delta 只改列出的 requirement；以 `s1d-model-registry` 的 delta 为底的两条（chat-sessions「派发前按会话设置对齐进程」、chat-web「输入框与能力栏」）在其 MODIFIED 文本上再改。

## Risks / Trade-offs

- **[有专家时项目层 `APPEND_SYSTEM.md` 不再生效]** omp 只在没给 `--append-system-prompt` 时发现它 → 接受并在 system.md 写明；无专家的会话行为不变。
- **[改能力多一次重启]** 与换档位同代价；只在下一条消息、且能力真的变了（指纹）时发生。
- **[停用名与技能实名不一致]** `skill:<名称>` 精确匹配 omp 解析出的技能名；宿主列出的名称与 omp 的取名规则若不一致则停用无效 → 组 1 的官方 omp 用例以宿主列出的名称停用并在上游请求里核对。
- **[专家提示词文件缺失]** omp 会把路径当字面文本 → 文件在 spawn 前同步写成、子进程退出后才删，同一 key 不复用。
- **[系统提示词是否列出技能描述]** 两个官方用例以「发往上游的系统消息含 / 不含技能描述哨兵」为观察面；若 18.12.3 不把技能描述放进系统提示词 → 组 1 改用 omp 的 RPC 命令清单（`get_commands` 一类）观察，并同 PR 改 skill-switches 场景的观察面。
- **[第二个 `--config` 在 18.12.3 上的叠加]** 源码只有 18.0.10 → 组 1 官方用例钉住（grill 开放项 1）。
- **[普通用户的 `/center` 从空态变为有内容]** SH-01、CM-04 改写为 `待签`；`s1d-model-registry` 组 10 的「普通用户空态」用例由本 change 组 7 改。

## Migration Plan

1. 组 1（会话配置文件机制，所有 spawn 写空能力）先合：argv 多一个 `--config`，行为不变。
2. 组 2（迁移 047 与 store）在 `s1d-model-registry` 的迁移 046 之后合。
3. 组 3–5（专家端点、技能端点、会话能力）；组 6（派发对齐）把能力接进 spawn——此后专家与停用才真正生效。
4. 组 7–10（中心两个 tab、输入框专家与能力弹层）。回滚 = 回退代码；两列与两张表留着无害（`disabled_skills` 缺省 `[]`）。

## Not yet specified

- 专家的导入 / 导出与分享；专家版本历史。
- 「能力」弹层里连接器的开关（`s1d-connectors` 加）。
- 技能卡的分类 / 图标（demo 有，SKILL.md 没有对应字段）。

## Open Questions

无（会改变规格、方案或任务切分的问题已由 grill 与事实核查解决；D1 用拒绝列表而非 `includeSkills`、D7 用独立端点而非扩会话视图、D10 不设账号缺省专家是起草者按事实与 KISS 的细化，登记在 Epic 待 owner 知悉）。

## Sketch seams under test

- 组 1：`writeSessionConfig` 纯写出（文件内容、模式、key 唯一、`remove`）；`spawnOmp` argv（假 omp 记录 argv：两个 `--config` 的次序、有 / 无 `--append-system-prompt`）；子进程退出即删、启动清扫；官方 omp 用例（`WORKBUDDY_OMP_TEST=1`，经代理到假上游）：带停用 `skill:a` 与提示词哨兵启动 → 发往上游的请求里系统提示词含哨兵、技能清单含 b 不含 a（第二个 `--config` 叠加与 `--append-system-prompt` 文件读取两个前提同时钉住）。
- 组 2：迁移 047（约束、级联、两列缺省）；experts store 校验与可见性；`account_skill_prefs` 读写；会话两列读写——`:memory:` + 真实迁移。
- 组 3：`/api/experts` 整体挂载（401 / 403 / 400 / 404 次序、键集、上限、删除清空会话引用、审计 detail 无提示词、no-store、归属身份）。
- 组 4：`/api/skills` 与 `PUT /api/skills/defaults`（假技能目录）。
- 组 5：会话创建两键、并集规则、能力端点（owner、归档 409、非空子集、清空专家不恢复）、fork 继承。
- 组 6：supervisor 假 omp 真子进程（改专家 / 改提示词 / 改停用 → 下一条重启、argv 与文件内容；未改 → 复用）；官方 omp 用例（会话中换专家后下一条上游请求带新提示词）。
- 组 7：`center-experts*.test.tsx`（假 `ApiClient`）；`center-page` 用例改真表；e2e `/center` 分支改为 `专家` tab。
- 组 8：`center-skills.test.tsx`。
- 组 9：「+」菜单专家项、专家对话框、能力行标签、欢迎态 `createBody`、中心 `开始会话` 带入。
- 组 10：能力弹层开关与 `PUT`、斜杠候选与「+」菜单过滤停用技能。

## 行数预算（800 行硬上限；`scripts/size-guard.sh`）

| 文件 | 现状 | 预计 | 说明 |
|---|---|---|---|
| `server/src/sessions/omp/process.ts` | 787 | ≤795 | argv 追加 + 写出 / 退出删除；超过即抽 `omp/argv.ts` |
| `server/src/sessions/supervisor.ts` | 785（+#1648） | ≤800 | 有效能力交给新准入；超过即移进 `pool.ts` |
| `server/src/sessions/pool.ts` | 383 | ~410 | `sessionRuntimeOpts` 带能力、slot 指纹 |
| `server/src/sessions/composer-align.ts` | 61（+#1648） | ~75 | 指纹判据 |
| `server/src/experts/*.ts`、`server/src/skills/*.ts` | 新 | 各 ≤400 | builtin / store / rest 分文件 |
| `web/src/features/chat/capability-bar.tsx` | 319 | ~360 | 专家标签、`能力` 按钮；对话框与弹层在新文件 |
| `web/src/features/chat/conversation-view.tsx` | 351 | ~375 | props 链 |
| `web/src/features/center/{experts,skills}/*` | 新 | 各 ≤400 | |

## Traceability

- 需求：`IMPLEMENTATION_PLAN.md` S1d（F-CTR-EXP、F-CTR-SKL、F-CHAT-11c）、F-CHAT-1（作废）；PLAN §3.3「专家」「技能」。
- grill 凭证：本 design「owner 的裁定」（2026-10-21）。
- 相关 ADR：0010（专用 uid：0640 / 组 omp 的读权限前提）、0012（overlay 层次）、0013（前端栈）。
- 既有 change：`s1d-model-registry`（Epic #1640；本 change 依赖 #1641、#1643、#1645、#1648、#1651）。
