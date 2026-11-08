## MODIFIED Requirements

### Requirement: 知识库真实端点冒烟
Makefile SHALL 提供 `make smoke-kb`：对调用方已运行、已配置 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY_FILE`、知识库嵌入模型与知识库对话模型并接上共用 RAGFlow 栈的服务（`SMOKE_BASE_URL`；登录方式与 `smoke/chat.hurl` 相同）运行 `smoke/kb.hurl`。前提：调用方已按 `smoke/fixtures/README.md` 把 `smoke/fixtures/sandbox/u1/` 复制到该服务的 `SANDBOX_ROOT/u1`；`make smoke-kb` 不替它复制。它 SHALL 先从调用方 shell 环境读 `RAGFLOW_BASE_URL`：未设置时在发出任何请求之前以非零退出并输出 `RAGFlow 私有配置缺失`；设置了则请求其 `/api/v1/system/version`，不可达或版本串不是 `v1.0.0-rc2` 时在发出任何知识库请求之前以非零退出并输出 `共用 RAGFlow 栈未运行或版本不符`。它 SHALL NOT 启动、停止或配置任何 RAGFlow 容器，SHALL NOT 执行任何 `docker` 命令。`smoke/kb.hurl` SHALL 覆盖：`GET /api/kb/status` 为 `available:true`、`embeddingReady:true` 且 `compileReady:true`；建一个名为 `smoke-kb` 的 `naive` 知识库；从夹具工作空间 `smoke-kb`（`smoke/fixtures/sandbox/u1/smoke-kb/`，一个 Markdown 文件与一个 PDF 文件）入库两份；轮询文档列表直到两份都为 `done` 且 `chunkCount` 大于 0（总时长上限经 `SMOKE_KB_POLL_SECONDS` 配置，缺省 300 秒）；以夹具 Markdown 文件里的一个专名为问句、`threshold:0`、`vectorWeight:0.7` 检索该库（`POST /api/kb/bases/:id/retrieval`；参数与缺省不同，同时走一次写回），断言 200、`hits` 非空、首条 `name` 为该 Markdown 文件名、`retrieval` 为 `{threshold:0, vectorWeight:0.7}`；本地上传一个文本文件；移出一份文档；删除知识库；再建一个名为 `smoke-kb-compile` 的 `naive` 知识库，`raptor` 与 `graph` 都为真，入库 Markdown 文件，轮询 `GET /api/kb/bases` 直到该库 `compile` 为 `{raptor:"done", graph:"done"}`（同一个上限，单独计时）；删除它；最后 `GET /api/kb/bases` 不再含这两个知识库。开编译的这一段是 DSL 对真实 RAGFlow 的唯一验证。运行 hurl 之前与 hurl 失败之后，`make smoke-kb` SHALL 各执行一次 `smoke/kb-cleanup.hurl`（经 app-server 删除名为 `smoke-kb` 与 `smoke-kb-compile` 的知识库；不存在即什么也不做，其失败不改变退出码），hurl 失败时整体仍以非零退出。`make smoke-kb` SHALL NOT 进入 CI 必需检查，也 SHALL NOT 被 `make smoke` 调用；`AGENTS.md` 验证矩阵与 Enforcement Index（`review-only`）、`constraints.yaml` 的 verification 段（`required_at: manual`）与 Makefile 的 `.PHONY` 同步登记它。

#### Scenario: 对真实 RAGFlow 走通摄取
- **WHEN** 共用栈运行 `v1.0.0-rc2`，服务已配置专用账号的密钥文件、知识库嵌入模型与知识库对话模型，执行 `make smoke-kb SMOKE_BASE_URL=<origin>`
- **THEN** hurl 全部断言通过、退出码 0；检索命中夹具 Markdown 文件；开编译的库两种编译都为 `done`；最后一次 `GET /api/kb/bases` 不含 `smoke-kb` 与 `smoke-kb-compile`

#### Scenario: 失败后清理
- **WHEN** 冒烟进行到入库之后某一断言失败（例如轮询超时）
- **THEN** `make smoke-kb` 非零退出；其后执行的 `smoke/kb-cleanup.hurl` 已删除这次留下的知识库，`GET /api/kb/bases` 不再含 `smoke-kb` 与 `smoke-kb-compile`

#### Scenario: 私有配置缺失
- **WHEN** 调用方 shell 环境未设置 `RAGFLOW_BASE_URL` 时执行 `make smoke-kb`
- **THEN** 非零退出，输出含 `RAGFlow 私有配置缺失`；没有向 `SMOKE_BASE_URL` 或任何 RAGFlow 地址发出请求

#### Scenario: 版本不符
- **WHEN** `RAGFLOW_BASE_URL` 指向一个本地桩，它的版本接口回 `v1.0.0-rc1`，执行 `make smoke-kb`
- **THEN** 非零退出，输出含 `共用 RAGFlow 栈未运行或版本不符`；桩只收到版本请求；没有向 `SMOKE_BASE_URL` 发出请求
