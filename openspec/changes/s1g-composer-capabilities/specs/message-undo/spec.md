## MODIFIED Requirements

### Requirement: 撤回 REST
`POST /api/sessions/:id/undo` SHALL 受 cookie guard 与 owner 预检（未认证 401；不存在或属他人 404 `not_found`，与未知 id 相同，均先于 body 解析），响应 `Cache-Control: no-store`，属于 content-parser 归属集（content-parser 错误 400 `bad_request`）。body SHALL 恰为 `{messageId:number, files:"restore"|"force"|"keep"}`：其它形状、缺键、多余键、`messageId` 不是安全整数、`files` 为其它值 SHALL 400 `bad_request`。前置校验 SHALL 按以下次序进行，全部不写任何行、不向任何进程发帧、不 spawn、不改动任何文件：
1. 会话已归档 → 409 `session_archived`；
2. 会话 `status="running"` 或其控制占用被持有 → 409 `session_busy`；
3. `messageId` 不是该会话的 `role="user"` 消息 → 400 `bad_request`；
4. 该消息的 `undo` 不是 `available` → 400 `bad_request`（无论 `files` 取何值）；
5. 会话 `omp_session_file` 为 NULL → 502 `agent_unavailable`；
6. `files` 为 `restore` 或 `force`，且存在另一个 `workspace_id` 相同、`status="running"` 的会话 → 409 `session_busy`；
7. `files` 为 `restore` 且存在冲突（「共用空间冲突」的判据，只读数据库）→ 409 `undo_conflict`。

校验通过即登记该会话的控制占用（turn-control「会话级控制占用」），持有至本次调用结束并在每一种结束路径上释放；持有期间同一会话的 prompt、regenerate、fork、undo、DELETE SHALL 409 `session_busy`。成功 SHALL 返回 200 `{session, draft, files, attachments}`：`session` 为撤回后的会话视图，`draft` 为被撤回消息所存的 `content` 原文（不带转义空格；只发附件的消息为空串），`files` 见「文件还原与结果」，`attachments` 为被撤回消息所存的附件（message-attachments「附件落库与快照」）里撤回完成后仍然存在的那些——按存储次序，元素恰为所存的 `{path, size}`；该消息没有附件或它们都已不存在时为 `[]`。所存的附件数组 SHALL 在「对话原地回退」第 5 步删除该消息行之前读出；是否存在 SHALL 在第 4 步的文件还原（`files` 不是 `keep` 时）之后判定：路径按 sandbox-core「resolve 契约与逃逸向量」（`op=read`）在该会话的工作空间内解析成功，且目标经 `lstat`（不跟随符号链接）是普通文件，即为存在。这一判定是服务端读回它受理时校验过的路径，不是用户请求：SHALL 使用不写审计的解析（不产生 `sandbox.reject`），解析被拒或 `lstat` 出错都按不存在处理，SHALL NOT 使撤回失败，也不读取文件内容。

#### Scenario: 形状与鉴权
- **WHEN** 所有者以 `{}`、`{messageId:1}`、`{messageId:"1",files:"restore"}`、`{messageId:1,files:"yes"}`、`{messageId:1,files:"keep",x:1}`、`[]`、malformed JSON、`text/plain` body 调用 undo
- **THEN** 均 400 `bad_request` 与 no-store，无行变化、无进程变化
- **WHEN** 匿名请求、他人会话、不存在的会话调用 undo（含非法 body）
- **THEN** 分别 401、404、404（后两者逐字相同），先于 body 解析

#### Scenario: 前置校验的各拒绝
- **WHEN** 分别对：已归档会话；回合进行中的会话；regenerate 正持有占用的会话；`messageId` 为助手消息、别的会话的消息或不存在的 id；`undo` 为 `command`、`too_large`、`failed`、`none` 的消息（`files` 取 `keep`）；一个 `workspace_id` 为 NULL 的存量会话的消息 调用 undo
- **THEN** 依次为 409 `session_archived`；409 `session_busy`；409 `session_busy`；三次 400；四次 400；400。每一次之后会话的消息行、`omp_session_file`、工作空间文件与快照目录都没有变化，fake omp 没有收到任何帧，没有新进程

