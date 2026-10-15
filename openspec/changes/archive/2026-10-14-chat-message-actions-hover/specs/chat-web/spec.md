## MODIFIED Requirements

### Requirement: 消息线程
会话页 SHALL 以 `web/src/features/chat/` 内的应用层组件渲染选中会话的消息线程：线程、消息、步骤卡与操作行直接由 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合而成；拷入层（`web/src/components/assistant-ui/`）只提供 `markdown-text`、`reasoning`、`tool-group` 三个组件及其 registry 依赖（ui-foundation `组件分层`），不拷入 registry 的 `thread` 与 `tool-fallback`。链接惰性、图片不加载、块次序、失败自动展开、不提供编辑/分支、不使用 runtime 的附件适配器等行为定制 SHALL 都在应用层实现（例如经 `markdown-text` 的 `components` 覆盖，以及组合 `tool-group` / `reasoning` 的 Root/Trigger/Content），不为此修改拷入文件。每条消息的根元素（用户与助手）SHALL 是 `article`，可访问名分别为 `用户` 与 `助手`，并带 `data-message-id="<message id>"`；对话内搜索的当前匹配标记 `aria-current="true"` 与当前匹配的高亮样式落在同一个根元素上（conversation-search）。根元素 SHALL 是整条消息：消息的全部内容与操作行都在它之内。

**用户消息** SHALL 渲染为右侧气泡，完整保留文本与空白（换行与前导空白不折叠），内容按纯文本呈现；消息带附件时气泡在文本下方列出它们（message-attachments「用户气泡中的附件」）。气泡（底色、圆角与内边距）SHALL 是根元素的内层容器，只包消息内容（文本、附件列表，以及存在时的工具调用组与错误文本）；操作行 SHALL 在气泡之外、气泡下方、靠右对齐，气泡的高度不因操作行而增加。文本为空的用户消息（只发附件的消息；「空」的判定见 message-attachments「用户气泡中的附件」：快照里 `content` 为空串，页面自己呈现的那条按发送时的草稿去掉首尾空白后判定）SHALL 只渲染附件列表，不渲染空的文本块；根元素、可访问名与操作行照旧。用户消息 SHALL 带一个操作行（行里一个按钮都没有时——已归档会话里只发附件的消息——不渲染操作行），按钮依次为 `复制`（仅文本非空时）、`撤回`、`从此处分叉`（可访问名与 tooltip 分别为 `复制`、`撤回`、`从此处分叉`）。用户消息的 `复制` SHALL 经 `navigator.clipboard.writeText` 写入气泡里显示的消息原文（含换行与前导空白，不含附件列表），成功与失败的反馈规则与助手消息的 `复制` 相同（见下文「操作行」）。`撤回` 的行为、不可用时的原因说明与冲突对话框见 message-undo「web 撤回」：点击不弹确认，成功后这条及其后的消息从线程移除、其原文（只发附件的消息为空串）覆盖输入框草稿、其撤回后仍存在的附件恢复为输入框的附件标签（message-attachments「输入框附件标签」）。`撤回` 与 `从此处分叉` 在输入框锁定期间都禁用，`复制` 不因锁定而禁用；已归档的会话 SHALL NOT 渲染 `撤回` 与 `从此处分叉`，也不渲染助手消息的 `重新生成`（「会话页」Archived session），用户消息的 `复制` 与助手消息的 `复制` 照常渲染。点击 `从此处分叉` SHALL 恰调用一次 `forkSession(sessionId, messageId)`，201 时导航到 `?session=<new id>`（保留无关的 search/hash）、从服务端刷新会话列表，并把输入框草稿设为返回的 `draft`（分叉点是只发附件的消息时为空串）、把输入框的附件标签设为返回的 `attachments`（message-attachments「输入框附件标签」）而不发送；400/409/502/503 信封文案就地显示在输入框上。

