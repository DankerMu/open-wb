# 知识库运维说明

`system.md` §9.13 的正文（S2a，change `s2a-kb-ragflow`）。单独成文件，`system.md` 那一节只留指引。

本节随任务组落地。组 4：配置键、密钥文件要求与 `kb_key` 阶段。组 6：`kb` 模块装配、关闭判定、状态端点与版本钉住。组 8：知识库模型设置、下发到 RAGFlow、探活与 `models` 联动。组 9 首刀：普通模板的建库、列表与删库，模板表。组 9 第二刀：开了 RAPTOR / 知识图谱的建库与删库，模板组与画布的生命周期。组 9 第三刀：列表里的编译状态。组 10：工作空间来源入库与 RAGFlow 文档的删除写法。组 11：文档列表。组 12：本地上传。组 13：移出与重新入库。组 14：嵌入模型更换与全量重建。组 18：部署要求、回滚与 `make smoke-kb`（文末）。S2b 组 6：重排模型的设置、下发与探活（并在「知识库模型设置」里）。S2c（change `s2c-kb-session`）：会话检索 `kb_search` 与知识库引用（「单轮检索与检索测试」之后）。web 侧（组 15–17）的界面契约在 spec，不在本文。

**配置键**（`server/src/kb/config.ts`；四项都可选，下面的配对规则另算）：

| 键 | 缺省 | 规则 |
|---|---|---|
| `RAGFLOW_BASE_URL` | 未配置，即知识库关闭 | 只有协议与 authority（`http` 或 `https`），无路径、无结尾斜杠、无查询与片段；不接受 userinfo（不能含 `@`，这一点与 `PREVIEW_ORIGIN` 不同）；空串非法 |
| `RAGFLOW_API_KEY_FILE` | 未配置 | 绝对路径；空串非法。配置解析时不读这个文件 |
| `KB_UPLOAD_MAX_BYTES` | `104857600` | 单个文件的字节上限，与 `UPLOAD_MAX_BYTES` 同一解析纪律（canonical 十进制正整数，`1..2147483647`） |
| `KB_UPLOAD_MAX_FILES` | `10` | 一次上传的文件数上限，解析纪律同上（`1..2147483647`） |

`RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE` 必须成对：只配一个是配置错误。任一项非法，服务启动失败：退出码 1，标准错误只有一行 `{"event":"server_start_failed","reason":"config"}`，不指出是哪一项、也不回显取值。

**本机跑 `make smoke` / `make ui-walk`**：这两项在 shell 里 export 着时，起的服务会开启知识库并连上那套 RAGFlow，ui-walk 主旅程里「知识库关闭时 tab 条不含「知识库」」的断言（`web/e2e/ui-walk-center.ts:24`）随之失败。起服务时去掉它们：`env -u RAGFLOW_BASE_URL -u RAGFLOW_API_KEY_FILE <起服务的命令>`。CI 的 smoke 与 ui-walk 两个 job 不配这两项。

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

**三条限频的 stderr 记录**，都恰只有 `event` 一个键，经同一受管 writer 写出，同一进程 60 秒内各至多一行：

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_version_mismatch"}` | 版本接口可达，版本串不是 `v1.0.0-rc2`。不可达时不写 | 把 RAGFlow 换回钉住的版本，或按升级流程改钉住的版本 |
| `{"event":"kb_upstream_auth_failed"}` | RAGFlow 应答 HTTP 401，或 body `code` 为 401 / 403（`DELETE /datasets` 的 `code:403` 是「不存在」，不算） | 核对密钥文件里的 key 是否仍有效；换 key 要重启服务 |
| `{"event":"kb_rerank_degraded"}` | 检索带了 `rerank_id`、RAGFlow 回 HTTP 200 `code:102`，去掉 `rerank_id` 重试了一次（不论重试结果）。`code:102` 不区分来源，非重排引起的也会写 | 核对重排模型的名称、地址、密钥（模型 tab 的探活）；无法修复时清除重排模型 |

**知识库模型设置**（`server/src/kb/settings.ts`）：四个端点都只给管理员，次序是未登录 401 → 关闭时 503 `kb_disabled` → 非管理员 403 → body 解析；成功应答都是 200 加读视图，带 `Cache-Control: no-store`。

| 端点 | 作用 |
|---|---|
| `GET /api/kb/settings` | 读 |
| `PUT /api/kb/settings` | 保存：先下发到 RAGFlow，成功后在同一事务里写 `kb_settings` 与审计；下发失败本地不变 |
| `POST /api/kb/settings/probe` | 探活嵌入或重排模型（bodyless；`?target=embedding\|rerank`，缺省嵌入；其它、空值、重复为 400；重排未配置为 400），不下发，不改模型身份 |
| `POST /api/kb/settings/rebuild` | 重试失败的重建（bodyless），见下面的「嵌入模型更换与全量重建」 |

读视图恰为八键 `{embedding, chatModelId, rerank, bases, compileBases, documents, rebuilding, rebuildFailed}`，不含任何密钥。`embedding` 与 `rerank` 都是 `{name, baseUrl, probe}` 或 `null`，`rerank.probe` 是重排模型自己的探活；`compileBases` 是 `raptor` 或 `graph` 为 1 的库数，含重建中与重建失败的库。

`PUT` 的 body 键集是 `embedding`、`chatModelId`、`rerank`、`confirmRebuild` 的子集，且至少含前三者之一。`rerank` 是 `{name, baseUrl, apiKey?}` 或 `null`，校验同 `embedding`。`embedding` 是 `{name, baseUrl, apiKey?}`：`name` 1–128 字节、无控制字符、不含 `@`；首次配置必须带 `apiKey`，之后省略即保留已存的值，空串或纯空白是 400。`chatModelId` 是 `models` 里带上游的 id（不含 `@`）或 `null`。`embedding.name` 与 `chatModelId` 不含 `@`，是因为 RAGFlow 用三段式 `<名称>@<实例>@<提供方>` 引用它们。

当前值非 `null` 且有开编译的知识库时，`chatModelId` 改为 `null` 或别的 id 都是 409 `kb_chat_model_locked`，同 id 照常下发：Compiler 的 `llm_id` 建库时固化，换模型会让旧库打到新上游。没有开编译的库时，改为 `null` 只改本地；已是 `null` 再设 `null` 是无操作，不写库、不审计。

嵌入身份是 `(name, baseUrl)`，只换密钥不算身份变化。身份变化且已有知识库时：有库处于 `rebuilding` 即 409 `kb_rebuilding`（带不带 `confirmRebuild` 都一样）；没带 `confirmRebuild:true` 即 409 `kb_rebuild_required`，不下发、不保存；带了就照常下发并保存，同时发起全量重建（见下面的「嵌入模型更换与全量重建」）。

**下发的固定序列**：实例名是常量，`owb-embed` 承载嵌入模型，`owb-chat` 承载知识库对话模型，`owb-rerank` 承载重排模型（见下面的「重排模型」），提供方都是 `OpenAI-API-Compatible`。一个实例的一轮下发：

1. `PUT /api/v1/providers`，body `{provider_name}`（幂等）。
2. `GET /api/v1/models`，按 `provider_name` 与 `instance_name` 判断实例是否存在。
3. 不存在：`POST …/instances`，body `{instance_name, api_key, base_url, model_info}`。存在：`GET …/instances/<实例>/models`，再 `PUT …/instances/<实例>`，body 同样四个键，`model_info` 为现有模型加本次的模型，同名项以本次为准。
4. `PATCH /api/v1/models/default`，body `{model_provider, model_instance, model_name, model_type}`。

**重排模型**（S2b D6）：实例 `owb-rerank`，`model_type:["rerank"]`，`max_tokens` 8192，一轮只有上面的第 1–3 步，没有第 4 步：重排不设账号缺省，检索时按请求传 `rerank_id`（续篇 §19.3）。body 含 `rerank` 对象时这一轮排在最前，失败即停，后面的嵌入、对话两轮都不发。排在最前是因为它没有账号级副作用：排在后面时，嵌入一轮的 `PATCH /models/default` 已生效而重排失败让本地不变，账号缺省嵌入就与本地分裂；代价是重排一轮成功、后面某轮失败时 `owb-rerank` 已是新地址与密钥，只影响重排，下一次成功保存即覆盖。`rerank:null` 只把本地三列置空，不发 RAGFlow 请求，实例与密钥留在 RAGFlow；只含 `rerank` 的保存不重发对话模型。重排不是嵌入身份的一部分，换重排模型不重建。

body 含 `embedding` 时先下发嵌入模型，再重发当时指定的对话模型（该行没有上游时跳过），所以管理员保存一次嵌入模型就能把两种缺省都补回来。只含 `chatModelId` 时只下发对话模型。`api_key` 恒为实际密钥：RAGFlow 按 trim 后的值写入，空串或纯空白会清空实例密钥，所以都不发出。不用 `PATCH /api/v1/users/me/models`，也不用 `GET …/instances/<实例>`：它明文回显上游密钥。下发不是原子的，第 3 步成功、第 4 步失败时 RAGFlow 已是新值、本地仍是旧值；重试同一次保存即收敛。

