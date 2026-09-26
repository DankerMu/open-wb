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

**Oracle 差异（显式记录）**：`docs/architecture/system.md:36` `sessions` 行写"omp-supervisor（每活跃会话 spawn、空闲回收、数量上限）"，数量上限至今未实现；本 change 实现后该行不需改字。`IMPLEMENTATION_PLAN.md:190` S1c Outcome 把审批条写为"允许/拒绝/超时自动通过"，与 grill 结论一致（超时自动允许）。

## Goals / Non-Goals

**Goals:**
- 活 omp 进程数受 `OMP_MAX_PROCESSES` 硬约束；触顶时可预测地驱逐最久空闲进程；不可驱逐时以 503 拒绝而非无界 spawn。
- 用户能在回合中停止，停止后会话进入独立 `stopped` 终态且可继续对话；停止在有界时间内一定收尾。
- 末条助手回答可重新生成，历史中不残留旧回答；任意用户消息处可分叉出新会话且原会话不受影响。
- exec 档工具调用经用户审批；审批状态可持久、可回放、刷新后可继续作答；超时与停止的方向明确且可审计。
- 所有新契约 server/web 同刀落地，`make check`/`make smoke`/`make ui-walk` 全绿。

**Non-Goals:**
- change B 范围（空间绑定、场景、分区侧栏、重命名/删除/置顶、对话内搜索、思考折叠、文件变更卡/产物卡）。
- 每会话审批模式切换、每账号上限、内存限额、整会话克隆、助手消息 fork 入口、非审批类 UI 请求交互（见 proposal Non-goals）。
- 池数值的性能调优：默认 16 是保守起点，VPS 实测值写入 Open Questions 关闭项，不改架构。
- 审批条以外的"权限"呈现（composer footer 权限段归 S3b）。

## Decisions

### D1 池治理落在 supervisor 准入点，不下沉到 runtime
- **决定**：`SessionSupervisor` 维护 `#liveProcesses`（sessionId → 最近活动时刻 + 是否在回合中）；`#dispatchNew` 与临时进程准入统一经 `#admitProcess()`：`live < cap` 直接放行；`live === cap` 时选择"非回合中且最近活动时刻最早"的进程执行 `#retireSlot`（等待其 shutdown 完成）后放行；无可驱逐者抛 `HttpError("agent_capacity")`。runtime 增 `onExit` 接线：任何原因的进程退出（空闲、崩溃、驱逐、关停）都回调 supervisor 删除该 slot——这同时修复 slot 泄漏。
- **为什么**：上限是跨会话的全局不变量，只有 supervisor 看得见全部进程；runtime 只知道自己。把驱逐做成"正常 retire"复用既有关停序列（stdin→TERM→KILL）与 token 撤销，不引入第二条生命周期。
- **备选**：(a) 在 runtime 层加全局计数器——违反 runtime 单会话职责且计数器需跨实例共享；(b) 触顶直接 503 不驱逐——空闲进程占名额直到 600s 超时，体验差（grill Q8 否决）。
- **配置**：`OMP_MAX_PROCESSES` 走 `agent-config.ts` 同 `OMP_IDLE_MS` 的解析纪律（canonical 正整数 1..2147483647，超限启动失败，默认 16；上界镜像 `OMP_IDLE_MS`，无更紧上界的依据）。

