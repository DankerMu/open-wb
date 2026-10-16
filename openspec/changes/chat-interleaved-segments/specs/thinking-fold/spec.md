## MODIFIED Requirements

### Requirement: 深度思考折叠块呈现
会话页 SHALL 为助手消息的每个思考段渲染一个深度思考折叠块，位于该段在分段区中的位置（chat-web「助手消息分段」：分段布局下每段思考各在它发生的位置，同一消息可有多个折叠块；旧布局下整条消息的 `thinking` 是一个折叠块，位于所有其它消息内容之前）。每个折叠块是一个可展开/收起的折叠块，其展开/收起控件带前置装饰性图标与一个标题，并以 `aria-expanded` 反映折叠态，主体为该段的思考原文（旧布局下为整条 thinking），以纯文本呈现（`white-space: pre-wrap`，不经 Markdown 渲染、不注入 HTML）。原文为空串的段与 `thinking` 为 `null` 或空串的旧布局消息 SHALL 不渲染折叠块。
标题（即控件的可见文本，也是其可访问名）SHALL 取以下三者之一（判定所用的视图字段见 chat-web「纯会话视图归约」；分段布局下「进行中」与「时长」取该段的——进行中按 chat-web「助手消息分段」的定义，时长为该段的 `thinkingMs`；旧布局下取消息的 `thinkingActive` 与 `thinkingMs`）：进行中（旧布局：消息 running 且 `thinkingActive` 为 `true`）时为 `正在思考…`，并带流光（`prefers-reduced-motion: reduce` 下流光动画暂停，与既有做法一致）；否则时长不为 `null` 时为 `已思考 N 秒`，N 为 `max(1, round(时长 ÷ 1000))`，不带流光；否则为 `深度思考过程`，不带流光。由此（分段布局）：一段思考进行中，它的折叠块为 `正在思考…`；这段思考结束后它的折叠块为 `已思考 N 秒`（N 只算这一段），此后它不再变化；再次进入思考时在新位置出现一个新的折叠块，从 `正在思考…` 开始。旧布局：思考中为 `正在思考…`，一段思考结束后为按消息累计时长的 `已思考 N 秒`，再次进入思考时回到 `正在思考…`。没有时长数据的段或消息（#910 之前的历史消息、从未闭段即中断的段）为 `深度思考过程`。
折叠态（每个折叠块各自按以下规则，互不影响）：
- **旧布局**（#910 的规则，不变）：消息 status 为 `running` 时展开，消息由 `running` 进入任一终态（`done|failed|stopped`）时收起；从快照打开一条已终态消息时为收起，从快照打开一条 running 消息时为展开。
- **分段布局**（owner 2026-10-15 B12：只展开正在思考的那一段）：一个折叠块的状态迁移是它那一段在「进行中」与「不在进行中」之间的变化（进行中的定义见 chat-web「助手消息分段」）。该段进行中时展开；该段结束时收起——该段的 `thinking.end` 到达、消息进入任一终态、或快照原地重装后该段不再进行中，三者先到者——不等整条消息结束。由于一段思考在任何可见的正文、步骤或审批出现之前就已闭合（chat-stream「分段位置的记录与下发」的闭段），一段思考之后正文或工具开始时，这段思考的折叠块已经收起。折叠块首次出现时（实时到达或从快照打开），按该段此刻是否进行中决定展开或收起。整条消息进入终态不是已结束的段的状态迁移：它们保持当时的折叠态。

两种布局下，两次状态迁移之间用户手动展开/收起的选择 SHALL 保留，不被随后到达的 `thinking.delta`、`thinking.end`（分段布局下另一段的）、其它事件或同状态的快照重新同步重置。截断标记 `…（已截断）` 作为原文的一部分逐字显示。
主体 SHALL 在两种状态下都限高 `12rem` 并在盒内滚动（`overflow: auto`，与步骤卡 `原始输出` 一致）。旧布局下消息 status 为 `running` 时、分段布局下只有进行中的那一段（其余段即使消息仍在 running 也不算），折叠块根元素带 `data-running` 属性，且展开着的主体为流式预览：主体内容增长时盒内 SHALL 自动滚到最新一行；用户在盒内向上滚动后暂停自动滚动，滚回盒底后恢复；预览不锁定、不改变转录区的滚动位置，转录区的贴底跟随与 `回到最新` 按 chat-web「消息线程」的规则照常工作。终态消息的折叠块与分段布局下已结束的段的折叠块不带 `data-running`，主体不自动滚动；因此贴底时手动展开一条终态消息的折叠块，转录区跟随位移不超过主体限高加其上外边距。主体 SHALL 不渲染遮盖内容的渐隐层。
运行中（分段布局下指该段进行中）且非减少动态效果时，主体显示的文本 SHALL 按 chat-web「消息线程」正文逐字展开的同一规则展开；消息进入终态（分段布局下该段结束）时立即显示全文；`prefers-reduced-motion: reduce` 下不逐字展开。折叠块不参与复制（`复制` 仍只复制正文）。