**账号缺省不变量**：`kb` 模块不发清空缺省的 `PATCH /api/v1/models/default`（只带 `model_type`，或名字为空串），也不调用 `/api/v1/providers` 下的任何 `DELETE`。RAGFlow 里的模型配置只增、只覆盖。账号没有缺省对话模型而有 pipeline 数据集时，数据集级合并任务会让全栈唯一的入库进程崩溃循环，影响栈上全部账号（实测记录 §13）。客户端没有这些调用的写法，`setDefaultModel` 拒绝发出空名字。`owb-rerank` 不是账号缺省，删除它没有 §13 的风险。

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

重排模型的探活（`?target=rerank`）同一套规则，只有这几处不同：向重排上游发 `POST <baseUrl>/rerank`，body `{model, query:"ping", documents:["ping"]}`；2xx 且 `results[0].relevance_score` 是有限数字是 `ok`，否则是 `failed`（`响应不含重排分数`）；未配置重排模型时 400 `bad_request`，不是 `kb_not_ready`（它的文案说的是嵌入模型）。续篇 §19.4 有一次同一请求耗时 22 s，超过 15 s 总期限，这样的探活会判为 `超时`；期限不为它放宽。

**写操作串行**：保存全程持进程级设置锁，取值规则与身份判定在锁内做，读到的是锁内的行。探活的请求在锁外，只有写回在锁内：结果只写回发起时的同一身份（名称、地址、密钥），身份已变时丢弃、不审计，应答回当前读视图。探活逐次串行：一条进程级链把「读身份 → 发请求 → 取锁写回」整段排队，后发的排在在途的之后，身份在排到时读取，前一个失败不影响后一个。这条链不并进设置锁，探活不能占锁 15 s。两种探活排在同一条链上；未配置的判定也在轮到时做。

每次保存写一条 `kb.settings` 审计，detail 只含实际变化的键（`embedding` 为模型名，`chatModelId`，`rerank` 为模型名或 `null`），可以为空；探活写一条，嵌入是 `{probe}`，重排是 `{rerankProbe}`。

**知识库端点**（`server/src/kb/bases.ts`，组 9 首刀与第二刀；编译状态在 `server/src/kb/compile-status.ts`，第三刀）：三条路由对任何已登录用户开放，只操作自己的库，全部应答带 `Cache-Control: no-store`。别人的或不存在的 id 一律 404 `not_found`，两者不可区分，判定先于 body 解析与 `state`，不发出站请求，不写审计。管理员没有例外。

| 端点 | 作用 |
|---|---|
| `GET /api/kb/bases` | 200 `{bases: BaseView[]}`，按 `created_at` 升序。库与文档数只读本地行；开了开关的库另现读编译状态，读不到为 `null`，RAGFlow 不可达时照常 200 |
| `POST /api/kb/bases` | 建库，201 `BaseView` |
| `DELETE /api/kb/bases/:id` | 删库，204 |

`BaseView` 恰为 `{id, name, template, raptor, graph, state, stateMessage, documents, compile, retrieval, createdAt}`：`raptor`、`graph` 是布尔；`retrieval` 是该库的检索参数 `{threshold, vectorWeight}`，取迁移 051 的两列原值（都是 0–1 的数字，建库为 `{0.2, 0.7}`），只读本地行；`documents` 是本地文档行数；`createdAt` 是 epoch 毫秒整数；两个开关都为 0 的库 `compile` 恒为 `{raptor:"off", graph:"off"}`，不发出站请求。开了开关的库：建库的 201 不读 RAGFlow，开着的类型为 `pending`、关着的为 `off`；列表里关着的类型为 `off`，开着的按下面的「编译状态」现读，取 `pending` / `running` / `done` / `failed`，整库读不到时 `compile` 为 `null`。

**建库**：body 键集是 `name`、`template`、`raptor?`、`graph?`。`name` 1–64 码点，无 C0 与 DEL，不 trim。依次判定：

1. 键集、类型、名称或模板不合规：400 `bad_request`。这一步不读库。
2. 嵌入模型未配置：409 `kb_not_ready`。
3. `raptor` 或 `graph` 为真而知识库对话模型未指定：400 `bad_request`。RAPTOR 与知识图谱对十一种模板都可用，没有按模板的限制。
4. 同账号重名：409 `conflict`。这个账号已有 50 个知识库：409 `kb_limit`。

第 2–4 步在进程级设置锁内做，建库全程持锁，所以不会建出代数过期的库，也不会与一次设置保存交错：保存排在建库之后，读到新建的库，换嵌入身份得 409 `kb_rebuild_required`，取消指定或更换对话模型得 409 `kb_chat_model_locked`；取消指定排在建库之前，建库读到未指定，400。

通过之后建 RAGFlow 资源，然后在同一事务里插行与写 `kb.create`。201 的 `BaseView` 不读 RAGFlow。两个开关都关：`POST /api/v1/datasets`，body `{name, parser_id, parse_type:1, embedding_model}`，没有模板组与画布。任一开关开：见下面的「编译资源」，数据集是 `parse_type:2`。

- 数据集名 `owb-<id 前 16 位>-g<代数>`：`<id>` 是知识库 id（32 位小写十六进制），取前 16 个字符；`<代数>` 是锁内读到的当前嵌入代数。开了开关的库，模板组与画布用同一个名字，建库与重建都经 `kb/pipeline.ts` 的 `resourceName` 生成。名字不超过 32 个字符（代数不超过 10 位时）：RAGFlow 建入库任务时把画布标题拷进 `pipeline_operation_log.pipeline_title`（`varchar(32)`），超长时任务建不出来，解析触发回 `code:0`、`success_count:0`，日志里没有记录（#1900）。用户可见的名称只存在本地，RAGFlow 不感知用户。
- `embedding_model` 恒显式传三段式 `<名称>@owb-embed@OpenAI-API-Compatible`：不传时回落到账号缺省甚至空值，缺省悬空时建库成功、到解析才失败。不发 `chunk_method`，RAGFlow 回 `101`。
- RAGFlow 的结果按客户端的映射返回（400 `kb_rejected` 或 503 `kb_unavailable`），不插行。
- 插行或审计写入失败：按删除次序删掉这一次建的资源（数据集 → 画布 → 模板组），应答 500。删除失败即停，写一行 leak，不改变应答。

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_dataset_leak","datasetId":<id>}` | 回滚删不掉数据集：RAGFlow 里留下一个本地没有行的数据集。开了开关的库，它的画布与模板组没有去删，也还在 | 按 `datasetId` 在 RAGFlow 里手工删除；开了开关的，再按数据集名（`owb-<id 前 16 位>-g<代数>`，画布与模板组同名）先删画布、再删模板组。这条记录不限频 |
| `{"event":"kb_pipeline_leak","canvasId":<id\|null>,"groupId":<id\|null>}` | 回滚删不掉画布（两个 id 都在，模板组没有去删）或模板组（画布已删，`canvasId` 为 `null`） | 按 id 在 RAGFlow 里先删画布、再删模板组。这条记录不限频 |

**编译资源**（`server/src/kb/pipeline.ts`，组 9 第二刀）。RAPTOR 与知识图谱不是数据集字段：`parser_config` 里的开关被 RAGFlow 静默丢弃。开了开关的库是三样资源：一个模板组、一个引用它的画布（ingestion pipeline），以及以这个画布建的 `parse_type:2` 数据集。每个库每一代一套，不共用。建库时建第 0 代；重建时新建一代，`rebuild_*` 三列记新一代（见下面的「嵌入模型更换与全量重建」）。解析时 Compiler 节点在 pipeline 里自动运行，没有单独的编译触发。

建一代（`createPipeline`，建库与重建共用；调用方持锁，它自己不取锁）：

1. `GET /api/v1/models/default`，只读。`data.models` 里 `chat` 与 `embedding` 两种都在、`model_name` 非空才继续；缺一种即 409 `kb_not_ready`，不发后续请求；重建时是该库 `rebuild_failed`。这一步挡的是 RAGFlow 侧被人手工清空缺省：没有缺省对话模型时，pipeline 数据集的数据集级合并会让全栈唯一的入库进程崩溃循环。本系统自己从不清空缺省（见上面的「账号缺省不变量」）。补救：管理员保存一次嵌入模型，两种缺省都会重新下发。
2. `GET /api/v1/compilation-templates/builtins` 取内置 `config`。RAPTOR 用 `tree`，删掉 `entity`、`relation`、`llm_id`（内置 `entity.fields` 带一条空 `type`，原样提交回 `102`）；知识图谱用 `knowledge_graph`，删掉 `llm_id`。
3. `POST /api/v1/compilation-template-groups`，名为 `owb-<id 前 16 位>-g<代数>`，`templates` 是开着的类型各一项。RAGFlow 对同名组自动加后缀，本系统只按应答里的 id 引用。
4. `GET /api/v1/pipelines/<parser_id>` 取内置 DSL，插一个 `Compiler:Owb` 节点：按 `obj.component_name` 含 `Chunker` 找 chunker（各模板节点名不同），插在它与原下游之间，`components` 与 `graph` 两处都改，`graph.edges` 里 chunker 的出边改从 Compiler 出发、原边不留，再加 chunker → Compiler 一条。Compiler 的 `llm_id` 留空，建数据集时 RAGFlow 把它固化成账号当时的缺省对话模型。然后 `POST /api/v1/agents`，`title` 同名，`canvas_category` 为 `dataflow_canvas`。内置 DSL 没有 `graph`，或 chunker 不是恰一个：503 `kb_unavailable`，不提交。`graph` 不能省：省掉时建画布、建库都回 `code:0`，文档静默换解析器、编译不运行。
5. `POST /api/v1/datasets`，body `{name, parse_type:2, pipeline_id:<画布 id>, embedding_model}`。

