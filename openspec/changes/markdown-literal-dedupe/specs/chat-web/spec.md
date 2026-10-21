## MODIFIED Requirements

### Requirement: 消息线程
会话页 SHALL 以 `web/src/features/chat/` 内的应用层组件渲染选中会话的消息线程：线程、消息、步骤卡与操作行直接由 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合而成；拷入层（`web/src/components/assistant-ui/`）只提供 `markdown-text`、`reasoning`、`tool-group` 三个组件及其 registry 依赖（ui-foundation `组件分层`），不拷入 registry 的 `thread` 与 `tool-fallback`。源 HTML 的消毒与链接 / 图片的目标规则、分段次序、不提供编辑/分支、不使用 runtime 的附件适配器等行为定制 SHALL 都在应用层实现（例如经 `markdown-text` 的 `components` 覆盖与 `rehypePlugins` 透传，以及组合 `tool-group` / `reasoning` 的 Root/Trigger/Content）；拷入文件只按 ui-foundation「组件分层」的第六类修改把调用方给的 `rehypePlugins` 原样透传给基元（ADR-0013 2026-10-04 放宽：只转发、不写默认值，调用方不传时行为与原文一致），不为别的目的修改。每条消息的根元素（用户与助手）SHALL 是 `article`，可访问名分别为 `用户` 与 `助手`，并带 `data-message-id="<message id>"`；对话内搜索的当前匹配标记 `aria-current="true"` 与当前匹配的高亮样式落在同一个根元素上（conversation-search）。根元素 SHALL 是整条消息：消息的全部内容与操作行都在它之内。

**用户消息** SHALL 渲染为右侧气泡，完整保留文本与空白（换行与前导空白不折叠），内容按纯文本呈现；消息带附件时气泡在文本下方列出它们（message-attachments「用户气泡中的附件」）。气泡（底色、圆角与内边距）SHALL 是根元素的内层容器，只包消息内容（文本、附件列表，以及存在时的工具段与错误文本）；操作行 SHALL 在气泡之外、气泡下方、靠右对齐，气泡的高度不因操作行而增加。文本为空的用户消息（只发附件的消息；「空」的判定见 message-attachments「用户气泡中的附件」：快照里 `content` 为空串，页面自己呈现的那条按发送时的草稿去掉首尾空白后判定）SHALL 只渲染附件列表，不渲染空的文本块；根元素、可访问名与操作行照旧。用户消息 SHALL 带一个操作行（行里一个按钮都没有时——已归档会话里只发附件的消息——不渲染操作行），按钮依次为 `复制`（仅文本非空时）、`撤回`、`从此处分叉`（可访问名与 tooltip 分别为 `复制`、`撤回`、`从此处分叉`）。用户消息的 `复制` SHALL 经 `navigator.clipboard.writeText` 写入气泡里显示的消息原文（含换行与前导空白，不含附件列表），成功与失败的反馈规则与助手消息的 `复制` 相同（见下文「操作行」）。`撤回` 的行为、不可用时的原因说明与冲突对话框见 message-undo「web 撤回」：点击不弹确认，成功后这条及其后的消息从线程移除、其原文（只发附件的消息为空串）覆盖输入框草稿、其撤回后仍存在的附件恢复为输入框的附件标签（message-attachments「输入框附件标签」）。`撤回` 与 `从此处分叉` 在输入框锁定期间都禁用，`复制` 不因锁定而禁用；已归档的会话 SHALL NOT 渲染 `撤回` 与 `从此处分叉`，也不渲染助手消息的 `重新生成`（「会话页」Archived session），用户消息的 `复制` 与助手消息的 `复制` 照常渲染。点击 `从此处分叉` SHALL 恰调用一次 `forkSession(sessionId, messageId)`，201 时导航到 `?session=<new id>`（保留无关的 search/hash）、从服务端刷新会话列表，并把输入框草稿设为返回的 `draft`（分叉点是只发附件的消息时为空串）、把输入框的附件标签设为返回的 `attachments`（message-attachments「输入框附件标签」）而不发送；400/409/502/503 信封文案就地显示在输入框上。

**错误文本**（#909）SHALL 在消息有 `error` 对象时渲染：第一行为 `error.message`，`error.status` 非 `null` 时其后接 `（HTTP <status>）`；`error.detail` 非空时其下有一个 `查看原文` 按钮（带 `aria-expanded`，缺省收起），展开后以纯文本显示 `detail`——保留换行与空白、自动折行、超出一定高度时块内滚动，SHALL NOT 按 Markdown 或 HTML 渲染。消息为 running 且 `retrying` 为 `true` 时，同一位置渲染一行 `role="status"` 的 `上游出错，正在重试…`。`error` 为 `null` 的失败消息不渲染错误文本。

