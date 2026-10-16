# Design: chat-interleaved-segments

## Context

#915 的需求与 owner 裁定见 proposal「Why」与下文「owner 的裁定」表（grill ledger B1–B13）。本节只记设计依赖的现状（读代码，`1e9dffc8`，2026-10-15）。

**正文与「已发布长度」**

- 每个回合都从一条新插入的空助手行开始：`acceptPrompt` 以 `""` 插入（`server/src/sessions/store.ts:375-378`），regenerate 换成新行（`store-branch.ts` `replaceLastAssistant`）。`turn.retry` 不清正文（`events.ts:328-336` 只发事件；web 只置重试标记，`stream.ts:180-181`）。所以一个回合内正文只增不减，偏移单调。
- 正文增量先进回合的内存 `pending`，满 2048 字节或 2000ms 才写库（`store.ts:525-546`）；快照取「已落库 + pending」（`store.ts:352`）。所以「已发布的正文长度」≠「库里 `content` 的长度」，必须在回合（`Turn`，`store.ts:247-262`、`openTurn` `:725-745`）上另记一个已发布长度。
- `appendDelta` 只在合并器发布一条 `text.delta` 的同一同步段内被调用（#910 D2，`delta-coalescer.ts:178-194`），所以 store 里看到的就是已发布的正文。

**#910 合并器与开段的次序**

- `DeltaCoalescer.route`（`delta-coalescer.ts:86-102`）对 `thinking.delta` 先调 `spans.open`（开段、写 `thinking_ms = NULL`），**然后**才在 `#take`（`:149-176`）里因换类而冲刷缓冲着的正文。所以今天开段时刻，合并器里可能还有未发布的正文。若在开段时记偏移，记下的长度会少于客户端随后收到的正文——这就是本 change 必须先修的次序（D3）。
- 非增量事件走 `route` 末尾的 `flush`（`:101`），在 `persistEvent` 之前；所以 `step.start` 持久化时合并器已空，次序不用改。

**步骤与 `toolCallId`**

- `chat_steps` 没有 tool call id 列（`032_chat_sessions.sql`、`033`、`034` 重建后的列：`id, message_id, ordinal, name, detail, status, started_at, ended_at, output, changes`）；`toolCallId → stepId` 只在 pump 的局部 `Map` 里（`supervisor.ts:606`），`ordinal` 来自 pump 的计数器（`:607-612`）。
- `startStep` 已是一个事务（`store.ts:553-585`，`runOwnedTransaction`），插入后返回新 id；`persistEvent` 的 `step.start` 分支在 `turn-control.ts:246-262`。

**思考**

- `chat_messages.thinking` 一个字符串，按 32768 **码点**截断并追加 `…（已截断）`（`store-thinking.ts:43-69`，`[...stored].length` 计码点）；`thinking_ms` 一个可空整数（迁移 044）。
- 段的开闭在 `thinking-span.ts:59-101`：开段写 NULL，闭段累加、写列、同一同步段发布 `thinking.end{messageId, thinkingMs}`。
- **闭段时机**：开着的段在三者最先发生时闭合——pump 读到原始 `thinking_end`（`supervisor.ts:623-625` 的 `endSpan`）；一条 `text.delta` 到达（`delta-coalescer.ts:93-98` 的正文分支调 `endSpan`）；任何非增量事件发布之前（`#commit` 里 `route` 末尾的 `flush`，`delta-coalescer.ts:101`；以及 `#publish` 的「先冲刷再推入」，`supervisor.ts:706-716`，审批两类事件——含 pump 之外的作答与超时路径——都走它）。`flush` 是「先 `#flushHeld` 保存并发布缓冲着的思考，再 `spans.close`」（`delta-coalescer.ts:108-110`）。所以一段思考从不跨过可见的正文、步骤或审批：它们发布之前该段已经闭合。

**确认（审批）**

- `chat_approvals` 列：`id, message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at`（`034_chat_turn_control.sql` 末段），没有指向步骤的列。`decision ∈ allow|deny|timeout`，`timeout` 即超时自动允许（`approvals.ts:200-231` 以 `timeout` 结算并向子进程回 `allow`）；停止、崩溃、关停与启动对账一律以 `deny` 结算挂起审批（tool-approval「停止与终态对挂起审批的结算」）。
- 审批请求只带工具名：`approvalRequest` 从 omp 的 select 标题 `Allow tool: <name>` 解析（`omp/ui-requests.ts:19-36`；omp 侧 `formatApprovalPrompt` 第一行即 `Allow tool: ${tool.name}`，`resource/oh-my-pi/packages/coding-agent/src/tools/approval.ts:267-268`）。`step.start` 的 `name` 是 `tool_execution_start.toolName`（`events.ts:210-236`），二者同一个名字空间。
- **审批行早于 pump 插入**：子进程 stdout 解析时就同步发出 `approval` 事件（`omp/process.ts:602-621`），运行时直接调 `ApprovalRegistry.register` 插行（`omp/runtime.ts:570-580`、`supervisor.ts:512`）；而 pump 是对帧的异步迭代，`approval.request` 要等 pump 走到 select 帧才发布（`approvals.ts:93-107`）。同一段 stdout 里排在 select 之前的 `tool_execution_start`，pump 处理它时审批行可能已经在库里。所以「按库里的行配对」会把后来的审批配给先来的步骤——配对必须按 pump 的次序（D6）。
- **select 与 start 的线上先后不是保证（2026-10-15 编排方指出，读 v18.0.10 源码复核）**：tool-approval「审批事件」写的是「真 omp v18.0.10 先发 select、再发 `tool_execution_start`」；omp 源码里的先后是反的，而线上先后取决于调度：
  - `runTool` 先 `stream.push` 出 `tool_execution_start`（`resource/oh-my-pi/packages/agent/src/agent-loop.ts:2547-2555`），再进工具的 `execute` 包装，审批 select 在包装里才发（`packages/coding-agent/src/extensibility/extensions/wrapper.ts:332`）；
  - 两种帧最终都经同一个有序的 stdout 队列写出（`packages/coding-agent/src/modes/rpc/rpc-mode.ts:716-739` 的 `writeFrames` / `output`），但路径不同：会话事件经 `session.subscribe` 扇出（`rpc-mode.ts:978-980`），扇出前要过 `#emitSessionEvent` 的扩展 emit 与 FIFO 闸（`packages/coding-agent/src/session/agent-session.ts:2188-2240`，含 `await`）；select 由 `execute` 里的 `uiContext.select` 直接 `output`（`rpc-mode.ts:545-571`）；
  - 审批路径上在 select 之前还有 `await`（`wrapper.ts:276` 的 `waitForToolApprovalPreview`，有处理器时 `:283-290` 的 `tool_approval_requested` emit）。
  所以谁先进 stdout 队列是事件循环调度的结果，不是 omp 的保证。fake-omp 与目前观察到的真 omp 回合是 select 先于 start；配对不能依赖这一点（D6）。
- **步骤开始不等作答**：无论线上谁先，`tool_execution_start` 都在作答之前推出，拒绝时 `throw new Error("Tool call denied by user: …")`（`wrapper.ts:340`），由 `runTool` 收成 `tool_execution_end{isError:true}`。所以配对时审批**通常仍是 pending**。官方二进制上已有的证据：`make smoke` 的 `smoke/chat.hurl:191-203` 断言审批挂起时 bash 步骤已在 `running`，`:219-228` 断言停止以 `deny` 结算后该步骤为 `failed`——「步骤先于作答存在」已观察到。没测过的是用户作答拒绝那一路的 `tool_execution_end{isError}` 与 select / start 的线上先后（fake-omp `approval-parallel` 的「`r2` 步骤 failed」是夹具行为，tool-approval「审批事件」），由 4.4 实测。
- 并行调用：fake-omp 下所有 select 先于所有 start（同上规格；真 omp 同样不保证）；同一批里同名工具可能有的要审批、有的不要（omp 的 `approval(args)` 按参数定档：`bash.ts:553-579` 的命令模式、`read.ts:619-625` 的 PDF/图片与 ssh 路径、`grep.ts:913-916` 的 ssh 路径）。

**快照、事件与 web**

- 快照形状在 `rest.ts:480-502`（消息十二键、步骤七键、审批六键），web 严格解析在 `web/src/lib/session-contract.ts:266-372`，事件解码在 `web/src/features/chat/stream.ts:655-720`，全部 `hasExactlyKeys`。
- **已知事件解析失败会触发重新同步**（`stream.ts:367-371` → `beginRecovery`，`:379-396`）：重新同步就是拉一次完整快照（`startLoad`，`:405-432`）。快照的严格解析失败时 `getMessages` 抛错（`web/src/lib/api-sessions.ts:164-167`），连接器 `fail` → 关闭事件流并报告（`stream.ts:526-532`），页面显示 `<错误>。请刷新页面后重试`（`use-chat-session.ts:312-319`，文案 `turn-actions.ts:16`）。所以旧解析器遇到多了字段的已知事件，不会循环，而是重新同步一次、因快照同样多了键而失败、关流报错。#910 新增的 `thinking.end` 是新类型，旧客户端按「未知事件忽略」跳过；本 change 是给既有事件加字段，没有这个余地（D8、Migration Plan）。
- web 没有按构建版本自动刷新的机制（`grep -rn "location.reload\|buildHash\|BUILD_ID" web/src` 无命中）。
- web 渲染：`runtime-convert.ts:44-48` 注释写明「数据里正文与步骤没有交错信息」，part 固定为 reasoning、text、tool-call；`message-thread.tsx:230-258` 按「思考 → 正文 → 一个工具组 → 已结算记录 → 错误 → 文件变更 → 产物 → 已停止」渲染；`tool-call-group.tsx:37-44` 失败自动展开、`:58-60` 摘要 `N 个步骤 · 末步名 状态`；`approval-card.tsx:166-228` 渲染已结算记录（`allow` → `已允许执行`、`deny` → `已拒绝执行`、`timeout` → `超时自动允许`）。
- 对话内搜索只匹配消息 `content`（`web/src/features/chat/search-match.ts:1-16`；conversation-search「对话内搜索框」：步骤 detail/output、深度思考、审批 SHALL NOT 参与）。
- 分叉拷贝在 `store-branch.ts:248-254`（消息、步骤、审批各一条 `INSERT … SELECT`，按列名逐列拷贝）；撤回删除在 `store-undo.ts:286`（`DELETE FROM chat_messages …`，子表靠外键级联，`core/db/index.ts:28` 开 `foreign_keys`）。

