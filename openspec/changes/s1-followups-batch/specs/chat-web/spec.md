## MODIFIED Requirements

### Requirement: 输入框与能力栏
会话页的输入框 SHALL 是 `web/src/features/chat/` 内的应用层组件：由拷入层的普通受控多行文本框与按钮组成，文本框的值即应用自有的 `draft` 状态（唯一事实来源），提交走页面既有的发送路径；SHALL NOT 使用 assistant-ui 的 `ComposerPrimitive`。它含附件标签区（仅在有附件时渲染，位于文本框上方，message-attachments「输入框附件标签」）、带标签的多行文本框（可访问名 `给助手发消息`；欢迎态占位 `今天帮你做些什么`，已选会话占位 `继续追问，或派一个新任务…`）、文本框下方的一行能力行与发送按钮（可访问名 `发送`）。`发送` 的启用条件 SHALL 是：草稿不是空白（去掉首尾空白后非空），或至少有一个附件标签且全部标签都处于可发送状态（已上传，或欢迎态的 `待上传`；message-attachments「输入框附件标签」）——只发附件、不发文字是允许的（owner 2026-10-06 改判）；任一附件标签处于 `上传中` 或 `失败` 时不可发送，输入框锁定时不可发送，这两条不变。提示 `Enter 发送 · Shift+Enter 换行` SHALL 保留。键盘规则不变：无修饰的 Enter 经同一表单受理路径发送一次原始草稿，Shift+Enter 换行，输入法组合态（`isComposing`）与键码 229 不发送，长按重复的 Enter 不新增提交，锁定期间不可发送，空白草稿在没有满足上述条件的附件标签时不可发送（Enter 与 `发送` 按钮同一判定）。

**回合进行中**（从提交、经运行中回合、直到权威终态）发送按钮 SHALL 原位换成 `停止` 按钮（可访问名与 tooltip 均为 `停止`），并显示 `role="status"` 的 `生成中`。`停止` 每个点击序列 SHALL 恰调用一次 `stopSession`（点击后到响应或终态之间禁用）；`"stopping"`（202）与 `"idle"`（204）都 SHALL NOT 弹任何提示；错误信封就地显示在输入框上。输入框保持锁定直到权威 `stopped` 状态到达（`turn.end stopped` 或终态快照），届时会话列表状态元素与仍在运行的步骤徽章读作 `已停止`，助手消息显示 `已停止` 徽章，输入框解锁并恢复 `发送`。