**助手消息** SHALL 渲染为左侧的无气泡块，带装饰性的助手头像标记（不进入可访问名）。块内各部分 SHALL 按以下次序渲染，每项仅在存在时渲染：分段区 → 兜底确认记录（配不上步骤的已结算确认，tool-approval「web 审批条」）→ 错误文本（含重试提示）→ `文件变更（N 个）` 卡 → 产物卡（turn-artifacts）→ `已停止` 徽章 → 操作行。分段区不另设包裹元素：各块按次序直接是消息内容容器（`data-slot="message-content"`）的子元素，其后的兜底确认记录等部件与之同级。分段区由「助手消息分段」的切段函数决定：分段布局下为正文段、思考段（每段一个深度思考折叠块，标题见 thinking-fold「深度思考折叠块呈现」）与工具段按发生次序交替；旧布局（该函数判为旧布局的消息，含本 change 之前的全部历史消息）下依次为深度思考折叠块 → 正文 → 一个工具段。消息没有任何正文段时，已停止的以 `（已停止生成）` 占位、运行中尚无任何可见块的代之以等待指示（见下文），二者都位于分段区末尾（旧布局下即正文的位置）；占位 SHALL 是一个 `data-slot="message-body"` 元素（与 #910 之前的占位同一元素）。分段布局下 SHALL NOT 为空正文或只含空白的正文渲染空的 `message-body`：例如一条 running 消息只有一段思考时，消息内没有 `message-body` 元素，第一个正文段到达时才出现。待决审批 SHALL NOT 渲染在消息内（见 `输入框上方停靠区` 与 tool-approval）。思考折叠块、工具段、兜底确认记录、文件变更卡与产物卡 SHALL NOT 改变本条规定的复制、重新生成、分叉与已停止行为：`复制` 仍复制整条消息的正文原文（各正文段按次序拼接即为原文，不含思考与步骤）。

**正文** SHALL 经 `@assistant-ui/react-markdown`（加 `remark-gfm`）渲染，源文本里的 HTML 解析成元素并经白名单消毒后渲染（规则见下，owner 2026-10-18 裁决，取代此前「源 HTML 作为文本出现、链接惰性、图片不加载」三条；「正文渲染错误边界」的回退态除外），不经 `web/src/lib/md-render.ts`（该模块留给文件页）；分段布局下每个正文段各自独立渲染为一个 `data-slot="message-body"` 的块，规则相同：
- 源文本中的 HTML SHALL 解析成元素并经白名单消毒后渲染。元素白名单：段落、标题、`b`/`strong`/`i`/`em`/`u`/`s`/`del`/`ins`/`mark`/`kbd`/`code`/`pre`/`sub`/`sup`/`span`/`br`/`hr`/`div`/`blockquote`/`q`、列表（`ul`/`ol`/`li`/`dl`/`dt`/`dd`）、表格（`table`/`thead`/`tbody`/`tfoot`/`tr`/`th`/`td`）、`details`/`summary`、`a`、`img`，以及只允许 Markdown 任务列表形态的 `input`（`type="checkbox"` 且 `disabled`；其它 `input` 去掉）。`script`、`style`、`noscript`、`textarea`、`iframe`、`object`、`embed` SHALL 连同其内容整体去掉（内容不以文本出现）；其它非白名单元素（`form`/`button`/`select`/`link`/`meta`/`base`/`svg`/`math`/`picture`/`source`/`video`/`audio` 等，以及 `<task>`、`<file>` 这类并非 HTML 元素名的占位写法）：源 HTML 写出的 SHALL 按源文本原样显示为文字——起始标签按原文（含其属性字节）显示——源中的一个起始标签 SHALL 只显示一次，含 HTML 解析器为跨段落、列表项或被块元素截断而重建（克隆）出的同名元素（#1535）——源中有结束标签的也按原文显示，二者之间的内容照常渲染（owner 2026-10-18：占位符不丢）；不是源 HTML 写出的（Markdown 自身生成，如 GFM 脚注的 `section`）SHALL 去掉元素、保留其中的文字。属性白名单：所有元素的 `style`、`title`、`lang`、`dir`；`a` 的 `href`；`img` 的 `src`、`alt`、`width`、`height`；`td`/`th` 的 `colspan`/`rowspan`/`align`；`ol` 的 `start`；`input` 的 `type`/`checked`/`disabled`；`code` 的 `language-*` class 与任务列表 `li`/`ul`/`ol` 的 GFM class（`task-list-item`、`contains-task-list`）；其余属性 SHALL 剥除——含其它取值的 `class`、`id`、`name`（不以加前缀的方式保留）、`target`、`rel`（二者只由链接规则写出）、`tabindex`、`accesskey`、`srcset`、`formaction` 与全部 `on*` 事件属性。`style` 属性的取值在解码 CSS 转义（如 `\75 rl(`）之后、不分大小写、忽略空白地含有 `url(`、`image(`、`image-set(`、`-webkit-image-set(`、`cross-fade(`、`src(` 或 `expression(` 时，或取值里出现 `/*`（CSS 注释：渲染器按声明切分后再去注释，与任何整串去注释的判法都可能配对不一致，是已证实的绕过路径；CSS 转义造不出 `/*`，注释在属性里也没有用处）时，SHALL 整个属性丢弃（元素保留）；其余 `style` 取值原样保留（owner 2026-10-18：完整保留 style）。消毒作用于 Markdown 与源 HTML 产生的全部元素。流式期间未闭合的标签按浏览器的容错规则解析；同一份正文在终态渲染的结果 SHALL 与一次性渲染它相同；
- 链接（Markdown 链接与源 HTML 的 `a`）：目标为 `http://`、`https://`（协议后必须是 `//`——`https:evil`、`https:/path` 会被浏览器按相对地址解析）或 `mailto:` 的 SHALL 渲染为 `a` 元素，`href` 为该目标、`target="_blank"`、`rel` 含 `noopener` 与 `noreferrer`、`class` 恰为链接规则写出的固定样式类 `aui-md-a text-primary hover:text-primary/80 underline underline-offset-2`（owner 2026-10-18：链接要看得出是链接；基础层把 `a` 重置为正文色，源 HTML 的 `class` 仍剥除）；协议前缀按字面、区分大小写比对（与消毒器的协议表同口径，`HTTPS://…` 按其它目标处理）；其它目标（`javascript:`、`data:`、`vbscript:`、相对路径、只有锚点、没有 `href`）SHALL 只渲染链接的可见文字、不生成 `a` 元素，目标地址不出现在页面文本与属性里；
- 图片（Markdown 图片与源 HTML 的 `img`）：`src` 为 `http://` 或 `https://`（同样要求 `//`）的 SHALL 渲染为 `img` 元素，`src` 为该地址、`alt` 为源文本的 alt（可为空）、`loading="lazy"`、`referrerpolicy="no-referrer"`，宽度不超过正文容器；协议前缀同样按字面、区分大小写比对；其它 `src`（`data:`、`javascript:`、相对路径、没有 `src`）SHALL 不生成 `img`、不发请求，在原位渲染其 alt 文本，无 alt 时渲染其 URL 文本；加载失败由浏览器显示 alt，页面不弹提示、不重试；
- 代码块 SHALL 带复制按钮，复制该代码块的原文——写入剪贴板的文本 SHALL 去掉末尾恰一个换行（代码内部的换行与原文末尾多出的空行都保留），使粘贴到终端时末行不会被直接执行；成功只把按钮图标换成对勾、不弹提示；复制失败（剪贴板 API 不存在、抛错或 reject）时 SHALL 在该按钮旁渲染 `role="alert"` 的一行文字 `复制失败`（与消息级 `复制` 同一规则：下一次复制成功或再次点击时清除），异常与 rejection 不外泄；不做语法高亮。

