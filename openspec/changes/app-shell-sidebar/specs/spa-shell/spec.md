# Spec delta: spa-shell（#281 app-shell-sidebar）

> 侧栏形态与用户菜单入口；顶栏与响应式 Drawer 由 2.2/2.3 各自的 delta 修改。demo 行号指 `resource/workbuddy-live-demo.html`。

## MODIFIED Requirements

### Requirement: 路由 IA 与侧栏
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与四个导航入口；视觉参考 demo，标签与说明仅表达已实现的功能，不宣传挂载等未交付能力。`/` 渲染 chat-web 规定的会话页（heading `会话`，当前会话由 `?session=<id>` 表示）；`/center` 明确展示暂不可用状态，不提供虚假功能按钮；`/files` 渲染 files-web 规定的工作空间页（heading `工作空间`，当前空间以 `?ws=<id>` 表示），routeManifest 描述及 routes/ui-walk 既有断言 SHALL 随真实页面同步更新；`/center` 为扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。**侧栏**（demo:232-300, 1773-1822）SHALL 宽 `288px`，每个导航项为 `Icon`（`routeManifest[].icon`：`message-square`/`folder`/`layout-grid`/`settings`）+ 标签 + 可选副标签（仅 `/files` 为 `文件·预览`，其余路由无副标签直到有真实内容），当前项高亮；顶部为品牌区（自有 mark + 字标 `WorkBuddy`，不使用上游 logo 资产）与折叠按钮（accessible name `折叠侧栏`/`展开侧栏`），折叠态宽 `48px` 只显示图标（每项保留 `aria-label` 为标签文本）并以 `Tooltip` 显示标签，折叠状态持久化在 `localStorage` key `workbuddy-sidebar`（`expanded|collapsed`，读取失败或值不合法按 expanded，写入失败静默并保留内存状态）；底部为用户区（aside 内 `<footer>`）：头像圆标（`account` 首字符大写）+ 逐字展示当前 Principal 的 `account` 与 `role`（前端不伪造 display name/部门或角色映射），整块为触发按钮（accessible name `用户菜单`），点击打开 `Menu`，菜单项**只有** `退出登录`（沙箱信息、账号与隔离、切换账号、铃铛无后端，不渲染）；退出请求进行中触发按钮保持可用，再次选择 `退出登录` 打开的确认框其确认按钮处于忙碌禁用态、取消按钮文案为 `关闭`（重复退出被锁定）。退出 SHALL 先显示可访问模态确认框：标题 `退出登录？`、说明退出后的登录状态与任务保留语义、按钮 `取消`/`退出`；取消不发请求，确认只调用一次 Provider-owned logout。其余 demo 用户菜单项延后见 proposal Non-goals。

#### Scenario: 视觉与键盘可用性
- WHEN 浏览器在桌面和390px窄屏打开登录及四个路由，并切换浅色/深色主题
- THEN 使用本地构建的统一样式与带来源的设计token，桌面侧栏与主区并排，窄屏导航可达且页面无横向溢出；焦点/禁用/忙碌/错误状态可辨，不请求公网字体或资源
- AND 退出模态打开时聚焦取消，Tab循环留在框内，Escape关闭并恢复到可用控件；提交中允许关闭窗口以避免网络停滞锁死应用，明确关闭不会撤销已发送的退出请求，重复退出仍被锁定
- AND 已发送的退出请求优先于普通服务信息读取；退出进行中进入设置页不得中断该请求，服务信息可暂不可用，当前会话的退出成功仍进入登录页

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN `/` 显示会话页、会话列表与输入框，`/files` 显示工作空间页、空间切换器与目录树区，`/center` 保持占位壳，`/settings` 保持设置页；侧栏高亮当前 tab，无浏览器控制台报错

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