**文件行数（800 行硬上限，`scripts/size-guard.sh`）**：`server/src/sessions/store.ts` 791、`supervisor.ts` 776、`events.ts` 531、`rest.ts` 574、`store-approvals.ts` 407、`store-branch.ts` 336；`web/src/features/chat/stream.ts` 776、`use-chat-session.ts` 790、`turn-actions.ts` 760、`message-thread.tsx` 393；`web/src/lib/session-contract.ts` 696；`server/test/session-rest.test.ts` 800；`web/e2e/ui-walk-layout.ts` 789。新逻辑进新模块，预算表见文末。

**迁移号**：已占用到 044；045 未被任何分支或打开的 PR 占用（编排方核对）。

## Goals / Non-Goals

**Goals**

- 新消息按发生次序交替显示正文段、思考段与工具段；刷新、重连、切换会话后分段与实时所见相同。
- 每段思考一个折叠、各自的时长；工具段默认收起、按动作归类计数。
- 已结算确认不再是消息里的独立卡片（配不上步骤的除外）；超时与拒绝在步骤卡上留小标记。
- 不改正文、思考的存储形态；新列可空，旧消息原样呈现。

**Non-Goals**

- **步骤卡本身的内容**：卡头图标、步骤名、状态徽章、参数摘要、`原始输出` 两块都不变，唯一的增加是确认小标记（issue 范围外第 1 条）。
- **待决确认卡的样式与交互**：位置、文案、倒计时、防误点、焦点规则都不变（issue 范围外第 2 条，B9）。
- **历史消息的回填**：迁移不回填；045 之前的消息没有位置信息，按旧布局呈现（B1、issue 范围外第 3 条）。
- **对话内搜索的行为**：匹配范围、跳转与高亮都不改（B8）；本 change 只用一条场景钉住现状在分段下仍成立。
- 把审批与步骤的配对用于作答、计时或结算（配对只是展示用的关联，D6）。
- 导出（session-sidebar「导出记录」）的格式：仍是正文原文加步骤列表，不按分段重排。
- 给工具段摘要以外的地方（侧栏、导出、通知）引入动作归类。
- omp 的 `customWireName` 等工具名改写：步骤名与审批工具名都取 omp 帧里给出的名字，本 change 不另做映射。

## Decisions

### owner 的裁定（已定，不是选项）

| # | 裁定 | 日期 | 落点 |
|---|---|---|---|
| B1 | 步骤与每段思考记录其开始时助手正文已发布的长度（偏移）；正文仍是一个字符串；新列可空；不回填；无位置信息的旧消息保持现有呈现 | 2026-10-13 Q10 | D1、D2、D5、D9 |
| B2 | #915 走完整 stage-change-pipeline | 2026-10-13 Q11 | proposal「流程记录」 |
| B3 | 在 `step.start` 时按工具名先进先出与同一消息内尚未配对的确认配对；落库为 `chat_approvals.step_id`（迁移 045） | 2026-10-15 A1 | D6 |
| B4 | 配不上步骤的已处理确认保留现有记录卡作兜底，显示在消息末尾；已配对的只在步骤卡上加小标记（超时自动允许 / 已拒绝），正常允许不加标记 | 2026-10-15 A2 | D12 |
| B5 | 每段思考折叠各显示自己的 `已思考 N 秒`；消息级累计 `thinking_ms` 保留；旧消息不变 | 2026-10-15 A3 | D4、D10 |
| B6 | 工具名 → 动作对应表：执行命令 = bash, eval；读取 = read；新建 = write；修改 = edit, ast_edit；搜索 = grep, glob, ast_grep, web_search（及别名 search, find）；其余归「其它」。单位：执行 N 条命令／读取\|新建\|修改 N 个文件／搜索 N 次／其它 N 步（按步骤计数） | 2026-10-15 A4 | D11 |
| B7 | 每个工具段一律默认收起（含失败，不再自动展开）；摘要末尾 `，N 步失败` 不着色；运行中显示进行中状态；手动展开保留规则沿用 | 2026-10-06 | D11 |
| B8 | 对话内搜索：命中内容在收起段里时的行为保持现状 | 2026-10-06 | D13、Non-Goals |
| B9 | 待决确认卡位置不变；已结算确认不再作独立记录卡（B4 兜底除外）；仍落库、随快照返回、审计照旧 | 2026-10-06 | D12、Non-Goals |
| B10 | #910 先做，#915 在其结果上设计 | 2026-10-06 | 本文 Context（#910 已合并归档） |
| B11 | 两段思考之间没有正文也没有工具调用时，仍是两个折叠，各记各的秒数，不合并 | 2026-10-15 | D4 |
| B12 | 运行中多段思考：只展开正在思考的那一段；较早的段在它结束时收起，不等整条回答结束 | 2026-10-15 | D10、D14 第 5 项 |
| B13 | 045 之前的旧消息只保留位置的旧样子；工具组用新摘要与新折叠规则，未配对的已结算确认仍是记录卡 | 2026-10-15 | D9 |

编排方 2026-10-15 的修订指令（不是 owner 裁定，按编排方决定执行）：配对与 select / start 的线上先后无关（D6）；`approval.request` 加 `stepId`（D8）；4.4 实测另记录并常驻断言被拒绝调用的线上先后。

### 起草者的技术决定

**D1 位置的形态与单位（B1，T2）。** 正文仍是 `chat_messages.content` 一个字符串，思考仍是 `chat_messages.thinking` 一个字符串。位置是「偏移」：

- 步骤：`chat_steps.body_offset` = 该步骤开始时本回合正文已发布的长度。
- 思考：每一段一行 `chat_thinking_segments`，记开段时的正文偏移 `body_offset`、这段在 thinking 字符串里的起点 `thinking_offset` 与长度 `thinking_length`、开段时已开始的步骤数 `steps_before`，以及本段毫秒 `thinking_ms`。

单位一律 **UTF-16 码元**：web 用 JavaScript 字符串的 `length` / `slice` 切，服务端用同一种 `length` 计，两边天然一致。不用字节（Buffer）也不用码点（`[...s].length`）。

`steps_before` 解决「同一偏移上先后发生的步骤与思考谁在前」：正文偏移相同（中间没有正文）时，只靠偏移排不出「思考 → 工具 → 思考」的次序；有了「开段时已开始几个步骤」，第 j 段恰排在第 `steps_before` 个步骤之前（chat-web「助手消息分段」的合并次序）。步骤自身的先后由既有 `ordinal` 给出。

放弃的方案：
- 改成按序的段列表、把正文拆成多行——违背 B1「正文仍是一个字符串」，并且要改落库、快照、复制、搜索、导出的全部读写方。
- 思考段用 JSON 列（`chat_messages.thinking_segments TEXT`）——拷贝、撤回同样省事，但开段要插一项、闭段要改末项，JSON 列就得读出整串、改、写回；独立表是「开段插一行、闭段按 id 改一行」，与 `chat_approvals` 同一个写法（D5）。
- 给步骤加「之前已开始几段思考」而不是给思考加 `steps_before`——两者等价；思考段是新表，加在新表上不动 `chat_steps` 的第二列。

**D2 正文已发布长度（事实核对后的必要补充）。** `Turn` 增加一个计数（`publishedLength`），`appendDelta` 每收到一段增量就加上 `delta.length`（码元，与 `pendingBytes` 的字节数分开），`openTurn` 置 0。它恒等于「已落库 + pending」的长度（Context），也等于客户端按序拼接已收到 `text.delta` 的长度。步骤插入与开段都从 store 里读它，不从库里读 `content`（库里少了 pending）。宿主进程崩溃会丢 pending、留下偏移：读出时偏移可能大于 `content` 的长度，切段函数把它当作 `content` 末尾（D9）。

**D3 边界前冲刷（不变量）。** 「记录任何位置边界之前，先冲刷合并器」。三种边界：

- `step.start`：今天已经满足（非增量事件先 `flush`，Context），不改。
- 开段：把 `route` 里 thinking 分支的次序改为「先冲刷缓冲着的另一类（正文）→ 再 `spans.open` → 再 `#take`」。`#take` 里的「换类先冲刷」保留（此时已无可冲）。
- 闭段：沿用 #910 的时机，不改代码——原始 `thinking_end`、一条 `text.delta`、任何非增量事件发布之前，三者先到者（Context「闭段时机」）。闭段经 `flush`：先保存并发布缓冲着的思考，再 `spans.close`；3b 在 `close` 里量 `thinking_length` = 此刻已保存 `thinking` 的长度 − `thinking_offset`，所以段长包含刚冲出的那一块。这条在 chat-stream「分段位置的记录与下发」的「闭段时长度含缓冲的思考」场景里钉住。

