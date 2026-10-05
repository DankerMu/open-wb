# Design: s1f-chat-surface

## Context

现状（均已核对，行号为 master `209afb8`）：

- 会话页在 `web/src/features/chat/`：`.ts`/`.tsx` 共 5,627 行，`.css` 1,650 行（`chat.css` 797、`messages.css` 806、`project-config.css` 47，经 `legacy.css:9-11` 导入）。
  其中约 1,900 行是数据层：`stream.ts`（事件归约、`connectSessionEvents` 快照 + 游标续流、`isUnknownTurn`）、`stream-{steps,approvals,artifacts,thinking}.ts`、
  `turn-actions.ts`（prompt 派发、停止、重新生成、分叉、审批作答及其 fence）、`ownership.ts`、`types.ts`。没有状态库，状态在 `page.tsx:65-96` 的 `useState` / ref 里。
- 数据模型：`ChatState = {status, messages[]}`；消息为 `{id:number, role, content(Markdown 原文), thinking, status, steps[], approvals[], error}`。
  正文与步骤之间没有时间交错信息（一个 `content` 字符串 + 一个 `steps` 列表）。
- 会话列表是 change C 的面：`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、
  `rename-dialog.tsx`、`delete-dialog.tsx`。列表经外壳的 `useSidebarSlot` 渲染在侧栏，不在 `main`；`page.tsx:657-674` 负责接线。
- 「新建会话」：`session-sidebar.tsx:155-164` → `page.tsx:664` `createAndSelect()` → 立刻 `client.createSession(welcome.createBody())`（`page.tsx:455-564`）。
  欢迎态首次发送已经走 `createAndSelect(prompt)`（`page.tsx:565-597`）。场景切换提示在 `scene-pills.tsx:26`。选中的零消息会话渲染一个空的 `section[aria-label=消息]`。
- 轻提示：重建范围内的调用点在 `composer.tsx:123`、`message-actions.tsx:18,20,45`、`artifact-card.tsx:66-104`、`artifacts-panel.tsx:75`、`scene-pills.tsx:26`。
  `session-actions.ts` 里的属于会话列表。`main.tsx:4` 仍挂旧 `ToastProvider`。
- 审批：`ChatApproval` DTO 为 `{id, tool, title, requestedAt, expiresAt, decision}`，按消息归属，没有与步骤的关联键。现状渲染在助手消息内（`conversation-view.tsx:152`）。
- 任务清单：omp v18.0.10 有 `todo` 工具。参数是按 `op` 的增量操作；`tool_execution_end` 的 `result.details` 为
  `{op, phases:[{name, tasks:[{content, status, blocker?}]}], storage, completedTasks?}`，`status ∈ pending|in_progress|completed|abandoned|blocked`，是全量。
  服务端 `events.ts` 的 `normalizeOutput` 丢弃 `details`，步骤 `detail` 在 4096 码点处截断，所以前端无法从步骤事件还原清单。
  读 `result.details` 已有先例（文件变更：`file-changes.ts`）。`/todo append|start|done…` 斜杠命令也改清单，但只产生 `command_output`，不产生工具帧。
  omp 的 `get_state` 响应带 `todoPhases`（全量），回合运行中调用会抛 `SessionBusyError`。
- 事件管线：omp 帧 → `events.ts#applyFrame` → `supervisor#commit` → `turn-control.ts#persistEvent` → ring buffer → SSE；所有现有事件都带 `messageId`；
  快照 `GET /api/sessions/:id/messages` 返回 `{session, messages, streamCursor}`，web 侧 `parseMessageSnapshot` 严格三键（`session-contract.ts:303-304`）。
  最新迁移是 `035_chat_session_metadata.sql`。
- 守卫：`web/test/ui-layering.test.ts` 的已迁移区域清单按前缀匹配、条目可以是单个文件、清单被硬断言；清单内文件从 `web/src/ui` 只能导入
  `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`。`ui-guardrails.test.ts:62-80` 钉住 `features/chat/stream-steps.ts` 的存在与第 44 行内容。
  拷入层目录 `web/src/components/assistant-ui` 已在豁免清单里但尚不存在；`web/src/components/ui` 现有九个组件（无 `dialog`、`popover`、`collapsible`）。
- 大量 `chat-*.test.tsx` 直接读 `chat.css` / `messages.css`（至少 17 个文件），整应用挂载的测试经 `mountAuthenticatedApp`。
  ui-walk 的 `createSessionFromSidebar`（`ui-walk-layout.ts:403-410`）点「新建会话」后等 URL 出现会话 id，整条驻留对话走查依赖它。

`@assistant-ui/react` 0.15.23 的 `ExternalStoreAdapter` 已核对类型声明：`messages`、`isRunning`、`convertMessage`、`onNew`（必填）、`onCancel`、`onReload`、
`onRespondToToolApproval`、`adapters.threadList`（标 deprecated/unstable）。registry 里本 change 拷入的只有 `markdown-text`、`reasoning`、`tool-group`；
线程、消息、步骤卡、停靠区与输入框是应用层组件，直接用 `ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive` 组合，不拷 registry 的 `thread` 与 `tool-fallback`（D3、D4）。
`server/src/sessions/supervisor.ts` 恰 800 行、`store.ts` 797 行、`web/src/features/chat/stream.ts` 742 行（size-guard 800）。重建前 `web/dist` 的 JS 为 598,483 字节（约 0.6 MB）。

