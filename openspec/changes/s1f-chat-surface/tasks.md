# Tasks: s1f-chat-surface

> 执行顺序：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9a → 9b → 10 → 11（design D11；串行原因是共享 `page.tsx`、`conversation-view.tsx`、`ui-layering.test.ts` 的清单断言与 ui-walk 文件）。
> 例外：4.2 + 4.3（创建时机反转，不替换组件、不依赖能力栏）只依赖组 1，可紧随组 1 执行；D11「4 在 3 之后」的理由只约束 4.1（欢迎页换肤）。
> 组 9a（迁移、归一化、测试支撑；无公共契约变化）与 1-8 没有依赖，可提前。组 9b 要改与组 2-8 共享的 web 测试 fixture，按序执行。
>
> 通用纪律：
> - 每组一个或多个 PR（按各组的 `Minimal mergeable slice`），每个 PR 合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行；会话页任何时刻只有一份实现挂在 `/`。
> - 「行为不变」的证据是既有行为断言（按角色/可访问名）原样通过。只允许删除或改写读 `.css`、按旧类名选择的断言；规格条文在本 change 被改的行为，其断言随条文改写，改写处写进 PR 的偏离记录。
> - 不改会话列表的八个文件（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、`rename-dialog.tsx`、`delete-dialog.tsx`）
>   的实现（组 4 也不需要改它们——`onCreateSession` 的语义在调用方变）；不改 `web/src/features/files/**`；`web/src/ui/**` 冻结；`main.tsx` 的 `ToastProvider` 不动；外壳文件不动。
> - 不移动、不改名 `web/src/features/chat/stream-steps.ts`，不改动其第 44 行及之前的行数（`ui-guardrails.test.ts` 钉死）。
> - 一个文件不再导入 `web/src/ui`（`Icon`、`IconName`、`BrandMark`、`useEscapeFallback` 除外）且不依赖旧类名时，把它加进 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 并同步清单断言；已迁移文件不得导入 `useToast`。
> - 拷入层（`web/src/components/ui`、`web/src/components/assistant-ui`）只做 A 定下的六类修改，行为定制一律写在应用层；拷入前后的差异写进 PR 描述。
>   拷入组件随首个消费它的任务拷入；它需要的 npm 包（如 `tw-shimmer`）随它加入并登记 `ATTRIBUTION.md`。不拷 registry 的 `thread`、`tool-fallback`。
> - 每个分片（不只是每组）在同一个 PR 里：删除它所替换的旧 `.tsx` 与旧 CSS 规则，改写被替换的行为/DOM 打破的断言（单元测试与 ui-walk），登记已迁移文件。
>   各组的「按分片退役」任务与「改写断言」任务不是组尾的一次性任务，每一刀带走自己的份额。新测试写进新文件（size-guard 800 行；已近上限的测试文件只减不增）。
> - 每组在 `docs/acceptance/functional-checklist.md` 的「会话（CH）」节为自己交付的行为补行，结论一律 `待签`。
> - knip 不允许未引用导出与未使用依赖：依赖随首个消费者同刀加入。

## 1. chat-web — 抽出无渲染的 `useChatSession`

- [x] 1.1 新建 `web/src/features/chat/use-chat-session.ts`：把 `page.tsx` 的列表、历史、连接、发送/创建、fence 状态与派生量（`generating`、`composerLocks` 等）移入，返回只读状态与动作；
  `turn-actions.ts` 改由它调用并由它持有 fence 状态。值导入方向只有 `page.tsx → use-chat-session.ts → turn-actions.ts`。
- [x] 1.2 `page.tsx` 只保留 `ChatPage` 的组合与外壳接线（`useTopbar`、`useSidebarSlot`）；`SessionSidebar` 的 props 契约不变；`index.ts` 仍只导出 `ChatPage`。
- [x] 1.3 既有测试零改动通过（整页测试约 12,600 行是这一刀的证据）；新增一个测试文件断言模块划分：`turn-actions.ts`、`use-chat-session.ts` 不导入 `./page.js`；
  `turn-actions.ts` 不导入 `./use-chat-session.js`，其导出只被 `use-chat-session.ts` 消费；`use-chat-session.ts` 不含 JSX。
- [x] 1.4 文档（design D12）：`IMPLEMENTATION_PLAN.md` S1f 段订正 B 的范围（含任务清单后端）并登记本次 grill 的决定；`docs/adr/0013-assistant-ui-frontend-rebuild.md` 增补一段，列五项：
  链接惰性与图片不加载、轻提示退场、审批提问卡与任务清单面板停靠在输入框上方、B 不用运行时的 threadList、任务清单后端。

