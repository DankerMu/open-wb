## MODIFIED Requirements

### Requirement: Tailwind 入口与层叠顺序
`web/src/styles.css` SHALL 是唯一样式入口（`web/index.html` 的 `<link>` 不变），其第一条规则 SHALL 是层声明 `@layer theme, base, components, utilities;`（自 s1f-legacy-layer-removal 起不含 `legacy`）。Tailwind 的 theme、preflight、utilities SHALL 分别导入到 `theme`、`base`、`utilities` 层。`styles.css` 中除 Tailwind 三段、`tw-animate-css`、`tw-shimmer`（拷入的 assistant-ui 组件给「进行中」标题用的流光类；owner 2026-10-05 决定启用）、`./styles/tokens.css`、`./styles/theme.css` 之外 SHALL 没有其它 `@import`。`web/src` 下的 `.css` 文件 SHALL 恰为 `web/src/styles.css`、`web/src/styles/tokens.css`、`web/src/styles/theme.css` 三个，`tokens.css` 与 `theme.css` 自身不含 `@import`；`web/src/styles/legacy.css`、`web/src/ui/` 下的样式文件与 `legacy` 层 SHALL 不存在。`tokens.css`、`theme.css` 与全局 reduced-motion 块不入层；唯一例外是 `theme.css` 里的一个 `@layer base { … }` 块，它依次承载：(1) 边框色基线 `*, ::before, ::after { border-color: var(--border); }`（拷入组件里不带颜色类的边框取 `--border` 而非 `currentColor`）；(2) `Icon`、`BrandMark` 自带的 `ui-icon`、`ui-icon-<size>`、`ui-brand*` 类的规则；(3) 全局基础规则——`*` 的 `box-sizing`、`html` / `body` / `#root` 的高度、`color-scheme` 的亮暗取值、`body` 的边距、字体、字号 14px、行高 22px 与溢出（视口不宽于 760px 时改为可滚动）、`button` / `input` / `textarea` / `select` 的 reset 与禁用态、链接、全局 `:focus-visible` 描边、选区与滚动条；(4) `.ui-alert`、`.ui-muted`、`.ui-empty` 三个类。这些规则 SHALL 在 `base` 层而不是未分层：它们排在 preflight 之后（同一层内按特异性与源码顺序压过 preflight），又低于 utilities（使用处的 Tailwind 类压过它们）。该块的选择器集合由守卫测试按清单断言，SHALL NOT 增加新的选择器（可以减少）；`theme.css` 里块外的规则 SHALL 只有 `:root`、`[data-theme="dark"]`、`@theme inline`、`body` 的底色与文字色、以及 reduce 下的 `[class*="transition"]`。由此：未分层规则压过 utilities，utilities 压过 `base` 层里的全局基础规则，全局基础规则压过 preflight。应用代码的样式 SHALL 只用 Tailwind 类与主题变量（上列 `ui-*` 类除外），SHALL NOT 新增 `.css` 文件。把这些规则从旧的 `legacy` 层搬进 `base` 块 SHALL 不改变任何页面的计算样式：s1f-legacy-layer-removal 以固定的探针清单在搬运前后、亮暗两种主题下逐项比对计算样式，结果随该 PR 提交。「全局基础规则压过 preflight」不再有专门的走查探针（旧的层序探针随 `legacy` 层删除）；它由入口结构守卫（导入次序）与上述块内清单的静态断言保证。

#### Scenario: utilities 压过旧全局规则
- **WHEN** `make ui-walk` 打开登录页，读取主按钮 `登录` 的计算 `background-color`
- **THEN** 它等于 `--primary` 的计算值，不是透明（全局规则 `button { background: none }` 在 `base` 层，被 utilities 压过）

#### Scenario: 旧页面规则压过 preflight
- **WHEN** 静态读取 `web/src/styles/theme.css`（去注释后按顶层块遍历）
- **THEN** 其中的 `@layer` 块恰为一个 `@layer base`，块内第一条规则是边框色基线；块内的选择器集合等于守卫清单（含 `.ui-icon` 与五个 `.ui-icon-<size>`、`.ui-brand` 与四个 `.ui-brand-*`、`html`、`body`、`button`、`:focus-visible`、`::selection`、三条 `::-webkit-scrollbar*`、`.ui-alert`、`.ui-muted`、`.ui-empty` 等）；块内 `body` 规则含 `font-size: 14px` 与 `line-height: 22px`；块内恰有一个嵌套的 `@media (max-width: 760px)` 块，只含 `body { overflow: auto; }`；块外的顶层规则只有 `:root`、`[data-theme="dark"]`、`@theme inline`、`body`（只声明底色与文字色）与 reduce 媒体块；对注入样本（块内多一个选择器、把 `button` 的 reset 挪到块外成为未分层规则、把块改成别的层名、删掉边框色基线）守卫各判失败

