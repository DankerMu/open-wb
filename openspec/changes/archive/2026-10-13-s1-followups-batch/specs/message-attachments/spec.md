## MODIFIED Requirements

### Requirement: prompt 携带附件
`POST /api/sessions/:id/prompt` 的 body SHALL 可选携带 `attachments`（请求体的键集、`message` 的规则与受理、补偿流程见 chat-sessions「REST prompt 受理与补偿」）。`attachments` 缺席与 `[]` 等价（无附件）。**只发附件、不发文字是允许的**（owner 2026-10-06 改判）：`message` 去掉首尾空白后为空串时，只要 `attachments` 非空并通过下列全部条件，请求照常受理（202）；`message` 为空而无附件（缺席或 `[]`）仍是 400 `bad_request`；`message` 键在任何情况下都 SHALL 出现且为字符串。空文本带非空 `attachments` 时，请求的去留只由下列条件决定（各自的 400 / 403 / 404），不因文本为空而被拒。给出时 SHALL 依次满足下列条件，全部在 `acceptPrompt` 之前判定，任一不满足即按所注明的结果拒绝，不受理、不派发、不写消息行：

1. 形状：数组，元素个数不超过 `UPLOAD_MAX_FILES` 的生效值（它就是每条消息的附件总数上限）；每个元素是字符串，1 到 1024 个 UTF-8 字节，不含下列任一字符（owner 2026-10-12，#1257）：U+0000–U+001F、U+007F、U+0085、U+2028、U+2029，以及双向控制字符 U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069；不得以 `/` 结尾，按 `/` 切开后的最后一段不得恰为 `.`（沙箱解析会跳过空路径段与 `.` 段，这样的路径本可通过后面各条，却取不出文件名——`uploads/a.pdf/.` 即是）；元素互不相同。否则 400 `bad_request`。
2. 非空的 `attachments` 要求会话绑定了工作空间（`workspace_id` 非 NULL）；否则 400 `bad_request`。
3. 文本经 `classifyPrompt` 判为内建命令（`builtin`）时不得带非空的 `attachments`；否则 400 `bad_request`。判为技能或普通文本的可以带。空串不以 `/` 开头，判为普通文本：只发附件的请求不触发本条，也不为它另设分类。
4. 先确认会话工作空间的根可见：该空间的根目录不存在，或其路径上不是一个目录（被同名的普通文件占据）→ 404 `not_found`，与工作空间端点对同一情形的应答相同（workspaces「工作空间 HTTP 集成边界」）；此时 SHALL NOT 调用沙箱解析、SHALL NOT 写 `sandbox.reject`——根不在时沙箱解析会把任何路径都判为越界，那条审计是假的（#1257）。根可见时，每个元素按请求次序经沙箱 facade `resolve(principal, <会话的 workspace_id>, <元素>, "read")`：被拒绝的（越界、符号链接等）→ 403 `sandbox_denied`，并由 facade 写一条 `sandbox.reject` 审计（sandbox-core）。
5. 每个解析出的目标 SHALL 是已存在的普通文件（`lstat`，不跟随符号链接）；否则 400 `bad_request`。

路径 SHALL NOT 被限定在 `uploads/` 之下：会话工作空间内的任何普通文件都可以作为附件。附件校验只读取文件元数据，SHALL NOT 读取文件内容。

#### Scenario: 带附件的 prompt 被受理
- **WHEN** owner 向绑定工作空间 W 的会话上传 `a.pdf`（3 字节）得到 `uploads/a.pdf`，随后以 `{message:"看看这个", attachments:["uploads/a.pdf"]}` 发 prompt（stub supervisor）
- **THEN** 202；库里用户消息的 `content` 为 `看看这个`、`attachments` 列解析为 `[{path:"uploads/a.pdf", size:3}]`；stub supervisor 收到的文本为 `看看这个\n\n用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：\n- uploads/a.pdf`；新会话的标题为 `看看这个` 的前缀，不含后缀文字

#### Scenario: 只带附件的 prompt 被受理
- **WHEN** owner 向一个新建（无标题）、绑定工作空间 W 的会话上传 `季度报表.xlsx`（3 字节）与 `b.png`（5 字节），随后以 `{message:"", attachments:["uploads/季度报表.xlsx","uploads/b.png"]}` 发 prompt（stub supervisor）；另一例对另一个新会话以 `{message:"  \n", attachments:["uploads/b.png"]}` 发 prompt
- **THEN** 两例都是 202，body 恰三键 `{userMessageId, assistantMessageId, undo}`，`undo` 不是 `command`（空文本不是命令回合；快照步骤照常运行时为 `available`）；库里用户消息的 `content` 都是空串（不是 NULL，也不是被去掉的空白），`attachments` 列分别解析为 `[{path:"uploads/季度报表.xlsx", size:3},{path:"uploads/b.png", size:5}]` 与 `[{path:"uploads/b.png", size:5}]`；stub supervisor 收到的文本恰为附件后缀本身——第一例为 `\n\n用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：\n- uploads/季度报表.xlsx\n- uploads/b.png`，开头两个换行之前没有任何字符；两个会话的标题分别为 `季度报表.xlsx` 与 `b.png`（第一个附件路径最后一个 `/` 之后的部分，按同一条 18 码点前缀规则；不含目录、不含后缀文字）
- **WHEN** 随后读取第一例的消息快照
- **THEN** 该用户消息的 `content` 为 `""`、`attachments` 为上述两项；键集与其它消息相同

