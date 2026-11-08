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
| 凭证泄露（重排上游密钥进响应、审计、日志；RAGFlow 的重排报错体带出上游信息） | 是 | 组 3 结果不含 message、组 6 读视图与审计哨兵、组 7 降级记录不含 message |
| 两份真相（本地参数 vs RAGFlow 缺省；命中关联不上本地文档） | 是 | 组 4 参数恒显式传、命中丢弃 |
| 并发（写回与重建、与其它写操作交错；并发的相同提交） | 是 | 组 4 第二刀的写锁用例 |
| 外部接口漂移（rc2 预发行版；`code:102` 不可区分） | 是 | 组 3 夹具只按 §19 写、组 7 的降级后果用例、组 10 真实冒烟（CK-11） |
| 权限（他人知识库可探测、非管理员配重排） | 是 | 组 4 的 404 矩阵、组 6 的 403 |
| 迁移与 DB 约束 | 是 | 组 1 |
| 跨服务契约（视图加键而 web 严格解析） | 是 | 组 2、组 6 同 PR 改两端 |
| 共用外部资源（账号缺省被改动） | 是 | 组 6：重排排在最前、不发 `PATCH /models/default`，请求序列断言 |

## 1. 迁移 051 与 store（knowledge-bases「迁移 051 检索参数与重排模型」）

- [x] 1.1 核对 Context：`050_knowledge_bases.sql`、`033` / `035` 的 `ADD COLUMN` 写法、`server/test/core-db-helpers.ts` 的跟踪清单、receipts 与 `sequenceRows`、`server/test/core-db-chat-step-output.test.ts` 与 `server/test/migration-034.test.ts`（`seed033Database`）的迁移排除链、`server/test/kb-schema.test.ts`、`server/src/kb/store.ts` 的 `settings()` / `saveSettings` / `recordEmbeddingProbe` 与知识库行的读写。验证：在 issue 里列出要改的函数与行号。
- [x] 1.2 测试先行：在 `server/test/kb-schema.test.ts` 加 051 的用例，覆盖「列与约束」场景（050 库上应用后两列取缺省；三处非法更新被拒：`1.5`、`-0.1`、非数字文本 `'abc'`；`1` 存成 `real`；重排三列为 NULL；`rerank_probe_status` 为 `never`），先看到红；新 `server/src/core/db/migrations/051_kb_retrieval.sql` 按 design D5 实现。另加一条「不改其它表」用例（仿 049→050 那条）：050 库里预置一行既有列取非缺省值的 `knowledge_bases` 与一行嵌入已配置的 `kb_settings`，升级后既有列值不变、其它表的 `sqlite_master` 不变、receipt 为 `[25, MIGRATION_051]`、`sequenceRows` 为 `["schema_migrations", 25, "integer"]`。`kb-schema.test.ts` 里打开完整迁移链的 050 形状断言（`kb_settings` / `knowledge_bases` 的 `tableInfo` 全列清单、`kb_settings` 整行 `toEqual`）原地改成 051 之后的形状，不另起一份。原地改 `core-db-helpers.ts` 的跟踪清单（加 `MIGRATION_051`）、receipts 与 `sequenceRows`，以及 `core-db-chat-step-output.test.ts`、`migration-034.test.ts` 的迁移排除链。验证：`npm run test:focus --workspace server -- kb-schema core-db migration-034` 全过。
- [ ] 1.3 store：知识库行读出 `retrievalThreshold` / `retrievalVectorWeight`；新增「在同一事务里写两列并执行回调」（审计由调用方在回调里写）；设置读出 `rerank`（名称、地址、探活，不含密钥）与单独的重排密钥读取；整组写、清空重排三列；写回重排探活结果（只写回同一身份）。测试先行：检索参数的读写用例加在 `server/test/kb-store.test.ts`，重排三列的用例与「重排三列整组写入」场景加在 `server/test/kb-store-settings.test.ts`。验证：`npm run test:focus --workspace server -- kb-store` 全过，`store.ts` 不超过 800 行。

