# Tasks: s1f-ui-foundation

> 执行顺序：1 → 2 → 3 / 4 / 5（3、4、5 互不依赖）。真实依赖以各组尾部为准。
>
> 通用纪律：
> - 每组一个 PR，合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行。
> - 「行为不变」的证据是既有行为断言（按角色/可访问名）原样通过；只允许删除或改写读源码、读 `.css`、按旧类名选择的断言，不得为通过而放宽行为断言。
> - 不改 `web/src/features/chat/**`、`web/src/features/files/**`、`web/src/ui/**` 的实现（`web/src/ui` 冻结）；不改任何 `server/**`。
> - 拷入层只做三类修改：颜色字面量换主题变量、可见与 aria 文案中文化、Biome 格式化。
> - size-guard：新写的应用层文件 ≤800 行；新测试写进新文件。

## 1. ui-foundation — 工具链、层叠、主题、分层、豁免与守卫

- [ ] 1.1 依赖与别名（design D1）：`web/package.json` 加 `tailwindcss`、`@tailwindcss/vite`、`radix-ui`、`class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`；
  `web/tsconfig.json` 覆盖 `module: ESNext`、`moduleResolution: Bundler`、`paths {"@/*": ["./src/*"]}`；`web/vite.config.ts` 加 Tailwind 插件与 `resolve.alias`；
  `web/vitest.config.ts` 复用 alias；knip 能解析 `@/`。
- [ ] 1.2 样式入口（design D2）：新建 `web/src/styles/legacy.css` 承接原 `styles.css` 的全部全局规则与 `@import`；`web/src/styles.css` 改为层声明 + Tailwind 三段导入 +
  `tw-animate-css` + `tokens.css` + `theme.css` + `legacy.css layer(legacy)`。
- [ ] 1.3 主题映射（design D3）：新建 `web/src/styles/theme.css`（shadcn 语义变量 → `--wb-*`、`@theme inline`、`--radius`、`@custom-variant dark`、`body` 底色与文字色）。
- [ ] 1.4 组件分层（design D4）：`web/components.json` 入库；`web/src/lib/utils.ts`（`cn`）；拷入 `button` 一个组件作为层的首个成员并通过全部门禁（其余组件由用到它们的任务拷入）。
- [ ] 1.5 门槛豁免（design D5）：`web/vitest.config.ts` coverage 排除、`.jscpd.json`、`.large-file-guard.json`、`biome.json` overrides、`knip.json`，条目只指向两个拷入目录；
  `scripts/test-guardrails.sh` 加「应用层 801 行被拒 / 拷入层 801 行通过」两例；`AGENTS.md` Enforcement Index 下加一行豁免注记；`ATTRIBUTION.md` 登记 Tailwind CSS、shadcn/ui、`radix-ui`。
- [ ] 1.6 守卫改写（design D6）：`web/test/ui-guardrails.test.ts` 与 `ui-tokens.test.ts` 按 D6 的保留/新增/删除清单修改（已迁移区域清单此时为空集，3/4/5 各自把目录加入）。
- [ ] 1.7 ui-walk 增两条计算样式断言的支撑：暗色下 `body` 底色等于 `--wb-home-bg-secondary` 深色值；一个旧页面容器的 `padding` 等于其 `.css` 声明值（legacy > preflight）。
  既有 ui-walk 全部用例保持通过（旧页面功能可用）；若 preflight 使某功能断言失败，在 `legacy.css` 补最小规则。

Suggested fixture level: expanded - 构建工具链、模块解析与全局层叠顺序是公共契约；层叠结果只有真实浏览器能证明，别名需在 tsc/Vite/vitest/knip 四处同时成立
Minimal mergeable slice: atomic - 层声明、`legacy.css`、Tailwind 导入与主题映射必须同刀：只接 Tailwind 不建 `legacy` 层，preflight 会直接改坏全部旧页面；只建层不接 Tailwind 则层序无从验证。别名、豁免与首个拷入组件是同一个「拷入层可用」的证明，拆开后任何一半都过不了门禁（拷入的 `button` 没有豁免即被覆盖率与 Biome 拒绝）。不改任何页面 JSX。依赖：无。

## 2. functional-acceptance / verification-harness — demo 一致性 harness 退役与功能验收清单

- [ ] 2.1 删除 `web/e2e/ui-shots.mjs`、`web/package.json` 的 `ui-shots` 脚本；Makefile 去掉 `ui-shots` 目标、`UI_SHOTS_*` 块、`.PHONY` 项与页头注释句（design D10）。
- [ ] 2.2 `constraints.yaml` `verification.surfaces` 去掉 `ui-shots`；`AGENTS.md` Verification Matrix 与 Enforcement Index 各去掉「demo 一致性截图对」一行。
- [ ] 2.3 `scripts/test-ci-harness.sh`：期望 surface 元组、逐字行、冻结块（两组）、`.PHONY`/配方断言与突变用例同步；新增「重新加入 `ui-shots` surface / target / AGENTS 行被拒」的突变用例。
- [ ] 2.4 新增 `docs/acceptance/functional-checklist.md`：文件头（运行方式、四列格式、三种结论、只有 owner 签收）+ 分节骨架（登录、外壳、会话、文件、设置），本任务不写数据行。

