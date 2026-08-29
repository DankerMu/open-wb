# 后端选型研究：RAGFlow 代码复用 × oh-my-pi Agent SDK

> 2026-08-29。参考副本：`resource/ragflow`（v0.27.1, commit `fc62487e`, Apache-2.0, 174MB）、
> `resource/oh-my-pi`（v18.0.10, commit `33cc6b9a`, MIT, 240MB）。均为 `--depth 1` 浅克隆，
> 保留 `.git` 以便 `git pull` 更新；已在根 `.gitignore` 排除（同 `app-reference` 的处理方式）。
> 本文只做评估，不做吸收/裁剪动作。

## 结论先行

1. **RAGFlow 吸收的主线是 Python 侧**（`rag/` + `deepdoc/`），不是 `internal/` 里开发中的 Go 重写。
   核心可复用件：切片模板、深度版面解析、混合检索、agentic 检索环、RAPTOR、GraphRAG。
   最大耦合点是 `api.db.services.*`，吸收时需替换成自己的存储层；官方解耦缝是
   `common/doc_store/doc_store_base.py` 的 `DocStoreConnection` 抽象。
2. **omp 可以做 agent 后端，但不是进程内 SDK，而是子进程 RPC**。SDK 要求 Bun 运行时
   （`docs/sdk.md`：Requires Bun 1.3.14+；`packages/coding-agent/src` 有 900+ 处 Bun API），
   Electron 主进程内嵌不可行。正确姿势是 spawn `omp --mode rpc`（stdio JSONL），
   这也是上游 WorkBuddy 桥接 CodeBuddy CLI 的同构架构（见 `app-reference/analysis/03-cli-backend.md`）。
3. **两条线的接合点**：RPC 协议的 `set_host_tools`（`packages/coding-agent/src/modes/rpc/rpc-types.ts:45`）
   允许宿主注册工具、agent 调用时回调宿主。把知识库 agentic 检索注册为 host tool，
   KB 权限过滤就留在 WorkBuddy 宿主侧，与原型的权限模型（visibleKbs/只读共享/审计）一致。
4. 许可均无障碍：RAGFlow Apache-2.0，omp MIT（版权链：Mario Zechner pi → Can Bölük → Stencil Labs）。
   一旦实际吸收 RAGFlow 源码，`ATTRIBUTION.md` §3 的条件义务立即生效
   （补 `LICENSE-RAGFlow` 全文 + `NOTICE` + 派生文件头标注来源与修改点）。

## 1. RAGFlow（v0.27.1）复用地图

背景：仓库当前是双实现。Python 主线（`api/` + `rag/` + `deepdoc/`）成熟；`internal/`（2073 个 .go）
+ `cmd/ragflow_server.go` 是开发中的 Go 重写（`internal/development.md` 自称
"RAGFlow Go implementation - Development Guide"）。**[INFERENCE]** Go 线尚未定型，吸收以 Python 线为准。

### 1.1 吸收（按价值排序）

