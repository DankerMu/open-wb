# Design: app-shell-topbar（#282）

Change surface: 新 `web/src/lib/topbar.tsx`、`web/src/routes/shell/app-shell.tsx`、`web/src/routes/shell/topbar.tsx`、`web/src/routes/shell/topbar.css`、`web/test/topbar.test.tsx`；改 `web/src/routes/router.tsx`（删内联 `AppShell` 与 PlaceholderPage h1）、`web/src/styles.css`（`.app-content` 层、`main` 选择器改名、删 `.ui-page-heading`、`@import` topbar.css）、`web/src/features/chat/{page.tsx,conversation-view.tsx,chat.css}`、`web/src/features/files/{page.tsx,files.css}`、`web/src/features/settings/page.tsx`、`web/test/{routes,main,chat-page,chat-page-ownership,chat-page-lifecycle,files-page,settings-footer}.test.tsx`（settings-footer 只改 `:47` `expectAuthenticatedShell` 的 `/` → `WorkBuddy，我帮你`）、`web/e2e/ui-walk.spec.ts`。

Must preserve: 路由表、`RouteHandle`/`useMatchedCanonicalPath`/canonical 重定向、`ProtectedAppShell` 的 Provider 树顺序（Theme → Auth → Guard）与 `router.tsx:88-112`；`Sidebar`/`useSidebarCollapsed` 用法；`<main>` 仍是 `.app-shell` 内唯一 `main`（ui-walk `expectDesktopLayout` 取 `main` boundingBox、`role=main` 定位）；四个页面除 h1 外的结构与文案（files 状态行、settings 两卡、center 描述 `<p>`）；chat 页会话列表/composer/流式逻辑与 `sessionTitle` 回退 `新会话`；登录页 `<h1>登录 WorkBuddy</h1>` 与 files 预览 Markdown h1（内容 heading，不计）；`工作空间`/`设置` 的既有 heading 断言在经路由挂载的测试里继续命中（顶栏 h1 同名；`settings-footer.test.tsx:47` 的 `/` → `会话` 映射除外，须改 hero）；`chat-page-lifecycle-support.tsx` 裸挂 `<ChatPage/>`（无 Provider）不抛错；`sidebar.css` 与 760 横条降级不动；`web/src/ui/**` 不动。

Must add/change:
- `web/src/lib/topbar.tsx`：
  ```tsx
  type TopbarContextValue = { breadcrumb: string | null; setBreadcrumb: (next: string | null) => void };
  const TopbarContext = createContext<TopbarContextValue | null>(null);
  export function TopbarProvider({ children }) { const [breadcrumb, setBreadcrumb] = useState<string | null>(null); const value = useMemo(() => ({ breadcrumb, setBreadcrumb }), [breadcrumb]); return <TopbarContext.Provider value={value}>{children}</TopbarContext.Provider>; }
  /** 页面向 shell 上报面包屑；Provider 外 no-op。变更即更新，卸载或改为 undefined 时清空。 */
  export function useTopbar({ breadcrumb }: { breadcrumb?: string | undefined }): void { const ctx = useContext(TopbarContext); const set = ctx?.setBreadcrumb; useEffect(() => { if (!set || breadcrumb === undefined) return; set(breadcrumb); return () => set(null); }, [set, breadcrumb]); }
  export function useTopbarBreadcrumb(): string | null { return useContext(TopbarContext)?.breadcrumb ?? null; }
  ```
  只在 `breadcrumb` 有值时写入，清空一律由 cleanup 负责（卸载、路由切换、会话取消选中都走 cleanup）——因此"cleanup 不清空"这一注入会真实变红。StrictMode：effect 双跑为 set→clear→set，最终一致。
