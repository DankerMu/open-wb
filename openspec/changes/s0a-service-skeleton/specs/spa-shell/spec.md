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
SPA SHALL 以 history 路由提供 `/`、`/files`、`/center`、`/settings` 四页与侧栏 4 tab（标签与副标题按 demo:1773-1778）；`/`、`/files`、`/center` 为占位壳（标题 + 所属阶段说明）；`/center` 为扁平路由（demo 的 8 tab 是页内状态而非 URL，demo:3144-3161；页内 tab 属 S1d）；demo 开发者页 `/tokens` 不移植。已认证侧栏底部 SHALL 有用户页脚，逐字展示当前 Principal 的 `account` 与 `role`（前端不伪造 display name/部门或角色映射）以及 `退出登录` 按钮。退出 SHALL 先显示可访问确认框：标题 `退出登录？`、说明 `退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。`、按钮 `取消`/`退出`；取消不发请求，确认只调用一次 Provider-owned logout。其余 demo 用户菜单项延后见 proposal Non-goals。

#### Scenario: 四路由可达
- WHEN 已登录用户依次访问四个路由
- THEN 每页渲染对应壳层，侧栏高亮当前 tab，无浏览器控制台报错

#### Scenario: 退出登录
- WHEN 在侧栏用户页脚点击 `退出登录` 并在确认框选择 `退出`
- THEN 恰调用一次 `POST /api/auth/logout`；204 或 current 401 均清空 Principal，并在保持当前 pathname/search/hash 不变时渲染登录页

#### Scenario: 取消退出
- WHEN 打开退出确认框后选择 `取消`
- THEN 关闭确认框，不调用 logout，原 Principal 与受保护壳保持不变

#### Scenario: 退出请求失败
- WHEN logout 返回非 401 错误、非 204 的成功 status 或网络失败
- THEN 保留原 Principal 与受保护壳；LoginForm 专用 error 保持 null，独立 authenticated `logoutError` 在用户页脚显示合法信封 message 或稳定回退 `请求失败，请稍后重试`，并允许重试

### Requirement: 登录页与路由守卫
未登录时任一受支持 SPA 路由（本阶段为 `/`、`/files`、`/center`、`/settings`）SHALL 在保持当前 browser URL 不变的情况下渲染登录页（域账号+密码），该 URL 即原目标路由；登录失败 SHALL 展示错误信封的 message 字段文案；登录成功 SHALL 在同一 URL 恢复原目标壳。`lib/api` SHALL 统一解析错误信封并在任何 401 响应时进入未登录态。

#### Scenario: 未登录重定向
- WHEN 未登录直接访问 `/files`
- THEN 渲染登录页；登录成功后落在 `/files`

#### Scenario: 停用账号提示
- WHEN 以停用账号登录
- THEN 页面展示"该账号已停用，请联系管理员"（来自信封 message）

### Requirement: 设置页
设置页 SHALL 含且仅含两张设置卡：`外观`与`关于`（另有页面标题 `设置`，无 `通用` 卡）。外观卡 SHALL 提供 `浅色`、`深色`、`跟随系统` 三个可访问单选项，默认档为 `跟随系统`；所选值 SHALL 以 production key `workbuddy-theme` 持久化为 `light|dark|system`，并把解析结果 `light|dark` 写到 `document.documentElement[data-theme]`。初始 storage 缺失、未知或读取抛错时 SHALL 选择 system；写入抛错不得破坏当前内存选择或向 UI 抛错，刷新后按可读取值（不可读即 system）重新初始化。system 使用唯一 query `(prefers-color-scheme: dark)`，系统偏好 change 时实时更新；固定 light/dark 不改变。`storage` 事件只在 key 为 `workbuddy-theme` 时同步其他 tab，null/unknown 归一化为 system；所有 listener 在 owner 卸载时移除。`当前生效`行 SHALL 恰为 `当前生效：浅色|深色`。

关于卡 SHALL 在 mount 时经 Provider-owned API operation 请求 `GET /api/info`（relative path、`credentials:"same-origin"`、`cache:"no-store"`），loading 显示 `正在读取服务信息`；只接受恰为 `{name:string,version:string}`、非空 name 且 version 符合共享 semver contract 的 body，成功逐字展示 name 与 `版本 <version>`。非 401 合法错误信封显示其 message；malformed/non-JSON/network 显示 `请求失败，请稍后重试`；current 401 依全局规则清 Principal。About component SHALL 在 effect cleanup 时 abort caller lifecycle signal，Provider SHALL 将其单向链接到自己的 operation controller，故离开设置 route element、更新 Provider operation或 app unmount 任一情况都 abort 传给 fetch 的 signal并移除 linkage；迟到响应不得写 UI/auth state。Provider 不感知 router/location。若 info 被 sibling operation supersede且该 operation 非 401 失败后 authenticated settings 仍 mounted，About SHALL 结束 loading并显示 `请求失败，请稍后重试`，不得永久停在 loading。不得硬编码 demo 的 `WorkBuddy`/`5.3.11` 作为成功 fallback。

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
