# Spec delta: http-service-skeleton（#450 十三码与十条归属集）

> 父 delta「统一错误信封」由 #450（码表与归属集成员）与 5.1a/5.1b/5.2a/5.2b（四条路由的真实 HTTP 边界、bodyless 拒 body）分担；本 delta 不含后者的 bodyless 规则句与两个路由级 Scenario，由对应路由 issue 归档时 MODIFIED 并入。

## MODIFIED Requirements

### Requirement: 统一错误信封
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为**十三码**：`bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)、`session_busy`(409, `会话正在生成，请稍候`)、`agent_unavailable`(502, `Agent 运行时不可用`)、`sandbox_denied`(403, `目标路径不在你的沙箱内，操作已拒绝`)、`conflict`(409, `同名资源已存在`)、`preview_too_large`(413, `文件过大，无法预览`)、`preview_unsupported`(415, `该类型不支持预览`)、`agent_capacity`(503, `Agent 容量已满，请稍后重试`)、`approval_settled`(409, `该审批已处理`)；`session_busy`、`conflict` 与 `approval_settled` 共享 409 状态但 code/message 各自独立，映射 SHALL 以 code 而非状态码区分。公共类、代码与消息 SHALL 仅定义在 `core/errors`；状态码、parser ownership与处理器 SHALL 落在 `http/` 横切层，不保留旧路径兼容导出。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 matched route identity 恰为精确十条归属身份 `POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt`、`POST /v1/chat/completions`、`POST /api/workspaces`、`POST /api/workspaces/:id/dirs`、`POST /api/sessions/:id/stop`、`POST /api/sessions/:id/regenerate`、`POST /api/sessions/:id/fork` 或 `POST /api/sessions/:id/approvals/:approvalId` 时，才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。归属身份对应的合同不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist，避免把可伪造的普通 Error shape当作受信 request error。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。其他原始API namespace的protected request在root preParsing guard前不解析body：未认证先返回401；通过guard后，相同parser/media错误若发生在matched `/api`/`/api/*` catch-all，恢复既有typed `not_found` 404，发生在归属集之外其他已注册API route保持generic5xx。原始non-API unmatched non-GET miss无论是否携cookie都绕过guard、零session query并保持既有typed404。不得回显parser/schema/password/session细节；具有相同status/statusCode或伪造code的任意programmer error不得被误标成十三种语义错误，仍为5xx。

#### Scenario: 十一码信封形状一致
- **WHEN** 测试路由分别抛出原有十一种 typed application error
- **THEN** 响应 status/code/message 与 definition map exact 对应，body 仅含 `{error:{code,message}}`，无 Fastify 默认 error 字段

#### Scenario: 新增两码信封形状一致
- **WHEN** 测试路由分别抛出 `HttpError("agent_capacity")` 与 `HttpError("approval_settled")`
- **THEN** 响应分别为 503 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}` 与 409 `{error:{code:"approval_settled",message:"该审批已处理"}}`，无 Fastify 默认 error 字段；伪造 `{code:"agent_capacity",statusCode:503}` 的普通对象仍为 generic 5xx

#### Scenario: auth POST 请求 parse/validation 错误稳定映射
- **WHEN** `/api/auth/login` 收到 empty/malformed JSON、unsupported media type、不符合手写 exact body validator 的 JSON 或超过 16 KiB body limit，或 bodyless `/api/auth/logout` 收到任意 parsed body/empty-or-malformed JSON/unsupported media/超过其最小合法 body limit
- **THEN** 不论 Fastify raw status 是否为 400/413/415，均按显式 typed error 或 exact matched auth-route-scoped allowlisted Fastify error code 返回 exact 400 `bad_request` 信封，不回显 validation/parser 详情或请求中的密码；错误发生在 logout cookie lookup/DELETE/clear-cookie 前
- **WHEN** 未认证请求携相同 malformed/media/body 输入访问original API namespace的受保护matched `/api`/`/api/*` catch-all或其他protected API route
- **THEN** guard在content parser前返回exact401 unauthorized；不得被raw parser status改写为400/404/500
- **WHEN** 无论有无cookie，相同输入访问original non-API unmatched non-GET miss
- **THEN** 绕过guard且零session query，保持既有exact typed `not_found` 404
- **WHEN** 有效会话携相同输入访问matched `/api`/`/api/*` catch-all
- **THEN** 通过guard后返回既有exact typed `not_found` 404；不得因content parser先于catch-all handler而成为400/500
- **WHEN** 有效会话携相同错误访问十条归属POST身份之外的其他已注册protected API route，或programmer error仅携带`statusCode=400/413`/伪造allowlist code/validation-shaped fields
- **THEN** 保持generic5xx，不得被auth POST request-error mapper或guard改写

#### Scenario: 意外错误不伪装
- **WHEN** API route 抛出未分类的 programmer error
- **THEN** 返回 5xx，且 body 不得声称十三个 typed semantic code 中任一个

#### Scenario: 产品路由身份在共享映射器中的归属
- **WHEN** genuine allowlisted Fastify content-parser error is mapped for the production-mounted POST matched /api/sessions/:id/prompt, /v1/chat/completions, /api/workspaces, /api/workspaces/:id/dirs, /api/sessions/:id/stop, /api/sessions/:id/regenerate, /api/sessions/:id/fork or /api/sessions/:id/approvals/:approvalId
- **THEN** the mapper returns exact400 bad_request without rawdetails; nonPOST, lookalike/raw-concrete identities and registered unowned routes staygeneric500; ownership is decided solely by the shared mapper's exact ten-identity set, not by whichever module registered the route

#### Scenario: Cache policy remains route-owned
- **WHEN** each of the thirteen typed errors passes through an existing no-store-owning route and the shared mapper
- **THEN** the response preserves exact Cache-Control no-store and exact typed envelope, without widening that route's auth error vocabulary
- **WHEN** an existing non-auth route emits401/204 without its own cache policy
- **THEN** it SHALL NOT inherit auth no-store or clear-cookie side effects; this additive mapper change SHALL NOT install a global cache hook

#### Scenario: 工作空间 parser owner 的真实 HTTP 边界
- **WHEN** the production POST /api/workspaces and /api/workspaces/:id/dirs routes mounted by createApp (16 KiB body limit, route-owned no-store) receive genuine malformed/empty/unsupported/oversized content-parser errors with a real login cookie
- **THEN** exact400 bad_request is returned before their handlers run, with the route's own no-store preserved; the ten-owner policy covers these two identities alongside the eight other owners
- **WHEN** the same parser failures hit a registered non-POST or lookalike route (proved by explicitly registered test probes), or an owner handler throws a forged parser/code/status/validation-shaped programmer error
- **THEN** the existing generic500 boundary remains and raw internal details are not disclosed
- **WHEN** unauthenticated requests hit those protected production workspace routes with invalid bodies
- **THEN** the existing guard returns401 before parser or handler work
