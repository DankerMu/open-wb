# demo 一致性三方审查：PLAN.md / IMPLEMENTATION_PLAN.md / web 实现 vs `resource/workbuddy-live-demo.html`

> 2026-09-24。触发：S0b（#81）与 S1a（#111）人工验收发现前端与 demo 差距巨大。
> 本文是审查报告 + 计划修订建议，**不改任何 oracle**（PLAN.md / IMPLEMENTATION_PLAN.md 的修订以 §6 的 patch 形式给出，待批准后单独 PR）。
> 行号约定：`demo:N` = `resource/workbuddy-live-demo.html` 第 N 行；其余为仓库文件路径:行号。

## 1. 判定（先说结论）

1. **差距是真实的，且主要不是"功能没到阶段"**。已交付的四个页面（登录、`/`、`/files`、`/settings`）里，属于 S0a/S0b/S1a 范围内的呈现——外壳、会话消息与输入区、文件树与预览、设置控件——与 demo 在结构、组件、状态、响应式上系统性不一致（§4 逐项）。
2. **根因在计划与规格层，不在某个 PR**：
   - `PLAN.md:12` 把"demo 里能点出来的行为就是需求"定为顶层目标，但 `IMPLEMENTATION_PLAN.md` 的 F-ID 清单只登记**功能/接口**（F-CHAT/F-FILE/F-CTR/F-SET/F-OPS），**没有任何一个 F-ID 代表"外壳/组件体系/逐页视觉与交互对齐/响应式/验收方法"**；覆盖表"无孤儿 ID"因此是同义反复——不存在的 ID 当然没有孤儿。
   - Stage 2 产出的 spec 对视觉只写了一条场景（`openspec/specs/spa-shell/spec.md:20-22`、`files-web/spec.md:77-78`），没有逐组件契约；Stage 5 给 web 任务的 `Suggested fixture level` 一律 `compact`（jsdom + mock），验证面天然证明不了呈现。
   - 验证 harness 只有一个 1280×720 的 Chromium 项目、无视口矩阵、无截图产物（`web/playwright.config.ts:31-36`）；spec 里写的"390px 窄屏"在任何层级都零测试。
3. **PR #269（样式与可访问交互）、#270（Enter 发送）是对症补救**：它们让页面"有样式、可用键盘"，但没有建立组件体系，也没有让任何一页与 demo 逐组件对齐；之后 CI 全绿只证明"自己定义的断言通过"。
4. **后端与安全契约保持不动**：沙箱/审计/uid 隔离/SSE 回放/凭证边界的验证是真实的，本文所有建议只动 `web/` 与验证 harness；同时**维持现状的一条纪律**——尚无后端能力的 demo 控件不得伪装可用（今天的实现做到了：`/center` 明示"暂不可用"，导航副标签不宣传挂载）。

## 2. 证据来源

| 来源 | 方法 |
|---|---|
| 实机截图 | master `d6bb314` 编译产物（`npm run build` web+server，Node 24.13.1），`server/dist/server.js` + `server/test/support/fake-upstream.mjs` + 真实 omp v18.0.10；Playwright chromium，视口 1440×900 与 390×844，亮/暗各一轮；demo 以 `file://` 打开、快捷登录 zhangsan。登录/会话/文件/设置/中心五页 + 切换器/预览态，共 46 张 |
| demo 清点 | 全文 4154 行逐段清点：布局骨架、token、全局组件、快捷键、路由与侧栏、逐页组件与状态、mock 数据索引、无后端控件清单 |
| 实现清点 | `web/src/**`、`web/test/**`、`web/e2e/ui-walk.spec.ts`、`web/playwright.config.ts`、promoted specs、PR #269/#270 diff |
| 计划 | `PLAN.md` §1/§3、`IMPLEMENTATION_PLAN.md` F-ID 清单与覆盖表、S0a 归档 change 的 Non-goals |

关键事实（后文表格引用）：

