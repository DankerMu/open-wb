## MODIFIED Requirements

### Requirement: 路由 IA 与侧栏
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与四个导航入口；视觉参考 demo，标签与说明仅表达已实现的功能，不宣传挂载等未交付能力。`/` 渲染 chat-web 规定的会话页（当前会话由 `?session=<id>` 表示；页面级 heading 归属见下文顶栏段）；`/center` 明确展示暂不可用状态，不提供虚假功能按钮；`/files` 渲染 files-web 规定的工作空间页（heading `工作空间`，当前空间以 `?ws=<id>` 表示），routeManifest 描述及 routes/ui-walk 既有断言 SHALL 随真实页面同步更新；`/center` 为扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。**侧栏**（demo:232-300, 1773-1822）SHALL 宽 `288px`，每个导航项为 `Icon`（`routeManifest[].icon`：`message-square`/`folder`/`layout-grid`/`settings`）+ 标签 + 可选副标签（仅 `/files` 为 `文件·预览`，其余路由无副标签直到有真实内容），当前项高亮；顶部为品牌区（自有 mark + 字标 `WorkBuddy`，不使用上游 logo 资产）与折叠按钮（accessible name `折叠侧栏`/`展开侧栏`），折叠态宽 `48px` 只显示图标（每项保留 `aria-label` 为标签文本）并以 `Tooltip` 显示标签，折叠状态持久化在 `localStorage` key `workbuddy-sidebar`（`expanded|collapsed`，读取失败或值不合法按 expanded，写入失败静默并保留内存状态）；底部为用户区（aside 内 `<footer>`）：头像圆标（`account` 首字符大写）+ 逐字展示当前 Principal 的 `account` 与 `role`（前端不伪造 display name/部门或角色映射），整块为触发按钮（accessible name `用户菜单`），点击打开 `Menu`，菜单项**只有** `退出登录`（沙箱信息、账号与隔离、切换账号、铃铛无后端，不渲染）；退出请求进行中触发按钮保持可用，再次选择 `退出登录` 打开的确认框其确认按钮处于忙碌禁用态、取消按钮文案为 `关闭`（重复退出被锁定）。**会话列表区**（demo:274、1797、1852）：`/` 路由下侧栏 SHALL 在主导航与用户区之间渲染会话页经 shell 槽位提供的列表区（`新建会话` 与平铺会话列表；列表内容、数据与行为归 chat-web `会话页`，shell 只提供槽位、不读取 chat 数据层），文档流侧栏中列表区独立滚动、用户区固定在底部（覆盖层沿用 Drawer 主体整体滚动）；其它路由不渲染列表内容；折叠态（`48px`）不渲染列表区（demo:241）；`≤760px` 覆盖层内列表区位于主导航之后，选择会话或 `新建会话` 后覆盖层关闭并按导航项关闭规则归还焦点，覆盖层关闭时列表不在 DOM 中。**顶栏**（demo:313-322, 1928-1963）SHALL 由 shell 渲染为 `main` 之外的 `<header>`（隐式 `role=banner`）、高 `56px`，三态：`≤760px` 时三态都在顶栏最左渲染 `打开导航` 按钮（accessible name 固定，`Icon` `menu`）；`/` 无当前会话时 `≥761px` 不渲染顶栏、`≤760px` 只渲染含 `打开导航` 的窄条（无 heading）；`/` 有当前会话时显示面包屑 `我的工作 / <会话标题>`（标题来自服务端 title 或 `新会话`，由会话页经 `useTopbar({ breadcrumb })` 上报，shell 不读取 chat 数据层；无重命名/搜索/更多按钮直到对应阶段）；其它路由显示 `routeManifest[].title`（`工作空间`/`中心`/`设置`）。**页面级 level-1 heading 归属**：`/` 欢迎态为 chat-web 渲染的 hero `WorkBuddy，我帮你`；`/` 有会话时为顶栏面包屑容器（heading level 1，accessible name `我的工作 / <标题>`）；其它路由为顶栏页面标题；除欢迎态 hero 外页面自身不再渲染页面级 `<h1>`，内容区（Markdown 预览、助手正文）内的 heading 不受此限，heading 断言以 banner 或 hero 定位。**响应式**（demo:305-310；外壳唯一断点 `760`，`≤900px` 文件页树栏宽度由 files-web 规定，demo 的 1100 断点只作用于 `/center` 面板、不在 S1e 范围）：`≤760px`（媒体查询 `(max-width: 760px)`，无 `matchMedia` 的环境按宽屏处理）侧栏不在文档流中渲染，改由顶栏 `打开导航` 按钮打开的 `Drawer side="left" width=288`（对话框 accessible name `导航`）承载：默认关闭；覆盖层内侧栏始终为展开态（标签与副标签可见，不渲染品牌区与折叠按钮）；选择任一导航项后关闭，Escape、遮罩与 `关闭` 亦关闭，关闭后焦点归还 `打开导航`；开合是瞬时状态，不读取也不写入 `workbuddy-sidebar`（桌面折叠偏好原样保留）；关闭时导航项不在 DOM 中（不可聚焦），用户区随之卸载，但退出请求进行中的锁定态（忙碌禁用的确认按钮、`关闭` 文案、状态提示）SHALL 不因关闭并重开覆盖层或视口跨越 `760` 而丢失；`≥761px` 不挂载 Drawer 也不渲染 `打开导航`；视口跨越 `760` 时即时切换，切回宽屏时覆盖层关闭且再次进入窄屏不得处于打开态；主区在 `≤760px` 占满宽度，任何视口无横向溢出。退出 SHALL 先显示可访问模态确认框：标题 `退出登录？`、说明退出后的登录状态与任务保留语义、按钮 `取消`/`退出`；取消不发请求，确认只调用一次 Provider-owned logout。其余 demo 用户菜单项延后见 proposal Non-goals。