**段不会跨过可见内容**：因为正文到达与任何非增量事件都先闭段，一段思考开着的期间 ring 里只会有它自己的 `thinking.delta`。所以「段开着、后面已有正文或步骤」在服务端不会发生，不需要另外的处理；客户端临时段（D8）在 `thinking.end` 到达前同样不会遇到后续可见内容（`thinking.end` 先于它们发布）。D9 的「开着的段不是末段」只是对坏数据的兜底，不是正常路径。

由此每个记下的偏移都等于该边界之前 ring 中同一消息 `text.delta` 拼接的长度，实时视图在收到 `thinking.delta` 时自己算的偏移（D8）与服务端记下的相同。这一条在 chat-stream「分段位置的记录与下发」有专门场景；证据分三层（D17）。

**D4 一段思考 = 一个 span = 一行 = 一个折叠（T1，B5，B11）。** owner 2026-10-15 B11 已裁定不合并，下面的理由是起草时的推演，与裁定一致。 #910 的 span（开段到 `thinking_end` 或下一个非思考事件）就是一段思考。两个 span 之间即使没有正文、没有步骤（例如 omp 先后发两个思考块，或中间只隔了一个 `turn.retry` / `approval.request`），也是两行、两个折叠，不合并。理由：

- issue 需求 2「每段思考出现在它发生的位置，各自一个折叠」与 B5「每段思考折叠各显示自己的 `已思考 N 秒`」都以「段」为单位；span 是服务端唯一有明确边界的「段」。
- 合并就得在前一段的 `thinking.end` 已经发布之后改写它的长度与毫秒，实时与快照会在合并发生前后短暂不一致，还要一条「什么算相邻」的新规则。issue 需求 1 的「相邻合并」只针对工具调用。
- 代价：上游若真的连发两个思考块，会出现两个紧挨的折叠（Risks）。

段时长：本段 `max(0, 结束 − 开始)` 取整，写在段行；消息级 `thinking_ms` 照旧是累计值（B5「消息级累计保留」）。注入时钟给整数毫秒，所以各段之和等于消息累计；若时钟给小数，二者可差 1ms 以内，不另处理。

**上限（UTF-16 与码点）。** 32768 的上限按码点（`store-thinking.ts`），段的偏移与长度按码元——二者不冲突，因为段只记**已保存文本**的码元长度：开段时 `thinking_offset` = 已保存 `thinking` 的 `length`（含可能的截断标记），闭段时 `thinking_length` = 此刻已保存的 `length` − `thinking_offset`。截断只决定「保存了什么」，段永远量「保存下来的」，所以不会错位。跨过上限的那一段含截断标记；上限之后才开始的段长度为 0，照常计时、照常有 `thinking.end`，web 不为它渲染折叠（零长度段不渲染、也不分隔工具段，chat-web「助手消息分段」）。

**D5 迁移 045（T2）。** 一个迁移文件 `045_chat_interleaved_segments.sql`：两条 `ADD COLUMN`（`chat_steps.body_offset`、`chat_approvals.step_id`，可空、无缺省、无 CHECK、无索引，042–044 先例）加一张新表 `chat_thinking_segments`（外键 `message_id → chat_messages ON DELETE CASCADE`，非负 CHECK，`message_id` 索引）。规格见 chat-sessions「迁移 045 分段位置与确认关联」。

- `step_id` 不加外键：它只会指向同一消息的步骤，而步骤只随消息删除，消息删除同时级联删除审批行；外键不增加任何保证，还要论证 ADD COLUMN 带 REFERENCES 的约束。
- 新表要 CHECK：它是新建的，不受「ADD COLUMN 不带 CHECK」的先例约束；负数偏移会让 web 的严格解析整体拒收快照（与 #910 D3「不写负数」同理）。
- 三件事一个迁移：它们只服务这一个 change，分开没有回滚上的好处；045 只有这一个号。

**D6 确认与步骤配对（B3，T5）。** 规格见 tool-approval「确认与步骤配对」。

- **与线上先后无关（编排方 2026-10-15 修订）**：select 与 `tool_execution_start` 谁先进 stdout 不是保证（Context），所以配对在一对同名审批与步骤中**后到的一方**到达时发生。新模块 `server/src/sessions/approval-pairing.ts`（纯，每个 pump 一个，与 `toolIds` 同生命周期）持两份状态：未配对审批队列 `{requestId, tool}`、未配对的运行中步骤 `{stepId, name}`，都按 pump 读到帧的次序。
  - **步骤开始**：`persistEvent` 的 `step.start` 分支取出队列里第一个同名审批；没有就把步骤记入运行中列表。
  - **审批 select**：pump 读到被 `approvalRequest(frame, frame.id)` 认作审批的帧时，在 `publishRequest` 之前（`supervisor.ts:624-628` 同一处）查运行中列表里最早开始的同名步骤；有就配对，没有就入队。该审批的 `approval.request` 已由结算路径先发布时（作答或超时先于 pump 读到 select：`#finish` 在 `approvals.ts:234-235` 先补发 request，`:236` 删除登记；停止与终态结算的 `settled` 在 `:150-151` 同样先补发再删除），select 时不配对、只入队——否则实时视图收到的 `approval.request` 已带 `stepId: null`，与库不一致；入队后仍可在后到的 `step.start` 配上，经 `step.start.approvalId` 送达。
  - **步骤结束**：`step.end` 持久化后把该步骤移出运行中列表；已结束的步骤不再配对。
- **写的位置**：步骤开始时，`startStep`（移到 `store-segments.ts`，D16 预算）在插入步骤行的同一事务里 `UPDATE chat_approvals SET step_id = ? WHERE message_id = ? AND request_id = ? AND step_id IS NULL`，返回 `{stepId, approvalId|null}`。审批 select 时，pump 在发布 `approval.request` 之前执行同样的一条 `UPDATE`（单条语句即一个事务），提交后才发布——「先持久化后发布」。两处失败都走既有 owned error-sink，不引入新的失败方式：前者不发布 `step.start`，后者不发布 `approval.request`（回合失败，挂起审批按终态结算以 `deny` 结算）。
- **不碰作答路径**：配对只写 `step_id`。`ApprovalRegistry` 的登记、计时、作答、`#finish`、`settled`、`abandon`，store 的 `settleApproval` 与审计，`approval.resolved` 的发布，一行都不改；`approval.request` 只多一个 `stepId` 字段（切片 5，`publishRequest` 由 pump 传入），发布时机与次序不变。select 时要知道「此刻 `publishRequest` 是否会为这一帧发布 request」——即该帧的登记仍在且 `requestPublished` 为假（`publishRequest` 的判定，`approvals.ts:93-107`）；登记已被删除（结算路径已发布并删除）时答「否」。`approvals.ts` 只加这一个只读查询，与 `publishRequest` 共用同一判定，不另写一套。审批的「标记」由 web 在渲染时按当前 `decision` 算（D12），所以「先配对、后作答」与「先作答、后配对」得到同样的结果，不需要第二次写。
- **为什么不是「库里最早的未配对行」**：审批行在 stdout 解析时插入，可能早于 pump 处理排在 select 之前的 `tool_execution_start`（Context）。用 `SELECT min(id) … WHERE step_id IS NULL` 会在 pump 还没读到 select 时就把审批配出去，实时视图与 ring 次序都对不上。两份状态只认 pump 读到的帧。
- **为什么不限「已作答的」**：编排方的默认是「已作答而未配对的确认先进先出」。代码与规格表明配对时刻审批通常还没作答（Context「步骤开始不等作答」），只取已作答的会让绝大多数确认配不上。所以按 B3 的原话取「尚未配对的」，不看是否作答（编排方已接受）。
- **已知局限（B3 的启发式本身，两种线上先后下都有）**：同一批并行调用里，同名工具有的需要审批、有的不需要时（例如写模式下一个普通 `read` 与一个读 PDF 的 `read`）：select 先到时，审批配给这一批里第一个开始的同名步骤；select 后到时，审批配给此刻最早开始、仍在运行的同名步骤——都不一定是真正需要审批的那个，pump 只有工具名可比。后果只限于标记落在同一段内另一张同名步骤卡上，记录、审计与作答不受影响（Risks）。
- **被拒绝的调用（实测）**：读源码，被拒绝的调用有步骤（start 先推出、拒绝在 `execute` 里抛错、收成 `isError` 的 end）；smoke 已在官方二进制上看到「审批挂起时步骤已在运行」与「停止结算拒绝后步骤 failed」（Context），所以分支二（没有步骤）基本不会出现，但用户作答拒绝那一路还没测过。4.4 是切片 4 第一个动手的任务，先于配对代码。任务 4.4 用官方 omp v18.0.10（`var/omp/omp`，`make omp-fetch` 拉取；不用 brew 版）在产品组装的官方世界里实测：`server/test/support/omp-official-proxied.ts` 的世界默认拒绝审批，受控上游的第一个请求是 bash 工具轮（`omp-official-delta-coalescing.test.ts` 头注释），所以不用新夹具就能拒绝一次 bash；记录帧里是否出现该调用的 `tool_execution_start` / `tool_execution_end{isError:true}`、**该调用的审批 select 与 `tool_execution_start` 在帧序列里的先后**，并读库看 `chat_steps` 与 `chat_approvals.step_id`。今天没有任何官方用例断言这件事（`grep -n 'tool_execution_start\|isError' server/test/omp-official-*.ts` 只命中允许路径的 `executions`）。两种结果都是合法终态，规格不依赖它：
  - 有步骤：被拒绝的审批配上该步骤，步骤以 `failed` 结束，web 在卡上标 `已拒绝`。
  - 没有步骤：审批留在队列里直到回合结束，保持未配对，web 显示 `已拒绝执行` 兜底记录。此时若同一回合后面又有同名步骤开始，它会先配上这个被拒绝的审批（FIFO），标记错位到后一步——这是该分支下 B3 启发式的已知局限，实测后写进本节与 PR，不在本 change 里修（「待编排方确认」）。
  结果以常驻断言留在该官方用例里（取哪一支就断言哪一支；观察到的线上先后也断言，三次一致才固化），omp 升级改变行为时它先判红。线上先后的结论只记录事实，配对规则不依赖它。

