## ADDED Requirements

### Requirement: Tailwind 入口与层叠顺序
`web/src/styles.css` SHALL 是唯一样式入口（`web/index.html` 的 `<link>` 不变），其第一条规则 SHALL 是层声明 `@layer theme, base, legacy, components, utilities;`。Tailwind 的 theme、preflight、utilities SHALL 分别导入到 `theme`、`base`、`utilities` 层。迁移前既有的样式（原 `styles.css` 的全局规则——全局 reduced-motion 块除外——以及 `web/src/ui/*.css`、尚未迁移的 feature 与 routes 的 `.css`）SHALL 集中在 `web/src/styles/legacy.css`，并由 `styles.css` 以 `@import "./styles/legacy.css" layer(legacy);` 导入；`styles.css` 中除 Tailwind 三段、`tw-animate-css`、`./styles/tokens.css`、`./styles/theme.css` 与这一条之外 SHALL 没有其它 `@import`，既有 `.css` SHALL 只被 `legacy.css` 直接导入，或经冻结区的 `web/src/ui/ui.css` 传递导入。`tokens.css`、`theme.css` 与全局 reduced-motion 块不入层。由此：未分层规则压过 utilities，utilities 压过 `legacy`，`legacy` 压过 preflight。已迁移区域的样式 SHALL 只用 Tailwind 类与主题变量（`Icon`、`BrandMark` 自带的 `ui-*` 类除外，它们的规则留在 `legacy` 层），不再新增 `.css` 文件。尚未迁移的页面在 preflight 生效后 SHALL 保持功能可用（`make ui-walk` 全绿）；它们因 preflight 产生的观感变化不修复。

#### Scenario: utilities 压过旧全局规则
- **WHEN** `make ui-walk` 打开登录页，读取主按钮 `登录` 的计算 `background-color`
- **THEN** 它等于 `--primary` 的计算值，不是透明（旧全局规则 `button { background: none }` 在 `legacy` 层，被 utilities 压过）

#### Scenario: 旧页面规则压过 preflight
- **WHEN** `make ui-walk` 打开 `/files`（尚未迁移），读取主区（`main`）内第一个旧基元按钮（类 `ui-btn`）的计算 `padding-left`（外壳的图标按钮自身即 `padding: 0`，证明不了层序）
- **THEN** 它不是 `0px`（`button.css` 的声明在 `legacy` 层，压过 preflight 的 `padding: 0`）；该场景在 `legacy` 层整体移除时（change `s1f-files-page` 收尾）随之删除

#### Scenario: 入口结构不可缺失或重排
- **WHEN** 静态读取 `web/src/styles.css` 与 `web/src/styles/legacy.css`
- **THEN** `styles.css` 的第一条规则是 `@layer theme, base, legacy, components, utilities;`；它对 `./styles/legacy.css` 的导入带 `layer(legacy)`，对 `tokens.css` 与 `theme.css` 的导入不带 `layer(...)`，此外只有 Tailwind 三段与 `tw-animate-css` 的导入；`web/src` 下其它既有 `.css` 只被 `legacy.css` 直接导入或经 `web/src/ui/ui.css` 传递导入

