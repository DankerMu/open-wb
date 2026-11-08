# Tasks: s2b-kb-retrieval

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组（或宽度门禁拆出的切片）一个子 issue、一个 PR。
>
> 没有外部前提：rc2 实测已完成（`docs/reviews/2026-10-28-ragflow-rc2-api.md` §19），本 change 的任何任务都不碰共用 RAGFlow 栈；
> `make smoke-kb` 的真实运行是 owner 执行的验收行。
>
> 依赖（真实依赖）：
> - 无前置：组 1、组 3、组 5。
> - 组 2 ← 1。组 4 ← 1、3。组 6 ← 1、5。组 7 ← 4、6。
> - 组 8 ← 2、4。组 9 ← 6。组 10 ← 4、8。
>
> 跨服务的严格解析：web 的 API 客户端按键集严格解析应答（knowledge-bases「中心「知识库」tab」）。所以服务端给既有视图加键时，
> web 的解析器 SHALL 在同一个 PR 里改（组 2 的 `BaseView.retrieval`、组 6 的设置读视图 `rerank`），否则合入即让界面 `requestFailed`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（重排上游密钥进响应、审计、日志；RAGFlow 的重排报错体带出上游信息） | 是 | 组 3 结果不含 message、组 6 读视图与审计、组 7 降级记录不含 message |
| 两份真相（本地参数 vs RAGFlow 缺省；命中关联不上本地文档） | 是 | 组 4 参数恒显式传、命中丢弃 |
| 并发（写回与重建、与其它写操作交错） | 是 | 组 4 的写锁用例 |
| 外部接口漂移（rc2 预发行版；`code:102` 不可区分） | 是 | 组 3 夹具只按 §19 写、组 7 的降级后果用例、组 10 真实冒烟 |
| 权限（他人知识库可探测、非管理员配重排） | 是 | 组 4 的 404 矩阵、组 6 的 403 |
| 迁移与 DB 约束 | 是 | 组 1 |
| 跨服务契约（视图加键而 web 严格解析） | 是 | 组 2、组 6 同 PR 改两端 |
| 共用外部资源（账号缺省被改动） | 是 | 组 6：重排不发 `PATCH /models/default`，请求序列断言 |

## 1. 迁移 051 与 store（knowledge-bases「迁移 051 检索参数与重排模型」）

- [ ] 1.1 核对 Context：`050_knowledge_bases.sql`、`033` / `035` 的 `ADD COLUMN` 写法、`server/test/core-db-helpers.ts` 的跟踪清单、`server/test/kb-schema.test.ts`、`server/src/kb/store.ts` 的 `settings()` / `saveSettings` / `recordEmbeddingProbe` 与知识库行的读写。验证：在 issue 里列出要改的函数与行号。
- [ ] 1.2 测试先行：在 `server/test/kb-schema.test.ts` 加 051 的用例，覆盖「列与约束」场景（050 库上应用后两列取缺省、三处越界更新被拒、`1` 存成 `real`、重排三列为 NULL、`rerank_probe_status` 为 `never`），以及跟踪清单含 `MIGRATION_051`，先看到红；新 `server/src/core/db/migrations/051_kb_retrieval.sql` 按 design D5 实现。验证：`npm run test:focus --workspace server -- kb-schema` 全过。
- [ ] 1.3 store：知识库行读出 `retrievalThreshold` / `retrievalVectorWeight`；新增「在同一事务里写两列并执行回调」（审计由调用方在回调里写）；设置读出 `rerank`（名称、地址、探活，不含密钥）与单独的重排密钥读取；整组写、清空重排三列；写回重排探活结果（只写回同一身份）。测试先行：`server/test/kb-store.test.ts` 加对应用例与「重排三列整组写入」场景。验证：focus 运行全过，`store.ts` 不超过 800 行。

Suggested fixture level: expanded - 迁移与持久化状态（migration、persisted state）。
Minimal mergeable slice: 1.1–1.2（迁移文件与 schema 用例）可独立合入保绿：只加列，既有代码不读它们；1.3 的 store 读写依赖它。

