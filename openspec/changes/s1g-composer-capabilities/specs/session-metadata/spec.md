## MODIFIED Requirements

### Requirement: 会话创建与空间绑定
`POST /api/sessions` SHALL 接受可选 body `{workspaceId?, scene?, approvalMode?, modelId?, reasoningEffort?}`，并因此成为 content-parser 归属路由（http-service-skeleton「统一错误信封」，body limit 16 KiB，与工作空间路由先例一致）。无 body（无 Content-Type 且无内容）SHALL 为合法请求，与 body `{}` 等价：`scene` 为 NULL，并为该会话创建一个临时空间（见下）。携带 body 时 SHALL 为 `application/json` 且解析为对象，键集 SHALL 为 `{workspaceId, scene, approvalMode, modelId, reasoningEffort}` 的子集：数组/`null`/非对象、多余键、`workspaceId` 非字符串（含 `null`）、`scene` 不是 `office`/`code`/`design` 之一（含 `null`、大小写不同或空串）SHALL 400 `bad_request`；`approvalMode`、`modelId`、`reasoningEffort` 的取值规则见 session-composer-settings「创建会话时的设置与继承」，不合法同为 400 `bad_request`；content-parser 错误亦为 400 `bad_request`。形状校验通过后，给出的 `workspaceId` SHALL 经工作空间 store 的所有者作用域判定：不存在或属他人的 id（含非 32 位小写 hex 的字符串）、以及任何**临时**空间的 id（即使属于调用者本人，temporary-workspaces「临时空间的可见性」）SHALL 返回相同的 404 `not_found` 信封，彼此不可区分；以上 400/404 均不写会话行、不写空间行、不建目录、不写审计。

合法请求 SHALL 在一个 SQLite 事务内完成：
- 给出 `workspaceId`：插入会话行（`workspace_id` 为该值、`scene` 为请求值或 NULL、`pinned_at` 与 `archived_at` NULL、`approval_mode` / `model_id` / `reasoning_effort` 三列按 session-composer-settings「创建会话时的设置与继承」取请求值、该账号的最近选择或 NULL、其余列同既有创建规则），并写一条 `session.bind` 审计（见「会话元数据审计」），审计失败则会话行也不存在；不创建任何目录。
- 未给出 `workspaceId`：按 temporary-workspaces「临时空间的创建」在同一事务内插入一行临时空间、确保其目录，再插入 `workspace_id` 指向它的会话行（三项设置列的取值规则同上）；不写 `session.bind` 与 `workspace.create` 审计。任一步失败则事务回滚，不留会话行、空间行，本次新建的空目录按该条的补偿规则移除。

两种情况 SHALL 在同一事务内另按 session-composer-settings「创建会话时的设置与继承」更新该账号的最近选择（仅当请求带有三项设置中的任一项），并按 session-permission-tier「档位变更审计」决定是否写一条 `session.permission` 审计（触发条件只在该条规定，本条不复述）；其中任一写入或审计失败则事务回滚，不留会话行与空间行。

两种情况 SHALL 返回 201 会话视图（「会话视图扩展键」）`{id,title:null,status:"idle",createdAt,updatedAt,scene,workspaceId,pinnedAt:null,archivedAt:null,pendingApproval:false,temporaryWorkspace,approvalMode,modelId,reasoningEffort}`：前者 `temporaryWorkspace` 为 false，后者为 true 且 `workspaceId` 为新建临时空间的 id；`approvalMode` / `modelId` / `reasoningEffort` 为新行的有效值（session-composer-settings「有效值解析」）。创建 SHALL NOT spawn 进程或调用 supervisor（进程仍在首个 prompt 时懒获取）。自本条起，REST 不再能创建 `workspace_id` 为 NULL 的会话；已存在的这类会话保持不变（「绑定不可改与工作目录」）。

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