Suggested fixture level: expanded - 无行为变化，但搬移的是全部所有权 fence、代次计数与 abort controller（共享状态 + 并发）；既有整页测试是证据，fence 的搬移需要逐条对照
Minimal mergeable slice: atomic - `page.tsx` 的状态与 `turn-actions.ts` 的 fence 注入是同一组闭包，拆成两次搬移会出现中间态里 fence 一半在页面一半在 hook；验证路径单一（既有测试 + knip）。这一刀不替换任何呈现，无旧文件/CSS/断言要退役

## 2. chat-web — 运行时与线程骨架

- [x] 2.1 依赖与拷入：`web/package.json` 加 `@assistant-ui/react`、`@assistant-ui/react-markdown`、`remark-gfm`；`ATTRIBUTION.md` 登记；
  只拷入本组消费的 `markdown-text` 到 `web/src/components/assistant-ui/`（`components.json` 产生的落点），连同它依赖的 `ui` 组件与 npm 包；文案中文化。
- [x] 2.2 `runtime-convert.ts`（纯函数，design D1）与其单元测试：id、text / reasoning / tool-call part 的映射与顺序、状态映射、`metadata.custom` 透传。
- [x] 2.3 运行时接入：`useExternalStoreRuntime`（`messages`、`isRunning`、`convertMessage`、`onNew`、`onCancel`、`onReload`）。`isRunning` 仅当选中会话末条消息是状态为 `running` 的助手消息时为真
  （运行时不注入乐观的助手占位）；`onNew` 委托给现有发送路径，没有 UI 调用运行时的 composer；`生成中` / `停止` / 锁定仍由应用自己的 `generating` 驱动（design D1）。
  测试：历史加载中、分叉进行中时输入框禁用但线程不显示运行态；欢迎态首次发送后，在 `turn.start` 或快照给出助手消息之前线程里没有助手块。
- [x] 2.4 线程骨架：应用层组件，直接用 `ThreadPrimitive` / `MessagePrimitive` 组合。消息根元素是 `article`（可访问名 `用户` / `助手`），带 `data-message-id` 与搜索命中标记 `aria-current`；
  用户气泡（保留空白）、助手块（头像、Markdown 正文、运行中光标、错误文本、`已停止` 徽章与空正文占位 `（已停止生成）`）；
  思考、步骤卡、审批条、文件变更卡、产物卡、操作行此刻仍用旧组件，按 D4 的块次序挂在助手消息的插槽里（审批条暂留在消息内，组 6 移走）。旧输入框表单仍在线程下方。
- [x] 2.5 Markdown（design D5）：不生成源 HTML 元素；链接与现状一样惰性（只显示可见文本、丢弃目标、不生成 `a` 元素）；图片渲染为 alt 文本、不加载；
  这些规则经 `markdown-text` 的 `components` 覆盖写在应用层。代码块复制成功只换图标，失败在按钮旁就地显示 `role="alert"` 的 `复制失败`。
  测试含注入样本：`<script>`、`javascript:` 链接、`https:` 链接、`data:` 链接、图片。
- [x] 2.6 滚动（design D4）：`ThreadPrimitive.Viewport` + 可访问名为 `回到最新` 的回底按钮；新滚动层继续提供对话内搜索使用的 `scrollToMessage` 句柄，
  `chat-page-search*.test.tsx` 与 ui-walk 的搜索步骤保持通过；既有滚动场景与 `ui-walk-scroll` 通过；原生行为不满足的场景保留 `scroll-follow.tsx` 对应逻辑。
- [x] 2.7 改写被打破的断言（按分片）：ui-walk 中 `.chat-md` / `.chat-msg-body` 选择器（`ui-walk-stop.ts`、`ui-walk.spec.ts`、`ui-walk-sessions.spec.ts`、`ui-walk-scroll.ts`）改为角色/属性；
  单元测试 `chat-messages`、`chat-copy`（读 CSS 的部分）、`chat-scroll-follow`；ui-walk 新增断言：`prefers-reduced-motion: reduce` 下光标的计算样式 `animation-name` 为 `none`；
  搜索高亮只断言 `aria-current`。
- [x] 2.8 按分片退役：删除被替换区域的旧 CSS 规则与读它们的静态断言、`conversation-view.tsx` 中已替换的部分；登记已迁移文件；CH 行：消息呈现、Markdown 规则、回到最新。

