# Design: app-shell-responsive（#283）

Change surface: 新 `web/src/lib/viewport.ts`、`web/test/app-shell-responsive.test.tsx`、`web/test/media-query-support.ts`；改 `web/src/routes/shell/app-shell.tsx`、`web/src/routes/shell/sidebar.tsx`、`web/src/routes/shell/sidebar.css`（删 `:229-299`，加覆盖层变体规则）、`web/src/features/auth/provider.tsx`（`logoutPending` 上提）、`web/src/features/auth/footer.tsx`（读 Provider 的 pending，删本地 `pending` state）、`web/src/routes/shell/topbar.tsx`、`web/src/routes/shell/topbar.css`（按需）、`web/src/styles.css`（`≤760` 块删一行）、`web/test/sidebar.test.tsx`（`:257` `narrowCss` helper、`:293-310` 两用例）、`web/test/theme-provider.test.tsx`（改 import 共享 mock，断言不动）。不改 `web/src/ui/**`、`web/e2e/**`、`web/playwright.config.ts`、chat/files feature css。

Must preserve: `≥761px`（含 jsdom 无 `matchMedia` 的默认态）外壳与 2.2 逐字节一致——文档流 `aside[aria-label=侧栏]`、折叠 288/48 + `workbuddy-sidebar` 读写、品牌区与 `折叠侧栏`/`展开侧栏` 按钮、欢迎态无顶栏、面包屑/页面标题 header、无 `打开导航`；`Drawer` 属性面（`open/onOpenChange/side/width/title/footer/children`，ui-primitives spec）不扩；`AuthFooter` 的全部可观测行为（`web/test/settings-footer.test.tsx` 零改动仍绿：同 tick 双击只发一次、pending 期间触发按钮可用、重开确认框忙碌禁用 + `关闭`、状态 note、失败提示与重试）；`AuthContextValue` 既有字段与 `logout(): Promise<boolean>` 语义；`useTopbar`/`Topbar` 三态判定与 heading 归属规则（每路由页面级 h1 恰一，`≤760` 窄条不含 heading）；`styles.css` `≤760` 块的页面级滚动模型（`body{overflow:auto}`、`.app-shell{height:auto;min-height:100dvh;overflow:visible}`、`.app-content > main{overflow:visible}`）与 `.theme-options`/`.login-card,.settings-page` 规则；`chat.css:405`/`files.css:625` 的 `≤760` 块；`web/test` 除 `sidebar.test.tsx` 两用例与 `theme-provider.test.tsx` 的 import 外全部不改仍绿；`ui-walk` 单 project 1280 全绿；ui-guardrails（无 hex/`rgba(`/palette、无 `style={`、features/routes 不 import `@radix-ui`）；新增 `.tsx/.css` 注释不含 `#NNN`。

Must add/change:
- `web/src/lib/viewport.ts`：
  ```ts
  export const SHELL_NARROW_QUERY = "(max-width: 760px)";
  function queryList(query: string): MediaQueryList | null {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    try { return window.matchMedia(query); } catch { return null; }
  }
  /** 订阅媒体查询；无 matchMedia（jsdom/SSR）或抛错时恒为 false（宽屏）。 */
  export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((onChange: () => void) => {
      const list = queryList(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    }, [query]);
    const read = useCallback(() => queryList(query)?.matches ?? false, [query]);
    return useSyncExternalStore(subscribe, read, () => false);
  }
  ```
  不复用 `features/theme/provider.tsx` 的 `getMediaQuery`（feature 私有；不反向依赖）。
