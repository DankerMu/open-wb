## ADDED Requirements

### Requirement: 迁移 050 知识库 schema
`server/src/core/db/migrations/050_knowledge_bases.sql` SHALL 建三张表，并只插入一行数据。

**`kb_settings`**：迁移插入 `id = 'kb'` 的唯一一行。列：
- `id TEXT NOT NULL PRIMARY KEY CHECK (id = 'kb')`。
- `embedding_name`、`embedding_base_url`、`embedding_api_key`：三列同为 NULL 或同为非 NULL。
- `embedding_generation INTEGER NOT NULL DEFAULT 0`。
- `embedding_probe_status TEXT NOT NULL DEFAULT 'never' CHECK (… IN ('never','ok','failed'))`、`embedding_probe_at INTEGER NULL`、`embedding_probe_message TEXT NULL`。
- `chat_model_id TEXT NULL REFERENCES models(id) ON DELETE SET NULL`。
- `rebuild_actor_id TEXT NULL REFERENCES accounts(id)`：最近一次发起或重试重建的管理员。
- `updated_at INTEGER NOT NULL`。

**`knowledge_bases`**：
- `id`：32 位小写十六进制。
- `owner_id REFERENCES accounts(id) ON DELETE RESTRICT`。
- `name`：1–64 码点，无 C0 / DEL。
- `template`：十二种模板之一。
- `raptor`、`graph`：0 或 1。
- `dataset_id TEXT NOT NULL`、`rebuild_dataset_id TEXT NULL`。
- `embedding_generation INTEGER NOT NULL`。
- `state`：`ready` / `rebuilding` / `rebuild_failed`；`state_message TEXT NULL`。
- `created_at`、`updated_at`。
- `UNIQUE (owner_id, name)`。

**`kb_documents`**：
- `id`、`kb_id REFERENCES knowledge_bases(id) ON DELETE CASCADE`。
- `ragflow_document_id TEXT NOT NULL`、`name`、`size INTEGER NOT NULL`。
- `source`：`workspace` / `upload`。
- `workspace_id TEXT NULL`、`source_path TEXT NULL`、`source_mtime_ms INTEGER NULL`；`(source = 'workspace')` 与这三列均非 NULL 等价。
- `created_at`。
- `UNIQUE (kb_id, workspace_id, source_path)`。

迁移 SHALL NOT 改任何既有表；`server/test/core-db-helpers.ts` 的跟踪清单 SHALL 加入 `MIGRATION_050`。

#### Scenario: 约束
- **WHEN** 在迁移后的库里依次：插第二行 `kb_settings`；插 `template = 'audio'` 的知识库；插 `source = 'upload'` 而 `source_path` 非空的文档；同一账号插两个同名知识库；删除一个被 `kb_settings.chat_model_id` 引用的模型行
- **THEN** 前四次插入都被约束拒绝；删除成功，`chat_model_id` 变为 NULL

### Requirement: 同一知识库的写操作串行
`kb` 模块 SHALL 为每个知识库持有一把进程内写锁。持锁范围：
- 工作空间入库（整批）、本地上传、重新入库、移出文档、删库，各在整个操作期间持有该库的锁。
- 重建器在重建该库期间持有它的锁。

写操作 SHALL 在取得锁之后重新判定该库是否存在、`state` 是否允许本操作。锁正被重建器持有时，写操作不等待，立即 409 `kb_rebuilding`。

结果：
- 同一知识库上不存在并发的上传与切换。
- 每个文档行都指向该库当前 `dataset_id` 里的 RAGFlow 文档。

#### Scenario: 上传与确认重建交错
- **WHEN** 一次本地上传已通过状态判定，假 RAGFlow 挂起该上传；此时管理员带 `confirmRebuild:true` 换嵌入模型；随后假 RAGFlow 放行上传
- **THEN** 上传得 201；重建器在上传完成之后才枚举该库的文档，新数据集里含这份文档；重建完成后，该库每一行的 RAGFlow 文档 id 都属于新数据集，旧数据集已删除