**等待指示与小圆点**：运行中的助手消息 SHALL 恰好显示二者之一，进入终态后二者都不显示。
- **等待指示**：消息 running 且还没有任何可见块——`thinking` 为 `null` 或空串、正文为空、没有步骤、没有已结算审批、`error` 为 `null` 且不在重试中——时，SHALL 在正文的位置显示一行 `role="status"`、可见文本为 `正在思考…` 的等待指示（`data-slot="message-waiting"`），带流光；`prefers-reduced-motion: reduce` 下流光动画暂停。任一可见块出现后它 SHALL 消失，同一回合不再出现。不区分模型是否支持推理。
- **小圆点**：消息 running 且已有可见块时，SHALL 在分段区的最后一段之后显示一个小圆点——最后一段是正文段时位于该段 `MarkdownBody` 之后（旧布局下即正文之后，与 #910 的位置相同），否则单独位于最后一段之下；分段区一个块也没有渲染时（例如重试提示先于任何内容出现、正文只有空白、或只有一条兜底确认记录），小圆点单独一行位于分段区的位置，即等待指示原本所在的位置。全条消息恰一个（`data-slot="message-caret"`、`aria-hidden`，计算样式 `border-radius` 为 50%），非减少动态效果时带动画（计算样式 `animation-name` 不为 `none`）；`prefers-reduced-motion: reduce` 下无动画（`animation-name` 为 `none`）。可观察量由 ui-walk 在真实浏览器里断言。

**正文逐字展开**：运行中、非减少动态效果时，正文 SHALL 按 `@assistant-ui/react` `useSmooth` 的规则逐字展开：显示的文本始终是已收到正文的前缀，每字间隔为 min(5ms, 250ms ÷ 尚未显示的字数)，积压越多越快；分段布局下这一规则作用于每个正文段，已被后续段隔开的正文段不再增长，只有仍在增长的最后一个正文段会逐字展开。消息组件首次挂载（打开会话、切换会话）时已有的正文 SHALL 立即全部显示，只有此后到达的部分逐字展开（原地重新安装快照时组件不重新挂载，快照比当前多出的部分按同一规则展开）；展开期间转录区的贴底跟随与 `回到最新` 的判定照常（贴着底时持续贴底，用户上滚后不被拉回）；消息进入任一终态时 SHALL 立即显示全文，不拖尾；`prefers-reduced-motion: reduce` 下 SHALL 不逐字展开，收到即显示。逐字展开期间消息内 SHALL 不出现小圆点之外的运行指示（Markdown 基元的容器 `data-status` 不为 `running`）。`复制` 写入的文本与对话内搜索匹配的文本 SHALL 取已收到的全文，与当前已显示到哪里无关。