### D2 停止 = `abort` 帧 + 独立 `stopped` 终态 + 有界退回
- **决定**：`POST /api/sessions/:id/stop`：会话 running → supervisor 对该 slot 先结算挂起审批（以 Deny 应答，见 D5），再 `request({type:"abort"})`，返回 202；非 running → 204（幂等，不报错）。归约器：`message_end{stopReason:"aborted"}` 记为"已中断"而非失败，终止 `agent_end` 到达时发 `turn.end{status:"stopped"}`（不发 `error`）；仍 running 的步骤结算为 `stopped`。若 `abort` 发出后 `OMP_ABORT_GRACE_MS`（内部常量 8000ms，不做配置）内 `agent_end` 未到，退回既有 retire 路径（FrameStream.return → 进程关停），supervisor 以 `applyStop`（新增纯函数，与 `applyFailure` 对称）合成 `turn.end stopped`。
- **为什么**：`stopped` 与 `failed` 在筛选、审计、侧栏点上语义不同（grill Q5）；`abort` 是 omp 原生且可续用的路径，退回 retire 是既有的最后手段，两者都有界。
- **备选**：复用 `failed` + 文案——零迁移但语义错；只走 retire 不发 abort——每次停止都要重 spawn，慢且丢进程内状态。
- **迁移 034**：重建须带过 `sqlite_sequence` 高水位（否则 032「删除后 ID 不复用」被打破）。SQLite 无法 ALTER CHECK，`034_chat_turn_control.sql` 对三表做重建（`CREATE TABLE …_next` → `INSERT … SELECT` → `DROP` → `ALTER TABLE RENAME`），保留全部列/索引/FK/级联并把三处 status CHECK 扩为含 `stopped`；同一迁移给 `chat_sessions` 加 `parent_session_id TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL`，新建 `chat_approvals`（D5）。迁移在 runner 事务内、`PRAGMA foreign_keys` 语义按仓内 runner 既有处理；回执追加为第八条，不改旧回执。**重建是本仓首次**：单测须覆盖"带数据的旧库升级后行数/内容/索引名以外的约束完全等价"与"重建中途失败不留半表"。

### D3 重新生成 = 末条助手消息、非 running、branch 后重发
- **决定**：`POST /api/sessions/:id/regenerate`：前置校验会话 owner、status ∈ {done, failed, stopped}、末条消息为 assistant 且其前一条为 user；否则 409 `session_busy`（running）或 400 `bad_request`（形态不满足）。执行：取得或起该会话的 slot（`--resume` 现文件，计入池）→ `request(get_branch_messages)` → 选 `entryId` 为最后一条且 `text` 与 SQLite 末条用户消息 content 相等（不等 → 502 `agent_unavailable`，不猜）→ `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务：删旧助手行（步骤级联）、插入新 running 助手行、`omp_session_file` = 新文件、status=running → 以 branch 返回的 `text` 走既有 prompt 派发。响应 202 `{assistantMessageId}`。
- **为什么**：branch 让模型上下文不含旧回答，是"重新生成"的真实语义（grill Q6）；限定末条避免中段重写历史的 UI/一致性复杂度。
- **备选**：同文再发一次——模型看到旧回答；`/retry`——只对 error/aborted 有效。
- **接缝**：runtime 增 `command(frame)` 暴露 `OmpProcess.request`（不在回合中才允许；回合中 → `SessionBusyError`；无存活子进程时经与 prompt 同一惰性获取路径起进程，fork 的临时进程依赖这一点）。
- **branch 之后派发失败**：新助手行与会话结算为 `failed`、返回 502；不复活已删的旧助手行（历史已被 omp 新文件改写，复活会撒谎）。

### D4 fork = 用户消息处分叉，临时进程执行 branch，原会话不动
- **决定**：`POST /api/sessions/:id/fork {messageId}`：`messageId` 必须是该会话的 user 消息，否则 400。若原会话 running → 409。执行：SQLite 先创建新会话行（owner 同、title 复制、`parent_session_id`=原 id、status idle、`omp_session_file` NULL）；经 `#admitProcess` 起**临时** `SessionRuntime`（`--resume` 原 `omp_session_file`，不绑定任何 slot、不发 token 外泄——仍走同一 spawn 契约）→ `get_branch_messages` → 选 `entryId` 使其 `text` 等于该用户消息 content 且顺位一致（按 SQLite 中该会话用户消息序号对齐 branch 列表序号；不一致 → 502）→ `branch` → `get_state` 取新文件 → 关停临时进程 → SQLite 事务：新会话 `omp_session_file` = 新文件，拷贝分叉点之前的 `chat_messages`/`chat_steps` 行到新会话（新 id、保持顺序与内容）。响应 201 `{session, draft: <branch 返回 text>}`。web 跳转 `?session=<new>` 并把 `draft` 填入 composer（不发送）。
- **为什么**：omp `branch` 会把当前进程切到新文件，不能在原会话的活进程上做（否则原会话下次 prompt 写进新文件）；临时进程隔离这一点（grill Q11）。分叉点取用户消息是 omp 唯一支持的粒度。
- **备选**：整会话 `--fork` 克隆——语义是复制不是分叉；在活进程上 branch 后再 `switch_session` 切回——两次切换且竞态面大。
- **对齐与边界**：`omp_session_file` 为 NULL 的会话（从未 prompt）无用户消息，先命中 400；驱逐打平（最近活动时刻相等）按准入先后取更早者。
- **原会话 `.jsonl` 只读打开**：`--resume` 同一文件的临时进程与原会话可能并存（原会话 idle 时进程已回收；原会话 running 时本 API 已 409），故不会出现两个进程同时写同一文件。

