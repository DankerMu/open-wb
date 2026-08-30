# Spec: spa-shell

## ADDED Requirements

### Requirement: web 构建工具链
web workspace SHALL 具备 Vite + React 构建面：`web/index.html`、`src/main.tsx` 入口、`vite.config.ts`（@vitejs/plugin-react，outDir=dist）、tsconfig JSX（react-jsx）、vitest jsdom 环境、knip entry 同步；`npm run build --workspace web` SHALL 可复现产出 `web/dist`，且 `make check` 全链（lint/typecheck/test/anti-drift）保持绿。

#### Scenario: 构建可复现
- WHEN 执行 `npm run build --workspace web`
- THEN 产出 `web/dist/index.html` 与静态资源，退出码 0

#### Scenario: 门禁兼容
- WHEN 工具链落地后执行 `make check`
- THEN typecheck（JSX）、knip（vite 入口解析）、覆盖率全部通过

### Requirement: 路由 IA 与侧栏
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与侧栏 4 tab（标签与副标题按 demo:1773-1778）；`/`、`/files`、`/center` 为占位壳（标题 + 所属阶段说明）；`/center` 为扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。侧栏底部 SHALL 有用户页脚：当前用户名/角色 + 退出登录（带确认，demo:1816-1822；其余菜单项延后见 proposal Non-goals）。

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN 每页渲染对应壳层，侧栏高亮当前 tab，无浏览器控制台报错

#### Scenario: 退出登录
- WHEN 在侧栏用户页脚点击退出并确认
- THEN 会话失效（logout 端点被调）并回到登录页

### Requirement: 登录页与路由守卫
未登录时任意路由 SHALL 渲染登录页（域账号+密码）并记录原目标路由；登录失败 SHALL 展示错误信封的 message 字段文案；登录成功 SHALL 跳回原目标。`lib/api` SHALL 统一解析错误信封并在 401 时进入未登录态。

#### Scenario: 未登录重定向
- WHEN 未登录直接访问 `/files`
- THEN 渲染登录页；登录成功后落在 `/files`

#### Scenario: 停用账号提示
- WHEN 以停用账号登录
- THEN 页面展示"该账号已停用，请联系管理员"（来自信封 message）

### Requirement: 设置页
设置页 SHALL 含"外观"卡（主题三档：浅色/深色/跟随系统，默认档为跟随系统（demo:1035），即时生效并持久化，展示"当前生效"行；存储不可用时按跟随系统渲染不报错）与"关于"卡（名称与版本取 `GET /api/info`，不硬编码 demo 的 5.3.11）；设置页 SHALL 仅含此两卡（demo:3533-3567 无"通用"分区，F-SET-1 的"通用"分档为空集——见 proposal 覆盖声明）。

#### Scenario: 主题切换即时生效
- WHEN 切换到深色
- THEN 页面立即应用深色且刷新后保持

#### Scenario: 跟随系统
- WHEN 选择"跟随系统"且系统为深色
- THEN 页面呈现深色，"当前生效"行显示 深色

#### Scenario: 关于卡真实版本
- WHEN 打开设置页
- THEN 关于卡展示 `/api/info` 返回的版本号
