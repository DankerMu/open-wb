# Design: s1c-turn-control-governance

## Context

见 proposal.md「Why」。现状接缝（均以 master `4ea3377` 为准）：

- `SessionSupervisor`（`server/src/sessions/supervisor.ts`）按会话持 `Slot`，`#dispatchNew` 无上限；空闲回收发生在 `SessionRuntime` 内部（`runtime.ts` `#retire`），supervisor 未传 `onExit`，回收后 `Slot` 留在 `#slots`（进程已死、下次 prompt 复用该 slot 重 spawn）——这是 slot 泄漏的根因。
- `OmpProcess`（`omp/process.ts`）已有相关请求 API `request(frame)`（握手用 `negotiate_protocol`/`get_state`），`send` 为无应答写入；对所有 `extension_ui_request` 在 `#onFrame` 内即时回 `{cancelled:true}`。argv 含 `--approval-mode yolo`。
- 纯归约 `applyFrame`（`events.ts`）把 `message_end{stopReason:"aborted"}` 记为失败，`agent_end` 时发 `error` + `turn.end failed`。
- `store.ts` `finishTurn` 只接受 `done|failed`；三表 CHECK 枚举不含 `stopped`，SQLite 不能 ALTER CHECK。
- web 解析（`web/src/lib/session-contract.ts`、`stream.ts`）用 `hasExactlyKeys`，任何新字段/新枚举值都要 server+web 同刀，否则旧页面把整个响应判为非法。
- omp v18.0.10 协议事实（`resource/oh-my-pi/`）：`abort` 帧 → `message_end{stopReason:"aborted"}` → `agent_end` → `response{command:"abort"}`，之后可继续 prompt；`get_branch_messages` 返回 `[{entryId,text}]`（仅用户消息）；`branch{entryId}` 写新会话文件（内容为该用户消息之前的历史）、进程切到新文件、返回 `{text}`；无原生 regenerate；审批以 `extension_ui_request{method:"select",title:"Allow tool: <name>…",options:["Approve","Deny"]}` 下发、无超时无默认、应答 `{value:"Approve"}` 即允许，其它一律视为拒绝；`abort` 会等待未应答的 select（agent loop 无竞速）；`--approval-mode` 不能运行时改。
- 审计（`core/audit`）只有 `emit(db,event)`；现有 kind 为 `sandbox.reject`、`workspace.create`。

**Oracle 差异（显式记录）**：`docs/architecture/system.md:36` `sessions` 行写"omp-supervisor（每活跃会话 spawn、空闲回收、数量上限）"，数量上限至今未实现；本 change 实现后该行随 tasks 9.1 补一句（全局上限/最久空闲驱逐/审批经 host 应答）。`IMPLEMENTATION_PLAN.md:207-208` S1c Outcome 把审批条写为"允许/拒绝/超时自动通过"，与 grill 结论一致（超时自动允许）。

## Goals / Non-Goals

**Goals:**
- 活 omp 进程数受 `OMP_MAX_PROCESSES` 硬约束；触顶时可预测地驱逐最久空闲进程；不可驱逐时以 503 拒绝而非无界 spawn。
- 用户能在回合中停止，停止后会话进入独立 `stopped` 终态且可继续对话；停止在有界时间内一定收尾。
- 末条助手回答可重新生成，历史中不残留旧回答；任意用户消息处可分叉出新会话且原会话不受影响。
- exec 档工具调用经用户审批；审批状态可持久、可回放、刷新后可继续作答；超时与停止的方向明确且可审计。
- 跨端契约按 D6 次序落地（`approvals` 键与 `approval.*` 事件 server/web 同刀；`stopped` 枚举 web 先解析、server 后发出），`make check`/`make smoke`/`make ui-walk` 全绿。

**Non-Goals:**
- change B 范围（空间绑定、场景、分区侧栏、重命名/删除/置顶、对话内搜索、思考折叠、文件变更卡/产物卡）。
- 每会话审批模式切换、每账号上限、内存限额、整会话克隆、助手消息 fork 入口、非审批类 UI 请求交互（见 proposal Non-goals）。
- 池数值的性能调优：默认 16 是保守起点，VPS 实测值写入 Open Questions 关闭项，不改架构。
- 审批条以外的"权限"呈现（composer footer 权限段归 S3b）。

## Decisions

