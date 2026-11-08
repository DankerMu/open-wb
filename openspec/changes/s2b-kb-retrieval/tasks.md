# Tasks: s2b-kb-retrieval

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组（或宽度门禁拆出的切片）一个子 issue、一个 PR。
>
> 没有外部前提：rc2 实测已完成（实测记录续篇 `docs/reviews/2026-11-08-ragflow-rc2-retrieval.md` §19），本 change 的任何任务都不碰共用 RAGFlow 栈；
> `make smoke-kb` 的真实运行是 owner 执行的验收行（CK-11）。
>
> 依赖（真实依赖）：
> - 无前置：组 1、组 3、组 5。
> - 组 2 ← 1。组 4 ← 1、2、3（首刀只需 1、3；第二刀另需 2：「参数变了先写回」断言列表里的 `retrieval`）。组 6 首刀 ← 1；组 6 第二刀（6.3–6.5）← 首刀、5；组 6 第三刀（6.6）← 第二刀。组 7 ← 4、组 6 首刀。
> - 组 8 ← 2、4。组 9 ← 6（第三刀 6.6，传递覆盖前两刀）、7、8（CK-14 要检索面板；没有组 7 时配了重排也不生效）。组 10 ← 4。组 11 ← 1–10 全部。
>
> 跨服务的严格解析：web 的 API 客户端按键集严格解析应答（knowledge-bases「中心「知识库」tab」）。所以服务端给既有视图加键时，
> web 的解析器 SHALL 在同一个 PR 里改（组 2 的 `BaseView.retrieval`、组 6 的设置读视图 `rerank`），否则合入即让界面 `requestFailed`。
>
> 文件行数（size-guard 也扫 `server/test`、`web/test`，上限 800）：`kb-ragflow-client.test.ts` 768 行、`kb-settings.test.ts` 755 行、
> `fake-upstream.mjs` 770 行、`web/test/api-kb.test.ts` 682 行，本 change 的新用例一律放进下面点名的新文件，不往这四个文件里加。
>
> 计数断言原地改：既有的计数与清单断言在它们的权威文件里改，SHALL NOT 在新文件里另写一份（Code Canonicality）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（重排上游密钥进响应、审计、日志；RAGFlow 的重排报错体带出上游信息） | 是 | 1.3 store 读出不含密钥（哨兵）、组 3 结果不含 message、组 6 读视图与审计哨兵、组 6 第二刀的探活 message 哨兵、组 7 降级记录不含 message |
| 两份真相（本地参数 vs RAGFlow 缺省；命中关联不上本地文档） | 是 | 组 4 参数恒显式传、命中丢弃 |
| 并发（写回与重建、与其它写操作交错；并发的相同提交） | 是 | 组 4 第二刀的写锁用例、组 6 第二刀的同链与身份变更用例 |
| 外部接口漂移（rc2 预发行版；`code:102` 不可区分） | 是 | 组 3 夹具只按 §19 写、组 7 的降级后果用例、组 10 真实冒烟（CK-11） |
| 权限（他人知识库可探测、非管理员配重排） | 是 | 组 4 的 404 矩阵、组 6 的 403 |
| 迁移与 DB 约束 | 是 | 组 1 |
| 跨服务契约（视图加键而 web 严格解析） | 是 | 组 2、组 6 同 PR 改两端 |
| 共用外部资源（账号缺省被改动） | 是 | 组 6：重排排在最前、不发 `PATCH /models/default`，请求序列断言；组 6 第二刀探活零个 RAGFlow 请求 |

## 1. 迁移 051 与 store（knowledge-bases「迁移 051 检索参数与重排模型」）

- [x] 1.1 核对 Context：`050_knowledge_bases.sql`、`033` / `035` 的 `ADD COLUMN` 写法、`server/test/core-db-helpers.ts` 的跟踪清单、receipts 与 `sequenceRows`、`server/test/core-db-chat-step-output.test.ts` 与 `server/test/migration-034.test.ts`（`seed033Database`）的迁移排除链、`server/test/kb-schema.test.ts`、`server/src/kb/store.ts` 的 `settings()` / `saveSettings` / `recordEmbeddingProbe` 与知识库行的读写。验证：在 issue 里列出要改的函数与行号。
- [x] 1.2 测试先行：在 `server/test/kb-schema.test.ts` 加 051 的用例，覆盖「列与约束」场景（050 库上应用后两列取缺省；三处非法更新被拒：`1.5`、`-0.1`、非数字文本 `'abc'`；`1` 存成 `real`；重排三列为 NULL；`rerank_probe_status` 为 `never`），先看到红；新 `server/src/core/db/migrations/051_kb_retrieval.sql` 按 design D5 实现。另加一条「不改其它表」用例（仿 049→050 那条）：050 库里预置一行既有列取非缺省值的 `knowledge_bases` 与一行嵌入已配置的 `kb_settings`，升级后既有列值不变、其它表的 `sqlite_master` 不变、receipt 为 `[25, MIGRATION_051]`、`sequenceRows` 为 `["schema_migrations", 25, "integer"]`。`kb-schema.test.ts` 里打开完整迁移链的 050 形状断言（`kb_settings` / `knowledge_bases` 的 `tableInfo` 全列清单、`kb_settings` 整行 `toEqual`）原地改成 051 之后的形状，不另起一份。原地改 `core-db-helpers.ts` 的跟踪清单（加 `MIGRATION_051`）、receipts 与 `sequenceRows`，以及 `core-db-chat-step-output.test.ts`、`migration-034.test.ts` 的迁移排除链。验证：`npm run test:focus --workspace server -- kb-schema core-db migration-034` 全过。
- [x] 1.3 store：知识库行读出 `retrievalThreshold` / `retrievalVectorWeight`；新增「在同一事务里写两列并执行回调」（审计由调用方在回调里写）；设置读出 `rerank`（名称、地址、探活，不含密钥）与单独的重排密钥读取；整组写、清空重排三列；写回重排探活结果（只写回同一身份）。测试先行：检索参数的读写用例加在 `server/test/kb-store.test.ts`，重排三列的用例与「重排三列整组写入」场景加在 `server/test/kb-store-settings.test.ts`。验证：`npm run test:focus --workspace server -- kb-store` 全过，`store.ts` 不超过 800 行。
  - store 接口形状（#1912 fixture 审查定，组 4、组 6 照此调用）：
    - 读出：`KnowledgeBase` 加 `retrievalThreshold` / `retrievalVectorWeight`（数字）；`createBase` 读回 0.2 / 0.7。`KbSettings` 加扁平的 `rerank: {name, baseUrl} | null`（`rerank_name IS NULL` 即 `null`）与顶层 `rerankProbe: {status, at, message}`，同既有 `embedding` 与 `probe` 分开放；顶层 `probe` 仍是嵌入的探活。D6 嵌套的 `{name, baseUrl, probe}` 是 HTTP 读视图，由组 6 在 `settings.ts` 拼，本 issue 不改 `settings.ts` 的 `view()` 与 `bases.ts` 的 `viewOf`（两处解构取值，新字段不提前漏进视图，web 严格解析在组 2 / 组 6 之前保持绿）。
    - 重排密钥：`rerankApiKey(): string | null`，未配置为 `null`。保存与探活写回之后 `JSON.stringify(store.settings())` 不含密钥哨兵。
    - 重排写入：`SettingsPatch` 加键 `rerank?: {name, baseUrl, apiKey} | null`，走 `saveSettings`，与嵌入、`chatModelId`、`rebuildActorId` 同一事务、同一 `within`，不另开方法。三个字段都是必填字符串，清空只能传 `null`，同一条 UPDATE 绑三列（类型层防部分写入）；`apiKey` 由调用方先定好（省略时取 `rerankApiKey()`，同嵌入）。首次保存：三列写入，重排探活 `never/null/null`，`updated_at` 更新；同一身份重存：探活保留；名称、地址、密钥任一变化：探活重置；`null`：三列置 NULL、探活重置、`updated_at` 更新。store 不判 null→null 无操作（「不写、不审计」由组 6 在调用方判，同 `chatModelId`）。保存重排不动嵌入的身份、探活与代数；保存嵌入不动重排探活。
    - 重排探活写回：`recordRerankProbe(identity, result, within?) → {view, recorded}`，照 `recordEmbeddingProbe` 的写法；身份是名称 + 地址 + 密钥，`IS` 比较；不动 `updated_at`。同一身份：写入并调 `within`；三项任一变化（各一例）或已清空：`recorded:false`，不调 `within`，探活不变；`within` 抛出：回滚。嵌入探活写回不动重排探活。
    - 检索参数写入：`saveRetrieval(id, {threshold, vectorWeight}, within?: (record: KnowledgeBase) => void): KnowledgeBase | undefined`，同一事务写两列并更新 `updated_at`，`within` 在写入后、COMMIT 前调用。store 不比较新旧值（D4 由调用方在锁内比）。未知 id：返回 `undefined`，不调 `within`（同 `failRebuild`）；CHECK 越界（如 `1.5`）：抛出，行不变，不调 `within`；`within` 抛出：两列一起回滚；`0` / `1` 读回是数字。
    - 「重排三列整组写入」场景的用例以本任务的 `kb-store-settings.test.ts` 为准（D5 说的「schema 用例」即指这里）：保存、更换、清除每一步之后读裸行，三列同为 NULL 或同为非 NULL；`within` 抛出时三列一起回滚。
    - 既有全形断言原地改，不另写一份：`kb-store-settings.test.ts` 的 settings 全形 `toEqual`、`kb-store.test.ts` 的 `createBase` 全形 `toEqual`。`recordEmbeddingProbe` / `saveSettings` 的既有签名与行为不变。行数以 800 为上限（design 表里的 ≤620 是估计）。

Suggested fixture level: expanded - 迁移与持久化状态（migration、persisted state）。
Minimal mergeable slice: 1.1–1.2（迁移文件与 schema 用例）可独立合入保绿：只加列，既有代码不读它们；1.3 的 store 读写依赖它。

## 2. `BaseView.retrieval`（knowledge-bases「知识库端点」的视图与 201 应答）

- [x] 2.1 测试先行：
  - `server/test` 里断言 `BaseView` 恰为十个键（`viewOf` 现为十键，加 `retrieval` 后十一键）的既有用例原地改（列表、建库 201，含「建库应答不读 RAGFlow」的 `retrieval:{threshold:0.2, vectorWeight:0.7}`），先看到红。
  - 新 `web/test/api-kb-retrieval.test.ts`：带 `retrieval` 的 `BaseView` 解析通过，缺 `retrieval` 或类型不符为 `requestFailed`。
  验证：两组用例先红。
- [x] 2.2 实现：`server/src/kb/bases.ts` 的 `viewOf` 加 `retrieval`；`web/src/lib/api-kb.ts` 的 `BaseView` 类型与解析器加 `retrieval`。两端在同一 PR。`docs/architecture/knowledge-base.md` 列举 `BaseView` 键的那一处加 `retrieval`。验证：`npm run test:focus --workspace server -- kb-bases`、`npm run test:focus --workspace web -- api-kb` 全过，`make typecheck` 退出 0。
  - 组 2 约定（#1915 fixture 审查定）：
    - 服务端：`retrieval` 恰为 `{threshold, vectorWeight}`，取 store 行的 `retrievalThreshold` / `retrievalVectorWeight` 原值，不取整、不夹逼，建库 201 不读 RAGFlow、不重算。原地改：`kb-bases-list.test.ts` 的 `BASE_KEYS`、`kb-bases.test.ts` 的 201 `toEqual`、`kb-bases-compile.test.ts` 的 `toEqual`、`kb-bases-helpers.ts` 的 `BaseBody` 类型。另加一例：store 直写非缺省值（如 0.5 / 0.3）后列表视图读出同值。
    - web 解析：`hasExactlyKeys(retrieval, ["threshold","vectorWeight"])`，两值都是有限数字（`typeof === "number"` 且 `Number.isFinite`），不在 web 侧校验 0–1（服务端 CHECK 是权威）。新 `web/test/api-kb-retrieval.test.ts` 的拒绝用例：`retrieval` 为 `null`、字符串、数组；缺内键或多内键；值为字符串或 `NaN`。原地改：`web/test/api-kb.test.ts` 的 `BASE` 常量加 `retrieval: {threshold: 0.2, vectorWeight: 0.7}`；`web/test/center-kb-support.tsx` 的 `base()` 工厂加 `retrieval` 并改「十键」注释。
    - 文档与冒烟：`docs/architecture/knowledge-base.md` 的 `BaseView` 键列表加 `retrieval` 与一行说明；`smoke/kb.hurl` 列 `BaseView` 键的注释同步，建库应答处可加 `$.retrieval.threshold == 0.2`、`$.retrieval.vectorWeight == 0.7` 断言。主规格 `openspec/specs/knowledge-bases/spec.md` 归档时由 delta 并入，本 issue 不改。
    - 不受影响（已核）：`web/e2e` 的 ui-walk 没有 `/api/kb/bases` 应答桩；`center-page.test.tsx` 与 `web/test/support.ts` 只回空列表或 `enabled:false`。