状态为 `stopped` 的助手消息 SHALL 在正文之后、操作行之前渲染一个 `role="status"` 徽章，可见文本 `已停止`、可访问名 `助手消息 已停止`（不带错误文本）；其正文为空时 SHALL 以占位文本 `（已停止生成）` 代替空块。这一消息级呈现不改变会话列表状态点、步骤徽章与输入框的呈现。

**操作行**：不再运行的助手消息在正文非空或符合重新生成条件时 SHALL 以操作行结尾；运行中的助手消息不渲染操作行。
- 正文非空时操作行含 `复制` 图标按钮（可访问名与 tooltip 均为 `复制`）：点击 SHALL 经 `navigator.clipboard.writeText` 复制消息的原始文本（Markdown 源文本，不是渲染后的文本）。成功时按钮图标换成对勾约 2 秒，并出现一个视觉隐藏的 `role="status"` 文本 `已复制`；不弹轻提示。剪贴板 API 不存在、抛错或 reject 时，SHALL 在该按钮旁渲染 `role="alert"` 的一行文字 `复制失败`，下一次复制成功或再次点击时清除；异常与 rejection 不外泄。
- `重新生成` 图标按钮（可访问名与 tooltip 均为 `重新生成`）SHALL 只出现在转录**末条**消息上，且该消息是助手消息、会话状态为 `done|failed|stopped`（正文为空也显示）；更早的助手消息、运行中的会话与 `idle` 会话不渲染它（会话只有在没有历史时才是 `idle`——分叉得到的会话继承末条被拷贝助手消息的状态，所以带历史的分叉会话是 `done|failed|stopped`，其末条助手消息符合条件）。这一可见条件由应用层组件判定，不依赖运行时的默认可见性。点击 SHALL 恰调用一次 `regenerateSession`（结算前按钮禁用），像运行中回合一样锁定输入框，202 时不弹任何提示，随后对账权威历史并从该快照重连：旧助手行消失，新的运行中助手行（新 id、正文为空）取代其位置，用户消息不重复；409/400/502/503 信封文案就地显示在输入框上并解锁输入框。
- 不提供点赞/点踩、消息编辑与分支切换。
- **显隐**（用户消息与全部助手消息的操作行同一规则，末条助手消息与刚结束的回答不做特殊处理）：操作行 SHALL 缺省不可见——计算样式的 `opacity` 为 `0`；以下任一条件成立时 SHALL 可见（`opacity` 为 `1`）：鼠标悬停在该消息的根元素上；行内有元素获得焦点（含键盘 Tab 到达行内按钮）；行内有 `复制失败` 提示（鼠标移开后它与整行仍可见，直到下一次点击清除它）。主指针不能悬停（`(hover: none)` 成立，例如手机与平板）的设备上操作行 SHALL 始终可见；能悬停的设备（含带鼠标的触屏笔记本）按悬停规则，与视口宽度无关。隐藏 SHALL 只经不透明度：行与按钮仍在文档流中占位（显隐不改变任何元素的位置与尺寸）、按钮仍在 Tab 顺序与无障碍树中（不带 `aria-hidden`、`inert`、`tabindex="-1"`，不用 `display: none` 或 `visibility: hidden`），不使用运行时操作栏的自动隐藏。非减少动态效果时显隐 SHALL 为短的不透明度过渡（计算 `transition-duration` 不为 `0s`）；`prefers-reduced-motion: reduce` 下 SHALL 为无过渡（计算 `transition-duration` 为 `0s`）。

**工具段**（其它规格里称「工具调用组」，二者同指）：分段布局下每个工具段是一串相邻的步骤（中间没有正文段或思考段），旧布局下一条消息的全部步骤收进一个工具段；没有步骤的消息没有工具段。每个工具段 SHALL 是一个 `role="group"`、可访问名 `工具调用` 的组，默认收起，展开/收起控件带 `aria-expanded`，收起时只显示一行摘要；摘要文字、运行中状态与折叠规则见「工具段摘要与折叠」（含失败步骤的工具段同样默认收起，不因失败自动展开）。文件变更卡与产物卡在工具段之外，不受其展开状态影响。
展开后每个步骤一张卡，卡的内容不变：SHALL show a header (terminal icon for `bash`, wrench icon otherwise, step name, and a status badge with `role="status"`, visible text `运行中|已完成|失败|已停止` mapped from running/done/failed/stopped and accessible name `<step name> 运行中|已完成|失败|已停止`) and a one-line summary derived from detail: for JSON object detail the non-blank `text` string, else the non-blank `content` string, or else the first key/value rendered as `<key>: <value>` (non-string values JSON-encoded); for any other detail (non-JSON, or JSON that is not an object) the first non-empty line; the summary is that value's first non-empty line, trimmed; empty detail yields an empty summary; all truncated to 120 code points; the summary SHALL come from `detail` (the tool args) only and SHALL NOT change when the step ends; the complete `detail` and, when non-empty, the step `output` (the tool result text, or the error text of a failed step) SHALL stay available behind a `原始输出` fold (collapsed by default) as two separate blocks, args first; a step whose detail and output are both empty renders no `原始输出`. No fabricated time or todo state. 卡头可另有一个确认小标记，规则见「步骤卡的确认标记」；这是卡内容唯一的变化。

