# Design: login-quick-accounts（#299）

Change surface:
- 新增：`web/src/features/auth/dev-accounts.ts`、`web/src/features/auth/quick-login.tsx`。
- 修改：`web/src/features/auth/login-form.tsx`、`web/src/features/auth/auth.css`。
- 测试：`web/test/auth-router.test.tsx`（整体改路由 mock，`describe("login form")` 迁出）、`web/test/login-form.test.tsx`（迁入并新增 Q1–Q8，翻转 L1/L7）、`web/test/settings-footer.test.tsx:758`（计数改为全部请求路径的多重集合）。
- 必要时新增 `web/test/auth-router-support.ts`，供两文件共享 helper，避免 jscpd 报重复。
- 不改：`features/auth/{provider,guard,footer}.tsx`、`web/src/lib/**`、`web/src/ui/**`、服务端、`web/e2e/**`。

Must preserve:
- 提交语义：`lockedRef` 同 tick 锁、`mountedRef` 守卫、`setAccount` 回填、`finally` 清空密码并解锁、`login()` 调用次数。#328 的 StrictMode 问题原样保留，不在本刀修。
- 登录卡结构与 #284 的全部定位器：h1、`账号`/`密码` label、提交前按钮名 `登录`、alert `textContent`、错误行在按钮之上。
- Provider 单槽 operation 与 `loadServiceInfo`：LoginForm 与 QuickLogin 不 import、不调用它们。
- `auth-router.test.tsx` 每个既有用例的行为意图不变。改写只替换 mock 构造与位置型断言，不删用例、不放宽语义断言；迁出的 `describe("login form")` 用例数不变。
- `auth-router.test.tsx` 与 `login-form.test.tsx` 都 ≤ 800 行。
- ui-walk 单 project 全绿：登录按钮定位器唯一，快捷区在真实 dev-stub 下渲染但不干扰。
- ui-guardrails：feature css/tsx 无字面颜色或 palette，只经 `ui/index.js` 取基元；新增注释不含 `#NNN`。

Must add/change:
- `dev-accounts.ts`：
  ```ts
  /** 镜像 dev-stub seed（server/src/core/db/migrations/010_auth_schema_seed.sql）的可登录账号；只有 account 与 seed role。 */
  export const DEV_ACCOUNTS = [
    { account: "zhangsan", role: "成员" },
    { account: "zhaoliu", role: "成员" },
    { account: "lisi", role: "管理员" },
  ] as const;
  export const DEV_PASSWORD = "demo";
  export const DEV_STUB_PROVIDER = "dev-stub";
  ```
- `quick-login.tsx`：
  ```tsx
  export function QuickLogin({ disabled, onPick }: { disabled: boolean; onPick: (account: string) => void }) {
    const [available, setAvailable] = useState(false);
    useEffect(() => {
      const controller = new AbortController();
      createApiClient().getInfo({ signal: controller.signal }).then(
        (info) => { if (!controller.signal.aborted) setAvailable(info.auth.provider === DEV_STUB_PROVIDER); },
        () => {},  // 失败、malformed、abort：不渲染、不重试、不报错
      );
      return () => controller.abort();
    }, []);
    if (!available) return null;
    return (
      <>
        <p className="login-hint">演示账号：{…DEV_ACCOUNTS 生成：<b>zhangsan</b> / <b>zhaoliu</b> / <b>lisi</b>（管理员）…}，密码均为 <b>{DEV_PASSWORD}</b></p>
        <ul aria-label="快捷登录" className="login-quick">
          {DEV_ACCOUNTS.map(({ account, role }) => (
            <li key={account}>
              <button className="login-quick-item" disabled={disabled} onClick={() => onPick(account)} type="button">
                <span aria-hidden="true" className="login-quick-avatar">{account.slice(0, 1).toUpperCase()}</span>
                <span className="login-quick-copy"><span className="login-quick-account">{account}</span> <span className="login-quick-role">{role}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }
  ```
  - hint 的 `（管理员）` 标注来自 `role === "管理员"`，不写死账号。hint 文本逐字为 `演示账号：zhangsan / zhaoliu / lisi（管理员），密码均为 demo`。
  - 卡片按钮可访问名为 `zhangsan 成员`，不含"登录"。列表可访问名 `快捷登录` 不含"账号"/"密码"：Playwright 1.62 的 `getByLabel` 把任意元素的 `aria-label` 当 label 做子串匹配，含"账号"会让 ui-walk 的 `getByLabel("账号")` 命中两个元素。
  - `createApiClient` 从 `../../lib/api.js` 导入，与 provider.tsx 同层先例。
  - `.then` 的 `aborted` 守卫防止卸载后写 state。
  - StrictMode 下双 mount：第一个请求随卸载 abort，第二个生效。
