## ADDED Requirements

### Requirement: 会话视图扩展键
会话视图（`GET /api/sessions` 的列表项、`POST /api/sessions` 与 `PATCH /api/sessions/:id` 的响应、消息快照的 `session`、fork 与 undo 响应的 `session`）SHALL 在既有八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}` 之外恰多三键，共十一键：
- `archivedAt`：`chat_sessions.archived_at`，非负整数（epoch 毫秒）或 null；
- `pendingApproval`：布尔，当且仅当该会话存在 `decision IS NULL` 的 `chat_approvals` 行（经 `chat_messages.session_id` 关联）时为 true；它是读取时推导的值，不落列；
- `temporaryWorkspace`：布尔，当且仅当 `workspace_id` 非 NULL 且所指 `workspaces` 行 `temporary = 1` 时为 true；`workspace_id` 为 NULL 时为 false。

同一会话在同一时刻经任何一个上述出口读到的视图 SHALL 逐键相等。`GET /api/sessions` SHALL 返回所有者的全部会话（含已归档的），排序不变（`updated_at` 降序、id 升序），不接受筛选参数；归档与否由客户端按 `archivedAt` 区分。`parent_session_id`、`omp_session_file`、`todo` 仍 SHALL NOT 出现在会话视图里。服务端与 web 对会话视图都是严格键集，三键 SHALL 与 web 的解析同一个改动落地（chat-web「API 客户端扩展」）。其它 change 给会话视图再加键时，以「当时的键集加这三键」为准；本条只规定这三键。

#### Scenario: 三键的取值
- **WHEN** 所有者有：绑定正式空间的会话 A；无 body 创建的会话 B；直接写库构造的 `workspace_id` 为 NULL 的存量会话 C；已归档的会话 D；回合中有一条待决审批的会话 E（fake omp `approval`）；读取 `GET /api/sessions`
- **THEN** 五个条目各恰十一键；`temporaryWorkspace` 仅 B 为 true（C 为 false）；`archivedAt` 仅 D 为非负整数、其余为 null；`pendingApproval` 仅 E 为 true；D 仍在列表里

#### Scenario: 待决确认随结算消失
- **WHEN** E 的审批被作答 `allow`；另一例 E 在审批待决时被停止；再一例服务在审批待决时重启并完成启动对账
- **THEN** 三种情况之后 `GET /api/sessions` 中 E 的 `pendingApproval` 均为 false

#### Scenario: 各出口一致
- **WHEN** 对同一会话依次取列表项、消息快照的 `session` 与一次 `PATCH {pinned:true}` 的响应
- **THEN** 三者键集相同（十一键），除 `pinnedAt` 因该 PATCH 而变化外逐值相等

### Requirement: 会话归档
归档 SHALL 经 `PATCH /api/sessions/:id` 的 `archived` 键读写（「会话元数据修改」），状态存于 `chat_sessions.archived_at`（迁移 037）。`archived:true`：会话 `status="running"` 或其控制占用被持有时 SHALL 409 `session_busy` 且整个 PATCH 不写任何列（同一请求里的其它键也不生效）；否则在 `archived_at` 为 NULL 时写入当前 epoch 毫秒、已归档时保持原值。`archived:false` 把 `archived_at` 置 NULL，对任何状态的会话都可执行。归档与恢复 SHALL NOT 改动 `updated_at`、`status`、`pinned_at`、`workspace_id`、任何消息/步骤/审批/快照行、会话文件、工作空间目录（含临时空间）与快照目录，SHALL NOT 退役或启动任何进程，不写审计。判定 `running` 与写入 SHALL 在同一条带条件的 UPDATE 或同一个同步段内完成，使「归档」与「受理 prompt」不能同时成功。

已归档的会话 SHALL 只读：对它的 `POST …/prompt`、`POST …/regenerate`、`POST …/fork`、`POST …/undo` SHALL 一律 409 `session_archived`，判定在 owner 预检与 body 校验之后、其余前置校验（含 `session_busy`）之前，不写任何行、不做快照、不向进程发帧、不 spawn。`GET …/messages`、单会话事件流订阅、`PATCH`（含 `title`、`scene`、`pinned` 与 `archived:false`）、`DELETE` 与 `POST …/stop`（非运行中 → 204）不受归档影响。删除已归档的会话按「会话删除」照常进行（含其临时空间与快照的清理）。恢复之后会话与归档前同等可用。

#### Scenario: 归档与恢复
- **WHEN** 所有者对 `done` 会话 PATCH `{archived:true}`，再 PATCH `{archived:true}`，再 PATCH `{archived:false}`
- **THEN** 三次均 200 会话视图：第一次 `archivedAt` 为请求时刻的 epoch 毫秒，第二次保持同值，第三次为 null；全程 `updatedAt`、`status`、`pinnedAt`、`workspaceId` 不变，消息快照与归档前逐值相同，`GET /api/audit` 无新增行，没有进程被退役

#### Scenario: 运行中与占用期间不能归档
- **WHEN** 回合进行中 PATCH `{archived:true}`；另一例 regenerate 正持有占用时 PATCH `{title:"新名",archived:true}`
- **THEN** 两者均 409 `session_busy`；`archived_at` 仍为 NULL；后一例标题未被修改
- **WHEN** 对同一个运行中的会话 PATCH `{archived:false}` 或 `{pinned:true}`
- **THEN** 200

#### Scenario: 归档后只读
- **WHEN** 对已归档会话分别调用 prompt（合法 body）、regenerate、fork（合法 body）、undo（合法 body）
- **THEN** 四者均 409 `session_archived`（message `会话已归档，恢复后才能继续对话`）；无行变化、无帧、无 spawn、无快照目录
- **WHEN** 对它读取消息快照、订阅事件流、PATCH `{title:"改名"}`、调用 stop
- **THEN** 分别为 200、建立连接、200、204

#### Scenario: 归档与受理不并发成功
- **WHEN** 对同一个 `done` 会话同时发出一条合法 prompt 与 PATCH `{archived:true}`
- **THEN** 结果只能是二者之一：prompt 202 而 PATCH 409 `session_busy`，或 PATCH 200 而 prompt 409 `session_archived`；不会出现「已归档且 running」的会话

#### Scenario: 归档保留临时空间与快照
- **WHEN** 归档一个用临时空间、已有两份回合快照的会话
- **THEN** 临时空间的行、目录与文件、两份快照目录都不变；恢复后对其第二条用户消息的撤回照常可用

#### Scenario: 鉴权
- **WHEN** 匿名请求、他人会话、不存在会话 PATCH `{archived:true}`
- **THEN** 分别 401、404、404（后两者一致），无写入

## MODIFIED Requirements

### Requirement: 绑定不可改与工作目录
会话的 `workspace_id` 只在创建时（或 fork 继承时）写入，此后 SHALL NOT 被任何 REST 修改：`PATCH /api/sessions/:id` 携带 `workspaceId` 键 SHALL 作为多余键 400 `bad_request`。会话的 omp 工作目录 SHALL 为：绑定时该空间根（经工作空间 store 以会话 `owner_id` 为 principal 的 `rootOf` 取得，落在 `<SANDBOX_ROOT>/<ownerId>/` 之下），`workspace_id` 为 NULL 的存量会话（「会话创建与空间绑定」之后 REST 不再创建这样的会话）沿用所有者根 `<SANDBOX_ROOT>/<ownerId>`，宿主 SHALL NOT 为它补建临时空间、SHALL NOT 迁移它的数据或改写它的 `workspace_id`；绑定临时空间的会话与绑定正式空间的会话同样经 `rootOf` 取根（`<SANDBOX_ROOT>/<ownerId>/tmp-<空间 id>`），临时空间转正不改变该根；该会话每一次 generation spawn（首次、闲置回收后、崩溃恢复、regenerate 重新获取）与以其为源的 fork 临时进程 SHALL 以此为 `--cwd`（chat-sessions「Supervisor dispatch and generation binding」）。绑定会话的 `rootOf` 返回 null 时 SHALL 以通用失败结束该次获取，不回退所有者根。`rootOf` 返回的空间根在获取时不是已存在的目录（被外部删除或改名），或 `rootOf` 因该根存在但不是普通目录（被同名文件占据、含 symlink）而拒绝解析时，宿主 SHALL NOT 创建该目录（不对空间根做 mkdir）、SHALL NOT spawn、SHALL NOT 回退所有者根，该次获取按 `agent_unavailable` 失败（prompt → 502 并走既有受理对补偿；regenerate 按其既有 502 规则）。omp `--resume` 以会话文件头记录的 cwd 为准，故同一会话各 generation 的 cwd SHALL 一致。空间目录丢失后的修复不在本契约内。

#### Scenario: 绑定会话的进程工作目录
- **WHEN** owner 在绑定 W 的会话、一个 `workspace_id` 为 NULL 的存量会话（直接写库构造）与一个无 body 创建的会话上各发 prompt，fake-omp probe 报告 `cwd=`
- **THEN** 三者的 `cwd` 依次为 W 的根、`<SANDBOX_ROOT>/<ownerId>`、该会话临时空间的根 `<SANDBOX_ROOT>/<ownerId>/tmp-<空间 id>`；闲置回收后再发 prompt，新 generation 报告的 `cwd` 与前一次相同；存量会话的 `workspace_id` 仍为 NULL，`workspaces` 没有为它新增行

#### Scenario: 空间目录缺失不回退不创建
- **WHEN** 绑定 W 的会话在下一次 prompt 之前，W 的根目录被应用之外的操作删除
- **THEN** prompt 返回 502 `agent_unavailable`，受理对被补偿、会话状态复原；无子进程 spawn；W 的根目录仍不存在；未以所有者根 spawn

#### Scenario: PATCH 不能改绑定
- **WHEN** owner 对绑定 W 的会话 PATCH `{workspaceId:"<另一空间 id>"}` 或 `{title:"x",workspaceId:null}`
- **THEN** 400 `bad_request`，会话行各列不变，后续 prompt 的 `cwd` 仍为 W 的根

#### Scenario: 存量未绑定会话照常可用
- **WHEN** 一个迁移前就存在、`workspace_id` 为 NULL、已有两轮消息的会话（直接写库构造）在升级后读取列表与快照并再发一条 prompt
- **THEN** 列表项 `workspaceId` 为 null、`temporaryWorkspace` 为 false；prompt 返回 202 且 `undo` 为 `unbound`；其进程 `cwd` 为 `<SANDBOX_ROOT>/<ownerId>`；账号根下没有为它新建 `tmp-…` 目录

### Requirement: 会话创建与空间绑定
`POST /api/sessions` SHALL 接受可选 body `{workspaceId?, scene?}`，并因此成为 content-parser 归属路由（http-service-skeleton「统一错误信封」，body limit 16 KiB，与工作空间路由先例一致）。无 body（无 Content-Type 且无内容）SHALL 为合法请求，与 body `{}` 等价：`scene` 为 NULL，并为该会话创建一个临时空间（见下）。携带 body 时 SHALL 为 `application/json` 且解析为对象，键集 SHALL 为 `{workspaceId, scene}` 的子集：数组/`null`/非对象、多余键、`workspaceId` 非字符串（含 `null`）、`scene` 不是 `office`/`code`/`design` 之一（含 `null`、大小写不同或空串）SHALL 400 `bad_request`；content-parser 错误亦为 400 `bad_request`。形状校验通过后，给出的 `workspaceId` SHALL 经工作空间 store 的所有者作用域判定：不存在或属他人的 id（含非 32 位小写 hex 的字符串）、以及任何**临时**空间的 id（即使属于调用者本人，temporary-workspaces「临时空间的可见性」）SHALL 返回相同的 404 `not_found` 信封，彼此不可区分；以上 400/404 均不写会话行、不写空间行、不建目录、不写审计。

合法请求 SHALL 在一个 SQLite 事务内完成：
- 给出 `workspaceId`：插入会话行（`workspace_id` 为该值、`scene` 为请求值或 NULL、`pinned_at` 与 `archived_at` NULL、其余列同既有创建规则），并写一条 `session.bind` 审计（见「会话元数据审计」），审计失败则会话行也不存在；不创建任何目录。
- 未给出 `workspaceId`：按 temporary-workspaces「临时空间的创建」在同一事务内插入一行临时空间、确保其目录，再插入 `workspace_id` 指向它的会话行；不写 `session.bind` 与 `workspace.create` 审计。任一步失败则事务回滚，不留会话行、空间行，本次新建的空目录按该条的补偿规则移除。

两种情况 SHALL 返回 201 会话视图（「会话视图扩展键」）`{id,title:null,status:"idle",createdAt,updatedAt,scene,workspaceId,pinnedAt:null,archivedAt:null,pendingApproval:false,temporaryWorkspace}`：前者 `temporaryWorkspace` 为 false，后者为 true 且 `workspaceId` 为新建临时空间的 id。创建 SHALL NOT spawn 进程或调用 supervisor（进程仍在首个 prompt 时懒获取）。自本条起，REST 不再能创建 `workspace_id` 为 NULL 的会话；已存在的这类会话保持不变（「绑定不可改与工作目录」）。

#### Scenario: 无 body 与空对象按默认创建
- **WHEN** 已认证 owner 以无 body 的请求、以及以 JSON body `{}` 各调用一次 `POST /api/sessions`
- **THEN** 两次均 201，视图恰为十一键且 `scene`、`pinnedAt`、`archivedAt` 为 null、`status="idle"`、`title=null`、`pendingApproval=false`、`temporaryWorkspace=true`；两次的 `workspaceId` 是两个不同的 32 位十六进制 id，各自对应一行 `temporary=1` 的空间与一个已存在的目录；审计无新增行；未产生 omp 子进程

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

### Requirement: 会话元数据修改
`PATCH /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检：未认证 401、不存在或属他人 404 `not_found`（与未知 id 相同），均先于 body 解析；响应 `Cache-Control: no-store`。body SHALL 为 `application/json` 对象，且为 `{title, scene, pinned, archived}` 的**非空**子集：`{}`、多余键（含 `workspaceId`）、非对象 SHALL 400 `bad_request`；content-parser 错误 SHALL 400 `bad_request`（http-service-skeleton 归属集含 `PATCH /api/sessions/:id`，body limit 16 KiB）。字段规则：
- `title` SHALL 为字符串，经 `String.prototype.trim` 一次后长度为 1..80 个 Unicode 码点（按码点计，非 UTF-16 单元），存储 trim 后的文本；空、全空白、超 80 码点或非字符串 SHALL 400。标题只写 SQLite（omp 以 `--no-title` 运行，不发任何 RPC）。
- `scene` SHALL 为 `office`/`code`/`design` 之一；`null` 或其它值 SHALL 400（场景可改不可清空）。
- `pinned` SHALL 为布尔：`true` 在 `pinned_at` 为 NULL 时写当前 epoch 毫秒、已置顶时保持原值；`false` 置 `pinned_at` 为 NULL。
- `archived` SHALL 为布尔，读写 `archived_at`，规则见「会话归档」：`true` 在会话 `running` 或其控制占用被持有时使整个请求 409 `session_busy`（不写任何列），否则在 `archived_at` 为 NULL 时写当前 epoch 毫秒、已归档时保持原值；`false` 置 `archived_at` 为 NULL。

