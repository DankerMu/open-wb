## MODIFIED Requirements

### Requirement: thinking.delta 合并发布与持久化
纯归约器 SHALL 把回合内（`agent_start` 之后、终态之前）助手消息的每个 `message_update{assistantMessageEvent:{type:"thinking_delta",delta}}`（`delta` 为非空字符串）映射为一条 `thinking.delta{messageId,delta}`（映射规则见 chat-stream）；`thinking_start`/`thinking_end` 帧、`message_end.message.content[]` 中的 `thinking`/`redactedThinking` 块 SHALL 不经纯归约器产生任何事件，也不作为 thinking 内容来源（只认增量帧；只在 `message_end` 给出整块思考而无增量帧的上游，其思考不落库、不呈现）；`thinking_end` 帧的到达时刻只由 supervisor 用作一段思考的结束信号（「思考时长记录与下发」）。
SessionSupervisor SHALL 用 chat-stream「正文与思考增量的时间窗合并」定义的合并器合并同一助手消息的 thinking 增量（空闲后的首段立即发布，之后每 250ms 至多一条，即将发布同一回合的任何其它事件之前与回合进入终态之前立即冲刷；不设字节阈值）。合并器每发布一条 `thinking.delta`，SHALL 先把该条的文本追加进 `chat_messages.thinking`，再在同一同步段内（中间无 await）入 ring（与既有「先持久化/缓冲、后入 ring」纪律一致）。由此 ring 中 `thinking.delta` 与同回合其它事件的相对次序等于上游帧到达次序；除此之外不作任何次序保证——只有上游先于正文发送 thinking 时，`thinking.delta` 才先于该回合第一条 `text.delta`。落库失败 SHALL 不发布该条事件，并沿既有 owned error-sink 路径处理；slot 因基础设施故障退役时合并器里尚未发布的 thinking SHALL 被丢弃（不落库、不发布）。
`chat_messages.thinking`（可空 TEXT 列，由 chat-sessions 的 035 迁移新增）SHALL 以追加方式保存该消息全部已发布 thinking：首段非空 thinking 落库前为 NULL，此后为已保存文本。某条消息是否有 thinking 只取决于上游响应是否带思考增量（omp 在响应侧无条件把 `reasoning_content`/`reasoning`/`reasoning_text` 映射为 thinking 帧），与托管 `models.yml` 的 `reasoning` 声明无关；「无 reasoning 不渲染」即上游未返回思考增量时 `thinking` 为 `null`、不渲染折叠块。保存与发布 SHALL 共享同一上限：至多 32768 个 Unicode 码点，不拆分代理对；使累计超过上限的那一次发布只保留恰好填满上限的前缀并紧接追加标记 `…（已截断）`，该次发布的 `delta` 即「保留前缀 + 标记」；此后同一消息的 thinking 增量 SHALL 既不落库也不发布（不再产生 `thinking.delta`）。累计恰为 32768 码点时不追加标记。由此实时视图与重载快照的 thinking 文本逐字相同。
`thinking.delta` SHALL 是普通 ring 事件：消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:thinking.delta` 投递，无任何特殊处理。消息快照 SHALL 为每条消息给出 `thinking: string | null`：user 消息恒为 `null`，无 reasoning 的助手消息为 `null`，否则为该列原文（含可能的截断标记）；合并器里尚未发布的 thinking 不在快照中。regenerate 删除旧助手行时其 thinking 随行删除；新回合从 NULL 重新开始。

#### Scenario: 合并与落库
- **WHEN** fake-omp `thinking` 场景在 agent_start 之后连续发 `thinking_start`、三个拼接为 `先读需求，再列要点，最后作答。` 的 `thinking_delta`（`先读需求，`、`再列要点，`、`最后作答。`，在同一时刻到达）、`thinking_end`，随后发正文 `text_delta` 与终态 agent_end
- **THEN** ring 中恰有两条 `thinking.delta`：先 `先读需求，`（前沿立即发布），再 `再列要点，最后作答。`（`thinking_end` 到达时冲刷），其后紧接一条 `thinking.end`，三者都在 turn.start 之后、第一条 `text.delta` 之前；`thinking_start` 未产生事件，`thinking_end` 只触发闭段；快照该助手消息 `thinking` 为 `先读需求，再列要点，最后作答。`，user 消息 `thinking` 为 `null`

#### Scenario: 字节阈值与时钟阈值
- **WHEN** 注入时钟下一回合的首段 thinking 增量在 t=0 到达，其后在 t=90、180、270、360、450ms 各到达一段，其间无其它事件，t=600ms 回合结束
- **THEN** 恰有三条 `thinking.delta`：t=0 发布首段；t=250ms 到点发布 t=90 与 t=180 两段合成的一条；t=500ms 到点发布 t=270、360、450 三段合成的一条；每条都先落库再发布；全部 `thinking.delta` 拼接与快照 `thinking` 逐字相同
- **WHEN** 一段增量到达时，该消息上一次发布 `thinking.delta` 已过去至少 250ms 且合并器为空
- **THEN** 该段立即发布，不等待
- **WHEN** 首段发布后 100ms 内合计到达 6000 UTF-8 字节的增量，其间无其它事件
- **THEN** 不因字节数提前发布（不设字节阈值）：这些增量在首段之后 250ms 到点时合成一条落库并发布

#### Scenario: 其它事件前冲刷
- **WHEN** 合并器中有未发布的 thinking、且该段思考尚未收到 `thinking_end` 帧时，到达同一回合一个不需要审批的工具的 `tool_execution_start`；另一回合中合并器未冲刷时回合以 `turn.end stopped` 结束
- **THEN** 前者 ring 中依次为该 `thinking.delta`、`thinking.end`、该 `step.start`，三者相邻；后者 `thinking.delta` 与 `thinking.end` 先于 `turn.end`，快照中该段内容已保存

#### Scenario: 上限与截断标记
- **WHEN** 一条助手消息的 thinking 增量合计 40000 码点，截断点恰落在一个星体字符（代理对）处，之后还有增量到达
- **THEN** `chat_messages.thinking` 为前 32768 码点（不含孤立代理项）加 `…（已截断）`；跨过上限的那条 `thinking.delta` 的 `delta` 为到上限为止的前缀加该标记；之后不再有该消息的 `thinking.delta`；把全部已发布 `thinking.delta` 拼接的结果与快照 `thinking` 逐字相同
- **WHEN** 注入时钟下上例的思考在 t=0 开始，上限在 t=300ms 被跨过，此后的增量持续到 t=900ms，t=1000ms 到达 `thinking_end`
- **THEN** 该段照常在 t=1000ms 闭合，`thinking.end{thinkingMs:1000}` 照常发布（计入上限之后的时间），`thinking_ms` 为 1000
- **WHEN** thinking 合计恰为 32768 码点
- **THEN** 全文保存，无标记

#### Scenario: 无 reasoning 的模型
- **WHEN** 上游只返回正文与工具调用，从未出现 `thinking_delta`
- **THEN** 无 `thinking.delta` 与 `thinking.end` 事件，快照中该助手消息 `thinking` 与 `thinkingMs` 均为 `null`

#### Scenario: 回放与刷新
- **WHEN** 客户端带 `thinking.delta` 之前的游标重连，另一客户端在回合 running 时无游标连接
- **THEN** 前者按序重放该 `thinking.delta` 恰一次；后者从活跃 turn.start 起的回放包含它；落库失败的 thinking 不进入 ring、不推进序号
- **WHEN** 合并器中有尚未发布的 thinking 时客户端读取快照，随后该段被发布
- **THEN** 快照的 `thinking` 不含该段；随后到达的 `thinking.delta` 是快照游标的后继，客户端追加后与服务端最终的列值逐字相同，不重复

### Requirement: 深度思考折叠块呈现
会话页 SHALL 在助手消息内、所有其它消息内容之前（块次序见 chat-web `消息线程`）渲染深度思考折叠块：一个可展开/收起的折叠块，其展开/收起控件带前置装饰性图标与一个标题，并以 `aria-expanded` 反映折叠态，主体为 thinking 原文，以纯文本呈现（`white-space: pre-wrap`，不经 Markdown 渲染、不注入 HTML）。`thinking` 为 `null` 或空串时 SHALL 不渲染该块。
标题（即控件的可见文本，也是其可访问名）SHALL 取以下三者之一（判定所用的消息视图字段见 chat-web「纯会话视图归约」）：消息 running 且 `thinkingActive` 为 `true` 时为 `正在思考…`，并带流光（`prefers-reduced-motion: reduce` 下流光动画暂停，与既有做法一致）；否则 `thinkingMs` 不为 `null` 时为 `已思考 N 秒`，N 为 `max(1, round(thinkingMs ÷ 1000))`，不带流光；否则为 `深度思考过程`，不带流光。由此：思考中为 `正在思考…`；一段思考结束、正文或工具调用开始后为 `已思考 N 秒`，再次进入思考时回到 `正在思考…`；没有时长数据的消息（本 change 之前的历史消息、从未闭段即中断的消息）为 `深度思考过程`。
折叠态：消息 status 为 `running` 时展开，消息由 `running` 进入任一终态（`done|failed|stopped`）时收起；从快照打开一条已终态消息时为收起，从快照打开一条 running 消息时为展开；两次状态迁移之间用户手动展开/收起的选择 SHALL 保留，不被随后到达的 `thinking.delta`、`thinking.end`、其它事件或同状态的快照重新同步重置。截断标记 `…（已截断）` 作为原文的一部分逐字显示。
主体 SHALL 在两种状态下都限高 `12rem` 并在盒内滚动（`overflow: auto`，与步骤卡 `原始输出` 一致）。消息 status 为 `running` 时折叠块根元素带 `data-running` 属性，且展开着的主体为流式预览：主体内容增长时盒内 SHALL 自动滚到最新一行；用户在盒内向上滚动后暂停自动滚动，滚回盒底后恢复；预览不锁定、不改变转录区的滚动位置，转录区的贴底跟随与 `回到最新` 按 chat-web「消息线程」的规则照常工作。终态消息的折叠块不带 `data-running`，主体不自动滚动；因此贴底时手动展开一条终态消息的折叠块，转录区跟随位移不超过主体限高加其上外边距。主体 SHALL 不渲染遮盖内容的渐隐层。
运行中且非减少动态效果时，主体显示的文本 SHALL 按 chat-web「消息线程」正文逐字展开的同一规则展开；消息进入终态时立即显示全文；`prefers-reduced-motion: reduce` 下不逐字展开。折叠块不参与复制（`复制` 仍只复制正文）。

#### Scenario: 流式展开、终态收起
- **WHEN** running 助手消息先收到 `thinking.delta{delta:"先想一想"}`，再收到 `thinking.end{thinkingMs:1400}`、正文 delta 与 `turn.end done`
- **THEN** 折叠块在正文之前出现、处于展开态，标题为 `正在思考…` 且带流光，主体最终为 `先想一想`；`thinking.end` 后标题为 `已思考 1 秒` 且不带流光；`turn.end done` 后折叠块收起，标题仍为 `已思考 1 秒`，再展开时主体文本不变，正文与 `复制` 按钮行为不变

#### Scenario: 标题三态与多段思考
- **WHEN** running 助手消息依次收到 `thinking.delta`、`thinking.end{thinkingMs:400}`、`step.start`、`thinking.delta`、`thinking.end{thinkingMs:2600}`、`turn.end done`
- **THEN** 标题依次为 `正在思考…`、`已思考 1 秒`（400ms 按至少 1 秒显示）、`正在思考…`、`已思考 3 秒`，终态后仍为 `已思考 3 秒`
- **WHEN** 以 `/?session=<id>` 加载快照：一条 done 助手消息 `thinking` 非空、`thinkingMs` 为 `61500`；一条 done 助手消息 `thinking` 非空、`thinkingMs` 为 `null`；一条 running 助手消息 `thinking` 非空、`thinkingMs` 为 `null`
- **THEN** 三者标题依次为 `已思考 62 秒`、`深度思考过程`、`正在思考…`

#### Scenario: 快照中的思考与截断标记
- **WHEN** 以 `/?session=<id>` 加载快照：一条 done 助手消息 `thinking` 以 `…（已截断）` 结尾，另一条 `thinking` 为 `null`，还有一条 `thinking` 为空串
- **THEN** 第一条渲染收起的折叠块，展开后主体末尾逐字显示 `…（已截断）`；后两条不渲染折叠块

#### Scenario: 用户手动切换保留
- **WHEN** running 期间用户收起折叠块，随后又到达两条 `thinking.delta` 与一条 `thinking.end`
- **THEN** 折叠块保持收起，标题按三态规则更新，展开后主体包含新增文本
- **WHEN** 用户展开一条 done 消息的折叠块，随后页面以一份该消息状态与思考不变、正文不同的快照重新同步
- **THEN** 正文更新为新快照的内容，折叠块保持展开

#### Scenario: 终态消息主体限高
- **WHEN** 转录贴底（距底 ≤4px），用户展开一条 done 助手消息的折叠块，其 thinking 为 120 行，点击前展开/收起控件距转录滚动容器顶不少于 198px（视口 390×844 与 1440×900）
- **THEN** 主体高度为 `12rem`（192px）且可在盒内滚动到末行；展开/收起控件仍在转录滚动容器的可视区内；转录保持贴底
- **WHEN** 转录贴底时一条 running 助手消息的 thinking 增长到 120 行
- **THEN** 折叠块根元素带 `data-running` 属性；主体高度为 `12rem`，盒内滚动位置在底部（`scrollTop + clientHeight` 等于 `scrollHeight`，容差 1px），最新一行可见；转录保持贴底；`turn.end` 后该属性消失
- **WHEN** 上一例中用户在主体盒内向上滚动，随后又到达若干 `thinking.delta`
- **THEN** 盒内滚动位置不再被改到底部，转录区的滚动位置不变；用户滚回盒底后，下一次增长重新贴到最新一行

#### Scenario: 思考的逐字展开
- **WHEN** 非减少动态效果下，一条 running 助手消息的折叠块展开着，收到一条 200 字的 `thinking.delta`
- **THEN** 主体显示的文本在此后的若干帧中由短到长增长，每一帧都是已收到 thinking 的前缀，至多约 250ms 后等于已收到的全文
- **WHEN** 该消息在主体尚未显示全文时进入终态；另一例在 `prefers-reduced-motion: reduce` 下收到同一条 `thinking.delta`
- **THEN** 前者终态后立即显示全文；后者收到后立即显示全文

### Requirement: reasoning 前提与真运行时取证
托管 `models.yml` SHALL 在 `MODEL_REASONING` 为 `on`（缺省）时为唯一模型条目声明 `reasoning: true` 与 `compat.reasoningContentField: reasoning_content`，`off` 时两者皆省略（写法与确定性见 model-proxy `托管 models.yml`；环境变量到写入选项的映射由装配层 `server/src/agent-config.ts` 负责，`on|off` 之外的取值（含空串）SHALL 在启动时拒绝）。该声明面向真实模型：它让 omp 把模型视为 reasoning 模型（请求思考、并在回放历史助手轮次时按 `reasoningContentField` 写回思考字段，DeepSeek 类上游校验历史 `reasoning_content`）；omp openai-completions 对响应中 `delta.reasoning_content` 的解析本身不依赖该声明。
真运行时取证 SHALL 走「真 omp v18.0.10 → model-proxy → 受控假上游 `server/test/support/fake-upstream.mjs`」链路：假上游在最后一条 user 文本含 `WORKBUDDY_THINK` 标记时，于正文轮先发三个 `reasoning_content` 分片（拼接恰为 `先读需求，再列要点，最后作答。`）再发不变的正文分片，无标记请求逐字节不变（见 omp-test-harness `受控上游思考与写入标记`）。`server/test/support/fake-omp.mjs` 的代理中继只读 `delta.content`/`delta.tool_calls`，不在该链路上，SHALL 不承担此取证；fake-omp 的 `thinking` 场景（直接发 `thinking_start/delta/end` 帧，归 omp-test-harness）只服务服务端集成测试。`make smoke` SHALL 不论 `MODEL_REASONING` 取值，以含该标记的 prompt 断言回合快照助手消息 `thinking` 恰为 `先读需求，再列要点，最后作答。`（合并只改变事件的切分，已发布 `thinking.delta` 拼接后与快照逐字相同，见「thinking.delta 合并发布与持久化」）；该断言位于只由 `make smoke` 运行的 `smoke/session-meta.hurl`（chat-harness `会话元数据 HTTP 冒烟`），`make smoke-live` 与 `smoke/chat.hurl` 不断言 thinking（真实上游是否返回 reasoning 属 grill 未决项 1，返回 `null` 时「不渲染」成立）。该取证证明思考帧经真 omp 到达、落库与快照，不证明 `MODEL_REASONING` 开关对真实模型的效果。

#### Scenario: 真 omp 帧到达
- **WHEN** CI smoke 以真 omp v18.0.10、`MODEL_REASONING` 缺省与受控假上游运行 `make smoke`，`smoke/session-meta.hurl` 发送含 `WORKBUDDY_THINK` 的 prompt
- **THEN** 回合结束后快照助手消息 `thinking` 恰为 `先读需求，再列要点，最后作答。`，正文仍恰为 `你好，这是 WorkBuddy 的第一条流式回复。`；`smoke/chat.hurl` 既有断言不变（该文件不断言 `thinking`）；「上游未返回思考增量 → `thinking` 为 `null`」由服务端集成测试以不含 thinking 帧的 fake 场景（如 A 的 `abort-ok`）证明

#### Scenario: 关闭 reasoning
- **WHEN** 以 `MODEL_REASONING=off` 启动，托管 `models.yml` 被写出
- **THEN** 模型条目无 `reasoning` 与 `compat` 键，文件与本 change 之前的托管输出逐字节相同；以 `MODEL_REASONING=maybe` 或空串启动时进程在写 `models.yml` 之前以配置错误退出（错误信息含变量名）

## ADDED Requirements

### Requirement: 思考时长记录与下发
SessionSupervisor SHALL 用服务端注入时钟为每条助手消息记录思考时长。一段思考（span）SHALL 在 supervisor 处理该回合一条 `thinking.delta`（合并之前、按帧到达时刻）且当前没有开着的段时开始。开段时 supervisor SHALL 把该消息的 `chat_messages.thinking_ms` 置为 NULL（同步写；写失败沿 owned error-sink 处理）。由此段开着期间快照的 `thinkingMs` 为 `null`。
段 SHALL 在以下两者先到者的时刻结束：(a) pump 读到同一回合的原始 `message_update{assistantMessageEvent:{type:"thinking_end"}}` 帧；(b) supervisor 即将处理同一回合的任何非 `thinking.delta` 事件（含 `text.delta`、`step.*`、`files.changed`、`approval.*`、`todo.updated`、`turn.retry`、`error`、`turn.end`，以及经 `applyFailure`/`applyStop` 合成的终态）。
段结束时 supervisor SHALL 依次：
1. 冲刷合并器；
2. 把本段时长 `max(0, 结束时刻 − 开始时刻)`（毫秒；墙钟回拨时该段记 0）累加到该消息本回合的累计值；
3. 把累计值（整数，`Math.round`）写入 `chat_messages.thinking_ms`；
4. 在同一同步段内发布 `thinking.end{messageId, thinkingMs}`（`thinkingMs` 为该累计值）；
5. 在 (b) 的情形下，才处理触发闭段的事件。

`thinking_end` 帧只用作时间信号：它不产生内容，也不改变「thinking.delta 合并发布与持久化」的内容来源规则。达到 32768 码点上限后 thinking 不再发布，但段照常开始、结束与计时。被停止或失败的回合（含 omp 子进程崩溃经 `applyFailure` 的退回），若段仍开着，在其 `turn.end`（或 `error`）之前结束，即按回合结束时刻计。
`thinking.end` SHALL 是普通 ring 事件（同 `thinking.delta` 的规则），先落库后发布；写库失败 SHALL 不发布该事件并沿 owned error-sink 处理。slot 因基础设施故障退役、或 WorkBuddy 服务端（宿主）进程在段开着时退出时，该段 SHALL 不补写：开段时已置 NULL，所以该消息的 `thinking_ms` 为 NULL，标题为 `深度思考过程`。启动对账不写 `thinking_ms`。
消息快照 SHALL 为每条消息给出 `thinkingMs: number | null`：user 消息恒为 `null`；助手消息为 `thinking_ms` 列值（NULL 为 `null`）。快照的消息形状见 chat-sessions「会话 REST」。fork 拷贝助手行时 `thinking_ms` 随行拷贝；regenerate 删除旧助手行时随行删除；新回合的助手行从 NULL 开始。

#### Scenario: 单段思考以 thinking_end 闭合
- **WHEN** 注入时钟下，一回合在 t=1000ms 到达首段 thinking，t=1100ms、t=1300ms 再到达两段，t=3000ms 到达 `thinking_end` 帧，t=3400ms 到达第一段正文，随后 agent_end
- **THEN** 三段 thinking 按 250ms 时间窗在 t=1000ms、t=1250ms、t=1500ms 各发布一条 `thinking.delta`；t=3000ms 时 ring 中追加 `thinking.end{thinkingMs:2000}`（此刻合并器若仍缓冲着思考，先冲刷出该 `thinking.delta`），第一条 `text.delta` 在其后；`chat_messages.thinking_ms` 为 2000；快照该助手消息 `thinkingMs` 为 2000，user 消息为 `null`

#### Scenario: 工具参数的生成不计入
- **WHEN** 一回合思考从 t=0 到 t=500ms，t=500ms 到达 `thinking_end`，随后模型流式生成工具参数（toolcall 帧，被归约器丢弃）直到 t=9000ms 到达该工具的 `tool_execution_start`
- **THEN** `thinking.end{thinkingMs:500}` 在 t=500ms 发布，早于 `step.start`；`thinking_ms` 为 500

#### Scenario: 没有 thinking_end 时以下一事件闭合
- **WHEN** 一回合思考从 t=0 开始，从未到达 `thinking_end`，t=800ms 到达第一段正文
- **THEN** `thinking.end{thinkingMs:800}` 紧先于第一条 `text.delta`

#### Scenario: 多段思考累计
- **WHEN** 一回合依次为：思考 500ms 后 `thinking_end` → 工具执行 3000ms → 思考 700ms 后 `thinking_end` → 正文 → agent_end；第二段思考进行中读取一次快照
- **THEN** 恰有两条 `thinking.end`，`thinkingMs` 依次为 500 与 1200；工具执行的 3000ms 不计入；第二段进行中的快照 `thinkingMs` 为 `null`；回合结束后快照 `thinkingMs` 为 1200

#### Scenario: 停止与失败
- **WHEN** 一回合思考进行中（未收到 `thinking_end`）用户停止生成，该回合在其首段思考开始后 900ms 以 `turn.end stopped` 结束；另一回合思考进行中 omp 子进程崩溃，该回合在首段思考开始后 600ms 以 error 与 `turn.end failed` 结束
- **THEN** 前者 `thinking.end{thinkingMs:900}` 在 `turn.end` 之前；后者 `thinking.end{thinkingMs:600}` 在 error 之前；两者 `thinking_ms` 分别为 900 与 600

#### Scenario: 中断后无法恢复
- **WHEN** 一回合在开着的第一段思考中宿主进程被杀；另一回合第一段已闭合（`thinking_ms` 为 500）、在开着的第二段中宿主进程被杀；重启后启动对账把两条消息置为 failed
- **THEN** 两条消息的 `thinking_ms` 都为 NULL，快照 `thinkingMs` 为 `null`，没有补发的 `thinking.end`

#### Scenario: 墙钟回拨
- **WHEN** 注入时钟在一段思考开始后回拨 5000ms，随后到达 `thinking_end`
- **THEN** 该段记 0，`thinking.end` 的 `thinkingMs` 为此前的累计值（首段时为 0），`thinking_ms` 不为负数

#### Scenario: 写库失败
- **WHEN** 闭段时写 `thinking_ms` 在 SQLite 中失败
- **THEN** 该 `thinking.end` 不进入 ring、不推进序号，失败沿既有 owned error-sink 路径处理

### Requirement: 迁移 044 思考时长列
迁移 `044_chat_message_thinking_ms.sql` SHALL 在既有 runner 持有的事务内执行，回执紧随 `043` 之后追加；它 SHALL 只用一条 `ALTER TABLE chat_messages ADD COLUMN thinking_ms INTEGER` 增加一个可空、无缺省、不带 CHECK、不建索引的列，不重建表、不回填；既有列顺序、约束、索引与 `sqlite_sequence` 不变。受信迁移的计数断言随之加一。032–043 的文件 SHALL 不改。回滚应用即不再读该列，迁移本身不逆转。

#### Scenario: 新库与存量库
- **WHEN** `openDb` 打开一个新库，另打开一份持有前 043 条回执与带 thinking 的消息行的存量库副本
- **THEN** 回执里 `044` 恰出现一次且紧随 `043`；`chat_messages.thinking_ms` 存在、为 INTEGER、可空、无缺省，是最后一列；存量库每条消息的原有列值与行数不变、`thinking_ms` 读作 NULL；`PRAGMA foreign_key_check` 为空；再次打开目录不变

#### Scenario: 中途失败可重试
- **WHEN** 在一次性副本里预置已存在的 `chat_messages.thinking_ms` 列使 `044` 失败，随后移除冲突对象重试
- **THEN** 失败时没有 `044` 的回执，此前的回执与数据不变；重试时恰应用一次