**能力行**（`data-slot="composer-toolbar"`）SHALL 是文本框下方的一行，分左右两组：左组（`data-slot="composer-capabilities"`）自左向右依次为「+」菜单、工作空间、权限档位；右组自左向右依次为模型、推理强度，其后是既有的 `生成中` 状态与 `停止` / `发送` 按钮。权限档位控件见 session-permission-tier「权限档位控件」，模型与推理强度控件见 model-selection「模型与推理强度控件」；三者的数据来自 `getComposerOptions()`（每个 client 取一次并缓存；失败后在下一次进入欢迎态或选中会话时重取；本页的一次设置保存成功之后缓存失效并重取一次（owner 2026-10-12，#1269）——「设置保存」指带 `approvalMode`、`modelId`、`reasoningEffort` 之一的 `patchSession`，或 input 带其中之一的 `createSession`——使欢迎态显示的缺省值等于此刻新建会话会得到的值。重取在途与失败期间继续使用上一份数据、控件不消失，失败后按上面的失败规则再取；重取到的 `defaults` 与上一份不同时，欢迎态里尚未发送的页面内选择被丢弃、三个控件回到新的缺省值（否则只选过强度而缺省模型已换成不支持推理的模型时，创建请求只会得到 400）），未取得时这三个控件都不渲染、不摆占位，其余各项照常。三者 SHALL NOT 随输入框锁定而禁用。工作空间与「+」菜单的规则如下（编号只是条目，不表示左右次序）：
1. 工作空间：欢迎态是选择器，触发按钮文本为 `任务启动于 <空间名>`，未选择时为 `任务启动于 未选择`（默认），选项为本账号的工作空间（选择器的呈现、搜索、数据来源与所选值进入创建请求的规则见 session-sidebar「composer footer 工作空间选择」）；已选会话时同一位置是只读标签，同样以 `任务启动于` 开头：会话用临时空间（`temporaryWorkspace` 为 true）时为 `任务启动于 临时空间`，`workspaceId` 为 null（存量的未绑定会话）时为 `任务启动于 未绑定`，绑定的工作空间在已读取的列表里时为 `任务启动于 <空间名>`，`workspaceId` 非空、`temporaryWorkspace` 为 false 但在已读取的列表里找不到（读取中、读取失败或空间已删除）时为 `任务启动于 已绑定空间`；标签不可操作、不发出任何修改请求（会话开始后工作空间锁定）。
2. 「+」菜单：触发按钮的可访问名为 `添加文件或命令`（本 change 之前为 `技能与命令`），只在输入框锁定时禁用。打开后第一项是 `上传文件`（点选即打开系统的文件选择框并关闭菜单；何时禁用及禁用时显示的文字见 message-attachments「没有工作空间的会话」与「输入框附件标签」），其后是命令段：草稿不是空白（去掉首尾空白后非空）时命令条目不可点选（`aria-disabled="true"`，点击与 Enter 都不改草稿），命令段开头显示一行 `清空输入后可选择命令`——这与「此时输入 `/` 不会打开斜杠候选」是同一条件；命令段列出当前工作空间命令目录（`listCommands(workspaceId)`）的全部条目（内建命令与技能），按目录顺序，每项显示 `label` 与 `description`，`source` 为 `project` 的条目带与斜杠候选相同的标记（`项目`，`overrides` 为真时 `项目 · 覆盖平台技能`），目录字符串一律按纯文本呈现。点选一项 SHALL 把草稿设为 `/<name> `（末尾一个空格；只有草稿为空白时才可能点选，所以不会覆盖已有文字）、关闭菜单并聚焦文本框（以 Esc 或点击菜单外关闭时草稿不变，焦点回到 `添加文件或命令` 按钮），SHALL NOT 发送。「+」菜单与斜杠候选共用同一份按工作空间 id 缓存的目录与同一套拉取时机规则：打开菜单时若当前 client 与工作空间 id 尚无目录且无在途调用，则发出一次 `listCommands(workspaceId)`；目录未持有（拉取中或失败）或目录为空时命令段不列出条目，只显示 `暂无可用项`（`上传文件` 项不受影响）；已持有的目录在菜单关闭的过程中仍照常列出，不显示错误；菜单打开期间目录到达时，条目列表 SHALL 就地替换 `暂无可用项`，不需要重新打开菜单。

专家与麦克风 SHALL NOT 渲染，既不出现在能力行，也不出现在「+」菜单里，不摆禁用占位。

**窄屏**（`≤760px`）：能力行 SHALL 允许换行——左组留在第一行，右组（模型、推理强度、`生成中`、`停止` / `发送`）在一行放不下时整体落到下一行并靠右对齐；工作空间按钮 / 标签与模型按钮各有最大宽度，超出时在按钮内截断（完整文字在 `title` 属性里）。任何视口下 `发送` / `停止` SHALL 完整位于输入框容器之内，文档 SHALL NOT 出现横向滚动；三个档位名与七个强度名都按文字显示，不退化为只有图标。

