# Proposal: s1e-frontend-parity

## Why

`docs/reviews/2026-09-24-demo-parity-audit.md` 判定：S0a/S0b/S1a 已交付的四个页面（登录、`/`、`/files`、`/settings`）与行为基准 `resource/workbuddy-live-demo.html` 在外壳、组件、状态、响应式上系统性不一致，且这类工作在 `IMPLEMENTATION_PLAN.md` 里没有任何 F-ID 认领；PR #269/#270 只是对症补救。`IMPLEMENTATION_PLAN.md`（#272 后）已新增 F-UI-1..6 与阶段 S1e，本 change 是 S1e 的流水线产物：把已交付页面按 demo 逐页逐组件对齐，建立基元组件库与 token 全集，并把"demo 一致性"变成可运行的验收产物与可签收的清单。

## What Changes

- **ui-primitives（新）**：`web/src/styles/tokens.css` 整套 token（demo:19-188 调色板层 + 语义层，亮/暗，补齐 demo 缺失的 6 个变量；`--wb-font-heading` 去掉 Poppins 为唯一差异）；`web/src/ui/` 基元组件库（Radix UI Primitives 行为层 + token 样式层）：Button/Input/Switch/Tag/Chip/Dialog/ConfirmDialog/Drawer（左/右）/Menu/Popover/Tooltip/Toast/EmptyState/Icon（lucide-react，单组件 name 映射）/BrandMark/SegmentedControl；`motion.css` 动效；既有两处手写 `<dialog>`、手写 `role="menu"` 创建菜单与手写切换器弹层迁移到基元，`web/src/lib/dialog.ts` 删除。
- **spa-shell（修改）**：侧栏（图标 + 副标签 + 折叠 288→48 持久化 + 底部用户区与只含 `退出登录` 的菜单）、顶栏三态（欢迎页 `≥761` 隐藏 / `≤760` 只留汉堡；会话面包屑；页面标题）与页面级 level-1 heading 归属（欢迎态 = hero、有会话 = 面包屑容器、其它 = 顶栏标题；页面不再渲染自有页面级 `<h1>`）、响应式 900/760 两档（760 以下侧栏覆盖层 + 汉堡按钮）；登录卡结构镜像 demo（品牌位 26px、副标题、自动聚焦、错误行），快捷登录列表仅当 `/api/info.auth.provider === "dev-stub"` 时渲染（LoginForm 自有的一次性 info 读取，不占 Provider 单槽 operation）；设置页外观改为分段控件 + `当前生效` 行，关于卡加品牌 mark，`/api/info` 解析接受新形状。
- **http-service-skeleton（修改）**：`GET /api/info` body 增 `auth:{provider}`，值来自 `registerAuth` 实际装配的 provider 对象 `name`（decorator `authProviderName`），server 与 web 严格校验、`smoke/public.hurl` exact body 同步。**这是本 change 唯一的服务端触碰**：只读字段，不新增后端能力。
- **chat-web（修改）**：欢迎态（hero 兼页面 h1、默认场景静态快捷 chip、静态七项最佳实践卡显示五张 + `换一批`、免责声明）、composer 卡片形态（只含发送按钮；运行中 `生成中` status）、用户气泡（保留原文空白）/助手块（空白按 Markdown 语义，`复制` 取原文） + 共享安全 Markdown（`md-render.ts` 移入 `web/src/lib/`）+ 流式光标、步骤卡结构化摘要（JSON/非 JSON/空三分支，`原始输出` 默认折叠）与中文可见状态 + 可访问名、`回到最新`、消息操作条仅 `复制`（失败 Toast）。
- **files-web（修改）**：逻辑路径 `<account>/<dir>`（界面任何位置不出现服务器绝对路径）、根行为 shield + 空间名、条目扩展名图标 + 大小（替换既有 `formatByteSize`）、`空目录`/空树/不支持态文案、切换器改 Popover（含搜索过滤）、`＋` 菜单改 `Menu`、三档宽度布局与长名截断。
- **demo-parity-acceptance（新）**：`make ui-shots`（六格 × 五个固定态名 × demo/app 成对截图 + `index.html`，每格断横向溢出，手动 surface）、肉眼可辨夹具（256×256 png、多段 md、4 行 csv；同步 ui-walk 断言，新增 `smoke/fixtures/README.md`）、`docs/acceptance/demo-parity-checklist.md` 逐页逐组件签收清单（S1e 范围有定义）、控制面同步（AGENTS 两行、constraints 第十一条 surface、Makefile 目标 + `.PHONY` + `safe_overrides`/`recipes`/PHONY 锚点）。
- **verification-harness（修改）**：`make ui-walk` 以两个 Playwright project（1440 亮 / 390 暗）跑同一 journey；project 私有目录名、按 project 分支的布局与主题步骤、880 宽树栏断言、reduced-motion 与离线图标断言、用户菜单退出；控制面 surfaces 十→十一、受保护 Make targets 四→五；CI 不新增 job/第三方 action。

