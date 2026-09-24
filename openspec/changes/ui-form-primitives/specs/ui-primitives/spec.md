# Spec: ui-primitives（切片 #276：表单级基元）

## MODIFIED Requirements

### Requirement: 基元组件库
`web/src/ui/index.ts` SHALL 是基元层的唯一出口，feature 与 routes 只经它导入基元；截至本切片导出 `Icon`、`BrandMark`、`Button`、`Input`、`Switch`、`Tag`、`Chip`（Dialog/Menu/Popover/Tooltip/Toast/EmptyState/SegmentedControl 由后续切片以 MODIFIED 加入）。基元组件 SHALL 用类名 + token 取色：`web/src/ui/**/*.css` 可引用语义 token 与 `--wb-palette-*`（基元层是调色板到组件的唯一映射边界，demo 组件规则直接引用调色板处照搬），不得出现 hex/`rgba(` 颜色字面量；`web/src/ui/**/*.tsx` 不得出现颜色字面量、`--wb-palette-` 引用与 `style={` 内联样式；每个组件根元素类名以 `ui-` 开头且不与既有 `.ui-button*`/`.ui-alert`/`.ui-muted`/`.ui-empty`/`.ui-page-heading` 撞名（既有类与其消费者在迁移切片前不动）。`BrandMark` SHALL 只含自有 mark SVG（沿用现有对勾图形）与可选字标 `WorkBuddy`，`size` 可配，不含任何上游品牌资产。
`Button` SHALL 提供 variant `primary|secondary|ghost|danger`（默认 secondary）与 size `sm|md|lg|icon`（默认 md），类名 `ui-btn ui-btn--<variant> ui-btn--<size>`，默认 `type="button"`（调用方可覆盖），透传原生 button 属性；`loading` 时 SHALL `disabled` 且 `aria-busy="true"`、加类名 `ui-btn--loading`、渲染 `aria-hidden` 且绝对定位（脱离文档流）、按变体上色（primary/danger 用 `--wb-text-white`，深色 primary 用 `--wb-palette-black-90`）的旋转指示器，children 仍在 DOM 并占位（文字透明——由 `.ui-btn.ui-btn--loading` 置于 button.css 末尾实现，且所有 hover 色规则带 `:not(:disabled)`，任何变体/主题/hover 下 label 都不显示），按钮宽度与非 loading 态一致；`size="icon"` 为 32×32 方形，调用方须提供 `aria-label`。样式映射 demo:570-586。
`Input` SHALL 渲染 `<input class="ui-input">` 并透传原生属性；`variant="search"` SHALL 渲染 `ui-input ui-input--search` 容器（`Icon name="search"` + `<input type="search">`）。样式映射 demo:606-612。
`Switch` SHALL 基于 `@radix-ui/react-switch`（`Root` 类名 `ui-switch`、`Thumb` 类名 `ui-switch-thumb`），`role="switch"`、`aria-checked` 与 `data-state` 由 Radix 提供，`checked`/`defaultChecked`/`onCheckedChange`/`disabled` 透传；jsdom 测试不放在 `<form>` 内且不传 `form` 属性（Radix 的表单桥接在表单内才构造 ResizeObserver，shim 归后续切片）。样式映射 demo:614-619。
`Tag` SHALL 提供 tone `brand|success|warning|error|neutral`（默认 neutral），类名 `ui-tag ui-tag--<tone>`。样式映射 demo:599-604（含 demo:601 深色 brand 文字色覆盖）。
`Chip` SHALL 是 `<button type="button">`，`selected` 映射 `aria-pressed` 与类名 `ui-chip--selected`，`onSelect` 映射点击。样式只映射 demo:622-625 的 `.filter-chip`（欢迎页 `.quick-row .qk` 形态不属于本组件）。可聚焦组件（Button/Input/Switch/Chip）的 css SHALL 自带 `:focus-visible` 规则重申自身圆角，以压制全局 `:focus-visible { border-radius: 4px }`；Button/Input/Switch/Chip 的过渡 SHALL 在 `prefers-reduced-motion: reduce` 下禁用（各组件 css 自带媒体块）。五个组件的 props SHALL 允许 `ref`（基于 `ComponentProps`，`ref` 落到根元素；search 变体落到内层 `<input>`）。
`ATTRIBUTION.md` §3 的 Radix 条目 SHALL 列出当前已安装的 Radix 包。

#### Scenario: 出口与品牌
- WHEN 在 jsdom 渲染 `<BrandMark />` 与 `<BrandMark wordmark />`，并静态 grep `web/src/ui/**/*.tsx`
- THEN `BrandMark` 渲染 svg，仅 `wordmark` 时出现文本 `WorkBuddy`；`web/src/ui/**/*.tsx` 无 `style={`；`Icon`/`BrandMark`/`Button`/`Input`/`Switch`/`Tag`/`Chip` 可从 `web/src/ui/index.ts` 导入

#### Scenario: 表单级基元可访问且状态可断言
- WHEN 在 jsdom 渲染 `<Button>保存</Button>`、`<Button loading>保存</Button>`、`<Button size="icon" aria-label="发送" />`、`<Input aria-label="账号" />`、`<Input variant="search" placeholder="搜索" />`、`<Switch aria-label="深色" checked={false} onCheckedChange={fn} />`、`<Tag tone="error">失败</Tag>`、`<Chip selected onSelect={fn}>日常</Chip>` 并点击可交互者
- THEN 默认按钮 `role=button`、`type="button"`、类名 `ui-btn ui-btn--secondary ui-btn--md`；loading 按钮 `disabled`、`aria-busy="true"`、类名含 `ui-btn--loading`、文本 `保存` 仍在 DOM、含 `aria-hidden` 指示器、点击不触发 `onClick`，且 `button.css` 中指示器为 `position: absolute`、最后一个规则块选择器为 `.ui-btn.ui-btn--loading` 且含 `color: transparent`、每个 `:hover` 选择器含 `:not(:disabled)`；`tag.css` 含 `[data-theme="dark"] .ui-tag--brand`；button/input/switch/chip 四个 css 各含 `:focus-visible` 规则（含 `border-radius`）与 `prefers-reduced-motion: reduce` 块；`<Input ref={r} />` 渲染后 `r.current` 为 `HTMLInputElement`；icon 按钮可访问名 `发送`、类名含 `ui-btn--icon`；`Input` 为 `role=textbox` 类名 `ui-input`，search 变体为 `role=searchbox` 且容器 `.ui-input--search` 含 svg；`Switch` 为 `role=switch` `aria-checked="false"`，点击后 `fn(true)`，`disabled` 时点击不触发；`Tag` 类名 `ui-tag ui-tag--error`；`Chip` `aria-pressed="true"`、类名含 `ui-chip--selected`、点击触发 `fn` 一次

#### Scenario: 基元层取色边界
- WHEN 静态扫描 `web/src/features/**/*.{css,tsx}`、`web/src/routes/**`、`web/src/ui/**/*.{css,tsx}`
- THEN 所有路径无 `#[0-9a-fA-F]{3,8}` 与 `rgba?(` 字面量；features/routes 与 `web/src/ui/**/*.tsx` 无 `--wb-palette-`；`web/src/ui/**/*.css` 引用的 `--wb-palette-*` 与 `--wb-*` 均在 `tokens.css` 有定义
