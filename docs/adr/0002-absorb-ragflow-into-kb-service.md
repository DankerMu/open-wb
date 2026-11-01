# 知识库：吸收 RAGFlow 源码组装 kb-service，不整机部署

> **已被 ADR-0016 取代**（[0016-ragflow-service-backend.md](0016-ragflow-service-backend.md)，owner 2026-10-28）：知识库改为对接运行中的 RAGFlow 服务，`kbservice/` 退役。下文保留为当时的记录。

吸收 RAGFlow（Apache-2.0）Python 线——deepdoc 解析、12 种模板切片、混合检索、agentic 检索环——
组装为独立 kb-service；重写其 `api.db` 耦合层，存储经 `DocStoreConnection` 接缝接入。不整机部署
RAGFlow：其多租户、前端与 API 层同本项目 app-server 职责重叠，且本项目多租户必须自研（可见范围/
审计语义不同）。源码落地时 `ATTRIBUTION.md` §3 的 LICENSE-RAGFlow/NOTICE/文件头义务生效。
吸收/跳过清单见 `resource/backend-research.md` §1。
