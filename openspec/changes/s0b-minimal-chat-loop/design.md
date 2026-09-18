# Design: s0b-minimal-chat-loop

## Context

S0a 留下的接缝：`createApp({db,...})` 插件装配、`registerAuth` + root guard（`request.principal` 唯一写者）、统一错误信封 `{error:{code,message}}`（`http/errors.ts` 的 typed 定义表 + `CONTENT_PARSER_OWNED_ROUTES` 路由归属集）、`openDb` 迁移基座（`0010/002/010`）、web `ApiClient` 与四路由壳（`web/test/routes.test.tsx` 钉住 `/` 占位文案）、hurl/Playwright harness 与 CI 编译服务脚本（`.github/scripts/ci-compiled-server.sh`）。omp v18.0.10 RPC 契约以 `resource/oh-my-pi/docs/rpc.md` 为准：stdio JSONL、`ready` 帧、`negotiate_protocol v2` + `rpc_chunk`、`prompt` 立即 ack、`agent_end.isTerminal`、`message_update.assistantMessageEvent` 增量、`message_end.message.stopReason/errorMessage`（`packages/ai/src/types.ts:959-961`）、`tool_execution_start{toolCallId,toolName,args}` / `tool_execution_end{toolCallId,toolName,result,isError?}`（`packages/agent/src/types.ts:883-885`）、`extension_ui_request` 可被 `cancelled` 回绝。openai-completions 对自定义 provider 的 `apiKey` 默认注入 `Authorization: Bearer`（`packages/ai/src/providers/openai-shared.ts:332`，无需 `authHeader: true`）。已定 ADR：0001（含二进制供给补充）、0006、0008（含开发期上游补充）、0010。

**Oracle 差异（显式记录，不静默改写）**：`docs/architecture/system.md:35` 写"会话正文在所有者沙箱内 omp `.jsonl`"，S0b grill ③ 由用户裁定 SQLite 为历史事实源、omp `.jsonl` 只供 resume 且放在 `OMP_STATE_DIR` 而非沙箱。system.md 该行以单独 docs 提交对齐（与 fork 脚注同法），本 change 不改 oracle。

## Goals / Non-Goals

**Goals:**
- 浏览器一次流式对话渲染完整（正文增量 + 工具步骤卡），P0 里程碑。
- 刷新/断线后续流：断线经 `Last-Event-ID` 回放；**页面刷新（无 `Last-Event-ID`）在回合进行中**重放当前回合；缓冲缺口时退化为 REST 重载而非丢内容。
- 杀掉 omp 子进程后下一条 prompt 以 `--resume` 接续，同一会话历史不丢；app-server 自身重启后残留的 `running` 会话可恢复可用。
- omp 子进程声明环境零上游凭证；上游密钥只存在于 app-server 进程（同 uid 下的 `/proc` 读取向量见 Risks，S1a/ADR-0010 关闭）。
- 全部行为在假上游下可在 CI 确定性验证；真实上游只在手动目标。

**Non-Goals:**（与 proposal 同源，此处为设计视角的边界）
- 停止/steer/follow-up 队列语义、多会话池、fork、分组、三场景（S1c）。
- host tools（`set_host_tools`）、附件、RAG（S2c）。
- 审批 UI 与 `extension_ui_request` 的任何交互式处理（一律 cancelled）；思考内容；重新生成。
- 用量计量/限额；omp uid 分离；沙箱越界拦截；技能/规则/扩展/LSP 面。
- 从 omp 读历史（`get_messages_page`）——历史来自 SQLite。
- 跨服务器重启的事件回放（缓冲仅内存；重启后统一走 `replay.gap`）。

## Decisions

