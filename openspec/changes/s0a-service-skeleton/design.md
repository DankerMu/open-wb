# Design: s0a-service-skeleton

## Context

首个可运行交付。约束：AGENTS.md L3 门禁全程生效（TDD、覆盖率 ≥80、复杂度 ≤15、knip 死代码 block）；架构基准 `docs/architecture/system.md`（http→feature→core 单向依赖、模块入口文件暴露接口）；行为基准 demo（登录/设置页语义，行号见 proposal）。grill 凭证（2026-08-30，用户拍板）：Fastify / session cookie / history 路由。

## Goals / Non-Goals

- Goals：可登录、四路由可达、主题可切换并持久化的最小 web 服务；smoke 与 UI 走查成为常驻验证面。
- Non-Goals：见 proposal（审计延后、无对话链路、占位页不做内容、/tokens 不移植）。

## Decisions

1. **Fastify + plugin 装配**（grill：用户拍板；备选 Express 5/Hono 见收敛小结）。每个 feature 模块导出 FastifyPluginAsync，`app.ts` 只做装配（可注入配置，供 inject 测试）；`server.ts` 是唯一 listen 入口（启动日志输出已注册模块清单），`make dev` / `npm run start --workspace server` 拉起——app/server 分离让 inject 测试不监听端口，`knip.json` server entry 增 `src/server.ts`。启动行为的验证由 smoke（4.1）对真实启动覆盖，不写监听单测。`http/` 仅承载横切中间件（认证守卫、错误信封处理器），无业务——对齐 system.md §3.1。
2. **session cookie**（grill：用户拍板；备选 JWT 弃于"即时吊销要黑名单"）。`@fastify/cookie` + 自研 SQLite 会话表（id、user_id、expires_at），不引第三方 session 框架——表结构即 S3a OIDC 复用点，因此安全契约按长期标准定：**session id = `crypto.randomBytes(32)` hex（256 bit CSPRNG），不得由行号/时间/用户可推导量派生**；cookie 名固定为 `workbuddy_session`，属性为 httpOnly、SameSite=Lax、Path=/、无 Domain，`Secure` 只随 `createApp({secureCookies})` 的 boolean 配置（默认 false；内网 HTTP 阶段关，HTTPS 部署开）。#9 建立会话时先以默认 7 天写绝对 `expires_at=now+604800000`，使 provider 接缝在中间主干可直接消费；TTL 配置、me/logout 与惰性清理由 #10 独占。browser cookie 本刀不写 Expires/Max-Age，server-side absolute expiry 是认证真值。
3. **history 路由 + fallback**（grill：用户拍板）。`@fastify/static` 托管静态根，`setNotFoundHandler` 对**非 `/api/*` 的 GET** 回 index.html；非 GET 未命中与 `/api/*` 未命中一律 JSON 404（错误信封）。静态根可配置（`STATIC_ROOT`）：单测用临时夹具目录，CI/生产指向 `web/dist`——1.3 因此不依赖 web 构建先行。
4. **SQLite 经 `node:sqlite`**（Node 24 内建，同步 API 足够单机元数据负载；备选 better-sqlite3 弃于原生编译负担；实测 v24.13.1 可用，仅 stderr ExperimentalWarning——ui-walk 的"零 console error"断言限定为浏览器控制台，不含服务端 stderr）。`core/db`：打开 WAL、按序执行 `migrations/*.sql`、迁移版本表幂等。ADR-0004 的第一块落地。
5. **auth provider 接缝**（ADR-0007、system.md §3.1/§5）：auth 模块对外唯一认证判定出口 `authenticate(req) → Principal | null`；共享层拥有 cookie parse、session read/write、CSPRNG seam、Principal projection 与 Fastify plugin，provider 不拥有 cookie/session。dev-stub 适配器落 `server/src/auth/providers/dev-stub.ts`，只做 JavaScript `trim().toLowerCase()`、账号查询、self-describing scrypt parse/verify 与 disabled-after-password 判定；未知账号走固定 dummy scrypt，避免跳过 KDF。S3a 换 OIDC 只增 `providers/oidc.ts`，接缝、session storage 与调用方不动。单测直接对 `authenticate()` 断言有效/缺失/畸形/未知/过期/停用会话，证明接缝可替换且 read-only。
6. **登录语义镜像 demo**：账号以 JavaScript `trim()` 后 `toLowerCase()`（demo:1644）；两类错误文案逐字采用（demo:1645,1647）；停用只在密码正确后暴露 403，错误密码仍为 401；停用账号拒绝登录但**不产生审计**（Non-goal；留痕在本节与 S1a change 的 Why，代码不写无号 TODO——AGENTS.md:105）。请求只接受 exact `{account,password}` string JSON object；无效 shape 在 provider/KDF/DB write 前拒绝。**密码存储 = `node:crypto` scrypt 散列（盐+参数编码入 `password_hash` 列），以 constant-time digest compare 校验，明文不入库/响应/日志**；未知/空账号使用同参数固定 dummy encoding 执行一次 scrypt 再统一 401。seed 四账号镜像 demo（demo:1400-1407）：zhangsan/成员、zhaoliu/成员、lisi/管理员，密码 `demo`（demo:1734），另增 wangwu/成员/停用——demo 无停用 seed（disabled 是 S3a 账号页的运行时开关，demo:2942），此账号为验证 403 分支引入；四账号也满足 P3"双普通账号互不可见"验收前提。
7. **统一错误信封**（ADR-0006 语言中立 REST 的具体化，S0b 起全部端点继承）：`{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；取值域为 `bad_request`(400, `请求格式不正确`)/`invalid_credentials`(401)/`account_disabled`(403)/`unauthorized`(401)/`not_found`(404)。Issue #6 先交付后四码；Issue #9 因 exact login JSON/schema/parse boundary 增量加入 `bad_request`——login 对 Fastify 已解析未变换的 body 执行无 schema 的手写 exact 校验，形状/尺寸失败由显式 typed `bad_request` 拥有；原生 Fastify content-parser 错误仅在 matched route 恰为 `POST /api/auth/login` 且 code 命中 exact constructor-backed allowlist（`FST_ERR_CTP_INVALID_MEDIA_TYPE`、`FST_ERR_CTP_INVALID_JSON_BODY`、`FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_BODY_TOO_LARGE`）时映射为不泄漏细节的 400，不把 programmer error 或凭证错误混入。Login 不使用 route schema，因此普通/真实 `FST_ERR_VALIDATION` 形状不受信，保持 generic 5xx，除非它被显式 typed error 拥有。处理器落 `http/`，server/web/hurl 三方按同一字段断言。
8. **SPA 构建面**：Vite + @vitejs/plugin-react；`web/index.html` + `src/main.tsx` 入口；`tsconfig.base.json` 增 `jsx: react-jsx`；web 测试环境 jsdom（`web/vitest.config.ts` 覆写）；`knip.json` web entry 增 vite 约定入口（探针已证：index.html+vite.config.ts+声明依赖齐备时 knip vite 插件自动解析）；`npm run build --workspace web` 产出 `web/dist`。
9. **SPA 结构**：react-router（createBrowserRouter）；**`/center` 为扁平路由 + 页内 tab**（镜像 demo——8 tab 是页内状态 `DB.centerTab` 而非 URL，demo:3144-3161；system.md §3.3 的 `/center/*` 字面按此澄清，S1d 需要 tab 深链时再引入 query 参数，不重构 router）；`/tokens` 不移植。路由级会话守卫：未登录任意路由渲染登录页并记录原目标，登录成功跳回。`lib/api`（fetch 封装 + 错误信封解析 + 401 统一跳登录）为独立横切模块，与首个消费方（登录页）同刀落地——理由是信封解析与 401 跳转需要消费方在场才能做有意义的集成断言（非 knip 死代码考虑：自带测试即不会被判死）。主题：`lib/theme` 扩 `system` 模式（可注入 matchMedia 接口），**默认档 = system**（demo:1035），normalizeTheme 未知值/存储不可用回退 system（现有回退 light 的语义同步修正）。退出登录在**侧栏用户页脚**（demo:1816-1822，带确认），设置页不放——demo IA 如此。
10. **验证 harness**：hurl 走 `make smoke`（本地未装则目标显式失败并打印安装指引，CI 官方 installer；smoke job 先 `npm run build --workspace web` 再起服务，否则深链用例必挂）；Playwright `make ui-walk`（chromium 单浏览器）；两者进 CI 独立 job 并纳入 `all-checks-passed` needs。控制面**四处同步**（Makefile 头注释契约）：AGENTS.md Verification Matrix 两行 gap → 真命令 + Enforcement Index 升 block + Known blind spots 删过期条目 + Directory Map 增 `smoke/`；`constraints.yaml` verification.surfaces 增 smoke/ui-walk；Makefile 目标 + .PHONY。

## Sketch seams under test

- **HTTP 接口（`app.inject()`）**——Fastify 自带注入，无需起端口；auth 流程、fallback、错误信封全部经此断言。选它因为它是最高的既有 seam，覆盖 http+auth+db 三层组装。
- **`core/db` 迁移接口（`openDb(path)` 对 `:memory:`）**——迁移正确性独立可测，是后续所有表的地基。
- **`authenticate(req) → Principal` 接缝**——provider 可替换性的直接证明点（Decision 5），dev-stub 与未来 oidc 共用断言。
- **`lib/theme` 纯函数接口**——已有 seam 扩 system 模式，沿用现有测试文件。
- （Playwright/hurl 是端到端 harness 自身，不算单测 seam。）

## Risks / Trade-offs

- [node:sqlite 尚新，API 面可能变] → 封装收敛在 `core/db` 单文件，替换成本一个模块。
- [hurl 首次进 CI 可能安装摩擦] → 与 semgrep 容器同理，首跑迭代预期内；本地缺失不阻塞 `make check`（smoke 是独立目标）。
- [dev-stub 密码 `demo` 入 seed] → 仅测试值、散列入库、文档标注"非生产凭证"；gitleaks 不放行真实密钥形态。
- [React 组件与装配层拉低覆盖率] → 组件测试经 jsdom 补齐；覆盖率范围不得收窄 include 掩盖（AGENTS.md）。

## Issue #5 delivery fixture: core/db migration base

Issue type: feature
Project profile: open-workbuddy
Blast radius: medium
Fixture level: high
Repair intensity: high
Upstream suggested level: compact (override: SQLite migration, persisted schema, file path, and shared core API are mandatory expanded triggers)
Minimal mergeable slice: atomic — `openDb(path)` plus its migration tests

Must preserve:
- `openDb(path)` remains the only caller-facing database-opening seam; callers own the returned handle lifetime.
- Existing server and web behavior, module dependency direction, and tracked migration assets remain unchanged outside `server/src/core/db`.

Must add/change:
- Open SQLite with WAL where SQLite supports it, discover tracked `migrations/*.sql` in lexical filename order, and record each applied filename once.
- Reopening one file database must apply no migration twice and must expose the same schema; `:memory:` must execute the same migration set.

Risk packs considered:
- Public API / CLI / script entry: selected — `openDb(path)` is the shared core entry seam.
- Config / project setup: selected — the caller supplies the database path and migration assets must resolve independently of the process working directory.
- File IO / path safety / overwrite: selected — database and tracked SQL assets are file-backed; the DB path is trusted operator configuration, not a sandbox/user path.
- Schema / columns / units / field names: selected — migration identity and version-table shape are persisted contracts.
- Auth / permissions / secrets: not selected — no account, session, credential, or authorization data in this slice.
- Concurrency / shared state / ordering: selected — lexical ordering and WAL setup are observable shared-state rules; concurrent migration coordination is a non-goal for the single-process S0a runtime.
- Resource limits / large input / discovery: not selected — discovery is non-recursive, fixed to one tracked directory, filters direct-child `.sql` files, and accepts no runtime/external input; repository size guards bound the assets.
- Legacy compatibility / examples: selected — reopening an already migrated database must be idempotent.
- Error handling / rollback / partial outputs: selected — each migration and its version receipt must commit atomically or roll back together.
- Release / packaging / dependency compatibility: selected — use Node 24 built-in `node:sqlite`; no new runtime dependency.
- Documentation / migration notes: not selected — this PR introduces the migration mechanism and no user migration procedure.
Domain packs:
- Tenant/sandbox isolation: not selected — the operator DB path is outside the user workspace boundary.
- Auth/session lifecycle: not selected — business tables are explicitly deferred to issue #8.
- Process and child-environment isolation: not selected — this slice does not spawn, listen, log environment, or manage child processes.
- Server/web HTTP-envelope compatibility: not selected — HTTP is an explicit issue #5 non-goal.
- SQLite migration/seed compatibility: selected — filename identity, ordering, receipts, and transaction boundaries must agree.
- Offline deployability: selected — migration execution uses only tracked assets and built-in Node APIs.

Migration asset contract:
- `openDb(path)` treats bootstrap, catalog preflight, each migration, and final postflight as one rollback-preserving initialization protocol: any failed preflight/bootstrap preserves the pre-open catalog, and every successful return is immediately reopenable. The migrator idempotently bootstraps and validates `schema_migrations(sequence INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)` before trusting receipts; metadata is read through fixed `PRAGMA main.*` statements that cannot be shadowed by ordinary catalog tables. All reserved ledger/foundation names are inventoried case-insensitively across every SQLite object type before effects, so cross-type or case-variant conflicts fail. The complete ledger index inventory is also canonical: exactly the promised filename UNIQUE autoindex with its expected metadata is allowed, while any extra nonunique, partial, or expression index fails before effects. `filename` is migration identity and `sequence` records actual application order. Existing receipts must be the exact sequence-ordered Unicode scalar code-point lexical prefix of discovered migrations; malformed, duplicate, unknown, gapped, reordered, unexpectedly triggered, or hidden-counter-divergent ledger state fails before new effects. Trigger ownership follows SQLite's case-insensitive identifier semantics, and `sqlite_sequence` must be absent for an empty/no-ledger state or equal the visible maximum sequence for a non-empty ledger. Each runner receipt insert must change exactly one row and leave the expected filename at the next contiguous sequence; the resulting complete catalog is revalidated inside the same migration transaction before commit, or its trigger/schema effects and receipt roll back while an already committed prefix remains unchanged. A final read-only postflight runs before returning the handle.
- `0010_schema_migrations_update_guard.sql` installs guards that reject UPDATE and reinsertion of an existing filename (including `INSERT OR REPLACE`) on migration receipts.
- `002_schema_migrations_history.sql` installs the guard that rejects DELETE and then creates the sequence-ordered `schema_migration_history` view; these are real migration-ledger integrity/introspection rules, not business tables or placeholders. Same-name incompatible objects fail rather than being silently accepted. The intentionally mixed-width immutable names make lexical order (`0010` before `002`) observably different from numeric/natural order and leave later `01x` names for issue #8.
- Business migrations, including account/session tables and seed data, remain exclusively in issue #8.
- Discovery reads only the exact bytes of regular direct-child `.sql` files from the tracked `server/src/core/db/migrations` directory; non-SQL files and subdirectories are ignored, URL/path metacharacters cannot redirect the read, and no external migration path is accepted. Catalog definition validation treats `LF`, `CRLF`, and lone `CR` as one line-ending representation while comparing every other SQL character exactly; tracked migration SQL is additionally pinned to LF through `.gitattributes`, but runtime correctness does not depend on checkout policy.
- The runner owns transaction boundaries: migration bodies cannot execute transaction or savepoint control. A rejected/failed body leaves neither its effects nor its receipt, and failed `openDb` closes its internally owned handle.

Invariant Matrix:
- Governing invariant: every tracked SQL migration is applied in lexical filename order at most once, and its schema effects and version receipt commit atomically.
- Source-of-truth identity/contract: migration filename plus the persisted migration-version row.
- Producers: `server/src/core/db/migrations/*.sql`.
- Validators/preflight: migration discovery and filtering inside `openDb(path)`.
- Storage/cache/query: SQLite migration-version table and migrated schema.
- Public routes/entrypoints: `openDb(path)`; no HTTP route in scope.
- Frontend/downstream consumers: issue #8 migrations consume this seam; existing `service-info` is unchanged.
- Failure paths/rollback/stale state: migration transaction rolls back SQL effects and receipt together; a prior receipt suppresses replay; rollback is exercised through `openDb(path)` on a temporary file database pre-seeded with a conflicting schema object, without exposing an alternate migration directory API.
- Evidence/audit/readiness: server Vitest assertions over `:memory:` and a temporary file database, plus `make check`.
- Regression rows:
  - Fresh `:memory:` database + tracked `0010`/`002` -> `schema_migration_history` reports receipts in lexical sequence as `0010`, `002` (not numeric/natural `002`, `0010`), and UPDATE/DELETE/reinsertion-by-REPLACE on the ledger are rejected.
  - Unicode scalar comparator receives U+E000 and U+10000 filename segments -> U+E000 sorts first, unlike default UTF-16 code-unit sorting.
  - Fresh temporary file database -> `PRAGMA journal_mode` returns `wal`; `:memory:` may retain SQLite's `memory` journal mode because WAL is unsupported there.
  - Same temporary file opened twice -> second open adds no receipt and schema is identical; valid `[0010]` receipt/effect prefix continues to `[0010,002]`.
  - Malformed/no-ledger catalog, non-prefix/unknown receipt, cross-object/case-variant reserved-name conflict, receipt-prefix-inconsistent extra ledger trigger, extra nonunique/partial/expression ledger index, PRAGMA-name shadow table, or `sqlite_sequence` mismatch -> `openDb` fails before any new migration effect or receipt and preserves the pre-open catalog snapshot; unrelated non-reserved tables/triggers remain allowed.
  - Receipt INSERT reports zero or more than one changed row, or its final filename/sequence is not the expected next contiguous identity -> runner rolls back its body effect and receipt; a reachable real-SQLite body/postflight conflict likewise rolls back its current trigger/schema effect and receipt while preserving any prior committed prefix.
  - Temporary file database pre-seeded through `node:sqlite` with a conflicting `schema_migration_history` table, then passed to `openDb(path)` -> reserved-name preflight fails before bootstrap or either migration, leaves the complete pre-open `sqlite_master`/`sqlite_sequence` snapshot unchanged, and creates no ledger or receipt.
  - Migration body attempts COMMIT/ROLLBACK/SAVEPOINT control -> authorizer rejects it; its schema effects and receipt both remain absent.
  - Fixed migration directory containing a non-SQL direct child and a nested `.sql` file -> both are ignored; special filename metacharacters cannot bind a discovered receipt to different bytes.
  - LF/CRLF/lone-CR forms of the canonical trigger/view SQL -> compare equivalent and fresh/partial/complete catalogs reopen stably; any non-EOL token/body or whitespace-only space/tab drift -> validation fails transactionally, with a whitespace-collapsing comparator mutant killed by the regression matrix.
  - Any failed `openDb` path -> its internally created `DatabaseSync.close` executes; every test-owned handle closes in `finally` even when an assertion fails.
  - Existing service-info test -> unchanged behavior.

Boundary-surface checklist:
- Shared helper roots: `server/src/core/db` only.
- Public entrypoints: `openDb(path)` only.
- Read/write surfaces: trusted DB path and tracked migration directory; no user-controlled sandbox path.
- Producer/consumer evidence boundary: SQL filename to version receipt and schema transaction.
- Stale-state/idempotency boundary: previously recorded filename on reopen.
- Unchanged downstream consumers: service-info and both other workspaces.

## Issue #6 delivery fixture: Fastify assembly, envelope, static fallback

Issue type: feature
Project profile: open-workbuddy
Blast radius: high
Fixture level: high
Repair intensity: high
Upstream suggested level: compact (override: shared app entrypoint, routing, public JSON schema, configured static path, and fallback precedence are mandatory expanded triggers)
Minimal mergeable slice: atomic — tasks 1.2 + 1.4 share the global error/not-found pipeline and one `app.inject()` seam

Change surface:
- `server/src/app.ts`, `server/src/http/**`, `server/test/app.test.ts`, server dependencies/lockfile, and this issue's OpenSpec rows.

Must preserve:
- `openDb(path)` remains the only DB opener; `createApp({ db, staticRoot })` receives a caller-owned open `DatabaseSync`, makes it available to registered plugins, and never closes it, including when `app.close()` runs.
- `SERVICE_INFO` remains the single source for app-server name/version; existing core/db, service-info, web, and kbservice behavior stays unchanged.
- `server.ts`, listen commands, auth/session behavior, and web source remain out of this PR.

Must add/change:
- `createApp({ db, staticRoot? })` returns a Fastify instance ready for `app.inject()` without listening. It installs health/info routes, the typed application-error handler, API namespace 404 handling, optional static serving, and history fallback in deterministic order.
- Expected application errors use one typed `HttpError`/definition map owned by `http/`: `invalid_credentials` → 401 / `账号或密码不正确`; `account_disabled` → 403 / `该账号已停用，请联系管理员`; `unauthorized` → 401 / `请先登录`; `not_found` → 404 / `请求的资源不存在`. Envelopes contain exactly `{error:{code,message}}`; unexpected programmer 5xx errors are not relabeled as one of these semantic codes.
- `/api/healthz` returns exactly `{status:"ok"}` and `/api/info` returns exactly `SERVICE_INFO`. Exact `/api` and every unknown `/api/*` method/path resolve to the JSON `not_found` envelope and can never be served by static files or SPA fallback.
- `staticRoot` is operator-controlled deployment configuration, not a user-workspace path. When it is an existing directory, regular assets are served under their URL paths. Only a non-API `GET` miss may fall back to that root's regular `index.html`. Absent, nonexistent, non-directory, or index-less roots do not block app readiness or health/info; the static lane or fallback is simply unavailable and misses return the JSON 404 envelope. Non-GET misses never receive index.html.

Seams under test:
- Real Fastify `app.inject()` over `createApp` is the single highest seam. Tests use a real caller-owned `openDb(":memory:")`, real temporary static files, and direct test route registration that throws each real typed `HttpError`; they do not mock Fastify, the DB, filesystem, error handler, or static plugin.

Risk packs considered (core):
- Public API / CLI / script entry: selected — `createApp` becomes the shared app-server entry seam; listen/CLI remains #7.
- Config / project setup: selected — injected DB handle and optional `staticRoot` must have stable ownership/unavailable-root behavior.
- File IO / path safety / overwrite: selected — untrusted URL paths read only from the configured static root through `@fastify/static`; no writes/deletes occur. Validation, symlink checks, existence checks, and `sendFile` bind to one normalized pathname identity. Non-API static paths allow at most one percent-decoding pass; multi-encoded non-API paths fail closed, so a percent-named symlink cannot be validated under a different decoded sibling. Traversal/symlinks cannot expose outside bytes, root/nested dotfiles (including encoded forms such as `.env`) are never served, and `/api` cannot be shadowed by static content.
- Schema / columns / units / field names: selected — status/code/message and exact JSON envelope shape are public REST contracts.
- Auth / permissions / secrets: not selected — no authentication/session decision is implemented; only future auth error vocabulary is centralized.
- Concurrency / shared state / ordering: selected — Fastify route/plugin/not-found registration order must preserve API precedence and exactly-one response selection; runtime is synchronous from the caller's perspective.
- Resource limits / large input / discovery: selected — request URLs are untrusted; recursive percent-decoding is capped at four passes and any still-encoded/malformed path fails closed before static/fallback, preventing superlinear CPU/heap amplification. The operator supplies one fixed artifact root and Fastify static handles file streaming.
- Legacy compatibility / examples: selected — core/db/service-info and current workspaces remain green; future #7/#9/#10 consume the new seam/contracts.
- Error handling / rollback / partial outputs: selected — unavailable static configurations, typed errors, API misses, and non-GET misses produce stable outputs without half registration or DB ownership changes.
- Release / packaging / dependency compatibility: selected — `fastify` and `@fastify/static` are new runtime dependencies and must support Node 24/npm workspaces/offline installation from the lockfile.
- Documentation / migration notes: not selected — no user migration or operator command exists yet; fixture and PR dependency rationale are sufficient.

Domain packs:
- Tenant/sandbox isolation: not selected — `staticRoot` is a trusted deployment artifact root, not an account workspace; request-path containment remains selected under File IO.
- Auth/session lifecycle: not selected — auth routes/guards/cookies are #9/#10; this PR only provides typed errors they will consume.
- Process/child-environment isolation: not selected — no listen/spawn/env forwarding in this PR.
- SQLite migration/catalog compatibility: selected — app assembly consumes but does not mutate or own the caller's validated DB handle.
- Server/web HTTP-envelope compatibility: selected — JSON error shape, health/info bodies, static assets, and SPA index fallback are shared server/browser contracts.
- Offline deployability: selected — all runtime packages/assets resolve locally; no CDN/network dependency is introduced.
- Browser runtime/navigation/persistence: selected — direct deep-link GET must return the configured SPA index while API/non-GET misses remain JSON.
- Cross-service boundary: not selected — kbservice and external HTTP clients are untouched.

Invariant Matrix:
- Governing invariant: every injected request resolves exactly once according to method + API namespace + typed error + static-root state, with `/api` always taking precedence over static/fallback, while the app never takes ownership of the injected DB handle.
- Source-of-truth identity/contract: one normalized request pathname/method used unchanged by namespace classification, dotfile/traversal/symlink/existence validation, and the final `sendFile` target; plus the four-entry typed error map, exact `SERVICE_INFO`, injected DB handle identity, and configured static-root/index identity.
- Producers: `createApp` options, registered feature/test routes, incoming Fastify requests, `SERVICE_INFO`, and files under the configured static root.
- Validators/preflight: app assembly validates static root/index type and installs route/error/not-found precedence; `@fastify/static` confines URL reads to its root.
- Storage/cache/query: no new persisted state; `app.db` is the same caller-owned object and static responses read immutable fixture/build files.
- Public routes/entrypoints: `createApp`, `GET /api/healthz`, `GET /api/info`, exact/descendant API misses, direct static GETs, and non-API fallback/miss behavior.
- Frontend/downstream consumers: current SPA deep links/assets; future `server.ts`, auth routes/guard, hurl smoke, and browser UI walk; existing workspaces unchanged.
- Failure paths/rollback/stale state: each typed error, API 404, non-GET miss, absent/nonexistent/file/index-less static root, traversal/outside-root request, plugin/app close, and post-close DB usability.
- Evidence/audit/readiness: real `app.inject()` matrix, real temp root/outside sentinel, exact JSON/content-type/body assertions, direct DB identity/lifetime assertion, dependency lockfile, server coverage, `make check`, and strict OpenSpec validation.
- Regression rows:
  - Valid caller DB + any static-root state → app injects health/info successfully and `app.close()` leaves the same DB usable until the caller closes it.
  - Each of the four typed errors → exact status and exact two-field envelope/message; no extra Fastify error fields leak.
  - Static root with index + asset → direct asset returns its bytes; non-API deep-link GET including `/files/` and query variants returns exact index bytes; safe repeated separator-free trailing slashes do not become traversal errors.
  - Static root containing an `api/**` file + unknown `/api` or `/api/*` request → JSON 404, never file/index; known health/info still win. API identity is recognized through at most four percent-decoding passes; deeper or malformed encodings fail closed with bounded work.
  - Absent/nonexistent/regular-file/index-less static root → app becomes ready, health/info work, and deep-link miss is JSON 404 without startup failure.
  - Non-GET non-API miss → JSON 404, never index; traversal/encoded traversal never returns outside bytes; literal and one-pass encoded safe assets bind validation and `sendFile` to the same normalized pathname; multi-encoded non-API asset/symlink paths fail closed; root/nested dotfiles in literal or encoded form return typed 404.
  - Existing core/db and service-info tests plus web/kbservice suites → unchanged green behavior.

Boundary-surface checklist:
- Shared helper roots: typed error definitions/envelope sender and route-namespace classifier in `server/src/http`.
- Public entrypoints: `createApp` only for this PR; no listen entry.
- Read surfaces: caller DB identity and configured static root/index/assets; no user-workspace root.
- Write/delete/overwrite surfaces: none.
- Staging/publish/rollback surfaces: plugin registration/readiness/close; no file publish.
- Producer/consumer evidence boundaries: typed code → status/message/envelope; static root/index → exact response; SERVICE_INFO → info body.
- Stale-state/idempotency boundaries: repeated injects and app close must not mutate/close the DB or static files.
- Unchanged downstream consumers: core/db, service-info, web, kbservice, lockfile/workspace gates.

Review focus:
- Fastify encapsulation and registration order cannot let static wildcard/fallback shadow known or unknown `/api` routes.
- Error handler must preserve exact statuses/messages/shapes without swallowing unexpected 5xx or leaking default Fastify fields.
- Static-root preflight/fallback must be non-throwing for unavailable roots and containment-safe for request paths.
- App/DB ownership and `app.close()` cleanup are explicit and evidenced.
- Dependency/lockfile and coverage changes remain minimal; no auth/listen/web scope creep.

## Issue #8 delivery fixture: account/auth-session schema and dev seed

Issue type: feature
Project profile: open-workbuddy
Blast radius: high
Fixture level: high
Repair intensity: high
Upstream suggested level: compact (override: persisted migration/schema, password-derived secret material, foreign-key lifecycle, and shared auth storage are mandatory expanded triggers)
Minimal mergeable slice: atomic — one `010` migration creates both tables, seeds all four accounts, and records one receipt

Change surface:
- One direct-child `server/src/core/db/migrations/010_*.sql` asset, `openDb` foreign-key setup, focused server migration/seed tests and helpers, plus this issue's OpenSpec rows.

Must preserve:
- `openDb(path)` remains the only DB-opening seam; lexical order remains `0010`, `002`, then `010`, and each migration body/effect/receipt remains one runner-owned transaction.
- The existing migration foundation catalog, WAL behavior, caller-owned handle, Fastify app, service-info, web, and kbservice behavior remain unchanged.
- A legal `0010` + `002` database is a supported prefix that upgrades once; malformed foundation state still fails before any new business effect.

Must add/change:
- A single plain-SQL `010_auth_schema_seed.sql` creates `accounts` and `auth_sessions` without `IF NOT EXISTS`, `OR IGNORE`, or alternate bootstrap path, then inserts exactly four fixed dev-stub accounts. A late table/seed conflict therefore aborts the migration transaction rather than silently accepting unknown state.
- `accounts` has exactly `id`, `account`, `role`, `disabled`, `password_hash`; IDs are `u1`–`u4`, persisted account identity is unique nonempty lowercase ASCII `[a-z0-9._-]+` (the downstream login normalizes input via trim+lowercase before lookup), role is exactly `成员 | 管理员`, disabled is integer `0 | 1`, and no display-name/dept/sandbox/quota field is invented in this slice.
- `auth_sessions` is distinct from future Agent conversation state and has exactly `id`, `user_id`, `expires_at`; IDs are 64 lowercase hex characters, `user_id` references `accounts(id) ON DELETE CASCADE`, and expiry is a non-negative integer Unix epoch in milliseconds. `openDb` enables SQLite foreign keys for every returned connection.
- Seed hashes are four distinct precomputed scrypt values with self-describing format `scrypt$16384$8$1$<16-byte salt hex>$<32-byte digest hex>`. The tracked migration contains no plaintext `demo`; tests independently parse the encoding and use Node `scrypt` to prove each row accepts `demo` and rejects a wrong password. No production login/verifier API is added before #9.

Seams under test:
- Real `openDb(":memory:")` and a real temporary file path remain the only product seams; tests query SQLite schema/data directly and use built-in `node:crypto` only as an independent hash oracle. No DB, migrator, filesystem, or crypto mock.

Risk packs considered (core):
- Public API / CLI / script entry: selected — `openDb(path)` now promises foreign-key enforcement and the auth schema to downstream #9/#10.
- Config / project setup: not selected — no new runtime config or external migration directory; the tracked fixed directory remains authoritative.
- File IO / path safety / overwrite: selected — a new immutable tracked SQL asset must remain a regular direct child and bind its receipt to its exact bytes; existing asset-safety tests remain green.
- Schema / columns / units / field names: selected — table names, exact columns, role/disabled domains, session-id shape, foreign key action, and epoch-millisecond unit are persisted contracts.
- Auth / permissions / secrets: selected — password-derived material is stored; plaintext and reversible credentials are forbidden, and independent verification must distinguish correct/wrong passwords.
- Concurrency / shared state / ordering: selected — lexical migration order, one receipt, unique account identity, foreign-key/cascade state, and reopen idempotency are shared-state rules; multi-process migration coordination remains out of scope.
- Resource limits / large input / discovery: not selected — four fixed seed rows and one fixed SQL asset are repository-bounded; scrypt parameters are fixed and no user input/discovery occurs in this slice.
- Legacy compatibility / examples: selected — an existing valid foundation prefix upgrades atomically and a fully upgraded DB reopens without changing schema, hashes, rows, or receipts.
- Error handling / rollback / partial outputs: selected — any early/late `010` conflict must leave no new table, seed row, or receipt while preserving the committed foundation prefix byte-for-byte at the catalog level.
- Release / packaging / dependency compatibility: selected — hashing verification uses Node 24 built-in `node:crypto`; no package dependency or network/runtime download is introduced.
- Documentation / migration notes: not selected — no operator migration procedure exists yet; the tracked migration and fixture define first-install behavior.

Domain packs:
- Tenant/sandbox isolation: not selected — this slice stores account identity only and creates no workspace/sandbox path or visibility query.
- Auth/session lifecycle: selected — account identity, disabled state, hash contract, session key/user/expiry schema and cascade are the exact storage seam consumed by #9/#10.
- Process/child-environment isolation: not selected — no process, environment, model token, or credential forwarding.
- SQLite migration/seed compatibility: selected — business effects, four seed rows and receipt must commit atomically after the legal foundation prefix and remain stable on reopen.
- Server/web HTTP-envelope compatibility: not selected — no route, cookie, Principal response, or envelope behavior is implemented in this slice.
- Offline deployability: selected — SQL and Node built-ins are the only runtime inputs.
- Browser runtime/navigation/persistence: not selected — no browser behavior or client storage changes.
- Cross-service boundary: not selected — no network contract or kbservice call.

Invariant Matrix:
- Governing invariant: one tracked `010` identity atomically turns a canonical foundation prefix into exactly one constrained account/session schema plus four independently verifiable non-plaintext dev accounts, and every later open observes the identical state.
- Source-of-truth identity/contract: migration filename/receipt; `accounts.id` + normalized `account`; encoded scrypt parameter/salt/digest bytes; `auth_sessions.id` + `user_id` foreign key + millisecond expiry.
- Producers: immutable `010_auth_schema_seed.sql` and its four literal seed rows.
- Validators/preflight: existing migration discovery/catalog prefix validation; SQLite table CHECK/UNIQUE/FOREIGN KEY constraints; test-only independent scrypt parser/oracle.
- Storage/cache/query: SQLite `accounts`, `auth_sessions`, `schema_migrations`, and connection-local `PRAGMA foreign_keys`.
- Public routes/entrypoints: `openDb(path)` only; HTTP/login/authenticate remain #9/#10.
- Frontend/downstream consumers: #9 reads account/hash/disabled and writes sessions; #10 reads/deletes sessions; current app DB decorator and all existing workspaces remain unchanged.
- Failure paths/rollback/stale state: invalid row mutations are rejected; unknown pre-existing `accounts` or `auth_sessions` state conflicts; a late `auth_sessions` conflict proves earlier account DDL/seed rollback; valid complete state reopens without reseeding or hash drift.
- Evidence/audit/readiness: exact `PRAGMA table_xinfo/index_list/foreign_key_list`, seed query, scrypt correct/wrong oracle, constraint mutation matrix, full catalog/data snapshot across upgrade/reopen/failure, server coverage, `make check`, and strict OpenSpec.
- Regression rows:
  - Fresh `:memory:` open → receipts exactly `[0010,002,010]`, exact two-table schema, exact four account identities/roles/disabled values, four unique valid hashes, zero auth sessions, foreign keys enabled.
  - Each invalid account/session mutation (empty/non-normalized/duplicate account, invalid role/disabled/hash/session id/user/expiry) → SQLite rejects it without changing canonical seed/session state.
  - Valid account + session then account delete → session cascades; unknown user insert → foreign-key failure.
  - Valid foundation-only temporary file → first open adds exactly `010`; second open preserves complete catalog, seed/hash bytes, empty sessions, and receipt order.
  - Foundation prefix + pre-existing conflicting `accounts` or late-conflicting `auth_sessions` → `openDb` fails, closes its owned handle, preserves the complete pre-open catalog/data snapshot, and leaves no `010` receipt or partial schema/seed.
  - Existing core/db/app/service-info tests plus web/kbservice suites → unchanged green behavior after expected receipt assertions are advanced from foundation prefix to current complete schema.

Boundary-surface checklist:
- Shared helper roots: `server/src/core/db` migration discovery/runner/ledger; no second DB opener or seed runner.
- Public entrypoints: `openDb(path)` only.
- Read/write surfaces: fixed migration asset and SQLite schema/seed rows; no external path or user input.
- Producer/consumer boundary: SQL hash encoding and table schema → #9/#10 auth consumers; names/units are fixed now to avoid downstream forks.
- Stale-state/idempotency boundary: foundation-only prefix, complete receipt prefix, conflicting partial business catalog, repeated open.
- Unchanged downstream consumers: Fastify app DB decorator, service-info, web, kbservice.

Review focus:
- SQL constraints and tests must prove the promised domains, not merely inspect four happy-path rows.
- Hash verification must independently derive all four digests and reject a wrong password; no plaintext or fake placeholder hash may enter production SQL.
- Foundation-prefix helpers/tests must not keep calling two receipts “complete”; every accepted/failure snapshot must distinguish foundation from current full schema.
- Foreign-key enforcement must be active on the caller-visible `openDb` connection, with cascade and unknown-user rejection observed.
- Conflict tests must exercise a late failure after earlier `010` statements to prove schema/seed/receipt rollback, not only an early CREATE failure.

## Issue #9 delivery fixture: auth provider seam and dev-stub login

Issue type: feature
Project profile: open-workbuddy
Blast radius: high
Fixture level: high
Repair intensity: high
Upstream suggested level: compact (override: authentication decision seam, password KDF, CSPRNG session creation, cookie security attributes, persisted shared session state, and public login JSON/error contracts are mandatory high-risk triggers)
Minimal mergeable slice: atomic — provider verification, shared session establishment, public `authenticate(req)` and the login route define one usable auth boundary; splitting would leave either an unreachable provider or a session writer with no replaceable authentication seam

Change surface:
- `server/src/auth/index.ts` plus internal shared session/plugin files and `server/src/auth/providers/dev-stub.ts`; `server/src/app.ts`; typed HTTP error mapping; focused direct/provider/real-`app.inject()` tests; `@fastify/cookie` runtime dependency/lockfile; this issue's OpenSpec rows.

Must preserve:
- `createApp({db,...})` keeps the caller-owned DB identity/lifetime and existing API/static precedence; `openDb(path)` remains the only DB opener and the existing `010` schema/seed bytes/receipt remain unchanged.
- Existing health/info/static/error behavior, core/db migration invariants, web's exact direct Principal/error-envelope contract, and all workspaces remain green.
- TTL configuration, me/logout, lazy expiry deletion and cookie clearing remain #10; default guard policy remains #19; no web, listen/server command, audit, OIDC or new migration scope.

Must add/change:
- Auth module exports exact `Principal = {id:string,account:string,role:string}` and one public decision seam `authenticate(request) -> Principal | null`. Its request contract is the minimal Fastify-compatible `{cookies,server.db}` shape; optional injected clock exists only as a deterministic dependency, not as an alternate identity API. It reads only an own cookie property `workbuddy_session` with exact `[0-9a-f]{64}`; prototype-inherited values are absent. It validates `now` as a nonnegative safe integer (invalid clock -> null), joins `auth_sessions` to `accounts`, requires `expires_at > now` and `disabled=0`, returns an exact projection, and performs no INSERT/UPDATE/DELETE.
- Shared auth/session code owns cookie parsing, Principal projection, CSPRNG session creation, expiry assignment and session INSERT. `providers/dev-stub.ts` owns only credential normalization/query/scrypt/disabled policy and does not import HTTP or own cookie/session rows. `http` may map auth-domain failures to typed envelopes; auth must not import `server/src/http`.
- Login accepts only `application/json` exact plain `{account,password}` with no extra keys and string values. The handler applies one hand-written validator to Fastify's parsed, unmodified body and does not attach a route body schema that could invoke default AJV type coercion or additional-property stripping; global AJV behavior remains unchanged. Raw account is bounded to 256 characters, password to 1024 characters, and route body to 16 KiB; shape/size/media/JSON parse failures occur before account lookup/KDF/session write and return exact `bad_request` 400 / `请求格式不正确` without Fastify/parser/password details.
- Provider applies JavaScript `trim().toLowerCase()` then queries canonical `accounts.account`. It parses only exact `scrypt$16384$8$1$<32 lower hex>$<64 lower hex>`, derives 32 bytes with encoded salt/parameters and compares with `timingSafeEqual`. Unknown/normalized-empty account applies the request's submitted password to one fixed valid dummy encoding, executes exactly one real-equivalent scrypt path, ignores its compare result, then returns `invalid_credentials`; production contains no fixed plaintext dummy password. Disabled status is exposed only after a correct password, so disabled+wrong password is the same 401 as every other credential failure.
- Successful login calls the shared generator whose production source is exactly `crypto.randomBytes(32)` and lower-hex encoding. It validates the generated 64-lowercase-hex identity, computes `expires_at = now + 604800000` as a non-negative safe integer, and uses an explicit SQLite transaction with plain INSERT to add exactly one session. Constraint/collision/transaction failure rolls back, preserves existing rows, returns generic 5xx, and sets no cookie. If rollback itself fails, shared session code throws an AggregateError preserving original + rollback errors/cause and does not claim cleanup succeeded; if caller already owns a transaction, BEGIN fails before ownership and the caller transaction/effects remain untouched.
- Successful response is exact direct Principal JSON, carries `Cache-Control: no-store`, and one `Set-Cookie` named `workbuddy_session` whose value equals the committed row ID. Attributes are `HttpOnly; SameSite=Lax; Path=/`; `Secure` appears iff explicit `secureCookies=true` (default false); Domain, Expires and Max-Age are absent in #9.
- `@fastify/cookie` is the only new runtime package and must be compatible with Fastify 5/Node 24/npm workspaces. Cookie registration precedes auth routes without changing API catch-all/static precedence.
- Typed HTTP vocabulary adds `bad_request` for explicit `HttpError("bad_request")`; native Fastify content-parser failures are classified only by exact matched route identity plus exact constructor-backed code allowlist `FST_ERR_CTP_INVALID_MEDIA_TYPE`, `FST_ERR_CTP_INVALID_JSON_BODY`, `FST_ERR_CTP_EMPTY_JSON_BODY`, `FST_ERR_CTP_BODY_TOO_LARGE`. Login does not use route schema, so forgeable ordinary `FST_ERR_VALIDATION` shapes are not trusted. The mapper ignores raw `statusCode`: exact POST login returns 400; matched API catch-all or unmatched non-GET miss returns existing typed not_found 404; any other registered route stays generic 5xx. Arbitrary 400/413-like properties, forged codes/shapes, and DB/KDF/CSPRNG/programmer failures remain generic 5xx; no secret/error detail is reflected.

Seams under test:
- Real `createApp` + caller-owned `openDb(":memory:")` + `app.inject()` is the highest login/cookie/DB/error seam. Tests query the same SQLite handle before/after and use real `node:crypto` scrypt for canonical success/wrong/unknown/disabled scenarios.
- Direct provider factory may inject only the crypto derivation boundary to prove unknown/empty/wrong/disabled ordering without mocking provider/DB behavior; at least one test per behavior also runs the real KDF.
- Direct `authenticate()` receives minimal request-shaped input with real DB and injected `now` to prove valid/missing/malformed/unknown/equal-expiry/past-expiry/future-expiry/disabled-session behavior without HTTP.
- Session ID generator receives an injected random-byte source in its direct unit seam to prove one 32-byte request and exact hex conversion; integration uses deterministic 32-byte fixtures for DB/cookie assertions plus multiple default-source sessions for unique/non-adjacent shape evidence.

Risk packs considered (core):
- Public API / CLI / script entry: selected — `POST /api/auth/login`, `authenticate(req)` and expanded `createApp` options are shared auth entry contracts.
- Config / project setup: selected — `secureCookies` and deterministic auth dependencies must default safely; `@fastify/cookie`/lockfile must install offline-compatible.
- File IO / path safety / overwrite: not selected — no filesystem/path input; existing static path behavior is preserved.
- Schema / columns / units / field names: selected — exact body, Principal, cookie identity and epoch-millisecond session fields cross HTTP/feature/SQLite/web boundaries.
- Auth / permissions / secrets: selected — password handling, account enumeration, disabled disclosure, cookie flags and session entropy are primary invariants.
- Concurrency / shared state / ordering: selected — async KDF precedes one transaction; DB commit precedes cookie; collision/failure cannot overwrite rows or leak a header.
- Resource limits / large input / discovery: selected — login body/account/password bounds stop oversized KDF work; fixed one-account query and one scrypt per shape-valid attempt.
- Legacy compatibility / examples: selected — exact demo normalization/messages and existing web Principal/error consumers must agree; current schema/seed remains immutable.
- Error handling / rollback / partial outputs: selected — validation, KDF, disabled, CSPRNG, clock, insert collision and transaction errors have distinct stable effects with no partial session/cookie.
- Release / packaging / dependency compatibility: selected — one Fastify plugin dependency must support Node 24 and the pinned Fastify major.
- Documentation / migration notes: not selected — no deployed schema migration or operator procedure; fixture records the new internal config.

Domain packs:
- Tenant/sandbox isolation: not selected — this slice authenticates account identity but reads no tenant workspace data.
- Auth/session lifecycle: selected — session establishment and provider-independent authentication are the slice; lifecycle mutation endpoints remain #10.
- Process/child-environment isolation: not selected — no child process/env/credential forwarding.
- SQLite migration/seed compatibility: selected — no migration change is allowed; login must consume exact #8 schema and preserve all catalog/seed invariants.
- Server/web HTTP-envelope compatibility: selected — direct Principal and exact bad-request/credential/disabled envelopes are already strict web contracts.
- Offline deployability: selected — built-in crypto, SQLite and lockfile package only; no network runtime.
- Browser runtime/navigation/persistence: selected only for cookie transport attributes and same-origin web contract; no web code/persistence change.
- Cross-service boundary: not selected — no kbservice or external IdP call.

Invariant Matrix:
- Governing invariant: every shape-valid login performs exactly one bounded password-verification path before revealing account state; only a correct enabled account may atomically create one unpredictable server-side session and emit a cookie bound to that committed identity, while `authenticate` is a read-only provider-independent projection of a currently valid session.
- Source-of-truth identity/contract: canonical `accounts.account`; encoded password hash; session row `id/user_id/expires_at`; cookie `workbuddy_session`; exact Principal and typed error definitions.
- Producers: login JSON, #8 seed rows/hashes, injected clock/random-byte/KDF boundaries, SQLite session INSERT, cookie serializer.
- Validators/preflight: hand-written exact validator over unmodified parsed JSON plus route body bound; exact login route identity + Fastify request-error code allowlist; account normalizer; exact real/dummy scrypt encoding parser; CSPRNG output/clock safe-integer validator; cookie-ID regex; SQLite constraints/FK.
- Storage/cache/query: caller-owned SQLite `accounts`/`auth_sessions`; no token/local/browser storage, cache or second session repository.
- Public routes/entrypoints: `POST /api/auth/login`, `authenticate(req)`, existing `createApp`; no me/logout/guard/listen route.
- Frontend/downstream consumers: strict web `ApiClient.login` direct Principal/envelope parser; #10 consumes `authenticate`/session expiry/cookie constants; #19 consumes only `authenticate`; future OIDC reuses shared session establishment.
- Failure paths/rollback/stale state: malformed/oversized requests, unknown/empty/wrong/disabled credentials, malformed stored hash, invalid random/clock, duplicate session ID, insert/commit failure, missing/malformed/unknown/expired/disabled session cookie, repeated login.
- Evidence/audit/readiness: direct provider/authenticator/generator tests, real KDF, real `app.inject()`+SQLite rows/cookies, transaction fault/collision proof, package/lock checks, server coverage, `make check`, strict OpenSpec and secret/diff/stash scans.
- Regression rows:
  - Correct zhangsan/zhaoliu/lisi credential + fixed now/random bytes -> exact 200 Principal, no password/hash fields, one exact session row at `now+604800000`, one matching no-store cookie with secure flag exactly configured.
  - `"  ZhangSan "` -> canonical zhangsan Principal/session user; whitespace-only/unknown/wrong password -> same exact 401 after one dummy/real KDF, no cookie/session delta.
  - wangwu correct password -> exact 403 disabled; wangwu wrong password -> exact 401 invalid credentials; both run KDF and write nothing.
  - Missing/extra/non-string/null/array/empty/malformed/non-JSON/over-bound login body -> exact 400 bad_request before KDF and DB write; a default-AJV route-schema mutant that coerces non-string values or strips extras is killed; password/parser/schema detail absent.
  - Login Fastify raw 413/415 and other allowlisted request codes -> exact 400 bad_request; matched API catch-all/unmatched non-GET miss with the same native error -> exact 404 not_found; registered non-login route -> generic 5xx. StatusCode/code-prefix/global-mapper/validation-shape mutants are killed by the cross-route matrix.
  - Generator direct seam -> random source called once with 32 and exact lowercase 64-hex output; multiple default logins -> unique IDs and no adjacent integer derivation; invalid-length source/unsafe clock/collision/forced insert failure -> generic 5xx, existing sessions unchanged, no Set-Cookie.
  - Direct `authenticate` over valid/future row -> exact Principal; no/own-property-missing/prototype-inherited cookie, wrong name, malformed/uppercase/unknown ID, invalid clock, `expires_at <= now`, missing account or disabled account -> null with zero DB mutation.
  - Session collision/constraint/COMMIT failure -> rollback leaves prior snapshot; forced rollback failure -> AggregateError preserves original+rollback errors and exposes still-active transaction for caller recovery; pre-existing caller transaction -> BEGIN fails without rollback/commit or effect loss.
  - Existing health/info/API/static/error/core-db/auth-schema/web/kbservice tests -> unchanged except intentional five-code error-map advance; app close still leaves caller DB usable.

Boundary-surface checklist:
- Shared helper roots: one auth module owns Principal/cookie/session generator/writer/reader; one dev-stub provider; one typed HTTP error map.
- Public entrypoints: `createApp`, `POST /api/auth/login`, `authenticate(req)`; no second DB opener/auth repository.
- Read surfaces: bounded request JSON, parsed cookie, exact account/session rows, encoded hash.
- Write/delete/overwrite surfaces: INSERT one session only; no UPDATE/DELETE/REPLACE, cookie set only after commit.
- Staging/publish/rollback surfaces: KDF -> CSPRNG/expiry -> SQLite transaction commit -> response/cookie; every pre-commit failure emits no cookie and rollback preserves rows.
- Producer/consumer evidence boundary: stored hash -> provider result -> Principal -> session identity -> Set-Cookie -> `authenticate`/future #10/#19 and existing web parser.
- Stale/idempotency boundaries: expired/unknown/disabled-account session returns null read-only; repeated valid login creates independent rows; collision never reuses/overwrites.
- Unchanged downstream consumers: core/db catalog/migration, Fastify static/API precedence, service-info, web auth client/provider/router/settings, kbservice.

Review focus:
- Feature-to-http dependency direction stays `http -> auth`, not `auth -> http`; shared session establishment is not buried in dev-stub.
- Unknown/wrong/disabled ordering and dummy KDF cannot leak account existence through response or KDF omission.
- Cookie/header identity is exactly the committed session row and is absent on every failure; secure default/config polarity is not inverted.
- Request validation observes unmodified parsed JSON and rejects non-string/extra fields rather than letting Fastify/AJV coerce or strip them; native content-parser error mapping combines exact route owner and constructor-backed code allowlist, never trusts unreachable validation-shaped errors or global/statusCode/prefix duck typing, restores API/non-GET miss 404 precedence, and never reflects password/parser details.
- `authenticate` checks strict expiry and disabled account but does not steal #10's cleanup ownership or mutate state.
- Tests prove exact single-invariant failure paths (collision/clock/random/KDF/body) rather than generic multi-cause throws.

## Migration Plan

新增服务，无存量业务数据迁移。Issue #8 从合法 foundation prefix 原子增加首个业务 schema；Issue #9 只消费该 schema，不增加或修改 migration。回滚 = revert PR，未发布开发会话可随 DB 删除；SQLite 文件路径仍由后续 #7 配置（默认 `var/dev.db`，gitignore）。

## Issue delivery fixture: #11 web 构建工具链

- **Issue type / profile:** feature；Generic（open-workbuddy project profile）。
- **Blast radius / fixture / repair:** medium；expanded；medium。
- **Upstream suggested level:** compact — override：新增 Vite 浏览器/构建公共入口并发布 `dist` 文件产物，命中 entrypoint 与 file-output 强制 expanded 触发器。
- **Change surface:** `web` workspace 依赖与脚本、`index.html`、`src/main.tsx` 及配对 `web/test/main.test.tsx`、Vite/vitest/tsconfig、根 JSX 与 knip 接线。
- **Must preserve:** 现有 `lib/theme` 行为及测试；server/kbservice workspace 的 lint、typecheck、test、dead-code/coverage 门禁；`app-reference/` 不进产物。
- **Must add:** React 根入口可打包并在 jsdom 挂载；Vite 固定输出 `web/dist`；web 测试运行于 jsdom；JSX 与 Vite 入口被 typecheck/knip 正确解析；React 类型包满足 strict NodeNext 编译。
- **Seams under test:** `web/test/main.test.tsx` 经 Testing Library 从 `index.html` 同形 `#root` DOM 装载真实 `src/main.tsx` 并断言最小根内容；`npm run build --workspace web`（受跟踪入口 → `dist/index.html`+静态资源）；`make typecheck`（strict NodeNext + react-jsx → 退出 0）；`make check`（完整 workspace → 全部既有门禁退出 0）。
- **Selected risk packs:** Public API / CLI / script entry；Config / project setup；File IO / path safety / overwrite；Release / packaging / dependency compatibility；Browser runtime / navigation / persistence。
- **Review focus:** 构建输出位置、workspace 兼容、覆盖率/knip 未被绕过、依赖均有实际用途、无公网运行时依赖。
- **Non-goals:** 页面、路由、主题语义、登录/设置、server、CI smoke/UI 走查。

### Risk packs considered for #11

- Public API / CLI / script entry: **selected** — 新增 `web` build 脚本与浏览器入口；build 命令须成功。
- Config / project setup: **selected** — Vite、vitest、tsconfig 与 knip 必须一致接线。
- File IO / path safety / overwrite: **selected** — 构建发布 `web/dist`；只验证固定 workspace 输出，不接受用户路径，因此 traversal/symlink/rollback 矩阵不适用。
- Schema / columns / units / field names: **not selected** — 无数据格式或 API schema 变更。
- Auth / permissions / secrets: **not selected** — 无认证、凭证或权限面。
- Concurrency / shared state / ordering: **not selected** — 构建为单进程确定性命令，无持久共享状态。
- Resource limits / large input / discovery: **not selected** — Vite 仅扫描受版本控制的固定入口，不接收外部发现根或不受控输入。
- Legacy compatibility / examples: **selected** — 现有 theme 测试和另外两个 workspace 必须保持绿。
- Error handling / rollback / partial outputs: **not selected** — `dist` 是可删除重建的忽略产物，无发布/外部可见部分成功语义；非零退出由构建命令表达。
- Release / packaging / dependency compatibility: **selected** — 新运行时/开发依赖及 lockfile 必须与 Node 24/npm workspaces 兼容，产物可复现。
- Documentation / migration notes: **not selected** — 工程契约已声明 P0 引入 React/Vite；无用户迁移。
- Browser runtime / navigation / persistence: **selected** — 最小根入口须可在浏览器 DOM 装载；路由与持久化明确不在本刀。
- Cross-service boundary / offline runtime: **not selected** — 本刀不调用服务或公网，Vite 产物不得引入运行时 CDN。

## Issue delivery fixture: #13 SPA 路由壳与侧栏

- **Issue type / profile:** feature；Generic（open-workbuddy project profile）。
- **Blast radius / fixture / repair:** medium；expanded；medium。
- **Upstream suggested level:** compact — override：`createBrowserRouter` 与 routing 是项目 profile 的强制 expanded trigger，并改写浏览器公共入口。
- **Change surface:** `web/src/main.tsx`；`web/src/routes/` 模块入口、路由壳与侧栏；配对 jsdom 测试；`react-router` 依赖与 lockfile。
- **Must preserve:** #11 的真实 `#root` 挂载、Vite build/coverage/knip；现有 theme 行为；server/kbservice；history 路由；后续 #14 可在路由外层加入认证守卫，#15 可替换 settings 占位内容而不重写 IA。
- **Must add:** 仅 `/`、`/files`、`/center`、`/settings` 四个平级 route；所有页面共用侧栏+内容 outlet；当前链接以 `aria-current="page"` 唯一标识；`/center` 不定义子路由；侧栏不含 `/tokens`。
- **Sidebar copy:** `会话`；`工作空间` / `文件·预览·挂载`；`中心` / `专家·技能·知识库·模型·权限`；`设置`（demo:1773-1778）。
- **Placeholder copy:** `/` = `会话` / `S0b 将接入会话与 Agent 链路`；`/files` = `工作空间` / `S1a 将接入工作空间与文件`；`/center` = `中心` / `S1d 将接入专家、技能、连接器、知识库、模型与权限`；`/settings` = `设置` / `S0a 后续任务将接入外观与关于设置`。
- **Seams under test:** 对每个 path 写入 jsdom history 后装配真实 production browser router，渲染标题/阶段说明/完整侧栏，并断言恰好一个当前链接；路由 manifest 断言路径集合精确等于四项，排除 `/tokens` 与 `/center/*`；真实 `main.tsx` 入口回归仍通过。
- **Selected risk packs:** Public API / CLI / script entry；Config / project setup；Legacy compatibility / examples；Release / packaging / dependency compatibility；Browser runtime / navigation / persistence。
- **Review focus:** browser history 初始位置、根路由 `end` 匹配、active state 唯一性、route manifest 单一来源、main 入口接线、组件/测试无重复 router 定义。
- **Non-goals:** 登录页/认证守卫、设置内容、用户页脚、视觉定稿、中心页内 tabs、`/tokens`、未知路径自定义 404、server history fallback、Playwright。

### Risk packs considered for #13

- Public API / CLI / script entry: **selected** — 四个 browser route 与 `main.tsx` RouterProvider 是用户可见入口；jsdom 深链逐项验收。
- Config / project setup: **selected** — 新增 `react-router` 并接入现有 Vite/TypeScript/Vitest workspace；build 与全链命令须绿。
- File IO / path safety / overwrite: **not selected** — 不新增文件系统输入、输出或可配置路径；沿用 #11 固定 build 产物。
- Schema / columns / units / field names: **not selected** — 无网络/持久化 schema；route metadata 是模块内唯一常量并由渲染 seam 验收。
- Auth / permissions / secrets: **not selected** — 认证守卫明确属于 #14，本刀所有壳公开渲染且无凭证。
- Concurrency / shared state / ordering: **not selected** — 无异步状态、持久共享状态、retry 或 cancellation。
- Resource limits / large input / discovery: **not selected** — 固定四 route/四 nav item，无外部输入发现或不受控集合。
- Legacy compatibility / examples: **selected** — #11 `main.tsx` 挂载、theme、另外两个 workspace 与后继 #14/#15 接缝必须保持兼容。
- Error handling / rollback / partial outputs: **not selected** — 自定义 404 与服务端 fallback 明确非目标；四个受支持 path 无外部失败面。
- Release / packaging / dependency compatibility: **selected** — `react-router` 必须兼容 React 19、Node 24、strict NodeNext、Vite build 与 npm clean install。
- Documentation / migration notes: **not selected** — 新壳无存量用户迁移，权威 IA 已在 stage spec/design。
- Browser runtime / navigation / persistence: **selected** — history 初始深链、链接导航与 active state 是本 issue 核心；逐路由 jsdom 测试并保留后续 UI-walk 接缝。
- Cross-service boundary / offline runtime: **not selected** — 不访问 server 或公网，bundle 仍为本地依赖。

## Issue delivery fixture: #12 theme system 模式

- **Issue type / profile:** feature；Generic（open-workbuddy project profile）。
- **Blast radius / fixture / repair:** low；compact；low。
- **Upstream suggested level:** compact — agree：仅扩展既有内部纯函数 seam 与既有测试，无 package/public entrypoint、直接 browser storage、持久化写入或 UI。
- **Change surface:** `web/src/lib/theme.ts` 与 `web/test/theme.test.ts`；零新增文件、依赖或入口。
- **Must preserve:** 有效 `light`/`dark` 的归一化与解析结果；模块 import 不读取 browser globals；#11 build、#13 router、server/kbservice 和全链门禁。
- **Must add:** `Theme = light | dark | system`；`ResolvedTheme = light | dark`；`normalizeTheme(value)` 对三档原样返回，对 unknown/null 回 `system`。
- **Injected storage seam:** `loadTheme(readStoredTheme?)`；reader 缺席、返回 null/unknown 或抛错均回 `system`，不在本 issue 固定 storage key、不直接访问/写入 localStorage。
- **Injected media seam:** `resolveTheme(theme, matchMedia)`；light/dark 原样且不调用 matchMedia；system 仅查询 `(prefers-color-scheme: dark)`，matches=true→dark、false→light。
- **Seams under test:** 只扩展既有 `theme.test.ts`，覆盖三档归一化、unknown/null、reader 成功/缺席/抛错、system 深/浅解析、固定档不调用媒体查询。
- **Selected risk packs:** Schema / field names；Legacy compatibility / examples；Error handling / rollback / partial outputs；Browser runtime / navigation / persistence。
- **Non-goals:** localStorage key/写入、DOM data-theme 应用、matchMedia change listener、设置页/当前生效行、跨 tab 同步、SSR/global fallback；这些由 #15 消费该纯函数 API 时实现。

### Risk packs considered for #12

- Public API / CLI / script entry: **not selected** — 仅内部模块导出 seam，无 package export、route 或命令入口；测试直接消费。
- Config / project setup: **not selected** — 无配置、manifest、依赖或构建接线变化。
- File IO / path safety / overwrite: **not selected** — 无文件读写或路径。
- Schema / columns / units / field names: **selected** — 内部主题值域由两档扩三档；三档与未知值矩阵逐项断言。
- Auth / permissions / secrets: **not selected** — 无身份、权限或凭证。
- Concurrency / shared state / ordering: **not selected** — 不注册媒体监听、不写共享状态；仅同步纯解析。
- Resource limits / large input / discovery: **not selected** — 常量输入与单次函数调用。
- Legacy compatibility / examples: **selected** — 既有 light/dark 调用语义和全部 workspace 门禁保持绿。
- Error handling / rollback / partial outputs: **selected** — 注入 reader 缺席/抛错必须稳定回 `system`，无副作用/部分写入。
- Release / packaging / dependency compatibility: **not selected** — 无新依赖或打包契约。
- Documentation / migration notes: **not selected** — 无用户迁移；stage spec/design 是权威。
- Browser runtime / navigation / persistence: **selected** — 通过注入 seam 模拟 storage 读取和系统深浅偏好；不直接触碰 browser globals/persistence。
- Cross-service boundary / offline runtime: **not selected** — 无网络、服务或公网依赖。

## Issue delivery fixture: #14 lib/api、登录页与路由守卫

- **Issue type / profile:** feature；Generic（open-workbuddy project profile）。
- **Blast radius / fixture / repair:** high；expanded；high。
- **Upstream suggested level:** compact — override：auth/permission、public API wrapper、route guard、shared state transition 均为强制 expanded/high surface。
- **Contract completion:** login 与 me 成功响应统一为直接 Principal `{id,account,role}`，恰三个 string 字段；错误信封恰为 `{error:{code,message}}`。这是把 server/web 并行链共享的既有“用户信息”语义补为网络 shape，不新增 endpoint。
- **Change surface:** `web/src/lib/api.ts`；登录 feature；route guard/auth state；`routes`/`main` 装配；jsdom 集成测试。mock 的仅是 fetch 网络边界，router/API client/auth UI 是真实 SUT。
- **Must preserve:** #13 恰四个 route/侧栏/active/canonicalization；当前 browser URL（含 canonical pathname 与现有 search/hash）不改写为 `/login`/returnUrl；#12 theme、server/kbservice、build/coverage/knip。
- **Must add:** 初始 `GET /api/auth/me` 决定 loading→authenticated/unauthenticated；未登录任一支持 route 在原 URL 渲染 login；成功 `POST /api/auth/login` 恢复该 route；任何 API 401 清 Principal 并进入 login；403/其他信封保持未认证且显示原 message。
- **Principal:** `{id:string, account:string, role:string}`；UI 当前只需登录态，#15 将消费 account/role；不接受额外/缺失/非 string 字段。
- **API client:** relative `/api/...` only，所有 fetch 显式 `credentials:"same-origin"`；JSON request 使用 content-type；本 issue 的 200 JSON 按调用方 validator 验证；错误先按 envelope 验证，再生成稳定 `ApiError(status, code, message)`；204/logout 支持留给 #15。
- **Malformed/network errors:** 非 JSON、畸形 envelope、成功 payload shape 错误、fetch reject 都不得泄漏原始响应/stack；登录页显示稳定中文 `请求失败，请稍后重试`，状态保持可重试。
- **Login form:** 标题 `登录 WorkBuddy`；账号 label `账号`、密码 label `密码`、button `登录`；账号/密码按输入原样提交（server 负责 trim/lowercase）；提交中禁用按钮；失败后保留账号、清空密码；Enter/submit 走同一 form seam。
- **Seams under test:** real production router + AuthProvider/guard + login UI，mock global fetch；逐项断言 me/login request method/path/credentials/body、四路未登录、`/files` 成功回跳、403 逐字文案、401 transition、malformed/network fallback、double-submit 单请求、existing route/sidebar regression。
- **Selected risk packs:** Public API / CLI / script entry；Schema / field names；Auth / permissions / secrets；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs；Browser runtime / navigation / persistence；Cross-service boundary / offline runtime。
- **Non-goals:** server implementation、cookie 内容/存储、logout/user footer（#15）、CSRF/OIDC、token/localStorage、审计、settings 内容、unknown-route 404、真实 HTTP/UI walk。

### Invariant Matrix for #14

- **Governing invariant:** UI 认证态只由同一 Principal contract 与最新有效 API transition 决定；未认证内容不可闪现，401 必清态，登录成功只恢复当前受支持 route。
- **Source-of-truth identity/contract:** direct Principal `{id,account,role}`；error envelope `{error:{code,message}}`；browser `location` 是原目标。
- **Producers:** server `/api/auth/login`、`/api/auth/me`（本 PR 以 contract-bound fetch mock 模拟）；前端不伪造 Principal。
- **Validators/preflight:** `lib/api` envelope/Principal validators；login form required input/submit lock。
- **Storage/cache/query:** React 内存 auth state only；不使用 localStorage/sessionStorage/token/query return URL。
- **Public routes/entrypoints:** existing four-route `createAppRouter` + real `main.tsx`；login 是 guard render state，不新增 route。
- **Frontend/downstream consumers:** guard、login page；#15 sidebar footer consumes Principal and logout seam later。
- **Failure/rollback/stale state:** initial loading blocks shell/login flash；401 clears state；failed login leaves unauthenticated/retryable; stale/late duplicate submission cannot overwrite newer state because only one submit is admitted。
- **Evidence/audit/readiness:** jsdom+mock fetch request/transition matrix；`make check`/CI；real browser deferred #17。
- **Regression rows:** valid me on `/files`→files shell + Principal；me 401→same `/files` URL + login；valid login→same `/files` shell；403 envelope→exact disabled message/no shell；malformed/network→stable fallback/no Principal；unchanged `/center` active/canonical route→same behavior after authenticated me。

### Boundary-surface checklist for #14

- Shared helper roots: `lib/api` and auth state/provider — one error/Principal validator, no per-component forks。
- Public entrypoints: `main.tsx` and `createAppRouter` consume one auth wrapper/factory。
- Read surfaces: me/login response JSON only, bounded to normal fetch JSON payload; no file/network discovery。
- Write/delete/overwrite: no local persistence; only POST login network side effect and in-memory state。
- Producer/consumer boundaries: server spec ↔ API validator ↔ auth state ↔ guard/login/#15 Principal consumer。
- Stale/idempotency: one in-flight login per form; initial me transition disposed safely with app lifecycle; no post-unmount state update warnings。
- Unchanged consumers: route manifest/sidebar/theme tests and main dispose lifecycle。

### Risk packs considered for #14

- Public API / CLI / script entry: **selected** — shared fetch wrapper and four-route guard alter browser entry behavior；request/response integration matrix。
- Config / project setup: **not selected** — no new config/dependency/build wiring。
- File IO / path safety / overwrite: **not selected** — no filesystem or user paths；browser path remains existing router contract。
- Schema / columns / units / field names: **selected** — strict Principal/envelope/request JSON fields across server/web；malformed/extra/missing matrix。
- Auth / permissions / secrets: **selected** — credentials and session-cookie flow；password only in request body, never state/log/storage；401 transition matrix。
- Concurrency / shared state / ordering: **selected** — initial me loading and login submit race/double-submit/unmount lifecycle；single admitted transition。
- Resource limits / large input / discovery: **not selected** — fixed endpoints and normal JSON payloads；no discovery/unbounded collection。
- Legacy compatibility / examples: **selected** — all existing routes/sidebar/main lifecycle/theme and server-independent tests remain green。
- Error handling / rollback / partial outputs: **selected** — 401/403/other envelope、malformed JSON、fetch rejection and retry state all tested；no partial authenticated shell。
- Release / packaging / dependency compatibility: **not selected** — use platform fetch/React, no dependency change。
- Documentation / migration notes: **not selected** — no user migration；OpenSpec is shared contract。
- Browser runtime / navigation / persistence: **selected** — same-URL guard, original-route restore, loading/no flash, no browser credential storage。
- Cross-service boundary / offline runtime: **selected** — relative same-origin endpoints and cookie credentials；mock fetch locked to server spec, no公网 endpoint。

## Issue delivery fixture: #15 设置页与侧栏用户页脚

- **Issue type / profile:** feature；Generic（open-workbuddy project profile）。
- **Blast radius / fixture / repair:** high；expanded；high。
- **Upstream suggested level:** compact — override：browser storage/system listener/cross-tab shared state、strict `/api/info` schema、Provider-owned logout 与 auth transition/cancellation 均命中 expanded/high 触发器。
- **Minimal mergeable slice:** atomic — 全局主题 owner、设置两卡、ServiceInfo consumer 与侧栏 logout 共用现有 router/AuthProvider/API 状态边界，拆开会留下死导出、无消费者 contract 或重复状态 owner。
- **Dependencies:** #12 与 #14 已合并；server `/api/info` 与 `/api/auth/logout` 的实现仍分别属于共享任务 1.2/2.3，本 issue 只实现 Web consumer，并以本 change 的 exact contract 绑定 fetch mock。
- **Change surface:** `lib/theme` browser adapter + 单一 ThemeProvider；strict API client 的 info/logout；既有 AuthProvider operation coordinator；settings feature；现有 router shell/sidebar；新的 jsdom/API/theme tests。`auth-router.test.tsx` 已恰好 800 行，不追加 #15 case。
- **Must preserve:** #14 latest-operation/signal authority、any-current-401、non-401 Principal preservation、same-location guard、canonicalization/Provider retention、四 route/唯一 current link、main dispose；#12 pure normalize/load/resolve seams；server/kbservice 与 coverage/Knip/size/CI 门禁。
- **Must add — theme owner:** production storage key 恰为 `workbuddy-theme`，持久值恰为 `light|dark|system`。唯一 ThemeProvider 初始化时安全读取 storage（缺失/unknown/throw→system），解析后写 `document.documentElement.dataset.theme`；同 tab 选择先更新内存/DOM，再 best-effort 写 storage，写失败不回滚内存选择且不抛 UI error。module import 不读 browser globals；缺失 `window`/`document`/`matchMedia`/storage 时稳定以 system+light fallback 工作。
- **Theme subscriptions:** system 只使用 `(prefers-color-scheme: dark)`；system 档的 media change 实时更新 resolved/DOM/当前生效行但不改 stored `system`，固定档忽略系统变化。`storage` 事件只消费 exact key；有效值同步，null/unknown→system，其他 key 忽略；remote event 不回写 storage。owner unmount 移除 media/storage listeners。为避免两套初始化规则，不新增 inline `index.html` theme script；pre-React first-paint styling 属 #17 真实浏览器观察面，本 PR 只保证首次 React commit 前的 layout effect 应用。
- **Theme UI:** `/settings` 仍使用既有 route/handle，渲染页面标题 `设置` 与且仅两张带 `h2` 的卡 `外观`/`关于`，无 `通用` 卡。外观卡有名为 `主题` 的单选组，逐字选项 `浅色`/`深色`/`跟随系统`；当前行恰为 `当前生效：浅色|深色`，消费唯一 ThemeContext，不直接读写 globals/storage。
- **ServiceInfo contract:** `GET /api/info` 使用 relative path、GET、`credentials:"same-origin"`、`cache:"no-store"` 与 operation signal；200 只接受 exact plain JSON `{name:string,version:string}`，name 非空，version 按服务端现有 regex `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`。关于卡逐字显示返回 name 与 `版本 <version>`，loading=`正在读取服务信息`；合法非 401 envelope 显示 message，malformed/non-JSON/network 显示稳定 fallback，不用 demo name/version 伪造成功。
- **Provider-owned info:** AuthContext 暴露窄 `loadServiceInfo(callerSignal) → Promise<ServiceInfo | null>` operation，不暴露 raw ApiClient。About mount 创建 lifecycle AbortController，cleanup（包括 `/settings` route element 离开）只 abort `callerSignal`；Provider 不订阅 router/location。Provider 启动自己的 operation controller：callerSignal 已 aborted 时立即 abort，否则注册一次性 abort listener，把 caller abort 单向链接到 operation controller；fetch 只接收该 operation controller 的 signal。任一 caller abort、更新 Provider operation、About cleanup 或 app unmount 都使同一个可观察 request signal aborted；`finally` 移除 caller listener。aborted/stale/current-401 均返回 null；caller cleanup 后 About 已 inactive，不写任何 state；current 401 最终卸载 About。若 operation 被 sibling operation supersede、其结果为 null但 logout/login 非 401 失败使 authenticated settings 仍 mounted，active About SHALL 结束 loading 并显示 stable fallback，而非永久 spinner。非 stale non-401 API error 向 About reject，由其显示。current 401 仍只经一个 callback 清 Principal；non-401 info error 不改 auth state。
- **Logout API/UI:** API client `POST /api/auth/logout` 无 body/content-type，带 same-origin credentials 与 operation signal。logout 使用专用 empty-success mode：fetch 返回后先检查 `status===204` 并直接成功，绝不调用 `response.json()`/`text()`；HTTP 204 的 body 由 server contract 禁止，browser client 按 status 接受并忽略不可用 body。其他状态进入共享 JSON/error-envelope core；任何其他 2xx（含 200/205）最终均为 stable `request_failed`。AuthContext 暴露窄 `logout() → Promise<boolean>`，共享同一 operationRef，单次只允许一个 logout；启动 logout abort pending session/login/info。204 或 current 401（含 malformed/non-JSON 401）都以 `true` 终止为 unauthenticated、Principal/login `error`/`logoutError` null。`logoutError` 是 AuthState/AuthContext 的独立 authenticated-scope 字段：LoginForm 只读既有 `error`，footer 只读 `logoutError`；任一 auth terminal transition清 `logoutError`，新 logout 开始也先清它。非 401 envelope/network/非204 success 以 `false` 保留 exact Principal/shell/location、保持 login `error` 为 null，并只把合法 message 或 stable fallback 写入 `logoutError`，后续 retry 清旧值。
- **Footer/confirm:** 已认证侧栏 footer 直接显示 Principal `account`/`role` 原字节（不发明 name/dept/本地化映射）与 `退出登录`。单用途 inline `alertdialog`（不抽象通用 modal/portal）逐字使用标题 `退出登录？`、说明 `退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。`、按钮 `取消`/`退出`。取消零请求；确认 pending 时禁用重复动作，terminal 后关闭；204/current 401 在原 pathname/search/hash 显示登录，failure 回 footer alert 并可重试。
- **Seams under test:** pure theme helpers + injected browser environment；真实 ThemeProvider/settings/router；真实 AuthProvider/Guard/footer/confirm；mock 仅 localStorage/matchMedia/browser event 与 fetch network boundary。API unit 严格断言 info/logout request/response branches；#15 新建测试文件承载 Provider/logout/settings 生命周期，不扩 800 行旧文件。
- **Selected risk packs:** Public API / CLI / script entry；Schema / field names；Auth / permissions / secrets；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs；Browser runtime / navigation / persistence；Cross-service boundary / offline runtime。
- **Non-goals:** server endpoint implementation、通用 modal library、demo 沙箱/账号/切换账号菜单、display name/dept/avatar、theme toast/topbar toggle、CSS/视觉定稿、首屏截图与真实 browser cookie/storage/autofill（#17）、CSRF/OIDC/audit、unknown-route 404、依赖/config/CI 改动。

### Invariant Matrix for #15

- **Governing invariant:** 主题 UI/DOM 只由归一化的当前 theme 选择与当前 system preference 决定；认证/API UI 只由 exact network contract 与最新获授权 Provider operation 决定，旧/取消/卸载工作不得覆盖更新状态。
- **Source-of-truth identity/contract:** theme key `workbuddy-theme` + enum `light|dark|system` + resolved `light|dark`；direct Principal；exact ServiceInfo `{name,version}`；logout 204/current-401 terminal；operation controller signal。
- **Producers:** localStorage/system media/storage events；server info/logout responses（本 PR contract-bound fetch mock）；当前 Principal 来自 #14 me/login。
- **Validators/preflight:** existing normalize/load/resolve theme pure seams；one ThemeProvider adapter；one ServiceInfo validator + existing envelope helper；confirm before logout。
- **Storage/cache/query:** localStorage 只存 selected theme；DOM `data-theme` 只存 resolved theme；info GET no-store；Principal/auth error 只在 AuthProvider memory。
- **Public routes/entrypoints:** existing four-route `createAppRouter`/real main；ThemeProvider 是 `ProtectedAppShell` 内最外层 owner，初始 canonical Navigate 期间也保持 mounted，并包住后续 AuthProvider/login/shell；#14 的 AuthProvider 仍只在 canonical location 后启动。`/settings` 替换 placeholder 而不增 route；sidebar footer 仅在 authenticated shell。
- **Frontend/downstream consumers:** appearance card consumes ThemeContext；About consumes Provider-owned info operation and owns only its caller lifecycle controller/local display error；footer consumes Principal/logoutError/logout；LoginForm alone consumes login error；Guard consumes auth state。
- **Failure/rollback/stale state:** storage read/write/global absence stable；system/storage listener cleanup；About cleanup caller-abort linked to info operation；info stale/401；logout cancel/double submit/204/401/non401/network/unmount；newer operation aborts predecessor；login error 与 logoutError 不串台。
- **Evidence/audit/readiness:** API/theme units + production router/Provider/settings/footer jsdom；mutation-capable exact branch tests；build/type/full check/strict OpenSpec/CI；real UI deferred #17。
- **Regression rows:**
  - no/unknown/throwing storage + system dark → selected system, resolved dark, `data-theme=dark`, no thrown UI error；write throw + choose light → memory/DOM light while stored value unchanged。
  - selected system + media dark→light → current line/data-theme update, persisted `system` unchanged；fixed dark + same media event → remains dark；unmount → both listeners removed。
  - storage event exact key dark/null/unknown → dark/system/system; other key → no change; event does not call writer。
  - `/settings` + valid info → exact two cards, account/role footer, returned name/version；malformed/network → stable alert, Principal/shell retained；current info 401 → login at same location。
  - cancel logout → zero POST/auth change；confirm + 204 or current 401 → one POST, Principal cleared/login same location；403/network/malformed success → exact Principal retained, footer alert, retry admitted。
  - pending info + About route-element cleanup/logout/app dispose → caller abort 或 operation supersession 使传给 fetch 的 operation signal aborted，listener 被移除，late response 不能写 state/console warning；AuthProvider 不订阅 location。若 superseding logout 非 401 失败且 settings 留存，About 结束 loading并显示 stable fallback，Principal 与独立 logoutError 同时按各自 contract 保留。
  - unchanged `/files`/`/center` route, canonical variants, login transitions, theme pure tests, main dispose, server/kbservice → prior behavior green。

### Boundary-surface checklist for #15

- **Shared helper roots:** `lib/theme` + ThemeProvider；`lib/api` validators/request core；AuthProvider operationRef。
- **Public entrypoints:** existing `createAppRouter`/main only；no new route, raw client or package entry。
- **Read surfaces:** localStorage/system/storage event；info/logout HTTP response；Principal context。
- **Write/delete/overwrite:** one theme key + root `data-theme`；logout server side effect；in-memory auth/about state。
- **Producer/consumer evidence boundary:** browser adapter → ThemeContext → settings；server spec → API validator → Provider operation → about/footer/Guard。
- **Stale/idempotency:** event listener ownership；cross-tab no echo；single logout；About caller signal→Provider operation controller 单向 abort linkage/cleanup；latest operation identity；独立 login error/logoutError ownership。
- **Unchanged downstream consumers:** login form/AuthGuard, route manifest/nav/canonicalization, main dispose, theme pure callers, server/kbservice。

### Risk packs considered for #15

- Public API / CLI / script entry: **selected** — AuthContext 增窄 info/logout operations，settings route element/footer 改用户入口；真实 production router seam 验收。
- Config / project setup: **not selected** — 无依赖、构建、tsconfig、CI 或环境配置变化。
- File IO / path safety / overwrite: **not selected** — 无文件/用户路径；localStorage 是固定单 key browser persistence，由 browser pack 覆盖。
- Schema / columns / units / field names: **selected** — ServiceInfo exact keys/semver、204 empty body、theme enum/key、Principal account/role；malformed/extra/missing matrix。
- Auth / permissions / secrets: **selected** — logout 会话失效与 current 401；不暴露 raw client/cookie/token，不记录 Principal 之外字段。
- Concurrency / shared state / ordering: **selected** — theme media/storage events、cross-tab、info/logout/session/login operation supersession、double submit、unmount cancellation。
- Resource limits / large input / discovery: **not selected** — 固定三档、两卡、两个 endpoint，无 unbounded input/discovery。
- Legacy compatibility / examples: **selected** — #12/#14 public seams、四 route/sidebar/main、server/kbservice 保持兼容；demo 只取明确行为不复制 mock 身份字段。
- Error handling / rollback / partial outputs: **selected** — storage/global failure、info malformed/network/401、logout 204/401/non401/network；错误不泄漏且失败保 Principal。
- Release / packaging / dependency compatibility: **not selected** — platform fetch/storage/matchMedia/React only，无新依赖/产物 contract。
- Documentation / migration notes: **not selected** — production storage key 为新值，无存量迁移；OpenSpec 即共享 contract。
- Browser runtime / navigation / persistence: **selected** — data-theme、localStorage、system/storage listeners、route leave、same-location logout 与 UI 交互。
- Cross-service boundary / offline runtime: **selected** — `/api/info` 与 `/api/auth/logout` exact contract、same-origin credentials/no-store、无公网依赖。

## Open Questions

（无——三分支已 grill 拍板；#15 的 storage/info/logout/确认语义已在本 fixture 闭合，其余为实现细节。）
