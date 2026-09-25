# Proposal: settings-page-parity（#300）

## Why
S1e 组 2 的 2.5，依赖 1.4（#278 `SegmentedControl`）与 3.1（#285 `/api/info` 三键形状），两者都已合入。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md:101` 把外观卡列为"功能已实现、形态实现偏差"：现实现是三张大色块 radio 卡加一行 `当前生效`（`web/src/features/settings/page.tsx:20-36`），demo 是标题 + 说明行 + 右侧三档分段控件，再加一行 `当前生效`（demo:3533-3567）。关于卡缺品牌图标。父 design 决策 10（D10）已拍板：`SegmentedControl`（Radix RadioGroup，每项 `role="radio"`），`当前生效` 行保留可访问文本 `当前生效：浅色|深色`，关于卡用 `BrandMark`。

## What Changes
- `web/src/features/settings/page.tsx`：
  - 两张卡改为 demo 的"节标题 + 卡片 + 行"结构：`<section aria-labelledby>` 内先是 `h2.settings-sec-h`（`外观`/`关于`，卡片外），再是 `div.settings-card`，卡内每行 `div.settings-row` 左侧 `settings-row-text`（标题 `settings-row-title` + 说明 `settings-row-desc`）、右侧控件。
  - 外观卡 `主题` 行：说明恰为 `浅色 / 深色 / 跟随系统 · 即时生效并持久保存`，右侧 `SegmentedControl`（label `主题`，三项 `浅色`/`深色`/`跟随系统`），接既有 `useTheme()` 的 `selectedTheme`/`setTheme`。旧 `fieldset`/`legend`/原生 radio/色块 swatch 删除。
  - 外观卡 `当前生效` 行：可见标题 `当前生效`，可见说明恰为 `浅色|深色 · 持久保存于 localStorage`；两者 `aria-hidden`，可访问文本由 `span.ui-sr-only` 承载，恰为 `当前生效：浅色|深色`。
  - 关于卡一行：左侧 `BrandMark size={32}`（无字标，`role="img"` 名 `WorkBuddy`，任何状态都渲染），右侧成功时标题为 `name`、说明恰为 `版本 <version>`；loading 说明 `正在读取服务信息`；失败 `p.ui-alert[role=alert]`。数据流（Provider `loadServiceInfo`、abort、supersede 收敛）不变。
- 新 `web/src/features/settings/settings.css`（demo:818-824 来源注释），`styles.css` 删除旧设置页规则（`.settings-card*`、`.theme-option*`、`.theme-swatch*`、`.service-identity*`、≤760 的 `.theme-options`/`.settings-page`）并 `@import` 新文件。≤760 时 `.settings-row` 换行。
- `web/src/ui/ui.css` 新增 `.ui-sr-only`（1px clip 模式，非 `display:none`）。
- 测试：
  - `describe("settings route")` 从 `web/test/settings-footer.test.tsx` 迁到新 `web/test/settings-page.test.tsx`，共享 helper 抽到新 `web/test/settings-support.tsx`。迁移时只改结构锚点（见 design 改写规则）。
  - `settings-page.test.tsx` 新增 S1–S7。

## Non-goals
主题逻辑与 storage/跨 tab 同步（不改 `features/theme/**`）；`parseServiceInfo`/类型（3.1 已完成）；Provider operation；页面标题（顶栏承担，#282 已完成）；ui-walk 断言改动；双 project 截图（6.1 #295）；关于卡可点击或外链。

## Capabilities
- MODIFIED `spa-shell`：Requirement「设置页」整段取父 delta（含布局句、`SegmentedControl`、`当前生效` 行、关于卡品牌 mark），Scenario「主题切换即时生效」改为"在分段控件选择"。

## Impact
`web/src/features/settings/{page.tsx,settings.css}`、`web/src/styles.css`、`web/src/ui/ui.css`；`web/test/{settings-footer,settings-page}.test.tsx`、`web/test/settings-support.tsx`（新）。不加依赖，不动服务端、`web/e2e/**`、`features/theme/**`、`features/auth/**`。

## 与 oracle 偏差留痕
- issue PR Boundary 写"一份测试"。`settings-footer.test.tsx` 现 785/800 行，加结构断言必过 size-guard，故拆出 `settings-page.test.tsx` 与 `settings-support.tsx`。
- demo 主题说明为 `…即时生效并持久保存（localStorage）`（demo:3541），父 delta 为 `浅色 / 深色 / 跟随系统 · 即时生效并持久保存`。本刀以 oracle 为准，不加括号。
- demo 关于卡为 `<img src=appIcon>` + `WorkBuddy` + `版本 5.3.11 · Live Demo 演示原型 · …`。上游图标不可复用（ATTRIBUTION §4），改用自有 `BrandMark`；name 与版本取 `/api/info`，说明只有 `版本 <version>`，不移植演示尾巴。
- demo 的 `当前生效` 行只有可见文本。父 delta 同时要求可见说明恰为 `浅色|深色 · 持久保存于 localStorage` 与可访问文本 `当前生效：浅色|深色`，本刀用视觉隐藏 span 同时满足：屏幕阅读器读 `当前生效：深色`，可见的两段 `aria-hidden` 以免重复朗读。
- demo 选中项为 `--wb-palette-black-90` + 白字；`SegmentedControl` 的样式在 #278 已定，本刀不改。

## Risk triage
- `.ui-sr-only` 写成 `display:none` 或 `visibility:hidden` 会让 ui-walk `getByText("当前生效：深色").toBeVisible()`（`web/e2e/ui-walk.spec.ts:382`）红。本地 ui-walk 是必需证据，S6 静态契约也钉住。
- Radix radio 是 `<button role="radio" aria-checked>`，不是 `<input>`：迁移用例里 `(… as HTMLInputElement).checked` 会得到 `undefined` 而断言失败，必须改写。改写规则 2 钉住。ui-walk 的 `.check()`/`toBeChecked()` 支持 ARIA radio，本地 ui-walk 验证。
- 节标题移到卡片外但仍在 `<section>` 内，`closest("section")` 仍能找到容器；改写规则 3 改用 `region` 语义查询，同时证明 `aria-labelledby` 生效。
- 删除旧 CSS 漏删会留下死规则或字面颜色（`#ffffff`/`#1f1f1f` swatch）。S6 钉住。
