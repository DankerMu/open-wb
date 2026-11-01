# RAGFlow `v1.0.0-rc2` 接口实测记录（s2a-kb-ragflow 组 1）

> 实测日期：2026-11-01（文件名日期由 spec 钉死，不代表实测日期）。
> 对象：共用开发栈上运行中的 RAGFlow 实例，全程只用专用账号的 API key 鉴权，未用账号密码。
> 结论全部来自对运行实例的观察：绝大部分是 API 应答；§5.4、§8.4、§13 的部分结论来自容器日志（只读），§13 的账号事实来自元数据库只读查询。读源码只用来找接口；个别地方引用源码解释现象时写明「源码」。
> 同日评审后补测过一轮，§5、§8、§9、§11 的新增内容来自这一轮，经过见 §17。
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
| 3 | RAPTOR 与知识图谱 | 支持（经 pipeline，不是数据集字段） | 开启要建模板组与画布，画布 DSL 必须带 `graph`；解析时自动执行，无须显式触发；没有按类型的终态；对话模型失败时 RAPTOR 完全无信号 |
| 4 | 改嵌入模型 | 支持（`chunk_count` 非 0 也成功） | 与文档及 design Context 相反 |
| 5 | multipart 上传 | 支持 | 不支持的后缀回 `code:500` |
| 6 | 解析与文档列表 | 支持 | 状态字段是 `ingestion_status`，八种取值；`success_count:0` 与 `code:0` 同时出现 |
| 7 | 原件下载 | 支持；始终带 `Content-Length`，未观察到分块 | 与 D8 的推测相反；0 字节文件下载回 `code:500`；not-found 也是 HTTP 200，靠响应头区分（§9） |
| 8 | 不存在的 id | 支持区分，但组合因路由而异 | 三条路由要靠 message 前缀；`DELETE /datasets` 回 `code:403`；解析回 `code:0` |
| 9 | 模型下发 | **支持** | 删除有联动风险：见 §13，撤销缺省对话模型可使入库进程崩溃循环 |
| 10 | 错误组合 | 支持 | 鉴权失败是 HTTP 401 + `code:401`；权限错误的 `code:403` 只在一条路由上观察到，单账号未造出真实权限错误；未观察到 `109`、`108` |

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
 "token_num":0,"update_time":...},"message":null}
```

成功应答的 `message` 为 `null`（`GET /datasets` 列表没有这个键）。`parse_type` 不出现在任何读接口里。

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

内置 `config` 的形状（`...` 是长文本，只列字符数）：

```jsonc
// id:"tree"，kind:"tree"
{
  "kind": "tree",
  "llm_id": "<内置值>",
  "global_rules": "",
  "raptor": {
    "prompt": "...",            // 339 字符
    "claim_prompt": "...",      // 2361 字符
    "max_token": 512,
    "clustering_threshold": 0.3,
    "clustering_ratio": 0.5
  },
  "entity":   {"description": "", "fields": [{"type": "", "description": "", "rule": ""}]},
  "relation": {"description": "", "fields": [{"type": "", "description": "", "rule": ""}]}
}