- 实现只有一个断点 `@media (max-width:760px)`（`web/src/styles.css:635`、`chat.css:408`、`files.css:631`），demo 有 1100/900/760 三档（demo:307-310, 892-905），760 以下 demo 侧栏是覆盖层，实现是把侧栏压成横排导航条。
- 实现没有共享 React 组件层：只有 `.ui-button/.ui-alert/.ui-empty` 等 CSS 类（`styles.css:164-232`）；对话框在 `auth/footer.tsx:106-137` 与 `files/dialogs.tsx:36-81` 各写一套；无 Toast、无 Menu/Pop 基元、无图标集。demo 有完整基元：`.wb-btn` 四变体三尺寸（demo:570-586）、`.wb-input`、`.switch`、Modal 栈、Drawer、Menu、锚定 Pop、Toast、`.tag`、`.filter-chip`、`.empty-state`、94 个内联 SVG 图标（demo:934-1031）。
- 视觉证据只在 e2e：`expectDesktopLayout`（侧栏/主区 boundingBox + 无横向溢出，`ui-walk.spec.ts:115-131`）和一条"深色后 main 背景色 ≠ 浅色"的不等式（`:90-97`）。仓库无 `toHaveScreenshot`/storybook/percy。
- 夹具 `smoke/fixtures/sandbox/u1/smoke-fixture/logo.png` 是 1×1 灰度 PNG——为 hurl 精确字节断言设计，不能给人眼验收（截图里预览区只有一个点）。
- demo 自身也有噪声，不应作为基线：Enter 发送无 IME 保护（demo:2621，实现 #270 更正确）；`.wb-table`、`fmtSize`、`renderAssistantPage` 等死代码；`/tokens` 开发者页；若干 CSS 变量未定义（demo:355, 379-380, 615）。

## 3. 分类规则（本文机械执行）

| 分类 | 判据 |
|---|---|
| 已实现 | demo 要素在已交付阶段范围内，实现与 demo 等价，且有测试/走查证据 |
| 已排期未实现 | 要素映射到某 F-ID，其阶段尚未运行（S1b/S1c/S1d/S2x/S3x）——**不是偏差** |
| 实现偏差 | 要素所属 F-ID 已交付（S0a/S0b/S1a），但呈现/交互与 demo 不一致 |
| 计划遗漏 | demo 有、任何 F-ID 与阶段都不认领（含"延后"但没写归属阶段的） |
| 明确不做 | 已有留痕决定不移植，或属 demo 表演/dev-stub 产物 |
| 待拍板 | 需要产品决定，本文不替用户决定 |

## 4. 映射表

### 4.1 全局外壳与组件体系

| demo 要求 | 计划归属 | 代码现状 | 验证证据 | 分类 |
|---|---|---|---|---|
| 设计 token 全集（`--wb-palette-*` ~150 个 + 语义层，demo:19-188），亮/暗两套 | S0a F-SET-1 只覆盖"主题切换" | `styles.css:1-59` 只有 19 个语义变量 + 15 个暗色覆盖；无调色板层 | `theme-provider.test.tsx` 只断 `data-theme` 属性 | **实现偏差**（token 取自上游 5.3.11 是 ATTRIBUTION §4 已允许的） |
| 基元组件：按钮四变体三尺寸、输入、开关、标签、筛选 chip、Modal 栈（Esc 关栈顶）、`confirmDialog`、Drawer、Menu、锚定 Pop、Toast、空态三段式、图标集（demo:570-634, 1044-1142, 3700-3726, 934-1031） | **无 F-ID** | CSS 类若干；两套手写 `<dialog>`；无 Toast/Menu/Pop/图标集 | `dialog.test.tsx` 仅焦点循环 | **计划遗漏** |
| 侧栏：图标 + 标签 + 副标签、可折叠 288→48px、底部通知铃铛/设置快捷/用户菜单（demo:232-247, 1773-1778, 1816-1822） | S0a 只写"侧栏 4 tab 与用户页脚"；用户菜单其余项"延后至 S1a/S3a"（S0a proposal:26）但 S1a change 未认领 | `router.tsx:52-87`：文字导航、无图标、不可折叠；页脚 = 用户名/角色 + 退出按钮 | `ui-walk` 走四路由 | **实现偏差**（图标/折叠）+ **计划遗漏**（铃铛、用户菜单、折叠） |
| 顶栏三态：欢迎页隐藏 / 任务视图面包屑 + 重命名 + 搜索/产物/更多 / 其它页标题 + 操作位（demo:313, 1928-1999） | 无 F-ID | 无顶栏；各页自渲染 `<h1>` | 无 | **计划遗漏**（面包屑/标题栏）；会话内搜索、产物面板、重命名 → 见 4.3 |
| 响应式三档：1100 / 900（树 280→210）/ 760（侧栏覆盖层）（demo:307-310, 723, 892-905） | spa-shell spec 仅"390px 无横向溢出" | 单断点 760，侧栏变横排（`styles.css:635`） | **零**窄屏测试（配置无视口矩阵） | **实现偏差** + **计划遗漏**（响应式规格） |
| 快捷键：⌘K 命令面板、Esc 逐层关闭、Enter 发送（demo:4141-4142, 2620） | 无 F-ID（Enter 发送已由 #270 补） | Enter/Shift+Enter ✓（`conversation-view.tsx:229-245`）；Esc 只在 dialog 内；无命令面板 | `chat-page.test.tsx:151,168` | Enter **已实现**；命令面板 **待拍板**（demo 只搜本地 mock） |
| 动效：淡入、弹入、流式光标、运行态脉冲、Drawer 滑入（demo:214-230, 774） | 无 F-ID | `prefers-reduced-motion` 有，其余无 | 无 | **计划遗漏**（随组件体系一起做） |
| 品牌图形：登录/侧栏用上游 logo 资产（demo `ASSETS.logoLight/Dark`） | ATTRIBUTION §4 + `styles.css:1-4`：token 借用、**品牌图形不复用** | 自有对勾 mark | — | **明确不做**（许可边界，需自有品牌图形替代——设计资产待拍板） |

