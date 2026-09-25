# Design: app-shell-sidebar（#281）

Change surface: 新 `web/src/routes/shell/sidebar.tsx`、`web/src/routes/shell/sidebar.css`、`web/src/routes/manifest.ts`、`web/test/sidebar.test.tsx`；改 `web/src/routes/router.tsx`（manifest 迁出、`AppShell` 挂 `Sidebar`）、`web/src/routes/index.ts`（再导出来源）、`web/src/features/auth/footer.tsx`（用户块 → `Menu` trigger，删独立按钮与 getter）、`web/src/styles.css`（删 `.sidebar*`/`.account-*` 与 760 块对应条目，`@import "./routes/shell/sidebar.css"`）、`web/test/settings-footer.test.tsx`（`:52` `expectAuthenticatedShell` 的 `退出登录` 按钮断言 → `用户菜单`；`openLogoutDialog` 与 F2/F3/F4）、`web/test/chat-page-lifecycle.test.tsx:390`、`web/test/routes.test.tsx`（import 路径如需）、`web/e2e/ui-walk.spec.ts`（退出入口 + 折叠往返）。

Must preserve: `<aside aria-label="侧栏">` 与 `<nav aria-label="主导航">`（`routes.test.tsx:184,231`、`auth-router.test.tsx` 七处、ui-walk `:70-75,:115-131,:354-356` 定位）；`NavLink end` 与 `aria-current="page"` 高亮；四路由 label `会话/工作空间/中心/设置`、`/files` 副标签 `文件·预览`；`AuthFooter` 导出与"未认证返回 null"；`<footer>` 在 aside 内（ui-walk `sidebarFooter` = `complementary[name=侧栏] footer`）且 account/role 逐字可见文本（`expectPrincipalFooter`）；`ConfirmDialog` 全部 props 与文案（标题 `退出登录？`、说明、`取消`/`关闭`/`退出`、pending 提示行）；`confirmLogout` 的 `pendingRef` 同 tick 去重、`mountedRef` 守卫、失败回滚 `setConfirming(false); setPending(false)`、成功后 principal 置空整体卸载；`logoutError` `.ui-alert role="alert"` 与 pending `role="status"` 行文案；`chat-page-lifecycle-support.tsx:110,129` 裸挂 `<AuthFooter />`（不在 aside 内，从不打开菜单，无测试覆盖其退出路径——`:390` 实际经 `render-app-router` 挂载）编译与渲染不变；`settings-footer.test.tsx` 除 `:52` helper（约 15 个用例经它断言侧栏，改为断言 `用户菜单` 按钮）与 F2/F3/F4 外其余用例逐字不动；`.brand-mark*` 规则（`login-form.tsx:53`）与 `.app-shell*` 规则不动；ui-walk 其余步骤（四路由、深色、布局）不动；`web/src/ui/**` 不动。

