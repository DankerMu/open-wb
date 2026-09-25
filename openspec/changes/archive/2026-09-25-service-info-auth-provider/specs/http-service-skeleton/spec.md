## MODIFIED Requirements
### Requirement: 健康与服务信息端点
系统 SHALL 提供 `GET /api/healthz`（无需认证）与 `GET /api/info`（无需认证，返回 exact SERVICE_INFO 与认证 provider 名）；info 成功 body SHALL 恰为 `{name:string,version:string,auth:{provider:string}}`，`name` 非空且 `version` 符合 `server/src/service-info.ts` 的 semver 规则，`auth.provider` 为 `registerAuth` 实际装配的认证 provider 对象的 `name`（provider 类型——现为 `DevStubProvider`——新增只读 `name`；dev-stub provider 为 `dev-stub`；S3a 的 OIDC 适配器为 `oidc`），由 `registerAuth` 在根实例上 `decorate("authProviderName", provider.name)`（provider 在 `registerAuth` 创建后传入封装的 auth 子插件，而非在子插件内创建，否则根实例读不到）暴露给 info route，不由 route、`createApp` 参数或 UI 硬编码，只读、不含任何配置值或密钥。可注入 app 装配 SHALL 接收 caller-owned SQLite handle、以名为 `db` 的 Fastify decorator 保持同一对象 identity，并不得在 `app.close()` 时关闭该 handle。

#### Scenario: 健康检查
- WHEN 通过 `createApp({db, staticRoot})` 注入请求 `GET /api/healthz`
- THEN 返回 200 与 exact `{"status":"ok"}`，且 DB 不变

#### Scenario: 服务信息
- WHEN 请求 `GET /api/info`
- THEN 返回 200，body 恰为 `{name,version,auth:{provider}}`：`name`/`version` exact 等于 `server/src/service-info.ts` 的 `SERVICE_INFO`，`name` 非空、`version` 符合 semver，`auth.provider` 等于 `registerAuth` 装配的 provider 的 `name`（当前唯一 provider 为 dev-stub，值 `dev-stub`）；HEAD 的 `content-length` 与新 body 一致；三值不得由 route/UI 硬编码；`smoke/public.hurl` 的 exact body 与 server/web 全部 info fixture 同 PR 更新为三键形状

#### Scenario: caller 保留 DB 所有权
- WHEN app ready 后读取 `db` decorator、重复 inject 并执行 `app.close()`
- THEN decorator 与传入 handle 是同一对象，close 后 caller 仍可查询并自行关闭它