## Goals / Non-Goals

**Goals**

- 会话页的呈现层重建在 assistant-ui + 拷入层组件上，数据层与后端契约的既有行为不变。
- 在新页面上解决 #824、#825、#826。
- 待决审批与任务清单停靠在输入框上方。
- 任务清单状态经快照与 SSE 到达 web，刷新与断线续流后仍在。
- 每个 PR 合入后主干可运行、三道门全绿；会话页任何时刻只有一份实现挂在 `/`。

**Non-Goals**

- 会话列表的重排、分组、置顶区、状态标记、搜索、归档，以及列表动作的提示（change C）。
- 临时空间；未选空间就发送仍按现状落到 owner 根目录（change C）。
- 文件页（change D）；`web/src/ui/**` 冻结区与旧 `ToastProvider` 的删除（D）。
- 权限设置、上传文件、专家（S1g / S1d）：不渲染控件，也不摆禁用占位。
- 代码分割与包体优化：只量并记录。
- assistant-ui 的 `adapters.threadList`、消息编辑（`onEdit`）、分支切换、附件、语音、反馈。
- 在界面里编辑任务清单（面板只读）。

## Decisions

### D1 运行时：`useExternalStoreRuntime`，应用继续持有状态

- `messages` = 选中会话的 `ChatState.messages`，经纯函数 `convertMessage` 映射；`onCancel` → `stopTurn`；`onReload` → `regenerateTurn`。
  `onNew` 是适配器类型的必填项，委托给现有发送路径；没有 UI 调用运行时的 composer（输入框是应用层组件，D6）。
- `convertMessage`（新文件 `runtime-convert.ts`，纯函数）：`id` → `String(id)`；`content` → 一个 `text` part；`thinking` 非空 → 一个 `reasoning` part；
  每个步骤 → 一个 `tool-call` part（`toolCallId` = 步骤 id，`toolName` = 步骤名，`argsText` = `detail`，`result` = `output`，失败步骤 `isError`）。
  part 顺序固定为 reasoning、text、tool-call（数据没有交错信息，见 D4 的块次序）。消息状态：`running` → running；`done` → complete；`failed` / `stopped` → incomplete。
  应用自有字段（`approvals`、步骤 `changes`、`error`、原始 `status`）经 `metadata.custom` 透传给自有组件。
- `isRunning` 仅当选中会话的末条消息是状态为 `running` 的助手消息时为真，所以运行时不会注入乐观的助手占位：
  欢迎态首次发送后，在 `turn.start` 或快照给出助手消息之前，线程里没有助手块。
- 输入框的 `生成中` / `停止` / 锁定由应用自己的 `generating`（创建/提交中、重新生成进行中、权威状态 `running`）驱动，规则不变，不经运行时。
  历史加载中、分叉进行中、连接器终止错误不算 generating，它们只让输入框禁用（经应用自己的 `composerLocked`）。
- 不用 `adapters.threadList`（会话列表在外壳侧栏，是 C 的面）；不用 `tool-call` 的 `approval` 字段与 `onRespondToToolApproval`（D7）；`onEdit` 不提供。
- 重新生成只对末条助手消息可见（服务端只支持这一种），由操作行的可见条件限制，不依赖运行时的默认可见性。

备选：`LocalRuntime` + 自定义 adapter（要把 SSE 续流、快照对账、所有权 fence 重写进 adapter，数据层 1,900 行与其测试作废）——否决。

### D2 数据层保留，先抽无渲染的 `useChatSession`

- 新文件 `use-chat-session.ts`：从 `page.tsx` 抽出列表、历史、连接、发送/创建、fence 状态与派生量（`generating`、`composerLocks` 等），返回只读状态与动作。
  `turn-actions.ts` 的规则不变（不渲染、不导入 `page.js`、fence 状态由调用方持有并注入——调用方从 `ChatPage` 变为 `useChatSession`）。
- `ChatPage` 留在 `page.tsx`、经 `index.ts` 导出；`SessionSidebar` 的 props 契约不变，C 可以在这个 hook 上重排列表。
- `stream.ts`、`stream-*.ts`、`ownership.ts`、`types.ts` 的行为不变。`stream-steps.ts` 不移动、不改名、不改动第 44 行及其之前的行数（守卫钉死）。
- 这一刀是纯重构，由现有约 12,600 行整页测试原样通过作证。

### D3 替换方式：同一目录内逐区替换，逐文件登记为已迁移

- 不建第二个会话页，也不建并行目录。每个分片替换 `features/chat/` 内一个区域的组件；尚未替换的区域继续用旧组件渲染在新骨架的插槽里
  （未登记为已迁移的文件导入 `web/src/ui` 合法）。