**D7 分叉、撤回、重新生成（T3）。**

- **分叉**（`store-branch.ts:248-254`，`branching.ts` 只编排、不改）：步骤拷贝加 `body_offset`；新增一条按原次序拷贝 `chat_thinking_segments` 的 `INSERT … SELECT`（逐值，含 NULL）；审批拷贝的 `step_id` 用子查询重映射：取新消息里 `ordinal` 与原 `step_id` 所指步骤相同的新步骤 id（`chat_steps` 有 `UNIQUE(message_id, ordinal)`），原值 NULL 或指不到时为 NULL。三处各在引入该列的切片里改（3a、3b、4），不留「某一刀里 fork 丢数据」的窗口——#910 第一刀就漏了 fork（3c 才补上）。
- **撤回**（`store-undo.ts:286` 的 `DELETE`，`undo.ts` 只编排）：新表靠外键级联；`step_id` 在被删的审批行上随行消失。不改代码，加场景与测试（message-undo「对话原地回退」的新场景）。
- **重新生成**（`replaceLastAssistant` 删旧助手行）：同上，级联；新助手行没有段行（chat-sessions「会话 REST」regenerate 场景）。

**D8 快照、REST 与事件字段（T4）。**

- 快照/REST（`rest.ts` 与 `store.ts` 读出）：消息加 `thinkingSegments`（数组，user 恒为 `[]`）、步骤加 `bodyOffset`、审批加 `stepId`；键数由 12/7/6 变为 13/8/7（chat-sessions「会话 REST」）。`decideApproval` 的 200 同为七键。
- 事件只给既有事件加字段，不加新类型：
  - `step.start` 加 `bodyOffset`（非负整数，实时永不为 null）与 `approvalId`（此刻配上的审批 id 或 `null`），由四键变六键。实时视图据此给步骤记偏移、给审批记 `stepId`。
  - `approval.request` 加 `stepId`（在 select 时配上的步骤 id 或 `null`），由五键变六键（D6；编排方 2026-10-15 修订）。配对在哪一方后到时发生，关联就由那一方的事件送达，所以实时视图与快照的 `stepId` 总是一致。
  - `thinking.end` 加 `segment`（刚结束那一段的五个值），由两键变三键。
  - `thinking.delta` 不加字段：开段的位置由 web 在收到该段第一条 `thinking.delta` 时自己记一个临时段（偏移 = 当前正文长度，起点 = 当前 thinking 长度，`stepsBefore` = 当前步骤数）。D3 保证它等于服务端记下的值；`thinking.end` 到达时临时段被服务端的值整体取代，所以结束的段永远以服务端为准。达到上限后没有 `thinking.delta` 的段，由 `thinking.end` 直接追加。
- **同刀规则扩到事件负载**：#909/#910 的规则是「服务端快照加键与 web 解析器加键同一 PR」。本 change 的事件字段更严：旧解析器遇到多字段的 `step.start` / `approval.request` / `thinking.end` 会重新同步一次、再因快照多键而关流报错（Context），所以服务端的事件字段、快照键、REST 形状与 web 的快照解析、事件解码、归约必须在同一个 PR 合入（切片 5，atomic）。之前的服务端切片只写库、不改任何对外形状。
- **唯一的切段函数**：`web/src/features/chat/message-segments.ts` 的纯函数，输入是视图的 `content`、`thinking`、步骤与 `thinkingSegments`。实时归约出的视图与快照生成的视图形状相同，所以二者经同一个函数（chat-web「助手消息分段」「实时与快照切段一致」场景）。`runtime-convert.ts` 只把新字段放进透传；part 次序不变，注释改为「part 不承载分段，分段由 `message-segments.ts` 从透传字段算」。

**D9 旧布局判定（T6）。** 规格见 chat-web「助手消息分段」：任一步骤 `bodyOffset` 为 null、或有 thinking 而没有段、或段不自洽（起点不相接、开着的段不是末段、越界、`stepsBefore` 递减或越界）、或合并后偏移递减——整条消息走旧布局，不出现半分段。偏移大于 `content` 长度（宿主崩溃丢 pending）不判旧布局，按末尾处理。

旧布局只是**位置**旧（owner 2026-10-15 B13）：思考在顶部（一个折叠、消息级时长与标题，#910 的标题与开合规则不变）、全部正文、一个工具段；工具段本身用新的摘要与折叠规则（D11），确认用新的标记/兜底规则（D12；旧消息没有 `stepId`，所以已结算的都是记录卡）。

**D10 分段渲染。** 新模块 `web/src/features/chat/message-segments-view.tsx` 按切段结果逐块渲染：正文段 → 既有 `MessageBody`（各一个 `data-slot="message-body"`，`SmoothText` 照旧，已被隔开的正文段不再增长，所以只有最后一段会逐字展开）；思考段 → 既有 `ThinkingFold`，标题数据换成该段的时长与进行中标记；工具段 → 既有 `ToolCallGroup`，步骤换成该段的步骤。`message-thread.tsx` 只决定布局并把兜底记录、错误、文件变更、产物、徽章、操作行排在分段区之后。

- **只含空白的正文段**不渲染、不分隔工具段（两个工具调用之间模型只吐了换行时，仍是一个工具段；issue 需求 1「中间没有正文」按可见正文理解；编排方默认，待 owner 验收）。`复制` 仍取 `content` 全文，不受影响。
- **小圆点**在分段区最后一段之后：最后一段是正文段时在其 `MarkdownBody` 之后（同 #910），否则单独一行在最后一段之下；全条消息恰一个。等待指示的判据不变（「已结算审批」仍算可见块：配上的有步骤、配不上的有兜底记录，二者都可见）。
- **折叠块的开合（owner 2026-10-15 B12）**：分段布局下每个折叠块的状态迁移是它那一段的「进行中 ⇄ 不在进行中」：进行中时展开，该段结束（`thinking.end`、消息终态、或快照重装后不再进行中，先到者）时收起，不等整条消息结束；首次出现时按该段此刻是否进行中定展开或收起；手动选择保留到该段的下一次迁移；消息终态不是已结束的段的迁移。流式预览与 `data-running` 只在进行中那一段。实现：`ThinkingFold` 的开合依据由 `running`（消息）换成「该段进行中」——旧布局传消息的 running 与 `thinkingActive`，行为与 #910 相同；分段布局传该段的进行中标记。以块键（`thinkingOffset`）为身份，所以流式增长不重挂载。由于一段思考在可见内容之前就已闭合（D3），任何时刻至多一个折叠块是展开的默认态。
- **块键**：按种类加前缀——正文段 `text:<起点偏移>`，思考段 `thinking:<thinkingOffset>`，工具段 `tool:<第一个步骤 id>`。不加前缀会撞键：先思考后正文时思考段 `thinkingOffset` 与第一个正文段的起点都是 0，二者是同级元素（分段区不设包裹元素），React 的同级键会重复。流式增长与快照原地重装不改变已有块的键，所以手动展开态（D11）与折叠态保留。

**D11 工具段摘要与折叠（B6、B7，T7）。** 新纯模块 `web/src/features/chat/tool-summary.ts`：`toolAction(name)` 按 B6 的表精确匹配（区分大小写），`summarizeTools(steps)` 按表的次序拼「执行 N 条命令、读取 N 个文件…」，有失败加 `，N 步失败`，有运行中加 `，进行中`。B6 同时列了 `grep`/`search`、`glob`/`find`：omp 的 `tool_execution_start.toolName` 取别名还是正名没有实测，两者都在表里，所以不影响归类。

- **运行中的措辞**：B7 只说「显示进行中的状态」。既有的转圈图标与流光保留；文字上加 `，进行中`，使读屏也能读到（今天的摘要靠末步的 `运行中` 文案传达，新摘要没有末步名；编排方默认，待 owner 验收）。
- **折叠**：`tool-call-group.tsx` 删掉 `failedCount` 比较与自动展开（`:37-44`），`useState(false)` 之后只随点击变化。「手动展开保留规则沿用」：今天的规则是「手动选择保留到下一个新失败」，去掉自动展开后就是「保留到组件卸载」；组件以块键（第一个步骤 id）为 React key，同一工具段增长、快照原地重装都不重挂载，新回合（turn.start 清空步骤）才重挂载。
- 失败后缀不着色：它是同一个 `span` 里的文字，不另加颜色类。

**D12 已结算确认的呈现（B4、B9，T8）。** 决定值域取代码里的 `ApprovalOutcome = "allow" | "deny" | "timeout"`（`store.ts:143`）：

| 审批 | 呈现 |
|---|---|
| `stepId` 指向本消息的一个步骤，`decision` = `timeout` | 该步骤卡头 `超时自动允许` |
| 同上，`decision` = `deny`（含停止、崩溃、对账结算出的 deny） | 该步骤卡头 `已拒绝` |
| 同上，`decision` = `allow` 或 `null` | 无 |
| `stepId` 为 null 或指不到本消息步骤，`decision` 非 null | 兜底记录卡（现有组件与文案：`已允许执行` / `已拒绝执行` / `超时自动允许`），位于分段区之后、错误文本之前 |
| `decision` 为 null | 仍只在输入框上方的提问卡（不变） |