- `web/src/routes/shell/topbar.tsx`：
  ```tsx
  export function Topbar() {
    const { pathname } = useLocation(); const breadcrumb = useTopbarBreadcrumb();
    const canonical = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const route = routeManifest.find((entry) => entry.path === canonical);
    if (!route) return null;
    if (route.path === "/") {
      if (breadcrumb === null) return null;   // 欢迎态：不渲染（≤760 窄条随 2.3）
      return (<header className="topbar"><h1 className="topbar-title topbar-crumbs"><span className="topbar-crumb-root">我的工作</span> / <span className="topbar-crumb-current">{breadcrumb}</span></h1></header>);
    }
    return (<header className="topbar"><h1 className="topbar-title">{route.title}</h1></header>);
  }
  ```
  JSX 中 `</span> / <span` 的字面 ` / ` 保留为文本节点，accessible name = `我的工作 / <标题>`。不写 `role="banner"`（`<header>` 不在 `main/section/article` 内即隐式 banner；biome `a11y/noRedundantRoles`）。
- `web/src/routes/shell/app-shell.tsx`：
  ```tsx
  export function AppShell() { const [collapsed, toggle] = useSidebarCollapsed(); return (<TopbarProvider><div className="app-shell"><Sidebar collapsed={collapsed} onToggle={toggle} /><div className="app-content"><Topbar /><main><Outlet /></main></div></div></TopbarProvider>); }
  ```
  `router.tsx` 删 `:11-21` 内联 `AppShell`、改 `import { AppShell } from "./shell/app-shell.js"`；`Sidebar`/`useSidebarCollapsed` import 随之移入 app-shell.tsx。PlaceholderPage `:83-90` 删 `<h1>`，外层元素与 `<p>{description}</p>` 按现状保留（现为 `ui-empty` 容器）；`title` 不再消费，从 Pick 与 `routeManifest.map` 解构中一并去掉。