Suggested fixture level: standard - 控制面镜像由既有 source-derived oracle 守护，改动是删除一个 surface 并同步 oracle；无运行时行为
Minimal mergeable slice: atomic - AGENTS.md 行、constraints surface、Makefile 目标与 oracle 期望被 `make test-guardrails` 逐字互相校验，任何子集单独合入都使 oracle 变红。依赖：无（与组 1 无文件交集）。

## 3. spa-shell — 外壳重写

- [ ] 3.1 拷入 `sheet`、`tooltip`、`dropdown-menu`、`alert-dialog`、`separator`（按需）；`routes/shell/{app-shell,sidebar,topbar}.tsx` 按 design D7 重写，删除 `sidebar.css`、`topbar.css` 并从 `legacy.css` 去掉其 `@import`；
  `legacy.css` 里只服务于旧外壳的全局规则（`.app-shell`、`.app-content` 等）一并删除。
- [ ] 3.2 `features/auth/footer.tsx`（用户菜单、退出确认、失败提示）按 D7 重写。
- [ ] 3.3 `lib/topbar.tsx`、`lib/sidebar-slot.tsx`、`lib/viewport.ts` 的导出与语义不变；actions 容器改 `data-slot="topbar-actions"`。
- [ ] 3.4 测试：`sidebar`、`sidebar-slot`、`app-shell-responsive`、`topbar`、`topbar-actions`、`routes`、`settings-footer` 的行为断言原样通过；读 `sidebar.css`/`topbar.css`/`styles.css`/源码的断言删除或改为行为断言；
  `web/e2e/ui-walk*` 里 `.sidebar-link`、`header.topbar h1`、`.topbar-actions` 选择器改为角色/名称或 `data-slot`。
- [ ] 3.5 守卫：把 `web/src/routes/**` 与 `web/src/features/auth/footer.tsx` 加入「已迁移区域」清单。`functional-checklist.md` 外壳节加行（导航四项、折叠与持久化、窄屏覆盖层、顶栏三态、用户菜单与退出、退出失败提示），结论 `待签`。

Suggested fixture level: expanded - 外壳是全部页面的容器，响应式覆盖层、焦点归还与退出锁定态只有真实浏览器 + 视口矩阵能证明
Minimal mergeable slice: atomic - 侧栏、顶栏、覆盖层与用户菜单共用同一组上下文（折叠状态、窄屏判定、槽位），且共用即将删除的两个 `.css`；先迁一半会让另一半失去样式或需要临时双写。验证路径单一（外壳的 jsdom 行为测试 + ui-walk 外壳段）。依赖：1、2。

## 4. spa-shell — 登录页重写

- [ ] 4.1 拷入 `card`、`input`、`label`（按需）；`features/auth/login-form.tsx`、`quick-login.tsx` 按 design D8 重写；删除 `auth.css` 并从 `legacy.css` 去掉其 `@import`；`.auth-loading` 的加载态改用 Tailwind。
- [ ] 4.2 测试：`login-form`、`auth-router`、`auth-session-client` 的行为断言原样通过；读 `auth.css`/`styles.css`/源码的断言删除或改为行为断言。ui-walk 增「登录主按钮计算底色等于 `--primary`」。
- [ ] 4.3 守卫：把 `web/src/features/auth/**` 整体加入「已迁移区域」清单（3.5 已含 footer）。`functional-checklist.md` 登录节加行（未登录落登录页且 URL 不变、登录成功回原路由、错误提示、快捷登录仅演示环境可见），结论 `待签`。

Suggested fixture level: expanded - 登录页是层叠顺序（utilities 压过旧全局 `button` 规则）的取证点，计算样式需真实浏览器
Minimal mergeable slice: atomic - 表单与快捷登录卡共用同一提交锁与同一个 `.css`，单页、单一验证路径。依赖：1、2。

## 5. spa-shell — 设置页重写

- [ ] 5.1 拷入 `toggle-group`（及其依赖 `toggle`）；`features/settings/page.tsx` 按 design D9 重写；删除 `settings.css` 并从 `legacy.css` 去掉其 `@import`。
- [ ] 5.2 测试：`settings-page`、`theme-provider`、`theme`、`prepaint-theme` 的行为断言原样通过；读 `settings.css`/`ui.css`/源码的断言删除或改为行为断言；
  ui-walk 里 `.settings-sec-h`、`.settings-row-title` 选择器改为角色/名称；增「亮/暗下 `body` 计算底色」断言（若 1.7 未覆盖 `/settings`）。
- [ ] 5.3 守卫：把 `web/src/features/settings/**`、`web/src/features/theme/**` 加入「已迁移区域」清单。`functional-checklist.md` 设置节加行（主题三档即时生效与持久化、跟随系统、关于卡显示服务名与版本、读取失败提示），结论 `待签`。

Suggested fixture level: standard - 单页、无新契约；主题切换的既有 jsdom 与 ui-walk 用例已覆盖行为
Minimal mergeable slice: atomic - 两张卡在同一个文件、同一个 `.css`，单一验证路径。依赖：1、2。