- 「消息末尾」按「分段区之后、错误文本之前」理解，即今天记录卡相对其它消息级部件的位置（旧布局下与今天完全相同；编排方默认，待 owner 验收）。
- 停止时挂起、但步骤已开始的审批：配对已发生，终态结算为 `deny`，所以该（`stopped`）步骤卡标 `已拒绝`——这是库里的事实（tool-approval 本来就以 `deny` 记），web 不区分「用户拒绝」与「停止结算」（编排方默认，待 owner 验收）。
- 标记元素 `span[data-slot="step-approval-mark"]`，在状态徽章之前，纯文本，不进徽章的可访问名（徽章名 `bash 已完成` 之类的既有定位器不受影响）。
- `approval-card.tsx` 的 `ApprovalRecords` 只多一个过滤条件（`stepId` 不指向本消息步骤）；文案与样式不变。

**D13 对话内搜索（B8，T7）。** 现状：搜索只比对 `content`，步骤与思考从不参与；正文段从不收起；命中以整条消息为单位高亮根元素、`scrollToMessage(id)` 跳到消息。所以「命中在收起的段里」在分段之后依然不会发生：命中的一定是某个正文段里的文字，它始终可见；只出现在步骤输出或思考里的词不计入匹配，跳转也不会展开任何工具段或折叠。conversation-search 不改；chat-web「工具段摘要与折叠」只加一句「搜索不改变段的展开态」与场景「对话内搜索不改变段的展开态」，把现状写成可测的断言（任务 6.4）。

**D14 被 owner 推翻的旧行为与改写规则（T9）。** 沿用 #910 的「通用纪律」第 3 种改法：既有断言钉住的正是被 owner 裁定推翻的旧行为时，改写为钉住新行为的反向断言，并在 PR 的偏离记录里引用该裁定。本 change 的封闭清单（#910 的四条仍有效，下列为新增）：

1. **工具组失败自动展开**（B7）。
2. **已结算确认的独立记录卡**（B9；B4 兜底除外——未配对的仍是记录卡，钉住它的断言不改）。
3. **新消息的块次序「思考 → 全部正文 → 工具组」**（issue 需求 1、2；旧布局的消息仍是这个次序，钉住旧布局的断言不改）。
4. **工具组摘要 `N 个步骤 · 末步名 状态`**（B6、B7）。
5. **分段布局下「运行中折叠块保持展开到消息终态」**（B12；#910 的开合规则连同「预览与 `data-running` 跟随消息 running」，对分段布局的消息被推翻，旧布局不变）。
6. **分段布局下「多段思考共用一个折叠块、标题按消息累计时长」**（B5、issue 需求 2；旧布局不变）。编排方的修订指令只列了第 5 项；第 6 项是重新 grep 时发现的同类断言（`chat-thinking-title.test.tsx:145-169`），按同一规则补入（「待编排方确认」）。

清单逐条对应的既有断言（2026-10-15 在 `1e9dffc8` 上 grep：`个步骤`、`已允许执行|已拒绝执行|超时自动允许|approval-record`、`aria-expanded` 与失败、块次序数组；第 5、6 项另 grep `thinking.delta`/`thinking.end` 驱动的 web 用例与 `reasoning-root|data-running|正在思考|已思考` 的走查步骤）。判定一条 web 用例在切片 5 之后是否成为分段布局（2026-10-15 Stage 3 复核后另 grep `message-body` 的全部取用处，补入 T6 与 `chat-tool-group.test.tsx:263`）：快照夹具补键后 `thinkingSegments` 为 `[]`、而 `thinking` 非空或有步骤 `bodyOffset` 为 `null` 的，以及在这样的快照上再到达思考事件的（临时段的 `thinkingOffset` 不为 0，不自洽），都是旧布局；从思考为空的消息起由事件驱动的，是分段布局——这时正文为空或只含空白就没有 `message-body` 元素（stopped 的占位除外），取它的断言要按清单项 3 改写。只有下表里的断言可以按第 3 种改法改写；新发现的停下来先补本表：

| 文件:行 | 钉住的旧行为 | 清单项 | 改写切片 |
|---|---|---|---|
| `web/test/chat-tool-group.test.tsx:84-133`（describe 名与「done 收起、failed 展开」用例；`:118`、`:124` 的 `aria-expanded="true"`） | 失败自动展开 | 1 | 7 |
| `web/test/chat-tool-group.test.tsx:135-178`（`:160`、`:174` 失败后展开、手动收起到下次失败） | 失败自动展开 | 1 | 7 |
| `web/test/chat-tool-group.test.tsx:108`、`:111`、`:125`、`:150`、`:175`、`:189`、`:207`、`:232`、`:246-248`、`:276`（摘要文本；`:68`、`:132` 的 `/个步骤/` 定位） | 摘要 | 4 | 7 |
| `web/test/chat-page-file-changes.test.tsx:739` | 摘要 | 4 | 7 |
| `web/test/chat-stop-button.test.tsx:242` | 摘要 | 4 | 7 |
| `web/test/chat-message-waiting.test.tsx:144` | 摘要 | 4 | 7 |
| `web/test/chat-page-artifact-card.test.tsx:636` | 摘要 | 4 | 7 |
| `web/e2e/ui-walk-steps.ts:16`（`/个步骤/u` 定位） | 摘要 | 4 | 7 |
| `web/e2e/ui-walk.spec.ts:665` | 摘要 | 4 | 7 |
| `web/e2e/ui-walk-todo.ts:90` | 摘要（`1 个步骤 · todo 已完成` → `其它 1 步`） | 4 | 7 |
| `web/e2e/ui-walk-approval.ts:110` | 摘要（运行中） | 4 | 7 |
| `web/e2e/ui-walk-approval.ts:12` 及其使用处（允许后消息里出现 `已允许执行`） | 独立记录卡（真 omp 下该审批配上 bash 步骤） | 2 | 8 |
| `web/e2e/ui-walk-upstream-failure.ts:91` | 独立记录卡（同上） | 2 | 8 |
| chat-harness「UI 走查对话步骤」对应走查断言（随规格 MODIFIED 改写） | 独立记录卡 | 2 | 8 |
| `web/test/chat-thinking.test.tsx:422-427`、`:443`（T6：第一条 `thinking.delta` 之后、正文到达之前取 `message-body` 并比较位置；分段布局下此刻没有空的 `message-body`，正文段到达后才出现，chat-web「消息线程」）。改写为「首段思考后消息内没有正文块；正文到达后正文段在折叠块之后」 | 新消息的块次序（空正文块） | 3 | 6 |
| `web/test/chat-tool-group.test.tsx:255-263`（`:263` 快照里 failed 步骤的组为 `aria-expanded="true"`） | 失败自动展开 | 1 | 7 |
| `web/test/chat-thinking-title.test.tsx:107-139`（`:121` 的 `thinking.end` 后 `expanded()` 为 `true`，从空思考由事件驱动，分段布局） | 运行中折叠保持展开到终态 | 5 | 6 |
| `web/test/chat-thinking-title.test.tsx:145-169`（两段思考只读第一个折叠的标题，期待 `已思考 3 秒` 的累计值，分段布局） | 多段共用一个折叠、累计标题 | 6 | 6 |

不在表里、也**不需要**改写的同类断言（夹具没有配对或位置数据，按 B4 兜底 / B1 旧布局，旧断言仍成立；补新键时取 `stepId: null`、`bodyOffset: null`、`thinkingSegments: []`）：`web/test/chat-approval-bar.test.tsx:198`、`:213`、`:507`，`chat-approval-dock.test.tsx:300-311`，`chat-approval-support.tsx:20-22`、`:168`，`chat-stop-button.test.tsx:360`，`chat-thinking.test.tsx:558`、`:655-680`，`chat-page-file-changes.test.tsx:685-700`、`:717-724`，`chat-page-artifact-card.test.tsx:555-575`，`chat-runtime-convert.test.ts:85`（part 次序不变，D8），`chat-thinking.test.tsx` 的 T8（`:467-489`）（从空思考由事件驱动、成为分段布局，但没有 `thinking.end`，该段一直进行中到终态，断言照旧成立）、`chat-regenerate-button.test.tsx:247` 与 `chat-stop-button.test.tsx:238-239`（stopped 且没有正文段，`（已停止生成）` 占位仍是 `data-slot="message-body"` 元素，chat-web「消息线程」已写明）、其余 F1–F6、T7、T9–T12 与限高 / 流光 / 渐隐用例（`:491-755`，快照夹具为旧布局），`chat-thinking-preview.test.tsx` 全文（含 `:221` 的「`thinking.end` 后仍是预览」：快照思考 `思考第 1 行` 补键后为旧布局，#910 规则不变），`chat-thinking-smooth.test.tsx` 全文（快照思考非空，旧布局），`chat-thinking-title.test.tsx:171-257`（快照为旧布局；`:217` 无 `thinking.end` 至终态；`:229` 手动收起跨过 `thinking.end` 仍收起，与 B12 一致），`chat-message-waiting.test.tsx:122-136`（只断言折叠块出现与小圆点），`web/e2e/ui-walk-thinking-preview.ts`（闸门停在思考中，该段进行中，展开、带 `data-running`；放行后终态收起），`web/e2e/ui-walk-sessions.spec.ts:320-340`（终态收起；`:scope ~ message-body` 要求折叠块与正文同级，分段区不设包裹元素即成立），`web/e2e/ui-walk-todo.ts:13`、`:91` 与 `ui-walk-session-list.ts:17`、`:56-58`（断言「没有任何审批组」，仍成立）。它们的事件夹具若含 `step.start`，补的 `approvalId` 取 `null`（不配对）；若某条用例必须改成配对才能继续表达原意，按「新发现」处理。#910 Stage 4.5 的回归就出在清单太短：实现中发现表外的断言因本 change 变红，先停下更新本表与偏离记录，不自行扩大。