- `login-form.tsx`：
  ```tsx
  async function performLogin(submittedAccount: string, password: string) {
    if (lockedRef.current) return;
    lockedRef.current = true; setAccount(submittedAccount); setSubmitting(true);
    try { await login({ account: submittedAccount, password }); }
    finally { …同现状（mountedRef 守卫下清空密码、解锁、setSubmitting(false)）… }
  }
  async function submit(event) { event.preventDefault(); …FormData 取值与类型守卫同现状…; await performLogin(submittedAccount, password); }
  …
  </form>
  <QuickLogin disabled={submitting} onPick={(picked) => { void performLogin(picked, DEV_PASSWORD); }} />
  ```
  快捷登录失败时错误行照常显示（同一 `useAuth().error`），账号框回填为所点账号。
- `auth.css`（沿用头注释，补 `:645-650` 来源）：
  ```css
  .login-root { display:flex; height:100dvh; overflow-y:auto; padding:24px 16px; background:var(--wb-home-bg-primary); }
  .login-card { margin:auto; …其余同现状… }
  .login-hint { margin:12px 0 0; font-size:11.5px; line-height:18px; text-align:center; color:var(--wb-text-tertiary); }
  .login-hint b { font-weight:600; color:var(--wb-text-secondary); }
  .login-quick { display:flex; flex-direction:column; gap:6px; margin:14px 0 0; padding:14px 0 0; border-top:1px solid var(--wb-border-default); list-style:none; }
  .login-quick-item { display:flex; align-items:center; gap:10px; width:100%; padding:7px 8px; border:1px solid transparent; border-radius:10px; background:transparent; color:var(--wb-text-primary); text-align:left; cursor:pointer; }
  .login-quick-item:hover:not(:disabled) { background:var(--wb-bg-hover); border-color:var(--wb-border-default); }
  .login-quick-item:disabled { cursor:default; opacity:.6; }
  .login-quick-avatar { display:inline-flex; flex-shrink:0; align-items:center; justify-content:center; width:28px; height:28px; border-radius:50%; background:var(--wb-brand-primary); color:var(--wb-bg-primary); font-size:12px; font-weight:700; }
  .login-quick-copy { display:flex; flex-direction:column; min-width:0; }
  .login-quick-account { font-size:13px; font-weight:550; line-height:18px; }
  .login-quick-role { font-size:11px; line-height:15px; color:var(--wb-text-secondary); }
  ```
  - 所用 token 若任一不存在，按 `tokens.css` 实有语义 token 替换并在 PR 说明。
  - demo 头像是 palette 渐变，本仓沿用侧栏头像的 brand-primary 平涂先例。
