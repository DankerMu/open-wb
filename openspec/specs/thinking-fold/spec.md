# thinking-fold Specification

## Purpose
定义模型深度思考（reasoning）从 omp 帧到会话页折叠块的端到端契约：`thinking.delta` 事件的合并发布、`chat_messages.thinking` 的有界持久化与快照、回放、web `深度思考过程` 折叠块，以及托管 `models.yml` 声明 reasoning 与真 omp smoke 取证这一前提。纯归约器侧的帧映射见 chat-stream `纯协议事件归约`，web 侧 DTO/事件解析见 chat-web，`models.yml` 写法见 model-proxy `托管 models.yml`；本 spec 拥有它们之间的合并、上限、次序与呈现规则。

## Requirements

### Requirement: thinking.delta 合并发布与持久化
纯归约器 SHALL 把回合内（`agent_start` 之后、终态之前）助手消息的每个 `message_update{assistantMessageEvent:{type:"thinking_delta",delta}}`（`delta` 为非空字符串）映射为一条 `thinking.delta{messageId,delta}`（映射规则见 chat-stream）；`thinking_start`/`thinking_end` 帧、`message_end.message.content[]` 中的 `thinking`/`redactedThinking` 块 SHALL 不产生任何事件，也不作为 thinking 来源（只认增量帧；只在 `message_end` 给出整块思考而无增量帧的上游，其思考不落库、不呈现）。
SessionSupervisor SHALL 对同一助手消息的 thinking 增量做合并：在内存缓冲中按到达顺序拼接，在下列任一时刻把整段缓冲作为**一条** `thinking.delta` 先落库再发布（与既有「先持久化/缓冲、后入 ring」纪律一致）：缓冲累计达到 2048 UTF-8 字节；自缓冲中第一段增量起经过 2000ms（注入时钟，与 text.delta 刷盘节奏同值）；即将发布同一回合的任何其它事件（`text.delta`、`step.start`、`step.end`、`files.changed`、`approval.*`、`error`、`turn.end`）之前；回合进入终态（含 `applyFailure`/`applyStop` 退回、崩溃与优雅关停）之前。由此 ring 中 `thinking.delta` 与同回合其它事件的相对次序等于上游帧到达次序；除此之外不作任何次序保证——只有上游先于正文发送 thinking 时，`thinking.delta` 才先于该回合第一条 `text.delta`。落库失败 SHALL 不发布该条事件，并沿既有 owned error-sink 路径处理。
`chat_messages.thinking`（可空 TEXT 列，由 chat-sessions 的 035 迁移新增）SHALL 以追加方式保存该消息全部已落库 thinking：首段非空 thinking 落库前为 NULL，此后为已保存文本。某条消息是否有 thinking 只取决于上游响应是否带思考增量（omp 在响应侧无条件把 `reasoning_content`/`reasoning`/`reasoning_text` 映射为 thinking 帧），与托管 `models.yml` 的 `reasoning` 声明无关；「无 reasoning 不渲染」即上游未返回思考增量时 `thinking` 为 `null`、不渲染折叠块。保存与发布 SHALL 共享同一上限：至多 32768 个 Unicode 码点，不拆分代理对；使累计超过上限的那一次合并只保留恰好填满上限的前缀并紧接追加标记 `…（已截断）`，该次发布的 `delta` 即「保留前缀 + 标记」；此后同一消息的 thinking 增量 SHALL 既不落库也不发布（不再产生 `thinking.delta`）。累计恰为 32768 码点时不追加标记。由此实时视图与重载快照的 thinking 文本逐字相同。
`thinking.delta` SHALL 是普通 ring 事件：消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:thinking.delta` 投递，无任何特殊处理。消息快照 SHALL 为每条消息给出 `thinking: string | null`：user 消息恒为 `null`，无 reasoning 的助手消息为 `null`，否则为该列原文（含可能的截断标记）。regenerate 删除旧助手行时其 thinking 随行删除；新回合从 NULL 重新开始。

#### Scenario: 合并与落库
- **WHEN** fake-omp `thinking` 场景在 agent_start 之后连续发 `thinking_start`、三个拼接为 `先读需求，再列要点，最后作答。` 的 `thinking_delta`、`thinking_end`，随后发正文 `text_delta` 与终态 agent_end，三个增量在 2000ms 内到达且合计不足 2048 字节
- **THEN** ring 中恰有一条 `thinking.delta{messageId, delta:"先读需求，再列要点，最后作答。"}`，位于第一条 `text.delta` 之前、turn.start 之后；`thinking_start`/`thinking_end` 未产生事件；快照该助手消息 `thinking` 为该串，user 消息 `thinking` 为 `null`

#### Scenario: 字节阈值与时钟阈值
- **WHEN** 增量累计跨过 2048 UTF-8 字节，另一回合中首段增量后注入时钟推进 2000ms 且其间无其它事件
- **THEN** 前者在跨过阈值的那段增量合入后立即落库并发布一条事件；后者在 2000ms 到点时落库并发布缓冲内容；两者之后的增量进入新缓冲

#### Scenario: 其它事件前冲刷
- **WHEN** 缓冲中有未发布的 thinking 时到达同一回合的 `tool_execution_start`，另一回合中缓冲未冲刷时回合以 `turn.end stopped` 结束
- **THEN** 前者 ring 中 `thinking.delta` 紧先于该 `step.start`；后者 `thinking.delta` 先于 `turn.end`，快照中该缓冲内容已保存

#### Scenario: 上限与截断标记
- **WHEN** 一条助手消息的 thinking 增量合计 40000 码点，截断点恰落在一个星体字符（代理对）处，之后还有增量到达
- **THEN** `chat_messages.thinking` 为前 32768 码点（不含孤立代理项）加 `…（已截断）`；跨过上限的那条 `thinking.delta` 的 `delta` 为到上限为止的前缀加该标记；之后不再有该消息的 `thinking.delta`；把全部已发布 `thinking.delta` 拼接的结果与快照 `thinking` 逐字相同
- **WHEN** thinking 合计恰为 32768 码点
- **THEN** 全文保存，无标记

#### Scenario: 无 reasoning 的模型
- **WHEN** 上游只返回正文与工具调用，从未出现 `thinking_delta`
- **THEN** 无 `thinking.delta` 事件，快照中该助手消息 `thinking` 为 `null`

#### Scenario: 回放与刷新
- **WHEN** 客户端带 `thinking.delta` 之前的游标重连，另一客户端在回合 running 时无游标连接
- **THEN** 前者按序重放该 `thinking.delta` 恰一次；后者从活跃 turn.start 起的回放包含它；落库失败的 thinking 不进入 ring、不推进序号
