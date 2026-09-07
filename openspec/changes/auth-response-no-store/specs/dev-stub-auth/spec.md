## ADDED Requirements

### Requirement: 认证会话响应不可存储

系统 SHALL 对 matched exact `POST /api/auth/login`、`GET /api/auth/me` 与 `POST /api/auth/logout` 的每个最终响应发送精确 `Cache-Control: no-store`。该要求 SHALL 在内容解析、认证 guard 与 handler 之前生效，因此覆盖成功响应、端点自身产生的认证/业务错误、受信内容解析错误和内部错误；它 SHALL NOT 扩大为全局 `/api/*`、静态资源或 method/path lookalike 的缓存策略。除新增该响应头外，既有状态码、Principal、统一错误信封、Set-Cookie/clear-cookie、会话写入/删除、TTL、惰性清理及故障回滚语义 SHALL 保持不变。

#### Scenario: 登录所有终态不可存储
- **WHEN** exact `POST /api/auth/login` 分别产生 200 成功、手写或 native parser 400 `bad_request`、401 `invalid_credentials`、403 `account_disabled` 或内部 5xx
- **THEN** 每个最终响应都含精确 `Cache-Control: no-store`，且原有 body、cookie 与数据库副作用逐值不变

#### Scenario: 查询当前会话所有终态不可存储
- **WHEN** exact `GET /api/auth/me` 分别处理有效、缺失、畸形、unknown、expired、disabled、orphan、已登出 cookie 或存储故障
- **THEN** 每个最终响应都含精确 `Cache-Control: no-store`，且原有 Principal、401/5xx、惰性清理与 clear-cookie 语义逐值不变

#### Scenario: 登出所有终态不可存储
- **WHEN** exact `POST /api/auth/logout` 分别产生成功 204、认证 401、native parser 400 或存储 5xx
- **THEN** 每个最终响应都含精确 `Cache-Control: no-store`，且原有会话删除、empty body 与 clear-cookie/rollback 语义逐值不变

#### Scenario: 非认证路由不继承策略
- **WHEN** 请求 healthz、info、静态资源、非 auth API，或 method/path 不匹配的 auth lookalike
- **THEN** 响应不因本要求获得 `Cache-Control: no-store`