**错误文本**（#909）SHALL 在消息有 `error` 对象时渲染：第一行为 `error.message`，`error.status` 非 `null` 时其后接 `（HTTP <status>）`；`error.detail` 非空时其下有一个 `查看原文` 按钮（带 `aria-expanded`，缺省收起），展开后以纯文本显示 `detail`——保留换行与空白、自动折行、超出一定高度时块内滚动，SHALL NOT 按 Markdown 或 HTML 渲染。消息为 running 且 `retrying` 为 `true` 时，同一位置渲染一行 `role="status"` 的 `上游出错，正在重试…`。`error` 为 `null` 的失败消息不渲染错误文本。

**助手消息** SHALL 渲染为左侧的无气泡块，带装饰性的助手头像标记（不进入可访问名）。块内各部分 SHALL 按以下次序渲染，每项仅在存在时渲染：深度思考折叠块 `深度思考过程`（thinking-fold）→ 正文（Markdown，或 `（已停止生成）` 占位）→ 工具调用组 → 已结算审批记录（tool-approval）→ 错误文本（含重试提示）→ `文件变更（N 个）` 卡 → 产物卡（turn-artifacts）→ `已停止` 徽章 → 操作行。待决审批 SHALL NOT 渲染在消息内（见 `输入框上方停靠区` 与 tool-approval）。思考折叠块、已结算审批记录、文件变更卡与产物卡 SHALL NOT 改变本条规定的复制、重新生成、分叉与已停止行为。

**正文** SHALL 经 `@assistant-ui/react-markdown`（加 `remark-gfm`，不启用任何把源 HTML 转成元素的插件）渲染，不经 `web/src/lib/md-render.ts`（该模块留给文件页）：
- 源文本中的 HTML SHALL 作为文本出现，不生成对应元素；
- 链接 SHALL 保持惰性，与现状一致：任何目标（含 `http:`、`https:`、`javascript:`、`data:`、相对路径）都只渲染链接的可见文字，目标地址被丢弃，不生成链接（`a`）元素；
- 图片 SHALL 不加载：不生成 `img` 元素、不向图片地址发请求，在原位渲染其 alt 文本，无 alt 时渲染其 URL 文本；
- 代码块 SHALL 带复制按钮，复制该代码块的原文——写入剪贴板的文本 SHALL 去掉末尾恰一个换行（代码内部的换行与原文末尾多出的空行都保留），使粘贴到终端时末行不会被直接执行；成功只把按钮图标换成对勾、不弹提示；复制失败（剪贴板 API 不存在、抛错或 reject）时 SHALL 在该按钮旁渲染 `role="alert"` 的一行文字 `复制失败`（与消息级 `复制` 同一规则：下一次复制成功或再次点击时清除），异常与 rejection 不外泄；不做语法高亮。

运行中的助手消息 SHALL 在正文最后一个字符之后显示闪烁光标，进入终态后光标消失；`prefers-reduced-motion: reduce` 下光标 SHALL 不闪烁（可观察量：光标元素计算样式的 `animation-name` 为 `none`，由 ui-walk 在真实浏览器里断言）。

状态为 `stopped` 的助手消息 SHALL 在正文之后、操作行之前渲染一个 `role="status"` 徽章，可见文本 `已停止`、可访问名 `助手消息 已停止`（不带错误文本）；其正文为空时 SHALL 以占位文本 `（已停止生成）` 代替空块。这一消息级呈现不改变会话列表状态点、步骤徽章与输入框的呈现。

