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
```

- 原 `styles.css` 的全局规则与全部既有 `@import`（`ui/*`、shell、chat、files、auth、settings）移入新文件 `web/src/styles/legacy.css`，整体进 `legacy` 层。
  本 change 迁走外壳/登录/设置后，从 `legacy.css` 删去它们的 `@import` 并删除对应 `.css` 文件。
- 层序含义：未分层规则 > utilities > components > legacy > base > theme。旧页面只声明在 `legacy` 的属性压过 preflight；
  新组件的 utilities 压过 `legacy` 里的全局元素规则（如 `button { background: none }`、`input { border-radius: 8px }`）。
- `tokens.css` 与 `theme.css` 只定义自定义属性，不入层。
- preflight 会重置旧页面依赖浏览器默认值的地方（标题字号、列表符号、段落外边距等）。owner 接受过渡期的观感变化；功能由 `make ui-walk` 守住。
- `legacy.css` 里的全局 `:focus-visible`、滚动条、`::selection`、reduced-motion 规则对新页面仍生效（未被 utilities 覆盖的属性），这是有意保留的一致性。

### D3 主题映射

`web/src/styles/theme.css`：

- `:root { --background: var(--wb-home-bg-secondary); --foreground: var(--wb-text-primary); --primary: var(--wb-brand-primary); … }`，
  每个 shadcn 语义变量指向一个 `--wb-*` 语义 token；因为 `--wb-*` 自己在 `[data-theme="dark"]` 下换值，这里不需要第二块。
  具体对应表由实现在本文件内给出并在 PR 描述里列出，原则：表面取 `--wb-bg-*` / `--wb-home-bg-*`，文字取 `--wb-text-*`，边框取 `--wb-border-*`，
  强调取 `--wb-brand-*`，危险取 `--wb-status-error*`，侧栏组取 `--wb-sidebar-bg` 等。`--primary-foreground` 须在亮/暗下都与 `--primary` 有足够对比
  （现行按钮：亮色白字、暗色深字——沿用 `web/src/ui/button.css` 的取值来源）。
- `@theme inline { --color-background: var(--background); … --radius-lg: var(--radius); … }` 把语义变量暴露成 Tailwind 颜色与圆角刻度。
- `--radius: 0.5rem`（现有 CSS 最常用的 `8px`）；字号沿用 Tailwind 默认刻度，`body` 14px / 22px 行高与现状一致。
- `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`
- `body { background: var(--background); color: var(--foreground); }` 写在 `theme.css`（未分层），取代 `legacy` 里 `body` 的同名声明。

### D4 组件分层与拷入

- `web/components.json`：`style: "radix-nova"`、`rsc: false`、`tsx: true`、`tailwind.css: "src/styles.css"`、`cssVariables: true`、
  aliases `components: "@/components"`、`ui: "@/components/ui"`、`utils: "@/lib/utils"`、`iconLibrary: "lucide"`。
- 拷入（`npx shadcn@latest add …`，只拷用到的）：本 change 预期 `button`、`input`、`label`、`card`、`dropdown-menu`、`alert-dialog`、`sheet`、`tooltip`、
  `toggle-group`（主题分段）、`separator`。拷入后只做三类修改：把颜色字面量换成主题变量（若有）、中文化可见文案与 aria 文案、按 Biome 格式化。
  `web/src/lib/utils.ts` 提供 `cn`。`shadcn` 命令会改写 `styles.css`——以 D2/D3 的结构为准，命令写入的默认主题块不保留。
- 侧栏不拷 shadcn 的 `sidebar` 整块：它自带 cookie 持久化、键盘快捷键与 768 断点，与现有契约（`workbuddy-sidebar` localStorage、760 断点、
  `data-collapsed`、槽位）不一致，改造成本高于用 `sheet` + `tooltip` + Tailwind 自己排。
- `Icon`、`IconName`、`BrandMark` 留在 `web/src/ui`（应用自有、与 demo 无关），已迁移区域只允许从 `web/src/ui/index.js` 导入这三个名字；
  搬家留给收尾 change。顶栏 actions 描述符的 `icon` 仍是 `IconName`，会话页的调用方不改。

### D5 拷入层门槛豁免

| 门槛 | 配置处 | 新增条目 |
|---|---|---|
| 覆盖率 | `web/vitest.config.ts` 的 `coverage.exclude`（不改根 `vitest.shared.mjs`，server 不受影响） | `src/components/ui/**`、`src/components/assistant-ui/**` |
| jscpd | `.jscpd.json` `ignore` | `web/src/components/ui/**`、`web/src/components/assistant-ui/**` |
| size-guard | `.large-file-guard.json` `exclude` | `web/src/components/ui/*`、`web/src/components/assistant-ui/*`（按该文件既有的 glob 语义，含子目录） |
| Biome linter | `biome.json` `overrides`：这两个目录 `linter.enabled: false`，formatter 不关 | 同上两个目录 |
| knip | `knip.json` web workspace `ignore`（只忽略未使用导出的来源文件，不影响应用层的未使用检测） | 同上两个目录 |

`scripts/test-guardrails.sh` 增两例自证：应用层 801 行文件仍被拒、拷入层 801 行文件通过。`AGENTS.md` Enforcement Index 下加一行注记（不新增表格行——表格行被 oracle 逐字钉住）。

### D6 守卫改写（`web/test/ui-guardrails.test.ts`、`ui-tokens.test.ts`）

- 保留：features/routes 无颜色字面量与 `--wb-palette-`（扫描范围加 `.ts`/`.tsx` 的类名字符串，正则不变即可命中 `bg-[#fff]`）；
  应用层不导入 `@radix-ui/*`，并加 `radix-ui`；`ATTRIBUTION.md` 登记每个 `@radix-ui/*`，并加 `radix-ui`、`tailwindcss`、shadcn/ui。
- 新增：`styles.css` 首条规则是层声明、既有样式的 import 都在 `legacy.css` 且 `legacy.css` 以 `layer(legacy)` 导入；`theme.css` 无颜色字面量；
  已迁移区域（routes、features/auth、features/settings、features/theme）从 `web/src/ui` 只导入 `Icon`/`IconName`/`BrandMark` 且无 `.css` 文件；
  `web/src/ui` 文件集合 ⊆ 迁移前快照（快照写在测试里）。
- 删除：`ui-tokens.test.ts` 的 demo 逐值相等与名集合断言、`body`/`.app-shell` 底色的源码断言（改由 ui-walk 的计算样式断言）；
  保留「引用的 `var(--wb-*)` 都有定义」「无公网字体」。
- 旧基元的测试（`web/test/ui-*.test.tsx`）与 `ui-reduced-motion.test.ts` 不动——旧基元仍被会话页与文件页使用。

### D7 外壳重写

行为契约不变（spa-shell「路由 IA 与侧栏」「退出失败提示可关闭」全部场景），实现换成 Tailwind + 拷入层：

- `routes/shell/app-shell.tsx`、`sidebar.tsx`、`topbar.tsx` 重写；`sidebar.css`、`topbar.css` 删除。窄屏覆盖层用 `sheet`（`side="left"`，对话框 accessible name `导航`）。
- `lib/topbar.tsx`、`lib/sidebar-slot.tsx`、`lib/viewport.ts` 的导出与语义不变（会话页是它们的调用方，本 change 不改会话页）。
- actions 容器从类 `.topbar-actions` 改为 `data-slot="topbar-actions"`；`ui-walk` 与测试里用到该类、`.sidebar-link`、`header.topbar h1` 的选择器改为角色/名称或 `data-slot`。
- `features/auth/footer.tsx`（用户菜单 + 退出确认）重写：菜单用 `dropdown-menu`，确认框用 `alert-dialog`；忙碌态、`关闭` 文案、失败提示与 `关闭提示`、
  覆盖层重开不丢锁定态的行为不变。
- 会话页注入侧栏槽位的内容仍是旧样式（在 `legacy` 层），与新侧栏并排——过渡期可接受。
- 必须保留的可访问名与属性：`aside[aria-label="侧栏"]`、`nav[aria-label="主导航"]`、`打开导航`、`折叠侧栏`/`展开侧栏`、`用户菜单`、`退出登录？`、`关闭提示`、
  `dialog` 名 `导航`、`data-collapsed`、`aria-current="page"`、`localStorage` key `workbuddy-sidebar`。

### D8 登录页重写

`features/auth/login-form.tsx`、`quick-login.tsx` 重写为 `card` + `input` + `label` + `button`；`auth.css` 删除。行为不变（spa-shell「登录页与路由守卫」
「登录表单在 StrictMode 下失败后可重试」）：字段名/placeholder/autocomplete、自动聚焦、错误行 `role="alert"`、`正在登录`、快捷登录只在 dev-stub 下出现、
匿名 info 读取不占 Provider 单槽。`provider.tsx`、`guard.tsx`、`dev-accounts.ts` 不改逻辑。

### D9 设置页重写

`features/settings/page.tsx` 重写为 `card` + `toggle-group`（`type="single"`，项 `role="radio"`、组 accessible name `主题`）；`settings.css` 删除。
`features/theme/provider.tsx` 与 `lib/theme.ts` 不改。`当前生效：浅色|深色` 的可访问文本保留（用 Tailwind 的 `sr-only`）。

### D10 demo 一致性 harness 退役与功能验收清单

同一 PR 内原子完成（oracle 逐字钉住这些镜像，分开改必红）：

- 删除 `web/e2e/ui-shots.mjs`、`web/package.json` 的 `ui-shots` 脚本、Makefile 的 `ui-shots` 目标 / `UI_SHOTS_*` 块 / `.PHONY` 项 / 页头注释句。
- `constraints.yaml` `verification.surfaces` 去掉 `ui-shots`（十一 → 十）。
- `AGENTS.md`：Verification Matrix 去掉「demo 一致性截图对」行，Enforcement Index 去掉对应行；「demo 文件头的来源注释在编辑时必须保留」保留（demo 文件仍在）。
- `scripts/test-ci-harness.sh`：期望元组、逐字行、冻结块检查、`.PHONY`/配方断言与突变用例同步去掉 `ui-shots`，并加一条「重新加入 `ui-shots` 被拒」。
- 新增 `docs/acceptance/functional-checklist.md`：文件头（运行方式、签收规则）+ 空的分节骨架；外壳/登录/设置的行由各自的迁移任务加入。
- `docs/acceptance/demo-parity-checklist.md`、`docs/reviews/2026-09-24-demo-parity-audit.md`、ADR-0011 里对 `ui-shots.mjs` 的行号引用是历史记录，不改。

### D11 落刀次序

1. 工具链 + 层叠 + 主题 + 分层 + 豁免 + 守卫（不改任何页面的 JSX；`legacy.css` 承接全部旧样式）。
2. harness 退役 + 功能清单骨架（与 1 无文件交集，除 `ui-tokens.test.ts`：demo 绑定断言在 1 里删，2 不碰该文件）。
3. 外壳、4. 登录页、5. 设置页：各自独立，均依赖 1 与 2（要往清单加行）。

## Sketch seams under test

- **层叠顺序**：登录页主按钮的计算 `background-color` 等于 `--primary`（utilities > legacy）；一个旧页面容器的 `padding` 等于其 `.css` 声明（legacy > preflight）。真实浏览器（ui-walk），jsdom 证明不了。
- **别名四处一致**：同一个 `@/components/ui/button` 导入在 `make typecheck`、`vite build`、`vitest`、`knip` 下都解析；任一处漏配即红。
- **`dark:` 绑定 `data-theme`**：暗色下 `body` 计算底色等于 `--wb-home-bg-secondary` 的深色值；首帧前主题的 ui-walk 用例（`MutationObserver` 顺序）保持通过。
- **豁免不外溢**：`make test-guardrails` 的两例（应用层 801 行被拒 / 拷入层 801 行通过）；覆盖率排除只列两个目录。
- **外壳槽位契约**：未改动的会话页经 `useTopbar` / `useSidebarSlot` 注入的内容在新外壳里仍出现（既有 `topbar-actions`、`sidebar-slot`、`app-shell-responsive` 测试的行为断言保留）。
- **退出流程的锁定态**：挂起退出请求时关闭并重开窄屏覆盖层，确认按钮仍忙碌禁用（既有场景）。
- **控制面 oracle**：`make test-guardrails` 在 `ui-shots` 镜像全部移除后通过，重新加入任一镜像被拒。

## Risks / Trade-offs

- **preflight 改变旧页面观感**：接受（owner）；若 `make ui-walk` 的功能断言因此失败（例如断言某元素可见但被重置隐藏），在 `legacy.css` 补最小规则修复功能，不追观感。
- **拷入层代码质量不受门槛约束**：只拷用到的组件；改动处由 ui-walk 与应用层测试间接覆盖。
- **shadcn / Tailwind 4 与 Biome 格式化冲突**：拷入后统一 `biome format --write`；Biome 对 Tailwind 4 的 `@theme`、`@custom-variant` 等 at-rule 若报解析错误，对 `web/src/styles/*.css` 关闭 CSS linter（只关这三个文件）。
- **测试改写量**：外壳/登录/设置的测试里读源码与 `.css` 的断言要删或改；行为断言（角色/名称）应原样通过——原样通过是「行为不变」的证据，不得为通过而放宽。
- **两套组件并存期**：直到文件页 change 收尾；`web/src/ui` 冻结守卫防止回流。

## Migration Plan

每个任务组一个 PR，合入后主干可运行；任一 PR 可独立 revert（组 1 被后续依赖，revert 需按逆序）。无数据迁移、无服务端变更、无部署步骤变化。

## Not yet specified

- shadcn 语义变量与 `--wb-*` 的逐项对应表（原则见 D3，具体取值在实现时对着亮/暗两套实际渲染定，PR 描述里列表，owner 在功能验收时看整体观感）。
- 旧页面在 preflight 下具体会出现哪些观感变化（不修，但若引起功能断言失败需要的最小补丁现在说不清）。
- Biome 对 Tailwind 4 at-rule 的实际兼容性（见 Risks 的兜底）。

## Open Questions

无阻塞项。