Suggested fixture level: expanded - 改公共 API 的应答形状（public API），web 的严格解析器要同步。
Minimal mergeable slice: atomic - 服务端加键与 web 解析器必须同 PR，任何一半单独合入都会让知识库 tab `requestFailed`（`web/src/lib/api-kb.ts` 以 `hasExactlyKeys` 严格比对键集）。

## 3. 假 RAGFlow 检索路由与客户端（ragflow-backend「RAGFlow 接口实测记录」的检索覆盖、「RAGFlow 出站请求」的 `POST /retrieval` 一行）

- [x] 3.1 核对 Context：实测记录续篇 §19.1–§19.6；`server/test/support/fake-ragflow.mjs` 的 `ROUTES` 与兄弟文件写法；`server/src/kb/ragflow-models.ts` 的 `modelCalls(json)` 并入方式；`ragflow-route.ts` 的 `Route` 与 `API` 常量。验证：在 issue 里列出 §19 里协议应答的键与码。
- [x] 3.2 测试先行：新 `server/test/support/fake-ragflow-retrieval.mjs`（加 `.d.mts`），挂到 `ROUTES`：
  - `POST /api/v1/retrieval` 回 §19.1 形状的 `{chunks, doc_aggs, labels, total}`，切片键取 §19.1 那十六个；零命中回 §19.1 的原样 `{chunks:[], doc_aggs:[], labels:null, total:0}`。
  - 命中由用例脚本化（数据集 → 切片列表与分数），夹具不实现检索算法。
  - 协议应答：§19.1 表里六条 `code:101` 与不存在数据集的 `code:404`；`rerank_id` 指向不存在的模型时回 `code:102`（§19.4）。
  - 故障注入：「带 `rerank_id` 时回 `code:102`」开关；「任意检索请求回指定 `code`（101 / 102，不论是否带 `rerank_id`）」；切片缺字段；挂起。
  - 记录收到的 JSON body。
  附夹具自测（覆盖两种 `code` 注入与零命中）。验证：夹具自测全过。
- [x] 3.3 新 `server/src/kb/ragflow-retrieval.ts`：检索路由（路径以 `${API}/retrieval` 拼），`code:102` 为类型化结果「检索失败」，读 `data.chunks`（须是数组，零命中为 `[]`）的 `document_id`、`content`、`similarity`，`chunks` 不是数组或缺字段即 `kb_unavailable`。经 `retrievalCalls(json)` 并入 `createRagflowClient`，`ragflow-client.ts` 只加并入的一行。测试先行：新 `server/test/kb-ragflow-client-retrieval.test.ts`：成功读取、零命中为空数组、`102` 为检索失败、`101` 为 `kb_rejected`、`404` 为 `kb_unavailable`、缺字段、结果与 stderr 不含 message 哨兵。验证：`npm run test:focus --workspace server -- kb-ragflow-client-retrieval` 全过，`ragflow-client.ts` 行数增加不超过 5 行。
  - 组 3 接口与夹具约定（#1913 fixture 审查定，组 4、组 7 照此调用）：
    - 客户端方法 `retrieve({question, datasetId, threshold, vectorWeight, rerankId?}) → Promise<Result<RetrievalChunk[], {kind: "retrieval_failed"}>>`，`Result` 即 `ragflow-route.ts` 的既有联合（另含 `kb_rejected` / `kb_unavailable`）。整份 body 由 `ragflow-retrieval.ts` 拼，恰为 D2 形状：`{question, dataset_ids:[datasetId], similarity_threshold, vector_similarity_weight, page:1, page_size:6}`，有 `rerankId` 时多一键 `rerank_id`，没有时连键都不发（不发 `null`）；不发 `top_k`、`keyword`、`highlight`、`use_kg`、`document_ids`。组 7 的重试只是不带 `rerankId` 再调一次。
    - `RetrievalChunk` 为 `{ragflowDocumentId, content, similarity}`：只取三键，其余十三键丢弃，次序同应答。命名与 D2 的本地 `RetrievalHit.documentId` 区分（两份真相）。
    - 结果映射照搬 `interpret`：只有 HTTP 200 且 `code:102` 才是 `{kind:"retrieval_failed"}`，只看 code、不看 message；非 200 的 `code:101` / `code:102` 落到通用映射 `kb_rejected`（D3「其余按通用映射」，`kb-ragflow-client.test.ts` 已钉住），其它非 200 为 `kb_unavailable`；挂起超过注入的总期限是 `kb_unavailable`，不是 `retrieval_failed`（spec「超时不降级」）。
    - 夹具复用既有能力，不另做一套：任意请求回指定 code 用 `answer()` 或 `fault(…, {kind:"combo", code, message})`；切片缺字段用 `fault` combo `code:0` 加自定义 `data`；挂起用 `fault hang` / `hold`；记录 body 即 `requests()[i].json`。新文件只加两样：
      - `setRetrievalHits(datasetId, hits: {documentId, content, similarity}[])`：脚本化命中。其余十三个 §19.1 切片键：`dataset_id` 取该数据集，`document_keyword` 取已种文档的名称（没有则占位名），三个分数同值（§19.1 不带重排时恒等），其余取 §19.1 样例的占位值。
      - `failRerank(message?: string)`：此后每个带 `rerank_id` 的检索都回 `code:102` 与该 message（缺省取 §19.4 的 `failed to get rerank model` 前缀原文），持续生效直到夹具关闭，供组 7 的连续三次检索与 message 哨兵。
      - 协议应答：§19.1 表六条 `code:101` 按表的输入与原样 message；不存在的数据集为 HTTP 200 `code:404` `Resource not found`（复用 `notFound()`）；`rerank_id` 指向账号里没有的模型为 `code:102`（§19.4），所以 `addModel` 的 `modelType` 放宽到 `"rerank"`。多个参数同时非法、101 与 404 谁先：记录里没有，文件头标「外推，用例不要钉死」，同 `fake-ragflow.mjs` 头注释的写法。
    - 夹具自测逐条：六条 `code:101` 各一例（输入与原样 message）；不存在数据集 HTTP 200 `code:404`；`rerank_id` 无此模型 `code:102`；零命中原样（含 `message:null`）；带命中时 `data` 恰四键、切片恰十六键；`failRerank` 只影响带 `rerank_id` 的请求；每例断言 `unknownRoutes()` 为空（防路由没挂上时 404 假通过）。
    - 3.3 用例另加：带与不带 `rerankId` 时 `requests()[0].json` 各恰为 D2 形状；非 200 的 `code:102` 为 `kb_rejected`（不是 `retrieval_failed`）；挂起超期为 `kb_unavailable`。
    - PR Boundary 补：`fake-ragflow.mjs` 的 `createState` 加检索状态、`ROUTES` 挂载、`start()` 返回加 `...retrievalViews(…)`（同 `pipelineViews`），行数上限 800；`fake-ragflow.d.mts` 的 `FakeRagflowServer` 加两个方法与 `addModel` 的 `"rerank"`；`ragflow-client.ts` 头注释「101 / 102 为 kb_rejected」改为点明检索路由的 102 例外（措辞不带路径字样，见下条），与并入行合计增加不超过 5 行。
    - 必须保持：RAGFlow 检索路由片段（`${API}/retrieval` / `/api/v1/retrieval`，含注释）在 `server/src` 里只出现在 `kb/ragflow-retrieval.ts`（组 4 收窄，本系统的 `/api/kb/bases/:id/retrieval` 不算），`ragflow-client.ts` 的并入行与注释都不带（组 4 的扫描用例）；其它路径照旧回 404 并标 `unknown`；`fake-ragflow.test.ts` 不动；`kb-ragflow-client.test.ts`（768 行）只原地改客户端方法清单的计数断言（加 `"retrieve"`），不加用例。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials）与新的类型化失败映射。
Minimal mergeable slice: atomic - 夹具与客户端路由共一条验证路径：客户端用例只能对夹具跑（真 RAGFlow 不进 CI），夹具的协议应答只有客户端用例消费；单独合入夹具，它的自测只证明自洽，不证明协议映射（S2a 组 5 先例）。

## 4. 单轮检索与检索测试端点（knowledge-bases「单轮检索」「检索测试端点」「`kb_search` 工具契约」「同一知识库的写操作串行」「知识库审计」的 `kb.retrieval_settings`、「知识库端点」的所有权矩阵；http-service-skeleton「统一错误信封」；ragflow-backend「知识库可用性」）

首刀（4.1–4.3）：

- [x] 4.1 测试先行：新 `server/test/kb-retrieval.test.ts`，直接调用单轮检索函数（真实 SQLite 与 store，接假 RAGFlow），覆盖「单轮检索」的「参数显式传」「命中关联本地文档」「应答缺字段」「零命中」，以及全部命中关联不上时为空数组。先看到红。验证：用例先红。
- [x] 4.2 新 `server/src/kb/retrieval.ts`：按 design D1、D2 实现单轮检索（本组不带 `rerank_id`，不写回）。验证：4.1 全过，`make lint`、`make typecheck` 退出 0。
- [x] 4.3 新 `server/test/kb-retrieval-canonical.test.ts`（「单轮检索」的「只有一处检索实现」与「`kb_search` 工具契约」的「契约与检索测试同源」）：扫描 `server/src`，断言客户端检索方法的调用（方法名以 3.3 定的为准）只出现在 `kb/retrieval.ts`，RAGFlow 路由片段（`${API}/retrieval` 与 `/api/v1/retrieval` 两种写法）只出现在 `kb/ragflow-retrieval.ts`（本系统自己的 `/api/kb/bases/:id/retrieval` 路由串不算，4.5 要在 `kb/rest.ts`、`http/errors.ts` 写它；#1913 审查定），`kb_search` 不出现在任何注册或分派里。验证：用例全过；变异：在 `kb/rest.ts` 加一次对客户端检索方法的调用，用例变红（手动变异一次，记录在 PR）。
- 组 4 首刀约定（#1916 fixture 审查定，4.5 与组 7 照此调用）：
  - 签名：`retrieveForBase(deps, base, question) → Promise<Result<RetrievalHit[]>>`（`Result` 即 `ragflow-route.ts` 的联合，失败只有 `kb_unavailable` / `kb_rejected`）。`base` 是 `KnowledgeBase` 行，检索参数取该行的 `retrievalThreshold` / `retrievalVectorWeight`，不另传参（「`kb_search` 工具契约」：调用方不逐次覆盖参数；4.5 传 `saveRetrieval` 的返回值或锁内重读的行）。`deps` 为 `{store: Pick<ReturnType<typeof createKbStore>, "listDocuments">, client: Pick<ReturnType<typeof createRagflowClient>, "retrieve">}`（同 `bases.ts` 的写法，不新增类型导出），组 7 只往里加 `settings` / `log` / `now`，不改调用方。导出名不得是 `retrieve`（4.3 的词扫描）。函数里不判 `state`（D4 第 3 步只约束端点）。
  - 请求：`datasetId` 取 `base.datasetId`（不是 `rebuildDatasetId`，D2）；本刀不带 `rerankId`。
  - 结果映射在本刀落地：`retrieval_failed`（未带 `rerank_id`）→ `kb_unavailable`（D3）；`kb_rejected` / `kb_unavailable` 原样。调用方照 `bases.ts` 的写法 `throw new HttpError(result.kind)`。组 7 只加「带了 `rerank_id` 且失败 → 去掉重试恰一次」。
  - 命中关联：用现成的 `store.listDocuments(base.id)`，在本库范围内建 `ragflowDocumentId → 本地行` 映射；不新增 store 方法（`store.ts` 不在本 issue 边界）。输出 `RetrievalHit = {documentId, name, similarity, content}`，`documentId` 是本地 id，次序同应答；关联不上即丢弃；同一文档的多条切片各成一条命中，不去重。
  - 4.1 另加：HTTP 200 `code:102`（未带重排）为 `kb_unavailable`；`code:101` 为 `kb_rejected`；切片的 `document_id` 只对得上另一个库的本地行 → 丢弃（防别人的文档名泄露）；同一本地文档两条切片 → 两条命中、次序同应答；库已 `setRebuildGeneration`（`rebuildDatasetId` 非空）时 body 的 `dataset_ids` 仍是 `[datasetId]`。
  - 4.3 匹配规则：词 `\bretrieve\b` 只许出现在 `kb/ragflow-retrieval.ts` 与 `kb/retrieval.ts`（解构、字符串键、`Pick<…, "retrieve">` 都算）；RAGFlow 路由正则 `/(?:\$\{API\}|\/api\/v1)\/retrieval\b/` 只许出现在 `kb/ragflow-retrieval.ts`；`kb_search` 在 `server/src` 里零出现（含注释；S2c 再改这条用例）。正向对照防空过：`kb/retrieval.ts` 至少命中一次 `retrieve`，`kb/ragflow-retrieval.ts` 至少命中一次路由片段，扫描到的文件集合含 `kb/rest.ts`。

