# Spec delta: spa-shell（S1e 修改）

> 按仓内先例整段重述三个 Requirement（`路由 IA 与侧栏`、`登录页与路由守卫`、`设置页`，含全部 Scenario），归档时整段替换。`web 构建工具链` 不变。demo 行号指 `resource/workbuddy-live-demo.html`。

## MODIFIED Requirements

### Requirement: 路由 IA 与侧栏
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与四个导航入口；标签与说明仅表达已实现的功能，不宣传挂载等未交付能力。`/` 渲染 chat-web 规定的会话页（当前会话由 `?session=<id>` 表示）；`/center` 明确展示暂不可用状态，不提供虚假功能按钮；`/files` 渲染 files-web 规定的工作空间页（当前空间以 `?ws=<id>` 表示），routeManifest 描述及 routes/ui-walk 既有断言 SHALL 随真实页面同步更新；`/center` 为扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。

外壳 SHALL 由 `AppShell` 提供：**侧栏**（demo:232-300, 1773-1822）宽 `288px`，每个导航项为 `Icon`（`message-square`/`folder`/`layout-grid`/`settings`）+ 标签 + 副标签（`/files` 为 `文件·预览`，`/center` 无副标签直到有真实 tab），当前项高亮；顶部为品牌区（自有 mark + 字标 `WorkBuddy`，不使用上游 logo 资产）与折叠按钮，折叠态宽 `48px` 只显示图标（每项保留 `aria-label` 为标签文本）并以 `Tooltip` 显示标签，折叠状态持久化在 `localStorage` key `workbuddy-sidebar`（`expanded|collapsed`，读取失败按 expanded，写入失败静默并保留内存状态）；底部为用户区（aside 内 `<footer>`）：头像圆标（`account` 首字符大写）+ 逐字 `account`/`role`（前端不伪造 display name/部门），整块为触发按钮（accessible name `用户菜单`），点击打开 `Menu`，菜单项**只有** `退出登录`（铃铛、沙箱信息、账号与隔离、切换账号无后端，不渲染）。**顶栏**（demo:313, 1928-1999）高 `56px`，三态：`/` 无当前会话时 `≥761px` 整条隐藏、`≤760px` 只渲染含 `打开导航` 按钮的窄条（无标题）；`/` 有当前会话时显示面包屑 `我的工作 / <会话标题>`（标题来自服务端 title 或 `新会话`，无重命名/搜索/更多按钮直到对应阶段）；其它路由显示页面标题（`工作空间`/`中心`/`设置`）。**页面级 level-1 heading 归属**：`/` 欢迎态为 chat-web 的 hero `WorkBuddy，我帮你`；`/` 有会话时为顶栏面包屑容器（heading level 1，accessible name `我的工作 / <标题>`）；其它路由为顶栏页面标题；除欢迎态 hero 外页面自身不再渲染页面级 `<h1>`，内容区（Markdown 预览、助手正文）内的 heading 不受此限。**响应式**两档（demo:723, 305-310；demo 的 1100 断点只作用于 `/center` 面板，不在 S1e 范围）：`≤900px` files 树栏 `210px`；`≤760px` 侧栏改为覆盖层（`Drawer side="left"` 宽 `288px`，默认关闭，顶栏左侧汉堡按钮 `打开导航` 打开，选择路由后关闭；覆盖层始终为展开态且开合为瞬时状态、不读写 `workbuddy-sidebar`；隐藏时导航项不可聚焦），主区占满宽度，任何视口无横向溢出。

退出 SHALL 先显示 `ConfirmDialog`：标题 `退出登录？`、说明退出后的登录状态与任务保留语义、按钮 `取消`/`退出`；取消不发请求，确认只调用一次 Provider-owned logout。其余 demo 用户菜单项延后见 proposal Non-goals。