Must add/change:
- `web/src/routes/manifest.ts`：`import type { IconName } from "../ui/index.js"`；`export type RouteDefinition = { path: "/" | "/files" | "/center" | "/settings"; icon: IconName; label: string; subtitle?: string; title: string; description: string }`；`export const routeManifest` 四项照搬 `router.tsx:24-50` 并加 `icon`（`message-square`/`folder`/`layout-grid`/`settings`）。`router.tsx` 删本地定义改 `import { type RouteDefinition, routeManifest } from "./manifest.js"`（`:90,:102,:106,:149,:162` 引用不变）；`routes/index.ts` → `export { routeManifest } from "./manifest.js"; export { createAppRouter } from "./router.js";`（biome organizeImports 要求 manifest 在前）（`routes.test.tsx:4` 经 index 导入，不改）。
- `web/src/routes/shell/sidebar.tsx`：
  - `const STORAGE_KEY = "workbuddy-sidebar"`；`function readCollapsed(): boolean { try { return window.localStorage.getItem(STORAGE_KEY) === "collapsed"; } catch { return false; } }`；`function writeCollapsed(collapsed: boolean): void { try { window.localStorage.setItem(STORAGE_KEY, collapsed ? "collapsed" : "expanded"); } catch { /* 写失败静默，内存状态已更新 */ } }`。
  - `export function useSidebarCollapsed(): readonly [boolean, () => void]`：`useState(readCollapsed)`；`toggle = useCallback(() => setCollapsed(prev => !prev), [])` 之后写入用 `useEffect` 不合适（mount 也会写）——改为 `const toggle = useCallback(() => { const next = !collapsedRef.current; collapsedRef.current = next; setCollapsed(next); writeCollapsed(next); }, [])`，`collapsedRef` 与 state 同步初始化（避免把副作用放进 updater，StrictMode 下 updater 双调）。
  - `export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void })`：
    ```tsx
    <aside aria-label="侧栏" className="sidebar" data-collapsed={collapsed ? "true" : "false"}>
      <div className="sidebar-brand">
        <BrandMark size={24} wordmark={!collapsed} />
        <Button aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={onToggle} size="icon" variant="ghost">
          <Icon name="panel-left" size={16} />
        </Button>
      </div>
      <nav aria-label="主导航"><ul>
        {routeManifest.map(({ icon, label, path, subtitle }) => {
          const link = (
            <NavLink {...(collapsed ? { "aria-label": label } : {})} className="sidebar-link" end to={path}>
              <Icon name={icon} size={16} />
              {collapsed ? null : <span className="sidebar-link-label">{label}</span>}
              {collapsed || !subtitle ? null : <span className="sidebar-link-sub">{subtitle}</span>}
            </NavLink>
          );
          return <li key={path}>{collapsed ? <Tooltip label={label} side="right">{link}</Tooltip> : link}</li>;
        })}
      </ul></nav>
      <AuthFooter />
    </aside>
    ```
    `NavLink` 是 forwardRef 组件，`Tooltip` 的 `Trigger asChild` 可直接包裹；`aria-current` 由 NavLink 自带，高亮走 CSS `[aria-current="page"]`，不再用 `is-active` class。基元只经 `../../ui/index.js`；`AuthFooter` 经 `../../features/auth/index.js`。
- `web/src/routes/router.tsx` `AppShell`：`const [collapsed, toggle] = useSidebarCollapsed(); return <div className="app-shell"><Sidebar collapsed={collapsed} onToggle={toggle} /><main><Outlet /></main></div>`。
- `web/src/features/auth/footer.tsx`：
  ```tsx
  <footer className="sidebar-footer">
    <Menu
      items={[{ icon: "log-out", label: "退出登录", onSelect: () => setConfirming(true) }]}
      trigger={
        <button aria-label="用户菜单" className="sidebar-user" ref={triggerRef} type="button">
          <span aria-hidden="true" className="sidebar-avatar">{principal.account.slice(0, 1).toUpperCase()}</span>
          <span className="sidebar-user-copy">
            <span className="sidebar-user-account">{principal.account}</span>
            <span className="sidebar-user-role">{principal.role}</span>
          </span>
        </button>
      }
    />
    {logoutError ? <p className="ui-alert" role="alert">{logoutError}</p> : null}
    {pending ? <p className="ui-muted" role="status">正在退出登录，可继续浏览或刷新确认登录状态。</p> : null}
    <ConfirmDialog …与现行相同… returnFocus={triggerRef} />
  </footer>
  ```
  `items` 用 `useMemo` 或模块级常量 + 闭包均可（`onSelect` 需 `setConfirming`，放组件内 `useMemo(..., [])`）。删 `useMemo<RefObject>` getter、`RefObject` 类型导入、独立按钮与 `disabled={pending}`。`triggerRef: RefObject<HTMLButtonElement | null>` 可赋给 `RefObject<HTMLElement | null>`。`Menu` 经 `../../ui/index.js` 导入（与 `ConfirmDialog` 同行）。Radix `Trigger asChild` 会在按钮上合并 `aria-haspopup="menu"`/`aria-expanded`/`data-state`，accessible name 仍为 `aria-label` `用户菜单`。