### Requirement: 会话元数据审计
会话元数据 SHALL 经 `core/audit` 既有 `emit` 写入两类新审计事件，均与其对应的业务写入处于同一 SQLite 事务（业务回滚则审计不存在，审计失败则业务不生效），`actorId` 为会话 `owner_id`：
- `session.bind`：仅在 `POST /api/sessions` 以 `workspaceId` 创建会话时写一条；`title="绑定工作空间"`、`workspaceId`=所绑空间 id、`detail={sessionId, scene}`（`scene` 为请求值或 null）。未绑定的创建与 fork 继承绑定不写该事件。
- `session.delete`：每次成功删除写一条；`title="删除会话"`、`workspaceId`=被删会话的 `workspace_id`（未绑定为 null）、`detail={sessionId, ompSessionFile, messageCount}`，`ompSessionFile` 为删除前的 `omp_session_file`（可为 null），`messageCount` 为被级联删除的消息行数。

会话的创建与 `PATCH /api/sessions/:id` 另可能写第三类事件 `session.permission`：它的触发条件与形状只由 session-permission-tier「档位变更审计」规定（本条不复述），同样与业务写入处于同一事务。除此之外 `PATCH /api/sessions/:id` 不写审计——修改 `title`、`scene`、`pinned`、`modelId`、`reasoningEffort` 都不写。`GET /api/audit` SHALL 以既有形状返回这两类事件，并沿用既有的按 actor 过滤与管理员可见规则。

#### Scenario: 绑定审计形状
- **WHEN** owner 以 `{workspaceId:W.id, scene:"office"}` 创建会话
- **THEN** `GET /api/audit?limit=1` 返回 `session.bind`（`title="绑定工作空间"`、`workspaceId=W.id`、`detail={sessionId,scene:"office"}`），`actorId` 为该 owner；第二个非管理员账号的 `GET /api/audit` 不含该条

#### Scenario: 审计形状
- **WHEN** owner 以 `{workspaceId:W.id, scene:"office"}` 创建会话、发一轮 prompt 至 `done`，再删除它
- **THEN** `GET /api/audit?limit=2` 依次返回 `session.delete`（`title="删除会话"`、`workspaceId=W.id`、`detail={sessionId,ompSessionFile:<路径>,messageCount:2}`）与 `session.bind`（`title="绑定工作空间"`、`workspaceId=W.id`、`detail={sessionId,scene:"office"}`），`actorId` 均为该 owner；第二个非管理员账号的 `GET /api/audit` 不含这两条