### D5 审批：识别、持久化、超时、与停止的次序
- **决定**：
  - spawn argv `--approval-mode write`。
  - `OmpProcess` 把 `extension_ui_request` 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]` 且 `title` 以 `Allow tool: ` 开头 → 视为审批请求，向上抛出（不自动应答）；其它 UI 请求维持即时 `cancelled`。工具名从 title 首行 `Allow tool: <name>` 解析，解析失败以 `unknown` 记录但仍走审批流。
  - 新表 `chat_approvals(id INTEGER PK, message_id FK CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK IN (allow,deny,timeout), decided_at INTEGER NULL, UNIQUE(message_id, request_id))`。
  - supervisor 收到审批请求：落库（pending）→ 发布 `approval.request{messageId, approvalId, tool, title, expiresAt}` 到 ring → 启动 60s 计时器（时钟可注入）。作答 `POST /api/sessions/:id/approvals/:approvalId {decision}`：pending 且属该 owner → 落库 decision → 向 omp 发 `extension_ui_response{id, value: decision==="allow" ? "Approve" : "Deny"}` → 发布 `approval.resolved{messageId, approvalId, decision}` → 200；非 pending → 409 `conflict`（复用既有码，文案"同名资源已存在"不贴切，故新增 `approval_settled`(409, `该审批已处理`)）。超时：decision=timeout，发 `Approve`，发布 resolved。停止（D2）：先对所有 pending 以 `deny` 结算并发 `Deny`，再 `abort`。
  - 审批挂起期间 runtime 空闲计时器暂停（`markPending()/clearPending()`），结算后重置。
  - 快照：`GET /api/sessions/:id/messages` 的每条 assistant 消息带 `approval: {id, tool, title, requestedAt, expiresAt, decision} | null`（取该消息最新一条审批记录；无则 null）。
  - 审计：每次结算 `emit({kind:"session.approval", actorId: <owner_id>, title:"工具执行审批", detail:{sessionId, messageId, tool, decision}})`；pending 不审计。
  - 事件次序：omp 在审批 select 之前已发 `tool_execution_start`，故序列为 `step.start → approval.request → approval.resolved → step.end`；Deny 时该步骤以 `isError` 结束为 `failed`。
  - 非作答路径的结算：回合因崩溃、有界退回或启动对账进入终态时，仍 pending 的审批一律结算为 `deny`（不向 omp 发帧、照常审计与发布 resolved），保证终态消息不存在 `decision NULL` 的审批。
  - 作答 REST 200 body 为快照同形的 `approval` 对象；stop 202 body 为 `{}`；快照中每条消息都有 `approval` 键（用户消息与无记录的助手消息为 `null`）。
  - web 倒计时显示实时剩余秒数（`（<n>s 内未操作将自动允许）`，初值 60）。
- **为什么**：超时方向是用户拍板（grill Q7）；持久化让刷新后仍可作答且历史可见 `已允许执行/已拒绝执行`；停止先 Deny 是因为 omp 的 `abort` 会等 select（agent loop 无竞速）。识别规则贴 omp 源码事实（`wrapper.ts` 用 `select(formatApprovalPrompt(), ["Approve","Deny"])`），无专用帧可用。
- **备选**：不持久化（内存）——刷新丢失、历史不可见；`always-ask`——每回合多次审批（grill 否决）；超时拒绝——用户明确选自动允许。
- **风险**：识别规则依赖 omp 内部 UI 文案；omp 冻结 v18.0.10，升版本前不会变；fake-omp 与真实二进制 smoke 都断言同一形状。

### D6 事件与快照契约同刀
- `turn.end.status` 联合 `done|failed|stopped`；新增事件 `approval.request`、`approval.resolved`；会话/消息/步骤 status 联合加 `stopped`；消息快照加 `approval`。web `session-contract.ts`/`stream.ts` 解析同 PR 更新；无兼容期（同仓同部署，无第三方消费者）。
- 归约器（web）：`approval.request` 写入对应消息 `approval`（pending）；`approval.resolved` 更新 decision；`turn.end stopped` 结算消息与会话为 stopped。

### D7 fake-omp 是全部服务端测试的真实边界
- fake-omp 新 scenario：`abort-ok`（收到 abort → 当前回合 `message_end aborted` + `agent_end` + response）、`abort-ignored`（收到 abort 不回，用于验证有界退回）、`branch`（响应 `get_branch_messages` 固定用户消息列表、`branch` 返回 text 并让后续 `get_state.sessionFile` 变为新路径、真的在 session-dir 下创建新文件）、`approval`（argv 含 `--approval-mode write` 时在 bash 步骤前发审批 select，未应答不发后续帧，收到 `Approve` 继续、`Deny` 发 `tool_execution_end{isError}` 再完成）、`approval-then-abort`（select 挂起时收到 abort 不响应直到 select 应答）。probe 回报记录收到的每个入站帧类型以便断言次序（"先 Deny 后 abort"）。

### D8 harness 在 `write` 模式下的确定性
- **事实**：仓内假上游（`server/test/support/fake-upstream.mjs`）对每个会话的首轮请求必回一个 `bash` tool call；omp 在审批 select 之前先发 `tool_execution_start`（`agent-loop.ts:2461` 早于 `wrapper.ts:332`）。切到 `--approval-mode write` 后，既有真 omp `make smoke`/`make ui-walk` 会停在审批处：chat.hurl 的 done 轮询上限 20s 小于 60s 自动允许，ui-walk 的受控 gate 在 bash 之后。
- **决定**：
  - `make smoke` 与 `make ui-walk` **作答审批**而不是绕开它：chat.hurl 在首轮 prompt 后轮询快照到 `approval.decision === null`，`POST …/approvals/:id {decision:"allow"}`，再等 done；ui-walk 对真 omp 断言 `需要你的确认` 出现、点 `允许`、`已允许执行`、回合完成（promoted 第 42 行"不得以 fake-omp 替代"保持成立；fake-omp `approval` scenario 只服务服务端单测）。
  - 停止用例的确定性 running 点：hurl 用**第二个新会话**（首轮必有 bash → 必有 pending 审批）在审批挂起时 `stop`；ui-walk 用同会话第二个受控 prompt（无 tool 轮）以 `held` 为 running 点。
  - `make smoke-live` 与 `make smoke` 共用 `chat.hurl`，真模型不一定调 bash：以 Hurl `[Options] skip: {{skip_turn_control}}` 模板化回合控制条目，`make smoke` 传 `--variable "skip_turn_control=false"`，`smoke-live` 传 `true`——与既有 `min_bash_steps=1|0` 同一形态，Makefile 两条配方各加一个 `--variable`，`scripts/test-ci-harness.sh` oracle 同 PR 跟随。done 轮询上限放宽到覆盖 60s（真实失败的 `make smoke` 会因此变慢，接受）。
  - CI harness 不传 `OMP_MAX_PROCESSES`（默认 16 足够）。
- **备选**：新增 `OMP_APPROVAL_MODE` 让 harness 回 yolo——让真 omp 验证面绕过本 change 最关键的路径，否决；拆独立 hurl 文件只给 `make smoke` 跑——同样改配方且多一个文件，收益不大。

## Sketch seams under test

- **`SessionSupervisor` + 真实 fake-omp 子进程（最高 seam，覆盖 D1/D2/D3/D4/D5 的服务端语义）**：以 `OMP_MAX_PROCESSES=1|2` 起 supervisor，用 fake-omp 演出上限/驱逐/503、abort 收尾、abort 有界退回、branch 重生成、fork 临时进程与行拷贝、审批 pending→allow/deny/timeout、停止先 Deny 后 abort。理由：这是 Critical Path 白盒面，mock 无法证明进程数与帧次序。
- **Fastify `app.inject()` + 真实 SQLite（REST 形状与状态码）**：四条新路由的 401/404/400/409/503/202/201 与 body 形状、迁移 034 的旧库升级等价。理由：既有 seam，HTTP 契约唯一证明点。
- **纯函数 `applyFrame`/`applyStop`（归约）**：aborted → stopped、审批帧不进归约（由 supervisor 直处理）。理由：既有纯 seam，成本最低。
- **web jsdom：`applyChatEvent` 归约 + 页面级 fixture（composer 停止按钮、审批条、重新生成/分叉操作、503 文案）**：既有 `chat-page*.test.tsx` fixture 路径。
- **`make smoke`（chat.hurl 停止用例）与 `make ui-walk`（停止 + 审批步骤）**：真实 HTTP/浏览器证据，CI 已有 job。

## Risks / Trade-offs

- [重建表迁移首次引入] → 单测覆盖带数据升级与中途失败原子性；迁移 SQL 显式列出全部列与索引，不用 `SELECT *`；归档时 chat-sessions spec 的 schema Requirement 整段重述。
- [审批识别依赖 omp UI 文案] → omp 冻结；fake-omp 与 `make smoke-live` 真二进制同形断言；识别失败退化为"仍视为审批但 tool=unknown"，不会静默放行也不会挂死（60s 后自动允许）。
- [60s 自动允许 = 无人值守时 exec 工具执行] → 用户拍板；审计 `session.approval decision=timeout` 留痕；S3b 权限面可复议。
- [abort 卡在未应答 select 之后（源码推断）] → D2 强制先 Deny 后 abort；`OMP_ABORT_GRACE_MS` 有界退回兜底；Open Question 用真二进制验证。
- [驱逐正在被另一请求准入的空闲进程] → `#admitProcess` 串行化（Promise 链），驱逐与 spawn 在同一临界区内完成；被驱逐会话下次 prompt 走 `--resume`，SSE 订阅者收到 `replay.gap` 后重载（既有语义）。
- [fork 行拷贝与 omp 新文件内容不一致] → 分叉点对齐同时校验序号与文本；不一致即 502 且删除已建的新会话行（事务回滚）。
- [web 严格解析导致旧页面遇新字段判非法] → server+web 同 PR；部署为同一产物，无滚动窗口。
- [`stopped` 步骤无 output] → 与 `finishOwnedTurn` 现行为一致（settled 步骤 output 为 NULL），读回 `""`。