- 测试夹具改写规则（auth-router 与迁入 login-form 的用例一律适用）：
  1. 每个用例用 `createFetchMock({ "/api/auth/me": …, "/api/auth/login": […], "/api/info": … })`。**同一路径会被请求 ≥2 次（含 StrictMode 双 mount）时必须用数组或函数**：普通 `Response` 值每次返回同一对象，第二次读 body 抛错。挂起用 `deferredResponse().promise`，需要看 signal 的用函数形式。
  2. LoginForm 的 info 请求：
     - 不关心快捷区的用例不注册 `/api/info`，未注册路径抛错，被 `fetchResponse` 转成 `requestFailed(0)`，快捷区静默不渲染；
     - `canonicalLoginPaths` 的设置页分支原本就注册 `/api/info`，改为数组或函数：第一次给 LoginForm，第二次给关于卡。
  3. 位置型断言替换：
     - `toHaveBeenCalledTimes(N)` 改为全部请求路径的多重集合断言：`expect(paths(fetchMock).sort()).toEqual([...期望路径].sort())`，把 LoginForm 的 `/api/info` 显式列入。LoginForm 挂载后的路径断言放进 `waitFor`，或放在 `expectAccountFocused()` 之后（子组件 effect 先于父组件的聚焦 effect 运行），避免在 QuickLogin 的 effect 触发前取样。它不依赖顺序，但保留"没有意外请求"的总量约束（未注册路径会静默变成 `requestFailed(0)`，只数关心的路径会放过杂散请求）；
     - `expectInfoRequest` 的 `NthCalledWith(3)` 改为"最后一个 `/api/info` 调用"的请求形状断言（credentials/cache/signal），并断言 `/api/info` 共 2 次（LoginForm 1 次 + 关于卡 1 次）；
     - `requestSignal(fetchMock, 1)` 改为按路径找 `/api/auth/login` 调用的 signal。
  4. 新增共享 helper（`paths(fetchMock)`、`calls(fetchMock, path)`、`lastCall(fetchMock, path)`）放 `support.ts`，或在 jscpd 要求时放新 `auth-router-support.ts`。

Governing invariant:
- 快捷登录只在 `GET /api/info` 成功且 `auth.provider === "dev-stub"` 时出现，数据只来自 `DEV_ACCOUNTS`（account + seed role）。
- 读取由 LoginForm 子树在每次 mount 时匿名发起一次，卸载即 abort，失败静默不重试。它不占用、不取消、不等待 Provider 的任何 operation，登录表单从不因它阻塞。
- 点击卡片等价于以该账号与 `demo` 提交一次，受同一 `lockedRef` 保护。

Sibling surfaces:
- 其余渲染 LoginForm 的测试已逐一核对，本刀不改：
  - `routes`、`main`：LoginForm 不挂载。
  - `auth-session-client`：`:230` 在认证态。
  - `files-errors`、`chat-page-ownership`、`chat-page-lifecycle`：401 移交后无总次数断言。
  - `sidebar`：按 `/api/auth/logout` 过滤。
  - `app-shell-responsive`：无计数断言。
  - `settings-footer`：只有 `:758` 在 LoginForm 挂载后，改为全部请求路径的多重集合断言（含 `/api/info`）。
  实现时若任一文件出现新红，按改写规则 3 修，并在 PR 列出。
- `web/e2e/ui-walk.spec.ts:61-64,387-390`：真实 dev-stub 下快捷区会渲染，定位器 `getByLabel("账号")` 与 `getByRole("button",{name:"登录"})` 仍唯一，不改 e2e。
- 6.1（#295）：mobile 390×844 下的快捷区与滚动由真实浏览器证据覆盖。
- #328：LoginForm StrictMode 修复，与本刀 `performLogin` 重构同文件，后合者 rebase。
- 2.5（#300）：关于卡仍走 Provider 的 `loadServiceInfo`。

