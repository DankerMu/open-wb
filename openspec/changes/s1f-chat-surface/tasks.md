# Tasks: s1f-chat-surface

> 执行顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11（design D11；串行原因是共享 `page.tsx`、`conversation-view.tsx`、`ui-layering.test.ts` 的清单断言与 ui-walk 文件）。
> 组 9（任务清单后端）与 1-8 没有依赖，可提前。
>
> 通用纪律：
> - 每组一个 PR，合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行；会话页任何时刻只有一份实现挂在 `/`。
> - 「行为不变」的证据是既有行为断言（按角色/可访问名）原样通过。只允许删除或改写读 `.css`、按旧类名选择的断言；规格条文在本 change 被改的行为，其断言随条文改写，改写处写进 PR 的偏离记录。
> - 不改会话列表的八个文件（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、`rename-dialog.tsx`、`delete-dialog.tsx`）
>   的实现（唯一例外：组 4 不需要改它们——`onCreateSession` 的语义在调用方变）；不改 `web/src/features/files/**`；`web/src/ui/**` 冻结；`main.tsx` 的 `ToastProvider` 不动。
> - 不移动、不改名 `web/src/features/chat/stream-steps.ts`，不改动其第 44 行及之前的行数（`ui-guardrails.test.ts` 钉死）。
> - 一个文件不再导入 `web/src/ui`（`Icon`、`IconName`、`BrandMark`、`useEscapeFallback` 除外）且不依赖旧类名时，把它加进 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 并同步清单断言；已迁移文件不得导入 `useToast`。
> - 拷入层（`web/src/components/ui`、`web/src/components/assistant-ui`）只做 A 定下的六类修改；拷入前后的差异写进 PR 描述。
> - 分片删除它所替换区域的旧 CSS 规则与读这些规则的静态断言；新测试写进新文件（size-guard 800 行）。
> - 每组在 `docs/acceptance/functional-checklist.md` 的「会话（CH）」节为自己交付的行为补行，结论一律 `待签`。
> - knip 不允许未引用导出与未使用依赖：依赖随首个消费者同刀加入。

## 1. chat-web — 抽出无渲染的 `useChatSession`

- [ ] 1.1 新建 `web/src/features/chat/use-chat-session.ts`：把 `page.tsx` 的列表、历史、连接、发送/创建、fence 状态与派生量（`generating`、`composerLocks` 等）移入，返回只读状态与动作；
  `turn-actions.ts` 改由它调用并由它持有 fence 状态。值导入方向只有 `page.tsx → use-chat-session.ts → turn-actions.ts`。
- [ ] 1.2 `page.tsx` 只保留 `ChatPage` 的组合与外壳接线（`useTopbar`、`useSidebarSlot`）；`SessionSidebar` 的 props 契约不变；`index.ts` 仍只导出 `ChatPage`。
- [ ] 1.3 既有测试零改动通过（整页测试约 12,600 行是这一刀的证据）；新增一个测试文件断言模块划分（`turn-actions.ts`、`use-chat-session.ts` 不导入 `./page.js`；`use-chat-session.ts` 不含 JSX）。
- [ ] 1.4 文档（design D12）：`IMPLEMENTATION_PLAN.md` S1f 段订正 B 的范围（含任务清单后端）并登记本次 grill 的决定；`docs/adr/0013-assistant-ui-frontend-rebuild.md` 增补一段
  （Markdown 链接/图片规则、轻提示退场、审批提问卡与任务清单停靠在输入框上方）。

Suggested fixture level: compact - 纯重构，无行为变化；既有整页测试是完整证据，风险只在所有权 fence 的搬移
Minimal mergeable slice: atomic - `page.tsx` 的状态与 `turn-actions.ts` 的 fence 注入是同一组闭包，拆成两次搬移会出现中间态里 fence 一半在页面一半在 hook；验证路径单一（既有测试 + knip）

## 2. chat-web — 运行时与线程骨架

- [ ] 2.1 依赖与拷入：`web/package.json` 加 `@assistant-ui/react`、`@assistant-ui/react-markdown`、`remark-gfm`；`ATTRIBUTION.md` 登记；
  拷入 `web/src/components/assistant-ui/` 的 `thread`、`markdown-text`（及它们依赖的 `ui` 组件）；文案中文化。
- [ ] 2.2 `runtime-convert.ts`（纯函数，design D1）与其单元测试：id、text / reasoning / tool-call part 的映射与顺序、状态映射、`metadata.custom` 透传。
- [ ] 2.3 运行时接入：`useExternalStoreRuntime`（`messages`、`isRunning`、`convertMessage`、`onNew`、`onCancel`、`onReload`）；`isRunning` 与应用锁定的边界按 D1；
  测试：历史加载中、分叉进行中时输入框禁用但线程不显示运行态。