任一步失败，逆序删掉这一次已建的资源再返回这一步的结果：建画布失败删模板组，建数据集失败先删画布再删模板组。回滚同样即停，删除失败写上表的 leak。超时而 RAGFlow 实际已建成、或资源建好后进程崩溃，会留下无法自动对账的孤儿，只能按名字前缀 `owb-` 手工清理。

删一代（`deletePipeline`）：次序固定为数据集 → 画布 → 模板组，上一步确认已删（成功或不存在）之前不发下一步，任一步失败即停。这两个删除接口没有引用保护：删了在用的画布或模板组，RAGFlow 回 `code:0`，之后解析 `FAILED`，所以次序只能由本系统保证。客户端的删画布与删模板组只有 `pipeline.ts` 调用。「不存在」视为已删：删数据集 `code:403`、删画布 `code:103`、删模板组 `code:404`。普通库的这一代只有数据集。

**编译状态**（`server/src/kb/compile-status.ts`，组 9 第三刀）。`GET /api/kb/bases` 对每个开了开关的库现读两份数据，不缓存，没有后台轮询：

- 该库在 RAGFlow 的全部文档：与文档列表同一个读法（`GET …/documents?page=<n>&page_size=100&orderby=create_time&desc=false`，读到 `total` 或空页），按 RAGFlow 文档 id 关联本地文档行。RAGFlow 里没有本地行的文档（`kb_document_leak` 留下的）不参与判定。
- 数据集任务日志 `GET /api/v1/datasets/<id>/ingestions?page=<n>&page_size=100&orderby=id`，逐页读到 `total`，读到空页也停（`total` 是那一页说的，翻页期间可能变）。读全之后按每行的 `task_type` 分类型：RAPTOR 为 `Tree`，知识图谱为 `Graph`。`total` 是日志行数（一份文档一种类型一条），不是文档数。

读法的依据（实测记录 §5.3、§18 #26–#29）：

- 不读 `GET …/compilation/status`：按类型读没有终态，跑完之后与「从未编译」同为 `idle`；不带类型的 `state` 在多文档时往返，文档还在排队时也可能是 `completed`。
- `orderby=id` 不能省：缺省的 `create_time` 次序里 `Tree`、`Graph` 两条常在同一毫秒建出，翻页会重复一行、丢一行，重读结果相同，读不回来。
- 不发 `task_type=`（静默忽略，回全部行）、`keywords=`（关键字匹配，不是类型过滤）、`log_type=file`（文档级日志，一页约 1.2 MB，超过客户端 1 MiB 的上限）。
- 不用 `dsl.entries[].variants` 判类型：两种都开时两条日志都是 `["structure","tree"]`。

对开着的每种类型按次序判定，关着的为 `off`：

1. 有本地文档在 RAGFlow 处于 `CREATED` / `SCHEDULED` / `RUNNING` / `STOPPING`，或该类型有 `operation_status` 为 `RUNNING` 的日志：`running`。文档这一半由文档列表就能定，这时两种都是 `running`，不读任务日志。
2. 有本地文档 `FAILED`：`failed`。图谱失败、模板组缺失、缺省嵌入模型缺失都表现为文档 `FAILED`；失败分不出类型，两种都算，解析器失败也算。`failed` 只有这一个来源。
3. 除 `COMPLETED` 且 0 切片的文档外（这种文档编译不运行），其余本地文档非空，且每份都出现在该类型 `DONE` 日志的 `dsl.entries[].doc_id` 并集里：`done`。要看到每份文档，所以日志读全才判定，不提前停。
4. 其它：`pending`。`operation_status` 的未知取值落在这里。

读不到时该库的 `compile` 整体为 `null`（spec 给 web 的文案是「状态未知」，组 15 剩余渲染），不影响列表本身，也不影响别的库：

- 文档列表回数据集不存在（`code:404`）；文档列表或任务日志的任何一页失败、超时或缺字段；`DONE` 日志读不出 `dsl.entries[].doc_id`。
- 本地文档的 `ingestion_status` 在八种之外：协议漂移，不知道它是不是还在跑，不能判 `done`。文档列表端点对同一情形回 503，这里只让这个库读不到。
- 总期限：一次列表里各库的读取并发发出，共用一个 5 s 的总期限；到期没读完的库为 `null`，之后不再发任何一页。在途的那个请求照走客户端自己的期限，结果丢弃。

代价：每个开了开关的库一次列表读一次文档列表；没有文档在排队或解析时，再逐页读任务日志。一份文档一种类型一条日志，500 份文档两种都开是 1000 行、10 页，一页约 87 KB。

已知限制：

- **RAPTOR 可能完全没有信号。** 对话模型失败（密钥无效、实例已删除）时，文档照常 `COMPLETED`、有切片，任务日志没有 `Tree` 记录（实测记录 §5.4）。这时 `raptor` 停在 `pending`：没有失败信号，所以不显示 `failed`；也没有完成记录，所以不显示 `done`。第 3 步要逐份覆盖，中途才坏掉的情形同样不会显示 `done`。文档阶段的这个失败在 RAGFlow 里只有容器日志，本系统读不到。spec 给 web 的 `pending` 文案是「尚未产出」，旁注写明可能是知识库对话模型不可用（组 15 剩余渲染）。
- 翻页期间有新日志写入：`id` 不随时间递增，新日志可能插到已读的页之前，这次可能漏读一行。结果是第 3 步少覆盖一份、显示 `pending`，不会错报 `done`，下一次读取修正。
- `page_size` 在 200 行以上的上限未测，取 100 不依赖它；`dsl.entries` 观察到恒为 1 项，按并集读，多项时同样成立。

**删库**：`state` 为 `rebuilding` 时 409 `kb_rebuilding`；写锁正被重建器持有时同样 409，不排队。否则在该库的写锁下逐代走上面的删一代：`rebuild_failed` 且新一代已建时先删新一代，再删当前一代。上一步确认已删之前不发下一步。取锁之后重判存在性与 `state`：排队期间库可能已删除（404）或转入重建（409）。

- `DELETE /api/v1/datasets` 的 `code:403` 是「不存在」（实测记录表 B），视为已删，不写 `kb_upstream_auth_failed`；删画布的 `code:103`、删模板组的 `code:404` 同样。
- 不可达或别的失败：503 `kb_unavailable` 或 400 `kb_rejected`，行不动。重试从头走一遍，已删的按「不存在」跳过，所以不留孤儿。
- 都删完后删行（文档行级联），在同一事务里写 `kb.delete`。

**审计**：`kb.create` 的 detail 恰为 `{id, template, raptor, graph}`，`kb.delete` 的恰为 `{id}`，标题是固定短句，不带用户文本。

**模板**（`server/src/kb/templates.ts`）：十一种，建库时固定，没有修改模板的端点。本地存模板名，发给 RAGFlow 的是 `parser_id`。`tag` 与 `audio` 都不提供：RAGFlow 回 `tag` 的建库 `102`，`audio` 要语音模型、编译未测成。后缀抄自实测记录表 C 末列，取自各模板 pipeline 的 Parser 节点，不是逐个上传验证的；入库的后缀判定见下面的「工作空间来源入库」。

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

**工作空间来源入库**（`server/src/kb/documents.ts`、`kb/source-file.ts`、`kb/multipart.ts`，组 10）：`POST /api/kb/bases/:id/documents`，body 恰为 `{workspaceId, paths}`，带 `Cache-Control: no-store`。

请求层依次判定，任一不过都是整个请求失败，不发出站请求：

1. 别人的或不存在的知识库 id：404 `not_found`，先于 body 解析。
2. 键集或类型不对，`paths` 为空或超过 `KB_UPLOAD_MAX_FILES`，任一路径的 UTF-8 编码超过 4096 字节：400 `bad_request`。过长的路径不写 `sandbox.reject`、`kb.ingest_reject`，原文不进审计。恰 4096 字节的按逐条处理走。
3. `workspaceId` 不是当前用户可见的工作空间：404 `not_found`，判定同工作空间文件路由（别人的、已删除的、根被占据或不在了）。
4. 知识库 `state` 不是 `ready`，或写锁正被重建器持有：409 `kb_rebuilding`。

之后在该库的写锁下顺序处理每条路径。快判到取锁之间没有 `await`，取锁后重判 1、3、4：排队期间库可能已删除或转入重建。请求合法且本地写入没有失败即 201 `{documents, rejected}`。

客户端断开不中止这一批：条目逐条提交，整批跑到底。

| 步 | 处理 | 被拒的 `reason` |
|---|---|---|
| 1 | `sandbox.resolve(principal, workspaceId, path, "read")`，越界照常写 `sandbox.reject` | `outside`（含 `..`、绝对路径、NUL、任一分量是符号链接） |
| 2 | 查重，再数该库的文档，都在锁内逐条算，批内的上一条算数 | `duplicate`；已有 500 份时 `limit` |
| 3 | 后缀：basename 最后一个 `.` 之后的部分转小写，查该模板的表。对全部知识库生效 | `unsupported_type`（含没有后缀） |
| 4 | 挂载内经挂载读取，挂载外 lstat 后以 `O_NOFOLLOW` 打开，再对同一 fd 取 `fstat` | `offline`；`not_file`（目录、FIFO、不存在、打不开） |
| 5 | 看 `fstat` 的大小 | `empty`；超过 `KB_UPLOAD_MAX_BYTES` 时 `too_large` |
| 6 | multipart 流式上传 | 见下 |
| 7 | 解析触发，`document_ids` 只有这一个 id | 见下 |
| 8 | 同一事务里插文档行与 `kb.ingest` | 见下 |