Suggested fixture level: expanded - 迁移与持久化状态（migration、persisted state）。
Minimal mergeable slice: 1.1–1.2（迁移文件与 schema 用例）可独立合入保绿：只加列，既有代码不读它们；1.3 的 store 读写依赖它。

## 2. `BaseView.retrieval`（knowledge-bases「知识库端点」的视图与 201 应答）

- [ ] 2.1 测试先行：
  - `server/test` 里断言 `BaseView` 恰为十一个键的既有用例原地改（列表、建库 201，含「建库应答不读 RAGFlow」的 `retrieval:{threshold:0.2, vectorWeight:0.7}`），先看到红。
  - 新 `web/test/api-kb-retrieval.test.ts`：带 `retrieval` 的 `BaseView` 解析通过，缺 `retrieval` 或类型不符为 `requestFailed`。
  验证：两组用例先红。
- [ ] 2.2 实现：`server/src/kb/bases.ts` 的 `viewOf` 加 `retrieval`；`web/src/lib/api-kb.ts` 的 `BaseView` 类型与解析器加 `retrieval`。两端在同一 PR。`docs/architecture/knowledge-base.md` 列举 `BaseView` 键的那一处加 `retrieval`。验证：`npm run test:focus --workspace server -- kb-bases`、`npm run test:focus --workspace web -- api-kb` 全过，`make typecheck` 退出 0。

Suggested fixture level: expanded - 改公共 API 的应答形状（public API），web 的严格解析器要同步。
Minimal mergeable slice: atomic - 服务端加键与 web 解析器必须同 PR，任何一半单独合入都会让知识库 tab `requestFailed`（`web/src/lib/api-kb.ts` 以 `hasExactlyKeys` 严格比对键集）。

## 3. 假 RAGFlow 检索路由与客户端（ragflow-backend「RAGFlow 接口实测记录」的检索覆盖、「RAGFlow 出站请求」的 `POST /retrieval` 一行）

- [ ] 3.1 核对 Context：实测记录续篇 §19.1–§19.6；`server/test/support/fake-ragflow.mjs` 的 `ROUTES` 与兄弟文件写法；`server/src/kb/ragflow-models.ts` 的 `modelCalls(json)` 并入方式；`ragflow-route.ts` 的 `Route` 与 `API` 常量。验证：在 issue 里列出 §19 里协议应答的键与码。
- [ ] 3.2 测试先行：新 `server/test/support/fake-ragflow-retrieval.mjs`（加 `.d.mts`），挂到 `ROUTES`：
  - `POST /api/v1/retrieval` 回 §19.1 形状的 `{chunks, doc_aggs, labels, total}`，切片键取 §19.1 那十六个；零命中回 §19.1 的原样 `{chunks:[], doc_aggs:[], labels:null, total:0}`。
  - 命中由用例脚本化（数据集 → 切片列表与分数），夹具不实现检索算法。
  - 协议应答：§19.1 表里六条 `code:101` 与不存在数据集的 `code:404`；`rerank_id` 指向不存在的模型时回 `code:102`（§19.4）。
  - 故障注入：「带 `rerank_id` 时回 `code:102`」开关；「任意检索请求回指定 `code`（101 / 102，不论是否带 `rerank_id`）」；切片缺字段；挂起。
  - 记录收到的 JSON body。
  附夹具自测（覆盖两种 `code` 注入与零命中）。验证：夹具自测全过。