1. **模块切分**（依赖方向 `http → feature → core`，与 system.md §5 目录树一致：omp 运行时是 `sessions/omp/`、事件流是 `sessions/stream/`，都是 `sessions` 的内部接缝）：
   - `server/src/sessions/omp/`：`process.ts`（`OmpProcess`：spawn 契约、JSONL 帧编解码、协商、`id` 相关、退出观察）与 `runtime.ts`（`SessionRuntime`：一会话一进程的生命周期与 idle 计时）。只依赖 `node:child_process`/`node:fs`，**不 import** `sessions` 其余部分或 `model-proxy`。
   - `server/src/model-proxy/`：`registerModelProxy(app, {upstream, tokens})`——`tokens` 是只读接口 `{ lookup(token): sessionId | null }`；`models-yml.ts` 的 `writeManagedModelsYml(agentDir, {proxyBaseUrl, modelId})`。**不 import** `sessions`。
   - `server/src/sessions/`：`store.ts`（`chat_*` 读写）、`events.ts`（帧→事件纯映射）、`tokens.ts`（`TokenRegistry` 实现）、`supervisor.ts`（sessionId → `SessionRuntime`）、`rest.ts`（四端点）、`stream/ring-buffer.ts`（事件序号与环形缓冲）、`stream/sse.ts`（事件端点）、`index.ts`（`registerSessions(app, deps)` 同时挂 REST 与 SSE）。对 `model-proxy` 的耦合只通过装配层注入的 `{ proxyBaseUrl(): string; tokens: TokenRegistry }`。
   - `app.ts` 装配顺序：auth → guard → model-proxy（`/v1/*` 显式路由，bearer 自行鉴权，不在 `/api` 命名空间因此不受 cookie guard；Fastify 按路由特异性匹配，注册顺序不影响其优先于静态兜底）→ sessions（`/api/sessions*` 含 SSE，受 guard）→ 既有 `/api/*` 404 → 静态。
2. **子进程 spawn 契约**（`OmpProcess.spawn`）：
   - 命令：`<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<principal.id> --session-dir <OMP_STATE_DIR>/sessions/<principal.id> --model workbuddy/<MODEL_ID> --approval-mode yolo --no-extensions --no-lsp --no-pty --no-title [--resume <omp_session_file>]`；`--resume` **仅当** `chat_sessions.omp_session_file` 非 null 时追加，否则冷启动新 omp 会话（连续性由 SQLite 历史保证，omp 侧上下文从空开始——这是握手未完成即崩溃时的诚实退化）。
   - 环境为**显式白名单且不继承 `process.env`**：`PATH`、`LANG`、`TMPDIR`、`HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`、`WORKBUDDY_MODEL_TOKEN=<每会话 token>`。测试断言 env 键集合**精确等于**该集合（`LANG`/`TMPDIR` 在父进程缺席时不设，断言按此条件化）。这是不变量 4 的**必要非充分**条件：它封死"声明环境"向量；同 uid 下 omp bash 仍可读 `/proc/<app-server pid>/environ`（ADR-0010 指出的向量），由 S1a 的 uid 分离关闭，S0b 不宣称不变量 4 成立。
   - 目录由 app-server 在 spawn 前 `mkdir -p`；`agent/models.yml` 由启动期 `writeManagedModelsYml` 写入（幂等覆盖）：provider `workbuddy`，`api: openai-completions`，`baseUrl: <proxyBaseUrl>`，`apiKey: WORKBUDDY_MODEL_TOKEN`（环境变量名语义，providers.md:56），`models: [{id: <MODEL_ID>, name, contextWindow: 128000, maxTokens: 8192}]`。不写 `authHeader`（默认即 Bearer，见 Context）。
   - 启动握手：读到 `ready` 帧 → 发 `negotiate_protocol 2` 成功 → 发 `get_state`；响应 `sessionFile` 为非空字符串才算握手成功并写回 `chat_sessions.omp_session_file`，**缺失/空视为握手失败**（终止子进程，spawn 以 `agent_unavailable` 失败）。握手超时（默认 10s）同样失败。
   - `rpc_chunk` 按 rpc.md 校验 `chunkId/index/count/byteLength`、拒绝交错、限 `maxReassembledFrameBytes`。