- `web/src/routes/shell/sidebar.css`（头注释注明 demo 行号来源；只用语义 token）：
  - `.sidebar{display:flex;flex-direction:column;flex-shrink:0;width:288px;height:100%;overflow:hidden;background:var(--wb-sidebar-bg);border-right:1px solid var(--wb-color-border-primary);transition:width .25s ease-out}`（demo:232-238）；`.sidebar[data-collapsed="true"]{width:48px}`（demo:240）；`@media (prefers-reduced-motion: reduce){.sidebar{transition:none}}`。
  - `.sidebar-brand{display:flex;align-items:center;justify-content:space-between;gap:8px;height:40px;padding:0 8px 0 12px}`；折叠 `.sidebar[data-collapsed="true"] .sidebar-brand{flex-direction:column;justify-content:center;height:auto;gap:4px;padding:8px 4px}`。
  - `.sidebar nav{padding:8px 12px}`，折叠 `padding:8px 4px`；`.sidebar nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}`。
  - `.sidebar-link{display:flex;align-items:center;gap:8px;padding:5px 12px;border-radius:8px;color:var(--wb-text-primary);font-size:14px;line-height:20px;text-decoration:none;transition:background-color .15s ease,color .15s ease}`（demo:259）；`.sidebar-link .ui-icon{flex-shrink:0;color:var(--wb-icon-secondary)}`；`:hover{background:var(--wb-todo-menu-bg-hover)}`；`[aria-current="page"]{background:var(--wb-todo-menu-bg-hover);font-weight:600}`、其 `.ui-icon{color:var(--wb-icon-primary)}`（demo:261-263）；`.sidebar-link-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`；`.sidebar-link-sub{flex-shrink:0;margin-left:auto;font-size:11px;line-height:20px;color:var(--wb-text-secondary)}`（demo:295）；折叠 `.sidebar[data-collapsed="true"] .sidebar-link{justify-content:center;padding:8px 0}`。
  - `.sidebar-footer{display:flex;flex-direction:column;gap:8px;margin-top:auto;padding:12px;border-top:1px solid var(--wb-color-border-primary)}`（demo:302）；折叠 `padding:12px 4px;align-items:center`。
  - `.sidebar-user{display:flex;align-items:center;gap:8px;width:100%;padding:2px 4px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}`（demo:651-654）；`:hover{background:var(--wb-bg-hover)}`；`:focus-visible` 沿用 `ui.css` 既有焦点环写法。`.sidebar-avatar` 照搬 `.account-avatar`（`styles.css:319-331`：28px 圆、`--wb-brand-primary` 底、`--wb-bg-primary` 字）；`.sidebar-user-copy{display:flex;flex-direction:column;min-width:0;flex:1}`；`.sidebar-user-account{font-size:13px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`；`.sidebar-user-role{font-size:11px;line-height:14px;color:var(--wb-text-secondary)}`（demo:303-304）；折叠 `.sidebar[data-collapsed="true"] .sidebar-user-copy{display:none}`、`.sidebar-user{justify-content:center;padding:2px 0}`。
  - `@media (max-width:760px)`：`.sidebar,.sidebar[data-collapsed="true"]{width:100%;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--wb-color-border-primary);transition:none}`；`.sidebar nav{flex:1 1 12rem;padding:0}`；`.sidebar nav ul{flex-direction:row;flex-wrap:wrap}`；`.sidebar-link{padding:6px 8px}`；`.sidebar-link-sub{display:none}`；`.sidebar-footer{flex:1 1 auto;flex-direction:row;flex-wrap:wrap;align-items:center;margin-top:0;padding:0;border-top:0}`（对应 `styles.css:574-616` 现行降级，保留 `flex-wrap`）。折叠态在此档只有宽度 inert：JSX 仍按 `collapsed` 隐藏标签/字标/account 文本，持久化为 `collapsed` 时 ≤760 呈通栏纯图标条（导航仍可达、无横向溢出，2.3 Drawer 前接受，PR 偏离记录注明）。
