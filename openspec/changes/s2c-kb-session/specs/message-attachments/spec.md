## MODIFIED Requirements

### Requirement: 交给 omp 的附件后缀
带附件或知识库引用的 prompt 交给 supervisor 的文本 SHALL 是 `toWireText(text, skills)`（chat-sessions「Slash 命令白名单与命令目录」）之后接上**附件后缀**；附件后缀由附件路径数组与知识库引用数组（「prompt 引用知识库」）唯一确定，是**附件段**与**引用段**依次拼接。附件段恰为：两个 U+000A；固定说明行 `用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：`；然后对每个路径按数组次序接一个 U+000A、`- `（连字符加一个空格）与该路径原文。附件段末尾没有换行，无附件时为空串。引用段恰为：两个 U+000A；固定说明行 `用户在本条消息中引用了以下知识库，可以用 kb_search 检索：`；然后对每项按数组次序接一个 U+000A、`- `、该项的 `name`、`（`（U+FF08）、该项的 `id` 与 `）`（U+FF09）。引用段末尾没有换行，无引用时为空串。没有引用时后缀与 change `s2c-kb-session` 之前逐字节相同；附件与引用都没有时后缀为空串，交给 supervisor 的文本与本要求最初引入之前逐字节相同。文本为空串（只发附件）时不另写分支：`toWireText("", skills)` 仍是空串，交给 supervisor 的文本就是后缀本身，以两个 U+000A 开头。
后缀的构造 SHALL 只有一份实现（与 `toWireText` 同模块），受理路径与分支对齐（下一要求）共用它。落库的 `content`、`classifyPrompt` 的输入与 fork 的 `draft` SHALL 都是不含后缀的用户原文（只发附件时为空串）；标题的取材同样不含后缀：文本非空时取文本的前缀，文本为空串时取第一个附件的文件名的前缀（chat-sessions「会话持久化与回合刷盘」）。

#### Scenario: 后缀的确切字节
- **WHEN** 对路径数组 `["uploads/a.pdf","uploads/图 (1).png"]` 构造后缀；对空数组构造后缀
- **THEN** 前者恰为 `\n\n用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：\n- uploads/a.pdf\n- uploads/图 (1).png`；后者为空串

#### Scenario: 与斜杠规则的组合
- **WHEN** owner 分别以文本 `/skill:weekly-report 写周报`（已安装的技能）与 `/etc/hosts 是什么` 各带附件 `["uploads/a.pdf"]` 发 prompt（stub supervisor）
- **THEN** 前者交给 supervisor 的文本以 `/skill:weekly-report 写周报` 开头、后接附件后缀；后者以一个 U+0020 加 `/etc/hosts 是什么` 开头、后接同样的后缀；两者落库的 `content` 都是原文
- **WHEN** 以空文本带同一附件发 prompt
- **THEN** `classifyPrompt("")` 为 `text`、`toWireText` 原样返回空串；交给 supervisor 的文本恰等于「后缀的确切字节」对 `["uploads/a.pdf"]` 给出的字符串，前面没有转义空格

#### Scenario: 带知识库引用的后缀
- **WHEN** 对路径数组 `["uploads/a.pdf"]` 与引用 `[{id:"k1",name:"产品文档"}]` 构造后缀；对空路径数组与同一引用构造后缀
- **THEN** 前者恰为 `\n\n用户随本条消息上传了以下文件（相对当前工作目录的路径），需要时请读取：\n- uploads/a.pdf\n\n用户在本条消息中引用了以下知识库，可以用 kb_search 检索：\n- 产品文档（k1）`；后者恰为 `\n\n用户在本条消息中引用了以下知识库，可以用 kb_search 检索：\n- 产品文档（k1）`
- **WHEN** 以文本 `查一下工单超时`、无附件、引用 `["k1"]` 发 prompt（stub supervisor）
- **THEN** 交给 supervisor 的文本恰为 `查一下工单超时` 接上后者；落库的 `content` 为 `查一下工单超时`

### Requirement: 重新生成与分叉中的附件
带附件或知识库引用的用户消息的 wire candidates（chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment）SHALL 是该消息文本的各个候选分别接上由其落库 `attachments` 的路径与落库 `knowledge_bases` 的快照（「prompt 引用知识库」）重新构造的附件后缀；两者都没有的消息候选不变。引用快照里的名称是受理时的名称，所以对位不受此后库表的任何变化影响（库被删除同样如此）。只发附件的消息（`content` 为空串）按同一条规则得到恰一个候选，即后缀本身；不为它另设比较方式。重新生成 SHALL 沿用 branch 返回的文本作为新回合的 prompt（它已含后缀），SHALL NOT 改动用户消息行及其 `attachments`。撤回（message-undo「对话原地回退」）的分支对位用同一份 wire candidates，所以带附件的消息及其之后的消息同样可以被对位；撤回响应带回被撤回消息里仍然存在的附件（message-undo「撤回 REST」）。
分叉 SHALL 把被拷贝的每条消息的 `attachments` 列与 `knowledge_bases` 列原值（含 NULL）拷到新消息行。fork 与撤回的响应 SHALL NOT 带知识库引用：分叉点与被撤回消息的引用不回填到草稿。分叉点那条用户消息不被拷贝：fork 响应 SHALL 在 `session`、`draft` 之外带 `attachments`，为该消息落库的附件数组（无附件为 `[]`）；`draft` 仍是其文本原文——分叉点是只发附件的消息时 `draft` 为空串、`attachments` 非空。分叉 SHALL NOT 复制、移动或删除任何文件（新会话继承同一个工作空间，路径仍然有效）。

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

