## ADDED Requirements

### Requirement: 步骤 args 与输出分栏
客户端 SHALL 把步骤 `output` 作为与 `detail` 并列的字符串字段贯穿快照解析（`steps[]` 严格键集 `{id,ordinal,name,detail,output,status}`）、SSE `step.end` 解码（严格键集 `{messageId,stepId,status,output}`）、归约与呈现；缺 `output` 或多余字段仍整体拒绝。运行中步骤的 output 为空串。

#### Scenario: 旧行与失败步骤
- WHEN 快照含一条 output 为空串的 done 步骤（迁移前旧行），以及一条 detail 为 `{"command":"false"}`、output 为 `boom` 的 failed bash 步骤
- THEN 旧行只渲染 detail 块、无 output 块且不报错；失败卡徽章 `失败`、摘要行 `command: false`，`原始输出` 含 detail 块与内容为 `boom` 的 output 块

#### Scenario: 长输出不影响摘要
- WHEN step.end 带回一条超过 120 码点的多行 output
- THEN 摘要行仍由 detail 派生不变，output 块完整保留换行


## MODIFIED Requirements

### Requirement: API 客户端扩展
`ApiClient` SHALL 提供 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，分别返回类型化的会话列表、会话、完整消息快照和接受回合的消息 ID。四方法 SHALL 使用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制；GET SHALL 禁止缓存，路径 ID SHALL 编码。成功状态 SHALL 分别为 200、201、200、202；新建会话不发送 body，prompt SHALL 原样发送 JSON `{message}`。
返回对象 SHALL 按公开 DTO 严格校验，不接受缺字段、多字段、错误枚举或非安全整数；消息时间戳和消息/步骤 ID SHALL 允许有符号安全整数，session 时间戳、epoch、非 null seq 和 ordinal SHALL 非负。`getMessages` SHALL 保留完整正文、步骤（含字符串 `output`）、顺序和 `streamCursor:{epoch:number,seq:number|null}`，不得截断、过滤、规范化文本或将 null/缺失游标默认成 0。409/502 SHALL 保留 `ApiError` 的 status/code/message；非法响应和网络异常 SHALL 使用既有不泄露响应内容的 request_failed 错误。

#### Scenario: 四方法请求与响应
- WHEN 调用四方法并收到服务端对应成功响应
- THEN 路径、HTTP 方法、body、凭证、signal、状态与类型化返回值符合上述合同，原始 prompt 文本和历史正文不变

#### Scenario: 完整快照边界
- WHEN 快照包含 NUL/BOM/Unicode 正文、零 ordinal、有符号消息时间戳和 `{epoch:1,seq:null}` 或 `{epoch:1,seq:0}`
- THEN 完整历史与游标逐值保留；缺失游标、非法嵌套项或额外私有字段则整体拒绝

#### Scenario: 信封和未登录
- WHEN prompt 返回 409 session_busy 或 502 agent_unavailable，或任一方法返回 401
- THEN 409/502 保留 code/message；401 无论合法、畸形或非 JSON 都沿用既有未登录通知，通知回调抛错不替代请求错误

#### Scenario: 原有客户端不回归
- WHEN 原有认证、工作空间、预览、审计 API 在共享校验抽取后运行
- THEN 既有成功形状、严格拒绝规则、signed workspace 时间戳、错误保密与预览资源生命周期不变


### Requirement: 纯会话视图归约
`chatStateFromSnapshot` SHALL 从完整消息快照生成有序聊天视图，不编造 SSE 缺失的时间戳或 ordinal。`applyChatEvent(state,event)` SHALL 为确定性的纯函数，只复制改变的分支、不修改输入；未知事件类型 SHALL 保持原状态。
归约器 SHALL 处理服务端六类事件：turn.start 重置对应 assistant 正文/步骤/错误并置 running；text.delta 原样追加；step.start 按 messageId 内的 stepId 新建 running 步骤且不重复；step.end 更新已有步骤的状态和 output，detail 保持 step.start 或快照中的值不变；error 将对应 assistant 标记 failed 并保存原始文案，但会话保持 running 等待 turn.end；turn.end 将消息、会话和仍 running 的步骤置为其 done/failed 状态。不存在的 assistant 可按消息事件补建；不得重写 user 消息。未知 step.end 不得编造缺失的步骤名称。没有先前 turn.start 或 error 的终态 SHALL 有效。

#### Scenario: 流式归约与重置
- WHEN 对初始状态应用 turn.start、step.start(bash)、text.delta×3、step.end(done,output)、turn.end(done)
- THEN 得到完整正文、一条 detail 仍为 start 值且带该 output 的 done bash 步骤和 done 状态，输入及未改分支不被修改
- WHEN 再次对该 assistant 应用 turn.start
- THEN 仅该消息正文、步骤、错误清空并回到 running

#### Scenario: 无 start 的合法终态与失败
- WHEN 接收本地完成回合的单独 turn.end(done)，或 agent_start 之前的 error 然后 turn.end(failed)
- THEN 对应 assistant 视图存在并进入正确终态；错误文案原样保留，error 本身不提前结束会话生成状态
- WHEN 快照已有步骤随后收到 step.end
- THEN 更新同一 messageId/stepId 的步骤而不是重复创建


