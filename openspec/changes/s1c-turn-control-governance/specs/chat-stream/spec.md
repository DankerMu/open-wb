# Spec delta: chat-stream（S1c A 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 审批事件发布
会话事件联合 SHALL 新增两类由 supervisor（而非纯归约器）产生的事件：`approval.request{messageId,approvalId,tool,title,expiresAt}` 与 `approval.resolved{messageId,approvalId,decision}`，其中 `messageId` 为当前回合的助手消息数字 id，`approvalId` 为 `chat_approvals.id`，`tool`/`title` 为字符串，`expiresAt` 为 epoch ms 整数，`decision` ∈ `allow|deny|timeout`。二者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer，消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，不需要 ring 或 SSE 端点的任何特殊处理；SSE 以 `event:approval.request`/`event:approval.resolved` 帧投递。发布纪律与步骤相同：`approval.request` SHALL 在 `chat_approvals` pending 行提交之后发布，`approval.resolved` SHALL 在该行 `decision`/`decided_at` 与其 `session.approval` 审计行同一事务提交之后发布（作答、超时与停止路径的次序为：落库+审计（同一事务）→ 向子进程发帧 → 发布 `approval.resolved`）；落库失败 SHALL 不发布对应事件。同一助手消息 SHALL 可同时存在多条 pending 审批（并行工具调用），每条以各自 `approvalId` 独立发布 request、独立计时与结算；`approval.request` SHALL 永不覆盖或结算同一消息的更早审批，两类事件的 payload 形状不因此改变。同一 `approvalId` SHALL 至多发布一次 `approval.request` 与一次 `approval.resolved`，且 resolved 不得先于 request。这两类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合的 `approval.resolved`（含停止前的 deny 与超时 allow）SHALL 在该回合 `turn.end` 之前发布。回合在没有子进程应答的情况下终止时（崩溃、传输失败、`applyStop` 退回、优雅关停），以及启动对账把 running 消息置为 `failed` 时，该消息每条仍 pending 的审批 SHALL 由 store 在同一终态事务内以 `deny` 结算（写 `decided_at` 与 `session.approval` 审计，见 chat-sessions「会话持久化与回合刷盘」），不向已死/正在回收的子进程写任何帧，supervisor 取消其超时计时器；对应 `approval.resolved` SHALL 仅在该回合 generation 的 ring 存在时发布（启动对账时尚无 ring，只落库与审计、不发布任何事件），且凡发布 SHALL 在该事务提交之后、该回合 `turn.end` 之前，使快照不残留 pending 审批。

#### Scenario: Request and resolution are ordered ring events
- **WHEN** a bound turn publishes turn.start, then an approval is persisted pending and answered `allow`, and the turn later ends
- **THEN** the ring contains, with consecutive sequence ids, `approval.request{messageId,approvalId,tool,title,expiresAt}` after the pending row commit and `approval.resolved{…,decision:"allow"}` after the decision commit, both before turn.end; an SSE subscriber reconnecting with the id preceding the request replays both in order exactly once

#### Scenario: Refresh during a pending approval
- **WHEN** a client connects without a cursor while the turn is running and its approval is still pending
- **THEN** replay starts at the retained turn.start and includes the `approval.request` event, so the client can render the approval bar without a snapshot round trip; a resolved event published later arrives live with the next sequence

#### Scenario: Persistence failure publishes nothing
- **WHEN** the pending insert, or the transaction writing the decision together with its audit row, fails in SQLite
- **THEN** no `approval.request` respectively `approval.resolved` event enters the ring, no frame is written to the child for that decision, the failure follows the existing owned error-sink path and the ring sequence is not advanced by the failed publication

#### Scenario: Parallel approvals coexist
- **WHEN** real fake-omp (`approval-parallel`) raises two approval selects in one turn and the owner answers the second (`deny`) before the first (`allow`), so the fake completes the turn normally
- **THEN** the ring holds two `approval.request` events with distinct approvalIds in request order, the second request does not alter the first, `approval.resolved` for the second precedes the one for the first, each approvalId has exactly one request and one resolved, and both precede turn.end