// id:"knowledge_graph"，kind:"knowledge_graph"
{
  "kind": "knowledge_graph",
  "llm_id": "<内置值>",
  "global_rules": "",
  "rechunk_rules": "...",       // 503 字符
  "entity":   {"description": "...", "fields": [{"type": "person", "description": "...", "rule": "..."}]},  // 6 项
  "relation": {"description": "...", "fields": [{"type": "owns", "description": "...", "rule": "..."}]}     // 6 项
}
```

本次提交的 `config`：`tree` 去掉 `entity`、`relation`、`llm_id`；`knowledge_graph` 去掉 `llm_id`。两者都建组成功，并实际跑通编译。

其余六种的差异：`timeline`、`mind_map` 与 `knowledge_graph` 同形；`page_index` 的 `entity` 多 `output_fields`；`session_essence`、`session_graph` 的 `config.kind` 都是 `knowledge_graph`，多 `synthesis`（`session_essence` 没有 `global_rules`）；`wiki` 另有 `claim`、`concept`、`example`、`instruction`、`mode`。这六种只读过形状，没有建组。

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

同步改 chunker 的 `downstream`、下游的 `upstream`，并在 `graph.nodes` 加 `type:"compilationNode"` 的节点、在 `graph.edges` 把 chunker 原来的出边改接到 Compiler 节点（`source` 改为 Compiler），再加 chunker → Compiler 一条；原边不保留，净增一条。各模板的 chunker 节点名不同（`GeneralChunker:SixApplesFall`、`ManualChunker:NineInsectsFind`、`QAChunker:TidyCloudsThink` 等），要按 `component_name` 含 `Chunker` 查找。

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

应答比 §4.2 多 `pipeline_id`。同一画布可被两个数据集引用（建库成功；解析只在其中一个上跑过，见 §14）。

**(6) 手写的最小 DSL**

上面 (3) 是改内置 DSL。下面这份是从零手写的，五个节点，没有 Extractor，端到端实测通过：文档 `COMPLETED`、1 切片，任务日志 `Tree DONE`、`Graph DONE`，图谱 9 实体 9 关系，`navigation` 1 条。`GET /agents/<canvas_id>` 读回的 `dsl` 与提交值逐键相等。

```json
{
  "components": {
    "File": {
      "upstream": [], "downstream": ["Parser:Owb"],
      "obj": {"component_name": "File", "params": {}}
    },
    "Parser:Owb": {
      "upstream": ["File"], "downstream": ["GeneralChunker:Owb"],
      "obj": {"component_name": "Parser", "params": {
        "text&code": {"output_format": "json", "preprocess": ["main_content"], "suffix": ["txt"]},
        "enable_vision_enhancement": false,
        "vlm": {"llm_id": ""}
      }}
    },
    "GeneralChunker:Owb": {
      "upstream": ["Parser:Owb"], "downstream": ["Compiler:Owb"],
      "obj": {"component_name": "GeneralChunker", "params": {
        "children_delimiters": [], "chunk_token_size": 512, "delimiters": ["\n"],
        "image_context_size": 0, "overlapped_percent": 0, "table_context_size": 0,
        "outputs": {"chunks": {"type": "Array<Object>", "value": []}}
      }}
    },
    "Compiler:Owb": {
      "upstream": ["GeneralChunker:Owb"], "downstream": ["Tokenizer:Owb"],
      "obj": {"component_name": "Compiler", "params": {
        "compilation_template_group_id": "<group_id>",
        "llm_id": "",
        "plan": false,
        "outputs": {"chunks": {"type": "Array<Object>", "value": []}}
      }}
    },
    "Tokenizer:Owb": {
      "upstream": ["Compiler:Owb"], "downstream": [],
      "obj": {"component_name": "Tokenizer", "params": {
        "fields": "text", "filename_embd_weight": 0.1,
        "search_method": ["embedding", "full_text"], "outputs": {}
      }}
    }
  },
  "graph": {
    "nodes": [
      {"id": "File", "type": "beginNode",
       "data": {"label": "File", "name": "File", "form": {}},
       "position": {"x": 0, "y": 200}, "sourcePosition": "right", "targetPosition": "left"},
      {"id": "Parser:Owb", "type": "parserNode",
       "data": {"label": "Parser", "name": "Parser", "form": {}},
       "position": {"x": 300, "y": 200}, "sourcePosition": "right", "targetPosition": "left"},
      {"id": "GeneralChunker:Owb", "type": "chunkerNode",
       "data": {"label": "GeneralChunker", "name": "GeneralChunker", "form": {}},
       "position": {"x": 600, "y": 200}, "sourcePosition": "right", "targetPosition": "left"},
      {"id": "Compiler:Owb", "type": "compilationNode",
       "data": {"label": "Compiler", "name": "Compiler", "form": {
         "compilation_template_group_id": "<group_id>", "llm_id": "", "plan": false,
         "outputs": {"chunks": {"type": "Array<Object>", "value": []}}
       }},
       "position": {"x": 900, "y": 200}, "sourcePosition": "right", "targetPosition": "left"},
      {"id": "Tokenizer:Owb", "type": "tokenizerNode",
       "data": {"label": "Tokenizer", "name": "Tokenizer", "form": {
         "fields": "text", "filename_embd_weight": 0.1,
         "search_method": ["embedding", "full_text"], "outputs": {}
       }},
       "position": {"x": 1200, "y": 200}, "sourcePosition": "right", "targetPosition": "left"}
    ],
    "edges": [
      {"id": "e0", "source": "File", "sourceHandle": "start", "target": "Parser:Owb", "targetHandle": "end"},
      {"id": "e1", "source": "Parser:Owb", "sourceHandle": "start", "target": "GeneralChunker:Owb", "targetHandle": "end"},
      {"id": "e2", "source": "GeneralChunker:Owb", "sourceHandle": "start", "target": "Compiler:Owb", "targetHandle": "end"},
      {"id": "e3", "source": "Compiler:Owb", "sourceHandle": "start", "target": "Tokenizer:Owb", "targetHandle": "end"}
    ]
  }
}
```

- 键路径：Compiler 节点在 `components."Compiler:<节点名>"`，模板组 id 在其 `obj.params.compilation_template_group_id`；`graph.nodes[].data.form` 再放一份。
- 内置 DSL 的顶层另有 `globals`、`history`、`messages`、`path`、`retrieval`、`variables`，手写时全部省略，实测不影响。
- 内置 DSL 的节点另有 `measured`、`dragging`、`selected`，边的字段恰为 `id`、`source`、`sourceHandle`、`target`、`targetHandle`。手写时节点省略这三个键，实测不影响。
- 内置 DSL 的 `Parser` 的 `graph.nodes[].data.form` 不为空，手写时放 `{}`，实测不影响。
- Parser 的 `suffix` 决定这个库管哪些后缀（§7.4）。这份只声明了 `txt`，别的后缀不走它。

**`graph` 不能省。** 去掉 `graph` 键的同一份 DSL，建画布、建库都回 `code:0`，但 RAGFlow 把 `components` 改写成无 `obj` 的形状（`{"id","name","params","upstream","downstream"}`），数据集的 `parser_config["Parser:Owb"]` 变成 `{}`。之后 `.txt` 文档被判为不归该库管，静默换到 `general`（§7.4），`pipeline_id` 为空，`COMPLETED`、编译不运行，无任何提示。

**(7) 删除**

```
DELETE /api/v1/agents/<canvas_id>
→ HTTP 200 {"code":0,"data":true,"message":"success"}

