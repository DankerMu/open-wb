# Design: s2b-kb-retrieval

## Context

动机与范围见 proposal.md。这里只写影响做法的现状与约束。

### 方向（ADR-0017）

agentic 检索的环由会话里的 omp 模型驱动：每次 `kb_search` 只执行一次「单轮检索」，改写、充分性判定与再查都由模型决定。
kb 模块里没有环。S2b 交付单轮检索、检索测试与重排模型；`kb_search` 的实现与「二轮真实触发」的验收在 S2c。

### rc2 的检索事实（实测记录续篇 `docs/reviews/2026-11-08-ragflow-rc2-retrieval.md` §19，2026-11-08；与任何文档不符时以记录为准）

续篇是 `docs/reviews/2026-10-28-ragflow-rc2-api.md` 的接续，节号从 §19 起；下文的 §4、§11、§13 指原文件。

**`POST /api/v1/retrieval`**（§19.1）：
- 应答 `data` 为 `{chunks, doc_aggs, labels, total}`。零命中时为 `{"chunks":[],"doc_aggs":[],"labels":null,"total":0}`：`chunks` 是空数组，不是 `null`。
- 切片带 `content`、`document_id`、`document_keyword`（文档名）、`similarity`、`vector_similarity`、`term_similarity` 等十六键，**没有切片序号**。
- 参数：`similarity_threshold`、`vector_similarity_weight` 都生效，取值 0–1，越界回 `code:101`；`page`、`page_size` 分页；`top_k` 截候选池。
- 不带重排时三个分数恒等，都等于 `weight × 向量相似度`。所以 RAGFlow 的缺省值（0.2 / 0.3）会滤掉纯语义命中。
- 候选看起来由全文匹配圈定 [INFERENCE]。

**数据集字段不可写**（§19.2）：`PUT /datasets` 带 `similarity_threshold`、`keywords_similarity_weight` 或 `vector_similarity_weight` 都回 `code:101 Extra inputs are not permitted`。

**重排**（§19.3、§19.4）：
- 下发：建 `model_type:["rerank"]` 的实例，走 §11.1 的同一序列。
- 引用：三段式 `<模型>@<实例>@OpenAI-API-Compatible`；两段式回 `code:102`。
- 调用：RAGFlow 调上游的 `<base_url>/rerank`。
- 失败一律 HTTP 200 `code:102`，message 原样带出上游错误体。**单凭 `code:102` 区分不出是不是重排失败**：嵌入失败的形状未测。
- 直连上游：`POST <base>/rerank`，body `{model, query, documents}`，应答 `results[].relevance_score`。模型不存在回 503，密钥无效回 401；一次耗时 22 秒。

**`use_kg`**（§19.5）：被接受，但在图谱库上看不出任何效果；没有读图谱的接口。

**不存在的数据集**（§19.1 表）：`code:404`。

### 主干现状（`636ac10b` 之后）

kb 模块：
- 路由在 `server/src/kb/rest.ts:55-64`，共十三条，含 `GET /api/kb/status`。所有权预检 `ownedBase` 在 `rest.ts:171-175`，先于 body 解析。
- `POST /api/kb/settings/probe` 是 bodyless（`rest.ts:183-193`）。

RAGFlow 客户端：
- 单出站点 `createRagflowClient`（`server/src/kb/ragflow-client.ts:481`）已 697 行，模型下发拆在兄弟文件 `ragflow-models.ts`（167 行，经 `modelCalls(json)` 并入）。
- 路由判定原语在 `ragflow-route.ts`：`Route<T, Typed>` 有 `typed` 与 `read`（`ragflow-route.ts:24-27`）。
- 「不重试」写在 ragflow-backend「RAGFlow 出站请求」。

设置与锁：
- `settings.ts`（516 行）的 `provision`（`settings.ts:215-235`）固定以 `PATCH /models/default` 结尾。
- 嵌入探活 `probeEmbedding` 在 `embedding-probe.ts:46-80`：路径与判定写死为 `embeddings` / `data[0].embedding`。
- 每库写锁 `locks.write`（`locks.ts:100-106`）：锁被重建器持有时立即 `rebuilding`，否则 FIFO 排队。

