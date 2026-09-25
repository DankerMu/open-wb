# Tasks: app-shell-responsive（#283）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×1）；`openspec validate app-shell-responsive --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新增 `web/test/media-query-support.ts`（从 `theme-provider.test.tsx` 抽出 `createMediaQuery` + `installMatchMedia(resolve)`，theme 测试改 import）；新增 `web/test/app-shell-responsive.test.tsx`（R1–R10 含 R2c/R4b/R9b）；`web/test/sidebar.test.tsx` 删 `narrowCss` 与依赖横条 CSS 的两处断言。先红。
- [x] 2.2 `web/src/lib/viewport.ts`（`SHELL_NARROW_QUERY`/`useMediaQuery`，matchMedia 缺失恒 false）。
- [x] 2.3 `web/src/features/auth/provider.tsx` `logoutPending` 上提 + `footer.tsx` 改读 Provider（`settings-footer.test.tsx` 零改动仍绿）。
- [x] 2.3b `web/src/routes/shell/sidebar.tsx` 覆盖层变体（`variant: "overlay"` + `onNavigate`，无品牌区/折叠按钮，`data-variant`）；`sidebar.css` 删 `≤760` 横条块、加 `.sidebar[data-variant="overlay"]` 规则。
- [x] 2.4 `web/src/routes/shell/topbar.tsx` `onOpenNav` + `打开导航` 按钮（header 首子节点，欢迎态窄条）；`topbar.css` 按需对齐规则。
- [x] 2.5 `web/src/routes/shell/app-shell.tsx`：`useMediaQuery` 分支、`Drawer side="left" width=288 title="导航"`、`navOpen` 瞬时状态与宽屏复位；`styles.css` `≤760` 块删 `flex-direction: column`。2.1 转绿，`web/test` 全绿。
- [x] 2.6 反向注入九项各红并回退（design Required evidence）。

## 3. Verification
- [x] 3.1 `make check` exit 0（size-guard、knip、jscpd、guardrails）。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量，单 project）exit 0；`git diff --stat web/src/ui web/e2e web/playwright.config.ts` 为空。

## Risk pack mapping
- Selected Public API / CLI / script entry：`useMediaQuery`/`SHELL_NARROW_QUERY`、`Sidebar` 判别联合 props、`Topbar({ onOpenNav })`、6.1 依赖的定位器（`打开导航`/`导航`）——R1/R3/R5/R10。
- Not selected Config / project setup：不加依赖、不改 playwright/vite/CI 配置。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无。
- Selected Auth / permissions / secrets：退出 pending 上提到 `AuthProvider`，`logout()` 返回值与 operation 单槽语义不变、重复退出仍被锁定（含覆盖层重开）——R9/R9b + `settings-footer.test.tsx` 零改动全绿。
- Selected Concurrency / shared state / ordering：`navOpen` 与 `narrow` 的转换次序（宽屏复位、不复活）、Drawer/Menu/ConfirmDialog 叠层、`#root` aria-hidden 复位——R7/R9。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：`≥761`/jsdom 默认态与 2.2 一致，既有 ~1200 用例零改动仍绿；`workbuddy-sidebar` 偏好不被覆盖层触碰；单 project ui-walk 仍绿——R2/R2b/R8 + 3.3。
- Not selected Error handling / rollback / partial outputs：`matchMedia` 抛错按宽屏兜底已在 Public API 内覆盖，无其它错误路径。
- Not selected Release / packaging / dependency compatibility：不加依赖；`Drawer` 已在产物中（#277），无新 Radix 包进入 `web/dist`。
- Selected Documentation / migration notes：`打开导航`/`导航` 定位器与 matchMedia mock 用法供 6.1（#295）与 5.3 复用——PR 迁移预告。
