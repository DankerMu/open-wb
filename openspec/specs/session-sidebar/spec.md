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

每个分区与子组 SHALL 为带 accessible name 的 `role="group"`（名称分别为可见标签 `置顶任务`、`任务 (n)`、`空间 (n)`、子组的空间名）；`n` 为该分区筛选后的条目数（`空间` 计其全部子组条目之和）；空分区与空子组不渲染。各分区与子组内条目 SHALL 保持服务端列表顺序（`updatedAt` 降序、id 升序），分区顺序为 置顶任务 → 任务 → 空间（demo:1873-1889）。会话列表已读取而筛选后没有任何会话时（含账号尚无会话）SHALL 只渲染文本 `没有匹配的任务`（demo:1897），不渲染分区标签；会话列表读取中或读取失败时沿用 chat-web 既有的 `正在读取会话` 与错误提示，不渲染该文本。条目 SHALL 保留 chat-web「会话页」的选择按钮、标题回退 `新会话` 与状态元素，并在行尾增加「更多」触发按钮（见「会话条目菜单与重命名」）。分区不可折叠；`助理任务` 分区（demo:1896）与项目/专家团分组 SHALL NOT 渲染；工作空间名只取自 `GET /api/workspaces`，前端不渲染空间根路径。

会话页 SHALL 在每次读取会话列表时并行读取 `GET /api/workspaces`；两个请求互不等待：会话列表到达即渲染，工作空间读取失败在列表区只影响归组（绑定会话归 `未知空间`），不产生列表区的错误提示，也不改变会话列表的读取结果；欢迎态 composer footer 对读取中与读取失败的呈现见「composer footer 工作空间选择」。

#### Scenario: 三分区互斥归属
- **WHEN** 列表含：已置顶且绑定 W1 的 A、未置顶绑定 W1 的 B、未置顶绑定 W2 的 C、未绑定未置顶的 D 与 E（服务端顺序 E、D、C、B、A），空间列表顺序为 W2、W1
- **THEN** `置顶任务` 组只含 A；`任务 (2)` 组依次为 E、D；`空间 (2)` 组内先为子组 `W2`（C）再为子组 `W1`（B）；A 不在 `空间` 与 `任务` 中重复出现；分区顺序为 置顶任务、任务、空间

#### Scenario: 空状态与未知空间
- **WHEN** 账号没有会话；另一次列表有一个绑定 W 的会话而空间列表读取失败；再一次空间列表读取成功后重新读取而第二次读取尚未返回
- **THEN** 第一种列表区只显示 `没有匹配的任务` 且无分区标签；第二种该会话位于 `空间 (1)` 内标签为 `未知空间` 的子组，会话列表照常渲染且列表区无错误提示；第三种该会话仍在以空间名为标签的子组内

#### Scenario: 置顶与取消置顶后的移动
- **WHEN** 对 `任务` 中的会话执行置顶，再执行取消置顶
- **THEN** 置顶后它只出现在 `置顶任务`、`任务` 计数减一；取消后回到 `任务` 中其服务端顺序位置

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

#### Scenario: 覆盖层内的筛选弹层在覆盖层之上
- **WHEN** 在真实浏览器 390×844 打开 `导航` 覆盖层，再打开 `筛选任务`
- **THEN** 弹层画在覆盖层的遮罩与面板之上：两个单选组可见，单选项能被真实指针点中（命中测试不被遮罩或面板拦截），选择后 `aria-checked` 随之变化且覆盖层仍打开（取证：chat-harness「UI 走查会话元数据」第 6 步的 `mobile-dark`）