## 2. `BaseView.retrieval`（knowledge-bases「知识库端点」的视图与 201 应答）

- [ ] 2.1 测试先行：
  - `server/test` 里断言 `BaseView` 恰为十一个键的用例（列表、建库 201，含「建库应答不读 RAGFlow」的 `retrieval:{threshold:0.2, vectorWeight:0.7}`），先看到红。
  - `web/test` 里 `api-kb` 的严格解析用例：带 `retrieval` 的应答解析通过，缺 `retrieval` 或类型不符为 `requestFailed`。
  验证：两组用例先红。
- [ ] 2.2 实现：`server/src/kb/bases.ts` 的 `viewOf` 加 `retrieval`；`web/src/lib/api-kb.ts` 的 `BaseView` 类型与解析器加 `retrieval`。两端在同一 PR。验证：`npm run test:focus --workspace server -- kb-bases`、`npm run test:focus --workspace web -- api-kb` 全过，`make typecheck` 退出 0。

Suggested fixture level: expanded - 改公共 API 的应答形状（public API），web 的严格解析器要同步。
Minimal mergeable slice: atomic - 服务端加键与 web 解析器必须同 PR，任何一半单独合入都会让知识库 tab `requestFailed`。

## 3. 假 RAGFlow 检索路由与客户端（ragflow-backend「RAGFlow 接口实测记录」的检索覆盖、「RAGFlow 出站请求」的 `POST /retrieval` 一行）

- [ ] 3.1 核对 Context：实测记录 §19.1–§19.6；`server/test/support/fake-ragflow.mjs` 的 `ROUTES` 与兄弟文件写法；`server/src/kb/ragflow-models.ts` 的 `modelCalls(json)` 并入方式；`ragflow-route.ts` 的 `Route`。验证：在 issue 里列出 §19 里协议应答的键与码。
- [ ] 3.2 测试先行：新 `server/test/support/fake-ragflow-retrieval.mjs`（加 `.d.mts`），挂到 `ROUTES`：
  - `POST /api/v1/retrieval` 回 §19.1 形状的 `{chunks, doc_aggs, labels, total}`，切片键取 §19.1 那十六个。
  - 命中由用例脚本化（数据集 → 切片列表与分数），夹具不实现检索算法。
  - 协议应答：§19.1 表里五条 `code:101` 与不存在数据集的 `code:404`；`rerank_id` 指向不存在的模型时回 `code:102`（§19.4）。
  - 故障注入：「带 `rerank_id` 时回 `code:102`」开关、切片缺字段、挂起。
  - 记录收到的 JSON body。
  附夹具自测。验证：夹具自测全过。
- [ ] 3.3 新 `server/src/kb/ragflow-retrieval.ts`：检索路由，`code:102` 为类型化结果「检索失败」，读 `data.chunks` 的 `document_id`、`content`、`similarity`，缺字段即 `kb_unavailable`。经 `retrievalCalls(json)` 并入 `createRagflowClient`，`ragflow-client.ts` 只加并入的一行。测试先行：`server/test/kb-ragflow-client.test.ts` 加检索一节：成功读取、`102` 为检索失败、`101` 为 `kb_rejected`、`404` 为 `kb_unavailable`、缺字段、结果与 stderr 不含 message 哨兵。验证：focus 运行全过，`ragflow-client.ts` 行数不增加超过 5 行。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials）与新的类型化失败映射。
Minimal mergeable slice: atomic - 夹具没有客户端就没有消费者，客户端没有夹具无法按规格验证；共一条验证路径（S2a 组 5 先例）。

## 4. 单轮检索与检索测试端点（knowledge-bases「单轮检索」「检索测试端点」「`kb_search` 工具契约」「知识库审计」的 `kb.retrieval_settings`、「知识库端点」的所有权矩阵；http-service-skeleton「统一错误信封」；ragflow-backend「知识库可用性」）