- [ ] 2.4 线程骨架：用户气泡（保留空白）、助手块（头像、Markdown 正文、运行中光标、错误文本、`已停止` 徽章与空正文占位 `（已停止生成）`）、消息根元素 `data-message-id`；
  思考、步骤卡、审批条、文件变更卡、产物卡、操作行此刻仍用旧组件，按 D4 的块次序挂在助手消息的插槽里（审批条暂留在消息内，组 6 移走）。旧输入框表单仍在线程下方。
- [ ] 2.5 Markdown（design D5）：不生成源 HTML 元素；仅 http/https 渲染为新窗口链接（`noopener noreferrer`）；图片渲染为 alt 文本；代码块复制成功只换图标、失败不提示。
  测试含注入样本：`<script>`、`javascript:` 链接、`data:` 链接、图片。
- [ ] 2.6 滚动（design D4）：`ThreadPrimitive.Viewport` + 可访问名为 `回到最新` 的回底按钮；既有滚动场景与 `ui-walk-scroll` 通过（其类名选择器改为角色/属性）；原生行为不满足的场景保留 `scroll-follow.tsx` 对应逻辑。
- [ ] 2.7 删除被替换区域的旧 CSS 规则与读它们的静态断言；`conversation-view.tsx` 中已替换的部分删除；登记已迁移文件；CH 行：消息呈现、Markdown 规则、回到最新。

Suggested fixture level: expanded - 引入运行时（状态边界一次定调）、换 Markdown 渲染器（安全面变化）、换滚动实现；ui-walk 才能证明滚动与布局
Minimal mergeable slice: 2.1 + 2.2 + 2.3 + 2.4 中「用户气泡与助手 Markdown 正文」——运行时、映射与最小线程必须同刀（依赖没有消费者即被 knip 拒绝，线程没有运行时无法渲染）；2.5 的安全规则随渲染器同刀不可后置。2.6 滚动可作为紧随其后的一刀（首刀期间保留旧 `scroll-follow.tsx` 包裹新线程即可保绿）

## 3. chat-web / session-sidebar — 输入框与能力栏

- [ ] 3.1 输入框：`ComposerPrimitive` 文本框（两种占位）、发送 / `停止` 原位切换、`生成中` 状态、键盘规则（Enter / Shift+Enter / 输入法组合态 / 键码 229 / 长按）；
  停止点击只调一次 `stopSession`、不弹提示；业务错误就地显示规则不变。
- [ ] 3.2 能力栏-工作空间（design D6）：欢迎态为选择器（`GET /api/workspaces`，默认 `未选择`）；选择器按钮文本 `任务启动于 <空间名|未选择>`，搜索与空结果文案不变；
  已选会话为只读标签 `任务启动于 <空间名>` / `任务启动于 未绑定` / `任务启动于 已绑定空间`（绑定的空间不在已读取列表时）。
- [ ] 3.3 能力栏-「+」菜单（按钮可访问名 `技能与命令`；拉取中或失败显示 `暂无可用项`；输入框锁定时禁用）：列出 `GET /api/commands?workspaceId=` 的条目与项目技能标记；点选写入 `/<name> ` 并聚焦输入框、不发送；与斜杠候选共用目录缓存与拉取时机。
- [ ] 3.4 斜杠候选 listbox 换肤（行为与 `slash-menu-state.ts` 不变）：既有斜杠场景全部通过。
- [ ] 3.5 删除 `composer.tsx` / `composer-footer.tsx` 的旧实现与对应 CSS、静态断言；改写断言 `已停止生成` 提示的测试为「无提示」；登记已迁移文件；CH 行：发送与停止、工作空间选择与只读、「+」菜单、斜杠候选。

Suggested fixture level: expanded - 输入框是发送/停止/锁定的唯一入口，键盘与输入法规则多；能力栏引入两处新交互
Minimal mergeable slice: 3.1 + 3.2 + 3.4——新输入框必须带着工作空间选择与斜杠候选一起替换旧表单（旧 footer 的选择器与旧候选面板挂在旧表单上，换掉表单而不带它们会丢功能）；3.3「+」菜单是新增入口，可后置一刀

## 4. session-sidebar / chat-web / spa-shell — 欢迎页、场景、会话创建时机与空态（#824 #825 #826）