#### Scenario: Settlement without a child answer
- **WHEN** a turn with a pending approval ends by native crash, by stop's bounded retire, or by graceful shutdown while its generation's ring exists, and separately the server restarts with a running message holding a pending approval
- **THEN** in the first three cases the approval row reads `deny` with its audit row committed in the terminal transaction, no frame is written to the child for it, and `approval.resolved{decision:"deny"}` is published after that commit and before the single turn.end; on restart reconcile the row reads `deny` with its audit row and no event is published

### Requirement: 纯协议事件归约
The module SHALL provide createEventState({messageId,promptRequestId}), pure applyFrame(state,frame), pure applyFailure(state,message) and pure applyStop(state), returning {state,events}. State SHALL belong to one accepted assistant message and exact RPC request identity, without IO, clocks, randomness, store/runtime imports or mutation of caller inputs. Events SHALL use {type,data} with these payloads: turn.start{messageId}, text.delta{messageId,delta}, step.start{messageId,stepId,name,detail}, step.end{messageId,stepId,status:"done"|"failed",output}, error{messageId,message}, turn.end{messageId,status:"done"|"failed"|"stopped"}. messageId SHALL be the caller-supplied numeric assistant ID; text/name/detail/output/error fields SHALL be strings. ChatEvent<StepId> SHALL permit string tool-call identities in mapper output and numeric persisted identities for later Supervisor publication; the mapper SHALL NOT fabricate database IDs or perform publication. `step.end.status` SHALL NOT be widened: a step left running by a stopped turn is settled by the store, not by the reducer.
The first agent_start SHALL emit turn.start; later duplicate starts SHALL NOT reset state. Only text_delta assistant updates SHALL emit exact text.delta. Thinking/toolcall/turn noise, extension UI requests (including approval-shaped `extension_ui_request{method:"select",options:["Approve","Deny"]}` frames, which are handled by the supervisor and never become reducer events), successful prompt ACKs, prompt_result, responses whose command is not `prompt` (such as `response{command:"abort"}`) and unrelated/malformed frames SHALL be filtered with unchanged state. Extension UI replies and local-only successful runtime completion are outside this pure mapping slice.
Tool starts SHALL correlate by nonempty toolCallId with nonempty toolName; known running calls alone SHALL accept one matching end. Duplicate starts, unknown ends and duplicate ends SHALL NOT create/update another step. Start detail SHALL be compact single-line JSON of args (U+2028/U+2029 escaped). step.end SHALL NOT carry, recompute or overwrite detail. step.end output SHALL be the normalized result text: for a result object whose `content` is an array, its `{type:"text",text:string}` blocks' text and `[图片]` for each `{type:"image"}` block, joined with `\n`, other blocks and all other result fields (including `details` and `providerMetadata`) dropped; an absent, null or undefined result SHALL yield an empty output; a string result SHALL be used as is; any other result SHALL use its compact single-line JSON. Detail and output SHALL each keep at most 4096 Unicode codepoints without splitting a surrogate pair and, when cut, SHALL end with the marker `…（已截断）` appended after the kept codepoints; values within the cap SHALL be kept whole. Output keeps its line breaks. isError===true SHALL set only that step failed, otherwise done; tool failure alone SHALL NOT fail the turn. Correlation keys SHALL NOT access object prototypes.
Assistant message_end SHALL remember exactly one outcome without emitting events: stopReason `error` remembers **failure**, stopReason `aborted` remembers **interruption**; the first remembered outcome wins and later message_end frames, later successful messages, repeated agent_start or agent_end.isTerminal===false SHALL NOT clear or replace it. agent_end.isTerminal===false SHALL not terminate; other agent_end SHALL emit turn.end done when nothing is remembered, error followed immediately by turn.end failed when failure is remembered, or turn.end stopped **without any error event** when interruption is remembered. Matching prompt failure responses and applyFailure SHALL immediately emit error then turn.end failed. applyStop SHALL immediately emit turn.end stopped without an error event, regardless of whether agent_start has arrived or what outcome is remembered; it is the supervisor's retire-fallback terminal for a stop whose agent_end never arrived. Missing/empty failure messages SHALL use the generic fallback. Nonmatching IDs/commands SHALL NOT terminate the accepted prompt.
After any terminal transition, all frame/failure/stop inputs SHALL produce no further events or state changes. Two independent state values SHALL remain isolated, and returned events SHALL NOT alias mutable retained state. Text content SHALL NOT be accumulated in reducer state.