DELETE /api/v1/compilation-template-groups/<group_id>
→ HTTP 200 {"code":0,"data":true,"message":"success"}
```

删除都没有引用保护：

| 情形 | 删除应答 | 之后 |
|---|---|---|
| 模板组被画布引用（无数据集） | `code:0`，组已删（`GET` 回 `404`） | 画布里的 `compilation_template_group_id` 不变；用该画布建库仍回 `code:0`；上传回 `code:0`，解析回 `success_count:1`，然后 `FAILED`，0 切片 |
| 模板组被画布与数据集引用（`knowledge_graph`、`tree` 各测一次） | `code:0` | 同上。消息为 `... component "Compiler_0" invoke: Compiler: compilation_template_group "<group_id>" not found for tenant "<tenant_id>"`，任务日志无记录 |
| 画布被数据集引用 | `code:0`（`GET` 画布回 `103`） | 数据集读回的 `pipeline_id` 不变；上传回 `code:0`，解析回 `success_count:1`，然后 `FAILED`，`Task failed: load canvas <canvas_id>: agent: not found or access denied` |
| 重复删除 | 画布 `103`，模板组 `404` | 见表 B |

所以删除顺序必须是数据集 → 画布 → 模板组，RAGFlow 不替调用方拦。

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

`?kind=` 实测了 `tree`、`graph`、`raptor`、`knowledge_graph`、`knowledgegraph`、`mindmap`、`wiki`，都回 `code:0`；`kind` 字段回显小写后的请求值，别名不归一（`Raptor` 回 `raptor`、`TREE` 回 `tree`）。未知值回 `102`，`unsupported compilation kind`。

**按类型读取没有终态**：批次跑完后，无 `kind` 的请求是 `completed`，而 `?kind=tree` 与 `?kind=graph` 都回 `idle`，`state` 与「从未编译」相同。差别只有多出的 `last_completed_at` 和真实的 `updated_at`，而这两个值不分类型：只开 `tree` 与 `knowledge_graph` 的库，`?kind=wiki`、`?kind=mindmap` 回的是同一个 `last_completed_at`。所以它只说明这个库跑过编译，不说明某一类型跑完了。批次进行中，只有涉及该类型时才是 `running`（只开 RAPTOR 的库，`kind=graph` 全程 `idle`）。无 `kind` 的 `state` 在多文档时随批次往返（`running` → `completed` → `running`），文档还在排队时也可能是 `completed`。

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

`Graph` 一条的 `document_name` 为 `Graph`，`dsl.entries[].variants` 为 `["structure","tree"]`，其中也含 `tree`，所以类型只能按 `task_type` 判定。`task_type` 观察到 `Tree`、`Graph`；`operation_status` 观察到 `RUNNING`、`DONE`。一份文档一个批次一条，开两种时每批次两条。

产物可读：`GET /datasets/<id>/artifacts/structure?kind=graph`（`total_entities`、`total_relations`）、`GET /datasets/<id>/navigation`（RAPTOR 的 `items`）、`GET /datasets/<id>/documents/<id>/structure/graph`（`templates[].kind` 为 `tree` / `knowledge_graph`）。`artifacts/structure?kind=tree` 回 `101`，`invalid structure kind: "tree"`。

### 5.4 编译失败时的信号

| 场景 | 文档 | 编译状态 | 任务日志 |
|---|---|---|---|
| `tree`，对话模型密钥无效 | **`COMPLETED`**，1 个切片 | **`idle`，无 error** | **无** |
| `tree`，对话模型的实例已删除 | **`COMPLETED`**，1 个切片；容器日志 `tree: claim extraction skipped for batch` | **`idle`，无 error** | **无** |
| `knowledge_graph`，对话模型密钥无效 | `FAILED`，0 切片，停在 Compiler 节点 | `idle` | 无 |
| `knowledge_graph`，对话模型已删除 | `FAILED`，`Compiler: model configuration unavailable: ...` | 不可靠（当时有 §13 的积压） | 无新增 |
| `tree`，账号缺省嵌入模型已清空 | `FAILED`，`knowledge_compiler: embedding_model is required and no tenant default embedding model is set` | 不可靠（同上） | 无新增 |
| `tree`、`knowledge_graph`，模板组已删除 | `FAILED`，0 切片，停在 Compiler 节点（§5.1 (7)） | `idle` | 无 |

所以 D14 的 `failed` 没有统一来源：图谱失败表现为文档 `FAILED`，整份文档 0 切片；RAPTOR 在对话模型失败（密钥无效、实例已删除）时完全无信号，文档照常 `COMPLETED`，只能从「任务日志没有该类型的记录、产物为空」推断；缺省嵌入模型缺失、模板组被删时文档 `FAILED`，有信号。

失败消息含上游原文，可能带上游 request id，不得进入本系统的响应、审计或日志（与 D4 一致）。

### 5.5 Compiler 用哪个模型

- `llm_id` 留空的 Compiler 节点，建数据集时 `parser_config` 里被填成**账号当时的缺省对话模型**（实测 `Compiler:*.llm_id` 读回为三段式）。之后清空账号缺省对话模型，文档阶段的编译仍用这个固化值，照常产出。
- 所以清空账号缺省对话模型不影响已建数据集的文档阶段编译；要删除模型本身，编译才失效（§5.4）。
- 数据集级合并另用账号缺省对话模型，没有缺省时入库进程退出（§13）。
- 文档阶段的 Compiler 依赖账号缺省嵌入模型，不是数据集的 `embedding_model`（§5.4「账号缺省嵌入模型已清空」一行）。

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
 "parser_id":"general","size":16,"source_type":"local","suffix":"txt","token_count":0,"type":"doc"}],"message":null}
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
| `UNSTART`、`FAILED`、`STOPPED` | 1 |
| `RUNNING` | 0 |
| `COMPLETED` | 0，不会重解析 |
| 不存在 / 属于别的数据集 / 非 hex id | 0 |

`STOPPED` 之后重新解析：从 `RUNNING` 停下的文档回 `success_count:1`，实测跑到 `COMPLETED`，切片数与未中断时相同。混合一份真实一份不存在：`success_count:1`。`document_ids` 为空或缺失：`102`，`` `document_ids` is required ``。

调用方必须检查 `success_count`，不能只看 `code`。

### 8.2 停止解析

```
POST /api/v1/datasets/<dataset_id>/documents/stop
{"document_ids":["<document_id>"]}
→ {"code":0,"data":{"success_count":1},"message":"success"}
```

| 文档状态 | 应答 |
|---|---|
| `RUNNING`、`SCHEDULED`、`STOPPED` | `code:0`，`success_count:1` |
| `UNSTART`、`COMPLETED` | `code:0`，`{"errors":["Can't stop parsing document that has not started or already completed"],"success_count":0}` |
| 不存在 | `code:100`，`Documents not found: ['<document_id>']` |

从 `RUNNING` 停下要经过 `STOPPING`，终态 `progress:-1`。从 `SCHEDULED` 停下立刻到 `STOPPED`（下一次轮询，约 0.01 秒），`progress:0`，不经过 `STOPPING`。

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
- `progress` 取值：成功 `1`；`STOPPED` 从 `RUNNING` 停下为 `-1`，从 `SCHEDULED` 停下为 `0`；`FAILED` 停在失败时的进度（`0.2`、`0.5`）。

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
| `STOPPED` | 停止完成 | `progress:-1` 或 `0`（§8.2），`Task stopped by user.` |
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
| `CREATED` | `code:0`，`deleted:1`，4 轮 4 次相同 | 已删，读回 `102` |
| **`RUNNING`、`STOPPING`** | **`code:0`，`deleted:0`** | **行仍在** |

运行结束后再删回 `deleted:1`。调用方必须检查 `deleted`，`code:0` 不代表删成了。

`CREATED` 是瞬时状态，上表的做法是：一次触发 40 份文档，用 `ingestion_status=CREATED` 紧密轮询，读到后立刻发 `DELETE`，两步之间约几十毫秒。有竞态：不能排除文档在 `DELETE` 到达前已进入 `SCHEDULED`，而后者的应答相同，所以这条的强度低于其它行。

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
| `.json`，内容恰为 not-found 正文，43 字节 | 200 | 43 | 43 | 无 | `application/octet-stream` |
| `.txt`，内容同上 | 200 | 43 | 43 | 无 | 同上 |
| `.html`，54 字节 | 200 | 54 | 54 | 无 | 同上 |
| `.pdf`，1998 字节 | 200 | 1998 | 1998 | 无 | 同上 |
| `.md`，4 字节 | 200 | 4 | 4 | 无 | 同上 |
| `.csv`，8 字节 | 200 | 8 | 8 | 无 | 同上 |
| `.png`，19 358 字节 | 200 | 19 358 | 19 358 | 无 | 同上 |
| **0 字节** | **200** | 52 | 52 | 无 | `application/json; charset=utf-8` |

除 0 字节文件外，字节数与 SHA-256 都和上传时一致；0 字节文件回的 52 字节是错误应答，不是文件内容。`Content-Type` 不随文件类型变，始终是 `application/octet-stream`。

**始终带 `Content-Length`，未观察到分块传输**，D8 的「大于 2 KiB 很可能走分块」在实例上不成立。

**0 字节文件的下载是错误应答**：`HTTP 200`，`{"code":500,"message":"Failed to download document"}`。

### 9.1 区分 not-found 与文件字节

not-found 也是 HTTP 200，所以状态码分不开。完整应答：

```
GET /api/v1/datasets/<dataset_id>/documents/<不存在或已删除的 document_id>
HTTP 200
Content-Length: 43
Content-Type: application/json; charset=utf-8
Date: ...
X-Api-Source: go

