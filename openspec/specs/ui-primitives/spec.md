# ui-primitives Specification

## Purpose
TBD - created by archiving change ui-tokens-foundation. Update Purpose after archive.
## Requirements
### Requirement: 设计 token 全集
`web/src/styles/tokens.css` SHALL 定义 demo（`resource/workbuddy-live-demo.html:19-188`）的调色板层（`--wb-palette-*`）与语义层（`--wb-brand-*`、`--wb-bg-*`、`--wb-text-*`、`--wb-border-*`、`--wb-status-*`、`--wb-shadow-*`、`--wb-icon-*`、`--wb-font*`、`--wb-mono`）全部 token，浅色在 `:root`、深色在 `[data-theme="dark"]`，值逐字取自 demo（"逐字"指经格式归一化——hex 小写、空白折叠、数字字面量规范化（`.10`→`0.1`）、折行合并——后相等，因 biome 会重排格式）；demo 引用但未定义的六个变量 SHALL 在此补齐为固定值并注明"demo 缺失、本仓补定"：`--wb-palette-black-60: rgba(0,0,0,.6)`、`--wb-palette-white-10: rgba(255,255,255,.1)`、`--wb-palette-white-20: rgba(255,255,255,.2)`、`--wb-palette-white-60: rgba(255,255,255,.6)`、`--wb-text-white: var(--wb-palette-white-100)`（以上两块同值）、`--wb-home-composer-chip-bg-hover`: 浅色 `var(--wb-palette-gray-3)`、深色 `var(--wb-bg-hover)`。每块的变量名集合 SHALL 恰为 demo 对应块名集合加这六个名，不得多出其它变量。文件头 SHALL 保留 token 来源说明（WorkBuddy 5.3.11 token 文件，经 demo；ATTRIBUTION.md §4）。`--wb-font-heading` 是唯一允许与 demo 值不同的变量：SHALL 去掉 `Poppins`、只列本地/系统字体栈，不得 `@import`/`<link>` 任何公网字体。仓内既有但 demo 无的 `--wb-home-bg`/`--wb-control-bg` SHALL 删除，消费者改用值相同的 demo token `--wb-home-bg-primary`/`--wb-color-bg-input`；`web/src/**/*.css` 引用的每个 `var(--wb-*)` SHALL 在 `tokens.css` 有定义（`web/test` 断言引用集合 ⊆ 定义集合）。feature 样式 SHALL 只引用语义层 token，不得直接引用 `--wb-palette-*` 或硬编码颜色（`web/test` 以 grep 断言 `web/src/features/**/*.css`、`web/src/features/**/*.tsx` 与 `web/src/routes/**` 无 `#[0-9a-fA-F]{3,8}`、`rgba?(`、`--wb-palette-`）。

#### Scenario: token 完整且分层
- WHEN 读取 `tokens.css` 并对照 demo `:root` 与 `[data-theme="dark"]` 两块
- THEN demo 定义的每个 `--wb-*` 变量名在对应主题块中存在且归一化后值相等（`--wb-font-heading` 期望为去掉 `Poppins,` 后的串）；六个补定变量在两块中都存在且等于固定值；每块名集合恰为 demo 名集合 ∪ 六个补定名；`web/src/**/*.css` 无未定义的 `var(--wb-*)` 引用；`web/src/features/**/*.css`、`web/src/features/**/*.tsx`、`web/src/routes/**` 中无硬编码颜色（含 `rgba(`）与调色板引用；构建产物无公网字体请求

### Requirement: 基元组件库
`web/src/ui/index.ts` SHALL 是基元层的唯一出口，feature 与 routes 只经它导入基元；本切片导出 `Icon` 与 `BrandMark`（Radix 基元由后续切片以 MODIFIED 加入）。基元组件 SHALL 用类名 + token 取色，`web/src/ui/**/*.tsx` 不得出现 `style={` 内联样式。`BrandMark` SHALL 只含自有 mark SVG（沿用现有对勾图形）与可选字标 `WorkBuddy`，`size` 可配，不含任何上游品牌资产。

#### Scenario: 出口与品牌
- WHEN 在 jsdom 渲染 `<BrandMark />` 与 `<BrandMark wordmark />`，并静态 grep `web/src/ui/**/*.tsx`
- THEN `BrandMark` 渲染 svg，仅 `wordmark` 时出现文本 `WorkBuddy`；`web/src/ui/**/*.tsx` 无 `style={`；`Icon`/`BrandMark` 可从 `web/src/ui/index.ts` 导入

### Requirement: 动效与图标
`Icon` SHALL 是单一组件：`name` 为本仓用到的 lucide 图标名联合类型，内部维护 name→组件映射、不逐个再导出 lucide 图标；size `12|14|16|18|20`（类名 `ui-icon-<size>`）；默认 `aria-hidden="true"`，传 `label` 时为 `role="img"` 且以 `label` 为可访问名。`web/src/ui/motion.css` SHALL 提供 demo 的 `wb-fadein`、`wb-pop`、`wb-pulse`、`wb-caret`、`wb-spin`、`wb-drawer-in` 关键帧与对应工具类（`ui-fadein`、`ui-pop`、`ui-pulse`、`ui-caret`、`ui-spin`），并在 `prefers-reduced-motion: reduce` 下把每个工具类置为 `animation: none` 与 `transition: none`；demo 未使用的 `wb-float`/`wb-shimmer` 不移植。图标 SHALL 全部经 `Icon` 取自 `lucide-react`（ISC，打包进产物，运行时零网络请求），`ATTRIBUTION.md` SHALL 新增 lucide（ISC）与 Radix UI Primitives（MIT）条目。

#### Scenario: 图标可访问、动效可禁用、归属登记
- WHEN 在 jsdom 渲染 `<Icon name="folder" />` 与 `<Icon name="folder" label="目录" size={12} />`，并静态读取 `motion.css` 与 `ATTRIBUTION.md`
- THEN 第一个 svg `aria-hidden="true"`；第二个 `role="img"`、可访问名 `目录`、类名含 `ui-icon-12`；`motion.css` 的 reduced-motion 块覆盖全部五个 `ui-*` 工具类；`ATTRIBUTION.md` 含 `lucide`/ISC 与 `Radix`/MIT 条目

