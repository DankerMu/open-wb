# 知识库运维说明

`system.md` §9.13 的正文（S2a，change `s2a-kb-ragflow`）。单独成文件，`system.md` 那一节只留指引。

本节随任务组落地。组 4：配置键、密钥文件要求与 `kb_key` 阶段。组 6：`kb` 模块装配、关闭判定、状态端点与版本钉住。组 8：知识库模型设置、下发到 RAGFlow、探活与 `models` 联动。组 9 首刀：普通模板的建库、列表与删库，模板表。

**配置键**（`server/src/kb/config.ts`；四项都可选，下面的配对规则另算）：

| 键 | 缺省 | 规则 |
|---|---|---|
| `RAGFLOW_BASE_URL` | 未配置，即知识库关闭 | 只有协议与 authority（`http` 或 `https`），无路径、无结尾斜杠、无查询与片段；不接受 userinfo（不能含 `@`，这一点与 `PREVIEW_ORIGIN` 不同）；空串非法 |
| `RAGFLOW_API_KEY_FILE` | 未配置 | 绝对路径；空串非法。配置解析时不读这个文件 |
| `KB_UPLOAD_MAX_BYTES` | `104857600` | 单个文件的字节上限，与 `UPLOAD_MAX_BYTES` 同一解析纪律（canonical 十进制正整数，`1..2147483647`） |
| `KB_UPLOAD_MAX_FILES` | `10` | 一次上传的文件数上限，解析纪律同上（`1..2147483647`） |

`RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE` 必须成对：只配一个是配置错误。任一项非法，服务启动失败：退出码 1，标准错误只有一行 `{"event":"server_start_failed","reason":"config"}`，不指出是哪一项、也不回显取值。

**密钥文件**（`server/src/kb/key-file.ts`）。RAGFlow 的 API key 放文件、不放环境变量：key 一旦泄露，就能读写全部账号的知识库；放在 `0600` 文件里，它不进 `/proc/<pid>/environ`，也不被 app-server 派生的进程继承。要求：

- 是普通文件本身：符号链接、目录、FIFO 都不行（以 `O_NOFOLLOW` 打开，判定与读取都走同一个描述符）。
- 属主是服务进程的 uid，组与其它用户没有任何权限位（`mode & 0o077` 为 0，`0600`、`0400` 都合规）。
- 大小 1–4096 字节。
- 内容去掉恰一个结尾 `\n` 后非空，且能作 HTTP 头值：不含 `\r`、NUL、第二个 `\n`，没有 U+00FF 之上的字符。

部署时这样写出：

```sh
install -m 600 -o <服务用户> /dev/null <密钥文件路径>
printf '%s\n' "$KEY" > <密钥文件路径>
```

**`kb_key` 阶段**：紧接配置解析、先于建 DB 父目录。配置了 `RAGFLOW_BASE_URL` 才读文件，未配置时不读任何文件。任一条要求不满足，服务启动失败：退出码 1，标准错误只有一行 `{"event":"server_start_failed","reason":"kb_key"}`，不带路径、文件内容与原始错误，此时没有建目录、没有开 DB、没有 listen。补救：逐条核对上面四项要求。

启动不连接 RAGFlow：地址写错或 RAGFlow 没起来都不影响启动。

**密钥的去向**：读出的 key 只留在一个只读句柄的闭包里，入口把句柄经 `createApp` 的 `kb` 字段交给 `kb` 模块，不进日志、审计、响应与任何子进程环境。omp 的 spawn 环境是白名单（`server/src/sessions/omp/spawn-env.ts`），`RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` 都不在其中。文件**路径**仍在 app-server 的环境里：同 uid 部署（未配置 `OMP_USER`）时 omp 能以同 uid 读这个文件，与 S0b 已登记的同 uid 风险是同一项，按 ADR-0010 的专用 uid 部署关闭。

**`kb` 模块**（`server/src/kb/index.ts`、`kb/rest.ts`）：createApp 的第十二个模块，注册与启动记录的 `modules` 都紧随 `connectors`。未配置 `RAGFLOW_BASE_URL` 时模块照常注册，只是不建客户端。配置了时只建一个 RAGFlow 客户端实例：下面的限频状态在实例里。