#### Scenario: 附件形状与前提
- **WHEN** 以 `attachments` 为 `"uploads/a.pdf"`、`[1]`、`[""]`、含换行的路径、以 `/` 结尾的路径 `uploads/a.pdf/`（该文件存在）、末段为 `.` 的路径 `uploads/a.pdf/.`（该文件存在）、分别含 U+0085、U+2028、U+2029、U+200E、U+202E、U+2066 的路径、两个相同的路径、超过 `UPLOAD_MAX_FILES` 个路径、指向不存在文件的路径、指向目录的路径发 prompt；以及对未绑定工作空间的会话带一个路径发 prompt；以及以 `{message:"/todo", attachments:["uploads/a.pdf"]}` 发 prompt；以及以 `{message:"", attachments:[]}`、`{message:"   "}`（空文本而无附件）、`{attachments:["uploads/a.pdf"]}`（没有 `message` 键）、`{message:"", attachments:["uploads/不存在.pdf"]}` 发 prompt
- **THEN** 均为 400 `bad_request` 与 no-store；没有新的消息行，supervisor 未被调用，审计无新增
- **WHEN** 以 `{message:"", attachments:["uploads/a.pdf"]}` 发 prompt（空文本不是内建命令，第 3 条不适用）；另一例以 `{message:" /todo", attachments:["uploads/a.pdf"]}` 发 prompt（去掉首尾空白后是内建命令）
- **THEN** 前者 202；后者 400 `bad_request`——「内建命令不得带附件」不因允许空文本而放宽
- **WHEN** 以 `attachments:[]` 或不带该键发 prompt
- **THEN** 两者行为相同：202，用户消息的 `attachments` 列为 NULL，交给 supervisor 的文本没有后缀

#### Scenario: 越界附件被拒绝并入审计
- **WHEN** owner 以 `attachments:["../other/secret.txt"]`、以及指向空间内一个符号链接的路径发 prompt（各以 `message:"看看"` 与 `message:""` 发一次，结果相同）；第二个账号以第一个账号空间里文件的路径向自己的会话发 prompt
- **THEN** 前两者为 403 `sandbox_denied`，每次请求各恰新增一条 `sandbox.reject`（`detail.op="read"`、`detail.relPath` 为所给路径）；第三者的路径在它自己的空间里解析，目标不存在 → 400；三者都没有新的消息行、没有派发

#### Scenario: 空间根丢失时带附件的 prompt
- **WHEN** 会话绑定的工作空间行还在，而它的根目录已被应用之外的操作删除；另一例根路径被一个同名的普通文件占据；owner 两例都以 `{message:"看看", attachments:["uploads/a.pdf"]}` 发 prompt
- **THEN** 两例都是 404 `not_found` 与 no-store；审计没有新增行（没有 `sandbox.reject`）；没有新的消息行，supervisor 未被调用

### Requirement: 欢迎态暂存与首次发送
欢迎态没有会话，接受的文件 SHALL 只保存在浏览器内存里，标签状态为 `待上传`，SHALL NOT 发出任何请求；`待上传` 的标签不阻止发送，并且是可发送状态（「输入框附件标签」的发送条件）：草稿为空白时只要有 `待上传` 的标签也可以发送。带着待上传标签的首次发送 SHALL 按以下次序进行，任何一步失败即停在那一步：

1. 恰一次 `createSession`（既有规则，input 带所选工作空间、场景与输入框设置）。
2. 建出的会话视图 `workspaceId` 为 null → 按「没有工作空间的会话」处理，结束。
3. 按标签次序逐个 `uploadFile(<该 workspaceId>, file, …)`，标签依次显示 `上传中` 与完成；任何一个失败 → 不发 prompt；草稿恢复；已完成的标签保持已上传，失败的显示 `失败：<原因>`，其后尚未开始的保持 `待上传`；输入框上显示该失败的 message；新会话保持选中（零消息）。
4. 全部成功 → 恰一次 prompt，`attachments` 为各上传响应的 `path`（按标签次序）。

整个过程视为「提交进行中」：输入框锁定，显示 `生成中`。第 3 步失败后用户移除失败的标签（或重新选入文件）即可再次发送：此时会话已存在，按已选会话的规则处理（仍为 `待上传` 的标签在这次发送前先上传），SHALL NOT 再建会话，已上传的文件 SHALL NOT 重复上传。