### D1 池治理落在 supervisor 准入点，不下沉到 runtime
- **决定**：`SessionSupervisor` 维护 `#liveProcesses`（sessionId → 最近活动时刻 + 是否在回合中 + 是否持有控制占用，见 D3）；`#dispatchNew` 与临时进程准入统一经 `#admitProcess()`：`live < cap` 直接放行；`live === cap` 时选择"非回合中、不持有控制占用且最近活动时刻最早"的进程执行 `#retireSlot`（等待其 shutdown 完成）后放行；无可驱逐者抛 `HttpError("agent_capacity")`。"回合中"的定义扩为"回合中或持有控制占用"（不可驱逐）。准入后 spawn/握手失败且无 pid（不会有 `onExit`）时，由准入方同步释放名额。runtime 增 `onExit` 接线：任何原因的进程退出（空闲、崩溃、驱逐、关停）都回调 supervisor 删除该 slot——这同时修复 slot 泄漏。
- **为什么**：上限是跨会话的全局不变量，只有 supervisor 看得见全部进程；runtime 只知道自己。把驱逐做成"正常 retire"复用既有关停序列（stdin→TERM→KILL）与 token 撤销，不引入第二条生命周期。
- **备选**：(a) 在 runtime 层加全局计数器——违反 runtime 单会话职责且计数器需跨实例共享；(b) 触顶直接 503 不驱逐——空闲进程占名额直到 600s 超时，体验差（grill Q8 否决）。
- **配置**：`OMP_MAX_PROCESSES` 走 `agent-config.ts` 同 `OMP_IDLE_MS` 的解析纪律（canonical 正整数 1..2147483647，超限启动失败，默认 16；上界镜像 `OMP_IDLE_MS`，无更紧上界的依据）。

### D2 停止 = `abort` 帧 + 独立 `stopped` 终态 + 有界退回
- **决定**：`POST /api/sessions/:id/stop`（content-parser 归属：任何 body → 400 `bad_request`）：会话 running → stop 在其调用期间持有控制占用，supervisor 先对该会话登记**停止意图**，返回 202 body `{}`；非 running → 204 无 body（幂等，不报错）。停止意图的两种落点：
  - prompt **尚未派发**（runtime 仍在获取/握手，`abort()` 返回 `false`，即「尚无已派发的回合」）：supervisor 只记下停止意图，stop 调用随即返回 202；待该回合 `prompt` 的派发回执（supervisor 本就在等的那个回执，见 chat-sessions「Supervisor ordered persistence」）兑现后，supervisor 立即对同一 generation 再次调用 `abort()`——此时 abort 写在 stop 调用返回之后，从这里起与「已派发」分支完全同一路径（进入 stop 时读取的 pending 快照必为空，故直接 `abort` → `message_end{stopReason:"aborted"}` → `agent_end` → 归约器发 `turn.end stopped`；`OMP_ABORT_GRACE_MS` 内未收尾则有界退回）。该回合唯一的 `turn.end` 由归约器这一条路径发出，停止意图分支自身不合成终态事件、不直接结算消息与会话。`prompt` 帧照常写出，用户消息进入 omp 历史，其后的 regenerate/fork 对齐不受影响；等待中的 prompt/regenerate 请求照常返回其 202 受理 body；停止后助手 `content` 为中断前已到达的 delta（可能为空，不作断言）。获取或派发失败时走该请求在无停止意图时完全相同的失败路径（prompt：既有 `rollbackPrompt` 补偿受理对 + 既有错误响应；regenerate：其自身规则），停止意图随之丢弃；若该回合已先被其它路径终态结算（如崩溃 `failed`），停止意图不改写其终态。该 ring 上可能没有 `turn.start`（真实 omp 的 abort 可能早于 `agent_start` 到达）：chat-web 归约器与 chat-stream 已允许「没有先前 turn.start 的终态」，无需新增契约。
  - prompt **已派发**：先以 `deny` 结算该回合**全部** pending 审批（以进入 stop 时读取的快照为准，写 abort 前不重读；发 `Deny`，见 D5），再 `request({type:"abort"})`。重复 stop 只发一帧 `abort`。