- [ ] 4.1 测试先行：新 `server/test/kb-retrieval.test.ts`（`buildApp` + `app.inject()`，真实 SQLite，接假 RAGFlow），覆盖：
  - 「单轮检索」的「参数显式传」「命中关联本地文档」「应答缺字段」；
  - 「检索测试端点」全部七个场景（含写回与重建交错：用 S2a 的锁注入让重建器持锁）；
  - 「知识库端点」的「文档路由的所有权」扩到十二次；
  - 「知识库可用性」的「未配置即关闭」扩到十三条；
  - http-service-skeleton「知识库的归属路由」加检索路由的 malformed / 空 / `text/plain` 三例，归属集恰三十九条；
  - 「知识库审计」的「detail 不含敏感内容」加含哨兵问句的检索写回。
  先看到红。验证：用例先红。
- [ ] 4.2 新 `server/src/kb/retrieval.ts`，按 design D1、D2、D4 实现：单轮检索（本组不带 `rerank_id`）、body 校验、写回编排（经 `locks.write`，回调里写 `kb.retrieval_settings`）。`server/src/kb/rest.ts` 注册 `POST /api/kb/bases/:id/retrieval`（`ownedBase` preParsing、body limit 16 KiB、no-store）。`server/src/http/errors.ts` 的归属集加这条身份。`index.ts` 装配。验证：4.1 全过，`make lint`、`make typecheck` 退出 0。
- [ ] 4.3 「`kb_search` 工具契约」的「契约与检索测试同源」：一个扫描 `server/src` 的用例，断言 `/api/v1/retrieval` 只出现在 `kb/ragflow-retrieval.ts`，`kb_search` 不出现在任何注册或分派里。验证：用例全过；在 `retrieval.ts` 外加一个假调用时用例变红（手动变异一次，记录在 PR）。
- [ ] 4.4 文档：`docs/architecture/system.md` §2 的 `kb` 行加检索端点；9.13 加「单轮检索与检索测试」一节（请求形状、参数显式传的理由、写回规则、命中关联）；`docs/architecture/knowledge-base.md` 加检索参数的缺省值与「候选由全文匹配圈定」的已知行为（引用 §19.1）。验证：`make anti-drift` 退出 0。

Suggested fixture level: expanded - 新的公共端点、权限、持久化写回与并发（public API、auth、persisted state、concurrency）。
Minimal mergeable slice: atomic - 单轮检索没有端点就没有调用方（knip 判死代码），端点没有单轮检索无法检索；写回、审计与所有权都在这一个端点的一条验证路径上。

## 5. 探活泛化为两种目标（ragflow-backend「知识库模型设置」的探活；行为不变的重构）

- [ ] 5.1 核对 Context：`server/src/kb/embedding-probe.ts` 全文与它的用例、`settings.ts` 的 `probeOnce`。验证：在 issue 里列出路径、body 与 2xx 判定三处写死的点。
- [ ] 5.2 原地重构：`embedding-probe.ts` 改名 `model-probe.ts`，`probeEmbedding` 泛化为按目标取路径、body 与 2xx 判定（design D7），嵌入目标的行为逐字不变。测试先行：把现有嵌入探活用例原样跑过改名后的模块（全绿），再加重排目标的单元用例（`POST <base>/rerank`、body `{model, query:"ping", documents:["ping"]}`、`results[0].relevance_score` 为数字为 `ok`、401 / 503 / 空 `results` 为 `failed`、错误摘录不含密钥与地址），先红后绿。验证：`npm run test:focus --workspace server -- probe` 全过；`git grep embedding-probe` 无残留。

Suggested fixture level: expanded - 带凭证的出站请求（outbound with credentials），重构不得改变嵌入探活的行为。
Minimal mergeable slice: atomic - 改名与泛化是一次原地重构；重排目标在本组只有单元调用方，端点接线在组 6。

