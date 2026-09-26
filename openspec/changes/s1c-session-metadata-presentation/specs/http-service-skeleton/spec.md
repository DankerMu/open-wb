# Spec delta: http-service-skeleton（S1c B 修改）

> 基线为 change A（`s1c-turn-control-governance`）对本能力的 delta：下列 Requirement 以 A 的重述文本为起点**整段重述**（含全部 Scenario，标题逐字保留），把「统一错误信封」的 parser-owner 归属集由 A 的十条扩为十二条（`POST /api/sessions`、`PATCH /api/sessions/:id`）并让映射按 method + route 判定；错误码表不变（十三码）。另以 A 的文本为起点重述「Shared agent module assembly」，只增补 createApp 把同一 workspace store 的 `rootOf` 交给 sessions。另以 A 的文本为起点重述「服务启动与装配」，只增补第十四个配置键 `MODEL_REASONING`（`on|off`，缺省 `on`）并把配置键计数改为十四。未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 统一错误信封
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为**十三码**：`bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)、`session_busy`(409, `会话正在生成，请稍候`)、`agent_unavailable`(502, `Agent 运行时不可用`)、`sandbox_denied`(403, `目标路径不在你的沙箱内，操作已拒绝`)、`conflict`(409, `同名资源已存在`)、`preview_too_large`(413, `文件过大，无法预览`)、`preview_unsupported`(415, `该类型不支持预览`)、`agent_capacity`(503, `Agent 容量已满，请稍后重试`)、`approval_settled`(409, `该审批已处理`)；`session_busy`、`conflict` 与 `approval_settled` 共享 409 状态但 code/message 各自独立，映射 SHALL 以 code 而非状态码区分。公共类、代码与消息 SHALL 仅定义在 `core/errors`；状态码、parser ownership与处理器 SHALL 落在 `http/` 横切层，不保留旧路径兼容导出。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 method 与 matched route identity 合起来恰为精确十二条归属身份 `POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt`、`POST /v1/chat/completions`、`POST /api/workspaces`、`POST /api/workspaces/:id/dirs`、`POST /api/sessions/:id/stop`、`POST /api/sessions/:id/regenerate`、`POST /api/sessions/:id/fork`、`POST /api/sessions/:id/approvals/:approvalId`、`POST /api/sessions` 或 `PATCH /api/sessions/:id` 时（method 为归属身份的一部分：映射不再只认 POST，`PATCH /api/sessions/:id` 以 PATCH 归属，其余十一条以 POST 归属），才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。bodyless 的 `POST /api/sessions/:id/stop` 与 `POST /api/sessions/:id/regenerate` 按 `POST /api/auth/logout` 先例属于归属集：任意 parsed body（含 `{}`）、empty-or-malformed JSON、unsupported media 或超过其最小合法 body limit 均为 exact 400 `bad_request`，发生在任何 supervisor 调用、omp 帧或数据库写入之前。`POST /api/sessions` 是**可选 body** 的归属路由：无 body（无 Content-Type 且无内容）为合法请求，按默认值创建；一旦携带 body，则必须为 `application/json` 且解析成功，empty-or-malformed JSON、unsupported media 或超过其 body limit 均为 exact 400 `bad_request`，发生在任何会话行、审计行写入之前——它不适用 stop/regenerate 的「任意 parsed body 即 400」规则，parsed body 交由 session-metadata 的手写 exact validator 判定。`PATCH /api/sessions/:id` 在 owner 预检（未知或属他人 → 与未知 id 相同的 404，先于 body 解析）之后，其 content-parser 错误同样为 exact 400 `bad_request`，无写入。`DELETE /api/sessions/:id` 不读取 body、**不**属于归属集：该路由不注册 body 语义，请求携带的 body 被忽略，不因 body 改变其 204/404/409 行为。归属身份对应的合同不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist，避免把可伪造的普通 Error shape当作受信 request error。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。其他原始API namespace的protected request在root preParsing guard前不解析body：未认证先返回401；通过guard后，相同parser/media错误若发生在matched `/api`/`/api/*` catch-all，恢复既有typed `not_found` 404，发生在归属集之外其他已注册API route保持generic5xx。原始non-API unmatched non-GET miss无论是否携cookie都绕过guard、零session query并保持既有typed404。不得回显parser/schema/password/session细节；具有相同status/statusCode或伪造code的任意programmer error不得被误标成十三种语义错误，仍为5xx。

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
- **WHEN** any of these inputs arrive unauthenticated on any of the four routes, or with a foreign/unknown session id
- **THEN** 401 respectively the identical 404 is returned before parser or handler work

#### Scenario: bodyless 归属路由拒绝任何 body
- **WHEN** the bodyless production POST /api/sessions/:id/stop or /api/sessions/:id/regenerate receives, with a real owner cookie on a running or done session, any parsed body (including `{}`), an empty or malformed JSON body, an unsupported media type or a body above its minimal legal body limit
- **THEN** like bodyless `/api/auth/logout`, exact400 bad_request with the route's no-store is returned before any supervisor call, `abort`/`branch` frame or database write, and the same request without a body keeps its normal 202/204 behaviour

#### Scenario: 会话元数据 parser owner 的真实 HTTP 边界
- **WHEN** the production POST /api/sessions mounted by createApp receives, with a real owner cookie, a malformed JSON body, an empty body declared `application/json`, a `text/plain` body or a body above its limit
- **THEN** exact400 bad_request with no-store is returned and no session row or audit row is written
- **WHEN** the same route receives no body at all (no Content-Type, no content), or the JSON body `{}`
- **THEN** 201 with the default session view (`scene` and `workspaceId` null) is returned
- **WHEN** the production PATCH /api/sessions/:id receives the same four content-parser failures on an owned session
- **THEN** exact400 bad_request with no-store is returned and the session row is unchanged; on a foreign or unknown id the identical404 not_found is returned before parsing; unauthenticated requests on either route receive401 before parsing
- **WHEN** DELETE /api/sessions/:id is sent with a JSON body on an owned idle session
- **THEN** the body is ignored and the route returns204 exactly as without a body; DELETE is not part of the parser-owner set

### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例，并以 `server/src/server.ts` 作为唯一 production listen/DB ownership 入口；import该module只暴露pure config seam，不得mkdir/open/listen或注册signal，只有ESM main guard命中的执行路径可启动。唯一配置源为 own environment keys `HOST`、`PORT`、`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`、`OMP_STATE_DIR`、`OMP_IDLE_MS`、`OMP_MAX_PROCESSES`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`、`MODEL_ID`、`OMP_USER`、`MODEL_REASONING`（共十四项）：缺省值分别为 `127.0.0.1`、`3000`、repo-root `var/dev.db`、repo-root `web/dist`、repo-root `var/omp/omp`、repo-root `var/omp-state`、`600000`、`16`、repo-root `var/sandbox`、未配置、未配置、`deepseek-v4.1-flash`、未配置（同uid直接spawn）、`on`；relative DB/static/omp/state/sandbox path SHALL 相对由 entry module identity 推导的repo root，不得随shell/npm workspace cwd分裂。`PORT` SHALL只接受canonical ASCII decimal `1..65535`；HOST missing取默认、empty或whitespace-only非法且不得trim/coerce；exact `localhost` SHALL 规范为 `127.0.0.1` 以保证单一 listener binding，其它nonempty string原样交listen；DB/static/omp/state/sandbox path explicit empty非法。`OMP_IDLE_MS` SHALL只接受canonical ASCII decimal整数1..2147483647（原生计时器上限，用户明确批准超限启动失败）；`OMP_MAX_PROCESSES` SHALL 遵守与 `OMP_IDLE_MS` 相同的解析纪律（canonical ASCII decimal 正整数 1..2147483647，缺省 16，empty/`0`/非 canonical/超限均为启动失败），经 `agent-config.ts` 同一 resolver 解析为 supervisor 的全局活进程上限；`MODEL_REASONING` SHALL 只接受 exact `on` 或 `off`（缺省 `on`；empty、大小写不同如 `ON`、`true`/`yes` 及其它任何值均为启动失败），经同一 resolver 解析为布尔并作为托管 models.yml 的 `reasoning` 输入（`on` → true、`off` → false，写出规则归 model-proxy）；非法值的配置错误SHALL命名该键而不含输入值。`MODEL_UPSTREAM_BASE_URL`/`MODEL_UPSTREAM_API_KEY`缺省合法，显式empty非法；未同时配置时代理仍先鉴权（无效bearer401，通过鉴权后502），不得阻止服务启动。OMP_USER及仅sudo模式的安全PATH前置条件 SHALL遵守主omp-uid-isolation规范，不在本切片重定义。全部config SHALL在任何filesystem/database/listen effect前验证。

对于non-`:memory:` DB path，入口SHALL recursive创建且只创建missing `dirname(DB_PATH)`，随后依主omp-uid-isolation「自有状态不对组可读」在openDb前准备exact主文件与既有sidecars为0600，再由唯一`openDb`打开exact file；不得创建`STATIC_ROOT`；监听成功后只额外创建`<OMP_STATE_DIR>/agent`并写托管models.yml，sandbox/session子目录仍由首次spawn或workspace创建按需经canonical ensureSharedDir创建，OMP_BIN目录不由启动创建。Exact `:memory:` SHALL保留SQLite特殊identity且不得mkdir。DB parent为existing non-directory、不可创建/写入或DB/migration不合法 SHALL走同一partial-start failure cleanup，不得fallback到默认路径。

`npm run start --workspace server` SHALL在clean checkout先以现有TypeScript compiler构建production-only JS并把tracked `migrations/`完整递归tree逐文件逐字节带入与compiled module相同的runtime位置，再执行compiled唯一入口；`make dev` SHALL只转发到该command，不得形成第二套启动逻辑。成功顺序 SHALL为validated config → DB-parent prepare → private-file preparation → DB open/migrate → createApp（auth → http guard → model-proxy → sessions → workspaces → accounts，sessions先对账后开放路由；workspace store/facade/audit绑定同一DB与runtime.sandboxRoot）→ listen → 以实际绑定地址推导可连接proxyBaseUrl并写`<OMP_STATE_DIR>/agent/models.yml` → application-owned stdout一行LF-terminated exact JSON `{"event":"server_started","host":"<actual>","port":<integer>,"modules":["core/db","auth","http","model-proxy","sessions","workspaces","accounts"]}`，不得有extra key或在listen前/应用stderr出现。Package-manager command banner不属于application record。

Runtime config/DB/app/listen/models.yml/success-record任一步失败 SHALL不输出success record，以nonzero退出，并在stderr sink可写时由application-owned stderr输出一行LF-terminated exact generic JSON `{"event":"server_start_failed"}`（无extra key/原始error/config）；若stderr sink自身不可写，该行物理不可达，系统仍SHALL nonzero、释放资源且不得产生unhandled stream stack。Node `node:sqlite` ExperimentalWarning MAY作为平台warning另出stderr。任意success/failure stream均不得dump environment或包含cookie/password/session值、MODEL_UPSTREAM_API_KEY值或会话bearer。Application stdout/stderr record SHALL经受管writer处理sync throw、write callback与stream error，settle exact一次且不得泄漏raw EPIPE。

失败清理 SHALL关闭当前入口已拥有的app/DB；每个entry SHALL把同一AbortSignal传给Fastify listen，SIGINT/SIGTERM只对pending bind执行abort；已绑定时SHALL经共享幂等shutdown先完成所有runtime原生退出及store回收，再停止listener，最后关闭唯一DB handle。不得让同一AbortSignal的Node原生close绕过runtime先行归属；重复/混合signal不得在清理期间重新abort已绑定listener。干净取消正常退出；已确定真实失败保持nonzero，不得被signal抹去failure record或降为0。Signal落在listen invoke与实际bind之间时不得后到绑定、不得输出success/failure record，port/DB须可由successor立即复用。`.gitignore` SHALL排除default `var/` runtime output，knip SHALL把`src/server.ts`识别为entry。

#### Scenario: 干净启动与一致命令面
- **WHEN** 从repo root执行`make dev`或`npm run start --workspace server`，或build后从foreign cwd直接执行absolute `dist/server.js`，且未设置十四项应用配置
- **THEN** 三种启动形状消费同一entry/config identity，监听`127.0.0.1:3000`，supervisor 的活进程上限为 16，托管models.yml的模型条目按 `MODEL_REASONING=on` 声明 reasoning；只在repo-root recursive创建`var/`并使`var/dev.db`完成tracked migrations；创建`var/omp-state/agent/models.yml`且baseUrl为实际端口的可连接回环地址；不创建missing `web/dist`/sandbox/bin；`GET /api/healthz`返回exact200；application stdout只在listen成功后出现上述exact startup record；SIGTERM后端口与DB均可立即由后继进程重用

#### Scenario: override、非法配置与部分启动失败
- **WHEN** 以可用custom host/port、absolute或relative DB/static/omp/state/sandbox路径、`OMP_MAX_PROCESSES`、`MODEL_REASONING=off` 及模型配置启动
- **THEN** override逐项原样生效（含上限值；`MODEL_REASONING=off` 时models.yml模型条目不含 reasoning 声明），relative path仍绑定repo root；只创建non-memory DB的exact parent与托管agent目录、绝不创建STATIC_ROOT或误建default DB；HOST=0.0.0.0时models.yml的baseUrl为http://127.0.0.1:<实际端口>/v1，IPv6通配绑定使用http://[::1]:<实际端口>/v1；build output中的完整migration tree与tracked source inventory/bytes一致，health/info/auth/static合同保持
- **WHEN** `PORT`为empty/whitespace/sign/fraction/exponent/zero/out-of-range，HOST为empty/whitespace-only，DB/static/omp/state/sandbox path为explicit empty，OMP_IDLE_MS为empty/0/abc/负数/小数/非canonical或大于2147483647的整数，OMP_MAX_PROCESSES为empty/0/abc/负数/小数/非canonical（如`016`、`+8`）或大于2147483647的整数，`MODEL_REASONING`为empty/`ON`/`true`/`yes`，上游变量为explicit empty，或import `server.ts`但不命中main guard
- **THEN** main-path非法config在任何filesystem/database/listen副作用前nonzero，application stderr恰一行上述generic failure record且无success；import-without-main保持silent且无filesystem/database/listen/signal副作用
- **WHEN** DB parent为file/不可创建、DB file创建/chmod失败、DB open/migration失败、HOST由listen拒绝、port已占用、models.yml不可写或post-listen stdout sink失败
- **THEN** 进程nonzero且stderr可写时只有generic failure record；stdout EPIPE不得输出raw stack；关闭所有已拥有的app/DB，不遗留可监听server、活跃omp原生子进程或active SQLite handle，parent/static/default路径无额外副作用；stderr同时不可写时允许无record但同样nonzero/cleanup
- **WHEN** SIGINT/SIGTERM 落在listen invoke后、实际bind前，或成功后重复/混合到达
- **THEN** pending bind由同一AbortSignal取消且无startup record，或已绑定listener幂等关闭；两种情况下均完成已拥有runtime原生退出后释放port、最后关DB；干净取消正常退出，successor可立即复用exact port/DB

#### Scenario: Signal during managed model publication
- **WHEN** a clean signal arrives while the post-listen model write is pending
- **THEN** owned IO is settled without a startup/shutdown await cycle; no late success/failure record is emitted solely because of cancellation, no cleared app handle is dereferenced, and no resource is abandoned; a genuine writer failure remains a truthful nonzero generic failure

#### Scenario: Full proxy turn keeps both credentials out of output
- **WHEN** the actual production entry uses a unique64-character upstream key and fake-omp call-proxy reads the generated models.yml, authenticates with its actual runtime bearer, and completes a real local upstream streamed turn before SIGTERM
- **THEN** the persisted assistant content equals the upstream deltas and the turn is done; complete application stdout/stderr contains neither the upstream sentinel nor that bearer; models.yml contains only the WORKBUDDY_MODEL_TOKEN variable name, never either credential value

#### Scenario: 完整装配路由与惰性根
- **WHEN** actual compiled entry starts using configured SANDBOX_ROOT before any session spawn or workspace creation
- **THEN** startup reports the exact seven modules in actual registration order; authenticated GET /api/workspaces and GET /api/audit return200 with their real shapes/no-store, anonymous requests return401, and SANDBOX_ROOT/u1 does not exist

#### Scenario: HOST=localhost 单一 binding
- **WHEN** 以 HOST=localhost 启动编译入口
- **THEN** 服务只在 127.0.0.1:<port> 可连接、[::1]:<port> 连接失败，startup record 的 host 为 127.0.0.1，models.yml baseUrl 为 http://127.0.0.1:<port>/v1，唯一 listener 受既有有界关停约束；大小写或写法不同的 `LOCALHOST` 等其它值仍原样交 listen

### Requirement: Shared agent module assembly
createApp SHALL always register model-proxy then sessions then workspaces then accounts after auth and the HTTP guard, before catch-all/static routes, using one shared TokenRegistry. Sessions SHALL reconcile before accepting requests. App close SHALL reuse the existing module preClose cleanup without closing caller-owned DB. No startup process or agent directories SHALL be created by merely configuring/registering modules; lazy runtime spawn retains directory ownership. The seven-module startup record SHALL correspond to the actual composition, not only a hardcoded list. Post-listen model publication and active-runtime signal cleanup belong to the production entry lifecycle above; merely constructing the injectable app SHALL remain free of these startup effects. SSE remains outside this requirement (issue #103).
createApp SHALL create exactly one workspace store with its caller-owned DB, runtime.sandboxRoot, canonical ensureSharedDir and raw emit(db,event). It SHALL bind audit.emit as event=>emit(db,event), create the synchronous sandbox facade with store.rootOf and that audit, registerWorkspaces(app,{store,sandbox,audit}), then registerAccounts(app,{db}). It SHALL NOT introduce a second sandboxRoot setting, optional module-registration bypass, alternate store/audit implementation, or eager owner directories. Existing synchronous onError/onEvent return-value ownership and all #204 sink semantics SHALL remain unchanged. The resolved `OMP_MAX_PROCESSES` value SHALL reach the sessions module as its supervisor process cap through the same runtime settings object as `OMP_IDLE_MS`, without a second configuration path. createApp SHALL create that single workspace store before registerSessions and SHALL pass its owner-scoped `rootOf` to registerSessions, which uses it only to resolve a bound session's omp working directory (chat-sessions「Supervisor dispatch and generation binding」); the module registration order (model-proxy → sessions → workspaces → accounts) and every other wiring rule above are unchanged, and no second workspace store, sandboxRoot setting or root computation SHALL be introduced for sessions.

#### Scenario: Authenticated session and bearer proxy coexist
- **WHEN** a real createApp is created with caller DB and injected trusted runtime/registry settings
- **THEN** session routes use cookie/owner guards, proxy uses the same runtime-issued bearer rather than cookie auth, health/info/static behavior remains unchanged and app.close leaves DB usable
#### Scenario: Missing upstream remains an available app
- **WHEN** either upstream setting is absent
- **THEN** startup and authenticated session CRUD remain available; invalid bearer receives401 before parser/config work, a registered live bearer receives502 and the secret value is absent from startup/failure output
#### Scenario: Pure source and compiled configuration identity
- **WHEN** the existing pure resolver receives defaults/overrides for all fourteen application keys at source and compiled entry URLs from unrelated cwd
- **THEN** each existing default and override (including optional ompUser, the process cap defaulting to 16 and the reasoning switch defaulting to on) is observed unchanged, path identity remains rooted at the entry's repository and unknown environment keys are ignored without filesystem/listen/signal side effects

#### Scenario: 同一真实装配贯穿租户与审计
- **WHEN** an owner creates a workspace through the production createApp and lists/tree-reads it, another owner requests the same workspace with a traversal path, then its real owner attempts traversal
- **THEN** the created root is under the injected runtime.sandboxRoot; foreign access returns404 without adding a denial event, owner traversal returns403 only after canonical sandbox.reject audit is committed on the same DB and visible via /api/audit; unauthorized calls return401 before parser effects

#### Scenario: 既有消费者原子切换
- **WHEN** all createApp callers and HTTP contract fixtures use the completed composition
- **THEN** production modules are registered exactly once; test-only stand-ins no longer occupy their paths, no registration bypass is added, real parser/cache/foreign404/native500 coverage is preserved, and app.close leaves caller DB usable

#### Scenario: 会话与工作空间共用同一 store
- **WHEN** an owner creates workspace W through the production createApp, creates a session bound to W and prompts it with the real fake reporting `cwd=`
- **THEN** the reported cwd equals the root W's `GET /api/workspaces` entry resolves to under the injected runtime.sandboxRoot; the startup record still lists the seven modules in the same order and no additional workspace store or directory is created at registration