#### Scenario: 视觉与键盘可用性
- WHEN 浏览器在桌面和390px窄屏打开登录及四个路由，并切换浅色/深色主题
- THEN 使用本地构建的统一样式与带来源的设计token，桌面侧栏与主区并排，390px 时侧栏为 `导航` 覆盖层、`打开导航` 在含欢迎态的每个路由可达且页面无横向溢出；焦点/禁用/忙碌/错误状态可辨，不请求公网字体或资源
- AND 退出模态打开时聚焦取消，Tab循环留在框内，Escape关闭并恢复到可用控件；提交中允许关闭窗口以避免网络停滞锁死应用，明确关闭不会撤销已发送的退出请求，重复退出仍被锁定
- AND 已发送的退出请求优先于普通服务信息读取；退出进行中进入设置页不得中断该请求，服务信息可暂不可用，当前会话的退出成功仍进入登录页

#### Scenario: 顶栏三态
- WHEN 依次访问 `/`（无会话）、`/?session=<id>`、`/files`
- THEN 第一态 `≥761px` 无顶栏、`≤760px` 顶栏只含 `打开导航`（无 heading），页面 level-1 heading 为 `WorkBuddy，我帮你`；第二态顶栏面包屑容器为 level-1 heading，accessible name `我的工作 / <服务端标题>`（无标题时 `我的工作 / 新会话`），离开该会话或路由后面包屑随即清空（含会话页不卸载、仅移除 `?session=` 的情况）；会话已选但标题尚未从列表或快照得知时 `≥761px` 既无顶栏也无 hero、`≤760px` 顶栏只含 `打开导航`（无 heading）且无 hero；第三态顶栏 heading level 1 为 `工作空间` 且页面主区无第二个页面级 level 1 heading（文件预览内 Markdown 的 `<h1>` 不计）

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN `/` 显示会话页（欢迎态 hero `WorkBuddy，我帮你`）与输入框、侧栏列表区含会话列表与 `新建会话`，`/files` 显示工作空间页、空间切换器与目录树区，`/center` 保持占位壳，`/settings` 保持设置页；侧栏高亮当前 tab，无浏览器控制台报错