Seams under test（`web/test/login-form.test.tsx`；先红 = `dev-accounts`/`quick-login` 不存在、快捷区不渲染）:
- (Q1) dev-stub：注册 `/api/info` 为 `() => jsonResponse(serviceInfo)`（support 的 provider 为 `dev-stub`）。
  - QuickLogin 的 info 请求形状：`lastCall(fetchMock, "/api/info")` 的 path 为相对 `/api/info`，options 含 `credentials: "same-origin"`、`cache: "no-store"`、`signal`。
  - `findByRole("list", { name: "快捷登录" })` 内恰 3 个 button，名字依次为 `zhangsan 成员`、`zhaoliu 成员`、`lisi 管理员`。
  - hint 的 `textContent` 恰为 `演示账号：zhangsan / zhaoliu / lisi（管理员），密码均为 demo`。
  - 快捷区在 `.login-card` 内、在 `.login-form` 之后（`compareDocumentPosition`）。
  - 不含任何 display name 或部门文本（无 `张三`、`部`）。
- (Q2) 非 dev-stub 与失败，逐项 it.each：
  - `auth.provider = "oidc"`；
  - `/api/info` 未注册（`requestFailed(0)`）；
  - 返回 500 信封；
  - malformed（两键旧形状）；
  - `auth.provider = "ldap"`。
  每项等 info 请求落定（`waitFor` 该路径被调用 1 次后再让出一个宏任务）。同一等待方式配一行 dev-stub 对照：该行在同样的等待后必须已显示快捷区，防止门控错误靠时序蒙混过关。之后：无 `list[name=快捷登录]`、无 `.login-hint`，表单可提交，alert 不存在（不报错）；`/api/info` 恰 1 次（不重试）。
- (Q3) 点击卡片：dev-stub 下点 `zhangsan 成员`。
  - `/api/auth/login` 恰 1 次，body JSON 为 `{"account":"zhangsan","password":"demo"}`。
  - 账号框值为 `zhangsan`。
  - 提交中三张卡都 `disabled`，主按钮为 `正在登录`。
  - 锁：login 挂起时在**同一个 `act`** 里对卡片连发两次 click（`act(() => { card.click(); card.click(); })`），再 `await yieldMacrotask()`（`ui-support.ts`）让第二次调用的 `finally` 有机会跑完，之后三张卡仍 `disabled`、主按钮仍为 `正在登录`。没有 `lockedRef` 时第二次调用的 `finally` 会提前解锁并恢复可用（同 `auth-router.test.tsx:466-468` 的可观测量）。
  - login 成功后进入受保护内容。
- (Q4) 卸载 abort：info 用 deferred 挂起，`cleanup()` 卸载后，该请求的 `options.signal.aborted === true`。`aborted` 守卫另测（React 19 不再对卸载后 setState 告警，不能靠 `console.error`；守卫唯一可观测的场景是 StrictMode 同一实例的 effect 重跑）：StrictMode 下 `/api/info` 用函数依次返回两个 deferred，fetch 忽略 signal；先把第二个 resolve 为 oidc 并等其落定，再把第一个（已被 cleanup abort）resolve 为 dev-stub，等一个宏任务后仍无快捷区。去掉守卫时第一个请求的迟到结果会把同一实例的 `available` 写成 true。
- (Q5) 不占 Provider 单槽：info 与 login 都用 deferred 挂起，填表提交登录。
  - 看到 `/api/auth/login` 调用后、LoginForm 仍挂载时，info 请求的 `signal.aborted === false`，login 请求的 signal 也未 aborted。若 info 走 Provider 单槽，`startOperation` 会在 login 开始时 abort info，此断言红。
  - 让 login 返回 401 信封失败，再把 info resolve 为 dev-stub：错误行出现，快捷区随后出现（info 未被取消、未被等待）。
  - 另一轮：login 成功进入受保护内容，此时 info 的 signal 随 LoginForm 卸载 aborted。
  - 登录失败时快捷区状态不变：dev-stub 已显示时 login 返回 401 信封，错误行出现，三张卡仍在、仍可点。
