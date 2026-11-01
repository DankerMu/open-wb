# RAGFlow `v1.0.0-rc2` 接口实测记录（s2a-kb-ragflow 组 1）

> 实测日期：2026-11-01（文件名日期由 spec 钉死，不代表实测日期）。
> 对象：共用开发栈上运行中的 RAGFlow 实例，全程只用专用账号的 API key 鉴权，未用账号密码。
> 结论全部来自对运行实例的观察。读源码只用来找接口；个别地方引用源码解释现象时写明「源码」。
> 本文件是假 RAGFlow 夹具（`server/test/support/fake-ragflow.mjs`）协议的唯一来源。

## 0. 脱敏约定

| 占位符 | 代表 |
|---|---|
| `<RAGFLOW_BASE_URL>` | RAGFlow 地址 |
| `<UPSTREAM_BASE_URL>` | 嵌入与对话模型的上游地址 |
| `<dataset_id>` `<document_id>` `<tenant_id>` `<user_id>` `<instance_id>` `<provider_id>` `<model_id>` `<canvas_id>` `<group_id>` `<log_id>` | 各类 32 位十六进制 id |
| `<api_key>` `<email>` `<nickname>` `<tenant_name>` | 密钥、邮箱、昵称、租户名 |

`owb-` 开头的名字都是本次实测建的临时对象，已全部删除（§16）。

## 1. 检测（tasks 1.1）

| 检测 | 结果 |
|---|---|
| shell 环境 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY_FILE` | 已设置；key 文件存在，权限 `0600` |
| `GET <RAGFLOW_BASE_URL>/api/v1/system/version` | HTTP 200，`{"code":0,"data":"v1.0.0-rc2","message":"success"}` |
| `docker compose ls` | 只读执行一次，只作观察，结果写进 issue 评论 |
| 实测开始时账号状态 | 数据集 0、已加模型 0、缺省模型全空、模板组 0、画布 0 |

栈处于就绪状态，放行。`/api/v1/system/healthz` 全部 `ok`；`/api/v1/system/status` 显示 `doc_engine.type` 为 `infinity`。

## 2. 结论速览

| # | 项 | 结论 | 与 design 的主要差异 |
|---|---|---|---|
| 1 | 版本接口 | 支持 | 无 |
| 2 | 建数据集 | 支持 | 字段是 `parser_id` 且必须带 `parse_type`；`chunk_method` 被拒；`tag` 不可建；`embedding_model` 为三段式 |
| 3 | RAPTOR 与知识图谱 | 支持（经 pipeline，不是数据集字段） | 开启要建模板组与画布；解析时自动执行，无须显式触发；没有按类型的终态；RAPTOR 失败可能完全无信号 |
| 4 | 改嵌入模型 | 支持（`chunk_count` 非 0 也成功） | 与文档及 design Context 相反 |
| 5 | multipart 上传 | 支持 | 不支持的后缀回 `code:500` |
| 6 | 解析与文档列表 | 支持 | 状态字段是 `ingestion_status`，八种取值；`success_count:0` 与 `code:0` 同时出现 |
| 7 | 原件下载 | 支持；始终带 `Content-Length`，未观察到分块 | 与 D8 的推测相反；0 字节文件下载回 `code:500` |
| 8 | 不存在的 id | 支持区分，但组合因路由而异 | 两条路由要靠 message 前缀；`DELETE /datasets` 回 `code:403`；解析回 `code:0` |
| 9 | 模型下发 | **支持** | 删除有联动风险：见 §13，撤销缺省对话模型可使入库进程崩溃循环 |
| 10 | 错误组合 | 支持 | 鉴权失败是 HTTP 401 + `code:401`；未观察到 `109`、`108` |

## 3. 版本接口（`GET /api/v1/system/version`）

无需鉴权。

```
GET /api/v1/system/version
HTTP 200
{"code":0,"data":"v1.0.0-rc2","message":"success"}
```

版本串在 `data`，类型为字符串。同组无鉴权接口还有 `/api/v1/system/healthz`（`{"db":"ok","redis":"ok","doc_engine":"ok","storage":"ok","message_queue":"ok","status":"ok"}`）与 `/api/v1/system/ping`（纯文本 `pong`）。

结论：**支持**。

## 4. 建数据集（`POST /api/v1/datasets`）

### 4.1 请求

```
POST /api/v1/datasets
Authorization: Bearer <api_key>
Content-Type: application/json

{"name":"owb-general","parser_id":"general","parse_type":1,"embedding_model":"bge-m3@owb-embed@OpenAI-API-Compatible"}
```

可接受的字段恰为 `name`、`embedding_model`、`parser_config`、`language`、`permission`、`parser_id`、`pipeline_id`、`parse_type`。多余字段回 `101`。

### 4.2 应答

```
HTTP 200
{"code":0,"data":{"chunk_count":0,"create_time":...,"created_by":"<user_id>","document_count":0,
 "embedding_model":"bge-m3@owb-embed@OpenAI-API-Compatible","id":"<dataset_id>",
 "keywords_similarity_weight":0.7,"language":"English","name":"owb-general","pagerank":0,
 "parser_config":{"Extractor:AutoExtractDefault":{...},"File":{},"GeneralChunker:SixApplesFall":{...},
                  "Parser:HipSignsRhyme":{...},"Tokenizer:LegalReadersDecide":{...}},
 "parser_id":"general","permission":"me","similarity_threshold":0.2,"tenant_id":"<tenant_id>",
 "token_num":0,"update_time":...}}
```

注意应答没有 `message` 键。`parse_type` 不出现在任何读接口里。

### 4.3 模板字段

| 请求 | 应答 |
|---|---|
| `{"name","chunk_method":"naive"}` | `{"code":101,"data":null,"message":"Extra inputs are not permitted: chunk_method"}` |
| `{"name","parser_id":"naive"}`（无 `parse_type`） | `{"code":102,"message":"parse_type is required"}` |
| `{"name"}` | 同上 |
| `{"parse_type":1}`（无 `parser_id`） | `102`，`parser_id is required when parse_type is BuiltIn` |
| `{"parse_type":2}`（无 `pipeline_id`） | `102`，`pipeline_id is required when parse_type is Pipeline` |
| `parse_type` 为 `0` / `3` | `102`，`invalid parse_type: 0 (must be 1 or 2)` |
| `parse_type` 为字符串 `"1"` | `102`，Go JSON 解码错误原文 |
| `{"parse_type":1,"parser_id":"general","pipeline_id":"..."}` | `102`，`pipeline_id must not be set when parse_type is BuiltIn` |
| `{"parse_type":2,"pipeline_id":<不存在>}` | `102`，`canvas is not accessible` |
| `parser_id:"nope"` | `102`，`input should be 'general', 'qa', 'manual', 'table', 'paper', 'book', 'laws', 'presentation', 'picture', 'one', 'audio' or 'email'` |

结论：字段是 `parser_id`，必须同时带 `parse_type:1`（内置）或 `parse_type:2`（pipeline，改带 `pipeline_id`）。`chunk_method` 不接受。

取值逐一实测（`parse_type:1`）：`general`、`naive`、`book`、`email`、`laws`、`manual`、`one`、`paper`、`picture`、`presentation`、`qa`、`table`、`audio` 均 `code:0`；`naive` 的应答 `parser_id` 规范化为 `general`。**`tag` 回 `102`，不可建**，尽管 `GET /users/me/models` 的 `parser_ids` 串里仍列着 `tag:Tag`。

### 4.4 `embedding_model` 的格式

| 取值 | 结果 |
|---|---|
| `bge-m3@owb-embed@OpenAI-API-Compatible`（`模型@实例@提供方`） | 成功 |
| `bge-m3@OpenAI-API-Compatible`，账号没有名为 `default` 的实例 | `102`，`model configuration unavailable: instance "default" lookup failed: record not found` |
| 同上，账号有名为 `default` 的实例 | 成功，应答保留两段式 |
| `bge-m3` | `102`，`embedding model identifier must follow <model_name>@<provider> format` |
| 空串 | 同上 |
| 不存在的模型 | `102`，`model configuration unavailable: model config not found: ...` |
| 把对话模型当嵌入模型 | `102`，`... cannot be used as embedding model` |
| 提供方名错 | `102`，`provider "Nope" lookup failed: record not found` |
| 不传，账号有缺省嵌入模型 | 成功，取缺省 |
| 不传，账号缺省指向已删除的模型 | **成功**，数据集绑定已不存在的模型，到解析时才 `FAILED`（§11.4） |
| 不传，账号没有缺省 | **成功**，`embedding_model` 为空 |

所以 `embedding_model` 必须总是显式传三段式。

### 4.5 同名与长度

| 请求 | 应答 |
|---|---|
| 第二次建 `owb-dup` | 成功，`name` 变为 `owb-dup(1)` |
| 建 `OWB-DUP`（已有 `owb-dup`、`owb-dup(1)`） | 成功，`name` 变为 `OWB-DUP(2)`，即不区分大小写 |
| 名字恰 128 字符 | 成功 |
| 名字 129 字符 | `102`，`Dataset name length is 129 which is large than 128` |
| 全空白名字 | `102`，`dataset name can't be empty` |