- 一个文件不再导入 `web/src/ui`（白名单四项除外）且不依赖旧类名时，把它的路径加进 `MIGRATED_AREAS`，同一分片更新 `ui-layering.test.ts` 的清单断言。
  目录 `web/src/features/chat` 本身不登记（会话列表八个文件仍是旧实现）。
- 旧 CSS 随区域删除：分片删除它所替换区域在 `messages.css` / `chat.css` / `project-config.css` 里的规则，以及读这些规则的静态断言；
  收尾分片删除 `messages.css`、`project-config.css` 与 `legacy.css` 中对应的 `@import` 和 `.chat-md` 的 `revert` 规则（同一条选择器里的 `.files-md` 部分保留）。
  `chat.css` 保留，届时只含会话列表规则（`.chat-session-*`、`.sidebar[data-variant="overlay"] .chat-session-groups` 等）。
- 拷入层与应用层的分工：不拷 registry 的 `thread` 与 `tool-fallback`。线程、消息、步骤卡、停靠区、输入框是 `features/chat/` 内的应用层组件，
  直接用 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合。拷入 `web/src/components/assistant-ui/`（`components.json` 产生的落点）的只有
  `markdown-text`、`reasoning`、`tool-group`，各自在首个消费它的任务组拷入，连同它们依赖的 `ui` 组件（`collapsible`、`skeleton` 等，不含 `avatar`）；
  拷入组件需要的 npm 包（如 `tw-shimmer`）随它加入并登记 `ATTRIBUTION.md`。拷入文件只做 A 定下的六类修改（owner 2026-10-04 把第六类从「渲染被丢弃的 `children`」放宽为「把被丢弃的调用方 `children` 或属性原样透传给底层基元，只转发、不写默认值」，`markdown-text` 的 `smooth` 即按此透传）；行为定制（链接惰性、图片显示为 alt 文本、块次序、
  失败自动展开、不出现编辑/分支/附件 UI）全部在应用层——经 `markdown-text` 的 `components` 覆盖，以及组合 `tool-group` / `reasoning` 的 Root/Trigger/Content。
- 每个分片（不只是每组）在同一 PR 里删除它替换的旧 `.tsx` 与旧 CSS、改写被打破的断言（单元测试与 ui-walk）、登记已迁移文件。
- 测试纪律沿用 A：按角色/可访问名的行为断言原样通过；只删除或改写读 `.css`、按旧类名选择的断言；规格条文在本 change 被改的行为，其断言随条文改写。
  新测试写进新文件（size-guard 800 行，现有四个测试文件已在 766-796 行）。

### D4 消息线程

- 线程与消息是应用层组件，用 `ThreadPrimitive` / `MessagePrimitive` / `ActionBarPrimitive` 组合；用到的拷入组件是 `markdown-text`（组 2）、`reasoning` 与 `tool-group`（组 5），见 D3。
- 消息根元素是 `article`，可访问名 `用户` / `助手`，带 `data-message-id`；对话内搜索的当前命中用 `aria-current` 标记，定位用滚动层提供的 `scrollToMessage` 句柄。
  这三样随线程在组 2 迁移（搜索框本身在组 8 只换肤）。
- 用户消息：右侧气泡，完整保留文本与空白。操作行：`从此处分叉`。
- 助手消息块次序（各项仅在存在时渲染）：思考折叠 → 正文 → 工具调用组 → 已结算审批记录 → 错误文本 → 文件变更卡 → 产物卡 → `已停止` 徽章 → 操作行（`复制`、`重新生成`）。
  与现状相比：待决审批移出消息（D7）；步骤卡变为工具调用组。
- 思考：折叠块，可访问名 `深度思考过程`，行为按 thinking-fold（回合进行中展开、终态收起）。
- 工具调用组（owner 决定 8）：一条助手消息的全部步骤收进一个默认收起的组，收起时显示一行摘要（步骤数与最近一步的名称、状态）；
  组由应用层组合 `tool-group` 的 Root/Trigger/Content，步骤卡是应用层组件。展开后每步一张卡：图标（`bash` 为终端，其余为扳手）、步骤名、`role="status"` 状态徽章（可访问名 `<步骤名> 运行中|已完成|失败|已停止`）、一行摘要（规则不变，来自 `step-summary.ts`）、
  `原始输出` 折叠（完整 `detail` 与 `output` 分栏，不做路径改写）。组内有失败步骤时组自动展开。文件变更卡与产物卡在组之外。