Suggested fixture level: expanded - 引入运行时（状态边界一次定调）、换 Markdown 渲染器（安全面变化）、换滚动实现；ui-walk 才能证明滚动与布局
Minimal mergeable slice: 2.1 + 2.2 + 2.3 + 2.4 + 2.5，以及 2.7 / 2.8 中属于它们的份额（`.chat-md` / `.chat-msg-body` 选择器、`chat-messages` 与 `chat-copy` 的读 CSS 断言、对应旧 CSS 与 `conversation-view.tsx` 已替换部分）——运行时、映射与最小线程必须同刀（依赖没有消费者即被 knip 拒绝，线程没有运行时无法渲染），渲染器的安全规则不可后置，`article` 根与 `aria-current` 同刀才能让搜索测试保绿。2.6 滚动是紧随其后的一刀，自带 `chat-scroll-follow` 与 `ui-walk-scroll.ts` 的改写（首刀期间旧 `scroll-follow.tsx` 包裹新线程并继续提供 `scrollToMessage`）

## 3. chat-web / session-sidebar — 输入框与能力栏

- [x] 3.1 输入框（design D6）：应用层组件，不用 `ComposerPrimitive`——受控 `textarea`（拷入层 `textarea`，在此拷入；可访问名 `给助手发消息`；两种占位）+ 按钮，应用的 `draft` 是唯一事实来源，发送走现有发送路径；
  发送 / `停止` 原位切换、`生成中` 状态、键盘规则（Enter / Shift+Enter / 输入法组合态 / 键码 229 / 长按）；停止点击只调一次 `stopSession`、不弹提示；业务错误就地显示规则不变。
  连接器终止失败而最近快照仍为 running 时：输入框锁定，不显示 `生成中`，不显示 `停止`（失败引导优先）。
- [x] 3.2 能力栏-工作空间（design D6）：欢迎态为选择器（`GET /api/workspaces`，默认 `未选择`）；选择器按钮文本 `任务启动于 <空间名|未选择>`，搜索与空结果文案不变；
  已选会话为只读标签 `任务启动于 <空间名>` / `任务启动于 未绑定` / `任务启动于 已绑定空间`（绑定的空间不在已读取列表时）。选择器需要的拷入层组件（如 `popover`）在此拷入。
- [x] 3.3 能力栏-「+」菜单（按钮可访问名 `技能与命令`）：列出 `GET /api/commands?workspaceId=` 的条目与项目技能标记；仅当草稿为空白时可用，点选把草稿设为 `/<name> ` 并聚焦输入框、不发送；
  草稿非空白或输入框锁定时按钮禁用；拉取中或失败显示 `暂无可用项`，菜单开着时目录到达则列表就地替换它；与斜杠候选共用目录缓存与拉取时机。
- [x] 3.4 斜杠候选 listbox 换肤（行为与 `slash-menu-state.ts` 不变）：既有斜杠场景全部通过。
- [x] 3.5 改写被打破的断言（按分片）：`ui-walk-stop.ts` 对 `已停止生成` 的正向断言改为断言它不出现；`ui-walk-sessions.spec.ts` 的 `.chat-slash-*` 选择器改为角色/属性；
  单元测试 `chat-composer`、`chat-stop-button`、`chat-page-slash`（796 行，只减不增，新用例进新文件）。
- [x] 3.6 按分片退役：删除 `composer.tsx` / `composer-footer.tsx` / `slash-menu.tsx` 的旧实现与对应 CSS、静态断言；登记已迁移文件；CH 行：发送与停止、工作空间选择与只读、「+」菜单、斜杠候选。

Suggested fixture level: expanded - 输入框是发送/停止/锁定的唯一入口，键盘与输入法规则多；能力栏引入两处新交互
Minimal mergeable slice: 3.1 + 3.2 + 3.4，以及 3.5 / 3.6 的全部（旧表单、旧 footer、旧候选面板及其 CSS 与断言在这一刀退役）——新输入框必须带着工作空间选择与斜杠候选一起替换旧表单（旧 footer 的选择器与旧候选面板挂在旧表单上，换掉表单而不带它们会丢功能）；3.3「+」菜单是新增入口，后置一刀，不替换旧实现

## 4. session-sidebar / chat-web / spa-shell — 欢迎页、场景、会话创建时机与空态（#824 #825 #826）

- [x] 4.1 欢迎页重建（design D9）：hero、三个场景分组、快捷任务、最佳实践卡与 `换一批`、免责声明；切换场景不弹提示（删除 `scene-pills.tsx` 的 `useToast`）；所选场景仍写进创建 body。
- [x] 4.2 「新建会话」只回欢迎态：`onCreateSession` 的处理改为以 replace 导航清除 `?session=`（保留无关 search/hash）、零请求、草稿不动。侧栏不是覆盖层时（宽视口）聚焦输入框，已在欢迎态时只聚焦；
  侧栏是覆盖层时（窄视口）覆盖层关闭、焦点按外壳现有规则回到 `打开导航`——外壳不改。
