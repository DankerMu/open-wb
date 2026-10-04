## ADDED Requirements

### Requirement: Tailwind 入口与层叠顺序
`web/src/styles.css` SHALL 是唯一样式入口（`web/index.html` 的 `<link>` 不变），并在文件最前声明层顺序 `@layer theme, base, legacy, components, utilities;`：Tailwind 的 theme、preflight（base）、utilities 各自导入到同名层；迁移前既有的全部样式（原 `styles.css` 的全局规则、`web/src/ui/*.css`、尚未迁移的 feature 与 routes 的 `.css`）SHALL 导入到 `legacy` 层，`tokens.css` 与主题映射文件不入层。由此 `legacy` 层的规则压过 preflight，Tailwind utilities 压过 `legacy` 层。已迁移区域的样式 SHALL 只用 Tailwind 类与主题变量，不再新增 `.css` 文件。尚未迁移的页面在 preflight 生效后 SHALL 保持功能可用（`make ui-walk` 全绿）；它们因 preflight 产生的观感变化不修复。

#### Scenario: utilities 压过旧全局规则
- **WHEN** 真实浏览器打开登录页，读取主按钮 `登录` 的计算样式
- **THEN** 其 `background-color` 等于主题变量 `--primary` 的计算值（不是被旧全局规则 `button { background: none }` 置空后的透明）

#### Scenario: 旧页面规则压过 preflight
- **WHEN** 真实浏览器打开一个尚未迁移的页面，读取某个只在其 `.css` 里声明了 `padding` 的容器的计算样式
- **THEN** 该 `padding` 等于其 `.css` 的声明值（不是 preflight 的 `0`）

#### Scenario: 层声明不可缺失或重排
- **WHEN** 读取 `web/src/styles.css`
- **THEN** 第一条规则是 `@layer theme, base, legacy, components, utilities;`；每个既有样式文件的 `@import` 都带 `layer(legacy)`；`tokens.css` 与主题映射文件的 `@import` 不带 `layer(...)`

### Requirement: 主题映射
`web/src/styles/theme.css` SHALL 把 shadcn/ui 约定的语义变量（至少 `--background`、`--foreground`、`--card`、`--card-foreground`、`--popover`、`--popover-foreground`、`--primary`、`--primary-foreground`、`--secondary`、`--secondary-foreground`、`--muted`、`--muted-foreground`、`--accent`、`--accent-foreground`、`--destructive`、`--border`、`--input`、`--ring`、`--radius` 及侧栏组的 `--sidebar*`）定义为对 `--wb-*` 语义 token 的引用（`var(--wb-…)`），不写颜色字面量，因此亮/暗取值随 `tokens.css` 的 `:root` / `[data-theme="dark"]` 自动切换，不另设 `.dark` 类。Tailwind 的 `dark:` 变体 SHALL 绑定到 `[data-theme="dark"]`（及其后代）。`--radius` 与字号刻度由本文件新定义（`tokens.css` 没有这两类 token）。`body` 的底色 SHALL 为 `--background`（映射自 `--wb-home-bg-secondary`）、文字色为 `--foreground`。首帧前主题脚本、`workbuddy-theme` 存储值与 `data-theme` 写入方式不变（spa-shell「首帧前主题」）。

#### Scenario: 亮暗两种主题的底色
- **WHEN** 真实浏览器分别在 `data-theme="light"` 与 `data-theme="dark"` 下打开 `/settings`
- **THEN** `body` 的计算底色分别等于 `tokens.css` 中 `--wb-home-bg-secondary` 的浅色值与深色值；一个带 `dark:` 变体类的元素只在深色下应用该变体

#### Scenario: 映射文件不含颜色字面量
- **WHEN** 读取 `web/src/styles/theme.css`
- **THEN** 其中无 `#[0-9a-fA-F]{3,8}`、`rgba?(`、`oklch(`、`hsl(` 字面量；每个语义变量的值都是 `var(--wb-…)`、对另一个语义变量的引用或非颜色量（如 `--radius`）

