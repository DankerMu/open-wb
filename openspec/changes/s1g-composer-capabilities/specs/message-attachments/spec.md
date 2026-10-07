## ADDED Requirements

### Requirement: 迁移 042 消息附件列
迁移 `042_chat_message_attachments.sql` SHALL 在既有 runner 持有的事务内执行，回执紧随 `041` 之后追加；它 SHALL 只用 `ALTER TABLE … ADD COLUMN` 给 `chat_messages` 增加恰一个可空、无缺省、不带 CHECK 的列 `attachments TEXT NULL`（`chat_steps.output`、`chat_messages.thinking` 的先例；内容规则见「附件落库与快照」）。既有行的全部原有列值、外键、级联、索引与 `sqlite_sequence` 值 SHALL 不变，新列读作 NULL；没有回填。更早的迁移文件 SHALL NOT 被编辑；受信任迁移目录计数断言 SHALL 随之加一。

#### Scenario: 新库与存量库
- **WHEN** `openDb` 打开一个新库；另一例打开一个回执止于 `041`、含消息与步骤的文件库
- **THEN** 回执里 `042` 恰出现一次且紧随 `041`；`chat_messages.attachments` 存在、可空、无缺省；存量库每条消息的原有列值与行数不变、新列读作 NULL；`PRAGMA foreign_key_check` 为空；再次打开目录不变

#### Scenario: 中途失败原子回滚
- **WHEN** 在一份一次性副本里预置已存在的 `chat_messages.attachments` 列使 `042` 中途失败，随后移除冲突对象重试
- **THEN** 失败时没有 `042` 的回执，此前的回执与数据不变；重试时恰应用一次

### Requirement: prompt 携带附件
`POST /api/sessions/:id/prompt` 的 body SHALL 可选携带 `attachments`（请求体的键集、`message` 的规则与受理、补偿流程见 chat-sessions「REST prompt 受理与补偿」）。`attachments` 缺席与 `[]` 等价（无附件）。**只发附件、不发文字是允许的**（owner 2026-10-06 改判）：`message` 去掉首尾空白后为空串时，只要 `attachments` 非空并通过下列全部条件，请求照常受理（202）；`message` 为空而无附件（缺席或 `[]`）仍是 400 `bad_request`；`message` 键在任何情况下都 SHALL 出现且为字符串。空文本带非空 `attachments` 时，请求的去留只由下列条件决定（各自的 400 / 403 / 404），不因文本为空而被拒。给出时 SHALL 依次满足下列条件，全部在 `acceptPrompt` 之前判定，任一不满足即按所注明的结果拒绝，不受理、不派发、不写消息行：

1. 形状：数组，元素个数不超过 `UPLOAD_MAX_FILES` 的生效值（它就是每条消息的附件总数上限）；每个元素是字符串，1 到 1024 个 UTF-8 字节，不含 U+0000–U+001F 与 U+007F，不得以 `/` 结尾（沙箱解析会跳过空路径段，这样的路径本可通过后面各条，却取不出文件名）；元素互不相同。否则 400 `bad_request`。
2. 非空的 `attachments` 要求会话绑定了工作空间（`workspace_id` 非 NULL）；否则 400 `bad_request`。
3. 文本经 `classifyPrompt` 判为内建命令（`builtin`）时不得带非空的 `attachments`；否则 400 `bad_request`。判为技能或普通文本的可以带。空串不以 `/` 开头，判为普通文本：只发附件的请求不触发本条，也不为它另设分类。
4. 每个元素按请求次序经沙箱 facade `resolve(principal, <会话的 workspace_id>, <元素>, "read")`：被拒绝的（越界、符号链接等）→ 403 `sandbox_denied`，并由 facade 写一条 `sandbox.reject` 审计（sandbox-core）；空间根不可见 → 404 `not_found`。
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
- **WHEN** 以 `attachments` 为 `"uploads/a.pdf"`、`[1]`、`[""]`、含换行的路径、以 `/` 结尾的路径 `uploads/a.pdf/`（该文件存在）、两个相同的路径、超过 `UPLOAD_MAX_FILES` 个路径、指向不存在文件的路径、指向目录的路径发 prompt；以及对未绑定工作空间的会话带一个路径发 prompt；以及以 `{message:"/todo", attachments:["uploads/a.pdf"]}` 发 prompt；以及以 `{message:"", attachments:[]}`、`{message:"   "}`（空文本而无附件）、`{attachments:["uploads/a.pdf"]}`（没有 `message` 键）、`{message:"", attachments:["uploads/不存在.pdf"]}` 发 prompt
- **THEN** 均为 400 `bad_request` 与 no-store；没有新的消息行，supervisor 未被调用，审计无新增
- **WHEN** 以 `{message:"", attachments:["uploads/a.pdf"]}` 发 prompt（空文本不是内建命令，第 3 条不适用）；另一例以 `{message:" /todo", attachments:["uploads/a.pdf"]}` 发 prompt（去掉首尾空白后是内建命令）
- **THEN** 前者 202；后者 400 `bad_request`——「内建命令不得带附件」不因允许空文本而放宽
- **WHEN** 以 `attachments:[]` 或不带该键发 prompt
- **THEN** 两者行为相同：202，用户消息的 `attachments` 列为 NULL，交给 supervisor 的文本没有后缀