- `styles.css`：`@import "./routes/shell/topbar.css";`（sidebar.css 之后）；`:217-231` 的 `.app-shell > main` / `.app-shell > main > *` 选择器改为 `.app-content > main` / `.app-content > main > *`，其前新增 `.app-content { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }`；760 块 `:444-446` `.app-shell > main` 同步改名；删 `:179-184` `.ui-page-heading`。
- `topbar.css`（头注释 demo:313-322 来源；语义 token）：`.topbar{flex:none;display:flex;align-items:center;gap:10px;height:56px;min-height:56px;padding:0 12px 0 16px;background:var(--wb-home-bg-secondary);border-bottom:1px solid var(--wb-border-card)}`（demo:313-314）；`.topbar-title{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:20px;color:var(--wb-text-primary)}`（demo:315-316 `.crumbs b`）；`.topbar-crumbs{display:flex;align-items:center;gap:7px;font-weight:400;color:var(--wb-text-secondary)}`；`.topbar-crumb-current{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--wb-text-primary)}`。
- 页面：`chat/page.tsx` 删 `:702` h1，删 `EMPTY_SELECTION`（`:29`）与 `emptySelection` 传参（`:707`）；在 `:686-688`（`listForClient`/`historyView` 派生之后）加 `useTopbar({ breadcrumb: selectedSessionTitle(requestedSessionId, listForClient, ownedHistory, historyState) })`；派生逻辑为 `session-path.ts` 的纯函数 `selectedSessionTitle(...)`（内联会使 `ChatPage` 触发 biome `noExcessiveCognitiveComplexity` 21 > 15）：列表优先——服务端刷新标题的来源；快照兜底；不新增请求；未加载/无选中 → `undefined`。hooks 顺序：`useTopbar` 必须在任何早退 return 之前、且每次渲染都调用。`conversation-view.tsx:214-219` 改为 `requestedSessionId ? (historyView ? <MessageThread historyView={historyView} /> : null) : <h1 className="chat-hero">WorkBuddy，我帮你</h1>`——**欢迎态 = `requestedSessionId === null`**；已选会话但历史未就绪/出错时不渲染 hero（否则与面包屑 h1 并存）；`emptySelection` prop 删除。`chat.css:20` `.chat-page > .ui-page-heading` 删；`:199` `.chat-welcome` → `.chat-hero{margin:0 0 16px;font-size:30px;font-weight:600;line-height:42px;text-align:center;text-wrap:balance;color:var(--wb-text-primary)}`（demo:341，去字体栈）。`files/page.tsx:410` 删 h1，`files.css:19` 删对应规则；`settings/page.tsx:99` 删 h1。
- 测试：
  - `routes.test.tsx`：`expectedPages`/`trailingSlashPages` 表内 `/` 的 `title` → `WorkBuddy，我帮你`（其它三项不变）；`expectRouteShell:179` 的 `if (title === "会话")` 改为 `title === "WorkBuddy，我帮你"`（否则 composer/`新建会话` 断言成死分支）。
  - `main.test.tsx:60` `会话` → `WorkBuddy，我帮你`；`chat-page.test.tsx:80`、`chat-page-lifecycle.test.tsx:398`：按各自 fixture 状态改——欢迎态 → hero；已选中会话（经路由挂载时）→ `getByRole("banner")` 内 h1 名 `我的工作 / <title>`；裸挂 `ChatPage`（lifecycle-support）无 Provider → 断言页面无 level-1 heading 或只断言 hero（视用例状态）；`chat-page-ownership.test.tsx:83,216`：`会话` heading → hero，`选择一个会话…` 文案断言 → hero heading（404 后 URL 先替换、React 后渲染，须 `await findByRole`）；`chat-page.test.tsx:110` 的 `getByText("saved title")` 会同时命中面包屑与列表项，限定到 `navigation[name=会话列表]` 内。
  - `files-page.test.tsx:35` 改 `screen.getByRole("heading", { level: 1, name: "工作空间" })` 并断言 `heading.closest("main")` 为 null；`:112` 保持原样（`getAllByRole(heading, {level:1, name:"工作空间"})` 仍恰 1）。**jsdom 注意**：`@testing-library/dom` 的 banner 角色不按祖先限定，`files/preview.tsx:256` 的 `<header className="files-preview-toolbar">` 也会被算作 banner，且预览 Markdown 的 h1 在 `main` 内——凡预览可能打开的用例，用 `.topbar`/`closest("main") === null` 定位顶栏 h1，不用 `getByRole("banner")`；T1–T7 的路由不打开预览，可用 banner。
  - 新 `web/test/topbar.test.tsx`：见 Seams。
- `ui-walk.spec.ts`：`ROUTES` `:30` `/` 的 `heading` → `WorkBuddy，我帮你`；`:82` 硬编码的 `expectAuthenticatedRoute(page, "/", "会话", "会话")` 第三参改 `ROUTES[0].heading`；在会话创建/选中后的既有断言处增一行 `await expect(page.getByRole("banner").getByRole("heading", { level: 1 })).toHaveAccessibleName(/^我的工作 \/ /);`（净增 2 行 → 802 行；size-guard 不扫 e2e，6.1 前拆分）。

Governing invariant: 每个已认证路由在任一时刻恰有一个页面级 level-1 heading，且归属固定——`/` 欢迎态（`requestedSessionId === null`）= chat hero `WorkBuddy，我帮你`（在 `main` 内），已选会话但历史未就绪/出错时不渲染 hero、`/` 有会话 = 顶栏面包屑（在 banner 内，名 `我的工作 / <服务端标题|新会话>`）、其它路由 = 顶栏页面标题（在 banner 内）；页面自身不再渲染页面级 h1（Markdown 内容 heading 除外）；顶栏只从 `useTopbar` 上报与 `routeManifest` 取信息，不 import 任何 feature 数据层；chat feature 只依赖 `lib/topbar`，不依赖 routes；欢迎态无顶栏（2.3 前任何宽度）。

