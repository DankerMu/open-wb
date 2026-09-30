# Design: parser-owner-identities（#512）

父设计：design D2「`http/errors.ts`」与「为什么」（按方法 + 路由判定，避免同路由 DELETE 被 PATCH 映射覆盖）。行号为 origin/master。

- **Change surface**：`server/src/http/errors.ts` 的 `CONTENT_PARSER_OWNED_ROUTES`（:42-58）与 `routeOwnerResult`（:60-89）及其注释；新测试文件；`server/test/http-typed-errors.test.ts:190` 一行删除。
- **Must preserve**：
  - 四码 allowlist 与 `isConstructorBackedContentParserError`（构造器身份判定）不变；伪造 `code`/`statusCode` 的普通 Error 永不映射。
  - 判定顺序不变：非构造器 CTP 错误 → `null`；归属身份命中 → `bad_request`；matched `/api`、`/api/*` catch-all 或 unmatched non-GET（`routeOptions.url === undefined && method !== "GET"`）→ `not_found`；其余 → `null`（generic 500）。
  - A 的十条身份仍以 POST 映射 400；其非 POST 方法（`GET`/`PUT`/`DELETE` 等）打到这些模板仍 generic 500（`auth-request-errors.test.ts:459-470`、`http-typed-errors.test.ts` 的 `NON_OWNER_CASES` 除被删一条外全部保持）。
  - `handleHttpError`/`sendHttpError` 签名与错误码表（十三码）不变；typed `HttpError` 路由无关。
- **Must add/change**：
  - 身份键：`` `${method} ${routeTemplate}` ``，集合恰为十二条：`POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt`、`POST /v1/chat/completions`、`POST /api/workspaces`、`POST /api/workspaces/:id/dirs`、`POST /api/sessions/:id/stop`、`POST /api/sessions/:id/regenerate`、`POST /api/sessions/:id/fork`、`POST /api/sessions/:id/approvals/:approvalId`、`POST /api/sessions`、`PATCH /api/sessions/:id`。`DELETE /api/sessions/:id` 不在集合内。
  - `routeOwnerResult`：`routeUrl !== undefined && CONTENT_PARSER_OWNED_ROUTES.has(`${request.method} ${routeUrl}`)` → `bad_request`；不再单独判 `method === "POST"`。`request.method` 按 Fastify 原样（大写）比较，不做大小写归一。
- **Sibling surfaces**：
  - `server/src/sessions/rest.ts` 已注册 `POST /api/sessions`（不读 body、无 `bodyLimit`）：合入后其 malformed/empty/非 JSON body 为 400（预期）；本刀不为其设 `bodyLimit`（4.1）。
  - `server/test/http-typed-errors.test.ts:190` 的守卫 `["POST", "/api/sessions"]` 断言旧行为，必须删除；同文件其余条目（含 `TURN_CONTROL_OWNERS` 的 GET/PUT）保持。
  - 其它用 `POST /api/sessions` 的测试（`server-assembly.test.ts:153`、`session-rest.test.ts`、`server-startup-helpers.ts:239` 等）均不带 body，行为不变；`session-rest.test.ts:296-327` 带 malformed/超限 body 但未认证，root guard 先于 content parser 返回 401，不经映射器，行为不变。`http-typed-errors.test.ts:166` 的 describe 标题「恰十条身份」同刀改为「恰十二条身份」（仅标题）。
- **Required evidence**（`server/test/http-parser-owners.test.ts`；新文件自带 `captureReply`/`requestShaped`/信封断言等最小等价辅助，不从 `auth-request-errors.test.ts` 导出；每条先红后绿，回归护栏除外；证据 1 仅 `POST /api/sessions`、`PATCH /api/sessions/:id` 两条为实现前红；证据 2–6 为守卫、实现前即绿，其区分力来自 URL-only 变体（去 POST 门 + 加 URL）会令证据 2 与证据 3 的 GET/PUT 行变红）：
  1. 十二条身份 × 四个真实构造器 CTP 错误（`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_BODY_TOO_LARGE`，经 `fastify.errorCodes` 构造器实例化）→ 400，body 恰为 `{"error":{"code":"bad_request","message":"请求格式不正确"}}`，不含 raw 细节。实现前 `PATCH /api/sessions/:id` 与 `POST /api/sessions` 两条为红，其余十条为回归护栏。
  2. `DELETE /api/sessions/:id` × 四错误 → generic 500 `{"error":{"message":"服务器内部错误"}}`（与 PATCH 同模板而不被覆盖）。
  3. 非本身份方法：`PATCH /api/sessions`、`POST /api/sessions/:id`、`GET /api/sessions`、`GET /api/sessions/:id`、`PUT /api/sessions/:id`、`PUT /api/auth/logout`、`PATCH /api/sessions/:id/prompt` → generic 500；lookalike/raw-concrete：`POST /api/sessions/`、`PATCH /api/sessions/:id/`、`PATCH /api/sessions/abc`（raw concrete，非模板）→ generic 500；小写方法 `patch /api/sessions/:id` → generic 500。
  4. 伪造 `Object.assign(new Error(...), {code:"FST_ERR_CTP_INVALID_JSON_BODY", statusCode:400})` 打到 `POST /api/sessions` 与 `PATCH /api/sessions/:id` → generic 500。
  5. 回归：matched `/api`、`/api/*` 与 unmatched non-GET（`routeOptions.url` undefined、`PATCH`/`DELETE`）→ 404 `not_found`；unmatched `GET` → generic 500（现状）。
  6. 错误码表：`Object.keys(HTTP_ERROR_MESSAGES)` 恰十三码（按键集相等断言；与 `http-typed-errors.test.ts:114-120` 同义，作为 issue 要求的本文件守卫）。
  7. 既有 `auth-request-errors.test.ts` 零改动全绿；`http-typed-errors.test.ts` 仅删一行、其余全绿。
