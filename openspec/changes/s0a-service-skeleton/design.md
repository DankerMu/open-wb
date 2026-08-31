# Design: s0a-service-skeleton

## Context

首个可运行交付。约束：AGENTS.md L3 门禁全程生效（TDD、覆盖率 ≥80、复杂度 ≤15、knip 死代码 block）；架构基准 `docs/architecture/system.md`（http→feature→core 单向依赖、模块入口文件暴露接口）；行为基准 demo（登录/设置页语义，行号见 proposal）。grill 凭证（2026-08-30，用户拍板）：Fastify / session cookie / history 路由。

## Goals / Non-Goals

- Goals：可登录、四路由可达、主题可切换并持久化的最小 web 服务；smoke 与 UI 走查成为常驻验证面。
- Non-Goals：见 proposal（审计延后、无对话链路、占位页不做内容、/tokens 不移植）。

## Decisions

1. **Fastify + plugin 装配**（grill：用户拍板；备选 Express 5/Hono 见收敛小结）。每个 feature 模块导出 FastifyPluginAsync，`app.ts` 只做装配（可注入配置，供 inject 测试）；`server.ts` 是唯一 listen 入口（启动日志输出已注册模块清单），`make dev` / `npm run start --workspace server` 拉起——app/server 分离让 inject 测试不监听端口，`knip.json` server entry 增 `src/server.ts`。启动行为的验证由 smoke（4.1）对真实启动覆盖，不写监听单测。`http/` 仅承载横切中间件（认证守卫、错误信封处理器），无业务——对齐 system.md §3.1。
2. **session cookie**（grill：用户拍板；备选 JWT 弃于"即时吊销要黑名单"）。`@fastify/cookie` + 自研 SQLite 会话表（id、user_id、expires_at），不引第三方 session 框架——表结构即 S3a OIDC 复用点，因此安全契约按长期标准定：**session id = `crypto.randomBytes(32)` hex（256 bit CSPRNG），不得由行号/时间/用户可推导量派生**；TTL 为配置项（默认 7 天，绝对过期，惰性清理）；cookie：httpOnly、SameSite=Lax、Path=/、`Secure` 随部署形态的配置项（内网 HTTP 阶段关，HTTPS 部署开）。
3. **history 路由 + fallback**（grill：用户拍板）。`@fastify/static` 托管静态根，`setNotFoundHandler` 对**非 `/api/*` 的 GET** 回 index.html；非 GET 未命中与 `/api/*` 未命中一律 JSON 404（错误信封）。静态根可配置（`STATIC_ROOT`）：单测用临时夹具目录，CI/生产指向 `web/dist`——1.3 因此不依赖 web 构建先行。
4. **SQLite 经 `node:sqlite`**（Node 24 内建，同步 API 足够单机元数据负载；备选 better-sqlite3 弃于原生编译负担；实测 v24.13.1 可用，仅 stderr ExperimentalWarning——ui-walk 的"零 console error"断言限定为浏览器控制台，不含服务端 stderr）。`core/db`：打开 WAL、按序执行 `migrations/*.sql`、迁移版本表幂等。ADR-0004 的第一块落地。
5. **auth provider 接缝**（ADR-0007、system.md §3.1/§5）：auth 模块对外唯一出口 `authenticate(req) → Principal | null`；dev-stub 适配器落 `server/src/auth/providers/dev-stub.ts`（登录流程），会话读取与守卫在 auth 模块内共享——S3a 换 OIDC 只增 `providers/oidc.ts`，接缝与调用方不动。单测直接对 `authenticate()` 断言以证明接缝可替换。
6. **登录语义镜像 demo**：账号 trim+小写化（demo:1644）；两类错误文案逐字采用（demo:1645,1647）；停用账号拒绝登录但**不产生审计**（Non-goal；留痕在本节与 S1a change 的 Why，代码不写无号 TODO——AGENTS.md:105）。**密码存储 = `node:crypto` scrypt 散列（盐+参数编码入 `password_hash` 列），明文不入库**；seed 四账号镜像 demo（demo:1400-1407）：zhangsan/成员、zhaoliu/成员、lisi/管理员，密码 `demo`（demo:1734），另增 wangwu/成员/停用——demo 无停用 seed（disabled 是 S3a 账号页的运行时开关，demo:2942），此账号为验证 403 分支引入；四账号也满足 P3"双普通账号互不可见"验收前提。
7. **统一错误信封**（ADR-0006 语言中立 REST 的具体化，S0b 起全部端点继承）：`{ "error": { "code": "<snake_case>", "message": "<可直接展示的中文文案>" } }`；本阶段取值域 `invalid_credentials`(401)/`account_disabled`(403)/`unauthorized`(401)/`not_found`(404)。处理器落 `http/`，server/web/hurl 三方按同一字段断言。
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

## Migration Plan

新增服务，无存量迁移。回滚 = revert PR；SQLite 文件路径可配置（默认 `var/dev.db`，gitignore）。

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

## Open Questions

（无——三分支已 grill 拍板，其余为实现细节。）
