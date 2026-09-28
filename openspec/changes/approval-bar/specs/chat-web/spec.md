# Spec delta: chat-web（#480 审批条）

> 「会话页」由多个 issue 分担（父 delta 为 MODIFIED）。本 delta 以主 spec 现文为底，只并入本 issue（父 tasks 7.4）交付的部分：
> - 在 **Messages** 段与 **Step cards** 段之间插入父 delta 的 **Approval bar** 段，逐字，只裁一处：末句「so the composer stays locked and the `停止` button is available」去掉「and the `停止` button is available」。composer 上的 `停止` 按钮归 7.2 #477，本 issue 不依赖它、master 上也还没有这个按钮。
> - 在「复制助手原文」之后追加父 delta 的三个审批 Scenario，标题逐字。「审批条挂起、允许与拒绝」首个 THEN 的「composer 仍锁定且 `停止` 可用」裁为「composer 仍锁定」，裁掉的部分同样归 #477。
> - #477 与 #480 谁后归档，谁就以已推进的主 spec 为底，按父 delta 原文恢复这两处 `停止` 子句。
> - 本块携带的是当前主 spec 的「会话页」全文。若 #477/#478/#479 中任一先归档，#480 归档前须以当时已推进的主 spec 为底重新生成整块：插入 Approval bar 段，追加三个审批 Scenario。不能直接沿用本块，否则会覆盖先归档者的文本。
> - 父 delta 中「会话页」的其余改动留在主 spec 原文不动，各归其 issue：列表/步骤徽章的 `已停止`、stopped 徽章与占位、Composer 的 `停止` 按钮、业务错误与 503 文案归 7.2 #477；`重新生成` 归 7.3a #478；`从此处分叉` 归 7.3b #479。对应 Scenario 也由这些 issue 追加：「停止生成」「助手消息级已停止呈现」「容量已满内联提示」归 #477（prompt 部分）与 #478（regenerate 部分），「重新生成末条回答」归 #478，「从此处分叉」归 #479。

## MODIFIED Requirements

