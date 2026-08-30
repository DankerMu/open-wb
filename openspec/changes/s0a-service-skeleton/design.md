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

## Open Questions

（无——三分支已 grill 拍板，其余为实现细节。）
