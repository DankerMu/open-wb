## MODIFIED Requirements

### Requirement: 单轮检索
`kb` 模块 SHALL 只有一处检索实现（「单轮检索」，ADR-0017）：对一个知识库的当前 `dataset_id` 发一次 `POST /api/v1/retrieval`。检索测试端点与会话检索 `kb_search`（「会话检索 `kb_search`」）都只经它检索。`kb` 模块 SHALL NOT 含改写问句、判定证据是否充分或发起第二轮检索的逻辑。

请求 body 恰为 `{question, dataset_ids, similarity_threshold, vector_similarity_weight, page, page_size}`，配置了重排模型时另带 `rerank_id`：
- `dataset_ids` 恰含该库的 `dataset_id`（不是 `rebuild_dataset_id`）。
- `similarity_threshold`、`vector_similarity_weight` SHALL 恒显式传该库的检索参数：RAGFlow 数据集上的同名字段经 API 不可写（实测记录 §19.2），不传即落到 RAGFlow 的缺省值。
- `page` 为 1，`page_size` 为 6。
- SHALL NOT 发送 `top_k`、`keyword`、`highlight`、`use_kg`、`document_ids`。
- `rerank_id` 为 `<重排模型名称>@owb-rerank@OpenAI-API-Compatible`。

结果：
- `code:0` 时读 `data.chunks`：它 SHALL 是数组（零命中时为 `[]`，实测记录 §19.1），每项须有字符串 `document_id`、字符串 `content` 与数字 `similarity`；`chunks` 不是数组或某项缺字段即 `kb_unavailable`。
- 每条按 `document_id` 关联该库本地文档行的 `ragflow_document_id`；关联不上的 SHALL 丢弃。零候选或全部丢弃时结果为空数组，不是错误。命中视图 `RetrievalHit` 恰为 `{documentId, name, similarity, content}`：
  - `documentId` 为本地文档 id。
  - `name` 取本地记录。
  - `similarity` 与 `content` 原样取 RAGFlow 的值。
- 次序同 RAGFlow 应答。
- 失败映射与重排降级见 ragflow-backend「RAGFlow 出站请求」。
单轮检索 SHALL 接受一个可选的中止信号，并把它传给检索请求与重排降级的那一次重试。信号已中止时 SHALL NOT 发出请求；请求进行中被中止时，结果与期限到期相同，为 `kb_unavailable`（ragflow-backend「RAGFlow 出站请求」）。检索测试端点不传信号。

#### Scenario: 参数显式传
- **WHEN** 一个库的检索参数为 `{threshold:0.35, vectorWeight:0.5}`，未配置重排模型，检索 `工单超时`
- **THEN** 假 RAGFlow 恰收到一次 `/api/v1/retrieval`，body 恰为 `{question:"工单超时", dataset_ids:[<该库 dataset_id>], similarity_threshold:0.35, vector_similarity_weight:0.5, page:1, page_size:6}`

#### Scenario: 带重排
- **WHEN** 管理员配置了名为 `qwen3-rerank` 的重排模型，检索任一问句
- **THEN** 请求 body 另含 `rerank_id:"qwen3-rerank@owb-rerank@OpenAI-API-Compatible"`

#### Scenario: 命中关联本地文档
- **WHEN** 假 RAGFlow 回三条切片：第一条的 `document_id` 属于本地文档 `notes.md`（RAGFlow 侧 `document_keyword` 为 `notes(1).md`），第二条属于本地文档 `brief.pdf`，第三条的 `document_id` 没有本地行
- **THEN** 命中恰两条，依次为 `{documentId:<notes 的本地 id>, name:"notes.md", …}` 与 `brief.pdf` 那条，`similarity` 与 `content` 等于 RAGFlow 的值

#### Scenario: 应答缺字段
- **WHEN** 假 RAGFlow 的某条切片缺 `similarity`（故障注入）
- **THEN** 503 `kb_unavailable`