- (Q6) StrictMode：dev-stub 下 StrictMode 挂载，快捷区恰出现一次（3 个 button）。`/api/info` 调用 2 次（双 mount），第一次的 signal 为 aborted。
- (Q7) 静态契约：
  - `quick-login.tsx` 不含 `loadServiceInfo`、`useAuth`、`@radix-ui`，含 `createApiClient(`；其中所有 `aria-label` 值不含"账号"或"密码"；
  - Q1 渲染态下 `screen.getAllByLabelText(/账号/)` 长度恰 1（只有账号输入框）；
  - `login-form.tsx` 不含 `loadServiceInfo`；
  - `dev-accounts.ts` 不含 `wangwu`、`name:`、`dept`；
  - `auth.css` 的 `.login-root` 含 `overflow-y: auto;` 与 `height: 100dvh;`，不含 `align-items: center;`；`.login-card` 含 `margin: auto;`；`.login-quick-item` 存在；
  - Q1 中每个卡片名不含"登录"。
- (Q8) 翻转既有：
  - L1 的"无 `演示账号`/`.login-quick`"改为在未注册 `/api/info` 的默认 helper 下断言。它仍成立，但语义变为"info 不可用时不渲染"，加注释说明；
  - L7 的"只有 `/api/auth/me`"改为 `["/api/auth/me", "/api/info"]`（顺序无关，用 `arrayContaining` 加长度 2）。
- 迁入的 `describe("login form")`：原五个用例（`auth-router.test.tsx:447-611`）按改写规则迁入，断言语义逐条保留。PR 附对照表：原行号 → 新行号，被替换的位置型断言 → 新断言。
- auth-router 余下用例：按改写规则全部迁移。PR 附同样的对照表，列出每个被替换的 `toHaveBeenCalledTimes`/`NthCalledWith`/`requestSignal(…, n)`。
- 既有全绿：`web/test` 全部；ui-walk 单 project 1 passed。

Required evidence:
- 先红后绿：Q1–Q7 实现前红；实现后 `web/test` 全绿。
- 反向注入各红并回退：
  1. QuickLogin 改用 `useAuth().loadServiceInfo` → Q7 红；Q5 红（login 开始时 info 的 signal 已 aborted）。
  2. 不 abort（去掉 cleanup）→ Q4 红。
  3. 失败时重试一次 → Q2 的"恰 1 次"红。
  4. 门控写成 `provider !== "oidc"` → Q2 的 `ldap` 行红。
  5. 快捷点击绕过 `lockedRef` 直接调 `login` → Q3 同 act 连点后的 `disabled`/`正在登录` 断言红。
  6. 卡片可访问名改为 `以 zhangsan 登录` → Q7 名称契约红。
  7. `.login-root` 恢复 `align-items: center` → Q7 红。
  8. 卡片加 display name（`张三`）→ Q1 红。
  9. 列表恢复 `aria-label="演示账号"` → Q7 的 `getAllByLabelText(/账号/)` 长度与 aria-label 静态契约红。
  10. 去掉 `.then` 里的 `aborted` 守卫 → Q4 第二段红。
- `make check` exit 0（size-guard：两测试文件 ≤ 800；jscpd 在阈值内；knip：新导出均有消费者）；`npm run build --workspace web` exit 0；ui-walk（CI 环境变量）1 passed。

Non-goals：Provider 机制；关于卡；#328；OIDC；ui-walk 快捷区断言；display name/部门。

Review focus:
- (0) 新增注释不含 `#NNN`。
- (1) 读取与 Provider 单槽完全隔离（Q5/Q7）。
- (2) abort 与迟到响应（Q4/Q6）。
- (3) 快捷点击与表单提交共用锁与错误路径（Q3/Q5）。
- (4) 测试改写没有弱化任何既有断言，逐条对照表。
- (5) ui-walk 定位器不冲突（卡片名不含"登录"）。
- (6) `.login-root` 可滚动且不裁顶。
- (7) 数据只来自 seed 镜像，不伪造 display name/部门。