### 4.2 登录页

| demo 要求（demo:1721-1752） | 计划归属 | 代码现状 | 验证证据 | 分类 |
|---|---|---|---|---|
| 卡片 360px：logo、标题、副标题"内网统一身份 · 本实例不出网"、账号/密码、登录按钮 | S0a F-SET-2 雏形（dev-stub） | `login-form.tsx`：标题 + 两输入 + 按钮；无副标题、无 logo 位 | `auth-router.test.tsx`、`ui-walk:61-64` | **实现偏差**（副标题/结构） |
| 错误文案逐字（"账号或密码不正确"/"该账号已停用，请联系管理员"）、Enter 提交、自动聚焦账号 | S0a design:19 | 文案 ✓（服务端信封）；Enter 提交 ✓（form）；**无自动聚焦账号框**（`login-form.tsx` 无 autoFocus） | smoke `auth.hurl`、`auth-router.test.tsx` | 文案/提交 **已实现**；自动聚焦 **实现偏差**（小） |
| 演示账号提示 + 三张快捷登录卡 | dev-stub 产物 | 无 | — | **明确不做**（生产走 OIDC，S3a）；开发态是否保留 → 待拍板 |
| 登录中/提交中态 | demo 无（同步） | 有 `正在登录` | `login-form.tsx:86-88` | 已实现（优于 demo） |

### 4.3 会话页 `/`

