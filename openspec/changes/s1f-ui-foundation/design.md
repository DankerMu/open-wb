# Design: s1f-ui-foundation

## Context

现状（均已核对）：

- `web` 是 React 19.2 + Vite 8，`tsconfig` 继承根 `tsconfig.base.json`（`module`/`moduleResolution` 为 NodeNext，import 带 `.js` 后缀，无 `paths`）。
- 样式：`web/src/styles.css`（全局 reset + `@import` 全部 `.css`）、`web/src/styles/tokens.css`（`--wb-*`，亮在 `:root`、暗在 `[data-theme="dark"]`，
  无圆角/间距/字号 token）、每个基元与页面各有 `.css`。`web/index.html` 以 `<link>` 引 `/src/styles.css`，并有首帧前主题内联脚本。
- 基元层 `web/src/ui/*`（Radix 单包只在这里导入）；`web/test/ui-guardrails.test.ts`、`ui-tokens.test.ts`、`ui-reduced-motion.test.ts` 是 UI 守卫的全部，
  `scripts/` 里没有 UI 规则。`ui-tokens.test.ts` 把 `tokens.css` 与 demo 逐值绑定。
- 外壳：`web/src/routes/{router.tsx,manifest.ts,shell/*}`、`web/src/lib/{topbar.tsx,sidebar-slot.tsx,viewport.ts}`、`web/src/features/auth/footer.tsx`；
  会话页经 `useTopbar` / `useSidebarSlot` / `useSidebarNavigate` 注入内容。登录在 `features/auth`，设置在 `features/settings` + `features/theme`。
- 门槛：覆盖率 80%（`vitest.shared.mjs`，`src/**/*.{ts,tsx}` 无排除）、jscpd 3%、size-guard 800 行、Biome（复杂度 ≤15）、knip。
- `make ui-shots` 不在 CI，但其 AGENTS.md 行、`constraints.yaml` surface、Makefile 目标/冻结块/`.PHONY` 都被 `scripts/test-ci-harness.sh` 的 oracle 钉住。

试验事实（2026-10-04，仓库外工程）：

- Tailwind 4 + shadcn（`radix-nova` 版式）+ `@assistant-ui/react` 0.15 在 React 19.2 / Vite 8 下安装、构建通过。
- 用仓库的 `tsc`（7.0.2）与本仓的严格选项（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）检查拷入的 shadcn 与 assistant-ui 组件：
  `moduleResolution: Bundler` + `paths` 零错误；`NodeNext` 下 `@/` 无扩展名导入全部 TS2307。

## Goals / Non-Goals

**Goals**

- 新旧页面在同一份样式表里并存，每个 PR 合入后主干可运行。
- 外壳、登录页、设置页迁到 shadcn/ui + Tailwind，行为契约不变。
- 守卫与门槛对应用层不放松，对拷入层的豁免路径精确。
- 界面验收从 demo 截图对换成功能清单，控制面（AGENTS / constraints / Makefile / oracle）保持一致。

**Non-Goals**

- 会话页、文件页、`/center`；删除旧基元与旧 `.css`；服务端；包体积；旧页面的观感修复。

## Decisions

### D1 模块解析：web 改用 Bundler + `@/` 别名

`web/tsconfig.json` 覆盖 `module: "ESNext"`、`moduleResolution: "Bundler"`，加 `paths: {"@/*": ["./src/*"]}`（相对 `web/`）。
`web/vite.config.ts` 加 `resolve.alias`（`@` → `web/src`）；`web/vitest.config.ts` 复用同一 alias；knip 读 tsconfig `paths`，如仍报未解析则在 `knip.json` 的 web workspace 加 `paths`。
既有带 `.js` 后缀的相对导入在 Bundler 下仍合法，不批量改写。拷入层与新写的应用层代码用 `@/` 导入，不带扩展名。
`server` 的 tsconfig 不动（根 base 不改）。
实现时补两项覆盖（#832）：`moduleDetection: "force"`——`module` 改 ESNext 后，无 import/export 的 `web/test/radix-platform.ts` 被判为脚本，对它的动态导入报 TS2306；
`skipLibCheck: true`（只在 `web/tsconfig.json`，owner 2026-10-04 接受）——`radix-ui` 合包入口带入的 `@radix-ui/react-select` 声明文件在 `exactOptionalPropertyTypes` 下报 TS2320，
错误在上游 `.d.ts`；代价是 web 的 typecheck 不再检查第三方声明文件，自有源码的严格选项不变。