### Requirement: 会话页
`/` SHALL render the account-owned session list, new-session action, message area and labeled composer. The page-level level-1 heading follows spa-shell: in welcome state it is the hero `WorkBuddy，我帮你` rendered by the chat page (replacing the former empty-selection copy); with a selected session it is the topbar breadcrumb container (accessible name `我的工作 / <title>`), the title being reported by the chat page via `useTopbar({ breadcrumb: sessionTitle(selected) })` as soon as the selected session is known and cleared when none is selected or the page unmounts; the page SHALL NOT render its own page-level `<h1>` (headings inside rendered Markdown are content, not page headings). List SHALL retain server updatedAt-descending order and show server title or `新会话` plus a status element (`role="status"`, accessible name `<title> 运行中|已完成|失败`, visible dot with `running` pulsing via `ui-pulse`, visually-hidden text `运行中|已完成|失败`; a session whose server status is `idle` uses `未开始` in the same positions). Selection/new SHALL update `?session=<id>` while preserving unrelated search/hash; refresh and Back SHALL restore the selected session. Missing selection (no `?session=`) or an inaccessible target that has been replace-removed SHALL show the welcome state (hero `WorkBuddy，我帮你`) and composer, never auto-select first session; a selected session whose history is pending or failed renders neither hero nor a page-level heading of its own (the breadcrumb owns it). An inaccessible initial GET404 SHALL replace-remove the session parameter and SHALL NOT open EventSource; other errors SHALL remain visible without displaying another session's history.
**Welcome state** (demo:2537-2567) SHALL show hero `WorkBuddy，我帮你`, one row of quick chips (static list ported from demo `QUICK_PROMPTS` for the default 日常办公 scene only; scene pills themselves belong to S1c and are not rendered), the composer card, a `不知道做什么，试试最佳实践案例` section with five static playbook cards (ported from demo `PLAYBOOKS`, demo:2553-2561) and a `换一批` action that rotates within the static set (`查看更多` is not rendered because its target `/center` is undelivered), and the disclaimer `内容由 AI 生成，请核实重要信息`. Clicking a chip or card SHALL only fill the composer draft, never send. While the composer is locked (from submit through the running turn), chips, cards and `换一批` SHALL be disabled so a pick cannot overwrite the draft that a failed create restores.
**Messages** (demo:2378-2406) SHALL render user messages as right-aligned bubbles that preserve complete text and whitespace (`white-space: pre-wrap`, safe rendering) and assistant messages as left-aligned plain blocks with an assistant avatar mark (`BrandMark`, decorative); assistant text SHALL be rendered through the shared safe Markdown renderer (`web/src/lib/md-render.ts`, relocated from the files feature with its provenance header intact; source HTML is escaped and never injected), with visible text following Markdown semantics (markup consumed, link destinations dropped), and a running assistant SHALL show a blinking caret (`ui-caret`) after the last character. Each assistant message that is no longer running and has non-empty text SHALL end with an action row holding a single icon button (`Icon copy`, decorative) whose accessible name and tooltip are `复制`; running messages, empty assistant text and user messages render no action row. Clicking it SHALL copy the raw message text (Markdown source, not the rendered text) via `navigator.clipboard.writeText` and show a `Toast` `已复制到剪贴板`; when the clipboard API is unavailable, throws or rejects, a `Toast` `复制失败` is shown instead and no exception or rejection escapes. Regenerate/like/dislike belong to S1c or are dropped.
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
- THEN `≥761px` 无顶栏（`≤760px` 顶栏只含 `打开导航`），页面 level-1 heading 为 hero `WorkBuddy，我帮你`；快捷 chip 行、composer 卡、五张卡片（取自静态七项清单）与免责声明可见，无场景胶囊/附件/模型/麦克风控件；点击卡片后输入框草稿等于卡片 prompt 且未发送；`换一批` 后五张卡片集合改变且仍来自静态清单

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


### Requirement: 步骤卡原始输出不做路径改写
按 ADR-0011，步骤卡 `原始输出` 内的完整 detail 与 output SHALL 原样展示其中出现的绝对沙箱路径，不做前缀替换、隐藏或其它改写；摘要行派生、120 码点截断与折叠默认状态不受影响。files 页、外壳、标题与 aria 属性不渲染 workspace `root` 的呈现规则不因此放宽。

#### Scenario: 含沙箱路径的 detail 原样出现在原始输出
- **WHEN** 会话页渲染一张 detail 为 `{"path":"<SANDBOX_ROOT>/<ownerId>/<dir>/a.md"}` 形态的 done 步骤
- **THEN** 该卡 `原始输出` 的 `<details>` 内文本包含该绝对路径原文，摘要行为 `path: <该路径>`

#### Scenario: 含沙箱路径的 output 原样出现在原始输出
- **WHEN** 会话页渲染一张 output 含 `<SANDBOX_ROOT>/<ownerId>/<dir>/a.md` 形态绝对路径的 done 步骤
- **THEN** 该卡 `原始输出` 的 output 块包含该路径原文
