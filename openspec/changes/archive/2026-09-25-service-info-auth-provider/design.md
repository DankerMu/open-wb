# Design: service-info-auth-provider（#285）

Change surface:
- server 源码：`server/src/auth/providers/dev-stub.ts`、`server/src/auth/index.ts`、`server/src/app.ts`。
- server 测试：`server/test/app.test.ts:244-245,591,626`、`server/test/http-guard.test.ts:178-179,205-206`，新文件 `server/test/auth-provider-name.test.ts`。
- web 源码：`web/src/lib/api.ts:24-27,182-197`。
- web 测试：`web/test/support.ts:11-14`、`web/test/api-info-logout.test.ts`（追加用例）、`web/test/auth-session-client.test.tsx:241,245`（fixture 与 `resolves.toEqual` 期望都改三键）、`web/test/auth-router.test.tsx:391`（改为从 `./support.js` 导入 `serviceInfo`，不增行）、`server/test/auth-provider.test.ts`（S4）、`web/test/routes.test.tsx:164-167`、`web/test/app-shell-responsive.test.tsx:58`、`web/test/topbar.test.tsx:72`。
- smoke：`smoke/public.hurl:12`。
- 不改：`createApp` 签名、`SERVICE_INFO`（`server/src/service-info.ts`）、`isSemver`、`server/test/http-guard-faults.test.ts`、`web/test/api.test.ts`、`web/src/features/**`、`Makefile`/CI/AGENTS（`scripts/test-ci-harness.sh` 不锚 info body）。

Must preserve:
- `SERVICE_INFO` 两键常量与 `service-info.test.ts` 不变。
- `/api/info` 无需认证；GET/HEAD 状态码与 no-store/guard 行为不变；HEAD content-length 等于 GET body 字节长度。
- auth 行为逐字节不变：login/logout/me 的 provider 调用、`passwordSource` 注入、dummy scrypt、错误映射；`authNow`、`principal` 装饰器；cookie 注册次序。provider 仍只创建一次，在同一 `db`/`passwordSource` 上创建。
- `createApp` 的 20+ 调用点不动。
- web：`getInfo` 的请求形状（relative path、`credentials:"same-origin"`、`cache:"no-store"`）、非 200 与 malformed 的失败映射 `requestFailed(200)`、关于卡展示 name 与 `版本 <version>`（不展示 provider）。
- `web/test/auth-router.test.tsx` 保持 800 行。
- 新增测试注释不含 `#NNN`。

Must add/change:
- `dev-stub.ts`：
  ```ts
  export interface DevStubProvider {
    readonly name: "dev-stub";
    verify(…): Promise<…>;
  }
  export function createDevStubProvider(db, passwordSource = scrypt): DevStubProvider {
    return { name: "dev-stub", async verify(…) { …同现状… } };
  }
  ```
- `auth/index.ts`：
  ```ts
  type AuthPluginOptions = AuthRegistrationOptions & { provider: DevStubProvider };
  export function registerAuth(app, options) {
    const provider = createDevStubProvider(options.db, options.passwordSource);
    app.decorateRequest("principal", null);
    app.decorate("authNow", options.runtime.now);
    app.decorate("authProviderName", provider.name);
    void app.register(fastifyCookie);
    void app.register(authPlugin, { ...options, provider });
  }
  async function authPlugin(instance, options: AuthPluginOptions) {
    const { provider } = options;   // 不再在子插件内创建
    …
  }
  ```
  `registerAuth` 头注释补一句：provider 在根上创建并 decorate 名称，经 options 传入封装子插件，子插件内 decorate 根实例读不到。
- `app.ts`：`interface FastifyInstance { …; authProviderName: string; }`；`app.get("/api/info", () => ({ ...SERVICE_INFO, auth: { provider: app.authProviderName } }));`。route 内不出现 `"dev-stub"` 字面量。
- `web/src/lib/api.ts`：
  ```ts
  export type ServiceInfo = { name: string; version: string; auth: { provider: string } };
  function parseServiceInfo(value: unknown): ServiceInfo | null {
    if (!hasExactlyKeys(value, ["name", "version", "auth"])) return null;
    const { name, version, auth } = value;
    if (typeof name !== "string" || name.length === 0 || typeof version !== "string") return null;
    if (!SERVICE_INFO_VERSION.test(version)) return null;
    if (!hasExactlyKeys(auth, ["provider"])) return null;
    const { provider } = auth;
    if (typeof provider !== "string" || provider.length === 0) return null;
    return { name, version, auth: { provider } };
  }
  ```
  `hasExactlyKeys` 已对非普通对象、数组、null 返回 false，沿用即可。若 biome 复杂度超 15，把 auth 校验抽成 `parseServiceAuth(value): { provider: string } | null`。