`permission:"team"` 被接受。畸形 JSON 回 `101`（`Malformed JSON syntax: ...`）；`Content-Type` 非 JSON 回 `101`（`Unsupported content type: ...`）。

### 4.6 列表、读取与删除

```
GET /api/v1/datasets?page=1&page_size=3&orderby=create_time&desc=true
{"code":0,"data":[{...}],"total_datasets":24}
```

`name` 查询参数是精确匹配，查不到回 `code:0`、`data:[]`。列表项不含 `pipeline_id`；`GET /api/v1/datasets/<dataset_id>` 含。pipeline 数据集的 `parser_id` 读回为 `general`，不反映 pipeline 的来源模板。

```
DELETE /api/v1/datasets
{"ids":["<dataset_id>"]}
→ {"code":0,"data":{"errors":[],"success_count":1},"message":null}
```

- `{"ids":[]}`、`{}`、`{"ids":null}` 都回 `{"code":0,"data":{"deleted":[]},"message":null}`，什么也不删。
- 多余字段回 `101`，`Extra inputs are not permitted: foo`。
- 含运行中文档的数据集可以删，回 `success_count:1`。
- 一次最多处理多少 id 未测上限；实测 10 个一批成功。

结论：**支持**。

## 5. RAPTOR 与知识图谱

### 5.1 开启方式

数据集级开关不存在：

| 请求 | 结果 |
|---|---|
| `parser_config:{"raptor":{"use_raptor":true},"graphrag":{"use_graphrag":true}}` | `code:0`，字段被**静默丢弃**，`parser_config` 不含这两键，且无错误无警告 |
| 对已有数据集 `PUT` 同样的 `parser_config` | `code:0`，同样无效果 |
| `parser_config:{"Compiler:Owb":{...}}`，`parse_type:1` | `code:0`，同样被丢弃 |

开启方式是 ingestion pipeline 里的 `Compiler` 节点，全部能用 API key 完成：

**(1) 取内置模板**

```
GET /api/v1/compilation-templates/builtins
{"code":0,"data":[{"id":"tree","kind":"tree","display_name":...,"description":...,"config":{...}},...]}
```

`kind` 实测取值：`knowledge_graph`、`timeline`、`mind_map`、`page_index`、`session_essence`、`session_graph`、`tree`、`wiki`。RAPTOR 对应 `tree`，知识图谱对应 `knowledge_graph`。

**(2) 建模板组**

```
POST /api/v1/compilation-template-groups
{"name":"owb-g-both","description":"","templates":[
  {"name":"owb-g-both-t","kind":"tree","description":"","config":<tree 的 config 去掉 entity、relation>},
  {"name":"owb-g-both-g","kind":"knowledge_graph","description":"","config":<knowledge_graph 的 config>}]}
→ {"code":0,"data":{"id":"<group_id>","name":...,"description":...,"scope":"file","templates":[...],
   "create_time":...,"update_time":...},"message":"success"}
```

内置 `tree` 的 `config.entity.fields` 带一条空 `type`，原样提交回 `102`，`Entity type is required`，所以要删掉 `entity` 与 `relation`。

**(3) 取内置 pipeline 并插入 Compiler 节点**

`GET /api/v1/pipelines/<parser_id>` 无须鉴权，应答 `{"code":0,"data":{"dsl":{...}}}`；不存在回 `{"code":102,...,"message":"pipeline not found"}`。把节点插在该 DSL 的 chunker 节点与其下游之间：

```json
{
  "Compiler:<节点名>": {
    "upstream": ["<chunker 节点>"],
    "downstream": ["<chunker 原来的下游>"],
    "obj": {
      "component_name": "Compiler",
      "params": {
        "compilation_template_group_id": "<group_id>",
        "llm_id": "",
        "plan": false,
        "outputs": {"chunks": {"type": "Array<Object>", "value": []}}
      }
    }
  }
}
```

同步改 chunker 的 `downstream`、下游的 `upstream`，并在 `graph.nodes` 加 `type:"compilationNode"` 的节点、在 `graph.edges` 加两条边。各模板的 chunker 节点名不同（`GeneralChunker:SixApplesFall`、`ManualChunker:NineInsectsFind`、`QAChunker:TidyCloudsThink` 等），要按 `component_name` 含 `Chunker` 查找。

**(4) 建画布**

```
POST /api/v1/agents
{"title":"owb-cv-both","canvas_category":"dataflow_canvas","dsl":{...}}
→ {"code":0,"data":{"canvas_category":"dataflow_canvas","create_date":...,"create_time":...,"dsl":{...},
   "id":"<canvas_id>","permission":"me","release":...,"tags":...,"title":"owb-cv-both",
   "update_date":...,"update_time":...,"user_id":"<user_id>"},"message":"success"}
```

同名标题自动加后缀（`owb-cv-life(1)`）。不带 `dsl` 回 `101`，`no DSL data in request`。

**(5) 以 pipeline 建数据集**

```
POST /api/v1/datasets
{"name":"owb-c-both","parse_type":2,"pipeline_id":"<canvas_id>","embedding_model":"bge-m3@owb-embed@OpenAI-API-Compatible"}
```

同一画布可被两个数据集引用（建库成功；解析只在其中一个上跑过，见 §14）。

### 5.2 是否需要显式触发

**不需要**。文档解析时 Compiler 节点在 pipeline 内运行；解析完成后 RAGFlow 自动建数据集级任务做合并（事件 `Created automatic Tree dataset task for 1 document event(s)`）。没有也不需要单独的「编译」接口。

观察到的事件序列（`latest_ingestion_event.message`）：

```
Task is queued...
Compiler Started
Compiler: tree-template: claim extraction start: 3 chunk(s) -> 1 batch(es)
Compiler: tree-template: extracting claims for chunk 3/3
Compiler: hypergraph-template: extracting batch 1/1
Compiler: hypergraph-template: batch 1/1 done: 6 entities, 4 relations
Tokenizer Started
Tokenizer Done
Task completed.
```

722 字节的文件，两种编译都开时，从触发解析到文档终态约 1–3 分钟（含排队；入库 worker 串行，且与其它探测并行）。