视图与表：
- `BaseView` 由 `bases.ts:168-171` 的 `viewOf` 生成。
- 写操作在 `state` 不是 `ready` 时回 409 `kb_rebuilding`（如 `documents.ts:367`、`uploads.ts:111`）。
- 迁移最新为 `050_knowledge_bases.sql`；新增迁移照 `033`、`035` 的 `ALTER TABLE … ADD COLUMN` 写法。
- 文档行 `kb_documents` 存 `ragflow_document_id` 与本地 `name`（050:78-95），名称一律取本地记录（knowledge-bases「文档列表与状态」）。

web：
- 详情是 `web/src/features/center/kb/detail.tsx`（115 行）。
- 模型 tab 的「知识库模型」段是 `web/src/features/center/models/kb-section.tsx` 加 `kb-embedding-dialog.tsx`。

## Grill 结论（2026-11-07 / 11-08，owner 逐分支拍板）

| # | 分支 | 结论 | 落点 |
|---|---|---|---|
| 1 | agentic 环落点 | omp 模型驱动，kb 模块只有单轮检索；本 change 不实现环（ADR-0017） | D1 |
| 2 | S2b 范围 | 单轮检索 + 检索测试（单轮）+ 可选全局重排模型；「二轮真实触发」移到 S2c | D1、Goals |
| 3 | `kb_search` | 只把工具契约写进规格；分派、注册、工具说明、条数与多库过滤都在 S2c，本 change 没有 `kb_search` 代码 | D9 |
| 4 | 重排模型 | 全局可选，照嵌入模型的写法：端点对话框、保存时探活（直连 `POST <base>/rerank`）、下发为 `owb-rerank`、可清除、换模型不重建、不设账号缺省；配了就一律用，没有逐次开关 | D6、D7 |
| 5 | 重排故障 | 自动降级：带 `rerank_id` 的检索得到 `code:102` 时，不带它重试恰一次；写一行不含密钥与上游 message 的 stderr 记录；用户看不到降级 | D3 |
| 6 | 可调参数 | 只有相似度阈值与向量权重（0–1）；返回条数是常量，检索测试取 6 | D2 |
| 7 | 参数存放 | 本地列，每次检索显式传（实测 §19.2：dataset 字段不可写）；新库与既有库缺省都是阈值 0.2、向量权重 0.7 | D2、D5 |
| 8 | 保存时机 | 检索时参数与已存值不同才写回：在该库写锁内先写，写成功才审计并检索；写失败就报错、不检索；参数没变只检索 | D4 |
| 9 | 审计 | 新增 `kb.retrieval_settings`，记旧值与新值；检索本身不审计 | D4 |
| 10 | 命中呈现 | 序号、文档名、综合相似度（`similarity`）、切片原文；不显示来源路径（owner 授权偏离 demo，2026-11-07）；不显示「切片 N」（rc2 应答没有序号） | D8 |
| 11 | `use_kg` | 不传；rc2 上看不出效果（§19.5） | Non-Goals |
| 12 | 验收 | 假 RAGFlow 按 §19 加检索与重排；`make smoke-kb` 加检索断言；CK 加检索测试与重排的行（`待签`） | D10 |

grill 时明确为**假设**、不是决定的三条：
- 可见范围维持 S2a 的「只有所有者」。
- 检索测试沿用详情页在知识库关闭、不可用与非 `ready` 时的行为（D8）。
- 模型不能逐次调整检索参数（由 #7 推出）。

## Goals / Non-Goals

**Goals**
- 所有者在知识库详情里用一个问句做单轮检索，看到命中的文档名、相似度与切片原文，并调整、保存该库的检索参数。
- 管理员配置一个可选的全局重排模型；配了之后所有检索都经它重排，它故障时检索照常返回（不重排）。
- 单轮检索是 kb 模块里唯一的检索实现，S2c 的 `kb_search` 直接复用。

**Non-Goals**（被划出范围的，附复活条件）
- agentic 环与 `kb_search` 的实现（S2c，ADR-0017）。kb 模块编排的环：S2c 验收发现模型自驱的多轮检索不可靠时再议。
- 检索测试里的重排开关：所有者需要对比开、关重排的效果时再加。
- 同时显示三个分数：只看综合分调不了权重时再加。
- 命中的来源路径：owner 改主意时再加（数据在 `kb_documents`）。
- `KB_RETRIEVAL_*` 环境配置键：运维提出要按部署调缺省值时再加。
- `use_kg`：RAGFlow 升级到 `/retrieval` 在 `use_kg` 下返回图谱内容的版本时再加。
- 可调的返回条数、`top_k`、`keyword`、`highlight`。
- 跨库检索、可见范围四档、共享只读、跨账号检索审计（S2c）。
- 检索记录与历史。

