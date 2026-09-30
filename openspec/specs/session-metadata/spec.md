# session-metadata Specification

## Purpose
定义会话元数据的服务端契约：创建时可选绑定工作空间与场景（`POST /api/sessions` body）、绑定不可改且决定 omp 工作目录、单一 `PATCH /api/sessions/:id` 修改标题/场景/置顶、同步 `DELETE /api/sessions/:id`（先停止、再退役进程、级联删行、删当前会话文件）、`session.bind`/`session.delete` 审计，以及 fork 对元数据的继承规则。本 change 在 change A（`s1c-turn-control-governance`）之后实施，停止、控制占用与 fork 流程沿用 A 的定义。

## Requirements

### Requirement: 绑定不可改与工作目录
会话的 `workspace_id` 只在创建时（或 fork 继承时）写入，此后 SHALL NOT 被任何 REST 修改。会话的 omp 工作目录 SHALL 为：绑定时该空间根（经工作空间 store 以会话 `owner_id` 为 principal 的 `rootOf` 取得，落在 `<SANDBOX_ROOT>/<ownerId>/` 之下），未绑定时沿用所有者根 `<SANDBOX_ROOT>/<ownerId>`；该会话每一次 generation spawn（首次、闲置回收后、崩溃恢复、regenerate 重新获取）与以其为源的 fork 临时进程 SHALL 以此为 `--cwd`（chat-sessions「Supervisor dispatch and generation binding」）。绑定会话的 `rootOf` 返回 null 时 SHALL 以通用失败结束该次获取，不回退所有者根。`rootOf` 返回的空间根在获取时不是已存在的目录（被外部删除或改名），或 `rootOf` 因该根存在但不是普通目录（被同名文件占据、含 symlink）而拒绝解析时，宿主 SHALL NOT 创建该目录（不对空间根做 mkdir）、SHALL NOT spawn、SHALL NOT 回退所有者根，该次获取按 `agent_unavailable` 失败（prompt → 502 并走既有受理对补偿；regenerate 按其既有 502 规则）。omp `--resume` 以会话文件头记录的 cwd 为准，故同一会话各 generation 的 cwd SHALL 一致。空间目录丢失后的修复不在本契约内。

#### Scenario: 绑定会话的进程工作目录
- **WHEN** owner 在绑定 W 的会话与一个未绑定会话上各发 prompt，fake-omp probe 报告 `cwd=`
- **THEN** 前者 `cwd` 为 W 的根，后者为 `<SANDBOX_ROOT>/<ownerId>`；闲置回收后再发 prompt，新 generation 报告的 `cwd` 与前一次相同

#### Scenario: 空间目录缺失不回退不创建
- **WHEN** 绑定 W 的会话在下一次 prompt 之前，W 的根目录被应用之外的操作删除
- **THEN** prompt 返回 502 `agent_unavailable`，受理对被补偿、会话状态复原；无子进程 spawn；W 的根目录仍不存在；未以所有者根 spawn

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

### Requirement: 会话元数据审计
会话元数据 SHALL 经 `core/audit` 既有 `emit` 写入新审计事件，与其对应的业务写入处于同一 SQLite 事务（业务回滚则审计不存在，审计失败则业务不生效），`actorId` 为会话 `owner_id`：
- `session.bind`：仅在 `POST /api/sessions` 以 `workspaceId` 创建会话时写一条；`title="绑定工作空间"`、`workspaceId`=所绑空间 id、`detail={sessionId, scene}`（`scene` 为请求值或 null）。未绑定的创建与 fork 继承绑定不写该事件。

`GET /api/audit` SHALL 以既有形状返回该事件，并沿用既有的按 actor 过滤与管理员可见规则。

#### Scenario: 绑定审计形状
- **WHEN** owner 以 `{workspaceId:W.id, scene:"office"}` 创建会话
- **THEN** `GET /api/audit?limit=1` 返回 `session.bind`（`title="绑定工作空间"`、`workspaceId=W.id`、`detail={sessionId,scene:"office"}`），`actorId` 为该 owner；第二个非管理员账号的 `GET /api/audit` 不含该条
