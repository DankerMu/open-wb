## MODIFIED Requirements

### Requirement: 相关命令 API 与回合中断
SessionRuntime SHALL 暴露两类经 `OmpProcess.request` 的相关（correlated）命令 API，均以独立 id 发送并只被 id 与 command 同时匹配的 `response` 结算（沿用「Correlated responses」规则）。
`abort()` SHALL 仅在存在活跃回合（该回合的 `prompt` 帧已成功写出，即自其派发回执 `dispatched`（见「Prompt dispatch receipt」）可兑现之时起）时返回 abort response 的 Promise，并且 SHALL 只在该回合**已开始**之后写出 `{type:"abort",id}`。「已开始」指该回合的 iterator 已收到 `agent_start`，或已收到该 prompt 报告本地完成结果的帧（`response{command:"prompt"}` 的 `data.agentInvoked===false` 或 `prompt_result{agentInvoked:false}`，与本地完成等待同一判定）。原因：真 omp v18.0.10 在回合开始前收到的 `abort` 会让仍在预处理的 prompt 静默放弃，两个 response 都为 success，此后没有该回合的任何帧，用户条目也不写入会话历史。回合已开始时调用 SHALL 立即写出该帧。派发回执已兑现而回合未开始时调用 SHALL 此刻不写帧，返回一个推迟的 Promise：在该回合开始时（处理使其开始的那一帧的同一同步段内）写出恰一帧 `abort`，并以其 response 结算；如果使其开始的帧同时结束了该回合（本地完成且无需再等待输出），SHALL 不写帧并以 `AgentUnavailableError` 拒绝；回合在开始前结束（terminal `agent_end`）、失败、其 iterator 被取消（`return()`），或其 generation 退役、子进程退出时，该 Promise SHALL 以 `AgentUnavailableError` 拒绝且不写帧；在使其开始的帧上写出之前 SHALL 重新核对同一 generation、未在退役、子进程存活，任一不满足同样拒绝。回合开始前对同一回合再次调用 `abort()` SHALL 返回同一个推迟的 Promise，不另登记、不多写帧；回合已开始后的再次调用照常各写一帧（owner 的停止去重保证至多一次，见 turn-control）。此外，没有活跃回合、`prompt` 已被调用但其帧尚未写出（仍在获取/握手）、没有存活子进程、或该回合所在 generation 正在退役时 SHALL 不写任何帧并返回 `false`，不抛错，且不影响那次仍在进行的 `prompt` 调用（其获取、握手与派发照常继续）。在该 prompt 派发回执兑现之前取得的 `false` 对 owner 的语义是"尚无已派发的回合"：owner 据此登记停止意图，并在其等待中的该 prompt 派发回执兑现后再次调用 `abort()`——此时回合已活跃，该调用 SHALL 返回 abort response 的 Promise，`abort` 帧按上文规则在该回合已开始后写出（turn-control 停止生成 REST）；owner 不得把这种 `false` 当作失败或等待崩溃路径。在派发回执已兑现之后取得的 `false`（子进程已死或 generation 正在退役）表示该回合正经失败路径收尾：owner SHALL 丢弃其停止意图，不再重试 `abort()`。runtime 不为停止意图新增任何接口。`abort` 的 response（`command:"abort"`）SHALL 只结算 abort 请求，不得结束或失败当前 prompt 的 iterator；回合是否结束仍由随后的 `agent_end` 决定。
`command(frame)` SHALL 接受 `get_branch_messages`、`branch{entryId}` 与 `get_state` 三种帧：若当前存在活跃回合 SHALL 同步抛出 `SessionBusyError` 而不写帧；若没有存活子进程 SHALL 经与 `prompt` 相同的惰性获取路径（同一 spawn 契约、握手、token、`--resume` 最后已知路径）先获取一个 generation，再发送该帧——这与 `prompt` 触发的获取是**同一种**获取：SHALL 恰调用一次 owner 提供的 `tokens.issue`，与 prompt 获取对 owner 的上报完全一致（会话进程的 owner 借此递增 `stream_epoch` 并建立该 generation 的 ring；fork 临时进程的 owner 接入不递增 epoch 的 token 适配器，runtime 契约不变）；随后在同一 generation 上的 `command`/`prompt` SHALL 复用它而不再次调用 `issue`；返回匹配 response 的 `data`。匹配 response 的 `success` 不为 `true`（例如 `branch` 的未知 `entryId`）时 SHALL 以 `AgentUnavailableError` 拒绝，且不因此回收 generation（是否 retire 由 owner 决定）。`branch` 成功后 `command({type:"get_state"})` 返回的 `sessionFile` SHALL 被视为新的 last-known-good path 供后续 `--resume`。`command` 期间 SHALL 视为活动：重置空闲计时器，且与 `prompt` 互斥（进行中的 `command` 使并发 `prompt`/`command` 抛 `SessionBusyError`）。子进程在 `command` 未结算前退出 SHALL 使该 Promise 以 `AgentUnavailableError` 拒绝并按既有路径回收 generation。`command` 在途时子进程产生协议错误（畸形行、超限行、非法 chunk 元数据）SHALL 与回合内同类错误一样回收该 generation，使该 Promise 以 `AgentUnavailableError` 拒绝，不等待空闲回收。runtime 已 `shutdown` 后调用 `command` SHALL 与 `prompt` 一样同步抛出 `AgentUnavailableError`，不写帧、不 spawn。