- [x] 4.3 首次发送建会话：欢迎态发送恰一次 `POST /api/sessions`、恰一次 prompt（沿用 `createAndSelect(prompt)` 与其 fence）；删除「空 prompt 建会话」的代码路径。
- [x] 4.4 零消息会话空态（design D4）：图标、`还没有消息，发一条开始吧`、只读的绑定工作空间名（未绑定，或空间名解析不出——列表读取中、失败、空间已删——时不显示这一行）；
  不显示场景与快捷任务；不改草稿；一级标题仍是面包屑。
- [x] 4.5 改写单元断言（按分片）：所有「点新建会话 → POST」的测试（`chat-page-welcome-scene*`、`chat-page-sidebar`（768 行，只减不增）、`chat-page-session-pin`、`chat-page-lifecycle`、`chat-page-ownership`、`app-shell-responsive`）
  改为断言零 POST 与欢迎态；需要一个已存在会话的用例改用预置会话或首次发送。场景提示的断言改为「无提示」。
- [x] 4.6 ui-walk（按分片）：`createSessionFromSidebar` 改为在欢迎态输入并发送来建会话（或由各调用点改用预置/首次发送）；`ui-walk-layout.ts` 的 `.chat-playbooks-row`、`.chat-main` 选择器改为角色/属性；
  新增步骤：点「新建会话」后 URL 无会话 id、会话数不变；零消息会话（从第一条用户消息分叉得到）显示空态。
- [x] 4.7 按分片退役：删除 `welcome.tsx`、`scene-pills.tsx` 的旧实现与对应 CSS、静态断言；登记已迁移文件；CH 行：场景切换无提示、新建会话回欢迎态、首次发送才出现在列表、零消息会话空态。
  PR 描述写明关闭 #824、#825、#826。

Suggested fixture level: expanded - 反转一条既有规格行为（新建即 POST），牵动六个测试文件与 ui-walk 的建会话辅助函数；会话创建路径带所有权 fence
Minimal mergeable slice: 4.2 + 4.3，以及 4.5 / 4.6 中依赖「新建即 POST」的全部断言与 `createSessionFromSidebar`——创建时机的反转与这些断言、ui-walk 辅助函数必须同刀（只改行为则这些断言全红，只改断言则无对象）；这一刀不替换组件，无旧文件要删。4.1 欢迎页换肤一刀自带场景提示断言、`.chat-playbooks-row` / `.chat-main` 选择器的改写与 4.7 的删除；4.4 空态是新增呈现，独立一刀

## 5. chat-web / thinking-fold / turn-control — 思考、工具调用组与操作行

- [x] 5.1 拷入 `reasoning`、`tool-group`（及它们依赖的 `ui` 组件 `collapsible` 等，不含 `avatar`；需要的 npm 包随之加入并登记）。思考折叠由应用层组合 `reasoning` 的 Root/Trigger/Content：
  回合进行中展开、终态收起，可访问名 `深度思考过程`，thinking-fold 的行为场景通过。
- [x] 5.2 工具调用组（design D4）：应用层组合 `tool-group` 的 Root/Trigger/Content，步骤卡是应用层组件。默认收起的一行摘要；展开后的步骤卡（图标、名称、状态徽章与可访问名、一行摘要、`原始输出` 的 detail/output 分栏、不做路径改写）；
  有失败步骤时自动展开；用户手动收起后不再自动展开，直到出现新的失败步骤。
- [x] 5.3 操作行（应用层，`ActionBarPrimitive`）：`复制`（原文；成功换图标 + 视觉隐藏的 `已复制` 状态；失败就地 `role="alert"`）、`重新生成`（仅末条助手且会话状态 ∈ done/failed/stopped；不弹提示）、
  `从此处分叉`（仅用户消息；锁定期间禁用）。不渲染编辑、分支切换、附件。
- [x] 5.4 改写被打破的断言（按分片）：所有断言步骤徽章的 e2e（`ui-walk-approval.ts`、`ui-walk.spec.ts`、`ui-walk-scroll.ts`、`ui-walk-sessions.spec.ts`）先展开工具调用组再断言步骤状态；
  单元测试里直接断言步骤徽章的用例（如 `chat-stop-button`）同样先展开；
  `.chat-step-*`、`details.thinking-block`、`.thinking-body` 选择器改为角色/属性；`ui-walk-stop.ts` 对 `正在重新生成…` 的正向断言改为断言它不出现；
  单元测试 `chat-steps`、`chat-thinking`、`chat-copy`，以及断言提示的 `chat-regenerate-button`。