## Decisions

### D1 单轮检索是 kb 模块里唯一的检索实现

`server/src/kb/retrieval.ts` 导出单轮检索：输入是一个知识库行、问句与参数，输出是命中数组。检索测试端点经它执行，S2c 的 `kb_search` 也只调它。
kb 模块里没有改写、充分性判定与第二轮。

- **为什么**：ADR-0017 把环交给模型；同一逻辑只允许一个实现。
- **备选**：在 kb 模块里先做好环，留给 S2c 用。没有调用方，是死代码（knip 拦截），而且与 ADR-0017 矛盾。

### D2 检索请求的形状

对该库的当前 `dataset_id`（不是 `rebuild_dataset_id`）发：

```
POST /api/v1/retrieval
{"question", "dataset_ids":[<dataset_id>], "similarity_threshold":<库的阈值>,
 "vector_similarity_weight":<库的向量权重>, "page":1, "page_size":6, "rerank_id"?}
```

- 阈值与权重**恒显式传**：dataset 上的值改不了（§19.2），不传就落到 RAGFlow 的缺省 0.2 / 0.3。
- `page_size` 是常量 6（demo 前 6 条）；`top_k`、`keyword`、`highlight`、`use_kg`、`document_ids` 都不传。
- `rerank_id` 只在设置里配了重排模型时传，取值为 `<名称>@owb-rerank@OpenAI-API-Compatible`（D6）。
- 判定：`code:0` 时读 `data.chunks`。它须是数组（零命中为 `[]`，§19.1），每项须有字符串 `document_id`、字符串 `content` 与数字 `similarity`；`chunks` 不是数组或某项读不到即「成功应答缺字段」，按 `kb_unavailable` 处理。
- 命中按 `document_id` 关联本地 `kb_documents.ragflow_document_id`，名称取本地 `name`。关联不上的命中**丢弃**，不报错。
  这类命中可能来自上传后插行失败、删除的中间态等，S2a 已逐一回滚，这里只是兜底。零候选或全部丢弃时命中是空数组，不是错误。
  - **为什么不传 `document_ids` 过滤**：§19.1 显示带 `document_ids` 时召回面不同（分数可以是 0），会改变检索的含义。
  - **为什么丢弃**：只回本地有行的文档，所有权与名称都在本地，不暴露 RAGFlow 侧的文档名。
- 输出 `RetrievalHit` 为 `{documentId, name, similarity, content}`：`documentId` 是本地文档 id，次序同 RAGFlow 应答（本系统不重排序）。

### D3 结果映射与重排降级（「不重试」的唯一例外）

检索路由放进新兄弟文件 `server/src/kb/ragflow-retrieval.ts`，按 `ragflow-models.ts` 的写法经 `retrievalCalls(json)` 并入 `createRagflowClient`：
`ragflow-client.ts` 已 697 行，不再加路由。路由专属组合：`code:102` 为类型化结果「检索失败」。其余按「RAGFlow 出站请求」的通用映射：
`code:101` 是 `kb_rejected`，`code:404` 与其它非零 `code` 是 `kb_unavailable`。

调用点处理「检索失败」：
- **本次带了 `rerank_id`**：不带 `rerank_id`、其余参数不变，**重试恰一次**。经受管 stderr writer 写一行，恰为 `{"event":"kb_rerank_degraded"}`，同一进程 60 秒内至多一行（复用 `perMinute`，`ragflow-client.ts:470`）。
  这一行不含密钥、上游地址与 RAGFlow 的 message。重试的结果按普通检索处理，用户与应答看不出降级。
- **本次没带 `rerank_id`**（含重试那一次）：`kb_unavailable`（503）。

后果（§19.4）：`code:102` 区分不出是不是重排失败。不是重排引起的 `code:102`（例如嵌入上游故障）也会触发一次不带重排的重试，然后以同样的方式失败，得到 503。代价是多一次请求与一行误报的 stderr 记录。两次各自受 30 s 总期限，最坏 60 s。

