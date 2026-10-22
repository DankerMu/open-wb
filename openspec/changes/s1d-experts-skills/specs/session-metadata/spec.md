# session-metadata Spec Delta

> s1d-experts-skills：「会话创建与空间绑定」的 body 键集加 `expertId`、`disabledSkills`（校验 400、`disabled_skills` 初值取 body ?? 账号缺省 ?? `[]`、给专家不给停用时按并集规则去掉专家声明的技能），会话视图键集不变，加一个场景；「fork 继承会话元数据」另复制 `expert_id`、`disabled_skills` 原值、临时进程带源会话的有效能力，加一个场景（design D7）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 会话创建与空间绑定
`POST /api/sessions` SHALL 接受可选 body `{workspaceId?, scene?, approvalMode?, modelId?, reasoningEffort?, expertId?, disabledSkills?}`，并因此成为 content-parser 归属路由（http-service-skeleton「统一错误信封」，body limit 16 KiB，与工作空间路由先例一致）。无 body（无 Content-Type 且无内容）SHALL 为合法请求，与 body `{}` 等价：`scene` 为 NULL，并为该会话创建一个临时空间（见下）。携带 body 时 SHALL 为 `application/json` 且解析为对象，键集 SHALL 为 `{workspaceId, scene, approvalMode, modelId, reasoningEffort, expertId, disabledSkills}` 的子集：数组/`null`/非对象、多余键、`workspaceId` 非字符串（含 `null`）、`scene` 不是 `office`/`code`/`design` 之一（含 `null`、大小写不同或空串）SHALL 400 `bad_request`；`approvalMode`、`modelId`、`reasoningEffort` 的取值规则见 session-composer-settings「创建会话时的设置与继承」，不合法同为 400 `bad_request`；`expertId` 不是字符串（含 `null`）或不是对调用者可见的专家的 id（experts「专家校验与可见性」：不存在与属他人的专家同样处理）、`disabledSkills` 不符合 skill-switches「技能清单与账号缺省」的列表规则（非字符串数组、超过 128 项、任一名称违反 experts「专家校验与可见性」的技能名规则）SHALL 400 `bad_request`，且先于下面的 `workspaceId` 判定；content-parser 错误亦为 400 `bad_request`。形状校验通过后，给出的 `workspaceId` SHALL 经工作空间 store 的所有者作用域判定：不存在或属他人的 id（含非 32 位小写 hex 的字符串）、以及任何**临时**空间的 id（即使属于调用者本人，temporary-workspaces「临时空间的可见性」）SHALL 返回相同的 404 `not_found` 信封，彼此不可区分；以上 400/404 均不写会话行、不写空间行、不建目录、不写审计。

合法请求 SHALL 在一个 SQLite 事务内完成：
- 给出 `workspaceId`：插入会话行（`workspace_id` 为该值、`scene` 为请求值或 NULL、`pinned_at` 与 `archived_at` NULL、`approval_mode` / `model_id` / `reasoning_effort` 三列按 session-composer-settings「创建会话时的设置与继承」取请求值、该账号的最近选择或 NULL、`expert_id` 与 `disabled_skills` 两列按下文「专家与停用技能的初值」、其余列同既有创建规则），并写一条 `session.bind` 审计（见「会话元数据审计」），审计失败则会话行也不存在；不创建任何目录。
- 未给出 `workspaceId`：按 temporary-workspaces「临时空间的创建」在同一事务内插入一行临时空间、确保其目录，再插入 `workspace_id` 指向它的会话行（三项设置列与 `expert_id`、`disabled_skills` 的取值规则同上）；不写 `session.bind` 与 `workspace.create` 审计。任一步失败则事务回滚，不留会话行、空间行，本次新建的空目录按该条的补偿规则移除。

**专家与停用技能的初值**（change s1d-experts-skills）：`expert_id` 为请求的 `expertId` 或 NULL；`disabled_skills` 为请求的 `disabledSkills`，请求不带它时为该账号 `account_skill_prefs.disabled_skills`（在同一事务内读取），该账号没有这一行时为 `[]`；给了 `expertId` 而没给 `disabledSkills` 时，再从上述集合中去掉该专家声明的技能（skill-switches「会话能力端点」的并集规则）；存储前去重并按字典序排列。`expertId` 与 `disabledSkills` SHALL NOT 更新该账号的最近选择或 `account_skill_prefs`，也不写审计。

两种情况 SHALL 在同一事务内另按 session-composer-settings「创建会话时的设置与继承」更新该账号的最近选择（仅当请求带有三项设置中的任一项），并按 session-permission-tier「档位变更审计」决定是否写一条 `session.permission` 审计（触发条件只在该条规定，本条不复述）；其中任一写入或审计失败则事务回滚，不留会话行与空间行。