任一字段不合法 SHALL 整体 400 且不写任何列。合法请求 SHALL 以单条所有者作用域的 UPDATE 只写所给字段对应的列，SHALL NOT 改动 `updated_at`、`status`、`workspace_id`、`omp_session_file`、`stream_epoch` 或任何消息/步骤行，不调用 supervisor，不写审计；会话处于任何状态（含 `running`）或其控制占用被持有时均可修改（`archived:true` 除外，见上）；UPDATE 命中 0 行（并发删除）SHALL 404。成功 SHALL 返回 200 更新后的会话视图（「会话视图扩展键」）。`title` 写入 SHALL 使该会话尚未结算的受理不再被视为"由该受理设置标题"，从而 `rollbackPrompt` 不撤销重命名（chat-sessions「会话持久化与回合刷盘」）。

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

### Requirement: 会话删除
`DELETE /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检（未认证 401、不存在或属他人 404 `not_found`，先于任何 supervisor 调用），响应 no-store，成功为 204 无 body。该路由不读取 body、不属于 content-parser 归属集：携带的格式良好的 body 被忽略，不改变 204/404/409 行为；body 引发的 content-parser 错误按 http-service-skeleton「统一错误信封」的非归属已注册路由语义为通用 500，不执行任何删除步骤。执行 SHALL 同步完成以下序列，任一步失败即停止后续步骤：
1. 若该会话的控制占用正被 regenerate、fork、undo、stop 或另一 DELETE 持有，SHALL 409 `session_busy`，无任何副作用；否则登记控制占用（chat-sessions「Supervisor dispatch and generation binding」），持有至本次调用结束，并在每一种结束路径（204、409、5xx、异常）上释放。持有期间同一会话的 prompt、regenerate、fork、undo 与 DELETE SHALL 409 `session_busy`；stop 不受占用阻塞，按其自身规则返回 202/204。
2. 若会话 `status="running"`：SHALL 在本次 DELETE 已持有的控制占用之下（不重新登记、不释放）执行与 `POST /api/sessions/:id/stop` 相同的停止序列（挂起审批以 `deny` 结算 → `abort` 帧，或派发前登记停止意图），并同时记录该回合的「停止已在途」（turn-control「停止生成 REST」）：等待期间用户对同一回合的 stop 按 A 的规则返回 202 `{}`，不写第二帧 `abort`、不重复结算审批。随后 SHALL 等待以下两者之一出现，出现即进入第 3 步：
   - (a) 该回合终态落库（`turn.end` 已发布）。该等待由 A 的有界退回保证：`abort` 写出后 `OMP_ABORT_GRACE_MS`（8000 ms）内未见 `agent_end` 即 retire 并以 `stopped` 结算，retire 本身按既有 5000/8000 ms 升级。
   - (b) 该回合的受理被补偿：停止意图登记后 runtime 获取或派发失败（例如空间根缺失的 `agent_unavailable`、池满 `agent_capacity`、握手失败），prompt 请求按其无停止意图时相同的失败路径返回它自己的 502/503，受理对被移除、会话状态复原，停止意图随之丢弃且不写 `abort`；此时不会有 `turn.end`。该 prompt 的失败属于该 prompt 请求，不是本 DELETE 的步骤失败；会话此时已非 running、无存活 generation，DELETE 照常继续。
   获取要么成功派发后经 (a) 结束，要么失败经 (b) 结束，二者都在既有上界内出现，删除不另设计时器。
3. 调用 supervisor 公开的 `retire(sessionId)`：存活进程经既有有界 retire 序列退出（token 撤销、名额释放），该会话的 slot 与事件环丢弃，所有 SSE 订阅者的响应结束且不再收到事件。自本步开始至本次调用结束（删除墓碑期，含 retire 完成与第 4 步删行之间的窗口），已通过 owner 预检的新事件流订阅 SHALL 立即结束且不写任何事件；第 4 步失败时墓碑随控制占用一同解除，此后订阅恢复既有行为。
4. 单个 SQLite 事务：读取 `omp_session_file` 与该会话消息数，删除会话行——消息、步骤、审批随外键级联删除，以其为源的 fork 会话 `parent_session_id` 由外键置 NULL 且这些会话保留——并在同一事务写一条 `session.delete` 审计；审计失败则整个事务回滚。同一事务 SHALL 在删除会话行之前读出该会话各用户消息的快照登记（`chat_turn_snapshots` 的 `message_id` 与 `workspace_id`，供第 6 步清理；这些行随消息行级联删除），并按 temporary-workspaces「共用与随最后一个会话删除」判定：被删会话用的是临时空间且删除后再无会话引用它时，在同一事务内删除该空间行并写 `workspace.delete` 审计。已归档的会话按同一序列删除。store SHALL 在删除时确认该会话无活跃回合/缓冲/步骤内存状态（此时应已结算；若仍存在视为不变量破坏，通用失败且不删除）。
5. 若第 4 步读到的 `omp_session_file` 非 NULL：该值由 omp 上报、写入时未经宿主校验，故宿主 SHALL 仅在它是绝对路径、其所在目录的 realpath 等于该会话所有者的 omp 会话目录（`<OMP_STATE_DIR>/sessions/<ownerId>`）的 realpath、该会话目录的 realpath 恰为 `<OMP_STATE_DIR 的 realpath>/sessions/<ownerId>`（`sessions` 与 `<ownerId>` 两级都不是符号链接——换成指向别处的符号链接后前一条比较两侧会一起解析到链接目标而恒等；omp-runtime「OMP_STATE_DIR 托管布局」之后这两级不能再被 omp uid 替换（它们的父目录对 omp uid 不可写），本校验保留为纵深防御）、且它本身（`lstat`，不跟随符号链接）是普通文件时才 unlink；不满足任一条件 SHALL NOT unlink 任何路径，并经服务错误通道报告。`ENOENT`（校验或 unlink 时已不存在）视为成功；其它错误经服务错误通道报告。以上任何情况响应仍为 204（行已删除，残留文件不影响任何会话），错误通道自身的失败也不改变该响应。同名目录的处理条件 SHALL 为：该值是绝对路径、其所在目录的 realpath 等于 owner 会话目录的 realpath、其 basename 以 `.jsonl` 结尾且去掉后缀后的名字非空且不是 `.` 或 `..`，并且对它本身的 `lstat` 结果是普通文件（不论随后 unlink 成功、`ENOENT` 或失败）或 `ENOENT`（文件已不存在而同名目录可能仍在）。条件满足时，宿主 SHALL 在同一校验后的 owner 会话目录 realpath 下，对去掉 `.jsonl` 后缀的同名项（omp 为该会话建的产物目录，存放工具完整输出等）做 `lstat`：为目录（不跟随符号链接）则先把它 `rename` 为 `<OMP_STATE_DIR 的 realpath>/trash/<32 位随机 hex>`（omp-runtime「OMP_STATE_DIR 托管布局」的 app 私有目录，omp uid 不能进入），再对 trash 里的该项 `lstat`：是目录则在 trash 内递归移除（不跟随目录内的符号链接），不是目录（`lstat` 与 `rename` 之间被换成了符号链接或文件）则只 `unlink` 这一项并经服务错误通道报告；`rename` 以 `ENOENT` 失败时（源已不在与 trash 缺失同为 `ENOENT`）SHALL 再对原位置 `lstat` 一次：已不存在视为成功，仍存在则按 trash 不可用经服务错误通道报告且不触碰原位置；其它失败（含 `EXDEV`、以及 omp uid 把自己的产物目录改成 app uid 不可写时的 `EACCES`）经服务错误通道报告且不触碰原位置；不存在视为成功；不是目录（含符号链接）则不移除任何东西并经服务错误通道报告；移除失败（含部分失败）经服务错误通道报告。递归移除因此发生在 omp uid 无法**按路径**到达的目录里：`rename` 不跟随符号链接、移动的是目录项本身，移入 trash 之后 omp uid 不能再经路径替换其下任何一级，#758 登记的「移除进行期间按路径替换目录」由此关闭。已知残留：(1) 在删除之前就已把工作目录或目录 fd 留在该产物目录树内的 omp uid 进程，仍可经相对路径在递归期间替换子目录（Node 的递归移除按路径逐项进行，没有 `*at` 系调用）——需要预先进入这一个会话的产物目录，受信局域网下接受并登记于 ADR-0010；(2) omp uid 以 `0700` 之类的权限位建出的子目录，app uid 无法列举或清空，递归移除部分失败——照常经服务错误通道报告一次，残余留在 trash（app 私有，不被任何会话引用，宿主不自动清理）而不在会话目录里。其余情形（非绝对路径、所在目录不符或不存在、本身不是普通文件、去后缀后的名字为空或为 `.`/`..`）SHALL NOT 触碰任何同名项；名字不合法的情形经服务错误通道报告。以上情况响应仍为 204。regenerate/fork 产生的旧分支 `.jsonl` 及其同名目录不在清理范围内。以被删会话为源的 fork 会话不依赖该目录（omp 只在会话自己的同名目录里解析产物引用，fork 不复制也不回退到源目录）。
6. 提交后的清理（与第 5 步一样，任何失败只经服务错误通道报告，响应仍为 204）：删除第 4 步读出的各快照目录（workspace-snapshots「快照清理」）；第 4 步删除了临时空间行时，按 temporary-workspaces「临时空间目录的删除」移除它的目录与它的整个快照目录。
7. 返回 204。

第 2–4 步失败（例如终态落库或删除事务的存储错误）SHALL 返回通用 5xx，会话行保持存在（进程可能已被退役，下次 prompt 按既有 `--resume` 懒获取）。删除完成后该 id 的 `GET /api/sessions/:id/messages`、事件流订阅、PATCH、DELETE SHALL 与未知 id 相同地 404，`GET /api/sessions` 不再列出它；其它会话的进程、行与订阅不受影响。

#### Scenario: 删除空闲会话
- **WHEN** owner 删除一个 `done` 会话（两轮消息、含步骤与一条 `allow` 审批、存活 idle 进程、一个打开的 SSE 订阅、`omp_session_file` 指向已存在文件），另有一个以它为源的 fork 会话
- **THEN** 204 无 body；fake-omp 子进程已退出且订阅响应已结束；该会话的消息/步骤/审批行不复存在；`omp_session_file` 文件已被删除，其同名目录（含一个文件与一层嵌套子目录）也已不存在；fork 会话仍在 `GET /api/sessions` 中且其 `parent_session_id` 为 NULL；`GET /api/audit` 恰新增一条 `session.delete`，`detail.messageCount=4`、`detail.ompSessionFile` 为被删文件路径

#### Scenario: 删除运行中的会话先停止
- **WHEN** 回合进行中且有一条挂起审批时 owner 删除该会话，fake-omp 以 `abort-ok` 应答
- **THEN** 该审批先以 `deny` 结算（审计有 `session.approval decision=deny`），fake-omp 收到 `abort`，订阅者在响应结束前收到 `approval.resolved{decision:"deny"}` 与恰一个 `turn.end{status:"stopped"}`；之后子进程退出、行被删除、响应 204
- **WHEN** fake-omp 以 `abort-ignored` 忽略 `abort`，注入时钟推进过 8000 ms
- **THEN** 进程被退役、回合以 `stopped` 结算，DELETE 随后完成 204，无 `error` 事件
- **WHEN** fake-omp 以 `abort-ignored` 使 DELETE 停在等待终态，此时 owner 对同一会话 `POST …/stop`
- **THEN** stop 返回 202 `{}`；fake-omp 自始至终恰收到一帧 `abort`；注入时钟推进过 8000 ms 后 DELETE 完成 204

#### Scenario: 删除时停止意图遇获取失败
- **WHEN** 会话在 fake-omp `slow-ready` 下受理 prompt（仍在获取/握手、`abort()` 返回 false），owner 此时 DELETE 使停止意图被登记，随后测试注入的获取失败使该次派发不发生
- **THEN** prompt 返回其失败对应的 502/503，受理对被补偿、会话状态复原，fake-omp 未收到 `prompt` 或 `abort` 帧；DELETE 随后 204 且 `GET /api/audit` 恰新增一条 `session.delete`；此后该 id 的 DELETE、PATCH 与 `GET …/messages` 均为 404（而非 409 `session_busy`），无残留控制占用，其它会话的 prompt 照常 202

#### Scenario: 运行中删除的过渡拒绝
- **WHEN** 回合进行中（会话 `running`、进程存活、一个打开的 SSE 订阅）时 owner 删除该会话
- **THEN** 不再返回过渡期的 409 `session_busy`：该回合按「删除运行中的会话先停止」被停止，随后删除完成、响应 204（过渡拒绝已由第 2 步的停止路径取代）

#### Scenario: 删除墓碑期新订阅立即结束
- **WHEN** DELETE 已完成第 3 步 retire、第 4 步删除事务尚未执行时，测试在该窗口内以同一 owner 对该会话发起新的 `GET /api/sessions/:id/events`
- **THEN** 该订阅响应立即结束且不含任何事件；DELETE 完成 204 后同一订阅请求为 404
- **WHEN** 同一窗口内发起新订阅，而随后测试令删除事务中的审计写入失败
- **THEN** 窗口内的订阅仍立即结束且无事件；DELETE 为通用 5xx，此后对该会话的新订阅正常建立（不立即结束）

#### Scenario: 删除期间的并发请求
- **WHEN** DELETE 正在等待被停止回合终态时，对同一会话发 prompt、regenerate、fork 与第二个 DELETE
- **THEN** 四者均 409 `session_busy`，无行变化、无帧；原 DELETE 完成 204；此后对该 id 的 DELETE 返回 404
- **WHEN** 同一会话的 regenerate 或 fork 正持有控制占用时发 DELETE
- **THEN** 409 `session_busy`，会话与进程不变

#### Scenario: 会话文件缺失与从未派发
- **WHEN** owner 删除 `omp_session_file` 指向的文件已不存在的会话，以及一个从未 prompt 过（`omp_session_file` 为 NULL、无进程）的会话
- **THEN** 两者均 204、行被删除、审计各一条（后者 `ompSessionFile=null`、`messageCount=0`），无错误报告

#### Scenario: 会话文件路径不在所有者会话目录内
- **WHEN** 被删会话的 `omp_session_file` 分别为所有者会话目录之外的一个已存在文件、一个相对路径、会话目录内指向目录外文件的符号链接
- **THEN** 三者均 204、行被删除、审计各一条；目录外文件、符号链接及其目标都仍存在；每次经服务错误通道恰报告一次

#### Scenario: 删除事务失败保留会话
- **WHEN** 测试令删除事务中的审计写入失败
- **THEN** 响应为通用 5xx；会话、消息、步骤、审批行与 `omp_session_file` 文件都保留；控制占用已释放，随后对该会话的 prompt 可 202

#### Scenario: 删除的鉴权
- **WHEN** 匿名请求、他人会话、不存在会话调用 DELETE
- **THEN** 分别 401、404、404（后两者一致），无 supervisor 调用、无进程变化、无写入

#### Scenario: 同名目录的边界情形
- **WHEN** 被删会话的 `omp_session_file` 合法存在，而其同名项是一个指向 owner 会话目录之外某目录的符号链接
- **THEN** 204；`.jsonl` 已删除；该符号链接及其目标目录的内容原样保留；服务错误通道恰收到一条报告
- **WHEN** 同名项不存在
- **THEN** 204，错误通道无报告
- **WHEN** `omp_session_file` 未通过校验（不在 owner 会话目录内，或不是普通文件）
- **THEN** 204；owner 会话目录内的同名项不被触碰（仍存在）
- **WHEN** `omp_session_file` 指向的 `.jsonl` 已不存在，而 owner 会话目录内的同名目录仍在
- **THEN** 204；同名目录已被移除；错误通道无报告
- **WHEN** `omp_session_file` 是 owner 会话目录内名为 `..jsonl` 或 `...jsonl` 的普通文件（去后缀后为 `.` 或 `..`）
- **THEN** 204；该文件按既有规则 unlink；owner 会话目录、其上级目录及其中的其它文件原样保留；错误通道收到一条报告
- **WHEN** 同名目录的递归移除失败（注入）
- **THEN** 204；会话行已删除；错误通道收到报告

#### Scenario: 产物目录经 trash 移除
- **WHEN** 删除一个会话，其 `.jsonl` 与同名非空产物目录（含嵌套子目录与一个指向会话目录之外文件的符号链接）都在 owner 会话目录里
- **THEN** 响应 204，`.jsonl` 与产物目录在会话目录里都不存在，`<state>/trash` 为空，链接指向的外部文件字节不变，无错误报告

#### Scenario: rename 之前被换成符号链接
- **WHEN** 产物目录在宿主 `lstat` 之后、`rename` 之前被换成指向会话目录之外一棵目录树的符号链接（经测试钩子在 `rename` 调用点注入）
- **THEN** 被移入 trash 的是该符号链接本身，宿主只 `unlink` 它并报告一次；链接目标的目录树逐字节不变；`<state>/trash` 为空

#### Scenario: trash 不可用
- **WHEN** `<state>/trash` 被换成普通文件，或根本不存在（`rename` 分别以 `ENOTDIR` 与 `ENOENT` 失败）
- **THEN** 两种情况响应都是 204，产物目录原样留在会话目录里，错误经服务错误通道各报告一次

#### Scenario: 部分失败的残余在 trash
- **WHEN** 产物目录里有一个 app uid 无法清空的子目录（mode `0500`、内含文件）
- **THEN** 响应 204，会话目录里已没有该产物目录，残余在 `<state>/trash/<随机名>` 之下，错误报告一次

#### Scenario: 删除连同快照与独占的临时空间
- **WHEN** owner 删除一个用临时空间 T、有两条带 `ok` 快照的用户消息的 `done` 会话
- **THEN** 204；会话、消息、快照登记行与 T 的空间行都不存在；`<SANDBOX_ROOT>/<ownerId>/tmp-<T>` 与 `<OMP_STATE_DIR>/snapshots/<T>` 都不存在；审计新增 `session.delete` 与 `workspace.delete` 各一条；错误通道无报告

#### Scenario: 绑定正式空间的会话只清自己的快照
- **WHEN** 正式空间 W 上有会话 A（两份快照）与会话 B（一份快照），owner 删除 A
- **THEN** 204；A 的两份快照目录不存在，B 的快照目录与 W 的行、目录、文件都不变；审计没有 `workspace.delete`

#### Scenario: 撤回持有占用时删除被拒
- **WHEN** 同一会话的 undo 正持有控制占用时发 DELETE
- **THEN** 409 `session_busy`，会话与工作空间不变

### Requirement: fork 继承会话元数据
`POST /api/sessions/:id/fork`（chat-sessions「会话 REST」fork 段）在其最终事务中插入的新会话行 SHALL 复制源会话的 `workspace_id` 与 `scene`，`pinned_at` 与 `archived_at` SHALL 为 NULL；其余列与该段规则一致。该事务拷贝的消息与步骤 SHALL 同时拷贝 `chat_messages.thinking` 与 `chat_steps.changes`（原值，含 NULL），使新会话的快照与源会话被拷贝部分的思考与文件变更一致。fork 响应中的 `session` 与其它会话视图键集相同（「会话视图扩展键」）。源会话用临时空间时，新会话继承同一个 `workspace_id`、与源会话共用该临时空间（temporary-workspaces「共用与随最后一个会话删除」），fork 不复制目录、不新建空间行；fork SHALL NOT 拷贝 `chat_turn_snapshots` 行。fork 会话后续 generation 的 `--cwd` 由其继承的 `workspace_id` 按「绑定不可改与工作目录」计算，与源会话一致（均为源空间根或所有者根）。fork 不写 `session.bind` 审计。

#### Scenario: 继承空间与场景、不继承置顶
- **WHEN** owner 对绑定 W、`scene="code"`、已置顶的源会话调用 fork（fake-omp `branch`），随后在新会话发 prompt
- **THEN** 201 的 `session` 为会话视图，`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；源会话 `pinnedAt` 不变；被拷贝助手消息的 `thinking` 与其步骤的 `changes` 在新会话快照中与源会话逐值相同（NULL 仍为 null）；新会话进程 probe 报告的 `cwd` 为 W 的根；审计无 `session.bind` 新增

#### Scenario: fork 响应的会话视图与列表一致
- **WHEN** owner 对绑定 W、`scene="design"`、已置顶的源会话调用 fork 成功，随后 `GET /api/sessions`
- **THEN** 201 响应的 `session` 恰为十一键，`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`、`archivedAt=null`、`pendingApproval=false`、`temporaryWorkspace=false`，且与 `GET /api/sessions` 中同 id 条目逐键相等

#### Scenario: 继承临时空间
- **WHEN** owner 对一个用临时空间 T 的源会话调用 fork
- **THEN** 新会话 `workspaceId=<T>`、`temporaryWorkspace=true`、`archivedAt=null`；`workspaces` 行数不变；账号根下的 `tmp-…` 目录数不变