- [x] 5.5 按分片退役：删除 `thinking-block.tsx`、`message-actions.tsx`、`conversation-view.tsx` 里的 `StepCard` 等旧实现与对应 CSS、静态断言；登记已迁移文件；
  CH 行：思考折叠、工具调用组收起/展开/失败自动展开、复制、重新生成、分叉。

Suggested fixture level: expanded - 步骤呈现从逐卡变为折叠组（owner 决定 8），状态徽章的可访问名被多处测试与 ui-walk 依赖；三处提示退场
Minimal mergeable slice: 5.1（只拷 `reasoning` 及其依赖）+ 思考折叠，自带 `thinking-block.tsx` 与其 CSS 的删除、`chat-thinking` 与 `details.thinking-block` / `.thinking-body` 选择器的改写——思考块与步骤、操作行互不依赖，可先单独替换保绿。随后 5.2 工具调用组一刀（此刻拷 `tool-group`；自带 `StepCard` 删除、`chat-steps`、`.chat-step-*` 与四个 e2e 文件的「先展开」改写）、5.3 操作行一刀（自带 `message-actions.tsx` 删除、`chat-copy`、`正在重新生成…` 断言改写）；旧的其余块仍挂在插槽里

## 6. tool-approval / chat-web — 停靠区与审批

- [x] 6.1 停靠区 `ComposerDock`（应用层）：输入框正上方、不随线程滚动、为空时不占位；此刻只承载审批提问卡（任务清单面板在组 10 加入其上方）。
  停靠区整体有最大高度（不超过页面列高度的一半）并在内部滚动；每张提问卡的 `title` 正文另有自己的最大高度与内部滚动，使第一张待决卡的 `允许` / `拒绝` 不滚动停靠区即可见。
  整页挂载结构测试（jsdom，不作视口断言）：三张待决提问卡、其中一张 `title` 为 50 行——全部卡在同一个停靠区容器内，该容器在线程滚动容器之外、文档顺序在输入框之前；
  停靠区容器与每张卡的 `title` 正文（经稳定钩子如 `data-slot` 定位）带有限高与内部滚动的样式声明；第一张卡的按钮不在 `title` 正文的滚动容器内。
- [x] 6.2 提问卡（design D7）：选中会话全部待决审批按 `id` 升序叠放；`role="group"` 名 `需要你的确认`；工具名徽章、`title` 全文、倒计时句（注入时钟；`n = max(0, ceil((expiresAt - now) / 1000))`，至少每秒重算一次）、`允许` / `拒绝`；
  各自以自己的 id 作答、点击后该张按钮立即禁用、卡头不做乐观改动；resolved 后消失。409 `approval_settled`：不显示错误，主动对账权威历史（同现状）。
  非 409 失败（400/404/502/503/网络）：信封文案（无信封时用主规格对这类错误的既有措辞）以 `role="alert"` 显示在该卡内，两个按钮恢复可用，下一次点击时清除。
  测试含：502 → 卡内出现 alert、按钮可用、再点成功、alert 消失。
- [x] 6.3 消息内已结算记录：`已允许执行` / `已拒绝执行` / `超时自动允许`，工具名徽章与 `title` 全文，无按钮无倒计时；位置按 D4 块次序。
- [x] 6.4 刷新恢复：待决 → 提问卡（倒计时从 `expiresAt`；刷新时 `expiresAt` 已过则显示 `（0s 内未操作将自动允许）`），已结算 → 记录；待决期间输入框锁定且 `停止` 可用。
- [x] 6.5 改写断言与 ui-walk：`chat-approval-bar.test.tsx` 按新位置改写（提问卡在消息 `article` 之外、已结算记录在其内）；`ui-walk-approval.ts` 改写：待决卡不在 `article[name=助手]` 内而在输入框上方，
  允许后消息内出现 `已允许执行` 记录，刷新后仍在。ui-walk 新增停靠区布局断言，只针对真实栈能产生的状态——首回合 bash 审批的那一张待决提问卡：
  在 390×844 与 1440×900 下，输入框与 `停止` 完整在视口内、线程可见高度不为零、页面无横向滚动、卡的 `允许` / `拒绝` 在视口内
  （多张卡与长 `title` 的极端状态由 6.1 的整页挂载结构测试覆盖，不新增受控上游标记；面板展开时的布局断言在 10.3）。