**滚动**：线程的滚动容器 SHALL 是 assistant-ui 的线程视口（`ThreadPrimitive.Viewport`）；其自带的跟随 SHALL 关闭，贴底跟随与 `回到最新` 由应用层实现，行为以下列条文与「转录区尺寸变化触发贴底重算」的场景为准；运行环境没有 `ResizeObserver` 时滚动容器可退回普通元素。A `回到最新` floating button (a chevron-down icon plus the text, rendered only while a session is selected and absent otherwise, never a disabled placeholder) SHALL appear when the transcript is scrolled more than one viewport (`clientHeight`) above the bottom, including when new content grows that distance while the user is away from the bottom; once shown it SHALL stay until the transcript reaches the bottom (within 4px) or the button is clicked; clicking SHALL scroll the transcript to the bottom and hide the button. New content SHALL auto-scroll the transcript to the bottom only when the transcript was at the bottom (within 4px) before the update or the user has just clicked `回到最新`; while the user is scrolled up, new content SHALL NOT change the scroll position. Opening or switching to a session SHALL start at the bottom. 线程的滚动层 SHALL 暴露对话内搜索使用的 `scrollToMessage(id)` 句柄（行为见 conversation-search `跳转与消息级高亮`）。

**零消息空态**：选中会话、历史已加载、消息为空且没有回合在跑时，线程区 SHALL 显示一个装饰性图标、一行 `还没有消息，发一条开始吧`，以及该会话绑定的工作空间名（只读，前缀 `工作空间`；会话未绑定时不显示这一行；已绑定但空间名解析不出来时——工作空间列表读取中、读取失败或该空间已删除——同样不显示这一行）。空态 SHALL NOT 显示场景分组、快捷任务或最佳实践卡，SHALL NOT 改动输入框草稿；页面一级标题仍是顶栏面包屑。历史尚在加载或加载失败时 SHALL NOT 显示空态。输入框处于锁定时（回合进行中，或流错误带着刷新指引——例如 prompt 已被受理但随后的快照读取失败）同样 SHALL NOT 显示空态：提示语指向的「发一条」此时做不了。

**正文渲染错误边界**（#1534）SHALL 包住每个助手正文段的 Markdown 渲染：转换在渲染期抛出异常（如超深嵌套的 `>` 或 `<div>` 在 Markdown→hast 转换中栈溢出）时，该正文段 SHALL 回退为保留换行与空白的纯文本原文（React 文本节点，不经 HTML 解析），同一条消息的其它块、同一会话的其它消息与应用壳 SHALL 不受影响；该正文段的文本变化（含快照原地重装）时 SHALL 重新尝试 Markdown 渲染——只在文本与抛错时不同才清错误态，同一文本再次抛错只是再落回回退态，不循环。应用 SHALL NOT 因助手正文的渲染异常落到 react-router 的默认错误页（`Unexpected Application Error!`）。

#### Scenario: 消息呈现与流式光标
- **WHEN** 一次回合的快照包含多行用户消息与含 Markdown（标题 + 代码块 + 源 HTML）的助手正文，先处于 running、随后收到 `turn.end` done；另一例在 `prefers-reduced-motion: reduce` 下渲染同一条 running 助手消息
- **THEN** 用户消息为右侧气泡且多行文本换行与前导空白保留；助手块带装饰性头像标记，正文渲染出 heading 与 code 元素，源 HTML 的 `<b>粗</b>` 渲染为一个 `b` 元素、页面文本中不出现 `<b>` 字样；代码块带复制按钮；running 时正文末尾有小圆点，done 后消失；减少动态效果的一例中小圆点存在但无动画（计算样式 `animation-name` 为 `none`）；两条消息的根元素都是 `article`，可访问名分别为 `用户` 与 `助手`，各带自己的 `data-message-id`

#### Scenario: 代码块复制失败就地提示
- **WHEN** 助手正文含一个代码块，点击其复制按钮：先在剪贴板可用时点击，再在 `writeText` reject 时点击，最后在剪贴板恢复可用后再点击一次
- **THEN** 第一次剪贴板写入恰为该代码块原文去掉末尾一个换行（代码块内容为两行 `a`、`b` 时写入 `a\nb`，不以换行结尾；代码块以一个空行结尾时写入的文本仍以恰一个换行结尾）、按钮图标换成对勾、页面没有轻提示；reject 时该按钮旁出现 `role="alert"` 的 `复制失败` 且无未捕获异常；再次点击成功后 `复制失败` 消失

