## ADDED Requirements

### Requirement: 迁移 038 临时标记
迁移 `038_workspace_temporary.sql` SHALL 在既有 runner 事务内、作为 `037` 之后的第十二个 receipt，只用 `ALTER TABLE … ADD COLUMN` 给 `workspaces` 增加一列 `temporary INTEGER NOT NULL DEFAULT 0 CHECK (temporary IN (0,1))`，不重建表、不回填（既有行读作 `0`），不改动 `031` 的任何列、约束与唯一索引。`031`–`037` 的迁移文件 SHALL NOT 被编辑。受信任迁移目录计数断言 SHALL 随之 +1。

#### Scenario: 新库与存量库
- **WHEN** openDb 打开一个新库，以及一个 receipts 止于 `037`、含两个账号各若干工作空间行的文件库
- **THEN** 两者 receipts 都含 `038`（其后可有更晚的迁移）；`workspaces.temporary` 存在、NOT NULL、默认 0；存量行逐列不变且 `temporary` 读作 0；`PRAGMA foreign_key_check` 为空；再次打开目录稳定

#### Scenario: 取值约束
- **WHEN** 写入 `temporary` 为 `0`、`1`，以及 `2`、`-1`、`NULL`、`'x'`
- **THEN** 前两者写入成功，其余被 SQLite 拒绝

### Requirement: 临时空间的创建
临时空间 SHALL 是一行 `temporary = 1` 的 `workspaces` 记录：`id` 为随机 32 位小写十六进制，`dir` 与 `name` 都恰为 `tmp-<id>`，`owner_id` 为创建者，目录为 `<SANDBOX_ROOT>/<ownerId>/tmp-<id>`（账号根下的同级目录，mode `2770`）。它 SHALL 只由 `POST /api/sessions` 在请求不带 `workspaceId` 时创建（session-metadata「会话创建与空间绑定」），并与该会话行处于同一个 SQLite 事务：插入空间行 → 经既有 `ensureSharedDir` 依次确保账号根与空间根 → 插入绑定该空间的会话行 → 提交。任一步失败 SHALL 回滚事务，并按工作空间创建的既有补偿规则逆序移除本次新建的空目录（采用的既有目录不动），请求以通用 5xx 结束，不留下空间行或会话行。创建 SHALL NOT 写 `workspace.create` 或 `session.bind` 审计，SHALL NOT spawn 进程。生成的 `dir` 或 `name` 与该账号既有行冲突时（随机 id 碰撞）SHALL 换一个 id 重试，不向调用方返回 409。工作空间 store SHALL 以一个方法（与 `create` 共用目录确保与补偿的实现，不另写一份）提供这一行为，调用方事务由会话创建持有。

`POST /api/workspaces` 的 `name` 或 `dir` 与某个临时空间的 `name` / `dir` 相同时 SHALL 按既有规则 409 `conflict`（唯一约束不区分临时与否）。

#### Scenario: 不带空间创建会话
- **WHEN** `zhangsan`（id `u1`）以无 body 的请求调用 `POST /api/sessions`
- **THEN** 201 的 `workspaceId` 为一个 32 位十六进制 id、`temporaryWorkspace` 为 `true`；`workspaces` 恰多一行 `temporary=1`、`dir` 与 `name` 都是 `tmp-<该 id>`；磁盘存在 `<SANDBOX_ROOT>/u1/tmp-<该 id>` 且 mode 为 `0o2770`；`GET /api/audit` 没有新增行；没有 omp 子进程

#### Scenario: 目录创建失败不留行
- **WHEN** 账号根下名为 `tmp-<将要生成的 id>` 的路径被一个普通文件占据（经测试注入的 id 生成器），调用无 body 的 `POST /api/sessions`
- **THEN** 响应为通用 5xx；`workspaces` 与 `chat_sessions` 都没有新行；该普通文件原样保留；本次调用新建的空目录（如有）已被移除

#### Scenario: 每个新会话各有自己的临时空间
- **WHEN** 同一账号连续两次无 body 创建会话
- **THEN** 两个会话的 `workspaceId` 不同，磁盘上是两个不同的 `tmp-…` 目录

### Requirement: 临时空间的可见性
工作空间 store 的 `list(ownerId)` 与 `GET /api/workspaces` SHALL NOT 返回 `temporary = 1` 的行（workspaces「列表与创建」）。`rootOf(principal, workspaceId)` SHALL 对临时空间与正式空间同样返回所有者的根，因此会话工作目录（session-metadata「绑定不可改与工作目录」）、`GET /api/workspaces/:id/tree`、`POST /api/workspaces/:id/dirs`、`GET /api/workspaces/:id/file`、`GET /api/commands?workspaceId=` 与 `GET /api/project-config?workspaceId=` 对所有者自己的临时空间 id SHALL 与正式空间行为一致；属他人的临时空间 id 与不存在的 id 一样 404。会话视图的 `temporaryWorkspace`（session-metadata「会话视图扩展键」）是 web 得知「这个会话用的是临时空间」的唯一来源。`POST /api/sessions` 显式携带一个临时空间的 `workspaceId`（即使属于调用者本人）SHALL 返回与不存在的 id 逐字相同的 404 `not_found`，不写任何行。