- **为什么映射为 503 而不是通用的 `kb_rejected`**：本系统发出的参数已在本地校验过，`/retrieval` 的 `code:102` 是 RAGFlow 侧的运行时失败（message 以 `retrieval search failed:` 或 `failed to get rerank model` 开头），不是调用方能改的请求错误。
- **为什么只认 `code` 不读 message**：message 原样带出上游错误体（§19.4），规格不允许它进入本系统。前缀判定在这里也帮不上忙：嵌入失败的前缀未测。
- **备选**：降级时在界面标「未重排」（owner 否决，#5）；不降级、直接报错（owner 否决）。

### D4 检索测试端点与写回

`POST /api/kb/bases/:id/retrieval`，body 恰为 `{question, threshold, vectorWeight}`，body limit 16 KiB。依次判定：
1. 所有权：在 preParsing，同 S2a（别人的或不存在 404）。
2. body：
   - `question` 是去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL 的字符串，原样发出（不 trim）。
   - `threshold` 与 `vectorWeight` 是 0–1 的有限数字。
   - 违反任一条：400 `bad_request`。
3. `state`：不是 `ready` 即 409 `kb_rebuilding`，不发请求。与重新入库一致：`rebuild_failed` 也拒，因为写回是写操作。
4. 参数与已存值逐个比较（数值相等）：
   - **相同**：不取锁，直接检索。
   - **不同**：经 `locks.write` 取该库写锁（FIFO，排在在途的入库、上传、移出与删库之后）。锁被重建器持有即 409 `kb_rebuilding`。
     取锁后重读该库：不存在 404 `not_found`，不检索；`state` 不是 `ready` 409 `kb_rebuilding`。
     **用重读的值再比较一次**：已相同（例如另一个并发提交刚写了同样的值）就释放锁，不写、不审计，直接检索。
     仍不同：在同一事务里写两列，并审计 `kb.retrieval_settings`（detail `{id, before:{threshold, vectorWeight}, after:{…}}`，`before` 取锁内重读的值），提交后释放锁，再检索。
     写失败：事务回滚，不审计，不检索，通用 500（body 不声称任何 typed code）。
5. 检索（D2、D3）在锁外执行：检索只读，不需要和写操作串行。
   因此写回成功、检索 503 时，参数已经保存了。这是 #8「先写后检」的直接后果，应答是 503，下一次检索即用新参数。

应答 200 恰为 `{hits: RetrievalHit[], retrieval: {threshold, vectorWeight}}`，`retrieval` 是检索时实际用的值（也就是已存的值）。带 no-store。检索本身不写审计。

- **为什么是 POST 带 body**：问句可能很长，可能含敏感内容，不进 URL 与访问日志；写回是副作用。
- **为什么参数随检索请求走，而不是另开一个保存端点**：owner 定了「每次检索即保存」（#8）。另开端点就是两个写入口。
- **为什么比较数值相等**：界面以 0.01 为步长，JSON 数字往返不失真；值相同就不写、不审计（审计不留无意义记录）。
- **为什么取锁后再比一次**：锁外的比较只是快路径。两个并发提交在锁外都判为「不同」时，第二个排到锁上已经和库里相同；不再比较就会写一条 `before == after` 的审计，或用锁外读到的旧值记出失真的 `before`。

### D5 迁移 051

`051_kb_retrieval.sql`：

```
ALTER TABLE knowledge_bases ADD COLUMN retrieval_threshold REAL NOT NULL DEFAULT 0.2
  CHECK (typeof(retrieval_threshold) = 'real' AND retrieval_threshold BETWEEN 0 AND 1);
ALTER TABLE knowledge_bases ADD COLUMN retrieval_vector_weight REAL NOT NULL DEFAULT 0.7
  CHECK (typeof(retrieval_vector_weight) = 'real' AND retrieval_vector_weight BETWEEN 0 AND 1);
ALTER TABLE kb_settings ADD COLUMN rerank_name TEXT NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_base_url TEXT NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_api_key TEXT NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_probe_status TEXT NOT NULL DEFAULT 'never'
  CHECK (rerank_probe_status IN ('never','ok','failed'));
ALTER TABLE kb_settings ADD COLUMN rerank_probe_at INTEGER NULL;
ALTER TABLE kb_settings ADD COLUMN rerank_probe_message TEXT NULL;
```