第二刀（4.4–4.6）：

- [x] 4.4 测试先行：新 `server/test/kb-retrieval-endpoint.test.ts`（`buildApp` + `app.inject()`，真实 SQLite，接假 RAGFlow），覆盖「检索测试端点」全部场景（含零命中与全部关联不上、写回排在入库之后、排队时库被删除、并发的相同提交、写回与重建交错：用 S2a 的锁注入让重建器持锁），以及「知识库审计」的「detail 不含敏感内容」里含哨兵问句的检索写回一支。计数断言原地改：
  - `server/test/kb-disabled.test.ts`：「未配置即关闭」十二条扩到十三条。
  - `server/test/http-parser-owners.test.ts`：归属集三十八条扩到三十九条（`:201-202`），其中 POST 三十条扩到三十一条（`:208`）；这个文件不挂产品路由，检索路由的 malformed / 空 / `text/plain` / 超 16 KiB 用例写进新文件（见下方「组 4 第二刀约定」）。
  - 检索路由的所有权（别人的 id、不存在的 id 各一次，合法 body 且参数与已存值不同，断言 A 库的检索参数不变）写进新文件 `server/test/kb-retrieval-endpoint.test.ts`。「文档路由的所有权」是五个既有文件各测自己那条路由（`kb-ingest-workspace`、`kb-documents-list`、`kb-documents-remove`、`kb-documents-reingest`、`kb-upload`），规格里的「十二次」是六条路由的合计，不改这五个文件（其中 `kb-documents-reingest.test.ts` 已 780 行）。
  先看到红。验证：用例先红。
- [x] 4.5 实现 design D4：`server/src/kb/retrieval.ts` 加 body 校验与写回编排（经 `locks.write`，锁内重读再比较，回调里写 `kb.retrieval_settings`）。`server/src/kb/rest.ts` 注册 `POST /api/kb/bases/:id/retrieval`（`ownedBase` preParsing、body limit 16 KiB、no-store）；`server/src/http/errors.ts` 的归属集加这条身份；`index.ts` 装配。验证：`npm run test:focus --workspace server -- kb-retrieval kb-disabled http-parser-owners` 全过，`make lint`、`make typecheck` 退出 0。
- [x] 4.6 文档：`docs/architecture/system.md` §2 的 `kb` 行把 S2a 之前的占位 `search(principal, query, kbRefs)` 换成单轮检索与检索端点，第 51 行附近「agentic 环…由 S2b 定」改为指向 ADR-0017；9.13（只是指向 `knowledge-base.md` 的一段指引）的话题清单加「单轮检索与检索测试端点」；`docs/architecture/knowledge-base.md` 加「单轮检索与检索测试」一节（请求形状、参数显式传的理由、写回规则、命中关联、`kb.retrieval_settings` 的 detail 形状）与检索参数的缺省值与「候选由全文匹配圈定」的已知行为（引用续篇 §19.1）。验证：`make anti-drift` 退出 0；`git grep -n "由 S2b 定" -- docs/architecture` 退出 1。
  - 组 4 第二刀约定（#1918 fixture 审查补；4.4–4.6 照此实现与测试）：
    - 支配不变量：一个库的两列检索参数只在它的写锁内变，与恰一条 `kb.retrieval_settings` 同事务落库，审计的 `before` 取锁内重读；检索恒用库里存的行，不用请求 body。兄弟面：同锁写者（入库、上传、重新入库、删文档、删库、重建器）；`BaseView.retrieval`（`bases.ts` 的 `viewOf`，组 2）；`retrieveForBase`（S2c 的消费者）；`errors.ts` 归属集；`kb-disabled` 守卫；canonical 扫描；下游消费 200 形状与错误信封的 web 检索面板（组 8）与 smoke-kb（组 10）。
    - 本刀风险包补行：错误处理与回滚 →「写回失败不检索」（列写失败与审计写失败两半）与「写回后检索失败」；资源上限与大输入 → 16 KiB 与 1000 码点正反两例；文档 → 4.6。
    - 接线与命名：`retrieval.ts` 导出 `createKbRetrieval({store: Pick<…, "getBase"|"listDocuments"|"saveRetrieval">, client: Pick<…, "retrieve">, locks, audit})`，返回的方法名不得是 `retrieve`（如 `test(id, body, ownerId) → Promise<{hits, retrieval}>`）；`KbRestDependencies` 加 `retrieval: ReturnType<typeof createKbRetrieval>`（照 `documents` / `uploads`）。`rest.ts`、`index.ts`、`errors.ts` 不得出现词 `retrieve`；`kb-retrieval-canonical.test.ts` 列入必须保持全绿。
    - 重读：handler 先校验 body，再用导出的 `ownedBase(store, id, ownerId)` 重读（preParsing 的行不随请求带下来）；锁内再用 `ownedBase` 重读，不在为 404，非 `ready` 为 409；传给 `retrieveForBase` 的是 `saveRetrieval` 的返回值或锁内重读的行；应答的 `retrieval` 取该行的 `retrievalThreshold` / `retrievalVectorWeight`，不回显 body。
    - 快路径不拿锁：持有 `world.locks.rebuild(baseId, () => held)`、库为 `ready` 时，提交已存参数 `{0.2, 0.7}` 得 200、恰一次检索请求、无审计。
    - 审计行：`actorId` 为 principal，`workspace_id` 为 null，title 为固定中文短语（如 `修改检索参数`），detail 恰为 `{id, before:{threshold, vectorWeight}, after:{threshold, vectorWeight}}`；含哨兵问句一例另断言哨兵不在 `world.lines()`（stderr）。
    - 并发不同提交（钉住 `before` 来自锁内重读）：`world.locks.write(baseId, () => held)` 持锁（照 `kb-bases-delete.test.ts:288`），发 A `{threshold:0.1, vectorWeight:0.7}` 与 B `{threshold:0.3, vectorWeight:0.7}`，轮询到 `writeWaiters(baseId)` 为 2 再放锁。期望两者 200，按到达次序恰两条审计，第二条 `before {0.1,0.7}` → `after {0.3,0.7}`，库存终值为 B，假 RAGFlow 收到两次检索、各带自己的 `after`。
    - 并发相同提交必须真的排队：同上持锁、轮询 `writeWaiters` 为 2 后放锁；两者 200，恰一条审计（`before {0.2,0.7}` → `after {0.1,0.7}`），两次检索都带 `similarity_threshold:0.1`。
    - 写失败注入两半：列写失败用 `BEFORE UPDATE OF retrieval_threshold ON knowledge_bases BEGIN SELECT RAISE(ABORT,'refuse'); END`；审计写失败照 `kb-bases.test.ts:376-378` 的 `REFUSE_AUDIT`。各自期望 500、body 恰为 `{"error":{"message":"服务器内部错误"}}`，两列与 `updated_at` 不变，零次检索请求，无 `kb.retrieval_settings`。错误从 `saveRetrieval` 的 `within` 原样抛出（事务回滚，通用 500 由框架给）。
    - body 正例（各 200）：`"a\tb\nc"` 发到 RAGFlow 的 `question` 逐字节相同（`model-catalog.ts:257` 的 `isLabel` 拒 `\t` / `\n`，不得原样复用）；`"  销售额  "` 不 trim 原样发；`"😀".repeat(1000)` 通过（长度按原串 `[...question].length` 计，不是 `.length`）；`threshold:0, vectorWeight:1` 通过。
    - body 反例补行（各 400 `bad_request`、零请求、无审计）：问句含 `\r`；含 `\u007f`；body 为 `null`；body 为 `[]`；`question:123`。次序：别人的 id 带坏 JSON 得 404（归属先于解析）；自己处于 `rebuilding` 的库带坏 body 得 400（body 先于状态）。
    - 解析器用例落点：坏 JSON、空 JSON、`text/plain`、超 16 KiB 的 body 写在 `server/test/kb-retrieval-endpoint.test.ts`（照 `kb-ingest-workspace.test.ts:326-336`），各 400 `bad_request`、零个 RAGFlow 请求。`server/test/http-parser-owners.test.ts` 不挂产品路由，只原地改：`KB_OWNER_IDENTITIES` 在 reingest 之后加 `["POST","/api/kb/bases/:id/retrieval"]`；`THIRTY_EIGHT_OWNER_IDENTITIES`（:40）改名并改 :39 注释、:27 的「七条」、:198 / :199 / :205 的标题；:201-202 的 `toHaveLength(38)` / `toBe(38)` 改 39，:208 的 POST 计数 30 改 31；可选在 `NON_OWNER_METHODS` 加 `GET` / `PUT /api/kb/bases/:id/retrieval`。
    - 其它计数文字原地改：`server/src/http/errors.ts:66` 与 `:135` 的「三十八条」改三十九；`server/test/kb-disabled.test.ts:3` 与 `:68` 的「十二条」改十三；新路由排在 `errors.ts` 的 `CONTENT_PARSER_OWNED_ROUTES` 注释清单 reingest 之后。
    - 命中透传：`setRetrievalHits` 种一条本地文档的切片与一条未知 `document_id`；期望 200，应答 `toEqual({hits:[{documentId:<本地 id>, name, similarity, content}], retrieval:{threshold:0.2, vectorWeight:0.7}})` 键集恰如此，`cache-control: no-store`；归属 404 也断言同一头。
    - 原语不判 state（#1938 的结转）：端点对 `rebuilding` / `rebuild_failed` 回 409 是 spec 定的；非 ready 库是否参与检索由 S2c 为 `kb_search` 定。所以钉在原语上：PR 边界加 `server/test/kb-retrieval.test.ts`，加一例 `setState("rebuilding")` 后 `retrieveForBase` 仍恰发一次检索、`dataset_ids:[datasetId]`、返回命中。
    - 文档（4.6）：`docs/architecture/knowledge-base.md` 写明 `kb.retrieval_settings` 的 detail 形状；`rest.ts` 的路由头注释加新路由。
    - 新测试文件约 25 例，须不超过 800 行；超了就照现有 `kb-*-helpers.ts` 拆一个 helper 文件。先查 `server/test/kb-ingest-helpers.ts` 等 helper 是否已有 `setRetrievalHits` 与「删数据集时让 RAGFlow 挂起」的手段（排队时库被删除一例要用）。

