# Design: s1e-frontend-parity

## Context

行为基准 `resource/workbuddy-live-demo.html`（demo）；差距清点与分类见 `docs/reviews/2026-09-24-demo-parity-audit.md` §4（本 design 的每条决策都对应其"实现偏差/计划遗漏"行）。既有实现：`web/src/styles.css`（19 个语义变量 + 两个本仓自有变量）、三份 feature css、两处手写 `<dialog>`、手写 `role="menu"` 创建菜单、单断点 760、Playwright 单 project 1280×720（`timeout` 30s / `globalTimeout` 60s）、夹具 1×1 png。Oracle：`IMPLEMENTATION_PLAN.md` S1e 条目与 F-UI-1..6（#272）；promoted specs `spa-shell`/`chat-web`/`files-web`/`http-service-skeleton`/`verification-harness`；`ATTRIBUTION.md` §4（token 可用、品牌图形不可用）。**Oracle 差异**六条已在 proposal「偏差留痕」逐条记录（ui-shots 不进 CI、ui-walk 两格、两档响应式、无铃铛/设置快捷、静态 chip 行、`/api/info` 只读字段）。

Grill（2026-09-24，12 项用户拍板）：headless 库 = Radix UI Primitives；token 整套移植；图标 lucide-react；验收 = 截图对 + 人工清单、不做像素 diff；路径展示 = 逻辑路径 `<account>/<dir>`；品牌 = 自有字标 + 现有 mark 占位；用户菜单只含退出、无铃铛、快捷登录仅 dev-stub；重新生成/审批/对话内搜索 → S1c，麦克风/⌘K 明确不做；ui-walk 矩阵 = 1440 亮 + 390 暗全 journey，ui-shots 六格；欢迎页静态清单。事实核查：Radix 支持 React 19；`/api/info` 无 provider 字段；Poppins 不可请求公网；`actions/upload-artifact` 不在白名单；ui-walk 每个 project 生成独立 gate UUID，fake upstream 以 Map 保存多个 gate，二次 arm 无冲突；master 上 ui-walk 的 Playwright 段约 6s。

## Goals / Non-Goals

**Goals：**
- 四个已交付页面对着 demo 逐组件对齐（结构、文案、状态、响应式、亮暗），且每项可由 `ui-shots` 产物 + 清单人工判定。
- 建立 feature 只消费、不重建的基元层与 token 全集；之后 S1b/S1c/S1d 的 web 工作只加页面不加基元。
- 把"窄屏可用"从 spec 里的一句话变成 CI 里跑的 project。
- 无后端契约的 demo 控件一个都不渲染（proposal Non-goals 全文适用）。

**Non-Goals：** proposal Non-goals 全文；不改沙箱/审计/会话/SSE 任何服务端契约；不做像素回归基线；不做品牌资产设计；不做 `/center`；不做 1100 断点档。

## Decisions

