## MODIFIED Requirements

### Requirement: 思考与文件变更事件发布
会话事件联合 SHALL 在 A 的审批事件之外包含三类经 supervisor 发布的事件：`thinking.delta{messageId,delta}`（`delta` 为非空字符串）、`thinking.end{messageId,thinkingMs}`（`thinkingMs` 为非负安全整数，见 thinking-fold「思考时长记录与下发」）与 `files.changed{messageId,stepId,files}`（`stepId` 为持久化步骤数字 id；`files` 为 1..50 个 `{path,added,removed,kind}`，`path` 为空间内相对路径）。三者 SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer、消费一个正常 `<epoch>:<seq>` id、受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:thinking.delta`/`event:thinking.end`/`event:files.changed` 投递，ring 与 SSE 端点无特殊处理。发布纪律 SHALL 为先持久化后发布：`thinking.delta` 在合并后的文本追加进 `chat_messages.thinking` 之后、在同一同步段内（中间无 await）入 ring（合并节奏见本 spec「正文与思考增量的时间窗合并」；32768 码点上限与截断标记、上限后停止发布见 thinking-fold）；`thinking.end` 在累计时长写入 `chat_messages.thinking_ms` 之后、在同一同步段内入 ring（闭段时机见 thinking-fold「思考时长记录与下发」）；`files.changed` 在 `chat_steps.changes`（JSON 数组文本）提交之后、该步骤 `step.end` 之前发布（归属判定、未绑定会话不发布、上限，见 turn-artifacts）；落库失败 SHALL 不发布对应事件且不推进 ring 序号。三类事件 SHALL 不改变 `turn.end` 的顺序约束：属于该回合者均在该回合 `turn.end` 之前发布。消息快照 SHALL 与之对应地给出消息 `thinking: string|null`、`thinkingMs: number|null` 与步骤 `changes: Change[]|null`，使只看快照的客户端与消费全部事件的客户端得到相同视图。

#### Scenario: Ordered publication after persistence
- **WHEN** a turn in a workspace-bound session publishes turn.start, merged thinking, a successful `edit` step, a successful `write` step and text, then ends
- **THEN** the ring holds, with consecutive ids, turn.start, the thinking.delta events (one or more, as coalesced) each after its text is saved, thinking.end after `thinking_ms` is saved, then for each step step.start, files.changed after the step row's `changes` commit and step.end, then text.delta and turn.end, in that order; a client reconnecting with the id preceding the first thinking.delta replays each exactly once and a snapshot taken afterwards shows the same `thinking`, `thinkingMs` and `changes`

#### Scenario: Persistence failure publishes nothing
- **WHEN** saving merged thinking, writing `thinking_ms` or committing `chat_steps.changes` fails in SQLite
- **THEN** the corresponding thinking.delta, thinking.end or files.changed never enters the ring, the ring sequence is not advanced by it, and the failure follows the existing owned error-sink path

## ADDED Requirements

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