Suggested fixture level: expanded - 新的公共端点、权限、持久化写回与并发（public API、auth、persisted state、concurrency）。
Minimal mergeable slice: 4.1–4.3 为首刀：`retrieval.ts` 的单轮检索（不带重排、不写回）与它的直接用例、源码扫描用例。knip 的 server entry 含 `test/**/*.test.ts`，被用例导入的导出不判死代码（S2a 组 15 先例），首刀独立保绿。第二刀 4.4–4.6（端点、写回、锁、审计、计数原地改、文档）依赖首刀与组 2。

## 5. 探活泛化为两种目标（ragflow-backend「知识库模型设置」的探活；行为不变的重构）

- [x] 5.1 核对 Context：`server/src/kb/embedding-probe.ts` 全文与它现有的 HTTP 层用例（`server/test/kb-settings-probe.test.ts`）、`settings.ts` 的 `probeOnce`。验证：在 issue 里列出路径、body 与 2xx 判定三处写死的点。
- [x] 5.2 原地重构：`embedding-probe.ts` 改名 `model-probe.ts`，`probeEmbedding` 泛化为按目标取路径、body 与 2xx 判定（design D7），嵌入目标的行为逐字不变。新 `server/test/support/fake-upstream-rerank.mjs`（照 `fake-upstream-embeddings.mjs` 的兄弟文件写法）提供 `POST /rerank`。测试先行：模块改名后 `kb-settings-probe.test.ts` 原样全绿；新 `server/test/kb-model-probe.test.ts` 加重排目标的单元用例（`POST <base>/rerank`、body `{model, query:"ping", documents:["ping"]}`、`results[0].relevance_score` 为数字为 `ok`、401 / 503 / 空 `results` 为 `failed`、错误摘录不含密钥与地址），先红后绿。验证：`npm run test:focus --workspace server -- probe` 全过；`git grep -n embedding-probe -- server web docs/architecture` 退出 1。
  - 组 5 约定（#1914 fixture 审查定，#1919 照此接线）：
    - 形状：`probeModel(target: "embedding" | "rerank", upstream, deadlines)`，内部用按目标索引的表 `{path, body(name), judge}`；返回类型与期限类型去掉 Embedding 前缀（`ModelProbeResult`、`ModelProbeDeadlines`）。`settings.ts` 的调用点传 `"embedding"`，`index.ts` 的 `probeDeadlines` 类型与注释同步改名；`store.recordEmbeddingProbe` 不动。
    - 必须保持（嵌入目标逐字不变）：`kb-settings-probe.test.ts` 一字不改且全绿；连接 10 s、总 15 s 的期限常量与 `probeDeadlines` 注入入口；错误体读取、上游摘录与密钥列表净化、200 点截断；`agent:false`、不跟随重定向、不重试；1 MiB 读取上限；嵌入失败文案（如「响应不含嵌入向量」）。新用例另断言嵌入目标发出的路径 `/embeddings`、body `{model, input:"ping"}` 与 `authorization: Bearer` 头（经 `fake-upstream-embeddings.mjs` 的 `requests()`）。
    - 重排判定：2xx 且 `results` 是非空数组、`results[0].relevance_score` 是有限数字（`Number.isFinite`）为 `ok`；缺 `results` 或不是数组、空数组、`results[0]` 缺 `relevance_score`、分数为字符串或 `null`、超过 1 MiB，都是 `failed`，文案「响应不含重排分数」（不复用嵌入文案）；401 / 503 等非 2xx 照既有映射。各一条用例（缺键、空数组、缺分数、非数字分数、401、503）。
    - 净化与期限（重排目标各一例）：错误体含 apiKey 与 baseUrl 哨兵时 `message` 不含它们；`totalDeadlineMs: 50` 加 `hold()` 得「超时」。
    - 假上游：`fake-upstream-rerank.mjs` 照嵌入兄弟文件提供脚本化的 `answer` / `hold` / `requests`；缺省应答取 §19.4 形状 `{results:[{document:{text:"ping"},index:0,relevance_score:0.635}],usage:{}}`；401 回显所给 bearer（净化用例的哨兵）；503 用 `error.code:"model_not_found"`。`fake-upstream.mjs` 的接线同 `/embeddings`（同时接受 `/rerank` 与 `/v1/rerank`），接完 `wc -l` ≤ 800。
    - `openspec/` 里的旧名是历史叙述，不改；改名只涉及 `server/`（`index.ts`、`settings.ts` 与模块本身）。

Suggested fixture level: compact - 行为不变的重构加一个新的出站目标，没有公共 API、schema 或权限变化；嵌入探活的既有用例原样全绿即证明不变。
Minimal mergeable slice: atomic - 改名与按目标参数化改的是同一个函数签名与同一批调用点，拆成两步只会让两个 PR 改同一批行，中间状态没有可单独验证的行为；重排目标此时只有单元用例调用，端点接线在组 6。

## 6. 重排模型的设置、下发与探活端点（ragflow-backend「知识库模型设置」；knowledge-bases「知识库审计」的 `kb.settings` 行）

- [x] 6.1 测试先行：新 `server/test/kb-settings-rerank.test.ts`，覆盖 ragflow-backend「知识库模型设置」的「重排模型的下发序列」「换重排模型不重建」「清除重排模型」「重排模型的密钥与名称」「重排模型下发失败」「组合保存时重排失败」，以及 knowledge-bases「detail 不含敏感内容」的设置一支带 `rerank.apiKey` 哨兵。新 `web/test/api-kb-rerank.test.ts`：设置读视图带 `rerank` 才解析通过。先看到红。验证：用例先红。
- [x] 6.2 实现 design D6：`settings.ts` 解析 `rerank`；保存时重排一轮排在嵌入、对话之前，失败即停；`Provision` 加 `modelType:"rerank"`，这时不发 `PATCH /models/default`；清除只改本地；读视图加 `rerank`；审计 detail 加 `rerank`。假 RAGFlow 的实例路由接受 `model_type:["rerank"]`（若有白名单）。同一 PR：`web/src/lib/api-kb.ts` 的设置视图解析与 `updateKbSettings` 的 input 加 `rerank`。验证：`npm run test:focus --workspace server -- kb-settings`、`npm run test:focus --workspace web -- api-kb` 全过，`make typecheck`、`make lint` 退出 0，`settings.ts` 不超过 800 行。
  - 组 6 首刀约定（#1917 fixture 审查补；6.1–6.2 照此实现与测试）：
    - 无操作判定：同时满足三条才是无操作——没有 `embedding`；`chatModelId` 缺省或由 `null` 设为 `null`；`rerank` 缺省或由 `null` 设为 `null`。`settings.ts` 现只认对话模型由 null 到 null，须原地改写。红用例：当前对话模型为 null 时，`{rerank:{…}, chatModelId:null}` 恰下发一轮 `owb-rerank` 并写库，审计 detail 为 `{rerank:<名称>}`。
    - 对话模型重发：body 不含 `chatModelId` 时不得取当前值重发对话那一轮。用例：已配对话模型 `m2`（`chatWorld`）时，`{rerank:{…}}` 恰只有 `owb-rerank` 一轮、没有 `owb-chat` 一轮、没有 `PATCH /models/default`；`{rerank:null}` 假 RAGFlow 收到零个请求。
    - 反方向（必须保持）：已配重排模型时，只含 `embedding` 或只含 `chatModelId` 的保存不发 `owb-rerank` 一轮，`rerank` 读视图与重排探活不变；嵌入、对话两种保存的既有请求序列与审计不变。
    - 同一身份重存重排模型：照常下发（`owb-rerank` 已有实例的那一轮，无 `PATCH`），重排探活保留，恰一条审计，detail 为 `{}`（同 knowledge-bases 审计表「同身份重存也是一次写入」）。只换密钥：探活回到 `never`，detail 为 `{rerank:<名称>}`。detail 的 `rerank` 键：名称、地址、密钥任一变化为名称；由非 null 清为 null 为 `null`；其余不出现。
    - 组合保存成功：请求序列为「重排一轮 → `nextRound("owb-embed")` → `nextRound("owb-chat")`」，detail 同时含 `embedding` 与 `rerank`。
    - 「重排模型下发失败」的前置探活 `ok` 用 `world.store.recordRerankProbe({name, baseUrl, apiKey}, {status:"ok", at, message:null})` 直接种；`?target=rerank` 不在本刀。
    - 首次配置重排模型不带 `apiKey` 的 400：锁内、任何下发之前判定，排在 `kb_chat_model_locked` 之前（`settings.ts` 文件头「400 先于一切」一档）。用例：已有开编译的库且已配对话模型时，`{rerank:{name, baseUrl}, chatModelId:null}` 得 400 而非 409，零个请求。
    - 权限：普通用户 `PUT {rerank:{…}}` 得 403 `forbidden`，零个请求，设置不变。
    - 校验：与嵌入共用同一解析函数（`parseEmbedding` 原地泛化，不另写一份）。下列每行都是 400、零个请求，用例在新文件：不是对象、未知键、缺 `name` 或 `baseUrl`；名称为空、非字符串、129 字节、含控制字符、含 `@`；地址 `ftp://` 或带 userinfo；密钥 `""`、纯空白、只有 U+0085、含换行、非字符串。名称恰 128 字节接受。`{rerank:null}` 单独出现合法；只有 `{confirmRebuild:true}` 仍 400。
    - 读视图：恰八键 `{embedding, chatModelId, rerank, bases, compileBases, documents, rebuilding, rebuildFailed}`；`rerank` 为 `{name, baseUrl, probe:{status, message, at}}` 或 `null`，`probe` 由 store 顶层 `rerankProbe` 拼入；`rerankProbe` 不出现在视图顶层，重排密钥哨兵不出现在应答与 stdout/stderr。
    - 既有测试原地改（改既有断言，不加用例）：`server/test/kb-settings.test.ts` 的 `EMPTY_VIEW` 加 `rerank: null`、「恰为七个键」改八个；`server/test/kb-settings-helpers.ts` 的 `SENTINELS` 加导出的 `RERANK_KEY`，加 `rerankFirstRound = firstRound().slice(0,3)` 与 `rerankNextRound = nextRound("owb-rerank").slice(0,4)`（既有两常量含 `PATCH_DEFAULT`，不能直接用）。
    - 不得放宽的三道防线：`expectDefaultNeverCleared` 的 `/^owb-(embed|chat)$/u`；`ragflow-models.ts` 中 `setDefaultModel` 的 `modelType: "embedding" | "chat"`（`provision` 对 `"rerank"` 按类型收窄后跳过缺省一步）；`fake-ragflow-models.mjs` 的 `DEFAULT_TYPES`。假 RAGFlow 建实例与改实例路由对 `model_type` 无白名单，不改。
    - web：`SETTINGS_KEYS` 加 `rerank`；`rerank` 与 `embedding` 走同一解析函数，精确键集 `{name, baseUrl, probe}`，`probe` 为 `{status, message, at}`，`null` 合法；缺键或形状不符即 `requestFailed`。`UpdateKbSettingsInput` 加第三分支 `rerank: {name, baseUrl, apiKey?} | null` 必填，每个分支保留 `embedding?` 与 `chatModelId?`（`use-kb-settings.ts:20` 引用 `UpdateKbSettingsInput["embedding"]`）。web 测试原地改：`api-kb.test.ts` 的 `SETTINGS` / `SETTINGS_EMPTY` 加 `rerank`，`malformed(SETTINGS, {…})` 加 `rerank:` 一列；`center-models-kb.test.tsx` 的 `settings()` 工厂加 `rerank: null`。内层形状拒绝、「缺 `rerank` 键即 requestFailed」、`updateKbSettings` 三种序列化（`{rerank:null}` 得 `'{"rerank":null}'`、省略密钥、带密钥）只放 `web/test/api-kb-rerank.test.ts`。
    - 不动：`kb-store-settings.test.ts`（#1912 已含 `rerank` / `rerankProbe`）。
