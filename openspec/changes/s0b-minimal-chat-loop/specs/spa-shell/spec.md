# Spec delta: spa-shell（S0b 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement。

## MODIFIED Requirements

### Requirement: 路由 IA 与侧栏
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与侧栏 4 tab（标签与副标题按 demo:1773-1778）；`/` 渲染 chat-web 规定的会话页（当前会话由查询参数 `?session=<id>` 表示）；`/files` 渲染 files-web 规定的工作空间页（heading `工作空间`，当前空间以 `?ws=<id>` 表示）；`/center` 为占位壳（标题 + 所属阶段说明）及扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。`routeManifest` 中 `/` 的 `description` 与既有路由消费者断言随会话页同步更新，保留工作空间页的现有 routes/ui-walk 行为。已认证侧栏底部 SHALL 有用户页脚，逐字展示当前 Principal 的 `account` 与 `role`（前端不伪造 display name/部门或角色映射）以及 `退出登录` 按钮。退出 SHALL 先显示可访问确认框：标题 `退出登录？`、说明 `退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。`、按钮 `取消`/`退出`；取消不发请求，确认只调用一次 Provider-owned logout。其余 demo 用户菜单项延后见 proposal Non-goals。

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN `/` 显示会话页（标题 `会话`、会话列表与输入框可见），`/files` 显示工作空间页、空间切换器与目录树区，`/center` 渲染占位壳，`/settings` 渲染设置页；侧栏高亮当前 tab，无浏览器控制台报错

#### Scenario: 退出登录
- WHEN 在侧栏用户页脚点击 `退出登录` 并在确认框选择 `退出`
- THEN 恰调用一次 `POST /api/auth/logout`；204 或 current 401 均清空 Principal（会话页的事件流连接随之关闭），并在保持当前 pathname/search/hash 不变时渲染登录页

#### Scenario: 取消退出
- WHEN 打开退出确认框后选择 `取消`
- THEN 关闭确认框，不调用 logout，原 Principal 与受保护壳保持不变

#### Scenario: 退出请求失败
- WHEN logout 返回非 401 错误、非 204 的成功 status 或网络失败
- THEN 保留原 Principal 与受保护壳；LoginForm 专用 error 保持 null，独立 authenticated `logoutError` 在用户页脚显示合法信封 message 或稳定回退 `请求失败，请稍后重试`，并允许重试