- 运行中的助手正文末尾显示闪烁光标；`prefers-reduced-motion: reduce` 下不闪（可观察量：光标的计算样式 `animation-name` 为 `none`）。
- 滚动：用 `ThreadPrimitive.Viewport` 的贴底跟随与 `ThreadPrimitive.ScrollToBottom`（可访问名 `回到最新`）。既有行为场景（打开即在底部、上滚后新增量不拉回、
  点 `回到最新` 回到底部并恢复跟随、转录区尺寸变化后重新贴底、欢迎态无该按钮）是判定标准；原生行为满足不了某条场景时，保留 `scroll-follow.tsx` 的对应逻辑补齐。
  实现结果（#849）：`ThreadPrimitive.Viewport` 是唯一的滚动容器，但它自带的跟随全部关闭，贴底状态机沿用旧逻辑——原生规则在贴底阈值（1px 对 4px）、
  按钮显隐（一离底即可用、贴底时渲染禁用占位，对「超过一屏才出现、贴底不渲染」）、上滚判定、scroll 回声当场回底、打开会话当帧回底、`scrollToMessage` 的同步重算六处与场景不符。
  `回到最新` 因此是普通按钮，不用 `ThreadPrimitive.ScrollToBottom`。基元无条件构造 `ResizeObserver`，没有它的环境里滚动容器退回普通 `div`（主规格要求此时退化且不报错）。
- 空态（#825）：选中会话且 `messages` 为空、历史已加载、输入框未锁定（无回合在跑，也没有带刷新指引的流错误）时，线程区显示一个图标、一行 `还没有消息，发一条开始吧`，
  以及该会话绑定的工作空间名（只读，前缀 `工作空间`；未绑定，或空间名解析不出——列表读取中、读取失败、空间已删——时不显示这一行）。不显示场景分组与快捷任务；不改输入框草稿；页面一级标题仍是顶栏面包屑。

### D5 Markdown：`@assistant-ui/react-markdown`

- 依赖 `@assistant-ui/react-markdown` + `remark-gfm`。不引入 `rehype-raw`：源 HTML 不生成元素，按文本出现。
- 链接：与现状一样惰性——只显示可见文本，丢弃目标，不生成 `a` 元素（任何协议都一样）。
- 图片：不加载。`img` 渲染为其 alt 文本（无 alt 时为 URL 文本）。理由：模型输出的图片 URL 会让浏览器向任意主机发请求。
- 链接与图片规则经 `markdown-text` 的 `components` 覆盖写在应用层，拷入文件不为此改动。
- 代码块带复制按钮：成功只换图标，失败在按钮旁就地显示 `role="alert"` 的 `复制失败`（与消息级复制同一规则，见 D8）；不做语法高亮（不为它再加依赖）。
- `web/src/lib/md-render.ts` 留给文件页使用，不删除。
- `复制` 仍复制助手的 Markdown 原文。

### D6 输入框与能力栏

- 输入框是应用层组件，不用 `ComposerPrimitive`：一个受控的 `textarea`（拷入层 `textarea`）加按钮，应用的 `draft` 状态是唯一事实来源，发送走现有发送路径。
  文本框可访问名 `给助手发消息`（欢迎态占位 `今天帮你做些什么`，已选会话 `继续追问，或派一个新任务…`）、底部能力栏、发送按钮；
  回合进行中发送按钮原位换成 `停止`，并显示 `role="status"` 的 `生成中`。键盘规则不变（Enter 发送、Shift+Enter 换行、输入法组合态与键码 229 不发送、长按不重复提交、空白草稿不可发送）。
- 能力栏（自左向右）：
  1. 工作空间：欢迎态是选择器（数据来自 `GET /api/workspaces`，默认 `未选择`，选项为本账号的空间）；已选会话是只读标签，显示绑定的空间名或 `未绑定`（owner 决定 4：会话开始后锁定）。
  2. 「+」菜单：列出 `GET /api/commands?workspaceId=` 的条目（内建命令与技能，项目技能带现有标记）。只在草稿为空白时可用：点选把草稿设为 `/<name> ` 并聚焦输入框，不发送；
     草稿非空白时 `技能与命令` 按钮禁用（与「此时键入 `/` 不会打开候选」同一条件）。权限设置、上传文件、专家不出现在菜单里。
- 斜杠候选（输入 `/` 触发的 listbox）行为不变，沿用 `slash-menu-state.ts`；它与「+」菜单共用同一份按工作空间缓存的目录与拉取时机规则。
- 停止：点击只调用一次 `stopSession`，点击后到响应或终态之间禁用；不弹提示（D8）。
- 连接器终止失败而最近快照仍为 running 时：输入框保持锁定，不显示 `生成中`，也不显示 `停止`（失败引导优先）。
- 业务错误（400/409/502/503 信封文案、`agent_capacity`）继续就地显示在输入框上，规则不变。

### D7 审批：输入框上方的提问卡 + 消息内已结算记录