- [x] 6.3 测试先行：在 `server/test/kb-settings-rerank.test.ts` 加「重排探活」「探活目标的取值」、「非管理员」对 `?target=rerank` 的 403、http-service-skeleton「知识库的归属路由」对 `POST /api/kb/settings/probe?target=rerank` 携 `{}` 的 400。先看到红。验证：用例先红。
- [x] 6.4 实现 design D7：`rest.ts` 的探活路由读 `target`（缺省、`embedding`、`rerank`；其它、重复、空值为 400；未配置重排时 400 `bad_request`）；`settings.ts` 的重排探活写回只写同一身份、排在同一条探活 Promise 链上，审计 `kb.settings` detail `{rerankProbe}`。验证：`npm run test:focus --workspace server -- kb-settings` 全过，`make typecheck`、`make lint` 退出 0。
- [x] 6.5 文档：正文写在 `docs/architecture/knowledge-base.md`「知识库模型设置」（重排模型：实例 `owb-rerank`、排在最前下发、不设账号缺省、清除只改本地、探活 `?target=rerank`；读视图八键），运维说明加「`owb-rerank` 不是账号缺省，删除没有 §13 的风险」；`docs/architecture/system.md` 9.13 只是一段指引，它的话题清单与 §2 `kb` 行各加一项（落点见下方「组 6 第二刀约定」）。验证：`make anti-drift` 退出 0。
  - 组 6 第二刀约定（#1919 fixture 审查补；6.3–6.5 照此实现与测试）：
    - 假上游密钥：`useSettingsWorlds` 启动假上游时用的是 `apiKey: EMBED_KEY`（`server/test/kb-settings-helpers.ts:183`），它的 `/rerank` 也只认这个 bearer（`fake-upstream.mjs:100`）。既有的 `QWEN` 常量指向的不是假上游。探活用例另定一个常量 `{name:"qwen3-rerank", baseUrl: world.embedding.baseUrl, apiKey: EMBED_KEY}` 来走 `ok` 路径。用的是哪把密钥，只由 `RERANK_KEY` 那一例证明：断言 `upstream.rerank.requests()[0].authorization === "Bearer " + RERANK_KEY`，结果为 `failed`。`fake-upstream.mjs`（781 行）与 `fake-upstream-embeddings.mjs` 不改。
    - 请求入口：用 `world.call("POST", "/api/kb/settings/probe?target=…", who)`，不带 body。`world.probe()` 不加参数，也不另写 helper。重排的审计在新文件里按 `Object.hasOwn(detail, "rerankProbe")` 过滤。
    - `?target` 取值表。下表每个 400 都断言：`BAD_REQUEST` 信封、no-store、两种上游的 `requests()` 都不增加、`world.sent()` 为空、没有 `kb.settings` 审计。
      - 不带 `target`：探嵌入。
      - `?target=embedding`：探嵌入，上游请求与审计 detail `{probe}` 都和不带 `target` 时相同。
      - `?target=rerank`：探重排。
      - `?target=`、`?target`：400。
      - `?target=rerank&target=embedding`、`?target=rerank&target=rerank`：400。
      - `?target=Rerank`、`?target=RERANK`、`?target=%20rerank`、`?target=nope`：400，按原值精确匹配。
      - 其它查询键（如 `?foo=1`）忽略，同 `models/rest.ts:126` 的 `idOf` 先例。
    - 接线：`target` 在 `rest.ts` 的 handler 里解析，次序为先校验 body、再解析 `target`、再调 `settings().probe(actorId, target)`，其中 `target: "embedding" | "rerank"` 为必填参数。非法 `target` 因此不进探活链：嵌入探活被 `hold()` 期间，`?target=nope` 立即得 400。`rest.ts:183` 的 probe/rebuild 共用循环里，`/rebuild` 不读 query，行为不变。`rest.ts` 文件头注释（:15-18）加 `target`。
    - 次序：普通用户对 `?target=rerank` 和 `?target=nope` 都得 403 `forbidden`（preParsing 先判），零个上游请求。匿名对 `?target=rerank` 得 401。管理员对 `?target=rerank` 携 `{}`，或对 `?target=nope` 携 `{}`，都得 400，零个上游请求，没有审计。
    - 未配置的判定：「重排未配置得 400 `bad_request`」放在探活链里、轮到时才判，镜像 `kb_not_ready`；`target=rerank` 永远不会得 `kb_not_ready`。用例：
      - 全新世界 `?target=rerank` 得 400。
      - 只配了重排、没配嵌入时，`?target=rerank` 得 200 `ok`。
      - 嵌入探活被 `hold()` 期间排入一个 `?target=rerank`，其间 `PUT {rerank:null}`；放行后这个重排探活得 400，`rerank.requests()` 为空。
    - 实现形状：不另写 `probeRerankOnce`。`probeOnce(actorId, target)` 内部按目标查一张表，表里有：
      - 身份：`settings().embedding` 加 `embeddingApiKey()`，或 `settings().rerank` 加 `rerankApiKey()`。
      - 未配置时的错误码：`kb_not_ready` 或 `bad_request`。
      - 写回：`recordEmbeddingProbe` 或 `recordRerankProbe`。
      - 审计 title 与 detail 键：`probe` 或 `rerankProbe`。
      另外，`KbSettingsDependencies.store` 的 Pick 加 `"recordRerankProbe"`，`AuditEvent.detail` 的联合加 `{rerankProbe: "ok" | "failed"}`。
    - 审计：`kind:"kb.settings"`，`actorId` 为 principal，title 恰为 `探活知识库重排模型`，detail 恰为 `{rerankProbe:"ok"|"failed"}`。不带 `probe` 键，不含 message、名称、地址。
    - 应答：200、no-store、八键读视图，与随后 `GET` 的结果 `toEqual`。`rerank.probe` 的取值：
      - `ok` 时为 `{status:"ok", at:≥before, message:null}`。
      - 上游 401 时 `message` 以 `HTTP 401` 开头。
      - 上游返回 `results:[]` 时 `message` 为 `响应不含重排分数`。
      每例都断言 `embedding.probe` 不变。反方向：不带 `target` 的探活不改 `rerank.probe`，`rerank.requests()` 为空。
    - 上游请求形状：`upstream.rerank.requests()[0].body` 恰为 `{model:"qwen3-rerank", query:"ping", documents:["ping"]}`；`world.sent()` 为空（零个 RAGFlow 请求，没有 `PATCH /models/default`）。
    - 只写回同一身份：
      - `rerank.hold()` 后发 `?target=rerank`，`await reached`，再 `PUT {rerank:{name:"bge-reranker", baseUrl, apiKey}}`，然后放行。结果：200，`rerank.name` 为 `bge-reranker`，`rerank.probe` 为 `NEVER`，没有 `rerankProbe` 审计。
      - 独立性：`rerank.hold()` 期间改的是嵌入模型。放行后重排探活照常写回，有一条 `{rerankProbe:"ok"}`。
    - 共用一条链：
      - `embeddings.hold()` 后发不带 `target` 的探活，`await reached`，再发 `?target=rerank`。放行前 `rerank.requests()` 长度为 0；放行后两者都 200，审计次序为 `{probe:"ok"}`、`{rerankProbe:"ok"}`。
      - 前一个失败不影响后一个：未配置重排时 `?target=rerank` 得 400，紧接着不带 `target` 的探活照常 `ok`。
    - 密钥哨兵：`RERANK_KEY` 那个 401 例里，哨兵不出现在 `rerank.probe.message`、应答 body、审计 detail、`world.logged` 中的任何一处。
    - 必须保持：
      - `server/test/kb-settings-probe.test.ts` 一字不改且全绿：`git diff --exit-code origin/master -- server/test/kb-settings-probe.test.ts` 退出 0。
      - `kb-model-probe.test.ts` 全绿，`store.recordEmbeddingProbe` 不动。
      - 路由身份不变，`kb-disabled.test.ts` 的条目数与 `http-parser-owners` 的计数都不改。
      - web 不改。
      - `settings.ts` 与 `kb-settings-rerank.test.ts` 都不超过 800 行，测试超了就照 `kb-*-helpers.ts` 拆一个兄弟文件。
    - 防回归（结转自 #1939 审查，加在 `kb-settings-rerank.test.ts`）：
      - 已配对话模型且 `compileBases>0` 时，`{rerank: <完整重排模型>, chatModelId:"<另一个 id>"}` 得 409 `kb_chat_model_locked`，零个请求。
      - 已配重排模型时，`{embedding, rerank:null}` 只有 `owb-embed`、`owb-chat` 两轮，没有 `owb-rerank` 一轮，detail 含 `rerank:null`。
    - 风险包补落点：「并发」→ 本刀的同链用例与身份变更用例；「凭证泄露」→ 探活 message 的哨兵；「共用外部资源」→ 探活零个 RAGFlow 请求。
    - 6.5 文档落点：`system.md` 9.13 只是一段指引，正文写在 `docs/architecture/knowledge-base.md`「知识库模型设置」。
      - :5 节首清单加 S2b 组 6。
      - :66 探活一行改为「探活嵌入或重排模型（`?target=embedding|rerank`，缺省嵌入；其它、空值、重复为 400；重排未配置为 400）」。
      - :69 读视图由七键改为八键 `{embedding, chatModelId, rerank, bases, compileBases, documents, rebuilding, rebuildFailed}`，`rerank` 为 `{name, baseUrl, probe}` 或 `null`。
      - :71 PUT 键集加 `rerank`：「至少含三者之一」，校验同嵌入。
      - :77-84 下发序列加 `owb-rerank` 一轮：`model_type:["rerank"]`，`max_tokens` 8192，没有第 4 步，排在最前，失败即停，并写明排在最前的理由；`rerank:null` 只改本地，换重排模型不重建。
      - :101 探活段加重排变体：`POST <baseUrl>/rerank`、body、判定方式，以及 §19.4 那次 22 s 的探活会判为超时。
      - :103 写明两种探活走同一条链。
      - :105 审计 detail 加 `rerank`（名称或 `null`）与 `{rerankProbe}`。
      - :86-88 附近与 :416 运维清理条各加一句「`owb-rerank` 不是账号缺省，删除它没有 §13 的风险」。
      - 不写检索带重排与降级，那是 7.2 的文档。
      - `system.md` 只改两处：9.13 的指引句加「重排模型（`owb-rerank`）与 `?target=rerank` 探活」；§2 `kb` 行的探活条目加 `?target=rerank`。
      - 行号以 origin/master 为准，#1918 的 4.6 合入后会有偏移，按内容定位。
    - 6.4 的验证加：`npm run test:focus --workspace server -- probe`，覆盖 `kb-settings-probe` 与 `kb-model-probe`。
- [ ] 6.6 web 原地改名：测试先行，`web/test/api-kb-rerank.test.ts` 加 `probeKbModel("rerank")` 发 `?target=rerank`；`web/test/api-kb.test.ts`、`web/test/api-files-archive.test.ts`、`web/test/center-models-kb.test.tsx` 里的旧名原地改。实现：`web/src/lib/api-kb.ts` 的 `probeKbEmbedding()` 改为 `probeKbModel(target)`，`web/src/lib/api.ts` 的 `ApiClient`、`web/test/api-files-archive.test.ts` 的方法清单与 `use-kb-settings.ts` 的调用点随之改。验证：`npm run test:focus --workspace web -- api-kb api-files-archive center-models-kb` 全过，`make typecheck` 退出 0，`git grep -n probeKbEmbedding -- web` 退出 1。

Suggested fixture level: expanded - 带凭证的出站请求、管理员权限与公共 API 的视图加键（outbound with credentials、auth、public API）。
Minimal mergeable slice: 6.1–6.2 为首刀（设置的解析、下发、清除、读视图，加上 web 设置视图解析器）：读视图加键与 web 解析器必须同 PR，不带 `target` 的探活行为不变，首刀独立保绿。第二刀 6.3–6.5（服务端探活 `target`、重排探活写回与文档）依赖首刀与组 5，atomic：探活的红用例、接线与描述它的文档是同一条验证路径。第三刀 6.6（web 探活方法改名）依赖第二刀，atomic：方法改名与它的调用点是同一批行。

## 7. 检索带重排与自动降级（ragflow-backend「RAGFlow 出站请求」的重排降级与三个场景；knowledge-bases「单轮检索」的「带重排」）

