# Spec delta: http-service-skeleton（S0b 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 统一错误信封
所有本阶段可预期 `/api/*` 应用错误与 API 404 SHALL 使用统一信封 `{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；typed definition map 固定为**七码**：`bad_request`(400, `请求格式不正确`)、`invalid_credentials`(401, `账号或密码不正确`)、`account_disabled`(403, `该账号已停用，请联系管理员`)、`unauthorized`(401, `请先登录`)、`not_found`(404, `请求的资源不存在`)、`session_busy`(409, `会话正在生成，请稍候`)、`agent_unavailable`(502, `Agent 运行时不可用`)；处理器 SHALL 落在 `http/` 横切层。`bad_request` 覆盖显式 typed `HttpError("bad_request")`；仅当 request 的 matched route identity 恰为 content-parser 归属集 `POST /api/auth/login`、`POST /api/auth/logout`、`POST /api/sessions/:id/prompt`、`POST /v1/chat/completions` 之一时，才额外覆盖 exact Fastify content-parser error code allowlist：`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`。归属路由均不使用 route schema，因此 `FST_ERR_VALIDATION` 不在此 allowlist。映射不依赖 raw `statusCode`（body-too-large 原始状态可为 413），最终均为 exact 400。其他原始 API namespace 的 protected request 在 root preParsing guard 前不解析 body：未认证先返回 401；通过 guard 后，相同 parser/media 错误若发生在 matched `/api`/`/api/*` catch-all，恢复既有 typed `not_found` 404，发生在归属集之外的其他已注册 API route 保持 generic 5xx。原始 non-API unmatched non-GET miss 无论是否携 cookie 都绕过 guard、零 session query 并保持既有 typed 404（`/v1/chat/completions` 是显式注册路由，不属 miss）。不得回显 parser/schema/password/session/bearer 细节；具有相同 status/statusCode 或伪造 code 的任意 programmer error 不得被误标成七种语义错误，仍为 5xx。

#### Scenario: 七码信封形状一致
- WHEN 测试路由分别抛出七种 typed application error
- THEN 响应 status/code/message 与 definition map exact 对应，body 仅含 `{error:{code,message}}`，无 Fastify 默认 error 字段

#### Scenario: 归属路由 POST 请求 parse/validation 错误稳定映射
- WHEN `/api/auth/login` 收到 empty/malformed JSON、unsupported media type、不符合手写 exact body validator 的 JSON 或超过 16 KiB body limit，或 bodyless `/api/auth/logout` 收到任意 parsed body/empty-or-malformed JSON/unsupported media/超过其最小合法 body limit，或已认证请求对 `POST /api/sessions/:id/prompt` 提交 unsupported media/malformed JSON/超过 32 KiB body，或持有效 bearer 的请求对 `POST /v1/chat/completions` 提交 unsupported media/malformed JSON/超过 4 MiB body
- THEN 不论 Fastify raw status 是否为 400/413/415，均按显式 typed error 或 exact matched 归属路由 allowlisted Fastify error code 返回 exact 400 `bad_request` 信封，不回显 validation/parser 详情、密码或 bearer；错误发生在任何 handler 副作用（cookie lookup/DELETE/会话写入/上游转发）之前
- WHEN 未认证请求携相同 malformed/media/body 输入访问 original API namespace 的受保护 matched `/api`/`/api/*` catch-all 或其他 protected API route（含 `POST /api/sessions/:id/prompt`）
- THEN guard 在 content parser 前返回 exact 401 unauthorized；不得被 raw parser status 改写为 400/404/500
- WHEN 无论有无 cookie，相同输入访问 original non-API unmatched non-GET miss
- THEN 绕过 guard 且零 session query，保持既有 exact typed `not_found` 404
- WHEN 有效会话携相同输入访问 matched `/api`/`/api/*` catch-all
- THEN 通过 guard 后返回既有 exact typed `not_found` 404；不得因 content parser 先于 catch-all handler 而成为 400/500
- WHEN 有效会话携相同错误访问归属集之外的其他已注册 protected API route，或 programmer error 仅携带 `statusCode=400/413`/伪造 allowlist code/validation-shaped fields
- THEN 保持 generic 5xx，不得被 request-error mapper 或 guard 改写

#### Scenario: 意外错误不伪装
- WHEN API route 抛出未分类的 programmer error
- THEN 返回 5xx，且 body 不得声称七个 typed semantic code 中任一个

### Requirement: 服务启动与装配
系统 SHALL 以 `server/src/app.ts` 装配 Fastify 实例，并以 `server/src/server.ts` 作为唯一 production listen/DB ownership 入口；import 该 module 只暴露 pure config seam，不得 mkdir/open/listen 或注册 signal，只有 ESM main guard 命中的执行路径可启动。唯一配置源为 own environment keys `HOST`、`PORT`、`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`、`OMP_STATE_DIR`、`OMP_IDLE_MS`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`、`MODEL_ID`：缺省值分别为 `127.0.0.1`、`3000`、repo-root `var/dev.db`、repo-root `web/dist`、repo-root `var/omp/omp`、repo-root `var/omp-state`、`600000`、repo-root `var/sandbox`、（无，可缺）、（无，可缺）、`deepseek-v4.1-flash`；relative path SHALL 相对由 entry module identity 推导的 repo root，不得随 shell/npm workspace cwd 分裂。`PORT` SHALL 只接受 canonical ASCII decimal `1..65535`；`OMP_IDLE_MS` SHALL 只接受 canonical ASCII decimal 正整数；HOST missing 取默认、empty 或 whitespace-only 非法且不得 trim/coerce，其它 nonempty string 原样交 listen；DB/static/omp/state/sandbox path explicit empty 非法；`MODEL_UPSTREAM_BASE_URL`/`MODEL_UPSTREAM_API_KEY` 缺省合法（代理对任何请求 502），显式 empty 非法。全部 config SHALL 在任何 filesystem/database/listen effect 前验证。

对于 non-`:memory:` DB path，入口 SHALL recursive 创建且只创建 missing `dirname(DB_PATH)`，随后由唯一 `openDb` 创建/打开 exact file；不得创建 `STATIC_ROOT`；`OMP_STATE_DIR` 与 `SANDBOX_ROOT` 的子目录由会话首次 spawn 时按需创建，启动期只创建 `<OMP_STATE_DIR>/agent`（为 models.yml）。Exact `:memory:` SHALL 保留 SQLite 特殊 identity 且不得 mkdir。DB parent 为 existing non-directory、不可创建/写入或 DB/migration 不合法 SHALL 走同一 partial-start failure cleanup，不得 fallback 到默认路径。

`npm run start --workspace server` SHALL 在 clean checkout 先以现有 TypeScript compiler 构建 production-only JS 并把 tracked `migrations/` 完整递归 tree 逐文件逐字节带入与 compiled module 相同的 runtime 位置，再执行 compiled 唯一入口；`make dev` SHALL 只转发到该 command，不得形成第二套启动逻辑。成功顺序 SHALL 为 validated config → DB-parent prepare → DB open/migrate → createApp（含 sessions 启动对账）→ listen → 以实际绑定地址推导 proxyBaseUrl 并写 `<OMP_STATE_DIR>/agent/models.yml` → application-owned stdout 一行 LF-terminated exact JSON `{"event":"server_started","host":"<actual>","port":<integer>,"modules":["core/db","auth","http","model-proxy","sessions"]}`，不得有 extra key 或在 listen 前/应用 stderr 出现。Package-manager command banner 不属于 application record。

Runtime config/DB/app/listen/models.yml/success-record 任一步失败 SHALL 不输出 success record，以 nonzero 退出，并在 stderr sink 可写时由 application-owned stderr 输出一行 LF-terminated exact generic JSON `{"event":"server_start_failed"}`（无 extra key/原始 error/config）；若 stderr sink 自身不可写，该行物理不可达，系统仍 SHALL nonzero、释放资源且不得产生 unhandled stream stack。Node `node:sqlite` ExperimentalWarning MAY 作为平台 warning 另出 stderr。任意 success/failure stream 与运行期日志均不得 dump environment 或包含 cookie/password/session 值、`MODEL_UPSTREAM_API_KEY` 值或任何会话 bearer token。Application stdout/stderr record SHALL 经受管 writer 处理 sync throw、write callback 与 stream error，settle exact 一次且不得泄漏 raw EPIPE。

失败清理 SHALL 关闭当前入口已拥有的 app/DB；每个 entry SHALL 把同一 AbortSignal 传给 Fastify listen，SIGINT/SIGTERM 先 abort pending bind 再经共享幂等 shutdown **先回收全部活跃 omp runtime（关 stdin → TERM → KILL 序列）**、再停止已绑定 listener、最后关闭唯一 DB handle 并正常退出。Signal 落在 listen invoke 与实际 bind 之间时不得后到绑定、不得输出 success/failure record，port/DB 须可由 successor 立即复用。`.gitignore` SHALL 排除 default `var/` runtime output，knip SHALL 把 `src/server.ts` 识别为 entry。

#### Scenario: 干净启动与一致命令面
- WHEN 从 repo root 执行 `make dev` 或 `npm run start --workspace server`，或 build 后从 foreign cwd 直接执行 absolute `dist/server.js`，且未设置任何配置
- THEN 三种启动形状消费同一 entry/config identity，监听 `127.0.0.1:3000`；只在 repo-root recursive 创建 `var/` 并使 `var/dev.db` 完成 tracked migrations、创建 `var/omp-state/agent/models.yml`（`baseUrl` 为 `http://127.0.0.1:3000/v1`）；不创建 missing `web/dist`、不创建 `var/sandbox` 与 `var/omp`；`GET /api/healthz` 返回 exact 200；application stdout 只在 listen 成功后出现上述 exact startup record（modules 恰五项）；SIGTERM 后端口与 DB 均可立即由后继进程重用

#### Scenario: override、非法配置与部分启动失败
- WHEN 以可用 custom host/port、absolute 或 relative DB/static/omp/state/sandbox 路径与 upstream 配置启动
- THEN override 逐项原样生效，relative path 仍绑定 repo root；`HOST=0.0.0.0` 时 models.yml `baseUrl` 为 `http://127.0.0.1:<port>/v1`；只创建 non-memory DB 的 exact parent 与 `<OMP_STATE_DIR>/agent`、绝不创建 STATIC_ROOT 或误建 default DB；build output 中的完整 migration tree 与 tracked source inventory/bytes 一致，health/info/auth/static 合同保持
- WHEN `PORT` 为 empty/whitespace/sign/fraction/exponent/zero/out-of-range，`OMP_IDLE_MS` 为 empty/`0`/`abc`/负数/小数，HOST 为 empty/whitespace-only，任一 path 为 explicit empty，upstream 变量为 explicit empty，或 import `server.ts` 但不命中 main guard
- THEN main-path 非法 config 在任何 filesystem/database/listen 副作用前 nonzero，application stderr 恰一行上述 generic failure record 且无 success；import-without-main 保持 silent 且无 filesystem/database/listen/signal 副作用
- WHEN DB parent 为 file/不可创建、DB open/migration 失败、HOST 由 listen 拒绝、port 已占用、models.yml 不可写或 post-listen stdout sink 失败
- THEN 进程 nonzero 且 stderr 可写时只有 generic failure record；stdout EPIPE 不得输出 raw stack；关闭所有已拥有的 app/DB 与 runtime，不遗留可监听 server、活 omp 子进程或 active SQLite handle，parent/static/default 路径无额外副作用；stderr 同时不可写时允许无 record 但同样 nonzero/cleanup
- WHEN SIGINT/SIGTERM 落在 listen invoke 后、实际 bind 前，或成功后重复/混合到达（含存在活跃 omp runtime 时）
- THEN pending bind 由同一 AbortSignal 取消且无 startup record，或已绑定 listener 幂等关闭；两种情况下均先回收 runtime、再释放 port、再关 DB 并正常退出，successor 可立即复用 exact port/DB

#### Scenario: 日志不含密钥
- WHEN 以 `MODEL_UPSTREAM_API_KEY=<64 位唯一哨兵>` 启动，完成一次经 model-proxy 的 prompt 回合后 SIGTERM
- THEN 进程 stdout/stderr 全文不含该哨兵，也不含该回合的 `WORKBUDDY_MODEL_TOKEN` 值