**操作行**：不再运行的助手消息在正文非空或符合重新生成条件时 SHALL 以操作行结尾；运行中的助手消息不渲染操作行。
- 正文非空时操作行含 `复制` 图标按钮（可访问名与 tooltip 均为 `复制`）：点击 SHALL 经 `navigator.clipboard.writeText` 复制消息的原始文本（Markdown 源文本，不是渲染后的文本）。成功时按钮图标换成对勾约 2 秒，并出现一个视觉隐藏的 `role="status"` 文本 `已复制`；不弹轻提示。剪贴板 API 不存在、抛错或 reject 时，SHALL 在该按钮旁渲染 `role="alert"` 的一行文字 `复制失败`，下一次复制成功或再次点击时清除；异常与 rejection 不外泄。
- `重新生成` 图标按钮（可访问名与 tooltip 均为 `重新生成`）SHALL 只出现在转录**末条**消息上，且该消息是助手消息、会话状态为 `done|failed|stopped`（正文为空也显示）；更早的助手消息、运行中的会话与 `idle` 会话不渲染它（会话只有在没有历史时才是 `idle`——分叉得到的会话继承末条被拷贝助手消息的状态，所以带历史的分叉会话是 `done|failed|stopped`，其末条助手消息符合条件）。这一可见条件由应用层组件判定，不依赖运行时的默认可见性。点击 SHALL 恰调用一次 `regenerateSession`（结算前按钮禁用），像运行中回合一样锁定输入框，202 时不弹任何提示，随后对账权威历史并从该快照重连：旧助手行消失，新的运行中助手行（新 id、正文为空）取代其位置，用户消息不重复；409/400/502/503 信封文案就地显示在输入框上并解锁输入框。
- 不提供点赞/点踩、消息编辑与分支切换。
- **显隐**（用户消息与全部助手消息的操作行同一规则，末条助手消息与刚结束的回答不做特殊处理）：操作行 SHALL 缺省不可见——计算样式的 `opacity` 为 `0`；以下任一条件成立时 SHALL 可见（`opacity` 为 `1`）：鼠标悬停在该消息的根元素上；行内有元素获得焦点（含键盘 Tab 到达行内按钮）；行内有 `复制失败` 提示（鼠标移开后它与整行仍可见，直到下一次点击清除它）。主指针不能悬停（`(hover: none)` 成立，例如手机与平板）的设备上操作行 SHALL 始终可见；能悬停的设备（含带鼠标的触屏笔记本）按悬停规则，与视口宽度无关。隐藏 SHALL 只经不透明度：行与按钮仍在文档流中占位（显隐不改变任何元素的位置与尺寸）、按钮仍在 Tab 顺序与无障碍树中（不带 `aria-hidden`、`inert`、`tabindex="-1"`，不用 `display: none` 或 `visibility: hidden`），不使用运行时操作栏的自动隐藏。非减少动态效果时显隐 SHALL 为短的不透明度过渡（计算 `transition-duration` 不为 `0s`）；`prefers-reduced-motion: reduce` 下 SHALL 为无过渡（计算 `transition-duration` 为 `0s`）。

**工具调用组**：一条助手消息的全部步骤 SHALL 收进一个工具调用组，位于正文之后；没有步骤的消息不渲染该组。组 SHALL 默认收起，展开/收起控件带 `aria-expanded`；收起时只显示一行摘要，内容为步骤数与最近一步（末位步骤）的名称及其状态文字。组内任一步骤状态为 `failed` 时组 SHALL 自动展开（从快照打开时即为展开；流式中某步骤变为 `failed` 时展开）。因失败自动展开后用户仍可手动收起；手动收起后组 SHALL NOT 再自动展开，直到该消息出现新的失败步骤。文件变更卡与产物卡在组之外，不受组的展开状态影响。
展开后每个步骤一张卡，卡的内容不变：SHALL show a header (terminal icon for `bash`, wrench icon otherwise, step name, and a status badge with `role="status"`, visible text `运行中|已完成|失败|已停止` mapped from running/done/failed/stopped and accessible name `<step name> 运行中|已完成|失败|已停止`) and a one-line summary derived from detail: for JSON object detail the non-blank `text` string, else the non-blank `content` string, or else the first key/value rendered as `<key>: <value>` (non-string values JSON-encoded); for any other detail (non-JSON, or JSON that is not an object) the first non-empty line; the summary is that value's first non-empty line, trimmed; empty detail yields an empty summary; all truncated to 120 code points; the summary SHALL come from `detail` (the tool args) only and SHALL NOT change when the step ends; the complete `detail` and, when non-empty, the step `output` (the tool result text, or the error text of a failed step) SHALL stay available behind a `原始输出` fold (collapsed by default) as two separate blocks, args first; a step whose detail and output are both empty renders no `原始输出`. No fabricated time or todo state.

