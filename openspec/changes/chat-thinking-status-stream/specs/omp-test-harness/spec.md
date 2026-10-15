## MODIFIED Requirements

### Requirement: Isolated bounded upstream dialogue gate
The existing loopback fake-upstream SHALL expose test-only authenticated gate control using its existing expected bearer: POST `/__control/gates/{uuid}` arm, GET phase, POST `/__control/gates/{uuid}/release` release held response, DELETE cleanup. Gate identity SHALL bind one final text response selected by the last user's `WORKBUDDY_UI_WALK:<uuid>` marker; the tool round remains unchanged. An armed final response SHALL send role and first nonempty content prefix (unless the last user text carries `WORKBUDDY_HOLD_AT`, whose hold points are defined by「受控上游节奏与闸门停点标记」) but withhold remaining content/finish/DONE until explicit release. Released bytes SHALL reconstruct the unchanged fixed reply. Default/unarmed requests SHALL retain existing behavior.
The fixture SHALL reject wrong bearer401, invalid ID400, duplicate arm or invalid transition409, unknown ID404 and claims of an already-bound gate without stealing ownership. Gates SHALL be instance-local, bounded to32 entries and30s lifetime; expiry/delete/disconnect/server close SHALL clear owned timers/state and destroy unfinished held responses instead of forging completion. Control failure SHALL not release another gate. No gate route SHALL exist in product app-server.

#### Scenario: Hold and release preserve real protocol
- WHEN an authenticated test arms a UUID gate and real omp sends matching final text request after bash
- THEN the upstream publishes prefix and held phase without finish; release sends the remaining original chunks and DONE exactly once

#### Scenario: Ownership and cleanup fail closed
- WHEN two distinct gates coexist, a request targets a different/unknown gate, authentication fails, a transition duplicates, or TTL/delete/disconnect/close occurs
- THEN only the owning gate can change; invalid controls fail explicitly, unfinished cancelled responses do not complete successfully and no owned gate/timer remains after cleanup

