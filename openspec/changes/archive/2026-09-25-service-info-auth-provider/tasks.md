# Tasks: service-info-auth-provider（#285）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×1）；`openspec validate service-info-auth-provider --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新 `server/test/auth-provider-name.test.ts`（S1/S2 + W3 server 侧契约）；`auth-provider.test.ts` 追加 S4；`app.test.ts`/`http-guard.test.ts` 改三键期望（S3）；`api-info-logout.test.ts` 追加 W1/W2 与 W3 web 侧 grep；`support.ts` 与五处内联 fixture 改三键；`public.hurl` 三键。先红。
- [x] 2.2 server：`dev-stub.ts` `name`；`auth/index.ts` provider 上提 + `decorate("authProviderName")` + 子插件经 options 取 provider；`app.ts` module 声明 + info route。
- [x] 2.3 web：`api.ts` `ServiceInfo` 三键 + `parseServiceInfo` 严格校验。2.1 转绿，server/web 全绿。
- [x] 2.4 反向注入六项各红并回退（design Required evidence）。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 smoke：`public.hurl` 三键通过（本地 `make smoke` 或 CI 等价脚本）；`wc -l web/test/auth-router.test.tsx` 为 800。

## Risk pack mapping
- Selected Public API / CLI / script entry：`GET /api/info` 公开响应形状变更；`ServiceInfo` 类型；`FastifyInstance.authProviderName`。证据：S1–S3、W1–W2、smoke。
- Not selected Config / project setup：不加依赖、不加 env、不改 `createApp` 参数。
- Not selected File IO / path safety / overwrite：无。
- Selected Schema / columns / units / field names：响应新增嵌套字段 `auth.provider`，web 严格三键。证据：W1/W2/W3。
- Selected Auth / permissions / secrets：provider 创建位置上提、子插件改用传入的 provider；provider 名公开但不含配置值或密钥。证据：S2（登录仍成功、只创建一次）、既有 auth 测试全绿。
- Not selected Concurrency / shared state / ordering：decorate 在 route 注册前同步完成，无并发面（Review focus 1 覆盖时机）。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：旧两键形状在 web 端被刻意判为 malformed，所有 fixture 同 PR 迁移。证据：W1、W3 grep、既有套件全绿。
- Selected Error handling / rollback / partial outputs：malformed 映射 `requestFailed(200)`，关于卡回退文案不变。证据：W1、既有 settings-footer。
- Not selected Release / packaging / dependency compatibility：无外部消费者（父 design 风险表）。
- Selected Documentation / migration notes：`auth.provider` 契约与 provider 名来源，供 2.4b 与 S3a 使用。证据：PR 迁移预告。
