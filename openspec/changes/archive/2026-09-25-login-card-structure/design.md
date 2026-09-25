# Design: login-card-structure（#284）

Change surface: 改 `web/src/features/auth/login-form.tsx`、`web/src/styles.css`、`web/src/ui/brand-mark.tsx`（仅 `:7` 注释）；新 `web/src/features/auth/auth.css`、`web/test/login-form.test.tsx`。不改 `web/test/auth-router.test.tsx`（行数与内容都不变）、`web/e2e/**`、其它 `web/src/ui/**`、`features/auth/{provider,guard,footer}.tsx`。

Must preserve:
- 提交语义逐行不变：`lockedRef` 同 tick 锁、`FormData` 取值与类型守卫、`setAccount` 回填、`finally` 里 `mountedRef` 守卫下清空密码并解锁。
- 定位器不变：h1 名 `登录 WorkBuddy`；`getByLabelText("账号")`/`("密码")`，以及 Playwright `getByLabel`；提交前按钮名 `登录`。
- 错误行：`role="alert"`，`textContent` 恰为信封 message。
- `name="account"`/`name="password"`、`required`；账号框受控（`value={account}`）；Enter 提交。
- `main.login-root` 仍是登录页唯一 `main`。
- 登录页不发任何新请求。
- `web/test` 既有用例零改动全绿，含 `auth-router.test.tsx` 与 `登录 WorkBuddy` 的 17 处 jsdom 断言；ui-walk 登录步骤全绿。
- ui-guardrails：feature css/tsx 无 hex/`rgba(`/palette，features 不直接 import `@radix-ui`，只经 `ui/index.js` 取 `BrandMark`/`Input`/`Button`/`Icon`。
- 新增 `.tsx/.css` 注释不含 `#NNN`。

Must add/change:
- `login-form.tsx`（结构；提交逻辑同现状）：
  ```tsx
  import { type FormEvent, useEffect, useId, useRef, useState } from "react";
  import { BrandMark, Button, Icon, Input } from "../../ui/index.js";
  …
  const accountRef = useRef<HTMLInputElement>(null);
  const accountId = useId(); const passwordId = useId();
  // 账号框 mount 即聚焦（不用 autoFocus：biome a11y/noAutofocus）。
  useEffect(() => { accountRef.current?.focus(); }, []);
  …
  return (
    <main className="login-root">
      <div className="login-card">
        <div className="login-brand"><BrandMark size={26} wordmark /></div>
        <h1 className="login-title">登录 WorkBuddy</h1>
        <p className="login-sub">内网统一身份 · 本实例不出网</p>
        <form className="login-form" onSubmit={submit}>
          <div className="login-field">
            <label className="login-label" htmlFor={accountId}>账号</label>
            <Input autoComplete="username" id={accountId} name="account" onChange={…} placeholder="域账号，如 zhangsan" ref={accountRef} required value={account} />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor={passwordId}>密码</label>
            <Input autoComplete="current-password" id={passwordId} name="password" placeholder="密码" ref={passwordRef} required type="password" />
          </div>
          {error ? <p className="login-err" role="alert"><Icon name="triangle-alert" size={12} />{error}</p> : null}
          <Button className="login-btn" disabled={submitting} type="submit" variant="primary">{submitting ? "正在登录" : "登录"}</Button>
        </form>
      </div>
    </main>
  );
  ```
  - `BrandMark wordmark` 时 svg 为 `aria-hidden`，可访问文本是字标 `WorkBuddy`。整块不再包 `aria-hidden`：字标是可见文本，与 demo `alt="WorkBuddy"` 语义一致。
  - `Input` 透传 `ref`/`id`/`placeholder`/`autoComplete` 等原生属性（React 19 ref-as-prop；`input.tsx`）。
  - `Icon` 的尺寸 `12` 在允许集合内。
