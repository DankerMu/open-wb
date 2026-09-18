# Proposal: s0b-minimal-chat-loop

## Why

IMPLEMENTATION_PLAN.md S0b：S0a 已交付 HTTP 骨架、dev-stub 认证、SPA 壳与 smoke/UI 走查 harness，但服务里还没有任何 Agent 能力——`/` 会话页是占位壳。本阶段把"浏览器 → app-server → omp 子进程 → 模型"整条最小链路打通并可验证：**P0 里程碑验收 = 浏览器一次流式对话渲染完整**（流式正文 + 工具步骤卡），刷新/断线后续流，杀掉 omp 子进程后会话可 resume。这是 S1c（会话治理）、S2c（KB 接入会话）与 S4a（omp 减肥回归基线）的前置。

## What Changes

- **omp 运行时供给与子进程契约**：`make omp-fetch` 按 ADR-0001 补充拉取官方 release **v18.0.10** 二进制到 `var/omp/`（对照 release `SHA256SUMS.txt` 校验，darwin-arm64 / linux-x64），CI 同法并缓存。app-server 以每活跃会话一个 `omp --mode rpc` 子进程运行（grill 已定：首次 prompt 懒启动、空闲超时退出、`--resume` 重 spawn）；子进程环境为显式白名单，`PI_CODING_AGENT_DIR`/`HOME`/`--session-dir`/`--cwd` 全部指向 app-server 托管目录（grill 事实项：绝不读开发机 `~/.omp`）。RPC 客户端实现 ready 帧 → `negotiate_protocol v2` → `rpc_chunk` 重组 → `id` 相关 → 回合以 `agent_end && isTerminal !== false` 结束。
- **model-proxy（F-OPS-2，ADR-0008）**：app-server 暴露 `POST /v1/chat/completions` 流式透传端点；omp 经托管 `models.yml` 的自定义 provider 指向它，凭证仅为每会话随机 256-bit bearer（未知/已失效 → 401）；上游 base URL / key 只在 app-server 配置（grill 已定：开发期上游为公网 OpenAI 兼容替身，值不入库）。grill 已定：S0b 只做透传 + bearer，用量计量/限额延后（见 Non-goals）。
- **会话与消息（F-CHAT-6 落盘 + resume）**：SQLite 新增 `chat_sessions` / `chat_messages` / `chat_steps`（迁移 `020`）；REST：创建、列出（仅本账号）、读消息、发 prompt（回合进行中 → 409）；启动时把上次进程遗留的 `running` 会话对账为 `failed`，避免永久 409。grill 已定双存储：omp `.jsonl` 只供 `--resume`，SQLite 是历史展示与回放缺口回退的事实源。他人会话一律 404（不泄漏存在性）。
- **SSE 事件流（F-CHAT-3 + F-CHAT-8，ADR-0006）**：`GET /api/sessions/:id/events`；app-server 把 omp 事件归一化为小型事件集 `turn.start / text.delta / step.start / step.end / turn.end / error`（grill 已定），事件 id 为 `<streamEpoch>:<seq>`；每会话环形缓冲，`Last-Event-ID` 命中缓冲则回放，否则发一条 `replay.gap` 由客户端从 REST 重载（grill 事实项）。
- **`/` 会话页（web）**：本账号会话扁平列表（最新在前）、新建会话、输入框、消息列表（流式正文 + 步骤卡 + 状态徽章）、当前会话以 `?session=<id>` 表示以支持刷新恢复、`EventSource` 自动重连续流、回合中刷新按 `turn.start` 重放、`replay.gap` 触发重载（grill 已定最小链路）。
- **验证 harness 延伸**：仓内确定性假 OpenAI 兼容上游（一次工具调用 + 分块正文）供单测 / `make smoke` / `make ui-walk` 使用；新增 `smoke/chat.hurl` 与 Playwright 走查的对话步骤；CI smoke/ui-walk job 增加 omp 拉取与假上游启动；`make smoke-live` 仅在上游 env 存在时手动打真实上游（grill 已定 CI 不碰真实上游）；Makefile / AGENTS.md 验证矩阵 / `constraints.yaml` verification 段三处同步。

## 功能覆盖声明

**与 IMPLEMENTATION_PLAN S0b Files 的偏离**：计划列有 `models(最小登记)`；S0b 以配置项 `MODEL_ID` + 托管 `models.yml` 承担最小模型选择，不建 `models` 模块——模型注册表（登记 + 探活，F-CTR-MOD）整体属 S1d，届时以注册表替换该配置项。特此留痕。