**D15 验收清单（T10）。** `docs/acceptance/functional-checklist.md` 受影响的行（2026-10-15 核对），各在引入该呈现的切片里改写，结论一律 `待签`：

| 行 | 现在写的 | 改写为 | 切片 |
|---|---|---|---|
| CH-14 | 思考折叠块在「正文上方」 | 在它发生的位置（第一段思考通常仍在最前）；只有正在思考的那一段展开，一段结束即收起（B12） | 6 |
| CH-15 | 摘要「3 个步骤 · bash 已完成」，失败自动展开、手动收起到下次失败 | 按动作归类的摘要、失败不展开、`，N 步失败`、`，进行中` | 7 |
| CH-19 | 「那条助手消息里的「N 个步骤」一行照常显示」 | 工具段摘要（如「执行 1 条命令，进行中」） | 7 |
| CH-20 | 允许后消息里出现「已允许执行」记录；拒绝后「已拒绝执行」 | 允许后消息里没有记录卡；拒绝后的呈现取 4.4 实测所取分支：有步骤时展开工具段、该步骤卡标「已拒绝」，没有步骤时消息末尾「已拒绝执行」 | 8 |
| CH-21 | 取消屏蔽后再点「允许」，消息里出现「已允许执行」 | 消息里没有记录卡 | 8 |
| CH-22 | 两张卡分别作答后，消息里按发起顺序「已允许执行」「已拒绝执行」两条记录 | 被允许的那一条没有记录卡；被拒绝的那一条取 4.4 实测所取分支（步骤卡标「已拒绝」，或消息末尾「已拒绝执行」） | 8 |
| CH-23 | 超时后消息里出现「超时自动允许」记录 | 展开工具段后该步骤卡标「超时自动允许」，消息里没有记录卡 | 8 |
| CH-24 | 回合结束后刷新，各消息里的三种记录都还在 | 刷新后呈现与刷新前相同：允许与超时的那两条没有记录卡（超时的步骤卡标「超时自动允许」）；CH-20 拒绝的那一条取 4.4 实测所取分支（步骤卡标「已拒绝」或消息末尾「已拒绝执行」） | 8 |
| CH-50 | 停止后消息里出现「已拒绝执行」 | 步骤已开始并已配对时该步骤卡标「已拒绝」，否则消息末尾「已拒绝执行」；验收步骤里哪一种出现取决于停止时步骤是否已开始，写法与 4.4 所取分支一致 | 8 |
| CH-56 | 分叉后拷来的一轮「思考折叠块、「工具调用」一行、确认记录、「文件变更」卡都在」 | 分段与源会话相同；确认体现为步骤卡标记（拷来的若是 045 之前的消息，按旧布局与记录卡） | 8 |
| CH-118 | 再次进入思考时标题回到「正在思考…」，「N 是各段思考的累计秒数」 | 再次进入思考时在新位置出现新的折叠块，从「正在思考…」开始、展开着；上一段的折叠块在它结束时已收起（B12），各自只算本段秒数（B5） | 6 |
| 新增 | — | 分段交替显示与刷新后一致（受控上游下带 `WORKBUDDY_INTERLEAVE`） | 6 |
| CH-117 | 「第一块内容…一出现，…换成正文末尾的小圆点」 | 小圆点在最后一个块之后：最后一块是正文段时在正文末尾，是工具段或思考段时单独一行在它下面（先调用工具的请求即如此）；等待指示的出现与消失不变 | 6 |

CH-119（逐字展开）、SL-17（导出）核对后不受影响。

**D16 行数预算与新模块。** 见文末表。`store.ts` 791 行装不下步骤偏移与配对：`startStep` 整体移到新模块 `store-segments.ts`（连同段行的开、闭与读出），`store.ts` 只留接口声明与一行委托，净减。`supervisor.ts` 的预算靠一个 per-pump 对象守住（Stage 3 指出配对状态要经 `commit` 闭包、`#commit`、`persistEvent` 一路传下去，不止一处调用）：切片 4 把今天 pump 局部的 `toolIds` Map、`ordinal` 计数器与 `nextOrdinal` 闭包（`supervisor.ts:606-612`）和配对状态合成一个对象 `PumpSteps`（放在 `approval-pairing.ts`），`#commit`（`:660-667`）与 `persistEvent`（`turn-control.ts:219`）的 `toolIds, nextOrdinal` 两个参数换成这一个参数——参数表变短，调用处不再折行。pump 里只多 select 配对与入队的一处调用（`:624-628` 的条件链），`step.end` 的移出在 `turn-control.ts`。按此估算切片 4 净增不超过 5 行、切片 5（把配对结果交给 `publishRequest`）再加 2 行；超出时先停下改本节。`approvals.ts`（264 行）在切片 4 加一个只读查询（此刻 `publishRequest` 是否会为该帧发布 request），在切片 5 让 `publishRequest` 接收并发布 `stepId`。web 的归约新逻辑进新模块 `stream-segments.ts`，严格解析进新模块 `session-contract-segments.ts`。`session-rest.test.ts`（800）的两组整快照断言在切片 5 必须随新键变化（它们用 `toEqual` 比整份快照），改用共享的助手视图常量展开使其净减，新断言进新文件；`delta-coalescer.test.ts`（771）不再扩写，3b 的新例进新文件；`session-thinking.test.ts`（786）补键用共享常量。走查新步骤进新文件 `web/e2e/ui-walk-segments.ts`（`ui-walk-layout.ts` 789）。

**D17 证据与受控上游的新标记。** 编排方的默认是「用既有标记 `WORKBUDDY_PACE`、`WORKBUDDY_HOLD_AT` 让窗口可观察」。核对后做不到：`WORKBUDDY_PACE` 先发思考、后发正文（`fake-upstream-pace.mjs:18-24`（da3ee248；#1468 后 `:21-27`）），`HOLD_AT` 只决定停在角色帧或思考帧之后（`fake-upstream.mjs:16-17`（#1468 后 `:21-22`）），工具轮只发一个工具调用、不带正文（`:508-540`，#1468 后 `:515-547`）——真链路上从来不会出现「合并器缓冲着正文时到达思考或工具」。所以：

- 新标记 `WORKBUDDY_INTERLEAVE`（omp-test-harness「受控上游交错标记」）：答复轮按 25ms 节奏发「正文、正文、思考、正文」，第二片正文必在第一片的 250ms 窗口内被缓冲，紧接的思考片触发「先冲刷再开段」。复用 `fake-upstream-pace.mjs` 的写出逻辑，不复制。
- 证据分三层（「Sketch seams under test」）：纯层（注入时钟）钉住次序与偏移；fake-omp 集成钉住接线；官方 omp 钉住真链路上偏移 = 已发布正文长度。

**D18 关键路径（T11）。** AGENTS.md 的 Critical Paths 是「沙箱与文件边界」与「omp 子进程治理（spawn/回收、凭证注入、资源限额）」。

- 切片 3a、3b、4 改 `supervisor.ts`、`delta-coalescer.ts`、`thinking-span.ts`、`turn-control.ts`：都在 pump 的事件持久化与发布路径上，不碰 spawn、回收、凭证注入与资源限额，不属于「omp 子进程治理」。但 3b 改的是合并器的冲刷次序（并发 / 次序风险包），按 expanded 审。
- 切片 4 在 `chat_approvals` 上写一列，与审批闸门（tool-approval：作答、超时自动允许、终态结算）同表、同一 pump：**请求白盒审查**，审查重点是「配对没有改变任何作答与结算路径」（D6），PR 写明这一点。
- 切片 5 改 `approvals.ts` 的 `approval.request` 负载（多一个 `stepId`），是审批闸门所在文件：**请求白盒审查**，重点是只改负载、不改发布时机与任何作答路径。
- 其余切片（web、夹具、迁移）不触及关键路径。

### 通用纪律（沿用 #910 并扩展；tasks.md 各组照此执行）

- **合入门槛。** 每个 PR 合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿，主干可运行。改到或新增官方 omp 用例的 PR，另跑 `WORKBUDDY_OMP_TEST=1 OMP_BIN=<repo>/var/omp/omp` 下相关的 `server/test/omp-official-*.test.ts`；omp 用 `make omp-fetch` 拉到的 v18.0.10，不用 brew 装的版本。
- **永远不打真实模型端点。** 单测、官方 omp 用例、冒烟与走查一律打假上游；实测用的模型端点只来自环境变量，不进任何被跟踪文件（本 change 的实测也只用受控假上游）。
- **新逻辑进新模块，行数有预算**（D16 与文末表）。`scripts/size-guard.sh` 是硬门槛，不调阈值；每个切片在 PR 里写明预算表里被它改到的文件改动前后的行数。
- **行号核对。** 本文与 tasks 里的 `文件:行` 是在 `1e9dffc8` 上读的。每组开工先重跑该组第一个任务的核对；有出入，先改本 change 的 design 与该组任务，再继续。
- **既有断言不删不削弱。** 因本 change 而变化的既有断言，在 PR 的偏离记录里逐条列出旧 → 新。只允许四种改法：
  1. 改为「拼接逐字相等」；
  2. 在注入时钟下改为确定条数；
  3. 钉住的正是 D14 封闭清单（#910 的四条加本 change 的六条）里的旧行为时，改写为钉住新行为的反向断言，并引用该裁定；只限 D14 表里列出的断言；
  4. **补键**：严格键集夹具（快照、事件、列清单）为新键补上取值——没有位置与配对语义的夹具取 `bodyOffset: null`、`stepId: null`、`thinkingSegments: []`、`approvalId: null`，原断言不动；列清单夹具补列。事件里不能为 `null` 的新字段取与该用例事件一致的值：`step.start` 的 `bodyOffset` 取此刻已收到正文的长度；`thinking.end` 的 `segment` 取该段在用例事件下的真实取值（单段时 `thinkingMs` 与事件的 `thinkingMs` 相同；用例从一份已有思考的快照起头时，`segment.thinkingOffset` 取快照思考的长度，与客户端临时段一致，消息因而保持旧布局，例如 `chat-thinking-smooth.test.tsx`、`chat-thinking-preview.test.tsx`）；`approval.request` 的 `stepId` 取 `null`。补键不算改写，但同样逐条列进偏离记录。
  实现中发现 D14 表外的断言需要第 3 种改法，先停下更新 D14，不自行扩大。