两种情况 SHALL 返回 201 会话视图（「会话视图扩展键」）`{id,title:null,status:"idle",createdAt,updatedAt,scene,workspaceId,pinnedAt:null,archivedAt:null,pendingApproval:false,temporaryWorkspace,approvalMode,modelId,reasoningEffort}`：前者 `temporaryWorkspace` 为 false，后者为 true 且 `workspaceId` 为新建临时空间的 id；`approvalMode` / `modelId` / `reasoningEffort` 为新行的有效值（session-composer-settings「有效值解析」）。视图键集不因 `expertId` / `disabledSkills` 改变：两者只经 skill-switches「会话能力端点」读写。创建 SHALL NOT spawn 进程或调用 supervisor（进程仍在首个 prompt 时懒获取）。自本条起，REST 不再能创建 `workspace_id` 为 NULL 的会话；已存在的这类会话保持不变（「绑定不可改与工作目录」）。

#### Scenario: 无 body 与空对象按默认创建
- **WHEN** 已认证 owner（该账号从未做过输入框设置的选择）以无 body 的请求、以及以 JSON body `{}` 各调用一次 `POST /api/sessions`
- **THEN** 两次均 201，视图恰为十四键且 `scene`、`pinnedAt`、`archivedAt` 为 null、`status="idle"`、`title=null`、`pendingApproval=false`、`temporaryWorkspace=true`、三项设置为缺省的有效值（session-composer-settings「有效值解析」）；两次的 `workspaceId` 是两个不同的 32 位十六进制 id，各自对应一行 `temporary=1` 的空间与一个已存在的目录；审计无新增行；未产生 omp 子进程

#### Scenario: 绑定自有工作空间并选择场景
- **WHEN** owner 先 `POST /api/workspaces` 建空间 W，再以 `{workspaceId:W.id, scene:"code"}` 创建会话
- **THEN** 201 视图 `workspaceId=W.id`、`scene="code"`、`temporaryWorkspace=false`；`chat_sessions.workspace_id` 与 `scene` 同值；`workspaces` 没有新增行；`GET /api/audit` 恰新增一条 `session.bind`；`GET /api/sessions` 列出该会话且各键一致；未产生 omp 子进程

#### Scenario: 只选场景不选空间
- **WHEN** owner 以 `{scene:"design"}` 创建会话
- **THEN** 201 视图 `scene="design"`、`temporaryWorkspace=true`、`workspaceId` 为新建临时空间的 id；审计无新增行

#### Scenario: 他人与不存在的空间一致 404
- **WHEN** 第二个账号以第一个账号的 W.id 创建会话；第一个账号以随机 32 位 hex、以 `abc`、以自己某个会话的临时空间 id 作为 `workspaceId` 创建会话
- **THEN** 四次均 404，信封与 no-store 逐字相同；无会话行、无空间行、无审计行新增

#### Scenario: 非法 body 形状
- **WHEN** owner 以 `{scene:"chat"}`、`{scene:null}`、`{scene:"Office"}`、`{workspaceId:null}`、`{workspaceId:1}`、`{title:"x"}`、`[]`、`null`、malformed JSON 或 `text/plain` body 调用 `POST /api/sessions`
- **THEN** 均为 400 `bad_request` 与 no-store，无会话行、无空间行、无目录、无审计行新增

#### Scenario: 临时空间创建失败不留会话
- **WHEN** 测试令临时空间的目录确保步骤失败，owner 以无 body 调用 `POST /api/sessions`
- **THEN** 响应为通用 5xx；`chat_sessions` 与 `workspaces` 都没有新行；随后的同一请求（故障移除后）201

#### Scenario: 创建时的专家与停用技能
- **WHEN** 账号的 `account_skill_prefs` 停用 `["deploy","lint"]`，自建专家 E 声明技能 `["deploy"]`；owner 依次以 `{}`、`{expertId:E}`、`{expertId:E, disabledSkills:["deploy"]}`、`{disabledSkills:[]}` 创建会话；再以 `{expertId:null}`、`{expertId:"builtin:nope"}`、`{expertId:<另一账号的专家 id>}`、`{disabledSkills:["a,b"]}`、`{disabledSkills:"deploy"}` 各调用一次
- **THEN** 前四次 201，视图恰为十四键（不含 `expertId` 与 `disabledSkills`），随后 `GET …/capabilities` 依次为 `{expertId:null, disabledSkills:["deploy","lint"]}`、`{expertId:E, disabledSkills:["lint"]}`、`{expertId:E, disabledSkills:["deploy"]}`、`{expertId:null, disabledSkills:[]}`；`account_skill_prefs` 行与最近选择行不变，审计无新增；后五次均 400 `bad_request` 与 no-store，无会话行、无空间行、无目录、无审计行新增