#### Scenario: 越界附件被拒绝并入审计
- **WHEN** owner 以 `attachments:["../other/secret.txt"]`、以及指向空间内一个符号链接的路径发 prompt（各以 `message:"看看"` 与 `message:""` 发一次，结果相同）；第二个账号以第一个账号空间里文件的路径向自己的会话发 prompt
- **THEN** 前两者为 403 `sandbox_denied`，每次请求各恰新增一条 `sandbox.reject`（`detail.op="read"`、`detail.relPath` 为所给路径）；第三者的路径在它自己的空间里解析，目标不存在 → 400；三者都没有新的消息行、没有派发

### Requirement: 附件落库与快照
受理带附件的 prompt 时，`acceptPrompt` SHALL 在创建用户消息行的同一事务里把 `attachments` 列写为 JSON 数组文本，元素按请求次序恰为 `{path, size}`：`path` 是请求给出的相对路径原文，`size` 是校验那一刻该文件的字节数（非负安全整数）。无附件时该列为 NULL。助手消息的该列恒为 NULL。只发附件的消息 `content` 落库为空串——与有文字时同一条规则（存去掉首尾空白后的文本），不存 NULL、不存占位文字。`rollbackPrompt` 移除受理对时该行连同附件信息一并移除；附件所指的文件 SHALL NOT 因受理、补偿或消息行被删除而被删除，绑定正式工作空间的会话被删除时也不删除；它们作为工作空间里的普通文件，只在两种由别的条文规定的情形下随工作空间一起变化：会话用的是临时空间且它是最后一个引用该空间的会话时，删除该会话会删除整个临时空间目录（temporary-workspaces「共用与随最后一个会话删除」）；撤回并连文件一起还原时，工作空间回到被撤回消息受理那一刻的快照（workspace-snapshots「还原」）。
消息快照（`GET /api/sessions/:id/messages`）的每条消息 SHALL 带 `attachments` 键：存储为 NULL 时读作 `[]`，否则为上述数组；元素恰两键。存储值无法解析或不合规（只有带外改库可达）时读作 `[]`，不使快照请求失败，不改写该列。
快照里的附件是受理时的记录，SHALL NOT 在读取时重新核对文件是否仍然存在或大小是否变化。会话事件流 SHALL NOT 携带附件：用户消息不经事件送达。

#### Scenario: 快照带附件
- **WHEN** 上一要求的受理场景之后读取消息快照；随后文件 `uploads/a.pdf` 被删除，再读一次
- **THEN** 两次快照里该用户消息的 `attachments` 都是 `[{path:"uploads/a.pdf", size:3}]`，同一回合的助手消息与其它无附件消息的 `attachments` 为 `[]`；每条消息的键集恰为 chat-sessions「会话 REST」所列