| demo 要求 | 计划归属 | 代码现状 | 验证证据 | 分类 |
|---|---|---|---|---|
| 欢迎页 hero "WorkBuddy，我帮你"（demo:2539） | 无 F-ID（F-CHAT-1 只管场景语义） | 空态一行字"选择一个会话，或直接发送开始新对话" | `chat-page.test.tsx` | **计划遗漏**（欢迎页形态） |
| 场景胶囊 日常办公/代码开发/创意设计 + 各场景快捷 chip 行（demo:2540-2546） | **F-CHAT-1 → S1c** | 无 | — | **已排期未实现** |
| 最佳实践卡片 + 换一批/查看更多 + 免责声明（demo:2553-2567） | 无 F-ID | 无 | — | **计划遗漏**（内容来源需拍板：静态清单即可） |
| Composer 卡：多行输入、附件按钮、模型切换 chip、麦克风、发送/停止切换、footer"任务启动于 <空间> / 权限"（demo:2576-2603） | 输入/发送 F-CHAT-3 ✓；停止 F-CHAT-7 → S1c；附件 F-CHAT-5 → S2c；模型 F-CTR-MOD → S1d；空间绑定 → S1c | `conversation-view.tsx`：label + textarea + 发送按钮，无卡片容器 | `chat-page*.test.tsx` | 卡片形态 **实现偏差**；附件/模型/停止/空间 **已排期**；麦克风 **待拍板**（demo:2720 纯表演，无 F-ID） |
| 侧栏会话分组：置顶/任务/空间/助理任务、条目状态点、更多菜单（重命名/置顶/导出/删除）（demo:1795-1920） | **F-CHAT-2 → S1c** | 平铺列表 + 状态点 + "新建会话" | `chat-page.test.tsx` | 分组/菜单 **已排期**；导出 **明确不做**（demo 仅 toast） |
| 消息渲染：用户/助手气泡区分、Markdown 正文、流式光标、深度思考折叠、消息操作条（复制/重新生成/赞/踩）、追问 chip（demo:2378-2406） | F-CHAT-3（正文/步骤）已交付；重新生成/赞踩无 F-ID | 纯文本段落（无 Markdown 渲染——`md-render.ts` 在 files 侧未复用）、无光标、无操作条 | `chat-page.test.tsx` 断文本 | Markdown/光标/气泡 **实现偏差**；操作条 **计划遗漏**（复制可做；重新生成/赞踩需后端语义 → 待拍板） |
| 执行步骤卡：卡头 + 子行状态（done/run/wait/err）+ 运行脉冲 + 已停止态（demo:2218-2242） | F-CHAT-3 已交付 | `chat-step`：名称 + 状态徽章 + `原始输出` 折叠展示工具返回 JSON（`conversation-view.tsx:82-97`） | 归约测试 | **实现偏差**——事件契约已够（`chat-stream` 给 name/status/detail），是呈现层把 detail 原样倒出；结构化摘要可在前端做 |
| 知识库检索卡（demo:2875-2902） | **F-CHAT-4 → S2c** | 无 | — | **已排期未实现** |
| 审批条 允许/拒绝/15s 自动通过（demo:2407-2418） | 无 F-ID（omp 以 yolo 模式跑，S0b 设计决定） | 无 | — | **待拍板**（是否引入审批语义属 S1c/权限模型） |
| 产物卡（code/html/img）与文件变更卡（demo:2420-2474） | 无 F-ID | 无 | — | **计划遗漏**（需事件/数据契约：与 S1c 会话治理或 S1a 文件面对接） |
| "回到最新"按钮、对话内搜索（demo:2011-2029） | 无 F-ID | 无 | — | 回到最新 **计划遗漏**（纯前端）；搜索 demo 本身不定位（假） → 待拍板 |
| 越权访问 toast + 审计（demo:2054-2059） | 后端 404 已实现（他账号 404，smoke `chat.hurl`） | 前端无 toast 组件 | smoke | 后端 **已实现**；提示形态随 Toast 基元 |

### 4.4 文件页 `/files`

| demo 要求 | 计划归属 | 代码现状 | 验证证据 | 分类 |
|---|---|---|---|---|
| 工作空间切换器卡（名 + 逻辑路径 `/data/workbuddy/<user>/<dir>`）→ 弹层：搜索、列表、✓ 当前、"＋ 新建工作空间"、"挂载目录到当前空间"（demo:3600-3629） | F-FILE-1/2 已交付；挂载 → S1b | 卡 + `<dialog>` 切换器 + 搜索 + 新建 ✓；**卡片直接显示服务器绝对路径**（`files/page.tsx:106,146`） | `files-page.test.tsx`、`ui-walk:386-399` | 功能 **已实现**；路径暴露 **实现偏差 + 待拍板**（展示逻辑路径还是隐藏）；挂载项 **已排期** |
| 树：根行 shield 图标 + 名称 + 在线点、目录/文件类型图标、文件大小列、只读标签、卸载按钮（demo:3861-3878） | 图标/大小 F-FILE-1 已交付；只读/在线/卸载 F-FILE-3 → S1b | 通用文件图标、无大小、根行叫 `root`（`tree.tsx:219`） | `ui-walk:402-432` | 图标/大小/根行 **实现偏差**（API 已返回 size/mtime）；只读/在线/卸载 **已排期** |
| 目录树懒加载、"新建或挂载目录" ➕ 菜单、新建文件夹弹窗（位置下拉只列可写在线目录、名称校验、去重） | F-FILE-2 已交付 | ✓（`files/dialogs.tsx`），菜单只有"新建文件夹" | `files-page.test.tsx`、`files-errors.test.tsx` | **已实现**（挂载项已排期） |
| 预览：文件头（名·大小·时间）、md 渲染/源码切换、csv 表格 + 行数说明、json 格式化、代码行号、图片、不支持态文案含大小与"可下载到沙箱后处理"、"共 N 行 · 大文件仅预览前若干行"（demo:3909-3925） | F-FILE-4 已交付 | md/csv/json(`prettyJson`)/code/image ✓；不支持态少大小说明与"可下载到沙箱"半句；截断态有提示 | `preview.test.tsx`、`ui-walk:408-423` | 主体 **已实现**；不支持态文案 **实现偏差**（小） |
| 空态文案"该工作空间暂无目录 / 点击左上角 ＋ 新建文件夹，或挂载…"（demo:3910） | S1a design D9 | 未选文件态 ✓、未选工作空间态 ✓（`page.tsx:177`）；**空目录无专用文案**（demo 的"该工作空间暂无目录…"应剪掉"挂载"半句后移植） | `files-page.test.tsx` | 两个空态 **已实现**；空目录文案 **实现偏差**（小） |
| 树栏宽 280 / 900px 以下 210 / 窄屏纵向 | files-web spec:78 "窄屏纵向布局" | 760 以下纵向堆叠 | **无窄屏测试** | **实现偏差**（无证据） |

