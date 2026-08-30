# Tasks: s0a-service-skeleton

> 执行序按依赖排列；TDD：每条实现任务先写失败测试再实现。

## 1. http-service-skeleton

- [ ] 1.1 `core/db`：`openDb(path)`（node:sqlite、WAL、migrations/*.sql 按序执行、版本表幂等）+ `:memory:` 单测
- [ ] 1.2 Fastify 装配与横切：`app.ts`（可注入配置）+ `http/` 错误信封处理器（invalid_credentials/account_disabled/unauthorized/not_found 四码，401/403/404 同形状断言）+ healthz/info 端点 + `app.inject()` 测试
- [ ] 1.3 启动入口与命令面：`server.ts`（唯一 listen、启动日志输出模块清单）、`make dev` 与 `npm run start --workspace server`、`knip.json` server entry 增 `src/server.ts`、`.gitignore` 增 `var/`（默认 db 路径产物不入库）；启动行为验证由 4.1 smoke 对真实进程覆盖（设计已定，不写监听单测）
- [ ] 1.4 静态托管与 history fallback：`STATIC_ROOT` 可配置（单测用临时夹具目录），非 `/api/*` GET 回 index.html，非 GET 与 `/api/*` 未命中回信封 404 + inject 测试

Suggested fixture level: compact - 组装层有跨模块交互（db+http+static），但均经 app.inject() 单 seam 可证
Minimal mergeable slice: 1.1 core/db 单独可合并保绿（独立模块+自带测试，无 HTTP 依赖；knip 探针已证测试 import 即非死代码）

## 2. dev-stub-auth

- [ ] 2.1 账号/会话表迁移 + seed 四账号（zhangsan/zhaoliu/lisi 密码 demo + wangwu 停用；scrypt 散列入 password_hash，明文不入库）+ seed 形态断言（散列可 verify、非明文）
- [ ] 2.2 provider 接缝与登录：`authenticate(req) → Principal | null` 出口 + `providers/dev-stub.ts` 登录流程（trim+小写化、401/403 信封文案镜像 demo、CSPRNG session id 256bit、Set-Cookie httpOnly/SameSite=Lax/Path=/、Secure 配置项）+ 接缝直接断言与 inject 测试
- [ ] 2.3 会话生命周期：`GET /api/auth/me`、`POST /api/auth/logout`（删行清 cookie）、TTL 配置（默认 7 天绝对过期）与惰性清理 + inject 测试（含过期置回）
- [ ] 2.4 认证守卫：`/api/*` 默认要求会话（healthz/info/login 豁免）、无 cookie 与伪造/未知 session id 均 401 信封不 5xx + inject 测试

Suggested fixture level: compact - 认证是安全面但范围小、全部经 inject 单 seam 断言；expanded 留给 S3a OIDC
Minimal mergeable slice: 2.1 迁移+seed 单独可合并保绿（依赖 1.1 已合并；纯迁移+seed 断言，无端点）

## 3. spa-shell

- [x] 3.0 web 构建工具链：vite + @vitejs/plugin-react + react/react-dom + @types/react/@types/react-dom + jsdom + @testing-library/react 依赖声明、`web/index.html`、`src/main.tsx` 最小入口及配对 `web/test/main.test.tsx`（Testing Library 在 `#root` 装载入口）、`vite.config.ts`（outDir=dist）、`tsconfig.base.json` 增 `jsx: react-jsx`、`web/vitest.config.ts` 覆写 jsdom 环境、`web/package.json` 增 build 脚本；验证 = jsdom 入口测试 + `make typecheck` + `npm run build --workspace web` 产出 dist + `make check` 全绿（knip vite 插件自动解析入口，依赖均由入口/配置/测试实际消费）
- [ ] 3.1 `lib/theme` 扩 system 模式：可注入 matchMedia、默认档 system（demo:1035）、未知值/存储不可用回退 system（修正现有回退 light 语义）+ 扩展既有 `web/test/theme.test.ts`
- [x] 3.2 路由壳：react-router 四路由 + 侧栏（demo:1773-1778 标签/副标题）+ 占位壳（/center 扁平，/tokens 不移植）+ jsdom 可达性断言
- [ ] 3.3 `lib/api` + 登录页与路由守卫：fetch 封装（信封解析、401 进未登录态）、未登录任意路由渲染登录页并记录原目标、登录成功跳回、错误 message 展示 + jsdom 断言（未登录访问 /files 渲染登录页、登录后落 /files）
- [ ] 3.4 设置页与用户页脚：外观卡（三档 seg + 当前生效行）、关于卡（/api/info 版本）、侧栏页脚（用户名/角色 + 退出登录带确认）+ jsdom 断言

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