### 功能覆盖声明

覆盖 F-UI-1（ui-primitives）、F-UI-2（spa-shell 外壳）、F-UI-3（chat-web）、F-UI-4（files-web）、F-UI-5（spa-shell 登录/设置）、F-UI-6（demo-parity-acceptance + verification-harness）。

**与 oracle 的偏差留痕**（均为 grill 拍板或事实核查结果，不改 oracle 原文）：

1. **ui-shots 不进 CI**：`docs/reviews/2026-09-24-demo-parity-audit.md` §7 第 6 组写"含 CI artifact 上传"；`verification-harness` 的四 action 白名单 Requirement 禁止引入 `actions/upload-artifact`，CI 里跑截图但不上传没有价值。本 change 把 `ui-shots` 定为手动 surface（`required_at: manual`、Enforcement `review-only`）。IMPLEMENTATION_PLAN F-UI-6 的"人工验收输入"表述与此一致。若将来要 CI 留档，需先单独修订白名单 Requirement。
2. **ui-walk 只跑矩阵六格中的两格**：IMPLEMENTATION_PLAN S1e Verify 写"`make ui-walk`（矩阵内每格无横向溢出、无 console error）"。grill 拍板 ui-walk 全 journey 只跑 1440 亮 + 390 暗（CI 时长与维护面）；1024 亮由 `desktop-light` 在四路由遍历中逐路由临时切 1024×768 断溢出（含 `/center`）补齐；其余三格（1440 暗、1024 暗、390 亮）的横向溢出由 `make ui-shots` 五态每格断言覆盖（手动 surface，非 CI block；`/center` 为占位壳，不在 ui-shots 态内）。
3. **响应式两档而非三档**：F-UI-2 写"1100/900/760 三档"。demo 的 1100 断点只作用于 `/center` 面板（demo:892-896），侧栏副标签在 demo 中只随折叠/hover 隐藏；S1e 无 1100 档元素，实施 900/760 两档，1100 档留给 S1d。
4. **侧栏底部铃铛/设置快捷入口不渲染**：F-UI-2 写"底部铃铛/设置/用户菜单展示形态"。grill 拍板无铃铛；设置入口已在主导航，不重复渲染快捷入口。
5. **欢迎页快捷 chip 行**：audit §4.3 把"场景胶囊 + 各场景快捷 chip 行"整行路由给 S1c（F-CHAT-1）。grill 拍板 S1e 渲染默认场景的静态 chip 行（点击只填草稿），场景胶囊与按场景切换的语义仍归 S1c。
6. **`/api/info` 增只读字段**：S1e Outcome 写"不新增任何后端能力"。`auth.provider` 是只读描述字段（登录页快捷登录门控所需），不引入新能力、不改任何安全边界。
7. **平铺会话列表进主侧栏**（#424，2026-09-25 用户拍板）：S0b 起会话列表是会话页 `main` 内的一列，挤压欢迎区（390 下免责声明掉出首屏、1024 下最佳实践卡折行）。改为会话页经 shell 槽位把 `新建会话` 与平铺列表渲染进侧栏主导航下方（demo:1797、1852），shell 仍不读取 chat 数据层；置顶/任务/空间/助理任务分组、条目菜单、筛选与搜索仍按 Non-goals 归 S1c。

