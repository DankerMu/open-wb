# Proposal: login-card-structure（#284）

## Why
S1e 组 2 的 2.4a。现状登录卡（`web/src/features/auth/login-form.tsx:50-92`）只有旧 CSS 方块 `.brand-mark`、标题与两个裸输入：无副标题、无 placeholder、账号框不自动聚焦，提交中用按钮外的一行 `<p className="ui-muted">正在登录</p>`。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md:64-65` 判为**实现偏差**（副标题/结构、自动聚焦）。父 spa-shell delta「登录页与路由守卫」规定登录卡镜像 demo:1721-1752。本刀只落结构与呈现；快捷登录门控与 `/api/info` 读取归 2.4b（#299，依赖 3.1）。

## What Changes
- `web/src/features/auth/login-form.tsx`：结构改为 `main.login-root > div.login-card > [div.login-brand > BrandMark size=26 wordmark, h1.login-title 登录 WorkBuddy, p.login-sub 内网统一身份 · 本实例不出网, form.login-form > [div.login-field(label 账号 + Input), div.login-field(label 密码 + Input), 错误行, Button 主按钮]]`。
  - 字段用 `ui/` 的 `Input`，`<label htmlFor>` 与 `useId()` 关联（`getByLabelText("账号"/"密码")` 与 ui-walk `getByLabel` 继续命中）。账号 placeholder `域账号，如 zhangsan`、`autocomplete="username"`；密码 placeholder `密码`、`autocomplete="current-password"`、`type="password"`。
  - 账号框 mount 时聚焦：`useEffect` 调 `accountRef.current?.focus()`。不用 React `autoFocus`：biome recommended 的 `a11y/noAutofocus` 会拦，`ui/dialog.tsx:14` 也有同样约定。
  - 主按钮用 `Button variant="primary" type="submit"`，提交中文案换成 `正在登录` 并 `disabled`。不用 `loading`：`Button` 的 loading 会把文字置透明（`button.tsx:6`），而 spec 要求"显示 `正在登录`"。删除按钮外的 `正在登录` 段落。
  - 错误行 `<p className="login-err" role="alert"><Icon name="triangle-alert" size={12} />{error}</p>`。Icon 默认 `aria-hidden` 且不产生文本节点，`auth-router.test.tsx:301` 的 `textContent` 精确比对不受影响。
  - 提交逻辑（`lockedRef`/`mountedRef`/清空密码/`login()` 调用）逐行不变。
- 新 `web/src/features/auth/auth.css`：带 demo 来源头注释（demo:637-644、:739-740、:606）。登录页规则从 `styles.css` 迁入并对齐 demo：`.login-card` 宽 360、`max-width: calc(100vw - 32px)`、边框 `--wb-border-card`、`padding: 28px 24px 22px`；`.login-brand` `margin-bottom: 14px`；`.login-title` 18/650；`.login-sub` 12px `--wb-text-tertiary`、`margin: 4px 0 18px`；`.login-field`/`.login-label`（13/500、间距 6、组间 14）；`.login-btn` 宽 100%、高 36、`margin-top: 4px`；`.login-err`（12px、`--wb-status-error-text` 与 `--wb-status-error-soft-bg`、圆角 8、`padding: 7px 10px`、`margin-bottom: 10px`、flex gap 6）。`styles.css` 增 `@import "./features/auth/auth.css";`。
- `styles.css`：删去 `.brand-mark`/`.brand-mark::after`（唯一消费者就是本表单）、全部 `.login-*` 规则、死规则 `.login-dialog`，以及 `≤760` 块里的 `.login-card` 选择器（该窄屏内边距随 auth.css 的 `@media (max-width: 760px)` 迁走，`.settings-page` 保留）。`web/src/ui/brand-mark.tsx:7` 注释里的 `.brand-mark` 引用改成"原 CSS 方块（已移除）"，只动注释。
- 测试：新 `web/test/login-form.test.tsx`（L1–L8）。`web/test/auth-router.test.tsx` 零改动。

## Non-goals
快捷登录 `演示账号` 区与 `features/auth/dev-accounts.ts`（2.4b）；LoginForm 读 `/api/info`、`auth-router.test.tsx` 的 fetch mock 重写与 `describe("login form")` 迁移（2.4b）；`/api/info` 形状（3.1）；OIDC；登录页主题切换；`.auth-loading` 呈现。

## Capabilities
- MODIFIED `spa-shell`：Requirement「登录页与路由守卫」增加登录卡结构句（不含快捷登录，快捷登录随 2.4b）；Scenario「未登录重定向」增"账号框已聚焦"。

## Impact
`web/src/features/auth/{login-form.tsx,auth.css}`、`web/src/styles.css`、`web/src/ui/brand-mark.tsx`（仅注释）、`web/test/login-form.test.tsx`（新）。不加依赖、不加网络请求。

## 与 oracle 偏差留痕
- 父 delta 的结构句写"自上而下……主按钮 `登录`……、错误行"，issue #284 Key interfaces 行同样写"主按钮 → 错误行"，错误行都排在按钮后。demo:1732-1733 与现有实现都把错误行放在按钮**之前**，而同一句又要求"镜像 demo:1721-1752"。本刀按 demo 顺序实施，delta 结构句写成"错误行（位于主按钮之上）"。父 delta 的对应句在本 issue 的归档 docs PR 里同步（运行期间 oracle 不改），防止 2.4b 以旧句整块重述时回退。
- 父 delta 同一 Requirement 里的快捷登录句与 Scenario「快捷登录仅 dev-stub 可见」归 2.4b，本 delta 不含，由 2.4b 晋升。
- demo 品牌位是上游 logo 图片（`<img>` height 26）。依据 `web/src/styles.css:1-4`「Brand imagery … not reused」、ATTRIBUTION §4 许可只及 demo token 而不延及上游应用本身，以及父 delta 的明文规定，改用自有 `BrandMark`（mark 26px + 字标 `WorkBuddy`）。
- demo 卡片阴影是字面量 `0 12px 40px rgba(0,0,0,.10)`（demo:638），沿用语义 token `--wb-shadow-dialog`（feature css 禁字面颜色）。

## Risk triage
- 定位器回归：`登录 WorkBuddy` h1 被 8 个 `web/test` 文件（17 处）与 ui-walk（2 处）使用；`账号`/`密码` 标签被 auth-router 与 ui-walk 使用；错误行 `textContent` 精确比对（L4/L5 + 既有套件零改动全绿钉住）。
- 聚焦实现方式：`autoFocus` 过不了 lint；effect 聚焦在 StrictMode 下双跑无害（L2 StrictMode 用例钉住）。
- CSS 迁移漏规则或留下死规则（L8 静态契约钉住）。
