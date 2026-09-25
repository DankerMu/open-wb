## MODIFIED Requirements

### Requirement: 纯协议事件归约
The module SHALL provide createEventState({messageId,promptRequestId}), pure applyFrame(state,frame) and pure applyFailure(state,message), returning {state,events}. State SHALL belong to one accepted assistant message and exact RPC request identity, without IO, clocks, randomness, store/runtime imports or mutation of caller inputs. Events SHALL use {type,data} with these payloads: turn.start{messageId}, text.delta{messageId,delta}, step.start{messageId,stepId,name,detail}, step.end{messageId,stepId,status:"done"|"failed",output}, error{messageId,message}, turn.end{messageId,status:"done"|"failed"}. messageId SHALL be the caller-supplied numeric assistant ID; text/name/detail/output/error fields SHALL be strings. ChatEvent<StepId> SHALL permit string tool-call identities in mapper output and numeric persisted identities for later Supervisor publication; the mapper SHALL NOT fabricate database IDs or perform publication.
The first agent_start SHALL emit turn.start; later duplicate starts SHALL NOT reset state. Only text_delta assistant updates SHALL emit exact text.delta. Thinking/toolcall/turn noise, extension UI requests, successful prompt ACKs, prompt_result and unrelated/malformed frames SHALL be filtered with unchanged state. Extension UI replies and local-only successful runtime completion are outside this pure mapping slice.
Tool starts SHALL correlate by nonempty toolCallId with nonempty toolName; known running calls alone SHALL accept one matching end. Duplicate starts, unknown ends and duplicate ends SHALL NOT create/update another step. Start detail SHALL be compact single-line JSON of args (U+2028/U+2029 escaped). step.end SHALL NOT carry, recompute or overwrite detail. step.end output SHALL be the normalized result text: for a result object whose `content` is an array, its `{type:"text",text:string}` blocks' text and `[图片]` for each `{type:"image"}` block, joined with `\n`, other blocks and all other result fields (including `details` and `providerMetadata`) dropped; an absent, null or undefined result SHALL yield an empty output; a string result SHALL be used as is; any other result SHALL use its compact single-line JSON. Detail and output SHALL each keep at most 4096 Unicode codepoints without splitting a surrogate pair and, when cut, SHALL end with the marker `…（已截断）` appended after the kept codepoints; values within the cap SHALL be kept whole. Output keeps its line breaks. isError===true SHALL set only that step failed, otherwise done; tool failure alone SHALL NOT fail the turn. Correlation keys SHALL NOT access object prototypes.
Assistant message_end with stopReason error/aborted SHALL remember the first failure without emitting events; later successful messages, repeated agent_start or agent_end.isTerminal===false SHALL NOT clear it. agent_end.isTerminal===false SHALL not terminate; other agent_end SHALL emit turn.end done, or error followed immediately by turn.end failed if failure was remembered. Matching prompt failure responses and applyFailure SHALL immediately emit error then failed. Missing/empty failure messages SHALL use the generic fallback. Nonmatching IDs/commands SHALL NOT terminate the accepted prompt.
After any terminal transition, all frame/failure inputs SHALL produce no further events or state changes. Two independent state values SHALL remain isolated, and returned events SHALL NOT alias mutable retained state. Text content SHALL NOT be accumulated in reducer state.

#### Scenario: Normal mapping and filtering
- WHEN a bound prompt receives agent_start, text_delta three times, two interleaved tool starts/ends, noise and terminal agent_end
- THEN output is the exact allowed sequence for the bound message, tool end identities match their starts, each end carries only status and the normalized output, detail stays single-line, and both obey the 4096-codepoint cap and marker rule, and no noise becomes an event
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

#### Scenario: Real tool result normalization
- WHEN a known call ends with an AgentToolResult `{content:[{type:"text",text:"a"},{type:"image",data:"<base64>",mimeType:"image/png"},{type:"text",text:"b"}],details:{…},providerMetadata:{…}}`, or with no result, a null result, a string result, or a non-content object
- THEN output is `a\n[图片]\nb` without base64, details or provider metadata; empty for absent/null; the string itself; or that object's compact JSON respectively

#### Scenario: Detail and output cap
- WHEN args serialize to exactly 4096 codepoints, and separately to more than 4096 with an astral character straddling the cut, and a result text exceeds 4096 codepoints
- THEN the 4096 value is kept whole with no marker; the longer values keep their first 4096 codepoints without a lone surrogate, followed by `…（已截断）`


### Requirement: 步骤 detail 不做路径改写
按 ADR-0011，工具步骤的 detail（由 args 派生）与 output（由 result 派生），经 SSE 发布、落库并由历史接口返回，SHALL 原样保留其中出现的绝对沙箱路径，不做前缀替换或其它脱敏；截断、单行化与码点边界规则不受影响。

#### Scenario: 含沙箱路径的 args 原样进入 detail
- **WHEN** 映射器收到 `tool_execution_start`，其 args 含 `<SANDBOX_ROOT>/<ownerId>/<dir>/a.md` 形态的绝对路径且序列化后不超过 detail 上限
- **THEN** `step.start` 的 detail 包含该路径原文

#### Scenario: 含沙箱路径的 result 原样进入 output
- **WHEN** 映射器收到已知调用的 `tool_execution_end`，其 result 的 text 块含 `<SANDBOX_ROOT>/<ownerId>/<dir>/a.md` 形态的绝对路径且不超过 output 上限
- **THEN** `step.end` 的 output 包含该路径原文