#### Scenario: Markdown 链接惰性与图片不加载
- **WHEN** 助手正文为 `[脚本](javascript:alert(1)) [数据](data:text/html,x) [相对](docs/a.md) [锚点](#top) ![](data:image/png;base64,AAAA) ![本地](./a.png) <a href="javascript:void(0)">j</a> <img src="data:image/gif;base64,R0lGOD" alt="内联">`（全部是不安全或无法解析的目标）
- **THEN** `脚本`、`数据`、`相对`、`锚点`、`j` 都只作为文字出现，正文内没有任何 `a` 元素，页面文本与属性中不出现 `javascript:`、`alert(1)`、`data:text`、`docs/a.md`、`#top`、`void(0)`；正文内没有任何 `img` 元素、没有发出任何图片请求，三张图片的位置分别显示文本 `data:image/png;base64,AAAA`（无 alt 显示地址）、`本地`、`内联`

#### Scenario: 链接、图片与源 HTML 的渲染与消毒
- **WHEN** 助手正文为 `[官网](https://example.com/a) [脚本](javascript:alert(1)) [数据](data:text/html,x) [相对](docs/a.md) [邮件](mailto:a@example.com) ![示意图](https://img.example.com/a.png) ![](data:image/png;base64,AAAA) <a href="https://evil.example" onclick="alert(1)" class="x" id="y" name="n" target="_self">x</a> <span style="color:#c0392b">红</span> <span style="background:url(https://t.example/p.png)">底</span> <span style="background:\75 rl(https://t.example/q.png)">转</span> <span style="background-image:image-set('https://t.example/r.png' 1x)">集</span> <span style="content:'/*';background:u/**/rl(https://t.example/q.png)">注</span> <span style="color:red/*;background:u/**/rl(https://t.example/p.png)">配</span> [r](https:evil) ![i](https:t.png) <img src="https:/t.example/x.png"> <script>window.__pwned = 1</script> <style>body{display:none}</style> <iframe src="https://evil.example/frame"></iframe> <img src="https://img.example.com/c.png" onerror="alert(1)"> <details><summary>折叠</summary>内容</details> <table><tr><td>格</td></tr></table> <input type="text" value="v"> Use /todo append <task> to start one. <font color="red">彩</font> ` 加一行 Markdown 任务列表 `- [x] 做完`
- **THEN** `官网`、`x` 与 `邮件` 各是一个 `a` 元素，`href` 分别为 `https://example.com/a`、`https://evil.example`、`mailto:a@example.com`，三者都带 `target="_blank"` 且 `rel` 含 `noopener` 与 `noreferrer`，`x` 的元素没有 `onclick`、`name` 属性，也没有任何形式的 `id` 属性（含加了前缀的），其 `class` 恰为 `aui-md-a text-primary hover:text-primary/80 underline underline-offset-2`（源文本的 `x` 不在其中），`官网` 的 `a` 带同一 `class`；`脚本`、`数据`、`相对` 只作为文字出现、不在任何 `a` 元素内，页面文本与属性中不出现 `javascript:`、`alert(1)`、`data:text`、`docs/a.md`；`示意图` 与源 HTML 的 `img` 各渲染为一个 `img`，`src` 分别为 `https://img.example.com/a.png` 与 `https://img.example.com/c.png`，都带 `loading="lazy"` 与 `referrerpolicy="no-referrer"`，前者 `alt` 为 `示意图`，后者没有 `onerror`；`data:` 图片不生成 `img`，原位显示文本 `data:image/png;base64,AAAA`；`红` 的 `span` 的 `color` 声明为 `#c0392b`（按解析后的声明比对——如计算样式 `rgb(192, 57, 43)`——不按属性字节），`底`、`转`、`集`、`注`、`配` 五个 `span` 都存在但都没有 `style` 属性（后两个是跨声明注释写法）；`r` 只作为文字出现、不在 `a` 内，`![i](https:t.png)` 与 `<img src="https:/t.example/x.png">` 不生成 `img`（原位分别显示文本 `i`——有 alt 显示 alt——与 `https:/t.example/x.png`），`https:evil`、`https:t.png`、`https:/t.example` 不出现在任何属性里，没有向 `t.example` 发出任何请求；文档内没有 `script`、`style`、`iframe` 元素，`window.__pwned` 未被赋值、`body` 仍可见，页面文本中不出现 `<script>`、`<style>`、`<iframe` 字样，也不出现 `body{display:none}`；`details` 渲染为 `details` 元素，其 `summary` 文本为 `折叠`；表格渲染为 `table` 元素，单元格文本为 `格`；没有 `input[type="text"]`，任务列表渲染出一个 `input[type="checkbox"][disabled][checked]`；页面文本原样含 `Use /todo append <task> to start one.` 与 `<font color="red">彩</font>`（`<task>` 与 `<font …>`/`</font>` 是文字，文档内没有 `task`、`font` 元素）

