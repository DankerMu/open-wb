# Spec delta: chat-stream（S1c B 修改）

> 本 delta 以 change A（`s1c-turn-control-governance`）对 `纯协议事件归约` 的整段重述为基线再次**整段重述**（含 A 的全部 Scenario，另加 B 的 Scenario）；A 新增的 `审批事件发布` 不在此修改。归档次序：A 先于 B 归档，B 的重述替换 A 归档后的同名 Requirement。

## MODIFIED Requirements

### Requirement: 纯协议事件归约
The module SHALL provide createEventState({messageId,promptRequestId}), pure applyFrame(state,frame), pure applyFailure(state,message) and pure applyStop(state), returning {state,events}. State SHALL belong to one accepted assistant message and exact RPC request identity, without IO, clocks, randomness, store/runtime imports or mutation of caller inputs. Events SHALL use {type,data} with these payloads: turn.start{messageId}, text.delta{messageId,delta}, step.start{messageId,stepId,name,detail}, step.end{messageId,stepId,status:"done"|"failed",output}, error{messageId,message}, turn.end{messageId,status:"done"|"failed"|"stopped"}, thinking.delta{messageId,delta}, files.changed{messageId,stepId,files:[{path,added,removed,kind}]} (`kind` ∈ `"edit"|"write"`; `added`/`removed` are nonnegative safe integers for edit and null for write). messageId SHALL be the caller-supplied numeric assistant ID; text/name/detail/output/error/thinking-delta/path fields SHALL be strings. ChatEvent<StepId> SHALL permit string tool-call identities in mapper output and numeric persisted identities for later Supervisor publication; the mapper SHALL NOT fabricate database IDs or perform publication. `step.end.status` SHALL NOT be widened: a step left running by a stopped turn is settled by the store, not by the reducer.
The first agent_start SHALL emit turn.start; later duplicate starts SHALL NOT reset state. Only text_delta assistant updates SHALL emit exact text.delta. Assistant `thinking_delta` updates whose `delta` is a nonempty string SHALL emit exactly one thinking.delta carrying that exact delta per frame, subject to the same agent_start and assistant-role gates as text_delta; merging, the 32768-codepoint cap and publication belong to the supervisor (thinking-fold `thinking.delta 合并发布与持久化`), and the reducer SHALL NOT merge, cap or accumulate thinking. `thinking_start`/`thinking_end` updates, thinking blocks inside message_end content, toolcall/turn noise, extension UI requests (including approval-shaped `extension_ui_request{method:"select",options:["Approve","Deny"]}` frames, which are handled by the supervisor and never become reducer events), successful prompt ACKs, prompt_result, responses whose command is not `prompt` (such as `response{command:"abort"}`) and unrelated/malformed frames SHALL be filtered with unchanged state. Extension UI replies and local-only successful runtime completion are outside this pure mapping slice.
Tool starts SHALL correlate by nonempty toolCallId with nonempty toolName; known running calls alone SHALL accept one matching end. Duplicate starts, unknown ends and duplicate ends SHALL NOT create/update another step. Start detail SHALL be compact single-line JSON of args (U+2028/U+2029 escaped). step.end SHALL NOT carry, recompute or overwrite detail. step.end output SHALL be the normalized result text: for a result object whose `content` is an array, its `{type:"text",text:string}` blocks' text and `[图片]` for each `{type:"image"}` block, joined with `\n`, other blocks and all other result fields (including `details` and `providerMetadata`) dropped from output; an absent, null or undefined result SHALL yield an empty output; a string result SHALL be used as is; any other result SHALL use its compact single-line JSON. Detail and output SHALL each keep at most 4096 Unicode codepoints without splitting a surrogate pair and, when cut, SHALL end with the marker `…（已截断）` appended after the kept codepoints; values within the cap SHALL be kept whole. Output keeps its line breaks. isError===true SHALL set only that step failed, otherwise done; tool failure alone SHALL NOT fail the turn. For a known running call whose toolName is `edit` or `write` and which is not failed, the reducer SHALL read `result.details` only to derive raw file-change candidates exactly as turn-artifacts `文件变更推导与归属` specifies (edit: `perFileResults[{path,diff}]` or `path`+`diff`, counting `+<digits>|` and `-<digits>|` lines; write: `resolvedPath`, counts null), and when at least one candidate exists SHALL emit files.changed{messageId,stepId:<toolCallId>,files:<raw candidates in derivation order>} immediately before that call's step.end in the same result; paths are raw details values, not yet resolved or contained — resolution, workspace containment, relativization, caps and persistence belong to the supervisor. No other tool name, and no failed call, SHALL yield files.changed; details SHALL never enter step output. Correlation keys SHALL NOT access object prototypes.
Assistant message_end SHALL remember exactly one outcome without emitting events: stopReason `error` remembers **failure**, stopReason `aborted` remembers **interruption**; the first remembered outcome wins and later message_end frames, later successful messages, repeated agent_start or agent_end.isTerminal===false SHALL NOT clear or replace it. agent_end.isTerminal===false SHALL not terminate; other agent_end SHALL emit turn.end done when nothing is remembered, error followed immediately by turn.end failed when failure is remembered, or turn.end stopped **without any error event** when interruption is remembered. Matching prompt failure responses and applyFailure SHALL immediately emit error then turn.end failed. applyStop SHALL immediately emit turn.end stopped without an error event, regardless of whether agent_start has arrived or what outcome is remembered; it is the supervisor's retire-fallback terminal for a stop whose agent_end never arrived. Missing/empty failure messages SHALL use the generic fallback. Nonmatching IDs/commands SHALL NOT terminate the accepted prompt.
After any terminal transition, all frame/failure/stop inputs SHALL produce no further events or state changes. Two independent state values SHALL remain isolated, and returned events SHALL NOT alias mutable retained state. Text and thinking content SHALL NOT be accumulated in reducer state.

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