## Migration Plan

- 新增 `034_chat_turn_control.sql`，由 `openDb` 顺序执行；回执追加为第八条。升级前建议备份 DB 文件；回滚 = 恢复备份 + 回退代码（迁移不可逆，与 032 同纪律）。
- 部署配置：新增可选 `OMP_MAX_PROCESSES`（缺省 16）；sudo 模式 sudoers 行不变（argv 尾参 `*` 覆盖 `--approval-mode write`）。
- 无数据回填：旧会话无审批记录、无 `parent_session_id`。

## Not yet specified

- 「继续」控件：demo 无对应按钮；停止后用户发新 prompt 即继续。若未来需要"从中断处续写而非新回合"，其与 omp `/retry`/steer 的关系尚说不清问题边界。
- 驱逐策略对多 tab 同会话订阅者的呈现：被驱逐会话的 SSE 客户端收到 `replay.gap` 后重载，页面是否要提示"进程已回收"尚未定义问题。
- 审批请求的细节展示（omp title 中的 `Reason:`/命令详情如何截断与格式化）：本 change 只展示 title 首行工具名与原文 title，格式化规则待真实样本。

## Open Questions

- `OMP_MAX_PROCESSES` 的生产建议值：在测试 VPS 上以真实 omp 起 8/16 个空闲与回合中进程测 RSS，写入本节关闭项；不改架构。
- abort 是否确实被未应答 select 阻塞：以 `make smoke-live` 前置的真二进制手工验证一次；结论只影响 D2 的注释与 fake-omp `approval-then-abort` 是否保留。
- 034 重建迁移在 `PRAGMA foreign_keys=ON` 下 `DROP TABLE` 子表顺序：实现时按 runner 现状决定是否需在迁移内临时 `PRAGMA foreign_keys=OFF`（runner 是否允许待查）；不影响 spec。