#### Scenario: 白名单外格式元素被克隆时起始标签只显示一次
- **WHEN** 助手正文分别为 `<font color="red">彩` + 空行 + `下一段`、`<small>a` + 空行 + `b`、两项列表 `- <small>a` / `- b`、`<font>a<div>b</font>c`
- **THEN** 前三者的正文段 `textContent` 中 `<font color="red">`（或 `<small>`）恰出现一次，`彩`/`下一段`（或 `a`/`b`）照常显示；第四者 `<font>` 与 `</font>` 各恰出现一次，去掉空白后为 `<font>ab</font>c`；四者正文段内都没有 `font`、`small` 元素
- **WHEN** 作为对照，助手正文为白名单内格式元素 `<b>a` + 空行 + `b`
- **THEN** 渲染出两个 `b` 元素（解析器的克隆照常成为真实元素），页面文本不含 `<b>`

#### Scenario: 流式期间的半截 HTML 不留痕
- **WHEN** 一条 running 助手消息的正文先到达 `<b>粗` 与 `<details><summary>折`，随后补齐为 `<b>粗</b>` 与 `<details><summary>折叠</summary>内容</details>` 并以 `turn.end` done 结束
- **THEN** 终态下正文里恰有一个 `b` 元素（文本 `粗`）与一个 `details` 元素（`summary` 文本 `折叠`），页面文本中不出现 `<b>`、`<details` 等标签字样；期间没有未捕获异常

#### Scenario: 步骤卡呈现
- **WHEN** 回合快照含 detail 为 `{"command":"echo workbuddy-smoke"}` 的 running `bash` 步骤与一条非 bash 步骤，展开该消息的工具段，随后 bash 步骤以 output `workbuddy-smoke` 结束为 done
- **THEN** bash 卡头为终端图标、`bash` 与徽章 `运行中`（`role=status` 名 `bash 运行中`），摘要行为 `command: echo workbuddy-smoke`；结束后徽章为 `已完成`（名 `bash 已完成`）、摘要行仍为 `command: echo workbuddy-smoke`；非 bash 卡头为扳手图标；`原始输出` 折叠未展开，展开后内含完整 detail 块与内容为 `workbuddy-smoke` 的 output 块