### Requirement: 会话元数据修改
`PATCH /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检：未认证 401、不存在或属他人 404 `not_found`（与未知 id 相同），均先于 body 解析；响应 `Cache-Control: no-store`。body SHALL 为 `application/json` 对象，且为 `{title, scene, pinned, archived, approvalMode, modelId, reasoningEffort}` 的**非空**子集：`{}`、多余键（含 `workspaceId`）、非对象 SHALL 400 `bad_request`；content-parser 错误 SHALL 400 `bad_request`（http-service-skeleton 归属集含 `PATCH /api/sessions/:id`，body limit 16 KiB）。字段规则：
- `title` SHALL 为字符串，经 `String.prototype.trim` 一次后长度为 1..80 个 Unicode 码点（按码点计，非 UTF-16 单元），存储 trim 后的文本；空、全空白、超 80 码点或非字符串 SHALL 400。标题只写 SQLite（omp 以 `--no-title` 运行，不发任何 RPC）。
- `scene` SHALL 为 `office`/`code`/`design` 之一；`null` 或其它值 SHALL 400（场景可改不可清空）。
- `pinned` SHALL 为布尔：`true` 在 `pinned_at` 为 NULL 时写当前 epoch 毫秒、已置顶时保持原值；`false` 置 `pinned_at` 为 NULL。
- `archived` SHALL 为布尔，读写 `archived_at`，规则见「会话归档」：`true` 在会话 `running` 或其控制占用被持有时使整个请求 409 `session_busy`（不写任何列），否则在 `archived_at` 为 NULL 时写当前 epoch 毫秒、已归档时保持原值；`false` 置 `archived_at` 为 NULL。
- `approvalMode`、`modelId`、`reasoningEffort` 的取值规则、写入的列、对账号最近选择的更新与响应里的有效值见 session-composer-settings「修改会话设置」；任一不合法同样整体 400。

任一字段不合法 SHALL 整体 400 且不写任何列。合法请求 SHALL 以单条所有者作用域的 UPDATE 只写所给字段对应的列，SHALL NOT 改动 `updated_at`、`status`、`workspace_id`、`omp_session_file`、`stream_epoch` 或任何消息/步骤行，不调用 supervisor、不向 omp 发任何帧；除有效审批档位实际变化时的 `session.permission`（触发条件见 session-permission-tier「档位变更审计」，与该 UPDATE 同一事务）外不写审计；会话处于任何状态（含 `running`）或其控制占用被持有时均可修改（`archived:true` 除外，见上）；UPDATE 命中 0 行（并发删除）SHALL 404。成功 SHALL 返回 200 更新后的会话视图（「会话视图扩展键」）。`title` 写入 SHALL 使该会话尚未结算的受理不再被视为"由该受理设置标题"，从而 `rollbackPrompt` 不撤销重命名（chat-sessions「会话持久化与回合刷盘」）。

#### Scenario: 重命名、改场景与置顶
- **WHEN** owner 对 `done` 会话依次 PATCH `{title:"  季度 汇报  "}`、`{scene:"design"}`、`{pinned:true}`、再 `{pinned:true}`、再 `{pinned:false}`
- **THEN** 各返回 200 会话视图：`title="季度 汇报"`；`scene="design"`；第一次置顶 `pinnedAt` 为请求时刻的 epoch 毫秒、第二次保持同值；取消后 `pinnedAt=null`；全程 `updatedAt`、`status` 与 `GET /api/sessions` 中的相对顺序不变，`GET /api/audit` 无新增行

#### Scenario: 多字段一次修改与运行中修改
- **WHEN** 会话 `running` 时 owner PATCH `{title:"新名",scene:"office",pinned:true}`
- **THEN** 200，三列一次写入，回合照常进行且其 `turn.end` 后标题仍为 `新名`

#### Scenario: 标题边界
- **WHEN** PATCH `title` 为恰 80 个码点（含辅助平面字符）、81 个码点、`""`、`"   "`、`123`
- **THEN** 80 码点 200 且原样存储；其余均 400 `bad_request`，标题不变

#### Scenario: 非法 body 与鉴权
- **WHEN** owner PATCH `{}`、`{pinned:"yes"}`、`{archived:"yes"}`、`{archived:null}`、`{scene:null}`、`{status:"done"}`、`{title:"a",extra:1}`、`[]`、malformed JSON 或 `text/plain` body
- **THEN** 均 400 `bad_request` 与 no-store，会话行不变
- **WHEN** 匿名请求、他人会话、不存在会话以合法或非法 body PATCH
- **THEN** 分别 401、404、404（后两者一致），均先于 body 解析，无写入

#### Scenario: 重命名不被 prompt 补偿撤销
- **WHEN** 无标题会话受理一个 prompt（标题取前 18 码点），派发挂起期间 owner PATCH `{title:"季度汇报"}`，随后 supervisor 以 `agent_unavailable` 拒绝使受理对被补偿
- **THEN** prompt 返回 502，受理对被移除、`status`/`updatedAt` 复原，而标题仍为 `季度汇报`

#### Scenario: 归档键与其它键一起修改
- **WHEN** owner 对 `done` 会话 PATCH `{title:"旧项目",pinned:false,archived:true}`
- **THEN** 200 会话视图，`title="旧项目"`、`pinnedAt=null`、`archivedAt` 为请求时刻的 epoch 毫秒；`updatedAt` 与 `status` 不变；审计无新增行

### Requirement: fork 继承会话元数据
`POST /api/sessions/:id/fork`（chat-sessions「会话 REST」fork 段）在其最终事务中插入的新会话行 SHALL 复制源会话的 `workspace_id` 与 `scene`，并原样复制 `approval_mode`、`model_id`、`reasoning_effort` 三列的原始值（含 NULL；新会话的有效值由 session-composer-settings「有效值解析」读出，与源会话当前的有效值相同），`pinned_at` 与 `archived_at` SHALL 为 NULL；其余列与该段规则一致。该事务拷贝的消息与步骤 SHALL 同时拷贝 `chat_messages.thinking` 与 `chat_steps.changes`（原值，含 NULL），使新会话的快照与源会话被拷贝部分的思考与文件变更一致。fork 响应中的 `session` 与其它会话视图键集相同（「会话视图扩展键」）。源会话用临时空间时，新会话继承同一个 `workspace_id`、与源会话共用该临时空间（temporary-workspaces「共用与随最后一个会话删除」），fork 不复制目录、不新建空间行；fork SHALL NOT 拷贝 `chat_turn_snapshots` 行。fork 临时进程以源会话的有效审批档位与有效模型启动（omp-runtime「子进程 spawn 契约」）；fork SHALL NOT 改动该账号的最近选择。fork 会话后续 generation 的 `--cwd` 由其继承的 `workspace_id` 按「绑定不可改与工作目录」计算，与源会话一致（均为源空间根或所有者根）。fork 不写 `session.bind` 审计，也不写 `session.permission` 审计。

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

### Requirement: 会话视图扩展键
会话视图（`GET /api/sessions` 的列表项、`POST /api/sessions` 与 `PATCH /api/sessions/:id` 的响应、消息快照的 `session`、fork 与 undo 响应的 `session`）SHALL 在既有八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}` 之外恰多三键，共十一键（s1g-composer-capabilities 在此之上另加 `approvalMode`、`modelId`、`reasoningEffort` 三键，取值为 session-composer-settings「有效值解析」的有效值，会话视图合计十四键，完整键集见 chat-sessions「会话 REST」）：本条规定的三键为
- `archivedAt`：`chat_sessions.archived_at`，非负整数（epoch 毫秒）或 null；
- `pendingApproval`：布尔，当且仅当该会话存在 `decision IS NULL` 的 `chat_approvals` 行（经 `chat_messages.session_id` 关联）时为 true；它是读取时推导的值，不落列；
- `temporaryWorkspace`：布尔，当且仅当 `workspace_id` 非 NULL 且所指 `workspaces` 行 `temporary = 1` 时为 true；`workspace_id` 为 NULL 时为 false。

