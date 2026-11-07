# CONTEXT — 限界上下文与不变量

> 本文件定义领域边界与不变量；术语定义只在 `openspec/glossary.md`（本文件只链接不定义）。行为基准是
> `resource/workbuddy-live-demo.html`（demo 能点出来的行为就是需求），架构基准是 `docs/architecture/system.md`（`PLAN.md` 保留为建设方案与阶段账本）。

## 项目本质

内网多用户 AI Agent Web 服务。三个组件：**app-server**（业务后端）、**web SPA** 与
外部 **RAGFlow 服务**（知识库后端，ADR-0016）；agent 执行由 **omp**（钉住官方二进制 v18.12.3，ADR-0001）以每会话子进程承担。

## 领域术语

术语及其边界说明见 [`openspec/glossary.md`](openspec/glossary.md)。命名领域概念前先读它；本文件不定义术语。

## 限界上下文

- **会话编排**（server）：会话/场景/专家/omp 子进程生命周期。
- **文件与沙箱**（server）：工作空间/挂载/沙箱边界/白名单。
- **知识库**（app-server `kb` 模块 + RAGFlow）：摄取/切片/检索/agentic 环——`kb` 模块按所有权与可见范围过滤，RAGFlow 不感知租户，只收已过滤输入。
- **账号与治理**（server）：SSO/项目组/可见范围/审计——多租户逻辑全在这里。

## 不变量（违反即缺陷）

1. 共享知识库对非所有者永远只读。
2. 进入模型上下文的 KB 内容只能是命中切片+出处，不能是整篇文档。
3. 沙箱外写/删一律拒绝且必入审计。
4. RAGFlow API 密钥与模型网关密钥不得出现在 omp 子进程可读环境。
5. `app-reference/` 内容不进任何产物。

## 开放术语/问题

- SSO 已定 OIDC、项目组默认自建（ADR-0007）；剩余开放：IdP 是否带组声明，带则改同步——待身份源调研，P3 前关闭。
