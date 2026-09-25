# Proposal: ui-walk-dual-project（#295）

## Why
父 change `s1e-frontend-parity` tasks 6.1。`make ui-walk` 是仓库唯一的真实浏览器 seam，但目前只有一个 1280 默认视口的 `chromium` project（`web/playwright.config.ts:28-33`），窄屏覆盖层导航（2.3）、树栏三档宽度（5.3）、reduced-motion（1.1）与图标离线（1.1）都只有 jsdom 证据。父 spec verification-harness「UI 走查（Playwright）」已定为双 project 矩阵，ui-primitives「图标离线、动效可禁用且归属登记」与 files-harness「走查 /files 步骤」的真实浏览器部分也由本刀交付。

## What Changes
- `web/playwright.config.ts`：`projects` 改为 `desktop-light`（1440×900，`colorScheme: "light"`）与 `mobile-dark`（390×844，`colorScheme: "dark"`），`browserName: "chromium"`；`workers: 1`；`globalTimeout` 60s → 150s。
- `web/e2e/ui-walk.spec.ts` 按 project 分支（`testInfo.project.name`）：
  - 布局：desktop 侧栏/主区并排；四路由遍历中逐路由临时 1024×768 断无横向溢出后恢复；`/files` 临时 880×800 断树栏 210px 后恢复。mobile 覆盖层默认关闭、每路由 `打开导航` 可见，路由点击与用户区断言前经 `openNav()` 打开覆盖层。
  - 每 project 每路由 `scrollWidth <= innerWidth` 且主区可见。
  - `walk-out-<project>` 补齐至 64 字符（≥48），断言树行名称截断、行本身不溢出、`title` 为全名。
  - 主题：desktop 选 `深色`，mobile 选 `浅色`，各断 `data-theme`、storage、reload 持久。侧栏折叠步骤只在 desktop（覆盖层无折叠）。
  - desktop：受控回合运行中对 `.ui-pulse` `emulateMedia({ reducedMotion: "reduce" })` 断 `animationName === "none"`，恢复 `no-preference` 后非 `none`；journey 末断静态资源（`image|font|stylesheet|script`）零 `requestfailed`（`net::ERR_ABORTED` 不计）与零非 `baseURL` 源请求。
  - 两 project 的 401/console/page error 预算各自独立（每个 test 自己的 oracle）。
- ui-walk.spec.ts 现 788 行：oracle 与布局/项目辅助抽到新模块（如 `web/e2e/ui-walk-oracle.ts`、`web/e2e/ui-walk-layout.ts`），各文件 ≤ 800 行。

## Non-goals
- CI workflow、Makefile、AGENTS.md、constraints.yaml（ui-walk job 的 15 分钟 `timeout-minutes` 已覆盖两 project；harness oracle 不检查 playwright 配置）。
- `make ui-shots`（6.3a/6.3b）；夹具（6.2 已交付）；files-web「三档宽度布局」中 1024 的 `/files` 格（由 ui-shots 断言）。
- 产品代码：若真实浏览器暴露呈现缺陷（溢出、截断失效），停下报告，不在本刀修产品。

## Capabilities
- MODIFIED `verification-harness`：「UI 走查（Playwright）」整段取父 delta 的双 project 版本。
- MODIFIED `files-harness`：「走查 /files 步骤」的 walk-out 改为 `walk-out-<project>` ≥48 字符并断截断与 `title`。
- MODIFIED `ui-primitives`：「动效与图标」新增 Scenario「图标离线、动效可禁用且归属登记」（父 delta 原文）。

## Impact
- Error handling / rollback / partial outputs：任一 project 失败 → `make ui-walk` 非零；第二 project 复用第一 project 已创建的 smoke-fixture 工作空间（既有"选或建"分支）；walk-out 按 project 分名，互不冲突。
