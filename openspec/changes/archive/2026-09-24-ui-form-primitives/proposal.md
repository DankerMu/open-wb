# Proposal: ui-form-primitives（#276）

## Why
S1e 组 1 第二刀。#275 建立了 token 全集与 `web/src/ui/index.ts` 出口；页面对齐切片（登录卡 #284、设置页 #300、composer #288、files #292–#294/#302）需要按钮/输入/开关/标签/chip 五个表单级基元，而当前只有 `styles.css:115-153` 的三条 `.ui-button*` CSS 类（11 处 tsx 消费者）、无输入/开关/标签/chip 组件。demo 的对应契约在 `resource/workbuddy-live-demo.html:570-586`（`.wb-btn` 四变体三尺寸 + icon）、606-612（`.wb-input`、`--search`）、599-604（`.tag` 五色）、614-619（`.switch`）与 622-625（`.filter-chip`）。欢迎页快捷 chip `.quick-row .qk`（demo:352-356，32 高/圆角 100/`--wb-quick-action-selected-*`）与 `.filter-chip` 差异大，不归本刀 `Chip`，由 #289 自定。

## What Changes
- 新增 `web/src/ui/{button,input,switch,tag,chip}.tsx` 与各自 css（`ui/button.css` 等，由 `ui/ui.css` `@import` 汇总；`styles.css` 的 import 列表不变）：
  - `Button`：variant `primary|secondary|ghost|danger`，size `sm|md|lg|icon`，`loading` 时 `disabled` + `aria-busy="true"`、类名切到 `ui-btn--loading`、label 仍在 DOM 且仍占位（`color: transparent`），旋转指示器绝对定位居中、脱离文档流（宽度因此保留）；透传原生 button props，默认 `type="button"`。
  - `Input`：`<input class="ui-input">` 透传原生 props；`variant="search"` 渲染 `ui-input ui-input--search` 容器（`Icon name="search"` + `<input type="search">`）。
  - `Switch`：基于 `@radix-ui/react-switch`（`Root` = `ui-switch`，`Thumb` = `ui-switch-thumb`），`checked`/`onCheckedChange`/`disabled`，`role="switch"` 由 Radix 提供。
  - `Tag`：`tone` `brand|success|warning|error|neutral`（默认 neutral），`ui-tag ui-tag--<tone>`。
  - `Chip`：`<button type="button" aria-pressed={selected}>`，`selected`/`onSelect`，`ui-chip [ui-chip--selected]`。
- `web/src/ui/index.ts` 增量导出五个组件（及其 props 类型）。
- 守卫调整（`web/test/ui-guardrails.test.ts`）：`web/src/ui/**/*.css` 允许引用 `--wb-palette-*`（demo 组件规则本身直接引用调色板，如 `.wb-btn--primary`/`.switch`/`.filter-chip.active`；基元层是调色板→组件的映射边界），hex/`rgba(` 字面量仍禁止；`web/src/ui/**/*.tsx` 三类模式全部禁止。feature/routes 规则不变。
- 新依赖 `@radix-ui/react-switch`（MIT）；`ATTRIBUTION.md` §3 Radix 条目"当前尚未引入依赖"改为已安装包清单（其余包由后续切片安装）。
- 单测 `web/test/ui-form.test.tsx`：五组件角色/禁用/loading/选中/变体类名断言。

## Non-goals
Dialog/Menu/Popover/Toast 等其它基元（#277–#279）；任何 feature 迁移（既有 `.ui-button*` 类与 11 处消费者本刀不动，其 CSS 由最后一个迁移切片删除）；`web/test/radix-platform.ts` shim（#277；本刀 Switch 测试不放在 `<form>` 内、不传 `form` 属性——Radix Switch 在表单外不构造 ResizeObserver）；Chip 计数徽标（demo `.filter-chip .count`，无消费者）与欢迎页 `.qk` 形态（#289）；组件 story/文档页。

## Capabilities
### Modified
- `ui-primitives`：「基元组件库」Requirement 整体重述，加入五个组件契约与 ui 层调色板规则。

## Impact
- `web/package.json`（+`@radix-ui/react-switch`）、`package-lock.json`；`web/src/ui/{button,input,switch,tag,chip}.{tsx,css}`、`web/src/ui/ui.css`（`@import` 五个 css）、`web/src/ui/index.ts`；`web/test/ui-form.test.tsx`、`web/test/ui-guardrails.test.ts`（ui css 调色板豁免）；`ATTRIBUTION.md`。
- 不改任何页面、路由、feature css；`make ui-walk` 行为不变。knip：五个导出由 `ui-form.test.tsx` 消费。
- 已知延后：`@radix-ui/react-switch` 与 lucide 一样尚无页面消费者，bundle 体积/tree-shaking 证据归首个接入切片（#284/#300）。

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：前端通用契约——呈现类任务至少 expanded；新增公共出口导出与守卫规则变更)
Blast radius: 五个组件是后续 ≥8 个页面切片的取用面，props/类名契约一旦落地即被继承；守卫豁免若写宽（如 tsx 也豁免、或 hex 也放行）会让 #275 建立的 invariant 失效；类名若与既有 `.ui-button*` 撞名会经 `styles.css` 后置规则覆盖组件样式。
Selected risk packs: Public API / CLI / script entry（`ui/index.ts` 新导出与 props 契约）；Config / project setup（Radix 依赖、ATTRIBUTION、守卫规则）；Legacy compatibility / examples（`.ui-button*` 11 处消费者与类名命名空间）；Release / packaging / dependency compatibility（Radix peer 范围、ESM、jsdom 兼容）；Documentation / migration notes（ATTRIBUTION 措辞、demo→token 映射留痕）。
Evidence floor: `make check` exit 0；`ui-form.test.tsx` 先红后绿；守卫调整后 `ui-guardrails.test.ts` 对 ui css 注入 `#123456`/`rgba(` 仍红、注入 `var(--wb-palette-gray-3)` 绿、对 features css 注入 `--wb-palette-` 仍红；`npm run build --workspace web` 通过；`make ui-walk` exit 0。
