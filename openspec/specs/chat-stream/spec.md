# chat-stream Specification

## Purpose
定义从解码后的omp帧到消息绑定聊天事件的纯归约，以及每会话epoch事件环形缓冲和回放判定。归约覆盖工具/request关联、噪声过滤、摘要、失败记忆与终态顺序；缓冲覆盖有界保留、游标缺口与当前回合刷新。SSE端点与流生命周期接线由后续#103补充。

## Requirements

### Requirement: 纯协议事件归约
The module SHALL provide createEventState({messageId,promptRequestId}), pure applyFrame(state,frame), pure applyFailure(state,message) and pure applyStop(state), returning {state,events}. State SHALL belong to one accepted assistant message and exact RPC request identity, without IO, clocks, randomness, store/runtime imports or mutation of caller inputs. Events SHALL use {type,data} with these payloads: turn.start{messageId}, text.delta{messageId,delta}, step.start{messageId,stepId,name,detail}, step.end{messageId,stepId,status:"done"|"failed",output}, error{messageId,message,reason,status,detail} (`reason`, `status` and the sentence `message` are upstream-failure「回合失败分类」's; in mapper output `detail` is the not yet sanitised source text, in the persisted and published event it is the sanitised text, upstream-failure「上游原文净化」), turn.retry{messageId}, turn.end{messageId,status:"done"|"failed"|"stopped"}, thinking.delta{messageId,delta}, files.changed{messageId,stepId,files:[{path,added,removed,kind}]} (`kind` ∈ `"edit"|"write"`; `added`/`removed` are nonnegative safe integers for edit and null for write), todo.updated{messageId,todo} (in mapper output `todo` is the raw, not yet validated `result.details.phases` value of a `todo` tool result; in the persisted and published event it is the normalized task list `{phases:[{name,tasks:[{content,status}]}]}` or null). The supervisor validates, normalizes, de-duplicates, persists and publishes `todo.updated` as session-todo `任务清单来源与归一化`, `任务清单持久化` and `todo.updated 事件` specify, and a candidate that is dropped there (invalid structure, or equal to the value already stored) is neither persisted nor published and consumes no ring sequence. The supervisor merges, persists and publishes `thinking.delta` as Requirement「思考与文件变更事件发布」 and thinking-fold specify; the supervisor resolves, contains, relativizes, caps, persists and publishes `files.changed` as turn-artifacts `文件变更推导与归属` and Requirement「思考与文件变更事件发布」 specify, and an event that is dropped there (unbound session, no surviving file) is neither persisted nor published and consumes no ring sequence. messageId SHALL be the caller-supplied numeric assistant ID; text/name/detail/output/error/thinking-delta/path fields SHALL be strings. ChatEvent<StepId> SHALL permit string tool-call identities in mapper output and numeric persisted identities for later Supervisor publication; the mapper SHALL NOT fabricate database IDs or perform publication. `step.end.status` SHALL NOT be widened: a step left running by a stopped turn is settled by the store, not by the reducer.
The first agent_start SHALL emit turn.start; later duplicate starts SHALL NOT reset state. Only text_delta assistant updates — and `command_output` frames as specified below — SHALL emit text.delta. Assistant `thinking_delta` updates whose `delta` is a nonempty string SHALL emit exactly one thinking.delta carrying that exact delta per frame, subject to the same agent_start and assistant-role gates as text_delta; merging, the 32768-codepoint cap and publication belong to the supervisor (thinking-fold `thinking.delta 合并发布与持久化`), and the reducer SHALL NOT merge, cap or accumulate thinking. `thinking_start`/`thinking_end` updates, thinking blocks inside message_end content, toolcall/turn noise, extension UI requests (including approval-shaped `extension_ui_request{method:"select",options:["Approve","Deny"]}` frames, which are handled by the supervisor and never become reducer events), successful prompt ACKs, prompt_result, responses whose command is not `prompt` (such as `response{command:"abort"}`) and unrelated/malformed frames SHALL be filtered with unchanged state. A `command_output` frame whose `text` is a string, received while the state is not terminal, SHALL emit turn.start first if no agent_start has been seen (the state then counts as started; a later agent_start does not reset it) and then exactly one text.delta whose `delta` is the text for the first command output of the turn and `"\n"` followed by the text for every later one; the reducer SHALL keep only a boolean `commandOutputSeen`, never the text; a `command_output` without a string `text` SHALL be filtered. Extension UI replies and local-only successful runtime completion (the turn.end of a command-only turn) are outside this pure mapping slice.
Tool starts SHALL correlate by nonempty toolCallId with nonempty toolName; known running calls alone SHALL accept one matching end. Duplicate starts, unknown ends and duplicate ends SHALL NOT create/update another step. Start detail SHALL be compact single-line JSON of args (U+2028/U+2029 escaped). step.end SHALL NOT carry, recompute or overwrite detail. step.end output SHALL be the normalized result text: for a result object whose `content` is an array, its `{type:"text",text:string}` blocks' text and `[图片]` for each `{type:"image"}` block, joined with `\n`, other blocks and all other result fields (including `details` and `providerMetadata`) dropped from output; an absent, null or undefined result SHALL yield an empty output; a string result SHALL be used as is; any other result SHALL use its compact single-line JSON. Detail and output SHALL each keep at most 4096 Unicode codepoints without splitting a surrogate pair and, when cut, SHALL end with the marker `…（已截断）` appended after the kept codepoints; values within the cap SHALL be kept whole. Output keeps its line breaks. isError===true SHALL set only that step failed, otherwise done; tool failure alone SHALL NOT fail the turn. Correlation keys SHALL NOT access object prototypes.
Assistant message_end SHALL remember exactly one outcome without emitting events: stopReason `error` remembers **failure**, stopReason `aborted` remembers **interruption**; the first remembered outcome wins and later message_end frames, later successful messages, repeated agent_start or agent_end.isTerminal===false SHALL NOT clear or replace it — with the single exception of an omp session-level retry: an `auto_retry_start` frame received while the state is started and not terminal SHALL emit exactly one turn.retry{messageId} and mark the state as retrying without clearing the remembered outcome; the first assistant message_end after that SHALL replace the remembered outcome (`error` → that failure, `aborted` → interruption, any other stopReason → nothing remembered) and end the retrying mark; an `auto_retry_end` whose `success` is false and whose `finalError` is exactly `Retry cancelled` SHALL replace the remembered outcome with interruption; every other `auto_retry_end` and an `auto_retry_start` outside a started, non-terminal state SHALL be filtered with unchanged state. The failure an error event carries is the classification of the remembered message_end's `errorStatus` and `errorMessage` (upstream-failure「回合失败分类」, source `message_end`); matching prompt failure responses and applyFailure classify with source runtime. agent_end.isTerminal===false SHALL not terminate; other agent_end SHALL emit turn.end done when nothing is remembered, error followed immediately by turn.end failed when failure is remembered, or turn.end stopped **without any error event** when interruption is remembered. Matching prompt failure responses and applyFailure SHALL immediately emit error then turn.end failed. applyStop SHALL immediately emit turn.end stopped without an error event, regardless of whether agent_start has arrived or what outcome is remembered; it is the supervisor's retire-fallback terminal for a stop whose agent_end never arrived. Missing/empty failure messages SHALL use the generic fallback. Nonmatching IDs/commands SHALL NOT terminate the accepted prompt.
After any terminal transition, all frame/failure/stop inputs SHALL produce no further events or state changes. Two independent state values SHALL remain isolated, and returned events SHALL NOT alias mutable retained state. Text and thinking content SHALL NOT be accumulated in reducer state.

For a known running call whose toolName (the name registered by its tool_execution_start) is `edit` or `write` and which is not failed, the reducer SHALL read `result.details` only to derive raw file-change candidates exactly as turn-artifacts `文件变更推导与归属` specifies (edit: `perFileResults[{path,diff}]` or `path`+`diff`, counting `+<digits>|` and `-<digits>|` lines; write: `resolvedPath`, counts null), and when at least one candidate exists SHALL emit files.changed{messageId,stepId:<toolCallId>,files:<raw candidates in derivation order>} immediately before that call's step.end in the same result; paths are raw details values, not yet resolved or contained — resolution, workspace containment, relativization, caps and persistence belong to the supervisor. No other tool name, and no failed call, SHALL yield files.changed; details SHALL never enter step output.

For a known running call whose toolName (the name registered by its tool_execution_start) is `todo` and which is not failed (neither the frame's `isError` nor `result.isError` is true), when `result` and `result.details` are plain objects and `details` has an own `phases` property, the reducer SHALL emit todo.updated{messageId,todo:<that raw phases value>} immediately before that call's step.end in the same result, reading own properties only and no other key of `details`. The reducer SHALL NOT validate, normalize, cap, compare or retain the value: structural validation, normalization, the 200-task and 200-codepoint limits, the comparison with the stored value, persistence into `chat_sessions.todo` and publication belong to the supervisor (session-todo). A failed `todo` call (omp v18.0.10 then reports the unchanged previous phases), a `todo` result whose `details` is absent, not a plain object or lacks an own `phases`, and every other tool name SHALL yield no todo.updated; a `todo` call never yields files.changed. `command_output` frames, including the output of `/todo …` commands, SHALL NOT yield todo.updated. (This change does not process other omp todo frames.)

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

#### Scenario: Thinking deltas map one-to-one
- **WHEN** a bound turn receives, after agent_start, `thinking_start`, two `thinking_delta` frames with deltas `先` and `想`, an empty-string `thinking_delta`, `thinking_end`, a `text_delta`, and a `thinking_delta` before agent_start in a separate state
- **THEN** output is exactly thinking.delta `先`, thinking.delta `想`, then text.delta, all for the bound messageId; the empty delta, start/end frames and the pre-start frame produce no event and no state change, and the reducer state holds no thinking text

#### Scenario: Edit and write details yield raw candidates
- **WHEN** a known `edit` call ends successfully with `details:{diff:"+3|a\n+4|b\n-3|x\n 2|ctx",path:"/ws/src/app.ts"}`, a known `write` call ends with `details:{resolvedPath:"/ws/out/index.html"}`, a known `bash` call ends with `details:{exitCode:0}`, and a known `edit` call ends with `isError:true`
- **THEN** the first emits files.changed{stepId:<its toolCallId>,files:[{path:"/ws/src/app.ts",added:2,removed:1,kind:"edit"}]} immediately followed by its step.end, the second files.changed{files:[{path:"/ws/out/index.html",added:null,removed:null,kind:"write"}]} followed by its step.end, while bash and the failed edit emit only step.end; every step.end output still excludes details

#### Scenario: Command output becomes assistant text
- **WHEN** a bound turn receives, without any agent_start, `command_output{text:"No todos. Use /todo append <task> to start one."}`, then `command_output{text:"second"}`, then `command_output{output:"x"}` (no string `text`), then a successful prompt ACK `response{command:"prompt",success:true,data:{agentInvoked:false}}`, then an `agent_start`
- **THEN** output is exactly turn.start, text.delta `No todos. Use /todo append <task> to start one.`, text.delta `\nsecond`, all for the bound messageId; the malformed frame, the ACK and the late agent_start produce no event (no second turn.start); the state is not terminal and holds no output text; a `command_output` arriving after a terminal transition produces no event

#### Scenario: Todo result yields a raw candidate
- **WHEN** a known `todo` call ends successfully with `details:{op:"init",phases:[{name:"准备",tasks:[{content:"读取需求",status:"in_progress"}]}],storage:"session"}`, a second known `todo` call ends with frame `isError:true` and the same details, a third known `todo` call ends successfully with `details:{op:"view",storage:"memory"}` (no `phases`), a known `bash` call ends successfully with `details:{phases:[]}`, and a `command_output{text:"Added 1 task."}` frame arrives
- **THEN** the first emits todo.updated{messageId,todo:[{name:"准备",tasks:[{content:"读取需求",status:"in_progress"}]}]} immediately followed by its step.end; the failed call, the call without `phases` and the bash call emit only their step.end; the command output emits only its text.delta; no step.end output contains details, no files.changed is emitted, and the reducer state holds no todo value

#### Scenario: Classified failure payload
- **WHEN** an assistant `message_end{stopReason:"error",errorStatus:401,errorMessage:"401 Incorrect API key provided\nIncorrect API key provided (type=invalid_request_error)"}` precedes a terminal agent_end; separately a prompt failure response with error `boom`
- **THEN** the first emits error{messageId,message:"鉴权失败：模型服务拒绝了配置的 API 密钥",reason:"auth_failed",status:401,detail:<the errorMessage>} then turn.end failed; the second error{…,reason:"agent_failed",status:null,detail:"boom"} then turn.end failed

#### Scenario: Retry that succeeds ends done
- **WHEN** a bound turn receives agent_start, an error message_end (errorStatus 502), turn_end, `auto_retry_start{attempt:1,maxAttempts:1}`, agent_start, three text_delta frames, a `stop` message_end, `auto_retry_end{success:true}` and a terminal agent_end
- **THEN** output is turn.start, exactly one turn.retry, the three text.delta and turn.end done, with no error event

#### Scenario: Retry that fails reports the last failure
- **WHEN** the first round's message_end carries errorStatus 502 with the `status.503` marker, the retry round's message_end carries errorStatus 401, then `auto_retry_end{success:false}` and a terminal agent_end arrive
- **THEN** exactly one turn.retry precedes one error whose reason is `auth_failed` and status 401, then turn.end failed

#### Scenario: Cancelled retry ends stopped
- **WHEN** after an error message_end and `auto_retry_start`, `auto_retry_end{success:false,attempt:1,finalError:"Retry cancelled"}` arrives followed by a terminal agent_end
- **THEN** output after turn.retry is exactly one turn.end stopped and no error event

#### Scenario: Retry frames outside a running turn
- **WHEN** `auto_retry_start` arrives before agent_start, and separately after a terminal transition; and `auto_retry_end{success:false,finalError:"other"}` arrives in a running turn with no retry
- **THEN** none emits an event or changes state

### Requirement: Pure epoch event ring and replay decisions
The sessions stream module SHALL provide a per-session per-epoch RingBuffer with push(event) returning `<streamEpoch>:<seq>` and since(lastEventId|null,{turnRunning}) returning `{mode:'replay'|'gap'|'fresh',events}`. It SHALL reuse canonical numeric-step ChatEvent payloads, returning retained records with id/type/data. The caller supplies the trusted epoch; each new instance SHALL start sequence1 and retain exactly the latest1000 records in ascending sequence order. Separate instances SHALL not share data. It SHALL perform no IO, persistence, runtime allocation or SSE transport; generation ownership and disposal belong to SessionSupervisor. A read-only sequence getter SHALL expose the last assigned sequence, initially0, without advancing it or materializing replay records.

IDs SHALL parse only canonical ASCII nonnegative safe-integer epoch/sequence components separated by one colon, with no sign, whitespace, exponent, fraction or leading zero except0. Null alone means no cursor. Malformed or different-epoch cursors SHALL return gap with no replay records. A same-epoch cursor with seq at least minimum retained seq minus1 SHALL return replay with all and only retained records after that cursor, in order; older cursors SHALL return gap with no records. An empty new ring SHALL use minimum sequence1 for this decision; a valid cursor at or beyond the current tail SHALL return replay with an empty list. The buffer SHALL not synthesize replay.gap records or advance sequence during reads.

Without a cursor, turnRunning=false SHALL return fresh with no records. With turnRunning=true it SHALL replay from the most recent active retained turn.start inclusive; if that start has been evicted, no start has arrived, or the last started turn has ended, it SHALL return gap with no records. A present cursor SHALL take precedence over refresh logic. Retained records SHALL snapshot caller payloads without mutating/freezing caller objects; mutation of an input or returned array SHALL not change later replay. Reads SHALL preserve retained IDs and payload bytes without renumbering.

#### Scenario: Reconnect successors and accepted lower boundary
- WHEN an epoch1 ring receives1001 events and retains sequences2..1001
- THEN cursor1:1 replays2..1001 exactly once, cursor1:0 reports gap, and after event1002 cursor1:1 reports gap
- WHEN a cursor equals the tail or is syntactically valid and ahead of it
- THEN replay contains no records and does not change the next pushed ID

#### Scenario: Refresh only the active retained turn
- WHEN a no-cursor running connection arrives after turn.start and ordered step/text events
- THEN replay starts at that active turn.start and includes its retained successors
- WHEN that start was evicted, has not arrived, or belongs to a completed earlier turn
- THEN the running refresh reports gap rather than replaying stale or partial content
- WHEN a no-cursor nonrunning connection arrives
- THEN it is fresh with no historical replay

#### Scenario: Epoch, grammar and instance isolation
- WHEN an old-epoch or malformed cursor is supplied, including an empty string
- THEN gap contains no events; a new generation's first push still has sequence1
- WHEN two instances receive interleaved events and replay calls
- THEN their IDs, active-turn markers and retained payloads remain independent and repeated reads do not consume records

#### Scenario: Immutable retained records
- WHEN a caller changes an event after push or edits an array returned by since
- THEN future replay still returns the original ID and primitive payload values in their original order without modifying caller-owned objects

### Requirement: Generation-owned recording and snapshot fences
SessionSupervisor SHALL own one RingBuffer per acquired runtime generation, created after the persisted epoch increment. Each canonical event SHALL enter that exact generation ring synchronously after successful persistence/buffering and before optional external observation, even with no observer configured. The ring alone assigns sequence; snapshot reads SHALL not advance it. External sink returns SHALL still reach the synchronous-sink guard unchanged. A pump SHALL retain its generation identity rather than relabeling old events with a mutable replacement epoch.

The synchronous streamCursor(sessionId) port SHALL return the persisted epoch and that generation ring sequence while publication remains possible; otherwise seq SHALL be null, sealing the epoch. Native/token revocation SHALL NOT seal or dispose a generation until pending dispatch resolution and all its publication pumps have settled. Idle exits without pending publication SHALL release the ring. Failed acquisition, full retirement and process restart SHALL have sealed boundaries; a healthy idle-between-turns runtime SHALL retain its numeric sequence. Cleanup SHALL be identity-bound so an old pump cannot delete a replacement ring/slot; retirement SHALL NOT await its own pump. Existing native/pump/store/DB shutdown ordering SHALL remain.

#### Scenario: Sequence across reads and turns
- WHEN a live generation publishes a turn, arbitrary snapshot reads, then another turn
- THEN every data event consumes exactly one monotonic sequence across both turns, snapshots consume none, and the same IDs remain replayable under the unchanged min−1 rule
- WHEN no external observer is configured
- THEN recording and snapshot boundaries still advance identically

#### Scenario: Native exit before publication drain
- WHEN native exit revokes the token while stdout still has residual deltas and a terminal failure to drain
- THEN cursor stays numeric until those events are persisted/buffered and recorded in order; only final publication release seals the epoch and disposes its ring
- WHEN stale finalization from that generation runs after a replacement generation is installed
- THEN the new ring and its sequence remain intact

#### Scenario: Closed and replacement generations
- WHEN there is no runtime, an idle generation exits, an acquisition fails before data publication, or the application restarts from persisted history
- THEN snapshot epoch comes from the persisted session and seq is null once no publication remains; no magic numeric watermark or invented next epoch is used
- WHEN the next generation acquires
- THEN epoch increases once and its first data event is sequence1; previous-epoch queued events cannot duplicate the snapshot

### Requirement: Authenticated session SSE endpoint
GET /api/sessions/:id/events SHALL return200 with Content-Type:text/event-stream; charset=utf-8, Cache-Control:no-store and Connection:keep-alive after existing cookie authentication and owner-scoped authorization. Missing/foreign sessions SHALL return identical404 not_found and unauthenticated requests401 before any stream headers/data; runtimeState SHALL NOT authorize a caller. Route reads SHALL NOT allocate a runtime or mutate history. Each data event SHALL contain id:<epoch>:<seq>, event:<canonical type>, data:<JSON> and a blank-line delimiter. replay.gap SHALL contain empty id:, event:replay.gap, data:{} and consume no sequence. Comment-only : keepalive frames SHALL occur every15000ms through an injectable clock and SHALL NOT alter event IDs/history.

#### Scenario: Actual assembled owned route
- WHEN an authenticated owner connects through the fully assembled app
- THEN status200 and exact SSE/no-store/keep-alive headers arrive without waiting for response end, and subsequent real canonical events arrive with ring IDs and JSON payloads
- WHEN an anonymous, foreign-owner or missing-session request arrives
- THEN401 or identical404 occurs before any SSE frame or subscriber registration

#### Scenario: Framing and idle keepalive
- WHEN canonical text includes newlines, NUL, BOM or Unicode and injected time advances to14999 then15000ms
- THEN JSON round-trips exact data, no heartbeat precedes15000, a comment-only keepalive follows, and no data sequence is consumed

### Requirement: Atomic replay and live subscription
SSE SHALL consume Supervisor's single generation-owned RingBuffer and IDs, not a second buffer/counter. Subscription registration and initial replay decision SHALL be synchronous with no await gap. Retained successors SHALL precede live events exactly once using canonical ring min−1 decisions. Last-Event-ID is present even when empty/malformed; absent cursor with a running turn replays the retained active turn.start inclusive or emits gap. Absent cursor with nonrunning state is fresh. If no ring exists, a present cursor or running state SHALL emit gap; absent cursor/nonrunning is fresh. Gap SHALL precede live-only delivery. Subscribers SHALL remain session-scoped across generation replacement while old rings retain #214 drain/seal semantics.

#### Scenario: Reconnect and accepted lower boundary
- WHEN a client reconnects after1:5 while the ring retains1:6..1:9
- THEN1:6..1:9 arrive in order followed by live1:10 exactly once
- WHEN the retained range is2..1001 and cursor is1:1
- THEN2..1001 are replayable; cursor1:0 or a subsequent eviction yields gap under the unchanged pure-ring decision

#### Scenario: Running refresh and gaps
- WHEN no-ID connection arrives during a turn with retained start, steps and deltas
- THEN replay starts with that turn.start and contains its ordered successors before live delivery
- WHEN start is evicted, cursor is empty/malformed/old epoch/too old, or process reconstruction lost the ring
- THEN the first control frame resets the cursor with empty id and replay.gap before live events; no historical partial replay is fabricated

#### Scenario: Multiple subscribers and replacement
- WHEN two clients subscribe before a turn, one disconnects, and later a runtime generation is replaced
- THEN both initially see identical event IDs/payloads, the surviving client alone receives later events, and new generation events use its actual new epoch starting at1 without old-generation relabeling

#### Scenario: Bounded replay pause and reconnect recovery
- WHEN a near1000-record replay exceeds the writable high-water mark without concurrent live events
- THEN drain resumes after each accepted frame until every retained successor has been sent once before live delivery
- WHEN a new live event arrives while that replay is paused
- THEN that connection ends without queueing/overtaking; reconnect from its last received ID replays the retained suffix or reports gap for snapshot recovery, so delivery guarantees apply across reconnect rather than requiring an unbounded queue

### Requirement: Bounded subscriber isolation and teardown
Transport writers SHALL be synchronous and contain each client's failures without retiring the session runtime or interrupting other clients. During initial replay, raw.write(false) SHALL advance the accepted frame once and pause further writes/heartbeats until drain resumes the suffix; only the bounded initial replay array returned by the ring may be retained. A live event arriving while replay is paused SHALL unregister/end that client rather than queue or reorder it. During ordinary live delivery, raw.write(false) SHALL immediately unregister/end that client and cancel heartbeat, flushing only already-accepted bytes without resending the accepted frame or accumulating a live-event queue. Write throw/error SHALL close only that client. Paused or end-pending responses SHALL remain owned until closed and SHALL be destroyable at app preClose. Disconnect/error/finish cleanup SHALL be idempotent and remove owned timers/listeners/subscriptions. All open responses and subscribers SHALL be released before Fastify shutdown waits for long requests; existing supervisor/store/DB teardown order and #204 external synchronous sink guard SHALL remain intact.

#### Scenario: Broken or backpressured client
- WHEN a replay write returnsfalse and no new live event arrives before drain
- THEN no further bytes are written while blocked, drain resumes after the accepted record without duplication, and the full retained replay can complete before live delivery
- WHEN a writer throws/emits error, or a live event arrives while that client is blocked
- THEN only that client closes/unsubscribes, no live event queue grows, healthy delivery/runtime continue and no unhandled rejection occurs

#### Scenario: Disconnect and app shutdown
- WHEN raw injection AbortSignal or a real client socket disconnects
- THEN its subscription count and owned keepalive timers return to zero without stopping the runtime
- WHEN app.close occurs with active streams or an end-pending slow response
- THEN close resolves after releasing responses/subscribers/timers and the existing native/store/DB order is preserved

### Requirement: 步骤 detail 不做路径改写
按 ADR-0011，工具步骤的 detail（由 args 派生）与 output（由 result 派生），经 SSE 发布、落库并由历史接口返回，SHALL 原样保留其中出现的绝对沙箱路径，不做前缀替换或其它脱敏；截断、单行化与码点边界规则不受影响。

#### Scenario: 含沙箱路径的 args 原样进入 detail
- **WHEN** 映射器收到 `tool_execution_start`，其 args 含 `<SANDBOX_ROOT>/<ownerId>/<dir>/a.md` 形态的绝对路径且序列化后不超过 detail 上限
- **THEN** `step.start` 的 detail 包含该路径原文

#### Scenario: 含沙箱路径的 result 原样进入 output
- **WHEN** 映射器收到已知调用的 `tool_execution_end`，其 result 的 text 块含 `<SANDBOX_ROOT>/<ownerId>/<dir>/a.md` 形态的绝对路径且不超过 output 上限
- **THEN** `step.end` 的 output 包含该路径原文

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

### Requirement: 思考与文件变更事件发布
会话事件联合 SHALL 在 A 的审批事件之外包含三类经 supervisor 发布的事件：`thinking.delta{messageId,delta}`（`delta` 为非空字符串）、`thinking.end{messageId,thinkingMs,segment}`（`thinkingMs` 为非负安全整数，`segment` 为刚结束那一段的 `{bodyOffset,thinkingOffset,thinkingLength,stepsBefore,thinkingMs}`，五个值都是非负安全整数，见 thinking-fold「思考时长记录与下发」）与 `files.changed{messageId,stepId,files}`（`stepId` 为持久化步骤数字 id；`files` 为 1..50 个 `{path,added,removed,kind}`，`path` 为空间内相对路径）。三者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer、消费一个正常 `<epoch>:<seq>` id、受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:thinking.delta`/`event:thinking.end`/`event:files.changed` 投递，ring 与 SSE 端点无特殊处理。发布纪律 SHALL 为先持久化后发布：`thinking.delta` 在合并后的文本追加进 `chat_messages.thinking` 之后、在同一同步段内（中间无 await）入 ring（合并节奏见本 spec「正文与思考增量的时间窗合并」；32768 码点上限与截断标记、上限后停止发布见 thinking-fold）；`thinking.end` 在累计时长写入 `chat_messages.thinking_ms` 并把该段的长度与时长写入其 `chat_thinking_segments` 行之后、在同一同步段内入 ring（闭段时机见 thinking-fold「思考时长记录与下发」）；`files.changed` 在 `chat_steps.changes`（JSON 数组文本）提交之后、该步骤 `step.end` 之前发布（归属判定、未绑定会话不发布、上限，见 turn-artifacts）；落库失败 SHALL 不发布对应事件且不推进 ring 序号。三类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合者均在该回合 `turn.end` 之前发布。消息快照 SHALL 与之对应地给出消息 `thinking: string|null`、`thinkingMs: number|null`、`thinkingSegments` 与步骤 `changes: Change[]|null`，使只看快照的客户端与消费全部事件的客户端得到相同视图。

#### Scenario: Ordered publication after persistence
- **WHEN** a turn in a workspace-bound session publishes turn.start, merged thinking, a successful `edit` step, a successful `write` step and text, then ends
- **THEN** the ring holds, with consecutive ids, turn.start, the thinking.delta events (one or more, as coalesced) each after its text is saved, thinking.end after `thinking_ms` and the segment row are saved (its `segment` equal to that row), then for each step step.start, files.changed after the step row's `changes` commit and step.end, then text.delta and turn.end, in that order; a client reconnecting with the id preceding the first thinking.delta replays each exactly once and a snapshot taken afterwards shows the same `thinking`, `thinkingMs` and `changes`

#### Scenario: Persistence failure publishes nothing
- **WHEN** saving merged thinking, writing `thinking_ms` or the segment row, or committing `chat_steps.changes` fails in SQLite
- **THEN** the corresponding thinking.delta, thinking.end or files.changed never enters the ring, the ring sequence is not advanced by it, and the failure follows the existing owned error-sink path

### Requirement: 正文与思考增量的时间窗合并
SessionSupervisor SHALL 为每个 slot 持有一个增量合并器，处理同一回合助手消息的两类增量事件：`text.delta`（含 `command_output` 映射出的 `text.delta`）与 `thinking.delta`。纯协议事件归约（「纯协议事件归约」）的帧到事件映射不变，合并只发生在 supervisor 持久化与发布之前，只改变事件的切分，不改变同一消息同一类增量按发布顺序拼接后的全文。合并器 SHALL 一次只缓冲一类，规则为：
- 一段某类增量到达时，若缓冲中是另一类，先冲刷缓冲；若此时缓冲为空，且该类在本回合从未发布过或距该类上一次发布已满 250ms（注入时钟），立即发布这一段；否则并入缓冲，并在「该类上一次发布时刻 + 250ms」到点时发布缓冲内容（同一时刻只有一个计时）；
- 即将发布同一回合的任何非增量事件（`step.start`、`step.end`、`files.changed`、`approval.request`、`approval.resolved`、`todo.updated`、`turn.retry`、`thinking.end`、`error`、`turn.end`）之前，以及回合进入终态（含 `applyFailure`/`applyStop` 的退回、崩溃与优雅关停）之前，SHALL 立即冲刷缓冲；
- 每次发布（前沿、到点或冲刷）都记为该类的上一次发布时刻；不设字节阈值。
由此同一回合任一类的两条相邻事件发布时刻相隔不少于 250ms，冲刷产生的事件除外；ring 中各事件的相对次序等于上游帧到达次序。
发布一条合并后的 `text.delta` 时，supervisor SHALL 在同一同步段内（中间无 await）把它交给 store 的正文缓冲（chat-sessions「会话持久化与回合刷盘」的 `appendDelta`，落库节奏 2048 字节 / 2000ms 不变）并入 ring；`thinking.delta` 的落库与发布见 thinking-fold「thinking.delta 合并发布与持久化」。合并器中尚未发布的增量 SHALL 不进入 store、不进入 ring、不出现在快照中，所以快照仍等于已发布前缀（chat-sessions「Complete snapshot overlap boundary」不变）。slot 因基础设施故障退役时，合并器中尚未发布的增量 SHALL 被丢弃。

#### Scenario: 首段立即、之后按时间窗
- **WHEN** 注入时钟下一回合的正文帧在 t=0、10、20、…、990ms 各到达一段（共 100 段，每段一个字），其间无其它事件，t=1000ms 到达 agent_end
- **THEN** 第一条 `text.delta` 在 t=0 发布且只含第一段；其后的 `text.delta` 在 t=250、500、750ms 各发布一条，`turn.end` 之前的冲刷再发布一条；`text.delta` 共 5 条；它们按序拼接后恰为 100 个字；快照正文与之逐字相同

#### Scenario: 两类交错保持次序
- **WHEN** 同一时刻依次到达 thinking `a`、thinking `b`、正文 `c`、正文 `d`、thinking `e`，随后 agent_end
- **THEN** ring 中依次为 `thinking.delta{a}`（前沿）、`thinking.delta{b}`（因正文到达而冲刷）、`thinking.end`、`text.delta{c}`（前沿）、`text.delta{d}`（因 thinking 到达而冲刷）、`thinking.delta{e}`（距上一次 thinking 发布不足 250ms，缓冲到终态前冲刷）、`thinking.end`、`turn.end`（`thinking.end` 的时机见 thinking-fold「思考时长记录与下发」）；没有任何一段先于在它之前到达的段发布

#### Scenario: 非增量事件前冲刷
- **WHEN** 合并器缓冲着正文 `xy` 时到达该回合的 `tool_execution_start`
- **THEN** ring 中 `text.delta{xy}` 紧先于该 `step.start`；该 `text.delta` 之后正文缓冲（store pending）含 `xy`

#### Scenario: 快照与重连不重复
- **WHEN** 合并器缓冲着正文 `尾部` 时客户端读取快照（得到正文 P 与游标 C），随后 `尾部` 作为一条 `text.delta` 以 C 的后继 id 发布，客户端以游标 C 续流
- **THEN** 快照正文 P 不含 `尾部`；客户端追加该事件后正文为 P + `尾部`，与回合结束后的快照逐字相同

#### Scenario: 崩溃时的缓冲
- **WHEN** fake-omp 发两段正文后退出（第二段仍在合并器中），回合以 error 与 failed `turn.end` 结算
- **THEN** 第二段在 error 之前作为一条 `text.delta` 发布，failed 助手消息正文含两段；基础设施故障退役的另一例中合并器里的段不发布

#### Scenario: 本地完成路径的冲刷
- **WHEN** 一个只有本地命令输出的回合（无映射器终态，chat-sessions「Supervisor ordered persistence and publication」的本地完成路径）在 250ms 内到达两段 `command_output`，第二段仍在合并器中时运行时确认本地完成
- **THEN** 第二段在 `turn.end{status:"done"}` 之前作为一条 `text.delta` 发布并进入正文缓冲；终态事务提交后助手正文等于两段输出按规则拼接的全文；没有任何 `text.delta` 晚于 `turn.end`

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
