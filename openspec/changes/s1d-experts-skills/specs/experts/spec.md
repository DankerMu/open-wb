# experts Specification

## Purpose
专家是会话可选的一段角色设定：仓库内置若干位，账号还可自建只自己可见的专家。会话至多一个专家，其提示词在每次 spawn 时经 `--append-system-prompt` 注入 omp；专家可声明一组技能，加入会话时这些技能被打开。本能力覆盖专家数据、可见性、管理端点、注入规则、中心「专家」tab 与输入框的专家选择。

## ADDED Requirements

### Requirement: 迁移 047 专家与能力 schema
迁移 `047_experts_skills.sql` SHALL 在既有 runner 持有的事务内原子执行，回执紧随 `046_models.sql`：建表 `experts(id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('开发','办公','设计','产品')), tags TEXT NOT NULL, prompt TEXT NOT NULL, skills TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` 与索引 `experts_owner(owner_id, created_at)`；建表 `account_skill_prefs(account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, disabled_skills TEXT NOT NULL, updated_at INTEGER NOT NULL)`；给 `chat_sessions` 加列 `expert_id TEXT NULL` 与 `disabled_skills TEXT NOT NULL DEFAULT '[]'`。`tags`、`skills`、`disabled_skills` 为 JSON 字符串数组文本。`expert_id` 不设外键（内置专家不在表里）。迁移前已有的会话 SHALL 读出无专家、无停用技能，行为与迁移前相同。

#### Scenario: 建表与缺省
- **WHEN** 在已有一个会话与一个账号的库上运行迁移，随后删除该账号
- **THEN** 迁移后该会话 `expert_id` 为 NULL、`disabled_skills` 为 `[]`；`category` 不在四类的插入被 CHECK 拒绝；删除账号级联删除其 `experts` 与 `account_skill_prefs` 行

### Requirement: 内置专家
服务端 SHALL 内置恰四位专家，id 与 demo 对应：`builtin:frontend-architect`（`前端架构师`，开发）、`builtin:data-analyst`（`数据分析师`，办公）、`builtin:brand-designer`（`品牌视觉设计师`，设计）、`builtin:test-engineer`（`测试工程师`，开发）；描述与标签取 demo；每位的 `prompt` 是 300–1500 码点的中文系统提示词，写明角色、工作方式与输出要求；`skills` 为空。内置专家对所有账号可见，不可修改、不可删除，不存于 `experts` 表。

#### Scenario: 内置清单
- **WHEN** 任一账号 `GET /api/experts`
- **THEN** 列表前四项依次为上述四个 id，`builtin` 为 true，各自 `prompt` 码点数在 300..1500、`skills` 为 `[]`

### Requirement: 专家校验与可见性
自建专家的字段 SHALL 满足：`name` trim 后 1..32 码点；`description` 0..200 码点（缺省空串）；`category` 为 `开发` / `办公` / `设计` / `产品` 之一；`tags` 至多 5 项，每项 trim 后 1..12 码点，去重保序；`prompt` trim 后 1..8000 码点，存 trim 后文本；`skills` 至多 32 项，每项为技能名（1..128 UTF-8 字节、不含控制字符 U+0000–U+001F 与 U+007F、不含 `,`），去重后按字典序存储；每账号自建至多 50 个。违反任一条 SHALL 400 `bad_request`，message 不回显取值。对某账号可见的专家 = 全部内置专家 ∪ `owner_id` 为该账号的自建专家；对不可见专家的任何操作 SHALL 与不存在的 id 相同。自建专家 id 由服务端生成（32 位小写 hex）。

#### Scenario: 他人专家不可见
- **WHEN** 账号甲建专家 X；账号乙 `GET /api/experts`、`PUT /api/experts?id=X`、`DELETE /api/experts?id=X`，并以 `expertId: X` 创建会话
- **THEN** 乙的列表不含 X；`PUT` 与 `DELETE` 均 404 `not_found`；创建会话 400 `bad_request`；X 未被修改

#### Scenario: 字段边界
- **WHEN** 分别以 `name` 33 码点、`category` `运维`、6 个 `tags`、`prompt` 全空白、`prompt` 8001 码点、`skills` 含 `a,b`、以及第 51 个专家提交 `POST /api/experts`
- **THEN** 全部 400 `bad_request`，表不变
- **WHEN** 以 `prompt` 恰为 8000 个 CJK 码点（每个 3 个 UTF-8 字节，body 约 24 KiB，超过 16 KiB）提交 `POST /api/experts`，随后以同一 body `PUT` 该专家
- **THEN** 201 与 200，视图的 `prompt` 逐字等于所给文本（8000 码点）；body limit 64 KiB 不拒绝它

