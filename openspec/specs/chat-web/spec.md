# chat-web Specification

## Purpose
定义浏览器会话页、API 客户端、纯事件归约与有界 SSE 快照恢复：完整正文和步骤呈现、查询选择、严格响应/事件校验、账号与操作所有权、错误归属及关闭治理。
## Requirements
### Requirement: API 客户端扩展
`ApiClient` SHALL 提供 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，分别返回类型化的会话列表、会话、完整消息快照和接受回合的消息 ID。四方法 SHALL 使用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制；GET SHALL 禁止缓存，路径 ID SHALL 编码。成功状态 SHALL 分别为 200、201、200、202；新建会话不发送 body，prompt SHALL 原样发送 JSON `{message}`。
返回对象 SHALL 按公开 DTO 严格校验，不接受缺字段、多字段、错误枚举或非安全整数；消息时间戳和消息/步骤 ID SHALL 允许有符号安全整数，session 时间戳、epoch、非 null seq 和 ordinal SHALL 非负。`getMessages` SHALL 保留完整正文、步骤、顺序和 `streamCursor:{epoch:number,seq:number|null}`，不得截断、过滤、规范化文本或将 null/缺失游标默认成 0。409/502 SHALL 保留 `ApiError` 的 status/code/message；非法响应和网络异常 SHALL 使用既有不泄露响应内容的 request_failed 错误。

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
归约器 SHALL 处理服务端六类事件：turn.start 重置对应 assistant 正文/步骤/错误并置 running；text.delta 原样追加；step.start 按 messageId 内的 stepId 新建 running 步骤且不重复；step.end 更新已有步骤状态和 detail；error 将对应 assistant 标记 failed 并保存原始文案，但会话保持 running 等待 turn.end；turn.end 将消息、会话和仍 running 的步骤置为其 done/failed 状态。不存在的 assistant 可按消息事件补建；不得重写 user 消息。未知 step.end 不得编造缺失的步骤名称。没有先前 turn.start 或 error 的终态 SHALL 有效。

#### Scenario: 流式归约与重置
- WHEN 对初始状态应用 turn.start、step.start(bash)、text.delta×3、step.end(done,detail)、turn.end(done)
- THEN 得到完整正文、一条 done bash 步骤和 done 状态，输入及未改分支不被修改
- WHEN 再次对该 assistant 应用 turn.start
- THEN 仅该消息正文、步骤、错误清空并回到 running

#### Scenario: 无 start 的合法终态与失败
- WHEN 接收本地完成回合的单独 turn.end(done)，或 agent_start 之前的 error 然后 turn.end(failed)
- THEN 对应 assistant 视图存在并进入正确终态；错误文案原样保留，error 本身不提前结束会话生成状态
- WHEN 快照已有步骤随后收到 step.end
- THEN 更新同一 messageId/stepId 的步骤而不是重复创建

### Requirement: 事件流消费与续流
`connectSessionEvents` SHALL 使用注入的 EventSourceCtor 建立编码 sessionId 的同源 events URL，并设置 withCredentials:true。调用方先取得初始完整快照并传入 initialCursor；连接器 SHALL 提供 close，并通过 loadSnapshot(signal)、同步 onSnapshot/onEvent、可选 onGap 和 onError 管理恢复与错误。API 方法和页面由其他模块拥有。
连接器 SHALL 从命名 MessageEvent 的 data 解码负载、从 lastEventId 读取 canonical 安全整数 epoch:seq；六类数据事件均经过同一游标过滤。原生传输 error 不得被当作业务 error：CONNECTING 时保留状态并交给原生自动重连，CLOSED 时关闭并报告，不推断 HTTP 状态。已知事件的非法 payload/id SHALL 触发重新同步，未知事件类型忽略。
每次 open（含首次连接和自动重连）、replay.gap 或1000条待处理数据队列溢出 SHALL 开启新的完整快照恢复；gap 额外调用 onGap。恢复期间排队，并以 generation/AbortController 使旧加载失效；只有仍有效且属于当前会话、未倒退的快照可安装。安装后丢弃旧 epoch，同 epoch 的 seq:null 覆盖整代，否则丢弃 seq≤边界，仅按到达顺序消费后继；已经成功交付的 watermark 继续去重。过滤包含 turn.start，不能清空已覆盖快照。
再次 gap/溢出 SHALL 废弃旧队列并重新同步，不以截断后继续消费替代恢复。同步回调重入时仍须保持先后次序，并在关闭/替代后停止旧 drain。loadSnapshot 失败或消费者回调违反同步合同 SHALL 关闭并报告，不能留下未处理拒绝、失效安装或继续追加；不新增自动重试策略。close SHALL 幂等关闭底层源、移除监听、abort加载并使所有迟到结果失效。切换/卸载/未登录由页面生命周期调用 close。