{"code":404,"message":"Resource not found"}
```

```
GET /api/v1/datasets/<不存在的 dataset_id>/documents/<document_id>
HTTP 200
Content-Length: 55
Content-Type: application/json; charset=utf-8
Date: ...
X-Api-Source: go

{"code":404,"data":null,"message":"Resource not found"}
```

两者正文不同：文档不存在时没有 `data` 键。

内容恰为上面第一个正文的文件，下载应答：

```
GET /api/v1/datasets/<dataset_id>/documents/<document_id>
HTTP 200
Content-Disposition: attachment; filename="nf.json"
Content-Length: 43
Content-Type: application/octet-stream
Date: ...
X-Api-Source: go

{"code":404,"message":"Resource not found"}
```

状态码、`Content-Length`、正文、SHA-256 都与 not-found 相同，只有两个响应头不同：

| 应答 | HTTP | `Content-Disposition` | `Content-Type` |
|---|---|---|---|
| 成功（7 种文件，含内容相同的 `.json`、`.txt`） | 200 | `attachment; filename="..."` | `application/octet-stream` |
| 文档不存在、已删除 | 200 | 无 | `application/json; charset=utf-8` |
| 数据集不存在 | 200 | 无 | 同上 |
| 0 字节文件 | 200 | 无 | 同上 |
| 无 `Authorization`、错误密钥 | 401 | 无 | 同上 |

**可靠判据**：HTTP 200 且带 `Content-Disposition` 才是文件字节，正文一律不解析；不带时才按 JSON 解析 body `code`，`404` 为 not-found。上表 13 个应答里，`Content-Disposition` 与 `Content-Type` 两个信号完全同向，没有例外。源码也一致：handler 只在成功分支设 `Content-Disposition`，`Content-Type` 在服务层写死。

不能用的判据：解析正文看 `code`（文件可以恰好是这段 JSON）、看 `Content-Length`、看文件后缀。这个判据只在直连实例上验证过。

### 9.2 其它

- `Content-Disposition: attachment; filename="a.txt"`；非 ASCII 名是未编码的原始 UTF-8 字节，文件名里的 `"` 不转义。本系统不应解析它。
- `Range: bytes=0-99` 被忽略，回 200 与全量。
- `HEAD` 回 HTTP 404 与 JSON 体。

结论：**支持**。

## 10. 不存在的 id

完整组合见表 B。要点：全部是 HTTP 200，靠 body 判定；数据集不存在与「曾存在、已删除」的应答完全相同。

数据集 id 不存在：

- 大部分路由回 `code:404`，能与参数非法区分。
- `POST /datasets/<id>/documents`：`102` + 固定前缀，与其它 `102` 只能靠 message 区分。
- `DELETE /api/v1/datasets`：`code:403`，非 hex 的 id 是 `101`。这里的 `403` 不是权限错误，不能反过来把 `403` 当成「不存在」，见 §12。

文档 id 不存在（数据集存在）：

- `GET .../documents/<id>`：`code:404`，响应头见 §9.1。
- `DELETE .../documents`：`102` + 固定前缀，只能靠 message 区分。
- `GET .../documents?id=<id>`：`102` + 固定前缀，只能靠 message 区分。
- `POST .../documents/parse`：`code:0`，`success_count:0`，与「已在运行」「已完成」不可区分。
- `POST .../documents/stop`：`code:100`。

只能靠 message 前缀的路由共三条，就是上面的 `102`，与表 B 一致。

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

读回，时点是上面三步与 §11.2 的两个缺省全部完成之后：