- `REAL` 亲和性把整数 0、1 存成 `real`，`typeof` 检查对两端值成立。
- 同一亲和性会在 CHECK 之前把数字形态的文本（如 `'0.3'`）转成 `real`，所以 CHECK 拦的是越界数值与非数字文本（如 `'abc'`）。字符串形式的参数由端点的 body 校验判为 400（D4），不靠这一层。
- 重排三列「同为 NULL 或同为非 NULL」：`ADD COLUMN` 加不了表级 CHECK，由 store 的写入保证。`server/test` 的 schema 用例断言 store 只整组写入。
  - **备选**：重建 `kb_settings`。这是 034 那样的重建配方，为一个 store 已保证的不变量付迁移风险，不值。
- 既有库按列缺省取 0.2 / 0.7（owner #7，不迁移旧行为）。
- 不改其它表；`core-db-helpers.ts` 的跟踪清单加 `MIGRATION_051`。回退同 050：保留文件，列留着无害。

### D6 重排模型的设置与下发

设置 PUT 的 body 键集加 `rerank`：`{name, baseUrl, apiKey?}` 或 `null`。
- 校验与嵌入模型同一规则：`name` 1–128 字节、无控制字符、不含 `@`；`baseUrl` 同上游地址规则；首次必须带 `apiKey`，之后省略即保留。
- 至少含 `embedding`、`chatModelId`、`rerank` 之一（原来是前两者之一）。

保存流程（在设置锁内）：
- `rerank` 为对象：**先于**既有的嵌入、对话两轮，下发 `owb-rerank` 一轮，序列同 §11.1：`PUT /providers` → `GET /models` → 建或改实例，`model_info` 只增不减，`model_type:["rerank"]`，`max_tokens` 8192。
  **没有 `PATCH /models/default`**：重排不设账号缺省，只按请求传 `rerank_id`。实现上，`Provision` 加 `modelType: "rerank"` 时不发缺省那一步，不另写一套序列。
- `rerank` 为 `null`：只改本地三列为 NULL，不发 RAGFlow 请求。实例与密钥留在 RAGFlow，同对话模型的「取消指定」（账号缺省不变量禁止 `/providers` 下的 `DELETE`）。已是 `null` 时再设 `null` 是无操作：不写、不审计。
- 下发失败：本地不变，按映射返回。重排一轮失败时，后面的嵌入、对话两轮都不发。
- **为什么重排排在最前**：重排一轮没有 `PATCH /models/default` 这种账号级副作用。排在后面时，嵌入一轮的 `PATCH /models/default` 已生效而重排失败让本地不变，账号缺省嵌入就与本地分裂（Compiler 读的是账号缺省）。
  排在最前的代价：重排一轮成功而后面某一轮失败时，`owb-rerank` 实例已是新地址与密钥而本地不变，检索仍以本地的名称引用它；只影响重排（失败时自动降级），下一次成功保存即覆盖。
- 成功：同一事务写列并审计 `kb.settings`，detail 多一个可选键 `rerank: <名称> | null`。
- 名称、地址或密钥任一变化，重排探活重置为 `never`。
- 重排不是嵌入身份的一部分：换重排不触发 `kb_rebuild_required`，不发起重建。

读视图加 `rerank`：`{name, baseUrl, probe:{status, message, at}}` 或 `null`，永不含密钥。

### D7 探活：一个实现，两种目标

`embedding-probe.ts` 改名为 `model-probe.ts`，`probeEmbedding` 泛化为按目标取三样东西：路径（`embeddings` / `rerank`）、body（`{model, input:"ping"}` / `{model, query:"ping", documents:["ping"]}`）与 2xx 判定（`data[0].embedding` 为非空数字数组 / `results[0].relevance_score` 为数字）。
连接、期限（连接 10 s、总 15 s）、错误摘录与密钥净化不变。

- 端点：`POST /api/kb/settings/probe?target=rerank` 探重排；不带 `target` 或 `target=embedding` 探嵌入（既有行为不变）。`target` 的其它取值、重复（`?target=rerank&target=embedding`）或空值（`?target=`）都是 400。路由仍是 bodyless：带 `{}` body 照 http-service-skeleton 的归属判定为 400。
- 重排未配置时探重排：400 `bad_request`。不用 `kb_not_ready`：它的文案说的是嵌入模型。界面不配就不渲染 `探活`。
- 写回同嵌入：只写回发起时的同一身份，排在同一条探活 Promise 链上（`settings.ts:300`），审计 `kb.settings`，detail 为 `{rerankProbe:"ok" | "failed"}`。
- 22 秒的那次实测（§19.4）超过 15 s 总期限，会判为 `超时`。期限不为它放宽：探活是给管理员的信号，不是必须成功的流程。

