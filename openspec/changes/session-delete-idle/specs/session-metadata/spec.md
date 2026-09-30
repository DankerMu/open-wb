## ADDED Requirements

### Requirement: 会话删除
`DELETE /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检（未认证 401、不存在或属他人 404 `not_found`，先于任何 supervisor 调用），响应 no-store，成功为 204 无 body。该路由不读取 body、不属于 content-parser 归属集：携带的格式良好的 body 被忽略，不改变 204/404/409 行为；body 引发的 content-parser 错误按 http-service-skeleton「统一错误信封」的非归属已注册路由语义为通用 500，不执行任何删除步骤。执行 SHALL 同步完成以下序列，任一步失败即停止后续步骤：
1. 若该会话的控制占用正被 regenerate、fork、stop 或另一 DELETE 持有，SHALL 409 `session_busy`，无任何副作用；否则登记控制占用（chat-sessions「Supervisor dispatch and generation binding」），持有至本次调用结束，并在每一种结束路径（204、409、5xx、异常）上释放。持有期间同一会话的 prompt、regenerate、fork 与 DELETE SHALL 409 `session_busy`；stop 不受占用阻塞，按其自身规则返回 202/204。
2. 若会话 `status="running"`：SHALL 409 `session_busy`，释放第 1 步登记的控制占用，无任何其它副作用（不结算审批、不写帧、不 retire、不写行、不写审计）。这是运行中删除的过渡行为；停止后删除的路径由后续变更定义并替换本步。
3. 调用 supervisor 公开的 `retire(sessionId)`：存活进程经既有有界 retire 序列退出（token 撤销、名额释放），该会话的 slot 与事件环丢弃，所有 SSE 订阅者的响应结束且不再收到事件。自本步开始至本次调用结束（删除墓碑期，含 retire 完成与第 4 步删行之间的窗口），已通过 owner 预检的新事件流订阅 SHALL 立即结束且不写任何事件；第 4 步失败时墓碑随控制占用一同解除，此后订阅恢复既有行为。
4. 单个 SQLite 事务：读取 `omp_session_file` 与该会话消息数，删除会话行——消息、步骤、审批随外键级联删除，以其为源的 fork 会话 `parent_session_id` 由外键置 NULL 且这些会话保留——并在同一事务写一条 `session.delete` 审计；审计失败则整个事务回滚。store SHALL 在删除时确认该会话无活跃回合/缓冲/步骤内存状态（此时应已结算；若仍存在视为不变量破坏，通用失败且不删除）。
5. 若第 4 步读到的 `omp_session_file` 非 NULL：该值由 omp 上报、写入时未经宿主校验，故宿主 SHALL 仅在它是绝对路径、其所在目录的 realpath 等于该会话所有者的 omp 会话目录（`<OMP_STATE_DIR>/sessions/<ownerId>`）的 realpath、且它本身（`lstat`，不跟随符号链接）是普通文件时才 unlink；不满足任一条件 SHALL NOT unlink 任何路径，并经服务错误通道报告。`ENOENT`（校验或 unlink 时已不存在）视为成功；其它错误经服务错误通道报告。以上任何情况响应仍为 204（行已删除，残留文件不影响任何会话），错误通道自身的失败也不改变该响应。regenerate/fork 产生的旧分支 `.jsonl` 不在清理范围内。
6. 返回 204。

第 3–4 步失败（例如删除事务的存储错误）SHALL 返回通用 5xx，会话行保持存在（进程可能已被退役，下次 prompt 按既有 `--resume` 懒获取）。删除完成后该 id 的 `GET /api/sessions/:id/messages`、事件流订阅、PATCH、DELETE SHALL 与未知 id 相同地 404，`GET /api/sessions` 不再列出它；其它会话的进程、行与订阅不受影响。

#### Scenario: 删除空闲会话
- **WHEN** owner 删除一个 `done` 会话（两轮消息、含步骤与一条 `allow` 审批、存活 idle 进程、一个打开的 SSE 订阅、`omp_session_file` 指向已存在文件），另有一个以它为源的 fork 会话
- **THEN** 204 无 body；fake-omp 子进程已退出且订阅响应已结束；该会话的消息/步骤/审批行不复存在；`omp_session_file` 文件已被删除；fork 会话仍在 `GET /api/sessions` 中且其 `parent_session_id` 为 NULL；`GET /api/audit` 恰新增一条 `session.delete`，`detail.messageCount=4`、`detail.ompSessionFile` 为被删文件路径

#### Scenario: 删除墓碑期新订阅立即结束
- **WHEN** DELETE 已完成第 3 步 retire、第 4 步删除事务尚未执行时，测试在该窗口内以同一 owner 对该会话发起新的 `GET /api/sessions/:id/events`
- **THEN** 该订阅响应立即结束且不含任何事件；DELETE 完成 204 后同一订阅请求为 404
- **WHEN** 同一窗口内发起新订阅，而随后测试令删除事务中的审计写入失败
- **THEN** 窗口内的订阅仍立即结束且无事件；DELETE 为通用 5xx，此后对该会话的新订阅正常建立（不立即结束）

#### Scenario: 删除期间的并发请求
- **WHEN** 同一会话的 regenerate 或 fork 正持有控制占用时发 DELETE
- **THEN** 409 `session_busy`，会话与进程不变

#### Scenario: 运行中删除的过渡拒绝
- **WHEN** 回合进行中（会话 `running`、进程存活、一个打开的 SSE 订阅）时 owner 删除该会话
- **THEN** 409 `session_busy` 与 no-store；进程、会话/消息行与订阅均不变，无审计新增；回合照常结束后该会话的 prompt 可 202、DELETE 可 204（控制占用已释放）

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

## MODIFIED Requirements

### Requirement: 会话元数据审计
会话元数据 SHALL 经 `core/audit` 既有 `emit` 写入两类新审计事件，均与其对应的业务写入处于同一 SQLite 事务（业务回滚则审计不存在，审计失败则业务不生效），`actorId` 为会话 `owner_id`：
- `session.bind`：仅在 `POST /api/sessions` 以 `workspaceId` 创建会话时写一条；`title="绑定工作空间"`、`workspaceId`=所绑空间 id、`detail={sessionId, scene}`（`scene` 为请求值或 null）。未绑定的创建与 fork 继承绑定不写该事件。
- `session.delete`：每次成功删除写一条；`title="删除会话"`、`workspaceId`=被删会话的 `workspace_id`（未绑定为 null）、`detail={sessionId, ompSessionFile, messageCount}`，`ompSessionFile` 为删除前的 `omp_session_file`（可为 null），`messageCount` 为被级联删除的消息行数。

`PATCH /api/sessions/:id` 不写审计。`GET /api/audit` SHALL 以既有形状返回这两类事件，并沿用既有的按 actor 过滤与管理员可见规则。

#### Scenario: 绑定审计形状
- **WHEN** owner 以 `{workspaceId:W.id, scene:"office"}` 创建会话
- **THEN** `GET /api/audit?limit=1` 返回 `session.bind`（`title="绑定工作空间"`、`workspaceId=W.id`、`detail={sessionId,scene:"office"}`），`actorId` 为该 owner；第二个非管理员账号的 `GET /api/audit` 不含该条

#### Scenario: 审计形状
- **WHEN** owner 以 `{workspaceId:W.id, scene:"office"}` 创建会话、发一轮 prompt 至 `done`，再删除它
- **THEN** `GET /api/audit?limit=2` 依次返回 `session.delete`（`title="删除会话"`、`workspaceId=W.id`、`detail={sessionId,ompSessionFile:<路径>,messageCount:2}`）与 `session.bind`（`title="绑定工作空间"`、`workspaceId=W.id`、`detail={sessionId,scene:"office"}`），`actorId` 均为该 owner；第二个非管理员账号的 `GET /api/audit` 不含这两条