#### Scenario: 首次订阅窗口补齐
- WHEN 初始 REST 快照是 running/1:1，而回合在首次订阅前完成为 done/X/1:3，服务端 fresh 订阅不回放
- THEN open 后的完整快照同步仍安装 done/X/1:3，不停留在旧 running 状态

#### Scenario: 精确缺口重载
- WHEN gap 重载快照为2048字符和游标1:1002，期间排队1048字符 delta(1:1002)、旧 turn.start 以及 Z(1:1003)
- THEN 安装快照后仅追加 Z，正文恰2049字符，旧 turn.start 不清空历史
- WHEN 快照游标为 epoch1/seq:null，队列有 epoch1 尾帧及 epoch2 数据
- THEN 丢弃全部 epoch1，仅按到达顺序消费 epoch2

#### Scenario: 恢复所有权与队列边界
- WHEN 加载期间再次 gap 或队列超过1000条，然后旧加载最后才完成
- THEN 旧加载已 abort/失效，其结果不能安装；新快照及其后继负责恢复，不静默丢数据
- WHEN close、切换或未登录后加载完成，或回调重入关闭当前连接
- THEN 无迟到安装/交付，底层 EventSource 只关闭一次，队列和加载资源释放

#### Scenario: 命名错误与原生自动续连
- WHEN 先收到业务 event:error MessageEvent，再收到普通网络 error Event 和自动 reconnect/open
- THEN 仅业务帧改变 assistant 错误文案；网络错误不伪造生成失败，重连由原生 EventSource 携带 Last-Event-ID，open/必要 gap 同步恢复完整视图