#### Scenario: 入口结构不可缺失或重排
- **WHEN** 静态读取 `web/src/styles.css` 并列出 `web/src` 下全部 `.css` 文件
- **THEN** `styles.css` 的第一条规则是 `@layer theme, base, components, utilities;`；它的导入恰为 Tailwind 三段（各带其层）、`tw-animate-css`、`tw-shimmer`、`./styles/tokens.css` 与 `./styles/theme.css`（后两条不带 `layer(...)`），此外只有一个未分层的全局 reduce 块；`web/src` 下的 `.css` 恰为 `styles.css`、`styles/tokens.css`、`styles/theme.css`，后两个文件不含 `@import`；对注入样本（层声明里加回 `legacy`、加回 `@import "./styles/legacy.css" layer(legacy);`、`tokens.css` 入层、多一条 `@import`、`web/src/features` 下出现一个 `.css`）守卫各判失败

#### Scenario: 文件页样式已退出 legacy 层
- **WHEN** 列出 `web/src/features/files` 下的文件，并检查 `web/src/styles/legacy.css`
- **THEN** 该目录下没有 `.css` 文件；`web/src/styles/legacy.css` 不存在


### Requirement: 主题映射
`web/src/styles/theme.css` SHALL 定义 shadcn/ui 约定的语义变量：`--background`、`--foreground`、`--card`、`--card-foreground`、`--popover`、`--popover-foreground`、`--primary`、`--primary-foreground`、`--secondary`、`--secondary-foreground`、`--muted`、`--muted-foreground`、`--accent`、`--accent-foreground`、`--destructive`、`--border`、`--input`、`--ring`、`--radius`、`--sidebar`、`--sidebar-foreground`、`--sidebar-border`、`--sidebar-accent`、`--sidebar-accent-foreground`。每个颜色变量的值 SHALL 是对 `tokens.css` 中 `--wb-*` token 的引用（本文件是调色板到组件的唯一映射边界，可引用 `--wb-palette-*`；旧的 `web/src/ui/**/*.css` 已随 s1f-legacy-layer-removal 删除），不写颜色字面量。沿用现有配色体系意味着以下对应 SHALL 成立：

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
web SHALL 采用拷入层与应用层两层（自 s1f-legacy-layer-removal 起不再有冻结区）：`web/src/components/ui/`（由 shadcn/ui registry 拷入的组件，Radix 版式）与 `web/src/components/assistant-ui/`（由 assistant-ui registry 拷入的组件）是**拷入层**；`web/src` 下除拷入层之外的全部 `.ts`/`.tsx`（features、routes、lib、入口，以及直接放在 `web/src/components/` 下的自写共享组件）是**应用层**。自写共享组件——`web/src/components/icon.tsx`（`Icon`、`IconName`）与 `web/src/components/brand-mark.tsx`（`BrandMark`），以及仅当 ui-primitives「覆盖层的 Escape 关闭」的实测结论为保留时的 `web/src/components/escape-fallback.ts`——是本仓自写代码，不是 registry 拷入的组件：SHALL 直接放在 `web/src/components/` 下、不进两个拷入目录，适用应用层的全部门槛（「拷入层的门槛豁免」不覆盖它们），SHALL NOT 导入 Radix。`web/src/ui/` SHALL 不存在（旧基元层已删除），`web/src` 下 SHALL NOT 有任何模块从它导入；`ToastProvider` 与 `useToast` 随之删除，`web/src` 下 SHALL NOT 再出现这两个标识符（s1f-legacy-layer-removal 不提供替代的通知机制）。`web/components.json` SHALL 入库并记录 registry 配置（Radix 版式 style、别名指向 `@/components`、`@/components/ui`、`@/lib/utils`，以及把 registry 的 hooks 落到拷入层的 `@/components/assistant-ui/hooks`）。`radix-ui` 与 `@radix-ui/*` 只能在拷入层中导入；`lucide-react` 可在拷入层与应用层直接导入。自 s1f-chat-surface 起 `web/src/components/assistant-ui/`（`components.json` 产生的 registry 落点）只含 assistant-ui registry 的 `markdown-text`、`reasoning`、`tool-group` 三个组件与它们的 registry 依赖（例如 `tooltip-icon-button`、`use-copy-to-clipboard`），外加一个只声明样式模块类型的 `styles.d.ts`，各在首次用到它的改动里拷入；它们依赖的 shadcn/ui 组件（`collapsible` 等，不含 `avatar`）拷入 `web/src/components/ui/`；registry 的 `thread` 与 `tool-fallback` SHALL NOT 拷入。会话页工作空间侧边栏（workspace-sidebar）用到的 shadcn/ui `resizable` 随 s1f-files-page 拷入 `web/src/components/ui/`，它的 npm 依赖 `react-resizable-panels` 同样随之加入并登记。拷入的组件需要的 npm 包（例如 `tw-shimmer`）随该组件一起加入依赖并登记到 `ATTRIBUTION.md`。它们与 shadcn/ui 组件适用同一组修改限制。会话页的线程、消息、步骤卡、停靠区与输入框是应用层组件（`web/src/features/chat/` 内），直接由 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合，并组合上述三个拷入组件；全部行为定制（链接惰性、图片显示为 alt 文本、块次序、失败自动展开、不提供编辑/分支/附件 UI）SHALL 在应用层实现（例如经 `markdown-text` 的 `components` 覆盖、组合 `tool-group` / `reasoning` 的 Root/Trigger/Content），拷入文件只受下述六类修改。拷入后的组件只允许六类修改：把颜色字面量换成主题变量、中文化可见文案与 aria 文案、按 Biome 格式化、把 `cn` 的导入归一到 `@/lib/utils`（不引入 npm 包 `cn`）、为本仓严格 TS 选项做纯类型适配（不改运行时行为）、把被 registry 原文丢弃的调用方 `children` 或属性原样透传给它包着的底层基元（只增不改：拷入文件只转发调用方给的值，不写默认值，调用方不传时行为与原文一致）。s1f-ui-foundation 至 s1f-files-page 期间的冻结区文件清单、已迁移区域清单与导入白名单（`Icon`、`IconName`、`BrandMark`、`useEscapeFallback`）已随旧基元层一起退役，守卫 SHALL NOT 再保留这些清单；取而代之的终态由守卫断言：`web/src/ui` 下没有文件、没有模块从它导入；`web/src/features`、`web/src/routes`、`web/src/lib`、`web/src/components` 下没有 `.css` 文件（见「Tailwind 入口与层叠顺序」）；`web/src/features/chat` 下没有 `session-filter.tsx`。会话列表用到的 shadcn/ui 组件只限已拷入的 `button`、`input`、`dialog`、`alert-dialog`、`dropdown-menu`、`collapsible`、`tooltip`；s1f-session-list-temp-space 与 s1f-legacy-layer-removal 都不为列表拷入新的 registry 组件。