#### Scenario: 流式展开、终态收起
- **WHEN** running 助手消息（正文、思考为空，分段布局）先收到 `thinking.delta{delta:"先想一想"}`，再收到 `thinking.end{thinkingMs:1400, segment:{bodyOffset:0,thinkingOffset:0,thinkingLength:4,stepsBefore:0,thinkingMs:1400}}`、正文 delta 与 `turn.end done`
- **THEN** 折叠块在正文之前出现、处于展开态、带 `data-running`，标题为 `正在思考…` 且带流光，主体为 `先想一想`；`thinking.end` 后标题为 `已思考 1 秒` 且不带流光，折叠块立即收起、不带 `data-running`（不等 `turn.end`）；正文到达与 `turn.end done` 后折叠块仍收起、标题不变，再展开时主体文本不变，正文与 `复制` 按钮行为不变
- **WHEN** 以快照打开一条 running 助手消息（旧布局：`thinking` 为 `先想一想`、`thinkingSegments` 为 `[]`），随后到达 `thinking.end{thinkingMs:1400, …}`、正文 delta 与 `turn.end done`
- **THEN** 折叠块一直展开到 `turn.end done` 才收起（#910 的规则），`thinking.end` 后标题为 `已思考 1 秒`

#### Scenario: 标题三态与多段思考
- **WHEN** running 助手消息依次收到 `thinking.delta(先)`、`thinking.end{thinkingMs:400, segment:{bodyOffset:0,thinkingOffset:0,thinkingLength:1,stepsBefore:0,thinkingMs:400}}`、`step.start(bodyOffset 0)`、`thinking.delta(想)`、`thinking.end{thinkingMs:2600, segment:{bodyOffset:0,thinkingOffset:1,thinkingLength:1,stepsBefore:1,thinkingMs:2200}}`、`turn.end done`
- **THEN** 消息内依次为第一个折叠块、工具段、第二个折叠块；第一个折叠块的标题依次为 `正在思考…`、`已思考 1 秒`（400ms 按至少 1 秒显示），此后不再变化；第二个折叠块在第二条 `thinking.delta` 时出现，标题依次为 `正在思考…`、`已思考 2 秒`（只算第二段的 2200ms），终态后两个标题不变；每个折叠块在自己那一段进行中时展开、在自己的 `thinking.end` 时收起，所以任何时刻至多一个折叠块是展开的
- **WHEN** 以 `/?session=<id>` 加载快照（旧布局：`thinkingSegments` 为 `[]`）：一条 done 助手消息 `thinking` 非空、`thinkingMs` 为 `61500`；一条 done 助手消息 `thinking` 非空、`thinkingMs` 为 `null`；一条 running 助手消息 `thinking` 非空、`thinkingMs` 为 `null`
- **THEN** 三者各有一个位于正文之前的折叠块，标题依次为 `已思考 62 秒`、`深度思考过程`、`正在思考…`
- **WHEN** 以快照加载一条 failed 助手消息（分段布局），其 `thinkingSegments` 为两段：第一段 `thinkingMs` 为 1500，第二段 `thinkingLength` 与 `thinkingMs` 为 `null`（宿主进程在第二段开着时退出）
- **THEN** 两个折叠块的标题依次为 `已思考 2 秒` 与 `深度思考过程`，都不带流光

#### Scenario: 快照中的思考与截断标记
- **WHEN** 以 `/?session=<id>` 加载快照：一条 done 助手消息 `thinking` 以 `…（已截断）` 结尾，另一条 `thinking` 为 `null`，还有一条 `thinking` 为空串
- **THEN** 第一条渲染收起的折叠块，展开后主体末尾逐字显示 `…（已截断）`；后两条不渲染折叠块