- `web/src/routes/shell/app-shell.tsx`：
  ```tsx
  export function AppShell() {
    const [collapsed, toggle] = useSidebarCollapsed();
    const narrow = useMediaQuery(SHELL_NARROW_QUERY);
    const [navOpen, setNavOpen] = useState(false);
    useEffect(() => { if (!narrow) setNavOpen(false); }, [narrow]);   // 切回宽屏复位，避免再次窄屏时复活
    const closeNav = useCallback(() => setNavOpen(false), []);
    const openNav = useCallback(() => setNavOpen(true), []);
    return (
      <TopbarProvider>
        <div className="app-shell">
          {narrow ? (
            <Drawer onOpenChange={setNavOpen} open={navOpen} side="left" title="导航" width={288}>
              <Sidebar onNavigate={closeNav} variant="overlay" />
            </Drawer>
          ) : (
            <Sidebar collapsed={collapsed} onToggle={toggle} />
          )}
          <div className="app-content">
            <Topbar onOpenNav={narrow ? openNav : undefined} />
            <main><Outlet /></main>
          </div>
        </div>
      </TopbarProvider>
    );
  }
  ```
  `Drawer` 经 `../../ui/index.js` 导入（唯一出口）。`useSidebarCollapsed` 在两档都调用（只读一次 storage；写入只在 `toggle`，覆盖层永不调 `toggle`）。`≥761` 时 `Drawer` 组件不在树中（Radix Root/Portal 均不存在）；可观测契约是无 `dialog`、无 `打开导航`。
- `web/src/routes/shell/sidebar.tsx`：
  ```ts
  type SidebarProps =
    | { variant?: "inline"; collapsed: boolean; onToggle: () => void }
    | { variant: "overlay"; onNavigate: () => void };
  ```
  `const overlay = props.variant === "overlay"; const collapsed = overlay ? false : props.collapsed;`；`<aside aria-label="侧栏" className="sidebar" data-collapsed={collapsed ? "true" : "false"} data-variant={overlay ? "overlay" : "inline"}>`；品牌区 `div.sidebar-brand`（含折叠按钮）仅 `!overlay` 渲染；NavLink 加 `onClick={overlay ? props.onNavigate : undefined}`（Enter 触发 click，键盘同路）；其余（Tooltip 折叠态分支、`AuthFooter`）不变。覆盖层内 `AuthFooter` 照常渲染：`Menu` 内容与 `ConfirmDialog` 都是 Drawer 内容的 React 子树，Radix DismissableLayer 以 React 树（`onPointerDownCapture`）判定"内部"，FocusScope 栈会在菜单/确认框打开时暂停 Drawer 的焦点圈——不需要 `modal` 改动；R9 用测试钉住而不是靠推理。**但 Drawer 关闭即卸载内容**：`AuthFooter` 目前把退出 pending 放在本地 state（`footer.tsx:8-10`），窄屏下“确认退出 → 关闭确认框 → 关闭覆盖层 → 重开”会得到一个全新实例，状态 note 消失、重开的确认框 `退出` 可点、`取消` 文案回退——违反 spec 的“重复退出被锁定”。因此 pending 上提到 Provider（下一条）。