#### Scenario: 列表不含临时空间而按 id 可达
- **WHEN** 账号有一个正式空间 W 与一个临时空间 T（由无 body 创建会话产生），在 T 的根下放一个 `a.txt`，依次请求 `GET /api/workspaces`、`GET /api/workspaces/<T>/tree`、`GET /api/workspaces/<T>/file?path=a.txt`、`POST /api/workspaces/<T>/dirs {path:"out"}`
- **THEN** 列表恰含 W、不含 T；后三者分别为 200（`entries` 含 `a.txt`）、200（文件原字节）、201；第二个账号对 `<T>` 的同样三个请求均 404

#### Scenario: 不能显式绑定临时空间
- **WHEN** 所有者以 `{workspaceId:"<T>"}` 调用 `POST /api/sessions`
- **THEN** 404 `not_found`，信封与一个随机 32 位十六进制 id 的响应逐字相同；没有新的会话行

### Requirement: 转正
`POST /api/workspaces/:id/promote` SHALL 受 cookie guard 保护（未认证 401，先于 body 解析），响应 `Cache-Control: no-store`，属于 content-parser 归属集（body limit 16 KiB；content-parser 错误 400 `bad_request`）。`:id` 不存在或属他人 SHALL 404 `not_found`（先于 body 校验，二者不可区分）。body SHALL 恰为 `{name:string}`（多余键、非对象、`name` 非字符串 → 400）；`name` 的规则与 `POST /api/workspaces` 相同（trim 后 1..64 个 Unicode scalar，不含 U+0000–U+001F、U+007F 与孤立 surrogate），违反 → 400。`:id` 是调用者自己的**非临时**空间 SHALL 400 `bad_request`。合法请求 SHALL 在一个 SQLite 事务内以一条所有者作用域的 UPDATE 把该行的 `name` 置为给定名字、`temporary` 置 0（条件含 `temporary = 1`），并写一条 `workspace.promote` 审计（`actorId` 为所有者、`workspaceId` 为该空间 id、`title` 为 `另存为工作空间 <name>`、`detail={root:<该空间的绝对根>}`）；审计失败则 UPDATE 回滚。`(owner,name)` 冲突 SHALL 409 `conflict` 且不写任何行。成功 SHALL 返回 200 与五键工作空间对象 `{id,name,dir,root,createdAt}`：`id`、`dir`（仍为 `tmp-<id>`）、`root`、`createdAt` 与转正前相同。转正 SHALL NOT 移动、重命名或改写任何目录与文件，SHALL NOT 改动任何 `chat_sessions` 行、任何进程或快照；会话处于任何状态（含 `running`）时都可转正。

转正之后：`GET /api/workspaces` 列出该空间；绑定它的每个会话的视图 `temporaryWorkspace` 为 `false`、`workspaceId` 不变；删除这些会话不再删除该空间（「共用与随最后一个会话删除」只作用于 `temporary = 1`）；再次对它调用 promote 为 400。

#### Scenario: 原地转正
- **WHEN** 会话 S 用临时空间 T（根下有 `notes.md`），所有者 `POST /api/workspaces/<T>/promote {"name":"  调研资料  "}`
- **THEN** 200，`name` 为 `调研资料`，`dir` 为 `tmp-<T>`，`root` 与转正前相同；`notes.md` 的字节与 inode 不变；`GET /api/workspaces` 含该空间；`GET /api/sessions` 中 S 的 `workspaceId` 仍为 `<T>`、`temporaryWorkspace` 为 `false`；`GET /api/audit?limit=1` 为 `workspace.promote`，`title` 为 `另存为工作空间 调研资料`；S 随后的 prompt 其进程 probe 报告的 `cwd` 仍是同一根

#### Scenario: 运行中也可转正
- **WHEN** S 的回合进行中时对其临时空间调用 promote
- **THEN** 200；回合照常结束；没有进程被退役

#### Scenario: 冲突、非法与重复
- **WHEN** 账号已有名为 `项目A` 的空间，对 T promote `{"name":"项目A"}`；promote `{"name":""}`、`{"name":"x","dir":"y"}`、`[]`、malformed JSON；对一个正式空间 promote；T 转正成功后再次 promote
- **THEN** 依次为 409 `conflict`、四次 400 `bad_request`、400、400；除成功的那一次外 `workspaces` 行与审计都没有变化

#### Scenario: 鉴权
- **WHEN** 匿名请求、第二个账号对 `<T>`、任意账号对随机 id 调用 promote（含非法 body）
- **THEN** 分别 401、404、404（后两者逐字相同），无写入、无审计