#### Scenario: 工具调用组默认收起与失败自动展开
（场景名沿用；#915 起含失败步骤的工具段同样默认收起，不再自动展开，owner 2026-10-06。）
- **WHEN** 快照含一条 done 助手消息（旧布局：步骤 `bodyOffset` 为 `null`），其三个步骤（`read`、`bash`、`write`）均为 `done`；另一条 done 助手消息的两个步骤中 `bash` 为 `failed`；还有一条助手消息没有步骤；另一例中一条 running 助手消息的工具段处于收起，随后 `step.end` 把其中一个步骤置为 `failed`，之后到达 `text.delta` 与另一个步骤的 `step.end{status:"done"}`；再一例用户手动展开一个工具段后到达新的 `step.start` 与 `step.end{status:"failed"}`
- **THEN** 第一条的工具段为收起态（`aria-expanded="false"`），只见一行摘要 `执行 1 条命令、读取 1 个文件、新建 1 个文件`（按「工具段摘要与折叠」的归类次序，不按步骤次序），各步骤卡不可见；展开后按步骤原序出现三张卡。第二条的工具段打开时同样为收起态，摘要末尾为 `，1 步失败`；展开后失败卡徽章为 `失败`。第三条不渲染工具段。流式的一例在失败的 `step.end` 之后仍为收起态，摘要多出 `，1 步失败`；手动展开的一例在新的失败步骤到达后仍为展开态

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
- **WHEN** 快照含一条 `stopped` 助手消息（旧布局：`thinkingSegments` 为 `[]`、步骤 `bodyOffset` 为 `null`）：`thinking` 为 `先想一想`、`thinkingMs` 为 `null`，`approvals` 含一条 `stepId` 为 `null` 的已结算审批，正文为 `部分回答`，一个已结束 `write` 步骤的 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`，会话绑定到本账号的空间
- **THEN** 该消息内按文档顺序依次为 `深度思考过程` 折叠块（收起）、正文、工具段（收起）、兜底确认记录、名为 `文件变更（1 个）` 的卡片、`index.html` 的 HTML 产物卡、名为 `助手消息 已停止` 的徽章与操作行；消息内没有名为 `需要你的确认` 的区域；`复制` 仍只复制 `部分回答`

#### Scenario: 分段布局的块次序
- **WHEN** 快照含一条 done 助手消息：正文为 `先看一下。看完了，结论如下。`（`先看一下。` 5 个码元），`thinking` 为 `想想再答`，`thinkingSegments` 为 `[{bodyOffset:5,thinkingOffset:0,thinkingLength:4,stepsBefore:1,thinkingMs:2100}]`，两个步骤 `read`（ordinal 0）与 `bash`（ordinal 1）的 `bodyOffset` 都为 5，`approvals` 为一条 `stepId` 指向 `bash` 步骤、`decision` 为 `timeout` 的审批，`read` 步骤的 `changes` 为 `null`、`bash` 步骤的 `changes` 为 `null`
- **THEN** 分段区按文档顺序依次为正文段 `先看一下。`、工具段（摘要 `读取 1 个文件`，收起）、标题为 `已思考 2 秒` 的折叠块（收起）、工具段（摘要 `执行 1 条命令`，收起）、正文段 `看完了，结论如下。`；其后是操作行；消息内没有兜底确认记录；展开第二个工具段后 `bash` 步骤卡带 `超时自动允许` 小标记；`复制` 写入 `先看一下。看完了，结论如下。`

#### Scenario: 分段布局下的小圆点
- **WHEN** 一条 running 助手消息依次收到 text.delta(`先看一下。`)、step.start(read，`bodyOffset` 5)；随后收到 step.end 与 text.delta(`好了`)
- **THEN** step.start 之后分段区为正文段与工具段，小圆点恰一个、位于工具段之下而不在正文段内；text.delta(`好了`) 之后小圆点位于第二个正文段的 `MarkdownBody` 之后；`turn.end` 后没有小圆点

#### Scenario: 分段区没有块时的小圆点
- **WHEN** 一条 running 助手消息只收到 text.delta(`\n`)（正文只有空白，分段区一个块也不渲染）
- **THEN** 消息内小圆点恰一个，单独一行位于分段区的位置（等待指示原本所在处），消息内没有 `data-slot="message-body"`；随后收到 text.delta(`好了`) 后小圆点位于该正文段的 `MarkdownBody` 之后

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

#### Scenario: 等待指示
- **WHEN** 发送一条消息后，running 助手消息还没有任何事件内容；随后先到达一条 `thinking.delta`；另一例中随后先到达一条 `step.start`；第三例中随后先到达一条 `text.delta`
- **THEN** 内容到达之前该消息内只有 `role="status"` 的 `正在思考…`，没有小圆点、没有折叠块；三例中第一块内容到达后等待指示消失、小圆点出现，此后直到回合结束不再出现等待指示
- **WHEN** running 助手消息尚无可见块时收到 `turn.retry`；另一例收到 error 与 `turn.end(failed)`
- **THEN** 前者重试提示出现、等待指示消失；后者等待指示与小圆点都不显示，只显示分类错误

#### Scenario: 正文逐字展开
- **WHEN** 非减少动态效果下，一条 running 助手消息已显示正文 `A`，随后收到一条 200 字的 `text.delta`
- **THEN** 此后的若干帧中显示的正文由短到长增长，每一帧都是 `A` 加该 200 字的前缀，在有限时间内等于全文（时长按「正文逐字展开」的间隔规则，积压越多越快；200 字约 0.6s）；其间正文的 Markdown 容器没有 `data-status="running"`，消息内只有一个小圆点；其间点开对话内搜索输入该 200 字中最后五个字，该消息被匹配
- **WHEN** 该消息在正文尚未显示全文时收到 `turn.end(done)`；另一例以快照打开一条 running 助手消息，其正文已有 500 字
- **THEN** 前者终态后立即显示全文，`复制` 写入全文；后者首次渲染即显示全部 500 字，不从头逐字展开
- **WHEN** `prefers-reduced-motion: reduce` 下 running 助手消息收到一条 200 字的 `text.delta`
- **THEN** 收到后立即显示全文

#### Scenario: 正文转换栈溢出时回退纯文本
- **WHEN** 助手正文为 `"> ".repeat(N) + "x"`，N 大到 Markdown→hast 转换在渲染期栈溢出
- **THEN** 该正文段显示纯文本原文（以 `> > ` 开头、以 `x` 结尾），没有 `blockquote` 元素；助手消息的 `article` 仍在，页面没有 `Unexpected Application Error!`，`console.error` 没有收到 react-router 默认错误边界的那条消息（没有边界时正是这三样翻转：路由层接住异常、整页换成默认错误页）
- **WHEN** 助手正文为 `"<div>".repeat(N) + "x"`（源 HTML 经 rehype-raw 的路径）
- **THEN** 同样回退为纯文本，没有 `div` 子元素
- **WHEN** 溢出正文的末尾是 `<script>window.__pwned=1</script>`
- **THEN** 回退文本含字面 `<script>`，页面里没有 `script` 元素，`window.__pwned` 未定义
- **WHEN** 同一会话另有一条含 Markdown 链接的正常消息，且溢出消息里正文段之后还有工具块
- **THEN** 那条消息的链接、溢出消息的工具块、侧栏与输入框都照常渲染
- **WHEN** 处于回退态的正文段其文本换成 `**粗**`（直接渲染 `MessageBody` 后 `rerender`，或快照原地重装——流式 `text.delta` 只会追加，嵌套不会因追加而变浅）
- **THEN** 渲染出 `strong` 元素，不再是纯文本
