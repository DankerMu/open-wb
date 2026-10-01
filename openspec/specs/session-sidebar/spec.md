# session-sidebar Specification

## Purpose
定义 web 会话页在侧栏列表区与欢迎态的会话元数据呈现：「置顶任务 / 任务 / 空间」三分区互斥列表、纯前端状态×时间筛选、条目「更多」菜单（重命名 / 置顶 / 删除）与顶栏重命名入口、欢迎页场景胶囊与场景化快捷任务、欢迎态 composer footer 的工作空间选择，以及会话 DTO 八键严格解析。视觉与文案对照 `resource/workbuddy-live-demo.html`（下称 demo）标注的行号；与 demo 的有意偏差在各 Requirement 内留痕。
## Requirements
### Requirement: 会话 DTO 八键严格解析
web 的会话解析 SHALL 要求会话对象恰含八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`（`hasExactlyKeys`），并逐键校验：既有五键规则不变（`status` 含 A 的 `stopped`）；`scene` ∈ `office|code|design|null`；`workspaceId` 为 32 位小写十六进制字符串或 null；`pinnedAt` 为非负安全整数或 null。缺键、多余键或任一值不合法 SHALL 使该响应按既有规则视为无效成功响应（与其它 malformed success 相同的失败呈现，不部分采用）。该规则 SHALL 统一作用于 `GET /api/sessions` 列表项、`POST /api/sessions` 与 `PATCH /api/sessions/:id` 响应、消息快照的 `session` 与 fork 响应的 `session`。API 客户端 SHALL 新增 `patchSession(id, patch)`（`PATCH`，JSON body，成功 200 返回解析后的会话）与 `deleteSession(id)`（`DELETE`，无 body，成功恰为 204），`createSession(input?, options?)` SHALL 接受可选 input `{workspaceId?, scene?}` 并在提供时以 `application/json` 发送，`options` 为既有请求选项（含可选 `signal`）；三者沿用既有 same-origin、AbortSignal、错误信封与 401 通知机制，路径 id 编码。

#### Scenario: 八键接受与多余键拒绝
- **WHEN** `GET /api/sessions` 分别返回合法八键会话、缺 `pinnedAt` 的七键会话、多一个 `parentSessionId` 的九键会话、`scene:"chat"` 的会话
- **THEN** 第一种被接受并渲染；其余三种都使列表读取呈现既有的无效响应失败，不渲染任何部分列表

#### Scenario: 客户端新方法
- **WHEN** 调用 `patchSession(id,{pinned:true})`、`deleteSession(id)`、`createSession({scene:"code"})` 与无参 `createSession()`
- **THEN** 请求分别为 `PATCH /api/sessions/<id>` body `{"pinned":true}`、`DELETE /api/sessions/<id>` 无 body、`POST /api/sessions` body `{"scene":"code"}` 且 `Content-Type: application/json`、`POST /api/sessions` 无 body；`deleteSession` 对 200 视为无效响应

### Requirement: 分区侧栏
侧栏列表区（spa-shell「路由 IA 与侧栏」，`nav` accessible name `会话列表`）SHALL 保留既有 `新建会话` 按钮及其 accessible name（demo 的 `新建任务`（demo:1866）文案与分区标签上的 `+` 入口不采用，为有意偏差，既有 ui-walk 依赖该名称），并在其后渲染 `筛选任务` 按钮与分区列表（demo:1852-1898）。筛选后的会话 SHALL 按优先级 置顶 > 空间 > 任务 **互斥**归入恰一个分区，每个会话恰一个条目：
- `置顶任务`：`pinnedAt` 非 null 的会话；分区标签无计数（demo:1873）。
- `空间 (n)`：未置顶且 `workspaceId` 非 null 的会话，按工作空间分子组，子组标签为空间名；子组顺序为 `GET /api/workspaces` 的返回顺序；`workspaceId` 不在已读取空间列表中的会话归入标签为 `未知空间` 的末位子组（demo:1880-1889）。「已读取空间列表」为会话页最近一次成功读取的结果：首次读取完成之前与最近一次读取失败之后没有已读取列表（绑定会话全部归 `未知空间`）；重新读取进行中沿用上一次成功读取的列表，不把条目移入 `未知空间`。
- `任务 (n)`：其余会话（未置顶且未绑定），即 CONTEXT.md「任务」（demo:1878）。

每个分区与子组 SHALL 为带 accessible name 的 `role="group"`（名称分别为可见标签 `置顶任务`、`任务 (n)`、`空间 (n)`、子组的空间名）；`n` 为该分区筛选后的条目数（`空间` 计其全部子组条目之和）；空分区与空子组不渲染。各分区与子组内条目 SHALL 保持服务端列表顺序（`updatedAt` 降序、id 升序），分区顺序为 置顶任务 → 任务 → 空间（demo:1873-1889）。会话列表已读取而筛选后没有任何会话时（含账号尚无会话）SHALL 只渲染文本 `没有匹配的任务`（demo:1897），不渲染分区标签；会话列表读取中或读取失败时沿用 chat-web 既有的 `正在读取会话` 与错误提示，不渲染该文本。条目 SHALL 保留 chat-web「会话页」的选择按钮、标题回退 `新会话` 与状态元素。分区不可折叠；`助理任务` 分区（demo:1896）与项目/专家团分组 SHALL NOT 渲染；工作空间名只取自 `GET /api/workspaces`，前端不渲染空间根路径。

会话页 SHALL 在每次读取会话列表时并行读取 `GET /api/workspaces`；两个请求互不等待：会话列表到达即渲染，工作空间读取失败只影响归组（绑定会话归 `未知空间`），不产生列表区的错误提示，也不改变会话列表的读取结果。

#### Scenario: 三分区互斥归属
- **WHEN** 列表含：已置顶且绑定 W1 的 A、未置顶绑定 W1 的 B、未置顶绑定 W2 的 C、未绑定未置顶的 D 与 E（服务端顺序 E、D、C、B、A），空间列表顺序为 W2、W1
- **THEN** `置顶任务` 组只含 A；`任务 (2)` 组依次为 E、D；`空间 (2)` 组内先为子组 `W2`（C）再为子组 `W1`（B）；A 不在 `空间` 与 `任务` 中重复出现；分区顺序为 置顶任务、任务、空间

#### Scenario: 空状态与未知空间
- **WHEN** 账号没有会话；另一次列表有一个绑定 W 的会话而空间列表读取失败；再一次空间列表读取成功后重新读取而第二次读取尚未返回
- **THEN** 第一种列表区只显示 `没有匹配的任务` 且无分区标签；第二种该会话位于 `空间 (1)` 内标签为 `未知空间` 的子组，会话列表照常渲染且列表区无错误提示；第三种该会话仍在以空间名为标签的子组内

### Requirement: 状态与时间筛选
`筛选任务` 按钮（demo:1787，`Icon filter`）SHALL 打开 `Popover`，内含两个单选组：`状态`（`全部` / `进行中` / `已完成`）与 `时间`（`全部时间` / `今天` / `更早`）（demo:1828-1851；呈现为两个 `SegmentedControl` 分段控件而非 demo 的竖排菜单项，为有意偏差），每组为 accessible name 同组名的 `role="radiogroup"`，选项为 `role="radio"` 并以 `aria-checked` 表示选中，默认 `全部` 与 `全部时间`。选择立即作用于列表且弹层保持打开；Escape 关闭弹层并把焦点还给 `筛选任务`；点击弹层外部同样关闭弹层，但不把焦点归还 `筛选任务`（`Popover` 基元的非模态行为）。`筛选任务` 按钮与单选项 SHALL NOT 触发 `≤760px` 导航覆盖层的关闭。筛选 SHALL 纯前端计算，不发请求：`进行中` 为 `status="running"`；`已完成` 为 `status ∈ {done, failed, stopped}`（`idle` 只在 `全部` 下出现——与 demo「非 running 即已完成」（demo:1844）的有意偏差）；`今天` 为 `updatedAt` 的本地日历日等于当前本地日历日（当前时间取列表渲染时刻，不设定时器），`更早` 为其余。两组取交集。筛选状态为会话页内存状态：切换会话、折叠再展开侧栏、关闭再打开导航覆盖层均保留，刷新或离开会话页复位，不写 storage。筛选只影响侧栏条目，不改变当前选中会话及其主区内容。

#### Scenario: 状态与时间交集
- **WHEN** 列表含今天更新的 `running`、`done`、`idle` 会话各一个与昨天更新的 `failed`、`stopped` 会话各一个，依次选择 `进行中`、`已完成`、`已完成`+`今天`、`全部`+`更早`
- **THEN** 依次只显示 running 那个；done、failed、stopped 三个；done 一个；failed 与 stopped 两个；`idle` 只在 `全部` 且 `全部时间`/`今天` 下出现；全程无网络请求

#### Scenario: 无匹配与键盘关闭
- **WHEN** 选择 `进行中` 而无 running 会话，然后按 Escape
- **THEN** 列表区只显示 `没有匹配的任务`；弹层关闭且焦点在 `筛选任务`；当前选中会话的主区内容不变

#### Scenario: 筛选跨覆盖层保留
- **WHEN** 在 `≤760px` 打开 `导航` 覆盖层，打开 `筛选任务` 选择 `已完成`，按 Escape，再选择列表中的一个会话（覆盖层关闭），随后重新打开覆盖层
- **THEN** 选择单选项与按 Escape 都不关闭覆盖层（Escape 只关闭弹层）；重新打开后列表仍只含 `done`/`failed`/`stopped` 会话，再次打开 `筛选任务` 时 `已完成` 为选中