- `smoke/public.hurl:12`：`{"name":"workbuddy-app-server","version":"0.0.0","auth":{"provider":"dev-stub"}}`。
- server 测试期望：`app.test.ts`/`http-guard.test.ts` 定义 `const INFO_BODY = { ...SERVICE_INFO, auth: { provider: "dev-stub" } }`，原 `SERVICE_INFO` 期望换成 `INFO_BODY`，`JSON.stringify(INFO_BODY)`，content-length 仍由 `Buffer.byteLength` 算。两文件各自定义，或放进既有 server 测试 support；不新建共享常量模块，除非 jscpd 要求。
- web fixture：
  - `support.ts` 的 `serviceInfo` 改为三键；
  - `auth-router.test.tsx:391` 唯一方案：body 改用从 `./support.js` 导入的 `serviceInfo`（第 8 行已有 support 导入，扩一个名字），文件保持 800 行；
  - 其余内联字面量（`auth-session-client:241` 及其 `:245` 期望、`routes:164-167`、`app-shell-responsive:58`、`topbar:72`）加 `auth: { provider: "dev-stub" }`，biome 折行无妨。

Governing invariant: `/api/info` 成功 body 恰为 `{name, version, auth:{provider}}`。`name`/`version` 来自 `SERVICE_INFO`，`provider` 来自 `registerAuth` 装配的 provider 对象的 `name`，经根实例 decorator `authProviderName` 暴露；route、`createApp` 与 UI 都不硬编码。web 只接受恰为该形状的 body，其它一律 malformed。

Sibling surfaces:
- 2.4b（#299）：LoginForm 读 `auth.provider`。
- 2.5（#300）：设置页关于卡加 BrandMark，仍只展示 name/version。
- `web/src/features/auth/provider.tsx:330` `useServiceInfo` 与 `web/src/features/settings/page.tsx`：只透传类型，不改。
- S3a OIDC provider：`name: "oidc"`，届时接口改为联合类型。
- `server/test/service-info.test.ts`：不改。

Seams under test:
- (S1) 新 `server/test/auth-provider-name.test.ts`，根实例可见（本文件**不用** `vi.mock`；每个用例后 `vi.restoreAllMocks()`）：
  - `createApp({db, …})` ready 后 `app.hasDecorator("authProviderName")` 为 true，`app.authProviderName === "dev-stub"`；
  - 另起裸 `Fastify()` 调 `registerAuth(bare, {…})`，ready 后 `bare.authProviderName === "dev-stub"`，以此证明 decorate 发生在传入实例上，而非子插件。
- (S2) 同文件单个用例内，来源非硬编码：`import * as devStub from "../src/auth/providers/dev-stub.js"`，`const real = devStub.createDevStubProvider; const spy = vi.spyOn(devStub, "createDevStubProvider").mockImplementation((db, source) => ({ ...real(db, source), name: "probe-provider" }) as unknown as DevStubProvider)`（`name` 是字面量类型，probe 值需断言，不得为此把接口放宽成 `string`；命名空间 spy 先例 `server/test/server-assembly.test.ts:452`）；`createApp` 显式传入一个 `passwordSource`（真实 scrypt 包一层）。之后：
  - `GET /api/info` 的 JSON 为 `{ ...SERVICE_INFO, auth: { provider: "probe-provider" } }`；
  - HEAD content-length 等于该 body 的字节长度；
  - `spy` 恰被调用 1 次且 `toHaveBeenCalledWith(db, source)`——只创建一次、子插件没有另建（这是"同一 provider"的证明）；
  - 用 seed 账号 `zhangsan`/`demo` 登录仍成功（auth 行为未受上提影响）。