### Requirement: 会话条目菜单与重命名
每个条目 SHALL 有 accessible name 为 `更多操作：<显示标题>` 的图标按钮（`Icon more-horizontal`），它是选择按钮的同级元素（不嵌套），始终在 DOM 中且可聚焦（demo:296-297 的「悬停才出现」不采用：触屏与键盘不可达，为有意偏差；`≥761px` 且支持悬停的设备上仅以透明度弱化，悬停、聚焦或菜单打开时显现）。它打开 `Menu`，菜单项依次为 `重命名`（`Icon pencil`）、`置顶任务` 或 `取消置顶`（按该会话 `pinnedAt` 是否为 null，`Icon star`）、`删除`（`Icon trash`，danger）（demo:1909-1921）；`导出记录` SHALL NOT 渲染，菜单恰这三项。三项对任何状态（含 `running`）的会话均可用。「更多」按钮与菜单项 SHALL NOT 触发 `≤760px` 导航覆盖层的关闭。
- `重命名`：打开 `Dialog`，标题 `重命名任务`，含 accessible name `任务名称` 的输入框（初值为服务端 title，null 时为空；打开时焦点在输入框）与按钮 `取消` / `保存`（demo:3795-3801）；trim 后为空时 `保存` 禁用；`保存` 或输入框内 Enter 以 trim 后的文本发送一次 `PATCH {title}`，请求中 Dialog 忙碌：`保存` 禁用、不重复发送；200 后关闭 Dialog 并把焦点还给打开它的按钮，列表条目与顶栏面包屑以响应视图的标题更新，`Toast` `已重命名`；失败时 Dialog 保持打开并在其内以 `role="alert"` 显示信封 message（非信封失败为 `请求失败，请稍后重试`），再次提交时清除该提示。请求中 `取消`、`关闭`、Escape 与遮罩仍可关闭 Dialog（网络停滞时不锁死页面，同 spa-shell 退出确认的先例），请求不取消：其后的 200 照常更新列表与面包屑并 `Toast` `已重命名`，失败则以 `Toast` 显示同一 message（被同一会话更新的重命名请求取代的响应除外，见下）；关闭后再次打开的 Dialog 是全新状态，不受先前请求的结果影响（不被其关闭、不显示其错误）。
- `置顶任务` / `取消置顶`：发送 `PATCH {pinned:true|false}`；200 后以响应视图的 `pinnedAt` 更新列表并 `Toast` `已更新置顶状态`；失败时以 `Toast` 显示信封 message（非信封失败为 `请求失败，请稍后重试`）且列表不变。
- `删除`：打开 `ConfirmDialog`，标题 `删除任务`，说明 `确定要删除「<显示标题>」吗？删除后不可恢复。`，确认按钮 `删除`（danger）与 `取消`（demo:1918）；`取消` 或 Escape 关闭确认框且不发请求，焦点回到打开它的「更多」按钮。确认发送一次 `DELETE`（无 body），请求中确认按钮忙碌禁用、不重复发送（运行中会话的删除可能持续到停止有界退回完成）。请求中确认框仍可关闭（网络停滞时不锁死页面，同 spa-shell 退出确认的先例）：取消按钮文案改为 `关闭`，框内显示 `删除请求已发送，关闭窗口不会撤销请求。`；请求不取消，其间再次对同一会话打开的确认框仍处于这一忙碌状态（重复删除被锁定）。204 后从列表移除该会话、关闭为该会话打开的确认框与重命名 Dialog 并 `Toast` `任务已删除`；若响应到达时它是当前选中会话，页面 SHALL 关闭其事件流连接、以 replace 移除 `?session=`（保留其它 search/hash，pathname 为 `/`）并回到欢迎态（hero `WorkBuddy，我帮你`），不显示错误、不再读取该会话的消息；删除非当前会话不改变 URL 与主区。失败时关闭为该会话打开的确认框、以 `Toast` 显示信封 message（如 409 `会话正在生成，请稍候`；非信封失败为 `请求失败，请稍后重试`）并重新读取会话列表。

以响应视图更新 SHALL 只采用响应中该请求所修改的那个键（重命名取 `title`，置顶取 `pinnedAt`），不覆盖该条目的其它键（迟到的响应不得把已刷新的 `status`、或另一类请求刚写入的标题/置顶改回旧值）；同一会话有多个进行中的同类请求时只采用最后发出的那个请求的响应，被取代的响应不更新也不提示；账号切换或离开会话页之后到达的响应 SHALL 被丢弃（不更新列表、不提示）；删除的响应同样如此（不移除条目、不提示、不导航、不重新读取列表）。

顶栏第二态（有当前会话且标题已知）SHALL 经 spa-shell 的 `useTopbar` `actions` 插槽渲染 accessible name 与 Tooltip 均为 `重命名` 的图标按钮（`Icon pencil`，demo:1942），打开同一重命名 Dialog 作用于当前会话；会话页注入的顶栏按钮次序由有序常量 `CHAT_TOPBAR_ACTIONS` 固定为 `重命名`、`对话内搜索`、`产物面板`，页面只从该常量按序构造 `actions`，三个槽位都产出按钮（`对话内搜索` 归 conversation-search，`产物面板` 归 turn-artifacts）；顶栏 `更多`（demo:1954）SHALL NOT 渲染；欢迎态不上报 `actions`。

#### Scenario: 从条目菜单重命名
- **WHEN** 对当前选中会话打开 `更多操作：<标题>` → `重命名`，把输入改为 `  周报整理  ` 并点击 `保存`
- **THEN** 发出一次 `PATCH` body `{"title":"周报整理"}`；Dialog 关闭、焦点回到该条目的「更多」按钮；条目与顶栏 heading `我的工作 / 周报整理` 更新；出现 `Toast` `已重命名`；输入全空白时 `保存` 为禁用；输入框内 Enter 等价于 `保存`

#### Scenario: 重命名失败保留对话框
- **WHEN** PATCH 返回 400 信封 `请求格式不正确`
- **THEN** Dialog 仍打开，其内 `role="alert"` 文本恰为 `请求格式不正确`，列表标题不变