1. **基元层位置与依赖方向**：`web/src/ui/`（`index.ts` 在组 1 首刀创建、为唯一出口，之后各切片增量添加导出），feature 与 routes 只 `import from "../../ui"`；`ui/` 不 import 任何 feature/lib。Radix 包按需、按切片安装（1.3 dialog；1.4 dropdown-menu/popover/tooltip/radio-group；1.2 switch；1.5 toast），不装 themes/colors 包。测试用 grep 断言 `web/src/features/**` 与 `web/src/routes/**` 无 `@radix-ui` 直接 import。knip 纪律：每个新导出在同 PR 有 feature 或测试消费者；`Icon` 为单组件 + 内部 name→组件映射（不逐个再导出 lucide 图标）。
2. **token 分层**：`web/src/styles/tokens.css`（调色板 + 语义，从 demo:19-188 逐字移植；`--wb-font-heading` 去 Poppins 为唯一差异；六个 demo 缺失变量补定并注释；本仓既有 `--wb-home-bg`/`--wb-control-bg` 迁入并注明或改用等价语义 token）→ `web/src/styles.css` 只留 reset/字体栈/布局骨架 → `ui/*.css` 与 feature css 只引用语义 token。测试 grep 禁止 feature/routes 硬编码颜色与 `--wb-palette-`（同 PR 清掉 `chat.css:5` 注释里的 hex）。
3. **图标与品牌**：`ui/icon.tsx` 单组件（`name` 联合类型约 25 个 lucide 图标），统一尺寸与 `aria-hidden`；`ui/brand-mark.tsx` 自有 mark SVG + 可选字标，侧栏/登录/设置/助手头像共用一处，资产到位后单点替换；`ATTRIBUTION.md` 增 lucide ISC 与 Radix MIT。
4. **外壳与 heading 归属**：`routes/shell/{app-shell,sidebar,topbar}.tsx`。侧栏折叠状态 `localStorage['workbuddy-sidebar']`（读写包 try/catch，写失败静默）；折叠态 Tooltip + 每项 `aria-label`。顶栏三态由 route + `?session=` + 会话标题决定，会话标题经 chat 页通过 shell context 上报（`useTopbar({breadcrumb})`），避免 shell 反向依赖 chat 数据层。页面级 level-1 heading 归属：`/` 欢迎态 = hero（chat-web 渲染 `<h1>`）；有会话 = 顶栏面包屑容器 `<h1>`（accessible name `我的工作 / <标题>`）；其它路由 = 顶栏标题 `<h1>`。各页面删除自己的页面级 `<h1>`；内容区 Markdown 的 `<h1>` 不受此限，heading 断言以 `role=banner` 或 hero 定位、不用"全页恰一个 h1"。
5. **响应式**：两档 900/760（demo:723 与 demo:305-310；1100 档不在 S1e 范围）。760 以下侧栏用 `Drawer side="left" width=288`（Radix Dialog 变体）承载，顶栏出现 `打开导航`；欢迎态 `≤760` 渲染只含该按钮的窄条，保证每个路由有导航入口。覆盖层始终展开态、开合为瞬时状态、不读写 `workbuddy-sidebar`；`≥761` 时 Drawer 不挂载。ui-walk `mobile-dark` project 用 `openNav()` helper 在每次路由点击前打开覆盖层。
6. **登录卡与快捷登录**：`login-form.tsx` 结构镜像 demo:1721-1752，品牌位高 26px（demo:640）；`autoFocus` 账号框；快捷登录列表来自 `features/auth/dev-accounts.ts` 静态三项（镜像 dev-stub seed 的 account + 角色）。info 读取由 LoginForm 自己在 mount 时用匿名 client 发一次 `GET /api/info`（不经 Provider 单槽 operation，不与 login/logout 竞争，unmount abort，失败不重试，不渲染快捷区）。所有渲染 LoginForm 的 jsdom fixture 需处理这次额外请求：`support.ts` 对未注册路径同步抛错，但 `lib/api` 的 `fetchResponse` 会把它转成 `requestFailed(0)`（LoginForm 视为不可用、不渲染快捷区、不报错），因此纯 401 移交类夹具（`files-errors`、`chat-page-ownership`）只需核对 fetch 计数；`auth-router.test.tsx` 的按次序排队 mock 不止 8 处 `unauthenticatedResponse()`（还有 `it.each` 的 me 失败→principal、`renderAuthenticatedProvider` 后 401 移交、canonicalLoginPaths、`expectInfoRequest` 的 `NthCalledWith(3)` 与各处 `toHaveBeenCalledTimes`），因此该文件整体改为按路径路由的 fetch mock，计数断言逐个核对。`auth-router.test.tsx` 已到 size-guard 800 行上限：2.4b 同 PR 把登录表单相关用例迁到新文件 `web/test/login-form.test.tsx`，新用例也进该文件。StrictMode 双 mount 下首个请求随卸载 abort，实现按 mount 计数而非全局去重。
7. **`/api/info` 形状与 provider 名来源**：`{name,version,auth:{provider}}`。provider 类型（现 `DevStubProvider`，`server/src/auth/providers/dev-stub.ts`）新增只读 `name`（dev-stub 返回 `"dev-stub"`）；`createDevStubProvider(...)` 的调用从封装子插件 `authPlugin` 上提到 `registerAuth`，provider 经 options 传入子插件，`registerAuth` 在根实例 `app.decorate("authProviderName", provider.name)`（先例 `authNow`），`app.ts` 的 `declare module "fastify"` 补 `authProviderName: string`；info route 返回 `{...SERVICE_INFO, auth:{provider: app.authProviderName}}`。不新增 `createApp` 参数（现签名 `{db, staticRoot?, secureCookies?, sessionTtlMs?, authRuntime?, passwordSource?, assembly?}`，20+ 调用点不动）。web `parseServiceInfo` 严格校验三键与 `auth` 恰一键。同 PR 更新：`smoke/public.hurl` exact body、`server/test/{app,http-guard,http-guard-faults}.test.ts`（含 HEAD content-length）、`web/test/{support.ts,api.test.ts,api-info-logout.test.ts,auth-session-client.test.tsx,auth-router.test.tsx,routes.test.tsx,settings-footer.test.tsx}` 的 info fixture。
8. **会话页呈现**：`md-render.ts` 物理移到 `web/src/lib/md-render.ts`（头注释与来源不变）；`lib/markdown-view.tsx` 由 files 与 chat 共用（不放 `ui/`，它含渲染器依赖）。用户气泡 `white-space: pre-wrap`。流式光标：running assistant 正文容器尾部 `<span class="ui-caret" aria-hidden>`。步骤卡摘要：纯函数 `summarizeStepDetail(detail)`（JSON → 首个非空 `text`/`content` 或首键值；非 JSON → 首个非空行；空 → 空串；≤120 码点）。状态呈现：会话项 `role=status`、aria-label `<title> <状态>`（可见点 + 视觉隐藏 `运行中|已完成|失败`，running 加 `ui-pulse`）、步骤徽章 `role=status` 可见中文 + accessible name `<step> <状态>`、composer 运行中 `role=status` `生成中` + 发送按钮 aria-label `生成中`；ui-walk `selectedSessionStatus`/`bash running|bash done` 定位同 PR 改为中文；`generatingStatus` 已是中文 `生成中`，保持不变。`回到最新`：`scroll` 监听 + 距底 > `clientHeight` 显示；自动跟随只在贴底时。`复制`：`navigator.clipboard.writeText`，API 缺失或 reject → Toast `复制失败`。欢迎页静态数据 `features/chat/welcome-content.ts`：demo `QUICK_PROMPTS` 默认场景组（demo:1221-1239）、`PLAYBOOKS` 七项（demo:2553-2561）+ 卡片 prompt 映射（demo:2674），显示五张，`换一批` 在七项内轮换。新呈现拆到 `features/chat/{composer,welcome,scroll-follow}.tsx`（`chat/page.tsx` 已 729 行）。
9. **文件页呈现**：逻辑路径 = `${principal.account}/${workspace.dir}`；所有显示 `root` 的位置（切换器卡、列表项、树根、位置下拉 `根目录　<空间名>`）改用空间名/逻辑路径。条目图标映射与大小格式化为纯函数 `fileIcon(name)`/`formatSize(bytes)`（`formatSize` 替换 `preview.tsx` 既有 `formatByteSize`，单一来源）。切换器由 `<dialog>` 改 Popover（content `role="dialog"` 名 `工作空间切换器`；搜索框按名/逻辑路径过滤）。`＋` 创建菜单由手写 `role="menu"` 改 `Menu`。Radix 内容 portal 到 body：ui-walk 中以 `main` 为范围的 dialog/menuitem 定位改页面范围。
10. **设置页**：`SegmentedControl` 基于 Radix RadioGroup（每项 `role="radio"`）；`当前生效` 行保留可访问文本 `当前生效：浅色|深色`；关于卡 `BrandMark`。
11. **ui-shots 为手动 surface**：`web/e2e/ui-shots.mjs`（Playwright 脚本，不是 test）；`make ui-shots` 只消费运行中服务（需 `OMP_BIN` 与模型上游——假上游脚本或调用方真实上游——以产生 `chat-done` 态）；`UI_SHOTS_OUT` 未设置时脚本自算 `var/ui-shots/<UTC ts>/`（Make 不用 `$(shell)`；`var/` 已 gitignore）。六格 × 五个固定态名（`login-default`/`chat-welcome`/`chat-done`/`files-readme`/`settings-default`）× 两源 = 60 张 + `index.html`；每张 app 截图前断横向溢出与无绝对路径。主题：app 与 demo 都经 `addInitScript` 预置各自 localStorage 主题键（demo 键名与所选会话/文件 id 为脚本常量并注明 demo 行号）。不进 CI（白名单）；`constraints.yaml` `required_at: manual`，Enforcement `review-only`。
12. **ui-walk 双 project**：`playwright.config.ts` `projects: [desktop-light(1440×900, light), mobile-dark(390×844, dark)]`，同一 spec，`workers: 1`，`globalTimeout` 60s→150s；CI job `timeout-minutes: 15` 不变（master 上 Playwright 段约 6s，双 project 预计 <20s）。共用服务与沙箱：目录名 `walk-out-<project>`（补齐 ≥48 字符兼作长名截断样本）、gate UUID 各自独立；布局断言与主题步骤按 project 分支（desktop 断并排 + 880 宽树栏 210；mobile 断覆盖层与 `打开导航`；desktop 选深色、mobile 选浅色）；desktop-light 另在四路由遍历中逐路由临时切 1024×768 断溢出（含 `/center`），做 reduced-motion 切换断言，与静态资源（image/font/stylesheet/script）零 `requestfailed`（`net::ERR_ABORTED` 的导航/SSE 取消不计——held dialogue 的 reload 必然产生一条）/零跨源请求断言。
13. **夹具**：`logo.png` 256×256 由一次性脚本生成（不入库，`smoke/fixtures/README.md` 记录生成方式与三文件用途）；`readme.md` 首行保持 `# smoke-fixture`、增二级标题/列表/代码块/表格；`notes.csv` 4 行。`files.hurl` 用 `file,…;` 自引用比对，自动跟随；ui-walk 的 csv 行数、`共 4 行 · 大文件仅预览前若干行`、logo `naturalWidth` 断言同 PR；`test-ci-harness.sh` 的夹具 `cmp -s` oracle 无需改。
14. **控制面**：AGENTS.md Verification Matrix/Enforcement Index 各增一行、`constraints.yaml` surfaces 第十一条、Makefile `ui-shots` 目标（`UI_SHOTS_BASE_URL` 三行冻结模式、`UI_SHOTS_OUT` 仅 export）+ `.PHONY` + 页头；`test-ci-harness.sh` 受保护目标集 +1、surfaces 元组 +1、AGENTS 行期望 +2、`safe_overrides` 白名单 +3 行、`recipes("ui-shots", …)`、`.PHONY` 整行锚点。`docs/architecture/system.md` §3.3 补 `web/src/ui` 一段。
15. **验收清单**：`docs/acceptance/demo-parity-checklist.md` 由审查报告 §4 生成，S1e 范围 = "计划归属"落在 F-UI-1..6 或被本 change spec 认领的行；一行多组件逐组件拆项并各注 §4 来源行；其余行标 `不适用` 注明来源阶段/决策。Epic 关闭条件 = 清单签收贴入 Epic。