#### Scenario: 补偿与坏值
- **WHEN** 带附件的 prompt 被受理后 supervisor 以 `agent_unavailable` 拒绝
- **THEN** 响应 502，受理对被移除，快照里没有那条用户消息；`uploads/a.pdf` 仍在磁盘上
- **WHEN** 测试带外把某条用户消息的 `attachments` 列写成 `not json`、`{}`、`[{"path":1}]`
- **THEN** 快照请求 200，该消息的 `attachments` 为 `[]`，列值未被改写

### Requirement: 交给 omp 的附件后缀
带附件的 prompt 交给 supervisor 的文本 SHALL 是 `toWireText(text, skills)`（chat-sessions「Slash 命令白名单与命令目录」）之后接上**附件后缀**；附件后缀由附件路径数组唯一确定，恰为：两个 U+000A；固定说明行 `用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：`；然后对每个路径按数组次序接一个 U+000A、`- `（连字符加一个空格）与该路径原文。末尾没有换行。无附件时后缀为空串，交给 supervisor 的文本与本 change 之前逐字节相同。文本为空串（只发附件）时不另写分支：`toWireText("", skills)` 仍是空串，交给 supervisor 的文本就是后缀本身，以两个 U+000A 开头。
后缀的构造 SHALL 只有一份实现（与 `toWireText` 同模块），受理路径与分支对齐（下一要求）共用它。落库的 `content`、`classifyPrompt` 的输入与 fork 的 `draft` SHALL 都是不含后缀的用户原文（只发附件时为空串）；标题的取材同样不含后缀：文本非空时取文本的前缀，文本为空串时取第一个附件的文件名的前缀（chat-sessions「会话持久化与回合刷盘」）。

#### Scenario: 后缀的确切字节
- **WHEN** 对路径数组 `["uploads/a.pdf","uploads/图 (1).png"]` 构造后缀；对空数组构造后缀
- **THEN** 前者恰为 `\n\n用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：\n- uploads/a.pdf\n- uploads/图 (1).png`；后者为空串

#### Scenario: 与斜杠规则的组合
- **WHEN** owner 分别以文本 `/skill:weekly-report 写周报`（已安装的技能）与 `/etc/hosts 是什么` 各带附件 `["uploads/a.pdf"]` 发 prompt（stub supervisor）
- **THEN** 前者交给 supervisor 的文本以 `/skill:weekly-report 写周报` 开头、后接附件后缀；后者以一个 U+0020 加 `/etc/hosts 是什么` 开头、后接同样的后缀；两者落库的 `content` 都是原文
- **WHEN** 以空文本带同一附件发 prompt
- **THEN** `classifyPrompt("")` 为 `text`、`toWireText` 原样返回空串；交给 supervisor 的文本恰等于「后缀的确切字节」对 `["uploads/a.pdf"]` 给出的字符串，前面没有转义空格

### Requirement: 重新生成与分叉中的附件
带附件的用户消息的 wire candidates（chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment）SHALL 是该消息文本的各个候选分别接上由其落库 `attachments` 的路径重新构造的附件后缀；无附件的消息候选不变。只发附件的消息（`content` 为空串）按同一条规则得到恰一个候选，即后缀本身；不为它另设比较方式。重新生成 SHALL 沿用 branch 返回的文本作为新回合的 prompt（它已含后缀），SHALL NOT 改动用户消息行及其 `attachments`。撤回（message-undo「对话原地回退」）的分支对位用同一份 wire candidates，所以带附件的消息及其之后的消息同样可以被对位；撤回响应带回被撤回消息里仍然存在的附件（message-undo「撤回 REST」）。
分叉 SHALL 把被拷贝的每条消息的 `attachments` 列原值（含 NULL）拷到新消息行。分叉点那条用户消息不被拷贝：fork 响应 SHALL 在 `session`、`draft` 之外带 `attachments`，为该消息落库的附件数组（无附件为 `[]`）；`draft` 仍是其文本原文——分叉点是只发附件的消息时 `draft` 为空串、`attachments` 非空。分叉 SHALL NOT 复制、移动或删除任何文件（新会话继承同一个工作空间，路径仍然有效）。