### Requirement: 会话页
`/` SHALL render the message area and labeled composer as a single full-width column in `main`, and SHALL own the account-owned session list and new-session action, which it renders into the shell sidebar's list area (spa-shell `路由 IA 与侧栏`) through the shell-provided slot and never inside `main`; the page keeps all list data, selection, creation and ownership fences, and the list behavior specified here is unchanged by its location. The page-level level-1 heading follows spa-shell: in welcome state it is the hero `WorkBuddy，我帮你` rendered by the chat page (replacing the former empty-selection copy); with a selected session it is the topbar breadcrumb container (accessible name `我的工作 / <title>`), the title being reported by the chat page via `useTopbar({ breadcrumb: sessionTitle(selected) })` as soon as the selected session is known and cleared when none is selected or the page unmounts; the page SHALL NOT render its own page-level `<h1>` (headings inside rendered Markdown are content, not page headings). List SHALL retain server updatedAt-descending order and show server title or `新会话` plus a status element (`role="status"`, accessible name `<title> 运行中|已完成|失败`, visible dot with `running` pulsing via `ui-pulse`, visually-hidden text `运行中|已完成|失败`; a session whose server status is `idle` uses `未开始` in the same positions). Selection/new SHALL update `?session=<id>` while preserving unrelated search/hash; refresh and Back SHALL restore the selected session. Missing selection (no `?session=`) or an inaccessible target that has been replace-removed SHALL show the welcome state (hero `WorkBuddy，我帮你`) and composer, never auto-select first session; a selected session whose history is pending or failed renders neither hero nor a page-level heading of its own (the breadcrumb owns it). An inaccessible initial GET404 SHALL replace-remove the session parameter and SHALL NOT open EventSource; other errors SHALL remain visible without displaying another session's history.
**Welcome state** (demo:2537-2567) SHALL show hero `WorkBuddy，我帮你`, one row of quick chips (static list ported from demo `QUICK_PROMPTS` for the default 日常办公 scene only; scene pills themselves belong to S1c and are not rendered), the composer card, a `不知道做什么，试试最佳实践案例` section with five static playbook cards (ported from demo `PLAYBOOKS`, demo:2553-2561) and a `换一批` action that rotates within the static set (`查看更多` is not rendered because its target `/center` is undelivered), and the disclaimer `内容由 AI 生成，请核实重要信息`. At `≥761px` the five cards SHALL sit in one row without wrapping (demo:408-409: cards share the row equally with `min-width: 0` and at most `220px` each); at `≤760px` the row MAY wrap; at 1440×900, 1024×768 and 390×844 the disclaimer SHALL lie inside the first viewport of the welcome state. Clicking a chip or card SHALL only fill the composer draft, never send. While the composer is locked (from submit through the running turn), chips, cards and `换一批` SHALL be disabled so a pick cannot overwrite the draft that a failed create restores.
**Messages** (demo:2378-2406) SHALL render user messages as right-aligned bubbles that preserve complete text and whitespace (`white-space: pre-wrap`, safe rendering) and assistant messages as left-aligned plain blocks with an assistant avatar mark (`BrandMark`, decorative); assistant text SHALL be rendered through the shared safe Markdown renderer (`web/src/lib/md-render.ts`, relocated from the files feature with its provenance header intact; source HTML is escaped and never injected), with visible text following Markdown semantics (markup consumed, link destinations dropped), and a running assistant SHALL show a blinking caret (`ui-caret`) after the last character. Each assistant message that is no longer running and has non-empty text SHALL end with an action row holding a single icon button (`Icon copy`, decorative) whose accessible name and tooltip are `复制`; running messages, empty assistant text and user messages render no action row. Clicking it SHALL copy the raw message text (Markdown source, not the rendered text) via `navigator.clipboard.writeText` and show a `Toast` `已复制到剪贴板`; when the clipboard API is unavailable, throws or rejects, a `Toast` `复制失败` is shown instead and no exception or rejection escapes. Regenerate/like/dislike belong to S1c or are dropped.
**Approval bar** (demo:2407-2418) SHALL render inside an assistant message directly above its text, **one bar per entry of the message `approvals`**, stacked vertically in ascending `id` order (none when `approvals` is `[]`); each bar is its own `role="group"` region named by its header, and each bar is keyed and answered by its own `approval.id` independently of the others (several bars may share the same header name; tests disambiguate them by document order, which equals id order). Every bar shows a header, a tool badge and a body: the tool badge text is the approval `tool` field, i.e. the tool name the server parsed from the first line of `title` (`Allow tool: <name>`; `unknown` when unparseable — the web does not re-parse), and the body is the **full** `title` text (all lines, including the first) rendered as text with `white-space: pre-wrap`. Pending (`decision === null`): header `需要你的确认` (with `Icon shield`), below the body a single dynamic countdown sentence `（<n>s 内未操作将自动允许）` where `n = max(0, ceil((expiresAt - now)/1000))` is the remaining whole seconds (initially `60` for a fresh request), recomputed at least once per second from the injected clock — there is no separate static `60s` sentence and no second countdown element — and two buttons `允许`/`拒绝`. Clicking either SHALL call `decideApproval(sessionId, approval.id, "allow"|"deny")` exactly once and disable both buttons of that bar only; the bar SHALL NOT change its header optimistically but re-render from the `approval.resolved` event for its id or the next authoritative snapshot. Settled: `decision` `allow` or `timeout` → header `已允许执行`, `deny` → header `已拒绝执行`; no buttons, no countdown sentence, tool badge and full `title` body kept. A 409 `approval_settled` response SHALL show no error toast and no inline error: the page reconciles authoritative history so the bar renders the server decision. Other envelopes display inline on the composer. The approval bar SHALL render identically from a reloaded snapshot: a pending approval after reload remains answerable with the countdown sentence derived from the snapshot `expiresAt` (e.g. `（40s 内未操作将自动允许）` when 40s remain); a settled approval shows its final header. While any approval is pending the turn is still running, so the composer stays locked.
**Step cards** (demo:2218-2242) SHALL show a header (`Icon terminal` for `bash`, `Icon wrench` otherwise, step name, and a status badge with `role="status"`, visible text `运行中|已完成|失败` mapped from running/done/failed and accessible name `<step name> 运行中|已完成|失败`) and a one-line summary derived from detail: for JSON object detail the non-blank `text` string, else the non-blank `content` string, or else the first key/value rendered as `<key>: <value>` (non-string values JSON-encoded); for any other detail (non-JSON, or JSON that is not an object) the first non-empty line; the summary is that value's first non-empty line, trimmed; empty detail yields an empty summary; all truncated to 120 code points; the summary SHALL come from `detail` (the tool args) only and SHALL NOT change when the step ends; the complete `detail` and, when non-empty, the step `output` (the tool result text, or the error text of a failed step) SHALL stay available behind a collapsed `<details>` `原始输出` (collapsed by default, not open) as two separate blocks, args first; a step whose detail and output are both empty renders no `原始输出`. No fabricated time or todo state. A `回到最新` floating button (`Icon chevron-down` plus the text, rendered only while a session is selected and absent otherwise, never a disabled placeholder) SHALL appear when the transcript is scrolled more than one viewport (`clientHeight`) above the bottom, including when new content grows that distance while the user is away from the bottom; once shown it SHALL stay until the transcript reaches the bottom (within 4px) or the button is clicked; clicking SHALL scroll the transcript to the bottom and hide the button. New content SHALL auto-scroll the transcript to the bottom only when the transcript was at the bottom (within 4px) before the update or the user has just clicked `回到最新`; while the user is scrolled up, new content SHALL NOT change the scroll position. Opening or switching to a session SHALL start at the bottom.
**Composer card** (demo:2576-2603) SHALL be a bordered card containing the labeled multi-line textarea (placeholder `今天帮你做些什么` in welcome state, `继续追问，或派一个新任务…` with a selected session) and a bottom toolbar whose only control is the send button (`Icon send`, aria-label `发送`; while a turn is running the button is disabled with aria-label `生成中` and the toolbar shows a `role="status"` element with text `生成中`); attachment, model switcher, microphone, stop and workspace/permission footer are NOT rendered until their owning stages. The hint `Enter 发送 · Shift+Enter 换行` SHALL remain.
Page SHALL derive its API client from the current auth session, load complete history before opening EventSource, seed the exact snapshot cursor, and use existing pure reducer/connector. All callbacks SHALL be synchronous. Account renewal, session selection, unmount and successful/current401 logout SHALL abort/fence page requests and close the old connection; late responses and ignored-abort loads SHALL NOT mutate UI, navigate or open sources. Pending/failed logout SHALL preserve canonical authenticated behavior.
A user send with no session SHALL create once, select its returned ID and prompt that session once. Empty-whitespace sends SHALL be disabled, and duplicate submits SHALL NOT create concurrent turns. User-initiated navigation SHALL invalidate stale mutation continuations; the create-send operation's own URL handoff SHALL NOT lose its prompt. After successful acceptance the page SHALL reconcile authoritative history and reconnect from that snapshot, without appending duplicate rows or demoting an already finished turn. Failed502 SHALL NOT introduce speculative messages. Session title/order SHALL refresh from server, not duplicate server truncation logic.
Business errors SHALL display inline on the message;409/502 SHALL display envelope message. Composer SHALL be disabled from submit through running turn until terminal authoritative state, with `生成中` on the send button. Current401 SHALL hand off to login. Terminal connector failure SHALL expose a safe error and refresh guidance, preserve last history, and not invent completion or automatically retry; a still-running authoritative status remains locked until reloaded.