备选「保留 NodeNext，把拷入代码的导入全改成带 `.js` 的相对路径」：每次从 registry 更新组件都要重改一遍，否决。

### D2 Tailwind 接入与层叠顺序

`web/src/styles.css` 改为：

```css
@layer theme, base, legacy, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css" layer(utilities);
@import "tw-animate-css";
@import "./styles/tokens.css";
@import "./styles/theme.css";
@import "./styles/legacy.css" layer(legacy);

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { /* 原样保留的全局块 */ } }
```

- 原 `styles.css` 的全局规则（全局 reduced-motion 块除外）与全部既有 `@import`（`ui/*`、shell、chat、files、auth、settings）移入新文件
  `web/src/styles/legacy.css`，整体进 `legacy` 层；`legacy.css` 内的 `@import` 不带 `layer()`。迁走外壳/登录/设置时从 `legacy.css` 删去它们的 `@import` 并删除对应 `.css`。
- 层序含义：未分层 > utilities > components > legacy > base > theme。旧页面在 `legacy` 的声明压过 preflight；新组件的 utilities 压过
  `legacy` 里的全局元素规则（`button { background: none }`、`input { border-radius: 8px }` 等）。
- **全局 reduced-motion 块留在 `styles.css`、不入层**：它没有 `!important`，进了 `legacy` 层就压不住 utilities 层里 `tw-animate-css` 与 `duration-*` 设的动画时长。
  留在原文件也使 `ui-reduced-motion.test.ts`「`styles.css` 恰有一个全局块」的断言不用改。
- Tailwind 的 `transition*` 工具类在 reduce 下由 `theme.css` 里一条未分层规则统一关掉：
  `@media (prefers-reduced-motion: reduce) { [class*="transition"] { transition: none; } }`。不逐个给拷入组件加 `motion-reduce:`（那会超出「五类修改」）。
  这条是「只有覆盖、没有声明」的 reduce 规则，现行 reduced-motion 静态守卫允许。
- `tokens.css` 与 `theme.css` 只定义自定义属性与上述未分层规则，不入层（唯一例外：D3 的边框色基线在 `base` 层）。
- preflight 会重置旧页面依赖浏览器默认值的地方（标题字号、列表符号、段落外边距等）。owner 接受过渡期的观感变化；功能由 `make ui-walk` 守住。
- Biome 2.5 默认把 `@theme`、`@custom-variant` 判为解析错误（「Tailwind-specific syntax is disabled」，formatter 也中止）；`biome.json` 顶层设
  `css.parser.tailwindDirectives: true` 后通过（评审时实测）。`@layer a, b;` 与 `@import … layer(x)` 本身不报错。
- knip 在依赖含 `tailwindcss` 时把 `.css` 纳入项目文件，而 `web/index.html` 的 `<link rel="stylesheet">` 不算入口：`knip.json` web `entry` 加 `src/styles.css`，
  使 `.css` 图与 `tailwindcss` / `tw-animate-css` 两个只在 CSS 里出现的依赖可达。若仍被报未使用，以 `ignoreDependencies` 精确列这两个包名（不用通配）。

### D3 主题映射

`web/src/styles/theme.css`：

- `:root { … }` 定义规格所列的语义变量。规格钉住七项（`--background`、`--foreground`、`--primary`、`--primary-foreground`、`--destructive`、`--border`、`--sidebar`）；
  其余由实现按同一原则选：表面取 `--wb-bg-*` / `--wb-home-bg-*`，文字取 `--wb-text-*`，边框取 `--wb-border-*` / `--wb-color-border-*`，
  hover/选中取 `--wb-bg-hover` / `--wb-bg-active`，侧栏组取 `--wb-sidebar-bg` 与文字/边框 token。
- `--primary` 沿用迁移前主按钮的取值（`web/src/ui/button.css`：浅色 `--wb-palette-black-90` 底 + `--wb-text-white` 字，深色 `--wb-palette-white-90` 底 +
  `--wb-palette-black-90` 字），所以本文件引用调色板 token，并有一个 `[data-theme="dark"] { --primary: …; --primary-foreground: …; }` 块。
  品牌绿（`--wb-brand-primary`）不是主按钮色，留给焦点环与强调（`--ring` 可取它，与现行 `:focus-visible` 一致）。