#### Scenario: 应用层不直接引 Radix
- **WHEN** 扫描 `web/src` 下除 `components/ui`、`components/assistant-ui` 之外的全部 `.ts`/`.tsx`（含直接放在 `web/src/components/` 下的文件）
- **THEN** 没有文件静态或动态导入 `radix-ui` 或 `@radix-ui/*`；对注入样本（`web/src/features` 下一个文件导入 `@radix-ui/react-dialog`、`web/src/components/icon.tsx` 导入 `radix-ui`、`web/src/ui/` 下重新出现的一个文件导入 Radix）守卫各判失败

#### Scenario: 已迁移区域不回用旧基元，冻结区不增长
- **WHEN** 列出 `web/src` 下的全部文件并扫描全部 `.ts`/`.tsx`
- **THEN** `web/src/ui` 下没有任何文件；没有模块从解析到 `web/src/ui` 的路径导入（具名、`type`、`as` 改名、命名空间、副作用、再导出与动态导入都算）；`web/src` 下不出现标识符 `useToast` 与 `ToastProvider`；`web/src/components/icon.tsx` 与 `web/src/components/brand-mark.tsx` 存在，且不在两个拷入目录之下；对注入样本（`web/src/ui/card.tsx` 重新出现、一个文件写了 `import { Button } from "../../ui/index.js"`、一个文件导入 `useToast`）守卫各判失败