#### Scenario: 带附件回合的重新生成
- **WHEN** 一个会话的最后一个回合的用户消息为 `看看这个`、附件 `["uploads/a.pdf"]`，omp 的最后一个 `user` 条目文本是该文本加附件后缀（由 supervisor 测试所用的 runtime 替身给出该条目表），owner 调用 regenerate
- **THEN** 202；对齐成功（不是 502）；新回合的 prompt 文本等于 branch 返回的文本（含后缀）；用户消息行与其 `attachments` 不变
- **WHEN** 同一消息的 omp 条目文本只有 `看看这个`（没有后缀）
- **THEN** 该文本不是带附件消息的 wire candidate：502 `agent_unavailable`，行不变
- **WHEN** 最后一个回合的用户消息只有附件（`content` 为空串、附件 `["uploads/a.pdf"]`），omp 的最后一个 `user` 条目文本恰为附件后缀（以两个 U+000A 开头）；另一例该条目文本是去掉了开头两个换行的后缀
- **THEN** 前者 202、对齐成功，新回合的 prompt 文本等于 branch 返回的文本；后者 502 `agent_unavailable`，行不变（候选只有逐字节的后缀一项）

#### Scenario: 带附件消息的撤回对位
- **WHEN** 会话历史 u1（附件 `["uploads/a.pdf"]`）→a1→u2（无附件）→a2，各用户消息 `undo` 为 `available`，fake omp `branch` 场景的条目表里 u1 的条目文本是其原文加附件后缀、u2 的条目文本是其原文；所有者分别 undo u2 与 undo u1（`files:"keep"`）
- **THEN** 两次都 200（对位成功，不是 502），`branch` 的 `entryId` 分别是 u2 与 u1 的条目；undo u1 的响应 `draft` 为 u1 的原文（不含后缀）、`attachments` 为 `[{path:"uploads/a.pdf", size:<所存大小>}]`
- **WHEN** 同一会话而 u1 的条目文本没有后缀
- **THEN** undo u2 与 undo u1 都是 502 `agent_unavailable`，行不变
- **WHEN** 另一会话的 u1 只有附件（`content` 为空串、附件 `["uploads/a.pdf"]`，条目文本为后缀本身），所有者 undo u1（`files:"keep"`）
- **THEN** 200；`draft` 为 `""`，`attachments` 为 `[{path:"uploads/a.pdf", size:<所存大小>}]`

#### Scenario: 分叉拷贝与回填
- **WHEN** 一个四条消息的 `done` 会话，第一条用户消息带附件 `["uploads/a.pdf"]`、第二条用户消息带 `["uploads/b.png"]`，owner 在第二条用户消息处分叉
- **THEN** 201 的 body 恰含 `session`、`draft`、`attachments` 三键；`draft` 为第二条用户消息的文本，`attachments` 为 `[{path:"uploads/b.png", size:<受理时的大小>}]`；新会话的快照里被拷贝的第一条用户消息 `attachments` 为 `[{path:"uploads/a.pdf", …}]`，助手消息为 `[]`；`uploads/` 下的文件数与分叉前相同
- **WHEN** 在一条不带附件的用户消息处分叉
- **THEN** 响应的 `attachments` 为 `[]`
- **WHEN** 在一条只有附件的用户消息（`content` 为空串、附件 `["uploads/b.png"]`，其 omp 条目文本为后缀本身）处分叉
- **THEN** 201；`draft` 为 `""`，`attachments` 为 `[{path:"uploads/b.png", size:<受理时的大小>}]`；对位成功（不是 502）

### Requirement: 没有工作空间的会话
上传的目标是会话的工作空间，即会话视图的 `workspaceId`。临时空间是 `workspaces` 表里带标记的一行，与正式空间一样以这个 id 寻址（temporary-workspaces「临时空间的创建」「临时空间的可见性」），所以未选工作空间而得到临时空间的会话照常可以上传、可以带附件，web 不区分两者。`POST /api/sessions` 建出的会话总有工作空间（session-metadata「会话创建与空间绑定」）；`workspaceId` 为 null 的只有存量的未绑定会话。web SHALL 按下列规则处理没有工作空间的情形：