- `web/src/styles.css`：`@import "./routes/shell/sidebar.css";` 放 `./ui/ui.css` 之后、feature css 之前；删 `:194-300`（`.sidebar` … `.sidebar-link-sub`，但**保留** `:214-234` `.brand-mark`/`.brand-mark::after`）、`:302-346`（`.account-*`）、760 块中 `.sidebar`/`.sidebar-brand`/`.sidebar nav`/`.sidebar nav ul`/`.sidebar-link`/`.sidebar-link-sub`/`.account-footer`（:574-616）。`.sidebar-brand-name` 一并删除（字标由 `BrandMark wordmark`）。
- 测试：
  - `web/test/sidebar.test.tsx`（新，`import "./radix-platform.js"`，经 `render-app-router.tsx` 的 `mountAuthenticatedApp` 挂 `/files`；每用例 `localStorage.clear()` + `vi.restoreAllMocks()`）：见 Seams S1–S10。
  - `web/test/settings-footer.test.tsx`：`openLogoutDialog()` 改 `async`：`fireEvent.pointerDown(within(getFooter()).getByRole("button", { name: "用户菜单" }), { button: 0, ctrlKey: false, pointerType: "mouse" }); fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" })); return screen.getByRole("alertdialog");`，既有 8 个调用点（`:291,:584,:629,:656,:684,:707,:732,:740`）加 `await`，F2 改经它打开、F4 第 (iii) 步再调一次，共 10 处；`:52` `expectAuthenticatedShell` 的 `getByRole("button", { name: "退出登录" })` 改 `{ name: "用户菜单" }`；F2 `:601-618` 焦点归还目标改 `within(getFooter()).getByRole("button", { name: "用户菜单", hidden: true })`（在打开前取引用）；F3 `:620-644` 删 `a[aria-current=page]` 分支，Escape 后 `await waitFor(() => expect(document.activeElement).toBe(trigger))`（trigger = `用户菜单`）；F4 `:646-672` 改为固定顺序（确认框打开期间**不得**调用 `openLogoutDialog()`：`hideOthers` 已把 `#root` 置 `aria-hidden`，`within(getFooter())` 不继承 `hidden:true`；且 pending 中对话框不会自行关闭，`footer.tsx:47-50` 只在失败时 `setConfirming(false)`）：(i) 连点两次 `退出` → logout 计数 1、`confirm.disabled`；(ii) `fireEvent.keyDown(document.activeElement, { key: "Escape" })` → 对话框消失，`await waitFor(activeElement === 用户菜单)`（经 `returnFocus`；此处替代原 `:663-667` 的"trigger 禁用"断言，证明触发按钮可用）；(iii) `await openLogoutDialog()` → `within(dialog).getByRole("button", { name: "退出" })` 为 `disabled` 且 `aria-busy="true"`、存在 `关闭` 按钮、logout 计数仍 1；(iv) Escape 关闭 → resolve 204 → 登录页且无 `alertdialog`（原断言）。`迁移静态契约` describe 保留（`footer.tsx` 含 `ConfirmDialog`/`returnFocus`、不含 `<dialog` 等——仍成立），可追加 `not.toContain("aria-current")`（getter 已删）。净增 ≤ 15 行。
  - `web/test/chat-page-lifecycle.test.tsx:390`：`fireEvent.pointerDown(screen.getByRole("button", { name: "用户菜单" }), { button: 0, ctrlKey: false, pointerType: "mouse" }); fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));`（该用例经 `renderChatPage` → `mountAuthenticatedApp` 挂载，`render-app-router.tsx:8` 已引入 shim；`chat-page-lifecycle-support.tsx` 不改）。
  - `web/test/routes.test.tsx`：经 `routes/index.js` 导入不变；如有 `icon` 字段断言需求见 S10（放 `sidebar.test.tsx`）。
- `web/e2e/ui-walk.spec.ts`：`:99` 改两步（`用户菜单` click → `page.getByRole("menuitem", { name: "退出登录" }).click()`）；在深色主题步骤之前插入折叠往返：`const sidebar = page.getByRole("complementary", { name: "侧栏", exact: true }); await sidebar.getByRole("button", { name: "折叠侧栏" }).click(); await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(48); await page.reload(); await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(48); await sidebar.getByRole("button", { name: "展开侧栏" }).click(); await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(288); await expectPrincipalFooter(page);`（reload 后仍已登录；`oracle.phase` 按现有约定标注）。`sidebarFooter`/`expectPrincipalFooter`/`expectDesktopLayout` 不改。