#### Scenario: 同一路径并发入库
- **WHEN** 两个请求并发把同一 `(workspaceId, path)` 入库到同一知识库
- **THEN** 一个请求的 `documents` 含该文档；另一个的 `rejected` 含该路径，`reason` 为 `duplicate`；假 RAGFlow 恰收到一次上传

#### Scenario: 入库中删库
- **WHEN** 一批入库进行中（假 RAGFlow 挂起第一份上传），所有者删除该知识库，然后假 RAGFlow 放行
- **THEN** 删除在入库结束之后才执行，得 204；结束后库与文档行都不在，假 RAGFlow 收到的删数据集请求在上传之后

### Requirement: 知识库端点
知识库开启后，已登录用户 SHALL 能管理自己的知识库。别人的或不存在的 id 一律 404 `not_found`，不可探测。全部应答带 no-store。

**视图** `BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`：
- `documents`：本地文档行数。
- `compile`：
  - 两个开关都为 0 的库：恒为 `{raptor:"off", graph:"off"}`，不发出站请求。
  - 其余的库：按需从 RAGFlow 的编译状态接口读取，为 `{raptor, graph}`，各取 `off` / `pending` / `running` / `done` / `failed`。

**`GET /api/kb/bases`**：200 `{bases: BaseView[]}`，按 `created_at` 升序。
- 列表只依赖本地行。
- 各库的编译状态读取并发发出，共用一个 5 s 总期限；没有在期限内读到的库 `compile` 为 `null`。
- RAGFlow 不可达时列表照常 200。

**`POST /api/kb/bases`**：body 键集为 `name`、`template`、`raptor?`、`graph?`。依次判定：
1. 键集、类型、名称或模板不合规：400 `bad_request`。
2. 嵌入模型未就绪：409 `kb_not_ready`。
3. 开关对该模板不可用，或开关为真而知识库对话模型未指定：400 `bad_request`。开关可用表：RAPTOR 只对 `qa`、`manual`、`paper`、`book`、`laws`、`presentation`；知识图谱对 `tag` 之外的十一种。两张表都须经实测记录核对，不符时先修订本 change。
4. 同账号重名：409 `conflict`。已有 50 个知识库：409 `kb_limit`。

建库在进程级设置锁下进行：
1. 先在 RAGFlow 建名为 `owb-<id>-g<当前嵌入代数>` 的数据集，带模板、开关与当前嵌入模型。
2. 成功后插行，并在同一事务里审计 `kb.create`；成功应答为 201 `BaseView`。
3. 插行失败 SHALL 删除刚建的数据集。

没有修改模板或开关的端点。

**`DELETE /api/kb/bases/:id`**：
- `state` 为 `rebuilding`：409 `kb_rebuilding`。
- 否则先删 RAGFlow 数据集：`rebuild_failed` 时两份数据集都删；不存在视为已删；不可达时 503，行不动。
- 再删行（文档行级联），并审计 `kb.delete`，应答 204。

#### Scenario: 建库与列表隔离
- **WHEN** 用户 A 建 `规范库`（`manual`，`raptor:true`，知识库对话模型已指定）；用户 B 请求列表，并 `DELETE` A 的库 id
- **THEN** A 得 201 `BaseView`，假 RAGFlow 收到建数据集请求，名为 `owb-<id>-g0` 且带 RAPTOR 配置；B 的列表为 `{bases:[]}`，`DELETE` 为 404 `not_found`，假 RAGFlow 没有收到删除请求

#### Scenario: 开关校验
- **WHEN** 建 `table` 模板并带 `raptor:true`；未指定知识库对话模型时建 `manual` 并带 `graph:true`；嵌入模型未配置时建任意库
- **THEN** 前两次 400 `bad_request`，第三次 409 `kb_not_ready`；三次都没有出站请求