### Requirement: 会话页
`/` SHALL render the account-owned session list, new-session action, message area and labeled composer. The page-level level-1 heading follows spa-shell: in welcome state it is the hero `WorkBuddy，我帮你` rendered by the chat page (replacing the former empty-selection copy); with a selected session it is the topbar breadcrumb container (accessible name `我的工作 / <title>`), the title being reported by the chat page via `useTopbar({ breadcrumb: sessionTitle(selected) })` as soon as the selected session is known and cleared when none is selected or the page unmounts; the page SHALL NOT render its own page-level `<h1>` (headings inside rendered Markdown are content, not page headings). List SHALL retain server updatedAt-descending order and show server title or `新会话` plus a status element (`role="status"`, accessible name `<title> 运行中|已完成|失败`, visible dot with `running` pulsing via `ui-pulse`, visually-hidden text `运行中|已完成|失败`; a session whose server status is `idle` uses `未开始` in the same positions). Selection/new SHALL update `?session=<id>` while preserving unrelated search/hash; refresh and Back SHALL restore the selected session. Missing selection (no `?session=`) or an inaccessible target that has been replace-removed SHALL show the welcome state (hero `WorkBuddy，我帮你`) and composer, never auto-select first session; a selected session whose history is pending or failed renders neither hero nor a page-level heading of its own (the breadcrumb owns it). An inaccessible initial GET404 SHALL replace-remove the session parameter and SHALL NOT open EventSource; other errors SHALL remain visible without displaying another session's history.
**Welcome state** (demo:2537-2567) SHALL show hero `WorkBuddy，我帮你`, one row of quick chips (static list ported from demo `QUICK_PROMPTS` for the default 日常办公 scene only; scene pills themselves belong to S1c and are not rendered), the composer card, a `不知道做什么，试试最佳实践案例` section with five static playbook cards (ported from demo `PLAYBOOKS`, demo:2553-2561) and a `换一批` action that rotates within the static set (`查看更多` is not rendered because its target `/center` is undelivered), and the disclaimer `内容由 AI 生成，请核实重要信息`. Clicking a chip or card SHALL only fill the composer draft, never send. While the composer is locked (from submit through the running turn), chips, cards and `换一批` SHALL be disabled so a pick cannot overwrite the draft that a failed create restores.
**Messages** (demo:2378-2406) SHALL render user messages as right-aligned bubbles that preserve complete text and whitespace (`white-space: pre-wrap`, safe rendering) and assistant messages as left-aligned plain blocks with an assistant avatar mark (`BrandMark`, decorative); assistant text SHALL be rendered through the shared safe Markdown renderer (`web/src/lib/md-render.ts`, relocated from the files feature with its provenance header intact; source HTML is escaped and never injected), with visible text following Markdown semantics (markup consumed, link destinations dropped), and a running assistant SHALL show a blinking caret (`ui-caret`) after the last character. Each assistant message that is no longer running and has non-empty text SHALL end with an action row holding a single icon button (`Icon copy`, decorative) whose accessible name and tooltip are `复制`; running messages, empty assistant text and user messages render no action row. Clicking it SHALL copy the raw message text (Markdown source, not the rendered text) via `navigator.clipboard.writeText` and show a `Toast` `已复制到剪贴板`; when the clipboard API is unavailable, throws or rejects, a `Toast` `复制失败` is shown instead and no exception or rejection escapes. Regenerate/like/dislike belong to S1c or are dropped.
**Step cards** (demo:2218-2242) SHALL show a header (`Icon terminal` for `bash`, `Icon wrench` otherwise, step name, and a status badge with `role="status"`, visible text `运行中|已完成|失败` mapped from running/done/failed and accessible name `<step name> 运行中|已完成|失败`) and a one-line summary derived from detail: for JSON object detail the non-blank `text` string, else the non-blank `content` string, or else the first key/value rendered as `<key>: <value>` (non-string values JSON-encoded); for any other detail (non-JSON, or JSON that is not an object) the first non-empty line; the summary is that value's first non-empty line, trimmed; empty detail yields an empty summary; all truncated to 120 code points; full raw detail SHALL stay available behind a collapsed `<details>` `原始输出` (collapsed by default, not open). No fabricated time or todo state. A `回到最新` floating button (`Icon chevron-down` plus the text, rendered only while a session is selected and absent otherwise, never a disabled placeholder) SHALL appear when the transcript is scrolled more than one viewport (`clientHeight`) above the bottom, including when new content grows that distance while the user is away from the bottom; once shown it SHALL stay until the transcript reaches the bottom (within 4px) or the button is clicked; clicking SHALL scroll the transcript to the bottom and hide the button. New content SHALL auto-scroll the transcript to the bottom only when the transcript was at the bottom (within 4px) before the update or the user has just clicked `回到最新`; while the user is scrolled up, new content SHALL NOT change the scroll position. Opening or switching to a session SHALL start at the bottom.
**Composer card** (demo:2576-2603) SHALL be a bordered card containing the labeled multi-line textarea (placeholder `今天帮你做些什么` in welcome state, `继续追问，或派一个新任务…` with a selected session) and a bottom toolbar whose only control is the send button (`Icon send`, aria-label `发送`; while a turn is running the button is disabled with aria-label `生成中` and the toolbar shows a `role="status"` element with text `生成中`); attachment, model switcher, microphone, stop and workspace/permission footer are NOT rendered until their owning stages. The hint `Enter 发送 · Shift+Enter 换行` SHALL remain.
Page SHALL derive its API client from the current auth session, load complete history before opening EventSource, seed the exact snapshot cursor, and use existing pure reducer/connector. All callbacks SHALL be synchronous. Account renewal, session selection, unmount and successful/current401 logout SHALL abort/fence page requests and close the old connection; late responses and ignored-abort loads SHALL NOT mutate UI, navigate or open sources. Pending/failed logout SHALL preserve canonical authenticated behavior.
A user send with no session SHALL create once, select its returned ID and prompt that session once. Empty-whitespace sends SHALL be disabled, and duplicate submits SHALL NOT create concurrent turns. User-initiated navigation SHALL invalidate stale mutation continuations; the create-send operation's own URL handoff SHALL NOT lose its prompt. After successful acceptance the page SHALL reconcile authoritative history and reconnect from that snapshot, without appending duplicate rows or demoting an already finished turn. Failed502 SHALL NOT introduce speculative messages. Session title/order SHALL refresh from server, not duplicate server truncation logic.
Business errors SHALL display inline on the message;409/502 SHALL display envelope message. Composer SHALL be disabled from submit through running turn until terminal authoritative state, with `生成中` on the send button. Current401 SHALL hand off to login. Terminal connector failure SHALL expose a safe error and refresh guidance, preserve last history, and not invent completion or automatically retry; a still-running authoritative status remains locked until reloaded.