- [ ] 4.1 欢迎页重建（design D9）：hero、三个场景分组、快捷任务、最佳实践卡与 `换一批`、免责声明；切换场景不弹提示（删除 `scene-pills.tsx` 的 `useToast`）；所选场景仍写进创建 body。
- [ ] 4.2 「新建会话」只回欢迎态：`onCreateSession` 的处理改为以 replace 导航清除 `?session=`（保留无关 search/hash）、零请求、聚焦输入框、草稿不动；已在欢迎态时只聚焦；窄屏覆盖层侧栏照常关闭，焦点落在输入框而不归还 `打开导航`。
- [ ] 4.3 首次发送建会话：欢迎态发送恰一次 `POST /api/sessions`、恰一次 prompt（沿用 `createAndSelect(prompt)` 与其 fence）；删除「空 prompt 建会话」的代码路径。
- [ ] 4.4 零消息会话空态（design D4）：图标、`还没有消息，发一条开始吧`、只读的绑定工作空间名（未绑定不显示）；不显示场景与快捷任务；不改草稿；一级标题仍是面包屑。
- [ ] 4.5 改写断言：所有「点新建会话 → POST」的测试（`chat-page-welcome-scene*`、`chat-page-sidebar`、`chat-page-session-pin`、`chat-page-lifecycle`、`chat-page-ownership`、`app-shell-responsive`）
  改为断言零 POST 与欢迎态；需要一个已存在会话的用例改用预置会话或首次发送。场景提示的断言改为「无提示」。
- [ ] 4.6 ui-walk：`createSessionFromSidebar` 改为在欢迎态输入并发送来建会话（或由各调用点改用预置/首次发送）；新增步骤：点「新建会话」后 URL 无会话 id、会话数不变；零消息会话（从第一条用户消息分叉得到）显示空态。
- [ ] 4.7 登记已迁移文件；CH 行：场景切换无提示、新建会话回欢迎态、首次发送才出现在列表、零消息会话空态。PR 描述写明关闭 #824、#825、#826。

Suggested fixture level: expanded - 反转一条既有规格行为（新建即 POST），牵动六个测试文件与 ui-walk 的建会话辅助函数；会话创建路径带所有权 fence
Minimal mergeable slice: 4.2 + 4.3 + 4.5 + 4.6——创建时机的反转与全部依赖「新建即 POST」的断言、ui-walk 辅助函数必须同刀（只改行为则这些断言全红，只改断言则无对象）；4.1 欢迎页换肤与 4.4 空态各自可独立合入

## 5. chat-web / thinking-fold / turn-control — 思考、工具调用组与操作行

- [ ] 5.1 拷入 `reasoning`、`tool-fallback`、`tool-group`（及依赖）；思考折叠（回合进行中展开、终态收起，可访问名 `深度思考过程`，thinking-fold 的行为场景通过）。
- [ ] 5.2 工具调用组（design D4）：默认收起的一行摘要；展开后的步骤卡（图标、名称、状态徽章与可访问名、一行摘要、`原始输出` 的 detail/output 分栏、不做路径改写）；有失败步骤时自动展开；用户手动收起后不再自动展开，直到出现新的失败步骤。
- [ ] 5.3 操作行：`复制`（原文；成功换图标 + 视觉隐藏的 `已复制` 状态；失败就地 `role="alert"`）、`重新生成`（仅末条助手且会话状态 ∈ done/failed/stopped；不弹提示）、
  `从此处分叉`（仅用户消息；锁定期间禁用）。
- [ ] 5.4 删除 `thinking-block.tsx`、`message-actions.tsx`、`conversation-view.tsx` 里的 `StepCard` 等旧实现与对应 CSS、静态断言；改写断言提示的测试；登记已迁移文件；
  CH 行：思考折叠、工具调用组收起/展开/失败自动展开、复制、重新生成、分叉。

Suggested fixture level: expanded - 步骤呈现从逐卡变为折叠组（owner 决定 8），状态徽章的可访问名被多处测试与 ui-walk 依赖；三处提示退场
Minimal mergeable slice: 5.1 + 思考折叠——思考块与步骤、操作行互不依赖，可先单独替换保绿；随后 5.2 工具调用组一刀、5.3 操作行一刀（各自替换一个旧组件，旧的其余块仍挂在插槽里）

## 6. tool-approval / chat-web — 停靠区与审批

- [ ] 6.1 停靠区 `ComposerDock`：输入框正上方、不随线程滚动；此刻只承载审批提问卡（任务清单面板在组 10 加入其上方）。
- [ ] 6.2 提问卡（design D7）：选中会话全部待决审批按 `id` 升序叠放；`role="group"` 名 `需要你的确认`；工具名徽章、`title` 全文、倒计时句（注入时钟）、`允许` / `拒绝`；
  各自以自己的 id 作答、点击后该张按钮立即禁用、409 `approval_settled` 不报错；resolved 后消失。