- 已选会话的 `workspaceId` 为 null：「+」菜单的 `上传文件` 项禁用，并在该项内显示 `此会话没有工作空间，无法上传文件`；向输入框拖入或粘贴文件时，输入框上显示同一句文字，文件被丢弃；两种情形都 SHALL NOT 发出任何请求，输入框里已有的文字不变。
- 欢迎态：可以选择文件（见「欢迎态暂存与首次发送」）。服务端不会再建出没有工作空间的会话，但 web 以建出的会话视图为准而不自行假定：首次发送建出的会话视图 `workspaceId` 为 null 且有待上传的附件时，SHALL NOT 上传、SHALL NOT 发 prompt，恢复草稿与附件标签，在输入框上显示同一句文字；新会话保持选中。

服务端对应的保证见「prompt 携带附件」第 2 条（未绑定会话带附件 → 400）与 workspaces「文件上传」（没有该空间 → 404；临时空间与正式空间同样可上传）。

#### Scenario: 未绑定会话没有上传目标
- **WHEN** 选中一个 `workspaceId` 为 null 的会话，草稿为 `半句`；打开「+」菜单；随后向输入框拖入一个文件；再粘贴一张截图
- **THEN** 菜单里的 `上传文件` 项处于禁用，并显示 `此会话没有工作空间，无法上传文件`；拖入与粘贴后输入框上显示同一句，没有附件标签；全程没有上传请求；草稿仍为 `半句`

#### Scenario: 欢迎态首次发送后发现没有空间
- **WHEN** 欢迎态未选工作空间，选了一个文件并输入 `看看`，发送；`createSession` 返回的视图 `workspaceId` 为 null
- **THEN** 恰一次 `createSession`，没有上传请求、没有 prompt；URL 选中新会话；输入框上显示 `此会话没有工作空间，无法上传文件`，草稿恢复为 `看看`，那个文件的标签仍在；`上传文件` 项随即处于禁用
- **WHEN** 同样的操作而 `createSession` 返回的视图 `workspaceId` 非 null、`temporaryWorkspace` 为 true（未选工作空间时服务端的实际结果）
- **THEN** 按「欢迎态暂存与首次发送」向该 `workspaceId` 上传并发送，与选了正式工作空间时的请求次序相同

### Requirement: 输入框附件标签
输入框 SHALL 在文本框上方、输入框容器之内渲染当前待发送消息的附件标签；这部分 SHALL 位于 `web/src/features/chat/` 的应用层文件内，不使用 assistant-ui runtime 的 attachments 适配器，不修改拷入文件。没有附件时该区域不渲染、不占位。附件标签的状态属于页面内存，SHALL NOT 持久化；切换会话或回到欢迎态时清空（已上传的文件留在工作空间里；在途与排队的上传见下文「移除」）。