### 5.3 状态接口

```
GET /api/v1/datasets/<dataset_id>/compilation/status
{"code":0,"data":{"kind":"","state":"idle","progress":0,"inflight":0,"backlog":0,
 "updated_at":"0001-01-01T00:00:00Z"},"message":"success"}

{"code":0,"data":{"kind":"","state":"running","progress":0.4,"current_phase":"merging_navigation",
 "progress_msg":"Classifying 1 scheduling entries\n...","inflight":1,"backlog":0,"updated_at":"..."},"message":"success"}

{"code":0,"data":{"kind":"","state":"completed","progress":1,"current_phase":"completed",
 "progress_msg":"...","inflight":0,"backlog":0,"last_completed_at":"...","updated_at":"..."},"message":"success"}
```

`state` 实测取值：`idle`、`running`、`completed`。`pending` 未观察到（源码定义了它，4 份文档连续解析、0.15 秒轮询也没抓到）。`error` 键未观察到。`current_phase` 观察到 `deleting`、`loading_products`、`merging_navigation`、`completed`。

`?kind=` 实测了 `tree`、`graph`（源码另列 `raptor`、`knowledge_graph` 等别名，未实测）；未知值回 `102`，`unsupported compilation kind`；`kind` 字段回显请求值。

**按类型读取没有终态**：批次跑完后，无 `kind` 的请求是 `completed`，而 `?kind=tree` 与 `?kind=graph` 都回 `idle`，与「从未编译」的应答相同。批次进行中，只有涉及该类型时才是 `running`（只开 RAPTOR 的库，`kind=graph` 全程 `idle`）。无 `kind` 的 `state` 在多文档时随批次往返（`running` → `completed` → `running`），文档还在排队时也可能是 `completed`。

按类型的终态要从数据集任务日志读：

```
GET /api/v1/datasets/<dataset_id>/ingestions?page=1&page_size=10
{"code":0,"data":{"logs":[{"avatar":null,"create_date":...,"create_time":...,"dataset_id":"<dataset_id>",
 "document_id":"graph_raptor_x","document_name":"Tree","document_suffix":"",
 "dsl":{"entries":[{"doc_id":"<document_id>","event_type":"doc_completed","task_type":"Tree","variants":["tree"]}],"task_type":"Tree"},
 "id":"<log_id>","latest_ingestion_event":{"id":...,"ts":...,"event_type":2,"component":"","phase":0,
 "message":"Knowledge compilation completed"},"operation_status":"DONE","process_begin_at":...,
 "process_duration":31.9,"progress":1,"source_from":"knowledgebase","status":"1","task_type":"Tree",
 "tenant_id":"<tenant_id>","update_date":...,"update_time":...}],"total":1}}
```

`task_type` 观察到 `Tree`、`Graph`；`operation_status` 观察到 `RUNNING`、`DONE`。一份文档一个批次一条，开两种时每批次两条。

产物可读：`GET /datasets/<id>/artifacts/structure?kind=graph`（`total_entities`、`total_relations`）、`GET /datasets/<id>/navigation`（RAPTOR 的 `items`）、`GET /datasets/<id>/documents/<id>/structure/graph`（`templates[].kind` 为 `tree` / `knowledge_graph`）。`artifacts/structure?kind=tree` 回 `101`，`invalid structure kind: "tree"`。

### 5.4 编译失败时的信号

| 场景 | 文档 | 编译状态 | 任务日志 |
|---|---|---|---|
| `tree`，对话模型密钥无效 | **`COMPLETED`**，1 个切片 | **`idle`，无 error** | **无** |
| `tree`，对话模型的实例已删除 | **`COMPLETED`**，1 个切片；容器日志 `tree: claim extraction skipped for batch` | **`idle`，无 error** | **无** |
| `knowledge_graph`，对话模型密钥无效 | `FAILED`，0 切片，停在 Compiler 节点 | `idle` | 无 |
| `knowledge_graph`，对话模型已删除 | `FAILED`，`Compiler: model configuration unavailable: ...` | 不可靠（当时有 §13 的积压） | 无新增 |
| `tree`，账号缺省嵌入模型已清空 | `FAILED`，`knowledge_compiler: embedding_model is required and no tenant default embedding model is set` | 不可靠（同上） | 无新增 |

所以 D14 的 `failed` 没有统一来源：图谱失败表现为文档 `FAILED`，整份文档 0 切片；RAPTOR 失败可能完全无信号，文档照常 `COMPLETED`，只能从「任务日志没有该类型的记录、产物为空」推断。

失败消息含上游原文，可能带上游 request id，不得进入本系统的响应、审计或日志（与 D4 一致）。

### 5.5 Compiler 用哪个模型

- `llm_id` 留空的 Compiler 节点，建数据集时 `parser_config` 里被填成**账号当时的缺省对话模型**（实测 `Compiler:*.llm_id` 读回为三段式）。之后清空账号缺省，文档阶段的编译仍用这个固化值，照常产出。
- 所以清空账号缺省不影响已建数据集的文档阶段编译；要删除模型本身，编译才失效（§5.4）。
- 数据集级合并另用账号缺省对话模型，没有缺省时入库进程退出（§13）。
- 文档阶段的 Compiler 依赖账号缺省嵌入模型，不是数据集的 `embedding_model`（上表最后一行）。

结论：**支持**，形状是 pipeline 而不是数据集字段，无须显式触发。各模板的支持情况见表 C。

## 6. 改嵌入模型（`PUT /api/v1/datasets/<dataset_id>`）

```
PUT /api/v1/datasets/<dataset_id>      （chunk_count 为 2，document_count 为 24）
{"embedding_model":"bge-m3@owb-alt@OpenAI-API-Compatible"}
→ HTTP 200 {"code":0,"data":{"chunk_count":2,...,"embedding_model":"bge-m3@owb-alt@OpenAI-API-Compatible",...}}
```

`chunk_count` 非 0 时**成功**，已有切片未重建也未报错。这与文档及 design Context「要求 `chunk_count` 为 0」相反。`chunk_count` 为 0 时同样成功。模型不存在回 `102`。

D8 用新数据集做重建，不依赖这条，但本系统不得用它代替重建：改完不会重算向量。

结论：**支持**（行为与文档不符）。

## 7. multipart 上传（`POST /api/v1/datasets/<dataset_id>/documents`）

### 7.1 请求与应答

字段名为 `file`，可重复（一次两个文件回两条）。

```
POST /api/v1/datasets/<dataset_id>/documents
Content-Type: multipart/form-data; boundary=...
Content-Disposition: form-data; name="file"; filename="a.txt"

→ HTTP 200，Transfer-Encoding: chunked
{"code":0,"data":[{"chunk_count":0,"content_hash":"...","created_by":"<user_id>","dataset_id":"<dataset_id>",
 "id":"<document_id>","ingestion_status":"UNSTART","location":"a.txt","name":"a.txt","parser_config":{...},
 "parser_id":"general","size":16,"source_type":"local","suffix":"txt","token_count":0,"type":"doc"}]}
```

pipeline 数据集另有 `pipeline_id`，`parser_id` 为空串。

| 请求 | 应答 |
|---|---|
| 字段名 `files` / `upload` | `101`，`No file part!` |
| `application/octet-stream` 裸体 | `101`，`No file part!` |
| `?type=nope` | `101`，`"type" must be one of "local", "web", or "empty".` |
| 同名文件 | 成功，`name` 与 `location` 变为 `a(1).txt`、`a(2).txt`，内容相同与否都一样 |
| 空文件 | 成功，`size:0`，解析后 `COMPLETED`、0 切片；**但下载回 `code:500`**（§9） |
| 文件名 255 字节 | 成功 |
| 文件名 256 字节 | `101`，`File name must be 255 bytes or less.` |
| `bin.exe`、`thing.zzz`、无后缀 `noext` | **HTTP 200，`code:500`**，`bin.exe: This type of file has not been supported yet!` |