### 4.5 设置页 `/settings`

| demo 要求（demo:3533-3567） | 计划归属 | 代码现状 | 验证证据 | 分类 |
|---|---|---|---|---|
| 外观卡：标题 + 说明行 + 右侧三档**分段控件**；"当前生效"子卡 | S0a F-SET-1 | 三张大色块 radio 卡 + 一行"当前生效"（`settings/page.tsx:20-36`） | `settings-footer.test.tsx` | 功能 **已实现**；形态 **实现偏差** |
| 关于卡：图标 + 名称 + 版本说明 | S0a | 名称 + 版本，无图标 | `settings-footer.test.tsx` | **已实现**（版本取真实 `/api/info`，spec 明确不沿用 5.3.11） |
| 主题即时生效 + 持久化 + 跟随系统 + 跨 tab 同步 | S0a | ✓ | `theme-provider.test.tsx` | **已实现** |

### 4.6 `/center`（全部未到阶段）

八个 tab（专家/技能/连接器/知识库/模型/权限/审计/账号）→ S1d / S2a-c / S3a-b 全部**已排期未实现**；当前 `PlaceholderPage` 明示"中心暂不可用"（`router.tsx:149-156`）——符合"不伪装可用"纪律。`/tokens` **明确不做**（S0a proposal:25）。

### 4.7 demo 无后端控件（禁止原样上线，来自 demo 清点 §4）

麦克风语音（demo:2720-2731 随机填句）、上传本地文件（demo:3689 不弹系统选择框）、召唤专家/安装技能/连接器（延时翻转本地态）、"测试连通并保存/挂载"（只做正则）、审批 15s 自动通过、知识库入库与相似度（段落切分 + 词频）、导出记录（toast）、产物卡"在编辑器中打开"/文件变更"查看详情"（无绑定）、赞/踩（本地态）。**任何阶段移植这些控件都必须先有对应后端契约，否则不渲染或禁用并说明**——这条应写进计划通用契约（§6.2）。

## 5. 差距统计（按 4.1–4.6 行计）

| 分类 | 行数 | 说明 |
|---|---|---|
| 已实现 | 9 | 主要是 S1a 文件面功能与 S0a 主题/登录语义 |
| 已排期未实现 | 9 | 场景/分组/停止/附件/模型/检索卡/挂载/中心 |
| 实现偏差 | 13 | token 层、侧栏、响应式、登录卡、composer、消息渲染、步骤卡、路径暴露、树图标/大小、设置分段控件、小项文案/聚焦 |
| 计划遗漏 | 9 | 组件体系、顶栏/面包屑、响应式规格、动效、欢迎页、最佳实践卡、消息操作条、产物/变更卡、回到最新 |
| 明确不做 | 4 | 上游品牌图形、快捷登录卡、导出记录、`/tokens` |
| 待拍板 | 7 | 麦克风、命令面板、审批语义、重新生成/赞踩、对话内搜索、路径展示策略、开发态快捷登录 |