- 归约器：`message_end{stopReason:"aborted"}` 记为"已中断"而非失败，终止 `agent_end` 到达时发 `turn.end{status:"stopped"}`（不发 `error`）；仍 running 的步骤结算为 `stopped`。若 `abort` 发出后 `OMP_ABORT_GRACE_MS`（内部常量 8000ms，不做配置）内 `agent_end` 未到，退回既有 retire 路径（FrameStream.return → 进程关停），supervisor 以 `applyStop`（新增纯函数，与 `applyFailure` 对称）合成 `turn.end stopped`——这是"停止后 retire"对既有"retire 发 error"次序的唯一例外。
- **为什么**：`stopped` 与 `failed` 在筛选、审计、侧栏点上语义不同（grill Q5）；`abort` 是 omp 原生且可续用的路径，退回 retire 是既有的最后手段，两者都有界；冷启动窗口内没有可 abort 的回合，停止意图保证该窗口内的停止同样收尾为 `stopped` 而不是被随后的派发吞掉。
- **备选**：复用 `failed` + 文案——零迁移但语义错；只走 retire 不发 abort——每次停止都要重 spawn，慢且丢进程内状态。
- **迁移 034**：SQLite 无法 ALTER CHECK，`034_chat_turn_control.sql` 对三表做重建，把三处 status CHECK 扩为含 `stopped`，同一迁移给 `chat_sessions` 加 `parent_session_id TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL`，新建 `chat_approvals`（D5）。配方写死（`openDb` 先 `PRAGMA foreign_keys = ON`（`server/src/core/db/index.ts:28`），runner 再在事务内执行迁移（`migration-runner.ts:16` `BEGIN`），事务内切 `foreign_keys` 无效，故不依赖放宽约束）：
  1. 建 `chat_sessions_next`/`chat_messages_next`/`chat_steps_next`，三张 `_next` 表的 FK 指向对应 `_next` 父表（含自引用 `parent_session_id → chat_sessions_next`，`owner_id` 仍指向 `accounts(id)`）；显式列出全部列/默认值/NOT NULL/主键/AUTOINCREMENT/UNIQUE/FK/级联，**此时不建索引**。
  2. 按父表优先 `INSERT … SELECT` 复制全部行（逐列命名，不用 `SELECT *`）；并在任何 `DROP` 之前读出并保留 `chat_messages`/`chat_steps` 各自的 `max(旧 seq, max(id))`——`DROP TABLE` 会一并删除该表的 `sqlite_sequence` 行，步骤 (5) 时旧高水位已不可读。
  3. 全部复制完后按子表优先 `DROP` 旧表：steps → messages → sessions（子表先删，`ON DELETE CASCADE` 无行可级联）。
  4. 按父表优先 `ALTER TABLE … RENAME`：sessions → messages → steps（`legacy_alter_table=OFF` 下 RENAME 改写子表 FK 目标为新父表名）。
  5. 显式写 `sqlite_sequence` 中两张 AUTOINCREMENT 表 `chat_messages`、`chat_steps` 的高水位，取值为步骤 (2) 保留的值，保住 032「删除后 ID 不复用」；`chat_sessions` 为 TEXT 主键，无 sequence 行。
  6. RENAME 之后再建 `chat_approvals`（其 FK 直接指向最终表名，另建 `message_id` 索引），并重建三张被重建表的索引。

  迁移全程不写任何 `PRAGMA foreign_keys`（事务内无效）；正确性只依赖上述 DROP/RENAME 次序。
  回执追加为第八条，不改旧回执。**重建是本仓首次**：单测须覆盖"带数据的旧库升级后行数/内容/索引名以外的约束完全等价"、`PRAGMA foreign_key_check` 为空、高水位用例（旧库 `max(id)` 低于 seq 时升级后新插入 id 大于旧高水位）、在 node:sqlite 内置版本上确认 RENAME 改写 FK，以及"重建中途失败不留半表"。