### Requirement: 受控上游思考与写入标记
The existing loopback fake-upstream (`server/test/support/fake-upstream.mjs`, the controlled upstream behind real omp in `make smoke`, `make ui-walk` and their CI jobs) SHALL additionally honour three markers found as substrings of the last user message text, selected by the same last-user-text lookup as `WORKBUDDY_UI_WALK:<uuid>` and combinable with it and with each other. `WORKBUDDY_THINK`: the answering text round (the request whose history already holds a `tool` role message) SHALL emit, after the `role` chunk and before the first `content` chunk, exactly three chunks whose `delta` is `{reasoning_content:<part>}` with parts `先读需求，`, `再列要点，`, `最后作答。` (the same deterministic thinking text as the fake omp `thinking` scenario), leaving the content chunks, finish reason and `[DONE]` unchanged; under an armed gate these reasoning chunks are part of the prefix sent before the hold and release is unchanged (unless `WORKBUDDY_HOLD_AT` selects another hold point,「受控上游节奏与闸门停点标记」). `WORKBUDDY_WRITE`: the tool round (history without a `tool` role message) SHALL issue one `write` tool call with arguments exactly `{"path":"workbuddy-report.html","content":"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n"}` instead of the bash call; the answering round is unchanged. `WORKBUDDY_TODO`: the tool round (history without a `tool` role message) SHALL issue one `todo` tool call with arguments exactly `{"op":"init","list":[{"phase":"走查","items":["整理需求","输出结论"]}]}` instead of the bash call; the answering round is unchanged. The tool round issues a single call, so when the last user text contains both `WORKBUDDY_WRITE` and `WORKBUDDY_TODO` the `write` call SHALL win and no `todo` call is issued (every request that carries `WORKBUDDY_WRITE` keeps the frames it receives today); `WORKBUDDY_TODO` combines with `WORKBUDDY_THINK` and with a gate exactly as `WORKBUDDY_WRITE` does. Real omp v18.0.10 executes that `init` on its session task list and reports `tool_execution_end` whose `result.details.phases` is `[{name:"走查",tasks:[{content:"整理需求",status:"in_progress"},{content:"输出结论",status:"pending"}]}]` (it promotes the first pending task to `in_progress`); `todo` is not an exec-tier tool, so real omp in `--approval-mode write` raises no approval for it. These two statements about real omp are derived from the pinned binary and are proven only by the ui-walk step of chat-harness `UI 走查会话元数据`, which thereby also answers whether the `todo` tool (load mode `discoverable`) is callable in RPC mode; the fixture suite proves only the frames the upstream sends. Real omp in `--approval-mode write` treats that plain-path `write` as write tier, so it raises no approval, resolves the relative path against the session's `--cwd` (the bound workspace root for a bound session), writes the file and reports the absolute `details.resolvedPath`. The error marker keeps its precedence. Requests carrying none of the three markers (nor any marker of「受控上游节奏与闸门停点标记」) SHALL receive byte-for-byte the frames they receive today (bash tool round, fixed reply, no reasoning chunk), so the existing `chat.hurl`, ui-walk journey and gate requirement are unaffected. The fixture test suite SHALL cover all three markers, their combination with a gate, the `WORKBUDDY_WRITE` precedence over `WORKBUDDY_TODO`, and the unmarked default.
`start(options)` SHALL additionally accept an optional `toolRoundScope` (#1140). Omitted or `"history"` is the rule above: a request is a tool round when its whole history holds no `tool` role message. `"turn"` SHALL make the rule per turn: a request is a tool round when no `tool` role message follows the last `user` role message, so a later turn of the same session — whose history real omp resends in full — starts with a tool round again and its `WORKBUDDY_WRITE`, `WORKBUDDY_TODO` and default bash calls are issued; once that turn's `tool` message is appended the request is the answering round. Any other value SHALL make `start()` reject without listening. The scope decides only which round a request is: the last-user-text marker lookup, the error marker's precedence, `WORKBUDDY_THINK` on the answering round, gates and the request record behave identically under both scopes, and for a history with a single `user` message the two scopes produce byte-identical frames. The option exists only on `start()`: an upstream launched as a separate process (`.github/scripts/ci-fake-upstream.sh`, `make smoke`, `make ui-walk`) always runs with the default scope, so those journeys are unaffected. The official-binary test helper SHALL pass this option through to `start()` and SHALL NOT place a history-trimming forwarder between omp and the upstream.
Because the model proxy relays the upstream SSE bytes unchanged and omp's openai-completions provider maps `delta.reasoning_content` to `thinking_start`/`thinking_delta`/`thinking_end` unconditionally on the response side (vendored `ai/src/providers/openai-completions.ts:1150-1175`, independent of the model entry's `reasoning` declaration), a `WORKBUDDY_THINK` turn through real omp yields thinking frames regardless of `MODEL_REASONING`; the fixture proves frame arrival through real omp, not the behaviour of any real model.

#### Scenario: 思考标记产生 reasoning 块
- **WHEN** a chat-completions request whose history holds a `tool` message and whose last user text contains `WORKBUDDY_THINK` is sent, with and without an armed gate for its `WORKBUDDY_UI_WALK:<uuid>` marker
- **THEN** the stream is the role chunk, three `reasoning_content` chunks concatenating to exactly `先读需求，再列要点，最后作答。`, then the unchanged content chunks, finish and `[DONE]`; with an armed gate the reasoning chunks and the first content prefix are sent before the hold and release sends the unchanged remainder exactly once

#### Scenario: 写入标记替换 bash 工具轮
- **WHEN** a request without `tool` history whose last user text contains `WORKBUDDY_WRITE` is sent, and separately the same request without the marker
- **THEN** the marked request streams one `write` tool call with the exact documented arguments and finish reason `tool_calls`, no bash call; the unmarked request streams the unchanged bash tool call