- [ ] 3.3 新 `server/src/kb/ragflow-retrieval.ts`：检索路由（路径以 `${API}/retrieval` 拼），`code:102` 为类型化结果「检索失败」，读 `data.chunks`（须是数组，零命中为 `[]`）的 `document_id`、`content`、`similarity`，`chunks` 不是数组或缺字段即 `kb_unavailable`。经 `retrievalCalls(json)` 并入 `createRagflowClient`，`ragflow-client.ts` 只加并入的一行。测试先行：新 `server/test/kb-ragflow-client-retrieval.test.ts`：成功读取、零命中为空数组、`102` 为检索失败、`101` 为 `kb_rejected`、`404` 为 `kb_unavailable`、缺字段、结果与 stderr 不含 message 哨兵。验证：`npm run test:focus --workspace server -- kb-ragflow-client-retrieval` 全过，`ragflow-client.ts` 行数增加不超过 5 行。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials）与新的类型化失败映射。
Minimal mergeable slice: atomic - 夹具与客户端路由共一条验证路径：客户端用例只能对夹具跑（真 RAGFlow 不进 CI），夹具的协议应答只有客户端用例消费；单独合入夹具，它的自测只证明自洽，不证明协议映射（S2a 组 5 先例）。

## 4. 单轮检索与检索测试端点（knowledge-bases「单轮检索」「检索测试端点」「`kb_search` 工具契约」「同一知识库的写操作串行」「知识库审计」的 `kb.retrieval_settings`、「知识库端点」的所有权矩阵；http-service-skeleton「统一错误信封」；ragflow-backend「知识库可用性」）

首刀（4.1–4.3）：

- [ ] 4.1 测试先行：新 `server/test/kb-retrieval.test.ts`，直接调用单轮检索函数（真实 SQLite 与 store，接假 RAGFlow），覆盖「单轮检索」的「参数显式传」「命中关联本地文档」「应答缺字段」「零命中」，以及全部命中关联不上时为空数组。先看到红。验证：用例先红。
- [ ] 4.2 新 `server/src/kb/retrieval.ts`：按 design D1、D2 实现单轮检索（本组不带 `rerank_id`，不写回）。验证：4.1 全过，`make lint`、`make typecheck` 退出 0。
- [ ] 4.3 新 `server/test/kb-retrieval-canonical.test.ts`（「单轮检索」的「只有一处检索实现」与「`kb_search` 工具契约」的「契约与检索测试同源」）：扫描 `server/src`，断言客户端检索方法的调用（方法名以 3.3 定的为准）只出现在 `kb/retrieval.ts`，路由片段 `/retrieval` 只出现在 `kb/ragflow-retrieval.ts`，`kb_search` 不出现在任何注册或分派里。验证：用例全过；变异：在 `kb/rest.ts` 加一次对客户端检索方法的调用，用例变红（手动变异一次，记录在 PR）。

第二刀（4.4–4.6）：

- [ ] 4.4 测试先行：新 `server/test/kb-retrieval-endpoint.test.ts`（`buildApp` + `app.inject()`，真实 SQLite，接假 RAGFlow），覆盖「检索测试端点」全部场景（含零命中与全部关联不上、写回排在入库之后、排队时库被删除、并发的相同提交、写回与重建交错：用 S2a 的锁注入让重建器持锁），以及「知识库审计」的「detail 不含敏感内容」里含哨兵问句的检索写回一支。计数断言原地改：
  - `server/test/kb-disabled.test.ts`：「未配置即关闭」十二条扩到十三条。
  - `server/test/http-parser-owners.test.ts`：归属集三十八条扩到三十九条（`:201`），其中 POST 三十条扩到三十一条（`:205`），加检索路由的 malformed / 空 / `text/plain` 三例。
  - 检索路由的所有权（别人的 id、不存在的 id 各一次，合法 body 且参数与已存值不同，断言 A 库的检索参数不变）写进新文件 `server/test/kb-retrieval-endpoint.test.ts`。「文档路由的所有权」是五个既有文件各测自己那条路由（`kb-ingest-workspace`、`kb-documents-list`、`kb-documents-remove`、`kb-documents-reingest`、`kb-upload`），规格里的「十二次」是六条路由的合计，不改这五个文件（其中 `kb-documents-reingest.test.ts` 已 780 行）。
  先看到红。验证：用例先红。