#### Scenario: 输入框键盘发送
- WHEN 可发送的草稿在输入框收到无修饰的 Enter
- THEN 通过同一表单受理路径发送一次原始草稿；Shift+Enter 保留换行，输入法 composing 或确认键码229不发送，长按重复Enter不新增提交；空草稿及生成中仍不可发送

#### Scenario: Once-only create and streaming conversation
- WHEN an empty page user sends `你好` and the accepted turn emits start, step start/end, three deltas and done
- THEN exactly one session and prompt are created, URL selects that ID, user and assistant appear in server order without duplicates, text grows, step status/output changes, server title appears and composer unlocks at done

#### Scenario: Completed before acceptance response
- WHEN SSE turn.end arrives before prompt202 resolves and subsequent history reports the completed turn
- THEN acceptance reconciliation preserves one user/assistant pair and final content/status, never re-locks completed state or appends the user after the assistant

#### Scenario: Deep-link snapshot and covered replay
- WHEN `/?session=<id>` loads a running snapshot and EventSource opens with covered start/step/text and newer frames
- THEN snapshot GET completes before source construction, covered frames never erase/duplicate history, only successors append, and list selection matches the URL

#### Scenario: Selection and stale operation isolation
- WHEN a history/create/prompt/recovery request ignoring abort completes after user selects another session, navigates away or renews authentication
- THEN the old source is closed, owned signals are aborted and stale completion cannot install history, alter current errors, navigate, dispatch another prompt or create a source

