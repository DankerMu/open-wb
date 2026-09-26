# Proposal: s1c-turn-control-governance

## Why

IMPLEMENTATION_PLAN.md S1c 的第一刀（2026-09-26 grill 拍板把 S1c 切为两个 change，本 change 是 A，B 为 `s1c-session-metadata-presentation`）。S0b 交付的最小对话链路只能"发一条、等到底"：没有停止、没有重新生成、没有 fork；omp 以 `--approval-mode yolo` 运行，任何 `extension_ui_request` 被 host 立即回绝；omp-supervisor 没有进程数上限，且空闲回收后 slot 留在 `#slots` 里永不清理。这些都落在 AGENTS.md Critical Path「omp 子进程治理」上，S1d（专家/技能/连接器要在进程面上做配置注入）与 S2c（KB host tool 走同一回合语义）都以它为前置。

## What Changes

- **进程池治理（F-OPS-1）**：新增配置 `OMP_MAX_PROCESSES`（默认 16）作为全局活进程上限；触顶时驱逐最久空闲的 omp 进程（数据不丢，下次 prompt 以 `--resume` 重起）；全部进程都在回合中时新 prompt 以新错误码 `agent_capacity`（503）拒绝。修复空闲回收后 slot 泄漏：进程退出即从 supervisor 槽位表移除，会话重新 prompt 时按新槽位准入。fork/regenerate 的临时进程同样计入上限。
- **停止生成（F-CHAT-7 中断）**：`POST /api/sessions/:id/stop` 向 omp 发 `abort` 帧；新增独立终态 `stopped`（`chat_sessions`/`chat_messages`/`chat_steps` 三表 CHECK 扩展，需重建表迁移 `034`）；`turn.end{status:"stopped"}`；web 状态文案「已停止」、运行中 composer 的发送按钮变为 `停止`（demo:2595-2597），停止后 Toast `已停止生成`。`agent_end` 在有界时限内未到达时退回既有 retire 路径，会话仍以 `stopped` 收尾。
- **重新生成（S1e grill 移交）**：`POST /api/sessions/:id/regenerate`，仅对末条助手消息、会话非 running 时可用；机制为 omp `get_branch_messages` → `branch{entryId=末条用户消息}` → 以原文重新 `prompt`；SQLite 在受理事务内删除旧助手行（步骤级联）、插入新 running 助手行、`omp_session_file` 更新为 branch 产生的新文件。
- **从此处分叉（F-CHAT-6 fork 子项，S0b grill 移交）**：`POST /api/sessions/:id/fork {messageId}`，`messageId` 必须是该会话的用户消息；以旧会话文件 `--resume` 起临时 omp 进程执行 `branch`，产出新会话文件后关闭该进程，原会话进程与文件不动；新会话行带 `parent_session_id`、复制标题、拷贝分叉点之前的消息/步骤行；响应含新会话与 branch 返回的用户文本，web 跳转新会话并把该文本填入草稿（不发送）。用户消息新增操作条 `从此处分叉`。
- **审批条（S1e grill 移交，与 F-OPS-1 同批）**：omp 改以 `--approval-mode write` 启动（仅 exec 档工具 bash/eval/browser/task 触发审批，读写文件不触发）。host 识别 `extension_ui_request{method:"select", options:["Approve","Deny"]}` 为审批请求，其余 UI 请求仍即时 `cancelled`。新增事件 `approval.request` / `approval.resolved`，新增表 `chat_approvals` 持久化每次审批（请求、决定、时间），待审批状态进快照以支持刷新后继续作答。`POST /api/sessions/:id/approvals/:approvalId {decision:"allow"|"deny"}` 作答；**60s 超时自动允许**（用户拍板，接受无人值守时 exec 工具照常执行）；停止请求先以 Deny 应答挂起审批再发 `abort`；挂起期间不触发空闲回收。审批决定（allow/deny/timeout）写入审计 `session.approval`。web 在助手消息内渲染审批条（`需要你的确认`/`已允许执行`/`已拒绝执行`，`允许`/`拒绝`，倒计时文案 `（<n>s 内未操作将自动允许）`（初值 60），demo:2407-2418）。
- **web 契约同步**：会话/消息/步骤状态联合类型加 `stopped`；消息快照增 `approval` 字段；SSE 事件联合增两类审批事件与 `turn.end.stopped`；`hasExactlyKeys` 严格解析随字段同步；503 `agent_capacity` 文案在 composer 内联显示。
- **验证 harness 延伸**：fake-omp 新增可脚本化行为（`abort` → `message_end aborted`+`agent_end`+response、`get_branch_messages`/`branch`/branch 后 `get_state` 新文件、`--approval-mode write` 时在 bash 前发审批 select、忽略 abort 直至 select 被应答）；`smoke/chat.hurl` 在首轮作答审批并增停止用例（回合控制条目以 Hurl 变量 `skip_turn_control` 模板化，`make smoke`=false、`make smoke-live`=true）；ui-walk 对真 omp 增审批条与停止步骤；**控制面同步**：Makefile `smoke`/`smoke-live` 两条配方各加一个 `--variable`，`scripts/test-ci-harness.sh` oracle 同 PR 跟随；不新增 Make 目标、CI job 或 env。

## 功能覆盖声明

覆盖 F-OPS-1（每活跃会话一个、空闲回收、数量上限）、F-CHAT-7（生成中断；「继续」由 demo 无对应控件，以"停止后可继续发 prompt"承担）、F-CHAT-6 的 fork 子项，以及 S1e grill 移交的重新生成与审批条。**与 IMPLEMENTATION_PLAN S1c Outcome 的偏离**：会话分组侧栏、三场景、对话内搜索、回合产物呈现（F-CHAT-9）、深度思考折叠（F-CHAT-10）按 2026-09-26 grill 切入 change B，不在本 change。