#### Scenario: 重命名请求中
- **WHEN** 点击 `保存` 而 PATCH 尚未返回，期间再次提交，然后点击 `取消`；随后响应 200 到达
- **THEN** 请求中 `保存` 为禁用、没有第二个 PATCH；`取消` 关闭 Dialog；响应到达后条目与面包屑更新并出现 `Toast` `已重命名`
- **WHEN** 同样在请求中关闭 Dialog，而响应为 400 信封 `请求格式不正确`
- **THEN** 列表标题不变，出现 `Toast` `请求格式不正确`

#### Scenario: 顶栏重命名入口
- **WHEN** 打开 `/?session=<id>` 且标题已知
- **THEN** banner 内 heading 之后依次有 `重命名`、`对话内搜索`、`产物面板` 三个按钮且无 `更多`（该会话的项目配置列表为空时；非空时 `重命名` 之前另有 `项目配置`，chat-web「会话页」）；点击 `重命名` 打开 `重命名任务` Dialog，输入初值为该会话标题；欢迎态顶栏无这些按钮

#### Scenario: 置顶菜单文案与提示
- **WHEN** 对未置顶会话选择 `置顶任务`，再打开同一条目菜单
- **THEN** 发出 `PATCH {"pinned":true}`，出现 `Toast` `已更新置顶状态`，条目移入 `置顶任务`；再次打开的菜单项文案为 `取消置顶`；菜单中无 `导出记录`

#### Scenario: 迟到的元数据响应
- **WHEN** 对 `running` 会话发出置顶请求，响应返回前会话列表被重新读取且该会话已为 `done`，随后置顶响应（视图中 `status` 仍为 `running`）到达
- **THEN** 条目移入 `置顶任务` 且状态仍为 `已完成`

#### Scenario: 删除当前会话
- **WHEN** 对当前选中且 `running` 的会话选择 `删除`，确认框文案为 `确定要删除「<标题>」吗？删除后不可恢复。`，点击 `删除`
- **THEN** 发出一次 `DELETE`；请求中确认按钮忙碌禁用；204 后条目消失、`Toast` `任务已删除`、URL 的 pathname 为 `/` 且不含 `?session=`（其它 search/hash 保留）、页面为欢迎态（hero `WorkBuddy，我帮你` 可见）且无错误提示，事件流连接已关闭
- **WHEN** 删除一个非当前选中的会话
- **THEN** 204 后该条目消失、`Toast` `任务已删除`，URL 与主区当前会话不变
- **WHEN** 选择 `取消`，或 DELETE 返回 409
- **THEN** 前者不发请求；后者确认框关闭、`Toast` 显示 `会话正在生成，请稍候`，列表被重新读取

#### Scenario: 删除请求中
- **WHEN** 确认删除而 DELETE 尚未返回，点击 `关闭`，再从菜单对同一会话选择 `删除`；随后响应 204 到达
- **THEN** 请求中取消按钮文案为 `关闭`；重新打开的确认框其确认按钮仍忙碌禁用，没有第二个 DELETE；204 后确认框关闭、条目消失并出现 `Toast` `任务已删除`
- **WHEN** 删除请求发出时当前会话是它，响应到达前已切到另一会话
- **THEN** 204 后条目消失、`Toast` `任务已删除`，URL 与主区停在另一会话

### Requirement: 欢迎页场景胶囊与场景化快捷任务
欢迎态 SHALL 在 hero 与快捷任务行之间渲染场景胶囊组（accessible name `场景` 的 `role="group"`），三个按钮 `日常办公` / `代码开发` / `创意设计`（对应 `office` / `code` / `design`，图标分别为 `file-text` / `code` / `palette`），以 `aria-pressed` 表示选中，默认 `日常办公`（demo:1221-1225、2540-2542）。选择另一场景 SHALL 更新 `aria-pressed`、把快捷任务行替换为该场景的清单（标签与 prompt 取自 demo `SCENES[k].quick` 与 `QUICK_PROMPTS`，demo:1221-1239；图标只用已注册键：`日常办公` 六项沿用既有图标，`代码开发` 五项只用 `code`/`file-code`/`layout-grid`，`创意设计` 五项只用 `palette`/`image`/`file-text`），并显示 info `Toast` `已切换到「<场景名>」场景`（demo:2652-2663）；再次点击已选场景不改变状态、不显示 Toast。快捷任务的点击行为（只填草稿、不发送）与 composer 锁定期间禁用的规则同样适用于场景胶囊。选中场景为会话页内存状态（选中会话后再回到欢迎态保留；刷新或离开会话页复位为 `日常办公`）。