**入口**（三者走同一个处理函数）：「+」菜单的 `上传文件`（打开系统的文件选择框，可多选）；把文件拖进输入框（拖拽经过时输入框容器带 `data-drop-active="true"`，离开或放下后去掉；拖入的不是文件时不处理）；在文本框里粘贴且剪贴板带文件（含截图）——只在剪贴板带文件时拦截粘贴，粘贴纯文字照常进入草稿。输入框锁定时三个入口都不接受文件。
**限制**（取 `options.upload`）：每条消息的附件总数上限为 `maxFiles`（与服务端对 prompt `attachments` 的上限是同一个数）——本次选入的文件数与已有标签数之和超过它 → 整批不接受，输入框上显示 `每条消息最多 <maxFiles> 个附件`；单个文件字节数超过 `maxBytes` → 该文件不接受，输入框上显示 `「<文件名>」超过大小上限`，同批其余文件照常。`options` 未取得时三个入口都不接受文件（`上传文件` 项禁用）。
**标签**：附件区是一个可访问名为 `附件` 的列表（`role="list"`），每个标签一项，按加入次序排列，显示文件名、大小与状态，并带一个可访问名为 `移除 <文件名>` 的按钮。状态为：`待上传`（仅欢迎态）；`上传中`，带 0 到 100 的整数百分比，并以 `role="progressbar"` 暴露；已上传（不显示状态字样）；`失败：<原因>`，原因为 `ApiError` 的 message（网络异常为 request_failed 的安全文案）。
**上传**：已选会话且 `workspaceId` 非 null 时，文件一被接受即开始上传：逐个调用 `uploadFile(workspaceId, file, {signal, onProgress})`（同一时刻至多一个在途，其余排队，状态为 `上传中 0%`）；成功后标签记下响应的 `path`、`name`、`size`，文件名显示为响应的 `name`（可能已被编号）。
**移除**：移除 `上传中` 的标签 SHALL 中止它的请求（排队中的直接撤掉）；移除已上传的标签 SHALL NOT 发出任何请求（文件留在工作空间里）；移除不影响其它标签。切换会话、回到欢迎态、换账号或页面卸载使标签清空时，与逐个移除同一语义：在途的那个上传请求 SHALL 被中止（`signal`），排队中的 SHALL 被撤掉、不再发出请求；此前已经传完的文件留在原会话的工作空间里。欢迎态首次发送的上传阶段（「欢迎态暂存与首次发送」第 3 步）进行中发生切换时同样处理：在途的中止、其余不再上传，SHALL NOT 发 prompt，迟到的上传响应与中止结果 SHALL NOT 改动切换后的界面（不恢复草稿、不显示错误）。
**发送**：任一标签处于 `上传中` 或 `失败` 时不可发送（`发送` 禁用，Enter 不提交）。标签处于已上传或 `待上传` 时称为**可发送状态**。`发送` 的启用条件 SHALL 是：草稿不是空白（去掉首尾空白后非空），或至少有一个附件标签且全部标签都处于可发送状态；其余禁用条件（有 `上传中` / `失败` 的标签、输入框锁定等）不变，Enter 与按钮同一判定。所以草稿为空白时只要带着已上传的附件就能发送（只发附件），没有附件时空白草稿仍不可发送。发送时 prompt 的 `message` 为原始草稿（只发附件时即空串或用户留下的空白，服务端去掉首尾空白后按空文本受理），并带上全部已上传标签的 `path`，按标签次序。prompt 被受理后标签清空，用户气泡显示这些附件（「用户气泡中的附件」）；prompt 未被受理时标签随草稿一起恢复。
分叉成功后，输入框的附件标签 SHALL 设为 fork 响应 `attachments` 所列的各项（已上传状态，文件名取路径的最后一段），与 `draft` 回填同时发生，不发送。撤回成功后同样：标签设为 undo 响应 `attachments` 所列的各项（服务端已略去不再存在的文件），覆盖已有标签（message-undo「web 撤回」）。

#### Scenario: 选择即上传
- **WHEN** 已选会话绑定工作空间 W、`options.upload` 为 `{maxBytes:1000, maxFiles:3}`；经 `上传文件` 选入 `a.pdf`（10 字节）与 `b.png`（20 字节）；`uploadFile` 对第一个依次报告 50%、100% 后返回 `{path:"uploads/a.pdf", name:"a.pdf", size:10}`，对第二个返回 `{path:"uploads/b (1).png", name:"b (1).png", size:20}`；随后输入 `看看` 并发送
- **THEN** 附件列表先后出现两项；第一个上传期间它显示 `上传中 50%` 且第二个尚未发出请求，`发送` 处于禁用；全部完成后两项显示 `a.pdf` 与 `b (1).png`、没有状态字样，`发送` 可用；prompt 恰一次，body 的 `attachments` 为 `["uploads/a.pdf","uploads/b (1).png"]`；受理后附件区消失

#### Scenario: 数量与大小限制
- **WHEN** 同一配置下已有两个标签，再选入两个文件；另一例一次选入 `ok.txt`（10 字节）与 `big.bin`（1001 字节）
- **THEN** 第一例两个新文件都没有成为标签，输入框上显示 `每条消息最多 3 个附件`，没有新的上传请求；第二例只有 `ok.txt` 成为标签并上传，输入框上显示 `「big.bin」超过大小上限`

