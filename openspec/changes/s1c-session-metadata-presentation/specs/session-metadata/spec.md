# Spec: session-metadata

## Purpose
定义会话元数据的服务端契约：创建时可选绑定工作空间与场景（`POST /api/sessions` body）、绑定不可改且决定 omp 工作目录、单一 `PATCH /api/sessions/:id` 修改标题/场景/置顶、同步 `DELETE /api/sessions/:id`（先停止、再退役进程、级联删行、删当前会话文件）、`session.bind`/`session.delete` 审计，以及 fork 对元数据的继承规则。本 change 在 change A（`s1c-turn-control-governance`）之后实施，停止、控制占用与 fork 流程沿用 A 的定义。

## ADDED Requirements

### Requirement: 会话创建与空间绑定
`POST /api/sessions` SHALL 接受可选 body `{workspaceId?, scene?}`，并因此成为 content-parser 归属路由（http-service-skeleton「统一错误信封」，body limit 16 KiB，与工作空间路由先例一致）。无 body（无 Content-Type 且无内容）SHALL 为合法请求，与 body `{}` 等价：创建未绑定、`scene` 为 NULL 的会话。携带 body 时 SHALL 为 `application/json` 且解析为对象，键集 SHALL 为 `{workspaceId, scene}` 的子集：数组/`null`/非对象、多余键、`workspaceId` 非字符串（含 `null`）、`scene` 不是 `office`/`code`/`design` 之一（含 `null`、大小写不同或空串）SHALL 400 `bad_request`；content-parser 错误亦为 400 `bad_request`。形状校验通过后，`workspaceId` SHALL 经工作空间 store 的所有者作用域 `rootOf(principal, workspaceId)` 判定：不存在或属他人的 id（含非 32 位小写 hex 的字符串）SHALL 返回相同的 404 `not_found` 信封，二者不可区分；以上 400/404 均不写会话行、不写审计。

合法请求 SHALL 在一个 SQLite 事务内插入会话行（`workspace_id` 与 `scene` 为请求值或 NULL、`pinned_at` NULL、其余列同既有创建规则），并在绑定空间时于同一事务写一条 `session.bind` 审计（见「会话元数据审计」），审计失败则会话行也不存在；返回 201 八键会话视图 `{id,title:null,status:"idle",createdAt,updatedAt,scene,workspaceId,pinnedAt:null}`。创建 SHALL NOT 创建任何目录、spawn 进程或调用 supervisor（进程仍在首个 prompt 时懒获取）。

#### Scenario: 无 body 与空对象按默认创建
- **WHEN** 已认证 owner 以无 body 的请求、以及以 JSON body `{}` 各调用一次 `POST /api/sessions`
- **THEN** 两次均 201，视图恰为八键且 `scene`、`workspaceId`、`pinnedAt` 为 null、`status="idle"`、`title=null`；审计无新增行

#### Scenario: 绑定自有工作空间并选择场景
- **WHEN** owner 先 `POST /api/workspaces` 建空间 W，再以 `{workspaceId:W.id, scene:"code"}` 创建会话
- **THEN** 201 视图 `workspaceId=W.id`、`scene="code"`；`chat_sessions.workspace_id` 与 `scene` 同值；`GET /api/audit` 恰新增一条 `session.bind`；`GET /api/sessions` 列出该会话且八键一致；未产生 omp 子进程

#### Scenario: 他人与不存在的空间一致 404
- **WHEN** 第二个账号以第一个账号的 W.id 创建会话，以及第一个账号以随机 32 位 hex、以 `abc` 作为 `workspaceId` 创建会话
- **THEN** 三次均 404，信封与 no-store 逐字相同；无会话行、无审计行新增

#### Scenario: 非法 body 形状
- **WHEN** owner 以 `{scene:"chat"}`、`{scene:null}`、`{scene:"Office"}`、`{workspaceId:null}`、`{workspaceId:1}`、`{title:"x"}`、`[]`、`null`、malformed JSON 或 `text/plain` body 调用 `POST /api/sessions`
- **THEN** 均为 400 `bad_request` 与 no-store，无会话行、无审计行新增