路径先规范化：去掉空段与 `.` 段，`./a.md`、`a.md/` 与 `a.md` 是同一条路径。文档行、`kb.ingest` 与应答的 `documents` 用规范写法，`rejected` 与 `kb.ingest_reject` 用请求里的原文。只读挂载里的文件可以入库。入库不发任何编译请求：编译随解析自动运行。

**上传**：字段名 `file`，文件名只写 `filename*=UTF-8''…`，不用 `filename="…"`：文件名是用户的，`"`、CR、LF 写进带引号的值就是头注入。`Content-Length` 由 `fstat` 的大小加 multipart 的头尾算出，字节边读边发，不落临时文件。

读取一路读到 EOF，不按 `fstat` 的大小截断，文件长大了才看得出来。读到的多于或少于 `fstat` 的大小时立即中止出站请求，结束边界不发，RAGFlow 不留文档，也就不发删除。这时客户端只知道请求体坏了，回 `kb_unavailable`，所以调用点先看字节计数的结果：该条记为 `changed`，继续下一条。读到一半挂载到期记为 `offline`；别的读取错误同样记为 `changed`。

**RAGFlow 的失败**：

| 结果 | 该条 | 其后的条目 | 删除刚上传的文档 |
|---|---|---|---|
| 上传 `kb_rejected` | `rejected` | 继续 | 没有文档 |
| 上传 `code:500` 且 message 表明不支持这种文件 | `unsupported_type` | 继续 | 没有文档 |
| 解析触发 `kb_rejected`，或 `code:0` 而 `success_count` 为 0 | `rejected` | 继续 | 删 |
| 上传或解析触发 `kb_unavailable`，或得知数据集不存在 | `unavailable` | 全部 `unavailable`，不再解析路径、不发请求、不写 `sandbox.reject` | 上传已成功时删 |

`success_count` 为 0 除了 rc2 实测记录 §8.1 表里列的情形，还有一种：RAGFlow 建入库任务失败（如画布标题超过 `pipeline_operation_log.pipeline_title` 的 32 字符），这时 `code` 仍为 0，RAGFlow 日志里没有记录（2026-11-07 S2a 验收 CK-11 实测，#1900）。

第 8 步的插行或审计失败是本地的失败：删掉这一份刚上传的文档，整个请求 500，其后的条目不再处理，这一批前面已提交的行留着，重试时它们是 `duplicate`。

**拒绝原因**：`rejected` 的每条是 `{path, reason, message}`，`message` 按 `reason` 固定。

| `reason` | `message` |
|---|---|
| `outside` | `目标路径不在你的沙箱内` |
| `not_file` | `不是普通文件，或文件不存在` |
| `too_large` | `文件超过大小上限` |
| `unsupported_type` | `这个模板不支持这种文件` |
| `empty` | `文件是空的，不能入库` |
| `offline` | `挂载已离线` |
| `duplicate` | `已在知识库里` |
| `limit` | `知识库文档数已达上限` |
| `changed` | `读取期间文件发生了变化` |
| `rejected` | `知识库服务拒绝了这个文件` |
| `unavailable` | `知识库服务暂不可用` |

`documents` 的每条是 `DocumentView`，不读 RAGFlow：`status` 为 `queued`，`chunkCount`、`message` 为 `null`，`sourceChanged` 为 `false`。文档名取本地记录，RAGFlow 对同名文件的改名（`a(1).txt`）不影响它。

**RAGFlow 文档的删除写法**（`removeRagflowDocument`）：`code:0` 不代表删成了，`RUNNING`、`STOPPING` 的文档回 `deleted:0` 且行仍在。

1. 发删除。`deleted:1` 或不存在：完成。不可达或被拒：`failed`。
2. `deleted:0`：发一次停止解析，只发这一次。`code:0`（不论 `success_count`）或不存在：继续。其余：`failed`，不再删。
3. 每 500 ms 重发删除，至多 5 s。`deleted:1` 或不存在：完成。不可达或被拒：立即 `failed`。
4. 到期仍是 `deleted:0`：`busy`。

入库的补偿删除与重新入库删旧文档走这个写法，`failed`、`busy` 都只写一行 `kb_document_leak`，不改变该条的结果。移出按结果映射应答（见下面的「移出文档」）。这个函数不碰本地行。

| 记录 | 何时写 | 补救 |
|---|---|---|
| `{"event":"kb_document_leak","documentId":<id>}` | 补偿删除失败：RAGFlow 里留下一份本地没有行的文档。`documentId` 是 RAGFlow 的文档 id | 按 id 在 RAGFlow 里手工删除，文档还在解析时先停止。这条记录不限频 |

**审计**：每份文档一条 `kb.ingest`，detail 恰为 `{id, source:"workspace", workspaceId, path, documentId}`，`documentId` 是本地文档 id，与插行同一事务；每个被拒条目一条 `kb.ingest_reject`，detail 恰为 `{id, source:"workspace", workspaceId, path, reason}`，单独写入。两者的 `workspace_id` 列都是该工作空间，标题是固定短句，不带用户文本与文件内容。

**本地上传**（`server/src/kb/uploads.ts`，组 12）：`POST /api/kb/bases/:id/uploads?name=<文件名>`，请求体是 `application/octet-stream`，带 `Cache-Control: no-store`。请求体直接拼进出站 multipart，不落盘，不留副本。这条路由不经沙箱，文件名规则是 `workspaces` 的 `parseUploadFileName`：恰一个、非空、不含 `/`、无拒绝字符、无临时前缀、不超过 255 字节。失败的应答都带 `Connection: close`。

取锁之前依次判定，都不读请求体，不发出站请求：

| 判定 | 应答 | `kb.ingest_reject` 的 `reason` |
|---|---|---|
| 别人的或不存在的 id | 404 `not_found` | 不写 |
| 媒体类型不是 octet-stream，文件名规则不过，没有 `Content-Length`（含分块传输） | 400 `bad_request` | 不写 |
| `Content-Length` 超过 `KB_UPLOAD_MAX_BYTES` | 413 `upload_too_large` | `too_large` |
| 后缀不在模板的表里，判定同工作空间来源 | 400 `kb_file_unsupported` | `unsupported_type` |
| `Content-Length` 为 0 | 400 `kb_file_unsupported` | `empty` |
| `state` 不是 `ready` | 409 `kb_rebuilding` | 不写 |

之后在该库的写锁下：重判库与 `state`；已有 500 份时 409 `kb_limit`，审计 `limit`；排队期间已察觉连接断开的什么都不发，socket 已停读时要读到才察觉，这时走中止，不留文档；然后上传、触发解析、同事务插行与 `kb.ingest`，应答 201 `DocumentView`，不读 RAGFlow：`source` 为 `upload`，`workspaceId`、`path`、`sourceChanged` 为 `null`，`status` 为 `queued`，`chunkCount`、`message` 为 `null`。

| 结果 | 应答 | 删除刚上传的文档 |
|---|---|---|
| 客户端断开、短体或超过读请求体期限 | 中止出站，400 `bad_request`，不写审计 | 没有文档（§7.2） |
| 上传 `code:500` 且 message 表明不支持这种文件 | 400 `kb_file_unsupported`，审计 `unsupported_type` | 没有文档 |
| 上传 `kb_rejected` | 400 `kb_rejected` | 没有文档 |
| 上传不可达或数据集不存在 | 503 `kb_unavailable` | 没有文档 |
| 解析触发 `kb_rejected` 或 `success_count:0` | 400 `kb_rejected` | 删 |
| 解析触发不可达或数据集不存在 | 503 `kb_unavailable` | 删 |
| 插行或审计失败 | 500 | 删 |

删除走上面的写法，失败只写一行 `kb_document_leak`。写锁持到请求体读完，时长不由客户端决定：读请求体的总期限从取到写锁起算，排队时间不算，`max(60 s, Content-Length ÷ 64 KiB/s)`，缺省上限下约 27 分钟，持续滴发也逃不过。请求体停着不发时，这条期限与出站 60 s 空闲期限谁先到算谁：总期限 400 `bad_request`，空闲 503 `kb_unavailable`。

审计：`kb.ingest` 的 detail 恰为 `{id, source:"upload", name, size, documentId}`，`kb.ingest_reject` 恰为 `{id, source:"upload", name, reason}`，只写上面两张表里列出的 `reason`。`workspace_id` 列是 null。

**文档列表**（`server/src/kb/documents.ts`，组 11）：`GET /api/kb/bases/:id/documents`，200 `{documents: DocumentView[]}`，按 `created_at` 升序，带 `Cache-Control: no-store`，不写审计。别人的或不存在的 id 404 `not_found`，不发出站请求。不取写锁，不判 `state`。

状态以 RAGFlow 为准，每次请求现读，不起后台轮询：先读本地行，再读全该数据集的文档（`page_size=100`、`orderby=create_time`、`desc=false`，读到 `total` 或空页为止，不设页数上限），按 RAGFlow 文档 id 关联。`name` 取本地记录。