- `web/src/features/auth/provider.tsx` + `footer.tsx`（pending 上提，行为不变）：`AuthState` 增 `logoutPending: boolean`（初值与各 reset 分支为 `false`）；`useLogout` 在 `startOperation` 后的 `setState` 里同时置 `logoutPending: true`，并在 `finally` 中 `finishOperation` 之后、若 `mountedRef.current` 且 `operationRef.current?.kind !== "logout"`（已无退出请求在途）则置回 `false`（updater 内 `logoutPending` 已为 false 时原样返回，避免多余渲染）（成功路径 `clearSession` 进入 unauthenticated 状态自然为 false；被 supersede 的旧 logout 不清新 logout 的标志）；`logout()` 返回值语义不变。`AuthFooter`：删本地 `pending`/`setPending`，`const { logout, logoutError, logoutPending, principal } = useAuth()`，`cancelText`/`pending` prop/状态 note/说明段全部读 `logoutPending`；保留 `pendingRef` 作同 tick 双击守卫（第二次点击不得调用 `logout()`，否则 Provider 返回 false 会关掉确认框）；`!succeeded` 分支只 `setConfirming(false)`。`AuthContextValue` 多一个只读字段，`useAuth` 消费者不受影响。
- `web/src/routes/shell/topbar.tsx`：
  ```tsx
  type TopbarProps = { onOpenNav?: (() => void) | undefined };
  export function Topbar({ onOpenNav }: TopbarProps) {
    …route 解析同现状…
    const navButton = onOpenNav ? (
      <Button aria-label="打开导航" className="topbar-nav" onClick={onOpenNav} size="icon" variant="ghost">
        <Icon name="menu" size={16} />
      </Button>
    ) : null;
    if (!route) return null;
    if (route.path === "/" && breadcrumb === null && !navButton) return null;   // 宽屏欢迎态：与 2.2 相同
    const title = route.path === "/"
      ? (breadcrumb === null ? null : <h1 className="topbar-title topbar-crumbs">…同现状…</h1>)
      : <h1 className="topbar-title">{route.title}</h1>;
    return <header className="topbar">{navButton}{title}</header>;
  }
  ```
  **按钮永远是 `header` 的首子节点**，三态间只有 `title` 槽变化 → React 不重挂按钮，Drawer 的 `useFocusHandoff` 归还焦点时目标仍在文档中。`Button` 透传 `className`（`button.tsx:15`）。
- `sidebar.css`：删除 `:229-299`（注释 + 整个 `@media (max-width: 760px)` 块）；新增
  ```css
  /* Drawer 内的覆盖层变体：底色、边框与标题行由 Drawer 提供，本体填满 ui-drawer-body。 */
  .sidebar[data-variant="overlay"] { width: 100%; min-height: 100%; overflow: visible; background: transparent; border-right: 0; transition: none; }
  .sidebar[data-variant="overlay"] nav { padding: 0; }
  ```
  `min-height:100%` + `overflow:visible`（而非基础规则的 `height:100%;overflow:hidden`）让矮视口下由 `.ui-drawer-body` 滚动而不是裁掉用户区；`.sidebar-footer`（`:116`）的 `margin-top:auto`/`border-top` 在覆盖层内照用，使用户区贴底。`.ui-drawer-body` 自带 `padding:16px 18px; overflow-y:auto`，不改。
- `styles.css` `≤760` 块：删 `.app-shell{flex-direction:column;…}` 中的 `flex-direction: column;` 一行（侧栏已不在文档流，剩余三条保留）。
- `topbar.css`：如需对齐，只加 `.topbar-nav { flex: none; margin-left: -6px; }` 一类几何规则；不引入新 token。
- 测试：
  - `web/test/media-query-support.ts`：导出 `FakeMediaQuery` 类型、`createMediaQuery(initialMatches)`（`theme-provider.test.tsx:16-34` 原样搬出）、`installMatchMedia(resolve: (query: string) => FakeMediaQuery)`（`Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: vi.fn(resolve) })`）与 `uninstallMatchMedia()`（同样 `defineProperty` 置 `value: undefined`——`delete window.matchMedia` 在 strict TS 下是 TS2790，`theme-provider.test.tsx:155` 已用此法）；`FakeMediaQuery` 类型只在新测试确实 import 时导出（knip）；`theme-provider.test.tsx` 改为 `installMatchMedia(() => mediaQuery)`，其余不动。
  - `web/test/sidebar.test.tsx`：删 `:257` `narrowCss`；`:293-300` 用例去掉 `≤760 回到文档流` 断言与标题后缀；删 `:302-310` 用例。
  - 新 `web/test/app-shell-responsive.test.tsx`：见 Seams。挂载走 `mountAuthenticatedApp`（fetch 路由照 `topbar.test.tsx:64-78` `mountApp`），`import "./radix-platform.js"`；`installMatchMedia((q) => q === SHELL_NARROW_QUERY ? narrow : wideOther)` 在挂载前调用（theme provider 也会以 `(prefers-color-scheme: dark)` 调 `matchMedia`，必须按 query 分派）；`afterEach` `uninstallMatchMedia()`、`vi.restoreAllMocks()`、清 storage、dispose router、`cleanup()`。R8 的 `setItem` spy 必须在预置 `collapsed` **之后**安装。焦点归还断言前先 `button.focus()` 再 `fireEvent.click`（jsdom 的 click 不移焦点，`useFocusHandoff` 记录的是打开瞬间的 `activeElement`），归还发生在 FocusScope 卸载后的宏任务，断言放 `waitFor` 内（先例 `ui-dialog.test.tsx:531-537`）。`aria-hidden` 断言对象是 `mounted.view.container`（RTL 容器；`#root` 只在 `main.test.tsx` 存在，按 `#root` 查会恒真）。Drawer 打开期间 `#root` 被 `aria-hidden`，对话框外的查询用 `{ hidden: true }`；对话框内用 `within(dialog)`。

