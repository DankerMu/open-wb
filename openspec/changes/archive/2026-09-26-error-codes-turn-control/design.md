# Design: error-codes-turn-control（#450）

父设计：D1（`agent_capacity`）、D5（`approval_settled`）、D6（归属集六 → 十）。本文件只写本切片审查面。

- **Change surface**：`server/src/core/errors/index.ts`（definition map，公共类/码/文案唯一定义处）；`server/src/http/errors.ts`（状态映射、`CONTENT_PARSER_OWNED_ROUTES`、`routeOwnerResult`/`isConstructorBackedContentParserError` 判定与注释）。
- **Must preserve**：既有十一码的 status/message 逐字不变；既有六条归属身份与 allowlist（四个 `FST_ERR_CTP_*`，不含 `FST_ERR_VALIDATION`）不变；归属判定仍为「method === POST 且 matched route template 精确命中集合」；伪造 `code`/`statusCode` 的普通对象仍 generic 5xx；no-store 路由归属与 guard 次序不变；依赖方向 `http → core`。
- **Must add/change**：`agent_capacity`(503)、`approval_settled`(409) 两码；集合增四条模板字符串（与未来 Fastify 路由注册的 URL 模板逐字一致：`/api/sessions/:id/stop`、`/api/sessions/:id/regenerate`、`/api/sessions/:id/fork`、`/api/sessions/:id/approvals/:approvalId`）。
- **Governing invariant**：错误信封的 status 与 message 只由 typed code 经 definition map 决定；三种 409（`session_busy`/`conflict`/`approval_settled`）以 code 区分、互不伪装；content-parser 400 只授予精确十条归属身份。
- **Sibling surfaces**：
  - 生产者：`HttpError` 构造（core/errors）；将来的调用方 4.1/4.3（不在本刀）。
  - 映射器：`http/errors.ts` 的 `handleHttpError`（错误信封与归属判定）。
  - 消费者（既有测试）：`server/test/auth-lifecycle.test.ts:705` 的 `codes` 表带编译期双向穷尽守卫（`HttpCodesNotListed`），增码必使 `make typecheck` 失败——允许且仅允许为其补两条新码条目并把标题「恰十一码」改为「恰十三码」；`server/test/app.test.ts:20` `ERROR_CASES`（非穷尽数组，十一例仍真）、`:280/:306` 与 `auth-request-errors.test.ts:648-651`（十一种穿过 auth 接缝）保持不动，十三码的完整覆盖由新测试文件承担；`workspace-http-errors.test.ts` 等对六条归属的真实 HTTP 用例保持不动；web 端只消费信封 `message` 文案（`web/src` 无错误码联合），本刀无 web 改动；容量 503 内联文案归 7.2。
  - 失败路径：未分类 programmer error、伪造 code/statusCode、非 POST 与 lookalike（如具体 id 的 raw URL、尾斜杠、`/api/sessions/:id/stopx`）。
- **Seams under test**（写死，避免与 5.1a/5.1b/5.2a/5.2b 未来注册的真实路由冲突 `FST_ERR_DUPLICATED_ROUTE`）：沿用 `server/test/auth-request-errors.test.ts:440-515` 先例——直接调用共享 `handleHttpError(genuineCtpError, requestShaped(routeUrl, method), reply)`（`captureReply` 捕获），不挂载产品端点、不在 `/api/sessions/*` 上注册探针路由；十三码信封经裸 `fastify()` + `setErrorHandler(handleHttpError)` 的非 sessions 测试路由（如 `/api/test-errors/:code`）；no-store 经 `registerAuth` + `mapAuthError: () => new HttpError(code)`（`withMapperFailingApp` 先例）POST `/api/auth/login`。所需 helper（`captureReply`/`requestShaped`/`genuineEmptyJsonCtpError`/`expectGeneric` 等）在新文件内复制（既有文件不可改），属允许的小重复，须保持 jscpd ≤3%。不为测试新增 `CONTENT_PARSER_OWNED_ROUTES` 导出。四种 allowlisted CTP 错误须以 `fastify.errorCodes.FST_ERR_CTP_*` 构造真实实例（不得 `Object.assign` 伪造）。
- **Required evidence**：
  - 十三码逐一：测试路由抛 `HttpError(code)` → status/`{error:{code,message}}` 与 spec 码表逐字相等，body 无 Fastify 默认字段（`statusCode`/`error` 字符串/`message` 顶层）。
  - `HttpError("agent_capacity")` → 503 精确信封；`HttpError("approval_settled")` → 409 精确信封；普通对象 `{code:"agent_capacity",statusCode:503}` / `{code:"approval_settled",statusCode:409}` → generic 5xx，body 不含任何 typed code。
  - 归属集「恰十条」的证据形态：十条身份（既有六 + 四新模板）逐一以 `POST` + 模板 routeUrl 调 `handleHttpError`，四种 allowlisted `FST_ERR_CTP_*` 错误 → exact 400 `bad_request` 信封；四新模板的 `GET`/`PUT`、尾斜杠（`/api/sessions/:id/stop/`）、lookalike（`/api/sessions/:id/stopx`、`/api/sessions/:id/approvals`）、raw-concrete id（`/api/sessions/abc/stop`）及一个已注册但不归属的模板 → generic 500 且不回显细节。
  - no-store：`agent_capacity`、`approval_settled` 各经 `registerAuth` + `mapAuthError` 的 POST `/api/auth/login` → exact 503/409 信封、`cache-control: no-store`、无 `set-cookie`。
  - 红/绿分类：正向断言（两新码信封、no-store 两例、四新身份 400）必须先对未改源码跑红；负向守卫（伪造普通对象、非 POST/lookalike/raw-concrete/非归属）在未改源码上本就为 generic 500，标为「守卫，预期始终为绿」，无需伪造红。
- **Non-goals**：真实路由注册、bodyless 拒 body 语义、web 文案。
- **Review focus**：409 按 code 区分无状态码反查；集合字符串与未来路由模板一致；注释中的六 → 十同步；未扩大 allowlist。