Sibling surfaces: `web/src/routes/shell/sidebar.tsx`（不动；`app-shell.tsx` 消费）；`web/src/features/chat/session-path.ts` `sessionTitle`（复用）；`web/test/chat-page-support.tsx`/`chat-page-lifecycle-support.tsx`（挂载方式决定各用例的 heading 归属，不改 support 文件）；`web/test/sidebar.test.tsx:35`、`auth-router.test.tsx` 等 `工作空间`/`设置` 断言（经路由挂载 → 顶栏 h1 同名，不改；`settings-footer.test.tsx` 只改 `:47`）；`web/test/preview.test.tsx`（Markdown h1，不动）；`web/e2e/ui-walk.spec.ts:343-360 expectAuthenticatedRoute`（不改，页面级 heading 查询仍成立）；2.3（#283：欢迎态 ≤760 窄条 + `打开导航`、Drawer）；4.4（#289：把 hero h1 纳入 `welcome.tsx`）；6.1（#295：`ui-walk.spec.ts` 拆分）。

Seams under test（新文件 `web/test/topbar.test.tsx`；T1/T4/T5 经 `render-app-router.tsx` `mountAuthenticatedApp`，T2/T2b/T3/T6 复用 `chat-page-support.tsx` 的 `renderChatPage` + 会话 fixture（FakeEventSource、`/api/auth/me` 路由已备），`import "./radix-platform.js"`；先红 = `lib/topbar.js`/`shell/topbar.js` 不存在、banner 不存在）:
- (T1) `/` 欢迎态：`queryByRole("banner")` 为 null；`getAllByRole("heading", { level: 1 })` 恰 1 个且文本 `WorkBuddy，我帮你`，位于 `main` 内；旧空态文案不存在。
- (T2) `/?session=<id>`（fetch 路由返回含该 id 与 `title: "周报"` 的列表 + 快照）：`within(getByRole("banner")).getByRole("heading", { level: 1, name: "我的工作 / 周报" })`；`main` 内无 level-1 heading；hero 不存在。
- (T2b) 已选会话、历史未就绪（与 T2 共用 `expectBreadcrumbOnly` helper，避免 jscpd）：复用 `chat-page-support.tsx` 的 `renderChatPage`/deferred 历史 fixture（列表已返回、`initialMessages` 挂起，即 `chat-page.test.tsx:61-80` 状态）→ banner 内 1 个 h1（面包屑），`main` 内 0 个 level-1 heading、无 hero；`chat-page.test.tsx:80` 同步断言 `getAllByRole("heading", { level: 1 })` 长度 1。
- (T3) 标题回退：列表项 `title: null` → banner h1 名 `我的工作 / 新会话`。
- (T4) 其它路由：`/files` → banner h1 `工作空间`；`/settings` → `设置`；`/center` → `中心` 且 `main` 内仍有描述 `中心暂不可用`、无 h1；每个路由 `getAllByRole("heading", { level: 1 })` 长度恰 1（预览内容不在本用例）。
- (T5) 上报清理：从 `/?session=<id>` 点击侧栏 `工作空间`（链接可访问名含副标签，用 `/^工作空间/` 匹配） → banner h1 变 `工作空间`（无面包屑残留）；再点 `会话` → 回欢迎态，banner 消失、hero 出现。
- (T6) 会话切换（StrictMode 挂载，覆盖双 effect）：从 `/?session=a`（`周报`）点击列表中另一会话 `b`（`复盘`）→ banner h1 名变 `我的工作 / 复盘`。
- (T7) Provider 外 no-op：复用 `chat-page-lifecycle-support.tsx` 的 `renderChatPageWithAuthProbe`（无 Provider 裸挂）不抛错、无 `console.error`。
- (T8) 静态契约：`readRepoFile` 断言 `chat/page.tsx`、`files/page.tsx`、`settings/page.tsx`、`routes/router.tsx` 不含 `<h1`；`conversation-view.tsx` 含 `WorkBuddy，我帮你`；`styles.css`/`chat.css`/`files.css` 不含 `ui-page-heading`；`styles.css` 含 `.app-content > main`、不含 `.app-shell > main`；`routes/shell/topbar.tsx` 不含 `role="banner"`、不含 `@radix-ui`、不含 `features/`；`chat/page.tsx` 含 `useTopbar(`、不含 `routes/`；`document.querySelector("main .topbar")` 为 null（T4 挂载后）。
- 既有：`routes.test.tsx` 四路由 + 尾斜杠表改 `/` heading 后全绿；`main`/`chat-page*`/`files-page` 改后全绿；其余不改仍绿。
- ui-walk（CI）：`ROUTES` `/` → hero；选中会话后 banner 面包屑；其它路由 h1 不变；`expectDesktopLayout` 仍成立。