### Requirement: 主题映射
`web/src/styles/theme.css` SHALL 定义 shadcn/ui 约定的语义变量：`--background`、`--foreground`、`--card`、`--card-foreground`、`--popover`、`--popover-foreground`、`--primary`、`--primary-foreground`、`--secondary`、`--secondary-foreground`、`--muted`、`--muted-foreground`、`--accent`、`--accent-foreground`、`--destructive`、`--border`、`--input`、`--ring`、`--radius`、`--sidebar`、`--sidebar-foreground`、`--sidebar-border`、`--sidebar-accent`、`--sidebar-accent-foreground`。每个颜色变量的值 SHALL 是对 `tokens.css` 中 `--wb-*` token 的引用（本文件与 `web/src/ui/**/*.css` 同为调色板到组件的映射边界，可引用 `--wb-palette-*`），不写颜色字面量。沿用现有配色体系意味着以下对应 SHALL 成立：

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--background` | `--wb-home-bg-secondary` | 同名 token 的深色值 |
| `--foreground` | `--wb-text-primary` | 同名 token 的深色值 |
| `--primary` | `--wb-palette-black-90` | `--wb-palette-white-90` |
| `--primary-foreground` | `--wb-text-white` | `--wb-palette-black-90` |
| `--destructive` | `--wb-status-error` | 同名 token 的深色值 |
| `--border` | `--wb-border-default` | 同名 token 的深色值 |
| `--sidebar` | `--wb-sidebar-bg` | 同名 token 的深色值 |

（`--primary` 两行即迁移前主按钮 `.ui-btn--primary` 的取值；语义 token 自己随 `[data-theme="dark"]` 换值的变量不需要深色块，`--primary` / `--primary-foreground` 需要一个 `[data-theme="dark"]` 块。）其余变量的对应由实现按同一原则选定并在 PR 描述中列表。Tailwind 的 `dark:` 变体 SHALL 以 `@custom-variant dark` 绑定到 `[data-theme="dark"]`（及其后代），不设 `.dark` 类。`--radius` SHALL 为 `0.5rem`；字号沿用 Tailwind 默认刻度，`body` 字号 14px、行高 22px 与迁移前一致。`body` 的底色 SHALL 为 `--background`、文字色为 `--foreground`。首帧前主题脚本、`workbuddy-theme` 存储值与 `data-theme` 写入方式不变（spa-shell「首帧前主题」）。

#### Scenario: 亮暗两种主题的底色与主按钮
- **WHEN** `make ui-walk` 分别在 `data-theme="light"` 与 `data-theme="dark"` 下打开 `/settings`，读取 `body` 的计算底色与文字色；并在登录页读取主按钮的计算底色
- **THEN** `body` 底色分别为 `rgb(255, 255, 255)` 与 `rgb(20, 20, 20)`（`--wb-home-bg-secondary` 的两个取值），文字色等于 `--wb-text-primary` 的对应取值；浅色下主按钮底色为 `rgba(0, 0, 0, 0.9)`（`--wb-palette-black-90`）

#### Scenario: 映射文件结构
- **WHEN** 静态读取 `web/src/styles/theme.css`
- **THEN** 上列语义变量全部有定义；其中无 `#[0-9a-fA-F]{3,8}`、`rgba?(`、`oklch(`、`hsl(` 字面量；含一条把 `dark` 变体绑定到 `[data-theme="dark"]` 的 `@custom-variant`；`--primary` 在 `:root` 与 `[data-theme="dark"]` 下分别引用 `--wb-palette-black-90` 与 `--wb-palette-white-90`