### Requirement: 共用与随最后一个会话删除
fork 产生的会话 SHALL 继承源会话的 `workspace_id`（session-metadata「fork 继承会话元数据」），因此与源会话共用同一个临时空间，不复制目录。临时空间被哪些会话使用 SHALL 由 `chat_sessions.workspace_id` 等于它的行决定（含已归档的会话），不另存计数。`DELETE /api/sessions/:id` 在其删除事务内（session-metadata「会话删除」）SHALL 判定：被删会话的 `workspace_id` 指向 `temporary = 1` 的空间，且删除该会话行之后没有其它 `chat_sessions` 行引用它——成立时在**同一事务**内删除该空间行（其 `chat_turn_snapshots` 行随外键级联删除）并写一条 `workspace.delete` 审计（`actorId` 为所有者、`workspaceId` 为该空间 id、`title` 为 `删除临时空间`、`detail={root:<绝对根>, sessionId:<被删会话 id>}`）；不成立（空间非临时、会话未绑定、或还有别的会话在用）时空间行与目录 SHALL 不变。审计失败则整个删除事务回滚（会话行也保留）。事务提交之后 SHALL 按「临时空间目录的删除」移除目录。账号被删除时空间行随既有外键级联删除，目录不在本条范围内。

#### Scenario: 独占的临时空间随会话删除
- **WHEN** 会话 S 用临时空间 T（根下有文件与一层子目录），所有者删除 S
- **THEN** 204；`workspaces` 里没有 T；磁盘上 `tmp-<T>` 不存在；`GET /api/audit?limit=2` 依次含 `workspace.delete`（`title` `删除临时空间`、`detail.sessionId` 为 S）与 `session.delete`，顺序以实现为准但两条都在

#### Scenario: 共用时保留到最后一个会话
- **WHEN** S 与其 fork 产生的 F 共用临时空间 T，先删除 S，再删除 F
- **THEN** 删除 S 之后 T 的行与目录都在、目录内容不变，`F` 的 `workspaceId` 仍为 `<T>`，审计没有 `workspace.delete`；删除 F 之后 T 的行与目录都不存在，审计新增一条 `workspace.delete`

#### Scenario: 归档的会话仍算使用者
- **WHEN** S 与 F 共用 T，F 已归档，删除 S
- **THEN** T 的行与目录保留

#### Scenario: 转正后不再随会话删除
- **WHEN** T 已转正，随后删除绑定它的唯一会话
- **THEN** 204；该空间行与目录、文件都保留；审计没有 `workspace.delete`

#### Scenario: 审计失败时什么都不删
- **WHEN** 测试令删除事务中的 `workspace.delete` 审计写入失败
- **THEN** 响应为通用 5xx；会话行、空间行与目录都保留

### Requirement: 临时空间目录的删除
临时空间行在事务中被删除之后，宿主 SHALL 在提交后删除它的目录，且该删除是服务端内部操作，不经过沙箱 facade 的用户路径 resolve、不写 `sandbox_denied` 审计。步骤：
1. 取 `<SANDBOX_ROOT>/<ownerId>` 的 realpath 与目标 `<该 realpath>/tmp-<id>`；对目标 `lstat`（不跟随符号链接）：不存在视为成功；不是目录（含符号链接）SHALL NOT 删除任何东西，经服务错误通道报告一次。
2. 把目标 `rename` 为 `<OMP_STATE_DIR 的 realpath>/trash/<32 位随机 hex>`（omp-runtime「OMP_STATE_DIR 托管布局」的 app 私有目录），再对 trash 里的该项 `lstat`：是目录则在 trash 内递归删除（不跟随其内的符号链接），不是目录则只 `unlink` 该项并报告一次。
3. `rename` 以 `EXDEV` 失败（沙箱根与状态目录不在同一文件系统）时 SHALL 退为原地删除：再对目标 `lstat` 一次，仍是目录则原地递归删除（不跟随符号链接）。`rename` 以 `ENOENT` 失败时按「会话删除」的同名规则复查原位置。其它失败经服务错误通道报告且不触碰原位置。
4. 同时删除该空间的快照目录（workspace-snapshots「清理」）。

以上任何失败（含递归删除的部分失败）SHALL 只经服务错误通道报告，不改变 `DELETE` 的 204，错误通道自身的失败也不改变响应；残留目录不被任何行引用。递归删除 SHALL NOT 触及目标目录之外的任何路径：目标内指向外部的符号链接只删除链接本身。

#### Scenario: 经 trash 删除且不跟随链接
- **WHEN** 临时空间目录含嵌套子目录与一个指向沙箱外某文件的符号链接，其唯一会话被删除
- **THEN** 204；`tmp-<id>` 不存在；`<OMP_STATE_DIR>/trash` 为空；链接指向的外部文件字节不变；错误通道无报告

#### Scenario: 目标被换成符号链接
- **WHEN** 删除事务提交之后、目录删除之前，`tmp-<id>` 被换成指向账号根之外某目录的符号链接（经测试钩子注入）
- **THEN** 204；该符号链接与它的目标目录内容都保留；错误通道恰报告一次

#### Scenario: 跨文件系统退为原地删除
- **WHEN** 测试令 `rename` 以 `EXDEV` 失败
- **THEN** 204；`tmp-<id>` 已被原地递归删除；其内指向外部的符号链接的目标不变；错误通道无报告

#### Scenario: 删除失败不影响响应
- **WHEN** 目录内有一个 app 用户无法清空的子目录（mode `0500`、内含文件）
- **THEN** 204；空间行已删除；错误通道报告一次；残余位于 trash 之下而不在账号根下
