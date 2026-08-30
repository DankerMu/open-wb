# kb-service 文档存储用 Infinity

切片全文检索+向量存储选 Infinity，经 RAGFlow `DocStoreConnection` 接缝接入：混合检索（全文+向量+
融合）开箱即有、无 JVM、体积小，契合单机部署包约束。

## Considered Options
- Elasticsearch：RAGFlow 默认主力、适配代码路径最短，但 JVM 常驻 GB 级内存，与单机包目标相悖。
- pgvector 自研适配：元数据已定 SQLite，等于为此单独引入 PG 再加自写适配层，成本最高。

风险：Infinity 社区相对年轻；`DocStoreConnection` 接缝保留换回 ES 的退路。