#### Scenario: 删库
- **WHEN** 删除一个有两份文档的知识库；另一次删除时假 RAGFlow 不可达
- **THEN** 第一次 204，假 RAGFlow 收到一次删数据集请求，库与文档行都不在，恰一条 `kb.delete`；第二次 503 `kb_unavailable`，行仍在

#### Scenario: 编译状态读取有界
- **WHEN** 列表里有三个开了 RAPTOR 的库和一个两开关都为 0 的库，假 RAGFlow 挂起全部编译状态请求（总期限经装配注入缩短）
- **THEN** 列表在该期限后返回 200；三个库的 `compile` 为 `null`，第四个为 `{raptor:"off", graph:"off"}`

#### Scenario: 知识库数上限
- **WHEN** 一个账号已有 50 个知识库，再建第 51 个
- **THEN** 409 `kb_limit`，没有出站请求

### Requirement: 工作空间来源入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/documents` 把自己工作空间里的文件入库。

**请求**：body `{workspaceId, paths}`。
- `paths` 为 1 到 `KB_UPLOAD_MAX_FILES` 个相对路径；空数组或超出个数：400。
- `workspaceId` 不是当前用户可见的工作空间（别人的或已删除）：整个请求 404 `not_found`，不发出站请求。
- 知识库 `state` 不是 `ready`：整个请求 409 `kb_rebuilding`。

**逐条处理**：在该库的写锁下，每条路径依次经过以下步骤；被拒的条目以括号里的 `reason` 记录：
1. 经 `sandbox.resolve(principal, workspaceId, path, "read")` 解析。被拒为 `outside`；越界照常由 facade 写 `sandbox.reject`。路径上任一分量是符号链接时，`resolve` 拒绝，同样记为 `outside`。
2. 查重与计数：该库已有同一 `(workspaceId, path)`（`duplicate`）；该库已有 500 份文档（`limit`）。
3. 打开文件：挂载内经挂载读取，离线即被拒（`offline`）；挂载外以 `O_NOFOLLOW` 打开，不是普通文件即被拒（`not_file`）。之后对同一 fd 做 `fstat`，得到 `size` 与 `mtimeMs`。
4. 大小超过 `KB_UPLOAD_MAX_BYTES`（`too_large`）。
5. 以 multipart 流式上传到该库的数据集，不落临时文件；`Content-Length` 按 `fstat` 的大小计算。实际读出的字节数与之不符时：中止出站请求，删除 RAGFlow 上已建的文档，该条记为 `changed`。
6. 触发该文档的解析；实测记录要求显式触发编译、且该库开了 RAPTOR 或知识图谱时，再触发一次编译。
7. 在同一事务里插文档行，并审计 `kb.ingest`。

**RAGFlow 失败**：
- 上传或解析触发得到 `kb_rejected`：删除已建的文档，该条记为 `rejected`，继续处理下一条。
- 得到 `kb_unavailable`：删除已建的文档（尽力而为）；该条与其后全部条目都记为 `unavailable`，后续条目不再发请求。

**应答**：只要请求本身合法，即为 201 `{documents: DocumentView[], rejected: {path, reason, message}[]}`。`message` 按 `reason` 固定：

| `reason` | `message` |
|---|---|
| `outside` | `目标路径不在你的沙箱内` |
| `not_file` | `不是普通文件` |
| `too_large` | `文件超过大小上限` |
| `offline` | `挂载已离线` |
| `duplicate` | `已在知识库里` |
| `limit` | `知识库文档数已达上限` |
| `changed` | `读取期间文件发生了变化` |
| `rejected` | `知识库服务拒绝了这个文件` |
| `unavailable` | `知识库服务暂不可用` |

每个被拒的条目审计一条 `kb.ingest_reject`。只读挂载里的文件可以入库。