- [x] 7.1 测试先行：新 `server/test/kb-retrieval-rerank.test.ts`，加「带重排」「重排降级」「检索失败的映射」（收窄为带 `rerank_id` 重试后仍是 102 得 503；未配置重排时 102 与 101 的原语映射已由 4.1 覆盖，不重复；但要加一例未配置重排、`code:102` 时 stderr 无 `kb_rerank_degraded`）「超时不降级」四个场景；`kb_rerank_degraded` 60 秒内至多一行（注入时钟）；降级时 stderr 与应答都不含假 RAGFlow 的 message 哨兵。先看到红。验证：用例先红。
- [x] 7.2 `server/src/kb/retrieval.ts`：配置了重排模型时带 `rerank_id`，检索失败且带了 `rerank_id` 时去掉它重试恰一次并写降级记录（复用 `perMinute`），其余检索失败为 `kb_unavailable`（design D3）。验证：`npm run test:focus --workspace server -- kb-retrieval` 全过；降级规则与「`code:102` 不可区分」的后果写进 `docs/architecture/knowledge-base.md`「单轮检索与检索测试」一节，`docs/architecture/system.md` 9.13 只在话题清单里加一项（见下方「组 7 约定」）。
  - 组 7 约定（#1920 fixture 审查补；7.1–7.2 照此实现与测试）：
    - 限流器只建一次。这条推翻「组 4 首刀约定」里「组 7 加 `log` / `now`」的写法。
      - 照 `server/src/kb/index.ts` 中 `onVersionMismatch` 的写法建 `onRerankDegraded: perMinute(now, () => log({event:"kb_rerank_degraded"}))`，经 `createKbRetrieval` 的 deps 传进 `retrieveForBase`。
      - 理由：`perMinute` 的状态存在闭包里，在 `retrieveForBase` 内建会每调用一次就重置一次。只在 `index.ts` 建一次，S2c 的 `kb_search` 也能共用同一个限流器。
      - `KbRecord` 的联合加 `"kb_rerank_degraded"`。
      - 名字里不得含词 `retrieve`（4.3 的扫描会拦）。
    - deps 形状：
      - `RetrievalDependencies` 改为 `{store: Pick<…, "listDocuments" | "settings">, client: Pick<…, "retrieve">, onRerankDegraded: () => void}`。
      - `KbRetrievalDependencies` 同样加 `"settings"` 与 `onRerankDegraded`。
      - `retrieveForBase(deps, base, question)` 的签名不变。
    - 读取时机：
      - 在 `retrieveForBase` 开头读一次 `deps.store.settings().rerank`，不在 `test()` 里读。这样 S2c 也一律带重排（Grill #4「配了就一律用」）。
      - 重试复用同一个 `base` 行和问句，不重读设置。所以「请求开始到重试之间清除了重排」不单独设用例：重试本来就不带这个键。
    - 引用串：
      - 在 `settings.ts` 的 `embeddingModelOf` 旁加 `export function rerankModelOf(name)`，返回 `${name}@${RERANK_INSTANCE}@${PROVIDER}`，由 `retrieval.ts` 导入。
      - `retrieval.ts` 里不得出现字面量 `@owb-rerank@` 或 `OpenAI-API-Compatible`。
      - PR 边界因此加上 `settings.ts`，至多 +4 行。
    - 请求的 query：
      - 第一次为 `{...base 参数, ...(rerank === null ? {} : {rerankId: rerankModelOf(rerank.name)})}`。
      - 重试用 `const {rerankId, ...rest} = query` 去掉这个键，不传 `rerankId: undefined`（`exactOptionalPropertyTypes`）。
    - 只在一种情况下重试：第一次带了 `rerankId`，且结果为 `retrieval_failed`。
      - `kb_rejected`（含 101、非 200 的 102）与 `kb_unavailable`（404、HTTP 5xx、超时）都原样返回，不重试，不写记录。
      - 进入降级后，不论重试结果如何，`onRerankDegraded()` 都恰调用一次。
      - 重试结果按普通检索映射：`retrieval_failed` 为 `kb_unavailable`，101 为 `kb_rejected`，命中走既有关联。
    - 必须保持：
      - `server/src/kb/ragflow-retrieval.ts` 不动。
      - `kb-retrieval-endpoint.test.ts` 与 `kb-retrieval.test.ts` 的用例一条不改，全部保持绿。
      - `kb-retrieval-canonical.test.ts` 保持绿。
      - 未配置重排时，body 恰为 D2 的六个键，没有 `rerank_id` 键。
      - `kb-retrieval.test.ts` 的 `deps` 字面量原地加 `onRerankDegraded: () => {}`（`store` 已有 `settings`），不改用例，并列入 PR 边界。
    - 测试世界：
      - 新文件 `server/test/kb-retrieval-rerank.test.ts` 用 `useIngestWorlds()`。
      - 时钟用 `open({kb:{now: () => clock}})` 配一个可变的 `let clock`（ingest 世界没有 `advance`）。
      - 发检索时用与已存值相同的 body `{question, threshold:0.2, vectorWeight:0.7}`，走快路径，不拿锁、不审计。
    - 种重排：用 `world.store.saveSettings({rerank:{name:"qwen3-rerank", baseUrl, apiKey: RERANK_KEY}})`。成功路径还必须 `world.fake.addModel("owb-rerank","qwen3-rerank","rerank")`，否则夹具找不到模型会回 102，用例会因为错误的原因失败。
    - 带重排：
      - 期望 200，恰一次检索请求。
      - body `toEqual` D2 六键加 `rerank_id:"qwen3-rerank@owb-rerank@OpenAI-API-Compatible"`，期望值写成字面量，不从 src 取。
      - `world.logged` 为 `[]`。
      - `RERANK_KEY` 不出现在请求 body 和应答里。
    - 探活失败仍带重排：先 `world.store.recordRerankProbe({name, baseUrl, apiKey}, {status:"failed", at, message:null})` 再检索，body 仍带 `rerank_id`。
    - 按次读设置：已配置时检索带键；`world.store.saveSettings({rerank:null})` 之后的下一次检索恰一次请求，`Object.hasOwn(body, "rerank_id")` 为 false。
    - 重排降级：`failRerank(MESSAGE_SENTINEL)`，再用 `setRetrievalHits` 种两条本地文档的切片，连续检索三次。
      - 每次都是 200，应答 `toEqual({hits:[两条], retrieval:{threshold:0.2, vectorWeight:0.7}})`，键集恰如此，没有降级标记，带 `cache-control: no-store`。
      - 检索请求共六次，两两一对：每对的第二次 `toEqual` 第一次去掉 `rerank_id` 的结果，且 `Object.hasOwn(second, "rerank_id")` 为 false。
      - `world.logged` `toEqual([{event:"kb_rerank_degraded"}])`。这是精确对象比较，由此可证记录里没有 baseId、名称、地址、密钥或 message。
      - `MESSAGE_SENTINEL` 不出现在应答里。
      - `audit_events` 总行数不变。
    - 限流（注入时钟）：
      - 降级一次后 `clock += 59_999` 再降级，仍是一行；再 `clock += 1` 降级，变为两行（`perMinute` 用的是 `>=`）。
      - 限流是进程级的，不按库分：用 `world.addBase("naive")` 建第二个库，两个库在 60 秒内各降级一次，`world.logged` 恰一行。
    - 检索失败的映射（收窄后）：
      - 已配置重排时注入 `world.fake.fault(ROUTE, {kind:"combo", code:102, message:MESSAGE_SENTINEL}, {times:2})`（`answer` / `fault` 缺省只生效一次，必须写 `times:2`）。期望 503 `kb_unavailable`，恰两次请求，第二次不带键，`world.logged` 恰一行 `kb_rerank_degraded`。这一行误报是 D3 写明的已知后果。
      - 未配置重排时同样注入 `code:102`：期望 503，恰一次请求，`world.logged` 为 `[]`。
    - 不重试矩阵（已配置重排）：
      - `fault(ROUTE, {kind:"combo", code:101})` 得 400 `kb_rejected`，恰一次请求，没有记录。
      - 超时不降级：`open({kb:{deadlines:{totalMs:50}}})` 配 `fault(ROUTE, {kind:"hang"})`，得 503 `kb_unavailable`，恰一次请求（带 `rerank_id`），`world.logged` 为 `[]`。
    - 源码注释：`retrieval.ts` 文件头的「映射：「检索失败」（本刀不带重排）为 kb_unavailable」原地改写为降级规则。
    - 文档落点（取代 7.2 原文的「system.md 9.13 的检索一节」）：正文写在 `docs/architecture/knowledge-base.md` 的「单轮检索与检索测试」一节，两条 bullet 原地改。
      - 「请求」：配置了重排模型时另带 `rerank_id = <名称>@owb-rerank@OpenAI-API-Compatible`；未配置时连键都不发；探活状态不影响带不带。
      - 「结果」：把「HTTP 200 `code:102` 映射为 503」改写为降级规则。
        - 带了 `rerank_id` 时，去掉它、其余不变，重试恰一次，并写 `{"event":"kb_rerank_degraded"}`。同一进程 60 秒至多一行，不含密钥、地址与 message。应答里没有标记。
        - 没带 `rerank_id` 时（包括那次重试）得 503。
        - 超时、101、404、5xx 都不重试。
        - 写明「`code:102` 不可区分」的后果：非重排引起的 102 也会多一次请求和一行误报，最坏耗时 2×30 s = 60 s。
      - `system.md` 9.13 只在话题清单里加「带重排与自动降级（`kb_rerank_degraded`）」。
      - 验证：`make anti-drift` 退出 0；`git grep -n kb_rerank_degraded -- docs/architecture/knowledge-base.md` 退出 0。
    - 证据：`npm run test:focus --workspace server -- kb-retrieval` 全过（覆盖 kb-retrieval、kb-retrieval-endpoint、kb-retrieval-canonical、kb-retrieval-rerank），7.1 先红；`make lint`、`make typecheck` 退出 0；`retrieval.ts` 不超过 260 行（design 的行数表）。

Suggested fixture level: expanded - 出站请求的重试语义，是「不重试」规则的唯一例外（outbound、shared failure mapping）。
Minimal mergeable slice: atomic - 带 `rerank_id` 与降级必须同时生效：只带不降级，重排故障就让所有检索 503；只有降级没有可降的东西。

## 8. web：检索测试（knowledge-bases「中心「知识库」tab」的检索测试与其场景）

首刀（8.1–8.2）：