会话页由欢迎态首次发送或侧栏 `新建会话` 创建会话时，SHALL 以 `POST /api/sessions` body `{scene:<选中场景>}` 发送，当 composer footer 的按钮显示着某个工作空间时同时带它的 `workspaceId`，显示 `未选择` 时 body 不含 `workspaceId` 键（见「composer footer 工作空间选择」）；两条创建路径的 body 相同。场景只决定新会话的 `scene` 与欢迎页快捷任务清单，SHALL NOT 改变模型、工具面或 prompt 内容（与 F-CHAT-1「决定默认专家与工具面」的有意偏差）；会话内切换场景的入口不渲染（归 S1d）。

#### Scenario: 场景切换替换快捷任务
- **WHEN** 欢迎态点击 `代码开发`
- **THEN** `代码开发` 的 `aria-pressed="true"`、其余为 `false`；快捷任务行恰为 `日常开发`、`网站开发`、`Agent 应用`、`Skill 开发`、`CI/CD`；出现 `Toast` `已切换到「代码开发」场景`；点击 `网站开发` 后输入框草稿为 `帮我搭建一个内部系统首页` 且未发送

#### Scenario: 场景随创建请求发送
- **WHEN** 选中 `创意设计` 后在欢迎态输入并发送，另一次在默认场景下点击侧栏 `新建会话`
- **THEN** 前者的 `POST /api/sessions` body 为 `{"scene":"design"}`，后者为 `{"scene":"office"}`，均为 `application/json`；新会话视图的 `scene` 与之相同

### Requirement: composer footer 工作空间选择
欢迎态 composer（且仅欢迎态；有当前会话时不渲染）SHALL 在 composer 卡片末尾（卡片内、工具栏之后）渲染 footer，内含一个按钮，可见文本与 accessible name 为 `任务启动于 <空间名>`，未选择时为 `任务启动于 未选择`（`Icon folder`，demo:2579-2582）。footer SHALL NOT 渲染权限元素（demo 的 `权限 默认权限|完全访问` 不渲染，归 S3b）。点击按钮 SHALL 打开 `Popover`（demo:3588-3606），内含：accessible name 与 placeholder 为 `搜索工作空间` 的搜索输入框；选项 `未选择`；以及会话页已读取的该账号工作空间列表中的每个空间（按 `GET /api/workspaces` 的返回顺序；打开弹层不另发请求），显示空间名与 ADR-0011 逻辑路径 `<account>/<dir>`（`account` 取当前 Principal；不渲染空间根路径）。输入框按空间名做大小写不敏感子串过滤（查询先去掉首尾空白；`未选择` 始终保留），无匹配时显示 `没有匹配的工作空间`；每次打开弹层查询为空。当前选中项 SHALL 以 `aria-pressed="true"` 标示。选择任一项 SHALL 关闭弹层、更新按钮文本并把焦点还给按钮；`新建工作空间` 与 `挂载目录到当前空间`（demo:3601-3602）SHALL NOT 渲染。没有可用的空间列表时弹层按最近一次读取的状态呈现：读取在途（首次读取，或失败后的重新读取）显示 `正在读取工作空间`；读取失败显示 `role="alert"` 的信封 message 或 `请求失败，请稍后重试`；两种情况下仍可选 `未选择`。选中空间为会话页内存状态（选中会话后再回到欢迎态保留；刷新或离开会话页复位为未选择），作用于其后由欢迎态发送与侧栏 `新建会话` 发起的创建请求（`workspaceId`）。选中的空间不在当前已读取的列表中时（列表被重新读取后它已不存在、读取失败或换了账号）按钮显示 `任务启动于 未选择` 且创建请求不带 `workspaceId`——按钮文本与请求体始终一致。composer 锁定期间按钮禁用，已打开的弹层随之关闭且解锁后不自动重开。

#### Scenario: 选择空间后创建绑定会话
- **WHEN** 账号 `zhangsan` 有空间 `项目A`（dir `项目A`）与 `客服`，欢迎态打开 `任务启动于 未选择`，在 `搜索工作空间` 输入 `项目`，选择 `项目A`，再输入并发送
- **THEN** 弹层只列 `未选择` 与 `项目A`（副文本 `zhangsan/项目A`）；选择后按钮文本为 `任务启动于 项目A`、焦点在该按钮；`POST /api/sessions` body 为 `{"scene":"office","workspaceId":"<项目A 的 id>"}`；新会话出现在侧栏 `空间 (1)` 的 `项目A` 子组内；footer 随会话被选中而消失

#### Scenario: 无权限元素与无匹配
- **WHEN** 欢迎态查看 footer 并在弹层中搜索 `不存在`
- **THEN** footer 只含 `任务启动于` 按钮，无 `权限`、`完全访问` 或 `默认权限` 文本；弹层显示 `未选择` 与 `没有匹配的工作空间`，无 `新建工作空间` 与 `挂载目录到当前空间`