#### Scenario: 视觉与键盘可用性
- WHEN 浏览器在 1440、1024、390 三档宽度打开登录及四个路由，并切换浅色/深色主题
- THEN 使用本地构建的统一样式与带来源的设计 token（全部经 ui-primitives），1440/1024 时侧栏与主区并排，390 时侧栏为覆盖层、`打开导航` 在含欢迎态的每个路由可达、页面无横向溢出（1440/390 由 `make ui-walk` 两个 project 逐路由断言；1024 由 `desktop-light` project 在四路由遍历中逐路由临时切 1024×768 断言——含 `/center`——并由 `make ui-shots` 五态每格再断言）；焦点/禁用/忙碌/错误状态可辨，不请求公网字体或资源
- AND 退出模态打开时聚焦取消，Tab 循环留在框内，Escape 关闭并恢复到可用控件；提交中允许关闭窗口以避免网络停滞锁死应用，明确关闭不会撤销已发送的退出请求，重复退出仍被锁定
- AND 已发送的退出请求优先于普通服务信息读取；退出进行中进入设置页不得中断该请求，服务信息可暂不可用，当前会话的退出成功仍进入登录页

#### Scenario: 侧栏折叠与用户菜单
- WHEN 点击折叠按钮、reload、再展开；随后打开用户菜单
- THEN 折叠后侧栏宽 48px、导航只显示图标且 hover/聚焦出现 Tooltip 标签，`localStorage.workbuddy-sidebar=collapsed`，reload 保持折叠；菜单只含 `退出登录` 一项，Escape 关闭并恢复触发器焦点

#### Scenario: 窄屏导航覆盖层
- WHEN jsdom 以 `(max-width: 760px)` 匹配的 `matchMedia` mock 挂载已认证应用于 `/`、点击顶栏 `打开导航`，在覆盖层中选择 `工作空间`，随后再打开并按 Escape；再在覆盖层内经 `用户菜单` → `退出登录` → `退出` 发起一个挂起的退出请求，Escape 关闭确认框与覆盖层后重开
- THEN 挂载时无文档流侧栏、无 `dialog`、无 `主导航`，顶栏只含 `打开导航`，唯一 level-1 heading 为 hero；点击后出现 accessible name `导航` 的 `dialog`，其内主导航四项标签可见且无折叠按钮；选择后 `dialog` 消失、顶栏 heading 为 `工作空间`、焦点回到 `打开导航`、应用根节点不再 `aria-hidden`；Escape 同样关闭并归还焦点；覆盖层内 `用户菜单` 可打开且选择 `退出登录` 弹出确认框时覆盖层保持打开；退出请求挂起期间关闭确认框与覆盖层再重开，确认框仍为忙碌禁用 + `关闭`、状态提示仍在且不再发请求

#### Scenario: 覆盖层不触碰折叠偏好
- WHEN `localStorage.workbuddy-sidebar=collapsed` 时在 `≤760px` 打开覆盖层并选择路由，随后媒体查询 change 为不匹配，再 change 回匹配
- THEN 覆盖层始终为展开态、storage 值仍为 `collapsed` 且无任何写入；切回宽屏后文档流侧栏以折叠态渲染、覆盖层与 `打开导航` 消失；再次进入窄屏时覆盖层处于关闭态

#### Scenario: 顶栏三态
- WHEN 依次访问 `/`（无会话）、`/?session=<id>`、`/files`
- THEN 第一态 `≥761px` 无顶栏、`≤760px` 顶栏只含 `打开导航`，页面 level-1 heading 为 `WorkBuddy，我帮你`；第二态顶栏面包屑容器为 level-1 heading，accessible name `我的工作 / <服务端标题>`；第三态顶栏 heading level 1 为 `工作空间` 且页面主区无第二个页面级 level 1 heading（文件预览内 Markdown 的 `<h1>` 不计）

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN `/` 显示会话页、会话列表与输入框，`/files` 显示工作空间页、空间切换器与目录树区，`/center` 保持占位壳，`/settings` 保持设置页；侧栏高亮当前 tab，无浏览器控制台报错

#### Scenario: 退出登录
- WHEN 点击侧栏用户区触发按钮 `用户菜单`、在 `Menu` 中选择 `退出登录` 并在确认框选择 `退出`
- THEN 恰调用一次 `POST /api/auth/logout`；204 或 current 401 均清空 Principal，会话页的连接随卸载关闭，并在保持当前 pathname/search/hash 不变时渲染登录页

#### Scenario: 取消退出
- WHEN 打开退出确认框后选择 `取消`
- THEN 关闭确认框，不调用 logout，原 Principal 与受保护壳保持不变

