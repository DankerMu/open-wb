# Proposal: app-shell-topbar（#282）

## Why
S1e 组 2 第二刀（2.2）。现状无顶栏，四个页面各自渲染页面级 `<h1 className="ui-page-heading">`（`chat/page.tsx:702` `会话`、`files/page.tsx:410` `工作空间`、`settings/page.tsx:99` `设置`、`router.tsx:86` PlaceholderPage `中心`），欢迎态只有一行空态文案 `选择一个会话，或直接发送开始新对话`（`conversation-view.tsx:218`）。demo 顶栏（demo:313-330, 1928-1963）56px 三态：欢迎页整条隐藏、任务视图面包屑 `我的工作 / <标题>`、其它页页面标题。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md:54` 归为计划遗漏（F-UI-2）。本刀落地顶栏三态与页面级 heading 归属；响应式/Drawer/`打开导航` 归 2.3，欢迎页静态内容归 4.4。

## What Changes
- 新增 `web/src/lib/topbar.tsx`：`TopbarProvider`（持有 `breadcrumb: string | null` 状态）、`useTopbar({ breadcrumb })`（页面向 shell 上报：effect 内 set，卸载/变更时清空；**Provider 外为 no-op**，保证裸挂 `ChatPage` 的既有测试不受影响）、`useTopbarBreadcrumb()`（shell 侧读取）。放 `lib/` 而非 `routes/shell/`：chat feature 不反向依赖 routes 层。
- 新增 `web/src/routes/shell/topbar.tsx` + `topbar.css`：`Topbar()` 按 `useLocation().pathname`（规范化尾斜杠）与 breadcrumb 三态——`/` 且无 breadcrumb → **不渲染**；`/` 且有 breadcrumb → `<header className="topbar"><h1 className="topbar-title topbar-crumbs"><span>我的工作</span> / <span className="topbar-crumb-current">{breadcrumb}</span></h1></header>`（accessible name `我的工作 / <标题>`）；其它路由 → `<header className="topbar"><h1 className="topbar-title">{routeManifest 对应 title}</h1></header>`。`<header>` 位于 `<main>` 之外故隐式 `role=banner`（不写显式 `role`：biome `noRedundantRoles`）。
- 新增 `web/src/routes/shell/app-shell.tsx`：`AppShell` 从 `router.tsx` 抽出（design 决策 4 的文件位），结构 `div.app-shell > [Sidebar, div.app-content > [Topbar, main > Outlet]]`，`TopbarProvider` 包在 `.app-shell` 内层（Sidebar 与 Topbar 均在其内）；`router.tsx` 只保留路由表/守卫/占位页。`styles.css` 的 `.app-shell > main`/`.app-shell > main > *` 改为 `.app-content > main`/`.app-content > main > *`，新增 `.app-content{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}`（760 块 `:444-446` 同步）。
- 四个页面删除自有页面级 `<h1>`：`chat/page.tsx:702`、`files/page.tsx:410`、`settings/page.tsx:99`、`router.tsx:86`（PlaceholderPage 保留描述 `<p>`）；`styles.css:179-184` `.ui-page-heading` 与 `chat.css:20`、`files.css:19` 的对应规则删除（无剩余使用者）。
- chat 欢迎态（= 无 `?session=`）：`conversation-view.tsx:214-219` 的 `<p className="ui-empty chat-welcome">{emptySelection}</p>` 改为 `<h1 className="chat-hero">WorkBuddy，我帮你</h1>`，已选会话但历史未就绪/出错时不渲染 hero（避免与面包屑 h1 并存；仅 hero 文本；`emptySelection` prop 与 `EMPTY_SELECTION` 常量随之删除）；`chat.css` `.chat-welcome` → `.chat-hero`（demo:341 `.hero` 字号/行高/居中，去 PingFang 字体栈、不移植下划线 SVG 装饰）。chat 页在选中会话已知时 `useTopbar({ breadcrumb: sessionTitle(selected) })`（`selected` 取自列表项/快照，未加载或无选中时 `undefined`）。
- 测试（同 PR）：新增 `web/test/topbar.test.tsx`（三态、heading 唯一性、上报清理、标题回退 `新会话`、静态契约）；`routes.test.tsx` 表内 `/` 的 heading → `WorkBuddy，我帮你`；`main.test.tsx:60`、`chat-page.test.tsx:80`、`chat-page-ownership.test.tsx:83,216`、`chat-page-lifecycle.test.tsx:398` 的 `会话` heading / 空态文案断言改 hero 或面包屑；`files-page.test.tsx:35` 加 `closest("main") === null` 断言（`:112` 保持原样：jsdom 的 banner 角色不按祖先限定，预览 toolbar `<header>` 也算 banner）；`settings-footer.test.tsx:47`、`routes.test.tsx:179`、`ui-walk.spec.ts:82` 的 `会话` 映射同步。`ui-walk.spec.ts` `ROUTES` `/` heading → `WorkBuddy，我帮你`，选中会话后增一条 banner 面包屑断言。

## Non-goals
`≤760` 欢迎态 `打开导航` 窄条与 Drawer（2.3 / #283——按钮无接线即占位，违反"不得先摆上"，故 2.2 欢迎态在任何宽度都不渲染顶栏，spec delta 如实记录）；欢迎页 chip/卡片/免责声明（4.4 / #289）；面包屑 `我的工作` 作为返回按钮、重命名/搜索/产物/更多按钮（无对应阶段）；`/center` 页内 tab（S1d）；`chat/page.tsx` 拆分（4.x）。

## Capabilities
### Modified
- `spa-shell`：「路由 IA 与侧栏」增顶栏三态与页面级 heading 归属句、新增 Scenario「顶栏三态」（2.2 版：欢迎态无顶栏）。
- `chat-web`：「会话页」heading 句改为跟随 spa-shell（欢迎态 hero h1 / 有会话面包屑 h1，页面不再渲染自有 h1）。

## Impact
- 新文件：`web/src/lib/topbar.tsx`、`web/src/routes/shell/{app-shell.tsx,topbar.tsx,topbar.css}`、`web/test/topbar.test.tsx`。改：`router.tsx`、`styles.css`、`chat/{page.tsx,conversation-view.tsx,chat.css}`、`files/{page.tsx,files.css}`、`settings/page.tsx`、七份 jsdom 测试、`ui-walk.spec.ts`。不改 `web/src/ui/**`、不加依赖。
- 守卫：`routes/**`/`lib/**` 的 hex/rgba/palette 禁令；`chat/page.tsx` 现 729 行（净增 ≤ 5）；`ui-walk.spec.ts` 800 行（size-guard 不扫 e2e，本刀净增 ≤ 3 行，2.3/6.1 前需拆 helper）；PR diff 预计 > 400 行（`constraints.yaml` review-only）。
- 既有 `工作空间`/`设置` heading 断言（settings-footer/sidebar/auth-router 等）经路由挂载时仍能命中顶栏 h1，无需改动；需改的是所有 `会话` heading 映射（含 `settings-footer.test.tsx:47`、`ui-walk.spec.ts:82`）与 hero 相关断言。

### 与 oracle / demo 的偏差留痕
1. 欢迎态 `≤760` 不渲染窄条（spec 终态为"只含 `打开导航`"）：按钮由 2.3 接线，2.2 不摆占位。
2. 面包屑 `我的工作` 为纯文本（demo 为返回欢迎页按钮）：无对应阶段要求，YAGNI。
3. 顶栏不渲染 demo 的折叠按钮、主题切换、搜索/产物/更多、页面操作位。
4. hero 只取 demo `.hero` 的字号/行高/居中，不移植高亮下划线 SVG 与 PingFang 字体栈（token 层已去专有字体）。
5. `TopbarProvider`/`useTopbar` 放 `web/src/lib/`（父 design 说"shell context"）：避免 feature 反向 import routes。
6. `AppShell` 抽到 `routes/shell/app-shell.tsx` 并新增 `.app-content` 包裹层：`.app-shell > main > *` 会把作为 `main` 直接子元素的顶栏拉伸；顶栏在 `main` 外也是 `<header>` 取得隐式 banner 的前提。

## Risk triage
Issue type: feature（外壳结构 + 跨页面 heading 归属，decision-dense）
Fixture level: expanded
Upstream suggested level: expanded (agree：页面级 heading 是 jsdom 与 e2e 所有路由断言的锚点，两条路径须同 PR 绿)
Blast radius: 全部已认证路由的 level-1 heading 归属改变；`routes.test.tsx` 的 `expectRouteShell`、三份 chat-page 测试、`files-page`、`main` 与 ui-walk `ROUTES` 任一漏改即红；`AppShell` 结构变化牵动 `styles.css` 布局选择器与 ui-walk `expectDesktopLayout`；chat 页与 shell 之间新增上报契约。
Selected risk packs: Public API / CLI / script entry（`useTopbar`/`TopbarProvider`/`Topbar`/`AppShell` 出口与契约）；Concurrency / shared state / ordering（上报 effect 的设置/清理次序：路由切换、会话切换、页面卸载后 breadcrumb 必须归零；StrictMode 双 effect）；Legacy compatibility / examples（既有 heading 断言、`expectDesktopLayout`、裸挂 `ChatPage` 的测试在 Provider 外 no-op）；Documentation / migration notes（heading 定位以 banner/hero 为范围的写法供 4.4/6.1 复用）。
Evidence floor: `make check` exit 0；`web/test` 全绿含新 `topbar.test.tsx`；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed（`/` 欢迎态 hero、其它路由顶栏 h1、选中会话后面包屑）。