**知识库关闭**（未配置 `RAGFLOW_BASE_URL`）：`GET /api/kb/status` 返回 `{enabled:false}`；其余已注册的 `/api/kb/*` 路由返回 503 `kb_disabled`，带 `Cache-Control: no-store`，不发任何出站请求。这个判定是 root `preParsing` 钩子，次序：未登录 401 → 503 `kb_disabled` → 管理员 403 → body 解析。所以坏 JSON 与非管理员拿到的也是 503。没有注册的 `/api/kb/…` 路径仍是 404 `not_found`。

**`GET /api/kb/status`**：任何已登录用户可调，未登录 401，应答都带 `Cache-Control: no-store`。开启时应答恰为 `{enabled:true, available, embeddingReady, compileReady, uploadMaxBytes, uploadMaxFiles}`：

| 字段 | 含义 |
|---|---|
| `available` | 版本接口可达，且版本串恰为 `v1.0.0-rc2` |
| `embeddingReady` | 已配置知识库嵌入模型（`kb_settings`） |
| `compileReady` | 已指定知识库对话模型（`kb_settings`） |
| `uploadMaxBytes`、`uploadMaxFiles` | `KB_UPLOAD_MAX_BYTES`、`KB_UPLOAD_MAX_FILES` 的配置值 |

**版本钉住**：每次状态请求发一次 `GET <RAGFLOW_BASE_URL>/api/v1/system/version`，总期限 5 s，不带密钥。RAGFlow 不可达或版本不符都是 200 加 `available:false`，不是错误。版本钉住只决定 `available`，其它知识库端点不因版本不符而拒绝请求。升级 RAGFlow 是一次代码变更（`kb/rest.ts` 的常量），要重跑实测。

**两条 stderr 记录**，都恰只有 `event` 一个键，经同一受管 writer 写出，同一进程 60 秒内各至多一行：

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_version_mismatch"}` | 版本接口可达，版本串不是 `v1.0.0-rc2`。不可达时不写 | 把 RAGFlow 换回钉住的版本，或按升级流程改钉住的版本 |
| `{"event":"kb_upstream_auth_failed"}` | RAGFlow 应答 HTTP 401，或 body `code` 为 401 / 403（`DELETE /datasets` 的 `code:403` 是「不存在」，不算） | 核对密钥文件里的 key 是否仍有效；换 key 要重启服务 |

**知识库模型设置**（`server/src/kb/settings.ts`）：三个端点都只给管理员，次序是未登录 401 → 关闭时 503 `kb_disabled` → 非管理员 403 → body 解析；成功应答都是 200 加读视图，带 `Cache-Control: no-store`。

| 端点 | 作用 |
|---|---|
| `GET /api/kb/settings` | 读 |
| `PUT /api/kb/settings` | 保存：先下发到 RAGFlow，成功后在同一事务里写 `kb_settings` 与审计；下发失败本地不变 |
| `POST /api/kb/settings/probe` | 探活嵌入模型（bodyless），不下发，不改嵌入身份 |

读视图恰为 `{embedding, chatModelId, bases, compileBases, documents, rebuilding, rebuildFailed}`，不含任何密钥。`embedding` 是 `{name, baseUrl, probe}` 或 `null`；`compileBases` 是 `raptor` 或 `graph` 为 1 的库数，含重建中与重建失败的库。

`PUT` 的 body 键集是 `embedding`、`chatModelId`、`confirmRebuild` 的子集，且至少含前两者之一。`embedding` 是 `{name, baseUrl, apiKey?}`：`name` 1–128 字节、无控制字符、不含 `@`；首次配置必须带 `apiKey`，之后省略即保留已存的值，空串或纯空白是 400。`chatModelId` 是 `models` 里带上游的 id（不含 `@`）或 `null`。`embedding.name` 与 `chatModelId` 不含 `@`，是因为 RAGFlow 用三段式 `<名称>@<实例>@<提供方>` 引用它们。