#### Scenario: 退出请求失败
- WHEN logout 返回非 401 错误、非 204 的成功 status 或网络失败
- THEN 保留原 Principal 与受保护壳；LoginForm 专用 error 保持 null，独立 authenticated `logoutError` 在用户区显示合法信封 message 或稳定回退 `请求失败，请稍后重试`，并允许重试

### Requirement: 登录页与路由守卫
未登录时任一受支持 SPA 路由（本阶段为 `/`、`/files`、`/center`、`/settings`）SHALL 在保持当前 browser URL 不变的情况下渲染登录页（域账号+密码），该 URL 即原目标路由；登录失败 SHALL 展示错误信封的 message 字段文案；登录成功 SHALL 在同一 URL 恢复原目标壳。登录页 SHALL 镜像 demo:1721-1752 的结构：居中卡片宽 `360px`，自上而下为品牌区（`BrandMark` 自有 mark + 字标，高度与 demo:640 的 logo 一致 `26px`，不使用上游 logo 资产）、标题 `登录 WorkBuddy`（heading level 1）、副标题 `内网统一身份 · 本实例不出网`、`账号`（placeholder `域账号，如 zhangsan`，`autocomplete=username`，mount 时自动聚焦）、`密码`（placeholder `密码`，`autocomplete=current-password`）、错误行（`role="alert"`，位于主按钮之上，展示错误信封的 message 字段文案，文本内容恰为该 message）、主按钮 `登录`（提交中显示 `正在登录` 并禁用）；登录页不渲染无后端契约支撑的控件。当 `GET /api/info` 的 `auth.provider === "dev-stub"` 时 SHALL 在按钮下方渲染 `演示账号` 提示与快捷登录列表（静态常量镜像 dev-stub seed：`zhangsan`/`zhaoliu`/`lisi` 与各自 seed 角色，前端不伪造 display name/部门/角色映射；点击即以该账号与密码 `demo` 提交）。该 info 读取由 LoginForm 在每次 mount 时以匿名 API client 发起一次（relative path、`credentials:"same-origin"`、`cache:"no-store"`；StrictMode 双 mount 下首个请求随卸载 abort），**不占用** Provider 的单槽 operation、不与 login/logout 竞争，LoginForm 卸载时 abort，失败（含 `requestFailed(0)`、malformed）不重试；provider 非 dev-stub、body 不合法或请求失败时 SHALL 不渲染该区域，且不阻塞登录表单。`lib/api` SHALL 统一解析错误信封并在当前有效 operation 或当前认证会话所属、未取消页面请求的 401 响应时进入未登录态；旧会话（包括同账号重新登录之前）或已取消请求的迟到 401 SHALL 不改变当前认证状态。

#### Scenario: 未登录重定向
- WHEN 未登录直接访问 `/files`
- THEN 渲染登录页；账号框已聚焦；登录成功后落在 `/files`

#### Scenario: 停用账号提示
- WHEN 以停用账号登录
- THEN 页面展示"该账号已停用，请联系管理员"（来自信封 message）

#### Scenario: 快捷登录仅 dev-stub 可见
- WHEN `/api/info` 返回 `auth.provider="dev-stub"`；另一次返回 `auth.provider="oidc"` 或请求失败
- THEN 前者显示 `演示账号` 提示与三张快捷登录卡，点击 `zhangsan` 卡恰发一次 login 请求且 body 为 `{account:"zhangsan",password:"demo"}`；后者不渲染该区域，登录表单正常可用；info 尚未返回时提交登录不取消也不等待 info，登录失败后快捷区状态不变

#### Scenario: 文件请求使当前会话失效
- WHEN 当前认证会话发出的未取消文件请求返回 401（包括非法信封或非 JSON）
- THEN 清除 Principal，在保持 URL 的情况下显示登录页；并发文件请求不 supersede 彼此或既有 auth operation

#### Scenario: 旧会话与取消请求隔离
- WHEN 页面请求已取消，或用户退出并以同账号重新登录后旧请求才返回 401
- THEN 新会话与受保护页面保持不变，旧响应不得清除 Principal 或提交文件 UI