同一会话在同一时刻经任何一个上述出口读到的视图 SHALL 逐键相等。`GET /api/sessions` SHALL 返回所有者的全部会话（含已归档的），排序不变（`updated_at` 降序、id 升序），不接受筛选参数；归档与否由客户端按 `archivedAt` 区分。`parent_session_id`、`omp_session_file`、`todo` 仍 SHALL NOT 出现在会话视图里。服务端与 web 对会话视图都是严格键集，三键 SHALL 与 web 的解析同一个改动落地（chat-web「API 客户端扩展」）。其它 change 给会话视图再加键时，以「当时的键集加这三键」为准；本条只规定这三键。

#### Scenario: 三键的取值
- **WHEN** 所有者有：绑定正式空间的会话 A；无 body 创建的会话 B；直接写库构造的 `workspace_id` 为 NULL 的存量会话 C；已归档的会话 D；回合中有一条待决审批的会话 E（fake omp `approval`）；读取 `GET /api/sessions`
- **THEN** 五个条目各恰十四键；`temporaryWorkspace` 仅 B 为 true（C 为 false）；`archivedAt` 仅 D 为非负整数、其余为 null；`pendingApproval` 仅 E 为 true；D 仍在列表里

#### Scenario: 待决确认随结算消失
- **WHEN** E 的审批被作答 `allow`；另一例 E 在审批待决时被停止；再一例服务在审批待决时重启并完成启动对账
- **THEN** 三种情况之后 `GET /api/sessions` 中 E 的 `pendingApproval` 均为 false

#### Scenario: 各出口一致
- **WHEN** 对同一会话依次取列表项、消息快照的 `session` 与一次 `PATCH {pinned:true}` 的响应
- **THEN** 三者键集相同（十四键），除 `pinnedAt` 因该 PATCH 而变化外逐值相等