### Requirement: 专家管理端点
`experts` 模块 SHALL 注册（皆受 cookie guard，响应 `Cache-Control: no-store`）：
- `GET /api/experts` → 200 `{experts: ExpertView[]}`，`ExpertView = {id, name, description, category, tags, prompt, skills, builtin}`；内置在前（固定次序），其后本账号自建按 `created_at, id`。
- `POST /api/experts`，body 为 `{name, description?, category, tags?, prompt, skills?}`（键集严格，多余键 400）→ 201 视图。
- `PUT /api/experts?id=<id>`，body 同 POST（整体替换，省略的可选键取缺省）→ 200 视图。
- `DELETE /api/experts?id=<id>` → 204；同一事务里把 `chat_sessions.expert_id = <id>` 的行置 NULL。
检查次序：未认证 401 → `PUT` / `DELETE` 的 `id` 缺失、空或多值 400 → `id` 为内置专家的 `PUT` / `DELETE` 403 `forbidden` → `id` 对调用者不可见 404 → content-parser 与 body 400；401、`id` 的 400、403 与 404 都在 body 解析之前判定（preParsing，与 `/api/models` 同一做法），所以对内置专家与不可见专家的写入无论 body 是否合法都分别得到 403 与 404。`POST /api/experts` 与 `PUT /api/experts` SHALL 进 http-service-skeleton 的 content-parser 归属集，body limit 64 KiB（`prompt` 至多 8000 码点，CJK 文本约 24 KiB，16 KiB 不够）。每次写入 SHALL 在同一事务里记审计：`expert.create` / `expert.update` / `expert.delete`，`detail = {expertId, name}`，不含提示词。

#### Scenario: 自建、修改与删除
- **WHEN** 账号甲 `POST` 一个专家 X；`PUT` 改 X 的提示词；会话 S 以 X 为专家；`DELETE` X
- **THEN** 201、200、204；`GET /api/experts` 依次反映三次写入；删除后 S 的能力 `expertId` 为 null；审计依次三条，detail 不含提示词文本

#### Scenario: 内置专家只读
- **WHEN** 任一账号 `PUT /api/experts?id=builtin:data-analyst` 与 `DELETE` 同一 id（带合法 body 与不合法 body 各一次）
- **THEN** 全部 403 `forbidden`，响应带 no-store，无审计

### Requirement: 专家提示词注入
会话的有效专家 SHALL 是 `chat_sessions.expert_id` 所指、且对会话属主可见的专家；指向不存在或不可见的专家时视为没有专家。有有效专家的会话，其每一次 spawn SHALL 把该专家的 `prompt` 原文写入 omp-runtime「子进程 spawn 契约」规定的提示词文件并以 `--append-system-prompt` 传入；没有有效专家时 SHALL NOT 传该参数。专家或其提示词的变化 SHALL 在该会话下一次派发时经 chat-sessions「派发前按会话设置对齐进程」的重启生效，不打断在途回合。

#### Scenario: 提示词进入系统提示词
- **WHEN** 官方 omp（`WORKBUDDY_OMP_TEST=1`）经模型代理连假上游，会话专家的提示词含哨兵 `EXPERT-SENTINEL-1`，发一条 prompt 后经 RPC `get_state` 读 `systemPrompt`；随后把专家换成提示词含 `EXPERT-SENTINEL-2` 的另一位，再发一条并再读一次（假上游不记录消息正文，观察面是 omp 自报的系统提示词，先例 `server/test/omp-official-overlay-pins.test.ts` 的 `readState`）
- **THEN** 第一次 `systemPrompt` 含 `EXPERT-SENTINEL-1`；第二条回合前进程重启（`stream_epoch` 加一），第二次 `systemPrompt` 含 `EXPERT-SENTINEL-2` 且不含 `EXPERT-SENTINEL-1`