- **拷入层不改。** `web/src/components/ui/` 与 `web/src/components/assistant-ui/` 零改动；非改不可时停下报告。
- **不实现 Non-Goals 与「Not yet specified」。**
- **同刀。** 对外形状（快照键、REST 形状、事件字段）只在切片 5 改，且服务端与 web 同一 PR；之前的服务端切片只写库，不改任何对外形状（D8）。
- **验收清单。** 每个切片改到的呈现，同步改写 D15 表里的对应行或新增行；结论一律 `待签`，agent 不代签。
- **CI 文件。** 改了 `.github/**` 或 `scripts/test-ci-harness.sh` 的切片，在 PR 里单列一节说明。
- **白盒。** 切片 4 与切片 5 在 PR 里请求白盒审查（D18）。
- `Suggested fixture level` 只用 `none | compact | expanded`。

## 规格影响

- **改**（MODIFIED）：
  - chat-web：「API 客户端扩展」「纯会话视图归约」「事件流消费与续流」「会话页源码模块划分」「步骤 args 与输出分栏」（`steps[]` 严格键集加 `bodyOffset`）「消息线程」。
  - chat-sessions：「会话 REST」。
  - chat-stream：「思考与文件变更事件发布」「审批事件发布」（`approval.request` 加 `stepId`；原文「两类事件的 payload 形状不因此改变」指并行审批，保留）。
  - thinking-fold：「深度思考折叠块呈现」「思考时长记录与下发」。
  - tool-approval：「审批作答 REST」（200 的审批对象加 `stepId`，七键）「审批事件」（负载加 `stepId`；原文把「真 omp 先发 select」写成事实，改为不作保证，D6 Context）「审批快照」「web 审批条」。
  - turn-control：「从此处分叉 REST」。
  - message-undo：「对话原地回退」（级联列表加新表）。
  - chat-harness：「UI 走查对话步骤」。
  - ui-foundation：「组件分层」（定制清单去掉「失败自动展开」）。
- **加**（ADDED）：chat-web「助手消息分段」「工具段摘要与折叠」「步骤卡的确认标记」；chat-sessions「迁移 045 分段位置与确认关联」；chat-stream「分段位置的记录与下发」；tool-approval「确认与步骤配对」；chat-harness「分段呈现的冒烟与走查」；omp-test-harness「受控上游交错标记」。
- **仍成立、不改**：
  - chat-stream「纯协议事件归约」：映射器输出的 `step.start{messageId,stepId,name,detail}` 不变；两个新字段只在持久化之后发布的事件里（#910 的 `thinking.end` 同样不在该要求里）。
  - chat-stream「正文与思考增量的时间窗合并」：「一段某类增量到达时，若缓冲中是另一类，先冲刷缓冲」照旧；D3 只是把开段挪到这次冲刷之后，切分与次序不变。
  - chat-sessions「会话持久化与回合刷盘」「Complete snapshot overlap boundary」：正文落库节奏与快照前缀不变；已发布长度是内存计数。
  - tool-approval「chat_approvals 持久化」：列清单描述的是 034 的建表语句；045 追加的列由 chat-sessions「迁移 045」规定；CAS、级联、UNIQUE 不变。
  - tool-approval「超时自动允许」「停止与终态对挂起审批的结算」：配对不改任何作答与结算路径（D6）。
  - turn-artifacts「文件变更卡」「产物卡」：「在工具调用组之外，不随其收起而隐藏」对工具段同样成立（chat-web「消息线程」声明二者同指）。
  - chat-harness「UI 走查会话元数据」：「collapsed by default because no step failed」——工具段确实收起，括号里的理由在 #915 后不再是唯一原因，但陈述不假。
  - conversation-search「对话内搜索框」：匹配范围不变（D13）。
  - session-sidebar「导出记录」：导出不含审批记录，仍成立。

## Risks / Trade-offs

- **[B3 的同名启发式]** → 并行批里同名工具有的需审批、有的不需要时，无论 select 先到还是 start 先到，标记都可能落在同段的另一张同名步骤卡上（D6）；若实测表明被拒绝的调用没有步骤，被拒绝的审批会被同回合后一个同名步骤配走。影响只在展开后的标记；记录、审计、作答不受影响。实测结果与是否出现错位写进 D6 与 PR；需要改进时另开 issue（例如 omp 给 select 带 tool call id），不在本 change。
- **[Markdown 被切开]** → 正文段在步骤或思考的边界处切开，代码围栏、列表若恰好跨过边界，会在两段里各自渲染（未闭合的围栏在前一段里一直延续到段尾）。模型在调用工具前通常已结束当前段落；接受，`复制` 与搜索仍取全文。
- **[代理对被切开]** → 偏移落在增量边界上；上游若把一个代理对拆在两个增量里，切段时边界两侧各有半个，显示为替换字符。只在上游这样切分时发生，接受。
- **[两个紧挨的折叠]** → 上游连发两个思考块（中间只有 `turn.retry` 之类不可见的事件）时出现两个相邻折叠（D4）；接受，比改写已发布的段简单。
- **[一段思考很短时折叠块一闪而过]** → B12 下一段思考结束即收起；很短的段（几百毫秒）会出现「展开 → 收起」的快速切换。接受，owner 裁定的取舍（转录不被拉长）；收起动画沿用拷入组件，`prefers-reduced-motion` 下无动画。
- **[select 时配对的写与发布]** → 审批 select 时的 `step_id` 写入在 `approval.request` 发布之前，失败会让回合失败（与任何 pump 持久化失败相同）；概率与既有的审批行插入失败同级，不另设降级。
- **[宿主崩溃留下越界偏移]** → pending 丢失后偏移可能大于 `content` 长度；切段按末尾处理，不判旧布局（D9）。
- **[部署时已打开的标签页]** → 切片 5 部署后，部署前打开、仍在运行旧前端的标签页会在下一个带新字段的已知事件（`step.start`、`approval.request`、`thinking.end`）上重新同步一次，再因快照多键被旧解析器拒收而关闭事件流，显示 `<错误>。请刷新页面后重试`；在旧标签页里作答审批，服务端已结算，但客户端因 200 响应多一个键而报错。web 没有按版本自动刷新（Context），#910 的 design 以 #909 为先例，按「快照严格键集、不设兼容窗口」接受了同样的后果。接受：不丢数据，手动刷新即恢复；不为此加版本协商（Migration Plan）。
- **[每段多两次小写]** → 开段插一行、闭段改一行，加上 #910 的两次 `thinking_ms` 写，同一事务；SQLite WAL 下可忽略（推算），不做基准。
- **[步骤插入事务多一条 UPDATE]** → 只在有同名审批排队时执行；可忽略。
- **[既有夹具补键面广]** → 十几个服务端 `MESSAGE_KEYS` / 列清单夹具与 web 快照夹具要补键（第 4 种改法），PR 偏离记录逐条列出。

## Migration Plan

- 迁移 045 只加列、加表，不回填，迁移本身不逆转。迁移账本拒绝「回执多于已发现的迁移文件」的库（`server/src/core/db/migration-ledger.ts:370-371`），所以已应用 045 的库不能直接交给不含 045 文件的旧构建：回退只能前滚修复，或在回退代码时保留 045 文件（旧代码不读写新列与新表，新表里的行无害），或连库一起恢复到部署前的备份（chat-sessions「迁移 045 分段位置与确认关联」）。
- 线协议只在切片 5 一次变化：服务端快照与事件、web 解析与归约同一 PR；服务端与 web 同仓、同一次部署发布。之前的切片对外形状不变，任何时刻主干都可运行。
- **部署那一刻已打开的标签页**（实际行为，读代码）：旧前端对带新字段的已知事件解码失败 → 重新同步一次 → 旧的严格快照解析拒收新键 → `getMessages` 抛错 → 连接器关流并报告 → 页面显示 `<错误>。请刷新页面后重试`（Context 的文件与行）。不会循环重新同步；新打开或刷新后的页面加载新前端，一切正常。web 没有按构建版本自动刷新的机制。这与 #909 / #910 的快照加键（`thinkingMs`、`error`）在部署时的后果相同，#910 的 design（Migration Plan，引 #909 的先例）按「不设兼容窗口」接受了它；本 change 同样接受，不加版本协商或自动刷新（加的话是另一个 issue）。
- 子 issue 顺序见 tasks.md 的依赖：标记、迁移、工具段摘要可并行先行；服务端位置与配对 → 同刀 → 渲染与标记 → 走查集成。

## Not yet specified

无。分段、配对、标记、摘要与旧布局的规则都已写进规格；被拒绝调用是否有步骤是一个已写定两支的实测任务（D6），不是雾。可能的后续（omp 侧给 select 带 tool call id、≥60 秒时长的「分秒」显示）都不在 #915 的范围里，有需要另开 issue。

## 待编排方确认

B1–B13 与编排方 T1–T11 之外由起草者决定的事项。第一轮的 12 项经编排方 2026-10-15 处理如下：

