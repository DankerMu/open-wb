# s1f-ui-foundation — 前端重建的地基

## Why

ADR-0013（owner，2026-10-04）决定整个前端改用 assistant-ui + shadcn/ui + Tailwind 重建，并且全站不再以 demo 为验收基线。
S1f 按 grill 结论切为四个 change（`IMPLEMENTATION_PLAN.md` S1f 段）：地基 → 会话页 → 会话列表与临时空间 → 文件页。本 change 是第一个：
先把工具链、主题、组件分层、守卫与验收方式换好，并把不含业务复杂度的三块（外壳、登录页、设置页）迁过去，后面三个 change 才有东西可建。

## What Changes

- **工具链**：`web` 接入 Tailwind 4（`@tailwindcss/vite`）；`web/tsconfig.json` 改为 `module: ESNext` + `moduleResolution: Bundler` 并加 `@/` 别名
  （tsc / Vite / vitest / knip 四处一致）；`web/components.json` 入库（shadcn registry，Radix 版式）。
- **样式入口与层叠**：`web/src/styles.css` 声明层顺序 `theme, base, legacy, components, utilities`，既有全部样式进 `legacy` 层——
  旧页面规则压过 preflight，Tailwind utilities 压过旧全局规则，新旧页面可在同一份样式表里并存；全局 reduced-motion 块保持未分层。
- **主题映射**：`web/src/styles/theme.css` 把 shadcn 的语义变量定义为对现有 `--wb-*` token 的引用（owner：沿用现有配色体系）；
  `dark:` 变体绑定 `[data-theme="dark"]`；主按钮等关键取值与迁移前相同并有断言守护。`tokens.css` 不再与 demo 逐值绑定。
- **组件分层与守卫**：拷入层 `web/src/components/{ui,assistant-ui}`、应用层（其余 `web/src`）、冻结区 `web/src/ui`；应用层不直接引 Radix；
  `web/src/ui` 冻结；已迁移区域不回用旧基元、不新增 `.css`。
- **拷入层门槛豁免**（owner，2026-10-04）：仅这两个目录豁免覆盖率、jscpd、size-guard、Biome linter、knip 未使用导出；应用层门槛不变。
- **外壳、登录页、设置页重写**：行为契约（路由、守卫、折叠持久化、窄屏覆盖层、顶栏三态与 actions 插槽、侧栏列表槽位、退出流程、
  主题切换、关于卡）全部保留，去掉规格里的 demo 行号、像素值与旧基元名。
- **验收方式切换**：`make ui-shots`、`web/e2e/ui-shots.mjs`、demo-parity-acceptance 规格及其控制面镜像退役；
  新增 `docs/acceptance/functional-checklist.md`（按功能、owner 签收）。

## 功能覆盖声明

- 覆盖 F-UI-7 的地基部分（工具链、主题、分层、外壳/登录/设置）与 F-UI-8（功能验收 harness）。
- F-UI-7 的会话页、会话列表、文件页与 F-CHAT-11a 属后续三个 change。
- 与 `IMPLEMENTATION_PLAN.md` S1f 段无偏离。

## Non-goals

- 会话页、文件页、`/center` 的任何改动：它们继续用 `web/src/ui` 与各自的 `.css`（在 `legacy` 层里），直到各自的 change。
- 旧页面因 preflight 产生的观感变化不修复（功能必须可用，`make ui-walk` 全绿）。
- 删除 `web/src/ui`、旧 `.css`、各 `@radix-ui/*` 单包与 Toast 旧实现：最后一个 change（`s1f-files-page`）收尾。
- 任何服务端改动。
- 用户菜单新增项、设置页新增卡片、登录页新增控件：无后端，不渲染。
- 包体积优化与代码分割：会话页 change 引入 assistant-ui 时处理。

## Capabilities

### New Capabilities
- `ui-foundation`：Tailwind 入口与层叠顺序、主题映射、组件分层、拷入层门槛豁免。
- `functional-acceptance`：功能验收清单与签收规则。

### Modified Capabilities
- `spa-shell`：构建工具链加 Tailwind 与别名；路由 IA 与侧栏、登录页、设置页去掉 demo/像素/旧基元名（行为不变）；「外壳页面底色」移除（并入 ui-foundation 主题映射）。
- `ui-primitives`：「设计 token 全集」不再与 demo 逐值绑定；「基元组件库」「按钮单一实现与旧类退役」收窄到未迁移区域，退出确认改由拷入层渲染；「全局 reduced-motion 规则」补 Tailwind 过渡与拷入组件的 reduce 行为、场景改按角色定位；「Escape 分派不受 Toast 层栈影响」覆盖新外壳的导航覆盖层与退出确认。
- `verification-harness`：控制面由十一个 surface 减为十个，`ui-shots` 及其冻结块检查移除。
- `demo-parity-acceptance`：三条 Requirement 全部移除。

## Impact

- `web/`：`package.json`、`vite.config.ts`、`vitest.config.ts`、`tsconfig.json`、`components.json`、`src/styles.css`、`src/styles/theme.css`、
  `src/styles/legacy.css`、`src/components/ui/*`、`src/lib/utils.ts`、`src/ui/index.ts`（只加一个导出）、`src/routes/**`、`src/features/{auth,settings,theme}/**`、
  对应 `test/*`（含读 `styles.css` 或外壳类名的会话页测试）与 `e2e/ui-walk*`；删除 `e2e/ui-shots.mjs`。
- 根：`tsconfig.base.json` 与 `vitest.shared.mjs` 不动；`.jscpd.json`、`biome.json`、`knip.json`、`Makefile`、`constraints.yaml`、`AGENTS.md`、`ATTRIBUTION.md`、
  `scripts/size-guard.sh`、`scripts/test-ci-harness.sh`、`scripts/test-guardrails.sh`。
- 文档：新增 `docs/acceptance/functional-checklist.md`。
- 依赖新增：`tailwindcss`、`@tailwindcss/vite`、`radix-ui`、`class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`（均 MIT，构建期，无公网运行时请求）。
- 服务端、数据库、REST/SSE 契约：无影响。
