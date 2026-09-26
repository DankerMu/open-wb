# Spec delta: chat-stream（#455 aborted → stopped 归约与 applyStop）

> 父 delta「纯协议事件归约」整段（全部段落与九个 Scenario）均为纯归约器行为，由本 issue 全量交付，逐字取自父 delta。supervisor 调用 `applyStop` 的有界退回归 4.2a #473；父 delta「审批事件发布」的发布纪律归 4.3 #464 / 4.6 #474，不在本 delta。

## MODIFIED Requirements

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