- 停靠区 `ComposerDock`（应用层组件）位于输入框正上方，自上而下：任务清单面板（D10）、待决审批提问卡。停靠区不随线程滚动。
- 高度：停靠区整体有最大高度（不超过页面列高度的一半），超出时在停靠区内部滚动；每张提问卡的 `title` 正文另有自己的最大高度与内部滚动，
  使第一张待决卡的 `允许` / `拒绝` 不滚动停靠区即可见。判定按 seam 分工：
  - 结构（整页挂载，jsdom）：极端状态——三张待决提问卡（其中一张 `title` 为 50 行）、200 个任务的清单、面板与提问卡并存——只断言结构：面板与全部提问卡在同一个停靠区容器内，
    该容器在线程滚动容器之外、文档顺序在输入框之前；停靠区容器、每张卡的 `title` 正文、面板的列表各自带有限高与内部滚动的样式声明（经实现暴露的稳定钩子如 `data-slot` 定位）；
    第一张卡的按钮不在 `title` 正文的滚动容器内。jsdom 不做布局，这里不出现视口或像素断言。
  - 布局（ui-walk，真实浏览器）：只对真实栈能产生的状态断言。受控上游每轮只发一个工具调用、审批 `title` 由 omp 生成、ui-walk 禁用路由伪造与假 EventSource，
    所以走查里只有「一张待决提问卡」（首回合 bash 审批）与「两项任务的清单面板」（`WORKBUDDY_TODO` 回合）两种状态：390×844 与 1440×900 下，
    前者输入框与 `停止` 完整在视口内、线程可见高度不为零、页面无横向滚动、卡的 `允许` / `拒绝` 在视口内；后者面板展开时输入框与发送按钮完整在视口内、线程可见高度不为零、页面无横向滚动。
    不为凑极端状态新增受控上游标记。
- 提问卡：选中会话全部消息里 `decision === null` 的审批，按 `id` 升序各一张、纵向叠放。每张是独立的 `role="group"`，可访问名 `需要你的确认`；
  内容为工具名徽章（`tool` 字段）、`title` 全文（`white-space: pre-wrap`）、倒计时句 `（<n>s 内未操作将自动允许）`、按钮 `允许` / `拒绝`。
  `n = max(0, ceil((expiresAt - now) / 1000))`，至少每秒重算一次。
  每张只用自己的 `approval.id` 作答，互不影响；点击后该张两个按钮立即禁用；卡头不做乐观改动。
- 作答失败：409 `approval_settled` 不显示错误，页面主动对账权威历史（同现状）。非 409 的失败（400/404/502/503/网络）在该卡内以 `role="alert"` 显示信封文案
  （无信封的网络错误沿用主规格对这类错误的既有措辞），该卡两个按钮恢复可用，下一次点击时清除这条提示。
- 收起：`approval.resolved` 到达（或快照显示已结算）后提问卡消失。
- 已结算记录：在该审批所属的助手消息内（块次序见 D4）每条一行记录，`role="group"`，可访问名按 `decision`：`allow` → `已允许执行`，`deny` → `已拒绝执行`，
  `timeout` → `超时自动允许`；显示工具名徽章与 `title` 全文。没有按钮与倒计时。
  （现状把 `timeout` 也显示为 `已允许执行`；ADR-0013 决定 4 列了三种结果，这里分开。）
- 刷新后：快照里的待决审批恢复为提问卡，倒计时从 `expiresAt` 算（刷新时已过期则显示 `（0s 内未操作将自动允许）`）；已结算的恢复为消息内记录。
- 待决审批存在时回合仍在跑：输入框锁定、`停止` 可用，与现状一致。
- 不用 assistant-ui 的 `tool-call.approval`：它要求审批属于某一次工具调用（现有契约没有关联键，试验里按工具名配对），而且会被默认收起的工具调用组藏住。

### D8 轻提示退场

- 已迁移的会话页文件不导入 `useToast`（守卫白名单不变，机械保证）。
- 成功/信息类提示删除：`已复制到剪贴板`、`已停止生成`、`正在重新生成…`、`已切换到「…」场景`、`当前任务暂无产物`。
- 复制成功：按钮图标换成对勾约 2 秒，并有一个视觉隐藏的 `role="status"` 文本 `已复制`。
- 失败就地显示：在触发控件旁渲染 `role="alert"` 的一行文字（`复制失败`、`文件过大，无法复制`、下载/预览失败的信封文案），下一次成功或再次触发时清除。
- `产物面板` 在没有产物时照常打开，面板内显示空态 `当前任务暂无产物`（不再用提示替代打开）。
- `session-actions.ts` 的提示不动（C）。

### D9 欢迎页、场景与会话创建（#824 / #825 / #826）

- 欢迎态：hero `WorkBuddy，我帮你`（页面一级标题）、三个场景分组 `日常办公` / `代码开发` / `创意设计`（默认 `日常办公`）、所选场景的快捷任务、输入框（含能力栏）、
  最佳实践卡与 `换一批`、免责声明 `内容由 AI 生成，请核实重要信息`。静态内容沿用 `welcome-content.ts`。
- 场景只是欢迎页的建议分组（owner 决定 6）：切换只换快捷任务列表，不弹提示（#824）；会话开始后界面不再显示场景。
  所选场景仍随首次发送写进 `POST /api/sessions` 的 `scene`（后端字段与会话 DTO 不变）。
- 「新建会话」（#826，owner 决定 3）：`SessionSidebar` 的 `onCreateSession` 改为「回到欢迎态」——以 replace 导航清除 `?session=`（保留无关的 search/hash）、不发任何请求、输入框草稿不动。
  焦点：侧栏不是覆盖层时（宽视口）落到输入框，已在欢迎态时只聚焦输入框；侧栏是覆盖层时（窄视口）覆盖层关闭、焦点按外壳现有规则回到 `打开导航`，与任何侧栏导航一样。外壳不改。
