# Spec: http-service-skeleton

## ADDED Requirements

### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例（feature 模块以 plugin 注册、配置可注入），并以 `server/src/server.ts` 作为唯一监听入口；监听地址与端口、SQLite 路径、静态根 SHALL 来自环境变量并有默认值；启动日志 SHALL 输出已注册模块清单。

#### Scenario: 干净启动
- WHEN 以默认配置执行启动命令（`make dev` 或 `npm run start --workspace server`）
- THEN 进程持续监听配置端口，且 `GET /api/healthz` 返回 200（启动行为由 smoke 对真实进程验证）

### Requirement: 健康与服务信息端点
系统 SHALL 提供 `GET /api/healthz`（无需认证）与 `GET /api/info`（无需认证，返回 SERVICE_INFO 的名称与语义化版本）。

#### Scenario: 健康检查
- WHEN 请求 `GET /api/healthz`
- THEN 返回 200 与 `{"status":"ok"}`，且该请求不产生会话

#### Scenario: 服务信息
- WHEN 请求 `GET /api/info`
- THEN 返回 200，body 含 `name` 与符合 semver 的 `version`（复用 `server/src/service-info.ts`）

### Requirement: 统一错误信封
所有 `/api/*` 错误响应 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；本阶段错误码取值域为 `invalid_credentials`(401)、`account_disabled`(403)、`unauthorized`(401)、`not_found`(404)；处理器 SHALL 落在 `http/` 横切层（ADR-0006 语言中立 REST 约定的具体化）。

#### Scenario: 信封形状一致
- WHEN 分别触发 401、403、404 错误
- THEN 三个响应 body 均恰为 `{error:{code,message}}` 形状，code 属取值域，message 为中文文案

### Requirement: core/db 迁移基座
`core/db` SHALL 暴露 `openDb(path)`：打开 SQLite（WAL）、按文件序执行 `migrations/*.sql`、以迁移版本表保证幂等。

#### Scenario: 迁移幂等
- WHEN 对同一数据库路径连续调用两次 `openDb`
- THEN 第二次不重复执行任何迁移，且表结构与第一次一致

#### Scenario: 内存库可测
- WHEN 以 `:memory:` 打开
- THEN 全部迁移成功执行（单测经此 seam 验证）

### Requirement: 静态托管与 history fallback
系统 SHALL 托管静态根目录（`STATIC_ROOT` 可配置，生产/CI 指向 `web/dist`，单测可用夹具目录）；非 `/api/*` 的 GET 未命中静态文件时 SHALL 返回 index.html（200）；`/api/*` 未命中路由与非 GET 未命中 SHALL 返回错误信封 404。

#### Scenario: 深链刷新
- WHEN 浏览器直接请求 `/files`
- THEN 返回 index.html，SPA 接管路由

#### Scenario: API 404 不吞
- WHEN 请求 `GET /api/no-such`
- THEN 返回 404 与错误信封（code=not_found），不返回 index.html

#### Scenario: 非 GET 不回退
- WHEN 以 POST 请求一个未命中的非 API 路径
- THEN 返回错误信封 404，不返回 index.html