### Requirement: fork 继承会话元数据
`POST /api/sessions/:id/fork`（chat-sessions「会话 REST」fork 段）在其最终事务中插入的新会话行 SHALL 复制源会话的 `workspace_id` 与 `scene`，并复制 `approval_mode`、`model_id`、`reasoning_effort` 三列与 `expert_id`、`disabled_skills` 两列的原始值（含 NULL）——`expert_id` 指向的专家已不可见时同样原样复制（读出时视为没有专家，experts「专家提示词注入」）；`approval_mode` 高于当前 `APPROVAL_MAX_MODE` 时写入上界本身（session-permission-tier「管理员最高档」，owner 2026-10-12，#1282），其余原样；新会话的有效值由 session-composer-settings「有效值解析」读出，与源会话当前的有效值相同，`pinned_at` 与 `archived_at` SHALL 为 NULL；其余列与该段规则一致。该事务拷贝的消息与步骤 SHALL 同时拷贝 `chat_messages.thinking` 与 `chat_steps.changes`（原值，含 NULL），使新会话的快照与源会话被拷贝部分的思考与文件变更一致。fork 响应中的 `session` 与其它会话视图键集相同（「会话视图扩展键」）。源会话用临时空间时，新会话继承同一个 `workspace_id`、与源会话共用该临时空间（temporary-workspaces「共用与随最后一个会话删除」），fork 不复制目录、不新建空间行；fork SHALL NOT 拷贝 `chat_turn_snapshots` 行。fork 临时进程以源会话的有效审批档位、有效模型与有效能力启动（omp-runtime「子进程 spawn 契约」）；fork SHALL NOT 改动该账号的最近选择。fork 会话后续 generation 的 `--cwd` 由其继承的 `workspace_id` 按「绑定不可改与工作目录」计算，与源会话一致（均为源空间根或所有者根）。fork 不写 `session.bind` 审计，也不写 `session.permission` 审计。

#### Scenario: 继承空间与场景、不继承置顶
- **WHEN** owner 对绑定 W、`scene="code"`、已置顶的源会话调用 fork（fake-omp `branch`），随后在新会话发 prompt
- **THEN** 201 的 `session` 为会话视图，`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；源会话 `pinnedAt` 不变；被拷贝助手消息的 `thinking` 与其步骤的 `changes` 在新会话快照中与源会话逐值相同（NULL 仍为 null）；新会话进程 probe 报告的 `cwd` 为 W 的根；审计无 `session.bind` 新增

#### Scenario: fork 响应的会话视图与列表一致
- **WHEN** owner 对绑定 W、`scene="design"`、已置顶的源会话调用 fork 成功，随后 `GET /api/sessions`
- **THEN** 201 响应的 `session` 恰为十四键，`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`、`archivedAt=null`、`pendingApproval=false`、`temporaryWorkspace=false`、三项设置的有效值与源会话相同，且与 `GET /api/sessions` 中同 id 条目逐键相等

#### Scenario: 继承临时空间
- **WHEN** owner 对一个用临时空间 T 的源会话调用 fork
- **THEN** 新会话 `workspaceId=<T>`、`temporaryWorkspace=true`、`archivedAt=null`；`workspaces` 行数不变；账号根下的 `tmp-…` 目录数不变

#### Scenario: 继承三项设置
- **WHEN** owner 把源会话设为 `{approvalMode:"yolo", modelId:"m3", reasoningEffort:"low"}` 后调用 fork（fake-omp `branch`，测试记下临时进程的 argv），随后在新会话发 prompt；另一例源会话三列均为 NULL
- **THEN** 临时进程的 argv 含 `--approval-mode yolo` 与 `--model workbuddy/m3`；201 的 `session` 三键为 `yolo`、`m3`、`low`，新会话行三列与源会话逐值相同；新会话进程的 argv 含 `--approval-mode yolo`，其第一条 prompt 之前收到 `set_model` 与 `set_thinking_level`；审计没有新增 `session.permission`；该账号的最近选择行与 fork 前相同。另一例新会话三列为 NULL、视图为有效缺省值

#### Scenario: 封顶时 fork 不带走超界档位
- **WHEN** `APPROVAL_MAX_MODE=write`，源会话的 `approval_mode` 列为 `yolo`（上界调低之前写入）、另两列为 `m3`、`low`，owner 对其调用 fork（测试记下临时进程的 argv）
- **THEN** 临时进程的 argv 含 `--approval-mode write`；新会话行三列为 `write`、`m3`、`low`，源会话行仍为 `yolo`、`m3`、`low`；201 的 `session.approvalMode` 为 `write`；审计没有新增 `session.permission`；该账号的最近选择行与 fork 前相同

#### Scenario: 继承专家与停用技能
- **WHEN** 源会话 `expert_id` 为 owner 自建专家 E、`disabled_skills` 为 `["deploy"]`，owner 调用 fork（fake-omp `branch`，测试记下临时进程的 argv 与会话配置文件）；另一例源会话的 `expert_id` 为不存在的 id `builtin:nope`（模拟已下架的内置专家，测试直接写库构造）、`disabled_skills` 为 `[]`
- **THEN** 新会话行两列与源会话逐值相同；`GET /api/sessions/<新 id>/capabilities` 为 `{expertId:E, disabledSkills:["deploy"]}`；临时进程的 argv 含 `--append-system-prompt`，其文件内容为 E 的提示词，`disabledExtensions` 为 `["skill:deploy"]`；`account_skill_prefs` 行不变。另一例新会话行 `expert_id` 为 `builtin:nope`，能力读出 `{expertId:null, disabledSkills:[]}`，临时进程的 argv 不含 `--append-system-prompt`
