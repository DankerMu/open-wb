# Tasks: s0a-service-skeleton

> 执行序按依赖排列；TDD：每条实现任务先写失败测试再实现。

## 1. http-service-skeleton

- [x] 1.1 `core/db`：`openDb(path)`（node:sqlite、WAL、migrations/*.sql 按序执行、版本表幂等）+ `:memory:` 单测
  - Issue #5 fixture: high（上游 compact 因 migration/schema/path/shared core API 强制升档）；repair intensity: high。
  - Seams under test: `openDb(path)` 对真实 `:memory:` 与临时文件数据库，不 mock 被测 DB/迁移器。
  - Required evidence:
    - fresh `:memory:` + tracked `0010_schema_migrations_update_guard.sql`/`002_schema_migrations_history.sql` -> history receipt 按字典序严格为 `0010`,`002`（不得按数值/自然序成为 `002`,`0010`），且 ledger 的 UPDATE/DELETE/同 filename REPLACE 被拒；
    - U+E000 与 U+10000 filename segment -> scalar code-point comparator 必须排 U+E000 在前；
    - fresh 临时文件库 -> `PRAGMA journal_mode` = `wal`（`:memory:` 按 SQLite 能力保持 `memory`）；
    - 同一路径连续两次打开 -> receipt 数不增、schema 一致；合法 `[0010]` prefix 可续跑；malformed/no-ledger hidden-state/non-prefix/unknown/cross-object or case-variant reserved-name/extra-trigger/extra ledger index（nonunique/partial/expression）/PRAGMA-shadow/`sqlite_sequence` divergent state 在任何新 effect 前失败并保持 pre-open catalog snapshot，unrelated non-reserved table/trigger 不误拦；
    - receipt INSERT changes != 1 或最终 filename/sequence 不是预期 next contiguous identity -> 当前 migration effect 与 receipt 均回滚；可达的真实 SQLite runner fixture 在 migration body/postflight 冲突时同样证明当前 trigger/effect/receipt 全部回滚且既有 prefix 不变；
    - 临时文件库先用 `node:sqlite` 预置同名 `schema_migration_history` table，再调用同一 `openDb(path)` seam -> reserved-name preflight 在 bootstrap/`0010`/`002` 前失败，完整 `sqlite_master`/`sqlite_sequence` snapshot 不变，且不创建 ledger 或 receipt；同名错误 trigger 同样在任何新 effect 前失败；
    - migration body 尝试 COMMIT/ROLLBACK/SAVEPOINT -> 被拒，effect 与 receipt 均不存在；失败路径真实调用内部 handle close；
    - 固定 migration 目录中的非 `.sql` 直属文件与嵌套 `.sql` -> 均不执行；特殊 filename 元字符不得使 receipt 绑定到不同 bytes；
    - canonical foundation SQL 的 LF/CRLF/lone-CR -> catalog compare 等价且 fresh/partial/complete 可稳定重开；非 EOL token/body 或仅一个 interior space/tab 的 drift -> 事务性失败，并以 whitespace-collapsing comparator mutant 证明测试可判别；`.gitattributes` 同时固定 tracked migration `*.sql` 为 LF；
    - 每个测试自有 SQLite handle -> assertion 异常时仍经 `finally` 关闭；
    - `npm test --workspace server` 与 `make check` -> exit 0，coverage 门禁保持。
  - Non-goals: 业务表/seed（#8）、HTTP、并发多进程迁移协调、任意外部 migration 目录。
- [x] 1.2 Fastify 装配与横切：`app.ts`（可注入配置）+ `http/` 错误信封处理器（invalid_credentials/account_disabled/unauthorized/not_found 四码，401/403/404 同形状断言）+ healthz/info 端点 + `app.inject()` 测试
  - Issue #6 fixture: high（上游 compact 因 shared app entrypoint/routing/public schema/static path/fallback precedence 强制升档）；repair intensity: high；与 1.4 同 PR 原子交付。
  - Seams under test: `createApp({db, staticRoot?})` + real Fastify `app.inject()`；使用真实 caller-owned `openDb(":memory:")`、真实 temp static root、真实 typed `HttpError`，不 mock Fastify/DB/filesystem/error handler/static plugin。
  - Required evidence:
    - caller-owned DB + 任意 static-root 状态 -> `createApp` ready，`app.db` 与传入对象 identity 相同；重复 inject 不改 DB；`app.close()` 后 caller 仍可查询并自行 close；
    - `GET /api/healthz` -> 200 + exact `{"status":"ok"}`；`GET /api/info` -> 200 + exact `SERVICE_INFO`，version 仍为 semver；
    - 四个 typed errors -> 分别 exact 401/403/401/404，exact code/message map，body 仅 `{error:{code,message}}`；unexpected programmer error -> 5xx 且不得伪装成四个 semantic code；
    - exact `/api`、未知 `/api/*`（含 query 与 encoded separator/dot-segment bypass）-> JSON `not_found`，即使 static root 有同路径文件也不泄漏文件/index；known health/info 永远优先；percent-decoding 最多四轮，超过上限或 malformed 编码 fail closed，并以约 8KB nested-encoding case 证明 request work 不再随编码层数超线性放大；
    - server package runtime dependencies/lockfile -> Fastify 5 + matching `@fastify/static` 在 Node 24/npm clean install 下可解析，无 CDN/公网运行时依赖；
    - focused inject suite、server coverage、`make check`、strict OpenSpec -> exit 0，现有 core/db/service-info/web/kbservice 保持绿。
- [ ] 1.3 启动入口与命令面：`server.ts`（唯一 listen、启动日志输出模块清单）、`make dev` 与 `npm run start --workspace server`、`knip.json` server entry 增 `src/server.ts`、`.gitignore` 增 `var/`（默认 db 路径产物不入库）；启动行为验证由 4.1 smoke 对真实进程覆盖（设计已定，不写监听单测）
- [x] 1.4 静态托管与 history fallback：`STATIC_ROOT` 可配置（单测用临时夹具目录），非 `/api/*` GET 回 index.html，非 GET 与 `/api/*` 未命中回信封 404 + inject 测试
  - Issue #6 required evidence（与 1.2 共用同一 app/inject fixture）：
    - existing directory + regular index/asset -> direct asset GET 返回 exact bytes/content type；non-API deep-link GET（含 `/files/` trailing slash 与 query）返回 exact index bytes；
    - absent、nonexistent、regular-file 或 index-less static root -> app readiness 与 health/info 不受影响；不可用 fallback/deep-link 返回 exact JSON 404；index-less root 的既有 regular asset 仍可直接读取；
    - non-GET non-API miss -> exact JSON 404、不得返回 index；HEAD/POST 与 GET 的 fallback 分支需显式区分；
    - root 内 `api/**` 文件、root/nested dotfiles、encoded/multi-encoded API path、traversal/encoded traversal、literal/encoded/multi-encoded symlink ancestor 与 outside sentinel -> `/api` 始终 JSON；static validation/existence/send target 绑定同一 normalized pathname；multi-encoded non-API path fail closed，任何 request 不得返回 hidden 或 root 外 bytes；
    - repeated asset/deep-link/API requests 与 `app.close()` -> 无 double-send、无 leaked handle、无文件/DB mutation。
  - Non-goals: `server.ts`/listen/env/default config（#7）、auth/session/cookie/guards（#9/#10）、web 源码、business schema/seed、HTTP smoke/UI walk、多进程协调、用户 workspace static root。

Suggested fixture level: compact - 组装层有跨模块交互（db+http+static），但均经 app.inject() 单 seam 可证
Minimal mergeable slice: 1.1 core/db 单独可合并保绿（独立模块+自带测试，无 HTTP 依赖；knip 探针已证测试 import 即非死代码）

## 2. dev-stub-auth

- [x] 2.1 账号/会话表迁移 + seed 四账号（zhangsan/zhaoliu/lisi 密码 demo + wangwu 停用；scrypt 散列入 password_hash，明文不入库）+ seed 形态断言（散列可 verify、非明文）
  - Issue #8 fixture: high（上游 compact 因 migration/schema/password-derived secret/foreign-key lifecycle/shared auth state 强制升档）；repair intensity: high；minimal slice: atomic single `010` migration。
  - Seams under test: real `openDb(":memory:")` + real temporary file DB；direct SQLite schema/data queries + independent test-only `node:crypto` scrypt oracle；不 mock DB/migrator/filesystem/crypto，不提前添加 #9 production verifier。
  - Required evidence:
    - TDD/red-proof：先添加 issue #8 focused test 并在 pre-change production source 上运行，因缺 `010`/schema/seed/foreign-key state 而红；最终恢复并全绿，无 red-proof stash；
    - tracked assets/receipts exact lexical order = `0010_schema_migrations_update_guard.sql`, `002_schema_migrations_history.sql`, `010_auth_schema_seed.sql`；`010` 只有一条 receipt，migration source 不含 plaintext `'demo'`/`"demo"`、`IF NOT EXISTS`、`OR IGNORE` 或第二 seed runner；
    - `accounts` exact columns = `id,account,role,disabled,password_hash`；`auth_sessions` exact columns = `id,user_id,expires_at`；table/index/FK inventory only contains promised PK/UNIQUE/FK/CHECK semantics，无额外列、表、view/trigger/index；
    - exact seed rows = `u1/zhangsan/成员/0`, `u2/zhaoliu/成员/0`, `u3/lisi/管理员/0`, `u4/wangwu/成员/1`；恰四行，auth_sessions 恰零行；
    - 四个 `password_hash` 均 exact match `scrypt$16384$8$1$[0-9a-f]{32}$[0-9a-f]{64}`、salt/digest 各不相同、非 `demo`；测试独立 parse 参数并以 Node `scrypt` 证明 `demo` true、wrong password false；tracked SQL 与 DB 文本扫描不得出现明文 password 字段/值；
    - account mutation matrix：empty/uppercase/U+0020 trim-needed/tab/newline/CR/NUL/non-ASCII/disallowed punctuation/duplicate account、empty/BLOB id、invalid/BLOB role、disabled `-1/2/text/null`、malformed/BLOB hash 均被 SQLite constraint 拒绝且 canonical four rows 不变；合法 lowercase ASCII `[a-z0-9._-]+` 第五账号可插入并删除以证明约束不误拒；
    - auth session matrix：id 非 64 lowercase hex（含 32/63/65 lowercase-hex、uppercase、BLOB）、unknown/BLOB user、negative/non-integer expiry 被拒；合法 64 lowercase-hex session 可插入；删除 parent account 级联删除 session；`PRAGMA foreign_keys=1` 在 caller-visible `openDb` handle 上成立；
    - legal foundation-only `0010+002` temp DB 首次打开 -> 原子追加 exact `010` schema/seed/receipt；第二次打开 -> full catalog + seed/hash/session/receipt snapshot byte-stable；foundation helper/既有 core-db expectations 明确改称 prefix，不再把两 receipt 当 current complete；
    - early `accounts` conflict 与 late `auth_sessions` conflict（在 `010` 已执行 account DDL+seed 后失败）-> complete pre-open catalog/data snapshot 不变，无 partial accounts/session/seed/`010` receipt，failed `openDb` 真实关闭内部 handle；
    - existing malformed foundation/asset/runner/EOL/catalog tests、app/service-info/web/kbservice 保持绿；`npm test --workspace server`、`make check`、strict OpenSpec、`git diff --check` exit 0，coverage include/80% thresholds 不收窄。
  - Non-goals: production login/hash-verifier API（#9）、session generation/cookie（#9）、TTL/me/logout（#10）、guard（#19）、display name/dept/sandbox/quota、OIDC/audit/http/web、外部 migration/seed config、多进程迁移协调。
- [x] 2.2 provider 接缝与登录：`authenticate(req) → Principal | null` 出口 + `providers/dev-stub.ts` 登录流程（trim+小写化、401/403 信封文案镜像 demo、CSPRNG session id 256bit、Set-Cookie httpOnly/SameSite=Lax/Path=/、Secure 配置项）+ 接缝直接断言与 inject 测试
  - Issue #9 fixture: high（上游 compact 因 auth/password-KDF/CSPRNG/cookie/persisted-session/public seam 强制升档）；repair intensity: high；minimal slice: provider + shared session establishment + `authenticate` + login route 原子交付。
  - Change boundary: `server/src/auth/**`、`server/src/app.ts`、`server/src/http/**`、focused server tests、`@fastify/cookie` dependency/lockfile 与本 issue fixture；不改 migration SQL、web、server listen、me/logout/TTL config/lazy cleanup、guard、audit/OIDC。
  - Required evidence:
    - TDD/red-proof：先添加 direct provider/authenticator/generator + real `createApp/openDb/app.inject` tests，并在 pre-change production source 上因 auth module/login route/cookie dependency 缺失而红；不是语法/fixture 红，不留 `red-proof` stash；production SQL SHA/bytes 不变；
    - module ownership/import graph：`http/app -> auth -> core/db` 单向；`providers/dev-stub.ts` 只拥有 normalize/query/scrypt/disabled 判定，不 import `http`、不读写 cookie/session；共享 auth owner 唯一拥有 Principal projection、cookie constant、CSPRNG/expiry/session INSERT/read；无第二 DB opener/session repository/hash verifier；
    - exact request matrix：handler 对未经 route-schema 变换的 parsed JSON 使用手写 exact validator，不改 global AJV；仅 JSON exact plain `{account:string,password:string}` accepted；missing/extra/non-string/null/array/malformed/unsupported media、raw account >256、password >1024、body >16KiB -> exact 400 `bad_request` / `请求格式不正确`，KDF call count 0、无 Set-Cookie、session snapshot 不变，响应不含 password/parser/schema detail；显式覆盖 Fastify 将 `text/plain` 解析为 string 后由手写 validator 拒绝的路径，以及其他 media type 的 `FST_ERR_CTP_INVALID_MEDIA_TYPE` 路径；default-AJV coercion/strip route-schema mutant 必须被 non-string/extra rows 杀死；
    - correct credentials for zhangsan/zhaoliu/lisi -> exact 200 direct Principal `{id,account,role}` with no extra/hash/password fields、`Cache-Control: no-store`、one new session row；`"  ZhangSan "` 使用 JS trim/lowercase后 exact canonical `u1/zhangsan`；request/body bytes 不进入日志/响应/DB；
    - unknown、whitespace-only account 与 wrong password -> identical exact 401 invalid_credentials, no cookie/session delta；real-KDF integration proves correct/wrong/unknown paths；unknown/empty 使用 submitted password + fixed dummy encoding（production 无固定明文 dummy password）且忽略 compare 结果；injected derive seam proves each shape-valid unknown/empty/wrong attempt executes exactly one scrypt-equivalent call and no account-existence branch skips KDF；malformed stored encoding/KDF failure is generic 5xx，不伪装 401，不泄漏 encoding；
    - wangwu correct password -> exact 403 account_disabled；wrong password -> exact 401 invalid_credentials；两者都在 disabled 判定前执行 KDF，均无 cookie/session；不产生 audit；
    - exact stored-hash parser accepts only `scrypt$16384$8$1$<32 lower hex>$<64 lower hex>`、derives exactly 32 bytes and constant-time compares；known/dummy derive 若返回非 32 bytes 均 generic 5xx，不得把 known wrong-length 当错误密码 401；prefix/parameter/separator/salt/digest case/length mutations each fail closed；测试不得只复制 regex，至少以 real Node scrypt 正确/错误密码作为独立 oracle；
    - generator direct seam：frozen production default runtime 的 function identities exact 为 imported `crypto.randomBytes` 与 `Date.now`；random source 只被调用一次且 size=32，输出 exact 64 lowercase hex；31/33-byte 或非 Buffer/invalid output fail before write；多个 production-source login session IDs unique、非连续数值/时间/user-derived；不得用 retry/REPLACE 隐藏碰撞；
    - fixed clock/random successful login -> one plain INSERT row `{id,user_id,expires_at=now+604800000}` in one explicit SQLite transaction，cookie value exact equals committed row ID；now 非 finite/non-integer/negative 或 expiry 非 safe integer -> generic 5xx/no write/cookie；existing-session collision 与可达 INSERT/COMMIT failure -> rollback preserves complete session snapshot、no cookie、generic 5xx；authorizer-forced rollback failure -> AggregateError exact contains original+rollback errors/cause and leaves active transaction visible for caller recovery；pre-existing caller transaction -> BEGIN fails without rolling back/committing caller effects；
    - request-error mapper：explicit `HttpError("bad_request")` route-independent；native Fastify content-parser error only exact constructor-backed allowlist `FST_ERR_CTP_INVALID_MEDIA_TYPE|FST_ERR_CTP_INVALID_JSON_BODY|FST_ERR_CTP_EMPTY_JSON_BODY|FST_ERR_CTP_BODY_TOO_LARGE` + route owner：exact POST login -> 400，matched `/api|/api/*` catch-all / unmatched non-GET miss -> exact 404 not_found，其他 registered route -> generic 5xx；login 无 schema，forgeable `FST_ERR_VALIDATION` shape 不受信；arbitrary programmer `{statusCode:400|413}`、伪造同前缀/allowlist/validation shape 与 DB/KDF/CSPRNG error -> generic 5xx；global/statusCode/prefix/validation-duck-typing mutants 被对应 rows 杀死；
    - cookie matrix：name exact `workbuddy_session`，attributes include exactly HttpOnly/SameSite=Lax/Path=/；secureCookies omitted/false -> no Secure，true -> Secure；Domain/Expires/Max-Age absent；failure responses never Set-Cookie；cookie plugin registration preserves health/info/API/static precedence；
    - direct `authenticate()` with real DB：valid 64-lowerhex future-expiry row -> exact Principal；missing/own-property-missing/prototype-inherited cookie、wrong name、malformed/uppercase/32/63/65 ID、unknown row、invalid negative/fractional/nonfinite/unsafe clock、expires_at `<now`/`==now`、deleted/disabled parent -> null；all cases session/account snapshots unchanged，证明 #9 read-only、不偷做 #10 lazy cleanup；
    - repeated login creates independent rows；app close keeps caller DB usable；concurrent async login attempts on one DatabaseSync are serialized or fail atomically without cross-binding Principal/cookie/session IDs；tests close every app/DB handle in finally；
    - dependency/compatibility：Fastify 5 + matching `@fastify/cookie` 在 Node 24/npm clean install/lockfile 可解析，无新增 session framework/CDN/runtime network；existing core-db/auth-schema/app/service-info/web/kbservice tests保持绿；
    - focused tests、`npm test --workspace server`、`make check`、strict OpenSpec、`git diff --check`、size/knip/secret/plaintext/debug/skip/stash scans全绿，coverage include/80% threshold不收窄。
  - Non-goals: TTL 配置与 lazy delete、me/logout/clear-cookie（#10）、default API guard（#19）、server.ts/env/listen（#7）、HTTP smoke（#16）、web、audit、OIDC、CSRF、rate limiting、schema migration/change、multi-process session coordination。
- [x] 2.3 会话生命周期：`GET /api/auth/me`、`POST /api/auth/logout`（durable 删行 + scoped clear-cookie）、`createApp({sessionTtlMs})`（默认 7 天绝对过期）与 exact-row 惰性清理 + inject/transaction 测试
  - Issue #10 fixture: high（upstream compact 因 public auth routes、TTL config、persisted DELETE、cookie revocation、transaction rollback/shared-state transition 强制升档）；repair intensity: high；minimal slice: TTL + me + logout + lazy cleanup 原子闭合。
  - Change boundary: 既有 `server/src/auth/{index,session}.ts`、`server/src/app.ts`、logout-aware exact HTTP parser owner、一个 focused lifecycle inject test + direct session/authenticate regressions与本 issue fixture；不改 migration/dependency/web/listen/env/guard/smoke。
  - Required evidence:
    - TDD/red-proof：新 real `createApp/openDb/app.inject` lifecycle matrix 对 pre-change head 行为红——me/logout 为 404、自定义 TTL 被忽略、expired exact row 仍存在；不是语法/fixture 红，不留 red-proof stash；production migration SHA/bytes 不变；
    - TTL config：omitted→604800000，1 与自定义正安全整数→new row `now+ttl`；0/negative/fractional/NaN/Infinity/non-number/unsafe config 在 app assembly/DB mutation 前抛错；safe config + now sum overflow 在 login write/cookie 前 generic 5xx；不 clamp/round/fallback，不回写既有 rows，正常 cookie 继续无 Expires/Max-Age；
    - shared resolver/identity：SQLite 内先分类 exact ID expiry，不把任意 epoch integer 投影成 unsafe JS number；以 `Number.MAX_SAFE_INTEGER+1` 与 SQLite max signed-64 expiry 证明 future classification 不 throw/round；future enabled→exact Principal；`expires_at<=now`（含 disabled/orphan）只以 `id + expires_at<=now` conditional DELETE matched row后 null；conditional DELETE lost-race receipt=0仍为 null/HTTP 401而非5xx；unknown/invalid-clock/future-disabled/future-orphan不写；无全表 sweep或 sibling mutation；
    - me matrix：future valid cookie→exact 200 direct Principal + `Cache-Control:no-store`、no Set-Cookie、complete snapshots unchanged；missing/own-property-missing/prototype-inherited/malformed/uppercase/32/63/65/unknown、invalid clock、future disabled/orphan→exact 401 unauthorized/no-store/exact clear-cookie且 DB unchanged；equal/past expired→commit-delete exact row 后同 401/clear，unrelated future/expired rows不变；
    - logout request contract：canonical POST 无 body/content-type；route 使用 Fastify 最小合法 `bodyLimit:1` + explicit `request.body===undefined` validator。任意 parsed one-byte body/text，以及 empty/malformed JSON、unsupported media、larger body native CTP errors→exact 400 before cookie lookup/DELETE/clear；route无 schema且不信任 status/code/validation shape；
    - logout identity/outcomes：own exact cookie 对应 future/expired/disabled/future-or-expired orphan existing row→owned DELETE commit后 exact 204、empty body、no-store、exact clear-cookie；logout 不消费 auth clock，故 invalid `authNow` + existing row仍为204/delete；missing/malformed/unknown→exact 401 unauthorized/no-store/same clear-cookie/no DB delta；重复 old cookie为401；concurrent same-cookie logout结果 multiset 204+401且恰删一行；unrelated rows/accounts逐值不变；
    - clear-cookie：exact `workbuddy_session=` + `Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`；Secure iff omitted/false vs true createApp config，Domain absent；仅 terminal me/logout 401 或 committed logout 204可发，query/DELETE/transaction/programmer 5xx与logout 400均无 Set-Cookie；
    - transaction/delete matrix：exact DELETE 与 expired conditional DELETE 共用 owned BEGIN/receipt(0|1)/COMMIT/rollback primitive；native SQLite authorizer分别覆盖 query/DELETE/COMMIT denial与 rollback denial；rollback成功快照不变/no clear，rollback失败 AggregateError exact保留 original+rollback/cause与 active transaction；caller-owned BEGIN 在 mutation前失败且 caller effects/transaction untouched；
    - error ownership：auth-domain只增 existing `unauthorized` mapping；HTTP typed map仍五码。Constructor-backed CTP allowlist仅新增 exact POST logout route owner，login 400、logout 400、API catch-all/unmatched non-GET 404、registered non-auth 5xx与 forged/status/prefix/validation-shaped 5xx矩阵全绿；无 parser/session/error detail leakage；
    - lifecycle/idempotency：repeated valid me不写；expired me重复只首调用删一行；logout后旧 cookie me 401；me/logout app close 后 caller DB可用；每个 app/DB在 finally关闭；无 second DB opener/session repository；
    - compatibility：#9 login/provider/KDF/CSPRNG/normal-cookie/transaction tests、#6 app/static/error、#8 schema/migration、existing web `ApiClient.getMe/logout`/AuthProvider/footer、web/kbservice全绿；migration `010` byte-identical，无新增依赖或公网 runtime；
    - focused lifecycle/direct/request-error tests、`npm test --workspace server`、existing web consumer tests、`make check`、strict OpenSpec、`git diff --check`、size/knip/jscpd/secret/debug/skip/stash scans全绿，coverage include/80% threshold不收窄。
  - Non-goals: default `/api/*` guard/exemption policy（#19）、server.ts/env/listen mapping（#7）、hurl/real process（#16）、web changes、audit/OIDC/CSRF/rate limiting、schema migration/backfill、multi-process session coordination。
- [ ] 2.4 认证守卫：`/api/*` 默认要求会话（healthz/info/login 与 bearer-revocation POST logout 豁免；me 可由 guard 消费 authenticate）、无 cookie 与伪造/未知 session id 均 401 信封不 5xx + inject 测试

Suggested fixture level: compact - 认证是安全面但范围小、全部经 inject 单 seam 断言；expanded 留给 S3a OIDC
Minimal mergeable slice: 2.1 迁移+seed 单独可合并保绿（依赖 1.1 已合并；纯迁移+seed 断言，无端点）

## 3. spa-shell

- [x] 3.0 web 构建工具链：vite + @vitejs/plugin-react + react/react-dom + @types/react/@types/react-dom + jsdom + @testing-library/react 依赖声明、`web/index.html`、`src/main.tsx` 最小入口及配对 `web/test/main.test.tsx`（Testing Library 在 `#root` 装载入口）、`vite.config.ts`（outDir=dist）、`tsconfig.base.json` 增 `jsx: react-jsx`、`web/vitest.config.ts` 覆写 jsdom 环境、`web/package.json` 增 build 脚本；验证 = jsdom 入口测试 + `make typecheck` + `npm run build --workspace web` 产出 dist + `make check` 全绿（knip vite 插件自动解析入口，依赖均由入口/配置/测试实际消费）
- [x] 3.1 `lib/theme` 扩 system 模式：可注入 matchMedia、默认档 system（demo:1035）、未知值/存储不可用回退 system（修正现有回退 light 语义）+ 扩展既有 `web/test/theme.test.ts`
- [x] 3.2 路由壳：react-router 四路由 + 侧栏（demo:1773-1778 标签/副标题）+ 占位壳（/center 扁平，/tokens 不移植）+ jsdom 可达性断言
- [x] 3.3 `lib/api` + 登录页与路由守卫：fetch 封装（信封解析、401 进未登录态）、未登录任意路由渲染登录页并记录原目标、登录成功跳回、错误 message 展示 + jsdom 断言（未登录访问 /files 渲染登录页、登录后落 /files）
- [x] 3.4 设置页与用户页脚：全局主题 owner（`workbuddy-theme`、data-theme、system/storage listener）、外观卡（三档单选 + 当前生效行）、关于卡（strict `/api/info`）、侧栏页脚（Principal account/role + Provider-owned 204 logout + 确认）+ jsdom 断言

Suggested fixture level: compact - UI 组件测试经 vitest+jsdom；端到端交给 ui-walk，不重复抬档
Minimal mergeable slice: 3.0 工具链单独可合并保绿（纯配置+最小入口，build 与 make check 即验证；后续任务全部依赖它）

## 4. verification-harness

- [ ] 4.1 hurl 用例集（healthz/info/登录三态含信封文案断言/守卫 401/伪造 session 401/登出/深链 fallback/API 404 信封）+ `make smoke`（缺 hurl 显式失败并打印指引）
- [ ] 4.2 Playwright 走查（登录→四路由→主题持久→侧栏页脚退出，零浏览器 console error）+ `make ui-walk`
- [ ] 4.3 CI 接线与控制面四处同步：smoke/ui-walk 独立 job（装 hurl/browser、先 build web 再起服务）纳入 all-checks-passed；AGENTS.md（Verification Matrix 真命令、Enforcement Index 升 block、Known blind spots 删过期条目、Directory Map 增 smoke/）；constraints.yaml verification.surfaces 增两条；Makefile 目标 + .PHONY；验证 = 三处目标集合逐字比对

Suggested fixture level: none - harness 自身即验证物，其"测试"就是对真实服务全绿运行
Minimal mergeable slice: 4.1 smoke 单独可合并保绿（依赖 1.3 启动命令与 1/2 组端点；与 Playwright 无耦合；smoke/ 不在 make check 与 naming-guard 扫描面内）

## Issue #11 required evidence

- Fixture level: expanded；repair intensity: medium；权威 requirement = `specs/spa-shell/spec.md` 的“web 构建工具链”。
- [x] `web/test/main.test.tsx`：给定与 `index.html` 相同的 `#root` DOM，导入真实 `src/main.tsx` 后 Testing Library 可见最小根内容；测试先对 pre-change 源运行为红，实施后为绿。
- [x] `make typecheck`：strict NodeNext + `react-jsx` 对 React 入口和测试退出 0；`@types/react`/`@types/react-dom` 已声明且无隐式 any。
- [x] `npm run build --workspace web`：从受跟踪入口构建，退出 0，并生成 `web/dist/index.html` 与至少一个静态资源；重复运行仍成功。
- [x] `make check`：lint、JSX typecheck、web/server/kbservice tests+覆盖率、knip/jscpd/守卫全部退出 0；不收窄 `coverage.include`，所有新增依赖由入口、配置或配对测试实际消费。
- [x] 新生产入口的 TDD/red-proof 记录存在；入口必须有配对 jsdom 测试，不以 PR 偏离说明替代覆盖率和 TDD 门禁。
- [x] 检查 `web/dist` 不含 `app-reference/`、远程 CDN URL 或未声明运行时依赖；依赖新增理由写入 PR。
- [x] 保持 `web/src/lib/theme.ts`、现有 theme tests、server 与 kbservice 行为不变。
- OpenSpec archive: **deferred with reason** — 本 change 由 S0a 全部子 issue 共用，只有 16 项全部完成后归档；本 PR 仅勾选 3.0 与本节证据。

## Issue #13 required evidence

- Fixture level: expanded；repair intensity: medium；权威 requirement = `specs/spa-shell/spec.md` 的“路由 IA 与侧栏”。
- [x] TDD/red-proof：先添加真实 production router + sidebar 的 jsdom 测试并在 pre-change source 上运行，因 route 模块/依赖或预期 UI 缺失而红；不得 mock RouterProvider、router 或被测组件，不留 `red-proof` stash。
- [x] `/`：渲染标题 `会话` 与阶段说明 `S0b 将接入会话与 Agent 链路`；`会话`链接是唯一 `aria-current="page"`。
- [x] `/files`：渲染标题 `工作空间` 与阶段说明 `S1a 将接入工作空间与文件`；`工作空间`链接是唯一当前项。
- [x] `/center`：渲染标题 `中心` 与阶段说明 `S1d 将接入专家、技能、连接器、知识库、模型与权限`；`中心`链接是唯一当前项，route 为平级 `/center`。
- [x] `/settings`：渲染标题 `设置` 与阶段说明 `S0a 后续任务将接入外观与关于设置`；`设置`链接是唯一当前项。
- [x] 每个 route 都显示完整四项侧栏；副标题逐字为 `文件·预览·挂载` 与 `专家·技能·知识库·模型·权限`；nav/links 使用可访问语义。
- [x] production route manifest/path 集合精确为 `/`、`/files`、`/center`、`/settings`；不存在 `/tokens` 或 `/center/*` 子 route，测试与生产共用同一 router factory/manifest 而非复制实现。
- [x] `web/src/main.tsx` 通过真实 `RouterProvider` 装配 production browser router；#11 入口测试更新为验证默认 `/` 壳，仍覆盖真实入口且测试间 history/DOM 无泄漏。
- [x] 新增 `react-router` 依赖有实际消费且版本兼容 React 19/Node 24；`npm ci`、focused web test、`npm run build --workspace web`、`make check` 与 focused knip 全绿，coverage include/阈值不收窄。
- [x] 保持 `web/src/lib/theme.ts` 及测试、server、kbservice、#11 build config 不变；不实现登录/守卫、settings 内容、用户页脚、center tabs、unknown-route 404 或 Playwright。
- OpenSpec archive: **deferred with reason** — 本 change 仍有其他 S0a 子任务；本 PR 仅勾选 3.2 与本节证据，阶段全部完成后统一归档。

## Issue #12 required evidence

- Fixture level: compact；repair intensity: low；权威 requirement = `specs/spa-shell/spec.md` 的“设置页”主题语义，当前 PR 只交付其 `lib/theme` 纯函数地基。
- [x] TDD/red-proof：先扩展既有 `web/test/theme.test.ts`，在 pre-change source 上因 `system` 值域/新 seam 缺失或旧 light fallback 而红；不 mock 被测主题函数，不留 `red-proof` stash。
- [x] `normalizeTheme("light"|"dark"|"system")` 分别原样返回；unknown string 与 null 均返回 `system`，不再回 light。
- [x] `loadTheme(reader)`：reader 返回三档时归一化返回；返回 null/unknown、reader 缺席或 reader 抛错时稳定返回 `system`，异常不外泄。
- [x] `resolveTheme("system", matchMedia)`：只以精确 query `(prefers-color-scheme: dark)` 调用注入函数一次；matches=true→dark，false→light。
- [x] `resolveTheme("light"|"dark", matchMedia)` 原样返回且 matchMedia 调用次数为 0；结果类型仅 `light | dark`。
- [x] 模块 import 与函数调用不直接读取 `window`、`localStorage` 或全局 `matchMedia`；storage key/写入/change listener/data-theme/UI 留给 #15。
- [x] focused `theme.test.ts`、`make typecheck`、web build、`make check` 与 focused knip 全绿；coverage include/阈值不收窄，无新依赖。
- [x] 保持 router/main 真实入口测试、theme 以外 web 文件、server、kbservice 和构建配置不变。
- OpenSpec archive: **deferred with reason** — stage change 尚有其他 S0a 子任务；本 PR 仅勾选 3.1 与本节证据，全部完成后统一归档。

## Issue #14 required evidence

- Fixture level: expanded；repair intensity: high；权威 requirements = `spa-shell`“登录页与路由守卫”+ `http-service-skeleton` 错误信封 + `dev-stub-auth` login/me Principal contract。
- [x] TDD/red-proof：先添加 `lib/api` unit 与 production router/auth/login jsdom 测试，在 pre-change source 上因模块/guard/UI 缺失而红；只 mock fetch 网络边界，不 mock API client/router/auth provider/login SUT，不留 red-proof stash。
- [x] API success schema：login/me 200 body 仅接受恰 `{id:string,account:string,role:string}`；缺失、额外、非 string、null/array 均为稳定前端错误，不产生 Principal。
- [x] API error schema：非 2xx 的合法 `{error:{code,message}}` 生成 `ApiError` 并保留 status/code/message；非 JSON、畸形/额外字段 envelope、2xx malformed JSON 与 fetch reject 映射 `请求失败，请稍后重试`，不得显示原始 body/stack。
- [x] Request contract：`GET /api/auth/me` 和 `POST /api/auth/login` 都使用 relative path + `credentials:"same-origin"`；login 精确 JSON body `{account,password}` 与 content-type；不记录/持久化密码/token/cookie。
- [x] Initial state matrix（真实 production router）：四个受支持 path 各自 me 401→保持同一 `location.pathname/search/hash` 并渲染 `登录 WorkBuddy`；loading 期间不渲染 shell 或 login（可访问 loading status）。
- [x] Authenticated me：`/files` me 200 Principal→工作空间壳/唯一 active；`/center` canonical/trailing-slash existing behavior仍成立；login 不显示。
- [x] Login success：在未登录 `/files` 提交账号/密码→单次 POST、按钮提交中禁用、200 Principal 后仍在 `/files` 并显示工作空间壳；不新增 `/login` 或 returnUrl。
- [x] Login failure：403 account_disabled 逐字显示 `该账号已停用，请联系管理员`；401 invalid_credentials 显示服务端 message；失败后账号保留、密码清空、按钮恢复可重试、受保护壳不闪现。
- [x] Any-401 transition：已认证状态下 API client 收到 401 时通过单一 unauthorized callback 清 Principal 并在当前 route 显示 login；非 401 错误不得错误清除现有 Principal。
- [x] Concurrency/lifecycle：同一 login form double submit 只产生一条请求；app dispose/unmount 后 pending me/login resolve 不更新状态或报 React warning；新 mount 不继承旧 Principal/error/password。
- [x] Boundary inventory：一个 Principal/envelope validator、一个 auth state owner、一个 guard composition seam；#15 可消费 Principal/logout 而无需复制状态或重写四 route manifest。
- [x] focused api/auth/login tests、`npm ci`、`make typecheck`、web build、`make check`、focused knip 全绿；coverage include/阈值不收窄，无新依赖。
- [x] 保持 theme、server/kbservice、四 route/sidebars/canonicalization/main dispose 与非目标范围不变；真实 HTTP/UI walk 继续由 #16/#17 验收。
- OpenSpec archive: **deferred with reason** — stage change 尚有 server/auth、settings、harness 等任务；本 PR 仅勾选 3.3 与本节证据，阶段全部完成后统一归档。

## Issue #15 required evidence

- Fixture level: expanded；repair intensity: high；effective accountability tier: high；上游 compact 因 browser persistence/events、strict cross-service schema、auth logout 与 shared operation state 强制升档。
- [x] TDD/red-proof：先添加 #15 API/theme/settings/footer/logout tests，在 pre-change source 上因缺 ServiceInfo/logout/ThemeProvider/settings/footer seam 或旧 placeholder 行为而红；只 mock fetch/browser boundary，不 mock API client、Provider、router、ThemeProvider/settings/footer SUT；不留 red-proof stash。
- [x] Theme initial/apply/persist：storage key 精确 `workbuddy-theme`；缺失/unknown/read throw/无 browser global → selected system；system dark/light 解析并写根 `data-theme`；选 light/dark/system 立即更新 radio、DOM 与 `当前生效：浅色|深色`，best-effort 写 enum；write throw 保持当前 memory/DOM 且不抛。
- [x] Theme event matrix：system 下 media dark→light 实时更新且 stored 仍 system；fixed light/dark 忽略 media；storage event exact key 的 light/dark/system/null/unknown 同步且不回写，其他 key 不改变；owner unmount 精确移除 media/storage listeners，迟到 event 不写。
- [x] Settings structure：production `/settings` 经真实 router/auth/theme 渲染页面标题 `设置`，且只有 `外观`/`关于` 两张设置卡和 `主题` 单选组三项；不存在 `通用` 卡、demo `5.3.11`、hardcoded success name/version 或第五 route；既有 canonical pathname/search/hash/唯一 current link 保持。
- [x] ServiceInfo API：`GET /api/info` exact relative GET + same-origin + no-store + signal；只接受 exact plain `{name,version}`、nonempty name 与共享 semver regex，缺失/额外/非 string/空 name/invalid semver/null/array 均稳定失败；valid envelope 保留 message，malformed/non-JSON/network 不泄漏并回 `请求失败，请稍后重试`。
- [x] About operation/UI：mount loading 逐字 `正在读取服务信息`，valid response 显示 returned name 与 `版本 <version>`；non401 failure 保持 Principal/settings/footer并显示 exact/stable local alert；current valid/malformed/non-JSON 401 清 Principal并在同 `/settings` URL 显示 login。About effect owns caller controller；cleanup abort caller signal，Provider 单向链接到自己的 operation controller，fetch 接收的 signal 在 caller abort/newer operation/app unmount 任一情况均 aborted，link listener 在 finally 清理；迟到 response 不写 UI/auth 或 console warning，Provider 不订阅 router。若 info 被 logout supersede而 logout 非401失败使 settings 留存，active About 必须结束 loading并显示 stable fallback，不得永久 spinner。
- [x] Footer/confirm：所有 authenticated shell route 的侧栏 footer 逐字显示 exact Principal account/role 与 `退出登录`；无 display-name/dept/avatar fabrication。点击出现 accessible `alertdialog`，标题/说明/`取消`/`退出` 逐字匹配 fixture；cancel 关闭且零 POST/状态变化。
- [x] Logout API/state：confirm 后单次 `POST /api/auth/logout`，无 body/content-type，same-origin + signal；专用 mode 在读 body 前仅凭 204 成功且不调 json/text，所有其他 2xx（含 200/205）稳定失败，非2xx走共享 envelope/401 core。204 与 current valid/malformed/non-JSON 401 均清 Principal/login error/logoutError、保持 pathname/search/hash并显示 login；403/500合法信封保 exact message，malformed success/error/network回稳定 fallback，均保 exact Principal/shell/location、login error null，并只写独立 authenticated `logoutError` 供 footer retry。
- [x] Concurrency/lifecycle：同 tick double-confirm/sibling footer invocation 只产生一个 logout；logout supersede pending info/session/login，pending logout superseded/unmount 时 abort；stale/late 204/401/non401 不能覆盖 newer operation/fresh mount；所有 external/internal listener/controller 清理，main dispose 无新增 warning。
- [x] Boundary inventory：一个 ThemeProvider/context 是 theme state/DOM/listener owner且作为 `ProtectedAppShell` 最外层包住 canonicalization/auth/login/shell；一个 ServiceInfo validator + existing envelope core + logout empty-success mode；一个 AuthProvider operationRef 授权 session/login/info/logout，Context 仅暴露窄 operations、独立 login error/logoutError，不暴露 raw API client/storage/media/router；settings/footer 不各自 fetch 或持久化。
- [x] Final verification：new focused API/theme/settings/logout tests、全部 Web tests、`make typecheck`、Web build、`make check`、focused Web Knip、strict OpenSpec、diff/size/sensitive-data/artifact scans 全绿；coverage include/threshold、800 行旧 auth test、CI/guard 不收窄，无新依赖。
- [x] Compatibility/non-goals：保持 #12 pure theme API、#14 auth/login/route/canonicalization/main dispose、server/kbservice 与四 route manifest；不实现 server endpoint、通用 modal、其他用户菜单、CSS/首屏截图、CSRF/OIDC/audit/真实 browser UI walk。
- OpenSpec archive: **deferred with reason** — shared stage change 尚有 server/auth/harness 等任务；本 PR 只勾选 3.4 与本节证据，全部完成后统一归档。