#### Scenario: 无标记请求字节不变
- **WHEN** requests without any of the three markers (and without any marker of「受控上游节奏与闸门停点标记」) are sent for the tool round and the answering round, with and without a gate
- **THEN** the frames are identical to the pre-change fixture output (no `reasoning_content` key, bash tool call, fixed reply), and every existing gate scenario passes unchanged

#### Scenario: 任务清单标记替换 bash 工具轮
- **WHEN** a request without `tool` history whose last user text contains `WORKBUDDY_TODO` is sent; separately one whose last user text contains both `WORKBUDDY_WRITE` and `WORKBUDDY_TODO`; separately a `WORKBUDDY_TODO` request whose history already holds a `tool` message
- **THEN** the first streams exactly one tool call named `todo` whose reassembled arguments are exactly `{"op":"init","list":[{"phase":"走查","items":["整理需求","输出结论"]}]}` with finish reason `tool_calls` and no bash call; the second streams the unchanged `write` tool call and no `todo` call; the third streams the unchanged fixed reply with no tool call

#### Scenario: 按回合判定工具轮
- **WHEN** an instance started with `toolRoundScope:"turn"` receives a request whose history is `user → assistant(tool_calls) → tool → assistant → user` with last user text `WORKBUDDY_TODO`; then the same history with one `tool` message appended after the last user message; then the first history with last user text `WORKBUDDY_WRITE`, and with no marker
- **THEN** the first streams exactly one `todo` tool call with the documented arguments and finish reason `tool_calls`; the second streams the unchanged fixed reply with no tool call; the third and fourth stream the documented `write` call and the unchanged bash call
- **WHEN** the same first history is sent to an instance started without the option, and to one started with `toolRoundScope:"history"`
- **THEN** both stream the unchanged fixed reply with no tool call (the whole history holds a `tool` message)
- **WHEN** under `toolRoundScope:"turn"` the last user text carries the error marker; separately `WORKBUDDY_THINK` on an answering round, with and without an armed gate; separately a single-user-message history for the tool round and the answering round
- **THEN** each response is byte-identical to what the default scope produces for the same request (apart from the generated completion id and timestamp)
- **WHEN** `start({toolRoundScope:"session"})` is called
- **THEN** it rejects and no port is bound

## ADDED Requirements

### Requirement: 受控上游节奏与闸门停点标记
受控上游 `server/test/support/fake-upstream.mjs` SHALL 另识别三个标记，查找方式与「受控上游思考与写入标记」相同（最后一条 user 文本的子串），可与该要求的标记及 `WORKBUDDY_UI_WALK:<uuid>` 组合：
- `WORKBUDDY_PACE`：答复轮（与 `WORKBUDDY_THINK` 的轮次判定相同）SHALL 在角色帧之后，先发与 `WORKBUDDY_THINK` 相同的三个 `reasoning_content` 分片（`先读需求，`、`再列要点，`、`最后作答。`），再发恰 40 个 `content` 分片，每个分片的 `content` 为一个 `字`（拼接恰为 40 个 `字`），相邻两个分片（含第一个思考分片与角色帧之间）间隔 25ms，然后是 finish 与 `[DONE]`；它取代该轮的固定答复。同带 `WORKBUDDY_THINK` 时不重复发思考分片。工具轮不受影响。带已武装闸门时 `WORKBUDDY_PACE` 被忽略（闸门行为优先，逐字节同不带 `WORKBUDDY_PACE`）。
- `WORKBUDDY_THINK_LONG`：与 `WORKBUDDY_THINK` 同一轮次、同一位置，但三个 `reasoning_content` 分片合起来恰为 120 行：第 k 片（k=1,2,3）为 `思考第 40(k−1)+1 行` 到 `思考第 40k 行` 这 40 行，行间以 `\n` 分隔，第 1、2 片各以 `\n` 结尾（拼接为 `思考第 1 行\n…\n思考第 120 行`）。同带 `WORKBUDDY_THINK` 时以 `WORKBUDDY_THINK_LONG` 为准（只发长思考）。带已武装闸门时与 `WORKBUDDY_THINK` 一样属于停住之前的前缀（或按 `WORKBUDDY_HOLD_AT` 的停点）。
- `WORKBUDDY_HOLD_AT:<point>`：只在该请求带已武装闸门时生效；`<point>` 取冒号之后到下一个空白字符或文本末尾为止。`<point>` 为 `empty` 时，停住之前只发角色帧，思考分片（带 `WORKBUDDY_THINK` 时）与全部答复分片在放行时发出；为 `thinking` 时，停住之前发角色帧与思考分片（须同带 `WORKBUDDY_THINK` 或 `WORKBUDDY_THINK_LONG`，否则同 `empty`），全部答复分片在放行时发出。取值不是这两者、或请求没有已武装闸门时，SHALL 与不带该标记逐字节相同（今天的停点：第一段答复之后）。放行与闸门的其余规则（单次放行、TTL、容量、409）不变。
不带这三个标记的请求 SHALL 与本要求之前逐字节相同。

