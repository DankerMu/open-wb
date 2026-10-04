## MODIFIED Requirements

### Requirement: 设计 token 全集
`web/src/styles/tokens.css` SHALL 是 `--wb-*` 设计 token 的唯一定义处：调色板层（`--wb-palette-*`）与语义层（`--wb-brand-*`、`--wb-bg-*`、`--wb-text-*`、`--wb-border-*`、`--wb-status-*`、`--wb-shadow-*`、`--wb-icon-*`、`--wb-font*`、`--wb-mono` 等），浅色在 `:root`、深色在 `[data-theme="dark"]`。token 的值由本仓拥有，不再要求与 `resource/workbuddy-live-demo.html` 逐值相等，名集合也不再受 demo 约束；文件头 SHALL 保留 token 来源说明（WorkBuddy 5.3.11 token 文件，经 demo；ATTRIBUTION.md §4）。字体 token 只列本地/系统字体栈，不得 `@import`/`<link>` 任何公网字体。`web/src/**/*.css` 引用的每个 `var(--wb-*)` SHALL 在 `tokens.css` 有定义（`web/test` 断言引用集合 ⊆ 定义集合）。feature 与 routes 的样式 SHALL 只引用语义层 token 或 ui-foundation 的主题变量，不得直接引用 `--wb-palette-*` 或硬编码颜色（`web/test` 以 grep 断言 `web/src/features/**`、`web/src/routes/**` 的 `.css`/`.ts`/`.tsx` 无 `#[0-9a-fA-F]{3,8}`、`rgba?(`、`--wb-palette-`；Tailwind 任意值类名里的颜色字面量同样命中）。

#### Scenario: token 分层且无未定义引用
- **WHEN** 读取 `tokens.css` 并扫描 `web/src`
- **THEN** `:root` 与 `[data-theme="dark"]` 两块都存在；`web/src/**/*.css` 无未定义的 `var(--wb-*)` 引用；`web/src/features/**`、`web/src/routes/**` 中无硬编码颜色（含 `rgba(`）与调色板引用；`tokens.css` 不含 `@import` 与公网字体地址；构建产物无公网字体请求

#### Scenario: 不再与 demo 逐值绑定
- **WHEN** 修改 `tokens.css` 中某个 token 的值，或新增一个 demo 没有的 `--wb-*` token，然后执行 `npm test --workspace web`
- **THEN** 没有测试因「与 demo 不相等」或「名集合多出变量」而失败