#### Scenario: 混合批次
- **WHEN** 一批路径依次为：普通文件 `a.md`、只读挂载 `docs/` 下的 `b.pdf`、`../x`、一个目录、一个超过上限的文件、已入库过的 `a.md`、一个以符号链接为分量的路径
- **THEN** 201；`documents` 为 `a.md` 与 `docs/b.pdf` 两条；`rejected` 五条，`reason` 依次为 `outside`、`not_file`、`too_large`、`duplicate`、`outside`；审计有五条 `kb.ingest_reject`、两条 `kb.ingest`、两条 `sandbox.reject`；假 RAGFlow 收到两次上传（字节与源文件一致）与两次解析触发

#### Scenario: 挂载离线
- **WHEN** 入库路径位于一个离线的挂载内
- **THEN** 该条以 `reason: offline` 被拒，没有上传请求

#### Scenario: 中途不可达
- **WHEN** 一批三个路径，假 RAGFlow 对第二份的上传应答 HTTP 503
- **THEN** 201；`documents` 只有第一份；第二、三份的 `reason` 都是 `unavailable`；假 RAGFlow 恰收到两次上传，没有第三次

#### Scenario: 逐条被拒
- **WHEN** 一批两个路径，假 RAGFlow 对第一份的上传应答 `code:101`
- **THEN** 第一份以 `reason: rejected` 被拒，第二份成功入库

#### Scenario: 读取期间文件变化
- **WHEN** 经测试缝让第一份文件在 `fstat` 之后、读完之前被追加了字节
- **THEN** 该条以 `reason: changed` 被拒；没有该文档行；假 RAGFlow 上为它建的文档已被删除

#### Scenario: 文档数上限
- **WHEN** 一个知识库已有 499 份文档，一批入库两个合规文件
- **THEN** 第一份成功；第二份以 `reason: limit` 被拒，没有为它发上传请求

#### Scenario: 别人的工作空间
- **WHEN** 用户把另一个账号的 `workspaceId` 用于入库
- **THEN** 404 `not_found`；假 RAGFlow 收到零个请求；没有 `kb.ingest_reject`

### Requirement: 本地上传入库
所有者 SHALL 能经 `POST /api/kb/bases/:id/uploads?name=<文件名>` 上传一个文件入库，请求体为 `application/octet-stream`。

**请求校验**：
- 文件名规则与 255 字节上限同工作空间上传。
- SHALL 带 `Content-Length`；缺失或分块传输：400 `bad_request`。
- `Content-Length` 超过 `KB_UPLOAD_MAX_BYTES`：413 `upload_too_large`，并审计 `kb.ingest_reject`（`reason: too_large`），不发出站请求。
- 知识库 `state` 不是 `ready`：409 `kb_rebuilding`。
- 该库已有 500 份文档：409 `kb_limit`，并审计 `kb.ingest_reject`（`reason: limit`）。

**处理**：在该库的写锁下进行。
1. 请求体直接拼进出站 multipart 上传；app-server 不落盘，不保留副本。
2. 客户端中途断开，或发送的字节少于 `Content-Length`：中止出站请求，删除 RAGFlow 上已建的文档；不插行，不写 `kb.ingest`。
3. 上传成功后，触发该文档的解析；实测记录要求显式触发编译、且该库开了 RAPTOR 或知识图谱时，再触发一次编译。
4. 解析触发失败：删除该文档，按「RAGFlow 出站请求」映射返回。
5. 都成功后，在同一事务里插行并审计 `kb.ingest`。

**成功应答**：201 `DocumentView`，其中 `source` 为 `upload`，`workspaceId` 与 `path` 为 `null`。

#### Scenario: 上传不落盘
- **WHEN** 上传一个 1 MiB 的文件
- **THEN** 201；假 RAGFlow 收到的文件字节与请求体一致，multipart 的 `Content-Length` 与实际字节数相等；上传期间与之后，`SANDBOX_ROOT`、`OMP_STATE_DIR` 与系统临时目录里都没有新增文件

#### Scenario: 超限与缺少长度
- **WHEN** 以 `KB_UPLOAD_MAX_BYTES + 1` 的 `Content-Length` 上传；另一次以分块传输、不带 `Content-Length` 上传
- **THEN** 第一次 413 `upload_too_large`，一条 `kb.ingest_reject`；第二次 400 `bad_request`；两次都没有出站请求