### D3 重新生成 = 末条助手消息、非 running、branch 后重发
- **决定**：`POST /api/sessions/:id/regenerate`（content-parser 归属：任何 body → 400 `bad_request`）：前置校验会话 owner、status ∈ {done, failed, stopped}、末条消息为 assistant 且其前一条为 user；否则 409 `session_busy`（running 或控制占用中）或 400 `bad_request`（形态不满足）。预检通过即登记**控制占用**（control claim，按 sessionId），持有到派发完成/响应返回；期间同会话的 prompt/regenerate/fork 一律 409 `session_busy`（stop 例外：regenerate 派发后可正常 stop）。执行：经与 prompt 相同的懒获取路径取得**正常 generation**（进程已回收时 `--resume` 现文件起进程、epoch+1、建 ring，计入池）→ `request(get_branch_messages)` → 选 `entryId` 为最后一条且 `text` 与 SQLite 末条用户消息 content 相等（不等 → 502 `agent_unavailable`，不猜）→ `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务先做 CAS 复核（`status` 非 running 且末条 assistant id 等于预检读到的 id，否则 409 `session_busy` 并 retire 该进程），再删旧助手行（步骤级联）、插入新 running 助手行、`omp_session_file` = 新文件、status=running → 以 branch 返回的 `text` 走既有 prompt 派发。响应 202 `{assistantMessageId}`。
- regenerate 与 fork 是 supervisor 自有的受理/补偿路径（不经 `prompt` 路由的受理事务）；fork 的临时 runtime 不是 generation、不 bump epoch、不建 ring。
- **为什么**：branch 让模型上下文不含旧回答，是"重新生成"的真实语义（grill Q6）；限定末条避免中段重写历史的 UI/一致性复杂度；控制占用 + CAS 关闭"预检与提交之间被并发 prompt/regenerate 插入"的窗口。
- **备选**：同文再发一次——模型看到旧回答；`/retry`——只对 error/aborted 有效。
- **接缝**：runtime 增 `command(frame)` 暴露 `OmpProcess.request`（不在回合中才允许；回合中 → `SessionBusyError`；无存活子进程时经与 prompt 同一惰性获取路径起进程，fork 的临时进程依赖这一点）。
- **branch 之后、提交之前失败**：retire 该进程、返回 502，SQLite 不变（旧助手行仍在；omp 新文件未被引用）；**提交之后派发失败**：新助手行与会话结算为 `failed`、返回 502；不复活已删的旧助手行（历史已被 omp 新文件改写，复活会撒谎）。

### D4 fork = 用户消息处分叉，临时进程执行 branch，源会话文件不动、存活进程先 retire
- **决定**：`POST /api/sessions/:id/fork {messageId}`：`messageId` 必须是该会话的 user 消息，否则 400。若原会话 running 或控制占用中 → 409 `session_busy`。预检通过即对源会话登记控制占用（同 D3），并对源会话的存活 idle 进程执行既有 retire（数据在文件里，无损）。执行：SQLite 先创建新会话行（owner 同、title 复制、`parent_session_id`=原 id、`omp_session_file` NULL）；经 `#admitProcess` 起**临时** `SessionRuntime`（`--resume` 原 `omp_session_file`，不绑定任何 slot、不发 token 外泄——仍走同一 spawn 契约）→ `get_branch_messages` → 选 `entryId` 使其 `text` 等于该用户消息 content 且顺位一致（按 SQLite 中该会话用户消息序号对齐 branch 列表序号；不一致 → 502）→ `branch` → `get_state` 取新文件 → 关停临时进程 → SQLite 事务：新会话 `omp_session_file` = 新文件，拷贝分叉点之前的 `chat_messages`/`chat_steps` 行与其 `chat_approvals` 行（新 id、保持顺序、内容与 decision）到新会话；新会话 `status` = 拷贝历史中末条 assistant 消息的状态（done/failed/stopped），无历史时 `idle`。响应 201 `{session, draft: <branch 返回 text>}`。web 跳转 `?session=<new>` 并把 `draft` 填入 composer（不发送）。
- **为什么**：omp `branch` 会把当前进程切到新文件，不能在原会话的活进程上做（否则原会话下次 prompt 写进新文件）；临时进程隔离这一点（grill Q11）。分叉点取用户消息是 omp 唯一支持的粒度。拷贝 approvals 让分叉会话的历史审批条保真。
- **备选**：整会话 `--fork` 克隆——语义是复制不是分叉；在活进程上 branch 后再 `switch_session` 切回——两次切换且竞态面大。
- **对齐与边界**：`omp_session_file` 为 NULL 的会话（从未 prompt）无用户消息，先命中 400；驱逐打平（最近活动时刻相等）按准入先后取更早者。
- **同一文件不并存两个进程**：原会话回合结束后其进程要到 `OMP_IDLE_MS` 才回收，并非立即退出；故 fork 在临时进程启动**前**先 retire 源会话的存活 idle 进程，源会话 running 时本 API 已 409，控制占用又挡住 fork 期间源会话的新 prompt——三者合起来保证不会出现两个进程同时打开同一 `.jsonl`。源会话进程只是"不被发帧、在临时进程启动前 retire"，下次 prompt 以 `--resume` 重起。