#### Scenario: 输入框键盘发送
- WHEN 可发送的草稿在输入框收到无修饰的 Enter
- THEN 通过同一表单受理路径发送一次原始草稿；Shift+Enter 保留换行，输入法 composing 或确认键码229不发送，长按重复Enter不新增提交；空草稿及生成中仍不可发送

#### Scenario: Once-only create and streaming conversation
- WHEN an empty page user sends `你好` and the accepted turn emits start, step start/end, three deltas and done
- THEN exactly one session and prompt are created, URL selects that ID, user and assistant appear in server order without duplicates, text grows, step detail/status changes, server title appears and composer unlocks at done

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
- WHEN 回合快照含 detail 为 `{"command":"echo workbuddy-smoke"}` 的 running `bash` 步骤与一条非 bash 步骤，随后 bash 步骤以 `{"output":"workbuddy-smoke"}` 结束为 done
- THEN bash 卡头为 `terminal` 图标、`bash` 与徽章 `运行中`（`role=status` 名 `bash 运行中`），摘要行为 `command: echo workbuddy-smoke`；结束后徽章为 `已完成`（名 `bash 已完成`）、摘要行为 `output: workbuddy-smoke`；非 bash 卡头为 `wrench` 图标；`原始输出` 的 `<details>` 未展开且内含完整原始 detail

#### Scenario: 回到最新
- WHEN 长历史会话打开后，用户上滚超过一屏，随后新 delta 到达；再点击 `回到最新`，之后又有新 delta 到达
- THEN 打开时位于底部且无按钮；上滚期间新 delta 不改变滚动位置且按钮可见；点击后滚到底部、按钮消失；之后的新 delta 保持自动跟随到底部；欢迎态不渲染该按钮

#### Scenario: 复制助手原文
- WHEN 一次已完成回合的助手正文为含 Markdown 标记的原文，点击该助手消息的 `复制`；再分别在剪贴板 API 缺失、`writeText` reject 时点击
- THEN 剪贴板写入恰为该条助手的原始 Markdown 文本并出现 Toast `已复制到剪贴板`；API 缺失或 reject 时出现 Toast `复制失败` 且无未捕获异常；running 助手、空正文助手与用户消息均无 `复制` 按钮

### Requirement: 转录区尺寸变化触发贴底重算
会话转录区的滚动容器或其内容根发生尺寸变化（容器变矮或变高、内容自行变高，例如 transcript 上方出现 alert、展开步骤卡 `原始输出`、视口高度变化）而消息内容未变时，SHALL 执行与内容更新相同的只读重算：更新前处于贴底（距底 ≤4px）或刚点击 `回到最新` 的转录 SHALL 回到底部；用户已上滚时 SHALL NOT 改变滚动位置，并在距底超过一屏（`clientHeight`）时显示 `回到最新`。贴底状态仍只由用户滚动与点击 `回到最新` 写入。运行环境没有 `ResizeObserver` 时 SHALL 退化为仅在内容更新时重算且不报错；观察在组件卸载或切换会话时 SHALL 解除。

#### Scenario: 贴底时容器变矮仍贴底
- **WHEN** 转录处于贴底，随后其上方出现 alert 或视口变矮使滚动容器变矮
- **THEN** 转录回到底部（距底 ≤4px），最后一行可见

#### Scenario: 贴底时展开原始输出继续跟随
- **WHEN** 转录处于贴底时展开最后一张步骤卡的 `原始输出`
- **THEN** 转录跟随到底部（距底 ≤4px）

#### Scenario: 上滚时尺寸变化不拽回
- **WHEN** 用户已上滚超过一屏，随后视口高度变化或内容变高
- **THEN** 滚动位置不变，`回到最新` 可见