## ADDED Requirements

### Requirement: 思考与文件变更事件发布
会话事件联合 SHALL 在 A 的审批事件之外新增两类经 supervisor 发布的事件：`thinking.delta{messageId,delta}`（`delta` 为非空字符串）与 `files.changed{messageId,stepId,files}`（`stepId` 为持久化步骤数字 id；`files` 为 1..50 个 `{path,added,removed,kind}`，`path` 为空间内相对路径）。二者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer、消费一个正常 `<epoch>:<seq>` id、受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:thinking.delta`/`event:files.changed` 投递，ring 与 SSE 端点无特殊处理。发布纪律 SHALL 为先持久化后发布：`thinking.delta` 在合并后的文本追加进 `chat_messages.thinking` 之后发布（合并节奏 2048 UTF-8 字节 / 2000ms、其它事件前冲刷、32768 码点上限与截断标记、上限后停止发布，见 thinking-fold）；`files.changed` 在 `chat_steps.changes`（JSON 数组文本）提交之后、该步骤 `step.end` 之前发布（归属判定、未绑定会话不发布、上限，见 turn-artifacts）；落库失败 SHALL 不发布对应事件且不推进 ring 序号。两类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合者均在该回合 `turn.end` 之前发布。消息快照 SHALL 与之对应地给出消息 `thinking: string|null` 与步骤 `changes: Change[]|null`，使只看快照的客户端与消费全部事件的客户端得到相同视图。

#### Scenario: Ordered publication after persistence
- **WHEN** a bound turn in a workspace-bound session publishes turn.start, merged thinking, a successful `write` step and text, then ends
- **THEN** the ring holds, with consecutive ids, thinking.delta after its text is saved, step.start, files.changed after the step row's `changes` commit, step.end, text.delta and turn.end, in that order; a client reconnecting with the id preceding thinking.delta replays each exactly once and a snapshot taken afterwards shows the same `thinking` and `changes`

#### Scenario: Persistence failure publishes nothing
- **WHEN** saving merged thinking or committing `chat_steps.changes` fails in SQLite
- **THEN** the corresponding thinking.delta or files.changed never enters the ring, the ring sequence is not advanced by it, and the failure follows the existing owned error-sink path