### 7.2 流式请求体

用裸 socket 真发，不用 HTTP 库：

| 用例 | 结果 |
|---|---|
| 带 `Content-Length`，1 140 151 字节分 18 段发，段间停 30 ms | 成功，存入 1 140 000 字节，下载后 SHA-256 与发送值一致 |
| 带 `Content-Length`，105 MiB，边发边算 | 成功，`size` 为 110 100 480，下载后 SHA-256 与发送值一致 |
| `Transfer-Encoding: chunked` | 成功 |
| 带 `Content-Length`，发到 327 680 字节时断开 | 文档总数前后相同，不留半成品 |

### 7.3 文件名

| `Content-Disposition` | 存下的 `name` |
|---|---|
| `filename="中文文件名.txt"`（原始 UTF-8 字节） | `中文文件名.txt` |
| `filename="%E4%B8%AD...txt"` | 百分号串原样保留，不解码 |
| `filename="ascii.txt"; filename*=UTF-8''%E4%B8%AD...txt` | 取 `filename*`，解码为中文 |
| 只有 `filename*=UTF-8''...` | 解码为中文 |
| `filename="a\"b.txt"` | `a"b.txt` |
| `filename="dir/sub/c.txt"` | `c.txt`，路径被去掉 |

组 10 的 multipart 用原始 UTF-8 或 `filename*` 都可以，不要用百分号编码放进 `filename`。

### 7.4 文件类型与模板：不匹配时静默换解析器

每种模板的 Parser 只管一部分后缀。上传后缀不归该模板管时，RAGFlow 不报错，把**这份文档**改走别的内置解析器，并脱离数据集的 pipeline：

| 数据集 | 上传 | 文档实际 |
|---|---|---|
| `manual`（内置） | `.txt` | `parser_id:"general"` |
| `paper`（内置） | `.txt` | `parser_id:"general"` |
| `general`（内置） | `.png` | `parser_id:"picture"` |
| `qa`（内置） | `.pdf` | `parser_id:"qa"`，未换 |
| `manual` + Compiler 的 pipeline | `.txt`、`.md` | `parser_id:"general"`，`pipeline_id` 为空，**编译不运行**，无任何提示 |

各模板管的后缀见表 C 末列。

结论：**支持**。

## 8. 解析与文档列表

### 8.1 触发解析

```
POST /api/v1/datasets/<dataset_id>/documents/parse
{"document_ids":["<document_id>"]}
→ {"code":0,"data":{"success_count":1},"message":"success"}
```

`success_count` 是实际新启动的任务数，`code` 永远是 0：

| 文档状态 | `success_count` |
|---|---|
| `UNSTART`、`FAILED` | 1 |
| `RUNNING` | 0 |
| `COMPLETED` | 0，不会重解析 |
| 不存在 / 属于别的数据集 / 非 hex id | 0 |

`STOPPED` 之后重新解析未实测（§14）。混合一份真实一份不存在：`success_count:1`。`document_ids` 为空或缺失：`102`，`` `document_ids` is required ``。

调用方必须检查 `success_count`，不能只看 `code`。

### 8.2 停止解析

```
POST /api/v1/datasets/<dataset_id>/documents/stop
{"document_ids":["<document_id>"]}
→ {"code":0,"data":{"success_count":1},"message":"success"}
```

| 文档状态 | 应答 |
|---|---|
| `RUNNING`、`STOPPED` | `code:0`，`success_count:1` |
| `UNSTART`、`COMPLETED` | `code:0`，`{"errors":["Can't stop parsing document that has not started or already completed"],"success_count":0}` |
| 不存在 | `code:100`，`Documents not found: ['<document_id>']` |

### 8.3 文档列表

```
GET /api/v1/datasets/<dataset_id>/documents?page=1&page_size=100
{"code":0,"data":{"docs":[{...}],"has_active_tasks":false,"total":16},"message":"success"}
```

列表行的键：`chunk_count`、`chunk_method`、`create_date`、`create_time`、`created_by`、`dataset_id`、`id`、`ingestion_status`、`latest_ingestion_event`、`location`、`meta_fields`、`name`、`nickname`、`parser_config`、`parser_id`、`pipeline_id`、`pipeline_name`、`process_begin_at`、`process_duration`、`progress`、`progress_msg`、`size`、`status`、`suffix`、`thumbnail`、`token_count`、`type`、`update_date`、`update_time`。

- **运行状态字段是 `ingestion_status`**。`status` 恒为 `"1"`，是启用标志，不是运行状态。
- **切片数字段是 `chunk_count`**。
- 失败原因在 `latest_ingestion_event.message`；`progress_msg` 全程是空串。
- `latest_ingestion_event` 形如 `{"id":12,"ts":"...","event_type":1,"component":"","phase":0,"message":"..."}`；`event_type` 观察到 1（过程）与 2（终态）。
- `progress` 取值：成功 `1`；`STOPPED` 为 `-1`；`FAILED` 停在失败时的进度（`0.2`、`0.5`）。

分页：

| 查询 | `total` | 返回条数 |
|---|---|---|
| `page=1&page_size=5` | 16 | 5 |
| `page=4&page_size=5` | 16 | 1 |
| `page=999&page_size=5` | 16 | 0 |
| `page=1&page_size=100` | 16 | 16 |
| `page=1&page_size=101` / `1000` | 16 | **10，静默回落** |
| `page=1&page_size=0` / 非数字 / 不传 | 16 | 10 |
| `page=0` / `page=-1`，`page_size=5` | 16 | 5，当作第 1 页 |

缺省按创建时间倒序。`orderby` 只接受 `create_time`、`update_time`、`name`，其它值回 `101`，`invalid orderby field: size`；`desc=false` 生效。

过滤：`id=<id>`、`name=<精确名>` 查不到时回 `102`（`you don't own the document ...`），`data` 为 `{"docs":[],"total":0}`。`ingestion_status=`（也接受 `run=`）按状态过滤；非法值回 `102`。

### 8.4 运行状态的全部取值

八种都在运行实例上观察到：

| `ingestion_status` | 如何观察到 | 伴随 |
|---|---|---|
| `UNSTART` | 上传后未解析 | `progress:0` |
| `CREATED` | 8 份文档一次触发、紧密轮询时抓到 | 瞬时 |
| `SCHEDULED` | 入库 worker 被占用时排队 | `Task is queued...` |
| `RUNNING` | 解析中 | `progress` 上升，事件逐节点变化 |
| `STOPPING` | `documents/stop` 之后约 0.5 秒内 | 事件不变 |
| `STOPPED` | 停止完成 | `progress:-1`，`Task stopped by user.` |
| `COMPLETED` | 成功 | `progress:1`，`Task completed.` |
| `FAILED` | 4 KiB 随机字节命名为 `.pdf` | `Task failed: pipeline: run canvas workflow: [NodeRunError] agent: component "Parser" invoke: ...` |

映射见表 A。入库 worker 只有 1 个（容器日志 `Worker pool started with 1 workers`），解析串行，排队时间取决于共用栈的负载。

### 8.5 删除文档

```
DELETE /api/v1/datasets/<dataset_id>/documents
{"ids":["<document_id>"]}
→ {"code":0,"data":{"deleted":1},"message":"success"}
```