**滚动**：线程的滚动容器 SHALL 是 assistant-ui 的线程视口（`ThreadPrimitive.Viewport`）；其自带的跟随 SHALL 关闭，贴底跟随与 `回到最新` 由应用层实现，行为以下列条文与「转录区尺寸变化触发贴底重算」的场景为准；运行环境没有 `ResizeObserver` 时滚动容器可退回普通元素。A `回到最新` floating button (a chevron-down icon plus the text, rendered only while a session is selected and absent otherwise, never a disabled placeholder) SHALL appear when the transcript is scrolled more than one viewport (`clientHeight`) above the bottom, including when new content grows that distance while the user is away from the bottom; once shown it SHALL stay until the transcript reaches the bottom (within 4px) or the button is clicked; clicking SHALL scroll the transcript to the bottom and hide the button. New content SHALL auto-scroll the transcript to the bottom only when the transcript was at the bottom (within 4px) before the update or the user has just clicked `回到最新`; while the user is scrolled up, new content SHALL NOT change the scroll position. Opening or switching to a session SHALL start at the bottom. 线程的滚动层 SHALL 暴露对话内搜索使用的 `scrollToMessage(id)` 句柄（行为见 conversation-search `跳转与消息级高亮`）。

**零消息空态**：选中会话、历史已加载、消息为空且没有回合在跑时，线程区 SHALL 显示一个装饰性图标、一行 `还没有消息，发一条开始吧`，以及该会话绑定的工作空间名（只读，前缀 `工作空间`；会话未绑定时不显示这一行；已绑定但空间名解析不出来时——工作空间列表读取中、读取失败或该空间已删除——同样不显示这一行）。空态 SHALL NOT 显示场景分组、快捷任务或最佳实践卡，SHALL NOT 改动输入框草稿；页面一级标题仍是顶栏面包屑。历史尚在加载或加载失败时 SHALL NOT 显示空态。输入框处于锁定时（回合进行中，或流错误带着刷新指引——例如 prompt 已被受理但随后的快照读取失败）同样 SHALL NOT 显示空态：提示语指向的「发一条」此时做不了。

#### Scenario: 消息呈现与流式光标
- **WHEN** 一次回合的快照包含多行用户消息与含 Markdown（标题 + 代码块 + 源 HTML）的助手正文，先处于 running、随后收到 `turn.end` done；另一例在 `prefers-reduced-motion: reduce` 下渲染同一条 running 助手消息
- **THEN** 用户消息为右侧气泡且多行文本换行与前导空白保留；助手块带装饰性头像标记，正文渲染出 heading 与 code 元素，源 HTML 作为文本出现、不生成对应元素；代码块带复制按钮；running 时正文末尾有光标，done 后消失；减少动态效果的一例中光标存在但不闪烁（计算样式 `animation-name` 为 `none`）；两条消息的根元素都是 `article`，可访问名分别为 `用户` 与 `助手`，各带自己的 `data-message-id`

#### Scenario: 代码块复制失败就地提示
- **WHEN** 助手正文含一个代码块，点击其复制按钮：先在剪贴板可用时点击，再在 `writeText` reject 时点击，最后在剪贴板恢复可用后再点击一次
- **THEN** 第一次剪贴板写入恰为该代码块原文去掉末尾一个换行（代码块内容为两行 `a`、`b` 时写入 `a\nb`，不以换行结尾；代码块以一个空行结尾时写入的文本仍以恰一个换行结尾）、按钮图标换成对勾、页面没有轻提示；reject 时该按钮旁出现 `role="alert"` 的 `复制失败` 且无未捕获异常；再次点击成功后 `复制失败` 消失