### Requirement: 绑定不可改与工作目录
会话的 `workspace_id` 只在创建时（或 fork 继承时）写入，此后 SHALL NOT 被任何 REST 修改：`PATCH /api/sessions/:id` 携带 `workspaceId` 键 SHALL 作为多余键 400 `bad_request`。会话的 omp 工作目录 SHALL 为：绑定时该空间根（经工作空间 store 以会话 `owner_id` 为 principal 的 `rootOf` 取得，落在 `<SANDBOX_ROOT>/<ownerId>/` 之下），未绑定时沿用所有者根 `<SANDBOX_ROOT>/<ownerId>`；该会话每一次 generation spawn（首次、闲置回收后、崩溃恢复、regenerate 重新获取）与以其为源的 fork 临时进程 SHALL 以此为 `--cwd`（chat-sessions「Supervisor dispatch and generation binding」）。绑定会话的 `rootOf` 返回 null 时 SHALL 以通用失败结束该次获取，不回退所有者根。`rootOf` 返回的空间根在获取时不是已存在的目录（被外部删除或改名）时，宿主 SHALL NOT 创建该目录（不对空间根做 mkdir）、SHALL NOT spawn、SHALL NOT 回退所有者根，该次获取按 `agent_unavailable` 失败（prompt → 502 并走既有受理对补偿；regenerate 按其既有 502 规则）。omp `--resume` 以会话文件头记录的 cwd 为准，故同一会话各 generation 的 cwd SHALL 一致。空间目录丢失后的修复不在本契约内。

#### Scenario: 绑定会话的进程工作目录
- **WHEN** owner 在绑定 W 的会话与一个未绑定会话上各发 prompt，fake-omp probe 报告 `cwd=`
- **THEN** 前者 `cwd` 为 W 的根，后者为 `<SANDBOX_ROOT>/<ownerId>`；闲置回收后再发 prompt，新 generation 报告的 `cwd` 与前一次相同

#### Scenario: 空间目录缺失不回退不创建
- **WHEN** 绑定 W 的会话在下一次 prompt 之前，W 的根目录被应用之外的操作删除
- **THEN** prompt 返回 502 `agent_unavailable`，受理对被补偿、会话状态复原；无子进程 spawn；W 的根目录仍不存在；未以所有者根 spawn

#### Scenario: PATCH 不能改绑定
- **WHEN** owner 对绑定 W 的会话 PATCH `{workspaceId:"<另一空间 id>"}` 或 `{title:"x",workspaceId:null}`
- **THEN** 400 `bad_request`，会话行各列不变，后续 prompt 的 `cwd` 仍为 W 的根