- **为什么用查询参数而不是新路由**：路由身份不变，content-parser 归属不用再加一条，bodyless 的判定照旧。
- **备选**：另写 `rerank-probe.ts`。与嵌入探活九成重复，jscpd 会拦。

### D8 web

**检索测试**（`web/src/features/center/kb/retrieval-panel.tsx`，状态在 `use-retrieval.ts`）：放在详情文档表下方，标题 `检索测试`，只在 `state` 为 `ready` 时渲染。
知识库关闭或不可用时，整个 tab 已不渲染详情（S2a）。demo 面板头的标签 `召回 → 重排 → 引用` 不渲染：重排是可选的，未配置时这个标签与实际不符。
- 控件：问句输入框（placeholder 同 demo：`例如 销售额口径 / 弹窗 / 工单超时`）；`相似度阈值` 与 `向量权重` 两个数字输入（0–1，步长 0.01，初值取 `BaseView.retrieval`）；`检索` 按钮。
  问句为空白，或任一数字字段为空、不是数字、越界时 `检索` 禁用；数字字段无效时该字段旁显示原因（不能把空字段当 0 提交），问句空白只禁用、不显示原因（初始态即为空白）；在途时禁用，文字为 `正在检索`。
  问句框按 Enter 等同点 `检索`（demo `resource/workbuddy-live-demo.html:3423`）；按钮禁用时 Enter 不发请求。
- 成功：用应答的 `retrieval` 更新面板的参数，并通知列表更新该库的 `BaseView.retrieval`，不重取整表。
- 结果：
  - 还没检索时显示 `输入问题后检索，命中切片会带出所属文档`：demo 原文去掉「与来源路径」（#10），其余不改。
  - 没命中显示 `没有命中，换个说法或先把相关文档入库`。
  - 有命中时每条显示 `#<序号>`、文档名、`相似度 <两位小数>` 与切片原文。不显示「切片 N」与来源路径（#10），切片原文保留换行。
- 失败：面板内 `role="alert"` 显示信封文案，参数保持用户输入。这次提交的参数与面板初值（打开详情时的 `BaseView.retrieval`，或上一次成功应答的 `retrieval`）不同时，重取一次知识库列表：写回可能已经成功（D4 第 5 步），列表里该库的 `retrieval` 要与服务端一致，否则重新进入详情会以旧值初始化，下一次检索又悄悄写回旧值。信封区分不出写回是否成功（两种都是 `kb_unavailable`），所以只按「参数有变」判断：当次发出的两个数值与面板基线或列表里该库当前的 `retrieval` 任一不同即为有变（后者覆盖「先失败写回、再改回原值又失败」时列表已被重取改过的情形）。

**重排模型**（模型 tab 的「知识库模型」段）：
- 嵌入模型之下另起一行 `重排模型`：未配置显示 `未配置`；配置了显示名称、上游地址与探活状态，加 `编辑`、`探活`、`清除`。
- `kb-embedding-dialog.tsx` 改名 `kb-model-dialog.tsx`，加一个 `kind` 属性（标题、确认框只对嵌入模型生效）；不再写一个几乎相同的对话框。
- 保存后上游有改动时，恰调用一次 `probeKbModel("rerank")`。
- `清除`：先弹确认（`清除重排模型？`，说明 `清除后检索不再重排。`），确认后恰一次 `updateKbSettings({rerank:null})`。

API 客户端 `api-kb.ts` 加 `retrieveFromKnowledgeBase(id, input)`；`updateKbSettings` 的 input 加 `rerank`；`probeKbEmbedding()` 改为 `probeKbModel(target)`，嵌入用 `"embedding"`。
三者都严格解析应答（键集与类型不符即 `requestFailed`）。`web/src/lib/api.ts` 的 `ApiClient` 导出这些类型与方法，`web/test/api-files-archive.test.ts` 的方法清单随之改。

### D9 `kb_search` 的契约只进规格

knowledge-bases 新增「`kb_search` 工具契约」：
- 输入是问句与 kb_ids。
- 每个可见库各执行一次 D1 的单轮检索，用该库自己的检索参数；每条命中与 `RetrievalHit` 同形。
- 只有命中切片与出处进入上下文，不变量 2。
- 多库命中如何标注所属库、合并与条数、可见范围过滤与审计，都由 S2c 定；非 `ready` 的库（`rebuilding` / `rebuild_failed`）是否参与检索也由 S2c 定（D4 第 3 步只约束检索测试端点）。