| 文档状态 | 应答 | 删除后 |
|---|---|---|
| `UNSTART`、`SCHEDULED`、`COMPLETED`、`FAILED`、`STOPPED` | `deleted:1` | 已删 |
| **`RUNNING`、`STOPPING`** | **`code:0`，`deleted:0`** | **行仍在** |

运行结束后再删回 `deleted:1`。调用方必须检查 `deleted`，`code:0` 不代表删成了。

`ids` 含重复回 `101`；`ids` 为空或缺失回 `102`（`should either provide doc ids or set delete_all(true)`）；类型错回 `102`。

结论：**支持**。

## 9. 原件下载（`GET /api/v1/datasets/<dataset_id>/documents/<document_id>`）

| 文件 | HTTP | 字节数 | `Content-Length` | `Transfer-Encoding` | `Content-Type` |
|---|---|---|---|---|---|
| 16 字节 | 200 | 16 | 16 | 无 | `application/octet-stream` |
| 2047 / 2048 / 2049 字节 | 200 | 同左 | 同左 | 无 | 同上 |
| 4096 / 4097 字节 | 200 | 同左 | 同左 | 无 | 同上 |
| 1 140 000 字节 | 200 | 同左 | 同左 | 无 | 同上 |
| 110 100 480 字节 | 200 | 同左 | 同左 | 无 | 未记录 |
| **0 字节** | **200** | 52 | 52 | 无 | `application/json; charset=utf-8` |

全部字节数与 SHA-256 都和上传时一致。

**始终带 `Content-Length`，未观察到分块传输**，D8 的「大于 2 KiB 很可能走分块」在实例上不成立。

**0 字节文件的下载是错误应答**：`HTTP 200`，`{"code":500,"message":"Failed to download document"}`。

其它：
- `Content-Disposition: attachment; filename="a.txt"`；非 ASCII 名是未编码的原始 UTF-8 字节，文件名里的 `"` 不转义。本系统不应解析它。
- `Range: bytes=0-99` 被忽略，回 200 与全量。
- `HEAD` 回 HTTP 404 与 JSON 体。

结论：**支持**。

## 10. 不存在的 id

完整组合见表 B。要点：全部是 HTTP 200，靠 body 判定；数据集不存在与「曾存在、已删除」的应答完全相同。

- 能靠 `code` 与参数非法区分：`code:404` 的路由。
- `POST /datasets/<id>/documents`：`102` + 固定前缀，与其它 `102` 只能靠 message 区分。
- `DELETE /datasets/<id>/documents`：同上。
- `DELETE /api/v1/datasets`：`code:403`，与真实权限错误相同，而非 hex 的 id 是 `101`。
- `POST .../documents/parse`：`code:0`，`success_count:0`，与「已在运行」「已完成」不可区分。
- `POST .../documents/stop`：`code:100`。

混合批次：

| 请求 | 应答 | 实际 |
|---|---|---|
| `DELETE .../documents` 含一真一假 | `102` | **全部不删** |
| `DELETE /datasets` 含一真一假 | `403` | **全部不删** |
| `POST .../documents/parse` 含一真一假 | `code:0`，`success_count:1` | 真的那份启动 |

结论：**支持**，但 D4「HTTP 状态加 code」不足以覆盖全部路由。

## 11. 模型下发

全部用 API key 完成。

### 11.1 配提供方与实例

```
PUT /api/v1/providers
{"provider_name":"OpenAI-API-Compatible"}
→ {"code":0,"data":null,"message":"success"}

POST /api/v1/providers/OpenAI-API-Compatible/instances
{"instance_name":"owb-embed","api_key":"<api_key>","base_url":"<UPSTREAM_BASE_URL>",
 "model_info":[{"model_name":"bge-m3","model_type":["embedding"],"max_tokens":8192}]}
→ {"code":0,"data":null,"message":"success"}

POST /api/v1/providers/OpenAI-API-Compatible/instances/owb-embed/models
{"model_name":"deepseek-v4.1-flash","model_type":["chat"],"max_tokens":8192}
→ {"code":0,"message":"success"}
```

读回：

```
GET /api/v1/providers
{"code":0,"data":[{"base_url":null,"has_instance":false,"name":"OpenAI-API-Compatible","total_models":0}],"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible/instances
{"code":0,"data":[{"id":"<instance_id>","instance_name":"owb-embed","provider_id":"<provider_id>","region":"","status":"active"}],"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible/instances/owb-embed
{"code":0,"data":{"api_key":"<api_key>","base_url":"<UPSTREAM_BASE_URL>","id":"<instance_id>",
 "instance_name":"owb-embed","provider_id":"<provider_id>","region":"","status":"active"},"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible/instances/owb-embed/models
{"code":0,"data":[{"extra":{"max_tokens":8192},"features":[],"max_tokens":8192,"model_type":["embedding"],
 "name":"bge-m3","status":"active","verify":"unknown"}],"message":"success"}

GET /api/v1/models
{"code":0,"data":[{"instance_id":"<instance_id>","instance_name":"owb-embed","model_id":"<model_id>",
 "model_type":["embedding"],"name":"bge-m3","provider_id":"<provider_id>",
 "provider_name":"OpenAI-API-Compatible","rank":500,"tenant_id":"<tenant_id>","tenant_name":"<tenant_name>"}],"message":"success"}
```

**`GET .../instances/<实例>` 明文回显上游密钥。** 本系统的客户端不得记录这个应答体。

### 11.2 账号缺省模型

```
PATCH /api/v1/models/default
{"model_provider":"OpenAI-API-Compatible","model_instance":"owb-embed","model_name":"bge-m3","model_type":"embedding"}
→ {"code":0,"data":{"models":[]},"message":"success"}
```

`model_type` 取 `embedding` 或 `chat`。应答的 `models` 恒为空数组，读取要另发请求：

```
GET /api/v1/models/default
{"code":0,"data":{"models":[{"model_provider":"OpenAI-API-Compatible","model_instance":"owb-embed",
 "model_name":"deepseek-v4.1-flash","model_id":"<model_id>","model_type":"chat","enable":true},
 {...,"model_type":"embedding","enable":true}]},"message":"success"}

GET /api/v1/users/me/models
{"code":0,"data":{"tenant_id":"<tenant_id>","name":"<tenant_name>",
 "llm_id":"deepseek-v4.1-flash@owb-embed@OpenAI-API-Compatible",
 "embd_id":"bge-m3@owb-embed@OpenAI-API-Compatible","rerank_id":"","asr_id":"","img2txt_id":"","tts_id":"",
 "parser_ids":"naive:General,qa:Q&A,...,tag:Tag","role":"owner"},"message":"success"}
```

**不要用 `PATCH /api/v1/users/me/models`**：实例对随机 `tenant_id` 回 `code:0`，源码（`internal/service/user.go:741`）不校验该租户归属。缺省模型一律走 `PATCH /api/v1/models/default`。

清空缺省：`PATCH /api/v1/models/default` 带 `{"model_type":"chat"}`，或三个名字都为空串。**有 §13 的风险。**

### 11.3 以 `embedding_model` 引用

`bge-m3@owb-embed@OpenAI-API-Compatible` 建库成功，文档解析成功（§4.1、§8）。

### 11.4 改与删