- 首次发送：欢迎态发送时恰一次 `POST /api/sessions`（body 为 `{scene}` 或 `{scene, workspaceId}`），选中返回的 id，再恰一次 prompt。沿用现有 `createAndSelect(prompt)` 路径与其 fence。
- 零消息会话仍会出现（从第一条用户消息分叉、历史遗留的空会话）：显示 D4 的空态（#825）。
- 随之改写的断言：所有「点新建会话 → POST」的测试（`chat-page-welcome-scene*`、`chat-page-sidebar`、`chat-page-session-pin`、`chat-page-lifecycle`、`chat-page-ownership`、
  `app-shell-responsive`）与 ui-walk 的 `createSessionFromSidebar`（改为在欢迎态输入并发送来建会话）、`ui-walk-layout.ts` 的 `.chat-playbooks-row` / `.chat-main` 选择器。

### D10 任务清单

后端：

- 来源：`tool_execution_end` 且 `toolName === "todo"`、未失败时，归约器把 `result.details.phases` 原值作为候选交给持久化路径（归约器不做 IO、不校验）；
  那里做结构校验，通过则取全量 `phases`。校验不过（缺字段、类型不对、未知 `status`）时丢弃这一候选并记一条 warn 日志，不影响步骤事件与回合。
- 归一化与上限：`{phases:[{name, tasks:[{content, status}]}]}`；`status` 五值原样；`blocker` 不下发；`name` / `content` 各截断到 200 码点；
  总任务数上限 200（超出的按原序截掉）。没有任务的阶段不输出；全部阶段都没有任务时归一为 `null`。
- 持久化：迁移 `036` 给 `chat_sessions` 加可空 `todo` 列（JSON 文本）。事件提交时与其它事件走同一条有序持久化路径，写入该会话行；写 `todo` 不改会话的 `updated_at`。
- 文件落点：`supervisor.ts`（800 行）与 `store.ts`（797 行）不得增长。校验、归一化、去重、warn 落在 `turn-control.ts` 的 `persistEvent` 与一个新的 store 模块
  （与 `store-metadata.ts` / `store-changes.ts` 并列）；归一化本身是独立的纯函数模块（仿 `file-changes.ts`）；warn sink 以注入方式提供，不给 `supervisor.ts` 加行。
- 事件：`todo.updated`，`data = {messageId, todo}`（`todo` 为归一化对象或 `null`），`messageId` 是当前回合的助手消息 id（所有现有事件都带它，续流判定不用开特例）。
  与上一次落库值相同则不发。发布位置紧邻该次工具调用的 `step.end` 之前。
- 快照：`GET /api/sessions/:id/messages` 新增顶层键 `todo`（对象或 `null`），四键严格。
- 分叉得到的新会话 `todo` 为 `null`；重新生成不清空（清单是 omp 会话状态，下一次 `todo` 工具结果会覆盖）。
- 不新增 REST 端点，不调用 `get_state`。

web：

- `session-contract.ts` 的快照解析（`:303-304`）改为四键严格并校验 `todo` 结构（组 9b，连同约 22 个 web 测试文件、45 处三键快照字面量补 `todo: null`，
  尽量收敛到 `chat-stream-support.ts`、`chat-page-*-support.*`）；事件联合、解码与归约加入 `todo.updated`，`ChatState` 增 `todo`（组 10；`stream.ts` 已 742 行，新增逻辑放进新的 `stream-*.ts` 文件）。
- 面板（停靠区最上方）：`todo` 非空且至少有一个任务不是 `completed` / `abandoned` 时显示；全部完成或放弃、或 `todo` 为 `null` 时不显示。
  头部是一个按钮 `任务清单 <完成数>/<总数>`（`aria-expanded`），默认展开；展开后按阶段列出任务，多于一个阶段时显示阶段名；
  每个任务带状态标记与可访问文本（`待办` / `进行中` / `已完成` / `已放弃` / `受阻`）。只读。展开/收起状态按会话保存在内存里，切换会话不串。
- 面板计入停靠区的最大高度（D7），超出时在内部滚动，不把输入框挤出视口。200 个任务的清单只在整页挂载测试里断言结构（列表带有限高与内部滚动的样式声明）；
  ui-walk 只对 `WORKBUDDY_TODO` 产生的两项任务面板断言布局（证据分工见 D7）。

测试支撑：

- `server/test/support/fake-omp.mjs` 增 `todo` 场景（工具结果带 `details.phases`）；`fake-upstream.mjs` 增 `WORKBUDDY_TODO` 标记，让真实 omp 发出一次 `todo` 工具调用。
- ui-walk 在真实 omp + fake 上游下走一轮带 `WORKBUDDY_TODO` 的回合，断言面板出现且刷新后仍在。这同时回答「RPC 模式下真实 omp 的 `todo` 工具是否可用、`details` 形状是否如上」。

