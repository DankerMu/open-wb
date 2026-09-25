# Tasks: app-shell-topbar（#282）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×1）；`openspec validate app-shell-topbar --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新增 `web/test/topbar.test.tsx`（T1–T8 + T2b）；改 `routes.test.tsx`（`/` heading + `expectRouteShell:179` 条件改 hero 文本）、`settings-footer.test.tsx:47`、`main.test.tsx`、`chat-page.test.tsx`、`chat-page-ownership.test.tsx`、`chat-page-lifecycle.test.tsx`、`files-page.test.tsx` 的 heading/空态断言。先红。
- [x] 2.2 `web/src/lib/topbar.tsx`（`TopbarProvider`/`useTopbar`/`useTopbarBreadcrumb`）。
- [x] 2.3 `web/src/routes/shell/{app-shell.tsx,topbar.tsx,topbar.css}`；`router.tsx` 改用 `AppShell`、PlaceholderPage 删 h1；`styles.css` `.app-content` 层 + `main` 选择器改名 + 删 `.ui-page-heading` + `@import` topbar.css。
- [x] 2.4 四页面删 h1（chat/files/settings/center）；chat 欢迎态 hero h1 + `useTopbar` 上报；`chat.css`/`files.css` 对应规则清理。2.1 转绿，`web/test` 全绿。
- [x] 2.5 反向注入七项各红并回退（design Required evidence）。
- [x] 2.6 `web/e2e/ui-walk.spec.ts`：`ROUTES` `/` heading → `WorkBuddy，我帮你`、`:82` 硬编码 `会话` 同步；选中会话后 banner 面包屑断言。

## 3. Verification
- [x] 3.1 `make check` exit 0（size-guard、knip、guardrails）。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：`useTopbar({breadcrumb})`/`TopbarProvider`/`useTopbarBreadcrumb`/`Topbar`/`AppShell` 出口与契约——T1–T7 + 2.2/2.3。
- Not selected Config / project setup：不加依赖、不改配置、无存储键。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：不触及认证边界。
- Selected Concurrency / shared state / ordering：上报 effect 的 set/clear 次序（路由切换、会话切换、卸载、StrictMode）——T5/T6/T7。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：既有 `工作空间`/`设置` heading 断言经顶栏 h1 继续命中、`expectDesktopLayout`、裸挂 `ChatPage` no-op、Markdown h1 不计——既有测试 + T7/T8 + 3.3。
- Not selected Error handling / rollback / partial outputs：无错误路径（上报为纯状态）。
- Not selected Release / packaging / dependency compatibility：不加依赖，无新 Radix 消费者，产物只增两个小模块。
- Selected Documentation / migration notes：heading 以 banner/hero 为范围定位的写法、`useTopbar` 契约供 4.4/2.3/6.1 复用——PR 迁移预告。