### Requirement: 中心「专家」tab
`/center?tab=experts`（`label` `专家`，对所有人可见，`CENTER_TABS` 第一项）SHALL 渲染：分类 chip `全部`、`开发`、`办公`、`设计`、`产品`（单选，缺省 `全部`）；搜索框（placeholder `搜索专家`，按名称、描述、标签子串匹配，不区分大小写）；专家卡片网格（名称、`内置` 或 `自建` 标记、描述、标签）；每张卡 `开始会话` 按钮——以 `navigate("/", {state: {expertId}})` 回到欢迎态，欢迎态读一次该 state 并选中该专家；自建卡另有 `编辑`、`删除`（拷入层 alert-dialog 确认，按钮 `取消` / `删除`）；页顶 `新建专家` 打开对话框表单（名称、分类 select、标签、描述、提示词 textarea、技能多选取自 `GET /api/skills`），提交前按「专家校验与可见性」在客户端逐字段校验并显示原因，提交恰一次 `createExpert` / `updateExpert`，在途禁用，失败在框内 `role="alert"` 显示 `ApiError.message`；对话框接 `useEscapeFallback`。每次写入成功后重取列表。没有匹配项时显示 `没有匹配的专家`。API 客户端 `web/src/lib/api-experts.ts` 提供 `listExperts` / `createExpert` / `updateExpert` / `deleteExpert`，`id` 经 `encodeURIComponent`，严格解析 `ExpertView`。

#### Scenario: 浏览、筛选与开始会话
- **WHEN** 普通用户打开 `/center`；点 `设计` chip；搜索 `海报`；点 `品牌视觉设计师` 的 `开始会话`
- **THEN** URL 变为 `/center?tab=experts` 且 tab 条为 `专家`、`技能`（无 `模型`）；`设计` 下只剩设计类卡片；搜索后只剩标签含 `海报` 的卡；点击后到 `/` 欢迎态，能力行显示 `专家 · 品牌视觉设计师`，没有发出任何会话请求

#### Scenario: 自建专家的增改删
- **WHEN** 用户 `新建专家` 填名称、分类、提示词提交；对该卡 `编辑` 改名；`删除` 并确认
- **THEN** 依次恰一次 `createExpert`、`updateExpert`、`deleteExpert`，每次成功后恰一次 `listExperts`；内置卡没有 `编辑` / `删除`

### Requirement: 输入框的专家选择
会话页输入框「+」菜单 SHALL 在 `上传文件` 之后、命令段之前有一项 `选择专家…`（回答生成中与其它项同样禁用），点击打开专家对话框：搜索框、`不使用专家` 一项、按分类分组的可见专家（名称、`内置` / `自建`、描述）；选中即关闭。有专家时能力行左组「+」之后 SHALL 渲染标签 `专家 · <名称>` 与清除按钮（accessible name `移除专家`）。`<名称>` 取自会话页的专家清单：会话页每个 `ApiClient` 恰取一次 `listExperts`（与输入框选项同样缓存在 client 上；失败后在下一次进入欢迎态或选中会话时重取），专家对话框每次打开时另重取一次并以结果更新该缓存；专家 id 尚不在已取得的清单里（清单读取中、读取失败或该专家已不可见）时标签只显示 `专家`，清除按钮照常。欢迎态的选择 SHALL 只存在页面状态里（与输入框的附件、档位等待发选择分开存放，不进入会使输入框选项缓存失效的那份选择），首次发送的 `POST /api/sessions` 在用户选过专家时带 `expertId`；会话中的选择 SHALL 恰调用一次 `PUT /api/sessions/:id/capabilities`（body `{expertId}`），成功后以响应更新标签，失败以 `role="alert"` 显示 `ApiError.message` 并保持原标签。

#### Scenario: 欢迎态与会话中换专家
- **WHEN** 欢迎态从「+」菜单选 `测试工程师` 并发送；会话中再选 `不使用专家`
- **THEN** `POST /api/sessions` 的 body 含 `expertId:"builtin:test-engineer"`；会话中恰一次 `PUT …/capabilities` body `{expertId:null}`，之后能力行没有专家标签
- **WHEN** 选中一个能力为 `{expertId:"builtin:test-engineer"}` 的会话，而本 client 的 `listExperts` 失败；随后回到欢迎态（`listExperts` 重取成功）再选中该会话；再切换到另一个会话
- **THEN** 失败期间标签为 `专家`（带 `移除专家`），没有错误提示；重取成功后标签为 `专家 · 测试工程师`；全程恰两次 `listExperts`，此后切换会话不再发出
