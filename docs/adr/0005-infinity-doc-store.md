# kb-service 文档存储用 Infinity

切片全文检索+向量存储选 Infinity，经 RAGFlow `DocStoreConnection` 接缝接入：混合检索（全文+向量+
融合）开箱即有、无 JVM、体积小，契合单机部署包约束。

## Considered Options
- Elasticsearch：RAGFlow 默认主力、适配代码路径最短，但 JVM 常驻 GB 级内存，与单机包目标相悖。
- pgvector 自研适配：元数据已定 SQLite，等于为此单独引入 PG 再加自写适配层，成本最高。

风险：Infinity 社区相对年轻；`DocStoreConnection` 接缝保留换回 ES 的退路。

## 2026-11-01 补充（ADR-0016）：Infinity 经 RAGFlow 的 `DOC_ENGINE`

ADR-0016 取代 ADR-0002 之后，本系统不再有 kb-service，也不再持有 `DocStoreConnection` 接缝；上文的标题与接入方式是当时的记录。

- **选 Infinity 的决定不变，落点改变。** 生产环境由 RAGFlow 经其 `DOC_ENGINE` 配置使用 Infinity；本仓不写适配代码，app-server 不直连 Infinity。
- **ES 退路仍在，在 RAGFlow 侧。** 换回 ES 是改 RAGFlow 的 `DOC_ENGINE`，不是改本仓代码。
- **开发期引擎可以不同。** 共用开发栈的 `DOC_ENGINE` 由其所有者决定；与生产不同只影响检索（S2b），不影响 S2a 的摄取。