#### Scenario: 撤回期间的并发请求
- **WHEN** undo 的临时进程 `branch` 应答未到时，对同一会话发 prompt、regenerate、fork、第二个 undo 与 DELETE
- **THEN** 五者均 409 `session_busy`；原 undo 照常 200；之后对该会话的 prompt 返回 202

#### Scenario: 响应带回仍存在的附件
- **WHEN** 用户消息 u2 受理时带附件 `uploads/a.pdf` 与 `uploads/b.png`，其后的回合里 `uploads/b.png` 被删除；所有者 undo `{messageId:<u2>, files:"keep"}`；另一例同样的前提以 `files:"restore"` 撤回（u2 的快照里有这两个文件）；再一例撤回一条不带附件的消息；再一例 u2 的附件路径在受理之后被带外换成了符号链接
- **THEN** 第一例 200 的 `attachments` 恰为 `[{path:"uploads/a.pdf", size:<所存大小>}]`；第二例两项都在、次序与所存相同（`b.png` 已被还原）；第三例为 `[]`；第四例不含那一项；四例的 body 都恰含 `session`、`draft`、`files`、`attachments` 四键，审计都没有新增 `sandbox.reject`
- **WHEN** 被撤回的 u2 只有附件（`content` 为空串、附件 `uploads/a.pdf`，fake omp 的条目文本为附件后缀本身），所有者以 `files:"keep"` 撤回
- **THEN** 200；`draft` 为 `""`，`attachments` 为 `[{path:"uploads/a.pdf", size:<所存大小>}]`；对位成功（不是 502）

### Requirement: web 撤回
用户消息的操作行 SHALL 含 `撤回` 按钮（可访问名与 tooltip 均为 `撤回`），位于 `从此处分叉` 之前（chat-web「消息线程」；`复制` 与操作行的悬停显隐由 #908 规定，不属于本条）。已归档会话不渲染它。输入框锁定期间它禁用。消息的 `undo` 不是 `available` 时它 SHALL 以 `aria-disabled="true"` 呈现为不可用、点击不发请求，并带可访问描述说明原因：
- `too_large`：`这一轮开始前工作空间超出快照上限，无法撤回`
- `failed`：`这一轮开始前的文件快照没有保存成功，无法撤回`
- `unbound`：`这个会话没有使用工作空间，无法撤回`
- `command`：`命令消息无法撤回`
- `none`：`这条消息没有文件快照，无法撤回`

`undo` 为 `available` 时点击 SHALL 不弹确认，恰调用一次 `undoMessage(sessionId, messageId, "restore")`，请求期间输入框锁定（不显示 `生成中` 与 `停止`）。200 时页面 SHALL：重读该会话的消息快照并替换线程；把输入框草稿设为响应的 `draft`，覆盖已有草稿（`draft` 为空串——被撤回的是只发附件的消息——时草稿被清空）；把输入框的附件标签设为响应 `attachments` 所列各项（已上传状态，文件名取路径的最后一段，大小取 `size`；覆盖已有标签——在途的上传中止、排队的撤掉，与 message-attachments「输入框附件标签」切换会话时的规则相同），不发出任何上传请求；把焦点移到输入框；以响应的 `session` 更新列表条目。`files.skipped.count` 或 `files.failed.count` 大于 0 时 SHALL 在输入框上方就地显示一条可关闭的说明（`role="status"`），标题为 `已撤回，以下文件未还原`，列出 `paths`（超过所列条数时末行为 `等共 <count> 项`），下一次发送或切换会话时消失；二者都为 0 时不显示任何说明。

409 `undo_conflict` SHALL 打开对话框，标题 `其它会话改动过这个工作空间`，说明 `这条消息发出之后，共用这个工作空间的其它会话还运行过回合。连文件一起还原会把它们的改动一并冲掉。`，三个按钮 `只撤回对话`、`连文件一起还原`、`取消`：前两者关闭对话框并分别以 `"keep"`、`"force"` 再调用一次 `undoMessage`；`取消` 与 Escape 关闭对话框（遮罩点击不关闭：`alert-dialog`，同删除对话框）且不发请求，焦点回到该 `撤回` 按钮。没有冲突时 SHALL NOT 出现该对话框。其它失败（400/404/409 `session_busy`/409 `session_archived`/502/503 与网络失败）SHALL 把信封文案（非信封失败为既有的安全文案）就地显示在输入框上，线程、草稿与附件标签不变，输入框解锁。请求在途时切换会话、换账号或卸载页面，其后到达的响应 SHALL 被丢弃（不改草稿与附件标签、不导航、不显示错误）。撤回 SHALL NOT 显示任何轻提示。