Governing invariant: 外壳唯一断点 `760`：`≤760px` 时每个已认证路由（含 `/` 欢迎态）都能经顶栏 `打开导航` 到达主导航，导航以 Drawer 覆盖层承载且是**瞬时状态**——始终展开、默认关闭、选路由/Escape/遮罩/`关闭` 即关闭、关闭或 `≥761` 时不在 DOM、任何开合不读不写 `workbuddy-sidebar`；`≥761px` 与 2.2 完全相同；2.2 的"页面级 h1 恰一"在 `≤760` 继续成立（窄条无 heading）。

Sibling surfaces: `web/src/ui/drawer.tsx`（首个消费者，API 不扩；ui-primitives spec 第 22 行枚举属性面）；`web/src/features/theme/provider.tsx` `getMediaQuery`（各自守卫，不合并）；`chat.css:405`/`files.css:625` `≤760` 块（4.x/5.x）；`web/e2e/ui-walk.spec.ts` + `playwright.config.ts`（6.1 #295：`openNav()` 用按钮 `打开导航` / 对话框 `导航` 定位）；#318（桌面折叠态浮出 note）；5.3（`≤900` 树栏 210）；`web/test/topbar.test.tsx` T1（宽屏欢迎态无 banner，靠 `matchMedia` 缺失兜底继续成立）。