**已由 owner 裁定，移出本节**：相邻的两段思考不合并（B11，D4）；多段思考的开合改为只展开进行中的一段（B12，推翻了起草时「沿用 #910 规则」的决定，D10）；旧布局只有位置是旧的（B13，D9）。

**编排方默认，待 owner 验收**（按此实施，验收时 owner 可改）：
- 工具段运行中的摘要末尾加 `，进行中`，保留转圈图标与流光（D11）。
- 只含空白的正文段不渲染、不分隔工具段（D10）。
- 兜底记录的位置是分段区之后、错误文本之前（D12）。
- 停止结算的 deny 在已开始、已配对的步骤上显示 `已拒绝`，不区分用户拒绝与停止结算（D12）。

**编排方已接受**：配对不限「已作答」（D6）；新增 `WORKBUDDY_INTERLEAVE`（D17）；配对按 pump 次序而非库里最早的行（D6）；零长度思考段不渲染、不分隔工具段（D4、D10）。

**编排方已接受（第二轮，2026-10-15）**：
1. 被拒绝的调用若没有步骤（4.4 实测取分支二），被拒绝的审批会被同回合后一个同名步骤配走、标记错位（D6）；作为 B3 启发式的已知局限记录，不在本 change 修。
2. （本轮新增）D14 封闭清单的第 6 项「分段布局下多段思考共用一个折叠块、标题按消息累计时长」：编排方的修订只列了第 5 项；重新 grep 时发现 `chat-thinking-title.test.tsx:145-169` 钉住的正是被 B5 与 issue 需求 2 推翻的旧行为，按同一规则补入。
3. （本轮新增）审批 select 时若它的 `approval.request` 已由作答路径先发布（作答先于 pump 读到 select 的极端时序），select 时不配对、只入队，留给后到的 `step.start`；若步骤已经开始，这条审批就保持未配对、走兜底记录（D6）。这样实时视图与快照不会不一致，代价是这一极端时序下少一个标记。
4. （本轮新增）部署时已打开的旧标签页会关流并提示刷新（Migration Plan）；按 #910 先例接受，不加版本协商或自动刷新。

## Sketch seams under test

- **`DeltaCoalescer` + `ThinkingSpans` + 注入时钟 + 假端口（既有，纯）**：边界前冲刷的次序、开段时记下的偏移、段行的开与闭、段时长、上限之后的零长度段。时钟与次序只有在这一层能确定地造出来（#910 同一 seam）。
- **`approval-pairing.ts`（新，纯）**：两种到达次序都在后到的一方配对（start 先到时由 select 配给最早开始的运行中同名步骤，select 先到时由 start 按名字先进先出取出）、名字不同不配、已结束的步骤不再配、request 已发布的 select 只入队、回合结束丢弃。纯状态机，单测最便宜，也是唯一能穷举两种次序与交错的地方。
- **`SessionSupervisor` + fake-omp（既有）**：ring 次序、`step.start` 与 `approval.request` 的新字段、`approval-parallel` 下的配对与 `r2` 拒绝、快照三键。这是服务端集成的最高接缝，只证接线与次序；fake-omp 没有「start 先于 select」的帧序列时，用受控子进程造（#910 `session-thinking.test.ts` 先例）。
- **真 SQLite store（既有）**：迁移 045、分叉拷贝与 `step_id` 重映射、撤回与重新生成的级联。
- **官方 omp + 受控上游（既有，`WORKBUDDY_OMP_TEST=1`）**：`WORKBUDDY_INTERLEAVE` 下开段偏移 = 已发布正文长度；被拒绝调用的实测（有没有步骤、select 与 start 的线上先后）与常驻断言。只有真 omp 的帧节奏能证明真链路。
- **`Thread` + jsdom（既有）**：切段函数的全部规则（纯函数单测）、实时与快照切段一致、工具段折叠与摘要、步骤卡标记、兜底记录、搜索现状。
- **`make smoke` / `make ui-walk`（既有）**：快照字段的真栈取值、工具段在正文之前、交错消息与刷新一致。

## 行数预算

| 文件 | 现在 | 预计合入后上限 | 改动的切片 |
|---|---|---|---|
| `server/src/sessions/store.ts` | 791 | 3a 后 ≤ 765（`startStep` 移出、加计数）；3b、4 不论先后，单独合入后 ≤ 770、两刀都合入后 ≤ 774（`startStep` 返回 `{stepId, approvalId}`、select 时配对写的委托）；5 后 ≤ 784 | 3a、3b、4、5 |
| `server/src/sessions/supervisor.ts` | 776 | 4 后 ≤ 781；5 后 ≤ 783（D16 的 per-pump 对象） | 4、5 |
| `server/src/sessions/delta-coalescer.ts` | 211 | ≤ 220 | 3b |
| `server/src/sessions/thinking-span.ts` | 112 | 3b 后 ≤ 150；5 后 ≤ 160（发布 `segment`） | 3b、5 |
| `server/src/sessions/turn-control.ts` | 320 | ≤ 330 | 3a、4、5 |
| `server/src/sessions/events.ts` | 531 | ≤ 540 | 5 |
| `server/src/sessions/rest.ts` | 574 | ≤ 590 | 5 |
| `server/src/sessions/store-branch.ts` | 336 | ≤ 360 | 3a、3b、4 |
| `server/src/sessions/store-approvals.ts` | 407 | ≤ 412 | 5 |
| `server/src/sessions/store-segments.ts`（新） | — | ≤ 200 | 3a、3b、4、5 |
| `server/src/sessions/approval-pairing.ts`（新） | — | ≤ 80 | 4 |
| `server/test/session-rest.test.ts` | 800 | 5 后 ≤ 800（`:157-229`、`:745-792` 两组整快照断言改用共享的助手视图常量展开，先例 `session-rest-helpers.ts:38` 的 `UNBOUND_USER_VIEW`，净减） | 5 |
| `server/test/delta-coalescer.test.ts` | 771 | 不改（3b 的新例进新文件 `delta-coalescer-segments.test.ts`） | — |
| `server/test/thinking-span.test.ts` | 620 | ≤ 700 | 3b |
| `server/test/session-thinking.test.ts` | 786 | 5 后 ≤ 800（`:269`、`:354` 的 `thinking.end` 补 `segment` 用一个共享常量，不逐行展开） | 5 |
| `server/src/sessions/approvals.ts` | 264 | 4 后 ≤ 275；5 后 ≤ 280 | 4、5 |
| `web/src/features/chat/stream-thinking.ts` | 63 | ≤ 90 | 5 |
| `web/src/features/chat/stream-approvals.ts` | 120 | ≤ 130 | 5 |
| `web/src/lib/session-contract.ts` | 696 | ≤ 710 | 5 |
| `web/src/lib/session-contract-segments.ts`（新） | — | ≤ 120 | 5 |
| `web/src/features/chat/stream.ts` | 776 | ≤ 790 | 5 |
| `web/src/features/chat/stream-segments.ts`（新） | — | ≤ 150 | 5 |
| `web/src/features/chat/use-chat-session.ts` | 790 | 不改 | — |
| `web/src/features/chat/turn-actions.ts` | 760 | 不改 | — |
| `web/src/features/chat/message-thread.tsx` | 393 | ≤ 430 | 6、8 |
| `web/src/features/chat/message-segments.ts`（新） | — | ≤ 200 | 6 |
| `web/src/features/chat/message-segments-view.tsx`（新） | — | ≤ 200 | 6 |
| `web/src/features/chat/tool-summary.ts`（新） | — | ≤ 80 | 7 |
| `web/e2e/ui-walk-layout.ts` | 789 | 不改 | — |
| `web/e2e/ui-walk.spec.ts` | 680 | ≤ 700 | 9 |
| `web/e2e/ui-walk-segments.ts`（新） | — | ≤ 250 | 9 |
| `server/test/support/fake-upstream.mjs` | 640 | ≤ 670 | 1 |

## Traceability

| 来源 | 落点 |
|---|---|
| issue 需求 1 交替显示、相邻工具合并 | D1、D8、D10；chat-web「助手消息分段」「消息线程」；tasks 组 3、5、6 |
| issue 需求 2 思考分段 | B5、D4、D10；thinking-fold 两条 MODIFIED；tasks 3b、6 |
| issue 需求 3 刷新一致 | D3、D8；chat-stream「分段位置的记录与下发」、chat-web「实时与快照切段一致」；tasks 3a、3b、5、9 |
| issue 需求 4 旧消息兼容 | B1、D9；chat-web「助手消息分段」旧布局判定；tasks 6 |
| issue 需求 5–7 工具段 | B6、B7、D11；chat-web「工具段摘要与折叠」；tasks 7 |
| issue 需求 8 搜索 | B8、D13；tasks 6.4 |
| issue 需求 9–10 确认记录 | B3、B4、B9、D6、D12；tool-approval「确认与步骤配对」「web 审批条」、chat-web「步骤卡的确认标记」；tasks 4、8 |
| T1 | D4（B11） |
| T2 | D1、D5 |
| T3 | D7；chat-sessions「会话 REST」、turn-control「从此处分叉 REST」、message-undo「对话原地回退」；tasks 3a、3b、4 |
| T4 | D8；tasks 5 |
| T5 | D6；tasks 4、5 |
| B11 | D4 |
| B12 | D10、D14 第 5 项；thinking-fold「深度思考折叠块呈现」；tasks 6 |
| B13 | D9；tasks 6、7、8 |
| T6 | D9；tasks 6 |
| T7 | D11、D13；tasks 6、7 |
| T8 | D12；tasks 8 |
| T9 | D14 |
| T10 | D15 |
| T11 | D18 |