#### Scenario: 会话页迁移终态
- **WHEN** 列出 `web/src/features/chat` 下的全部文件，并列出 `web/src/components/assistant-ui` 下的组件文件
- **THEN** `web/src/features/chat` 下没有 `.css` 文件，也没有 `session-filter.tsx`；`web/src/components/assistant-ui` 下只有 `markdown-text`、`reasoning`、`tool-group` 三个组件、它们的 registry 依赖与 `styles.d.ts`，没有 `thread` 与 `tool-fallback`；对注入样本（该目录下出现一个 `.css`）守卫判失败

#### Scenario: 文件页整目录已迁移
- **WHEN** 扫描 `web/src/features/files`
- **THEN** 该目录下没有 `.css`，没有文件从 `web/src/ui` 导入；对注入样本（该目录下一个文件导入旧 `Dialog`、目录下出现一个 `.css`）守卫各判失败

### Requirement: 拷入层的门槛豁免
拷入层的两个目录 SHALL 豁免且只豁免以下门槛：单元测试覆盖率统计（`web/vitest.config.ts` 的 `coverage.exclude`，不改根 `vitest.shared.mjs`）、重复代码检测（`.jscpd.json` `ignore`）、单文件行数上限（`scripts/size-guard.sh` 内按这两个目录的路径前缀排除，带参数与无参数两种调用都生效）、Biome linter 规则（`biome.json` `overrides` 对这两个目录关闭 linter；格式化仍适用）、knip 的未使用导出报告（`knip.json` web workspace 的 `ignore`）。每处条目 SHALL 恰好指向 `web/src/components/ui` 与 `web/src/components/assistant-ui`，不使用能匹配应用层的通配；应用层的全部门槛不变——直接放在 `web/src/components/` 下的自写共享组件（`icon.tsx`、`brand-mark.tsx`）属于应用层，不在任何一处豁免之内。`constraints.yaml` 的 `exemptions.entries` SHALL 登记这两个目录及其豁免的规则与依据（ADR-0013）。`AGENTS.md` SHALL 在 Enforcement Index 的表格与其后的说明段之后、`Known blind spots` 小节之前以一行注记说明这项豁免。`ATTRIBUTION.md` SHALL 登记 Tailwind CSS、shadcn/ui、`radix-ui`（及保留的各 `@radix-ui/*` 包）与其许可证；assistant-ui 在其组件拷入时登记。为解析 Tailwind 4 的 at-rule，`biome.json` 顶层 SHALL 设 `css.parser.tailwindDirectives: true`（这是解析选项，不是豁免）。

#### Scenario: 豁免不外溢到应用层
- **WHEN** `make test-guardrails` 在仓库内临时创建并分别对 size-guard 传入：一个 801 行的 `web/src/features/_probe.tsx`；一个 801 行的 `web/src/components/ui/_probe.tsx`（用后删除）
- **THEN** 前者被拒绝，后者通过

#### Scenario: 豁免路径精确
- **WHEN** 守卫测试读取 `web/vitest.config.ts` 的 coverage 排除项、`.jscpd.json` 的 `ignore`、`scripts/size-guard.sh` 的排除前缀、`biome.json` 的 `overrides`、`knip.json` 的 web `ignore`、`constraints.yaml` 与 `AGENTS.md`
- **THEN** 每处为本 change 新增的条目都只匹配 `web/src/components/ui` 与 `web/src/components/assistant-ui` 之下的路径；`biome.json` 对这两个目录的 override 不关闭 formatter；`constraints.yaml` `exemptions.entries` 含这两个目录；`AGENTS.md` 在 `## Enforcement Index` 与 `### Known blind spots` 之间含一行同时提到这两个目录与 ADR-0013 的注记；这些条目都不匹配 `web/src/components/icon.tsx` 与 `web/src/components/brand-mark.tsx`，对注入样本（把 `src/components/**` 或 `src/components/icon.tsx` 写进任一处排除项）守卫判失败

#### Scenario: 归属登记完整
- **WHEN** 读取 `ATTRIBUTION.md` 与 `web/package.json`
- **THEN** `tailwindcss`、shadcn/ui、`radix-ui` 以及 `web/package.json` 中每个 `@radix-ui/*` 依赖都在 `ATTRIBUTION.md` 出现并带许可证