| 操作 | 应答 |
|---|---|
| `PUT /providers/<p>/instances/<i>`，带 `instance_name`、`api_key`、`base_url`、`model_info` | `code:0`；实例 `GET` 读到新值；模型 `verify` 复位为 `unknown` |
| 同上但不带 `model_info` | **HTTP 400**，`code:400` |
| 同上但 `api_key` 为空串 | `code:0`，**密钥被清空**，不是保留 |
| `model_info` 增一项 | 该模型被加入 |
| `PUT` 不存在的实例 | `code:404` |
| `POST` 同名实例 | **`code:500`**，`fail to create model instance: instance owb-alt already exists` |
| `POST` 同名模型 | `code:409` |
| 实例名含空格等 | HTTP 200，`code:400` |
| 空 body 建实例 | HTTP 200，`code:400` |
| 未知提供方建实例 | `code:404`，`provider 'Nope' does not exist` |
| 重复 `PUT /providers` | `code:0`，幂等 |
| `PUT /providers` 未知名字 | `code:0`，不出现在列表里；之后 `DELETE /providers/<该名>` 回 `code:0`，而从未 `PUT` 过的名字回 `404` |
| `PATCH /models/default` 模型不存在 | `code:100`，`model missing isn't available` |
| `PATCH /models/default` 类型不符 | `code:100`，`model bge-m3 isn't a chat model` |
| `PATCH /models/default` 无 `model_type` | HTTP 400，`code:400` |

删除：

```
DELETE /api/v1/providers/OpenAI-API-Compatible/instances/owb-embed/models
{"model_name":["deepseek-v4.1-flash"]}
→ {"code":0,"data":null,"message":"success"}        之后模型列表只剩 bge-m3

DELETE /api/v1/providers/OpenAI-API-Compatible/instances
{"instances":["owb-rev"]}
→ {"code":0,"data":null,"message":"success"}

DELETE /api/v1/providers/OpenAI-API-Compatible
→ {"code":0,...}                                    之后 GET /providers 为 []
```

| 删除情形 | 应答 |
|---|---|
| 再删已删模型 | `code:404`，`models [...] not found for provider ...` |
| 删模型不带 `model_name` | HTTP 400，`code:400` |
| 删不存在的实例 | `code:404` |
| 删实例空 body | HTTP 200，`code:400` |
| 删不存在的提供方 | `code:404` |
| **删除被账号缺省引用、被数据集使用的嵌入模型** | **`code:0`，无保护** |

删掉被引用的嵌入模型之后：`GET /users/me/models` 的 `embd_id` 仍指向它（**悬空**）；`GET /models/default` 的 `models` 为空；数据集读回的 `embedding_model` 不变；新建数据集显式引用它回 `102`，不传则成功并绑定悬空值；解析回 `success_count:1`，然后 `FAILED`（`component "Indexer" invoke: Tokenizer: tokenizer: resolve embedder: model configuration unavailable: ...`）。

`GET .../instances/<i>/connection` 走模型列表：有效密钥 18 秒回 `code:0`；无效密钥回 `code:500`，`no models found for provider`。它不等于嵌入探活，D7 的探活直连上游，不用它。

结论：**支持**。API key 能配 provider instance、配账号缺省模型、以 `embedding_model` 引用、删除已下发配置。撤销路径有两处要改 design，见 §13 与 §14。

## 12. 错误组合

| 情形 | HTTP | body `code` | message 摘录 |
|---|---|---|---|
| 无 `Authorization` | 401 | 401 | `Missing Authorization header` |
| `Bearer` 错误密钥 | 401 | 401 | `Invalid access token` |
| `Bearer ` 空 | 401 | 401 | `Invalid access token` |
| `Basic ...` | 401 | 401 | `Invalid access token` |
| 不带 `Bearer` 前缀的裸密钥 | 200 | 0 | 被接受 |
| `bearer`（小写） | 200 | 0 | 被接受 |
| 参数非法：多余字段、畸形 JSON、错 `Content-Type`、缺文件字段 | 200 | 101 | 见 §4、§7 |
| 参数非法：非 hex 的数据集 id（`PUT`、`DELETE /datasets`） | 200 | 101 | `Invalid UUID format` |
| 参数非法：缺字段、取值非法 | 200 | 102 | 见 §4 |
| 权限不足：`GET /tenants/<随机>/users` | 200 | **403** | `Permission denied` |
| 未知路由、未注册的方法 | 404 | 404 | `Not Found: /api/v1/nope` |
| `HEAD` 文档 | 404 | — | JSON 体 |
| 模型提供方路由的绑定错误（部分） | 400 | 400 | Go 校验器原文 |
| 不支持的文件类型、重复实例、0 字节下载 | 200 | 500 | 见 §7、§9、§11 |
| 操作异常 | 200 | 100 | `Documents not found: [...]`、`model missing isn't available` |
| 智能体不存在或无权 | 200 | 103 | `Make sure you have permission to access the agent.` |
| 未实现 | 200 | 501 | `IsAdmin not implemented` |

**`109` 与 `108` 未观察到**：鉴权失败是 HTTP 401 + `code:401`，权限不足是 HTTP 200 + `code:403`。D4 的第 4 条按 HTTP 401 / 403 或 body `108` / `109` 判定，HTTP 200 + `code:403` 不命中，会落入第 5 条，且不写 `kb_upstream_auth_failed`。

结论：**支持**；真实跨账号访问未测成（§14）。

## 表 A：运行状态到本系统 `status` 的映射

| `ingestion_status` | `status`（D12） | web 刷新 | 备注 |
|---|---|---|---|
| `UNSTART` | `unparsed` | 否 | |
| `CREATED` | `queued` | 是 | 瞬时 |
| `SCHEDULED` | `queued` | 是 | |
| `RUNNING` | `parsing` | 是 | |
| `STOPPING` | `parsing` | 是 | D12 没有对应值；此时删除文档回 `deleted:0` |
| `STOPPED` | `cancelled` | 否 | `progress:-1` |
| `COMPLETED` | `done` | 否 | `chunk_count` 取列表字段；可能为 0 |
| `FAILED` | `failed` | 否 | |
| 列表里没有该 id | `missing` | 否 | 本系统判定 |

`FAILED` 可重新触发解析；`COMPLETED` 不可（`success_count:0`）；`STOPPED` 未实测。

## 表 B：「不存在」组合

全部实测，HTTP 状态除特别注明外都是 200。「不存在」指 32 位随机 hex、带连字符的随机 UUID、曾存在已删除三种，应答相同。

### 数据集 id

| 路由 | 不存在 | 非 hex 串 / 全零 / 40 字符 | 与参数非法区分 |
|---|---|---|---|
| `GET /datasets/<id>` | `404` `Resource not found` | 同左 | 能 |
| `PUT /datasets/<id>` | `404` | `101` `Invalid UUID format` | 能 |
| `DELETE /datasets` `{"ids":[<id>]}` | **`403` `Permission denied`** | `101` `Invalid UUID format` | 能，但与真实权限错误不可区分 |
| `GET /datasets/<id>/documents` | `404` | 同左 | 能 |
| `POST /datasets/<id>/documents` | **`102`** `Can't find the dataset with ID <id>!` | 同左 | **只能靠 message 前缀** |
| `POST /datasets/<id>/documents/parse` | `404` | 同左 | 能 |
| `POST /datasets/<id>/documents/stop` | `404` | 同左 | 能 |
| `DELETE /datasets/<id>/documents` | `404` | 同左 | 能 |
| `GET /datasets/<id>/documents/<doc>` | `404` | 同左 | 能 |
| `GET /datasets/<id>/compilation/status` | `404` | 同左 | 能 |

### 文档 id（数据集真实存在）

不存在、已删除、非 hex、全零、属于别的数据集，五种应答相同。

