## MODIFIED Requirements

### Requirement: 思考与文件变更事件发布
会话事件联合 SHALL 在 A 的审批事件之外包含三类经 supervisor 发布的事件：`thinking.delta{messageId,delta}`（`delta` 为非空字符串）、`thinking.end{messageId,thinkingMs,segment}`（`thinkingMs` 为非负安全整数，`segment` 为刚结束那一段的 `{bodyOffset,thinkingOffset,thinkingLength,stepsBefore,thinkingMs}`，五个值都是非负安全整数，见 thinking-fold「思考时长记录与下发」）与 `files.changed{messageId,stepId,files}`（`stepId` 为持久化步骤数字 id；`files` 为 1..50 个 `{path,added,removed,kind}`，`path` 为空间内相对路径）。三者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer、消费一个正常 `<epoch>:<seq>` id、受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:thinking.delta`/`event:thinking.end`/`event:files.changed` 投递，ring 与 SSE 端点无特殊处理。发布纪律 SHALL 为先持久化后发布：`thinking.delta` 在合并后的文本追加进 `chat_messages.thinking` 之后、在同一同步段内（中间无 await）入 ring（合并节奏见本 spec「正文与思考增量的时间窗合并」；32768 码点上限与截断标记、上限后停止发布见 thinking-fold）；`thinking.end` 在累计时长写入 `chat_messages.thinking_ms` 并把该段的长度与时长写入其 `chat_thinking_segments` 行之后、在同一同步段内入 ring（闭段时机见 thinking-fold「思考时长记录与下发」）；`files.changed` 在 `chat_steps.changes`（JSON 数组文本）提交之后、该步骤 `step.end` 之前发布（归属判定、未绑定会话不发布、上限，见 turn-artifacts）；落库失败 SHALL 不发布对应事件且不推进 ring 序号。三类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合者均在该回合 `turn.end` 之前发布。消息快照 SHALL 与之对应地给出消息 `thinking: string|null`、`thinkingMs: number|null`、`thinkingSegments` 与步骤 `changes: Change[]|null`，使只看快照的客户端与消费全部事件的客户端得到相同视图。

#### Scenario: Ordered publication after persistence
- **WHEN** a turn in a workspace-bound session publishes turn.start, merged thinking, a successful `edit` step, a successful `write` step and text, then ends
- **THEN** the ring holds, with consecutive ids, turn.start, the thinking.delta events (one or more, as coalesced) each after its text is saved, thinking.end after `thinking_ms` and the segment row are saved (its `segment` equal to that row), then for each step step.start, files.changed after the step row's `changes` commit and step.end, then text.delta and turn.end, in that order; a client reconnecting with the id preceding the first thinking.delta replays each exactly once and a snapshot taken afterwards shows the same `thinking`, `thinkingMs` and `changes`

#### Scenario: Persistence failure publishes nothing
- **WHEN** saving merged thinking, writing `thinking_ms` or the segment row, or committing `chat_steps.changes` fails in SQLite
- **THEN** the corresponding thinking.delta, thinking.end or files.changed never enters the ring, the ring sequence is not advanced by it, and the failure follows the existing owned error-sink path


### Requirement: 审批事件发布
会话事件联合 SHALL 新增两类由 supervisor（而非纯归约器）产生的事件：`approval.request{messageId,approvalId,tool,title,expiresAt,stepId}` 与 `approval.resolved{messageId,approvalId,decision}`，其中 `messageId` 为当前回合的助手消息数字 id，`approvalId` 为 `chat_approvals.id`，`tool`/`title` 为字符串，`expiresAt` 为 epoch ms 整数，`stepId` 为发布时该审批已配上的步骤 id 或 `null`（tool-approval「确认与步骤配对」），`decision` ∈ `allow|deny|timeout`。二者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer，消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，不需要 ring 或 SSE 端点的任何特殊处理；SSE 以 `event:approval.request`/`event:approval.resolved` 帧投递。发布纪律与步骤相同：`approval.request` SHALL 在 `chat_approvals` pending 行提交之后发布（在审批 select 时配上步骤的，还在该行 `step_id` 写入提交之后），`approval.resolved` SHALL 在该行 `decision`/`decided_at` 与其 `session.approval` 审计行同一事务提交之后发布（作答、超时与停止路径的次序为：落库+审计（同一事务）→ 向子进程发帧 → 发布 `approval.resolved`）；落库失败 SHALL 不发布对应事件。同一助手消息 SHALL 可同时存在多条 pending 审批（并行工具调用），每条以各自 `approvalId` 独立发布 request、独立计时与结算；`approval.request` SHALL 永不覆盖或结算同一消息的更早审批，两类事件的 payload 形状不因此改变。同一 `approvalId` SHALL 至多发布一次 `approval.request` 与一次 `approval.resolved`，且 resolved 不得先于 request。这两类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合的 `approval.resolved`（含停止前的 deny 与超时 allow）SHALL 在该回合 `turn.end` 之前发布。回合在没有子进程应答的情况下终止时（崩溃、传输失败、`applyStop` 退回、优雅关停），以及启动对账把 running 消息置为 `failed` 时，该消息每条仍 pending 的审批 SHALL 由 store 在同一终态事务内以 `deny` 结算（写 `decided_at` 与 `session.approval` 审计，见 chat-sessions「会话持久化与回合刷盘」），不向已死/正在回收的子进程写任何帧，supervisor 取消其超时计时器；对应 `approval.resolved` SHALL 仅在该回合 generation 的 ring 存在时发布（启动对账时尚无 ring，只落库与审计、不发布任何事件），且凡发布 SHALL 在该事务提交之后、该回合 `turn.end` 之前，使快照不残留 pending 审批。

#### Scenario: Request and resolution are ordered ring events
- **WHEN** a bound turn publishes turn.start, then an approval is persisted pending and answered `allow`, and the turn later ends
- **THEN** the ring contains, with consecutive sequence ids, `approval.request{messageId,approvalId,tool,title,expiresAt,stepId}` (`stepId` null, the step not yet started) after the pending row commit and `approval.resolved{…,decision:"allow"}` after the decision commit, both before turn.end; an SSE subscriber reconnecting with the id preceding the request replays both in order exactly once

#### Scenario: Refresh during a pending approval
- **WHEN** a client connects without a cursor while the turn is running and its approval is still pending
- **THEN** replay starts at the retained turn.start and includes the `approval.request` event, so the client can render the approval bar without a snapshot round trip; a resolved event published later arrives live with the next sequence

#### Scenario: Persistence failure publishes nothing
- **WHEN** the pending insert, the `step_id` write that pairs the approval at its select (tool-approval「确认与步骤配对」), or the transaction writing the decision together with its audit row, fails in SQLite
- **THEN** no `approval.request` respectively `approval.resolved` event enters the ring, no frame is written to the child for that decision, the ring sequence is not advanced by the failed publication; a failed pending insert or timeout settlement follows the existing owned error-sink path, while a failed owner answer rejects the caller with the original error and leaves the approval pending

#### Scenario: Parallel approvals coexist
- **WHEN** real fake-omp (`approval-parallel`) raises two approval selects in one turn and the owner answers the second (`deny`) before the first (`allow`), so the fake completes the turn normally
- **THEN** the ring holds two `approval.request` events with distinct approvalIds in request order, the second request does not alter the first, `approval.resolved` for the second precedes the one for the first, each approvalId has exactly one request and one resolved, and both precede turn.end

#### Scenario: Settlement without a child answer
- **WHEN** a turn with a pending approval ends by native crash, by stop's bounded retire, or by graceful shutdown while its generation's ring exists, and separately the server restarts with a running message holding a pending approval
- **THEN** in the first three cases the approval row reads `deny` with its audit row committed in the terminal transaction, no frame is written to the child for it, and `approval.resolved{decision:"deny"}` is published after that commit and before the single turn.end; on restart reconcile the row reads `deny` with its audit row and no event is published

## ADDED Requirements

### Requirement: 分段位置的记录与下发
SessionSupervisor SHALL 为每个回合（一条助手消息）维护「正文已发布长度」：该回合每发布一条 `text.delta`（含 `command_output` 映射出的）就加上其 `delta` 的 UTF-16 码元数（JavaScript 字符串的 `length`；不是字节数，也不是码点数），回合开始时为 0。由于正文缓冲（chat-sessions「会话持久化与回合刷盘」的 `appendDelta`）只收已发布的增量，这个值恒等于「已落库正文 + 回合 pending」的长度，即快照 `content` 的长度，也等于客户端按序拼接已收到的 `text.delta` 得到的长度。

**边界前冲刷**：在记录任何位置边界之前，SHALL 先冲刷增量合并器（「正文与思考增量的时间窗合并」），使记录的偏移把合并器里尚未发布的正文也发布出去并计入。边界有三种：步骤开始（`step.start`；它作为非增量事件本来就先冲刷合并器，次序不变）；一段思考开始（thinking-fold「思考时长记录与下发」的开段：合并器里缓冲着正文时，SHALL 先把那段正文作为一条 `text.delta` 发布，再开段；即使这段思考的第一条增量本身会被缓冲）；一段思考结束（闭段）。由此每个记录的正文偏移都等于该边界之前 ring 中同一消息全部 `text.delta` 拼接后的长度。

**闭段**：开着的一段思考在以下三者中最先发生的时刻闭合（#910 的既有时机，不变）：pump 读到 omp 原始的 `thinking_end` 帧；一条 `text.delta` 到达；任何非增量事件发布之前（`step.start`、`approval.request`、`approval.resolved`——含 pump 之外的作答与超时路径——、`turn.retry`、`error`、`turn.end` 等，它们都先冲刷合并器）。闭段时 SHALL 先把合并器里缓冲着的思考作为一条 `thinking.delta` 保存并发布，再量该段：`thinking_length` 为此刻已保存 `thinking` 的长度减去该段的 `thinking_offset`。所以一段思考永远不会跨过可见的正文、步骤或审批而保持开着：同一位置之后任何可见块出现之前，该段已闭合并发布 `thinking.end`。

**步骤**：`step.start` 的持久化 SHALL 在插入步骤行的同一事务里写 `chat_steps.body_offset` 为此刻的正文已发布长度（并按 tool-approval「确认与步骤配对」写配对）；发布的 `step.start` 负载 SHALL 为 `{messageId,stepId,name,detail,bodyOffset,approvalId}`：`bodyOffset` 即所写的值，`approvalId` 为本步骤配上的 `chat_approvals.id` 或 `null`。纯协议事件归约（「纯协议事件归约」）输出的 `step.start` 形状不变，这两个字段只出现在持久化之后发布的事件里。写入失败沿既有 owned error-sink 处理，不发布该 `step.start`。

#### Scenario: 合并器缓冲着正文时开段
- **WHEN** 注入时钟下一回合在 t=0 到达正文 `看`（前沿立即发布），t=100ms 到达正文 `一下`（缓冲），t=120ms 到达第一条思考增量 `想`
- **THEN** ring 中依次为 `text.delta{看}`、`text.delta{一下}`（t=120ms 因开段被冲刷）、`thinking.delta{想}`；该段的 `chat_thinking_segments.body_offset` 为 3，等于两条 `text.delta` 拼接后的长度；同一时刻读取的快照 `content` 为 `看一下`，其 `thinkingSegments` 末段 `bodyOffset` 为 3、`thinkingLength` 为 `null`

#### Scenario: 步骤的正文偏移
- **WHEN** fake-omp `approval-parallel` 回合先发正文增量，再发两个 bash 审批的 select 与两个 `tool_execution_start`
- **THEN** 两条 `step.start` 的 `bodyOffset` 都等于其前全部 `text.delta` 的 `delta` 拼接后的 UTF-16 长度，与快照中两个步骤的 `bodyOffset` 相同；每条 `step.start` 之前 ring 中没有晚于它到达的正文

#### Scenario: 闭段时长度含缓冲的思考
- **WHEN** 注入时钟下一段思考在 t=0 到达 `先`（前沿发布）、t=100ms 到达 `想想`（缓冲），t=150ms 到达正文 `好`；另一例 t=150ms 到达的不是正文而是一个 `approval.request`
- **THEN** 两例 ring 中依次为 `thinking.delta{先}`、`thinking.delta{想想}`、`thinking.end`（其 `segment.thinkingLength` 为 3），然后才是 `text.delta{好}` 或 `approval.request`；该段行的 `thinking_length` 为 3

#### Scenario: 码元而非码点
- **WHEN** 一回合发布正文 `a😀`（`😀` 为一个码点、两个 UTF-16 码元）后开始一个步骤
- **THEN** 该步骤的 `bodyOffset` 为 3

#### Scenario: 真 omp 链路上的开段偏移
- **WHEN** 官方 omp v18.0.10 经受控假上游运行一个带 `WORKBUDDY_INTERLEAVE` 的回合（omp-test-harness「受控上游交错标记」：正文两片相隔 25ms，随后一片思考，再一片正文）
- **THEN** ring 中第一条 `thinking.delta` 之前的 `text.delta` 拼接恰为前两片正文；回合结束后快照 `thinkingSegments` 恰一段，其 `bodyOffset` 等于该拼接的长度，`thinkingOffset` 为 0、`thinkingLength` 等于思考片的长度