- `@theme inline { --color-background: var(--background); … --radius-lg: var(--radius); … }` 把语义变量暴露成 Tailwind 颜色与圆角刻度。
- `--radius: 0.5rem`（现有 CSS 最常用的 `8px`）；字号沿用 Tailwind 默认刻度；`body` 14px / 22px 行高不变。
- `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`
- `@custom-variant data-open (&:where([data-state="open"]));` 与 `data-closed`（#834，owner 2026-10-04 决定）：registry 组件的进出场动画写成 `data-open:` / `data-closed:`，
  这两个变体原本来自 shadcn 自带样式表，本仓入口不导入它，故在此绑定到 Radix 的 `data-state`。
- 边框色基线（#835 落地，owner 2026-10-04 决定）：`@layer base { *, ::before, ::after { border-color: var(--border); } }`——拷入组件里裸的 `border` 类否则取 `currentColor`；
  `legacy` 层优先级高于 `base`，旧页面自己声明的边框色不受影响。
- `body { background: var(--background); color: var(--foreground); }` 写在 `theme.css`（未分层），`legacy.css` 里 `body` 的同名声明删除。

### D4 组件分层与拷入

- `web/components.json`：`style: "radix-nova"`、`rsc: false`、`tsx: true`、`tailwind.css: "src/styles.css"`、`cssVariables: true`、
  aliases `components: "@/components"`、`ui: "@/components/ui"`、`utils: "@/lib/utils"`、`iconLibrary: "lucide"`。
- 拷入（`npx shadcn@latest add …`，只拷用到的）：本 change 预期 `button`、`input`、`label`、`card`、`dropdown-menu`、`alert-dialog`、`sheet`、`tooltip`、
  `radio-group`、`separator`。拷入后只做五类修改：颜色字面量换主题变量（若有）、中文化可见文案与 aria 文案、Biome 格式化（含其 import 排序）、`cn` 的导入归一到 `@/lib/utils`
  （`radix-nova` registry 现下发 `import { cn } from "cn"` 并让 CLI 安装 npm 包 `cn`；本仓不引入该依赖，每次 `shadcn add` 后卸掉它并改写导入——owner 2026-10-04 决定）、为本仓严格 TS 选项做的纯类型适配
  （registry 原文在 `exactOptionalPropertyTypes` 下报错处，如 `dropdown-menu` 的 `checked={checked}` 改为条件展开；不改运行时行为——owner 2026-10-04 决定，#834）。
  `web/src/lib/utils.ts` 提供 `cn`。`shadcn` 命令会改写 `styles.css`——以 D2/D3 的结构为准，命令写入的默认主题块不保留。
- 侧栏不拷 shadcn 的 `sidebar` 整块：它自带 cookie 持久化、键盘快捷键与 768 断点，与现有契约（`workbuddy-sidebar` localStorage、760 断点、
  `data-collapsed`、槽位）不一致，改造成本高于用 `sheet` + `tooltip` + Tailwind 自己排。
- `Icon`、`IconName`、`BrandMark` 留在冻结区 `web/src/ui`（应用自有、与 demo 无关），搬家留给收尾 change。已迁移区域从 `web/src/ui/index.js` 只可导入这三个名字与
  `useEscapeFallback`（D7）。顶栏 actions 描述符的 `icon` 仍是 `IconName`，会话页的调用方不改。

### D5 拷入层门槛豁免

| 门槛 | 配置处 | 新增条目 |
|---|---|---|
| 覆盖率 | `web/vitest.config.ts` 的 `coverage.exclude`（不改根 `vitest.shared.mjs`，server 不受影响） | `src/components/ui/**`、`src/components/assistant-ui/**` |
| jscpd | `.jscpd.json` `ignore` | `web/src/components/ui/**`、`web/src/components/assistant-ui/**` |
| size-guard | `scripts/size-guard.sh`：在逐文件循环里按路径前缀跳过这两个目录（含带 `./` 前缀的写法），带参数（pre-commit 传暂存文件）与无参数（全量扫描）共用同一循环；Bash 3.2 兼容 | 两个目录前缀 |
| Biome linter | `biome.json` `overrides`：这两个目录 `linter.enabled: false`，formatter 不关 | 同上两个目录 |
| knip | `knip.json` web workspace `ignore` | 同上两个目录 |