**Slash candidates**: while the draft matches `^\/[^\s]*$` and the composer is enabled, the composer SHALL show above the textarea a `role="listbox"` panel (`aria-label` `命令候选`) listing, from `listCommands(workspaceId)`, every command whose `name` or `label` starts with the typed text after `/` (case-sensitive), in catalogue order, each as a `role="option"` showing `label`, `description` and, when non-null, `hint` in muted text; an option whose `source` is `project` additionally shows the tag `项目`, or `项目 · 覆盖平台技能` when `overrides` is true, and every catalogue string is rendered as plain text. `workspaceId` is the selected session's workspace id (null when unbound) and, in the welcome state, the workspace currently chosen in the capability bar's workspace selector (null for none). The catalogue is fetched lazily and kept in a map keyed by workspace id (null included) for the lifetime of the client — a catalogue is never dropped when the workspace id changes, and a new client starts with an empty map: one `listCommands(workspaceId)` call is issued when the condition becomes true — or the client or the workspace id changes while it is true — while no catalogue is held for the current client and workspace id and no call is in flight for them; a catalogue held for another workspace id is never shown; while that call is pending the panel stays hidden and appears on its success if the condition still holds; a failed call keeps the panel hidden without any error UI, and a new call is issued only at the next such trigger (not on further keystrokes while the condition stays true). The first option is highlighted: the listbox's `aria-activedescendant` names it and it alone carries `aria-selected="true"`; `↑`/`↓` move the highlight cyclically and keep the highlighted option scrolled into view inside the panel, which has a bounded height; `Enter` or `Tab` replaces the draft with `/<name> ` (one trailing space) and closes the panel, `Esc` closes it until the draft changes (returning later to the same text shows it again), clicking an option does what `Enter` does for that option and does not move the focus (the panel and its options are not tab stops and a press on the panel does not take the focus from the textarea), and `Enter` with the panel open SHALL NOT submit; `Shift+Enter`, `Shift+Tab` and keys with `Ctrl`/`Alt`/`Meta` are not intercepted. Any change of the draft, and any change of the workspace id whose catalogue the panel shows, resets the highlight to the first option; a dismissal by `Esc` still lasts until the draft changes, whatever the workspace id does. Key events during an IME composition (`isComposing` or `keyCode` 229, the composer's existing rule) SHALL neither move the highlight nor pick an option, so confirming a Chinese candidate such as `/任务` with Enter is not a pick; with no matching command the panel is hidden and `Enter` submits as usual — an unmatched `/xxx` is sent unchanged (the server decides how omp receives it, chat-sessions「Slash 命令白名单与命令目录」), and the user bubble shows it as typed. The panel's state SHALL stay outside `page.tsx`, in `features/chat/slash-menu-state.ts`.

用临时空间的会话，其命令目录、斜杠候选与项目配置 SHALL 以该会话的 `workspaceId`（临时空间的 id）取用，与绑定正式空间的会话同一路径（`listCommands(workspaceId)`）；只有 `workspaceId` 为 null 的存量会话与欢迎态未选择空间时才以 `null` 取用。输入框草稿可被 `撤回` 覆盖（message-undo「web 撤回」），规则与 `从此处分叉` 写入草稿相同：不发送、焦点到文本框。

#### Scenario: 输入框键盘发送
- WHEN 可发送的草稿在输入框收到无修饰的 Enter
- THEN 通过同一表单受理路径发送一次原始草稿；Shift+Enter 保留换行，输入法 composing 或确认键码229不发送，长按重复Enter不新增提交；空草稿（没有附件标签时）及生成中仍不可发送；草稿为空白但带着全部处于可发送状态的附件标签时，Enter 与 `发送` 同样提交恰一次，prompt 的 `message` 为原始草稿（空串）、`attachments` 为各标签的 `path`；其中任一标签处于 `上传中` 或 `失败` 时 Enter 不提交

#### Scenario: 停止生成
- **WHEN** 一次回合 running 期间（含一条 running `bash` 步骤、无挂起审批）用户点击 composer 的 `停止`，服务端返回 202，随后 SSE 送达 `turn.end stopped`
- **THEN** 点击前输入框无 `发送` 按钮而有可访问名 `停止` 的按钮与 `role=status` `生成中`；点击后 `stopSession` 恰调用一次、按钮禁用，页面上不出现任何轻提示（含 `已停止生成`）；`turn.end stopped` 到达后 composer 解锁并恢复 `发送`，助手消息末尾出现名为 `助手消息 已停止` 的 `role=status` 徽章，展开工具调用组后仍 running 的步骤徽章为 `已停止`（步骤名 `bash 已停止`），侧栏该会话状态元素名为 `<title> 已停止`，助手消息无错误文案；再次发送 prompt 走既有受理路径
- **WHEN** 点击 `停止` 时服务端返回 204
- **THEN** 不出现任何轻提示，composer 以下一份权威快照的状态为准

#### Scenario: 「+」菜单写入草稿
- **WHEN** 已选会话绑定工作空间 A、草稿为 `半句`，点击可访问名为 `添加文件或命令` 的「+」按钮打开菜单（`listCommands("A")` 返回两条内建、`skill:weekly-report`（`source:"skill"`）与 `skill:deploy`（`source:"project"`、`overrides:false`））并点击 `deploy`；随后清空草稿、再次打开菜单并点选 `deploy`；随后清空草稿再输入 `/`；另一例 `listCommands` 尚未返回时打开菜单，菜单仍开着时它成功返回；再一例它失败后打开菜单；还有一例回合进行中（输入框锁定）
- **THEN** 草稿为 `半句` 时按钮可用，菜单第一项是 `上传文件`，命令段开头显示 `清空输入后可选择命令`，四个命令条目都带 `aria-disabled="true"`，点击 `deploy` 后草稿仍为 `半句`；清空后菜单的命令段按目录顺序恰列四项、没有那行提示，`deploy` 带 `项目` 标记；菜单里没有专家；点选后草稿为 `/skill:deploy `、菜单关闭、焦点在文本框，没有发出 prompt；清空草稿再输入 `/` 时斜杠候选直接显示同一份目录、不再发新的 `listCommands` 调用；拉取中的一例命令段先只显示 `暂无可用项`（`上传文件` 项在），目录到达后在仍打开的菜单里就地换成条目列表、`暂无可用项` 消失；失败的一例命令段不列条目、只显示 `暂无可用项`，不显示错误；输入框锁定的一例 `添加文件或命令` 按钮处于禁用