#### Scenario: 节奏标记
- **WHEN** 一个答复轮请求的最后一条 user 文本含 `WORKBUDDY_PACE`，不带闸门
- **THEN** 流为角色帧、三个 `reasoning_content` 分片、40 个各为 `字` 的 `content` 分片、finish、`[DONE]`；相邻分片的到达间隔不小于 20ms，首末分片相隔不小于 1000ms
- **WHEN** 同一请求还带已武装闸门
- **THEN** 流与不带 `WORKBUDDY_PACE` 的闸门请求逐字节相同（生成的 id 与时间戳除外）

#### Scenario: 闸门停点
- **WHEN** 带已武装闸门的答复轮请求分别含 `WORKBUDDY_HOLD_AT:empty`；含 `WORKBUDDY_THINK` 与 `WORKBUDDY_HOLD_AT:thinking`；只含 `WORKBUDDY_HOLD_AT:thinking`（不带思考标记）；含 `WORKBUDDY_HOLD_AT:middle`；含 `WORKBUDDY_HOLD_AT:emptyX`
- **THEN** 第一例停住前只收到角色帧，放行后收到全部答复分片、finish 与 `[DONE]` 各恰一次；第二例停住前收到角色帧与三个思考分片，放行后收到全部答复分片；第三例与第一例相同（同 `empty`）；第四、五例与不带停点标记的闸门请求逐字节相同
- **WHEN** 不带闸门的请求含 `WORKBUDDY_HOLD_AT:empty`
- **THEN** 流与不带该标记逐字节相同

#### Scenario: 长思考标记
- **WHEN** 一个答复轮请求的最后一条 user 文本含 `WORKBUDDY_THINK_LONG`，不带闸门；另一例同时含 `WORKBUDDY_THINK`
- **THEN** 两例都在角色帧之后、第一个 `content` 分片之前恰发三个 `reasoning_content` 分片，拼接恰为 `思考第 1 行` 到 `思考第 120 行` 这 120 行，答复分片、finish 与 `[DONE]` 不变

#### Scenario: 官方 omp 上的合并取证
- **WHEN** `WORKBUDDY_OMP_TEST=1` 下，经官方 omp v18.0.10、model-proxy 与本受控上游，发送含 `WORKBUDDY_PACE` 的 prompt 并读取该回合发布的事件
- **THEN** `text.delta` 拼接恰为 40 个 `字` 且条数少于 40；第一条 `text.delta` 的 `delta` 恰为一个 `字`（前沿只发布第一段）；`thinking.delta` 拼接恰为 `先读需求，再列要点，最后作答。`；恰有一条 `thinking.end`，位于第一条 `text.delta` 之前；回合结束后快照该助手消息 `thinkingMs` 为非负整数