- `.large-file-guard.json` 没有任何消费者（`size-guard.sh` 不读配置），不用它。
- `constraints.yaml` `exemptions.entries` 登记两个目录（rules 取 `size_limits`、`anti_drift`、`testing` 中对应的项；reason 指向 ADR-0013；`expires: never`）。
- `scripts/test-guardrails.sh` 增两例：在仓库内临时写 801 行的 `web/src/features/_probe.tsx` 与 `web/src/components/ui/_probe.tsx`，分别以相对路径传给 `size-guard.sh`，
  前者拒绝、后者通过，`trap` 清理（现有用例用 `$tmp` 路径，命中不了前缀规则）。
- `AGENTS.md`：Enforcement Index 的表格与「阈值与正则…」说明段被 `scripts/test-ci-harness.sh` 以整段逐字文本为锚，注记必须写在该说明段之后、
  `### Known blind spots` 之前，不进锚内。
- 新增守卫测试读上述五处配置，断言新增条目只匹配两个拷入目录、Biome override 未关 formatter（规格「豁免路径精确」）。

### D6 守卫改写

`web/test/ui-guardrails.test.ts`：

- 保留并扩展：颜色字面量与 `--wb-palette-` 扫描——范围为 features/routes 的 `.css`、`.tsx` 与**去注释后的** `.ts`（`web/test/ui-support.ts` 的 `stripComments` 只剥 `/* */`，为 `.ts` 另加剥 `//` 行注释的步骤；
  `features/chat/stream-steps.ts:44` 行注释里的 `（#367）` 不得命中，不改该文件）；Radix 导入扫描——范围改为 `web/src` 下除两个拷入目录与 `web/src/ui` 之外的全部 `.ts`/`.tsx`，
  匹配 `@radix-ui/` 与 `radix-ui`；`ATTRIBUTION.md` 登记检查加 `radix-ui`、`tailwindcss`、shadcn/ui。
- 新增：入口结构（规格「入口结构不可缺失或重排」）；`theme.css` 结构（规格「映射文件结构」）；已迁移区域清单与冻结区清单及其注入样本自证；豁免路径精确。
  已迁移区域清单在引入时为空，组 3/4/5 各自把目录加入。
- 「`web/src` 不再出现 `ui-button`」等其余既有断言不动。

`web/test/ui-tokens.test.ts`：删除 demo 逐值相等与名集合断言；`it.each` 里针对 `styles.css` 的 `body` / `.app-shell` / `.app-content > main` 底色断言删除
（`body` 底色改由 ui-walk 计算样式断言），针对 `files.css` 的两行保留到文件页 change；保留「引用的 `var(--wb-*)` 都有定义」「无公网字体」。

读 `styles.css` 的既有断言随内容搬家改指 `legacy.css`（组 1a 一并处理，它们在搬家那一刻就会红）：

| 测试 | 现断言 | 处理 |
|---|---|---|
| `web/test/chat-steps.test.tsx:145-149` | `styles.css` 含 `chat.css`、`messages.css` 的 `@import` 且有序 | 改读 `legacy.css` |
| `web/test/app-shell-responsive.test.tsx:551-554` | `styles.css` 的 `@media (max-width: 760px)` 块 | 改读 `legacy.css` |
| `web/test/topbar.test.tsx:277-278` | `styles.css` 含 `.app-content > main` | 改读 `legacy.css` |
| `web/test/sidebar.test.tsx:410-413` | `styles.css` 含 `routes/shell/sidebar.css` | 改读 `legacy.css` |
| `web/test/login-form.test.tsx:279-280` | `styles.css` 含 `auth.css` 的 `@import` | 改读 `legacy.css` |
| `web/test/settings-page.test.tsx:414,424` | `styles.css` 含 `settings.css` 的 `@import` | 改读 `legacy.css` |
| `web/test/ui-reduced-motion.test.ts:136-137` | `styles.css` 恰有一个全局 reduce 块 | 不改（块留在 `styles.css`） |