- `auth.css`（新；头注释：`/* 登录页 — adapted from resource/workbuddy-live-demo.html:637-644（.login-root/.login-card/.login-brand/.login-title/.login-sub/.login-btn/.login-err）、:739-740（.form-label/.form-group）。只用语义 token；品牌位用自有 BrandMark，不复用上游 logo。 */`）：
  ```css
  .login-root { display:flex; align-items:center; justify-content:center; min-height:100dvh; padding:24px 16px; background:var(--wb-home-bg-primary); }
  .login-card { width:360px; max-width:calc(100vw - 32px); padding:28px 24px 22px; border:1px solid var(--wb-border-card); border-radius:16px; background:var(--wb-bg-primary); box-shadow:var(--wb-shadow-dialog); }
  .login-brand { display:flex; justify-content:center; margin-bottom:14px; }
  .login-title { margin:0; font-size:18px; font-weight:650; line-height:26px; text-align:center; color:var(--wb-text-primary); }
  .login-sub { margin:4px 0 18px; font-size:12px; text-align:center; color:var(--wb-text-tertiary); }
  .login-form { display:flex; flex-direction:column; }
  .login-field { margin-bottom:14px; }
  .login-label { display:block; margin-bottom:6px; font-size:13px; font-weight:500; }
  .login-err { display:flex; align-items:center; gap:6px; margin:0 0 10px; padding:7px 10px; border-radius:8px; font-size:12px; color:var(--wb-status-error-text); background:var(--wb-status-error-soft-bg); }
  .login-btn { width:100%; height:36px; margin-top:4px; }
  @media (max-width:760px) { .login-card { padding-left:16px; padding-right:16px; } }
  ```
  - `.login-root` 与 `≤760` 内边距沿用现有值（demo 无对应窄屏规则）。
  - `.login-btn` 叠在 `.ui-btn--primary`/`--md` 之上，只改几何，不改配色。
- `styles.css`：
  - 增 `@import "./features/auth/auth.css";`，放在 files.css 之后。
  - 删 `:189-209`（`.brand-mark`、`.brand-mark::after`）、`:245-326`（`.login-root` 到 `.login-dialog`，`.auth-loading` 保留）。
  - `≤760` 块 `.login-card,\n  .settings-page` 改为 `.settings-page`。
- `brand-mark.tsx:7`：注释改为 `几何取自原 CSS 方块 .brand-mark（已移除）的 SVG 化`，代码不动。

Governing invariant: 登录页结构与 demo:1721-1752 同序——品牌（自有 mark + 字标）→ h1 → 副标题 → 账号 → 密码 → 错误行 → 主按钮。账号框 mount 即获得焦点。提交中主按钮显示 `正在登录` 且禁用。登录页不渲染任何无后端支撑的控件（快捷登录随 2.4b）。提交、锁与错误语义不变，全部既有定位器不变。

Sibling surfaces:
- `web/test/auth-router.test.tsx:152-158,301,446-612`：heading/label/按钮/alert 定位器，不改。
- 8 个 `web/test` 文件共 17 处 `登录 WorkBuddy` heading 断言，不改。
- `web/e2e/ui-walk.spec.ts:61-64`：登录步骤，不改。
- `features/auth/guard.tsx`：唯一消费者，不改。
- 2.4b（#299）：在 `login-btn` 之下追加 `演示账号` 区，迁 `describe("login form")`，重写 fetch mock；其晋升 delta 必须以本刀晋升后的结构句为底（错误行在按钮之上、`textContent` 恰为 message），不得回退到父 delta 旧写法。
- 2.5 设置页：同样用 `BrandMark`。
- `.auth-loading`：保留在 styles.css。

Seams under test（新文件 `web/test/login-form.test.tsx`；挂载走 `AuthProvider` + `AuthGuard`，`/api/auth/me` 返回 401 进未登录态，按 `auth-router.test.tsx` 既有 fixture 写法，经 `support.ts` 的 `createFetchMock`/`jsonResponse`，401 响应在新文件内联 `jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401)`（`unauthenticatedResponse` 是 `auth-router.test.tsx:105` 的局部函数，不得为此改该文件）；路由值一律用 resolver 形式 `() => jsonResponse(...)`（StrictMode 下 me 会请求两次，共享 Response 读第二次会失败）；先红 = 副标题、placeholder 不存在，焦点不在账号框）：
- (L1) 结构与顺序：
  - `findByRole("heading", { level: 1, name: "登录 WorkBuddy" })`。
  - 副标题 `getByText("内网统一身份 · 本实例不出网")` 为 `P.login-sub`。
  - 品牌区 `.login-brand` 内含 `svg.ui-brand-mark`，其 `width`/`height` 属性为 `"26"`，且 `aria-hidden="true"`；可见字标 `WorkBuddy`。
  - 登录卡内元素的 DOM 顺序：`.login-brand` → h1 → `.login-sub` → 账号 input → 密码 input → 按钮，用 `compareDocumentPosition` 链式断言。
  - 无 `演示账号` 文本，无 `.login-quick`，无 `.brand-mark` 元素。
- (L2) 自动聚焦：挂载后 `waitFor(document.activeElement === getByLabelText("账号"))`。StrictMode 挂载同样成立（L2b，只测聚焦，不在 StrictMode 下测提交：既有 `mountedRef` cleanup 在 StrictMode 模拟卸载后不复位，属本刀范围外的既有问题）。
- (L3) 字段属性精确值：
  - 账号：`placeholder` 为 `域账号，如 zhangsan`，`autocomplete` 为 `username`，`name` 为 `account`，`required`。
  - 密码：`placeholder` 为 `密码`，`autocomplete` 为 `current-password`，`type` 为 `password`，`name` 为 `password`。
  - 两个输入都带类 `ui-input`，`<label>` 的 `htmlFor` 指向输入 `id`。