本 change 里没有 `kb_search` 的任何代码。这条要求的可验证部分只有一条：检索测试与 D1 走的是同一个函数。验证方式是扫描 `server/src`：客户端的检索方法只在 `kb/retrieval.ts` 里被调用，RAGFlow 的检索路由片段（`${API}/retrieval` 或 `/api/v1/retrieval`）只出现在 `kb/ragflow-retrieval.ts`，本系统自己的 `/api/kb/bases/:id/retrieval` 不算。只扫字面量 `/api/v1/retrieval` 不够：兄弟文件以 `${API}/…` 拼路径（`ragflow-route.ts:5`），另一处直接调客户端方法时也不含这个字面量。

### D10 测试与夹具

**假 RAGFlow**：
- 新文件 `server/test/support/fake-ragflow-retrieval.mjs`，挂到 `ROUTES`。
- `POST /api/v1/retrieval` 按 §19.1 的形状回切片：协议应答只用记录里有的键与码（`code:101` 的六条 message、`code:404`、带不存在的 `rerank_id` 的 `code:102`、零命中的 `{chunks:[], doc_aggs:[], labels:null, total:0}`）。
- 命中由用例显式脚本化：给定数据集的切片列表、分数，以及「带 `rerank_id` 时回 `code:102`」开关。夹具不实现检索算法。
- 故障注入另有「任意检索请求回指定 `code`（101 / 102，不论是否带 `rerank_id`）」：这属于记录允许的「同一路由上别的 101、102」防御性组合。没有它，「未配置重排时的 `code:102`」与「对合法请求的 `code:101`」两个场景造不出来：本系统的参数在本地已校验，经端点发不出能触发 101 的请求。
- 记录收到的 body，供断言参数显式传、`rerank_id` 的取值与重试次数。
- 重排实例走既有的实例路由（`fake-ragflow-models.mjs`）；它对 `model_type` 不设白名单，若有就加 `rerank`（§19.3）。

**假上游**：新文件 `server/test/support/fake-upstream-rerank.mjs` 提供 `POST /rerank`（`fake-upstream.mjs` 已 770 行，照 `fake-upstream-embeddings.mjs` 的兄弟文件写法）。

**smoke-kb**：在 `smoke-kb` 库的两份文档都 `done` 之后，以夹具 `notes.md` 里的专名为问句（例如 `北礁观测站由谁值守`），`threshold:0`、`vectorWeight:0.7` 检索。
断言 200、`hits` 非空、首条 `name` 为 `notes.md`。这条同时验证了写回：参数与缺省不同，写回之后检索。
它是 §19 的映射对真实 rc2 成立的唯一证明，所以同一 PR 改写 CK-11 的期望（加上这条检索断言），结论回到 `待签`，由 owner 重跑 `make smoke-kb` 签收。

**ui-walk**：CI 没有真实 RAGFlow，知识库开启的界面只能在浏览器层桩 API。新分支 `web/e2e/ui-walk-center-kb.ts` 用 `page.route(...).fulfill`（先例 `web/e2e/ui-walk-layout.ts:71`）应答 `/api/kb/status`、`/api/kb/bases`、`…/documents`、`…/retrieval` 与 `/api/kb/settings`，在桌面与 390 px 两种宽度下走检索测试面板（成员 `zhangsan`）与重排模型一行（管理员 `lisi`：模型 tab 只对管理员渲染，成员读 `GET /api/models` 为 403），过 error oracle；结束前 unroute。它证明的是真实浏览器里的呈现与交互，不证明服务端。

**验收清单**：CK 节新增 CK-13（检索测试：命中、无命中、参数写回后刷新仍在）与 CK-14（管理员配置、探活、清除重排模型，配置后检索照常有结果），结论 `待签`。
两行的期望都含「桌面与手机宽度、浅色与深色主题下布局不溢出、文字可读」，由 owner 在真实栈上走查。行文写明「不显示来源路径与切片序号」，这是 owner 授权的偏离。

### D11 模块划分与行数