Required evidence:
- 先红后绿：`topbar.test.tsx` 与七份既有测试改动在实现前红（模块不存在 / `会话` heading 仍在 / banner 不存在）；实现后 `web/test` 全绿。
- 反向注入各红并回退：`useTopbar` cleanup 不清空（effect 只在有值时写入）→ T5 红（回到欢迎态后 banner 残留 `我的工作 / …`）；`Topbar` 欢迎态渲染空 header → T1 红；面包屑分隔符写成 aria-hidden → T2 名不匹配红；`route.title` 误用 label（把 `/files` title 改 `文件`）→ T4 红；chat 页不删 h1 → T4/T2 的唯一性红；`app-shell` 把 `Topbar` 放进 `main` → T2/T4 的"`main` 内无 level-1 heading"红 + T8 静态 `document.querySelector("main .topbar") === null` 红（jsdom 的 banner 角色不按祖先限定，不能靠 banner 查询变红）；`useTopbar` 在 Provider 外抛错 → T7 红。
- `make check` exit 0（size-guard：`chat/page.tsx` ≤ 735、其余 < 800；knip：`useTopbarBreadcrumb`/`TopbarProvider`/`Topbar`/`AppShell` 各有消费者；guardrails：`topbar.css` 无 hex/palette）；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。
- `grep -rn "<h1" web/src/features/chat/page.tsx web/src/features/files/page.tsx web/src/features/settings/page.tsx web/src/routes/router.tsx` 为空；`grep -rn "ui-page-heading" web/src` 为空。

Non-goals: `≤760` 欢迎态窄条/`打开导航`/Drawer（2.3）；欢迎页 chip/卡片/免责声明（4.4）；面包屑返回按钮、重命名、搜索、产物、更多、主题切换、顶栏折叠按钮；`chat/page.tsx` 拆分；`ui-walk.spec.ts` 拆分（6.1）。

Review focus: (0) 新增 `.tsx/.css` 注释不含 `#NNN`；(1) heading 唯一性在四路由 × {欢迎, 有会话} 全部成立（T1/T2/T4 + 既有 heading 断言无双命中）；(2) `useTopbar` 的 set/clear 次序：路由切换、会话切换、StrictMode 双 effect、Provider 外 no-op（T5/T6/T7）；(3) `<header>` 隐式 banner 的前提——不在 `main` 内、`app-shell.tsx` 结构与 `.app-content` 选择器改名不漏（760 块）；(4) 面包屑 accessible name 恰为 `我的工作 / <标题>`（分隔符是可见文本节点）；(5) chat 页 `selectedSession` 派生（列表优先、快照兜底）不新增请求、未加载时不上报，hooks 顺序稳定；(5b) 历史挂起/出错时无 hero（T2b）；(6) 删除的 `.ui-page-heading`/`.chat-welcome`/`EMPTY_SELECTION` 无残留引用；(7) `ui-walk.spec.ts` 净增行数与 `ROUTES` 改动；(8) 依赖方向：`lib/topbar` 不 import routes/features，`routes/shell/topbar` 不 import features。