#### Scenario: abort during a turn ends the turn as aborted
- **WHEN** a prompt is active on the real fake (`abort-ok`) and `abort()` is called
- **THEN** exactly one `{type:"abort",id}` frame is written, the iterator then observes `message_end{stopReason:"aborted"}` and terminal `agent_end` and ends, the abort Promise resolves with the correlated `response{command:"abort"}` (which the child sends after `agent_end`, so it is not an iterator frame), and a following prompt on the same generation is accepted without a new spawn

#### Scenario: abort without an active turn is a no-op
- **WHEN** `abort()` is called on a runtime with no active turn, before any spawn or between turns
- **THEN** nothing is written to the child, no child is spawned and the call returns `false`

#### Scenario: Branch command family outside a turn
- **WHEN** an idle runtime with a persisted sessionFile receives `command(get_branch_messages)`, then `command(branch{entryId})`, then `command(get_state)` against the real fake (`branch`)
- **THEN** the child is acquired with `--resume <persisted file>`, each call resolves with the matching response data, `get_state` returns the new file created by branch, and that file becomes the `--resume` path of the next acquisition

#### Scenario: abort right after the dispatch receipt
- **WHEN** `prompt()` has been called on a runtime whose real fake is `slow-ready` (delayed `ready`, then `abort-ok` behaviour), `abort()` is called before `dispatched` resolves, and the owner calls `abort()` again as soon as `dispatched` resolves
- **THEN** the first `abort()` returns `false` and writes nothing, while the pending prompt still acquires, handshakes and writes its `prompt` frame; the second call writes exactly one `{type:"abort",id}` frame, after the `prompt` frame and not before the turn's `agent_start` has reached the runtime; the iterator observes `message_end{stopReason:"aborted"}` and terminal `agent_end` and ends, the abort Promise resolves with the correlated `response{command:"abort"}`, and a following prompt on the same generation is accepted without a new spawn or a second `issue`

#### Scenario: abort response alone does not end the turn
- **WHEN** a turn has a resolved dispatch receipt but is still waiting for a late `command_output` (real fake `slash --compact-silent`, prompt `/compact`), `abort()` is called and the child answers only `response{command:"abort"}`
- **THEN** exactly one `abort` frame is written, the abort Promise resolves with that response, the response reaches the iterator as an ordinary frame of the still-active turn without ending it, and the turn still ends only when the local-command grace elapses on the injected clock; a following prompt reuses the same child

#### Scenario: Command acquisition reports the generation like prompt
- **WHEN** a runtime with no live child receives `command(get_branch_messages)` and then a `prompt` on the same generation
- **THEN** the owner's `tokens.issue` is called exactly once, before the command frame is written, exactly as for a prompt-triggered acquisition; the following prompt reuses that generation without another `issue` or spawn

#### Scenario: Command during a turn or after child death
- **WHEN** `command(get_branch_messages)` is called while a prompt is active, or the child exits before the command response arrives
- **THEN** the in-turn call throws `SessionBusyError` synchronously without writing a frame; the interrupted call rejects with `AgentUnavailableError`, the generation is reclaimed and its token revoked exactly once

#### Scenario: Command failure response and closed runtime
- **WHEN** `command(branch{entryId})` names an entry the real fake (`branch`) does not know, and separately `command` is called after `shutdown()`
- **THEN** the first rejects with `AgentUnavailableError` while the generation stays current and the next `command` on it resolves without a new spawn or `issue`; the call after shutdown throws `AgentUnavailableError` synchronously, writes nothing and spawns no child

#### Scenario: abort before the turn starts is deferred to agent_start
- **WHEN** a runtime runs the real fake `abort-ok --start-delay-ms 200` (the held turn opens 200ms after the prompt ack) and `abort()` is called as soon as `dispatched` resolves; separately `slow-ready --ready-delay-ms 300 --start-delay-ms 200` where the first `abort()` precedes the receipt and a second follows it
- **THEN** the call after the receipt returns a Promise and no `abort` frame is written until the turn's `agent_start` reaches the runtime; then exactly one `abort` frame is written after the `prompt` frame, the iterator observes `agent_start`, the two deltas, `message_end{stopReason:"aborted"}` and terminal `agent_end`, the Promise resolves with the correlated `response{command:"abort"}`, and a following prompt on the same generation completes without a new spawn

#### Scenario: deferred abort is rejected when the turn never starts
- **WHEN** `abort()` is deferred after the receipt and the turn then ends without starting: the real fake `crash` exits after its prompt ack, or the real fake `slash` answers `/todo` with its output and a local completion response that ends the turn
- **THEN** no `abort` frame is written; the Promise rejects with `AgentUnavailableError`; the iterator ends through its existing failure or completion path; after `/todo` the next prompt reuses the same child

#### Scenario: local completion that awaits output opens the deferred abort
- **WHEN** `abort()` is deferred after the receipt of `/compact` on the real fake `slash --compact-silent`, and the local completion response arrives while the turn keeps waiting for a late `command_output`
- **THEN** exactly one `abort` frame is written as that response is processed, the Promise resolves with the abort response, and the turn still ends only when the local-command grace elapses on the injected clock
