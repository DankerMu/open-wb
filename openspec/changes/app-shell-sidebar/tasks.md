# Tasks: app-shell-sidebar（#281）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×1）；`openspec validate app-shell-sidebar --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新增 `web/test/sidebar.test.tsx`（S1–S10）；改 `web/test/settings-footer.test.tsx`（`:52` helper → `用户菜单`、`openLogoutDialog` 菜单驱动（8 个调用点 `await`）、F2/F3 归还 `用户菜单`、F4 pending 锁定）、`web/test/chat-page-lifecycle.test.tsx:390` 菜单驱动。先红。
- [x] 2.2 `web/src/routes/manifest.ts`（`RouteDefinition.icon` + `routeManifest`）；`router.tsx` 改导入、`AppShell` 挂 `Sidebar`；`routes/index.ts` 再导出来源改 manifest。
- [x] 2.3 `web/src/routes/shell/sidebar.tsx`（`Sidebar` + `useSidebarCollapsed`）与 `sidebar.css`（含 reduced-motion 与 760 降级）；`styles.css` `@import` + 删 `.sidebar*`/`.account-*` 与 760 块对应条目（保留 `.brand-mark*`）。
- [x] 2.4 `web/src/features/auth/footer.tsx`：用户块 → `Menu` trigger `用户菜单`、菜单项 `退出登录`、删独立按钮与 getter、`returnFocus={triggerRef}`。2.1 转绿，`web/test` 全绿。
- [x] 2.5 反向注入七项各红并回退（design Required evidence）。
- [x] 2.6 `web/e2e/ui-walk.spec.ts`：退出入口两步 + 折叠往返（48 → reload 48 → 288）。

## 3. Verification
- [x] 3.1 `make check` exit 0（size-guard 全部 < 800、knip、guardrails）。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：`Sidebar {collapsed,onToggle}`、`useSidebarCollapsed`、`RouteDefinition.icon`、`manifest.ts` 出口——S1/S2/S10 + 2.2。
- Selected Config / project setup：`localStorage['workbuddy-sidebar']` 键名/值域/读写失败——S2–S5。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：只搬退出入口，`useAuth().logout` 与凭证边界不动。
- Selected Concurrency / shared state / ordering：Menu 回焦 vs Dialog 入场聚焦次序、pending 中再次打开的锁定——S8/S9、F2/F3/F4。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：退出语义/文案逐字、`sidebarFooter`/`getFooter`/`AuthFooter` 裸挂/`.brand-mark` 保留——F1–F7、chat-page-lifecycle、3.3。
- Selected Error handling / rollback / partial outputs：storage 读写抛错静默、logout 失败 alert——S4/S5、F6。
- Selected Release / packaging / dependency compatibility：不加依赖，但本刀是 DropdownMenu/Tooltip 首个页面级消费者（`files/dialogs.tsx` 的 `CreationMenu` 仍是手写），`@radix-ui/react-menu`/`react-popper` 与传递依赖 `@floating-ui/*`（MIT）首次进入 `web/dist`——3.2 记录 dist 增量，PR 偏离记录上报传递依赖许可（ATTRIBUTION §3 只登记直接依赖，政策待用户拍板，沿用 #280 处理）。
- Selected Documentation / migration notes：`pointerDown` 开菜单、`manifest.ts`、pending 不禁用触发器三条记入 PR 偏离记录供 2.2/2.3/#302。