- [ ] 4.5 实现 design D4：`server/src/kb/retrieval.ts` 加 body 校验与写回编排（经 `locks.write`，锁内重读再比较，回调里写 `kb.retrieval_settings`）。`server/src/kb/rest.ts` 注册 `POST /api/kb/bases/:id/retrieval`（`ownedBase` preParsing、body limit 16 KiB、no-store）；`server/src/http/errors.ts` 的归属集加这条身份；`index.ts` 装配。验证：`npm run test:focus --workspace server -- kb-retrieval kb-disabled http-parser-owners` 全过，`make lint`、`make typecheck` 退出 0。
- [ ] 4.6 文档：`docs/architecture/system.md` §2 的 `kb` 行把 S2a 之前的占位 `search(principal, query, kbRefs)` 换成单轮检索与检索端点，第 51 行附近「agentic 环…由 S2b 定」改为指向 ADR-0017；9.13 加「单轮检索与检索测试」一节（请求形状、参数显式传的理由、写回规则、命中关联）；`docs/architecture/knowledge-base.md` 加检索参数的缺省值与「候选由全文匹配圈定」的已知行为（引用续篇 §19.1）。验证：`make anti-drift` 退出 0；`git grep -n "由 S2b 定" -- docs/architecture` 退出 1。

Suggested fixture level: expanded - 新的公共端点、权限、持久化写回与并发（public API、auth、persisted state、concurrency）。
Minimal mergeable slice: 4.1–4.3 为首刀：`retrieval.ts` 的单轮检索（不带重排、不写回）与它的直接用例、源码扫描用例。knip 的 server entry 含 `test/**/*.test.ts`，被用例导入的导出不判死代码（S2a 组 15 先例），首刀独立保绿。第二刀 4.4–4.6（端点、写回、锁、审计、计数原地改、文档）依赖首刀与组 2。

## 5. 探活泛化为两种目标（ragflow-backend「知识库模型设置」的探活；行为不变的重构）

- [ ] 5.1 核对 Context：`server/src/kb/embedding-probe.ts` 全文与它现有的 HTTP 层用例（`server/test/kb-settings-probe.test.ts`）、`settings.ts` 的 `probeOnce`。验证：在 issue 里列出路径、body 与 2xx 判定三处写死的点。
- [ ] 5.2 原地重构：`embedding-probe.ts` 改名 `model-probe.ts`，`probeEmbedding` 泛化为按目标取路径、body 与 2xx 判定（design D7），嵌入目标的行为逐字不变。新 `server/test/support/fake-upstream-rerank.mjs`（照 `fake-upstream-embeddings.mjs` 的兄弟文件写法）提供 `POST /rerank`。测试先行：模块改名后 `kb-settings-probe.test.ts` 原样全绿；新 `server/test/kb-model-probe.test.ts` 加重排目标的单元用例（`POST <base>/rerank`、body `{model, query:"ping", documents:["ping"]}`、`results[0].relevance_score` 为数字为 `ok`、401 / 503 / 空 `results` 为 `failed`、错误摘录不含密钥与地址），先红后绿。验证：`npm run test:focus --workspace server -- probe` 全过；`git grep -n embedding-probe -- server web docs/architecture` 退出 1。

Suggested fixture level: compact - 行为不变的重构加一个新的出站目标，没有公共 API、schema 或权限变化；嵌入探活的既有用例原样全绿即证明不变。
Minimal mergeable slice: atomic - 改名与按目标参数化改的是同一个函数签名与同一批调用点，拆成两步只会让两个 PR 改同一批行，中间状态没有可单独验证的行为；重排目标此时只有单元用例调用，端点接线在组 6。

## 6. 重排模型的设置、下发与探活端点（ragflow-backend「知识库模型设置」；knowledge-bases「知识库审计」的 `kb.settings` 行）