#### Scenario: Normal mapping and filtering
- **WHEN** a bound prompt receives agent_start, text_delta three times, two interleaved tool starts/ends, noise and terminal agent_end
- **THEN** output is the exact allowed sequence for the bound message, tool end identities match their starts, each end carries only status and the normalized output, detail stays single-line, and both obey the 4096-codepoint cap and marker rule, and no noise becomes an event
- **WHEN** frozen state/frame inputs are used or returned events are modified by the caller
- **THEN** inputs and future reducer behavior are unchanged

#### Scenario: Assistant failure survives maintenance
- **WHEN** an assistant `stopReason:"error"` message_end precedes nonterminal agent_end, duplicate start and later successful message_end
- **THEN** no terminal appears until true/omitted-isTerminal agent_end, which emits the first failure error before turn.end failed exactly once
- **WHEN** only a tool reports isError or a non-assistant message reports stopReason error
- **THEN** an otherwise successful final agent_end remains turn.end done

#### Scenario: Aborted turn ends stopped without error
- **WHEN** an assistant `stopReason:"aborted"` message_end precedes nonterminal agent_end, a duplicate agent_start and a later successful message_end, then a terminal agent_end arrives
- **THEN** no event is emitted before the terminal agent_end, which emits exactly one turn.end{status:"stopped"} and no error event; a later `response{command:"abort"}` or any further frame produces no event
- **WHEN** an `error` message_end is followed by an `aborted` message_end, or vice versa, before terminal agent_end
- **THEN** the first remembered outcome decides the terminal: error then turn.end failed in the first case, turn.end stopped alone in the second

#### Scenario: Correlated runtime failure
- **WHEN** a response failure has command prompt and the bound exact id, or the supervisor supplies applyFailure for abnormal runtime exit
- **THEN** error precedes turn.end failed, even if no agent_start has arrived
- **WHEN** an unrelated response or successful prompt ACK arrives
- **THEN** no event or state change occurs

#### Scenario: Supervisor stop fallback
- **WHEN** the supervisor supplies applyStop for a stop whose agent_end never arrived, on a state with or without agent_start and with or without a remembered outcome
- **THEN** exactly one turn.end{status:"stopped"} and no error event are emitted, and every later applyFrame/applyFailure/applyStop input yields no event or state change

#### Scenario: Approval frames are not reducer events
- **WHEN** an `extension_ui_request{method:"select",title:"Allow tool: bash…",options:["Approve","Deny"]}` frame and a non-approval extension UI request arrive during a bound turn
- **THEN** both are filtered with unchanged state and produce no event; the approval is surfaced by the supervisor through the separate approval events

#### Scenario: Step identity and stale inputs
- **WHEN** tool IDs interleave, repeat, use prototype-like strings, or an end names an unknown/already-ended call
- **THEN** only the matching known running call can finish once and other calls are unchanged
- **WHEN** late frames/failure arrive after terminal or a separate prompt state processes its own frames
- **THEN** the terminal state remains terminal and independent prompts do not share failure/tool state

#### Scenario: Real tool result normalization
- **WHEN** a known call ends with an AgentToolResult `{content:[{type:"text",text:"a"},{type:"image",data:"<base64>",mimeType:"image/png"},{type:"text",text:"b"}],details:{…},providerMetadata:{…}}`, or with no result, a null result, a string result, or a non-content object
- **THEN** output is `a\n[图片]\nb` without base64, details or provider metadata; empty for absent/null; the string itself; or that object's compact JSON respectively

#### Scenario: Detail and output cap
- **WHEN** args serialize to exactly 4096 codepoints, and separately to more than 4096 with an astral character straddling the cut, and a result text exceeds 4096 codepoints
- **THEN** the 4096 value is kept whole with no marker; the longer values keep their first 4096 codepoints without a lone surrogate, followed by `…（已截断）`

