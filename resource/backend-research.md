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
2. **omp 可以做 agent 后端，但不是进程内 SDK，而是子进程 RPC**。已决策（2026-08-29）：
   **fork 并定死在 v18.0.10 / commit `33cc6b9a`，后续不再跟进上游**。SDK 要求宿主进程跑 Bun
   （`docs/sdk.md`：Requires Bun 1.3.14+；`packages/coding-agent/src` 有 900+ 处 Bun API）。
   本项目形态为 web 服务（见 `PLAN.md`），app-server 选 Bun 后 SDK 技术上可行，但仍不选：
   单进程承载全部用户会话，一崩全站，且并发多会话需绕 AgentRegistry 的单 Main 限制
   （`docs/sdk.md`）。正确姿势是每活跃会话 spawn 一个 `omp --mode rpc`（stdio JSONL）——
   崩溃隔离、每用户 cwd、资源限额，也是上游 WorkBuddy 桥接 CodeBuddy CLI 的同构架构
   （见 `app-reference/analysis/03-cli-backend.md`）。
3. **两条线的接合点**：RPC 协议的 `set_host_tools`（`packages/coding-agent/src/modes/rpc/rpc-types.ts:45`）
   允许宿主注册工具、agent 调用时回调宿主。把知识库 agentic 检索注册为 host tool，
   KB 权限过滤就留在 WorkBuddy 宿主侧，与原型的权限模型（visibleKbs/只读共享/审计）一致。
4. 许可均无障碍：RAGFlow Apache-2.0，omp MIT（版权链：Mario Zechner pi → Can Bölük → Stencil Labs）。
   据此已定根级 `LICENSE` = **Apache-2.0**（吸收目标 RAGFlow 即 Apache-2.0，MIT 内容兼容），
   见 `ATTRIBUTION.md` §4。一旦实际吸收 RAGFlow 源码，`ATTRIBUTION.md` §3 的条件义务立即生效
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
  由 app-server 管理生命周期。这不违背"不拉起完整 RAGFlow 服务"——它不是 RAGFlow
  的 api server，只是吸收代码后的宿主进程；Python 重依赖（onnx/torch）也不该塞进 app-server 进程。

## 2. oh-my-pi（v18.0.10）作为 agent 后端

### 2.1 集成通道判定

| 通道 | 可行性 | 依据 |
|---|---|---|
| 进程内 SDK（`createAgentSession`，`packages/coding-agent/src/sdk.ts:1278`） | ❌ 不选 | 要求宿主跑 Bun（`docs/sdk.md`）；即便 app-server 用 Bun，单进程承载全部用户会话缺乏崩溃隔离，多会话还需绕 AgentRegistry 单 Main 限制——多用户 web 服务下子进程隔离价值更高 |
| **子进程 RPC（`omp --mode rpc`）** | ✅ 推荐 | `docs/rpc.md`：stdio JSONL，ready 帧协商、1MiB 帧 + v2 分块重组、自带 TS/Python `RpcClient`。官方先例：`python/robomp` 就是外部服务按 issue 驱动 `omp --mode rpc`（`docs/user-facing-packages.md`）；社区 `apoc/omp-desktop` 同路 |
| ACP 模式（`src/modes/acp/`） | 备选 | 编辑器标准协议，功能面窄于自家 RPC |

关键能力对齐 WorkBuddy 需求：

- **host tools**：`set_host_tools` / `host_tool_call` / `host_tool_result`
  （`rpc-types.ts:45,446-481`）。知识库检索做成宿主工具，权限/审计留在应用侧。
- **内网模型**：`pi-ai` + `pi-catalog` 支持自定义 provider 与本地模型
  （`docs/local-models.md`、`docs/providers.md`），对接内网模型注册表无阻碍。
- **会话持久化**：`SessionManager` 文件型 `.jsonl` 会话，天然支持 resume/fork——与原型的会话模型吻合。
- RPC 模式默认关闭自动标题生成、支持 host 默认配置注入（`docs/rpc.md` Behavior notes）。

### 2.2 减肥策略（定稿）

前提决策：fork 定死在 `33cc6b9a`（v18.0.10），不合并上游。这消掉了"持续 rebase 债"，
换来两个新风险，列在阶段 0。omp 发行形态是 `bun build --compile` 单二进制
（Bun 运行时内嵌，见 `scripts/fix-dt-verdef.ts:4`），减肥按收益/风险比分五个阶段，
**每个阶段结束都跑同一套冒烟脚本 + 记录三项指标**（见"验收"）。

**阶段 0 —— 冻结基线**

- fork 到自有仓库，打 tag（如 `workbuddy-base` = `33cc6b9a`）；Bun 锁 `1.4.0`
  （根 `package.json` 的 `packageManager` 字段）。
- 冻结的代价，认了但要记录：① 上游安全修复无法自动获得，只能自查自修；
  ② `pi-catalog` 内置模型库随时间过期——内网模型走自定义 provider 不受影响，
  但若将来要接新的公网模型，需手工补 catalog 条目。