#### Scenario: 已选会话工作空间只读
- **WHEN** 选中一个绑定工作空间 `项目A` 的会话；再选中一个未绑定工作空间的会话；再选中一个 `workspaceId` 非空、`temporaryWorkspace` 为 false、但该空间不在已读取列表里（已删除，或工作空间列表读取失败）的会话；再选中一个 `temporaryWorkspace` 为 true 的会话；随后回到欢迎态
- **THEN** 四者的能力栏分别显示只读的 `任务启动于 项目A`、`任务启动于 未绑定`、`任务启动于 已绑定空间`、`任务启动于 临时空间`，都没有可打开的工作空间选择器，切换前后没有发出修改会话的请求；回到欢迎态后能力栏是可操作的选择器，按钮为 `任务启动于 未选择`

#### Scenario: 斜杠命令候选
- **WHEN** 在欢迎态与已选会话（均未绑定工作空间）的 composer 中分别输入 `/`（`listCommands(null)` 返回两条内建与 `skill:weekly-report`），再输入 `/t`，按 `↓` `↑` `Enter`；再输入 `/help` 后 `Enter`；再输入 `/` 后 `Esc`；输入法组合态下（`isComposing`）输入 `/任` 并按 Enter；以及 `listCommands(null)` 失败时输入 `/`
- **THEN** 输入 `/` 时出现 `命令候选` listbox 恰三项、第一项 `整理上下文` 高亮，`/t` 过滤为 `任务清单` 一项（`todo` 前缀命中），`↓`/`↑` 循环回到该项，`Enter` 使 draft 变为 `/todo ` 且面板关闭、不发送；`/help` 无候选、面板隐藏，`Enter` 照常发送且用户气泡显示 `/help`；`Esc` 关闭面板、再输入字符后重新出现；组合态的 Enter 既不选中也不发送，draft 保持输入法上屏结果；拉取失败时无面板、无错误提示，下次满足条件时重新拉取

#### Scenario: 候选目录的拉取时机
- **WHEN** 首次输入 `/` 而 `listCommands(null)` 尚未返回，其间清空并再次输入 `/`，随后它成功；另一例它失败后继续输入 `/t`，再清空并重新输入 `/`
- **THEN** 返回之前没有面板，成功后（draft 仍满足条件）面板出现，整个过程恰一次调用；失败的一例里 `/t` 不触发新的调用，重新输入 `/` 时发出第二次调用（共恰两次）

#### Scenario: 点击与 Tab 选中
- **WHEN** 面板打开时点击 `任务清单`，另一例按 `Tab`，再一例按 `Shift+Tab`
- **THEN** 点击与 `Tab` 都使 draft 变为对应的 `/<name> ` 并关闭面板，输入框的焦点不被移走，不发送；`Shift+Tab` 不选中

#### Scenario: 候选面板按工作空间取目录
- **WHEN** 已选会话绑定工作空间 A，输入 `/`（`listCommands("A")` 返回两条内建、一条平台 skill、`skill:deploy`（`source:"project"`、`overrides:false`）与 `skill:weekly-report`（`source:"project"`、`overrides:true`））；随后切到未绑定工作空间的会话并输入 `/`；再回到欢迎态、在能力栏的工作空间选择器选中工作空间 A 后输入 `/`
- **THEN** 第一次面板恰五项，`deploy` 一项带 `项目` 标记，`weekly-report` 一项带 `项目 · 覆盖平台技能` 标记，其余无标记；切到未绑定会话时发出 `listCommands(null)`，其返回前不显示 A 的目录；欢迎态选中 A 后显示的是 A 的目录且不再发新调用（同一 client 与工作空间 id 已持有）