### Requirement: 会话元数据修改
`PATCH /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检：未认证 401、不存在或属他人 404 `not_found`（与未知 id 相同），均先于 body 解析；响应 `Cache-Control: no-store`。body SHALL 为 `application/json` 对象，且为 `{title, scene, pinned}` 的**非空**子集：`{}`、多余键（含 `workspaceId`）、非对象 SHALL 400 `bad_request`；content-parser 错误 SHALL 400 `bad_request`（http-service-skeleton 归属集含 `PATCH /api/sessions/:id`，body limit 16 KiB）。字段规则：
- `title` SHALL 为字符串，经 `String.prototype.trim` 一次后长度为 1..80 个 Unicode 码点（按码点计，非 UTF-16 单元），存储 trim 后的文本；空、全空白、超 80 码点或非字符串 SHALL 400。标题只写 SQLite（omp 以 `--no-title` 运行，不发任何 RPC）。
- `scene` SHALL 为 `office`/`code`/`design` 之一；`null` 或其它值 SHALL 400（场景可改不可清空）。
- `pinned` SHALL 为布尔：`true` 在 `pinned_at` 为 NULL 时写当前 epoch 毫秒、已置顶时保持原值；`false` 置 `pinned_at` 为 NULL。

任一字段不合法 SHALL 整体 400 且不写任何列。合法请求 SHALL 以单条所有者作用域的 UPDATE 只写所给字段对应的列，SHALL NOT 改动 `updated_at`、`status`、`workspace_id`、`omp_session_file`、`stream_epoch` 或任何消息/步骤行，不调用 supervisor，不写审计；会话处于任何状态（含 `running`）或其控制占用被持有时均可修改；UPDATE 命中 0 行（并发删除）SHALL 404。成功 SHALL 返回 200 更新后的八键会话视图。`title` 写入 SHALL 使该会话尚未结算的受理不再被视为"由该受理设置标题"，从而 `rollbackPrompt` 不撤销重命名（chat-sessions「会话持久化与回合刷盘」）。

#### Scenario: 重命名、改场景与置顶
- **WHEN** owner 对 `done` 会话依次 PATCH `{title:"  季度 汇报  "}`、`{scene:"design"}`、`{pinned:true}`、再 `{pinned:true}`、再 `{pinned:false}`
- **THEN** 各返回 200 八键视图：`title="季度 汇报"`；`scene="design"`；第一次置顶 `pinnedAt` 为请求时刻的 epoch 毫秒、第二次保持同值；取消后 `pinnedAt=null`；全程 `updatedAt`、`status` 与 `GET /api/sessions` 中的相对顺序不变，`GET /api/audit` 无新增行

#### Scenario: 多字段一次修改与运行中修改
- **WHEN** 会话 `running` 时 owner PATCH `{title:"新名",scene:"office",pinned:true}`
- **THEN** 200，三列一次写入，回合照常进行且其 `turn.end` 后标题仍为 `新名`

#### Scenario: 标题边界
- **WHEN** PATCH `title` 为恰 80 个码点（含辅助平面字符）、81 个码点、`""`、`"   "`、`123`
- **THEN** 80 码点 200 且原样存储；其余均 400 `bad_request`，标题不变

#### Scenario: 非法 body 与鉴权
- **WHEN** owner PATCH `{}`、`{pinned:"yes"}`、`{scene:null}`、`{status:"done"}`、`{title:"a",extra:1}`、`[]`、malformed JSON 或 `text/plain` body
- **THEN** 均 400 `bad_request` 与 no-store，会话行不变
- **WHEN** 匿名请求、他人会话、不存在会话以合法或非法 body PATCH
- **THEN** 分别 401、404、404（后两者一致），均先于 body 解析，无写入

#### Scenario: 重命名不被 prompt 补偿撤销
- **WHEN** 无标题会话受理一个 prompt（标题取前 18 码点），派发挂起期间 owner PATCH `{title:"季度汇报"}`，随后 supervisor 以 `agent_unavailable` 拒绝使受理对被补偿
- **THEN** prompt 返回 502，受理对被移除、`status`/`updatedAt` 复原，而标题仍为 `季度汇报`

### Requirement: 会话删除
`DELETE /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检（未认证 401、不存在或属他人 404 `not_found`，先于任何 supervisor 调用），响应 no-store，成功为 204 无 body。该路由不读取 body、不属于 content-parser 归属集：携带的格式良好的 body 被忽略，不改变 204/404/409 行为；body 引发的 content-parser 错误按 http-service-skeleton「统一错误信封」的非归属已注册路由语义为通用 500，不执行任何删除步骤。执行 SHALL 同步完成以下序列，任一步失败即停止后续步骤：
1. 若该会话的控制占用正被 regenerate、fork、stop 或另一 DELETE 持有，SHALL 409 `session_busy`，无任何副作用；否则登记控制占用（chat-sessions「Supervisor dispatch and generation binding」），持有至本次调用结束，并在每一种结束路径（204、409、5xx、异常）上释放。持有期间同一会话的 prompt、regenerate、fork 与 DELETE SHALL 409 `session_busy`；stop 不受占用阻塞，按其自身规则返回 202/204。
2. 若会话 `status="running"`：SHALL 在本次 DELETE 已持有的控制占用之下（不重新登记、不释放）执行与 `POST /api/sessions/:id/stop` 相同的停止序列（挂起审批以 `deny` 结算 → `abort` 帧，或派发前登记停止意图），并同时记录该回合的「停止已在途」（turn-control「停止生成 REST」）：等待期间用户对同一回合的 stop 按 A 的规则返回 202 `{}`，不写第二帧 `abort`、不重复结算审批。随后 SHALL 等待以下两者之一出现，出现即进入第 3 步：
   - (a) 该回合终态落库（`turn.end` 已发布）。该等待由 A 的有界退回保证：`abort` 写出后 `OMP_ABORT_GRACE_MS`（8000 ms）内未见 `agent_end` 即 retire 并以 `stopped` 结算，retire 本身按既有 5000/8000 ms 升级。
   - (b) 该回合的受理被补偿：停止意图登记后 runtime 获取或派发失败（例如空间根缺失的 `agent_unavailable`、池满 `agent_capacity`、握手失败），prompt 请求按其无停止意图时相同的失败路径返回它自己的 502/503，受理对被移除、会话状态复原，停止意图随之丢弃且不写 `abort`；此时不会有 `turn.end`。该 prompt 的失败属于该 prompt 请求，不是本 DELETE 的步骤失败；会话此时已非 running、无存活 generation，DELETE 照常继续。
   获取要么成功派发后经 (a) 结束，要么失败经 (b) 结束，二者都在既有上界内出现，删除不另设计时器。