#### Scenario: 带知识库引用回合的对位
- **WHEN** 最后一个回合的用户消息为 `查一下`、无附件、引用快照 `[{id:"k1",name:"产品文档"}]`，omp 的最后一个 `user` 条目文本是该文本加引用段，随后库 k1 被删除，owner 调用 regenerate
- **THEN** 202，对齐成功；新回合的 prompt 文本等于 branch 返回的文本
- **WHEN** 同一消息的 omp 条目文本只有 `查一下`
- **THEN** 502 `agent_unavailable`，行不变

#### Scenario: 分叉拷贝引用
- **WHEN** 第一条用户消息带引用 `[{id:"k1",name:"产品文档"}]`，owner 在第二条用户消息处分叉
- **THEN** 新会话快照里被拷贝的第一条用户消息 `knowledgeBases` 为 `[{id:"k1",name:"产品文档"}]`；201 的 body 仍恰含 `session`、`draft`、`attachments` 三键

## ADDED Requirements

### Requirement: 迁移 052 知识库引用列
迁移 `052_chat_message_knowledge_bases.sql` SHALL 在既有 runner 持有的事务内执行，回执紧随 `051` 之后追加。它 SHALL 只用 `ALTER TABLE … ADD COLUMN` 给 `chat_messages` 增加恰一个可空、无缺省、不带 CHECK 的列 `knowledge_bases TEXT NULL`（迁移 042 的先例；内容规则见「prompt 引用知识库」）。

既有行的全部原有列值、外键、级联、索引与 `sqlite_sequence` 值 SHALL 不变，新列读作 NULL，没有回填。更早的迁移文件 SHALL NOT 被编辑；受信任迁移目录计数断言 SHALL 随之加一。

#### Scenario: 新库与存量库
- **WHEN** `openDb` 打开一个新库；另一例打开一个回执止于 `051`、含消息的文件库
- **THEN** 回执里 `052` 恰出现一次且紧随 `051`；`chat_messages.knowledge_bases` 存在、可空、无缺省；存量库每条消息的原有列值与行数不变、新列读作 NULL；`PRAGMA foreign_key_check` 为空

#### Scenario: 中途失败原子回滚
- **WHEN** 在一份一次性副本里预置已存在的 `chat_messages.knowledge_bases` 列使 `052` 中途失败，随后移除冲突对象重试
- **THEN** 失败时没有 `052` 的回执，此前的回执与数据不变；重试时恰应用一次

### Requirement: prompt 引用知识库
`POST /api/sessions/:id/prompt` 的 body SHALL 可选携带 `knowledgeBases`（键集规则见 chat-sessions「REST prompt 受理与补偿」）。缺省与 `[]` 是同一个请求。它只是给模型的提示，不限制 `kb_search` 能检索哪些库（knowledge-bases「会话检索 `kb_search`」）。

**判定**：在附件的判定（「prompt 携带附件」）之后、受理之前进行。
- `knowledgeBases` 须为数组，元素为非空字符串、互不相同，至多 5 个，否则 400 `bad_request`。
- 每个元素须是调用者拥有的知识库 id，否则 404 `not_found`。不存在、属于别人与知识库关闭三种情形不可区分。
- 判定不访问 RAGFlow，不写审计。
- 引用不放宽空文本规则：去掉首尾空白后为空的文本仍须带非空的 `attachments`。

**落库**：受理时 SHALL 在创建用户消息行的同一事务里把 `knowledge_bases` 列写为紧凑 JSON 数组，元素按请求次序恰为 `{id, name}`，`name` 为受理那一刻该库的本地名称。无引用时该列为 NULL；助手消息恒为 NULL。补偿移除受理对时，该行连同引用一并移除。

**快照**：消息快照的每条消息 SHALL 带 `knowledgeBases` 键：
- 存储为 NULL 时读作 `[]`，否则为上述数组，元素恰两键。
- 存储值无法解析，或任何一项不合规（只有带外改库可达）时，整列读作 `[]`，不使快照请求失败，不改写该列。
- 快照里的引用是受理时的记录，SHALL NOT 在读取时核对库是否仍然存在。
- 会话事件流 SHALL NOT 携带引用。

#### Scenario: 受理与快照
- **WHEN** 所有者有库 k1（`产品文档`），以 `{message:"查一下", knowledgeBases:["k1"]}` 发 prompt；随后删除 k1，再读快照
- **THEN** 202；两次快照里该用户消息的 `knowledgeBases` 都是 `[{id:"k1",name:"产品文档"}]`，助手消息与其它消息为 `[]`

