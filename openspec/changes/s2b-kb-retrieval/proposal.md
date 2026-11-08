# Proposal: s2b-kb-retrieval

> Issue type: feature（P2 第二刀：知识库检索线）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明）
> Blast radius: RAGFlow 客户端加 `POST /api/v1/retrieval` 与重排模型下发（新兄弟文件，`ragflow-client.ts` 不加路由）；迁移 051（`knowledge_bases` 两列检索参数、`kb_settings` 六列重排模型）；`BaseView` 多一键 `retrieval`；新端点 `POST /api/kb/bases/:id/retrieval`（第三十九条 content-parser 归属身份）；`POST /api/kb/settings/probe` 加查询参数 `target`；设置读视图与 PUT body 各多一键 `rerank`；第八种知识库审计 `kb.retrieval_settings`；中心知识库详情多一块「检索测试」；模型 tab「知识库模型」段多一个重排模型
> Evidence floor: `npm test --workspace server`、`npm test --workspace web`、typecheck、size-guard、`make check`、`make ui-walk`；真实 RAGFlow 只在本机 `make smoke-kb` 与验收走一轮
> 依赖：建在 `s2a-kb-ragflow` 归档后的主规格之上（knowledge-bases、ragflow-backend）；事实来源是实测记录 `docs/reviews/2026-10-28-ragflow-rc2-api.md` §19（2026-11-08，S2b 检索实测）；方向决定见 ADR-0017。

## Why

`IMPLEMENTATION_PLAN.md` S2b 要求知识库能被检索（F-CTR-KB3「检索测试」），这也是 S2c 会话内 `kb_search` 的地基。
2026-11-07 的 grill 定了方向（ADR-0017）：agentic 环交给会话里的 omp 模型，kb 模块只提供「单轮检索」。
所以 S2b 交付三样东西：单轮检索原语，中心页的检索测试，以及一个可选的全局重排模型。

rc2 的检索接口此前从未实测，2026-11-08 补测（记录 §19）推翻了两个预设：
- dataset 上的阈值与权重经 API 不可写（§19.2），检索参数只能存在本地。
- `use_kg` 在 rc2 上没有可观察的效果（§19.5）。

## What Changes

- **单轮检索**（kb 模块内唯一的检索实现）：
  - 对一个知识库的当前数据集发 `POST /api/v1/retrieval`，显式带该库的阈值与向量权重，返回条数固定为 6。
  - 配了重排模型时带 `rerank_id`；带重排的检索失败（`code:102`）时，不带重排重试恰一次，写一行 stderr 记录，用户无感。
  - 命中按 RAGFlow 的文档 id 关联本地文档行，名称取本地记录；关联不上的命中丢弃。
- **检索参数**：
  - 迁移 051 给 `knowledge_bases` 加 `retrieval_threshold`（缺省 0.2）与 `retrieval_vector_weight`（缺省 0.7），既有库也取缺省。
  - `BaseView` 多 `retrieval: {threshold, vectorWeight}`。
- **检索测试端点** `POST /api/kb/bases/:id/retrieval`：
  - body `{question, threshold, vectorWeight}`。
  - 参数与已存值不同时，先在该库写锁内写回，并审计 `kb.retrieval_settings`；写失败就不检索。
  - 只对所有者，只在 `state` 为 `ready` 时。
  - 检索本身不审计。
- **重排模型**（管理员，全局可选）：
  - 设置 PUT 多 `rerank: {name, baseUrl, apiKey?} | null`，读视图多 `rerank`。
  - 下发到实例 `owb-rerank`（`model_type:["rerank"]`），不设为账号缺省；清除只改本地。
  - 探活 `POST /api/kb/settings/probe?target=rerank` 直连上游 `POST <baseUrl>/rerank`，与嵌入探活共用一个实现（`embedding-probe.ts` 改名 `model-probe.ts`）。
  - 更换不触发重建。
- **审计**：第八种 kind `kb.retrieval_settings`。
- **`kb_search` 的工具契约**写进规格（问句加 kb_ids，命中与检索测试同形）。S2b 不写任何 `kb_search` 代码，分派、注册、工具说明、条数与多库过滤都在 S2c。
- **web**：
  - 知识库详情里有「检索测试」一块：问句、相似度阈值、向量权重、`检索`，命中显示序号、文档名、相似度与切片原文。
  - 模型 tab 的「知识库模型」段加重排模型（摘要、`编辑`、`探活`、`清除`），与嵌入模型同一个对话框组件。
- **验证**：
  - 假 RAGFlow 加 `/api/v1/retrieval` 与重排实例，协议只按记录 §19。
  - `make smoke-kb` 加一条检索断言。
  - 验收清单 CK 节加检索测试与重排的行（`待签`）。
- **文档**：`docs/architecture/system.md` 9.13 与 §2 模块表、`docs/architecture/knowledge-base.md` 加检索与重排。

## Capabilities

### New Capabilities

无。

### Modified Capabilities
- `knowledge-bases`：
  - 「迁移 050 知识库 schema」之后加迁移 051。
  - 「知识库端点」：`BaseView` 加 `retrieval`，建库应答带缺省值。
  - 「知识库审计」：八种 kind。
  - 「中心「知识库」tab」：详情加检索测试。
  - 新增「单轮检索」「检索测试端点」「`kb_search` 工具契约」。
- `ragflow-backend`：
  - 「RAGFlow 接口实测记录」：覆盖 §19。
  - 「知识库可用性」：十三条路由。
  - 「RAGFlow 出站请求」：检索路由的类型化结果与重排降级这一处重试例外。
  - 「知识库模型设置」：重排模型的键、下发、清除与探活。
- `model-registry`：「模型 tab」的「知识库模型」段加重排模型。
- `http-service-skeleton`：「统一错误信封」的归属身份加 `POST /api/kb/bases/:id/retrieval`（三十九条，三十一条以 POST 归属）。
- `verification-harness`：「知识库真实端点冒烟」加检索断言。

## Impact

- 服务端：
  - 新文件 `server/src/kb/ragflow-retrieval.ts`（检索路由）与 `server/src/kb/retrieval.ts`（单轮检索与检索测试）。
  - `embedding-probe.ts` 改名 `model-probe.ts`。
  - 改动 `settings.ts`、`store.ts`、`bases.ts`、`rest.ts`、`index.ts`。
  - 新迁移 `051_kb_retrieval.sql`；`http/errors.ts` 的归属集。
- 前端：
  - 新文件 `web/src/features/center/kb/retrieval-panel.tsx` 与 `use-retrieval.ts`。
  - 改动 `detail.tsx`、`api-kb.ts`、模型 tab 的 `kb-section.tsx` 与 `kb-embedding-dialog.tsx`（泛化为两种模型共用）、`use-kb-settings.ts`。
- 测试夹具：`server/test/support/fake-ragflow*.mjs` 加检索路由，重排实例走既有的实例路由。
- 外部：
  - 开发期仍用共用 RAGFlow 栈；本 change 不再需要对它做实测（已在 §19 完成）。
  - 重排上游由管理员配置；`make smoke-kb` 不依赖重排。
- 不动的东西：RAGFlow 的账号缺省（重排不设缺省）、嵌入身份与重建、omp 与会话。