覆盖 F-CHAT-3（流式对话 + 执行步骤卡片）、F-CHAT-6（会话落盘、resume；**fork 按 grill 裁定归 S1c**，IMPLEMENTATION_PLAN 覆盖表脚注另提交）、F-CHAT-8（断线/刷新续流）、F-OPS-2（模型代理，omp 环境零凭证）。

## Non-goals

- 停止生成（omp `abort`）、三场景、会话分组侧栏、fork、多会话池治理/上限/内存限额——S1c。
- 附件双语义、RAG 检索卡、KB host tool——S2c；`set_host_tools` 在 S0b 不发送。
- 审批卡 UI：S0b 以 `--approval-mode yolo` 起 omp，任何 `extension_ui_request` 由 host 立即 `cancelled: true` 回绝不悬挂；审批交互形态待沙箱强制（S1a）落地后再议。
- 重新生成、点赞、思考内容展示（`thinking_delta` 丢弃）、会话删除/重命名。
- model-proxy 的用量计量、限额与审计（ADR-0008 后果之一）——grill 已定有意延后到 S3b 审计面落地时。
- omp 子进程与 app-server 的 uid 分离（ADR-0010）——S1a；S0b 在 macOS 开发机与 CI 同 uid 运行。
- 沙箱边界强制（`core/sandbox` resolve/白名单）——S1a；S0b 只提供每账号 cwd 目录雏形。
- omp 技能/规则/扩展/LSP 面（`--no-extensions --no-lsp`，技能规则属 S1d）。

## Capabilities

### New Capabilities

- `omp-runtime`：v18.0.10 二进制供给（make/CI）、子进程 spawn 契约（参数/环境白名单/托管目录）、RPC 客户端（协商/分块/相关/回合终点）、每会话生命周期（懒启动/空闲退出/关停/resume）。
- `model-proxy`：`/v1/chat/completions` 流式透传、每会话 bearer、上游配置、托管 `models.yml` 生成、假上游夹具契约。
- `chat-sessions`：会话/消息/步骤 schema 与迁移、REST 端点、本账号隔离、prompt 回合状态机、omp 事件到 SQLite 的落盘。
- `chat-stream`：归一化事件集、事件 id/环形缓冲/回放/缺口语义、SSE 端点契约。
- `chat-web`：`/` 页面、API 客户端扩展、事件流消费与状态归约、断线重连。
- `chat-harness`：假上游进程、`smoke/chat.hurl`、Playwright 对话步骤、CI 接线、`make omp-fetch` / `make smoke-live`、控制面三处同步。

### Modified Capabilities（各有 `specs/<capability>/spec.md` 的 `## MODIFIED Requirements` delta）

- `http-service-skeleton`：错误信封新增两码 `session_busy`（409）、`agent_unavailable`（502）并把 `POST /api/sessions/:id/prompt`、`POST /v1/chat/completions` 加入 content-parser 错误归属集；`server.ts` 启动模块清单增 `sessions`、`model-proxy` 并新增配置项（`OMP_BIN`、`OMP_STATE_DIR`、`OMP_IDLE_MS`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY`、`MODEL_ID`）。
- `spa-shell`：`/` 路由从占位壳换为会话页；`ApiClient` 增会话四方法。
- `verification-harness`：smoke/ui-walk 增对话用例；CI job 增 omp 拉取与假上游；新增 `make omp-fetch`、`make smoke-live`。

## Impact

- 代码：`server/src/sessions`（含内部接缝 `sessions/omp/`，与 system.md §5 目录树一致）与 `server/src/model-proxy`（新模块）、`server/src/core/db/migrations/020_chat_sessions.sql`、`server/src/{app,server,http/errors}.ts`（装配/配置/错误码）、`web/src/features/chat`、`web/src/lib/api.ts`、`web/src/routes/router.tsx`、`server/test/support/fake-upstream.mjs`、`smoke/chat.hurl`、`web/e2e/ui-walk.spec.ts`。
- 构建/控制面：`Makefile`（`omp-fetch`、`smoke-live`、`.PHONY`）、`.github/workflows/ci.yml` 与 `.github/scripts/`（omp 拉取、假上游启动）、`knip.json`（新入口如有）、`AGENTS.md` 验证矩阵/Directory Map、`constraints.yaml` verification 段、`.gitignore`（`var/` 已覆盖）。
- 依赖：**零新增 npm 依赖**——子进程用 `node:child_process`，HTTP 上游用 Node 内建 `fetch`，SSE 用 Fastify 原生 reply raw stream，SQLite 沿用 `node:sqlite`。omp 二进制为运行时外部依赖，不进 package.json。
- 依赖方向保持 `http → feature → core`：`model-proxy` 与 `sessions` 不互相 import；`sessions` 经构造注入拿到"模型代理 base URL 与 token 登记"接口。
