# Tasks: login-quick-accounts（#299）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate login-quick-accounts --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [ ] 2.1 `web/test/auth-router.test.tsx` 整体改按路径路由 mock 并替换位置型断言；`describe("login form")` 迁入 `web/test/login-form.test.tsx`（同样改写）；`settings-footer.test.tsx:758` 改为全部请求路径的多重集合断言。此步在现实现上保持全绿（纯夹具重构），附对照表。
- [ ] 2.2 `login-form.test.tsx` 新增 Q1–Q7，翻转 L1/L7（Q8）。先红。
- [ ] 2.3 `features/auth/dev-accounts.ts` + `quick-login.tsx`；`login-form.tsx` `performLogin` 抽取与 `<QuickLogin>` 挂载；`auth.css` 快捷区样式与可滚动 `.login-root`。2.2 转绿，`web/test` 全绿。
- [ ] 2.4 反向注入十项各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.1 `make check` exit 0（size-guard、jscpd、knip）。
- [ ] 3.2 `npm run build --workspace web` exit 0。
- [ ] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：LoginForm 新增可见控件（快捷卡），可访问名是 ui-walk 与 6.1 的定位面。证据：Q1、Q7。
- Not selected Config / project setup：不加依赖、不改配置。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：只消费 #285 已定的 `auth.provider`。
- Selected Auth / permissions / secrets：快捷登录直接提交 seed 密码；只在 dev-stub provider 下出现；不绕过 `login()`。证据：Q2、Q3。
- Selected Concurrency / shared state / ordering：匿名 info 读取与 Provider 单槽、login 锁、卸载 abort 的次序。证据：Q4、Q5、Q6。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：auth-router 与迁入用例全部改写不弱化；ui-walk 定位器不冲突。证据：对照表、3.3。
- Selected Error handling / rollback / partial outputs：info 失败或 malformed 静默不渲染、不重试；快捷登录失败走同一错误行。证据：Q2、Q5。
- Not selected Release / packaging / dependency compatibility：不加依赖。
- Selected Documentation / migration notes：测试夹具按路径路由的改写规则，供后续所有登录页测试沿用。证据：PR 迁移说明。