### D11 落刀次序

每组至少一个 PR（组内按 tasks 的 `Minimal mergeable slice` 再切），组间串行，次序 1 → 8 → 9a → 9b → 10 → 11（共享 `page.tsx` / `conversation-view.tsx` / `ui-layering.test.ts` 清单断言 / ui-walk 文件）。

- 组 1：数据 hook 抽取（纯重构）。
- 组 2：运行时与线程骨架：依赖、拷入 `markdown-text`、`convertMessage`、用户/助手正文（Markdown）、光标、错误、停止徽章、滚动与 `scrollToMessage`、搜索命中标记；其余块用旧组件挂在插槽里。
- 组 3：输入框与能力栏。
- 组 4：欢迎页、场景、会话创建时机、空态（关闭 #824、#825、#826）。
- 组 5：思考、工具调用组、操作行（复制/重新生成/分叉的提示退场）；ui-walk 改为先展开工具调用组再断言步骤状态。
- 组 6：停靠区与审批（提问卡 + 已结算记录）；停靠区极端状态的结构断言（整页挂载）；ui-walk 的审批位置步骤与一张待决提问卡时的停靠区布局断言。
- 组 7：文件变更卡、产物卡、产物面板。
- 组 8：对话内搜索框换肤与项目配置入口。
- 组 9a：任务清单后端之一：迁移 036、归一化纯函数模块、fake omp 的 `todo` 场景与 fake 上游的 `WORKBUDDY_TODO` 标记及其测试——无公共契约变化。
- 组 9b：任务清单后端之二：归约器候选、持久化路径（校验/归一化/去重/warn/写入）、`todo.updated` 发布、快照 `todo` 键、web 四键解析与 web 测试 fixture、管线测试。
- 组 10：任务清单 web：归约与面板（契约解析已在 9b）。
- 组 11：收尾：删旧 CSS 与 `revert` 规则、ui-walk 残余选择器、包体记录、清单与文档对齐。

4 放在 3 之后是真实依赖：欢迎态的工作空间选择在能力栏里。9a 与 1-8 无依赖，可提前；排在后面只因为串行执行且前面的分片先解决用户报的缺陷。
9b 要改与组 2-8 共享的 web 测试 fixture，留在序列里。

### D12 功能验收清单与文档

- 每个分片在 `docs/acceptance/functional-checklist.md` 的「会话（CH）」节为自己交付的行为补行，结论一律 `待签`（agent 不签）。
- `IMPLEMENTATION_PLAN.md` 的 S1f 段把 B 的「纯前端」订正为含任务清单后端，并登记本次 grill 的决定；ADR-0013 增补一段，列五项：链接惰性与图片不加载、轻提示退场、审批提问卡与任务清单面板停靠在输入框上方、B 不用运行时的 threadList、任务清单后端。
  这两处在第一个分片里改。

### D13 细则（规格撰写时收敛的取法）

- 思考折叠的默认态按 thinking-fold 现规则：回合进行中展开、终态收起（D4 的「默认收起」指终态）。
- 能力栏的工作空间选择器保留现有文案与交互：按钮文本 `任务启动于 <空间名|未选择>`、搜索框 `搜索工作空间`、空结果 `没有匹配的工作空间`、逻辑路径副文本。
  已选会话的只读标签同样以 `任务启动于` 开头，后接空间名或 `未绑定`；`workspaceId` 非空但在已读取列表里找不到（读取中、失败、空间已删）时显示 `任务启动于 已绑定空间`。
- 「+」按钮的可访问名为 `技能与命令`。打开菜单时按斜杠候选同一规则触发目录拉取；拉取中或失败时菜单显示 `暂无可用项`，不报错；菜单开着时目录到达，列表就地替换 `暂无可用项`；输入框锁定或草稿非空白时按钮禁用。每项显示名称与描述。
- 输入框下方的提示行 `Enter 发送 · Shift+Enter 换行` 保留；助手消息保留装饰性头像标记。
- 工具调用组的一行摘要内容为步骤数、末位步骤的名称与状态文字；因失败自动展开后用户仍可手动收起，之后不再自动展开，直到出现新的失败步骤。
- 停靠区为空时不占位。
- 任务清单：`<完成数>` 只数 `completed`，`<总数>` 为全部任务数；截断是纯码点截断、不加标记。
- `WORKBUDDY_WRITE` 与 `WORKBUDDY_TODO` 同时出现时前者优先；`fake-omp.mjs` 已 799 行，新增常量放进 `fake-omp-thinking.mjs`。
- 9b 合入而 10 未合入期间，web 对 `todo.updated` 按「未知事件类型忽略」处理。
- 拷入层组件的拷入点：`markdown-text` 在组 2，`textarea` 与工作空间选择器所需的 `popover` 在组 3，`reasoning`、`tool-group`、`collapsible`、`skeleton` 在组 5，
  `dialog` 在组 7（首个消费者是 html 产物预览），组 8 的项目配置入口复用它。