#### Scenario: 切换工作空间后高亮回到首项
- **WHEN** 欢迎态草稿为 `/`、未选工作空间的目录有三项，按两次 `↓`（第三项高亮），随后在能力栏的工作空间选择器选中工作空间 A（其目录有五项），再按 `Enter`；另一例在第三项高亮时按 `Esc` 后切到工作空间 A
- **THEN** 切换后面板显示 A 的目录且第一项高亮（`aria-activedescendant` 指向它，仅它 `aria-selected="true"`），`Enter` 选中的是 A 的第一项；另一例切换后面板保持关闭，草稿变化后重新出现且第一项高亮

#### Scenario: 能力行的次序
- **WHEN** 整页挂载（假 API）选中一个绑定工作空间 `项目A` 的会话，`getComposerOptions` 返回三档与两个模型（当前模型支持推理）；另一例回到欢迎态；再一例 `getComposerOptions` 失败
- **THEN** 第一例能力行内按文档顺序依次为：`添加文件或命令` 按钮、只读的 `任务启动于 项目A`、`权限：只问命令` 按钮、`模型：<名>` 按钮、`推理强度：高` 按钮、`发送` 按钮；前三者在左组容器内，后三者不在左组容器内；整个过程恰一次 `getComposerOptions` 调用。欢迎态次序相同，第二项是可操作的工作空间选择器。失败的一例能力行里只有 `添加文件或命令`、工作空间项与 `发送`，没有占位元素，也没有错误提示

#### Scenario: 锁定时三个控件仍可用
- **WHEN** 回合进行中（输入框锁定）
- **THEN** `添加文件或命令` 按钮与文本框处于禁用；权限、模型、推理强度三个按钮都未禁用，可以打开各自的菜单；`生成中` 与 `停止` 照常显示

#### Scenario: 真实浏览器下能力行不挤出发送键
- **WHEN** ui-walk 在 `desktop-light`（1440×900）与 `mobile-dark`（390×844）下对真实栈打开欢迎态与一个已选会话
- **THEN** 两种视口下 `发送` 按钮与五个能力行控件的包围盒都完整位于输入框容器之内、互不重叠，文档没有横向滚动；`mobile-dark` 下模型按钮所在的一行位于权限按钮所在的一行之下或同一行（允许换行），`desktop-light` 下六者在同一行

#### Scenario: 选项读取失败后重取
- **WHEN** 整页挂载时第一次 `getComposerOptions` 失败；随后选中另一个会话，这一次 `getComposerOptions` 成功；之后再切换两次会话
- **THEN** 失败后能力行没有权限、模型与推理强度三个控件；选中另一个会话时恰发出第二次 `getComposerOptions`，成功后三个控件出现；其后的切换不再发出该请求（全程恰两次）

#### Scenario: 保存设置后重取缺省值
- **WHEN** 整页挂载，第一次 `getComposerOptions` 返回 `defaults.approvalMode="write"`；在已选会话里把档位改为 `全部自动`，`patchSession` 成功，第二次 `getComposerOptions`（先挂起、后返回 `defaults.approvalMode="yolo"`）；随后回到欢迎态，不碰控件直接发送
- **THEN** `patchSession` 成功后恰发出第二次 `getComposerOptions`，它挂起期间三个控件仍在；返回后欢迎态的权限按钮是警示色的 `权限：全部自动`；`createSession` 的 input 不含 `approvalMode`，这次创建成功后没有第三次 `getComposerOptions`（input 不带三键）
- **WHEN** 欢迎态选过 `每次都问` 后发送，`createSession`（input 含 `approvalMode`）成功
- **THEN** 其后恰多一次 `getComposerOptions`
- **WHEN** `patchSession` 只带 `title`；另一例带 `modelId` 的 `patchSession` 失败
- **THEN** 两例都没有新的 `getComposerOptions` 请求
- **WHEN** 欢迎态把强度选为 `低` 之后，一次在途的重取返回的 `defaults.modelId` 是不支持推理的模型；随后发送
- **THEN** 强度控件消失，模型按钮显示新的缺省模型；`createSession` 的 input 不含 `reasoningEffort`，也不含 `modelId`
- **WHEN** 保存成功后的那次重取失败；随后选中另一个会话
- **THEN** 失败期间三个控件按上一份数据照常显示；选中另一个会话时再发出一次 `getComposerOptions`
