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
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与四个导航入口；视觉参考 demo，标签与说明仅表达已实现的功能，不宣传挂载等未交付能力。`/` 渲染 chat-web 规定的会话页（当前会话由 `?session=<id>` 表示；页面级 heading 归属见下文顶栏段）；`/center` 明确展示暂不可用状态，不提供虚假功能按钮；`/files` 渲染 files-web 规定的工作空间页（heading `工作空间`，当前空间以 `?ws=<id>` 表示），routeManifest 描述及 routes/ui-walk 既有断言 SHALL 随真实页面同步更新；`/center` 为扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。**侧栏**（demo:232-300, 1773-1822）SHALL 宽 `288px`，每个导航项为 `Icon`（`routeManifest[].icon`：`message-square`/`folder`/`layout-grid`/`settings`）+ 标签 + 可选副标签（仅 `/files` 为 `文件·预览`，其余路由无副标签直到有真实内容），当前项高亮；顶部为品牌区（自有 mark + 字标 `WorkBuddy`，不使用上游 logo 资产）与折叠按钮（accessible name `折叠侧栏`/`展开侧栏`），折叠态宽 `48px` 只显示图标（每项保留 `aria-label` 为标签文本）并以 `Tooltip` 显示标签，折叠状态持久化在 `localStorage` key `workbuddy-sidebar`（`expanded|collapsed`，读取失败或值不合法按 expanded，写入失败静默并保留内存状态）；底部为用户区（aside 内 `<footer>`）：头像圆标（`account` 首字符大写）+ 逐字展示当前 Principal 的 `account` 与 `role`（前端不伪造 display name/部门或角色映射），整块为触发按钮（accessible name `用户菜单`），点击打开 `Menu`，菜单项**只有** `退出登录`（沙箱信息、账号与隔离、切换账号、铃铛无后端，不渲染）；退出请求进行中触发按钮保持可用，再次选择 `退出登录` 打开的确认框其确认按钮处于忙碌禁用态、取消按钮文案为 `关闭`（重复退出被锁定）。**顶栏**（demo:313-322, 1928-1963）SHALL 由 shell 渲染为 `main` 之外的 `<header>`（隐式 `role=banner`）、高 `56px`，三态：`/` 无当前会话时不渲染顶栏（`≤760px` 含 `打开导航` 的窄条随响应式切片与 Drawer 一并落地，在此之前不渲染无接线的占位按钮）；`/` 有当前会话时显示面包屑 `我的工作 / <会话标题>`（标题来自服务端 title 或 `新会话`，由会话页经 `useTopbar({ breadcrumb })` 上报，shell 不读取 chat 数据层；无重命名/搜索/更多按钮直到对应阶段）；其它路由显示 `routeManifest[].title`（`工作空间`/`中心`/`设置`）。**页面级 level-1 heading 归属**：`/` 欢迎态为 chat-web 渲染的 hero `WorkBuddy，我帮你`；`/` 有会话时为顶栏面包屑容器（heading level 1，accessible name `我的工作 / <标题>`）；其它路由为顶栏页面标题；除欢迎态 hero 外页面自身不再渲染页面级 `<h1>`，内容区（Markdown 预览、助手正文）内的 heading 不受此限，heading 断言以 banner 或 hero 定位。退出 SHALL 先显示可访问模态确认框：标题 `退出登录？`、说明退出后的登录状态与任务保留语义、按钮 `取消`/`退出`；取消不发请求，确认只调用一次 Provider-owned logout。其余 demo 用户菜单项延后见 proposal Non-goals。

#### Scenario: 视觉与键盘可用性
- WHEN 浏览器在桌面和390px窄屏打开登录及四个路由，并切换浅色/深色主题
- THEN 使用本地构建的统一样式与带来源的设计token，桌面侧栏与主区并排，窄屏导航可达且页面无横向溢出；焦点/禁用/忙碌/错误状态可辨，不请求公网字体或资源
- AND 退出模态打开时聚焦取消，Tab循环留在框内，Escape关闭并恢复到可用控件；提交中允许关闭窗口以避免网络停滞锁死应用，明确关闭不会撤销已发送的退出请求，重复退出仍被锁定
- AND 已发送的退出请求优先于普通服务信息读取；退出进行中进入设置页不得中断该请求，服务信息可暂不可用，当前会话的退出成功仍进入登录页

#### Scenario: 顶栏三态
- WHEN 依次访问 `/`（无会话）、`/?session=<id>`、`/files`
- THEN 第一态无顶栏（任何宽度；`≤760px` 的 `打开导航` 窄条随响应式切片落地），页面 level-1 heading 为 `WorkBuddy，我帮你`；第二态顶栏面包屑容器为 level-1 heading，accessible name `我的工作 / <服务端标题>`（无标题时 `我的工作 / 新会话`），离开该会话或路由后面包屑随即清空（含会话页不卸载、仅移除 `?session=` 的情况）；会话已选但标题尚未从列表或快照得知时既无顶栏也无 hero；第三态顶栏 heading level 1 为 `工作空间` 且页面主区无第二个页面级 level 1 heading（文件预览内 Markdown 的 `<h1>` 不计）

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN `/` 显示会话页（欢迎态 hero `WorkBuddy，我帮你`）、会话列表与输入框，`/files` 显示工作空间页、空间切换器与目录树区，`/center` 保持占位壳，`/settings` 保持设置页；侧栏高亮当前 tab，无浏览器控制台报错