Seams under test（`web/test/app-shell-responsive.test.tsx`；先红 = `lib/viewport.js` 不存在 / `打开导航` 不存在 / 横条 CSS 仍在）:
- (R1) 窄屏欢迎态：`narrow.matches=true` 挂 `/` → `.topbar` header 存在且含 `button[name=打开导航]`、header 内无 heading；`getAllByRole("heading", { level: 1 })` 恰为 hero；无 `dialog`、无 `navigation[name=主导航]`、无 `complementary[name=侧栏]`、无 `折叠侧栏`/`展开侧栏`。
- (R2) 宽屏：`narrow.matches=false` 挂 `/` → 文档流 `aside` 存在、无 `打开导航`、无 `dialog`、无 banner；(R2b) 不安装 `matchMedia`（jsdom 默认）→ 同 R2；(R2c) `matchMedia` 抛错（`installMatchMedia(() => { throw new Error("boom"); })`）→ 同 R2，无 `console.error`。
- (R3) 打开并选路由：R1 状态 `focus()` 并点击 `打开导航` → `findByRole("dialog", { name: "导航" })`；对话框 `data-side="left"` 且含类 `ui-drawer--w288`；对话框内 `navigation[name=主导航]` 4 个链接、标签文本可见（`within(link).getByText("工作空间")`）、`aside[data-collapsed="false"][data-variant="overlay"]`、无折叠按钮、无品牌字标；`view.container` `aria-hidden="true"`；点击链接 `/^工作空间/` → `waitFor` 对话框消失、`.topbar h1` 文本 `工作空间`、`view.container` 无 `aria-hidden`、`waitFor(document.activeElement === 打开导航按钮)`、`localStorage.setItem` spy 未调用且 `getItem("workbuddy-sidebar")` 为 null。
- (R4) 窄屏 `/?session=<id>`（复用 `chat-page-support.tsx` `renderChatPage` 或本文件路由）→ header 含 `打开导航` 与唯一 h1 `我的工作 / 周报`；(R4b) 标题未知窗口（列表与历史均挂起，`topbar.test.tsx` T2c 的窄屏对应）→ header 只含 `打开导航`、无 heading、无 hero，页面级 h1 为 0。
- (R5) 窄屏 `/settings` 直挂 → header 含 `打开导航` 与 h1 `设置`；`getAllByRole heading level 1` 长度 1。
- (R6) 关闭路径：（先 `focus()` 打开者）打开后 Escape（`fireEvent.keyDown(document.activeElement, { key: "Escape" })`）→ 关闭、`waitFor` 焦点回 `打开导航`；再打开后点 `关闭` → 关闭。
- (R7) 视口切换：`matches=false` 挂载 → `act(() => narrow.emit(true))` → `aside` 消失、按钮出现；打开覆盖层 → `act(() => narrow.emit(false))` → `dialog` 消失、`aside` 回到文档流（`data-collapsed="false"`）、`view.container` 的 `aria-hidden`（打开时先断言为 `"true"`）已移除、无 storage 写入；`act(() => narrow.emit(true))` → 无 `dialog`（不复活）、按钮存在。
- (R8) 预置偏好：`localStorage.setItem("workbuddy-sidebar", "collapsed")` 后窄屏挂载并打开 → 覆盖层标签可见（展开态），`getItem` 仍为 `collapsed`、`setItem` spy 未调用；`emit(false)` → 文档流 `aside[data-collapsed="true"]`；再 `emit(true)` → 无 `dialog`、`打开导航` 存在。
- (R9) 覆盖层内用户区：打开覆盖层 → 对话框内 `用户菜单` 以 `fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" })` 打开 → `findByRole("menuitem", { name: "退出登录" })` 点击 → `alertdialog[name=退出登录？]`（`ConfirmDialog` 是 `role="alertdialog"`，`confirm-dialog.tsx:57`）可见且 `dialog[name=导航]` 仍在 DOM（`hidden: true`）；点 `取消` → 确认框消失、`导航` 对话框仍打开、`waitFor` 焦点回 `用户菜单` 触发按钮。
- (R9b) 覆盖层内退出锁跨重开：`/api/auth/logout` 挂起；打开覆盖层 → 菜单 → `退出登录` → 点 `退出`（fetch 到 logout 恰 1 次）→ Escape 关确认框 → Escape 关覆盖层（内容卸载）→ 再点 `打开导航` → 菜单 → `退出登录` → 重开的 `alertdialog` 内 `退出` 为 `disabled` 且 `aria-busy="true"`、存在 `关闭` 按钮、覆盖层内 `status` note `正在退出登录…` 存在、fetch 次数未增；resolve 204 → 登录页。
- (R9b′) 重挂 footer 的退出失败：R9b 前置后在重开的锁定态确认框里让挂起请求以 403 信封落定 → 确认框关闭、`导航` 覆盖层仍开、覆盖层用户区 `alert` 可见（未被 aria-hidden）、无登录页、logout fetch 1 次（`footer.tsx` 在 `logoutError` 变为非空时关确认框；review round 1 C1/TE-F2）。
- (R9c) 跨断点保锁：窄屏确认退出挂起、确认框仍开时 `emit(false)` → 无 `dialog`/`alertdialog`、容器无 `aria-hidden`、文档流 `aside` 出现；其用户区重开确认框仍忙碌禁用 + `关闭` + status、fetch 仍 1；`emit(true)` 无 dialog；204 → 登录页（review round 1 TE-F1）。
- (R10) 静态契约：`sidebar.css` 不含 `max-width: 760px`、含 `.sidebar[data-variant="overlay"]`；`styles.css` `≤760` 块体（`blockBody`）不含 `flex-direction: column`；`app-shell.tsx` 含 `useMediaQuery(SHELL_NARROW_QUERY)` 与 `from "../../ui/index.js"` 导入的 `Drawer`；`topbar.tsx` 含 `打开导航`、不含 `@radix-ui`；`viewport.ts` 含 `useSyncExternalStore` 与 `(max-width: 760px)`；`web/src/ui/drawer.tsx` 的 props 类型仍只含 `open/onOpenChange/side/width/title/footer/children`（不扩 API）。
- 既有：`sidebar.test.tsx` 改后全绿；`theme-provider.test.tsx` 改 import 后全绿；`topbar.test.tsx`、`settings-footer.test.tsx`、`routes.test.tsx` 等不改仍绿（宽屏兜底）。
- ui-walk（CI 单 project 1280）：不改 spec，1 passed。