#### Scenario: 失败、移除与取消
- **WHEN** `uploadFile` 对 `a.pdf` 以 413 信封 `文件超过大小上限` 失败；随后移除该标签；再选入 `c.zip`，在其 `上传中` 时点 `移除 c.zip`；最后移除一个已上传的标签
- **THEN** 失败的标签显示 `失败：文件超过大小上限`，此时 `发送` 禁用；移除后 `发送` 恢复（草稿非空，或仍有标签且都处于可发送状态时；草稿为空白且已没有标签时仍禁用）；移除 `c.zip` 时它的请求的 signal 被中止、标签消失；移除已上传的标签没有发出任何请求

#### Scenario: 拖入与粘贴
- **WHEN** 把两个文件拖到输入框上方再放下；在文本框里粘贴一张截图（剪贴板 `files` 含一个 `image.png`）；在文本框里粘贴一段纯文字；拖入一段被选中的文字
- **THEN** 拖拽经过时输入框容器带 `data-drop-active="true"`，放下后去掉且两个文件成为标签并上传；粘贴截图后多一个 `image.png` 标签，草稿没有因此多出文字；粘贴纯文字进入草稿，没有新标签；拖入文字不产生标签

#### Scenario: 发送被拒时恢复
- **WHEN** 带两个已上传标签发送，prompt 返回 409 `session_busy`
- **THEN** 输入框上显示信封文案，草稿与两个标签都恢复（仍为已上传状态），没有重新上传

#### Scenario: 只有附件时可发送
- **WHEN** 已选会话绑定工作空间 W，草稿为空；经 `上传文件` 选入 `a.pdf`，上传进行中；上传完成；随后按 Enter（另一例点 `发送`）
- **THEN** 没有标签时 `发送` 禁用；`上传中` 期间 `发送` 仍禁用、Enter 不提交；上传完成后 `发送` 可用；提交恰发出一次 prompt，body 恰为 `{"message":"","attachments":["uploads/a.pdf"]}`；受理后附件区消失，线程里出现一条只有附件列表的用户消息（「用户气泡中的附件」）
- **WHEN** 草稿为三个空格、带一个已上传标签时发送；另一例草稿为空、带一个已上传标签与一个 `失败` 标签；再一例草稿为空，移除了唯一的已上传标签
- **THEN** 第一例恰一次 prompt，`message` 为那三个空格、`attachments` 含该标签的 `path`；第二例 `发送` 禁用、Enter 不提交；第三例 `发送` 禁用
- **WHEN** 草稿为空、带两个已上传标签发送，prompt 返回 409 `session_busy`
- **THEN** 输入框上显示信封文案，草稿仍为空，两个标签恢复为已上传状态，`发送` 仍可用

#### Scenario: 切换会话清空标签
- **WHEN** 已有一个已上传的标签时切到另一个会话，再切回来
- **THEN** 两个会话的输入框都没有附件标签；没有发出删除文件的请求

#### Scenario: 上传中切换会话
- **WHEN** 已选会话里选入 `a.bin`、`b.bin`、`c.bin`，`a.bin` 已传完、`b.bin` 上传到 40% 时切到另一个会话（另一例：回到欢迎态）；随后 `b.bin` 的请求以中止结束
- **THEN** `b.bin` 的请求的 `signal` 被中止；`c.bin` 没有发出过上传请求；切换后的输入框没有附件标签、没有错误文字；没有发出删除文件的请求（`a.bin` 留在原会话的工作空间里）
- **WHEN** 欢迎态带两个待上传标签首次发送，第一个 `uploadFile` 在途时用户切到另一个已有会话
- **THEN** 在途请求的 `signal` 被中止，第二个文件没有上传请求，没有 prompt；切换后的会话的草稿与标签不受影响、没有错误文字；全程恰一次 `createSession`