- [ ] 6.1 测试先行：新 `server/test/kb-settings-rerank.test.ts`，覆盖 ragflow-backend「知识库模型设置」的「重排模型的下发序列」「换重排模型不重建」「清除重排模型」「重排模型的密钥与名称」「重排模型下发失败」「组合保存时重排失败」，以及 knowledge-bases「detail 不含敏感内容」的设置一支带 `rerank.apiKey` 哨兵。新 `web/test/api-kb-rerank.test.ts`：设置读视图带 `rerank` 才解析通过。先看到红。验证：用例先红。
- [ ] 6.2 实现 design D6：`settings.ts` 解析 `rerank`；保存时重排一轮排在嵌入、对话之前，失败即停；`Provision` 加 `modelType:"rerank"`，这时不发 `PATCH /models/default`；清除只改本地；读视图加 `rerank`；审计 detail 加 `rerank`。假 RAGFlow 的实例路由接受 `model_type:["rerank"]`（若有白名单）。同一 PR：`web/src/lib/api-kb.ts` 的设置视图解析与 `updateKbSettings` 的 input 加 `rerank`。验证：`npm run test:focus --workspace server -- kb-settings`、`npm run test:focus --workspace web -- api-kb` 全过，`make typecheck`、`make lint` 退出 0，`settings.ts` 不超过 800 行。
- [ ] 6.3 测试先行：在 `server/test/kb-settings-rerank.test.ts` 加「重排探活」「探活目标的取值」、「非管理员」对 `?target=rerank` 的 403、http-service-skeleton「知识库的归属路由」对 `POST /api/kb/settings/probe?target=rerank` 携 `{}` 的 400。先看到红。验证：用例先红。
- [ ] 6.4 实现 design D7：`rest.ts` 的探活路由读 `target`（缺省、`embedding`、`rerank`；其它、重复、空值为 400；未配置重排时 400 `bad_request`）；`settings.ts` 的重排探活写回只写同一身份、排在同一条探活 Promise 链上，审计 `kb.settings` detail `{rerankProbe}`。验证：`npm run test:focus --workspace server -- kb-settings` 全过，`make typecheck`、`make lint` 退出 0。
- [ ] 6.5 文档：`docs/architecture/system.md` 9.13 的知识库模型一节加重排模型（实例 `owb-rerank`、排在最前下发、不设账号缺省、清除只改本地、探活 `?target=rerank`）；`docs/architecture/knowledge-base.md` 的运维说明加「`owb-rerank` 不是账号缺省，删除没有 §13 的风险」。验证：`make anti-drift` 退出 0。
- [ ] 6.6 web 原地改名：测试先行，`web/test/api-kb-rerank.test.ts` 加 `probeKbModel("rerank")` 发 `?target=rerank`；`web/test/api-kb.test.ts`、`web/test/api-files-archive.test.ts`、`web/test/center-models-kb.test.tsx` 里的旧名原地改。实现：`web/src/lib/api-kb.ts` 的 `probeKbEmbedding()` 改为 `probeKbModel(target)`，`web/src/lib/api.ts` 的 `ApiClient`、`web/test/api-files-archive.test.ts` 的方法清单与 `use-kb-settings.ts` 的调用点随之改。验证：`npm run test:focus --workspace web -- api-kb api-files-archive center-models-kb` 全过，`make typecheck` 退出 0，`git grep -n probeKbEmbedding -- web` 退出 1。

Suggested fixture level: expanded - 带凭证的出站请求、管理员权限与公共 API 的视图加键（outbound with credentials、auth、public API）。
Minimal mergeable slice: 6.1–6.2 为首刀（设置的解析、下发、清除、读视图，加上 web 设置视图解析器）：读视图加键与 web 解析器必须同 PR，不带 `target` 的探活行为不变，首刀独立保绿。第二刀 6.3–6.5（服务端探活 `target`、重排探活写回与文档）依赖首刀与组 5，atomic：探活的红用例、接线与描述它的文档是同一条验证路径。第三刀 6.6（web 探活方法改名）依赖第二刀，atomic：方法改名与它的调用点是同一批行。

## 7. 检索带重排与自动降级（ragflow-backend「RAGFlow 出站请求」的重排降级与三个场景；knowledge-bases「单轮检索」的「带重排」）