当前值非 `null` 且有开编译的知识库时，`chatModelId` 改为 `null` 或别的 id 都是 409 `kb_chat_model_locked`，同 id 照常下发：Compiler 的 `llm_id` 建库时固化，换模型会让旧库打到新上游。没有开编译的库时，改为 `null` 只改本地；已是 `null` 再设 `null` 是无操作，不写库、不审计。

嵌入身份是 `(name, baseUrl)`，只换密钥不算身份变化。身份变化且已有知识库时：有库处于 `rebuilding` 即 409 `kb_rebuilding`，否则 409 `kb_rebuild_required`。确认重建（`confirmRebuild`）目前不开放，带了同样 409。

**下发的固定序列**：两个实例名是常量，`owb-embed` 承载嵌入模型，`owb-chat` 承载知识库对话模型，提供方都是 `OpenAI-API-Compatible`。一个实例的一轮下发：

1. `PUT /api/v1/providers`，body `{provider_name}`（幂等）。
2. `GET /api/v1/models`，按 `provider_name` 与 `instance_name` 判断实例是否存在。
3. 不存在：`POST …/instances`，body `{instance_name, api_key, base_url, model_info}`。存在：`GET …/instances/<实例>/models`，再 `PUT …/instances/<实例>`，body 同样四个键，`model_info` 为现有模型加本次的模型，同名项以本次为准。
4. `PATCH /api/v1/models/default`，body `{model_provider, model_instance, model_name, model_type}`。

body 含 `embedding` 时先下发嵌入模型，再重发当时指定的对话模型（该行没有上游时跳过），所以管理员保存一次嵌入模型就能把两种缺省都补回来。只含 `chatModelId` 时只下发对话模型。`api_key` 恒为实际密钥：RAGFlow 按 trim 后的值写入，空串或纯空白会清空实例密钥，所以都不发出。不用 `PATCH /api/v1/users/me/models`，也不用 `GET …/instances/<实例>`：它明文回显上游密钥。下发不是原子的，第 3 步成功、第 4 步失败时 RAGFlow 已是新值、本地仍是旧值；重试同一次保存即收敛。

**账号缺省不变量**：`kb` 模块不发清空缺省的 `PATCH /api/v1/models/default`（只带 `model_type`，或名字为空串），也不调用 `/api/v1/providers` 下的任何 `DELETE`。RAGFlow 里的模型配置只增、只覆盖。账号没有缺省对话模型而有 pipeline 数据集时，数据集级合并任务会让全栈唯一的入库进程崩溃循环，影响栈上全部账号（实测记录 §13）。客户端没有这些调用的写法，`setDefaultModel` 拒绝发出空名字。

**取消指定不撤销**：`chatModelId` 改为 `null` 只改本地，账号缺省仍指向 `owb-chat`。上游密钥留在 RAGFlow 里，直到下一次下发覆盖或运维清理。运维清理要按实测记录 §16 的次序：账号缺省保持不动，先删数据集、画布、模板组，静默到没有编译活动，才清缺省、删实例。

**与 `models` 的联动**（`modelWriteGuard`，D1、D7）：`kb` 注册时给出钩子，`app.ts` 把它绑给 `models`（`kb` 注册晚于 `models`，钩子在写入时才读）；知识库关闭时没有钩子，`models` 直接写，删除经外键把 `chat_model_id` 置空，已下发的副本不撤销，重新开启后保存一次设置即覆盖。开启时 `DELETE /api/models` 与 `PUT /api/models` 的写入整段由钩子包住，在设置锁内依次：`plan`（`models/store.ts` 的 `planUpdate`，校验 body，算候选上游与 `upstreamChanged`，不写库，所以非法 body 400、不发 RAGFlow 请求）→ 引用判定 → 需要时重新下发 → 写入回调。这一行是 `kb_settings.chat_model_id` 时：