后四行中属于外壳/登录/设置的断言在各自页面迁移时（组 3/4/5）随 `.css` 删除而删除。旧基元的测试（`web/test/ui-*.test.tsx`）不动——旧基元仍被会话页与文件页使用；
唯一例外是 `ui-toast-drawer-escape.test.tsx`，它挂载整个应用，见 D7。

### D7 外壳重写

行为契约不变（spa-shell「路由 IA 与侧栏」「退出失败提示可关闭」、ui-primitives「Escape 分派不受 Toast 层栈影响」与「基元组件库」的退出确认场景），实现换成 Tailwind + 拷入层：

- `routes/shell/app-shell.tsx`、`sidebar.tsx`、`topbar.tsx` 重写；`sidebar.css`、`topbar.css` 删除。窄屏覆盖层用 `sheet`（`side="left"`，对话框 accessible name `导航`）。
- `lib/topbar.tsx`、`lib/sidebar-slot.tsx`、`lib/viewport.ts` 的导出与语义不变（会话页是它们的调用方，本 change 不改会话页实现）。
- `features/auth/footer.tsx`（用户菜单 + 退出确认）重写：菜单用 `dropdown-menu`，确认框用 `alert-dialog`。忙碌态、`关闭` 文案、失败提示与 `关闭提示`、
  覆盖层重开不丢锁定态、初始焦点在取消按钮、关闭时按触发器是否禁用把焦点归还到触发器或 `aside` 内 `a[aria-current=page]`（`onCloseAutoFocus` 在应用层实现）不变。
  **忙碌期焦点救回**：旧实现靠 `web/src/ui/dialog.tsx:68-81` 的 `useBusyFocusRescue`（冻结区内、未导出）。`footer.tsx` 在应用层用一个 effect 重现同一行为——
  `pending` 上升沿时若活动元素在确认框内且被禁用，或活动元素为 `document.body`/空，把焦点移到取消按钮（与旧 hook 的判定相同）；`web/e2e/ui-walk.spec.ts:154-160` 的既有断言原样通过即为证据。
- **Escape 兜底**（#643）：Toast 仍是旧实现（`@radix-ui/react-toast`），它的层会让导航覆盖层与确认框收不到 Escape。`web/src/ui/index.ts` 增加导出 `useEscapeFallback`
  （冻结区唯一允许的内容变更），外壳把它返回的 `ref` / `onEscapeKeyDown` / `onKeyDown` 经 props 传给 `SheetContent` 与 `AlertDialogContent`（Radix Content 透传这些 props，不改拷入代码）。
  `radix-ui` 合包与旧 `@radix-ui/*` 单包是否共用同一份 DismissableLayer 要等 lockfile 生成才知道；两种情况下兜底都成立（它不依赖层栈），
  `web/test/ui-toast-drawer-escape.test.tsx` 的行为断言原样通过即为证据。
- **会话页与文件页对外壳的依赖必须保留**：
  - `aside` 保留类 `sidebar` 与 `data-variant="inline|overlay"`——`features/chat/chat.css:102` 的 `.sidebar[data-variant="overlay"] .chat-session-groups` 靠它决定覆盖层内列表的滚动方式
    （`web/test/chat-page-sidebar.test.tsx:761` 钉着这条规则）。
  - 主区布局契约：`main` 是纵向 flex 容器、`min-height: 0`、`overflow: hidden`，直接子元素撑满（现 `styles.css` 的 `.app-content`、`.app-content > main`、`.app-content > main > *`
    与 760 断点下的对应规则）。`.chat-page` / `.files-page` 靠它撑满并各自滚动。实现以 Tailwind 类等价重现后删除这些旧规则；ui-walk 的滚动与布局用例原样通过即为证据。
  - `legacy.css` 中 `ui-alert`、`ui-muted`、`ui-empty`、`ui-sr-only` 等仍被会话页/文件页使用的全局类不删。
- 选择器迁移：actions 容器从类 `.topbar-actions` 改为 `data-slot="topbar-actions"`；侧栏宽度断言（`web/e2e/ui-walk-layout.ts:30-41` 的 48/288）改为 `data-collapsed`；
  `.sidebar-link`、`header.topbar h1` 改为角色/名称。受影响且不在外壳测试清单里的会话页测试只改选择器、不改断言含义：
  `web/test/chat-page-project-config.test.tsx:177`（`closest(".topbar-actions")`）、`web/test/chat-page-welcome-scene.test.tsx:91,649`（字面 `<span class="sidebar-user-account">`）。