- [ ] 7.1 测试先行：新 `server/test/kb-retrieval-rerank.test.ts`，加「带重排」「重排降级」「检索失败的映射」（用 3.2 的「指定 `code`」注入造出未配置重排时的 102 与 101）「超时不降级」四个场景；`kb_rerank_degraded` 60 秒内至多一行（注入时钟）；降级时 stderr 与应答都不含假 RAGFlow 的 message 哨兵。先看到红。验证：用例先红。
- [ ] 7.2 `server/src/kb/retrieval.ts`：配置了重排模型时带 `rerank_id`，检索失败且带了 `rerank_id` 时去掉它重试恰一次并写降级记录（复用 `perMinute`），其余检索失败为 `kb_unavailable`（design D3）。验证：`npm run test:focus --workspace server -- kb-retrieval` 全过；`docs/architecture/system.md` 9.13 的检索一节补上降级规则与「`code:102` 不可区分」的后果。

Suggested fixture level: expanded - 出站请求的重试语义，是「不重试」规则的唯一例外（outbound、shared failure mapping）。
Minimal mergeable slice: atomic - 带 `rerank_id` 与降级必须同时生效：只带不降级，重排故障就让所有检索 503；只有降级没有可降的东西。

## 8. web：检索测试（knowledge-bases「中心「知识库」tab」的检索测试与其场景）

首刀（8.1–8.2）：

- [ ] 8.1 测试先行：在 `web/test/api-kb-retrieval.test.ts` 加 `retrieveFromKnowledgeBase` 的严格解析用例（键集 `{hits, retrieval}`，命中键集 `{documentId, name, similarity, content}`，`hits:[]` 解析通过）；`web/test/api-files-archive.test.ts` 的方法清单加它。先看到红。验证：用例先红。
- [ ] 8.2 实现：`api-kb.ts` 加 `retrieveFromKnowledgeBase`；`web/src/lib/api.ts` 的 `ApiClient` 导出其类型与方法。验证：`npm run test:focus --workspace web -- api-kb api-files-archive` 全过，`make typecheck` 退出 0。

第二刀（8.3–8.6）：

- [ ] 8.3 测试先行：新 `web/test/center-kb-retrieval.test.tsx`，覆盖「检索测试的命中与空态」「检索测试的参数与禁用」「清空数字字段」「Enter 检索」「检索测试只在 ready 时出现」「检索失败」「失败后列表与服务端一致」。先看到红。验证：用例先红。
- [ ] 8.4 实现 design D8 的检索测试：新 `web/src/features/center/kb/retrieval-panel.tsx` 与 `use-retrieval.ts`；`detail.tsx` 在 `ready` 时渲染它；成功后经回调更新列表里该库的 `retrieval`，失败且参数有变时重取列表。验证：`npm run test:focus --workspace web -- center-kb` 全过。
- [ ] 8.5 ui-walk：新 `web/e2e/ui-walk-center-kb.ts`，在 `web/e2e/ui-walk.spec.ts` 里注册。用 `page.route(...).fulfill`（先例 `web/e2e/ui-walk-layout.ts:71`）应答 `/api/kb/status`（开启、可用、嵌入就绪）、`/api/kb/bases`、`…/documents` 与 `…/retrieval`（一次有命中、一次 `hits:[]`），在桌面与 390 px 两种宽度下打开知识库详情、检索、看到命中与空态，过 error oracle；结束前 unroute。验证：`make ui-walk` 退出 0；PR 附两种宽度的截图。
- [ ] 8.6 验收清单：`docs/acceptance/functional-checklist.md` 的「中心·知识库（CK）」节加 CK-13（检索测试：命中显示序号、文档名、两位小数的相似度与切片原文，没有来源路径与切片序号；无命中的文案；改参数检索后刷新页面参数仍在；桌面与手机宽度、浅色与深色主题下布局不溢出、文字可读），结论 `待签`。验证：`npm run test:focus --workspace web -- functional-checklist` 全过。

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