| 路由 | 应答 | 与参数非法区分 |
|---|---|---|
| `DELETE /datasets/<ds>/documents` | **`102`** `These documents do not belong to dataset <id> or Document not found: <id>` | **只能靠 message 前缀** |
| `GET /datasets/<ds>/documents/<id>` | `404` `Resource not found` | 能 |
| `GET /datasets/<ds>/documents?id=<id>` | `102` `you don't own the document <id>`，`data:{"docs":[],"total":0}` | 只能靠 message 前缀 |
| `POST /datasets/<ds>/documents/parse` | **`0`**，`success_count:0` | 不是错误应答 |
| `POST /datasets/<ds>/documents/stop` | `100` `Documents not found: ['<id>']` | 能 |

### 其它资源

| 路由 | 应答 |
|---|---|
| `GET /agents/<id>` | `103` `Make sure you have permission to access the agent.` |
| `DELETE /agents/<id>` | `103` `Only the owner of the agent is authorized for this operation.` |
| `DELETE /compilation-template-groups/<id>` | `404` `Cannot find compilation template group <id>.` |
| 提供方、实例、模型 | §11.4 |

## 表 C：RAPTOR / 知识图谱的模板支持

每种模板：`GET /pipelines/<parser_id>` 取 DSL → 插 Compiler（同一模板组开两种）→ 建画布 → `parse_type:2` 建库 → 上传该模板支持的小文件 → 解析 → 看任务日志与产物。「可用」指任务日志同时有 `Tree DONE` 与 `Graph DONE`，且 `Compiler` 事件报出实体数；`picture` 的任务日志只在运行中读过（当时为空），它的依据是事件序列同时有 `tree-template` 与 `hypergraph-template`，且 `compilation/status` 终态 `completed`。

| 模板 | `parser_id` | 建库 | 实测文件 | 实体 / 关系 | RAPTOR：D9 → 实测 | 图谱：D9 → 实测 | 模板管的后缀 |
|---|---|---|---|---|---|---|---|
| naive | `general`（`naive` 为别名） | 可 | `.txt` | 9 / 9 | 不可用 → 可用，**不符** | 可用 → 可用，一致 | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、csv、14 种文本与代码 |
| book | `book` | 可 | `.txt` | 9 / 10 | 可用 → 可用，一致 | 一致 | doc、docx、htm、html、pdf、txt |
| email | `email` | 可 | `.eml` | 9 / 9 | 不可用 → 可用，**不符** | 一致 | eml |
| laws | `laws` | 可 | `.txt` | 9 / 11 | 一致 | 一致 | doc、docx、htm、html、md、markdown、mdx、pdf、txt |
| manual | `manual` | 可 | `.pdf` | 10 / 11 | 一致 | 一致 | doc、docx、pdf（`.txt`、`.md` 退到 general，编译不运行） |
| one | `one` | 可 | `.txt` | 9 / 9 | 不可用 → 可用，**不符** | 一致 | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、txt |
| paper | `paper` | 可 | `.pdf` | 10 / 10 | 一致 | 一致 | pdf |
| picture | `picture` | 可 | `.png` | 5 / 3 | 不可用 → 可用，**不符** | 一致 | 9 种图片、11 种视频 |
| presentation | `presentation` | 可 | `.pdf` | 10 / 10 | 一致 | 一致 | pdf、pptx、ppt |
| qa | `qa` | 可 | `.txt`、`.csv` | 6 / 4 | 一致 | 一致 | docx、md、markdown、mdx、pdf、xls、xlsx、csv、txt（`.md` 按示例格式写的未切出切片，0 切片，编译未运行） |
| table | `table` | 可 | `.csv` | 2 / 0 | 不可用 → 可用，**不符** | 一致 | xls、xlsx、csv、txt |
| **tag** | **不接受** | **`102`** | — | — | 不可用 → 不可用，一致 | 不可用 → 不可用，一致；**但 D9 与 Goals 把它列为可建模板：不符** | — |
| audio（D9 无） | `audio` | 可 | `.wav` | — | D9 无 → **未测成** | D9 无 → **未测成** | 15 种音频 |

- D9 的「RAPTOR 只对六种可用」来自 demo，rc2 没有这个限制：除 `tag`、`audio` 外十一种都实际跑通。
- `audio`：解析在 Parser 节点 `FAILED`，`no default speech2text model is set`；账号没配语音模型，编译节点没有轮到。
- 内置模板的 Extractor 节点：`qa`、`table` 没有，其余都有。

## 13. 共用栈事故：清空缺省对话模型使入库进程崩溃循环

**实测中发生，由本次操作引起，已恢复。**

- 时间：2026-11-01 16:19:27 至 16:25:57（UTC+8），容器日志记录 **8 次** `ingestor exited with code 1. Restarting in 1 second...`，间隔约 25 秒与 95 秒交替。
- 日志原文：`fatal ingestor_server knowledge_compile: dataset-level LLM deduper unavailable, refusing to continue with a no-op merge`，`factory_err` 为 `knowledge_compiler: llm_id is empty and no tenant default chat model available: no default chat model is set`。
- 触发步骤：① 用模型下发一节的方法把账号缺省对话模型清空；② 在两个 pipeline 数据集（`llm_id` 已固化，§5.5）上解析文档。文档照常 `COMPLETED`，随后数据集级合并任务被 worker 取走，因为账号没有缺省对话模型而 `fatal` 退出；进程重启后同一任务又被取走（租约过期是按间隔推断的），循环。
- 影响面：入库进程全栈只有一个，按进程结构判断，**崩溃循环期间共用栈上所有账号的入库都会受影响**，不限于本账号。容器没有重启，事后 `healthz` 全 `ok`。本次未波及其它使用者：事后查元数据库，这套栈上只有部署时的超级管理员与本专用账号两个账号，当天才部署，没有其它使用者。
- 处置：只经 API 恢复本账号的缺省对话与嵌入模型（16:26 前后），两个批次约两分钟内完成；此后日志再无 `fatal`。未执行任何 `docker` 写操作。
- 收尾：删除全部数据集并观察 170 秒无编译活动后，才清空缺省与删除模型配置，再观察 200 秒无 `fatal`、无重启，`healthz` 全 `ok`。
- 编译任务积压时，`compilation/status` 卡在 `running`、`current_phase:"deleting"`，`error` 为空，任务日志 `RUNNING`，外部看不出异常。

对 design 的影响：D7 的「`chatModelId` 改为 `null` 时撤销对话模型的下发」、D14 的「此后的编译会在 RAGFlow 侧失败并显示 `failed`」都不成立。按现有写法清空缺省，已开编译的库下一次入库就会让共用入库进程崩溃循环。**组 8 开工前必须修订撤销语义。**

## 14. 未测成与未观察到

| 项 | 状态 | 原因 |
|---|---|---|
| 真实跨账号访问（别的账号的数据集） | 未测成 | 只有一个账号，按要求不用账号密码，不注册第二个账号 |
| `code:108`、`code:109` | 未观察到 | 同上；单账号下造不出 |
| 编译状态 `pending` 与 `error` 键 | 未观察到 | 4 份文档连续解析、0.15 秒轮询未抓到；源码有定义，但不能算实测 |
| RAPTOR 失败的显式信号 | 未观察到 | 见 §5.4，可能根本不存在 |
| 分块传输的下载应答 | 未观察到 | 16 字节到 105 MiB 都带 `Content-Length` |
| `audio` 模板的编译 | 未测成 | 账号未配 speech2text 模型 |
| 上传体积上限 | 未测成 | 105 MiB 成功，未再往上试 |
| 共用画布被两个库同时解析 | 未测成 | 只验证了两个库都能建成 |
| `STOPPED` 之后重新解析 | 未测成 | §13 之后停止了新探测；只测过 `FAILED` 之后重新解析 |
| `SCHEDULED` 时停止解析 | 未测成 | 同上 |
| 画布被删后的数据集 | 已测 | 上传成功，解析回 `success_count:1`，然后 `FAILED`，`load canvas <id>: agent: not found or access denied`；删除在用画布本身回 `code:0`，无保护 |

