## MODIFIED Requirements

### Requirement: Tailwind 入口与层叠顺序
`web/src/styles.css` SHALL 是唯一样式入口（`web/index.html` 的 `<link>` 不变），其第一条规则 SHALL 是层声明 `@layer theme, base, legacy, components, utilities;`。Tailwind 的 theme、preflight、utilities SHALL 分别导入到 `theme`、`base`、`utilities` 层。迁移前既有的样式（原 `styles.css` 的全局规则——全局 reduced-motion 块除外——以及 `web/src/ui/*.css`、尚未迁移的 feature 与 routes 的 `.css`）SHALL 集中在 `web/src/styles/legacy.css`，并由 `styles.css` 以 `@import "./styles/legacy.css" layer(legacy);` 导入；`styles.css` 中除 Tailwind 三段、`tw-animate-css`、`tw-shimmer`（拷入的 assistant-ui 组件给「进行中」标题用的流光类；owner 2026-10-05 决定启用）、`./styles/tokens.css`、`./styles/theme.css` 与这一条之外 SHALL 没有其它 `@import`，既有 `.css` SHALL 只被 `legacy.css` 直接导入，或经冻结区的 `web/src/ui/ui.css` 传递导入。`tokens.css`、`theme.css` 与全局 reduced-motion 块不入层；唯一例外是 `theme.css` 里的边框色基线 `@layer base { *, ::before, ::after { border-color: var(--border); } }`（拷入组件里不带颜色类的边框取 `--border` 而非 `currentColor`；在 `base` 层，低于 `legacy`，旧页面自己声明的边框色不受影响）。由此：未分层规则压过 utilities，utilities 压过 `legacy`，`legacy` 压过 preflight。已迁移区域的样式 SHALL 只用 Tailwind 类与主题变量（`Icon`、`BrandMark` 自带的 `ui-*` 类除外，它们的规则留在 `legacy` 层），不再新增 `.css` 文件。尚未迁移的页面在 preflight 生效后 SHALL 保持功能可用（`make ui-walk` 全绿）；它们因 preflight 产生的观感变化不修复。

#### Scenario: utilities 压过旧全局规则
- **WHEN** `make ui-walk` 打开登录页，读取主按钮 `登录` 的计算 `background-color`
- **THEN** 它等于 `--primary` 的计算值，不是透明（旧全局规则 `button { background: none }` 在 `legacy` 层，被 utilities 压过）

#### Scenario: 旧页面规则压过 preflight
- **WHEN** `make ui-walk` 打开 `/files`（尚未迁移），读取主区（`main`）内第一个旧基元按钮（类 `ui-btn`）的计算 `padding-left`（外壳的图标按钮自身即 `padding: 0`，证明不了层序）
- **THEN** 它不是 `0px`（`button.css` 的声明在 `legacy` 层，压过 preflight 的 `padding: 0`）；该场景在 `legacy` 层整体移除时（change `s1f-files-page` 收尾）随之删除

#### Scenario: 入口结构不可缺失或重排
- **WHEN** 静态读取 `web/src/styles.css` 与 `web/src/styles/legacy.css`
- **THEN** `styles.css` 的第一条规则是 `@layer theme, base, legacy, components, utilities;`；它对 `./styles/legacy.css` 的导入带 `layer(legacy)`，对 `tokens.css` 与 `theme.css` 的导入不带 `layer(...)`，此外只有 Tailwind 三段、`tw-animate-css` 与 `tw-shimmer` 的导入；`web/src` 下其它既有 `.css` 只被 `legacy.css` 直接导入或经 `web/src/ui/ui.css` 传递导入