- 会话页注入侧栏槽位的内容仍是旧样式（在 `legacy` 层），与新侧栏并排——过渡期可接受。
- 必须保留的可访问名与属性：`aside[aria-label="侧栏"]`、`nav[aria-label="主导航"]`、`打开导航`、`折叠侧栏`/`展开侧栏`、`用户菜单`、`退出登录？`、`关闭提示`、
  `dialog` 名 `导航`、`data-collapsed`、`aria-current="page"`、`localStorage` key `workbuddy-sidebar`。

### D8 登录页重写

`features/auth/login-form.tsx`、`quick-login.tsx` 重写为 `card` + `input` + `label` + `button`；`auth.css` 删除。行为不变（spa-shell「登录页与路由守卫」
「登录表单在 StrictMode 下失败后可重试」）：字段名/placeholder/autocomplete、自动聚焦、错误行 `role="alert"`、`正在登录`、快捷登录只在 dev-stub 下出现、
匿名 info 读取不占 Provider 单槽。`provider.tsx`、`guard.tsx`、`dev-accounts.ts` 不改逻辑。

### D9 设置页重写

`features/settings/page.tsx` 重写为 `card` + `radio-group`（Radix RadioGroup：根 `role="radiogroup"`、项 `role="radio"`、再点已选项不取消选中、方向键移动即选中——
与旧 `SegmentedControl` 同一基元，既有 `getByRole("radiogroup", { name: "主题" })` 断言原样通过），在应用层用 Tailwind 排成分段样式；`settings.css` 删除。
不用 `toggle-group`：它的根是 `role="group"`，`type="single"` 时再点已选项会清空选择。
`features/theme/provider.tsx` 与 `lib/theme.ts` 不改。`当前生效：浅色|深色` 的可访问文本保留（Tailwind 的 `sr-only`）。

### D10 demo 一致性 harness 退役与功能验收清单

同一 PR 内原子完成（oracle 逐字钉住这些镜像，分开改必红）：

- 删除 `web/e2e/ui-shots.mjs`、`web/package.json` 的 `ui-shots` 脚本、Makefile 的 `ui-shots` 目标 / `UI_SHOTS_*` 块 / `.PHONY` 项 / 页头注释句。
- `constraints.yaml` `verification.surfaces` 去掉 `ui-shots`（十一 → 十）。
- `AGENTS.md`：Verification Matrix 去掉「demo 一致性截图对」行，Enforcement Index 去掉对应行；在豁免注记旁加一行指向功能验收清单的注记（同样在锚外）；
  「demo 文件头的来源注释在编辑时必须保留」保留（demo 文件仍在）。
- `scripts/test-ci-harness.sh`：内嵌 oracle 的矩阵行、enforcement 行、surface 元组、wanted 表、页头、safe_overrides、targets 集合与 `.PHONY`、freeze_block 与 recipes 八类断言，
  以及 `:144-145` 的整段锚与 `:155-174` 一带全部含 `ui-shots` 的突变用例同步去掉 `ui-shots`；新增断言「`web/package.json` 无 `ui-shots` 脚本」与突变用例「重新加入 `ui-shots` surface / target / AGENTS 行被拒」。
- 新增 `docs/acceptance/functional-checklist.md`：文件头（运行方式、签收规则）+ 分节骨架；新增其格式守卫测试（`web/test`，读仓库文件，含注入样本自证）。
  外壳/登录/设置的行由各自的迁移任务加入。
- `docs/acceptance/demo-parity-checklist.md`、`docs/reviews/2026-09-24-demo-parity-audit.md`、ADR-0011 与 `IMPLEMENTATION_PLAN.md` 里对 `ui-shots` 的既有提及是历史记录，不改。

### D11 落刀次序

线性链 1a → 1b → 2 → 3 → 4 → 5。串行的原因是共享文件，不全是逻辑依赖：`AGENTS.md` 与 `web/package.json`（1b、2）；守卫的已迁移区域清单、
`docs/acceptance/functional-checklist.md` 与 `web/e2e/ui-walk-layout.ts` 的同一个主题探针函数（3、4、5）；`features/auth/footer.tsx` 属组 3 而 `features/auth/**` 整目录在组 4 登记（4 依赖 3）。