- [ ] 6.3 消息内已结算记录：`已允许执行` / `已拒绝执行` / `超时自动允许`，工具名徽章与 `title` 全文，无按钮无倒计时；位置按 D4 块次序。
- [ ] 6.4 刷新恢复：待决 → 提问卡（倒计时从 `expiresAt`），已结算 → 记录；待决期间输入框锁定且 `停止` 可用。
- [ ] 6.5 删除 `approval-bar.tsx` 旧实现与 CSS、静态断言；`chat-approval-bar.test.tsx` 等按新位置改写（提问卡在消息 `article` 之外、已结算记录在其内）；
  ui-walk `ui-walk-approval.ts` 改写：待决卡不在 `article[name=助手]` 内而在输入框上方，允许后消息内出现 `已允许执行` 记录，刷新后仍在。登记已迁移文件；CH 行：审批提问卡位置、允许/拒绝、并发两条、超时自动允许的记录、刷新保留。

Suggested fixture level: expanded - 审批是安全相关交互；位置从消息内移到输入框上方反转了两份规格条文与 ui-walk；并发审批与倒计时有时序
Minimal mergeable slice: atomic - 提问卡移出消息与消息内只留已结算记录是同一次移动：只做前者则已结算审批无处显示，只做后者则待决审批消失；断言与 ui-walk 的选择范围随位置同刀改

## 7. turn-artifacts — 文件变更卡、产物卡与产物面板

- [ ] 7.1 文件变更卡：换到拷入层组件，位于工具调用组之外；行为场景不变。
- [ ] 7.2 产物卡：预览、复制、下载行为不变；复制成功换图标 + `已复制` 状态；`文件过大，无法复制`、`复制失败`、下载/预览失败的信封文案就地 `role="alert"`。
- [ ] 7.3 产物面板：旧 `Drawer` 换为拷入层 `sheet`（可访问名、焦点与 Escape 行为按现规格）；无产物时照常打开并显示空态 `当前任务暂无产物`。
- [ ] 7.4 删除旧实现的 CSS 与静态断言；改写断言提示的测试；登记已迁移文件；CH 行：文件变更卡、产物卡预览/复制/下载、产物面板与空态。

Suggested fixture level: compact - 三个组件的换肤，行为规格不变；变化只有提示改就地与面板空态
Minimal mergeable slice: 7.1——文件变更卡不带交互，可单独替换保绿；7.2 产物卡与 7.3 产物面板各一刀（面板的空态改动与卡片无关）

## 8. conversation-search / chat-web — 对话内搜索与项目配置入口

- [ ] 8.1 对话内搜索：搜索框换到拷入层组件，位置与行为按 conversation-search；跳转用消息根元素的 `data-message-id` 定位并滚入视口；消息级高亮。
- [ ] 8.2 项目配置入口：拷入 `dialog`；只读列表的标题、说明、分组与条目不变；`project-config.css` 的规则删除。
- [ ] 8.3 `topbar-actions.ts` 的描述符不变（`重命名` 仍来自会话列表动作）；删除旧实现的 CSS 与静态断言；登记已迁移文件；CH 行：对话内搜索、项目配置入口。

Suggested fixture level: compact - 两个彼此独立的小组件换肤，行为规格不变
Minimal mergeable slice: 8.2——项目配置入口不依赖线程，可先单独合入；8.1 搜索依赖组 2 的 `data-message-id` 与滚动容器，单独一刀

## 9. session-todo / chat-stream / chat-sessions / omp-test-harness / chat-web — 任务清单后端

- [ ] 9.1 迁移 `server/src/core/db/migrations/036_*.sql`：`chat_sessions` 加可空 `todo` 列；迁移测试（仿 `migration-034.test.ts`）。
- [ ] 9.2 归一化（纯函数，新文件，仿 `file-changes.ts`）：结构校验、五种 `status`、`name` / `content` 截断 200 码点、总任务数上限 200、全空归一为 `null`、不下发 `blocker`；单元测试含不合规样本。
- [ ] 9.3 事件：`events.ts#applyFrame` 在 `tool_execution_end` 且 `toolName === "todo"`、未失败时只产出 `details.phases` 原值候选（归约器不做 IO）；
  supervisor 的持久化路径做校验、归一化、去重（与上次落库值相同不发）并发布 `todo.updated{messageId, todo}`，位置紧邻该次调用的 `step.end` 之前；
  不合规候选丢弃并经可注入的 warn sink 记一条 warn，不影响步骤事件与回合。