| `ingestion_status` | `status` | `chunkCount` | `message` |
|---|---|---|---|
| `UNSTART` | `unparsed` | `null` | `null` |
| `CREATED`、`SCHEDULED` | `queued` | `null` | `null` |
| `RUNNING`、`STOPPING` | `parsing` | `null` | `null` |
| `STOPPED` | `cancelled` | `null` | `null` |
| `COMPLETED` | `done` | `chunk_count`，可以是 0 | `null` |
| `FAILED` | `failed` | `null` | `解析失败` |
| 列表里没有该 id，或数据集 not-found | `missing` | `null` | `null` |
| 其它取值，这一行有没有本地行都一样 | 整个请求 503 `kb_unavailable` | | |

RAGFlow 不可达 503 `kb_unavailable`，翻页到一半也是，不给半张表。`code:101`、`102` 走通用映射 400 `kb_rejected`。

`sourceChanged` 只对工作空间来源计算，上传来源为 `null`。用工作空间根加纯函数 `resolve`，不经 facade，所以读不到不写 `sandbox.reject`，再 stat，挂载内经挂载的适配器：

| 情形 | `sourceChanged` |
|---|---|
| 大小与修改时间都和入库记录相同 | `false` |
| 任一不同，文件已不存在，或已不是普通文件 | `true` |
| 解析被拒（含路径上的符号链接）、工作空间不可见、挂载离线 | `null` |

**移出文档**（`server/src/kb/documents.ts`，组 13 首刀）：`DELETE /api/kb/bases/:id/documents?doc=<文档 id>`，`doc` 是本地文档 id，带 `Cache-Control: no-store`。不读 body，不读沙箱，源文件不动。取锁之前依次判定，都不发出站请求、不写审计：

| 判定 | 应答 |
|---|---|
| 别人的或不存在的知识库 id（先于 body 与 `doc`） | 404 `not_found` |
| `doc` 缺失、为空或多值 | 400 `bad_request` |
| `state` 为 `rebuilding`，或写锁正被重建器持有（不排队）；`rebuild_failed` 照常移出 | 409 `kb_rebuilding` |
| `doc` 不是这个库的文档 | 404 `not_found` |

之后在该库的写锁下重判库、`state` 与文档行，按上面的删除写法删当前数据集里的 RAGFlow 文档，用锁内读到的 RAGFlow 文档 id：

| 删除写法的结果 | 应答 | 本地行 |
|---|---|---|
| 已删，含「不存在」（`code:102` 加 `These documents do not belong to dataset` 前缀，或数据集不存在） | 204 | 删除，同一事务写 `kb.document_delete` |
| `busy`：到期仍是 `deleted:0` | 409 `kb_document_busy`，稍后再试 | 不动 |
| `failed` | 不可达 503 `kb_unavailable`，被拒 400 `kb_rejected` | 不动 |

审计：`kb.document_delete` 的 detail 恰为 `{id, documentId}`，`documentId` 是本地文档 id；工作空间来源的文档 `workspace_id` 列是该工作空间，上传来源是 null。

**重新入库**（`server/src/kb/documents.ts`，组 13）：`POST /api/kb/bases/:id/documents/reingest?doc=<文档 id>`，只对工作空间来源，带 `Cache-Control: no-store`。bodyless：任意 body（含 `{}`）400 `bad_request`，在所有权判定之后。取锁之前依次判定，都不发出站请求、不写审计：

| 判定 | 应答 |
|---|---|
| 别人的或不存在的知识库 id（先于 body 与 `doc`） | 404 `not_found` |
| `doc` 缺失、为空或多值 | 400 `bad_request` |
| `state` 不是 `ready`（`rebuild_failed` 也拒），或写锁正被重建器持有（不排队） | 409 `kb_rebuilding` |
| `doc` 不是这个库的文档 | 404 `not_found` |
| 本地上传来源的文档 | 400 `bad_request` |

之后在该库的写锁下重判，旧的 RAGFlow 文档 id 取锁内读到的。按工作空间来源入库的第 1 步与第 4–7 步重读源文件并上传（查重、上限与后缀不判），先建新文档、后删旧文档：

| 结果 | 应答 | 本地行 | 新文档 |
|---|---|---|---|
| 读取被拒：工作空间已不可见、`outside`（facade 照常写 `sandbox.reject`）、`not_file`、`offline`、`empty`、`too_large`、`changed` | 409 `kb_source_unreadable` | 不动 | 没有 |
| 上传 `kb_rejected` | 400 `kb_rejected` | 不动 | 没有 |
| 上传 `code:500` 且 message 表明不支持这种文件 | 400 `kb_file_unsupported` | 不动 | 没有 |
| 上传不可达或数据集不存在 | 503 `kb_unavailable` | 不动 | 没有 |
| 解析触发 `kb_rejected` 或 `success_count:0` | 400 `kb_rejected` | 不动 | 删 |
| 解析触发不可达或数据集不存在 | 503 `kb_unavailable` | 不动 | 删 |
| 换行或审计失败 | 500 | 不动 | 删 |
| 成功 | 200 `DocumentView`，不读 RAGFlow：`status` 为 `queued`，`chunkCount`、`message` 为 `null`，`sourceChanged` 为 `false` | 单事务换 RAGFlow 文档 id、`size` 与 `source_mtime_ms`，`id`、`name`、`createdAt` 不变 | 留下；再按上面的写法删旧文档，旧文档还在解析（`busy`）或删除失败只写一行 `kb_document_leak`，应答不变 |

审计：成功时与换行同一事务写 `kb.ingest`，detail 恰为 `{id, source:"workspace", reingest:true, documentId}`，`documentId` 是本地文档 id，`workspace_id` 列是该工作空间。读取被拒不写 `kb.ingest_reject`。

**单轮检索与检索测试**（`server/src/kb/retrieval.ts`、`kb/ragflow-retrieval.ts`，s2b-kb-retrieval 组 4；[ADR-0017](../adr/0017-agentic-retrieval-model-driven.md)）。`kb` 模块只有单轮检索，没有改写问句、充分性判定与第二轮：要不要再查由会话里的模型决定。检索测试端点与 S2c 的会话内检索工具都经 `retrieveForBase` 这一个函数检索，客户端的检索方法只在这里被调用（`server/test/kb-retrieval-canonical.test.ts` 扫源码守住）。

- **请求**：对该库当前的 `dataset_id`（不是重建中的 `rebuild_dataset_id`）发 `POST /api/v1/retrieval`，body 恰为 `{question, dataset_ids:[<dataset_id>], similarity_threshold, vector_similarity_weight, page:1, page_size:6}`；配置了重排模型时另带 `rerank_id = <名称>@owb-rerank@OpenAI-API-Compatible`，未配置时连这个键都不发，重排模型的探活状态不影响带不带（每次检索开头读一次设置）。不发 `top_k`、`keyword`、`highlight`、`use_kg` 与 `document_ids`（带 `document_ids` 时召回面不同，命中分可以是 0，实测记录续篇 §19.1）。
- **参数恒显式传**：每个库的阈值与向量权重存在本地 `knowledge_bases` 的两列（迁移 051，`retrieval_threshold`、`retrieval_vector_weight`，0–1，CHECK 约束），新库与升级前已有的库缺省都是**阈值 0.2、向量权重 0.7**。RAGFlow 数据集上的检索字段经 API 改不了（`PUT` 回 `code:101`，续篇 §19.2），不传就落到 RAGFlow 自己的缺省（阈值 0.2、权重相当于 0.3），所以每次检索都把库里存的两个值显式传过去。
- **结果**：`code:0` 时读 `data.chunks`，须是数组（零命中为 `[]`），每项须有字符串 `document_id`、`content` 与数字 `similarity`，否则按「成功应答缺字段」为 503 `kb_unavailable`。检索路由的 HTTP 200 `code:102` 是「检索失败」，按这次请求带没带 `rerank_id` 处理（重排降级，「不重试」规则的唯一例外，design D3）：带了的，去掉 `rerank_id`、其余字段不变，重试恰一次，并经受管 stderr writer 写一行，恰为 `{"event":"kb_rerank_degraded"}`；同一进程 60 秒内至多一行（进程级，不按库分），不含密钥、上游地址与 message；重试的结果按普通检索处理，应答里没有降级标记。没带的（包括那次重试）为 503 `kb_unavailable`。超时、`code:101`（400 `kb_rejected`）、`code:404` 与 HTTP 5xx 都不重试，其余照通用映射。`code:102` 区分不出是不是重排引起的（续篇 §19.4）：嵌入上游故障之类的 102 也会多一次不带重排的请求和一行误报的 `kb_rerank_degraded`，再以 503 结束；两次各受 30 s 总期限，最坏耗时 2×30 s = 60 s。RAGFlow 的 message 不进应答与日志。
- **命中关联**：切片的 `document_id` 只对本库的本地文档行（`ragflow_document_id`）关联，名称取本地 `name`；关联不上的切片丢弃，不报错，不暴露 RAGFlow 侧或别的库的文档名。同一文档的多条切片各成一条命中，次序同 RAGFlow 应答，本系统不重排序。命中为 `{documentId, name, similarity, content}`，`documentId` 是本地文档 id。零候选或全部丢弃时为空数组。
- **已知行为：候选由全文匹配圈定**。阈值设为 0 时也只回与问句有词重叠的切片（续篇 §19.1，[INFERENCE] 候选由全文匹配圈定，向量分只参与排序和阈值）。不带重排时三个分数恒等，都等于「向量权重 × 向量相似度」，所以纯语义的问句在低向量权重下可能零命中；要调的是本库的向量权重，不是问句。

