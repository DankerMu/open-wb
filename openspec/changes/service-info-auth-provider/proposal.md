# Proposal: service-info-auth-provider（#285）

## Why
S1e 组 3（父 tasks 3.1），S1e 唯一的服务端改动。2.4b（#299）的快捷登录门控要知道当前装配的认证 provider，只有 `auth.provider === "dev-stub"` 时才渲染演示账号区。现状 `GET /api/info` 只返回 `SERVICE_INFO` 两键（`server/src/app.ts:147`），provider 在封装的 auth 子插件里创建（`server/src/auth/index.ts:171`），根实例读不到它。父 design 决策 7（D7）与父 http-service-skeleton delta 已规定形状与来源。

## What Changes
- `server/src/auth/providers/dev-stub.ts`：`DevStubProvider` 接口增 `readonly name: "dev-stub"`，`createDevStubProvider` 返回对象带 `name: "dev-stub"`。
- `server/src/auth/index.ts`：
  - `createDevStubProvider(options.db, options.passwordSource)` 从 `authPlugin` 上提到 `registerAuth`；
  - `registerAuth` 在根实例执行 `app.decorate("authProviderName", provider.name)`，先例是同处的 `authNow`；
  - provider 经 options 传入子插件（`void app.register(authPlugin, { ...options, provider })`），`authPlugin` 不再自己创建 provider。
- `server/src/app.ts`：`declare module "fastify"` 的 `FastifyInstance` 增 `authProviderName: string`；info route 返回 `{ ...SERVICE_INFO, auth: { provider: app.authProviderName } }`。不加 `createApp` 参数，`SERVICE_INFO` 常量本身不变。
- `web/src/lib/api.ts`：`ServiceInfo = { name: string; version: string; auth: { provider: string } }`；`parseServiceInfo` 做三键精确校验，`auth` 必须是恰含 `provider` 一键的普通对象，`provider` 为非空字符串；旧两键形状判为 malformed。
- 同 PR 更新 fixture：
  - `smoke/public.hurl` 的 exact body；
  - `server/test/app.test.ts` 的 GET info 期望与 `server/test/http-guard.test.ts` 的 GET/HEAD 期望（HEAD content-length 仍由 `Buffer.byteLength` 从期望 body 计算）；
  - `web/test/support.ts` 的共享 `serviceInfo`；
  - `web/test/{auth-session-client,auth-router,routes,app-shell-responsive,topbar}.test.tsx` 的内联 info fixture。
- 新测试：
  - `server/test/auth-provider-name.test.ts`：provider 名来自装配的 provider，在根实例可见（S4 的 `name` 单测进既有 `server/test/auth-provider.test.ts`）；
  - `web/test/api-info-logout.test.ts`：追加三键接受与旧形状、`auth` 变体拒绝用例。

## Non-goals
登录页门控 UI 与 LoginForm 读 info（2.4b #299）；关于卡展示 provider（spec 明确不展示）；任何其它端点；OIDC provider（S3a）；web 侧 semver 正则与 server `isSemver` 的重复（既有，范围外）。

## Capabilities
- MODIFIED `http-service-skeleton`：Requirement「健康与服务信息端点」与 Scenario「服务信息」改为三键形状，provider 名来自根实例 decorator。
- MODIFIED `spa-shell`：Requirement「设置页」只改关于卡接受句（三键、provider 不展示）与 Scenario「关于卡真实版本」「关于卡失败」（取父 delta），以晋升文本为底；外观卡、BrandMark（2.5）与登录页（2.4b）不在本 delta。父 tasks 2.5 明文"解析/类型改动属 3.1"。

## Impact
server：`auth/index.ts`、`auth/providers/dev-stub.ts`、`app.ts`，测试 `app.test.ts`、`http-guard.test.ts`，以及新文件 `auth-provider-name.test.ts`。web：`lib/api.ts`，测试 `support.ts`、`api-info-logout.test.ts`、`auth-session-client.test.tsx`、`auth-router.test.tsx`（改为导入 `support.ts` 的 `serviceInfo`，仍为 800 行）、`routes.test.tsx`、`app-shell-responsive.test.tsx`、`topbar.test.tsx`。另有 `smoke/public.hurl`。不加依赖，公开端点形状有破坏性变更，但无外部消费者（父 design 风险表）。

## 与 oracle 偏差留痕
- issue 列出的 `web/test/api.test.ts` 目前没有任何 info fixture（grep 零命中），本 PR 不改它。web 端 `parseServiceInfo` 的契约测试实际在 `api-info-logout.test.ts`。
- issue 未列、但持有两键 info fixture 的 `web/test/app-shell-responsive.test.tsx:58` 与 `web/test/topbar.test.tsx:72` 同 PR 改为三键。它们都挂 `/settings`，关于卡读取的正是这个 fixture；不改的话，这两处会带着一个已被判为 malformed 的旧形状，测试在错误前提下仍然是绿的。
- issue 列出的 `server/test/http-guard-faults.test.ts:113` 只断言 HEAD `/api/info` 的状态码，没有 body 或长度断言，因此不需要改。

## Risk triage
- 封装作用域：decorate 若放在 `authPlugin` 里，根实例读不到，info route 会拿到 `undefined`，`JSON.stringify` 后 `auth` 为 `{}`。S1 用 `hasDecorator` 断言根实例可见来钉住。
- 硬编码：route 或 UI 写死 `"dev-stub"` 也能让形状测试通过。S2 用用例内命名空间 spy 把 provider 名换成 probe 值来钉住。
- 严格校验漏判：`auth` 带多余键或 `provider` 为空仍被接受。W1 钉住。
- fixture 漏改：某个挂 `/settings` 的测试仍用旧形状。W3 grep 契约钉住。