### Requirement: 设置页
设置页 SHALL 含且仅含两张设置卡：`外观`与`关于`（页面标题 `设置` 由顶栏承担，无 `通用` 卡），布局镜像 demo:3533-3567：卡内每行为左侧标题 + 说明、右侧控件。外观卡 SHALL 有 `主题` 行（说明 `浅色 / 深色 / 跟随系统 · 即时生效并持久保存`，右侧 `SegmentedControl` 三项 `浅色`/`深色`/`跟随系统`，每项 `role="radio"`，默认 `跟随系统`）与 `当前生效` 行（说明恰为 `浅色|深色 · 持久保存于 localStorage`，并保留可访问文本 `当前生效：浅色|深色`）；所选值 SHALL 以 production key `workbuddy-theme` 持久化为 `light|dark|system`，并把解析结果 `light|dark` 写到 `document.documentElement[data-theme]`。初始 storage 缺失、未知或读取抛错时 SHALL 选择 system；写入抛错不得破坏当前内存选择或向 UI 抛错，刷新后按可读取值（不可读即 system）重新初始化。system 使用唯一 query `(prefers-color-scheme: dark)`，系统偏好 change 时实时更新；固定 light/dark 不改变。`storage` 事件只在 key 为 `workbuddy-theme` 时同步其他 tab，null/unknown 归一化为 system；所有 listener 在 owner 卸载时移除。

关于卡 SHALL 以品牌 mark 图标 + 名称 + 版本说明一行呈现，在 mount 时经 Provider-owned API operation 请求 `GET /api/info`（relative path、`credentials:"same-origin"`、`cache:"no-store"`），但已有退出请求进行中时 Provider SHALL 返回 null，不启动 info operation、不发起该 GET、不打断退出；About 结束 loading 并显示稳定失败提示，退出结束后的新 mount 恢复普通读取。普通读取 loading 显示 `正在读取服务信息`；只接受恰为 `{name:string,version:string,auth:{provider:string}}`、非空 name、version 符合共享 semver contract、`auth` 恰含非空 `provider` 的 body，成功逐字展示 name 与 `版本 <version>`（provider 不在关于卡展示，仅供登录页快捷登录门控）。非 401 合法错误信封显示其 message；malformed/non-JSON/network 显示 `请求失败，请稍后重试`；current 401 依全局规则清 Principal。About component SHALL 在 effect cleanup 时 abort caller lifecycle signal，Provider SHALL 将其单向链接到自己的 operation controller，故离开设置 route element、更新 Provider operation 或 app unmount 任一情况都 abort 传给 fetch 的 signal 并移除 linkage；迟到响应不得写 UI/auth state。Provider 不感知 router/location。若 info 被 sibling operation supersede 且该 operation 非 401 失败后 authenticated settings 仍 mounted，About SHALL 结束 loading 并显示 `请求失败，请稍后重试`，不得永久停在 loading。不得硬编码 demo 的 `WorkBuddy`/`5.3.11` 作为成功 fallback。

#### Scenario: 主题切换即时生效
- WHEN 在分段控件选择 `深色`
- THEN 该 radio 立即选中，根元素 `data-theme` 变为 `dark`，`当前生效：深色` 可见，storage 写入 `workbuddy-theme=dark`；重新 mount 仍为深色

#### Scenario: 跟随系统
- WHEN 选择 `跟随系统` 且系统为深色，随后系统改为浅色
- THEN 先呈现 `当前生效：深色`/`data-theme=dark`，change 后呈现 `当前生效：浅色`/`data-theme=light`，持久化值仍为 `system`

#### Scenario: 存储失败与跨 tab 同步
- WHEN storage 初始读取抛错，或收到 `workbuddy-theme` 的 storage event
- THEN 读取失败稳定按 system 渲染且无异常；有效 event 值同步档位/解析结果，null/unknown event 值同步为 system，其他 key 不改变主题

#### Scenario: 关于卡真实版本
- WHEN 打开设置页且 `/api/info` 返回 `{name:"workbuddy-app-server",version:"0.0.0",auth:{provider:"dev-stub"}}`
- THEN 关于卡展示 `workbuddy-app-server` 与 `版本 0.0.0`，不展示 demo 版本 `5.3.11`，不展示 provider

#### Scenario: 关于卡失败
- WHEN `/api/info` 返回 malformed success（含缺失 `auth`、多余键或旧的 `{name,version}` 两键形状）、非 JSON 或网络失败
- THEN 关于卡显示稳定回退 `请求失败，请稍后重试`，不泄漏 response/transport details 或伪造 name/version