- [x] 6.6 删除 `approval-bar.tsx` 旧实现与 CSS、静态断言；登记已迁移文件；CH 行：审批提问卡位置、允许/拒绝、作答失败就地提示、并发两条、超时自动允许的记录、刷新保留、停靠区限高（结构）与一张待决卡时的布局。

Suggested fixture level: expanded - 审批是安全相关交互；位置从消息内移到输入框上方反转了两份规格条文与 ui-walk；并发审批、倒计时与作答失败有时序
Minimal mergeable slice: atomic - 待决卡离开消息与测试/ui-walk 的选择范围是同一次移动（已结算记录今天就在消息内，只是换实现）：待决卡移走而断言范围不改则全红，只改断言则无对象；旧 `approval-bar.tsx` 同时承载待决与已结算两种呈现，删除它（6.6）与 6.1-6.5 同刀

## 7. turn-artifacts — 文件变更卡、产物卡与产物面板

- [x] 7.1 文件变更卡：换到拷入层组件，位于工具调用组之外；行为场景不变。
- [ ] 7.2 产物卡：预览、复制、下载行为不变；在此拷入 `dialog`（首个消费者：html 产物预览），关闭预览后焦点回到预览按钮且线程不滚动；复制成功换图标 + `已复制` 状态；
  `文件过大，无法复制`、`复制失败`、下载/预览失败的信封文案就地 `role="alert"`。覆盖 ui-primitives「焦点归还不滚动」的既有断言若以 html 预览为对象，改以会话重命名对话框（仍是旧 `Dialog`）为对象。
- [ ] 7.3 产物面板：旧 `Drawer` 换为拷入层 `sheet`（可访问名、焦点与 Escape 行为按现规格）；无产物时照常打开并显示空态 `当前任务暂无产物`。
- [ ] 7.4 改写被打破的断言（按分片）：`ui-walk-sessions.spec.ts` 的 `.artifact-lang`、`iframe.artifact-preview-frame` 选择器改为角色/属性；
  单元测试 `chat-page-artifacts-panel`、`chat-page-file-changes`（766 行）、`chat-page-artifact-card`（778 行）——后两个只减不增，新用例进新文件；断言提示的测试改为就地呈现。
- [ ] 7.5 按分片退役：删除 `file-changes-card.tsx`、`artifact-card.tsx`、`artifacts-panel.tsx` 的旧实现与对应 CSS、静态断言；登记已迁移文件；CH 行：文件变更卡、产物卡预览/复制/下载、产物面板与空态。

Suggested fixture level: compact - 三个组件的换肤，行为规格不变；变化只有提示改就地与面板空态
Minimal mergeable slice: 7.1，自带 `file-changes-card.tsx` 旧实现与其 CSS 的删除、`chat-page-file-changes` 的读 CSS 断言改写——文件变更卡不带交互，可单独替换保绿；7.2 产物卡一刀（自带 `dialog` 拷入、`artifact-card.tsx` 退役、`chat-page-artifact-card` 与 `.artifact-lang` / `iframe.artifact-preview-frame` 改写）、7.3 产物面板一刀（自带 `artifacts-panel.tsx` 退役与 `chat-page-artifacts-panel` 改写；面板的空态改动与卡片无关）

## 8. conversation-search / chat-web — 对话内搜索与项目配置入口

- [ ] 8.1 对话内搜索：只做搜索框换肤（换到拷入层组件），位置与行为按 conversation-search；`data-message-id`、`aria-current` 高亮与 `scrollToMessage` 已在组 2 随线程迁移，这里不动。
- [ ] 8.2 项目配置入口：复用 7.2 拷入的 `dialog`；只读列表的标题、说明、分组与条目不变；`project-config.css` 的规则删除。
- [ ] 8.3 改写被打破的断言（按分片）：`ui-walk-sessions.spec.ts` 的 `.chat-search-count`；`ui-walk-project-config.ts` 的 `.chat-project-config-path`、`.ui-tag`；单元测试 `chat-page-search`（读 CSS / 旧类名的部分）、`chat-page-project-config`。
- [ ] 8.4 按分片退役：`topbar-actions.ts` 的描述符不变（`重命名` 仍来自会话列表动作）；删除 `conversation-search.tsx`、`project-config.tsx` 旧实现的 CSS 与静态断言；登记已迁移文件；CH 行：对话内搜索、项目配置入口。

Suggested fixture level: compact - 两个彼此独立的小组件换肤，行为规格不变
Minimal mergeable slice: 8.2，自带 `project-config.css` 规则删除与 `ui-walk-project-config.ts`、`chat-page-project-config` 的改写——项目配置入口不依赖线程，可先单独合入；8.1 搜索框换肤单独一刀，自带 `.chat-search-count` 与 `chat-page-search` 的改写及旧搜索框 CSS 的删除

