# spa-shell Specification

## Purpose
Defines the React SPA build, four-route shell, authentication guard, settings/theme behavior, and workspace-page integration.
## Requirements
### Requirement: web 构建工具链
web workspace SHALL 具备 Vite + React 构建面：`web/index.html`、`src/main.tsx` 入口、`vite.config.ts`（@vitejs/plugin-react，outDir=dist）、tsconfig JSX（react-jsx）、vitest jsdom 环境、knip entry 同步；`npm run build --workspace web` SHALL 可复现产出 `web/dist`，且 `make check` 全链（lint/typecheck/test/anti-drift）保持绿。

#### Scenario: 构建可复现
- WHEN 执行 `npm run build --workspace web`
- THEN 产出 `web/dist/index.html` 与静态资源，退出码 0

#### Scenario: 门禁兼容
- WHEN 工具链落地后执行 `make check`
- THEN typecheck（JSX）、knip（vite 入口解析）、覆盖率全部通过

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

### Requirement: 登录表单在 StrictMode 下失败后可重试
登录表单的挂载标记 SHALL 在挂载 effect 体内置为已挂载、在 cleanup 中置为未挂载，使 React StrictMode 的模拟卸载→重挂之后组件仍被视为已挂载。登录请求（表单提交或快捷登录卡）失败后，无论是否处于 StrictMode，表单 SHALL 清空密码框、解除提交锁并恢复提交按钮可用，后续提交 SHALL 再次发出登录请求；登录成功导致表单卸载后 SHALL NOT 再写入其状态或 DOM。

#### Scenario: StrictMode 下表单登录失败后可重试
- **WHEN** 在 `<StrictMode>` 中渲染登录页，填写账号密码提交，`/api/auth/login` 返回 401 且错误行出现
- **THEN** 提交按钮可用、密码框为空；再次提交发出第 2 次 `/api/auth/login` 请求

#### Scenario: StrictMode 下快捷登录失败后可重试
- **WHEN** 在 `<StrictMode>` 中渲染 dev-stub 登录页，点击一张快捷登录卡，`/api/auth/login` 返回 401
- **THEN** 快捷登录卡与表单恢复可用；再次点击快捷登录卡发出第 2 次 `/api/auth/login` 请求

### Requirement: 退出失败提示可关闭
侧栏用户区的退出失败提示（`role="alert"`，文本内容恰为错误信封 message）SHALL 在提示内提供一个仅图标的关闭按钮（accessible name `关闭提示`），在展开、折叠浮出与窄屏覆盖层三种呈现下一致。点击后 SHALL 移除该提示、将焦点移到 `用户菜单` 触发器，且不改变侧栏折叠状态与其持久化值、不发任何请求；关闭状态 SHALL 由认证 Provider 持有，使窄屏覆盖层关闭后重开仍不再显示已关闭的提示。之后再次退出失败 SHALL 重新显示提示。退出进行中的状态提示不提供关闭按钮。

#### Scenario: 折叠态关闭退出失败提示
- **WHEN** 桌面视口下折叠侧栏，经 `用户菜单` → `退出登录` → `退出` 发起退出且返回 403，浮出的 `role="alert"` 出现后点击 `关闭提示`
- **THEN** 该 alert 消失，焦点位于 `用户菜单`，侧栏 `data-collapsed` 仍为 `true`

#### Scenario: 关闭后再次失败重新显示
- **WHEN** 关闭提示后再次经 `用户菜单` 发起退出，且以与上次相同的 message 再次失败
- **THEN** `role="alert"` 重新出现，文本内容恰为该 message

#### Scenario: 窄屏覆盖层重开不复现已关闭提示
- **WHEN** 窄屏覆盖层内退出失败、点击 `关闭提示`，随后关闭覆盖层再重开
- **THEN** 覆盖层内不再出现该 `role="alert"`

#### Scenario: 退出进行中无关闭按钮
- **WHEN** 折叠侧栏后发起一个挂起的退出请求，状态提示出现
- **THEN** 不存在 accessible name 为 `关闭提示` 的按钮