**上传阶段按 `停止`**（owner 2026-10-12，#1277）：第 3 步进行中（会话已建出、prompt 尚未发出）点击 `停止` SHALL 取消这次首次发送，而不是请求停止回合：在途的那个 `uploadFile` 被中止（`signal`），其后的文件不再上传，SHALL NOT 发出 prompt，SHALL NOT 调用 `stopSession`（此时没有回合，它只会得到 204）。收尾与第 3 步失败相同但不显示错误：草稿回到输入框；已传完的标签保持已上传，被中止的那个与尚未开始的回到 `待上传`；输入框解锁；新会话保持选中（零消息）。已经传完的文件留在该工作空间的 `uploads/` 里，SHALL NOT 发出删除请求。此后再次发送按上一段的续发规则进行。prompt 已经发出之后的 `停止` 行为不变（turn-control「回合控制 web 呈现」）。
**空的首次发送不发出**（#1277）：首次发送进行中（建会话期间或上传阶段）用户把标签全部移除，而草稿去掉首尾空白后为空时，SHALL NOT 发出 prompt（它只会得到 400）：按未受理收尾——输入框解锁、不显示错误、新会话保持选中（零消息）。草稿非空时照常只带文字发出。
**上传落定后的归属判定**（#1277）：第 3 步的上传全部落定之后、发出 prompt 或按失败收尾之前，页面 SHALL 重新确认这次首次发送仍归它所有——页面仍挂载、这次发送没有被中止或被另一次发送取代、API 客户端（账号）没有变、当前请求的会话仍是这次建出的会话——与 prompt 落定之后安装快照之前所做的是同一组判定；任一不成立时 SHALL NOT 发出 prompt，也 SHALL NOT 改动界面（不恢复草稿、不显示错误）。

#### Scenario: 首次发送先建会话再上传再发 prompt
- **WHEN** 欢迎态选中工作空间 W，选入 `a.pdf` 与 `b.png`（都显示 `待上传`，没有任何请求），输入 `看看` 并发送；`createSession` 返回 `workspaceId=W`，两次 `uploadFile` 成功
- **THEN** 请求次序恰为：一次 `createSession`、`uploadFile(W, a.pdf)`、`uploadFile(W, b.png)`、一次 prompt（`attachments` 为两个响应的 `path`）；期间输入框锁定；受理后用户气泡显示两个附件，附件区清空
- **WHEN** 欢迎态不输入任何文字，只选入 `a.pdf`（`待上传`）并发送
- **THEN** `发送` 在选入后即可用；请求次序恰为一次 `createSession`、`uploadFile(<workspaceId>, a.pdf)`、一次 prompt，其 body 恰为 `{"message":"","attachments":[<该响应的 path>]}`；受理后线程里是一条只有附件列表的用户消息；页面不自行拼标题，列表里该会话的标题以服务端返回的会话视图为准（服务端取文件名 `a.pdf`，「prompt 携带附件」）

#### Scenario: 上传中途失败
- **WHEN** 同样的操作而第二个 `uploadFile` 以 403 信封失败
- **THEN** 没有 prompt；URL 选中新会话，线程为零消息状态；草稿恢复为 `看看`；第一个标签为已上传，第二个为 `失败：<信封文案>`；输入框上显示该文案；`发送` 禁用
- **WHEN** 随后移除失败的标签并再次发送
- **THEN** 没有第二次 `createSession`，没有重新上传 `a.pdf`；恰一次 prompt，`attachments` 只含 `a.pdf` 的 `path`

#### Scenario: 上传阶段按停止
- **WHEN** 欢迎态选中工作空间 W，选入 `a.pdf`、`b.png`、`c.zip`，输入 `看看` 并发送；`a.pdf` 传完、`b.png` 上传到 40% 时点 `停止`
- **THEN** `b.png` 的请求的 `signal` 被中止；`c.zip` 没有发出过上传请求；没有 prompt 请求，没有 `stopSession` 请求，没有删除文件的请求；输入框解锁（不再显示 `生成中`），草稿为 `看看`，三个标签依次为已上传、`待上传`、`待上传`，输入框上没有错误文字；URL 仍选中新会话，线程为零消息状态
- **WHEN** 随后再次发送，两次上传都成功
- **THEN** 没有第二次 `createSession`，没有重新上传 `a.pdf`；依次 `uploadFile(W, b.png)`、`uploadFile(W, c.zip)`，然后恰一次 prompt，`attachments` 为三个响应的 `path`（按标签次序）
- **WHEN** 另一例 prompt 已被受理、回合进行中点 `停止`
- **THEN** 恰一次 `stopSession`（既有行为）

#### Scenario: 移空标签后不发空 prompt
- **WHEN** 欢迎态草稿为空、只选入 `a.pdf` 并发送，在 `createSession` 返回之前移除该标签；另一例在 `a.pdf` 上传到 40% 时移除它
- **THEN** 两例都没有 prompt 请求（第二例上传请求的 `signal` 被中止）；输入框解锁，不停在 `生成中`，没有错误文字；新会话保持选中、零消息
- **WHEN** 草稿为 `看看`、带一个待上传标签发送，在上传中途移除该标签
- **THEN** 恰一次 prompt，body 恰为 `{"message":"看看"}`

#### Scenario: 上传落定时已离开该会话
- **WHEN** 欢迎态带一个待上传标签首次发送；它的上传落定的那一刻，页面当前请求的会话已经是另一个已有会话，而这次发送的中止尚未执行
- **THEN** 没有 prompt 请求；另一个会话的草稿、标签与错误区都没有变化；全程恰一次 `createSession`