## 15. 与 design Context 的逐条复核

| Context 所述 | 实测 |
|---|---|
| 服务端 Go 重写；NATS、Kvrocks | 一致：应答头 `X-API-Source: go`，`/language` 回 `go` |
| 版本与健康接口无鉴权 | 一致 |
| 其余接口 `Authorization: Bearer` | 一致；裸密钥与小写 `bearer` 也被接受 |
| `code`：`0`、`101`、`102`、`103`、`105`、`108`、`109` | `0`、`101`、`102`、`103` 观察到；`105`、`108`、`109` 未观察到；另有 `100`、`400`、`401`、`403`、`404`、`409`、`500`、`501` |
| HTTP 200 加非零 `code` 是常态 | 一致 |
| 重名自动加后缀、不区分大小写、≤128 | 一致 |
| `embedding_model` 形如 `model@factory` | **不符**：三段式；两段式只在实例名为 `default` 时可用 |
| `chunk_method` 十二种 vs `parser_id` | **`parser_id`，且必须带 `parse_type`**；取值见 §4.3 |
| `PUT` 改 `embedding_model` 要求 `chunk_count` 为 0 | **不符** |
| 上传、下载、列表、删除、解析、停止 | 路径一致 |
| 编译状态接口 | 路径一致；形状见 §5.3 |
| 模型提供方路由 | 路径一致，`PATCH /users/me/models` 不可用（§11.2） |

## 16. 清理结果

- 只删除本账号上本次建的对象。开始时账号全空，清理前核对过列表，名称全部以 `owb-` 开头（不区分大小写；其中 `OWB-DUP(2)` 是为测大小写建的，§17 列为偏离）。
- 数据集：54 个，全部删除，`GET /datasets` 的 `total_datasets` 为 0。
- 画布：24 个，全部删除。模板组：7 个，全部删除。
- 模型配置：账号缺省已清空（`llm_id`、`embd_id` 为空），实例 `default`、`owb-bad`、`owb-alt`、`owb-embed` 已删除，提供方已删除；`GET /providers`、`GET /models`、`GET /models/default` 都为空。「能删除」的证据见 §11.4。
- 未触碰任何非本账号的对象，未执行任何 `docker` 写操作。
- 原始应答只保存在会话 scratchpad，不入库。

## 17. 偏离

- 为测大小写建了 `OWB-DUP`，RAGFlow 存为 `OWB-DUP(2)`，大写前缀不符合「一律 `owb-` 前缀」的字面要求，已随清理删除。
- 除数据集外另建了 `owb-` 前缀的画布、模板组与模型实例（实例含一个名为 `default` 的，用来测两段式），已全部删除。
- §13 的事故。

## 18. 结论的后果（tasks 1.4）

| 分流条件 | 是否触发 | 依据 |
|---|---|---|
| 「模型下发」不支持 | **未触发** | §11：API key 能配 instance、配缺省、以 `embedding_model` 引用、删除。D7 应急预案不启动 |
| 「编译开启或触发」不支持 | **未触发** | §5：API key 能建模板组、画布与 pipeline 数据集，解析时自动编译，十一种模板实际产出。D14 的停止条件不成立 |
| 模板支持表与 D9 不符 | **触发** | 表 C：`tag` 不可建；`audio` 为 D9 之外的模板；RAPTOR 在 D9 标为不可用的五种模板上都可用 |

按 tasks 1.4：本 PR 照常合入。合入前建修订 issue R，标题「修订 s2a-kb-ragflow：模板支持表」，组 9 与组 15 首刀 `Depends on #<R>`，先等 owner 决定再修订。

下列事实不构成 1.4 的分流条件，但实现按现有 design 写会出错，应一并进入修订。其中 §13 的撤销语义要求组 8 不能按现稿开工，而 1.4 的机制只挡组 9 与组 15 首刀，**这一条需要主会话另行决定**。

| # | 事实 | 章节 | 涉及 |
|---|---|---|---|
| 1 | 清空缺省对话模型可使共用入库进程崩溃循环 | §13 | D7、D14、ragflow-backend「知识库模型设置」、组 8、组 14 |
| 2 | 「开关」不是数据集字段：要模板组、画布与 pipeline 数据集；模板组与画布的生命周期未设计 | §5.1 | D9、D14、D2、组 9、组 5 夹具 |
| 3 | `embedding_model` 三段式；建库必须带 `parse_type` | §4 | D9、D2、组 9 |
| 4 | 编译状态没有按类型的终态，`done` 要读任务日志 | §5.3 | D14、D9、组 9、组 15 |
| 5 | RAPTOR 失败可能无信号，`failed` 没有统一来源 | §5.4 | D14、组 9、组 15 |
| 6 | 文档后缀不归模板管时静默换解析器，编译不运行 | §7.4 | D9、D10、D14、组 10、组 12 |
| 7 | 不支持的后缀回 `code:500`，按 D4 映射为 `kb_unavailable`，会中止工作空间入库的整批 | §7.1 | D4、D10、组 10、组 12 |
| 8 | `RUNNING`、`STOPPING` 时删文档回 `code:0`、`deleted:0`，按现有流程本地行被删、RAGFlow 留孤儿 | §8.5 | D13、D10、组 13、组 5 夹具 |
| 9 | `success_count:0` 与 `code:0` 同时出现，「解析触发失败」不会被 D4 识别 | §8.1 | D4、D10、D11、D13、组 10、组 12、组 13、组 14 |
| 10 | 不存在组合依路由而异，两条要 message 前缀；`DELETE /datasets` 为 `code:403` | 表 B | D4、spec「RAGFlow 出站请求」、组 5、组 9、组 13、组 14 |
| 11 | 权限错误是 HTTP 200 + `code:403`，鉴权错误是 HTTP 401 + `code:401`，D4 第 4 条对前者不生效 | §12 | D4、组 5 |
| 12 | 0 字节文件下载回 `code:500`，重建会判该库失败且重试不会好 | §9 | D8、D10、组 14 |
| 13 | 下载始终带 `Content-Length`，未观察到分块；spec「原件缺失与分块下载」的分块分支在实例上没有对应行为，与「记录里没有的不出现在夹具里」冲突 | §9 | D8、D17、spec、组 14 |
| 14 | `PUT` 实例不带 `model_info` 回 400，`api_key` 空串清空密钥，重复 `POST` 回 `500` | §11.4 | D7、组 8 |
| 15 | `GET` 实例明文回显密钥 | §11.1 | D4、组 5、组 8 |
| 16 | 删除被引用的模型无保护，`embd_id` 悬空 | §11.4 | D7、组 8 |
| 17 | 不传 `embedding_model` 时回落到账号缺省甚至空值 | §4.4 | D9、组 9 |
| 18 | 删除在用画布无保护，之后解析 `FAILED` | §14 | D9、组 9 |
| 19 | Compiler 依赖账号缺省嵌入模型，`llm_id` 建库时固化 | §5.5 | D7、D14、组 8 |
| 20 | `STOPPING` 在 D12 没有对应值 | 表 A | D12、组 11 |
| 21 | `tag` 不可建，Non-Goals 的「可以建 `tag` 模板的库」不成立 | §4.3 | design Non-Goals、Goals、组 15 |
| 22 | 空文件解析后 `COMPLETED`、0 切片，`chunkCount` 可为 0 | §7.1 | D12、组 11 |
| 23 | 同名上传改名为 `a(1).txt`，重新入库期间 RAGFlow 里的 `name` 与本地不同 | §7.1 | D13，影响小 |