#### Scenario: Inaccessible and empty targets
- WHEN no session is selected or initial history returns404 for an unknown/foreign ID
- THEN the page shows the welcome state (hero `WorkBuddy，我帮你`) and composer, no first-session fallback and no source for the inaccessible target; invalid query removal preserves other search/hash

#### Scenario: Error and stream ownership
- WHEN prompt rejects409/502, named business error arrives, or connector terminates while last snapshot is running
- THEN exact API/business messages are visible,502 introduces no speculative rows, connector failure gives safe refresh guidance without false terminal state, and temporary native reconnect errors do not become business failures

#### Scenario: Logout and page compatibility
- WHEN confirmed logout succeeds/current401 clears auth, or page unmounts under StrictMode
- THEN owned source/request lifecycles close without late UI writes or unhandled rejection; failed logout preserves authenticated page, and routes/main/settings-footer fixtures still exercise honest successful root loading

#### Scenario: 欢迎态与静态引导
- WHEN 已登录无 `?session=` 打开 `/`，点击一张最佳实践卡，再点击 `换一批`
- THEN `≥761px` 无顶栏（`≤760px` 顶栏只含 `打开导航`），页面 level-1 heading 为 hero `WorkBuddy，我帮你`；快捷 chip 行、composer 卡、五张卡片（取自静态七项清单）与免责声明可见，无场景胶囊/附件/模型/麦克风控件；点击卡片后输入框草稿等于卡片 prompt 且未发送；`换一批` 后五张卡片集合改变且仍来自静态清单；1440×900、1024×768 与 390×844 下免责声明位于首屏内，`≥761px` 五张卡片同行（`offsetTop` 相同），`main` 内无会话列表与 `新建会话`

#### Scenario: 消息呈现与流式光标
- WHEN 一次回合的快照包含多行用户消息与含 Markdown（标题 + 代码块 + 源 HTML）的助手正文，先处于 running、随后收到 `turn.end` done
- THEN 用户消息为右侧气泡且多行文本换行与前导空白保留；助手块带装饰性 `BrandMark` 头像，正文渲染出 heading 与 code 元素，源 HTML 作为文本出现、不生成对应元素；running 时正文容器末尾存在 `ui-caret`，done 后消失

#### Scenario: 步骤卡呈现
- WHEN 回合快照含 detail 为 `{"command":"echo workbuddy-smoke"}` 的 running `bash` 步骤与一条非 bash 步骤，随后 bash 步骤以 output `workbuddy-smoke` 结束为 done
- THEN bash 卡头为 `terminal` 图标、`bash` 与徽章 `运行中`（`role=status` 名 `bash 运行中`），摘要行为 `command: echo workbuddy-smoke`；结束后徽章为 `已完成`（名 `bash 已完成`）、摘要行仍为 `command: echo workbuddy-smoke`；非 bash 卡头为 `wrench` 图标；`原始输出` 的 `<details>` 未展开且内含完整 detail 块与内容为 `workbuddy-smoke` 的 output 块

