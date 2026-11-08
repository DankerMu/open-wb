# RAGFlow v1.0.0-rc2 接口实测记录（续）：S2b 检索

`2026-10-28-ragflow-rc2-api.md` 的续篇，节号接着它编（§19 起），以免原文件继续变长。脱敏约定沿用原文件 §0；文中的 §4、§11、§13 等指原文件。
change `s2b-kb-retrieval` 的 RAGFlow 事实只以本文件与原文件为准。另用一个占位符：`<chunk_id>` 代表 32 位十六进制的切片 id。


## 19. S2b 检索实测（2026-11-08）

change `s2b-kb-retrieval` 的事实前提，在共用栈上用专用账号实测。开始时账号有 app-server 下发的 `owb-chat`、`owb-embed` 两个实例和两种
缺省，没有数据集。实测**全程不动这两个实例和账号缺省**（避开 §13）。另建的对象都带 `owb-probe-` 前缀，结束时全部删除（§19.7）。
嵌入模型是 `text-embedding-3-large@owb-embed@OpenAI-API-Compatible`。普通库四份单切片小文档：中文三份（销售额口径、工单超时、
弹窗规范），英文一份（release checklist）。图谱库用本仓 `createKbPipeline`（`server/src/kb/pipeline.ts`）建，`graph:true`、
`raptor:false`、`general` 模板，入库其中两份。原始应答只保存在会话 scratchpad，不入库。

### 19.1 `POST /api/v1/retrieval`

```
POST /api/v1/retrieval
{"question":"销售额怎么统计","dataset_ids":["<dataset_id>"]}
→ HTTP 200
{"code":0,"data":{"chunks":[{"content":"# 销售额口径\n\n销售额按含税金额统计…","content_ltks":"…","dataset_id":"<dataset_id>",
  "doc_type_kwd":"","document_id":"<document_id>","document_keyword":"sales.md","id":"<chunk_id>","image_id":"",
  "important_keywords":[],"mom_id":"","positions":[],"row_id":…,"similarity":0.2028,"tag_kwd":[],
  "term_similarity":0.2028,"vector_similarity":0.2028}],
 "doc_aggs":[{"count":1,"doc_id":"<document_id>","doc_name":"sales.md"}],"labels":…,"total":1}}
```

- 应答 `data` 恒为四键：`chunks`、`doc_aggs`、`labels`、`total`。文档名在切片的 `document_keyword` 里，没有 `docnm_kwd`。
- 零命中（阈值 0.9、缺省参数下的纯语义问句、§19.2 的 `PUT` 之后，三次）的应答原样：
  `{"code":0,"data":{"chunks":[],"doc_aggs":[],"labels":null,"total":0},"message":null}`。`chunks` 与 `doc_aggs` 是空数组，不是 `null`；
  `labels` 在有命中时同样是 `null`；成功应答的 `message` 为 `null`。
- 切片键是上面这十六个。带 `highlight:true` 时多一个 `highlight`，值是用 `<em>` 标出命中词的切片原文。
- 39 次检索耗时 0.00–8.26 秒，带重排的那些偏慢。

| 参数 | 实测 |
|---|---|
| `similarity_threshold` | 生效：0.9 时 `total:0`；0 时只剩候选本身的限制 |
| `vector_similarity_weight` | 生效：同一切片在 1.0 / 缺省 / 0 下分别是 0.676 / 0.203 / 0。缺省值相当于 0.3 |
| `page`、`page_size` | 分页生效：4 条候选，`page_size:2` 回前两条、`page:2` 回后两条，`total` 都是 4 |
| `top_k` | 截的是候选池：`top_k:2` 时 `total:2` |
| `document_ids` | 只在这些文档里检索；命中分可以是 0 |
| `keyword:true` | `code:0`，分数随之变化；没有看出召回面上的差别 |
| `highlight:true` | 切片多一个 `highlight` 键 |
| `use_kg:true` | 见 §19.5 |

**分数**（不带重排）：三个分数**恒等**，都等于 `vector_similarity_weight × 向量相似度`，关键词部分没有贡献。所以缺省参数（阈值 0.2、
权重 0.3）会滤掉纯语义命中：问句「怎样避免误操作的确认对话框」在权重 1.0 下命中弹窗规范 0.647，缺省参数下 `total:0`。

**候选**：阈值设为 0 时，只回与问句有词重叠的切片（「规则」只命中工单超时规则一份）。[INFERENCE] 候选由全文匹配圈定，向量分只参与排序和阈值。

参数非法时一律 HTTP 200：