#### Scenario: 拒绝
- **WHEN** 依次以 `knowledgeBases` 为 `"k1"`、`[1]`、`[""]`、`["k1","k1"]`、六个 id 发 prompt
- **THEN** 五次都是 400 `bad_request`，没有新增行
- **WHEN** 以不存在的 id、另一账号的库 id 发 prompt；另一例知识库关闭时以任意 id 发 prompt
- **THEN** 三次都是 404 `not_found`，body 相同，没有新增行，假 RAGFlow 没有收到请求
- **WHEN** 以 `{message:"  ", knowledgeBases:["k1"]}` 发 prompt
- **THEN** 400 `bad_request`

#### Scenario: 坏值
- **WHEN** 测试带外把某条用户消息的 `knowledge_bases` 写成 `not json`、`[{"id":"k1"}]`、`[{"id":"k1","name":"x","extra":1}]`
- **THEN** 快照请求 200，该消息的 `knowledgeBases` 为 `[]`，列值未被改写

### Requirement: 输入框知识库引用
知识库开启时（`GET /api/kb/status` 的 `enabled` 为真），输入框「+」菜单 SHALL 在 `上传文件` 之后（没有该项时在最前）有一项 `引用知识库…`；知识库关闭或状态未取得时没有这一项。
- **选择**：
  - 选中它打开一个可访问名为 `引用知识库` 的选择列表，列出 `listKnowledgeBases` 返回的全部库（名称；非 `ready` 的库附状态字样，同样可选）。
  - 已引用的库显示为已选，再选一次即取消。
  - 引用总数达到 5 时，其余项禁用。
  - 列表取得失败时显示该失败的 message，不改动已有引用。
- **标签**：
  - 引用标签区是一个可访问名为 `引用的知识库` 的列表（`role="list"`），与附件标签区同在文本框上方、输入框容器之内。
  - 每项显示库名，带可访问名为 `移除 <库名>` 的按钮，按加入次序排列。
  - 没有引用时该区域不渲染、不占位。
  - 引用状态属于页面内存，SHALL NOT 持久化；切换会话、回到欢迎态或换账号时清空。
  - 分叉或撤回回填草稿时也清空（fork 与撤回的响应不带引用）。
- **发送**：
  - 引用不改变 `发送` 的启用条件（「输入框附件标签」）：空白草稿只带引用不可发送。
  - 发送时 prompt body 在引用非空时带 `knowledgeBases`（按标签次序的 id），为空时省略该键。
  - 受理成功后清空引用；被拒绝时保留，并显示拒绝的 message。
- **欢迎态**：引用同样可以暂存；首次发送的那一次 prompt（「欢迎态暂存与首次发送」第 4 步，或没有待上传标签时的唯一一次 prompt）带上暂存的引用。

#### Scenario: 引用并发送
- **WHEN** 知识库开启，所有者有库 `产品文档`、`客服问答`，在已选会话里打开「+」菜单选 `引用知识库…`，选 `产品文档`，输入 `查一下` 发送
- **THEN** `引用的知识库` 列表一项 `产品文档`；prompt body 恰为 `{message:"查一下", knowledgeBases:["<产品文档的 id>"]}`；受理后列表消失

#### Scenario: 关闭时没有入口
- **WHEN** `GET /api/kb/status` 回 `{enabled:false}`
- **THEN** 「+」菜单没有 `引用知识库…`

#### Scenario: 空白草稿与上限
- **WHEN** 草稿为空白，只有一个引用标签
- **THEN** `发送` 禁用
- **WHEN** 已引用 5 个库
- **THEN** 选择列表里其余项禁用

#### Scenario: 欢迎态暂存
- **WHEN** 欢迎态引用 `产品文档` 并发送 `查一下`
- **THEN** 恰一次 `createSession`、恰一次 prompt，prompt body 带 `knowledgeBases:["<产品文档的 id>"]`

### Requirement: 用户气泡中的知识库引用
用户消息的气泡 SHALL 在文本（与附件列表，「用户气泡中的附件」）下方列出该消息引用的知识库（消息 `knowledgeBases` 非空时）：
- 一个可访问名为 `引用的知识库` 的列表（`role="list"`），每项显示库名，按数组次序。
- 纯文本呈现，SHALL NOT 是链接或按钮，不发出任何请求。
- 无引用的用户消息与全部助手消息不渲染该列表。

数据来源与附件相同：受理后页面自己呈现的那条用户消息带上发送时的引用，加载历史与重新同步后来自快照，两种来源呈现相同的结果。引用段 SHALL NOT 出现在气泡文本里。

#### Scenario: 受理后与刷新后一致
- **WHEN** 发送 `查一下` 并引用 `产品文档`，受理后看气泡；随后刷新页面再看
- **THEN** 两次气泡都有 `引用的知识库` 列表，恰一项 `产品文档`；气泡文本为 `查一下`，不含 `kb_search`