Governing invariant: 侧栏是唯一的外壳导航面：结构（品牌区/导航/用户区）、折叠态与其持久化只在 `routes/shell/sidebar.tsx` + `sidebar.css`，状态由 `AppShell` 经 `{collapsed, onToggle}` 注入；退出入口只有用户菜单的 `退出登录` 一项，确认与请求编排仍全部在 `AuthFooter`（`ConfirmDialog` + `confirmLogout`），文案与"恰一次 logout / 失败回滚 / pending 锁定"语义逐字保留；jsdom（`settings-footer`、`chat-page-lifecycle`、`sidebar`）与 e2e 两条退出路径同 PR 绿；routes 层只经 `ui/index.ts` 取基元、不含硬编码颜色与 palette token。

Sibling surfaces: `web/src/routes/router.tsx:88-178`（RouteHandle/canonical path/PlaceholderPage 不动）；`web/src/features/auth/login-form.tsx:53`（`.brand-mark` 仍用，2.4b）；`web/src/features/theme/provider.tsx:20,70-80`（`workbuddy-theme` 读写模式，sidebar 镜像其 try/catch 语义）；`web/test/ui-menu.test.tsx:115-122`（`pointerDown` 开菜单的 jsdom 模式）；`web/test/ui-guardrails.test.ts`（routes/** hex/palette/radix 禁令自动覆盖新文件）；`web/e2e/ui-walk.spec.ts:115-131`（`expectDesktopLayout` 相对位置断言，288px 不影响）；`docs/acceptance/demo-parity-checklist.md`（#301 签收时勾侧栏行，本刀不动）；#315（`ConfirmDialog` pending 焦点，本刀沿用同一 footer，不新增 pending 消费者）。

Seams under test（新文件 `web/test/sidebar.test.tsx`，先红 = `Sidebar`/`manifest.ts` 不存在或 `用户菜单` 不存在时 import/查询失败）:
- (S1) 默认展开：`aside[data-collapsed="false"]`；`nav` 内 4 个 link（展开态无 `aria-label`，`/files` 的可访问名是 `工作空间文件·预览`，故**不用** `name` 精确匹配，改为逐链接 `within(link).getByText(label, { exact: true })` 取 `会话/工作空间/中心/设置`）；`/files` link 内 `getByText("文件·预览", { exact: true })`；每个 link 含 `svg.ui-icon`；aside 内可见字标 `WorkBuddy`；`折叠侧栏` 按钮存在。
- (S2) 折叠往返：点击 `折叠侧栏` → `data-collapsed="true"`、`localStorage.getItem("workbuddy-sidebar") === "collapsed"`、4 个 link `aria-label` 分别为标签、link 内无标签文本节点与副标签、按钮名变 `展开侧栏`、字标不可见（`queryByText("WorkBuddy")` 为 null 或 aria-hidden）；再点 → `data-collapsed="false"`、storage `expanded`。
- (S3) 初始读取：预置 `collapsed` → 挂载即折叠；预置任意其他值（`"garbage"`）→ 展开。
- (S4) 读失败：`vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); })` → 挂载展开，无 `console.error`。
- (S5) 写失败：`setItem` 抛错 → 点击 `折叠侧栏` 仍 `data-collapsed="true"`，且 `window` `error` 事件监听收集到的未捕获异常为空（React 19 把事件回调抛出的异常交给 `window` error 事件而非 `console.error`，也不会从 `fireEvent` 抛出，因此断言必须监听 `window`）；再点恢复展开。
- (S6) 折叠态 Tooltip：折叠后 `fireEvent.focus(link)` → `await screen.findByRole("tooltip")` 文本为标签；`fireEvent.blur(link)` → tooltip 消失；展开态 focus 不出现 tooltip。
- (S7) 用户菜单：`pointerDown` `用户菜单` → `menu` 出现，`getAllByRole("menuitem")` 名称恰为 `["退出登录"]`；Escape → menu 消失，`await waitFor(activeElement === 用户菜单按钮)`。
- (S8) 菜单退出恰一次：选择 `退出登录` → `alertdialog`；`document.activeElement` 为 `取消`（同步）且 `await yieldMacrotask()` 后仍为 `取消`（机制：`react-menu` `handleSelect` 经 `dispatchDiscreteCustomEvent` 同步挂载 Dialog 并聚焦 `取消`，该 focusin 被非模态菜单判为 focus-outside → `hasInteractedOutsideRef=true` → `setTimeout(0)` 里的 `onCloseAutoFocus` 跳过回焦 trigger；即便回焦，Dialog trapped FocusScope 也会拉回。双断言把这两层都钉住）；点击 `退出` → `POST /api/auth/logout` 恰一次 → 登录页。
- (S9) 菜单取消：选择 `退出登录` → `取消` → 无 logout 请求、aside 仍在、`await waitFor(activeElement === 用户菜单按钮)`。
- (S10) manifest：`routeManifest.map(r => [r.path, r.icon])` 恰为 `[["/","message-square"],["/files","folder"],["/center","layout-grid"],["/settings","settings"]]`；`readRepoFile("web/src/routes/router.tsx")` 不含 `export const routeManifest`；`readRepoFile("web/src/routes/shell/sidebar.tsx")` 不含 `@radix-ui`；`readRepoFile("web/src/styles.css")` 不含 `.account-footer`/`.sidebar-link` 且含 `routes/shell/sidebar.css`。
- 既有：`settings-footer.test.tsx` F1–F7 改菜单驱动后全绿（F4 改为 pending 锁定断言）；`chat-page-lifecycle.test.tsx:378-397` 改菜单驱动后全绿；`routes.test.tsx`/`auth-router.test.tsx` 不改仍绿。
- ui-walk（CI）：折叠往返宽度 48/288 + reload 保持 + 新退出路径 + `zhangsan`/`成员` 仍在 footer，1 passed。

Required evidence:
- 先红后绿：`sidebar.test.tsx` 与三处既有测试改动在实现前红（`用户菜单` 不存在、`manifest.js` 不存在）；实现后 `web/test` 全绿。
- 反向注入各红并回退：`writeCollapsed` 不包 try/catch → S5 红；`readCollapsed` 不包 try/catch → S4 红；折叠态不加 `aria-label` → S2 红；折叠态不包 `Tooltip` → S6 红；`items` 多加一项 → S7 红；去掉 `returnFocus` → S9 红（指针模式下打开时 activeElement 是即将卸载的菜单 content，归还落到 body）；`data-collapsed` 不随 storage 初值 → S3 红。
- `make check` exit 0（size-guard：`settings-footer.test.tsx` ≤ 775、`router.tsx`/`styles.css` 下降；knip 无新未用导出；guardrails 对 `sidebar.css` 无命中）；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。
- `grep -n "aria-current" web/src/features/auth/footer.tsx` 为空；`footer.tsx` 中 `退出登录` 只出现在菜单项 label、pending 状态行 `正在退出登录…` 与标题 `退出登录？` 三处（不再有独立按钮文本）。

Non-goals: 顶栏/heading（2.2）；760 Drawer 与视口矩阵（2.3）；`app-shell.tsx` 抽离；登录卡 BrandMark；`Menu` disabled API；新 IconName；版本号/搜索/筛选/铃铛/沙箱信息等 demo 顶行与菜单项；#315。

Review focus: (0) 新增/改动的 `.tsx`/`.css` 注释不得含 `#281`/`#315` 之类编号（`ui-support.ts:9` 的颜色字面量守卫会命中 `#` + 数字）；(1) Menu 关闭回焦与 Dialog 入场聚焦的次序（S8 的同步 + `yieldMacrotask` 双断言，及 F2/F3/S9 归还到 `用户菜单`）；(2) pending 锁定语义变化（触发按钮不禁用）是否在 spec 段、F4 与 proposal 偏离 1 三处一致；(3) `manifest.ts` 迁移后 `routes/index.ts`/`router.tsx`/测试 import 无循环、knip 干净；(4) `styles.css` 删除范围恰好（`.brand-mark*` 与 `.app-shell*` 保留，760 块无残留 `.account-footer`）；(5) `sidebar.css` 只用语义 token、有 reduced-motion、760 档宽度不随折叠变化且 `.sidebar-footer` 保留 `flex-wrap`；(6) `chat-page-lifecycle.test.tsx:390` 菜单驱动改法与 `render-app-router` shim 路径；(7) ui-walk 折叠往返放置位置不破坏 `expectDesktopLayout` 与 oracle phase 约定；(8) size-guard 与 `settings-footer.test.tsx` 净增。