```
GET /api/v1/providers
{"code":0,"data":[{"base_url":null,"has_instance":true,"name":"OpenAI-API-Compatible","total_models":0}],"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible
{"code":0,"data":{"base_url":null,"name":"OpenAI-API-Compatible","total_models":0},"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible/instances
{"code":0,"data":[{"id":"<instance_id>","instance_name":"owb-embed","provider_id":"<provider_id>","region":"","status":"active"}],"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible/instances/owb-embed
{"code":0,"data":{"api_key":"<api_key>","base_url":"<UPSTREAM_BASE_URL>","id":"<instance_id>",
 "instance_name":"owb-embed","provider_id":"<provider_id>","region":"","status":"active"},"message":"success"}

GET /api/v1/providers/OpenAI-API-Compatible/instances/owb-embed/models
{"code":0,"data":[{"extra":{"max_tokens":8192},"features":[],"max_tokens":8192,"model_type":["embedding"],
 "name":"bge-m3","status":"active","verify":"unknown"},
 {"extra":{"max_tokens":8192},"features":[],"max_tokens":8192,"model_type":["chat"],
 "name":"deepseek-v4.1-flash","status":"active","verify":"unknown"}],"message":"success"}

GET /api/v1/models
{"code":0,"data":[{"instance_id":"<instance_id>","instance_name":"owb-embed","model_id":"<model_id>",
 "model_type":["embedding"],"name":"bge-m3","provider_id":"<provider_id>",
 "provider_name":"OpenAI-API-Compatible","rank":500,"tenant_id":"<tenant_id>","tenant_name":"<tenant_name>"},
 {...,"model_type":["chat"],"name":"deepseek-v4.1-flash",...}],"message":"success"}
```

`has_instance` 在有实例时是 `true`，实例全删后是 `false`。`total_models` 有模型时仍是 `0`，不能用它判断是否已下发。

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

结论：**支持**。API key 能配 provider instance、配账号缺省模型、以 `embedding_model` 引用、删除已下发配置。撤销语义要改 design 的 D7 与 D14，见 §13；删除无保护见上表。

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
| 权限不足：`GET /tenants/<随机>/users`（仅此一条路由） | 200 | **403** | `Permission denied` |
| 未知路由、未注册的方法 | 404 | 404 | `Not Found: /api/v1/nope` |
| `HEAD` 文档 | 404 | — | JSON 体 |
| 模型提供方路由的绑定错误（部分） | 400 | 400 | Go 校验器原文 |
| 不支持的文件类型、重复实例、0 字节下载 | 200 | 500 | 见 §7、§9、§11 |
| 操作异常 | 200 | 100 | `Documents not found: [...]`、`model missing isn't available` |
| 智能体不存在或无权 | 200 | 103 | `Make sure you have permission to access the agent.` |
| 未实现 | 200 | 501 | `IsAdmin not implemented` |

**`109` 与 `108` 未观察到**：鉴权失败是 HTTP 401 + `code:401`。

**`code:403` 的结论是受限的**：单账号未造出真实权限错误，作为权限错误只在 `GET /tenants/<随机>/users` 这一条路由上观察到；`DELETE /datasets` 的 `403` 是「不存在」（§10）。所以「权限不足是 HTTP 200 + `code:403`」不是全局结论，别的路由上真实权限错误的形状未知。

D4 的第 4 条按 HTTP 401 / 403 或 body `108` / `109` 判定，HTTP 200 + `code:403` 不命中，会落入第 5 条，且不写 `kb_upstream_auth_failed`。

结论：**支持**；真实跨账号访问未测成（§14）。

## 表 A：运行状态到本系统 `status` 的映射

| `ingestion_status` | `status`（D12） | web 刷新 | 备注 |
|---|---|---|---|
| `UNSTART` | `unparsed` | 否 | |
| `CREATED` | `queued` | 是 | 瞬时 |
| `SCHEDULED` | `queued` | 是 | |
| `RUNNING` | `parsing` | 是 | |
| `STOPPING` | `parsing` | 是 | D12 没有对应值；此时删除文档回 `deleted:0` |
| `STOPPED` | `cancelled` | 否 | `progress:-1` 或 `0` |
| `COMPLETED` | `done` | 否 | `chunk_count` 取列表字段；可能为 0 |
| `FAILED` | `failed` | 否 | |
| 列表里没有该 id | `missing` | 否 | 本系统判定 |

`FAILED`、`STOPPED` 可重新触发解析；`COMPLETED` 不可（`success_count:0`）。

## 表 B：「不存在」组合

全部实测，HTTP 状态除特别注明外都是 200。「不存在」指 32 位随机 hex、带连字符的随机 UUID、曾存在已删除三种，应答相同。

### 数据集 id

| 路由 | 不存在 | 非 hex 串 / 全零 / 40 字符 | 与参数非法区分 |
|---|---|---|---|
| `GET /datasets/<id>` | `404` `Resource not found` | 同左 | 能 |
| `PUT /datasets/<id>` | `404` | `101` `Invalid UUID format` | 能 |
| `DELETE /datasets` `{"ids":[<id>]}` | **`403` `Permission denied`** | `101` `Invalid UUID format` | 能，但 `403` 不唯一指向「不存在」（§12） |
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
| `GET /compilation-template-groups/<id>` | `404` `Cannot find compilation template group <id>.` |
| `DELETE /compilation-template-groups/<id>` | `404` `Cannot find compilation template group <id>.` |
| 提供方、实例、模型 | §11.4 |

## 表 C：RAPTOR / 知识图谱的模板支持

每种模板：`GET /pipelines/<parser_id>` 取 DSL → 插 Compiler（同一模板组开两种）→ 建画布 → `parse_type:2` 建库 → 上传该模板支持的小文件 → 解析 → 看任务日志与产物。「可用」指任务日志同时有 `Tree DONE` 与 `Graph DONE`，且 `Compiler` 事件报出实体数。`picture` 首轮的任务日志只在运行中读过，补测重跑后确认：文档 `COMPLETED`、1 切片，任务日志 `Tree DONE`、`Graph DONE`，`navigation` 有 RAPTOR 产物 1 条，`artifacts/structure?kind=graph` 为 6 实体 3 关系。

