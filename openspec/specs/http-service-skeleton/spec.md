# http-service-skeleton Specification

## Purpose
Define the application server's startup, health, persistence and static-serving contracts together with canonical typed error envelopes, trusted parser ownership, and explicit core-versus-HTTP responsibility boundaries.
## Requirements
### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例，并以 `server/src/server.ts` 作为唯一 production listen/DB ownership 入口；import该module只暴露pure config seam，不得mkdir/open/listen或注册signal，只有ESM main guard命中的执行路径可启动。唯一配置源为 own environment keys `HOST`、`PORT`、`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`、`OMP_STATE_DIR`、`OMP_IDLE_MS`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`、`MODEL_ID`：缺省值分别为 `127.0.0.1`、`3000`、repo-root `var/dev.db`、repo-root `web/dist`、repo-root `var/omp/omp`、repo-root `var/omp-state`、`600000`、repo-root `var/sandbox`、未配置、未配置、`deepseek-v4.1-flash`；relative DB/static/omp/state/sandbox path SHALL 相对由 entry module identity 推导的repo root，不得随shell/npm workspace cwd分裂。`PORT` SHALL只接受canonical ASCII decimal `1..65535`；HOST missing取默认、empty或whitespace-only非法且不得trim/coerce，其它nonempty string原样交listen；DB/static/omp/state/sandbox path explicit empty非法。`OMP_IDLE_MS` SHALL只接受canonical ASCII decimal整数1..2147483647（原生计时器上限，用户明确批准超限启动失败）；非法值的配置错误SHALL命名该键而不含输入值。`MODEL_UPSTREAM_BASE_URL`/`MODEL_UPSTREAM_API_KEY`缺省合法，显式empty非法；未同时配置时代理仍先鉴权（无效bearer401，通过鉴权后502），不得阻止服务启动。全部config SHALL在任何filesystem/database/listen effect前验证。

对于non-`:memory:` DB path，入口SHALL recursive创建且只创建missing `dirname(DB_PATH)`，随后由唯一`openDb`创建/打开exact file；不得创建`STATIC_ROOT`。Exact `:memory:` SHALL保留SQLite特殊identity且不得mkdir。DB parent为existing non-directory、不可创建/写入或DB/migration不合法 SHALL走同一partial-start failure cleanup，不得fallback到默认路径。

`npm run start --workspace server` SHALL在clean checkout先以现有TypeScript compiler构建production-only JS并把tracked `migrations/`完整递归tree逐文件逐字节带入与compiled module相同的runtime位置，再执行compiled唯一入口；`make dev` SHALL只转发到该command，不得形成第二套启动逻辑。成功顺序 SHALL为validated config → DB-parent prepare → DB open/migrate → createApp（auth → http guard → model-proxy → sessions，sessions先对账后开放路由）→ listen → application-owned stdout一行LF-terminated exact JSON `{"event":"server_started","host":"<actual>","port":<integer>,"modules":["core/db","auth","http","model-proxy","sessions"]}`，不得有extra key或在listen前/应用stderr出现。Package-manager command banner不属于application record。

Runtime config/DB/app/listen/success-record任一步失败 SHALL不输出success record，以nonzero退出，并在stderr sink可写时由application-owned stderr输出一行LF-terminated exact generic JSON `{"event":"server_start_failed"}`（无extra key/原始error/config）；若stderr sink自身不可写，该行物理不可达，系统仍SHALL nonzero、释放资源且不得产生unhandled stream stack。Node `node:sqlite` ExperimentalWarning MAY作为平台warning另出stderr。任意success/failure stream均不得dump environment或包含cookie/password/session值、MODEL_UPSTREAM_API_KEY值或会话bearer。Application stdout/stderr record SHALL经受管writer处理sync throw、write callback与stream error，settle exact一次且不得泄漏raw EPIPE。

