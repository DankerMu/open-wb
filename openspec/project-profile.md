# open-workbuddy Project Profile

> Living artifact；项目新增风险面或验证命令时在 Phase 0.5 更新。

**Project profile:** Generic（TypeScript Web 服务 + Python 知识库，多子系统）

**Entry surfaces**
- app-server：Fastify plugin 装配、REST、唯一 listen 入口、SQLite、模型代理与 omp 子进程边界。
- web：Vite 浏览器入口、history 路由、API 客户端与登录态/主题持久化。
- kbservice：HTTP 检索/摄取入口；跨服务只走网络契约。
- operator：Make 目标、GitHub Actions、hurl smoke 与 Playwright UI 走查。

**Contracts**
- REST 错误信封、session cookie、workspace/KB 网络契约与 SQLite migration receipt/schema。
- 浏览器路由 IA、主题存储值、构建产物 `web/dist`；`app-reference/` 永不进产物。
- 模块依赖遵循 `http -> feature -> core`；沙箱、凭证、租户与审计不变量以 `AGENTS.md`/`CONTEXT.md` 为准。

**Risk axes**
- 账号隔离、共享 KB 只读、沙箱越界审计、omp 环境零服务凭证。
- SQLite schema/迁移/hidden catalog state、文件路径、进程生命周期与共享状态顺序。
- SPA 深链/fallback、登录态回跳、浏览器持久化与 server/web 契约漂移。
- Node/Python workspace 工具链、覆盖率/死代码/重复代码门禁兼容。

**Typical evidence**
- Fastify `app.inject()`；公共 seam Vitest + 真实内存/临时 SQLite；失败、回滚、重开与未改消费者回归。
- 固定 web 构建输出、jsdom 组件/路由断言、真实 HTTP smoke、Chromium UI 走查与零新增 console error。
- 全仓 lint/typecheck/test/knip/jscpd/guard，以及 schema/version/权限负向断言。

**Command entry points**
- setup=`make setup`; lint=`make lint`; typecheck=`make typecheck`; test=`make test`。
- drift=`make anti-drift`; full=`make check`; guardrails=`make test-guardrails`。
- server-test=`npm test --workspace server`; server-build=`npm run build --workspace server`; server-start=`npm run start --workspace server`; dev=`make dev`。
- web-test=`npm test --workspace web`; web-build=`npm run build --workspace web`；kb-test=`cd kbservice && uv run pytest`。

**Verification matrix**
- Web 构建/入口 -> `npm run build --workspace web` -> 退出码 0，`web/dist/index.html` 与静态资源存在。
- TS/Python 静态与类型 -> `make lint && make typecheck` -> 退出码 0。
- Server/SQLite/HTTP seam -> `npm test --workspace server` -> 退出码 0，coverage ≥80%。
- Server build/production entry -> `npm run build --workspace server` + controlled compiled-process probe -> dist JS/migration assets完整；health 200；startup JSON/env/default identity正确；SIGTERM释放DB/port。正式常驻HTTP回归由#16 `make smoke`接管。
- Web 行为 -> `npm test --workspace web` -> 退出码 0，coverage ≥80%。
- Python 行为 -> `cd kbservice && uv run pytest` -> 退出码 0，coverage ≥80%。
- 死代码/重复/命名/行数 -> `make anti-drift` -> 退出码 0。
- 默认全链 -> `make check` -> 退出码 0。
- 守卫机制 -> `make test-guardrails` -> 每条注入违例均 PASS。
- HTTP/UI 运行时 -> 当前无命令（AGENTS.md READINESS GAP）-> 改动仅评审；S0a harness 落地时更新。

**Domain risk packs**
- Tenant/sandbox isolation；auth/session lifecycle；process/child-environment isolation。
- SQLite migration/catalog compatibility；server/web HTTP-envelope compatibility；offline deployability。
- Browser runtime/navigation/persistence：深链、当前路由、登录回跳、存储失败、console error。
- Cross-service boundary：网络契约、无公网依赖、凭证不跨进程泄漏。

**Domain expanded-triggers**
- Fastify assembly/routes/hooks、session cookies/TTL、SQLite migrations/seed、sandbox/static paths。
- `createBrowserRouter`、history fallback、route guard、browser storage、Playwright、service composition。
- Process spawn/listen/shutdown、cross-service contracts、smoke/UI harness、CI/production configuration。