#### Scenario: 侧栏折叠与用户菜单
- WHEN 点击折叠按钮、reload、再展开；随后打开用户菜单
- THEN 折叠后侧栏宽 48px、导航只显示图标且 hover/聚焦出现 Tooltip 标签，`localStorage.workbuddy-sidebar=collapsed`，reload 保持折叠；展开后宽 288px 且 storage 为 `expanded`；菜单只含 `退出登录` 一项，Escape 关闭并恢复触发器焦点

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
未登录时任一受支持 SPA 路由（本阶段为 `/`、`/files`、`/center`、`/settings`）SHALL 在保持当前 browser URL 不变的情况下渲染登录页（域账号+密码），该 URL 即原目标路由；登录失败 SHALL 展示错误信封的 message 字段文案；登录成功 SHALL 在同一 URL 恢复原目标壳。`lib/api` SHALL 统一解析错误信封并在当前有效 operation 或当前认证会话所属、未取消页面请求的 401 响应时进入未登录态；旧会话（包括同账号重新登录之前）或已取消请求的迟到 401 SHALL 不改变当前认证状态。

#### Scenario: 未登录重定向
- WHEN 未登录直接访问 `/files`
- THEN 渲染登录页；登录成功后落在 `/files`

#### Scenario: 停用账号提示
- WHEN 以停用账号登录
- THEN 页面展示"该账号已停用，请联系管理员"（来自信封 message）

#### Scenario: 文件请求使当前会话失效
- WHEN 当前认证会话发出的未取消文件请求返回 401（包括非法信封或非 JSON）
- THEN 清除 Principal，在保持 URL 的情况下显示登录页；并发文件请求不 supersede 彼此或既有 auth operation

#### Scenario: 旧会话与取消请求隔离
- WHEN 页面请求已取消，或用户退出并以同账号重新登录后旧请求才返回 401
- THEN 新会话与受保护页面保持不变，旧响应不得清除 Principal 或提交文件 UI

### Requirement: 设置页
设置页 SHALL 含且仅含两张设置卡：`外观`与`关于`（另有页面标题 `设置`，无 `通用` 卡）。外观卡 SHALL 提供 `浅色`、`深色`、`跟随系统` 三个可访问单选项，默认档为 `跟随系统`；所选值 SHALL 以 production key `workbuddy-theme` 持久化为 `light|dark|system`，并把解析结果 `light|dark` 写到 `document.documentElement[data-theme]`。初始 storage 缺失、未知或读取抛错时 SHALL 选择 system；写入抛错不得破坏当前内存选择或向 UI 抛错，刷新后按可读取值（不可读即 system）重新初始化。system 使用唯一 query `(prefers-color-scheme: dark)`，系统偏好 change 时实时更新；固定 light/dark 不改变。`storage` 事件只在 key 为 `workbuddy-theme` 时同步其他 tab，null/unknown 归一化为 system；所有 listener 在 owner 卸载时移除。`当前生效`行 SHALL 恰为 `当前生效：浅色|深色`。

关于卡 SHALL 在 mount 时经 Provider-owned API operation 请求 `GET /api/info`（relative path、`credentials:"same-origin"`、`cache:"no-store"`），但已有退出请求进行中时 Provider SHALL 返回 null，不启动 info operation、不发起该 GET、不打断退出；About 结束 loading 并显示稳定失败提示，退出结束后的新 mount 恢复普通读取。普通读取 loading 显示 `正在读取服务信息`；只接受恰为 `{name:string,version:string}`、非空 name 且 version 符合共享 semver contract 的 body，成功逐字展示 name 与 `版本 <version>`。非 401 合法错误信封显示其 message；malformed/non-JSON/network 显示 `请求失败，请稍后重试`；current 401 依全局规则清 Principal。About component SHALL 在 effect cleanup 时 abort caller lifecycle signal，Provider SHALL 将其单向链接到自己的 operation controller，故离开设置 route element、更新 Provider operation或 app unmount 任一情况都 abort 传给 fetch 的 signal并移除 linkage；迟到响应不得写 UI/auth state。Provider 不感知 router/location。若 info 被 sibling operation supersede且该 operation 非 401 失败后 authenticated settings 仍 mounted，About SHALL 结束 loading并显示 `请求失败，请稍后重试`，不得永久停在 loading。不得硬编码 demo 的 `WorkBuddy`/`5.3.11` 作为成功 fallback。

#### Scenario: 主题切换即时生效
- WHEN 切换到 `深色`
- THEN 该选项立即选中，根元素 `data-theme` 变为 `dark`，`当前生效：深色` 可见，storage 写入 `workbuddy-theme=dark`；重新 mount 仍为深色

#### Scenario: 跟随系统
- WHEN 选择 `跟随系统` 且系统为深色，随后系统改为浅色
- THEN 先呈现 `当前生效：深色`/`data-theme=dark`，change 后呈现 `当前生效：浅色`/`data-theme=light`，持久化值仍为 `system`

#### Scenario: 存储失败与跨 tab 同步
- WHEN storage 初始读取抛错，或收到 `workbuddy-theme` 的 storage event
- THEN 读取失败稳定按 system 渲染且无异常；有效 event 值同步档位/解析结果，null/unknown event 值同步为 system，其他 key 不改变主题

#### Scenario: 关于卡真实版本
- WHEN 打开设置页且 `/api/info` 返回 `{name:"workbuddy-app-server",version:"0.0.0"}`
- THEN 关于卡展示 `workbuddy-app-server` 与 `版本 0.0.0`，不展示 demo 版本 `5.3.11`

#### Scenario: 关于卡失败
- WHEN `/api/info` 返回 malformed success、非 JSON 或网络失败
- THEN 关于卡显示稳定回退 `请求失败，请稍后重试`，不泄漏 response/transport details 或伪造 name/version