| 模板 | `parser_id` | 建库 | 实测文件 | 实体 / 关系 | RAPTOR：D9 → 实测 | 图谱：D9 → 实测 | 模板管的后缀 |
|---|---|---|---|---|---|---|---|
| naive | `general`（`naive` 为别名） | 可 | `.txt` | 9 / 9 | 不可用 → 可用，**不符** | 可用 → 可用，一致 | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、csv、txt、py、js、java、c、cpp、h、php、go、ts、sh、cs、kt、sql |
| book | `book` | 可 | `.txt` | 9 / 10 | 可用 → 可用，一致 | 一致 | doc、docx、htm、html、pdf、txt |
| email | `email` | 可 | `.eml` | 9 / 9 | 不可用 → 可用，**不符** | 一致 | eml |
| laws | `laws` | 可 | `.txt` | 9 / 11 | 一致 | 一致 | doc、docx、htm、html、md、markdown、mdx、pdf、txt |
| manual | `manual` | 可 | `.pdf` | 10 / 11 | 一致 | 一致 | doc、docx、pdf（`.txt`、`.md` 退到 general，编译不运行） |
| one | `one` | 可 | `.txt` | 9 / 9 | 不可用 → 可用，**不符** | 一致 | doc、docx、htm、html、md、markdown、mdx、pdf、xls、xlsx、txt |
| paper | `paper` | 可 | `.pdf` | 10 / 10 | 一致 | 一致 | pdf |
| picture | `picture` | 可 | `.png` | 5 / 3；重跑 6 / 3 | 不可用 → 可用，**不符** | 一致 | bmp、gif、jpeg、jpg、png、svg、tif、tiff、webp；3gp、3gpp、avi、flv、mkv、mov、mp4、mpeg、mpg、webm、wmv |
| presentation | `presentation` | 可 | `.pdf` | 10 / 10 | 一致 | 一致 | pdf、pptx、ppt |
| qa | `qa` | 可 | `.txt`、`.csv` | 6 / 4 | 一致 | 一致 | docx、md、markdown、mdx、pdf、xls、xlsx、csv、txt（`.md` 按示例格式写的未切出切片，0 切片，编译未运行） |
| table | `table` | 可 | `.csv` | 2 / 0 | 不可用 → 可用，**不符** | 一致 | xls、xlsx、csv、txt |
| **tag** | **不接受** | **`102`** | — | — | 不可用 → 不可用，一致 | 不可用 → 不可用，一致；**但 D9 与 Goals 把它列为可建模板：不符** | — |
| audio（D9 无） | `audio` | 可 | `.wav` | — | D9 无 → **未测成** | D9 无 → **未测成** | aac、aiff、ape、au、da、flac、midi、mp3、ogg、oggvorbis、realaudio、vqf、wav、wave、wma |

- D9 的「RAPTOR 只对六种可用」来自 demo，rc2 没有这个限制：除 `tag`、`audio` 外十一种都实际跑通。
- `audio`：解析在 Parser 节点 `FAILED`，`no default speech2text model is set`；账号没配语音模型，编译节点没有轮到。
- 内置模板的 Extractor 节点：`qa`、`table` 没有，其余都有。
- 后缀取自 `GET /pipelines/<parser_id>` 的 Parser 节点，不是逐个上传验证的。

## 13. 共用栈事故：清空缺省对话模型使入库进程崩溃循环

**实测中发生，由本次操作引起，已恢复。**

- 时间：2026-11-01 16:19:27 至 16:25:57（UTC+8），容器日志记录 **8 次** `ingestor exited with code 1. Restarting in 1 second...`，间隔约 25 秒与 95 秒交替。
- 日志原文：`fatal ingestor_server knowledge_compile: dataset-level LLM deduper unavailable, refusing to continue with a no-op merge`，`factory_err` 为 `knowledge_compiler: llm_id is empty and no tenant default chat model available: no default chat model is set`。
- 触发步骤：① 用模型下发一节的方法把账号缺省对话模型清空；② 在两个 pipeline 数据集（`llm_id` 已固化，§5.5）上解析文档。文档照常 `COMPLETED`，随后数据集级合并任务被 worker 取走，因为账号没有缺省对话模型而 `fatal` 退出；进程重启后同一任务又被取走（租约过期是按间隔推断的），循环。
- 影响面：入库进程全栈只有一个，按进程结构判断，**崩溃循环期间共用栈上所有账号的入库都会受影响**，不限于本账号。容器没有重启，事后 `healthz` 全 `ok`。本次未波及其它使用者：事后查元数据库，这套栈上只有部署时的超级管理员与本专用账号两个账号，当天才部署，没有其它使用者。
- 处置：只经 API 恢复本账号的缺省对话与嵌入模型（16:26 前后），两个批次约两分钟内完成；此后日志再无 `fatal`。未执行任何 `docker` 写操作。
- 收尾：删除全部数据集并观察 170 秒无编译活动后，才清空缺省与删除模型配置，再观察 200 秒无 `fatal`、无重启，`healthz` 全 `ok`。
- 编译任务积压时，`compilation/status` 卡在 `running`、`current_phase:"deleting"`，无 `error` 键，任务日志 `RUNNING`，外部看不出异常。

对 design 的影响：D7 的「`chatModelId` 改为 `null` 时撤销对话模型的下发」、D14 的「此后的编译会在 RAGFlow 侧失败并显示 `failed`」都不成立。按现有写法清空缺省，已开编译的库下一次入库就会让共用入库进程崩溃循环。**组 8 开工前必须修订撤销语义。**

## 14. 未测成与未观察到