3. **每会话生命周期**（`SessionRuntime`，grill ②）：懒启动——第一条 prompt 触发 spawn；每次收到 omp 事件或 prompt 重置 idle 计时器（`OMP_IDLE_MS` 默认 600000）；idle 到期或服务关停：关 stdin → 等待退出（宽限 5s）→ `SIGTERM` → 再 3s → `SIGKILL`；退出后注销 token、清空缓冲（下一 epoch 重新计数）。子进程在回合中意外退出：当前 assistant 消息置 `failed`（正文为已刷盘 + 内存中未刷盘的增量，一并落盘），先发 `error` 再发 `turn.end{status:"failed"}`，runtime 丢弃；下一条 prompt 按 D2 规则 spawn。
4. **存储**（迁移 `020_chat_sessions.sql`，grill ③）：
   - `chat_sessions(id TEXT PK, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, title TEXT NULL, status TEXT NOT NULL CHECK IN ('idle','running','done','failed'), omp_session_file TEXT NULL, stream_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`，索引 `(owner_id, updated_at DESC)`。
   - `chat_messages(id INTEGER PK AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, role TEXT CHECK IN ('user','assistant'), content TEXT NOT NULL DEFAULT '', status TEXT CHECK IN ('done','running','failed'), created_at INTEGER NOT NULL)`。
   - `chat_steps(id INTEGER PK AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT CHECK IN ('running','done','failed'), started_at INTEGER NOT NULL, ended_at INTEGER NULL, UNIQUE(message_id, ordinal))`。
   - 会话 id 为 CSPRNG 128-bit lowercase hex；标题在首条 prompt 时取消息前 18 个字符（demo:2251）。写入时机：user 消息与空的 running assistant 消息在 prompt 受理时同事务插入；step 事件即时落盘；**正文刷盘节奏**：`text.delta` 先累加到内存，回合进行中**每 2s 或每累计 2KB 刷一次**（取先到者），`turn.end` 时做最终刷盘——因此崩溃丢失上限 ≤ 2s/2KB 的增量，且回合中崩溃时把内存残量一并落盘后再标 `failed`（实际丢失为 0，2s/2KB 只是 app-server 自身被 kill 时的上限）。
   - **启动对账**：`registerSessions` 在受理任何请求前，把所有 `status='running'` 的会话及其 `running` 消息置为 `failed`（此时不可能有活 runtime），避免上次进程被杀留下的永久 409。
5. **事件契约与回放**（grill ④⑩）：
   - 事件类型：`turn.start{messageId}`、`text.delta{messageId,delta}`、`step.start{messageId,stepId,name,detail}`、`step.end{messageId,stepId,status,detail}`、`turn.end{messageId,status:"done"|"failed"}`、`error{messageId?,message}`、`replay.gap{}`。SSE 帧：`id: <streamEpoch>:<seq>`、`event: <type>`、`data: <json>`；每 15s 一条 `: keepalive` 注释。
   - omp → 事件映射：`agent_start` → `turn.start`；`message_update.assistantMessageEvent.text_delta` → `text.delta`（`thinking_*`/`toolcall_*` 丢弃）；`tool_execution_start{toolName,args}` → `step.start`（detail = `args` JSON 单行摘要 ≤120 字符）；`tool_execution_end{isError}` → `step.end`（`isError` → `failed`）；**失败判定**：`message_end` 的 `message.role==="assistant"` 且 `stopReason ∈ {"error","aborted"}` → 记录 `errorMessage`；随后的 `agent_end && isTerminal !== false` → 若本回合记录过失败则先发 `error{message: errorMessage}` 再发 `turn.end failed`，否则 `turn.end done`；进程异常退出/同 id 失败响应 → 先 `error` 再 `turn.end failed`（`error` 恒先于 `turn.end`）。`extension_ui_request` → 立即 `{type:"extension_ui_response", id, cancelled:true}`。
   - `streamEpoch` 每次 runtime 创建（含 resume 重 spawn）时 `chat_sessions.stream_epoch += 1`；`seq` 在 epoch 内从 1 单调递增。环形缓冲每会话保留当前 epoch 最近 1000 条。
   - 订阅入口判定：(a) 带 `Last-Event-ID` 且 epoch 相同且 `seq ≥ 缓冲最小 seq − 1` → 从 `seq+1` 回放后实时；(b) 带 `Last-Event-ID` 但不满足 (a) → 先发 `replay.gap` 再实时；(c) **不带 `Last-Event-ID`**：会话 `status !== 'running'` → 直接实时；`status === 'running'` 且缓冲中仍含本回合的 `turn.start` → 从该 `turn.start` 起回放本回合事件后实时；否则发 `replay.gap` 再实时。客户端收到 `turn.start{messageId}` 时把该消息的正文与步骤**重置为空**再应用后续事件（回放与 REST 已加载的部分正文不会重复）。
   - 多订阅者：同一会话允许多个 SSE 连接（多 tab），事件扇出；连接关闭不影响 runtime。