#### Scenario: 用户手动切换保留
- **WHEN** running 期间用户收起折叠块，随后又到达两条 `thinking.delta` 与一条 `thinking.end`
- **THEN** 折叠块保持收起，标题按三态规则更新，展开后主体包含新增文本
- **WHEN** 分段布局下一段思考结束（其折叠块已收起）后用户展开它，随后到达正文、第二段思考（新折叠块展开）、第二段的 `thinking.end` 与 `turn.end done`
- **THEN** 第一个折叠块始终保持展开（这些都不是它的状态迁移）；第二个折叠块在其 `thinking.end` 时收起
- **WHEN** 用户展开一条 done 消息的折叠块，随后页面以一份该消息状态与思考不变、正文不同的快照重新同步
- **THEN** 正文更新为新快照的内容，折叠块保持展开

#### Scenario: 终态消息主体限高
- **WHEN** 转录贴底（距底 ≤4px），用户展开一条 done 助手消息的折叠块，其 thinking 为 120 行，点击前展开/收起控件距转录滚动容器顶不少于 198px（视口 390×844 与 1440×900）
- **THEN** 主体高度为 `12rem`（192px）且可在盒内滚动到末行；展开/收起控件仍在转录滚动容器的可视区内；转录保持贴底
- **WHEN** 转录贴底时一条 running 助手消息的 thinking（分段布局下为进行中的那一段）增长到 120 行
- **THEN** 折叠块根元素带 `data-running` 属性；主体高度为 `12rem`，盒内滚动位置在底部（`scrollTop + clientHeight` 等于 `scrollHeight`，容差 1px），最新一行可见；转录保持贴底；`turn.end` 后（分段布局下该段的 `thinking.end` 后）该属性消失
- **WHEN** 上一例中用户在主体盒内向上滚动，随后又到达若干 `thinking.delta`
- **THEN** 盒内滚动位置不再被改到底部，转录区的滚动位置不变；用户滚回盒底后，下一次增长重新贴到最新一行

#### Scenario: 思考的逐字展开
- **WHEN** 非减少动态效果下，一条 running 助手消息的折叠块展开着，收到一条 200 字的 `thinking.delta`
- **THEN** 主体显示的文本在此后的若干帧中由短到长增长，每一帧都是已收到 thinking 的前缀，在有限时间内等于已收到的全文（时长按 chat-web「正文逐字展开」的间隔规则，积压越多越快）
- **WHEN** 该消息在主体尚未显示全文时进入终态；另一例在 `prefers-reduced-motion: reduce` 下收到同一条 `thinking.delta`
- **THEN** 前者终态后立即显示全文；后者收到后立即显示全文

#### Scenario: 分段布局下只展开进行中的一段
- **WHEN** running 助手消息（分段布局）依次收到 `thinking.delta(先)`、`thinking.end`（第一段）、`text.delta(看)`、`thinking.delta(想)`
- **THEN** 此刻第一个折叠块收起、不带 `data-running`，标题为 `已思考 N 秒`；第二个折叠块展开、带 `data-running`、主体为流式预览，标题为 `正在思考…`；消息内只有第二个折叠块的主体在 DOM 中
- **WHEN** 随后到达第二段的 `thinking.end` 与 `text.delta(好)`
- **THEN** 两个折叠块都收起、都不带 `data-running`，消息仍为 running