- 先构建一次官方全量二进制，记录基线：体积 / 冷启动到 ready 帧耗时 / 空载 RSS。

**阶段 1 —— 入口收敛（不删代码，靠打包器摇树；收益最大、风险最低，先做）**

- 新建精简入口 `packages/coding-agent/src/rpc-main.ts`：只挂运行时初始化
  （`src/modes/runtime-init.ts`）+ RPC 模式（`src/modes/rpc/rpc-mode.ts`），
  不 import `src/cli.ts`、`interactive-mode.ts`、TUI/composer/theme/setup-wizard。
- `bun build --compile --minify` 以 `rpc-main.ts` 为入口出 `omp-rpc` 单二进制；
  交互层、`src/web`、`src/eval` 等未被引用的子树由打包器摇掉。
- **[INFERENCE]** `rpc-mode.ts` 的 import 闭包不含 TUI（RPC 是 stdio 协议，无终端渲染），
  摇树应能剥离 `pi-tui`；以阶段 1 的体积对比实测验证，若摇不掉说明有隐蔽引用，转阶段 2 处理。

**阶段 2 —— 依赖面裁剪（删包 + patch，仅当阶段 1 指标不达标）**

- 直接删除的 workspace 包（无 rpc 链路引用）：`metaharness`、`collab-web`、
  `browser-relay`、`typescript-edit-benchmark`、`python/robomp`。
- 需要 patch 才能删的（是 `coding-agent` 的 package.json 直接依赖）：
  `pi-tui`（仅交互模式引用，随阶段 1 入口已不进产物，删包时同步去依赖声明）、
  `omp-stats`（去掉 `omp stats` 子命令注册）。
- **保留但配置关闭**：`mnemopi`（记忆引擎）——它嵌在 session 链路里，删除要动核心代码，不值。
- 去掉 `puppeteer-core` 依赖与 `patches/puppeteer-core@25.3.0.patch`（浏览器工具整条链路
  不进 rpc 入口）。
- OTel：保留 `@opentelemetry/api`（类型与 no-op 实现），移除 exporter/sdk 系列；
  先实测默认路径是否惰性加载——若本来就不初始化，此项跳过。

**阶段 3 —— natives 裁 feature（Rust 层，仅当二进制/内存仍超标）**

- `packages/natives` 是单一 N-API 包，PDF/音频/WebRTC/grep/剪贴板/图像/语法高亮/PTY/shell
  全在一个 .node 里（见其 package.json 描述）；裁剪要在 `crates/` workspace 的 feature 层做。
- 保留：shell/PTY（bash 工具）、grep/walker（文本检索）、`pi-ast`（语法）、PDF（附件解析可能用）。
- 裁掉：`pi-voice`（语音）、WebRTC、剪贴板；图像处理视附件功能取舍。
- JS 侧 addon 加载器（`docs/natives-addon-loader-runtime.md`）需同步容错缺失符号。

**阶段 4 —— 运行时配置面（随发行物固化的 host 默认值）**

- extensions / skills / slash-commands 自动发现：关，改由 WorkBuddy 经 RPC 显式注入。
- MCP：**保留**（原型"连接器"页依赖），但只走显式配置，不自动发现。
- 浏览器工具、computer-use：关；LSP 默认关、按工作空间语言按需开。
- telemetry：关。
- 会话目录、内网模型 provider、审计事件订阅由 app-server 在 RPC 会话建立时注入
  （`docs/rpc.md`：host 默认值仅在未显式配置时生效，项目/全局配置仍是权威）。

**验收（减肥完成的定义）**

- 指标：二进制体积、冷启动到 ready 帧耗时、空载 RSS——每阶段与阶段 0 基线对比；
  绝对目标在基线实测后定（先验数字没有意义）。
- 功能门槛（冒烟脚本全绿）：RPC v2 握手与分块、`set_host_tools` 注册 KB 检索并完成一次
  host_tool_call 往返、prompt 流式事件、session resume/fork、内网 provider 对话、
  bash/read/edit/write 内置工具。
- 顺序纪律：阶段 1 先做并实测；2/3 只在数字不达标时进入；4 独立于 1-3，随集成一起做。

## 3. 开放问题（待定，不阻塞）

- 内网如何分发 `InfiniFlow/deepdoc` 的 onnx 模型与 embedding/rerank 模型权重（HF 镜像 or 制品库）。
- ~~根级 LICENSE~~ 已定 Apache-2.0；~~omp 归属条目~~ 已入 `ATTRIBUTION.md` §3（2026-08-29）。
- omp 冻结后的安全修复策略：出高危 CVE 时是自修还是例外性 cherry-pick，届时再定。
- kb-service（Python）与 omp（RPC 子进程）之间：KB 检索 host tool 由 app-server 转发，
  还是 omp 直连 kb-service 的本地端口——前者审计链完整，后者少一跳。**[INFERENCE]** 倾向前者。