## 6. 重排模型的设置、下发与探活端点（ragflow-backend「知识库模型设置」；knowledge-bases「知识库审计」的 `kb.settings` 行）

- [ ] 6.1 测试先行：`server/test/kb-settings*.test.ts` 加 ragflow-backend「知识库模型设置」新增的五个场景（重排模型的下发序列、换重排模型不重建、清除重排模型、重排模型的密钥与名称、重排探活），以及「非管理员」对 `?target=rerank` 的 403；`web/test` 的 `api-kb` 解析用例：设置读视图带 `rerank` 才解析通过，`probeKbModel("rerank")` 发 `?target=rerank`。先看到红。验证：用例先红。
- [ ] 6.2 实现 design D6、D7：
  - `settings.ts` 解析 `rerank`；`Provision` 加 `modelType:"rerank"`，这时不发 `PATCH /models/default`；清除只改本地；读视图加 `rerank`；审计 detail 加 `rerank` 与 `rerankProbe`。
  - `rest.ts` 的探活路由读 `target`。
  - 假 RAGFlow 的实例路由接受 `model_type:["rerank"]`（若有白名单）。
  - 同一 PR：`web/src/lib/api-kb.ts` 的设置视图解析与 `updateKbSettings` 的 input 加 `rerank`，`probeKbEmbedding()` 改为 `probeKbModel(target)`，web 里的调用点随之改。
  验证：6.1 全过，`make typecheck`、`make lint` 退出 0，`settings.ts` 不超过 800 行。
- [ ] 6.3 文档：`docs/architecture/system.md` 9.13 的知识库模型一节加重排模型（实例 `owb-rerank`、不设账号缺省、清除只改本地、探活 `?target=rerank`）；`docs/architecture/knowledge-base.md` 的运维说明加「`owb-rerank` 不是账号缺省，删除没有 §13 的风险」。验证：`make anti-drift` 退出 0。

Suggested fixture level: expanded - 带凭证的出站请求、管理员权限与公共 API 的视图加键（outbound with credentials、auth、public API）。
Minimal mergeable slice: 6.1–6.2 中除 `target=rerank` 探活以外的部分（设置的解析、下发、清除、读视图，加上 web 解析器）为首刀：读视图加键与 web 解析器必须同 PR，探活接线可以后补。剩余（探活 `target`、6.3）依赖首刀。

## 7. 检索带重排与自动降级（ragflow-backend「RAGFlow 出站请求」的重排降级与三个场景；knowledge-bases「单轮检索」的「带重排」）

- [ ] 7.1 测试先行：在 `server/test/kb-retrieval.test.ts` 加「带重排」「重排降级」「检索失败的映射」「超时不降级」四个场景；`kb_rerank_degraded` 60 秒内至多一行（注入时钟）；降级时 stderr 与应答都不含假 RAGFlow 的 message 哨兵。先看到红。验证：用例先红。
- [ ] 7.2 `server/src/kb/retrieval.ts`：配置了重排模型时带 `rerank_id`，检索失败且带了 `rerank_id` 时去掉它重试恰一次并写降级记录（复用 `perMinute`），其余检索失败为 `kb_unavailable`（design D3）。验证：7.1 全过；`docs/architecture/system.md` 9.13 的检索一节补上降级规则与「`code:102` 不可区分」的后果。

Suggested fixture level: expanded - 出站请求的重试语义，是「不重试」规则的唯一例外（outbound、shared failure mapping）。
Minimal mergeable slice: atomic - 带 `rerank_id` 与降级必须同时生效：只带不降级，重排故障就让所有检索 503；只有降级没有可降的东西。

## 8. web：检索测试（knowledge-bases「中心「知识库」tab」的检索测试与四个场景）