Required evidence:
- 先红后绿：`app-shell-responsive.test.tsx` 实现前红（模块不存在 / 无按钮）；`sidebar.test.tsx` 两用例调整在删 CSS 前后一致；实现后 `web/test` 全绿。
- 反向注入各红并回退：`useMediaQuery` 的兜底返回 `true`（`queryList` 为 null 时按窄屏）→ R2b/R2c 与既有套件红；`Sidebar` 覆盖层仍渲染折叠按钮 → R3 红；NavLink 不接 `onNavigate` → R3 红（对话框不关）；覆盖层打开时调用 `toggle`/`writeCollapsed` → R3/R8 红；`AppShell` 不在 `narrow=false` 时复位 `navOpen` → R7 复活断言红；`Topbar` 窄屏欢迎态返回 `null` → R1 红；给 `打开导航` 按钮加 `key={pathname}`（路由切换重挂）→ R3 焦点归还断言红（`{title}{navButton}` 这种位置调换不会重挂：React 按位置对齐、按钮仍在同一槽位，不能用作注入）；`Sidebar` 覆盖层以 `collapsed` 读到的值渲染 → R8 红；`AuthFooter` 保留本地 `pending` state 不读 Provider → R9b/R9b′/R9c 红；删去 footer 的 `logoutError` 关框 effect → R9b′ 红。
- `make check` exit 0（size-guard：所有文件 < 800；knip：`useMediaQuery`/`SHELL_NARROW_QUERY`/`media-query-support` 各有消费者；jscpd 0 clones；guardrails）；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。
- `grep -n "max-width: 760px" web/src/routes/shell/sidebar.css` 为空；`git diff --stat web/src/ui web/e2e web/playwright.config.ts` 为空。

Non-goals: 1100/`≤900` 档；Playwright 双 project、`openNav()`；#318；chat/files `≤760` 内部；覆盖层持久化/手势/吸顶；Drawer API 扩展；覆盖层内品牌区；`features/theme` 的 matchMedia 守卫合并。

Review focus: (0) 新增 `.tsx/.css` 注释不含 `#NNN`；(1) 覆盖层"瞬时、不持久化"：任何路径都不调 `toggle`/`writeCollapsed`，且不以 storage 中的 `collapsed` 渲染（R3/R8）；(2) 视口跨越 760 的四个转换（宽→窄、窄开→宽、宽→窄不复活、`#root` aria-hidden 复位）（R7）；(3) `打开导航` 在三态中树位置稳定、焦点归还（R3/R6）；(4) `≥761` 与 jsdom 默认态逐字节等于 2.2（R2/R2b + 既有测试零改动）；(5) `AuthFooter` 在模态 Drawer 内的菜单/确认框叠层（R9），以及 pending 上提后 `settings-footer.test.tsx` 零改动全绿、窄屏重开锁定（R9b）；(6) 删除的横条 CSS 无残留、`styles.css` 页面级滚动模型未被顺手改掉；(7) 依赖方向：`lib/viewport` 无 import，`routes/shell` 只经 `ui/index.js` 取 `Drawer`；(8) `e2e`/`ui/` 零 diff。