### Non-goals（grill 已拍板 / 无后端契约，S1e 不渲染）

- 场景胶囊与会话分组侧栏、停止生成、重新生成、对话内搜索、审批条（→ S1c）；附件按钮（→ S2c）；模型切换 chip（→ S1d）；挂载相关项、只读/在线标记（→ S1b）；`/center` 各 tab 与 1100 断点面板（→ S1d）。
- 明确不做：麦克风语音输入、⌘K 命令面板、导出对话记录、赞/踩、通知铃铛、侧栏底部设置快捷入口、上游品牌 logo 资产（用自有 mark + 字标占位）、`/tokens` 页、demo 快捷登录卡在非 dev-stub 环境。
- 不改任何后端契约（`/api/info` 只读字段除外）、不改沙箱/审计/SSE/凭证边界、不引入像素 diff 基线。

## Capabilities

### New
- `ui-primitives`：token 全集、Radix 基元组件库、图标与动效。
- `demo-parity-acceptance`：`make ui-shots`、肉眼夹具、签收清单、控制面同步。

### Modified
- `spa-shell`：路由 IA 与侧栏 / 登录页与路由守卫 / 设置页 三个 Requirement 重述。
- `http-service-skeleton`：健康与服务信息端点（`auth.provider`）。
- `chat-web`：会话页。
- `files-web`：工作空间页 / 文件界面与键盘可用性。
- `verification-harness`：UI 走查（Playwright）/ CI 接线与控制面同步。

## Impact

- 新依赖（web）：`@radix-ui/react-{dialog,dropdown-menu,popover,toast,switch,radio-group,tooltip}`（按切片分别安装）、`lucide-react`；`ATTRIBUTION.md` 增 Radix（MIT）与 lucide（ISC）条目；knip：`ui/index.ts` 的每个导出都有 feature 或测试消费者，`Icon` 为单组件映射，不产生未使用导出。
- 既有测试面（同 PR 更新）：`/api/info` 三键形状 → `smoke/public.hurl`、`server/test/{app,http-guard,http-guard-faults}.test.ts`、`web/test/{support.ts,api.test.ts,api-info-logout.test.ts,auth-session-client.test.tsx,auth-router.test.tsx,routes.test.tsx,settings-footer.test.tsx}`；页面级 heading 上收 → `web/test/routes.test.tsx`、`chat-page*`、`files-page`、`settings-footer`、`auth-router` 与 `web/e2e/ui-walk.spec.ts` 的 heading 定位；用户菜单退出 → ui-walk 退出定位器与 `sidebarFooter`/`expectPrincipalFooter`；状态文本中文化 → ui-walk `selectedSessionStatus`/`bash running|bash done` 定位、`chat-page.test.tsx` 与 `chat-page-ownership-gaps.test.tsx`；Radix portal → ui-walk 内 `main` 范围的 dialog/menuitem 定位改页面范围、`settings-footer.test.tsx` 的 `HTMLDialogElement` 断言改 Escape；LoginForm 读 info → 所有渲染 LoginForm 的 fixture 注册 `/api/info`（`auth-router.test.tsx` 整体改为按路径路由的 fetch mock 并逐个核对计数断言，登录表单用例迁出以守住 800 行）并核对 fetch 次序/计数断言；夹具替换 → ui-walk csv/md/logo 断言。`web/e2e/ui-walk.spec.ts` 改为双 project。
- size-guard（800 行）：`auth-router.test.tsx` 已满，新用例进 `web/test/login-form.test.tsx`；`chat/page.tsx` 新呈现拆到 `features/chat/{composer,welcome,scroll-follow}.tsx`。
- 服务端：`DevStubProvider` 类型增只读 `name`；provider 创建上提到 `registerAuth` 并在根实例装饰 `authProviderName`（fastify module 声明补字段）；info route 读 decorator；`server/test` info 用例更新。
- 文档：`docs/acceptance/demo-parity-checklist.md`、`smoke/fixtures/README.md` 新增；`docs/architecture/system.md` §3.3 补一段 `web/src/ui` 基元层（同 PR）。
