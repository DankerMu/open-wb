## MODIFIED Requirements

### Requirement: 统一错误信封
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为**十三码**：`bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)、`session_busy`(409, `会话正在生成，请稍候`)、`agent_unavailable`(502, `Agent 运行时不可用`)、`sandbox_denied`(403, `目标路径不在你的沙箱内，操作已拒绝`)、`conflict`(409, `同名资源已存在`)、`preview_too_large`(413, `文件过大，无法预览`)、`preview_unsupported`(415, `该类型不支持预览`)、`agent_capacity`(503, `Agent 容量已满，请稍后重试`)、`approval_settled`(409, `该审批已处理`)；`session_busy`、`conflict` 与 `approval_settled` 共享 409 状态但 code/message 各自独立，映射 SHALL 以 code 而非状态码区分。公共类、代码与消息 SHALL 仅定义在 `core/errors`；状态码、parser ownership与处理器 SHALL 落在 `http/` 横切层，不保留旧路径兼容导出。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 method 与 matched route identity 合起来恰为精确十二条归属身份 `POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt`、`POST /v1/chat/completions`、`POST /api/workspaces`、`POST /api/workspaces/:id/dirs`、`POST /api/sessions/:id/stop`、`POST /api/sessions/:id/regenerate`、`POST /api/sessions/:id/fork`、`POST /api/sessions/:id/approvals/:approvalId`、`POST /api/sessions` 或 `PATCH /api/sessions/:id` 时（method 为归属身份的一部分：映射不再只认 POST，`PATCH /api/sessions/:id` 以 PATCH 归属，其余十一条以 POST 归属），才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。bodyless 的 `POST /api/sessions/:id/stop` 与 `POST /api/sessions/:id/regenerate` 按 `POST /api/auth/logout` 先例属于归属集：任意 parsed body（含 `{}`）、empty-or-malformed JSON、unsupported media 或超过其最小合法 body limit 均为 exact 400 `bad_request`，发生在任何 supervisor 调用、omp 帧或数据库写入之前。`POST /api/sessions` 是**可选 body** 的归属路由：无 body（无 Content-Type 且无内容）为合法请求，按默认值创建；一旦携带 body，则必须为 `application/json` 且解析成功，empty-or-malformed JSON、unsupported media 或超过其 body limit 均为 exact 400 `bad_request`，发生在任何会话行、审计行写入之前——它不适用 stop/regenerate 的「任意 parsed body 即 400」规则，parsed body 交由 session-metadata 的手写 exact validator 判定。`PATCH /api/sessions/:id` 在 owner 预检（未知或属他人 → 与未知 id 相同的 404，先于 body 解析）之后，其 content-parser 错误同样为 exact 400 `bad_request`，无写入。`DELETE /api/sessions/:id` 不读取 body、**不**属于归属集：该路由不注册 body 语义，请求携带的格式良好的 body 被忽略，不因 body 改变其 204/404/409 行为；body 引发的 genuine allowlisted content-parser 错误（malformed JSON、空 JSON body、不支持的媒体类型、超限）按非归属已注册路由语义保持 generic 500（见 Scenario「产品路由身份在共享映射器中的归属」），不执行任何删除步骤。归属身份对应的合同不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist，避免把可伪造的普通 Error shape当作受信 request error。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。其他原始API namespace的protected request在root preParsing guard前不解析body：未认证先返回401；通过guard后，相同parser/media错误若发生在matched `/api`/`/api/*` catch-all，恢复既有typed `not_found` 404，发生在归属集之外其他已注册API route保持generic5xx。原始non-API unmatched non-GET miss无论是否携cookie都绕过guard、零session query并保持既有typed404。不得回显parser/schema/password/session细节；具有相同status/statusCode或伪造code的任意programmer error不得被误标成十三种语义错误，仍为5xx。

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
- **WHEN** 有效会话携相同错误访问十二条归属身份之外的其他已注册protected API route，或programmer error仅携带`statusCode=400/413`/伪造allowlist code/validation-shaped fields
- **THEN** 保持generic5xx，不得被auth POST request-error mapper或guard改写

#### Scenario: 意外错误不伪装
- **WHEN** API route 抛出未分类的 programmer error
- **THEN** 返回 5xx，且 body 不得声称十三个 typed semantic code 中任一个

#### Scenario: 产品路由身份在共享映射器中的归属
- **WHEN** genuine allowlisted Fastify content-parser error is mapped for the production-mounted POST matched /api/sessions/:id/prompt, /v1/chat/completions, /api/workspaces, /api/workspaces/:id/dirs, /api/sessions/:id/stop, /api/sessions/:id/regenerate, /api/sessions/:id/fork, /api/sessions/:id/approvals/:approvalId or /api/sessions, or the PATCH matched /api/sessions/:id
- **THEN** the mapper returns exact400 bad_request without rawdetails; a method other than the owner identity's own method (for example PATCH /api/sessions, POST /api/sessions/:id, DELETE /api/sessions/:id), lookalike/raw-concrete identities and registered unowned routes staygeneric500; ownership is decided solely by the shared mapper's exact twelve-identity (method + route) set, not by whichever module registered the route

#### Scenario: Cache policy remains route-owned
- **WHEN** each of the thirteen typed errors passes through an existing no-store-owning route and the shared mapper
- **THEN** the response preserves exact Cache-Control no-store and exact typed envelope, without widening that route's auth error vocabulary
- **WHEN** an existing non-auth route emits401/204 without its own cache policy
- **THEN** it SHALL NOT inherit auth no-store or clear-cookie side effects; this additive mapper change SHALL NOT install a global cache hook

#### Scenario: 工作空间 parser owner 的真实 HTTP 边界
- **WHEN** the production POST /api/workspaces and /api/workspaces/:id/dirs routes mounted by createApp (16 KiB body limit, route-owned no-store) receive genuine malformed/empty/unsupported/oversized content-parser errors with a real login cookie
- **THEN** exact400 bad_request is returned before their handlers run, with the route's own no-store preserved; the twelve-owner policy covers these two identities alongside the ten other owners
- **WHEN** the same parser failures hit a registered non-POST or lookalike route (proved by explicitly registered test probes), or an owner handler throws a forged parser/code/status/validation-shaped programmer error
- **THEN** the existing generic500 boundary remains and raw internal details are not disclosed
- **WHEN** unauthenticated requests hit those protected production workspace routes with invalid bodies
- **THEN** the existing guard returns401 before parser or handler work

#### Scenario: 回合控制 parser owner 的真实 HTTP 边界
- **WHEN** the production POST /api/sessions/:id/fork and /api/sessions/:id/approvals/:approvalId routes mounted by createApp receive genuine malformed/empty/unsupported/oversized content-parser errors with a real owner cookie
- **THEN** exact400 bad_request with the route's no-store is returned before any supervisor call, omp frame or database write
- **WHEN** malformed, empty or unsupported-media inputs arrive unauthenticated on any of the four routes, or with a foreign/unknown session id
- **THEN** 401 respectively the identical 404 is returned before parser or handler work

#### Scenario: bodyless 归属路由拒绝任何 body
- **WHEN** the bodyless production POST /api/sessions/:id/stop or /api/sessions/:id/regenerate receives, with a real owner cookie on a running or done session, any parsed body (including `{}`), an empty or malformed JSON body, an unsupported media type or a body above its minimal legal body limit
- **THEN** like bodyless `/api/auth/logout`, exact400 bad_request with the route's no-store is returned before any supervisor call, `abort`/`branch` frame or database write, and the same request without a body keeps its normal behaviour

#### Scenario: 会话元数据 parser owner 的真实 HTTP 边界
- **WHEN** the production POST /api/sessions mounted by createApp receives, with a real owner cookie, a malformed JSON body, an empty body declared `application/json`, a `text/plain` body or a body above its limit
- **THEN** exact400 bad_request with no-store is returned and no session row or audit row is written
- **WHEN** the same route receives no body at all (no Content-Type, no content), or the JSON body `{}`
- **THEN** 201 with the default session view (`scene` and `workspaceId` null) is returned
- **WHEN** the production PATCH /api/sessions/:id receives the same four content-parser failures on an owned session
- **THEN** exact400 bad_request with no-store is returned and the session row is unchanged; on a foreign or unknown id the identical404 not_found is returned before parsing; unauthenticated requests on either route receive401 before parsing
- **WHEN** DELETE /api/sessions/:id is sent with a JSON body on an owned idle session
- **THEN** the body is ignored and the route returns204 exactly as without a body; DELETE is not part of the parser-owner set
- **WHEN** DELETE /api/sessions/:id is sent on an owned idle session with `Content-Type: application/json` and a malformed JSON body
- **THEN** the content-parser error stays generic500 (the non-owner mapping of 「产品路由身份在共享映射器中的归属」, not a400 envelope), the session row, its audit trail and any live process are unchanged, and a following bodyless DELETE returns204