#### Scenario: 零命中
- **WHEN** 假 RAGFlow 按实测记录 §19.1 回零命中 `{code:0, data:{chunks:[], doc_aggs:[], labels:null, total:0}, message:null}`
- **THEN** 单轮检索的结果为空数组，不是 `kb_unavailable`

#### Scenario: 只有一处检索实现
- **WHEN** 检索测试端点处理一次检索；会话检索处理一次 `kb_search`；另扫描 `server/src`
- **THEN** 两者都经单轮检索那一个函数发出请求；客户端的检索方法只在 `kb/retrieval.ts` 里被调用，RAGFlow 的检索路由片段（`${API}/retrieval` 或 `/api/v1/retrieval`）只出现在 `kb/ragflow-retrieval.ts`；本系统自己的 `/api/kb/bases/:id/retrieval` 不算

#### Scenario: 中止
- **WHEN** 假 RAGFlow 挂起检索应答，调用方中止信号；另一例在调用之前信号已中止
- **THEN** 前者结果为 `kb_unavailable`，假 RAGFlow 观察到连接被放弃；后者结果为 `kb_unavailable`，假 RAGFlow 没有收到请求
- **WHEN** 配置了重排模型，带重排的检索回 `code:102`，降级重试发出之前信号被中止
- **THEN** 结果为 `kb_unavailable`，假 RAGFlow 只收到一次检索请求

## ADDED Requirements

### Requirement: 会话检索 `kb_search`
知识库开启时，kb 模块 SHALL 为会话提供宿主工具 `kb_search` 的定义与执行（omp-runtime「`kb_search` 的注册」「宿主工具协议」）。本要求中，一个账号「可见的库」就是它拥有的库（可见范围四档在后续 change）。

**定义**：只读本地库表，不访问 RAGFlow。账号一个库都没有时没有定义。否则定义恰为：
- `name:"kb_search"`、`label:"知识库检索"`、`loadMode:"essential"`。
- 参数 schema `{type:"object", properties:{question:{type:"string"}, kb_ids:{type:"array", items:{type:"string"}, minItems:1, maxItems:5}}, required:["question","kb_ids"], additionalProperties:false}`。
- `description` 为固定的中文说明，之后逐行列出该账号的全部库：`- <名称>（<id>）`，按建库时间升序。固定说明 SHALL 讲清三件事：
  - 返回的是切片与出处。
  - 一次至多 5 个库，每库至多 6 条。
  - 证据不足时可以改写问句或换库再次调用。
- 注册比较的「库清单」即 `[{id, name}]` 依同一次序排列。

**执行**：输入为调用者的账号 id、参数与中止信号，依次判定：
1. **参数**：
   - 键集恰为 `question`、`kb_ids`。
   - `question` 按检索测试端点同一条规则判定：去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL；原样检索，不去空白。
   - `kb_ids` 为数组，元素为非空字符串，按首次出现去重后为 1–5 个。
   - 不符：`isError`，文本说明不符之处；去重后超过 5 个时，文本恰为 `一次至多检索 5 个知识库`。不访问 RAGFlow。
2. **逐库**（按去重后的次序）：
   - 不存在或不是调用者的库：状态 `not_found`。两种情形的文本与 `details` 完全相同，不回显任何名称，SHALL NOT 能据此探测别人的库。
   - `state` 不是 `ready`：状态 `not_ready`，不检索。
   - 其余库各做一次单轮检索（「单轮检索」，参数取该库已存的检索参数，带上中止信号），彼此并发：成功为 `ok`（命中可以为零条），`kb_unavailable` 或 `kb_rejected` 为 `failed`。
3. **结果**：
   - **给模型的文本**：各库按次序分段，段间空一行。
     - `ok`：首行 `知识库「<名称>」（<id>）：命中 <n> 条`，其后每条命中两行：`[<序号>] <文档名>（相似度 <similarity 保留四位小数>）` 与切片原文。
     - `not_found`：恰一行 `知识库 <id>：未找到该知识库`。
     - `not_ready`：恰一行 `知识库「<名称>」（<id>）：正在重建，本轮未检索`。
     - `failed`：恰一行 `知识库「<名称>」（<id>）：检索失败`。
     - 文本里只有切片原文与出处（库、文档名、相似度），SHALL NOT 有整篇文档（CONTEXT.md 不变量 2）。
   - **`details`**：恰为 `{bases:[{kbId, name, status, hits}]}`，次序同上。
     - `name` 在 `not_found` 时为 `null`，其余为本地名称。
     - `status ∈ {ok, not_found, not_ready, failed}`。
     - `hits` 在 `ok` 时为该库的 `RetrievalHit` 数组，其余为 `[]`。
   - **`isError`**：当且仅当没有任何一个库是 `ok`。