### D5 审批：识别、持久化、超时、与停止的次序
- **决定**：
  - spawn argv `--approval-mode write`。
  - `OmpProcess` 把 `extension_ui_request` 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]` 且 `title` 以 `Allow tool: ` 开头 → 视为审批请求，向上抛出（不自动应答，transport 不自行作答、不设兜底 Deny）；其它 UI 请求维持即时 `cancelled`。工具名从 title 首行 `Allow tool: <name>` 解析，解析失败以 `unknown` 记录但仍走审批流。
  - 新表 `chat_approvals(id INTEGER PK, message_id FK CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK IN (allow,deny,timeout), decided_at INTEGER NULL, UNIQUE(message_id, request_id))`。
  - **多条审批模型**：同一回合可并行挂起多条审批（omp 可对同回合的多个 bash 同时发 select）；每条独立落库，`approval.request` 不覆盖旧记录；supervisor 计时器按 `approvalId` 各自独立。不存在"一个回合至多一条 pending"的假设。
  - supervisor 收到审批请求：落库（pending）→ 发布 `approval.request{messageId, approvalId, tool, title, expiresAt}` 到 ring → 为该 `approvalId` 启动 60s 计时器（时钟可注入）。作答 `POST /api/sessions/:id/approvals/:approvalId {decision}`：属该 owner → 以 `decision IS NULL` 做 CAS 结算 → 200；CAS 失败（已作答/已超时/已被非作答路径结算，含所属进程已退出）→ 409 `approval_settled`(`该审批已处理`)；作答与结算共用同一 CAS，后到者 409。超时：decision=timeout，发 `Approve`。停止（D2）：对该回合**全部** pending 以 `deny` 结算并发 `Deny`，再 `abort`。
  - **结算路径枚举**（一条审批的 `decision` 只可能经以下路径写入）：作答（allow/deny，发对应帧）、超时（timeout，发 `Approve`）、停止（deny，发 `Deny`）、崩溃、有界退回、优雅关停（`close()`）、启动对账（`reconcileOnStartup`）——后四条一律 `deny`、不向 omp 发帧。保证终态消息不存在 `decision NULL` 的审批。
  - **归属层与次序**：`store-approvals.ts` 持有 `settlePendingForMessage(messageId, decision)`，与 running→failed **或 running→stopped** 翻转在同一事务；审计由 store 经注入的 `audit.emit` 在同一事务内写入（与 `server/src/workspaces/store.ts:109` `workspace.create` 先例一致）。每条结算的次序固定为「落库 + 审计（同一事务）→ 向 omp 发帧（仅作答/超时/停止）→ 有 ring 时发布 `approval.resolved{messageId, approvalId, decision}`」：有 ring 时发布（含优雅关停）；无 ring（启动对账）只落库 + 审计。持久化失败不发布。
  - 审批挂起期间 runtime 空闲计时器暂停（`markPending(approvalId)/clearPending(approvalId)`，按 id 的集合，重复调用 no-op），最后一条结算后恢复。
  - 发帧规则：作答、超时、停止三条向 omp 发 `Approve|Deny`；崩溃/有界退回、优雅关停、启动对账三条不发帧。
  - 快照：`GET /api/sessions/:id/messages` 的每条消息带 `approvals: Approval[]`（`Approval = {id, tool, title, requestedAt, expiresAt, decision}`，按 id 升序；用户消息与无记录的助手消息为 `[]`）。作答 REST 200 body 为快照同形的单条 `Approval`；stop 202 body 为 `{}`。
  - 审计：每次结算 `emit({kind:"session.approval", actorId: <owner_id>, title:"工具执行审批", detail:{sessionId, messageId, tool, decision}})`，所有结算路径都审计；pending 不审计。
  - 事件次序：omp 在审批 select 之前已发 `tool_execution_start`，故单条序列为 `step.start → approval.request → approval.resolved → step.end`；并行审批时各条序列交错。Deny 时该步骤以 `isError` 结束为 `failed`。
  - web 审批条（已定）：一条助手消息按 `approvals` id 顺序纵向渲染多个审批条；pending 头部 `需要你的确认` + 工具名徽章（title 首行 `Allow tool: <name>` 解析）+ 正文为 title **全文**（`white-space: pre-wrap`，不截断）+ 单句动态倒计时 `（<n>s 内未操作将自动允许）`（由 `expiresAt` 实时计算，初值 60）+ `允许`/`拒绝`；已结算为 `已允许执行`（allow/timeout）/`已拒绝执行`（deny）。
- **为什么**：超时方向是用户拍板（grill Q7）；持久化让刷新后仍可作答且历史可见 `已允许执行/已拒绝执行`；停止先 Deny 是因为 omp 的 `abort` 会等 select（agent loop 无竞速），并行审批时漏掉任何一条都会让 abort 挂住；审计与落库同事务使"有决定必有审计"成为存储不变量而不是调用方纪律。识别规则贴 omp 源码事实（`wrapper.ts` 用 `select(formatApprovalPrompt(), ["Approve","Deny"])`），无专用帧可用。
- **备选**：不持久化（内存）——刷新丢失、历史不可见；`always-ask`——每回合多次审批（grill 否决）；超时拒绝——用户明确选自动允许；单条 `approval | null` 快照——并行审批时后到的请求遮蔽先到的，先到那条无法作答。
- **风险**：识别规则依赖 omp 内部 UI 文案；omp 冻结 v18.0.10，升版本前不会变；fake-omp 与真实二进制 smoke 都断言同一形状。

### D6 事件与快照契约同刀
- `turn.end.status` 联合 `done|failed|stopped`；新增事件 `approval.request`、`approval.resolved`（payload 为单条审批，按 `approvalId` 寻址）；会话/消息/步骤 status 联合加 `stopped`；消息快照加 `approvals: Approval[]`。content-parser 归属集六 → 十（加 stop、regenerate、fork、approvals 四条路由）。无兼容期（同仓同部署，无第三方消费者）。
- 归约器（web）：`approval.request` 以 `approvalId` 为键增入对应消息的 `approvals`（不覆盖旧条）；`approval.resolved` 以 `approvalId` 更新 decision（未知 id 忽略）；`turn.end stopped` 结算消息与会话为 stopped。
- **跨端落刀次序**（web `hasExactlyKeys` 严格解析，任一侧先行都会让会话页整体失效）：
  - `stopped` 枚举：server 侧 `store.ts` `FinishStatus` 放宽为 `done|failed|stopped` 与 stopped 步骤结算随归约器（tasks 3.1）同刀，`supervisor.ts:689` 的 `turn.end` 穷举随之通过；web 解析与 `status-label.ts` 的 `stopped: "已停止"`（tasks 7.1）**先于** server 真正发出 `turn.end stopped`（tasks 4.2a/4.2b、5.1a）合入——即 web-parse-before-server-emit。
  - `approvals` 快照键：server 投影与 web `session-contract.ts` 键集 + 新建 `features/chat/stream-approvals.ts` 归约（`stream.ts` 只增接线调用）是同一个跨端 task（tasks 5.3），同 PR 合入。

### D7 fake-omp 是全部服务端测试的真实边界
- fake-omp 新 scenario：`abort-ok`（收到 abort → 当前回合 `message_end aborted` + `agent_end` + response；早于 `agent_start` 与两段 delta 之前读到的 abort 在它们发出后立即兑现，帧序固定）、`abort-ignored`（收到 abort 不回，用于验证有界退回）、`branch`（响应 `get_branch_messages` 固定用户消息列表、`branch` 返回 text 并让后续 `get_state.sessionFile` 变为新路径、真的在 session-dir 下创建新文件）、`approval`（argv 含 `--approval-mode write` 时在 bash 步骤前发审批 select，未应答不发后续帧，收到 `Approve` 继续、`Deny` 发 `tool_execution_end{isError}` 再完成）、`approval-parallel`（同一回合两个 bash 同时发两个 select，分别应答各发自己的 `tool_execution_end`；两条都应答后：至少一条 `Approve` 且未收到 abort → 正常完成；全部为拒绝且未收到 abort → 同 `abort-ok` 挂起等待 abort（模拟模型的后续调用期间宿主 stop 落地）；任一 select 挂起时到达的 abort 在**全部** select 应答前不产生任何帧，全部应答后以 `message_end aborted` + `agent_end` + `response{command:"abort"}` 兑现）、`approval-then-abort`（select 挂起时收到 abort 不响应直到 select 应答并发出其 `tool_execution_end`；应答后未收到 abort 则同 `abort-ok` 挂起等待 abort、不发完成帧——宿主「先 Deny 后 abort」的停止次序因此得到确定的 aborted 收尾）、`approval-chain-abort-ignored`（同 `approval`；首个 select `r1` 被应答（任意值）后发该调用的 `tool_execution_end`，再发第二个 bash `tool_execution_start` 与第二个 select `r2`；任何入站 abort 都不产生帧，进程存活到 stdin 关闭或收到信号——用于构造「有界退回时仍有挂起审批」）、`slow-ready`（`ready` 延迟 `--ready-delay-ms <n>` 毫秒后才发（缺省 500），之后行为与 **`abort-ok`** 完全相同：回合挂起并兑现 abort；若按 `normal` 则 prompt 可能在 abort 之前完成，派发前停止的用例会竞态）。fake-omp 的 S1c scenario 共八个。probe 回报尾部增 `frames=` 记录收到的每个入站帧类型以便断言次序（"先 Deny 后 abort"）。

### D8 harness 在 `write` 模式下的确定性
- **事实**：仓内假上游（`server/test/support/fake-upstream.mjs`）对每个会话的首轮请求必回一个 `bash` tool call；omp 在审批 select 之前先发 `tool_execution_start`（`agent-loop.ts:2461` 早于 `wrapper.ts:332`）。切到 `--approval-mode write` 后，既有真 omp `make smoke`/`make ui-walk` 会停在审批处：chat.hurl 的 done 轮询上限 20s 小于 60s 自动允许，ui-walk 的受控 gate 在 bash 之后。
- **决定**：
  - `make smoke` 与 `make ui-walk` **作答审批**而不是绕开它：chat.hurl 在首轮 prompt 后轮询快照到 `approvals` 中出现 `decision === null` 的条目，`POST …/approvals/:id {decision:"allow"}`，再等 done；ui-walk 对真 omp 断言 `需要你的确认` 出现、点 `允许`、`已允许执行`、回合完成（promoted 第 42 行"不得以 fake-omp 替代"保持成立；fake-omp `approval` scenario 只服务服务端单测）。
  - **测试侧 argv 注入**：生产 argv 切到 `write`（tasks 2.1b）之前，服务端单测经既有 `spawnImpl` 注入点（`server/test/session-supervisor-helpers.ts:98`，已在此追加 `--scenario`）把 argv 中的 `yolo` 替换为 `write`，故审批与停止的服务端用例在生产仍为 `yolo` 时即可证明；argv 切换本身与 smoke/ui-walk 的作答条目同 PR。
  - 停止用例的确定性 running 点：hurl 用**第二个新会话**（首轮必有 bash → 必有 pending 审批）在审批挂起时 `stop`；ui-walk 用同会话第二个受控 prompt（无 tool 轮）以 `held` 为 running 点。
  - `make smoke-live` 与 `make smoke` 共用 `chat.hurl`，真模型不一定调 bash：以 Hurl `[Options] skip: {{skip_turn_control}}` 模板化回合控制条目，`make smoke` 传 `--variable "skip_turn_control=false"`，`smoke-live` 传 `true`——与既有 `min_bash_steps=1|0` 同一形态，Makefile 两条配方各加一个 `--variable`，`scripts/test-ci-harness.sh` oracle 同 PR 跟随。done 轮询上限放宽到覆盖 60s（真实失败的 `make smoke` 会因此变慢，接受）。
  - CI harness 不传 `OMP_MAX_PROCESSES`（默认 16 足够）。
- **备选**：新增 `OMP_APPROVAL_MODE` 让 harness 回 yolo——让真 omp 验证面绕过本 change 最关键的路径，否决；拆独立 hurl 文件只给 `make smoke` 跑——同样改配方且多一个文件，收益不大。

### 模块拆分（size-guard）
- **事实**：`scripts/size-guard.sh` 硬限单文件 ≤800 行（阈值不调）。现状 `server/src/sessions/omp/runtime.ts` 797、`server/src/sessions/store.ts` 798、`server/src/sessions/supervisor.ts` 770、`server/src/sessions/omp/process.ts` 732、`web/src/lib/api.ts` 749、`web/src/features/chat/page.tsx` 734、`web/src/features/chat/stream.ts` 717 行，本 change 的新增代码放不进去。
- **决定**：各组首刀做**纯搬迁、行为不变**的拆分，新代码落到新模块：
  - `server/src/sessions/omp/runtime.ts` → 拆出 `omp/commands.ts`（command/abort/pending 计时面）；`omp/process.ts` 若超限 → 拆出 `omp/ui-requests.ts`（UI 请求分流）。
  - `server/src/sessions/supervisor.ts` → 拆出 `sessions/pool.ts`（准入/驱逐/名额）、`sessions/turn-control.ts`（stop/regenerate/fork 编排）、`sessions/approvals.ts`（审批登记/计时/结算）。
  - `server/src/sessions/store.ts` → 拆出 `sessions/store-approvals.ts`（含 `settlePendingForMessage`）与 `sessions/store-branch.ts`（regenerate/fork 事务与行拷贝）。
  - `web/src/features/chat/page.tsx` → 拆出 `features/chat/turn-actions.ts`（stop/regenerate/fork/approval 的 handler 与 fence）；`web/src/lib/api.ts` → 拆出 `lib/api-sessions.ts`（会话族方法）；`features/chat/stream-approvals.ts` 是 tasks 5.3 **新建**的文件（审批事件归约落在其中），不拆分 `stream.ts`。
  - 新测试一律写进新建测试文件，既有测试文件不增长。
- **验证**：每个拆分刀 `bash scripts/size-guard.sh` 退出 0、被搬迁文件的既有测试不改动全绿、knip 零新增。

## Sketch seams under test

- **`SessionSupervisor` + 真实 fake-omp 子进程（最高 seam，覆盖 D1/D2/D3/D4/D5 的服务端语义）**：以 `OMP_MAX_PROCESSES=1|2` 起 supervisor，用 fake-omp 演出上限/驱逐/503、abort 收尾、abort 有界退回、冷启动窗口内停止、branch 重生成、控制占用下的并发 409、fork 临时进程与行拷贝、审批 pending→allow/deny/timeout、并行审批、停止先 Deny 全部 pending 后 abort、四条非作答路径结算。理由：这是 Critical Path 白盒面，mock 无法证明进程数与帧次序。
- **Fastify `app.inject()` + 真实 SQLite（REST 形状与状态码）**：四条新路由的 401/404/400/409/503/202/201 与 body 形状、content-parser 归属（malformed JSON → 400）、迁移 034 的旧库升级等价。理由：既有 seam，HTTP 契约唯一证明点。
- **纯函数 `applyFrame`/`applyStop`（归约）**：aborted → stopped、审批帧不进归约（由 supervisor 直处理）。理由：既有纯 seam，成本最低。
- **web jsdom：`applyChatEvent` 归约 + 页面级 fixture（composer 停止按钮、审批条、重新生成/分叉操作、503 文案）**：既有 `chat-page*.test.tsx` fixture 路径。
- **`make smoke`（chat.hurl 审批作答/停止/重新生成/分叉用例）与 `make ui-walk`（审批、停止、重新生成与分叉步骤）**：真实 HTTP/浏览器证据，CI 已有 job。

## Risks / Trade-offs

- [重建表迁移首次引入] → 单测覆盖带数据升级与中途失败原子性；迁移 SQL 显式列出全部列与索引，不用 `SELECT *`；配方 D2 (1)–(6) 写死 DROP/RENAME 次序与高水位；归档时 chat-sessions spec 的 schema Requirement 整段重述。
- [审批识别依赖 omp UI 文案] → omp 冻结；fake-omp 与 `make smoke-live` 真二进制同形断言；识别失败退化为"仍视为审批但 tool=unknown"，不会静默放行也不会挂死（60s 后自动允许）。
- [60s 自动允许 = 无人值守时 exec 工具执行] → 用户拍板；审计 `session.approval decision=timeout` 留痕；S3b 权限面可复议。
- [abort 卡在未应答 select 之后（源码推断）] → D2 强制先 Deny 全部 pending 后 abort；`OMP_ABORT_GRACE_MS` 有界退回兜底；Open Question 用真二进制验证。
- [驱逐正在被另一请求准入的空闲进程] → `#admitProcess` 串行化（Promise 链），驱逐与 spawn 在同一临界区内完成；被驱逐会话下次 prompt 走 `--resume`，SSE 订阅者收到 `replay.gap` 后重载（既有语义）。
- [regenerate/fork 与并发 prompt 竞争] → 控制占用挡住同会话新请求，提交事务内 CAS 复核兜底；持有控制占用的进程不可驱逐。
- [fork 行拷贝与 omp 新文件内容不一致] → 分叉点对齐同时校验序号与文本；不一致即 502 且删除已建的新会话行（事务回滚）。
- [web 严格解析导致旧页面遇新字段判非法] → 按 D6 跨端次序分两类：`approvals` 快照键与 `approval.*` 事件 server+web 同 PR（tasks 5.3）；`stopped` 枚举由 web 解析与 `status-label.ts` 先接受、再由 server 发出（web-parse-before-server-emit：tasks 7.1 先于 4.2/5.1a）。部署为同一产物，无滚动窗口。
- [`stopped` 步骤无 output] → 与 `finishOwnedTurn` 现行为一致（settled 步骤 output 为 NULL），读回 `""`。