#### Scenario: 客户端中断
- **WHEN** 请求声明 1 MiB，发送 512 KiB 后断开连接
- **THEN** 出站上传被中止；没有文档行，没有 `kb.ingest`；假 RAGFlow 上没有留下这份文档

#### Scenario: 解析触发失败
- **WHEN** 上传成功，但假 RAGFlow 对解析触发应答 HTTP 503
- **THEN** 503 `kb_unavailable`；假 RAGFlow 收到删除该文档的请求；没有文档行

### Requirement: 文档列表与状态
所有者 SHALL 能经 `GET /api/kb/bases/:id/documents` 读文档列表，应答 200 `{documents: DocumentView[]}`，按 `created_at` 升序，带 no-store。
- 状态以 RAGFlow 为准，每次请求时读取：分页读取该数据集的全部文档，按 RAGFlow 文档 id 关联；不起后台轮询。
- 数据集本身为 not-found 时，全部文档为 `missing`。
- RAGFlow 不可达：503 `kb_unavailable`。

**视图** `DocumentView` 恰为 `{id, name, size, source, workspaceId, path, status, chunkCount, message, sourceChanged, createdAt}`：
- `status` 取 `queued` / `parsing` / `done` / `failed` / `cancelled` / `unparsed` / `missing`。
  - RAGFlow 运行状态到前六值的映射以实测记录为准；未开始解析为 `unparsed`。
  - RAGFlow 列表里没有该 id：`missing`。
- `chunkCount`：只在 `done` 时为数字，否则为 `null`。
- `message`：只在 `failed` 时为 `解析失败`，否则为 `null`。
- `sourceChanged`：
  - 只对工作空间来源计算，其它来源为 `null`。
  - 计算方式：经 core 的无审计解析（工作空间根加纯函数 `resolve`），再 stat 源路径；挂载内经挂载 stat。
  - 大小或修改时间与入库记录不同，或文件已不存在：`true`；相同：`false`。
  - 解析被拒、工作空间已不可见、挂载离线：`null`。

这次读取 SHALL NOT 写任何审计。

#### Scenario: 状态映射
- **WHEN** 假 RAGFlow 对四份文档分别报告：解析完成 12 个切片、解析中、失败、未开始；第五份本地记录在 RAGFlow 列表里不存在
- **THEN** 五条 `status` 依次为 `done`（`chunkCount: 12`）、`parsing`、`failed`（`message: "解析失败"`）、`unparsed`、`missing`

#### Scenario: 源文件变更
- **WHEN** 入库后改写工作空间里一份源文件；另一份的源文件被删除；第三份未动
- **THEN** 三条 `sourceChanged` 依次为 `true`、`true`、`false`；这次读取不产生审计记录

#### Scenario: 源路径变成符号链接
- **WHEN** 入库后把源文件所在目录换成指向它的符号链接，然后连续两次请求列表
- **THEN** 两次该条的 `sourceChanged` 都是 `null`；`audit_events` 里没有新增 `sandbox.reject`

### Requirement: 重新入库与移出
**重新入库**：所有者 SHALL 能经 `POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>` 重新入库一份工作空间来源的文档，在该库的写锁下进行。
- 知识库 `state` 不是 `ready`：409 `kb_rebuilding`。
- 本地上传的文档：400 `bad_request`。
- 按「工作空间来源入库」的规则重读源文件。读取被拒（含工作空间已不可见、`outside`、`not_file`、`offline`、`too_large`、`changed`、源文件不存在）：409 `kb_source_unreadable`，行不变。`outside` 仍由 facade 写 `sandbox.reject`。
- 读取成功：上传为新文档并触发解析（编译触发规则同入库）。
- 上传或解析触发失败：删除新文档，按映射返回，行不变。
- 成功：在单事务里更新该行的 RAGFlow 文档 id、`size` 与 `source_mtime_ms`，并审计 `kb.ingest`；再删除旧的 RAGFlow 文档，删除失败只写一行 `{"event":"kb_document_leak","documentId":<id>}`。应答 200 `DocumentView`。