| 文件 | 内容 | 预计行数 |
|---|---|---|
| `kb/ragflow-retrieval.ts`（新） | 检索路由与 `retrievalCalls(json)` | ≤120 |
| `kb/retrieval.ts`（新） | 单轮检索（D1–D3）、body 校验、写回编排（D4） | ≤260 |
| `kb/model-probe.ts`（改名） | 两种目标的探活 | ≤200 |
| `kb/settings.ts` | 加 `rerank` 的解析、下发、清除与探活写回 | 516 → ≤640 |
| `kb/store.ts` | 读写检索参数与重排三列 | 558 → ≤620 |
| `kb/rest.ts`、`kb/index.ts`、`kb/bases.ts` | 一条路由、装配、`viewOf` 加 `retrieval` | 各增 ≤30 |
| `web/…/kb/retrieval-panel.tsx`、`use-retrieval.ts`（新） | 检索测试 | 各 ≤200 |
| `web/lib/api-kb.ts` | 加检索与 `rerank` | 516 → ≤600 |

全部低于 800 行；复杂度 ≤15 由 Biome 检查。

### Sketch seams under test

| Seam | 理由 |
|---|---|
| app-server HTTP 应用（`buildApp` + `app.inject()`，真实 SQLite，接假 RAGFlow） | 检索端点、所有权、写回、审计、重排降级与设置的下发序列都在这一层可观察，S2a 用的就是这一层 |
| 假 RAGFlow HTTP 服务（`fake-ragflow*.mjs`） | 检索 body（参数显式传、`rerank_id`、重试恰一次）与 `owb-rerank` 的下发序列（没有 `PATCH /models/default`）只能在出站侧断言 |
| web 组件（jsdom + 假 `ApiClient`） | 检索测试面板与重排模型段的呈现与调用 |
| `make ui-walk`（真实 Chromium，`page.route` 桩知识库 API） | 前端通用契约要求真实浏览器与视口矩阵；知识库开启的界面在 CI 只能这样到达 |
| `make smoke-kb`（真实 RAGFlow） | 唯一证明 §19 的检索映射对真实 rc2 成立的 seam；只在本机与验收 |

## Not yet specified

- 检索参数的推荐值怎么来。0.2 / 0.7 只是 owner 按 §19.1 定的缺省，还没有用真实语料系统地评估过；评估方法、语料与指标都还说不清。
- 带重排时综合分的含义：§19.3 的 `similarity = 0.3 × vector + 0.7 × term` 是 [INFERENCE]，阈值在带重排与不带重排时是不是同一把尺子，还说不清。

## Risks / Trade-offs

- [不是重排引起的 `code:102` 也会重试一次] → 多一次请求与一行 stderr 误报，结果仍是 503（D3）；嵌入失败的形状测出来之后可以收窄。
- [重排降级对用户不可见，管理员只能从 stderr 发现] → owner 的取舍（#5）；探活状态在模型 tab 可见，`kb_rerank_degraded` 按分钟限流写入。
- [写回成功、检索 503 时参数已保存] → #8 的直接后果，应答如实是 503；参数可在下一次检索时改回（D4）。
- [候选由全文匹配圈定（[INFERENCE]）：与问句没有词重叠的文档召回不到] → 记录在实测记录 §19.1；检索测试正好让所有者看到这一点；是否需要 `keyword` 或其它参数，留给真实语料评估（Not yet specified）。
- [rc2 预发行版] → 版本钉住不变；升级时重跑 §19 与 `make smoke-kb`。
- [组合保存时重排一轮先于嵌入：重排成功、嵌入失败时 `owb-rerank` 已是新上游而本地不变] → 只影响重排，检索失败时自动降级；下一次成功保存即覆盖（D6）。
- [重排上游慢（实测 22 秒）] → 检索受 30 s 总期限，超时按 `kb_unavailable`。不会降级：超时不是 `code:102`。探活 15 s 内判 `超时`。

## Migration Plan

- 迁移 051 只加列，不改既有行的取值，只补上缺省值；回退代码时保留文件（账本规则同 050）。
- 部署：未配重排模型时检索不带 `rerank_id`，行为与本 change 之前的 RAGFlow 缺省排序一致；知识库关闭时新端点同样 503 `kb_disabled`。
- 回滚：清除重排模型即停止重排；`owb-rerank` 实例留在 RAGFlow，由运维按 D16（S2a）的纪律处理，它不是账号缺省，删除没有 §13 的风险。

## Open Questions

无。参数存放与 `use_kg` 已由实测 §19 与 owner 2026-11-08 的决定关闭。