### Requirement: 组件分层
web SHALL 采用三层：`web/src/components/ui/`（由 shadcn/ui registry 拷入的组件，Radix 版式）与 `web/src/components/assistant-ui/`（由 assistant-ui registry 拷入的组件）是**拷入层**；`web/src/features/**` 与 `web/src/routes/**` 是**应用层**，只经 `@/components/...` 使用拷入层。`web/components.json` SHALL 入库并记录 registry 配置（style 为 Radix 版式、别名指向 `@/components`、`@/lib/utils`）。`radix-ui` 与 `@radix-ui/*` 只能在拷入层与迁移前的 `web/src/ui` 中导入；`lucide-react` 可在拷入层与应用层直接导入。拷入层只收实际被使用的组件。迁移期间 `web/src/ui` 冻结：不新增文件，已迁移区域（本 change 为 `web/src/routes/**`、`web/src/features/auth/**`、`web/src/features/settings/**`、`web/src/features/theme/**`）SHALL 只从 `web/src/ui/index.js` 导入 `Icon`、`IconName` 与 `BrandMark` 三个名字，且该区域内不存在 `.css` 文件。

#### Scenario: 应用层不直接引 Radix
- **WHEN** 扫描 `web/src/features/**` 与 `web/src/routes/**` 的 `.ts`/`.tsx`
- **THEN** 没有文件导入 `radix-ui` 或 `@radix-ui/*`

#### Scenario: 已迁移区域不回用旧基元
- **WHEN** 扫描 `web/src/routes/**`、`web/src/features/auth/**`、`web/src/features/settings/**`、`web/src/features/theme/**`
- **THEN** 其中从 `web/src/ui` 的导入只出现 `Icon`、`IconName`、`BrandMark`；这些目录下没有 `.css` 文件；`web/src/ui` 的文件集合不多于迁移前

### Requirement: 拷入层的门槛豁免
拷入层的两个目录 SHALL 豁免且只豁免以下门槛：单元测试覆盖率统计（`vitest` coverage 排除）、重复代码检测（jscpd 忽略）、单文件行数上限（size-guard 排除）、Biome linter 规则（含复杂度上限；格式化仍适用）、knip 的未使用导出报告。豁免 SHALL 以这两个目录的精确路径配置，不使用能匹配应用层的通配；应用层（含 `web/src/lib`）的全部门槛不变。`AGENTS.md` 的 Enforcement Index SHALL 以一行注记说明这项豁免及其依据（ADR-0013）。`ATTRIBUTION.md` SHALL 登记 Tailwind CSS、shadcn/ui、`radix-ui`（及保留的各 `@radix-ui/*` 包）与其许可证；assistant-ui 在其组件拷入时登记。

#### Scenario: 豁免不外溢到应用层
- **WHEN** `make test-guardrails` 分别注入：一个 801 行的 `web/src/features/x.tsx`；一个 801 行的 `web/src/components/ui/x.tsx`
- **THEN** 前者被 size-guard 拒绝，后者通过

#### Scenario: 豁免路径精确
- **WHEN** 读取 vitest coverage 的排除项、jscpd 的 ignore、size-guard 的排除清单、Biome 的 overrides 与 knip 的 ignore
- **THEN** 每处新增的条目都恰好指向 `web/src/components/ui` 与 `web/src/components/assistant-ui`（及其下文件），没有匹配 `web/src/features`、`web/src/routes` 或 `web/src/lib` 的条目

#### Scenario: 归属登记完整
- **WHEN** 读取 `ATTRIBUTION.md` 与 `web/package.json`
- **THEN** `tailwindcss`、shadcn/ui、`radix-ui` 以及 `web/package.json` 中每个 `@radix-ui/*` 依赖都在 `ATTRIBUTION.md` 出现并带许可证