### Requirement: 欢迎态暂存与首次发送
欢迎态没有会话，接受的文件 SHALL 只保存在浏览器内存里，标签状态为 `待上传`，SHALL NOT 发出任何请求；`待上传` 的标签不阻止发送，并且是可发送状态（「输入框附件标签」的发送条件）：草稿为空白时只要有 `待上传` 的标签也可以发送。带着待上传标签的首次发送 SHALL 按以下次序进行，任何一步失败即停在那一步：

1. 恰一次 `createSession`（既有规则，input 带所选工作空间、场景与输入框设置）。
2. 建出的会话视图 `workspaceId` 为 null → 按「没有工作空间的会话」处理，结束。
3. 按标签次序逐个 `uploadFile(<该 workspaceId>, file, …)`，标签依次显示 `上传中` 与完成；任何一个失败 → 不发 prompt；草稿恢复；已完成的标签保持已上传，失败的显示 `失败：<原因>`，其后尚未开始的保持 `待上传`；输入框上显示该失败的 message；新会话保持选中（零消息）。
4. 全部成功 → 恰一次 prompt，`attachments` 为各上传响应的 `path`（按标签次序）。

整个过程视为「提交进行中」：输入框锁定，显示 `生成中`。第 3 步失败后用户移除失败的标签（或重新选入文件）即可再次发送：此时会话已存在，按已选会话的规则处理（仍为 `待上传` 的标签在这次发送前先上传），SHALL NOT 再建会话，已上传的文件 SHALL NOT 重复上传。

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

### Requirement: 用户气泡中的附件
用户消息的气泡 SHALL 在文本下方列出该消息的附件（消息 `attachments` 非空时）：一个可访问名为 `附件` 的列表（`role="list"`），每项显示文件名（路径的最后一段）与大小，按数组次序；内容按纯文本呈现，SHALL NOT 是链接或按钮，不发出任何请求。无附件的用户消息与全部助手消息不渲染该列表。用户消息的文本为空（只发附件的消息：快照里 `content` 为空串；页面自己呈现的那条按发送时的草稿去掉首尾空白后判定）时，气泡 SHALL 只渲染附件列表，SHALL NOT 渲染空的文本块；消息的根元素、可访问名、`data-message-id` 与操作行（`撤回`、`从此处分叉`）照旧。
列表的数据来源：prompt 受理后页面自己呈现的那条用户消息带上发送时的附件（路径与大小取自标签）；加载历史与重新同步后来自快照。两种来源 SHALL 呈现相同的结果。用户气泡的文本、空白保留与操作行规则（chat-web「消息线程」）不变；交给 omp 的附件后缀 SHALL NOT 出现在气泡里。

#### Scenario: 受理后与刷新后一致
- **WHEN** 带附件 `uploads/a.pdf`（10 字节）与 `uploads/子目录/图 (1).png`（2048 字节）发送 `看看` 并被受理；随后刷新页面
- **THEN** 两次都是：用户气泡的文本为 `看看`（不含 `用户随本条消息上传了以下文件`），其下有名为 `附件` 的列表，恰两项，依次含 `a.pdf` 与 `图 (1).png` 及各自的大小；列表项内没有链接与按钮

#### Scenario: 无附件不渲染
- **WHEN** 线程里有一条不带附件的用户消息与一条助手消息
- **THEN** 两条消息内都没有名为 `附件` 的列表

#### Scenario: 只有附件的气泡
- **WHEN** 草稿为两个空格、带附件 `uploads/a.pdf`（10 字节）发送并被受理；随后刷新页面（快照里该消息 `content` 为 `""`、`attachments` 为 `[{path:"uploads/a.pdf", size:10}]`）
- **THEN** 两次都是：该用户消息的根元素是可访问名为 `用户` 的 `article`，气泡内有名为 `附件` 的列表且恰一项 `a.pdf`，没有文本块（气泡内除列表外没有其它文本节点，也没有只含空白的段落）；操作行照常渲染（`撤回` 在 `从此处分叉` 之前）；对话内搜索输入 `a.pdf` 时这条消息不计入匹配（搜索只看 `content`，conversation-search）