## 9a. session-todo / chat-sessions / omp-test-harness — 任务清单后端：迁移、归一化与测试支撑

- [ ] 9a.1 迁移 `server/src/core/db/migrations/036_*.sql`：`chat_sessions` 加可空 `todo` 列；迁移测试（仿 `migration-034.test.ts`）。
- [ ] 9a.2 归一化（纯函数，新文件，仿 `file-changes.ts`）：结构校验、五种 `status`、`name` / `content` 截断 200 码点、总任务数上限 200、没有任务的阶段不输出、全空归一为 `null`、不下发 `blocker`；单元测试含不合规样本。
- [ ] 9a.3 测试支撑：`fake-omp.mjs` 增 `todo` 场景（工具结果带 `details.phases`；常量放进 `fake-omp-thinking.mjs`，入口文件已 799 行）；`fake-upstream.mjs` 增 `WORKBUDDY_TODO` 标记
  （与 `WORKBUDDY_WRITE` 同时出现时 `WORKBUDDY_WRITE` 优先）与 `fake-upstream-markers.test.ts` 用例。

Suggested fixture level: compact - 一个只加可空列的迁移、一个纯函数模块、两处测试支撑；没有公共契约变化（事件联合、快照、web 解析都不动）
Minimal mergeable slice: 9a.1——迁移与其测试自成一刀；9a.2 归一化模块（纯函数 + 单元测试）与 9a.3 测试支撑（标记用例）各自可独立合入。三者都是新增，不替换任何实现，无旧文件/断言要退役

## 9b. session-todo / chat-stream / chat-sessions / chat-web — 任务清单后端：事件、持久化、快照与 web 契约

- [ ] 9b.1 归约器候选：`events.ts#applyFrame` 在 `tool_execution_end` 且 `toolName === "todo"`、未失败时只产出 `details.phases` 原值候选（归约器不做 IO、不校验）。
- [ ] 9b.2 持久化路径：校验、归一化（9a.2）、去重（与上次落库值相同不发不写）、warn 与写入落在 `turn-control.ts` 的 `persistEvent` 与一个新的 store 模块（与 `store-metadata.ts` / `store-changes.ts` 并列）。
  `server/src/sessions/supervisor.ts`（800 行）与 `store.ts`（797 行）不得增长；warn sink 以注入方式提供，不给 `supervisor.ts` 加行。不合规候选丢弃并记一条 warn，不影响步骤事件与回合。
  写 `todo` 不改会话的 `updated_at`。
- [ ] 9b.3 事件：发布 `todo.updated{messageId, todo}`，位置紧邻该次工具调用的 `step.end` 之前；事件联合新增该类型。
- [ ] 9b.4 快照：`GET /api/sessions/:id/messages` 返回顶层 `todo`（四键）；分叉新会话为 `null`；重新生成不清空。
- [ ] 9b.5 web 契约（design Migration Plan）：`session-contract.ts` 的快照解析（`:303-304`）改为四键严格并校验 `todo` 结构；契约测试更新。此刻 web 只解析、不显示，`todo.updated` 按未知事件类型忽略。
- [ ] 9b.6 web 测试 fixture：三键快照字面量散在约 22 个 web 测试文件（45 处），在 fixture 构造点补 `todo: null`，尽量收敛到 support 文件（`chat-stream-support.ts`、`chat-page-*-support.*`）。
- [ ] 9b.7 服务端管线测试（用 9a.3 的 fake-omp 场景）：事件、落库、快照、SSE 续流、去重、不合规候选的 warn、`updated_at` 不变、分叉为 `null`。

Suggested fixture level: expanded - 事件联合与快照契约（web 严格解析）两处公共契约变化，持久化路径有顺序与去重；数据形状来自对 omp 二进制的反查
Minimal mergeable slice: atomic - 快照多出一个键会被 web 的三键严格解析拒绝，所以服务端快照字段、web 解析与 web fixture（9b.4 + 9b.5 + 9b.6）必须同刀；事件产出没有落库则刷新即丢，9b.1-9b.4 互为前提。这一刀自带它打破的全部 fixture 改写。验证路径单一：服务端管线测试 + 契约测试

## 10. session-todo / chat-web / chat-harness — 任务清单 web：归约与面板