#### Scenario: 撤回并回填
- **WHEN** 输入框草稿为 `半句话`，点击第二条用户消息（文本 `第二个问题`，`undo` 为 `available`）的 `撤回`，undo 返回 200（`files.skipped.count` 与 `files.failed.count` 均为 0）
- **THEN** 没有出现确认框；恰发出一次 `POST /api/sessions/<id>/undo`，body 为 `{"messageId":<该 id>,"files":"restore"}`；随后恰一次消息快照读取；线程里不再有 `第二个问题` 及其后的消息；输入框草稿为 `第二个问题`、焦点在输入框；页面没有轻提示，也没有 `已撤回，以下文件未还原`

#### Scenario: 不可撤回的原因
- **WHEN** 线程里有 `undo` 分别为 `too_large`、`failed`、`unbound`、`command`、`none` 的用户消息
- **THEN** 各自的 `撤回` 按钮 `aria-disabled="true"`，可访问描述依次为上列五句；点击它们不发出任何请求

#### Scenario: 冲突三选一
- **WHEN** 首次 undo 返回 409 `undo_conflict`
- **THEN** 出现对话框 `其它会话改动过这个工作空间`，含三个按钮；点击 `取消` 后没有第二个请求、线程与草稿不变、焦点在该 `撤回` 按钮
- **WHEN** 改点 `只撤回对话`；另一例点 `连文件一起还原`
- **THEN** 分别恰再发出一次 body 为 `{"messageId":<id>,"files":"keep"}` 与 `{"messageId":<id>,"files":"force"}` 的请求；其 200 之后的行为与「撤回并回填」相同

#### Scenario: 列出未还原的文件
- **WHEN** undo 返回 200，`files.skipped` 为 `{count:1,paths:[{path:"big.bin",reason:"too_large"}]}`、`files.failed.count` 为 0
- **THEN** 输入框上方出现 `已撤回，以下文件未还原` 与 `big.bin`；关闭后消失；发送下一条消息后不再出现

#### Scenario: 失败就地显示
- **WHEN** undo 返回 502 `agent_unavailable`，或 409 `session_busy`
- **THEN** 输入框上显示对应的信封文案；线程与草稿不变；输入框可用；没有轻提示

#### Scenario: 锁定与归档时
- **WHEN** 回合进行中；另一例打开一个已归档的会话
- **THEN** 前者每条用户消息的 `撤回` 为禁用；后者用户消息没有 `撤回` 按钮

#### Scenario: 撤回带附件的消息恢复标签
- **WHEN** 输入框里已有一个已上传的标签 `old.txt`，点击一条带附件 `uploads/a.pdf`、`uploads/b.png` 的用户消息（文本 `看看这两个`）的 `撤回`，undo 返回 200 且 `attachments` 为 `[{path:"uploads/a.pdf", size:3}]`（`b.png` 已不存在）
- **THEN** 草稿为 `看看这两个`；附件区恰有一个已上传状态的 `a.pdf` 标签，没有 `old.txt` 与 `b.png`；没有发出任何上传请求；此时直接发送，prompt 的 `attachments` 恰为 `["uploads/a.pdf"]`
- **WHEN** 另一例 undo 返回的 `attachments` 为 `[]`
- **THEN** 附件区不渲染；草稿照常回填
- **WHEN** 输入框草稿为 `半句话`，撤回一条只有附件的用户消息，undo 返回 200 且 `draft` 为 `""`、`attachments` 为 `[{path:"uploads/a.pdf", size:3}]`
- **THEN** 草稿为空（`半句话` 被覆盖）；附件区恰有一个已上传状态的 `a.pdf` 标签；`发送` 可用；线程里不再有那条只有附件的消息；没有发出上传请求
