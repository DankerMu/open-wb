## MODIFIED Requirements

### Requirement: prompt 引用知识库
`POST /api/sessions/:id/prompt` 的 body SHALL 可选携带 `knowledgeBases`（键集规则见 chat-sessions「REST prompt 受理与补偿」）。缺省与 `[]` 是同一个请求。它只是给模型的提示，不限制 `kb_search` 能检索哪些库（knowledge-bases「会话检索 `kb_search`」）。

**判定**：在附件的判定（「prompt 携带附件」）之后、受理之前进行。
- `knowledgeBases` 须为数组，元素为非空字符串、互不相同，至多 5 个，否则 400 `bad_request`。
- 文本经 `classifyPrompt` 判为内建命令（`builtin`）时不得带非空的 `knowledgeBases`，否则 400 `bad_request`（与「prompt 携带附件」第 3 条同一规则）；这一条在可见判定之前。
- 每个元素须是对调用者可见的知识库 id（knowledge-bases「可见范围判定」），否则 404 `not_found`。不存在、不可见与知识库关闭三种情形不可区分。
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
- **WHEN** 以不存在的 id、另一账号范围为 `me`（对调用者不可见）的库 id 发 prompt；另一例知识库关闭时以任意 id 发 prompt
- **THEN** 三次都是 404 `not_found`，body 相同，没有新增行，假 RAGFlow 没有收到请求
- **WHEN** 以 `{message:"  ", knowledgeBases:["k1"]}` 发 prompt
- **THEN** 400 `bad_request`
- **WHEN** 以 `{message:"/compact", knowledgeBases:["k1"]}`、`{message:" /todo", knowledgeBases:["k1"]}`、`{message:"/compact", knowledgeBases:["nope"]}` 发 prompt
- **THEN** 三次都是 400 `bad_request`（第三次不是 404：内建命令的判定在可见判定之前）；没有新增行，supervisor 未被调用
- **WHEN** 以 `{message:"/compact"}` 与 `{message:"/compact", knowledgeBases:[]}` 发 prompt
- **THEN** 两次都照常受理

#### Scenario: 坏值
- **WHEN** 测试带外把某条用户消息的 `knowledge_bases` 写成 `not json`、`[{"id":"k1"}]`、`[{"id":"k1","name":"x","extra":1}]`
- **THEN** 快照请求 200，该消息的 `knowledgeBases` 为 `[]`，列值未被改写

#### Scenario: 引用共享给自己的库
- **WHEN** u1 的库 K 为 `scope:"all"`、库 P 为 `scope:"me"`；u2 以 `{message:"查一下", knowledgeBases:["K"]}` 发 prompt；再以 `knowledgeBases:["P"]` 发 prompt
- **THEN** 第一次 202，该用户消息的 `knowledge_bases` 为 `[{"id":"K","name":"<K 的名称>"}]`；第二次 404 `not_found`，body 与不存在的 id 相同
- **WHEN** u1 随后把 K 改为 `scope:"me"`，u2 读快照
- **THEN** 那条消息的 `knowledgeBases` 仍是 `[{id:"K", name:<K 的名称>}]`（快照不重新校验）

### Requirement: 输入框知识库引用
知识库开启时（`GET /api/kb/status` 的 `enabled` 为真），输入框「+」菜单 SHALL 在 `上传文件` 之后（没有该项时在最前）有一项 `引用知识库…`；知识库关闭或状态未取得时没有这一项。
- **选择**：
  - 选中它打开一个可访问名为 `引用知识库` 的选择列表，列出 `listKnowledgeBases` 返回的全部库（名称；`owned` 为假的库附 `（<所有者账号>）`；非 `ready` 的库附状态字样，同样可选），次序同该应答。
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

#### Scenario: 共享库附所有者
- **WHEN** `listKnowledgeBases` 返回自有库 `产品文档` 与共享库 `规范库`（`owned:false`，所有者账号 `zhangsan`），用户打开选择列表
- **THEN** 两项依次为 `产品文档` 与 `规范库（zhangsan）`，都可选

#### Scenario: 内建命令带引用被拒
- **WHEN** 引用了 `产品文档`，草稿为 `/compact`，点 `发送`，prompt 返回 400 `bad_request`
- **THEN** 引用标签保留，显示拒绝的 message；与内建命令带附件被拒时的呈现相同