**检索测试端点**：`POST /api/kb/bases/:id/retrieval`，只对所有者，body limit 16 KiB，在 content-parser 归属集（坏 JSON、空 body、非 JSON 媒体类型、超限都是 400 `bad_request`），应答带 `Cache-Control: no-store`。依次判定，前三步都不发出站请求、不写审计：

1. 所有权：别人的或不存在的 id 404 `not_found`，先于 body 解析（坏 JSON 也是 404）。
2. body 键集恰为 `question`、`threshold`、`vectorWeight`：`question` 去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL，原样发出、不 trim；两个参数是 0–1 的有限数字（含两端）。不符 400 `bad_request`，先于 `state`。
3. `state` 不是 `ready`（含 `rebuild_failed`）：409 `kb_rebuilding`。
4. 两个参数与已存值逐个比较（数值相等）。相同：不取锁、不写、不审计，直接检索（重建器持锁时照样能检索）。不同：取该库的写锁，排在在途的入库、上传、重新入库、移出与删库之后；锁正被重建器持有时 409 `kb_rebuilding`。取锁后重读：库已删 404 `not_found`，`state` 不是 `ready` 409；用重读的值再比较一次，已相同（并发的相同提交）就不写、不审计；仍不同才在同一事务里写两列并审计 `kb.retrieval_settings`，然后释放锁。写入或审计失败：事务回滚，通用 500（body 不声称任何 typed code），不检索，参数不变。
5. 在锁外检索，用的是库里存的行（写回后的值），不用请求 body。写回成功之后检索失败时，参数已经保存，应答是检索的失败（如 503 `kb_unavailable`）。

成功 200 恰为 `{hits, retrieval}`：`hits` 是上面的命中数组，`retrieval` 是 `{threshold, vectorWeight}`，取这次检索实际使用的已存值，与 `BaseView.retrieval` 同形。检索本身不写审计。

审计：`kb.retrieval_settings` 只在参数实际写回时写一条，与两列的写入同一事务，actor 为请求的所有者，`workspace_id` 列为 null，标题是固定短句「修改检索参数」；detail 恰为 `{id, before:{threshold, vectorWeight}, after:{threshold, vectorWeight}}`，`id` 是知识库 id，`before` 取锁内重读的值，`after` 是提交的值。问句只发给 RAGFlow，不进审计与日志。

**会话检索 `kb_search`**（`server/src/kb/session-search.ts`、`sessions/omp/host-tools.ts`、`sessions/host-tool-align.ts`、`sessions/kb-hits.ts`，S2c change `s2c-kb-session`；规格 knowledge-bases「会话检索 `kb_search`」、omp-runtime「宿主工具协议」「`kb_search` 的注册」）。会话里的 omp 模型经 host tool 调用 `kb_search`，app-server 以会话所有者的身份，对每个指定的库做一次上面的单轮检索；要不要再查由模型决定（ADR-0017）。可检索的库就是所有者自己的库（`session-search.ts:134-135` 只读 `listBases(ownerId)`）；可见范围四档、共享只读与跨账号检索审计在 change B。omp 侧的帧形以实测记录 `docs/reviews/2026-11-10-omp-host-tools.md`（v18.12.3）为准。

**给模型什么，`details` 与 `kb.hits` 里是什么**：

- 宿主对每个调用至多写一帧（被取消或写端关闭后不写）`host_tool_result{id, result:{content:[{type:"text", text}], details?}, isError?}`（`host-tools.ts:111-124`）。`text` 进模型上下文，只有切片原文与出处：每个库一段，段间空一行；`ok` 的段首行为 `知识库「<名称>」（<id>）：命中 N 条`，之后每条命中两行，`[k] <文档名>（相似度 0.xxxx）` 与切片原文（`session-search.ts:111-129`）。没有整篇文档（CONTEXT.md 不变量 2）。
- `details` 恰为 `{bases:[{kbId, name, status, hits}]}`，次序同文本（`session-search.ts:185-189`）；`hits` 与检索测试的命中同形，`not_found` 的 `name` 为 `null`，非 `ok` 的 `hits` 为 `[]`。omp 把 `details` 原样放进 `tool_execution_end.result.details`，不发给上游（实测记录 §2.5）。本仓对这一点的证据只有本机门控用例 `server/test/omp-official-host-tools.test.ts`（上游第二、三次请求的 tool 消息不含键名 `bases`），CI 不跑它。
- `kb.hits{messageId, stepId, intent, bases}`：reducer 只从成功的 `kb_search` 步骤派生，`bases` 原样取 `details.bases`，排在同一调用的 `step.end` 之前（`sessions/events.ts:311-315`）；`intent` 取 `tool_execution_start` 顶层的 `intent`（omp 往参数 schema 里加的 `i`），不是非空字符串时为 `null`（`events.ts:252-253`）。supervisor 发布前严格校验（`kb-hits.ts:72-99`），不符就丢弃并写一行 `{"event":"kb_hits_invalid","messageId":<id>}`（不含切片原文，不限频）；`stepId` 换成落库步骤的数字 id，映射不到即丢（`turn-control.ts:336-341`）。它与 `turn.retry` 一样占当代环形缓冲的一个序号、不写任何表：同一 epoch 内带 `Last-Event-ID` 的重连可以回放，经完整快照恢复的连接看不到。
- 切片原文不进日志与 stderr。会话检索不写回检索参数、不写审计（`session-search.ts:9-11`）。

**上限**：

- **库数**：每次调用至多 5 个库，超过时文本恰为 `一次至多检索 5 个知识库`。
- **每库条数**：就是单轮检索的 `page_size:6`（`ragflow-retrieval.ts:26`），本地不截断。`kb.hits` 的校验要求每库 `hits` 至多 6 条（`kb-hits.ts:45`、`:94-96`）：RAGFlow 回得更多时，给模型的文本照样全给，`kb.hits` 整个被丢弃（fail-closed），检索卡那一行没有命中。
- **问句**：与检索测试端点同一个判定函数 `isQuestion`（`retrieval.ts:145-149`）：去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL；原样检索，不去空白。
- **参数键集**恰为 `question`、`kb_ids`。omp 加的 `i` 不在 `host_tool_call.arguments` 里（实测记录 §2.2）。
- **`kb_ids` 的两处计数不一致**：schema 写 `minItems:1, maxItems:5`（`session-search.ts:32`），执行时先按首次出现去重、再判 1–5 个（`session-search.ts:94-100`）。原始 6 个、去重后不超过 5 个的数组违反 schema，执行照常受理（用例 `server/test/kb-session-search.test.ts:359`）。omp 会不会在发 `host_tool_call` 之前按 schema 拦下它，没有实测。

参数不合规时结果为 `isError`，文本说明哪里不符，没有 `details`，不访问 RAGFlow。

**逐库结果**（按去重后的次序）：

| `status` | 何时 | 给模型的那一行 |
|---|---|---|
| `ok` | 单轮检索成功，命中可以为 0 条 | `知识库「<名称>」（<id>）：命中 N 条` 加命中 |
| `not_found` | 不存在，或不是所有者的库。两种情形的文本与 `details` 除 `kbId` 外完全相同，不回显名称，不能据此探测别人的库 | `知识库 <id>：未找到该知识库` |
| `not_ready` | `state` 不是 `ready`，不检索。`rebuilding` 与 `rebuild_failed` 都落在这里，`rebuild_failed` 也写「正在重建」（`session-search.ts:146-147`、`:116-117`），对模型不准确 | `知识库「<名称>」（<id>）：正在重建，本轮未检索` |
| `failed` | 单轮检索 `kb_unavailable` / `kb_rejected`，含调用被中止 | `知识库「<名称>」（<id>）：检索失败` |

`isError` 当且仅当没有一个库是 `ok`（`session-search.ts:188`）。这时 omp 以失败结束这一步，而 reducer 不从失败的步骤、也不从 `result.isError` 为真的结果派生候选（`events.ts:277`、`:283-284`、`:345`），所以没有 `kb.hits`：检索卡上这一行只有问句与「失败」状态。

**协议**（`host-tools.ts`，白盒关键路径）：每个 `host_tool_call` 以帧的 `id` 进在途表，交给处理函数并附一个中止信号；多个调用并发，互不等待（`host-tools.ts:64-71`）。`host_tool_cancel{targetId}` 中止对应的处理，之后的结果不写（`:49-51`、`:81-83`）；中止信号经单轮检索传到 RAGFlow 请求（`retrieval.ts:97-102`、`ragflow-retrieval.ts:88`），该库为 `failed`。进程退出或写端关闭时中止全部在途调用，不再写帧。处理函数抛错回 `工具执行失败`，错误原文不进帧与日志；不认识的工具名回 `未知工具`；应答超过 1 MiB 帧长时先去掉 `details`，仍超过回 `工具结果过大`（`:94-108`）。没被取消、写端也没关闭时，每个调用恰有一帧应答：omp 在 5 s 内不会自己让调用超时（§2.7），更长没测，所以不能依赖它。

**注册**（`host-tool-align.ts:72-88`）：派发前对齐的第 3 步，在 `set_model` / `set_thinking_level` 之后、`prompt`（regenerate 是 `get_branch_messages`）之前（`supervisor.ts:409-412`）。

