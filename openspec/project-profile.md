# open-workbuddy Project Profile

> Living artifact；项目新增风险面或验证命令时在 Phase 0.5 更新。

**Project profile:** Generic（TypeScript Web 服务 + Python 知识库，多子系统）

**Entry surfaces**
- app-server：HTTP plugin 装配、唯一 listen 入口、模型代理与 omp 子进程边界。
- web：Vite 浏览器入口、history 路由、API 客户端与登录态/主题持久化。
- kbservice：HTTP 检索/摄取入口；跨服务只走网络契约。

**Contracts**
- REST 错误信封、session cookie、workspace/KB 网络契约与 SQLite 迁移。
- 浏览器路由 IA、主题存储值、构建产物 `web/dist`；`app-reference/` 永不进产物。

**Risk axes**
- 账号隔离、共享 KB 只读、沙箱越界审计、omp 环境零服务凭证。
- SPA 深链/fallback、登录态回跳、浏览器持久化与 server/web 契约漂移。
- Node/Python workspace 工具链、覆盖率/死代码/重复代码门禁兼容。

**Typical evidence**
- 最高可用 seam 的单元/集成测试、失败与边界输入、未改消费者回归。
- 固定构建输出、真实 HTTP smoke、Chromium UI 走查与零新增 console error。

**Command entry points**
- setup=`make setup`; lint=`make lint`; typecheck=`make typecheck`; test=`make test`。
- drift=`make anti-drift`; full=`make check`; guardrails=`make test-guardrails`。
- web-build=`npm run build --workspace web`（S0a #11 起可用）。

**Verification matrix**
- Web 构建/入口 -> `npm run build --workspace web` -> 退出码 0，`web/dist/index.html` 与静态资源存在。
- TS/Python 静态与类型 -> `make lint && make typecheck` -> 退出码 0。
- 单元/集成与覆盖率 -> `make test` -> 退出码 0，覆盖率均 ≥80%。
- 死代码/重复/命名/行数 -> `make anti-drift` -> 退出码 0。
- 默认全链 -> `make check` -> 退出码 0。
- 守卫机制 -> `make test-guardrails` -> 每条注入违例均 PASS。
- HTTP/UI 运行时 -> 当前无命令（AGENTS.md READINESS GAP）-> 改动仅评审；S0a harness 落地时更新。

**Domain risk packs**
- Browser runtime / navigation / persistence：深链、当前路由、登录回跳、存储失败、console error。
- Cross-service boundary / offline runtime：网络契约、无公网依赖、凭证不跨进程泄漏。

**Domain expanded-triggers**
- `createBrowserRouter`、history fallback、route guard、browser storage、Playwright、service composition。