- 1a：Tailwind + 层叠 + `legacy.css` + `theme.css`（只动样式入口与读它的测试；不改任何 JSX）。
- 1b：Bundler + 别名 + `components.json` + 首个拷入组件 + 豁免 + 分层守卫。
- 2：harness 退役 + 功能清单骨架与格式守卫。
- 3：外壳。4：登录页。5：设置页。

## Sketch seams under test

- **层叠顺序**：登录页主按钮的计算底色等于 `--primary`（utilities > legacy）；`/files` 上旧 `ui-btn` 的 `padding-left` 非 0（legacy > preflight）。真实浏览器（ui-walk），jsdom 证明不了。
- **配色不换**：浅色下主按钮计算底色为 `rgba(0, 0, 0, 0.9)`；亮/暗 `body` 底色为 `rgb(255, 255, 255)` / `rgb(20, 20, 20)`。
- **别名四处一致**：`@/…` 导入在 `make typecheck`、`vitest`、`knip`（1b：测试渲染 `@/components/ui/button`）与 `vite build`（组 3 起应用层模块经别名导入拷入组件）下都解析。
- **`dark:` 绑定 `data-theme`** 与首帧前主题：`theme.css` 的 `@custom-variant` 静态断言；首帧前主题的 ui-walk 用例（`MutationObserver` 顺序）保持通过。
- **reduced-motion**：reduce 下打开的菜单/覆盖层内容 `animation-duration` ≤ `0.01ms`、带 `transition*` 类的按钮 `transition-property` 为 `none`；切主题时继承色即时生效（既有用例，定位改为角色）。
- **豁免不外溢**：`make test-guardrails` 的两例与读配置的守卫测试。
- **外壳槽位与布局契约**：未改动的会话页经 `useTopbar` / `useSidebarSlot` 注入的内容仍出现；会话页/文件页在新 `main` 内撑满并滚动（ui-walk 滚动与布局用例）。
- **Escape 兜底**：Toast 在场时 Escape 仍关闭导航覆盖层与退出确认（`ui-toast-drawer-escape.test.tsx` 原样通过）。
- **退出流程的锁定态**：挂起退出请求时关闭并重开窄屏覆盖层，确认按钮仍忙碌禁用（既有场景）。
- **控制面 oracle**：`make test-guardrails` 在 `ui-shots` 镜像全部移除后通过，重新加入任一镜像被拒。

## Risks / Trade-offs

- **preflight 改变旧页面观感**：接受（owner）；若 `make ui-walk` 的功能断言因此失败，在 `legacy.css` 补最小规则修复功能，不追观感。
- **`[class*="transition"]` 选择器较宽**：reduce 下任何类名含 `transition` 的元素都失去过渡。这正是意图；旧 `.css` 没有以 `transition` 命名的类。
- **拷入层代码质量不受门槛约束**：只拷用到的组件；其行为由 ui-walk 与应用层测试间接覆盖。
- **测试改写量**：外壳/登录/设置的测试里读源码与 `.css` 的断言要删或改；行为断言（角色/名称）原样通过是「行为不变」的证据，不得为通过而放宽。
- **两套组件并存期**：直到文件页 change 收尾；冻结区与已迁移区域守卫防止回流。
- **组 1a / 3 的 diff 会超过 400 行评审线**（review-only）：样式整体搬家与外壳整体替换无法更小；PR 描述标明哪些是纯搬移。

## Migration Plan

每个任务组一个 PR，按 D11 的线性次序合入，合入后主干可运行；revert 按逆序。无数据迁移、无服务端变更、无部署步骤变化。

## Not yet specified

- 规格钉住的七项之外，其余 shadcn 语义变量具体对应哪个 `--wb-*`（原则见 D3；实现时对着亮/暗两套实际渲染定，PR 描述里列表，owner 在功能验收时看整体观感）。
- 旧页面在 preflight 下具体会出现哪些观感变化（不修），以及其中是否有会让 ui-walk 功能断言失败、需要在 `legacy.css` 补最小规则的。
- `radix-ui` 合包与旧 `@radix-ui/*` 单包是否解析出同一份 DismissableLayer（lockfile 生成后才知道；不影响 Escape 兜底的成立）。

## Open Questions

无阻塞项。