- 定义恰为 `{name:"kb_search", label:"知识库检索", description, parameters, loadMode:"essential"}`（`session-search.ts:157-173`）：缺省 `loadMode` 的工具不进模型的 `tools`（§2.1）。描述末尾逐行列所有者的全部库 `- <名称>（<id>）`，按建库时间升序；定义只读本地库表，不访问 RAGFlow。
- 每个 generation 记下上次成功注册的库清单，新 generation（spawn、resume、空闲回收之后）从「尚未注册」开始：host tool 不随会话文件保存（§2.8）。清单变了就重发；库全删了发 `set_host_tools{tools:[]}`；从来没有定义（知识库关闭，或所有者没有库）就一帧都不发，帧序与 S2c 之前相同。回合进行中清单变了不重发。
- 应答须为 `success:true` 且 `data.toolNames` 恰为 `["kb_search"]`（撤下时为 `[]`），否则这一步失败：slot 退役，prompt 以 502 `agent_unavailable` 失败。
- 处理函数在 slot 构造进程时绑定为「以所有者执行」（`pool.ts:305-314`），模型给的 kb_id 只按这个所有者判定。fork 与撤回的临时进程不注册、不注入处理函数。
- 装配：`registerKb` 建会话检索（`kb/index.ts:192`），`app.ts` 迟绑定注入 sessions（`app.ts:234-235`、`:350-351`）；sessions 不导入 kb。

**审批放行**（`ui-requests.ts:78-81`、`omp/process.ts:601-618`；规格 tool-approval「审批请求识别」）：`write`、`always-ask` 下 omp 对每次 `kb_search` 调用都发 `select`，标题恰为 `Allow tool: kb_search`（§2.4）；`yolo` 下不发。这一代进程不是 `always-ask` 时，传输层立即答 `Approve`：不登记审批、不发 `approval.request`、不写 `chat_approvals`、不审计。`always-ask` 照常交给所有者，检索卡那一行显示 `已拒绝` 或 `超时自动允许`。只认整个标题恰好相等：带第二行，或工具名不同（如 `kb_search_extra`）的不放行。残余：[INFERENCE] 放行只看标题，工作空间里项目层的同名工具 `.omp/tools/kb_search` 只要出同一标题的确认卡，在 `write` 档下也会被放行。这是 ADR-0012 已接受残余（项目层 `.omp/tools` 不拦）的延伸；同名项目工具与宿主 `kb_search` 在真实 omp 上怎样共存没有测过。

**知识库引用**（`sessions/store-knowledge-bases.ts`、`sessions/slash-commands.ts:330-339`，迁移 052；规格 message-attachments「prompt 引用知识库」）：

- 迁移 `052_chat_message_knowledge_bases.sql` 给 `chat_messages` 加 `knowledge_bases TEXT NULL`：只 `ADD COLUMN`，无缺省、无 CHECK，存量行不回填。
- prompt body 可带 `knowledgeBases`：须为至多 5 个互不相同的非空字符串，否则 400 `bad_request`；任何一个不是调用者的库即 404 `not_found`，不存在、别人的库与知识库关闭三者 body 相同（`store-knowledge-bases.ts:38-61`）。判定在附件之后、受理之前（`sessions/rest.ts:340`），不访问 RAGFlow，不审计，不放宽空文本规则。它只是给模型的提示，不限制 `kb_search` 能查哪些库。
- 受理时在同一事务里落紧凑 JSON `[{id, name}]`，名称取受理那一刻的本地值；无引用为 NULL。坏值整列读作 `[]`，不改写列（`store-knowledge-bases.ts:68-100`）。
- 后缀 `promptSuffix(paths, kbs)` 是唯一构造：附件段之后接引用段，`\n\n用户在本条消息中引用了以下知识库，可以用 kb_search 检索：` 再逐项 `\n- <名称>（<id>）`。无引用时与之前逐字节相同，存量会话的重新生成、fork 与撤回的对位不受影响；有引用的消息按落库的引用快照重建后缀再对位（`branch-temp.ts:200`）。
- 消息快照每条消息带第十四键 `knowledgeBases`（助手消息恒为 `[]`），读取时不核对库是否还在；事件流不带引用。
- fork 原样拷贝被复制消息的这一列（`store-branch.ts:259`）；fork 与撤回的应答不回填引用。
- 已知缺口：内置斜杠命令带引用按规格字面受理，`{message:"/compact", knowledgeBases:["k1"]}` 为 202 并派发 `/compact` 接引用段（用例 `server/test/prompt-knowledge-bases.test.ts:279`）；而内置命令带附件是 400（`prompt-attachments.ts:142`）。是否也拒绝引用待 owner 裁定。

**web**（界面契约在 chat-web「会话知识库检索卡」、message-attachments「输入框知识库引用」「用户气泡中的知识库引用」）：

- 「+」菜单在 `上传文件` 之后有 `引用知识库…`，只在 `GET /api/kb/status` 回 `enabled:true` 时出现（`web/src/features/chat/page.tsx:151-159`、`capability-bar.tsx:240-250`）。它打开选择列表 `引用知识库`（`kb-ref-picker.tsx`），非 `ready` 的库同样可选，满 5 个后其余禁用；标签区 `引用的知识库` 在文本框上方，欢迎态可暂存，首次发送带上。
- 用户气泡在文本与附件下方列出引用的库名，纯文本（`message-thread.tsx:174-193`）。
- 一条消息里的 `kb_search` 步骤合成一张「知识库检索」卡，放在第一个 `kb_search` 步骤的位置（`message-segments.ts:90-95`、`kb-search-card.tsx`），不计入工具段摘要（`tool-summary.ts:39`）。每次调用一行：`第 N 轮`、意图（没有时用问句）、命中条数、状态。
- 命中只来自实时的 `kb.hits`（`stream-kb-hits.ts`）。任何一次快照安装都把每个步骤的 `kbHits` 置为 `null`（`stream.ts:154`），所以刷新或经快照恢复之后，卡上只剩各轮的问句与状态，行不可展开（G12 已接受）。

**测试说明**：

- CI 覆盖协议面：假 omp 的 `host-tool`、`host-tool-parallel`、`host-tool-abort`、`host-tool-register-fail` 场景（`server/test/support/fake-omp-host-tool.mjs`），以及 ui-walk 分支 `web/e2e/ui-walk-chat-kb.ts`（只用 `page.route` 桩，CI 不配 RAGFlow）。
- 受控假上游的标记 `WORKBUDDY_KB_SEARCH:<kbId>`（`server/test/support/fake-upstream-kb.mjs`）：以本回合最后一条 user 消息之后的 tool 消息条数为准，0 条回第一次 `kb_search`，1 条回第二次（问句加 ` 详细说明`），2 条及以上回固定正文 `已根据知识库检索结果作答。`；请求的 `tools` 里没有 `kb_search` 时标记不生效。
- 真实 omp v18.12.3 把日期与 cwd 的 `<system-reminder>` 作为同一条 user 消息的第一个 text part 发出（#1975 实测），所以标记解析先去掉从开头到第一个 `</system-reminder>` 的整块，没有闭合标签时原样保留（`fake-upstream-kb.mjs:13-15`）。这与 #1769 那种整条提醒消息是两种形状。
- 本机门控回归 `server/test/omp-official-host-tools.test.ts`（`WORKBUDDY_OMP_TEST=1`，CI 跳过）：官方二进制在 `write` 档跑两轮 `kb_search`，断言两条 `kb.hits`、没有 `approval.request`、`details` 不进上游。单跑用文件头的命令；与全部官方门控用例一起跑时要加 `--maxWorkers=4`，默认并发下大量用例握手超时（#2002）。
- 真实模型与真实 RAGFlow 下的会话检索是验收行 CK-15–CK-18，由 owner 执行。

**嵌入模型更换与全量重建**（`server/src/kb/rebuild.ts`、`kb/settings.ts`，组 14）。换嵌入模型的数据集不能就地改：`PUT /datasets/<id>` 改 `embedding_model` 不重算向量（实测记录 §6），所以每个库建一代新数据集，把入库原件从旧数据集搬过去。

确认：`PUT /api/kb/settings` 带 `confirmRebuild:true` 换嵌入身份，下发成功后在同一事务里写设置、嵌入代数加一、全部知识库置 `rebuilding`、`kb_settings.rebuild_actor_id` 记为这次的管理员，并审计两条：`kb.settings` 与 `kb.rebuild`（detail 恰为 `{bases, documents}`，受影响的库数与文档数）。提交之后唤醒重建器。重建期间：入库、上传、重新入库与删库都 409 `kb_rebuilding`，移出也 409；再换嵌入身份 409 `kb_rebuilding`，只换密钥照常；有开编译的库时 `chatModelId` 照旧锁定。

重建器在进程内一次处理一个库，按 `created_at`、`id` 的次序，处理期间持有该库的写锁：锁正被它持有时写操作立即 409，不排队；它自己排在在途写操作之后，拿到锁才读文档清单，所以排在前面的上传进入新数据集。拿到锁先重读库行，库已删除或不再是 `rebuilding` 即跳过，什么都不建。每个库：