3. 调用 supervisor 公开的 `retire(sessionId)`：存活进程经既有有界 retire 序列退出（token 撤销、名额释放），该会话的 slot 与事件环丢弃，所有 SSE 订阅者的响应结束且不再收到事件。自本步开始至本次调用结束（删除墓碑期，含 retire 完成与第 4 步删行之间的窗口），已通过 owner 预检的新事件流订阅 SHALL 立即结束且不写任何事件；第 4 步失败时墓碑随控制占用一同解除，此后订阅恢复既有行为。
4. 单个 SQLite 事务：读取 `omp_session_file` 与该会话消息数，删除会话行——消息、步骤、审批随外键级联删除，以其为源的 fork 会话 `parent_session_id` 由外键置 NULL 且这些会话保留——并在同一事务写一条 `session.delete` 审计；审计失败则整个事务回滚。store SHALL 在删除时确认该会话无活跃回合/缓冲/步骤内存状态（此时应已结算；若仍存在视为不变量破坏，通用失败且不删除）。
5. 若第 4 步读到的 `omp_session_file` 非 NULL，SHALL unlink 该文件：`ENOENT` 视为成功；其它错误经服务错误通道报告，响应仍为 204（行已删除，残留文件不影响任何会话）。regenerate/fork 产生的旧分支 `.jsonl` 不在清理范围内。
6. 返回 204。

第 2–4 步失败（例如终态落库或删除事务的存储错误）SHALL 返回通用 5xx，会话行保持存在（进程可能已被退役，下次 prompt 按既有 `--resume` 懒获取）。删除完成后该 id 的 `GET /api/sessions/:id/messages`、事件流订阅、PATCH、DELETE SHALL 与未知 id 相同地 404，`GET /api/sessions` 不再列出它；其它会话的进程、行与订阅不受影响。

#### Scenario: 删除空闲会话
- **WHEN** owner 删除一个 `done` 会话（两轮消息、含步骤与一条 `allow` 审批、存活 idle 进程、一个打开的 SSE 订阅、`omp_session_file` 指向已存在文件），另有一个以它为源的 fork 会话
- **THEN** 204 无 body；fake-omp 子进程已退出且订阅响应已结束；该会话的消息/步骤/审批行不复存在；`omp_session_file` 文件已被删除；fork 会话仍在 `GET /api/sessions` 中且其 `parent_session_id` 为 NULL；`GET /api/audit` 恰新增一条 `session.delete`，`detail.messageCount=4`、`detail.ompSessionFile` 为被删文件路径

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