### Requirement: 组件分层
web SHALL 采用两层加一个冻结区：`web/src/components/ui/`（由 shadcn/ui registry 拷入的组件，Radix 版式）与 `web/src/components/assistant-ui/`（由 assistant-ui registry 拷入的组件）是**拷入层**；`web/src` 下除拷入层与 `web/src/ui/` 之外的全部 `.ts`/`.tsx`（features、routes、lib、入口）是**应用层**；`web/src/ui/` 是迁移期间的**冻结区**。`web/components.json` SHALL 入库并记录 registry 配置（Radix 版式 style、别名指向 `@/components`、`@/components/ui`、`@/lib/utils`，以及把 registry 的 hooks 落到拷入层的 `@/components/assistant-ui/hooks`）。`radix-ui` 与 `@radix-ui/*` 只能在拷入层与冻结区中导入；`lucide-react` 可在拷入层与应用层直接导入。自 s1f-chat-surface 起 `web/src/components/assistant-ui/`（`components.json` 产生的 registry 落点）只含 assistant-ui registry 的 `markdown-text`、`reasoning`、`tool-group` 三个组件与它们的 registry 依赖（例如 `tooltip-icon-button`、`use-copy-to-clipboard`），外加一个只声明样式模块类型的 `styles.d.ts`，各在首次用到它的改动里拷入；它们依赖的 shadcn/ui 组件（`collapsible` 等，不含 `avatar`）拷入 `web/src/components/ui/`；registry 的 `thread` 与 `tool-fallback` SHALL NOT 拷入。拷入的组件需要的 npm 包（例如 `tw-shimmer`）随该组件一起加入依赖并登记到 `ATTRIBUTION.md`。它们与 shadcn/ui 组件适用同一组修改限制。会话页的线程、消息、步骤卡、停靠区与输入框是应用层组件（`web/src/features/chat/` 内），直接由 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合，并组合上述三个拷入组件；全部行为定制（链接惰性、图片显示为 alt 文本、块次序、失败自动展开、不提供编辑/分支/附件 UI）SHALL 在应用层实现（例如经 `markdown-text` 的 `components` 覆盖、组合 `tool-group` / `reasoning` 的 Root/Trigger/Content），拷入文件只受下述六类修改。拷入后的组件只允许六类修改：把颜色字面量换成主题变量、中文化可见文案与 aria 文案、按 Biome 格式化、把 `cn` 的导入归一到 `@/lib/utils`（不引入 npm 包 `cn`）、为本仓严格 TS 选项做纯类型适配（不改运行时行为）、把被 registry 原文丢弃的调用方 `children` 或属性原样透传给它包着的底层基元（只增不改：拷入文件只转发调用方给的值，不写默认值，调用方不传时行为与原文一致）。冻结区 SHALL 不新增文件，其文件名集合 SHALL 是守卫测试内所列清单（本 change 开始时的 32 个文件）的子集；唯一允许的内容变更是在 `index.ts` 增加 `useEscapeFallback` 的导出。**已迁移区域**由守卫测试内的一份清单定义，条目按路径前缀匹配，可以是目录或单个文件，清单内容被守卫硬断言（s1f-ui-foundation 结束时为 `web/src/routes/**`、`web/src/features/auth/**`、`web/src/features/settings/**`、`web/src/features/theme/**`）：清单内的文件从 `web/src/ui` 只可导入 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`，且清单内的目录下不存在 `.css` 文件。会话页按文件逐个登记：`web/src/features/chat/` 下的一个文件不再从 `web/src/ui` 导入上述四项之外的名字、且不依赖旧类名时，SHALL 在同一个改动里把它的路径加进清单并更新守卫的清单断言；目录 `web/src/features/chat` 本身 SHALL NOT 登记，只要会话列表的文件（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、`rename-dialog.tsx`、`delete-dialog.tsx`）仍是旧实现；未登记的文件导入 `web/src/ui` 仍然合法。导入白名单不变，因此已登记的文件 MUST NOT 导入 `useToast`（会话页的轻提示退场由这份清单机械保证）。**本 change 的终态**：s1f-chat-surface 完成时，`web/src/features/chat` 下除上述八个会话列表文件之外的每个 `.ts`/`.tsx` 文件 SHALL 都在已迁移清单里，且该目录下剩下的 `.css` 文件 SHALL 只有 `chat.css`；守卫测试 SHALL 断言这一终态。

#### Scenario: 应用层不直接引 Radix
- **WHEN** 扫描 `web/src` 下除 `components/ui`、`components/assistant-ui` 与 `ui` 之外的全部 `.ts`/`.tsx`
- **THEN** 没有文件静态或动态导入 `radix-ui` 或 `@radix-ui/*`

#### Scenario: 已迁移区域不回用旧基元，冻结区不增长
- **WHEN** 扫描守卫清单内的目录与文件，并列出 `web/src/ui` 的文件
- **THEN** 清单内的文件（含逐个登记的会话页文件）从 `web/src/ui` 的导入只出现 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`；清单内的目录下没有 `.css` 文件；清单不含目录 `web/src/features/chat` 本身；`web/src/ui` 的每个文件名都在守卫的冻结清单里；对注入样本（清单内文件导入 `Button`、清单内文件导入 `useToast`、清单内出现 `.css`、冻结区多出一个文件）守卫各判失败

#### Scenario: 会话页迁移终态
- **WHEN** s1f-chat-surface 完成后列出 `web/src/features/chat` 下的全部文件，并列出 `web/src/components/assistant-ui` 下的组件文件
- **THEN** 该目录下除 `session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、`rename-dialog.tsx`、`delete-dialog.tsx` 之外的每个 `.ts`/`.tsx` 文件都在守卫的已迁移清单里，该目录下唯一的 `.css` 文件是 `chat.css`；`web/src/components/assistant-ui` 下只有 `markdown-text`、`reasoning`、`tool-group` 三个组件、它们的 registry 依赖与 `styles.d.ts`，没有 `thread` 与 `tool-fallback`；对注入样本（一个未登记的非会话列表文件、目录下多出一个 `.css`）守卫各判失败