## 6. 计划修订建议（patch 文本，未应用）

### 6.1 `IMPLEMENTATION_PLAN.md` 新增 F-UI 清单与阶段 S1e

在「功能实现清单」末尾新增一节，并在覆盖表加一行；`S1c` 的 `Depends on` 增加 `S1e`（S1c 要在正确的外壳与组件体系上加侧栏分组与场景，否则再返工一次）。

```markdown
### 前端基准对齐（demo 呈现层，跨页面）
| ID | 行为 |
|---|---|
| F-UI-1 | 设计 token 全集（调色板 + 语义层，亮/暗）与基元组件库：按钮/输入/开关/标签/chip/Modal 栈/confirm/Drawer/Menu/锚定 Pop/Toast/空态/图标集/动效；全部页面只经基元取样式 |
| F-UI-2 | 应用外壳：侧栏（图标 + 副标签 + 折叠 288→48 + 底部铃铛/设置/用户菜单展示形态）、顶栏三态（欢迎页隐藏 / 任务面包屑 / 页面标题 + 操作位）、响应式 1100/900/760 三档（760 以下侧栏覆盖层） |
| F-UI-3 | 会话页对齐（已交付范围）：欢迎页 hero + 最佳实践卡 + 免责声明、composer 卡片形态（未交付控件不渲染）、用户/助手消息形态、Markdown 正文 + 流式光标、步骤卡结构化摘要（不倒 JSON）、回到最新、消息操作条（复制） |
| F-UI-4 | 文件页对齐：树图标/大小/修改时间、根行形态、切换器弹层形态、预览头与 json/不支持态文案、逻辑路径展示（不暴露服务器绝对路径） |
| F-UI-5 | 登录页与设置页对齐：登录卡结构（自有品牌位 + 副标题）、外观分段控件 + 当前生效卡、关于卡图标 |
| F-UI-6 | demo 一致性验收 harness：Playwright 视口矩阵（1440/1024/390 × 亮/暗）、逐页 demo-vs-app 截图对产物（`make ui-shots`，人工验收输入）、肉眼可辨夹具（≥128px 图片 + 多段 md + 多行 csv）、逐页逐组件验收清单文档 |
```