**移出**：所有者 SHALL 能经 `DELETE /api/kb/bases/:id/documents?doc=<文档 id>` 移出文档，在该库的写锁下进行。
- 允许的 `state`：`ready` 与 `rebuild_failed`；`rebuilding` 时 409 `kb_rebuilding`。
- 先删 RAGFlow 文档：不存在视为已删；不可达时 503，行不变。
- 再删行，并审计 `kb.document_delete`，应答 204。源文件不动。

**两者共用的校验**：`doc` 缺失、为空或多值：400；文档不属于该库：404。

#### Scenario: 重新入库
- **WHEN** 源文件改写后对该文档重新入库
- **THEN** 200 返回新的 `DocumentView`（`sourceChanged: false`）；假 RAGFlow 依次收到上传、解析触发、删除旧文档

#### Scenario: 源不可读
- **WHEN** 源文件已被删除后对该文档重新入库
- **THEN** 409 `kb_source_unreadable`；该行不变；假 RAGFlow 没有收到上传

#### Scenario: 移出不动源文件
- **WHEN** 移出一份工作空间来源的文档
- **THEN** 204；工作空间里的源文件字节不变；恰一条 `kb.document_delete`

#### Scenario: 重建失败后移出
- **WHEN** 知识库处于 `rebuild_failed` 时移出其中一份文档；再对它请求重新入库
- **THEN** 移出 204，该行已删除；重新入库 409 `kb_rebuilding`

### Requirement: 知识库审计
知识库相关审计 SHALL 只用下表七种 kind。标题为中文短句；detail 的键集恰如下表，SHALL NOT 含密钥、文件内容或 RAGFlow 应答原文。

| kind | 时机 | detail |
|---|---|---|
| `kb.create` | 建库成功 | `{id, template, raptor, graph}` |
| `kb.delete` | 删库成功 | `{id}` |
| `kb.ingest` | 工作空间入库，每份文档一条 | `{id, source:"workspace", workspaceId, path, documentId}` |
| `kb.ingest` | 本地上传 | `{id, source:"upload", name, size, documentId}` |
| `kb.ingest` | 重新入库 | `{id, source:"workspace", reingest:true, documentId}` |
| `kb.ingest_reject` | 工作空间入库，每个被拒的条目一条 | `{id, source:"workspace", workspaceId, path, reason}` |
| `kb.ingest_reject` | 本地上传被拒 | `{id, source:"upload", name, reason}` |
| `kb.document_delete` | 移出成功 | `{id, documentId}` |
| `kb.settings` | 保存设置 | `{embedding?: <名称>, chatModelId?: string \| null}` |
| `kb.settings` | 探活 | `{probe: "ok" \| "failed"}` |
| `kb.rebuild` | 确认重建 | `{bases, documents}` |
| `kb.rebuild` | 重试 | `{bases, documents, retry:true}` |
| `kb.rebuild` | 单库结束 | `{id, result:"ok", skipped: string[]}` 或 `{id, result:"failed"}` |

规则：
- actor 为请求的 principal；重建器写的单库记录，actor 为 `kb_settings.rebuild_actor_id`。
- 工作空间来源的记录，`workspaceId` 列为该工作空间；其余为 null。
- 每条成功审计与它对应的那一次本地写入在同一事务内：一次写入一条审计。本地写入失败时不留审计。
- `kb.ingest_reject` 没有对应的本地写入，单独写入。

#### Scenario: detail 不含敏感内容
- **WHEN** 以内容含哨兵串的文件完成一次工作空间入库、一次本地上传、一次重新入库与一次移出，并以带密钥哨兵的 body 保存一次知识库模型设置
- **THEN** 全部审计行的 `title` 与 `detail` 都不含任一哨兵；各行的 detail 键集与上表一致