| 模块 | 路径 | 说明 |
|---|---|---|
| 切片模板 | `rag/app/*.py`（14 个：naive/qa/manual/paper/book/laws/presentation/table/one/picture/email/tag + audio/resume） | 原型 `kbMethods` 的 12 项与之一一对应。对 `api/` 耦合极低（`naive.py` 仅 4 处 `from api`），是最干净的吸收单元 |
| 深度版面解析 | `deepdoc/parser/`（pdf/docx/excel/html/markdown 等 18 种）+ `deepdoc/vision/`（OCR、layout、表格结构还原） | onnxruntime 推理；模型运行时从 HF 下载（`deepdoc/vision/layout_recognizer.py:65` `snapshot_download(repo_id="InfiniFlow/deepdoc")`）——**内网部署必须预置模型文件**，把 `snapshot_download` 替换为本地路径 |
| 混合检索 | `rag/nlp/`：`query.py`（查询构造）、`term_weight.py`（加权关键词）、`search.py`（全文+向量融合检索） | 注意两点：① 中文分词已下沉到 `infinity` pip 包（`rag/nlp/rag_tokenizer.py:17` `import infinity.rag_tokenizer`），当纯依赖库用即可（该 pip 包的许可与离线安装行为未核实，内网装包前要确认）；② `search.py:107` 有一处运行时 `from api.db.services...`，需剥离 |
| agentic 检索环 | `rag/advanced_rag/agentic_rag.py` + `agentic_rag_graph.py` | 与原型演示的循环同构：`formalize`(:399) → `extract_keywords`(:568) → `retrieve`(:580) → `judge_sufficiency`(:703) → `gen_followups`(:719) → 外层工具 `rag`(:777)。**耦合最重**：文件头直接 import `api.db.services.*`（document/knowledgebase/llm service），吸收时这一层要整体换成自己的存储与模型注册表 |
| RAPTOR | `rag/utils/raptor_utils.py`、`rag/advanced_rag/knowlege_compile/raptor.py`（目录名 typo 是上游原样） | 原型里 KB 的 `raptor` 开关对应此实现 |
| GraphRAG | `rag/graphrag/`（general/light 两模式 + entity_resolution + NER） | 原型 `kg` 开关对应此实现 |
| 嵌入/重排包装 | `rag/llm/embedding_model.py`、`rerank_model.py` | 对接内网自建模型注册表的改造点（bge-m3 / bge-reranker-v2-m3 即在此层配置） |
| 提示词 | `rag/prompts/` | 引用生成、query 改写、充分性判定等 prompt |
| 存储抽象缝 | `common/doc_store/doc_store_base.py`（`DocStoreConnection`、`MatchDenseExpr`、`FusionExpr`） | ES/Infinity/OpenSearch/GaussDB/OceanBase 各连接器（`rag/utils/*_conn.py`）都实现它。内网自建只需保留 1 个连接器（如 ES）或自写一个轻量实现 |

### 1.2 跳过

- `api/`：Flask 服务层 + 他们的 DB schema——用户已定调"吸收代码而非拉起服务"，这层整体不要
- `web/`：RAGFlow 前端，无关
- `rag/svr/task_executor*`：分布式摄取任务队列（Redis 依赖）。内网单机/小团队用同步或简单队列即可
- `agent/`、`admin/`、`mcp/`、`sdk/`：RAGFlow 自己的 workflow agent（与 omp 职责重复）、管理面、MCP 服务、HTTP SDK
- `internal/` + `cmd/`（Go）、`docker/`、`helm/`：未定型 / 部署形态无关

### 1.3 现实成本

- Python `>=3.13,<3.14`（`pyproject.toml:8`），依赖面大（onnxruntime、huggingface_hub、
  torch 按需装——`deepdoc/vision/ocr.py:25` `pip_install_torch`、doc store 客户端等）。
- **[INFERENCE]** 合理落地形态：把吸收的模块组装成本应用的一个内部 Python 进程
  （"kb-service"，只含 deepdoc + rag/nlp + advanced_rag + 一个 doc store 连接器），
  由 Electron 主进程管理生命周期。这不违背"不拉起完整 RAGFlow 服务"——它不是 RAGFlow
  的 api server，只是吸收代码后的宿主进程；Python 重依赖（onnx/torch）也不可能塞进 Node 进程。

## 2. oh-my-pi（v18.0.10）作为 agent 后端

### 2.1 集成通道判定

| 通道 | 可行性 | 依据 |
|---|---|---|
| 进程内 SDK（`createAgentSession`，`packages/coding-agent/src/sdk.ts:1278`） | ❌ Electron 内不可行 | `docs/sdk.md` 明确 Requires Bun 1.3.14+；`packages/coding-agent/src` 913 处 Bun API 调用，Node 移植不现实 |
| **子进程 RPC（`omp --mode rpc`）** | ✅ 推荐 | `docs/rpc.md`：stdio JSONL，ready 帧协商、1MiB 帧 + v2 分块重组、自带 TS/Python `RpcClient`。官方先例：`python/robomp` 就是外部服务按 issue 驱动 `omp --mode rpc`（`docs/user-facing-packages.md`）；社区 `apoc/omp-desktop` 同路 |
| ACP 模式（`src/modes/acp/`） | 备选 | 编辑器标准协议，功能面窄于自家 RPC |

