# Spec: thinking-fold

## Purpose
定义模型深度思考（reasoning）从 omp 帧到会话页折叠块的端到端契约：`thinking.delta` 事件的合并发布、`chat_messages.thinking` 的有界持久化与快照、回放、web `深度思考过程` 折叠块，以及托管 `models.yml` 声明 reasoning 与真 omp smoke 取证这一前提。纯归约器侧的帧映射见 chat-stream `纯协议事件归约`，web 侧 DTO/事件解析见 chat-web，`models.yml` 写法见 model-proxy `托管 models.yml`；本 spec 拥有它们之间的合并、上限、次序与呈现规则。

## ADDED Requirements

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

### Requirement: 深度思考折叠块呈现
会话页 SHALL 在助手消息内、所有其它消息内容（审批条、正文）之前渲染深度思考折叠块：`<details class="thinking-block">`，`<summary>` 可见文本 `深度思考过程`（前置装饰性 `Icon chevron-right`），主体为 thinking 原文，以纯文本呈现（`white-space: pre-wrap`，不经 Markdown 渲染、不注入 HTML）。`thinking` 为 `null` 或空串时 SHALL 不渲染该块。折叠态：消息 status 为 `running` 时展开（`open`），消息进入任一终态（`done|failed|stopped`）时收起；从快照打开一条已终态消息时为收起；两次状态迁移之间用户手动展开/收起的选择 SHALL 保留，不被随后到达的 `thinking.delta` 或其它事件重置。截断标记 `…（已截断）` 作为原文的一部分逐字显示。流式期间主体随 `thinking.delta` 增长；折叠块不参与对话内搜索（见 conversation-search）与复制（`复制` 仍只复制正文）。

#### Scenario: 流式展开、终态收起
- **WHEN** running 助手消息先收到 `thinking.delta{delta:"先想一想"}`，再收到正文 delta 与 `turn.end done`
- **THEN** 折叠块在正文之前出现、`summary` 文本为 `深度思考过程`、处于展开态且主体为 `先想一想`；`turn.end done` 后折叠块收起、主体文本不变，正文与 `复制` 按钮行为不变

#### Scenario: 快照中的思考与截断标记
- **WHEN** 以 `/?session=<id>` 加载快照：一条 done 助手消息 `thinking` 以 `…（已截断）` 结尾，另一条 `thinking` 为 `null`，还有一条 `thinking` 为空串
- **THEN** 第一条渲染收起的折叠块，展开后主体末尾逐字显示 `…（已截断）`；后两条不渲染折叠块

#### Scenario: 用户手动切换保留
- **WHEN** running 期间用户收起折叠块，随后又到达两条 `thinking.delta`
- **THEN** 折叠块保持收起，展开后主体包含新增文本

### Requirement: reasoning 前提与真运行时取证
托管 `models.yml` SHALL 在 `MODEL_REASONING` 为 `on`（缺省）时为唯一模型条目声明 `reasoning: true` 与 `compat.reasoningContentField: reasoning_content`，`off` 时两者皆省略（写法与确定性见 model-proxy `托管 models.yml`；环境变量到写入选项的映射由装配层 `server/src/agent-config.ts` 负责，`on|off` 之外的取值（含空串）SHALL 在启动时拒绝）。该声明面向真实模型：它让 omp 把模型视为 reasoning 模型（请求思考、并在回放历史助手轮次时按 `reasoningContentField` 写回思考字段，DeepSeek 类上游校验历史 `reasoning_content`）；omp openai-completions 对响应中 `delta.reasoning_content` 的解析本身不依赖该声明。
真运行时取证 SHALL 走「真 omp v18.0.10 → model-proxy → 受控假上游 `server/test/support/fake-upstream.mjs`」链路：假上游在最后一条 user 文本含 `WORKBUDDY_THINK` 标记时，于正文轮先发三个 `reasoning_content` 分片（拼接恰为 `先读需求，再列要点，最后作答。`）再发不变的正文分片，无标记请求逐字节不变（见 omp-test-harness `受控上游思考与写入标记`）。`server/test/support/fake-omp.mjs` 的代理中继只读 `delta.content`/`delta.tool_calls`，不在该链路上，SHALL 不承担此取证；fake-omp 的 `thinking` 场景（直接发 `thinking_start/delta/end` 帧，归 omp-test-harness）只服务服务端集成测试。`make smoke` SHALL 不论 `MODEL_REASONING` 取值，以含该标记的 prompt 断言回合快照助手消息 `thinking` 恰为 `先读需求，再列要点，最后作答。`（三分片在 2000ms 内到达且不足 2048 字节，合并后逐字相同）；该断言位于只由 `make smoke` 运行的 `smoke/session-meta.hurl`（chat-harness `会话元数据 HTTP 冒烟`），`make smoke-live` 与 `smoke/chat.hurl` 不断言 thinking（真实上游是否返回 reasoning 属 grill 未决项 1，返回 `null` 时「不渲染」成立）。该取证证明思考帧经真 omp 到达、落库与快照，不证明 `MODEL_REASONING` 开关对真实模型的效果。

#### Scenario: 真 omp 帧到达
- **WHEN** CI smoke 以真 omp v18.0.10、`MODEL_REASONING` 缺省与受控假上游运行 `make smoke`，`smoke/session-meta.hurl` 发送含 `WORKBUDDY_THINK` 的 prompt
- **THEN** 回合结束后快照助手消息 `thinking` 恰为 `先读需求，再列要点，最后作答。`，正文仍恰为 `你好，这是 WorkBuddy 的第一条流式回复。`；`smoke/chat.hurl` 既有断言不变（该文件不断言 `thinking`）；「上游未返回思考增量 → `thinking` 为 `null`」由服务端集成测试以不含 thinking 帧的 fake 场景（如 A 的 `abort-ok`）证明

#### Scenario: 关闭 reasoning
- **WHEN** 以 `MODEL_REASONING=off` 启动，托管 `models.yml` 被写出
- **THEN** 模型条目无 `reasoning` 与 `compat` 键，文件与本 change 之前的托管输出逐字节相同；以 `MODEL_REASONING=maybe` 或空串启动时进程在写 `models.yml` 之前以配置错误退出（错误信息含变量名）
