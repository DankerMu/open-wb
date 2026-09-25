# Proposal: app-shell-sidebar（#281）

## Why
S1e 组 2 首刀（2.1）。现行侧栏是 `web/src/routes/router.tsx:52-87` 内联的 224px 文字导航（无图标、不可折叠、`.brand-mark` 手写 span），用户页脚 `web/src/features/auth/footer.tsx:57-80` 是"头像 + account/role + 独立 `退出登录` 按钮"。demo 侧栏（demo:232-300, 1773-1822）为 288px、图标 + 标签 + 副标签、可折叠到 48px 并持久化、底部用户块整体为菜单触发器。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md:53` 归为实现偏差 + 计划遗漏（F-UI-2）。本刀落地侧栏与用户区形态；顶栏（2.2）与响应式 Drawer（2.3）不在本刀。

## What Changes
- 新增 `web/src/routes/shell/sidebar.tsx`：`Sidebar({ collapsed, onToggle })`（`<aside aria-label="侧栏" className="sidebar" data-collapsed>`：品牌区 `BrandMark size={24} wordmark={!collapsed}` + 折叠按钮 `Button variant="ghost" size="icon"` `aria-label` `折叠侧栏`/`展开侧栏`、`Icon name="panel-left"`；`<nav aria-label="主导航">` 每项 `NavLink end` = `Icon` + 标签 + 副标签，折叠态不渲染标签/副标签、加 `aria-label={label}` 并以 `Tooltip side="right"` 包裹；底部 `<AuthFooter />`）与 `useSidebarCollapsed()`（读 `localStorage['workbuddy-sidebar'] === "collapsed"`，读失败 → expanded；toggle 时写 `collapsed|expanded`，写失败静默保留内存状态）。新增 `web/src/routes/shell/sidebar.css`（demo:232-247/259-268/295/301-304/651-654 移植，语义 token；`prefers-reduced-motion` 关闭宽度过渡；含 `≤760px` 横条降级；该档只有宽度不随折叠变化，持久化为 collapsed 时呈通栏纯图标条，2.3 Drawer 前接受），由 `web/src/styles.css` `@import`。
- `routeManifest` 与 `RouteDefinition` 移到新文件 `web/src/routes/manifest.ts`（避免 `sidebar.tsx` ↔ `router.tsx` 循环导入；2.2 顶栏同样要读它），`RouteDefinition` 增 `icon: IconName`（`/`=`message-square`、`/files`=`folder`、`/center`=`layout-grid`、`/settings`=`settings`）；`routes/index.ts` 改从 `./manifest.js` 再导出 `routeManifest`；`router.tsx` 的 `AppShell` 保留内联（2.2 再抽 `app-shell.tsx`），改为 `const [collapsed, toggle] = useSidebarCollapsed(); <Sidebar collapsed={collapsed} onToggle={toggle} />`。
- `web/src/features/auth/footer.tsx`（issue 的 PR Boundary 未列出，但"本 issue 只搬入口"即指它）：`<footer className="sidebar-footer">`；用户块改为 `Menu` 的 trigger `<button type="button" aria-label="用户菜单" className="sidebar-user" ref={triggerRef}>`（`.sidebar-avatar` 首字符 + `.sidebar-user-copy` 内逐字 account/role），`items=[{ icon: "log-out", label: "退出登录", onSelect: () => setConfirming(true) }]`；独立 `退出登录` 按钮删除；`returnFocus={triggerRef}`（触发按钮永远可用，删除 #280 的 getter 与 `a[aria-current=page]` 分支）；`logoutError` alert、pending `role="status"` 行、`ConfirmDialog` 全部 props、`confirmLogout` 去重/回滚/卸载守卫不变。
- `web/src/styles.css`：删 `.sidebar*`（:194-300）与 `.account-*`（:302-346）规则及 `≤760px` 块内对应条目（:574-616 中 `.sidebar*`/`.account-footer`）；保留 `.brand-mark*`（`login-form.tsx:53` 仍用，2.4b 迁移）与 `.app-shell*`。
- 测试（同 PR）：新增 `web/test/sidebar.test.tsx`（折叠/持久化/读写失败/Tooltip/菜单集合/退出恰一次/取消/manifest icon）；`web/test/settings-footer.test.tsx` 的 `:52` `expectAuthenticatedShell` 改断言 `用户菜单` 按钮、`openLogoutDialog()` 改 `pointerDown` `用户菜单` → `menuitem` `退出登录`，F2/F3 焦点归还改回 `用户菜单`，F4 的"trigger 禁用"改"pending 中再次经菜单打开的确认框其 `退出` 按钮禁用且 logout 仍 1 次"；`web/test/chat-page-lifecycle.test.tsx:390` 改菜单驱动（经 `render-app-router` 挂载，shim 已有）；`web/test/routes.test.tsx` 视 import 路径同步。
- `web/e2e/ui-walk.spec.ts:99` 退出入口改 `sidebarFooter(page).getByRole("button", { name: "用户菜单" }).click()` → `page.getByRole("menuitem", { name: "退出登录" }).click()`；`sidebarFooter`/`expectPrincipalFooter` 保持 `footer` 定位不改；退出前增折叠往返（`折叠侧栏` → aside 宽 48 → reload 仍 48 → `展开侧栏` → 288）。

## Non-goals
顶栏与 heading 归属（2.2 / #282）；`≤760px` Drawer 覆盖层与视口矩阵（2.3 / #283）；`app-shell.tsx`/`topbar.tsx` 抽离（2.2）；登录卡 `.brand-mark` → `BrandMark`（2.4b）；铃铛/设置快捷入口/沙箱信息/账号与隔离/切换账号（无后端，不渲染；铃铛为明确不做）；新增 `IconName`（折叠按钮用现有 `panel-left`）；`Menu` 增 `disabled` API；#315（`ConfirmDialog` pending 焦点逃逸，基元层，#302 前修）。

## Capabilities
### Modified
- `spa-shell`：「路由 IA 与侧栏」侧栏段改为 288/48 折叠 + 图标 + 用户菜单形态；新增 Scenario「侧栏折叠与用户菜单」；「退出登录」WHEN 改菜单路径；「退出请求失败」用户区措辞。

## Impact
- 新文件：`web/src/routes/shell/{sidebar.tsx,sidebar.css}`、`web/src/routes/manifest.ts`、`web/test/sidebar.test.tsx`。改：`router.tsx`、`routes/index.ts`、`features/auth/footer.tsx`、`styles.css`、`settings-footer.test.tsx`、`chat-page-lifecycle.test.tsx`、（视情况）`routes.test.tsx`、`ui-walk.spec.ts`。不改 `web/src/ui/**`、不加依赖、不改 ATTRIBUTION。
- 守卫：`web/src/routes/**` 受 hex/rgba 与 `--wb-palette-` 禁令——头像底色用 `--wb-brand-primary` 平涂（沿用 `.account-avatar`），不移植 demo 的 palette 渐变；`routes/shell/sidebar.tsx` 只经 `../../ui/index.js` 取基元。
- knip：`useSidebarCollapsed`/`Sidebar` 由 `router.tsx` 消费；`AuthFooter` 导出仍由 `chat-page-lifecycle-support.tsx` 与 `sidebar.tsx` 消费；`manifest.ts` 由 `router.tsx`/`sidebar.tsx`/`index.ts` 消费。
- size-guard：`settings-footer.test.tsx` 现 759 行，改动净增 ≤ 15 行；新增用例一律进 `sidebar.test.tsx`。

### 与 oracle / demo 的偏差留痕
1. **pending 期间用户菜单触发按钮不禁用**（#280 是禁用独立按钮）：`Menu` 无 `disabled` API、`ui/menu.tsx` 不在本刀边界，且 Radix `Trigger asChild` 对子元素 `disabled` 的指针事件门控依赖浏览器对禁用按钮的事件派发行为，无法在 jsdom 证实。"重复退出仍被锁定"改由 `pendingRef` + `ConfirmDialog pending`（确认按钮 loading/禁用、取消文案 `关闭`）保证；`returnFocus` 因而是普通 ref，`a[aria-current=page]` 分支删除。
2. 折叠按钮图标 demo 为 `chevronLeft`，`IconName` 无此项，用 `panel-left`（不改 `ui/icon.tsx`）。
3. 折叠态**不渲染**标签/副标签文本（demo 用 `font-size:0` 隐藏），accessible name 由 `aria-label` 提供。
4. 品牌区：demo 顶行是 mac 窗口灯 + 折叠/搜索/筛选三按钮 + 版本号 `WorkBuddy V5.3.11`；本刀只保留 `BrandMark`（含字标）+ 折叠按钮，不渲染版本号（`/api/info` 版本属设置页关于卡）与搜索/筛选（⌘K 明确不做、筛选无后端）。
5. `/files` 副标签 `文件·预览`（demo `文件·预览·挂载`；spec 收窄，挂载未交付）。
6. `routeManifest` 迁出 `router.tsx` 到 `manifest.ts`（tasks 2.1 只写"增 icon 字段"）：为解 sidebar/router 循环导入。
7. ui-walk 增折叠往返（tasks 2.1 只写退出段改动）：spec Scenario 要求"reload 保持折叠"与 48px 宽度，jsdom 无法给出宽度证据。
8. `AppShell` 不抽 `app-shell.tsx`（design 决策 4 列出该文件）：2.1 范围只有 sidebar，2.2 顶栏时一并抽。

## Risk triage
Issue type: feature（外壳结构与用户区形态定调，decision-dense）
Fixture level: expanded
Upstream suggested level: expanded (agree：真实浏览器呈现面 + 退出主路径，jsdom 与 `make ui-walk` 两条路径同 PR 绿)
Blast radius: 侧栏与用户区出现在全部已认证路由；退出入口迁入菜单同时改变 jsdom（`settings-footer` 14 个退出用例、`chat-page-lifecycle`）与 e2e 的退出定位，任一未同步即 CI 红；`routeManifest` 迁文件牵动 `routes/index.ts` 与 `routes.test.tsx`；`styles.css` 大段删除若漏掉 760 块会让窄屏横条错乱。
Selected risk packs: Public API / CLI / script entry（`Sidebar` props、`useSidebarCollapsed`、`RouteDefinition.icon`、`manifest.ts` 出口）；Release / packaging / dependency compatibility（DropdownMenu/Tooltip 首次进页面产物，`@floating-ui/*` 传递依赖许可上报）；Config / project setup（`localStorage['workbuddy-sidebar']` 键名与值域、读写失败语义）；Concurrency / shared state / ordering（Menu 关闭与 `ConfirmDialog` 入场聚焦 `取消` 的次序——同步挂载的 Dialog 聚焦触发非模态菜单的 focus-outside，`onCloseAutoFocus` 跳过回焦 trigger，trapped FocusScope 为第二层；pending 中再次打开菜单/确认框的锁定）；Legacy compatibility / examples（退出语义/文案/恰一次 logout/失败回滚逐字保留；`sidebarFooter`/`expectPrincipalFooter`/`getFooter()` 定位不变；`chat-page-lifecycle-support` 裸挂 `AuthFooter` 仍有效；`.brand-mark` 保留给登录卡）；Error handling / rollback / partial outputs（storage 读/写抛错静默；logout 失败 alert 仍在用户区）；Documentation / migration notes（`pointerDown` 开菜单、`hidden:true`、`manifest.ts` 供 2.2/2.3/#302 复用）。
Evidence floor: `make check` exit 0（size-guard 全部 < 800；knip 无新未用导出；guardrails 对 `routes/shell/sidebar.css` 无 hex/palette 命中）；`web/test` 全绿含新 `sidebar.test.tsx`；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed（新退出路径 + 折叠往返 + `zhangsan`/`成员` 仍在 footer）。