关键能力对齐 WorkBuddy 需求：

- **host tools**：`set_host_tools` / `host_tool_call` / `host_tool_result`
  （`rpc-types.ts:45,446-481`）。知识库检索做成宿主工具，权限/审计留在应用侧。
- **内网模型**：`pi-ai` + `pi-catalog` 支持自定义 provider 与本地模型
  （`docs/local-models.md`、`docs/providers.md`），对接内网模型注册表无阻碍。
- **会话持久化**：`SessionManager` 文件型 `.jsonl` 会话，天然支持 resume/fork——与原型的会话模型吻合。
- RPC 模式默认关闭自动标题生成、支持 host 默认配置注入（`docs/rpc.md` Behavior notes）。

### 2.2 轻量化（"减肥"）清单

omp 发行形态是 `bun build --compile` 单二进制（Bun 运行时内嵌，见 `scripts/fix-dt-verdef.ts:4`）。
减肥的两个层次：

**第一层：配置面裁剪（不动代码，优先做）**
- 关掉 extensions / skills / MCP 自动发现、浏览器工具、LSP（按需）——SDK/RPC 均支持显式传入代替发现
- 不装 `browser-relay`、不触发 puppeteer 路径；禁 telemetry（OTel 全家桶是 coding-agent 直接依赖）

**第二层：编译入口裁剪（fork 后自建 entry，确认第一层不够再做）**

| 处置 | 包/目录 | 说明 |
|---|---|---|
| 保留 | `packages/agent`（agent-loop/compaction）、`ai`、`catalog`、`wire`、`utils`、`snapcompact`、`natives`（裁 feature）、`coding-agent` 的 `session/ tools/ config/ prompts/ modes/rpc/` | 核心回路 + RPC 模式 |
| 裁掉 | `modes/` 里除 `rpc` 外的交互层（interactive/TUI/composer/theme，约 3.9MB 源码）、`packages/tui`（2.5MB）、`src/web`、`src/eval`、`autoresearch`、`stats`、`metaharness`、`collab-web`、`browser-relay`、`robomp` | 全是 TUI/评测/协作/浏览器周边。注意 `tui`/`stats`/`mnemopi` 是 `coding-agent` 的 package.json 直接依赖，裁掉需连带 patch 其依赖引用；`mnemopi`（记忆引擎）建议先留、配置关闭 |
| natives 裁 feature | `crates/`：`pi-voice`（语音）、WebRTC、剪贴板等 | `packages/natives` 是单一 N-API 包（PDF/音频/WebRTC/grep/PTY/语法高亮全在里面，见其 package.json 描述），减体积要在 Rust feature 层做 |

**风险**：omp 迭代极快（版本号 18.x，上游日更）。fork 减肥 = 背上持续 rebase 的债。
所以推荐路径是三步走，且 YAGNI——前一步证明不够再走下一步：

1. 直接 spawn 官方 `omp --mode rpc`，验证链路：host tool 注册 KB 检索 + 内网 provider + 会话 resume；
2. 配置面裁剪（第一层），实测启动耗时/内存/二进制体积是否可接受；
3. 仅当 ②仍超标，才 fork 自建精简编译入口（第二层）。

## 3. 开放问题（待定，不阻塞）

- 内网如何分发 `InfiniFlow/deepdoc` 的 onnx 模型与 embedding/rerank 模型权重（HF 镜像 or 制品库）。
- 仓库仍无根级 LICENSE；引入两个上游参考副本后此事更该定了（已多次上报，等决策）。
- omp 二进制一旦进入发行物，需在 `ATTRIBUTION.md` 补 MIT 归属条目（现阶段仅本地参考副本，未分发，不触发）。
- kb-service（Python）与 omp（RPC 子进程）之间：KB 检索 host tool 由 Electron 主进程转发，
  还是 omp 直连 kb-service 的本地端口——前者审计链完整，后者少一跳。**[INFERENCE]** 倾向前者。