- [ ] 10.1 归约：事件联合、解码与归约加入 `todo.updated`；`ChatState.todo`；快照安装时带入；未知回合的处理与其它事件一致。`stream.ts` 已 742 行，新增逻辑放进新的 `stream-*.ts` 文件。纯归约测试。
- [ ] 10.2 面板（design D10）：位于停靠区最上方；可见条件；头部按钮 `任务清单 <完成数>/<总数>`（`aria-expanded`，默认展开）；阶段与任务列表、状态标记与可访问文本；只读；
  展开状态按会话保存在内存；面板计入停靠区的最大高度（6.1）并在内部滚动；欢迎态不显示。
  整页挂载结构测试（jsdom，不作视口断言）：200 个任务的清单——200 个列表项都在面板的列表元素内，该列表带有限高与内部滚动的样式声明，头部按钮不在其滚动容器内；
  面板与三张待决提问卡（其中一张 `title` 为 50 行）并存时都在同一个停靠区容器内、面板在前，容器在线程滚动容器之外、文档顺序在输入框之前。
- [ ] 10.3 ui-walk：带 `WORKBUDDY_TODO` 的回合在真实 omp 下出现面板（位于输入框上方、审批提问卡之上），刷新后仍在；面板展开时（该回合不产生审批）在 390×844 与 1440×900 下断言布局：输入框与发送按钮完整在视口内、线程可见高度不为零、页面无横向滚动
  （200 个任务与「面板 + 多张提问卡」不是真实栈能产生的状态，由 10.2 的结构测试覆盖）。
  记录两个 project 下 sessions 旅程的实测时长写进 PR 描述；若逼近每个测试 30 s 的预算，带清单的回合拆进独立的 `test()`，并在同一 PR 调整 chat-harness delta 的「一条串行旅程」措辞
  （组 3、5 删掉等待提示消失的步骤已腾出预算）。
- [ ] 10.4 CH 行：任务清单出现与更新、收起/展开、刷新保留、全部完成后消失。

Suggested fixture level: expanded - 新的会话级状态进入归约与续流；面板与审批提问卡、输入框争夺纵向空间，需要真实浏览器证据
Minimal mergeable slice: 10.1——归约与纯归约测试先行一刀（新增状态，不替换任何实现，无旧文件/断言要退役）；随后 10.2-10.4 面板、ui-walk 与 CH 行一刀（面板、它的结构测试与 ui-walk 布局断言同刀）

## 11. chat-web / ui-foundation — 收尾

- [ ] 11.1 删除 `web/src/features/chat/messages.css`、`project-config.css` 与 `legacy.css` 中对应的 `@import`；`chat.css` 只留会话列表规则；
  `legacy.css` 的 `.chat-md` `revert` 规则删除（同一条选择器里的 `.files-md` 部分保留）；`conversation-view.tsx` 等已无引用的旧文件删除——`chat-composer.test.tsx` 读 `conversation-view.tsx` 源码的断言同刀改写。
- [ ] 11.2 ui-walk 核对：`web/e2e` 里除会话列表的选择器外，不再有会话页的 `.chat-*` / `.ui-*` 选择器（各组已随分片改写，这里只查残余并补漏）；视口矩阵无横向溢出、无 console error。
  `chat-page.test.tsx` 对「新建会话」按钮类名的断言属于会话列表，不改。
- [ ] 11.3 守卫：在 `ui-layering.test.ts` 加终态断言——`web/src/features/chat` 下除会话列表八个文件外的每个文件都在 `MIGRATED_AREAS`，该目录只剩 `chat.css` 一个 `.css`；
  加 `useToast` 的注入样本自检（已迁移文件里注入一条 `useToast` 导入时守卫报错）。在 `web/src` 与 `web/e2e` 搜索残留旧类名（`chat-md`、`chat-msg`、`chat-step`、`chat-transcript`、`chat-thread`、`thinking-`、`artifact-`）并清除。
- [ ] 11.4 包体：记录 `web/dist` 的 JS 总大小与 gzip 大小（对比重建前 598,483 字节），写进 PR 描述与 design 的 Open Questions 结论处。
- [ ] 11.5 CH 节通读：每条规格里用户可见的行为都有对应行，结论全部 `待签`；PR 描述列出待 owner 执行的真实端点验收步骤（一轮含审批与任务清单的回合、断线/刷新续流 F-CHAT-8 复测）——由 owner 执行，不是实现者的任务。

Suggested fixture level: compact - 删除已无引用的样式与文件、加终态守卫、记录数字；无新行为
Minimal mergeable slice: 11.1 + 11.3，含 `chat-composer.test.tsx` 的改写——旧 CSS 与旧文件删除同终态守卫同刀（删完守卫才成立，读被删源码的断言不改则红）；11.2 ui-walk 残余核对可单独一刀；11.4、11.5 是记录与验收步骤清单，不改代码