### Requirement: 外壳页面底色
已认证外壳的页面底色 SHALL 与 demo 同构：唯一来源是 `body` 的 `--wb-home-bg-secondary`（demo:195；亮色 `#ffffff`、暗色 `#141414`）。`.app-shell`、`.app-content > main` 以及 files 页的 `.files-layout`、`.files-preview`（demo 对应的 `.app-shell`/`.main-column`/`.fs-layout`/`.fs-preview`，demo:210-213、666、702）SHALL NOT 自涂底色，由 body 透出。侧栏（`--wb-sidebar-bg`）、卡片、输入、弹层、用户气泡等表面的既有 token 不变，因此暗色下主区（`#141414`）与侧栏（`#1f1f1f`）、以及主区与用户气泡（`--wb-bg-hover-light`，暗色 `#1f1f1f`，messages.css:33）和 composer 卡片（`--wb-bg-primary`，暗色 `#1f1f1f`）的明度层次与 demo 一致；登录页与认证加载页保留各自的显式底色。

#### Scenario: 暗色主区与侧栏可区分
- **WHEN** 暗色主题下打开 `/`（有会话）、`/files`、`/settings`
- **THEN** `body` 的计算底色为 `rgb(20, 20, 20)`（`#141414`），`.app-content > main` 的计算底色为透明（主区渲染为 body 色），侧栏为 `rgb(31, 31, 31)`，用户气泡与 composer 卡片（均为 `#1f1f1f`）在主区上可辨；亮色下 `body` 计算底色为 `rgb(255, 255, 255)`

#### Scenario: 外壳容器不自涂底色
- **WHEN** 读取 `web/src/styles.css` 与 `web/src/features/files/files.css`
- **THEN** `body` 的 background 为 `var(--wb-home-bg-secondary)`，`.app-shell`、`.app-content > main`、`.files-layout`、`.files-preview` 的规则体不含 background 声明

### Requirement: 首帧前主题
`web/index.html` SHALL 在 `<head>` 内（构建后位于样式表 `<link>` 之前）含一段经典（非 module）内联脚本：读取 `localStorage["workbuddy-theme"]`，按 `web/src/lib/theme.ts` 的规则解析（`light`/`dark`/`system`，非法值与读取抛错回落为 `system`；`system` 按 `matchMedia("(prefers-color-scheme: dark)")` 解析，`matchMedia` 不可用或抛错时按 `light`），并在首次样式解析前写入 `document.documentElement.dataset.theme`。脚本 SHALL 用 try/catch 包住全部存储与媒体查询访问，任何异常都不得阻断页面加载。挂载后的同步（设置页切换、跨标签页 `storage` 事件、`system` 下系统配色变化）仍由 `ThemeProvider` 负责，行为不变；对同一输入，内联脚本与 `theme.ts` 的解析结果 SHALL 一致，因此挂载时根元素主题不再变化。

#### Scenario: 冷加载首帧即为目标主题
- **WHEN** `make ui-walk` 的 `desktop-light` project 在独立 test 中为三种输入各开一个全新 context 打开 `/files`（未登录，由守卫渲染登录页）：存储 `dark` + 系统浅色、存储 `system` + 系统深色、存储 `light` + 系统深色；经 `addInitScript` 预置存储，并以同一 `MutationObserver`（`document` 子树 childList + `data-theme` 属性，从文档创建起记录）记录变更顺序；等到登录页标题 `登录 WorkBuddy` 可见（守卫只在 `/api/auth/me` 响应后才离开 loading，故此时 React 已挂载且该响应已到）后读取记录
- **THEN** 写入 `data-theme` 的属性记录先于插入 `rel="stylesheet"` 的 `<link>` 与 `#root` 的记录出现，写入值依次为 `dark`、`dark`、`light`；之后所有 `data-theme` 记录都保持该值；无 `pageerror`，console error 至多为该次 `/api/auth/me` 401 的 Chromium 网络日志一条（与 ui-walk oracle 的放行规则相同）

#### Scenario: 内联脚本与 theme.ts 解析一致
- **WHEN** 在 jsdom 中取出 `web/index.html` 的内联脚本，对用例表中的每个输入执行它（存储值 `light`/`dark`/`system`/非法值/`null`/读取抛错 × 系统深色/浅色/`matchMedia` 抛错/`matchMedia` 未定义），并用 `loadTheme` + `resolveTheme` 计算同一输入的期望值
- **THEN** 每个输入下脚本写入的 `data-theme` 都与期望值相等，且没有异常逸出