#### Scenario: Markdown 链接惰性与图片不加载
- **WHEN** 助手正文为 `[官网](https://example.com/a) [脚本](javascript:alert(1)) [数据](data:text/html,x) [相对](docs/a.md) ![示意图](https://img.example.com/a.png) ![](https://img.example.com/b.png) <a href="https://evil.example">x</a>`
- **THEN** `官网`、`脚本`、`数据`、`相对` 都只作为文字出现，正文内没有任何链接（`a`）元素，页面文本与属性中不出现这些链接的目标地址；正文内没有任何 `img` 元素，也没有向 `img.example.com` 发出请求，两张图片的位置分别显示文本 `示意图` 与 `https://img.example.com/b.png`；源 HTML 的 `<a …>` 作为文本出现，不生成链接元素

#### Scenario: 步骤卡呈现
- **WHEN** 回合快照含 detail 为 `{"command":"echo workbuddy-smoke"}` 的 running `bash` 步骤与一条非 bash 步骤，展开该消息的工具调用组，随后 bash 步骤以 output `workbuddy-smoke` 结束为 done
- **THEN** bash 卡头为终端图标、`bash` 与徽章 `运行中`（`role=status` 名 `bash 运行中`），摘要行为 `command: echo workbuddy-smoke`；结束后徽章为 `已完成`（名 `bash 已完成`）、摘要行仍为 `command: echo workbuddy-smoke`；非 bash 卡头为扳手图标；`原始输出` 折叠未展开，展开后内含完整 detail 块与内容为 `workbuddy-smoke` 的 output 块

#### Scenario: 工具调用组默认收起与失败自动展开
- **WHEN** 快照含一条 done 助手消息，其三个步骤（`read`、`bash`、`write`）均为 `done`；另一条 done 助手消息的两个步骤中 `bash` 为 `failed`；还有一条助手消息没有步骤；另一例中一条 running 助手消息的组处于收起，随后 `step.end` 把其中一个步骤置为 `failed`，用户手动收起该组，之后到达 `text.delta` 与另一个步骤的 `step.end{status:"done"}`，最后又一个步骤以 `failed` 结束
- **THEN** 第一条的工具调用组为收起态（`aria-expanded="false"`），只见一行摘要，含步骤数 3 与末位步骤的名称 `write` 及状态 `已完成`，各步骤卡不可见；展开后按步骤原序出现三张卡。第二条的组打开即为展开态，失败卡徽章为 `失败`。第三条不渲染工具调用组。流式的一例在第一个失败的 `step.end` 之后组变为展开态；手动收起后 `text.delta` 与 `done` 的 `step.end` 不使它重新展开；新的失败步骤到达后组再次展开

#### Scenario: 回到最新
- WHEN 长历史会话打开后，用户上滚超过一屏，随后新 delta 到达；再点击 `回到最新`，之后又有新 delta 到达
- THEN 打开时位于底部且无按钮；上滚期间新 delta 不改变滚动位置且按钮可见；点击后滚到底部、按钮消失；之后的新 delta 保持自动跟随到底部；欢迎态不渲染该按钮

#### Scenario: 复制助手原文
- **WHEN** 一次已完成回合的助手正文为含 Markdown 标记的原文，点击该助手消息的 `复制`；再分别在剪贴板 API 缺失、`writeText` reject 时点击；随后在剪贴板恢复可用后再点击一次
- **THEN** 第一次点击后剪贴板写入恰为该条助手的原始 Markdown 文本，按钮图标换成对勾并在约 2 秒后恢复，出现视觉隐藏的 `role="status"` 文本 `已复制`，页面上没有任何轻提示；API 缺失或 reject 时按钮旁出现 `role="alert"` 的 `复制失败` 且无未捕获异常，同样没有轻提示；恢复后再点击，`复制失败` 消失；running 助手与空正文助手无 `复制` 按钮（用户消息的 `复制` 见「复制用户原文」）