- (S3) `app.test.ts`（GET：`:244-245,591,626`）与 `http-guard.test.ts`（GET `:178-179`、HEAD `:205-206`）：既有 info 断言换成三键期望。`payload` exact 等于 `JSON.stringify(INFO_BODY)`；HEAD content-length 等于 `Buffer.byteLength(JSON.stringify(INFO_BODY))`。
- (S4) 既有 `server/test/auth-provider.test.ts` 追加：`createDevStubProvider(db).name === "dev-stub"`。
- (W1) `api-info-logout.test.ts` 追加以下 reject 用例（均映射 `requestFailed(200)`）：
  - 旧两键（由 `serviceInfo` 删去 `auth` 派生，不写字面量）；
  - `auth` 缺失；
  - `auth: null`；
  - `auth: []`；
  - `auth: "dev-stub"`；
  - `auth: {}`；
  - `auth: { provider: "" }`；
  - `auth: { provider: 3 }`；
  - `auth: { provider: "dev-stub", extra: 1 }`；
  - 顶层多余键。

  原 it.each 表里"a missing name/version"改为基于三键 `serviceInfo` 删键；"an extra field"保持。
- (W2) 同文件 accept：三键 `serviceInfo` resolve 为 `toEqual({ name, version, auth: { provider: "dev-stub" } })`；provider 为其它非空串，如 `oidc`，同样接受。web 不枚举 provider 值。
- (W3) 静态契约：
  - `smoke/public.hurl` 含三键 exact 行；
  - `web/test` 下 grep `name: "workbuddy-app-server", version: "0.0.0" }`（两键 info 字面量）零命中，模式在测试里拼接构造、不以完整字面量出现；
  - `server/src/app.ts` 的 info route 不含 `"dev-stub"`；
  - `server/src/auth/index.ts` 的 `authPlugin` 函数体内不含 `createDevStubProvider(`。

  这些断言放在 S1 文件；web 侧 grep 放在 `api-info-logout.test.ts`，用 `readRepoFile`/`listRepoFiles`。
- 既有：`settings-footer.test.tsx` 经 `support.ts` 自动三键全绿；关于卡成功路径展示 `workbuddy-app-server` 与 `版本 0.0.0`，不展示 `dev-stub`（补一条断言：关于卡文本不含 `dev-stub`）。
- smoke（CI `make smoke`）：`public.hurl` 三键 exact 通过。

Required evidence:
- 先红后绿：S1–S4、W1–W3 在实现前红（decorator 不存在、body 两键、旧形状仍被接受）；实现后 server 与 web 全绿。
- 反向注入各红并回退：
  1. `authProviderName` 的 decorate 挪进 `authPlugin`（`instance.decorate`）→ S1 红（根 `hasDecorator` 为 false），info body 的 `auth` 变为 `{}`，S3 红。
  2. info route 写死 `provider: "dev-stub"` → S2 红。
  3. `authPlugin` 仍自己创建 provider → S2 调用次数为 2，W3 源码契约红。
  4. `parseServiceInfo` 不查 `auth` 多余键 → W1 红。
  5. `parseServiceInfo` 接受两键旧形状 → W1 红。
  6. `public.hurl` 保留两键 → W3 红，CI smoke 红。
- `make check` exit 0（server 与 web 测试、size-guard、knip、jscpd、typecheck）；`npm run build --workspace web` exit 0；本地 `make smoke`，或 `ci-compiled-server.sh smoke`（CI 环境变量）exit 0；`wc -l web/test/auth-router.test.tsx` 仍为 800。

Non-goals：LoginForm 门控（2.4b）；关于卡展示 provider；OIDC；semver 正则去重；`createApp` 新参数。

Review focus：
0. 新增注释不含 `#NNN`。
1. decorate 的作用域：Fastify 封装语义下根实例可见，`hasDecorator` 与 route 闭包读值的时机（`registerAuth` 在 route 注册之前、ready 之后读值）。
2. provider 只创建一次，子插件复用同一对象，auth 行为零变化。
3. web 严格校验的完备性：`auth` 为 null、数组、原型污染对象，`provider` 为空，多余键。
4. 全部 info fixture 与 smoke 同步，无遗漏。
5. HEAD content-length 期望由 body 推导而非硬编码。
6. `ServiceInfo` 类型扩展对 `provider.tsx`/`settings/page.tsx` 零影响。