## Migration Plan

- 新增 `034_chat_turn_control.sql`，由 `openDb` 顺序执行；回执追加为第八条。升级前建议备份 DB 文件；回滚 = 恢复备份 + 回退代码（迁移不可逆，与 032 同纪律）。
- 部署配置：新增可选 `OMP_MAX_PROCESSES`（缺省 16）；sudo 模式 sudoers 行不变（argv 尾参 `*` 覆盖 `--approval-mode write`）。
- 无数据回填：旧会话无审批记录、无 `parent_session_id`。

## Not yet specified

- 「继续」控件：demo 无对应按钮；停止后用户发新 prompt 即继续。若未来需要"从中断处续写而非新回合"，其与 omp `/retry`/steer 的关系尚说不清问题边界。
- 驱逐策略对多 tab 同会话订阅者的呈现：被驱逐会话的 SSE 客户端收到 `replay.gap` 后重载，页面是否要提示"进程已回收"尚未定义问题。

## Open Questions

- `OMP_MAX_PROCESSES` 的生产建议值：在测试 VPS 上以真实 omp 起 8/16 个空闲与回合中进程测 RSS，写入本节关闭项；不改架构。
- 真二进制行为验证（abort 阻塞 + branch 文本对齐）：以 `make smoke-live` 前置的真二进制手工验证一次——(a) abort 是否确实被未应答 select 阻塞，结论只影响 D2 的注释与 fake-omp `approval-then-abort` 是否保留；(b) `get_branch_messages` 返回的 `text` 是否与 SQLite 中用户消息 content 逐字相等（regenerate/fork 的对齐判据），并由 tasks 8.1c/8.1d 的 regenerate/fork hurl 条目在 `make smoke` 中持续证明；(c) 真实 omp 在 `prompt` 帧后紧接 `abort`（可能早于 `agent_start`）时，用户消息条目是否仍写入 `.jsonl` 历史（否则派发前停止后的 regenerate/fork 对齐失败）——同一次真二进制手工验证覆盖该窗口；tasks 8.1b 的停止条目（`make smoke`，真 omp）另对停止后的助手 regenerate 断言 202 且完成，是 CI 内对「停止后历史仍可对齐」的唯一真 omp 探针（其停止点在审批挂起时，已过 `agent_start`，故不替代手工验证）。
- ~~034 重建迁移在 `PRAGMA foreign_keys=ON` 下 `DROP TABLE` 子表顺序~~ **已关闭**：以 chat-sessions delta 中 MODIFIED 整段重述 032 schema Requirement（034 取代 032 列集与 CHECK）与 D2 迁移配方 (1)–(6) 回答——事务内 `PRAGMA foreign_keys` 无效故不使用；`_next` 表 FK 指向 `_next` 父表、子表优先 DROP、父表优先 RENAME，旧表 DROP 时无可级联行，runner 无需改动。