### Requirement: 思考时长记录与下发
SessionSupervisor SHALL 用服务端注入时钟为每条助手消息记录思考时长。一段思考（span）SHALL 在 supervisor 处理该回合一条 `thinking.delta`（合并之前、按帧到达时刻）且当前没有开着的段时开始。开段之前 SHALL 先冲刷合并器（chat-stream「分段位置的记录与下发」的边界前冲刷：合并器里缓冲着的正文先发布）。开段时 supervisor SHALL 在同一事务里（同步写；写失败沿 owned error-sink 处理）把该消息的 `chat_messages.thinking_ms` 置为 NULL，并为这一段插入一行 `chat_thinking_segments`：`body_offset` 为此刻的正文已发布长度（chat-stream「分段位置的记录与下发」），`thinking_offset` 为此刻 `chat_messages.thinking` 已保存文本的 UTF-16 码元长度（含可能的截断标记；NULL 记 0），`steps_before` 为该消息此刻已开始的步骤数，`thinking_length` 与 `thinking_ms` 为 NULL。由此段开着期间快照的 `thinkingMs` 为 `null`，`thinkingSegments` 的末段 `thinkingLength` 与 `thinkingMs` 为 `null`。每一段（span）恰一行：前一段结束后即使中间没有正文、步骤或其它事件，再开的段也是新的一行，不与前一段合并。
段 SHALL 在以下两者先到者的时刻结束：(a) pump 读到同一回合的原始 `message_update{assistantMessageEvent:{type:"thinking_end"}}` 帧；(b) supervisor 即将处理同一回合的任何非 `thinking.delta` 事件（含 `text.delta`、`step.*`、`files.changed`、`approval.*`、`todo.updated`、`turn.retry`、`error`、`turn.end`，以及经 `applyFailure`/`applyStop` 合成的终态）。
段结束时 supervisor SHALL 依次：
1. 冲刷合并器；
2. 本段时长为 `max(0, 结束时刻 − 开始时刻)`（毫秒；墙钟回拨时该段记 0），累加到该消息本回合的累计值；
3. 在同一事务里把累计值（整数，`Math.round`）写入 `chat_messages.thinking_ms`，并把本段的 `thinking_length` 写为此刻 `chat_messages.thinking` 已保存文本的 UTF-16 码元长度减去该段的 `thinking_offset`、`thinking_ms` 写为本段时长（整数，`Math.round`）；
4. 在同一同步段内发布 `thinking.end{messageId, thinkingMs, segment}`（`thinkingMs` 为该累计值；`segment` 为本段那一行此刻的五个值 `{bodyOffset, thinkingOffset, thinkingLength, stepsBefore, thinkingMs}`）；
5. 在 (b) 的情形下，才处理触发闭段的事件。

`thinking_end` 帧只用作时间信号：它不产生内容，也不改变「thinking.delta 合并发布与持久化」的内容来源规则。达到 32768 码点上限后 thinking 不再发布，但段照常开始、结束与计时，照常插入与写入段行：上限之后才开始的段 `thinking_length` 为 0（chat-web「助手消息分段」不为它渲染折叠块），跨过上限的那一段的长度含截断标记。段的偏移与长度一律按已保存文本的 UTF-16 码元计，不按上限所用的码点计，所以截断不会使段与 `thinking` 字符串错位。被停止或失败的回合（含 omp 子进程崩溃经 `applyFailure` 的退回），若段仍开着，在其 `turn.end`（或 `error`）之前结束，即按回合结束时刻计。
`thinking.end` SHALL 是普通 ring 事件（同 `thinking.delta` 的规则），先落库后发布；写库失败 SHALL 不发布该事件并沿 owned error-sink 处理。slot 因基础设施故障退役、或 WorkBuddy 服务端（宿主）进程在段开着时退出时，该段 SHALL 不补写：开段时已置 NULL，所以该消息的 `thinking_ms` 为 NULL，该段行的 `thinking_length` 与 `thinking_ms` 也保持 NULL，标题为 `深度思考过程`。启动对账不写 `thinking_ms`，也不写段行。
消息快照 SHALL 为每条消息给出 `thinkingMs: number | null`：user 消息恒为 `null`；助手消息为 `thinking_ms` 列值（NULL 为 `null`）。快照的消息形状见 chat-sessions「会话 REST」。消息快照 SHALL 同时给出该消息的 `thinkingSegments`（形状见 chat-sessions「会话 REST」）。fork 拷贝助手行时 `thinking_ms` 随行拷贝，其段行逐值拷贝（turn-control「从此处分叉 REST」）；regenerate 删除旧助手行、撤回删除消息时，段行随外键级联删除；新回合的助手行从 NULL、没有段行开始。

#### Scenario: 单段思考以 thinking_end 闭合
- **WHEN** 注入时钟下，一回合在 t=1000ms 到达首段 thinking，t=1100ms、t=1300ms 再到达两段，t=3000ms 到达 `thinking_end` 帧，t=3400ms 到达第一段正文，随后 agent_end
- **THEN** 三段 thinking 按 250ms 时间窗在 t=1000ms、t=1250ms、t=1500ms 各发布一条 `thinking.delta`；t=3000ms 时 ring 中追加 `thinking.end{thinkingMs:2000, segment:{bodyOffset:0,thinkingOffset:0,thinkingLength:L,stepsBefore:0,thinkingMs:2000}}`（L 为三段 thinking 的 UTF-16 总长；此刻合并器若仍缓冲着思考，先冲刷出该 `thinking.delta`），第一条 `text.delta` 在其后；`chat_messages.thinking_ms` 为 2000；快照该助手消息 `thinkingMs` 为 2000、`thinkingSegments` 恰为那一段，user 消息为 `null` 与 `[]`