6. **REST 契约**（受 cookie guard，全部按 `principal.id` 过滤；他人/不存在 → 404 `not_found`）：
   - `POST /api/sessions` → 201 `{id,title:null,status:"idle",createdAt,updatedAt}`。
   - `GET /api/sessions` → 200 `{sessions:[...]}` 按 `updated_at` 降序。
   - `GET /api/sessions/:id/messages` → 200 `{session, messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,status}]}]}`。
   - `POST /api/sessions/:id/prompt` body 精确 `{message:string}`（trim 后非空、≤32768 字节）→ 202 `{userMessageId, assistantMessageId}`；会话 `status=running` → 409 `session_busy`；spawn/握手失败或 `OMP_BIN` 不存在 → 502 `agent_unavailable`（会话与消息状态回滚为 prompt 前）。`status` 为 `idle/done/failed` 均可受理。**content-parser 错误归属**：`POST /api/sessions/:id/prompt` 加入 `http/errors.ts` 的 `CONTENT_PARSER_OWNED_ROUTES`，使错误 content-type / malformed JSON / 超限 body 在 handler 前即映射为 400 `bad_request`（与 login/logout 同机制）。
   - `GET /api/sessions/:id/events` → `text/event-stream`，`Cache-Control: no-store`。
   - 新错误码进入 `http/errors.ts` 表：`session_busy{409,"会话正在生成，请稍候"}`、`agent_unavailable{502,"Agent 运行时不可用"}`；表由五码扩为七码（http-service-skeleton delta spec）。