- [x] 8.1 测试先行：在 `web/test/api-kb-retrieval.test.ts` 加 `retrieveFromKnowledgeBase` 的严格解析用例（键集 `{hits, retrieval}`，命中键集 `{documentId, name, similarity, content}`，`hits:[]` 解析通过）；`web/test/api-files-archive.test.ts` 的方法清单加它。先看到红。验证：用例先红。
- [x] 8.2 实现：`api-kb.ts` 加 `retrieveFromKnowledgeBase`；`web/src/lib/api.ts` 的 `ApiClient` 导出其类型与方法。验证：`npm run test:focus --workspace web -- api-kb api-files-archive` 全过，`make typecheck` 退出 0。
  - 组 8 首刀约定（#1921 fixture 审查补；8.1–8.2 照此实现与测试）：
    - 档位理由：本刀是 `expanded`，因为公共 API 加了一个严格解析器；ui-walk 属于第二刀。跨服务契约：web 解析器只对照 spec「检索测试端点」的 200 形状，不依赖 #1918 合入。界面要到 8.4 才第一次调用它，先合入不会暴露用户路径。两端形状漂移由 4.4/4.5 端点用例的 `toStrictEqual` 键集和 8.5 的 ui-walk 桩兜住。
    - 签名：`api-kb.ts` 在 `KbIngestResult` 之后导出三个类型：`RetrievalHit = {documentId: string; name: string; similarity: number; content: string}`、`KbRetrievalInput = {question: string; threshold: number; vectorWeight: number}`、`KbRetrievalResult = {hits: RetrievalHit[]; retrieval: BaseView["retrieval"]}`。`ApiClient` 在 `removeKbDocument` 之后加 `retrieveFromKnowledgeBase(id: string, input: KbRetrievalInput, options?: ApiRequestOptions): Promise<KbRetrievalResult>`。`KbMethods` 的 Pick 联合加 `"retrieveFromKnowledgeBase"`。`api.ts` 的 `export type {…} from "./api-kb.js"` 块按字母序加这三个类型名，import 块只加 `api.ts` 自己引用的 `KbRetrievalInput`、`KbRetrievalResult`（不引用的 `RetrievalHit` 进 import 块会被 Biome 判为未使用导入）。`api-kb.ts` 第 5 行的「十三个方法对应十三条路由」改为十四。
    - 请求：作为 `createKbMethods` 返回对象的最后一个成员，写成 `parsed(\`${basePath(id)}/retrieval\`, jsonBody("POST", input, requestOptions(options?.signal)), 200, parseRetrievalResult)`。成功码只认 200。input 原样序列化，不 trim，运行时不剔多余的键（与兄弟方法一致，恰好三键由类型保证）。
    - 请求用例：`id = "kb/1 中"`，fetch 恰调用一次，参数 `toStrictEqual([["/api/kb/bases/kb%2F1%20%E4%B8%AD/retrieval", {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:'{"question":"  口径\\n","threshold":0.2,"vectorWeight":0.7}'}]])`，问句首尾的空白与 `\n` 原样保留，init 里没有 `cache`。另一例传 signal，init 里多出 `signal`。
    - 成功码与错误映射用例都写在新文件里，不往 `api-kb.test.ts` 加 `REQUESTS` 行：
      - 应答 201 得 `requestFailed(201)`。
      - 错误信封原样透传为 `ApiError(status, code, message)`，fetch 只调用一次。至少覆盖 400 `bad_request`、404 `not_found`、409 `kb_rebuilding`、503 `kb_unavailable`、400 `kb_rejected`。
      - 非 JSON 的 500 得 `requestFailed(500)`。
      - `unauthorizedResponseCases()` 三种形态各只通知一次。
      - 只复用 `support.ts` 与本文件已有的 helper（`stub`、`rawJsonResponse`、`textResponse`），不拷贝 `api-kb.test.ts` 的 `it.each` 块（jscpd 也扫测试文件）。
    - 通过用例：每例返回值都 `toStrictEqual` 应答原样。
      - `{hits:[], retrieval:{threshold:0.2, vectorWeight:0.7}}`。
      - 一条命中。
      - 同一 `documentId` 两条命中：次序同应答，不去重。
      - `similarity` 取 0、1，以及区间外的有限数（如 1.5）：web 不校验 0–1，与 `parseRetrieval` 一致。
      - `content` 含 `\n`。
    - 拒绝用例：每行都断言 `expectRequestFailure(error, 200)`。
      - 顶层：`null`、数组、字符串、`{}`；缺 `hits`；缺 `retrieval`；多一键（如 `total:1`）。
      - `hits`：为 `null`、`{}`、字符串。
      - 命中整体：为 `null`；多一键（如 `ragflowDocumentId`）；四键各缺一次。
      - 命中字段：`documentId` 为 1 或 `null`；`name` 为 1；`content` 为 `null`；`similarity` 为 `"0.9"`、`null` 或 `true`；`similarity` 为 `NaN`（用 `rawJsonResponse`）；`similarity` 为 `1e999` 溢出成的 `Infinity`（用 `textResponse`，并断言文本里含 `1e999`）。
      - 好坏混排：一条好的命中加一条坏的，整份应答得 `requestFailed`。
      - `retrieval` 子对象：本文件已有的 `REJECTED` 列表包进 `{hits:[], retrieval}` 后逐条断言，不另写第二份。
    - 单一实现：
      - `parseRetrievalResult` 先用 `hasExactlyKeys(value, ["hits","retrieval"])`；`hits` 走 `parseJsonArray(value.hits, parseRetrievalHit)`；`retrieval` 调既有的 `parseRetrieval`。
      - `parseRetrievalHit` 用 `hasExactlyKeys` 查四键，三个字符串字段用 `typeof === "string"`，`similarity` 用既有的 `isFiniteNumber`，不新写数值判定。
      - 两个解析器放在 `parseIngestResult` 之后。`parseRetrieval` 与 `BaseView` 一字不改。
    - 方法清单：`web/test/api-files-archive.test.ts` 的 `OTHER_CLIENT_METHODS` 在知识库组 `"removeKbDocument"` 之后加 `"retrieveFromKnowledgeBase"`（键集比较，不比次序）。`web/test/api-kb-retrieval.test.ts` 的头注释加一行「组 8 首刀（#1921）」及规格出处。
    - 必须保持：`web/test/api-kb.test.ts` 不动，包括 `REQUESTS`、`SHAPES` 的十三行和「十三个」字样；既有十三个方法的请求与解析行为不变；不改 `features/`。
    - 行数：D11 对 `api-kb.ts` 的预计是 ≤600，加上 #1917 的 `rerank` 之后会超。硬上限 800 不变，超出预计照 #1912 的先例在 PR「偏离记录」里写明。

第二刀（8.3–8.6）：