#### Scenario: 工具参数的生成不计入
- **WHEN** 一回合思考从 t=0 到 t=500ms，t=500ms 到达 `thinking_end`，随后模型流式生成工具参数（toolcall 帧，被归约器丢弃）直到 t=9000ms 到达该工具的 `tool_execution_start`
- **THEN** `thinking.end{thinkingMs:500}` 在 t=500ms 发布，早于 `step.start`；`thinking_ms` 为 500

#### Scenario: 没有 thinking_end 时以下一事件闭合
- **WHEN** 一回合思考从 t=0 开始，从未到达 `thinking_end`，t=800ms 到达第一段正文
- **THEN** `thinking.end{thinkingMs:800}` 紧先于第一条 `text.delta`

#### Scenario: 多段思考累计
- **WHEN** 一回合依次为：思考 500ms 后 `thinking_end` → 工具执行 3000ms → 思考 700ms 后 `thinking_end` → 正文 → agent_end；第二段思考进行中读取一次快照
- **THEN** 恰有两条 `thinking.end`，`thinkingMs` 依次为 500 与 1200，`segment.thinkingMs` 依次为 500 与 700，第二段的 `stepsBefore` 为 1、`thinkingOffset` 等于第一段的 `thinkingLength`；工具执行的 3000ms 不计入；第二段进行中的快照 `thinkingMs` 为 `null`、`thinkingSegments` 为两段且第二段 `thinkingLength` 与 `thinkingMs` 为 `null`；回合结束后快照 `thinkingMs` 为 1200，`thinkingSegments` 与两条 `thinking.end` 的 `segment` 逐值相同

#### Scenario: 停止与失败
- **WHEN** 一回合思考进行中（未收到 `thinking_end`）用户停止生成，该回合在其首段思考开始后 900ms 以 `turn.end stopped` 结束；另一回合思考进行中 omp 子进程崩溃，该回合在首段思考开始后 600ms 以 error 与 `turn.end failed` 结束
- **THEN** 前者 `thinking.end{thinkingMs:900}` 在 `turn.end` 之前；后者 `thinking.end{thinkingMs:600}` 在 error 之前；两者 `thinking_ms` 分别为 900 与 600

#### Scenario: 中断后无法恢复
- **WHEN** 一回合在开着的第一段思考中宿主进程被杀；另一回合第一段已闭合（`thinking_ms` 为 500）、在开着的第二段中宿主进程被杀；重启后启动对账把两条消息置为 failed
- **THEN** 两条消息的 `thinking_ms` 都为 NULL，快照 `thinkingMs` 为 `null`，没有补发的 `thinking.end`；第一条消息的唯一段行、第二条消息的第二段行 `thinking_length` 与 `thinking_ms` 为 NULL，第二条消息的第一段行仍为 500ms

#### Scenario: 墙钟回拨
- **WHEN** 注入时钟在一段思考开始后回拨 5000ms，随后到达 `thinking_end`
- **THEN** 该段记 0，`thinking.end` 的 `thinkingMs` 为此前的累计值（首段时为 0），`thinking_ms` 不为负数

#### Scenario: 写库失败
- **WHEN** 闭段时写 `thinking_ms` 在 SQLite 中失败
- **THEN** 该 `thinking.end` 不进入 ring、不推进序号，失败沿既有 owned error-sink 路径处理

#### Scenario: 相邻的两段不合并
- **WHEN** 一回合思考 300ms 后到达 `thinking_end`，紧接着（中间没有正文、步骤或其它事件）又开始一段思考，400ms 后到达第一段正文
- **THEN** 恰有两条 `thinking.end`，`segment` 分别为两行：`bodyOffset` 都为 0、`stepsBefore` 都为 0，`thinkingMs` 依次为 300 与 400；快照 `thinkingSegments` 为这两段

#### Scenario: 上限之后的段
- **WHEN** 一回合第一段思考的增量跨过 32768 码点上限，结束后执行一个工具，随后第二段思考的增量全部在上限之后到达
- **THEN** 第一段的 `thinkingLength` 等于已保存 `thinking` 的 UTF-16 长度（含截断标记）；第二段没有 `thinking.delta`，其 `thinking.end` 照常发布，`segment.thinkingOffset` 等于已保存 `thinking` 的长度、`thinkingLength` 为 0、`thinkingMs` 为该段时长