1. 有残留的一代（`rebuild_dataset_id` 非空：上次失败或崩溃留下的）就按删除次序删掉它，「不存在」视为已删，再置空三个 `rebuild_*` 列。
2. 以原模板与开关、新嵌入模型建新一代，名为 `owb-<id 前 16 位>-g<新代数>`，写回 `rebuild_*`。两个开关都关的库只建 `parse_type:1` 数据集，不读账号缺省；开了开关的库新建模板组与画布，不复用旧的，账号缺省缺失即失败、不发后续请求。
3. 逐份文档：从旧数据集下载入库原件，原样拼进 multipart 上传到新数据集（不落盘），再触发这一份的解析。multipart 长度按本地记录的 `size` 算，字节在流上数：多出一个字节当场中止上传并销毁下载流，少了不发结束边界，RAGFlow 都不留文档。下载判为 not-found 的文档跳过；字节不符、上传失败、解析触发失败（含 `success_count:0`）都让这个库失败。
4. 单事务切换：删掉被跳过的文档行，其余行换成新的 RAGFlow 文档 id；当前一代的三个 id 换成新一代，`rebuild_*` 置空，代数换成新代数，`state` 为 `ready`；同事务审计 `kb.rebuild`，detail 恰为 `{id, result:"ok", skipped}`，`skipped` 是被跳过的本地文档 id。
5. 按删除次序删旧一代。删不掉不影响状态，只写一行（同上面的 leak 表）：数据集删不掉写 `kb_dataset_leak`，它的画布与模板组不再去删；画布删不掉写 `kb_pipeline_leak`（两个 id 都在）；模板组删不掉同样写 `kb_pipeline_leak`（`canvasId` 为 `null`）。补救同 leak 表。

任一步失败：该库 `rebuild_failed`，`stateMessage` 为 `重建失败，可在模型设置里重试`，不带 RAGFlow 原文；同事务审计 `kb.rebuild {id, result:"failed"}`。`rebuild_*` 留着，重试的第 1 步删掉它们。`rebuild_failed` 的库可以移出文档（删的是当前一代里的文档），可以删库（先删新一代再删当前一代），不能入库、上传与重新入库。重建器写的审计，actor 一律是 `rebuild_actor_id`。

**下载判别**（实测记录 §9.1）：not-found 也是 HTTP 200，文件内容又可以恰好等于 not-found 的正文，所以只看响应头：HTTP 200 且带 `Content-Disposition` 是文件字节，正文一律不解析，不看 `Content-Type`、`Content-Length` 与后缀；HTTP 200 不带这个头才按 JSON 读，`code:404` 是 not-found（跳过），别的按 RAGFlow 出站请求的通用映射（这个库失败）；非 200 同样走通用映射。0 字节文件的下载是不带头的 `code:500`，入库时就拒绝了空文件，重建碰不到它。这个判据只在直连实例上验证过：中间若有代理剥掉这个头，下载判为失败，该库 `rebuild_failed`，不会把错误应答当文件上传。

**重试**：`POST /api/kb/settings/rebuild`，管理员专用（非管理员 403，未登录 401），bodyless（任意 body，含 `{}`，400）。在设置锁内把全部 `rebuild_failed` 置回 `rebuilding`，`rebuild_actor_id` 改为这次的管理员，审计 `kb.rebuild {bases, documents, retry:true}`（重试的库数与它们的文档数），唤醒重建器，应答 200 加读视图。没有失败库时 200，不写库、不审计、不发任何请求。

**续做与关停**：入口在写出 `server_started` 之后、不等待地启动重建器，对仍是 `rebuilding` 的库从第 1 步做起。续做中的失败只改变知识库状态，不写 failure record，不改变退出码（RAGFlow 不可达时该库 `rebuild_failed`，重试即可）。关停时，在关闭主实例与 DB 之前停住重建器：在途的 RAGFlow 请求被中止，只等正在持锁处理的那一个库收尾，不等排在写锁队列里的（一个在途的本地上传最长约 27 分钟，等它会拖住关停）。中止不算失败：第 4 步提交之前该库保持 `rebuilding`，下次启动续做；提交之后已是 `ready`，第 5 步没删完的旧一代不续删，成为孤儿，那一步中止的删除照样写一行 leak，按 leak 表手工清理。未配置 `RAGFLOW_BASE_URL` 时重建器不启动，`rebuilding` 的库保持原状、不改成 `rebuild_failed`，重新配置之后下次启动续做。

**部署要求**（组 18）：

- 一个已在运行的 RAGFlow 服务，版本恰为 `v1.0.0-rc2`（`kb/rest.ts` 的常量，见上面的「版本钉住」），`DOC_ENGINE=infinity`（ADR-0005）。本系统只当客户端用它：不启动、不停止、不配置它的容器（D16）。共用栈上别的账号的数据集与模型配置不归本系统管。
- 专用的 RAGFlow 账号和它的 API key。key 写进 `0600` 的普通文件，按上面「密钥文件」的四条要求放好，`RAGFLOW_API_KEY_FILE` 指向它；`RAGFLOW_BASE_URL` 与它成对配置。
- 网络：app-server 能访问 `<RAGFLOW_BASE_URL>`；RAGFlow 能访问嵌入模型与知识库对话模型的上游（嵌入请求由 RAGFlow 直接发出，不经 app-server 的模型代理）。
- 迁移 050 随启动自动执行，只建三张表、插入 `kb_settings` 的唯一一行，不改既有表。
- 启动后，管理员在「中心」的「模型」tab 的「知识库模型」段保存嵌入模型；要开 RAPTOR / 知识图谱，还要指定知识库对话模型。保存会把两个模型下发到这个账号并设为账号缺省（见上面「下发的固定序列」）。之后 `GET /api/kb/status` 应为 `available:true`、`embeddingReady:true`，指定了对话模型时 `compileReady:true`。
- 单次上传的大小与文件数上限按需调整 `KB_UPLOAD_MAX_BYTES`、`KB_UPLOAD_MAX_FILES`。

**回滚**：

- 去掉 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY_FILE` 两个键并重启，知识库即关闭：tab 不出现，`/api/kb/*` 返回 503 `kb_disabled`（`/api/kb/status` 除外），`models` 的删除与修改不再受联动约束。本地的三张表与行保留，重新配置后照常可用；仍是 `rebuilding` 的库在下次启动时续做。
- 回退代码时迁移文件保留：迁移账本拒收多出的回执，规则同 049。
- RAGFlow 里的 `owb-` 数据集、画布与模板组由运维按需清理。次序按实测记录 §16：账号缺省模型保持不动，先删数据集、画布与模板组，等到没有编译活动，才清缺省、删模型实例。账号上还有 pipeline 数据集时清空缺省对话模型，会让全栈唯一的入库进程崩溃循环（上面的「账号缺省不变量」）。`owb-rerank` 不是账号缺省，删除它没有 §13 的风险。
- 删除的 `kbservice/` 不能靠配置恢复，需要时从 git 历史恢复。

**真实端点冒烟 `make smoke-kb`**（`Makefile`、`smoke/kb.hurl`、`smoke/kb-cleanup.hurl`，组 18 首刀）。它在验证矩阵里是 `review-only` / `required_at: manual`：`make smoke` 与 CI 都不调用它，真实运行是 owner 的验收行 CK-11。前提：

- 调用方的服务已在运行，已按上面的部署要求接上 RAGFlow，两个模型都已配置（状态四项都为 true）。
- 启动服务前，调用方已把 `smoke/fixtures/sandbox/u1/` 复制到该服务的 `SANDBOX_ROOT/u1`（`smoke/fixtures/README.md`）。`make smoke-kb` 不替它复制，也不启动、停止或配置服务与 RAGFlow。
- 本机有 hurl 8.0.1 与 Node 18 或更高版本。

运行：`SMOKE_BASE_URL=<服务地址> make smoke-kb`。它先依次做三项检测，任一不过就退出，不发任何知识库请求，也不执行任何 `docker` 命令：

1. 没有设置 `RAGFLOW_BASE_URL`：「RAGFlow 私有配置缺失」。
2. 本机没有 Node 18+：「未找到 Node 18+（版本检测需要 fetch）」。
3. `GET <RAGFLOW_BASE_URL>/api/v1/system/version` 不通，或版本不是 `v1.0.0-rc2`：「共用 RAGFlow 栈未运行或版本不符」。判据与服务端的状态端点相同：不带密钥，总期限 5 s，不跟随重定向。

之后，`kb-cleanup.hurl` 先删掉上次残留的 `smoke-kb` 与 `smoke-kb-compile`。接着 `kb.hurl` 以成员账号走完整条流程：

1. 状态检查。
2. 采用工作空间 `smoke-kb`，建普通库 `smoke-kb`，入库 `notes.md` 与 `brief.pdf`，轮询到两份都 `done` 且切片数大于 0，再以 `notes.md` 的专名检索（`threshold:0`、`vectorWeight:0.7`），断言命中非空、首条为 `notes.md`、参数已写回。
3. 上传一份文本，轮询到 `done` 后移出它，然后删库。
4. 建两个开关都开的 `smoke-kb-compile`，入库 `notes.md`，轮询到 RAPTOR 与知识图谱都是 `done`，然后删库。这是编译 DSL 对真实 RAGFlow 的唯一验证。
5. 确认列表里两个库都不在。

轮询上限是 `SMOKE_KB_POLL_SECONDS`（缺省 300），按 5 秒一次重试向上取整，不计单次请求的耗时。`kb.hurl` 失败时再跑一次清理，退出码保持 hurl 的原值；清理本身失败不改变退出码，下一次运行前的清理会再试。`brief.pdf` 是手写的极简 PDF，如果卡在它的切片数上，先换一份正常排版的小 PDF（文件名不变）再跑。