| 写入 | 结果 |
|---|---|
| `DELETE` | 409 `kb_model_in_use`，行不变；这一行同时是缺省模型时也是这个码，取消指定之后才是 `model_in_use` |
| `PUT` 且 `upstream: null` | 409 `kb_model_in_use`，行不变；这一行的上游已经是空的也是 409（知识库关闭期间清空过），要先配上上游或取消指定 |
| `PUT` 且 `upstreamChanged` 为真 | 候选密钥纯空白时 400 `bad_request`，不发 RAGFlow 请求，行不变。否则按候选上游把 `owb-chat` 重新下发一轮（序列同上，`max_tokens` 取这次修改之后的值），成功后才写库；下发失败按映射回 503 `kb_unavailable` / 400 `kb_rejected`，行、审计与 `models.yml` 都不变，但 `owb-chat` 可能已是候选上游（第 3 步成功、第 4 步失败）。重试同一次修改即收敛；放弃修改时保存一次知识库模型设置，用本地的行覆盖 |
| `PUT` 且 `upstreamChanged` 为假 | 不下发，直接写：只改名或只改 `maxTokens` 不碰 RAGFlow，`model_info` 里的 `max_tokens` 留到下一次下发更新 |

开编译的库不影响这张表：同一行轮换密钥或改地址照常下发。没有被引用的行不碰 RAGFlow，删除也一样，账号缺省仍指向已下发的配置。引用判定与写入在同一次设置锁内，所以与一次并发的保存只有两种次序：保存在前，修改判定为已引用并重新下发，删除得 409；修改或删除在前，保存读到写入之后的行。发布（`registry.refresh()` 与 `models.yml`）在钩子之外，不占设置锁。

**探活**：向嵌入上游发 `POST <baseUrl>/embeddings`，body `{model, input:"ping"}`，期限同模型探活（连接 10 s、总 15 s），不跟随重定向。2xx 且 `data[0].embedding` 为非空数字数组是 `ok`，否则是 `failed`。未配置嵌入模型时 409 `kb_not_ready`。保存时名称、地址或密钥任一变化，探活状态在同一事务里重置为 `never`；三者都不变时保留。

**写操作串行**：保存全程持进程级设置锁，取值规则与身份判定在锁内做，读到的是锁内的行。探活的请求在锁外，只有写回在锁内：结果只写回发起时的同一身份（名称、地址、密钥），身份已变时丢弃、不审计，应答回当前读视图。探活逐次串行：一条进程级链把「读身份 → 发请求 → 取锁写回」整段排队，后发的排在在途的之后，身份在排到时读取，前一个失败不影响后一个。这条链不并进设置锁，探活不能占锁 15 s。

每次保存写一条 `kb.settings` 审计，detail 只含实际变化的键（`embedding` 为模型名，`chatModelId`），可以为空；探活写一条，detail 是 `{probe}`。

**知识库端点**（`server/src/kb/bases.ts`，组 9 首刀）：三条路由对任何已登录用户开放，只操作自己的库，全部应答带 `Cache-Control: no-store`。别人的或不存在的 id 一律 404 `not_found`，两者不可区分，判定先于 body 解析与 `state`，不发出站请求，不写审计。管理员没有例外。

| 端点 | 作用 |
|---|---|
| `GET /api/kb/bases` | 200 `{bases: BaseView[]}`，按 `created_at` 升序。只读本地行，RAGFlow 不可达时照常 200 |
| `POST /api/kb/bases` | 建库，201 `BaseView` |
| `DELETE /api/kb/bases/:id` | 删库，204 |

`BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt}`：`raptor`、`graph` 是布尔；`documents` 是本地文档行数；`createdAt` 是 epoch 毫秒整数；两个开关都为 0 的库 `compile` 恒为 `{raptor:"off", graph:"off"}`，不发出站请求。

**建库**：body 键集是 `name`、`template`、`raptor?`、`graph?`。`name` 1–64 码点，无 C0 与 DEL，不 trim。依次判定：

1. 键集、类型、名称或模板不合规：400 `bad_request`。这一步不读库。
2. 嵌入模型未配置：409 `kb_not_ready`。
3. `raptor` 或 `graph` 为真：400 `bad_request`。目前只开放普通模板，开关随模板组与画布一起开放。
4. 同账号重名：409 `conflict`。这个账号已有 50 个知识库：409 `kb_limit`。

