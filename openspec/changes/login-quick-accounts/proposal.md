# Proposal: login-quick-accounts（#299）

## Why
S1e 组 2 的 2.4b，依赖 2.4a（#284 登录卡结构）与 3.1（#285 `/api/info` 的 `auth.provider`），两者都已合入。demo 登录卡在按钮下方有 `演示账号` 提示与三张快捷登录卡（demo:1734-1739, 645-650）。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md:66` 把它列为"开发态是否保留 → 待拍板"。父 design 决策 6（D6）已拍板：只在装配的 provider 为 `dev-stub` 时渲染，数据来自静态常量，不伪造 display name/部门。本刀交付门控与快捷区，并把受影响的登录页测试夹具改成按路径路由。

## What Changes
- 新 `web/src/features/auth/dev-accounts.ts`：
  - `DEV_ACCOUNTS` 为静态三项 `{ account, role }`，镜像 dev-stub seed（`server/src/core/db/migrations/010_auth_schema_seed.sql:34-62`）：`zhangsan/成员`、`zhaoliu/成员`、`lisi/管理员`。停用账号 `wangwu` 不列。
  - `DEV_PASSWORD = "demo"`。
  - 只有 account 与 seed role，不含 display name 或部门。
- 新 `web/src/features/auth/quick-login.tsx`：`QuickLogin({ disabled, onPick })`。
  - 每次 mount 用 `createApiClient()`（匿名，不传 `onUnauthorized`）发一次 `getInfo({ signal })`，signal 来自本组件的 `AbortController`，卸载即 abort。
  - 只有 `info.auth.provider === "dev-stub"` 时渲染 `<p className="login-hint">` 与 `<ul className="login-quick">` 三张卡；pending、失败（含 `requestFailed(0)`、malformed）、其它 provider 都渲染 `null`。
  - 失败不重试，不显示错误，不碰 `useAuth()` 的任何 operation。
  - 列表为 `<ul aria-label="快捷登录">`；卡片是 `<button type="button" className="login-quick-item">`，内容为头像圆标（account 首字母大写，`aria-hidden`）加 `<span>zhangsan</span> <span>成员</span>`。可访问名形如 `zhangsan 成员`，**不含"登录"**，列表名**不含"账号"/"密码"**：Playwright 的 `getByRole({ name })` 与 `getByLabel` 默认都做子串匹配（`getByLabel` 还把任意 `aria-label` 当 label），否则 ui-walk 的 `登录` 按钮与 `账号` 输入框定位器会命中多个元素。
- `web/src/features/auth/login-form.tsx`：
  - 提交主体抽成 `performLogin(account, password)`，表单提交与快捷卡共用；`lockedRef`、`mountedRef`、`setAccount`、清空密码的语义不变。
  - 快捷卡点击时 `setAccount(account)` 并提交 `{ account, password: DEV_PASSWORD }` 一次。
  - `<QuickLogin>` 放在 `</form>` 之后、`.login-card` 之内，提交中 `disabled`。
- `web/src/features/auth/auth.css`：
  - 按 demo:645-650 增 `.login-hint`、`.login-quick`、`.login-quick-item`（含 hover，头像复用 `.sidebar-avatar` 的几何但写在 auth.css，只用语义 token）。
  - `.login-root` 改为可滚动：`height: 100dvh; overflow-y: auto`，卡片 `margin: auto` 居中。不再用 `align-items: center`，否则内容高于视口时顶部被裁掉、滚不到。这回应了 #299 评论里 #284 集成审查的预警。
- 测试：
  - `web/test/auth-router.test.tsx` 整体改为按路径路由的 `createFetchMock`（数组表示同一路径的依次响应），删掉位置型断言（`NthCalledWith(3)`、`requestSignal(fetchMock, 1)`、总次数），改为全部请求路径的多重集合断言与按路径的请求形状断言。
  - `describe("login form")` 迁到 `web/test/login-form.test.tsx`，迁移时同样按路径路由。
  - `login-form.test.tsx` 新增 Q1–Q8，并按 #299 评论翻转 L1/L7。
  - `settings-footer.test.tsx:758` 计数改为全部请求路径的多重集合断言（含 LoginForm 的 `/api/info`）。
  - 其余渲染 LoginForm 的测试文件核对后不改（见 design Sibling surfaces）。

## Non-goals
Provider operation 机制（不改）；关于卡（2.5 #300）；#328（LoginForm 在 StrictMode 下锁死，另行修复）；OIDC 登录；ui-walk 断言快捷区（6.1 #295 的双 project 视觉证据）；display name/部门/头像图片。

## Capabilities
- MODIFIED `spa-shell`：Requirement「登录页与路由守卫」在结构句后加快捷登录句（取父 delta），新增 Scenario「快捷登录仅 dev-stub 可见」（取父 delta）。以 #284 晋升后的文本为底，结构句不回退。

## Impact
`web/src/features/auth/{dev-accounts.ts,quick-login.tsx}`（新）、`login-form.tsx`、`auth.css`；`web/test/{auth-router,login-form,settings-footer}.test.tsx`，可能新增 `web/test/auth-router-support.ts`（jscpd 抽取时）。不加依赖，不动服务端。

## 与 oracle 偏差留痕
- demo 卡片内容是 display name + 部门 · 角色（demo:1737），头像取姓名首字；hint 文本写明三个账号与密码。父 delta 禁止伪造 display name/部门，卡片只显示 account 与 seed role，头像取 account 首字母。hint 由 `DEV_ACCOUNTS` 生成，文本为 `演示账号：zhangsan / zhaoliu / lisi（管理员），密码均为 demo`，与 demo 逐字一致，管理员标注来自 role。
- `.login-root` 布局从 flex 居中改为可滚动容器 + `margin: auto`。demo 的 `.login-root` 是 `position:fixed; align-items:center`（demo:637），存在同样的裁切问题，本仓修正它。
- `auth-router.test.tsx` 的位置型断言改为按路径的断言（总次数改为全部请求路径的多重集合），这比 issue 字面的"核对 NthCalledWith(3)"更进一步：LoginForm 的 info 请求让所有位置型断言都不稳定，按路径断言才是不随请求插入而漂移的写法。
- 父 tasks 2.4b 与 issue 写"auth-session-client/routes/main/settings-footer 注册 `/api/info`"，issue Key interfaces 写 `useServiceInfoOnce()`。本刀改为：不关心快捷区的夹具不注册 `/api/info`，依赖未注册路径转成 `requestFailed(0)` 的静默回退（父 D6 已记录此链路）；核对后这四个文件只有 `settings-footer.test.tsx:758` 需要改。读取实现为 `QuickLogin` 组件内的 effect，与 `useServiceInfoOnce()` 等价，只是不单独导出 hook。

## Risk triage
- 门控读取占用 Provider 单槽 → login/logout 被 supersede。Q5 钉住：info 挂起时提交登录不被取消，About 读取仍走 Provider。
- 快捷卡可访问名含"登录"会让 ui-walk 定位器变成多元素，严格模式下失败。Q7 的静态契约钉住，CI ui-walk 也会跑到。
- 卸载不 abort 会导致迟到 setState 警告或请求泄漏。Q4 钉住。
- 测试夹具改写漏改或弱化既有断言。等价改写表钉住，review 逐条对照。