失败清理 SHALL关闭当前入口已拥有的app/DB；每个entry SHALL把同一AbortSignal传给Fastify listen，SIGINT/SIGTERM先abort pending bind再经共享幂等shutdown停止已绑定listener、最后关闭唯一DB handle并正常退出。Signal落在listen invoke与实际bind之间时不得后到绑定、不得输出success/failure record，port/DB须可由successor立即复用。`.gitignore` SHALL排除default `var/` runtime output，knip SHALL把`src/server.ts`识别为entry。

#### Scenario: 干净启动与一致命令面
- WHEN 从repo root执行`make dev`或`npm run start --workspace server`，或build后从foreign cwd直接执行absolute `dist/server.js`，且未设置十一项配置
- THEN 三种启动形状消费同一entry/config identity，监听`127.0.0.1:3000`；只在repo-root recursive创建`var/`并使`var/dev.db`完成tracked migrations；不创建missing `web/dist`；`GET /api/healthz`返回exact200；application stdout只在listen成功后出现上述exact startup record；SIGTERM后端口与DB均可立即由后继进程重用

#### Scenario: override、非法配置与部分启动失败
- WHEN以可用custom host/port、absolute或relative DB/static/omp/state/sandbox路径及模型配置启动
- THENoverride逐项原样生效，relative path仍绑定repo root；只创建non-memory DB的exact parent、绝不创建STATIC_ROOT或误建default DB；build output中的完整migration tree与tracked source inventory/bytes一致，health/info/auth/static合同保持
- WHEN`PORT`为empty/whitespace/sign/fraction/exponent/zero/out-of-range，HOST为empty/whitespace-only，DB/static/omp/state/sandbox path为explicit empty，OMP_IDLE_MS为empty/0/abc/负数/小数/非canonical或大于2147483647的整数，上游变量为explicit empty，或import `server.ts`但不命中main guard
- THENmain-path非法config在任何filesystem/database/listen副作用前nonzero，application stderr恰一行上述generic failure record且无success；import-without-main保持silent且无filesystem/database/listen/signal副作用
- WHENDB parent为file/不可创建、DB open/migration失败、HOST由listen拒绝、port已占用或post-listen stdout sink失败
- THEN进程nonzero且stderr可写时只有generic failure record；stdout EPIPE不得输出raw stack；关闭所有已拥有的app/DB，不遗留可监听server或active SQLite handle，parent/static/default路径无额外副作用；stderr同时不可写时允许无record但同样nonzero/cleanup
- WHEN SIGINT/SIGTERM 落在listen invoke后、实际bind前，或成功后重复/混合到达
- THEN pending bind由同一AbortSignal取消且无startup record，或已绑定listener幂等关闭；两种情况下均先释放port再关DB并正常退出，successor可立即复用exact port/DB

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
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为 `bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)、`session_busy`(409, `会话正在生成，请稍候`)、`agent_unavailable`(502, `Agent 运行时不可用`)、`sandbox_denied`(403, `目标路径不在你的沙箱内，操作已拒绝`)、`conflict`(409, `同名资源已存在`)、`preview_too_large`(413, `文件过大，无法预览`)、`preview_unsupported`(415, `该类型不支持预览`)；公共类、代码与消息 SHALL 仅定义在 `core/errors`；状态码、parser ownership与处理器 SHALL 落在 `http/` 横切层，不保留旧路径兼容导出。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 matched route identity 恰为精确六条归属身份 `POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt`、`POST /v1/chat/completions`、`POST /api/workspaces` 或 `POST /api/workspaces/:id/dirs` 时，才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。归属身份对应的合同不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist，避免把可伪造的普通 Error shape当作受信 request error。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。其他原始API namespace的protected request在root preParsing guard前不解析body：未认证先返回401；通过guard后，相同parser/media错误若发生在matched `/api`/`/api/*` catch-all，恢复既有typed `not_found` 404，发生在归属集之外其他已注册API route保持generic5xx。原始non-API unmatched non-GET miss无论是否携cookie都绕过guard、零session query并保持既有typed404。不得回显parser/schema/password/session细节；具有相同status/statusCode或伪造code的任意programmer error不得被误标成十一种语义错误，仍为5xx。

#### Scenario: 十一码信封形状一致
- WHEN 测试路由分别抛出十一种 typed application error
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
- WHEN有效会话携相同错误访问六条归属POST身份之外的其他已注册protected API route，或programmer error仅携带`statusCode=400/413`/伪造allowlist code/validation-shaped fields
- THEN保持generic5xx，不得被auth POST request-error mapper或guard改写

#### Scenario: 意外错误不伪装
- WHEN API route 抛出未分类的 programmer error
- THEN 返回 5xx，且 body 不得声称十一个 typed semantic code 中任一个

#### Scenario: 未来路由身份在共享映射器中的归属
- WHEN genuine allowlisted Fastify content-parser error is mapped for POST matched /api/sessions/:id/prompt or /v1/chat/completions, /api/workspaces or /api/workspaces/:id/dirs before those product routes are implemented
- THEN the mapper returns exact400 bad_request without rawdetails; nonPOST, lookalike/raw-concrete identities and registered unowned routes staygeneric500; this change SHALL NOT mount any of these product endpoints

#### Scenario: Cache policy remains route-owned
- WHEN each of the eleven typed errors passes through an existing no-store-owning route and the shared mapper
- THEN the response preserves exact Cache-Control no-store and exact typed envelope, without widening that route's auth error vocabulary
- WHEN an existing non-auth route emits401/204 without its own cache policy
- THEN it SHALL NOT inherit auth no-store or clear-cookie side effects; this additive mapper change SHALL NOT install a global cache hook

#### Scenario: 工作空间 parser owner 的真实 HTTP 边界
- WHEN test-only matched POST /api/workspaces and /api/workspaces/:id/dirs receive genuine malformed/empty/unsupported/oversized content-parser errors through createApp with a real login cookie
- THEN exact400 bad_request is returned before their handlers run; the six-owner policy retains existing four owners and does not mount product workspace routes
- WHEN the same parser failures hit a registered non-POST or lookalike route, or an owner handler throws a forged parser/code/status/validation-shaped programmer error
- THEN the existing generic500 boundary remains and raw internal details are not disclosed
- WHEN unauthenticated requests hit those test-only protected workspace routes with invalid bodies
- THEN the existing guard returns401 before parser or handler work

### Requirement: core/db 迁移基座
`core/db` SHALL 暴露 `openDb(path)`：打开 SQLite（WAL）、按文件序执行 `migrations/*.sql`、以迁移版本表保证幂等。

#### Scenario: 迁移幂等
- WHEN 对同一数据库路径连续调用两次 `openDb`
- THEN 第二次不重复执行任何迁移，且表结构与第一次一致

#### Scenario: 内存库可测
- WHEN 以 `:memory:` 打开
- THEN 全部迁移成功执行（单测经此 seam 验证）

### Requirement: 静态托管与 history fallback
系统 SHALL 从可选 operator-configured `STATIC_ROOT` 托管常规静态文件；当 root 为存在目录且包含常规 `index.html` 时，仅非 `/api` 命名空间的 GET miss SHALL 返回该 index（200）。Exact `/api` 与所有 `/api/*`（含 query/encoded path）始终优先于静态文件与 fallback；#19后受保护的未知API先经默认guard：未认证返回typed `unauthorized` 401，有效会话通过guard后返回typed `not_found` 404。非GET非API miss与不可用fallback仍返回typed `not_found` 404。Absent、nonexistent、non-directory、index-less root 不得阻断 app readiness、health 或 info。

#### Scenario: 静态文件与深链刷新
- WHEN existing root 含 regular `index.html` 与 asset，分别 GET asset、`/files`、`/files/` 与 `/files?tab=1`
- THEN asset 返回自身 exact bytes/content type，三个 deep link 均返回 exact index bytes

#### Scenario: API namespace 永远优先且分类工作有界
- WHEN root 内存在 `api/no-such` 文件或 index，客户端以无会话或有效会话请求 exact `/api`、`/api/no-such`、其 literal query、1–4轮encoded path与decoded-query bypass（如`/api%3Fx=1`、`/%61pi%3Fx=1`），并另请求约8KB的更深nested encoding与`/files%3Ftab=1`
- THEN exact、1–4轮encoded与post-decode routed exact `/api` identity永不返回文件/index：无会话返回JSON `unauthorized` 401，有效会话通过guard后返回JSON `not_found` 404；`/files%3Ftab=1`保持non-API fallback；更深输入在最多四次decode后作为unsafe fail-closed typed404而不继续按层分配或查询session，其他原始non-API unsafe identity同样404；known health/info保持自身body且不查询session

#### Scenario: 静态根不可用不阻断 app
- WHEN `staticRoot` absent、nonexistent、为 regular file、或目录缺 regular index
- THEN app ready 且 health/info 200；fallback 不可用时 deep-link miss 返回 JSON 404；index-less 目录内的其他 regular asset 仍可直接 GET

#### Scenario: 非 GET 不回退
- WHEN 以 POST 或 HEAD 请求未命中的非 API 路径
- THEN 返回 404、不得返回 index body；POST 使用 exact JSON `not_found` envelope，HEAD 保持无响应体的 HTTP 语义

#### Scenario: 静态 pathname identity 不分裂
- WHEN root 含普通 asset、percent-named symlink ancestor、root/nested dotfile 与 root 外 sentinel，并请求 literal、one-pass encoded、multi-encoded、traversal 或 separator 变体
- THEN one-pass safe asset 可按同一 normalized pathname 返回；multi-encoded non-API path 与所有 dotfile/symlink/traversal 变体均 typed 404，不得包含 hidden/sentinel/index bytes；validation、symlink/existence checks 与 `sendFile` 不得消费不同 pathname identity

### Requirement: 公共错误类型归属 core
The canonical HttpError class, error codes and messages SHALL reside in core/errors and SHALL be usable by core modules without importing http or feature modules. HTTP status codes, content-parser ownership and reply mapping SHALL remain in http. Existing callers SHALL migrate atomically to the sole core export; http SHALL NOT retain compatibility class/type re-exports. Existing name/code/message identity, five-code HTTP status/envelope/no-store behavior and generic failure handling SHALL remain unchanged.

#### Scenario: 核心错误贯穿既有信封
- WHEN core emits an existing typed application error and HTTP maps it
- THEN the mapper recognizes the canonical constructor and preserves its existing status, exact message/envelope and no-store response; plain forged code/status objects remain generic server errors

#### Scenario: 分层无旧导出
- WHEN application, guards and existing tests use the shared error API after cutover
- THEN all use core/errors directly, with no duplicate error implementation or reverse core dependency, and existing HTTP regression suites pass

### Requirement: Shared agent module assembly
createApp SHALL always register model-proxy then sessions after auth and the HTTP guard, before catch-all/static routes, using one shared TokenRegistry. Sessions SHALL reconcile before accepting requests. App close SHALL reuse the existing module preClose cleanup without closing caller-owned DB. No startup process or agent directories SHALL be created by merely configuring/registering modules; lazy runtime spawn retains directory ownership. The five-module startup record SHALL correspond to the actual composition, not only a hardcoded list. This slice SHALL NOT claim post-listen models.yml publication, SSE or full active-runtime signal acceptance (issue #102/#103).
#### Scenario: Authenticated session and bearer proxy coexist
- WHEN a real createApp is created with caller DB and injected trusted runtime/registry settings
- THEN session routes use cookie/owner guards, proxy uses the same runtime-issued bearer rather than cookie auth, health/info/static behavior remains unchanged and app.close leaves DB usable
#### Scenario: Missing upstream remains an available app
- WHEN either upstream setting is absent
- THEN startup and authenticated session CRUD remain available; invalid bearer receives401 before parser/config work, a registered live bearer receives502 and the secret value is absent from startup/failure output
#### Scenario: Pure source and compiled configuration identity
- WHEN the existing pure resolver receives defaults/overrides for all eleven keys at source and compiled entry URLs from unrelated cwd
- THEN each of the seven added defaults and overrides is observed unchanged, path identity remains rooted at the entry's repository and unknown environment keys are ignored without filesystem/listen/signal side effects

