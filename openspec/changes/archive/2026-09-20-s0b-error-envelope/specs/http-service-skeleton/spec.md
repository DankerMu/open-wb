## MODIFIED Requirements

### Requirement: 统一错误信封
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为 `bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)、`session_busy`(409, `会话正在生成，请稍候`)、`agent_unavailable`(502, `Agent 运行时不可用`)；公共类、代码与消息 SHALL 仅定义在 `core/errors`；状态码、parser ownership与处理器 SHALL 落在 `http/` 横切层，不保留旧路径兼容导出。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 matched route identity 恰为精确四条归属身份 `POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt` 或 `POST /v1/chat/completions` 时，才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。归属身份对应的合同不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist，避免把可伪造的普通 Error shape当作受信 request error。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。其他原始API namespace的protected request在root preParsing guard前不解析body：未认证先返回401；通过guard后，相同parser/media错误若发生在matched `/api`/`/api/*` catch-all，恢复既有typed `not_found` 404，发生在归属集之外其他已注册API route保持generic5xx。原始non-API unmatched non-GET miss无论是否携cookie都绕过guard、零session query并保持既有typed404。不得回显parser/schema/password/session细节；具有相同status/statusCode或伪造code的任意programmer error不得被误标成七种语义错误，仍为5xx。

#### Scenario: 七码信封形状一致
- WHEN 测试路由分别抛出七种 typed application error
- THEN 响应 status/code/message 与 definition map exact 对应，body 仅含 `{error:{code,message}}`，无 Fastify 默认 error 字段

#### Scenario: auth POST 请求 parse/validation 错误稳定映射
- WHEN `/api/auth/login` 收到 empty/malformed JSON、unsupported media type、不符合手写 exact body validator 的 JSON 或超过 16 KiB body limit，或 bodyless `/api/auth/logout` 收到任意 parsed body/empty-or-malformed JSON/unsupported media/超过其最小合法 body limit
- THEN 不论 Fastify raw status 是否为 400/413/415，均按显式 typed error 或 exact matched auth-route-scoped allowlisted Fastify error code 返回 exact 400 `bad_request` 信封，不回显 validation/parser 详情或请求中的密码；错误发生在 logout cookie lookup/DELETE/clear-cookie 前
- WHEN 未认证请求携相同 malformed/media/body 输入访问original API namespace的受保护matched `/api`/`/api/*` catch-all或其他protected API route
- THEN guard在content parser前返回exact401 unauthorized；不得被raw parser status改写为400/404/500
- WHEN无论有无cookie，相同输入访问original non-API unmatched non-GET miss
- THEN绕过guard且零session query，保持既有exact typed `not_found` 404
- WHEN有效会话携相同输入访问matched `/api`/`/api/*` catch-all
- THEN通过guard后返回既有exact typed `not_found` 404；不得因content parser先于catch-all handler而成为400/500
- WHEN有效会话携相同错误访问四条归属POST身份之外的其他已注册protected API route，或programmer error仅携带`statusCode=400/413`/伪造allowlist code/validation-shaped fields
- THEN保持generic5xx，不得被auth POST request-error mapper或guard改写

#### Scenario: 意外错误不伪装
- WHEN API route 抛出未分类的 programmer error
- THEN 返回 5xx，且 body 不得声称七个 typed semantic code 中任一个

#### Scenario: 未来路由身份在共享映射器中的归属
- WHEN genuine allowlisted Fastify content-parser error is mapped for POST matched /api/sessions/:id/prompt or /v1/chat/completions before those product routes are implemented
- THEN the mapper returns exact400 bad_request without rawdetails; nonPOST, lookalike/raw-concrete identities and registered unowned routes staygeneric500; this change SHALL NOT mount either product endpoint

#### Scenario: Cache policy remains route-owned
- WHEN each of the seven typed errors passes through an existing no-store-owning route and the shared mapper
- THEN the response preserves exact Cache-Control no-store and exact typed envelope, without widening that route's auth error vocabulary
- WHEN an existing non-auth route emits401/204 without its own cache policy
- THEN it SHALL NOT inherit auth no-store or clear-cookie side effects; this additive mapper change SHALL NOT install a global cache hook