- [ ] 8.1 测试先行：`web/test` 加四个场景（命中与空态、参数与禁用、只在 ready 时出现、检索失败）与 `retrieveFromKnowledgeBase` 的严格解析用例（键集 `{hits, retrieval}`，命中键集 `{documentId, name, similarity, content}`）。先看到红。验证：用例先红。
- [ ] 8.2 实现 design D8 的检索测试：`api-kb.ts` 加 `retrieveFromKnowledgeBase`；新 `web/src/features/center/kb/retrieval-panel.tsx` 与 `use-retrieval.ts`；`detail.tsx` 在 `ready` 时渲染它；成功后经回调更新列表里该库的 `retrieval`。验证：8.1 全过；`make ui-walk` 退出 0；桌面与手机宽度、浅色与深色各一张截图，控制台零新增报错。
- [ ] 8.3 验收清单：`docs/acceptance/functional-checklist.md` 的「中心·知识库（CK）」节加 CK-13（检索测试：命中显示序号、文档名、两位小数的相似度与切片原文，没有来源路径与切片序号；无命中的文案；改参数检索后刷新页面参数仍在），结论 `待签`。验证：`npm run test:focus --workspace web -- functional-checklist` 全过。

Suggested fixture level: expanded - 前端通用契约：涉及呈现的 web 任务至少 `expanded`（真实浏览器 + 视口矩阵）。
Minimal mergeable slice: atomic - API 方法没有面板就没有调用方（knip），面板没有 API 方法无法检索；CK 行与它交付的界面同 PR（签收规则）。

## 9. web：模型 tab 的重排模型（model-registry「模型 tab」的重排模型与改名后的探活调用）

- [ ] 9.1 原地重构：`kb-embedding-dialog.tsx` 改名 `kb-model-dialog.tsx`，加 `kind` 属性，嵌入模型的行为与文案不变（标题、重建确认只对嵌入生效）。测试先行：既有嵌入对话框与「更换嵌入模型需确认」用例原样全绿。验证：`npm run test:focus --workspace web -- kb-` 全过；`git grep kb-embedding-dialog` 无残留。
- [ ] 9.2 测试先行：加「重排模型」场景（编辑、保存后探活、`探活`、`清除` 的取消与确认）；实现 `kb-section.tsx` 的重排模型一行与清除确认框（拷入层 alert-dialog）。验证：用例全过；`make ui-walk` 退出 0；桌面与手机宽度各一张截图，控制台零新增报错。
- [ ] 9.3 验收清单 CK 节加 CK-14（管理员配置重排模型、探活、清除；配置后成员的检索测试照常有结果），结论 `待签`。验证：`npm run test:focus --workspace web -- functional-checklist` 全过。

Suggested fixture level: expanded - 前端通用契约：涉及呈现的 web 任务至少 `expanded`。
Minimal mergeable slice: 9.1（对话框的改名与泛化，嵌入行为不变）可独立合入保绿；9.2–9.3 依赖它。

## 10. 真实端点冒烟与收口（verification-harness「知识库真实端点冒烟」）

- [ ] 10.1 `smoke/kb.hurl`：在 `smoke-kb` 库两份文档都 `done` 之后，以夹具 `notes.md` 里的专名（如 `北礁观测站由谁值守`）、`threshold:0`、`vectorWeight:0.7` 检索，断言 200、`hits` 非空、首条 `name` 为 `notes.md`、`retrieval` 为 `{threshold:0, vectorWeight:0.7}`；文件头注释的步骤与端点说明同步。验证：`hurl --test` 对一个接假 RAGFlow 的本地服务语法通过（不进 CI 必需检查）；真实运行由 owner 的验收行 CK-11 承担，PR 写明。
- [ ] 10.2 收口：`IMPLEMENTATION_PLAN.md` 的 S2b 状态与 Next Step 更新；核对 design「Grill 结论」每一行都有落点；`npx openspec validate s2b-kb-retrieval --strict --no-interactive` 通过。验证：命令退出 0；`make check` 退出 0。

Suggested fixture level: compact - 只改冒烟用例与文档，不改产品代码；冒烟不进 CI 必需检查。
Minimal mergeable slice: atomic - 一条冒烟断言与收口文档，拆开没有独立价值。