| 项 | 状态 | 原因 |
|---|---|---|
| 真实跨账号访问（别的账号的数据集） | 未测成 | 只有一个账号，按要求不用账号密码，不注册第二个账号 |
| `code:108`、`code:109` | 未观察到 | 同上；单账号下造不出 |
| 编译状态 `pending` 与 `error` 键 | 未观察到 | 4 份文档连续解析、0.15 秒轮询未抓到；源码有定义，但不能算实测 |
| 对话模型失败时 RAPTOR 的显式信号 | 未观察到 | 见 §5.4，可能根本不存在；缺省嵌入模型缺失、模板组被删时有 `FAILED` |
| 分块传输的下载应答 | 未观察到 | 16 字节到 105 MiB 都带 `Content-Length` |
| `audio` 模板的编译 | 未测成 | 账号未配 speech2text 模型 |
| 上传体积上限 | 未测成 | 105 MiB 成功，未再往上试 |
| 共用画布被两个库同时解析 | 未测成 | 只验证了两个库都能建成 |
| `operation_status` 的失败值 | 未观察到 | 只观察到 `RUNNING`、`DONE`；§13 的崩溃循环里任务日志停在 `RUNNING`，未再重现 |
| `code:105` | 未观察到 | design Context 列出，实测没有碰到 |
| `?kind=` 的其余别名 | 未测 | 已测的见 §5.3；源码另列 `artifact`、`mind_map`、`timeline`、`pageindex`、`page_index`、`skill` |
| `DELETE /datasets` 的批量上限 | 未测 | 实测 10 个一批成功，未再往上试 |

## 15. 与 design Context 的逐条复核

| Context 所述 | 实测 |
|---|---|
| 服务端 Go 重写；NATS、Kvrocks | 一致：应答头 `X-API-Source: go`，`/language` 回 `go` |
| 版本与健康接口无鉴权 | 一致 |
| 其余接口 `Authorization: Bearer` | **不符**：`GET /api/v1/pipelines/<parser_id>` 无须鉴权（§5.1）；其余带鉴权的接口一致，裸密钥与小写 `bearer` 也被接受 |
| `code`：`0`、`101`、`102`、`103`、`105`、`108`、`109` | `0`、`101`、`102`、`103` 观察到；`105`、`108`、`109` 未观察到；另有 `100`、`400`、`401`、`403`、`404`、`409`、`500`、`501` |
| HTTP 200 加非零 `code` 是常态 | 一致 |
| 重名自动加后缀、不区分大小写、≤128 | 一致 |
| `embedding_model` 形如 `model@factory` | **不符**：三段式；两段式只在实例名为 `default` 时可用 |
| `chunk_method` 十二种 vs `parser_id` | **`parser_id`，且必须带 `parse_type`**；取值见 §4.3 |
| `PUT` 改 `embedding_model` 要求 `chunk_count` 为 0 | **不符** |
| 上传、下载、列表、删除、解析、停止 | 路径一致 |
| 编译状态接口 | 路径一致；形状见 §5.3 |
| 模型提供方路由；`GET` / `PATCH /me/models` | 提供方路由一致。**`/me/models` 不符**：`GET /api/v1/me/models` 回 HTTP 404，实际路径是 `/api/v1/users/me/models`；其 `PATCH` 不校验租户归属，不可用，缺省模型走 `/api/v1/models/default`（§11.2） |

## 16. 清理结果

- 只删除本账号上本次建的对象。开始时账号全空，清理前核对过列表，名称全部以 `owb-` 开头（不区分大小写；其中 `OWB-DUP(2)` 是为测大小写建的，§17 列为偏离）。
- 首轮：数据集 54 个、画布 24 个、模板组 7 个，全部删除。
- 补测轮：开始时账号同样全空。数据集 15 个，全部删除；画布 8 个、模板组 6 个，部分在测删除时已删，其余 6 个画布、2 个模板组在清理时删除。结束时 `total_datasets` 为 0，画布 0，模板组 0。
- 补测轮的顺序：账号缺省保持不动，先删数据集、画布、模板组；静默 180 秒，无 `fatal`、无 `ingestor exited`、无编译活动；才清空缺省、删实例与提供方；再观察 210 秒，同样无 `fatal`、无 `ingestor exited`，`healthz` 全 `ok`。
- 模型配置：账号缺省已清空（`llm_id`、`embd_id` 为空），实例 `default`、`owb-bad`、`owb-alt`、`owb-embed` 已删除（`owb-embed` 在补测轮重建过一次，已再次删除），提供方已删除；`GET /providers`、`GET /models`、`GET /models/default` 都为空。「能删除」的证据见 §11.4。
- 未触碰任何非本账号的对象，未执行任何 `docker` 写操作。
- 原始应答只保存在会话 scratchpad，不入库。

## 17. 偏离

- 为测大小写建了 `OWB-DUP`，RAGFlow 存为 `OWB-DUP(2)`，大写前缀不符合「一律 `owb-` 前缀」的字面要求，已随清理删除。
- 除数据集外另建了 `owb-` 前缀的画布、模板组与模型实例（实例含一个名为 `default` 的，用来测两段式），已全部删除。
- §13 的事故。
- 补测中途，2026-11-01 21:14:48（UTC+8）容器引擎收到外部的重启请求，**不是本次探测引起**。引擎日志记录的是一次显式的重启请求，虚拟机正常关机再启动，控制台日志无 OOM 或 panic；同机所有容器都重启了，包括与 RAGFlow 无关的容器；发起者未查明。RAGFlow 约 1.5 分钟后恢复。一个探测脚本因此中断，重跑后完成。本次未执行任何 `docker` 写操作。
- 上一条的附带观察：数据、账号缺省模型都保留；重启前已触发、未完成的文档在恢复后都跑到 `COMPLETED`，无须重新触发（只观察过这一次）。

## 18. 结论的后果（tasks 1.4）