#### Scenario: 回到最新
- WHEN 长历史会话打开后，用户上滚超过一屏，随后新 delta 到达；再点击 `回到最新`，之后又有新 delta 到达
- THEN 打开时位于底部且无按钮；上滚期间新 delta 不改变滚动位置且按钮可见；点击后滚到底部、按钮消失；之后的新 delta 保持自动跟随到底部；欢迎态不渲染该按钮

#### Scenario: 复制助手原文
- WHEN 一次已完成回合的助手正文为含 Markdown 标记的原文，点击该助手消息的 `复制`；再分别在剪贴板 API 缺失、`writeText` reject 时点击
- THEN 剪贴板写入恰为该条助手的原始 Markdown 文本并出现 Toast `已复制到剪贴板`；API 缺失或 reject 时出现 Toast `复制失败` 且无未捕获异常；running 助手、空正文助手与用户消息均无 `复制` 按钮

#### Scenario: 审批条挂起、允许与拒绝
- **WHEN** running 助手消息收到 `approval.request{approvalId, tool:"bash", title:"Allow tool: bash\nReason: run ls", expiresAt: now+60s}`
- **THEN** 该消息内出现名为 `需要你的确认` 的审批条，工具名徽章为 `bash`，正文为 title 全文（两行均在，换行按 `white-space: pre-wrap` 保留），倒计时句为 `（60s 内未操作将自动允许）` 且随注入时钟推进 1s 后变为 `（59s 内未操作将自动允许）`，条内无其它倒计时元素，按钮 `允许`/`拒绝` 可用；composer 仍锁定
- **WHEN** 点击 `允许`，服务端 200，随后收到 `approval.resolved{decision:"allow"}`
- **THEN** `decideApproval(sessionId, approvalId, "allow")` 恰调用一次，两按钮立即禁用，resolved 到达后头部为 `已允许执行`、无按钮无倒计时句，工具名徽章与 title 全文保留
- **WHEN** 另一条挂起审批点击 `拒绝` 并收到 `approval.resolved{decision:"deny"}`
- **THEN** 头部为 `已拒绝执行`
- **WHEN** 点击 `允许` 时服务端返回 409 `approval_settled`，随后权威快照中该审批 `decision:"timeout"`
- **THEN** 无错误 Toast、composer 无内联错误，审批条按快照重渲染为 `已允许执行`

#### Scenario: 同一消息两条并行审批分别作答
- **WHEN** running 助手消息先后收到 `approval.request{approvalId:7, tool:"bash"}` 与 `approval.request{approvalId:8, tool:"bash"}`（均 pending），用户先点 id 8 审批条的 `拒绝`、再点 id 7 审批条的 `允许`，服务端各返回 200，随后依次收到 `approval.resolved{approvalId:8, decision:"deny"}` 与 `approval.resolved{approvalId:7, decision:"allow"}`
- **THEN** 该消息内按文档顺序纵向排列两个名为 `需要你的确认` 的审批条（第一个为 id 7、第二个为 id 8），第二个 request 未替换第一个；点 id 8 的 `拒绝` 只以 `decideApproval(sessionId, 8, "deny")` 调用一次并只禁用 id 8 的两按钮，id 7 的按钮仍可用、倒计时句仍在；id 8 resolved 后仅第二个条为 `已拒绝执行`、第一个仍为 `需要你的确认`，composer 仍锁定；id 7 作答并 resolved 后第一个条为 `已允许执行`，两条均无按钮

#### Scenario: 刷新后审批状态保留
- **WHEN** 以 `/?session=<id>` 重新加载：快照中一条助手消息 `approvals` 含一条 pending 且 `expiresAt` 距今 40s，另一次加载中一条助手消息的审批 `decision` 为 `timeout`、另一条助手消息的为 `deny`
- **THEN** pending 加载后审批条头部 `需要你的确认`、倒计时句为 `（40s 内未操作将自动允许）`、按钮可点并能作答；`timeout` 渲染为 `已允许执行`，`deny` 渲染为 `已拒绝执行`，均无按钮与倒计时句；`approvals` 为 `[]` 的助手消息不渲染审批条