#### Scenario: 写入失败不留审计
- **WHEN** 经注入让文档行插入失败
- **THEN** 没有 `kb.ingest` 审计；假 RAGFlow 收到删除刚上传文档的请求

### Requirement: 中心「知识库」tab
`/center?tab=knowledge-bases` SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时对所有用户可见（见 model-registry「中心页外壳」），渲染当前用户的知识库。

**状态行**：
- `available:false`：页顶以 `role="alert"` 显示 `知识库服务暂不可用` 与 `重试` 按钮（重取状态与列表），其余控件不渲染。
- `embeddingReady:false`：显示 `管理员尚未配置知识库嵌入模型`，不渲染 `新建知识库`。

**列表**：
- 每个知识库一行：名称、模板中文名、`RAPTOR` / `知识图谱` 标签与其编译状态（`compile` 为 `null` 时显示 `状态未知`）、文档数、`重建中` / `重建失败` 标记。
- 点行进入详情。
- 没有知识库时显示空态 `还没有知识库`。

**`新建知识库` 对话框**：
- 字段：名称；模板（十二种，每项带 demo 的说明文案）；`RAPTOR` 与 `知识图谱` 复选，只在 `compileReady` 为真且所选模板支持时渲染。
- 提交恰调用一次 `createKnowledgeBase`；失败时在对话框内以 `role="alert"` 显示信封文案。

**详情**：
- **文档表**，每行：
  - 名称。
  - 来源：工作空间来源显示 `<空间名>/<路径>`，本地上传显示 `本地上传`。
  - 大小。
  - 状态：`排队中` / `解析中` / `已切片 N` / `解析失败` / `已取消` / `未解析` / `已丢失`。
  - `源文件已变更` 标记：只在 `sourceChanged` 为 `true` 时显示。
  - 每个工作空间来源的行都有 `重新入库` 按钮。
  - `移出`。
- **`从工作空间入库` 对话框**：选工作空间，逐级浏览目录树并勾选文件，至多 `uploadMaxFiles` 个；提交恰调用一次 `ingestFromWorkspace`；结果里被拒的条目逐条显示 `message`。
- **`上传文件`**：文件选择，一次至多 `uploadMaxFiles` 个；单个超过 `uploadMaxBytes` 在客户端就地拒绝；逐个调用 `uploadToKnowledgeBase`。
- **`删除知识库`**：先弹确认对话框。
- 知识库 `state` 不是 `ready` 时，入库、上传与重新入库按钮不渲染；`rebuild_failed` 时 `移出` 仍渲染，`rebuilding` 时不渲染。

**刷新**：详情里存在 `queued` / `parsing` 文档且页面可见时，每 3 秒重取文档列表；页面隐藏时停止。`unparsed` 不触发刷新。

**API 客户端** `web/src/lib/api-kb.ts` SHALL 按上面各端点的应答形状严格解析全部应答（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型与方法。

#### Scenario: 不可用与未就绪
- **WHEN** 状态为 `{enabled:true, available:false, …}` 时打开 tab；点 `重试` 后状态变为可用，但 `embeddingReady:false`
- **THEN** 先看到 `知识库服务暂不可用` 与 `重试`，没有 `新建知识库`；重试后看到 `管理员尚未配置知识库嵌入模型`，仍没有 `新建知识库`

#### Scenario: 解析中自动刷新
- **WHEN** 详情的第一次列表里有一份 `parsing`，第二次全部为 `done`
- **THEN** 3 秒后恰重取一次；之后不再重取；`已切片 N` 显示 RAGFlow 给出的切片数

#### Scenario: 编译开关按模板显示
- **WHEN** `compileReady:true` 时在新建对话框选 `manual`，再选 `table`；`compileReady:false` 时选 `manual`
- **THEN** 选 `manual` 时显示两个复选；选 `table` 时只显示 `知识图谱`；`compileReady:false` 时两个都不显示
