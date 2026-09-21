## ADDED Requirements

### Requirement: 纯协议事件归约
The module SHALL provide createEventState({messageId,promptRequestId}), pure applyFrame(state,frame) and pure applyFailure(state,message), returning {state,events}. State SHALL belong to one accepted assistant message and exact RPC request identity, without IO, clocks, randomness, store/runtime imports or mutation of caller inputs. Events SHALL use {type,data} with these payloads: turn.start{messageId}, text.delta{messageId,delta}, step.start{messageId,stepId,name,detail}, step.end{messageId,stepId,status:"done"|"failed",detail}, error{messageId,message}, turn.end{messageId,status:"done"|"failed"}. messageId SHALL be the caller-supplied numeric assistant ID; text/name/detail/error fields SHALL be strings. ChatEvent<StepId> SHALL permit string tool-call identities in mapper output and numeric persisted identities for later Supervisor publication; the mapper SHALL NOT fabricate database IDs or perform publication.
The first agent_start SHALL emit turn.start; later duplicate starts SHALL NOT reset state. Only text_delta assistant updates SHALL emit exact text.delta. Thinking/toolcall/turn noise, extension UI requests, successful prompt ACKs, prompt_result and unrelated/malformed frames SHALL be filtered with unchanged state. Extension UI replies and local-only successful runtime completion are outside this pure mapping slice.
Tool starts SHALL correlate by nonempty toolCallId with nonempty toolName; known running calls alone SHALL accept one matching end. Duplicate starts, unknown ends and duplicate ends SHALL NOT create/update another step. Start detail SHALL be compact single-line JSON of args, at most120 Unicode codepoints without ellipsis; end detail SHALL summarize result the same way, or preserve initial detail when result is absent. isError===true SHALL set only that step failed, otherwise done; tool failure alone SHALL NOT fail the turn. Correlation keys SHALL NOT access object prototypes.
Assistant message_end with stopReason error/aborted SHALL remember the first failure without emitting events; later successful messages, repeated agent_start or agent_end.isTerminal===false SHALL NOT clear it. agent_end.isTerminal===false SHALL not terminate; other agent_end SHALL emit turn.end done, or error followed immediately by turn.end failed if failure was remembered. Matching prompt failure responses and applyFailure SHALL immediately emit error then failed. Missing/empty failure messages SHALL use the generic fallback. Nonmatching IDs/commands SHALL NOT terminate the accepted prompt.
After any terminal transition, all frame/failure inputs SHALL produce no further events or state changes. Two independent state values SHALL remain isolated, and returned events SHALL NOT alias mutable retained state. Text content SHALL NOT be accumulated in reducer state.

#### Scenario: Normal mapping and filtering
- WHEN a bound prompt receives agent_start, text_delta three times, two interleaved tool starts/ends, noise and terminal agent_end
- THEN output is the exact allowed sequence for the bound message, tool end identities match their starts, summaries obey120-codepoint/single-line limits, and no noise becomes an event
- WHEN frozen state/frame inputs are used or returned events are modified by the caller
- THEN inputs and future reducer behavior are unchanged

#### Scenario: Assistant failure survives maintenance
- WHEN an assistant error/aborted message_end precedes nonterminal agent_end, duplicate start and later successful message_end
- THEN no terminal appears until true/omitted-isTerminal agent_end, which emits the first failure error before turn.end failed exactly once
- WHEN only a tool reports isError or a non-assistant message reports stopReason error
- THEN an otherwise successful final agent_end remains turn.end done

#### Scenario: Correlated runtime failure
- WHEN a response failure has command prompt and the bound exact id, or the supervisor supplies applyFailure for abnormal runtime exit
- THEN error precedes turn.end failed, even if no agent_start has arrived
- WHEN an unrelated response or successful prompt ACK arrives
- THEN no event or state change occurs

#### Scenario: Step identity and stale inputs
- WHEN tool IDs interleave, repeat, use prototype-like strings, or an end names an unknown/already-ended call
- THEN only the matching known running call can finish once and other calls are unchanged
- WHEN late frames/failure arrive after terminal or a separate prompt state processes its own frames
- THEN the terminal state remains terminal and independent prompts do not share failure/tool state