- [ ] 9.4 持久化与快照：`persistEvent` 写会话行的 `todo`；`toPublicHistory` 返回顶层 `todo`；分叉新会话为 `null`；重新生成不清空。
- [ ] 9.5 web 契约（design Migration Plan）：`session-contract.ts` 的快照解析改为四键严格并校验 `todo` 结构；`api-sessions*` / 契约测试更新。此刻 web 只解析、不显示。
- [ ] 9.6 测试支撑：`fake-omp.mjs` 增 `todo` 场景（常量放进 `fake-omp-thinking.mjs`，入口文件已 799 行）；`fake-upstream.mjs` 增 `WORKBUDDY_TODO` 标记（与 `WORKBUDDY_WRITE` 同时出现时后者优先）与 `fake-upstream-markers.test.ts` 用例；服务端管线测试（事件、落库、快照、SSE 续流、去重）。
- [ ] 9.7 `smoke/chat.hurl` 等对快照键集合的断言补 `todo`。

Suggested fixture level: expanded - 跨 schema 迁移、事件联合、快照契约（web 严格解析）三处公共契约；数据形状来自对 omp 二进制的反查，需要真实 omp 证据
Minimal mergeable slice: atomic - 快照多出一个键会被 web 的三键严格解析拒绝，所以服务端快照字段与 web 解析（9.4 + 9.5）必须同刀；事件产出没有落库则刷新即丢，9.1-9.4 互为前提；测试支撑是这些断言的对象。验证路径单一：服务端管线测试 + 契约测试 + smoke

## 10. session-todo / chat-web / chat-harness — 任务清单 web

- [ ] 10.1 `stream.ts`：事件联合、解码与归约加入 `todo.updated`；`ChatState.todo`；快照安装时带入；未知回合的处理与其它事件一致。纯归约测试。
- [ ] 10.2 面板（design D10）：位于停靠区最上方；可见条件；头部按钮 `任务清单 <完成数>/<总数>`（`aria-expanded`，默认展开）；阶段与任务列表、状态标记与可访问文本；只读；
  展开状态按会话保存在内存；高度上限与内部滚动；欢迎态不显示。
- [ ] 10.3 ui-walk：带 `WORKBUDDY_TODO` 的回合在真实 omp 下出现面板（位于输入框上方、审批提问卡之上），刷新后仍在；面板展开时输入框仍在视口内（390 与 1440 两个宽度）。
- [ ] 10.4 CH 行：任务清单出现与更新、收起/展开、刷新保留、全部完成后消失。

Suggested fixture level: expanded - 新的会话级状态进入归约与续流；面板与审批提问卡、输入框争夺纵向空间，需要真实浏览器证据
Minimal mergeable slice: atomic - 归约不带面板则 `ChatState.todo` 无消费者（knip 拒绝未用导出/字段无对象可证），面板不带归约无数据；验证路径单一（归约测试 + 整页测试 + ui-walk 一步）

## 11. chat-web / ui-foundation — 收尾

- [ ] 11.1 删除 `web/src/features/chat/messages.css`、`project-config.css` 与 `legacy.css` 中对应的 `@import`；`chat.css` 只留会话列表规则；
  `legacy.css` 的 `.chat-md` `revert` 规则删除（同一条选择器里的 `.files-md` 部分保留）；`conversation-view.tsx` 等已无引用的旧文件删除。
- [ ] 11.2 ui-walk 残余的 `.chat-*` / `.ui-*` 选择器（会话页部分）改为角色/属性；视口矩阵无横向溢出、无 console error。
- [ ] 11.3 守卫核对：会话页除会话列表八个文件外全部在 `MIGRATED_AREAS`；这些文件无 `useToast` 导入；`rg` 确认 `features/chat` 内除会话列表文件外无 `web/src/ui` 的非白名单导入。
- [ ] 11.4 包体：记录 `web/dist` 的 JS 总大小与 gzip 大小（对比重建前 598,483 字节），写进 PR 描述与 design 的 Open Questions 结论处。
- [ ] 11.5 CH 节通读：每条规格里用户可见的行为都有对应行，结论全部 `待签`；真实端点走一轮含审批与任务清单的回合，断线/刷新续流（F-CHAT-8）复测，结果写进 PR 描述。

Suggested fixture level: compact - 删除已无引用的样式与文件、核对守卫、记录数字；无新行为
Minimal mergeable slice: 11.1 + 11.3——旧 CSS 删除与守卫核对同刀（删完才能证明无残留依赖）；11.2 ui-walk 选择器清理可单独一刀；11.4、11.5 是记录与验收，不改代码