4. **不做的事**：不写回检索参数，不写审计；切片原文 SHALL NOT 进入日志或 stderr。

#### Scenario: 定义
- **WHEN** 账号依次建了库 `产品文档`（id `k1`）与 `客服问答`（id `k2`），取定义；另一账号没有库
- **THEN** 前者的定义 `loadMode` 为 `essential`，描述末尾两行依次为 `- 产品文档（k1）` 与 `- 客服问答（k2）`，库清单为 `[{id:"k1",name:"产品文档"},{id:"k2",name:"客服问答"}]`；后者没有定义；两次取定义假 RAGFlow 都没有收到请求

#### Scenario: 两个库都命中
- **WHEN** 以 `{question:"工单超时", kb_ids:["k1","k2"]}` 执行，假 RAGFlow 对 k1 回两条切片、对 k2 回一条
- **THEN** 假 RAGFlow 恰收到两次检索，各带该库的 `dataset_id` 与已存参数；`isError` 为假；文本两段，第一段首行为 `知识库「产品文档」（k1）：命中 2 条`；`details.bases` 依次为 k1（`ok`，两条命中）与 k2（`ok`，一条）；`knowledge_bases` 的检索参数与 `updated_at` 不变，没有新增审计

#### Scenario: 部分失败与不可探测
- **WHEN** 以 `kb_ids:["k1","nope","other-owner-kb","k3"]` 执行：`nope` 不存在，`other-owner-kb` 属于另一账号，k3 处于 `rebuilding`，k1 的检索被假 RAGFlow 以 HTTP 503 应答
- **THEN** `isError` 为真；文本依次为 `知识库「产品文档」（k1）：检索失败`、`知识库 nope：未找到该知识库`、`知识库 other-owner-kb：未找到该知识库`、`知识库「<k3 的名称>」（k3）：正在重建，本轮未检索`；`nope` 与 `other-owner-kb` 两项的 `details` 除 `kbId` 外完全相同（`name:null`、`status:"not_found"`、`hits:[]`）；假 RAGFlow 只收到 k1 的一次检索
- **WHEN** 同一调用里 k1 改为正常命中零条
- **THEN** `isError` 为假，k1 的段为 `知识库「产品文档」（k1）：命中 0 条`

#### Scenario: 参数校验
- **WHEN** 依次以缺 `kb_ids`、多一个键 `top_k`、`kb_ids:[]`、`kb_ids:[""]`、去重后六个 kb_id、`question:"   "`、1001 码点的问句执行
- **THEN** 七次都是 `isError`，假 RAGFlow 收到零个请求；去重后六个时文本恰为 `一次至多检索 5 个知识库`
- **WHEN** 以 `kb_ids:["k1","k1"]` 执行
- **THEN** 只检索 k1 一次，`details.bases` 一项

#### Scenario: 中止
- **WHEN** 假 RAGFlow 挂起检索，执行中止信号
- **THEN** 该库为 `failed`；执行在信号中止后结束，不再等待假 RAGFlow

## REMOVED Requirements

### Requirement: `kb_search` 工具契约
**Reason**: S2c 实现了会话内检索，契约由完整的「会话检索 `kb_search`」取代；原契约留给 S2c 决定的多库合并、条数、过滤与非 `ready` 的库，已由 2026-11-10 的 grill 定下并写进新要求。
**Migration**: 无需迁移；原契约只约束「不注册、不分派」，新要求规定了注册与执行。可见范围的过滤与跨账号检索审计仍归后续 change。