#### Scenario: 删除事务失败保留会话
- **WHEN** 测试令删除事务中的审计写入失败
- **THEN** 响应为通用 5xx；会话、消息、步骤、审批行与 `omp_session_file` 文件都保留；控制占用已释放，随后对该会话的 prompt 可 202

#### Scenario: 删除的鉴权
- **WHEN** 匿名请求、他人会话、不存在会话调用 DELETE
- **THEN** 分别 401、404、404（后两者一致），无 supervisor 调用、无进程变化、无写入

### Requirement: 会话元数据审计
会话元数据 SHALL 经 `core/audit` 既有 `emit` 写入两类新审计事件，均与其对应的业务写入处于同一 SQLite 事务（业务回滚则审计不存在，审计失败则业务不生效），`actorId` 为会话 `owner_id`：
- `session.bind`：仅在 `POST /api/sessions` 以 `workspaceId` 创建会话时写一条；`title="绑定工作空间"`、`workspaceId`=所绑空间 id、`detail={sessionId, scene}`（`scene` 为请求值或 null）。未绑定的创建与 fork 继承绑定不写该事件。
- `session.delete`：每次成功删除写一条；`title="删除会话"`、`workspaceId`=被删会话的 `workspace_id`（未绑定为 null）、`detail={sessionId, ompSessionFile, messageCount}`，`ompSessionFile` 为删除前的 `omp_session_file`（可为 null），`messageCount` 为被级联删除的消息行数。

`PATCH /api/sessions/:id` 不写审计。`GET /api/audit` SHALL 以既有形状返回这两类事件，并沿用既有的按 actor 过滤与管理员可见规则。

#### Scenario: 审计形状
- **WHEN** owner 以 `{workspaceId:W.id, scene:"office"}` 创建会话、发一轮 prompt 至 `done`，再删除它
- **THEN** `GET /api/audit?limit=2` 依次返回 `session.delete`（`title="删除会话"`、`workspaceId=W.id`、`detail={sessionId,ompSessionFile:<路径>,messageCount:2}`）与 `session.bind`（`title="绑定工作空间"`、`workspaceId=W.id`、`detail={sessionId,scene:"office"}`），`actorId` 均为该 owner；第二个非管理员账号的 `GET /api/audit` 不含这两条

### Requirement: fork 继承会话元数据
`POST /api/sessions/:id/fork`（turn-control「从此处分叉 REST」）预先插入的新会话行 SHALL 复制源会话的 `workspace_id` 与 `scene`，`pinned_at` SHALL 为 NULL；其余列与 A 的规则一致。fork 事务拷贝的消息与步骤 SHALL 同时拷贝 `chat_messages.thinking` 与 `chat_steps.changes`（原值，含 NULL），使新会话的快照与源会话被拷贝部分的思考与文件变更一致。fork 响应中的 `session` 与其它会话视图相同，为八键视图。因 omp `--resume` 采用源会话文件头的 cwd，fork 会话后续 generation 的 `--cwd` 与源会话一致（均为源空间根或所有者根）。fork 不写 `session.bind` 审计。

#### Scenario: 继承空间与场景、不继承置顶
- **WHEN** owner 对绑定 W、`scene="code"`、已置顶的源会话调用 fork（fake-omp `branch`），随后在新会话发 prompt
- **THEN** 201 的 `session` 为八键，`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；源会话 `pinnedAt` 不变；被拷贝助手消息的 `thinking` 与其步骤的 `changes` 在新会话快照中与源会话逐值相同；新会话进程 probe 报告的 `cwd` 为 W 的根；审计无 `session.bind` 新增

#### Scenario: fork 响应的会话视图与列表一致
- **WHEN** owner 对绑定 W、`scene="design"`、已置顶的源会话调用 fork 成功，随后 `GET /api/sessions`
- **THEN** 201 响应的 `session` 恰为八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`，`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`，且与 `GET /api/sessions` 中同 id 条目逐键相等；web 八键严格解析接受该响应（不因缺键视为无效响应）
