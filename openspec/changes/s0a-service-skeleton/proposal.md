# Proposal: s0a-service-skeleton

## Why

IMPLEMENTATION_PLAN.md S0a：项目目前只有脚手架，无任何可运行服务。本阶段立起 app-server HTTP 骨架、SPA 壳与运行时验证 harness，为后续所有阶段提供承载面，并关闭 AGENTS.md 两条 READINESS GAP（HTTP smoke / UI 走查）。

## What Changes

- 新增 web 构建工具链：Vite + React（AGENTS.md Stack "P0 引入 React + Vite"），`npm run build --workspace web` 可复现产出 `web/dist`；tsconfig 增 JSX、vitest 增 jsdom 环境、knip entry 同步。
- 新增 Fastify app-server：健康/服务信息端点、统一错误信封（ADR-0006 语言中立 REST 约定的具体化）、静态 SPA 托管（history fallback）、`server.ts` 启动入口与 `make dev` 命令面、模块化 plugin 装配（grill 已定：Fastify）。
- 新增 dev-stub 认证：auth 模块以 `authenticate(req) → Principal` 单一出口暴露（ADR-0007 provider 接缝，dev-stub 为首个适配器）；SQLite seed 四账号（镜像 demo 三账号 + 增列一个停用账号）、登录/登出、服务端 session cookie（httpOnly；grill 已定：cookie 载体）。登录错误语义镜像 demo（demo:1644-1647）：账号 trim+小写化、"账号或密码不正确"、"该账号已停用，请联系管理员"。密码以 scrypt 散列存储，明文不入库。
- 新增 SPA 壳：history 路由（grill 已定）四页 `/`、`/files`、`/center`、`/settings` + 侧栏 4 tab 与用户页脚（含退出登录，demo:1816-1822）；设置页 = 主题三档（浅色/深色/跟随系统，默认跟随系统，即时生效+持久化）+ 关于卡（版本取 `GET /api/info`，不沿用 demo 5.3.11）。未登录访问任意路由渲染登录页，登录后回原目标。
- 新增验证 harness：`smoke/*.hurl` + `make smoke`、Playwright 走查 + `make ui-walk`，两者接入 CI；AGENTS.md Verification Matrix 两条 READINESS GAP 行、Enforcement Index、Known blind spots、Directory Map 与 `constraints.yaml` verification 段同步更新（Makefile 头注释的"三处同步"契约）。
- `core/db` 最小落地：SQLite（`node:sqlite`）打开 + 迁移执行（账号表与会话表是首批迁移）。

## 功能覆盖声明

覆盖 F-SET-1（主题/关于）。**"通用"分档处置**：demo 设置页（demo:3533-3567）只有"外观"与"关于"两个分区，无"通用"设置——该分档在行为基准中为空集，本阶段判定不存在对应功能，特此留痕以保持覆盖表可核对。

## Non-goals

- 登录/登出/停用尝试的审计事件（demo 有此行为）：`core/audit` 属 S1a，本阶段显式延后；留痕方式 = 本 design 与 S1a change 的 Why，代码内不写无号 TODO（AGENTS.md 禁无 issue 号 TODO）。
- omp 对话链路、SSE（S0b）；工作空间/文件（S1a）。
- `/center` 8 个 tab 的内容与页内 tab 切换（S1d）；本阶段 `/center` 为单一占位壳。
- demo 开发者页 `/tokens` **不移植**（无 F-ID 归属，非任何阶段范围）。
- 侧栏用户页脚仅做"用户名/角色展示 + 退出登录（带确认）"；demo 用户菜单其余项（沙箱信息、账号与隔离、切换账号）延后至 S1a/S3a。
- OIDC 真实现（S3a）；生产级部署形态（S4b）。

## Capabilities

### New Capabilities

- `http-service-skeleton`：Fastify 装配、健康/服务信息端点、统一错误信封、静态托管与 history fallback、启动入口与命令面、core/db 迁移基座。
- `dev-stub-auth`：provider 接缝与 dev-stub 适配器、seed 账号、登录/登出端点、session cookie 安全契约、认证守卫。
- `spa-shell`：web 构建工具链、React 路由 IA、侧栏与用户页脚、登录页与路由守卫、设置页（主题/关于）、占位页。
- `verification-harness`：hurl smoke、Playwright 走查、make/CI 接线、控制面文档四处同步。

### Modified Capabilities

（无——首个 change，`openspec/specs/` 为空。）

## Impact

- 代码：`server/src/{app,server,http,core/db,auth/providers}`、`web/{index.html,vite.config.ts,src/{main,routes,features,lib}}`、`smoke/`、`web/e2e/`。
- 构建面：根/`web` `package.json`、`tsconfig.base.json`（jsx）、`vitest.shared.ts` 或 `web/vitest.config.ts`（jsdom）、`knip.json`（server/web entry）、`Makefile`（dev/smoke/ui-walk 目标 + .PHONY）、`.github/workflows/ci.yml`（smoke/ui-walk job，先 build web 再起服务）、`AGENTS.md`（Verification Matrix/Enforcement Index/Known blind spots/Directory Map）、`constraints.yaml`（verification.surfaces 增 smoke/ui-walk）。
- 依赖新增（PR 须按 AGENTS.md 说明理由）：fastify、@fastify/static、@fastify/cookie；react、react-dom、react-router、vite、@vitejs/plugin-react、jsdom、@testing-library/react、@types/react、@types/react-dom；@playwright/test；hurl（CI 安装，不进 package.json）。SQLite 用 `node:sqlite`（Node 24 内建，零新增依赖；实测可用，仅 ExperimentalWarning）。
