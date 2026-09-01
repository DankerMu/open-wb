# Spec: http-service-skeleton

## ADDED Requirements

### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例（feature 模块以 plugin 注册、配置可注入），并以 `server/src/server.ts` 作为唯一监听入口；监听地址与端口、SQLite 路径、静态根 SHALL 来自环境变量并有默认值；启动日志 SHALL 输出已注册模块清单。

#### Scenario: 干净启动
- WHEN 以默认配置执行启动命令（`make dev` 或 `npm run start --workspace server`）
- THEN 进程持续监听配置端口，且 `GET /api/healthz` 返回 200（启动行为由 smoke 对真实进程验证）

### Requirement: 健康与服务信息端点
系统 SHALL 提供 `GET /api/healthz`（无需认证）与 `GET /api/info`（无需认证，返回 exact SERVICE_INFO）；info 成功 body SHALL 恰为 `{name:string,version:string}`，`name` 非空且 `version` 符合 `server/src/service-info.ts` 的 semver 规则。可注入 app 装配 SHALL 接收 caller-owned SQLite handle、以名为 `db` 的 Fastify decorator 保持同一对象 identity，并不得在 `app.close()` 时关闭该 handle。

#### Scenario: 健康检查
- WHEN 通过 `createApp({db, staticRoot})` 注入请求 `GET /api/healthz`
- THEN 返回 200 与 exact `{"status":"ok"}`，且 DB 不变

#### Scenario: 服务信息
- WHEN 请求 `GET /api/info`
- THEN 返回 200，body exact 等于 `server/src/service-info.ts` 的 `SERVICE_INFO` 且恰为 `{name,version}`；`name` 非空、`version` 符合 semver，两值不得由 route/UI 硬编码

#### Scenario: caller 保留 DB 所有权
- WHEN app ready 后读取 `db` decorator、重复 inject 并执行 `app.close()`
- THEN decorator 与传入 handle 是同一对象，close 后 caller 仍可查询并自行关闭它

### Requirement: 统一错误信封
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为 `bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)；处理器 SHALL 落在 `http/` 横切层。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 matched route identity 恰为 `POST /api/auth/login` 或 `POST /api/auth/logout` 时，才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。Login/logout 不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist，避免把可伪造的普通 Error shape当作受信 request error。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。相同 allowlisted parser/media 错误若发生在 matched `/api`/`/api/*` catch-all 或未匹配的 non-GET miss，SHALL 恢复既有 typed `not_found` 404；发生在其他已注册 route 时保持 generic 5xx。不得回显 parser/schema/password 细节；具有相同 status/statusCode 或伪造 code 的任意 programmer error不得被误标成五种语义错误，仍为 5xx。

#### Scenario: 五码信封形状一致
- WHEN 测试路由分别抛出五种 typed application error
- THEN 响应 status/code/message 与 definition map exact 对应，body 仅含 `{error:{code,message}}`，无 Fastify 默认 error 字段

#### Scenario: auth POST 请求 parse/validation 错误稳定映射
- WHEN `/api/auth/login` 收到 empty/malformed JSON、unsupported media type、不符合手写 exact body validator 的 JSON 或超过 16 KiB body limit，或 bodyless `/api/auth/logout` 收到任意 parsed body/empty-or-malformed JSON/unsupported media/超过其最小合法 body limit
- THEN 不论 Fastify raw status 是否为 400/413/415，均按显式 typed error 或 exact matched auth-route-scoped allowlisted Fastify error code 返回 exact 400 `bad_request` 信封，不回显 validation/parser 详情或请求中的密码；错误发生在 logout cookie lookup/DELETE/clear-cookie 前
- WHEN 相同 allowlisted malformed/media/body 错误发生在 matched `/api`/`/api/*` catch-all 或未匹配的 non-GET miss
- THEN 返回既有 exact typed `not_found` 404；不得因 content parser 先于 catch-all handler 而成为 400/500
- WHEN 相同错误发生在 exact POST login/logout 之外的其他已注册 route，或 programmer error 仅携带 `statusCode=400/413` /伪造 allowlist code/validation-shaped fields
- THEN 保持 generic 5xx，不得被 auth POST request-error mapper 改写

#### Scenario: 意外错误不伪装
- WHEN API route 抛出未分类的 programmer error
- THEN 返回 5xx，且 body 不得声称五个 typed semantic code 中任一个

### Requirement: core/db 迁移基座
`core/db` SHALL 暴露 `openDb(path)`：打开 SQLite（WAL）、按文件序执行 `migrations/*.sql`、以迁移版本表保证幂等。

#### Scenario: 迁移幂等
- WHEN 对同一数据库路径连续调用两次 `openDb`
- THEN 第二次不重复执行任何迁移，且表结构与第一次一致

#### Scenario: 内存库可测
- WHEN 以 `:memory:` 打开
- THEN 全部迁移成功执行（单测经此 seam 验证）

### Requirement: 静态托管与 history fallback
系统 SHALL 从可选 operator-configured `STATIC_ROOT` 托管常规静态文件；当 root 为存在目录且包含常规 `index.html` 时，仅非 `/api` 命名空间的 GET miss SHALL 返回该 index（200）。Exact `/api` 与所有 `/api/*`（含 query/encoded path）优先于静态文件与 fallback；未知 API、非 GET miss、不可用 fallback 均返回 typed `not_found` 404。Absent、nonexistent、non-directory、index-less root 不得阻断 app readiness、health 或 info。

#### Scenario: 静态文件与深链刷新
- WHEN existing root 含 regular `index.html` 与 asset，分别 GET asset、`/files`、`/files/` 与 `/files?tab=1`
- THEN asset 返回自身 exact bytes/content type，三个 deep link 均返回 exact index bytes

#### Scenario: API namespace 永远优先且分类工作有界
- WHEN root 内存在 `api/no-such` 文件或 index，客户端请求 exact `/api`、`/api/no-such`、其 query/一至四轮 encoded bypass，以及约 8KB 的更深 nested encoding
- THEN API/encoded 变体均返回 JSON `not_found` 404、不返回文件或 index，深层输入在最多四次 decode 后 fail closed 而不继续按层分配；known health/info 仍返回自身 body

#### Scenario: 静态根不可用不阻断 app
- WHEN `staticRoot` absent、nonexistent、为 regular file、或目录缺 regular index
- THEN app ready 且 health/info 200；fallback 不可用时 deep-link miss 返回 JSON 404；index-less 目录内的其他 regular asset 仍可直接 GET

#### Scenario: 非 GET 不回退
- WHEN 以 POST 或 HEAD 请求未命中的非 API 路径
- THEN 返回 404、不得返回 index body；POST 使用 exact JSON `not_found` envelope，HEAD 保持无响应体的 HTTP 语义

#### Scenario: 静态 pathname identity 不分裂
- WHEN root 含普通 asset、percent-named symlink ancestor、root/nested dotfile 与 root 外 sentinel，并请求 literal、one-pass encoded、multi-encoded、traversal 或 separator 变体
- THEN one-pass safe asset 可按同一 normalized pathname 返回；multi-encoded non-API path 与所有 dotfile/symlink/traversal 变体均 typed 404，不得包含 hidden/sentinel/index bytes；validation、symlink/existence checks 与 `sendFile` 不得消费不同 pathname identity