**与 demo 的有意偏差（留痕）**：
1. 审批超时 60s（demo 15s），方向同 demo 为自动允许；拒绝真实生效（demo 拒绝后仍照常输出，是演示缺陷）。
2. 停止后会话状态为 `stopped`（demo 停止后侧栏点仍为 running，是演示缺陷）。
3. fork 入口在用户消息操作条（demo 无 fork UI）；重新生成只对末条助手消息（demo 允许任意助手消息且无流式守卫）。
4. 审批条只在真实 exec 工具调用时出现（demo 由 `/销售|周报/` 正则触发）。

## Non-goals

- 会话↔工作空间绑定、场景、置顶/重命名/删除、分区侧栏、对话内搜索、思考折叠、文件变更卡/产物卡 → change B `s1c-session-metadata-presentation`。
- 每会话审批模式切换（「允许完全访问」开关）→ S3b 权限面（grill Q19）。
- 每账号进程上限（grill Q8 只要全局上限）；omp 内存限额（cgroup）→ S4b 部署包。
- 整会话克隆（omp `--fork`）；助手消息上的 fork 入口。
- 审批条以外的 `extension_ui_request` 交互（input/editor/confirm 仍回绝）。
- 池数值定参以外的性能压测（并发多会话压测在 VPS 上作为验收动作，不产生代码）。

## Capabilities

### New Capabilities

- `omp-pool`：全局活进程上限、最久空闲驱逐、`agent_capacity` 拒绝、进程退出即释放槽位、临时进程计入上限。
- `turn-control`：停止（abort 帧、`stopped` 终态、有界退回）、重新生成（branch + 重发）、从此处分叉（临时进程 branch + 行拷贝）三条 REST 与其状态机。
- `tool-approval`：审批请求识别、`chat_approvals` 持久化、`approval.*` 事件、作答 REST、60s 自动允许、停止前 Deny、审计事件、web 审批条。

### Modified Capabilities（各有 `specs/<capability>/spec.md` 的 `## MODIFIED Requirements` delta）

- `omp-runtime`：spawn 契约 `--approval-mode yolo` → `write`；RPC IO 不再对审批 select 自动 `cancelled`（其余 UI 请求不变）；新增 `abort` 发送与对 `get_branch_messages`/`branch`/`get_state` 的相关请求 API；进程退出上报给 supervisor（`onExit` 接线）。
- `chat-sessions`：schema 迁移 `034`（三表 `stopped`、`chat_sessions.parent_session_id`、`chat_approvals`）；REST 新增 stop/regenerate/fork/approvals 四路；消息快照增 `approval`；`finishTurn` 支持 `stopped`。
- `chat-stream`：归约 `message_end{stopReason:"aborted"}` → `turn.end{status:"stopped"}`（不再记为失败）；新增 `approval.request`/`approval.resolved` 事件；`turn.end.status` 联合加 `stopped`。
- `chat-web`：状态文案与联合类型加 `stopped`；composer 运行中的 `停止` 按钮；末条助手消息 `重新生成`、用户消息 `从此处分叉` 操作；审批条组件；`agent_capacity` 内联文案；解析器与归约器同步。
- `http-service-skeleton`：错误码新增 `agent_capacity`（503，`Agent 容量已满，请稍后重试`）与 `approval_settled`（409，`该审批已处理`），十一码 → 十三码；配置项新增 `OMP_MAX_PROCESSES`；content-parser 归属集加 `POST /api/sessions/:id/fork`、`POST /api/sessions/:id/approvals/:approvalId`。
- `omp-test-harness`：fake-omp 新脚本行为（abort/branch/approval select）与 probe 回报。
- `chat-harness`：`smoke/chat.hurl` 审批作答 + 停止用例 + `skip_turn_control` 模板化；`smoke-live` 入口配方随之传变量；ui-walk 停止与审批步骤（真 omp）。

## Impact

- 代码：`server/src/sessions/{supervisor,store,rest,events}.ts`、`server/src/sessions/omp/{process,runtime}.ts`、`server/src/core/db/migrations/034_*.sql`、`server/src/core/errors/index.ts`、`server/src/http/errors.ts`、`server/src/agent-config.ts`、`server/src/server.ts`、`server/src/core/audit`（新事件 kind）、`web/src/features/chat/*`、`web/src/lib/{api,session-contract}.ts`、`web/src/features/chat/stream.ts`、`server/test/support/fake-omp.mjs`、`smoke/chat.hurl`、`web/e2e/ui-walk*.ts`。
- 控制面：`Makefile` `smoke`/`smoke-live` 配方各加 `--variable "skip_turn_control=…"`，`scripts/test-ci-harness.sh` oracle 同步；CI 不传 `OMP_MAX_PROCESSES`；AGENTS.md 验证矩阵不新增 surface。
- 依赖：零新增 npm 依赖。omp 二进制版本不变（v18.0.10）。
- 依赖方向保持 `http → feature → core`；审批审计经 `core/audit` 既有 `emit`。
- 文档：`docs/architecture/system.md` §3.1 `sessions` 行的 supervisor 描述随归档补"上限/驱逐/审批"一句；ADR 不新增（审批超时方向为产品决策，记在本 proposal 偏差留痕与 IMPLEMENTATION_PLAN）。