- (L4) 提交中：`/api/auth/login` 为 deferred。填账号密码后点 `登录`，同一按钮节点的 `textContent` 为 `正在登录`、`disabled`，且 `getByRole("button", { name: "正在登录" })` 与它是同一元素；页面无 `登录` 按钮名。提交中 `getAllByText("正在登录")` 恰 1 个（只在按钮上，无旁挂段落）。resolve 403 信封 `该账号已停用，请联系管理员` 后，按钮回到 `登录`、可用，`findByRole("alert")` 的 `textContent` 恰为该 message，alert 内含 `svg[aria-hidden="true"]`，且类为 `login-err`；位置：`passwordInput.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING` 且 `alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING`（button 为提交前捕获的节点）。
- (L5) 网络失败：`requestFailed` 时 alert `textContent` 为 `请求失败，请稍后重试`，按钮可用，密码框被清空。
- (L6) 路由路径：经 `mountAuthenticatedApp` 等价的路由挂载未登录访问 `/files`：登录页出现、URL 仍为 `/files`、账号框已聚焦（Scenario「未登录重定向」前半）。
- (L7) 零新请求（本刀范围守卫，非 spec 条款；2.4b 会加 `/api/info`；非 strict 挂载下断言）：挂载并等待聚焦后，`fetchMock` 只收到 `/api/auth/me`，没有 `/api/info`。
- (L8) 静态契约（`readRepoFile` + `ruleBody`/`stripComments`）：
  - `auth.css` 原文头注释含 `resource/workbuddy-live-demo.html:637`；`ruleBody` 前先 `stripComments`；`.login-card` 含 `width: 360px;`、`border: 1px solid var(--wb-border-card);`、`max-width: calc(100vw - 32px);`；`.login-sub` 含 `color: var(--wb-text-tertiary);`；`.login-btn` 含 `height: 36px;`；`.login-err` 含 `var(--wb-status-error-soft-bg)`。
  - `styles.css` 含 `@import "./features/auth/auth.css";`，不含 `.brand-mark`、`.login-`、`.login-dialog`。
  - `login-form.tsx` 不含 `autoFocus`、`@radix-ui`、`ui-muted`，含 `from "../../ui/index.js"`。
- 既有：`auth-router.test.tsx` 零改动全绿，行数 800 不变；`登录 WorkBuddy` 断言所在 8 个文件零改动全绿。
- ui-walk（CI）：登录步骤 1 passed。

Required evidence:
- 先红后绿：`login-form.test.tsx` 在实现前红（副标题、placeholder、聚焦、`正在登录` 按钮名、auth.css 均不存在）；实现后 `web/test` 全绿。
- 反向注入各红并回退：
  - 删聚焦 effect → L2 红。
  - 按钮改用 `loading` 而非换文案 → L4 红（`textContent` 仍为 `登录`）。
  - 错误行里加入可见文本前缀（如 `错误：`）→ L4 与 `auth-router.test.tsx:301` 红。
  - 错误行移到按钮之后 → L4 位置断言红。
  - `BrandMark` 不传 `wordmark` → L1 红（svg 不再 `aria-hidden`，缺字标）。
  - 保留 `styles.css` 的 `.brand-mark` → L8 红。
  - placeholder 写成 `域账号` → L3 红。
- `make check` exit 0（size-guard、knip、jscpd、naming-guard、guardrails）；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。
- `git diff --stat web/test/auth-router.test.tsx web/e2e` 为空；`grep -rn "brand-mark\b" web/src --include=*.css` 只剩 `ui-brand-mark*`。

Non-goals: 快捷登录与 `/api/info`（2.4b / 3.1）；`auth-router.test.tsx` 拆分与 mock 重写（2.4b）；OIDC；`.auth-loading` 呈现；登录页主题切换；`Input` 基元高度调整（demo `.wb-input` 本就是 32px）。

Review focus:
- (0) 新增 `.tsx/.css` 注释不含 `#NNN`。
- (1) 提交逻辑零语义变化：diff 只动 JSX 与聚焦 effect。
- (2) 全部既有定位器仍命中：heading、label、提交前按钮名、alert `textContent`。
- (3) 聚焦 effect 在 StrictMode 下无害，且不与 AuthGuard 的 loading 态冲突（LoginForm 只在 unauthenticated 时挂载）。
- (4) CSS 迁移完整：无遗漏规则，`.login-dialog`/`.brand-mark` 死规则删净，`≤760` 窄屏内边距仍生效。
- (5) demo 行号与数值逐项对得上（638-644、739-740）。
- (6) 不渲染任何 2.4b 控件。