| 请求 | `code` | `message` |
|---|---|---|
| `similarity_threshold:1.5` | 101 | `similarity_threshold must be between 0 and 1` |
| `vector_similarity_weight:-1` | 101 | `vector_similarity_weight must be between 0 and 1` |
| `page_size:0` | 101 | `page_size must be greater than or equal to 1` |
| `similarity_threshold:"0.1"`（字符串） | 101 | `Mismatch type float64 with value number …` |
| `question:""` | 101 | `Key: 'SearchDatasetsRequest.Question' Error:Field validation for 'Question' failed on the 'required' tag` |
| 缺 `dataset_ids` | 101 | 同上，字段为 `DatasetIDs` |
| 不存在的数据集 id | 404 | `Resource not found` |

### 19.2 数据集上的检索字段不可写

数据集读回带 `similarity_threshold:0.2` 与 `keywords_similarity_weight:0.7`（§4.2），没有 `vector_similarity_weight`。
`PUT /api/v1/datasets/<dataset_id>` 带其中任何一个字段（或带 `vector_similarity_weight`）都回 HTTP 200、`code:101`
`Extra inputs are not permitted: <字段>`，读回不变。所以经 API 改不了，`/retrieval` 是否读它们也就无从区分（缺省值与读回值一致）。
结论：检索参数要按库保存，就只能存在本地，每次检索时显式传参。

### 19.3 重排模型下发

照 §11.1 的序列建实例，`model_type` 为 `rerank`：

```
POST /api/v1/providers/OpenAI-API-Compatible/instances
{"instance_name":"owb-probe-rerank","api_key":"<api_key>","base_url":"<UPSTREAM_BASE_URL>",
 "model_info":[{"model_name":"qwen3-rerank","model_type":["rerank"],"max_tokens":8192}]}
→ {"code":0,"data":null,"message":"success"}
```

`GET /api/v1/models` 列出它，`model_type:["rerank"]`，`verify:"unknown"`。检索时用三段式引用：
`"rerank_id":"qwen3-rerank@owb-probe-rerank@OpenAI-API-Compatible"`。带重排时三个分数开始不同，例如
`similarity 0.165、vector_similarity 0.549、term_similarity 0.0`，排序也变了。[INFERENCE] 这时 `term_similarity` 是重排分，
`similarity = 0.3 × vector + 0.7 × term`（按缺省权重核对四条都成立）。没有配账号缺省重排模型，`rerank_id` 只按请求传。

### 19.4 重排失败的信号

都是 HTTP 200、`code:102`：

| 情形 | `message` |
|---|---|
| 实例的 `base_url` 不通 | `retrieval search failed: failed to send request: Post "<base_url>/rerank": dial tcp …: connect: connection refused` |
| 上游密钥无效 | `retrieval search failed: vLLM rerank API error: 401 Unauthorized, body: {…上游错误体，含 request id…}` |
| 模型名不存在 | `failed to get rerank model by rerank_id: model configuration unavailable: model config not found: <rerank_id>` |
| 两段式 `rerank_id` | `failed to get rerank model by rerank_id: model configuration unavailable: provider "<实例名>" lookup failed: record not found` |

- RAGFlow 调上游的地址是 `<base_url>/rerank`。
- message 原样带出上游错误体，**不能透传给用户或写进日志**。
- 未测：嵌入模型失败时 `/retrieval` 回什么。owner 的 `owb-embed` 不能动，没有造这个场景。所以单凭 `code:102` 区分不出是重排失败还是别的失败。

直连上游（app-server 探活要用的形状，不经 RAGFlow）：

```
POST <UPSTREAM_BASE_URL>/rerank
{"model":"qwen3-rerank","query":"ping","documents":["ping"]}
→ HTTP 200 {"results":[{"document":{"text":"ping"},"index":0,"relevance_score":0.635}],"usage":{…}}
```

- 模型不存在回 HTTP 503，`error.code:"model_not_found"`；密钥无效回 HTTP 401。
- 同一请求一次 0.55 秒、一次 22.33 秒。

### 19.5 `use_kg`

图谱库入库两份文档，解析 `COMPLETED`，任务日志两条 `Graph` `DONE`。无 `kind` 的编译状态是 `completed`，`progress_msg` 含
`Merging structure products: 10`。

- 同一问句在图谱库上带不带 `use_kg:true`，应答完全相同：`total:1`，同一切片，同一分数，没有额外的图谱切片。
- 普通库带 `use_kg:true` 也是 `code:0`。
- `GET /api/v1/datasets/<dataset_id>/knowledge_graph` 回 HTTP 404 `Not Found`。

结论：rc2 接受 `use_kg`，但看不出效果。

### 19.6 跨库

`dataset_ids` 同时给普通库和图谱库，两库的同名文档各回一条，`document_id` 不同，分数相同。

### 19.7 清理

- 删除两个数据集（`DELETE /api/v1/datasets`）、图谱库的画布与模板组、三个 `owb-probe-` 重排实例（正常、`base_url` 不通、密钥无效各一个）。
- 结束时：数据集 0、画布 0、模板组 0；实例只剩 `owb-chat`、`owb-embed`；两种账号缺省与开始时相同。
- 未清空任何缺省，未执行任何 `docker` 写操作。