第 2–4 步在进程级设置锁内做，建库全程持锁，所以不会建出代数过期的库，也不会与一次设置保存交错：保存排在建库之后，读到新建的库，换嵌入身份得 409 `kb_rebuild_required`。

通过之后 `POST /api/v1/datasets`，body `{name, parser_id, parse_type:1, embedding_model}`，然后在同一事务里插行与写 `kb.create`。201 的 `BaseView` 不读 RAGFlow。

- 数据集名 `owb-<id>-g<代数>`：`<id>` 是知识库 id（32 位小写十六进制），`<代数>` 是锁内读到的当前嵌入代数。用户可见的名称只存在本地，RAGFlow 不感知用户。
- `embedding_model` 恒显式传三段式 `<名称>@owb-embed@OpenAI-API-Compatible`：不传时回落到账号缺省甚至空值，缺省悬空时建库成功、到解析才失败。不发 `chunk_method`，RAGFlow 回 `101`。
- RAGFlow 的结果按客户端的映射返回（400 `kb_rejected` 或 503 `kb_unavailable`），不插行。
- 插行或审计写入失败：删掉刚建的数据集，应答 500。这个删除失败时写一行 `{"event":"kb_dataset_leak","datasetId":<id>}`，不改变应答。

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_dataset_leak","datasetId":<id>}` | 建库的回滚删不掉数据集：RAGFlow 里留下一个本地没有行的数据集 | 按 `datasetId` 在 RAGFlow 里手工删除。这条记录不限频 |

**删库**：`state` 为 `rebuilding` 时 409 `kb_rebuilding`；写锁正被重建器持有时同样 409，不排队。否则在该库的写锁下按次序删数据集：`rebuild_failed` 且新一代已建时先删新一代，再删当前一代。上一步确认已删之前不发下一步。取锁之后重判存在性与 `state`：排队期间库可能已删除（404）或转入重建（409）。

- `DELETE /api/v1/datasets` 的 `code:403` 是「不存在」（实测记录表 B），视为已删，不写 `kb_upstream_auth_failed`。
- 不可达或别的失败：503 `kb_unavailable` 或 400 `kb_rejected`，行不动。重试从头走一遍，已删的按「不存在」跳过，所以不留孤儿。
- 都删完后删行（文档行级联），在同一事务里写 `kb.delete`。

**审计**：`kb.create` 的 detail 恰为 `{id, template, raptor, graph}`，`kb.delete` 的恰为 `{id}`，标题是固定短句，不带用户文本。

**模板**（`server/src/kb/templates.ts`）：十一种，建库时固定，没有修改模板的端点。本地存模板名，发给 RAGFlow 的是 `parser_id`。`tag` 与 `audio` 都不提供：RAGFlow 回 `tag` 的建库 `102`，`audio` 要语音模型、编译未测成。后缀抄自实测记录表 C 末列，取自各模板 pipeline 的 Parser 节点，不是逐个上传验证的；入库的后缀判定随入库端点落地。

| 模板 | `parser_id` | 后缀 |
|---|---|---|
| `naive` | `general` | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、csv、txt、py、js、java、c、cpp、h、php、go、ts、sh、cs、kt、sql |
| `book` | `book` | doc、docx、htm、html、pdf、txt |
| `email` | `email` | eml |
| `laws` | `laws` | doc、docx、htm、html、md、markdown、mdx、pdf、txt |
| `manual` | `manual` | doc、docx、pdf |
| `one` | `one` | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、txt |
| `paper` | `paper` | pdf |
| `picture` | `picture` | bmp、gif、jpeg、jpg、png、svg、tif、tiff、webp、3gp、3gpp、avi、flv、mkv、mov、mp4、mpeg、mpg、webm、wmv |
| `presentation` | `presentation` | pdf、pptx、ppt |
| `qa` | `qa` | docx、md、markdown、mdx、pdf、xls、xlsx、csv、txt |
| `table` | `table` | xls、xlsx、csv、txt |
