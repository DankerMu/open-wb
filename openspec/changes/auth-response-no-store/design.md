## Context

当前 `GET /api/auth/me` 与 `POST /api/auth/logout` 在 route-local `onRequest` 设置 `Cache-Control: no-store`，因此 guard、parser、handler 和统一错误处理产生的终态都保留该头。`POST /api/auth/login` 只在会话写入成功后设置该头，400/401/403 与 5xx 提前退出路径没有同一保证。身份响应的缓存策略属于 auth route owner，不能扩大到全局 `/api/*`。

Fixture level: expanded
Repair intensity: high
Project profile: Generic（TypeScript Web 服务 + Python 知识库，多子系统）

## Goals / Non-Goals

**Goals:**
- 三个 exact auth route 的每个端点自身终态都返回精确 `Cache-Control: no-store`。
- 在 Fastify 内容解析前设置登录响应头，使 native parser 错误也满足契约。
- 保留所有既有状态码、body、cookie、数据库与会话生命周期语义。
- 证明该策略不泄漏到 health、info、静态资源、非 auth API 或 auth lookalike 路径。

**Non-Goals:**
- 不设置全局 API、代理或 CDN 缓存策略。
- 不修改 web `fetch` cache 选项、OIDC、CSRF 或其他安全响应头。
- 不改变认证凭证校验、会话 schema、TTL 或 guard 豁免规则。

## Decisions

1. 在 login route options 增加与 me/logout 同构的 route-local `onRequest`，移除成功 handler 中较晚的重复设置。该 hook 在 content parser 与 handler 前运行，统一覆盖业务异常、parser 异常与内部异常；全局 hook 会错误扩大作用域，逐个 throw 分支设置则易遗漏。
2. 响应头契约按 Fastify matched exact route 归属。query string 仍属于该 route；method、尾斜杠或 lookalike 不匹配时不得继承。
3. 测试通过公共 `createApp` + `app.inject()` seam 观察完整响应。login 覆盖 200、手写 400、native parser 400、401、403 与代表性 5xx；me/logout 保留已有矩阵并补齐必要断言；控制组覆盖 health、info、静态资源及非 auth API。
4. 规范以 `dev-stub-auth` 新增独立要求表达，不改写既有身份、错误或会话要求，避免归档时丢失现有细节。

## Risk Packs Considered

- Public API / CLI / script entry: selected - 三个公共 HTTP endpoint 新增精确响应头契约。
- Config / project setup: not selected - 无配置或命令面变化。
- File IO / path safety / overwrite: not selected - 不新增文件运行时读写或路径处理。
- Schema / columns / units / field names: not selected - body、cookie 与数据库 schema 不变。
- Auth / permissions / secrets: selected - 响应包含身份和会话有效性信息。
- Concurrency / shared state / ordering: not selected - 不改变事务、guard 或共享状态顺序。
- Resource limits / large input / discovery: not selected - 既有 login body limit 原样保留，仅观察其错误响应。
- Legacy compatibility / examples: selected - 既有客户端依赖的状态、body、cookie 与会话副作用必须逐项保持。
- Error handling / rollback / partial outputs: selected - 头必须覆盖 parser、业务与内部错误且不得改变会话副作用。
- Release / packaging / dependency compatibility: not selected - 无依赖或产物结构变化。
- Documentation / migration notes: selected - 主 OpenSpec 规范需成为长期契约；无需部署迁移。
- Tenant/sandbox isolation: not selected - 不触及 tenant、workspace 或文件边界。
- Auth/session lifecycle: selected - 覆盖 login、me、logout 的完整终态但冻结生命周期语义。
- Process/child-environment isolation: not selected - 不触及子进程。
- SQLite migration/catalog compatibility: not selected - 无 schema 或 migration 改动。
- Server/web HTTP-envelope compatibility: selected - header 新增，现有 response body/error envelope 必须兼容。
- Offline deployability: not selected - 无网络或依赖变化。
- Browser runtime/navigation/persistence: not selected - 前端行为不变，服务端头由 inject seam 验证。
- Cross-service boundary: not selected - 不触及 kbservice 或 omp 网络契约。

## Invariant Matrix

Governing invariant: exact auth route 一旦匹配，无论成功、认证/业务拒绝、内容解析失败或内部失败，其最终响应都含且仅含精确 `Cache-Control: no-store`；非 auth route 不因本策略获得该头。
Source-of-truth identity/contract: Fastify matched method + route identity，以及 route-local `onRequest` 设置的 `Cache-Control` 值。

Surfaces:
- Producers: `server/src/auth/index.ts` 中 login/me/logout route options。
- Validators/preflight: Fastify content parser、login exact-body validator、root auth guard。
- Storage/cache/query: login session INSERT、me lookup/expired cleanup、logout DELETE；语义保持不变。
- Public routes/entrypoints: `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`。
- Frontend/downstream consumers: `web/src/lib/api.ts` 既有状态/body/cookie消费保持兼容。
- Failure paths/rollback/stale state: typed auth errors、native parser errors、统一 HTTP error handler、数据库失败。
- Evidence/audit/readiness: `server/test/auth-login.test.ts`、`auth-request-errors.test.ts`、`auth-lifecycle.test.ts`、`app.test.ts` 及 server coverage。

Regression rows:
- exact auth route + 每类成功/失败输入 -> 原有终态不变并返回精确 `no-store`。
- method/path lookalike、health/info/static/non-auth API -> 不继承 auth 专属 `no-store`。
- me/logout 既有有效、过期、撤销与 storage-fault lane -> header、cookie 与数据库语义保持兼容。

## Boundary-Surface Checklist

- Public entrypoints: 三个 exact auth route；method/path lookalike 为负向边界。
- Producer/consumer evidence boundaries: route-local hook到统一错误处理与最终 inject response。
- Stale-state/idempotency boundaries: me expired cleanup、logout missing/unknown/existing row 保持既有语义。
- Unchanged downstream consumers: web API client、health/info、static fallback、其他 API。

## Risks / Trade-offs

- [路由头意外全局化] → 只在各 auth route 的 `onRequest` 设置，并保留非 auth 控制组。
- [前移 hook 改变 body/cookie/DB 行为] → hook 仅写响应头；测试逐值复核原有终态和副作用。
- [错误处理覆盖响应头] → 通过真实 Fastify parser 与统一 error handler 的 inject 测试验证最终响应。

## Migration Plan

无数据迁移。部署可直接替换；回滚仅恢复 route option 与测试/spec commit，不涉及持久状态。