### Requirement: 组件分层
web SHALL 采用两层加一个冻结区：`web/src/components/ui/`（由 shadcn/ui registry 拷入的组件，Radix 版式）与 `web/src/components/assistant-ui/`（由 assistant-ui registry 拷入的组件）是**拷入层**；`web/src` 下除拷入层与 `web/src/ui/` 之外的全部 `.ts`/`.tsx`（features、routes、lib、入口）是**应用层**；`web/src/ui/` 是迁移期间的**冻结区**。`web/components.json` SHALL 入库并记录 registry 配置（Radix 版式 style、别名指向 `@/components`、`@/components/ui`、`@/lib/utils`）。`radix-ui` 与 `@radix-ui/*` 只能在拷入层与冻结区中导入；`lucide-react` 可在拷入层与应用层直接导入。拷入后的组件只允许三类修改：把颜色字面量换成主题变量、中文化可见文案与 aria 文案、按 Biome 格式化。冻结区 SHALL 不新增文件，其文件名集合 SHALL 是守卫测试内所列清单（本 change 开始时的 32 个文件）的子集；唯一允许的内容变更是在 `index.ts` 增加 `useEscapeFallback` 的导出。**已迁移区域**由守卫测试内的一份目录清单定义（本 change 结束时为 `web/src/routes/**`、`web/src/features/auth/**`、`web/src/features/settings/**`、`web/src/features/theme/**`）：清单内的文件从 `web/src/ui` 只可导入 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`，且清单内的目录下不存在 `.css` 文件。

#### Scenario: 应用层不直接引 Radix
- **WHEN** 扫描 `web/src` 下除 `components/ui`、`components/assistant-ui` 与 `ui` 之外的全部 `.ts`/`.tsx`
- **THEN** 没有文件静态或动态导入 `radix-ui` 或 `@radix-ui/*`

#### Scenario: 已迁移区域不回用旧基元，冻结区不增长
- **WHEN** 扫描守卫清单内的目录，并列出 `web/src/ui` 的文件
- **THEN** 清单内的文件从 `web/src/ui` 的导入只出现 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`；这些目录下没有 `.css` 文件；`web/src/ui` 的每个文件名都在守卫的冻结清单里；对注入样本（清单内文件导入 `Button`、清单内出现 `.css`、冻结区多出一个文件）守卫各判失败

### Requirement: 拷入层的门槛豁免
拷入层的两个目录 SHALL 豁免且只豁免以下门槛：单元测试覆盖率统计（`web/vitest.config.ts` 的 `coverage.exclude`，不改根 `vitest.shared.mjs`）、重复代码检测（`.jscpd.json` `ignore`）、单文件行数上限（`scripts/size-guard.sh` 内按这两个目录的路径前缀排除，带参数与无参数两种调用都生效）、Biome linter 规则（`biome.json` `overrides` 对这两个目录关闭 linter；格式化仍适用）、knip 的未使用导出报告（`knip.json` web workspace 的 `ignore`）。每处条目 SHALL 恰好指向 `web/src/components/ui` 与 `web/src/components/assistant-ui`，不使用能匹配应用层或冻结区的通配；应用层的全部门槛不变。`constraints.yaml` 的 `exemptions.entries` SHALL 登记这两个目录及其豁免的规则与依据（ADR-0013）。`AGENTS.md` SHALL 在 Enforcement Index 的表格与其后的说明段之后、`Known blind spots` 小节之前以一行注记说明这项豁免。`ATTRIBUTION.md` SHALL 登记 Tailwind CSS、shadcn/ui、`radix-ui`（及保留的各 `@radix-ui/*` 包）与其许可证；assistant-ui 在其组件拷入时登记。为解析 Tailwind 4 的 at-rule，`biome.json` 顶层 SHALL 设 `css.parser.tailwindDirectives: true`（这是解析选项，不是豁免）。

#### Scenario: 豁免不外溢到应用层
- **WHEN** `make test-guardrails` 在仓库内临时创建并分别对 size-guard 传入：一个 801 行的 `web/src/features/_probe.tsx`；一个 801 行的 `web/src/components/ui/_probe.tsx`（用后删除）
- **THEN** 前者被拒绝，后者通过

#### Scenario: 豁免路径精确
- **WHEN** 守卫测试读取 `web/vitest.config.ts` 的 coverage 排除项、`.jscpd.json` 的 `ignore`、`scripts/size-guard.sh` 的排除前缀、`biome.json` 的 `overrides`、`knip.json` 的 web `ignore`、`constraints.yaml` 与 `AGENTS.md`
- **THEN** 每处为本 change 新增的条目都只匹配 `web/src/components/ui` 与 `web/src/components/assistant-ui` 之下的路径；`biome.json` 对这两个目录的 override 不关闭 formatter；`constraints.yaml` `exemptions.entries` 含这两个目录；`AGENTS.md` 在 `## Enforcement Index` 与 `### Known blind spots` 之间含一行同时提到这两个目录与 ADR-0013 的注记

#### Scenario: 归属登记完整
- **WHEN** 读取 `ATTRIBUTION.md` 与 `web/package.json`
- **THEN** `tailwindcss`、shadcn/ui、`radix-ui` 以及 `web/package.json` 中每个 `@radix-ui/*` 依赖都在 `ATTRIBUTION.md` 出现并带许可证