#### Scenario: 助手消息级已停止呈现
- **WHEN** 快照含两条 `stopped` 助手消息：一条正文为 `部分回答`，另一条正文为空；同时含一条 `done` 与一条 `failed` 助手消息
- **THEN** 两条 `stopped` 助手消息正文之后各有一个 `role=status`、可见文本 `已停止`、accessible name `助手消息 已停止` 的徽章且无错误文案；空正文那条正文区显示占位文本 `（已停止生成）`，非空那条正文为 `部分回答` 且无占位文本；`done`/`failed` 助手消息无该徽章与占位文本；侧栏状态元素、步骤徽章与 composer 的呈现不因此改变

#### Scenario: 重新生成末条回答
- **WHEN** 会话状态为 `done`、末条为助手消息时点击其 `重新生成`，服务端 202 返回新的 `assistantMessageId`，随后权威快照中旧助手行不存在、新助手行 running，SSE 送达 delta 与 `turn.end done`
- **THEN** `regenerateSession` 恰调用一次，页面上不出现任何轻提示（含 `正在重新生成…`），composer 立即锁定；对账后转录为同一条用户消息加一条新 id 的助手消息（旧正文消失、无重复用户行），新正文按 delta 增长直至 done 解锁；`重新生成` 只在末条为助手消息且会话状态 ∈ `done`/`failed`/`stopped` 时可见——running 期间、非末条助手消息与用户消息均无该按钮；`failed`/`stopped` 会话的末条助手消息（含空正文）同样可见并可点击；分叉得到且含历史的会话状态继承末条被拷贝助手消息的状态，其末条助手消息同样可见
- **WHEN** 服务端对 regenerate 返回 409 `session_busy` 或 503 `agent_capacity`
- **THEN** 信封文案内联显示于 composer，composer 解锁，转录不变，页面上没有轻提示

#### Scenario: 从用户消息分叉
- **WHEN** 已完成会话中点击第二条用户消息的 `从此处分叉`，服务端 201 返回 `{session:<new>, draft:"<该用户消息原文>", attachments:[{path:"uploads/a.pdf", size:3}]}`
- **THEN** `forkSession` 恰以该消息 id 调用一次；URL 变为 `?session=<new id>`（无关 search/hash 保留），页面加载新会话历史（分叉点之前的消息）并打开其 EventSource，会话列表从服务端刷新后含新会话，其状态元素反映继承自末条被拷贝助手消息的状态（此例第一条助手消息 `done` → `<title> 已完成`），末条助手消息显示 `重新生成`；composer 草稿等于 `draft`，附件区恰有一个已上传状态的 `a.pdf` 标签，未发送任何 prompt、未发出上传请求；composer 锁定期间 `从此处分叉` 禁用，助手消息无该按钮
- **WHEN** 对第一条用户消息点击 `从此处分叉`，服务端 201 返回的新会话 `status` 为 `idle`
- **THEN** 新会话线程区显示零消息空态（无消息、无 `重新生成`），侧栏状态元素名为 `<title> 未开始`，composer 草稿等于该用户消息原文且未发送
- **WHEN** 点击一条只有附件的用户消息的 `从此处分叉`，服务端 201 返回 `{session:<new>, draft:"", attachments:[{path:"uploads/a.pdf", size:3}]}`
- **THEN** 新会话里 composer 草稿为空，附件区恰有一个已上传状态的 `a.pdf` 标签，`发送` 可用；未发送任何 prompt、未发出上传请求