- [x] 8.3 测试先行：新 `web/test/center-kb-retrieval.test.tsx`，覆盖「检索测试的命中与空态」「检索测试的参数与禁用」「清空数字字段」「Enter 检索」「检索测试只在 ready 时出现」「检索失败」「失败后列表与服务端一致」。先看到红。验证：用例先红。
- [x] 8.4 实现 design D8 的检索测试：新 `web/src/features/center/kb/retrieval-panel.tsx` 与 `use-retrieval.ts`；`detail.tsx` 在 `ready` 时渲染它；成功后经回调更新列表里该库的 `retrieval`，失败且参数有变时重取列表。验证：`npm run test:focus --workspace web -- center-kb` 全过。
- [x] 8.5 ui-walk：新 `web/e2e/ui-walk-center-kb.ts`，在 `web/e2e/ui-walk.spec.ts` 里注册。用 `page.route(...).fulfill`（先例 `web/e2e/ui-walk-layout.ts:71`）应答 `/api/kb/status`（开启、可用、嵌入就绪）、`/api/kb/bases`、`…/documents` 与 `…/retrieval`（一次有命中、一次 `hits:[]`），在桌面与 390 px 两种宽度下打开知识库详情、检索、看到命中与空态，过 error oracle；结束前 unroute。验证：`make ui-walk` 退出 0；PR 附两种宽度的截图。
- [x] 8.6 验收清单：`docs/acceptance/functional-checklist.md` 的「中心·知识库（CK）」节加 CK-13（检索测试：命中显示序号、文档名、两位小数的相似度与切片原文，没有来源路径与切片序号；无命中的文案；改参数检索后刷新页面参数仍在；桌面与手机宽度、浅色与深色主题下布局不溢出、文字可读），结论 `待签`。验证：`npm run test:focus --workspace web -- functional-checklist` 全过。
  - 组 8 第二刀约定（#1922 fixture 审查补；8.3–8.6 照此实现与测试）：
    - 列表重取必须走静默路径：`use-kb.ts:65-71` 的 `load()` 会先把视图置为 `{status:"loading"}`，并且重读 `getKbStatus`；而 `panel.tsx:36-37,87` 只在视图为 `ready` 时才渲染详情。所以失败后的重取不得用 `kb.reload()` 或 `load()`，否则详情会卸载，面板的 alert 和用户输入都会丢，「检索失败」「失败后列表与服务端一致」两个场景同时变红。`use-kb.ts` 照 `setDocumentCount` 的写法加 `setRetrieval(id, retrieval)`，值相同时不改状态。本地改动列表的路径（`setRetrieval`（检索成功，不论行值是否变化：成功意味着服务端有一次晚于在途读取的写入）、`setDocumentCount`（只在文档数真的变了时：详情每次读文档都会报数，解析中每 3 秒一次，无条件作废会让最长约 5 秒的重取永远落不了地）、新建成功、删除成功）都要作废在途的静默重取：若有在途重取，就再发一次 `refetchBases()`，靠序号丢弃旧应答（#1944 审查：旧应答可能读于本地改动之前，整表覆盖会把列表改回旧值）。另加 `refetchBases()`：只调 `client.listKnowledgeBases()`，视图保持 `ready`；成功只换 `bases`，失败不改视图、不写 notice；用 `sequence` 防旧应答覆盖（照 `use-documents.ts:63-77` 的 `quiet` 先例）。用例要断言失败后 `getKbStatus` 的调用数不变，alert 和三个输入框的值都还在。
    - 接线：`KnowledgeBaseDetail` 加两个 props，`onRetrieval(retrieval: BaseView["retrieval"])` 和 `onRefetchBases()`。`panel.tsx` 传入 `(r) => kb.setRetrieval(detailBase.id, r)` 和 `kb.refetchBases`。PR 边界写明这两个文件以及 `web/test/center-kb-support.tsx`。
    - 面板的状态模型：问句和两个数字都存成原始字符串，挂载时从 `base.retrieval` 用 `String(n)` 初始化一次（不用 `toFixed`）；之后 `base` prop 变化不覆盖输入，换库靠 detail 的 `key` 重挂载。「面板初值」baseline 放在 `use-retrieval.ts` 里，只有成功应答的 `retrieval` 能替换它；成功时两个数字字段改写为应答值，问句保留。「参数有变」的判定在提交时取当次发出的两个数值，与当时的 baseline、以及列表里该库当前的 `retrieval`（`base` prop）各做数值比较（D4「数值相等」），任一不同即为有变（#1944 审查裁定：覆盖「先失败写回 0.3、改回 0.2 又失败」时 baseline 仍是 0.2 而列表已是 0.3 的情形）。问句原样发出、不 trim，只在判定空白时 trim；客户端不查长度和控制字符，服务端回的 400 文案走 alert 显示。
    - 数字字段：用 `type="number" inputMode="decimal" min={0} max={1} step={0.01}`。有效性只按字符串判定：去空白后非空、`Number.isFinite(Number(raw))`、0≤v≤1，不读 `validity`，所以 0.123 也合法。三种无效情况共用一条原因文案 `填 0 到 1 之间的数字`，经 `aria-describedby` 关联并带 `aria-invalid`，字段组件复用 `models/form-parts.tsx` 的 `TextField`（跨 feature 引用有先例：`models/kb-section.tsx:12` 引 `../kb/list.js`），不另写第四份。问句空白时只禁用按钮、不显示原因（初始态就是空白，显示原因只是噪音；PR 里注明这是对规格的解读）。8.3 注明：jsdom 会把 number 输入框里的 `abc` 净化成 `""`，所以 `abc` 一例断言的是同一条原因。
    - 可访问名称（固定下来，供用例和 ui-walk 定位）：面板根是 `<section aria-labelledby>`，配 `<h4>检索测试</h4>`，即 `getByRole("region",{name:"检索测试"})`。问句框 `aria-label="检索问句"`，placeholder 照 demo。两个数字框的 label 分别是 `相似度阈值`、`向量权重`。按钮为 `type="button"`，文字 `检索`，在途时为 `正在检索`。
    - Enter 与防重复提交：不用 `<form>`。只在问句框挂 `onKeyDown`，先照 `conversation-search.tsx:92` 判 `event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229` 并直接返回，再判 `key==="Enter"`，然后 `preventDefault`，走与按钮同一个 `submit()`。`submit()` 自己再查一遍有效性和在途标记（`useRef`，先例 `use-kb.ts:63`）。数字框里按 Enter 不提交（demo 只给问句框绑了 Enter）。8.3 另加两例：一是 `fireEvent.keyDown(input,{key:"Enter",isComposing:true})`，期望零次调用；二是请求挂起期间再点一次、再按一次 Enter，期望仍只有一次调用。
    - 卸载与过期应答：请求不 abort。`use-retrieval.ts` 用序号 ref，卸载后或有更新的提交时，丢弃面板本地的 setState。但 `onRetrieval` 与 `onRefetchBases` 照常调用：它们更新的是父组件按库 id 定位的状态，换库后列表仍要与服务端写回一致（D8 的不变量）。8.3 加一例：参数有变的检索挂起时切到别的库，放行成功后列表里原库的 `retrieval` 是新值，切回来初值也是新值；失败变体放行后恰一次 `listKnowledgeBases`。
    - 结果区：未检索时显示 `输入问题后检索，命中切片会带出所属文档`。在途时保留上一次的结果；每次提交先清掉 alert；成功后替换结果；失败时清掉命中，只显示 alert（`role="alert"`，文案用 `ingest-tree.tsx:12` 导出的 `messageOf`，不再复制一份）。命中用 `<ol>`，每条 `#${i+1}`、`hit.name`、`相似度 ${hit.similarity.toFixed(2)}`，原文用 `whitespace-pre-wrap [overflow-wrap:anywhere]`，文档名也加 `[overflow-wrap:anywhere]`。React key 用下标，不用 `documentId`：同一文档允许出现多条命中，用它做 key 会产生重复 key 的 console 报错，ui-walk 的 error oracle 会变红。
    - 渲染条件：面板只看 `base.state === "ready"`，与文档表处于读取中、失败、0 份哪种状态都无关，放在文档表区域之后、`IngestDialog` 之前。
    - 断言范围：「页面不出现来源路径与 `切片`」一律用 `within(检索测试 region)` 限定。同一详情里文档表本身就显示 `已切片 N` 和 `<空间名>/<路径>`，按整页断言会和既有行为冲突。CK-13 的行文同样写「检索结果里」。
    - 测试夹具：`web/test/center-kb-support.tsx` 的 `fakeKb` 原地加 `retrieveFromKnowledgeBase: vi.fn`，记进 `calls`。缺省行为模拟服务端写回：参数与库里存的不同就改库的 `retrieval`，再返回 `{hits:[], retrieval}`。另返回 `setRetrievalOf(id, r)`（改此后 `listKnowledgeBases` 的应答，供「失败后列表…」一例先写回再抛 503），命中和挂起都用 `mockImplementationOnce` 给出。「失败后列表…」一例要有两个库，才能切走再切回。新用例全部放 `web/test/center-kb-retrieval.test.tsx`，既有的 `center-kb-*.test.tsx` 不动。
    - ui-walk 注册：在 `ui-walk.spec.ts` 里另写一个 `test()`，有自己的 `runWithBrowserErrorOracle`，复用 `ui-walk-composer.ts` 的 `login()` / `logout()`（oracle 每个 test 只认一轮登录和登出）。主旅程和 `ui-walk-center.ts` 不动。新分支不得对 `/center` 调 `expectAuthenticatedRoute`：它会经 `expectCenterRoute` 跑到 `expectKbTabAbsent`（`ui-walk-center.ts:21`），而知识库已被桩成开启，必然失败。改为直接 `page.goto("/center?tab=knowledge-bases")`。
    - ui-walk 路由桩：在 goto 之前装好，分别是 `**/api/kb/status`、`**/api/kb/bases`（只应答 GET，其余方法 `route.fallback()`）、`**/api/kb/bases/*/documents`、`**/api/kb/bases/*/retrieval`。应答体必须严格符合 `api-kb.ts` 的键集：`STATUS_KEYS` 六键（`enabled/available/embeddingReady:true`），`BASE_KEYS` 十一键（库 id 只用 URL 安全字符，如 `kb-walk`，`state:"ready"`，`retrieval:{threshold:0.2,vectorWeight:0.7}`），`DOCUMENT_KEYS` 十一键（`status:"done"`，免得触发 3 秒刷新）。键集不符界面会直接 `requestFailed`。retrieval 桩带计数：第一次回两条命中，其中一条原文含 `\n` 和一串 40 个以上字符、不断行的 ASCII 串，另一条文档名很长；第二次回 `hits:[]`。断言共两次请求，第一次的 `postDataJSON()` 恰为 `{question,threshold:0.2,vectorWeight:0.7}`。`/api/workspaces` 走真实服务。四个桩都在 `finally` 里 unroute。
    - ui-walk 断言：两种宽度由 Playwright 的两个 project 提供（desktop-light 1440 浅色、mobile-dark 390 深色），不用 `withViewport`。命中出现后、空态出现后各查一次横向溢出：把 `ui-walk-layout.ts:152` 的 `expectNoHorizontalOverflow` 原地改成导出，不复制。命中断言 `#1`、`#2`、两位小数的相似度、原文换行；再断言 region 内没有 `切片`。不走失败路径：4xx/5xx 会让 Chromium 记一条 console error，oracle 只放行 `/api/auth/me` 的 401（`ui-walk-layout.ts:65-66`）；失败路径由 jsdom 用例覆盖，PR 里写明。
    - 截图来源要固定：配置是 `screenshot:"off"`，`outputDir` 也是 `preserveOutput:"never"`，现有 e2e 没有截图先例。建议在新分支里加一个受环境变量控制的 `page.screenshot`，例如设了 `UI_WALK_SHOT_DIR` 才写，文件名带 project 名，写到 scratchpad，不入库。不设时不截图，CI 行为不变。
    - CK-13 的操作列要写全（现在 8.6 只有期望要点），照 CK-11/12 的格式。示例：「由 owner 执行（agent 不得代签）。接 CK-06（「规范库」里有已切片的 `manual.pdf`）；以成员账号 `zhangsan` 点「规范库」一行，看文档表下方的「检索测试」；问句填 `manual.pdf` 里出现过的一个词，按 Enter；再把问句换成一串无意义的字母，点「检索」；把「相似度阈值」清空，看按钮；填回 `0.1` 后检索，刷新页面再点「规范库」一行；最后把阈值改回 `0.2` 检索一次。在桌面宽度与宽度 390、浅色与深色主题下各看一遍」。期望列写：未检索提示文案；命中带 `#1` 起的序号、文档名、`相似度` 加两位小数和保留换行的原文；检索结果里没有来源路径和「切片」字样；无命中时的文案；阈值为空时按钮不可点，字段旁有原因；刷新后阈值仍是 `0.1`；布局不溢出、文字可读；页面没有其它错误提示。结论 `待签`。这段文字过得了守卫（`#1`、`0.68`、「宽度 390」都合规，不写 `px`，也不出现点号或井号紧跟字母或中文的写法）。
    - 风险包补一行（本刀）：一是列表与服务端不一致，落点是「失败后列表…」一例和换库中途一例；二是并发提交，落点是 ref 防重复和挂起期间的二次点击一例；三是过期应答，落点是序号和换库一例；四是跨服务形状漂移，落点是 ui-walk 桩的严格键集。
    - 必须保持：`detail.tsx` 在非 ready 下的按钮规则、`DocumentsTable`、`IngestResults` 不变；其它 tab 不变；`web/src/lib/` 和服务端不改；`center-kb-detail/list/ingest`、`api-kb*.test.ts`、`ui-walk-center.ts` 和主旅程原样全绿。
    - 行数：`retrieval-panel.tsx`、`use-retrieval.ts` 各 ≤200 行（D11）。`use-kb.ts`（157 行）、`detail.tsx`（115 行）、`center-kb-support.tsx`（322 行）、`ui-walk.spec.ts`（683 行）都还有余量，硬上限 800。

Suggested fixture level: expanded - 前端通用契约：涉及呈现的 web 任务至少 `expanded`（真实浏览器 + 视口矩阵，由 8.5 的 ui-walk 分支承担）。
Minimal mergeable slice: 8.1–8.2 为首刀：API 方法是 `createKbMethods` 返回对象的成员，knip 不查对象成员，web entry 也含 `test/**/*.test.ts`，被解析用例调用即可独立保绿（S2a 组 15 首刀先例）。第二刀 8.3–8.6（面板、hook、详情、ui-walk、CK 行；CK 行与它交付的界面同 PR，签收规则）依赖首刀与组 2、组 4。

## 9. web：模型 tab 的重排模型（model-registry「模型 tab」的重排模型与改名后的探活调用）

- [x] 9.1 原地重构：`kb-embedding-dialog.tsx` 改名 `kb-model-dialog.tsx`，加 `kind` 属性，嵌入模型的行为与文案不变（标题、重建确认只对嵌入生效）。测试先行：`web/test/center-models-kb.test.tsx` 里既有嵌入对话框与「更换嵌入模型需确认」用例原样全绿。验证：`npm run test:focus --workspace web -- center-models-kb` 全过（vitest 输出里能看到该文件）；`git grep -n kb-embedding-dialog -- server web docs/architecture` 退出 1。
- [ ] 9.2 测试先行：在 `web/test/center-models-kb.test.tsx` 加「重排模型」场景（编辑、保存后探活、`探活`、`清除` 的取消与确认）；实现 `kb-section.tsx` 的重排模型一行与清除确认框（拷入层 alert-dialog）。`web/e2e/ui-walk-center-kb.ts` 加一段：`/api/kb/status`（`enabled:true`）与 `/api/kb/settings`（已配置重排模型）由 route 应答，改以管理员 `lisi` 登录（模型 tab 是 `adminOnly`，成员访问 `GET /api/models` 为 403，会让 error oracle 变红）。这一段在 `web/e2e/ui-walk.spec.ts` 里是独立的 `test()`，有自己的 page 与 oracle（oracle 每个 `test()` 只认一轮登录与登出，`ui-walk-oracle.ts:186-195`）；`web/e2e/ui-walk-composer.ts` 的 `login()` 原地加 `account` 参数（缺省 `zhangsan`，密码同为 `demo`），不另写登录函数；在桌面与 390 px 宽度下打开模型 tab 看到重排模型一行，过 error oracle。验证：`npm run test:focus --workspace web -- center-models-kb` 全过；`make ui-walk` 退出 0；PR 附两种宽度的截图。
- [ ] 9.3 验收清单 CK 节加 CK-14（管理员配置重排模型、探活、清除；配置后成员的检索测试照常有结果；桌面与手机宽度、浅色与深色主题下布局不溢出），结论 `待签`。验证：`npm run test:focus --workspace web -- functional-checklist` 全过。

Suggested fixture level: expanded - 前端通用契约：涉及呈现的 web 任务至少 `expanded`（真实浏览器由 9.2 的 ui-walk 段承担）。
Minimal mergeable slice: 9.1（对话框的改名与泛化，嵌入行为不变）可独立合入保绿；9.2–9.3 依赖它与组 6（第三刀 6.6）、组 7、组 8。

## 10. 真实端点冒烟（verification-harness「知识库真实端点冒烟」）

- [ ] 10.1 `smoke/kb.hurl`：在 `smoke-kb` 库两份文档都 `done` 之后，以夹具 `notes.md` 里的专名（如 `北礁观测站由谁值守`）、`threshold:0`、`vectorWeight:0.7` 检索，断言 200、`hits` 非空、首条 `name` 为 `notes.md`、`retrieval` 为 `{threshold:0, vectorWeight:0.7}`；文件头注释的步骤与端点说明同步。同一 PR 改写验收清单 CK-11 的期望，加上这条检索断言，结论回到 `待签`（owner 重跑 `make smoke-kb` 签收）。验证：`make test-guardrails` 退出 0；`hurlfmt --out json smoke/kb.hurl > /dev/null` 退出 0（只解析，不发请求）；`npm run test:focus --workspace web -- functional-checklist` 全过。真实运行由 CK-11 承担，PR 写明。

Suggested fixture level: compact - 只改冒烟用例与验收行，不改产品代码；冒烟不进 CI 必需检查。
Minimal mergeable slice: atomic - 冒烟断言与 CK-11 的期望必须同 PR（签收规则：改变验收对象的 PR 同时把对应行写为 `待签`）。

## 11. 收口

- [ ] 11.1 `IMPLEMENTATION_PLAN.md` 的 S2b 状态与 Next Step 更新；核对 design「Grill 结论」每一行都有落点；`npx openspec validate s2b-kb-retrieval --strict --no-interactive` 通过。验证：命令退出 0；`make check` 退出 0。

Suggested fixture level: none - 只改计划文档，没有运行时行为。
Minimal mergeable slice: atomic - 收口只有一条验证路径（全部组合入后的状态核对），依赖组 1–10 全部。