| 分流条件 | 是否触发 | 依据 |
|---|---|---|
| 「模型下发」不支持 | **未触发** | §11：API key 能配 instance、配缺省、以 `embedding_model` 引用、删除。D7 应急预案不启动 |
| 「编译开启或触发」不支持 | **未触发** | §5：API key 能建模板组、画布与 pipeline 数据集，解析时自动编译，十一种模板实际产出。D14 的停止条件不成立 |
| 模板支持表与 D9 不符 | **触发** | 表 C：`tag` 不可建；`audio` 为 D9 之外的模板；RAPTOR 在 D9 标为不可用的五种模板上都可用 |

按 tasks 1.4：本 PR 照常合入。合入前建修订 issue R，标题「修订 s2a-kb-ragflow：模板支持表」，R 为修订 issue，闸门加在 #1836、#1840、#1841、#1846 上。

**owner 决定（2026-11-01）**：修订 R 覆盖全部 23 条事实（下表 #1–#23）；RAPTOR 按实测对 11 种模板放开，删 `tag`，不加 `audio`；编译开关留在 S2a。

下列事实不构成 1.4 的分流条件，但实现按现有 design 写会出错。owner 已定 R 覆盖全部，组 5–17 除 #1837（组 7 剩余）外都等 R。

#24、#25 是评审后补测新增的，不在 owner 决定时的 23 条之内，也应进入 R。

| # | 事实 | 章节 | 涉及 |
|---|---|---|---|
| 1 | 清空缺省对话模型可使共用入库进程崩溃循环 | §13 | D7、D14、ragflow-backend「知识库模型设置」、组 8、组 14 |
| 2 | 「开关」不是数据集字段：要模板组、画布与 pipeline 数据集；模板组与画布的生命周期未设计 | §5.1 | D2、D6、D8、D9、D14、组 5 夹具、组 7、组 9、组 14、knowledge-bases「迁移 050」 |
| 3 | `embedding_model` 三段式；建库必须带 `parse_type` | §4 | D8、D9、组 9、组 14 |
| 4 | 编译状态没有按类型的终态，`done` 要读任务日志 | §5.3 | D14、D9、组 9、组 15 |
| 5 | 对话模型失败时 RAPTOR 无信号，`failed` 没有统一来源 | §5.4 | D14、组 9、组 15 |
| 6 | 文档后缀不归模板管时静默换解析器，编译不运行 | §7.4 | D9、D10、D11、D14、组 10、组 12 |
| 7 | 不支持的后缀回 `code:500`，按 D4 映射为 `kb_unavailable`，会中止工作空间入库的整批 | §7.1 | D4、D10、D11、组 10、组 12 |
| 8 | `RUNNING`、`STOPPING` 时删文档回 `code:0`、`deleted:0`，按现有流程本地行被删、RAGFlow 留孤儿 | §8.5 | D13、D10、组 13、组 5 夹具 |
| 9 | `success_count:0` 与 `code:0` 同时出现，「解析触发失败」不会被 D4 识别 | §8.1 | D4、D8、D10、D11、D13、组 10、组 12、组 13、组 14 |
| 10 | 不存在组合依路由而异，三条要 message 前缀；`DELETE /datasets` 为 `code:403` | 表 B | D4、D10、D11、spec「RAGFlow 出站请求」、组 5、组 9、组 10、组 12、组 13、组 14 |
| 11 | 鉴权错误是 HTTP 401 + `code:401`。权限错误的 `code:403` 只在一条路由上观察到，单账号未造出真实权限错误；D4 第 4 条对 HTTP 200 + `code:403` 不生效。spec「结果映射」的 Scenario 要假 RAGFlow 回 HTTP 200 `code:109`，而实例未观察到 `109`，与「记录里没有的不出现在夹具里」（`ragflow-backend/spec.md:25`）冲突 | §12 | D4（`design.md:151`）、spec「结果映射」第 4 条（`ragflow-backend/spec.md:85`）与 Scenario（`:90-92`）、组 5 |
| 12 | 0 字节文件下载回 `code:500`，重建会判该库失败且重试不会好 | §9 | D8、D10、D11、组 12、组 14 |
| 13 | 下载始终带 `Content-Length`，未观察到分块；spec「原件缺失与分块下载」的分块分支在实例上没有对应行为，与「记录里没有的不出现在夹具里」冲突 | §9 | D8、D17、spec、组 14 |
| 14 | `PUT` 实例不带 `model_info` 回 400，`api_key` 空串清空密钥，重复 `POST` 回 `500` | §11.4 | D7、组 8 |
| 15 | `GET` 实例明文回显密钥 | §11.1 | D4、组 5、组 8 |
| 16 | 删除被引用的模型无保护，`embd_id` 悬空 | §11.4 | D7、组 8 |
| 17 | 不传 `embedding_model` 时回落到账号缺省甚至空值 | §4.4 | D9、组 9 |
| 18 | 删除在用的画布、被引用的模板组都无保护，之后解析 `FAILED` | §5.1 (7) | D9、组 9 |
| 19 | Compiler 依赖账号缺省嵌入模型，`llm_id` 建库时固化 | §5.5 | D7、D14、组 8 |
| 20 | `STOPPING` 在 D12 没有对应值 | 表 A | D12、组 11 |
| 21 | `tag` 不可建，Non-Goals 的「可以建 `tag` 模板的库」不成立 | §4.3 | design Non-Goals、Goals、组 7、组 9、组 15、kb 开关表与新建对话框 |
| 22 | 空文件解析后 `COMPLETED`、0 切片，`chunkCount` 可为 0 | §7.1 | D12、组 11 |
| 23 | 同名上传改名为 `a(1).txt`，重新入库期间 RAGFlow 里的 `name` 与本地不同 | §7.1 | D13，影响小 |
| 24 | not-found 下载也是 HTTP 200，文件内容可与 not-found 正文逐字节相同；只能靠响应头 `Content-Disposition`、`Content-Type` 区分，不能解析正文判 `code` | §9.1 | D4、D8、组 5、组 14 |
| 25 | 画布 DSL 省掉 `graph` 时建画布、建库都成功，但编译静默不运行 | §5.1 (6) | D9、D14、组 5 夹具、组 9 |
