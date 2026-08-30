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

## Open Questions

（无——三分支已 grill 拍板，其余为实现细节。）