## Sketch seams under test

- `web/src/ui/*`：RTL jsdom 渲染 + 角色/键盘断言（`radix-platform.ts` shim 提供 ResizeObserver 等）。
- 页面级 jsdom（既有 `chat-page*`、`files-page`、`settings-footer`、`auth-router` fixtures + 新 `login-form.test.tsx`）：结构/文案/状态类名/纯函数——复用既有 seam。
- `web/e2e/ui-walk.spec.ts` 双 project：唯一真实浏览器 seam（布局、溢出、覆盖层、亮暗、reduced-motion、离线、console oracle）。
- `server/test` `createApp` inject：`/api/info` 新形状与 HEAD。
- `make test-guardrails`：控制面三处 + Makefile 目标/覆盖白名单/配方 + 夹具复制。
- `make smoke`：`public.hurl` 三键 body、`files.hurl` 夹具字节。
- 静态 grep/文本 oracle（`web/test`）：token 名集合、feature/routes 无硬编码颜色与 `@radix-ui`、`ui/**` 无 `style={`、`motion.css` reduced-motion 块。

## Not yet specified

- 品牌资产到位后的替换：尺寸、亮/暗两版、`favicon` 是否同换——资产未定，`BrandMark` 单点替换即可，但替换验收标准要等资产。
- 步骤卡对非 `bash` 工具（read/write/edit/glob）的摘要形态：S0b 只有 bash 有真实样本，S1c 放开工具面后再定每类摘要字段。