7. **model-proxy**（grill ⑤，ADR-0008）：`POST /v1/chat/completions`：`Authorization: Bearer <token>` 经 `tokens.lookup` 命中活跃 runtime 才放行，否则 401 `unauthorized`（信封）；请求体原样转发到 `${MODEL_UPSTREAM_BASE_URL}/chat/completions`，加 `Authorization: Bearer ${MODEL_UPSTREAM_API_KEY}`，透传上游状态码、`content-type` 与流式 body；上游连接失败 → 502 `agent_unavailable`。body 上限 4 MiB；该路由同样加入 `CONTENT_PARSER_OWNED_ROUTES`，超限/非 JSON → 400 `bad_request`。响应头 `Cache-Control: no-store`。不解析、不改写、不记录消息内容。上游 env 缺失时服务照常启动，代理对任何请求返回 502。**`proxyBaseUrl`**：监听后取实际地址；`HOST` 为 `0.0.0.0` → `http://127.0.0.1:<port>/v1`，`::` → `http://[::1]:<port>/v1`，其余按实际绑定地址（IPv6 加方括号）——写入 models.yml 的必须是可连接地址。
8. **配置**（`server.ts` 纯配置 seam 扩展）：`OMP_BIN`（默认 `<repo>/var/omp/omp`）、`OMP_STATE_DIR`（默认 `<repo>/var/omp-state`）、`OMP_IDLE_MS`（默认 600000，正整数）、`SANDBOX_ROOT`（默认 `<repo>/var/sandbox`）、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`（二者可缺）、`MODEL_ID`（默认 `deepseek-v4.1-flash`）。`STARTUP_MODULES` 增 `model-proxy`、`sessions`（顺序与装配一致）。启动 JSON 行与任何 stderr 输出 SHALL 不含 `MODEL_UPSTREAM_API_KEY` 值与任何会话 token（测试以哨兵值注入并断言输出不含）。
9. **假上游**（grill ⑧）：`server/test/support/fake-upstream.mjs`，零依赖 Node http 服务，`node` 可直接运行（`FAKE_UPSTREAM_PORT`）。脚本化行为：messages 中**不含** `role:"tool"` → 流式返回一个 `tool_calls`（`bash`，`{"command":"echo workbuddy-smoke"}`）并 `finish_reason:"tool_calls"`；含 `tool` 消息 → 以 ≥3 个 `delta.content` 块返回固定文本 `你好，这是 WorkBuddy 的第一条流式回复。` 后 `[DONE]`；最后一条 user 消息含 `WORKBUDDY_FAKE_ERROR` → 返回 500 JSON 错误（触发 omp 侧 `stopReason:"error"`）；缺/错 `Authorization` → 401。单测在进程内起它；smoke/ui-walk 由 CI 脚本作为独立进程启动。 假子进程 `fake-omp.mjs` 另有 **call-proxy 模式**：从 `$PI_CODING_AGENT_DIR/models.yml` 取 `baseUrl`、以 `WORKBUDDY_MODEL_TOKEN` 为 bearer 真实 POST 代理并把上游文本转为 `text_delta`——它是「日志不含密钥」场景在单测里的载体（假 omp → 代理 → 假上游），也顺带证明托管 models.yml 可被消费。
10. **web**：`web/src/features/chat/`：`page.tsx`（列表 + 新建 + 消息区 + composer）、`stream.ts`（`connectSessionEvents(id, {EventSourceCtor})` + 纯归约器 `applyChatEvent(state, event)`）、`api.ts` 扩展 `listSessions/createSession/getMessages/prompt`。**当前会话由 URL 查询参数 `?session=<id>` 表示**（刷新后可回到同一会话；路由 canonicalization 已保留 search），选择/新建会话即更新该参数。页面加载顺序：`getMessages` → 打开 `EventSource`；`turn.start` 重置对应消息（D5）；`replay.gap` → 重新 `getMessages` 后继续消费实时事件；切换会话、组件卸载、登出转为未登录态时关闭连接。`EventSource` 由构造注入以便 jsdom 用假实现。步骤卡镜像 demo `exec.steps` 三态，状态徽章镜像 `running/done/failed`。`web/test/routes.test.tsx` 中 `/` 的占位断言随 `/` 换为 ChatPage 一并更新。
11. **harness / CI**：`make omp-fetch`（读取固定版本与 SHA256 表，按 `uname -sm` 选资产，落 `var/omp/omp`，已存在且校验通过则跳过）；`make smoke-live`（要求 `MODEL_UPSTREAM_BASE_URL`/`MODEL_UPSTREAM_API_KEY` 均存在，否则显式失败并说明；对已运行服务执行 `smoke/chat.hurl`，以 `--variable content_pattern='^.+$' --variable min_bash_steps=0` 放宽为形状断言，`make smoke` 则传精确锚定文本 + `min_bash_steps=1`——同一 hurl 文件两档断言，不复制用例）。CI smoke/ui-walk job：`make omp-fetch`（每次下载 + 校验，不加 `actions/cache`：release 资产在 Actions 网络内秒级完成，且四 action 白名单 oracle `inspect-ci-workflow.js` 不必扩展）→ 启动假上游进程 → 以 `OMP_BIN`/`OMP_STATE_DIR`/`SANDBOX_ROOT`/`MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<port>/v1`/`MODEL_UPSTREAM_API_KEY=fake` 起编译服务 → `make smoke`/`make ui-walk`。`ci-compiled-server.sh` 的进程组/取消契约不改，假上游作为同组子进程由现有 reap 逻辑回收。控制面三处同步：Makefile `.PHONY` 与头注释、AGENTS.md 验证矩阵（`make omp-fetch` 前置行、`make smoke-live` 手动行）、`constraints.yaml verification.surfaces`。 **`scripts/test-ci-harness.sh` 是这三处 + workflow + Makefile recipe 的精确形状 oracle**（受保护目标集、surfaces 期望元组、job 步骤/env 元组、`.PHONY` 锚点全部硬编码）：每个改动控制面的 PR 必须同 PR 扩展该 oracle，`omp-fetch`/`smoke-live` 进入受保护目标集，否则 `make test-guardrails` 红。既有 promoted spec 的三条 Requirement（HTTP smoke / UI 走查 / CI 接线与控制面同步）由 verification-harness delta **整段重述**替换（含其全部 Scenario），http-service-skeleton 与 spa-shell 的被改 Requirement 同法。

## Sketch seams under test

- **HTTP 接口（`app.inject()` + 真实 `openDb(":memory:")`）**——REST 四端点、400/409/502/404 分支、SSE 帧（inject 读取 raw stream）与 `Last-Event-ID` 回放/缺口/刷新中重放全部经此断言；omp 以 `spawn` 注入点替换为假子进程（`server/test/support/fake-omp.mjs`，按 rpc.md 吐帧，可脚本化崩溃/不发 ready/分块/缺 sessionFile/stopReason error），不 mock Fastify/DB。选它因为它是最高的既有 seam，一次覆盖 http+sessions+db 组装。
- **`OmpProcess` 帧层（对假子进程脚本）**——ready/negotiate/chunk 重组/id 相关/异常退出/握手失败是独立可测的协议边界，与业务无关。
- **`model-proxy` 路由（`app.inject()` 对进程内假上游）**——bearer 命中/未命中、透传状态与流式 body、上游不可达 502、parser 错误 400。
- **`applyChatEvent` 纯归约器 + `ChatPage`（jsdom，注入假 `EventSource` 与 mock fetch）**——事件到 UI 状态的映射、`turn.start` 重置、`replay.gap` 重载、`?session` 恢复。
- **真实 omp v18.0.10 二进制**只在 `make smoke` / `make ui-walk`（假上游）与 `make smoke-live`（真实上游）走，不进单测；它同时是"白名单环境下 omp 可运行"的唯一证明点。

## Not yet specified

- 回合中子进程崩溃后的用户侧恢复动作（是否提供"重试上一条"）：现在只知道"标 failed 并允许发下一条"，重试语义要等 S1c 的中断/队列模型一起定。
- 多 tab 同时向同一会话发 prompt 的体验：S0b 以 409 拒绝第二方，但前端如何呈现"另一处正在生成"尚不清楚问题边界。
- `models.yml` 的 `contextWindow/maxTokens` 与真实上游模型能力的对齐方式（S0b 写死一组保守值；何时、由谁校准，随 S1d 模型注册表一起看）。

## Risks / Trade-offs

- **`--approval-mode yolo` + 未强制的沙箱**：S0b 里 omp 的 bash 以 app-server uid 在 `var/sandbox/<id>` 下执行且无越界拦截。缓解：dev/CI 环境；S1a 沙箱与 ADR-0010 uid 分离紧随其后；假上游脚本只调用 `echo`。
- **同 uid 的 `/proc` 凭证读取向量**（ADR-0010）：S0b 期间 omp bash 可读 app-server 的 `/proc/<pid>/environ`，其中含 `MODEL_UPSTREAM_API_KEY`。S0b 只封"声明环境"向量，不宣称不变量 4 成立；`constraints.yaml downgrades` 记一条到 S1a 关闭为止的窗口。
- **omp 对白名单环境的兼容性**（缺少常见变量、`HOME` 指向空目录）：以真实二进制在 `make smoke` 中验证；若 omp 需要额外变量，只能加入白名单并逐个写明理由，不得回退为继承 `process.env`。
- **同端口承载 `/v1`**：浏览器可达该路径但无 bearer 只能拿 401；不增加攻击面之外的能力。
- **正文按 2s/2KB 刷盘**：app-server 自身被 kill 时最多丢该上限内的增量；omp 崩溃不丢（内存残量落盘）。
- **假上游的工具调用依赖 omp 真实执行 `bash`**：把"步骤卡"从形状断言变成真实端到端，但引入 `--no-pty` 与 shell 可用性前提；CI ubuntu 与 macOS 均有 `/bin/sh`。
- **`get_state.sessionFile` → `--resume <path>` 回程**：cli-reference 确认 `--resume` 接受路径，`get_state` 返回 `sessionFile`；首次 `make smoke` 的 kill-resume 用例是该回程的真实证明点。

## Migration Plan

新增迁移 `020_chat_sessions.sql` 走既有 `openDb` 顺序执行；无既有数据迁移。启动对账只改 `status` 列。回滚 = 移除模块注册与迁移文件（开发期库可删 `var/dev.db`）。