```markdown
**S1e 前端基准对齐（已交付页面）**
- Outcome：把 S0a/S0b/S1a 已交付的四页按 demo 逐页逐组件对齐；建立基元组件库与 token 全集；接入视口矩阵与截图对产物；人工联合验收以截图对 + 清单签收。**不新增任何后端能力；demo 中无后端支撑的控件一律不渲染。**
- Files/components：`web/src/ui/*`（基元）、`web/src/styles/tokens.css`、`web/src/routes`（外壳）、四个 feature 目录的呈现层、`web/e2e`、`web/playwright.config.ts`、`smoke/fixtures/sandbox`、`docs/acceptance/demo-parity-checklist.md`。
- 覆盖：F-UI-1 … F-UI-6。
- 必读增量：demo 全局组件与逐页节（本审查 §4 行号）；ATTRIBUTION.md §4（token 可用、品牌图形不可用）。
- Verify：`make check` + `make ui-walk`（矩阵内每格无横向溢出、无 console error）+ `make ui-shots` 产物经人工按清单逐项签收（清单每项写"demo:行号 → 页面元素 → 通过/不通过"）。
- Depends on：S0b、S1a。
- Review attention：decision-dense（组件边界与 token 分层一次定调；之后所有 web 阶段只消费不重建）。
```

覆盖表新增：`| S1e | F-UI-1/2/3/4/5/6 |`；S1c 行 `Depends on：S0b、S1a、S1e`。

### 6.2 `IMPLEMENTATION_PLAN.md`「Phases」通用契约增加两条

```markdown
- 凡触碰 `web/` 的阶段：Verify 必含该阶段页面的 demo-vs-app 截图对（`make ui-shots`）与逐组件验收清单签收；Stage 5 对 web 任务的 `Suggested fixture level` 不得只以 jsdom/mock 收口，涉及呈现的任务至少 `expanded`（真实浏览器 + 视口矩阵）。
- demo 中无后端契约支撑的控件（麦克风、上传、审批、召唤/安装、连通测试等）在其后端阶段落地前**不渲染**；不得以禁用态/占位按钮"先摆上"。
```

### 6.3 `PLAN.md` §3 增加一句交叉引用

`PLAN.md:12` 的"demo 里能点出来的行为就是需求"之后补：「呈现层（外壳/组件/响应式/状态）的对齐是独立交付物，见 `IMPLEMENTATION_PLAN.md` F-UI-*」。PLAN.md 其余不动。

### 6.4 待拍板项（进 S1e grill）

1. 路径展示：`workspaces.root` 是服务器绝对路径（API 契约保留），UI 显示 `<沙箱根>/<dir>` 逻辑路径还是仅显示 dir？
2. 品牌图形：自有 logo/吉祥物由谁出资产？在此之前登录/侧栏用文字标识。
3. 麦克风、命令面板、对话内搜索、重新生成/赞踩、审批条：是否列入后续任一阶段（各自需要后端契约），否则归"明确不做"并从清单删除。
4. 开发态是否保留快捷登录卡（dev-stub 专用，生产 OIDC 无此面）。

## 7. issue 拆分建议（S1e 跑 stage-change-pipeline 时的 Stage 5 形状）

按仓库 Stage 5 契约（单模块范围、单一验证路径、`Depends on` 逐行、fixture/slice 声明），不接受"CSS 修补"型 issue。建议分组：

| 组 | issue（首刀加粗） | 依赖 | 验证路径 |
|---|---|---|---|
| 1 token + 基元 | **1.1 token 全集 `tokens.css`（亮/暗）+ 取样测试**；1.2 Button/Input/Switch/Tag/Chip；1.3 Dialog 栈 + confirm + Drawer（替换两套手写 dialog）；1.4 Menu + 锚定 Pop；1.5 Toast；1.6 EmptyState + 图标集 + 动效 | 1.2–1.6 依赖 1.1 | web vitest（渲染 + a11y 角色）+ 截图对 |
| 2 外壳 | **2.1 侧栏（图标/副标签/折叠/底部区）**；2.2 顶栏三态 + 面包屑；2.3 响应式三档 + 视口矩阵接入 `playwright.config.ts` | 1.x | `make ui-walk` 矩阵 + 截图对 |
| 3 会话页 | **3.1 消息形态 + Markdown + 流式光标**；3.2 步骤卡结构化摘要；3.3 composer 卡片 + 回到最新 + 操作条（复制）；3.4 欢迎页 hero/最佳实践卡/免责声明 | 1.x、2.x | web vitest + 截图对 |
| 4 文件页 | **4.1 树图标/大小/时间/根行**；4.2 切换器与新建菜单形态 + 逻辑路径；4.3 预览头/不支持态文案/空目录文案等小项 | 1.x | web vitest + 截图对 |
| 5 登录/设置 | **5.1 登录卡**；5.2 外观分段控件 + 当前生效卡 + 关于卡 | 1.x | web vitest + 截图对 |
| 6 验收 harness | **6.1 `make ui-shots` + 视口矩阵产物（原子一刀，含 CI artifact 上传）**；6.2 肉眼夹具替换（同步 `files.hurl` 字节断言与 `test-ci-harness.sh` oracle）；6.3 `docs/acceptance/demo-parity-checklist.md` + 控制面同步 | 6.2 依赖 6.1 | CI job 产物 + `make test-guardrails`（multi-path 例外） |

## 8. 本次审查附带发现（报告不修）

- 本机残留 5 个非本会话的 `server/dist/server.js` 进程（`open-wb-startup-*` 临时目录，来自其它测试运行），未处置。
- demo 本身的缺陷不应被移植：Enter 无 IME 保护（demo:2621）、任务追问附件被丢弃（demo:2709-2713）、`.msg-action-btn` 无样式（5 处引用）、若干未定义 CSS 变量（demo:355, 379-380, 615）、`/center` 搜索 placeholder 提"工具"但无该 tab（demo:3158）。
- `docs/architecture/system.md:54-58` §3.3 只描述路由与 lib，未提组件层；S1e 落地时应补一段"`web/src/ui` 基元层，feature 只消费"。