- html 产物预览改用拷入层 `dialog`：关闭后焦点回到预览按钮且线程不滚动（turn-artifacts）；ui-primitives 的「焦点归还不滚动」场景改以会话重命名对话框（仍是旧 `Dialog`）为对象。
- 对话内搜索的高亮只以 `aria-current` 为可观察量。

## Sketch seams under test

1. **整页挂载 + 假 API/假 EventSource**（`renderChatPage` / `mountAuthenticatedApp`，已有）：会话页全部行为断言的主 seam，按角色与可访问名选择；另含停靠区极端状态的结构断言（多张提问卡、50 行 `title`、200 个任务的清单：同一停靠区容器、在线程滚动容器之外、各滚动容器带有限高与内部滚动的样式声明，不作视口断言）。选它因为它已经承载约 12,600 行行为断言，重建前后同一组断言是「行为不变」的证据。
2. **纯函数**：`convertMessage`、`stream.ts` 归约（含 `todo.updated`）、`session-contract.ts` 解析、服务端 `applyFrame` 与清单归一化。选它因为映射与契约错误在这里最便宜地暴露。
3. **服务端事件管线测试**（`session-events*`、`session-snapshot*`、`session-sse*`、迁移测试，已有模式）+ fake omp：`todo` 的落库、事件、快照、续流。
4. **ui-walk（真实服务 + 真实 omp + fake 上游）**：层叠与布局结果、停靠区位置与布局（只对真实栈能产生的状态：一张待决提问卡、两项任务的清单面板，见 D7）、滚动、首次发送建会话、任务清单端到端、`prefers-reduced-motion` 下光标的计算样式。只有真实浏览器与真实 omp 能证明的东西放这里。
5. **静态守卫**：`ui-layering.test.ts` 的已迁移清单（机械保证已迁移文件不导入 `useToast` 与旧基元）。

## Risks / Trade-offs

- **运行时与自有状态的错位**：`isRunning` 与应用的 `generating` / 锁定是两套信号。缓解：D1 把二者的边界写死（`isRunning` 只看末条助手消息，不产生乐观占位），
  分叉/历史加载的锁定与「首次发送后没有助手块」有专门断言。
- **停靠区挤占纵向空间**：任务清单面板加多张提问卡可能把线程压没或把输入框挤出视口。缓解：D7 的两级最大高度与内部滚动；极端状态（多张卡、50 行 `title`、200 个任务）由整页挂载测试断言结构，ui-walk 在两个视口下对真实栈能产生的状态（一张待决卡、两项任务的面板）断言布局。残余：极端状态下的像素级布局没有自动化证据，靠限高规则本身与评审把关。
- **滚动行为回归**：换成 Viewport 原生跟随。缓解：既有场景与 `ui-walk-scroll` 是判定标准，必要时保留旧逻辑。
- **`todo` 形状来自对二进制的反查**：缓解：结构校验 + 丢弃不合规帧；ui-walk 用真实 omp 走通；真实端点验收时再看一次。
- **`/todo` 斜杠命令改清单后面板滞后**：见 Not yet specified。面板在下一次 `todo` 工具结果到达时自愈。
- **分片期间新旧观感混排**：2-8 之间页面里同时有新旧块。可接受（owner 决定 1：逐步替换、主干可运行）。
- **包体翻倍**：试装约 1.09 MB。记录不处理；超出可接受范围另行立项做分割。
- **change 体量大**：12 个串行任务组，多数组内再切成几刀。每组都有独立的验证路径；9a 可以随时提前。

## Migration Plan

- 数据库：迁移 `036` 只加一个可空列，旧行为 `NULL`（即无清单），无回填。回滚 = 不读该列。
- 9a（迁移、归一化模块、测试支撑）不改任何公共契约，可单独合入。
- 快照四键：三键严格解析会拒绝多出的键，所以 9b 把服务端快照的 `todo` 键、web 的四键解析与 web 测试 fixture 放在同一刀；归约与面板在 10。
- 其余为纯前端替换，无数据迁移；回滚 = 回退对应 PR。

## Not yet specified

- **`/todo` 斜杠命令对清单的修改**：`/todo append|start|done…` 不产生工具帧，面板要到下一次 `todo` 工具结果才更新。补读需要在回合结束后调用 `get_state`，
  它与回合收尾的发布顺序、进程回收、`SessionBusyError` 的关系还没摸清，问题本身尚不能精确表述。
- **omp 的 `todo_reminder` / `todo_auto_clear` 帧**：本 change 不处理 omp 的其它 todo 帧；它们是否意味着清单被清空、面板该如何反映，没有摸清。
- **已结算审批标到具体工具卡**：需要审批与步骤的关联键（后端），关联键的来源（omp 的审批请求是否带工具调用 id）未查证。

## Open Questions

- 真实模型在 RPC 模式下是否会主动调用 `todo`（工具为 `discoverable` 加载）。不影响实现；若实际很少触发，面板只是很少出现。真实端点验收时记录观察结果。
- 包体上限定多少、何时做分割：等收尾分片量出数字后由 owner 定。