#### Scenario: 侧栏折叠与用户菜单
- WHEN 点击折叠按钮、reload、再展开；随后打开用户菜单
- THEN 折叠后侧栏宽 48px、导航只显示图标、列表区不渲染且 hover/聚焦出现 Tooltip 标签，`localStorage.workbuddy-sidebar=collapsed`，reload 保持折叠；展开后宽 288px 且 storage 为 `expanded`；菜单只含 `退出登录` 一项，Escape 关闭并恢复触发器焦点

#### Scenario: 窄屏导航覆盖层
- WHEN jsdom 以 `(max-width: 760px)` 匹配的 `matchMedia` mock 挂载已认证应用于 `/`、点击顶栏 `打开导航`，在覆盖层中选择 `工作空间`，随后再打开并按 Escape；再在覆盖层内经 `用户菜单` → `退出登录` → `退出` 发起一个挂起的退出请求，Escape 关闭确认框与覆盖层后重开
- THEN 挂载时无文档流侧栏、无 `dialog`、无 `主导航`，顶栏只含 `打开导航`，唯一 level-1 heading 为 hero；点击后出现 accessible name `导航` 的 `dialog`，其内主导航四项标签可见、其后为会话列表区且无折叠按钮；选择后 `dialog` 消失、顶栏 heading 为 `工作空间`、焦点回到 `打开导航`、应用根节点不再 `aria-hidden`；Escape 同样关闭并归还焦点；覆盖层内 `用户菜单` 可打开且选择 `退出登录` 弹出确认框时覆盖层保持打开；退出请求挂起期间关闭确认框与覆盖层再重开，确认框仍为忙碌禁用 + `关闭`、状态提示仍在且不再发请求

#### Scenario: 覆盖层不触碰折叠偏好
- WHEN `localStorage.workbuddy-sidebar=collapsed` 时在 `≤760px` 打开覆盖层并选择路由，随后媒体查询 change 为不匹配，再 change 回匹配
- THEN 覆盖层始终为展开态、storage 值仍为 `collapsed` 且无任何写入；切回宽屏后文档流侧栏以折叠态渲染、覆盖层与 `打开导航` 消失；再次进入窄屏时覆盖层处于关闭态

#### Scenario: 退出登录
- WHEN 点击侧栏用户区触发按钮 `用户菜单`、在 `Menu` 中选择 `退出登录` 并在确认框选择 `退出`
- THEN 恰调用一次 `POST /api/auth/logout`；204 或 current 401 均清空 Principal，会话页的连接随卸载关闭，并在保持当前 pathname/search/hash 不变时渲染登录页

#### Scenario: 取消退出
- WHEN 打开退出确认框后选择 `取消`
- THEN 关闭确认框，不调用 logout，原 Principal 与受保护壳保持不变

#### Scenario: 退出请求失败
- WHEN logout 返回非 401 错误、非 204 的成功 status 或网络失败
- THEN 保留原 Principal 与受保护壳；LoginForm 专用 error 保持 null，独立 authenticated `logoutError` 在用户区显示合法信封 message 或稳定回退 `请求失败，请稍后重试`，并允许重试

#### Scenario: 侧栏会话列表区
- WHEN 已登录用户在 1440 宽打开 `/` 并新建一个会话；再折叠侧栏；随后在 `≤760px` 打开 `打开导航` 覆盖层、选择列表中另一会话，再打开覆盖层点击 `新建会话`
- THEN 宽屏展开态 `新建会话` 与 `会话列表` 位于 `aside[aria-label="侧栏"]` 内 `主导航` 之后、用户区之前，`main` 内没有它们；折叠后列表区不渲染；覆盖层内选择后 URL 写入该 `?session=`、覆盖层关闭、焦点回到 `打开导航`；`新建会话` 同样关闭覆盖层；覆盖层关闭时列表不在 DOM 中；`/files`、`/center`、`/settings` 的侧栏无列表内容