#### Scenario: 零消息会话空态
- **WHEN** 以 `/?session=<id>` 打开一个绑定工作空间 `项目A`、快照 `messages` 为 `[]` 的 `idle` 会话，打开前输入框草稿为 `草稿`；另一例会话未绑定工作空间；另一例会话已绑定工作空间但工作空间列表读取中、读取失败或该空间已不在列表里；再一例历史请求尚未返回；随后在第一例中发送一条消息
- **THEN** 第一例线程区显示一个图标、`还没有消息，发一条开始吧` 与 `工作空间 项目A`，没有场景分组、快捷任务与最佳实践卡，没有 hero，页面 level-1 heading 仍是顶栏面包屑 `我的工作 / <title>`，输入框草稿仍为 `草稿`、可发送；未绑定与空间名解析不出来的两例都有图标与 `还没有消息，发一条开始吧`，但没有以 `工作空间` 开头的那一行；历史请求尚未返回的一例在历史返回之前不显示空态；发送被受理后空态消失、出现用户消息

#### Scenario: 助手块次序
- **WHEN** 快照含一条 `stopped` 助手消息：`thinking` 为 `先想一想`，`approvals` 含一条已结算审批，正文为 `部分回答`，一个已结束 `write` 步骤的 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`，会话绑定到本账号的空间
- **THEN** 该消息内按文档顺序依次为 `深度思考过程` 折叠块（收起）、正文、工具调用组（收起）、已结算审批记录、名为 `文件变更（1 个）` 的卡片、`index.html` 的 HTML 产物卡、名为 `助手消息 已停止` 的徽章与操作行；消息内没有名为 `需要你的确认` 的区域；`复制` 仍只复制 `部分回答`

#### Scenario: 用户消息操作行的按钮与次序
- **WHEN** 渲染一个 `done` 会话里 `undo` 为 `available` 的用户消息；另一例回合进行中；再一例会话已归档（另含一条只发附件的用户消息）
- **THEN** 第一例操作行的按钮依次为 `复制`、`撤回`、`从此处分叉`，三者可用；第二例 `撤回` 与 `从此处分叉` 禁用、`复制` 可用；第三例操作行里只有 `复制`，没有 `撤回` 与 `从此处分叉`；同一已归档会话里一条只发附件的用户消息不渲染操作行（`article` 内没有 `message-actions`）

#### Scenario: 只有附件的用户消息
- **WHEN** 渲染一个 `done` 会话，其第一条用户消息 `content` 为 `""`、`attachments` 为 `[{path:"uploads/a.pdf", size:3}]`、`undo` 为 `available`
- **THEN** 该消息的根元素是可访问名为 `用户` 的 `article` 并带 `data-message-id`；气泡内只有名为 `附件` 的列表，没有文本块；操作行在气泡之外，按钮依次为 `撤回`、`从此处分叉`，二者可用，没有 `复制`

#### Scenario: 用户气泡与操作行的结构
- **WHEN** 渲染一个 `done` 会话里文本为 `hello`、无附件的用户消息；另一例这条消息是对话内搜索的当前匹配
- **THEN** 根元素 `article`（可访问名 `用户`、带 `data-message-id`）的直接子元素依次为气泡与操作行；气泡内只有消息正文，不含任何按钮；操作行不在气泡内；气泡的底色在气泡上而不在根元素上；另一例 `aria-current="true"` 在根元素上，气泡与操作行都不带它

#### Scenario: 复制用户原文
- **WHEN** 一条用户消息的文本为 `  第一行\n第二行`（含前导空白与换行），点击它的 `复制`；再分别在剪贴板 API 缺失、`writeText` reject 时点击；随后在剪贴板恢复可用后再点击一次
- **THEN** 第一次点击后剪贴板写入恰为 `  第一行\n第二行`，按钮图标换成对勾并在约 2 秒后恢复，出现视觉隐藏的 `role="status"` 文本 `已复制`，页面上没有任何轻提示；API 缺失或 reject 时按钮旁出现 `role="alert"` 的 `复制失败` 且无未捕获异常，同样没有轻提示；恢复后再点击，`复制失败` 消失

#### Scenario: 隐藏的操作行仍可达
- **WHEN** 渲染一个 `done` 会话，含一条带 `撤回` 与 `从此处分叉` 的用户消息与一条正文非空的末条助手消息，鼠标不在任何消息上
- **THEN** 两条消息的操作行都在文档中，其按钮可按可访问名找到，没有一个按钮或其祖先带 `aria-hidden`、`inert` 或 `tabindex="-1"`；按 Tab 能依次到达这些可用按钮

#### Scenario: 真实浏览器下操作行的显隐
- **WHEN** 在支持悬停的桌面浏览器里打开一个已完成、含用户消息与带正文助手消息的会话，鼠标不在任何消息上；然后把鼠标移到用户消息上，再移到末条助手消息上；然后移开鼠标、用 Tab 把焦点移到用户消息的一个操作按钮上；然后在剪贴板写入必定失败时悬停用户消息并点它的 `复制`，再移开鼠标并让焦点离开该行；另一例在 `prefers-reduced-motion: reduce` 下悬停；再一例在主指针不能悬停（`(hover: none)` 成立）的浏览器上下文里打开同一会话
- **THEN** 开始时两条消息操作行的计算 `opacity` 都为 `0`，且该行的包围盒高度大于 0；悬停用户消息时它的操作行为 `1`、助手消息的为 `0`，悬停助手消息时反过来，悬停前后两条消息根元素的包围盒不变；键盘聚焦时该行为 `1`；`复制失败` 出现后移开鼠标、焦点离开，该行仍为 `1`；不减少动态效果时该行的计算 `transition-duration` 不为 `0s`，减少动态效果的一例中为 `0s`；不能悬停的一例中不移动鼠标，两条消息的操作行都为 `1`

#### Scenario: 显隐的短渐变与减少动态效果
- **WHEN** 在支持悬停的桌面浏览器里打开一个已完成、含带正文助手消息的会话，先在不减少动态效果时读取该助手消息操作行的计算样式，再在 `prefers-reduced-motion: reduce` 下读取一次
- **THEN** 不减少动态效果时计算 `transition-duration` 不为 `0s`（显隐是短的不透明度过渡）；减少动态效果下为 `0s`（显隐瞬时完成）；两种情况下悬停后的 `opacity` 都为 `1`

#### Scenario: 失败消息的分类说明与原文
- **WHEN** 快照含一条 `failed` 助手消息，`error` 为 `{reason:"auth_failed",message:"鉴权失败：模型服务拒绝了配置的 API 密钥",status:401,detail:"401 Incorrect API key provided\n<b>x</b>"}`；另一条 `failed` 助手消息 `error` 为 `{reason:"upstream_timeout",message:"上游超时：模型服务没有及时响应",status:null,detail:""}`；另一条 `failed` 助手消息 `error` 为 `null`
- **THEN** 第一条在错误文本位置显示 `鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）` 与一个 `aria-expanded="false"` 的 `查看原文` 按钮，原文不可见；点击后按钮为 `aria-expanded="true"`，原文按纯文本显示两行 `401 Incorrect API key provided` 与字面的 `<b>x</b>`（没有 `b` 元素）；第二条只显示 `上游超时：模型服务没有及时响应`，没有 `（HTTP` 字样，也没有 `查看原文`；第三条不渲染错误文本；三条末条位置上的 `重新生成` 规则不变，输入框不因此锁定

#### Scenario: 重试提示
- **WHEN** running 助手消息收到 turn.retry，随后收到 text.delta；另一例收到 turn.retry 后收到 error 与 turn.end(failed)
- **THEN** turn.retry 后错误文本位置出现一行 `role="status"` 的 `上游出错，正在重试…`；text.delta 后它消失；另一例中它被分类说明取代