## Risks / Trade-offs

- **Radix 引入包体积与升级面**：七个包 tree-shake 后预计 < 60 KB gzip；锁 major，`npm ci` lockfile 约束。收益是焦点/定位/键盘正确性不自己写。
- **Radix portal 与既有定位器**：dialog/menuitem 不再在 `main` 内；组 1 迁移时一次性改 ui-walk 与 jsdom 定位，tasks 1.6 逐一列出。
- **ui-walk 时长**：Playwright 段 6s → 预计 <20s；`globalTimeout` 150s 留余量；CI 15 分钟不动。
- **页面级 heading 归属改变**：影响全部 heading 断言（jsdom + ui-walk + spec 文案）；2.2 一次性改完。
- **`/api/info` 形状变化**是破坏性的严格校验变更：server/web/smoke/测试 fixture 必须同 PR（D7 清单）；无外部消费者。
- **LoginForm 读 info 增加一次请求**：波及所有渲染登录页的 jsdom fixture 的 fetch 计数——2.4b 列出文件，逐个核对。
- **demo 侧截图依赖 demo 自身 UI 稳定**：demo 是仓内静态文件，不漂。

## Migration Plan

1. 组 1 首刀（token + Icon/BrandMark + motion + `ui/index.ts`）先合，视觉不变；随后各基元切片；1.6 迁移既有 dialog/menu/切换器并一次性改定位器。
2. 组 3（`/api/info`）独立小 PR，先于 2.4b。
3. 组 2 外壳（侧栏 → 顶栏/heading → 响应式）合入后再合组 4/5 页面对齐；6.1 双 project 紧随 2.3。
4. 组 6 其余（夹具、ui-shots 脚本、控制面、清单）最后；Epic 关闭前跑一次 `make ui-shots` 并按清单签收贴入 Epic。
5. 回滚：任一 PR `git revert`；组 1 回滚会连带页面样式退回 #269 状态但功能不受影响。
