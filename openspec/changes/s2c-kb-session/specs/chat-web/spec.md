## MODIFIED Requirements

### Requirement: 助手消息分段
web SHALL 用一个纯函数把一条助手消息视图切成分段，实时视图与快照恢复的视图都只经这一个函数（「会话页源码模块划分」的 `message-segments.ts`）。输入为消息的 `content`、`thinking`、步骤（按视图里的数组次序，各带 `bodyOffset`；快照生成的视图按 `ordinal` 升序，实时归约的视图按 `step.start` 到达次序，二者对同一回合相同——`ordinal` 由 pump 按 `tool_execution_start` 的到达次序分配；视图步骤不带 `ordinal`，见「纯会话视图归约」）与 `thinkingSegments`（按给出次序）；输出为「旧布局」，或一个有序的块列表，每块是正文段（一段正文原文）、思考段（一段思考原文及该段的时长与是否进行中）、工具段（一串步骤）或检索块（该消息全部名为 `kb_search` 的步骤，「会话知识库检索卡」）之一。所有偏移与长度都按 UTF-16 码元（JavaScript 字符串的 `length` 与 `slice`）计。

**旧布局判定**：以下任一条成立时 SHALL 输出旧布局（不切段，消息按「消息线程」规定的旧布局呈现），不出现部分分段、部分不分段的消息：
1. 任一步骤的 `bodyOffset` 为 `null`；
2. `thinking` 非空而 `thinkingSegments` 为空；
3. `thinkingSegments` 不自洽：第一段的 `thinkingOffset` 不为 0；某段的 `thinkingOffset` 不等于前一段的 `thinkingOffset + thinkingLength`；末段之外有段的 `thinkingLength` 为 `null`；末段的 `thinkingOffset` 加其长度（`null` 时为 0）超过 `thinking` 的长度；`stepsBefore` 不是非递减的，或大于步骤数；
4. 按下文合并后的次序，正文偏移出现递减。

**合并次序**：步骤按输入的数组次序、思考段按给出次序，第 j 段排在第 k 个步骤（0 起）之前当且仅当该段的 `stepsBefore ≤ k`；由此每段思考恰排在它开始时已开始的那些步骤之后、其余步骤之前。各项的正文偏移取其 `bodyOffset`，大于 `content` 长度的按 `content` 长度计（宿主进程崩溃会丢掉尚未落库的正文尾部而留下偏移，chat-sessions「会话持久化与回合刷盘」）。

**切段**：自正文起点起依次处理合并后的各项：项的正文偏移大于当前游标时，先输出 `content` 在 [游标, 偏移) 的正文段并把游标移到偏移；然后输出该项——思考段的原文为 `thinking` 在 [`thinkingOffset`, `thinkingOffset + thinkingLength`) 的部分（末段 `thinkingLength` 为 `null` 时到 `thinking` 末尾）；步骤并入紧挨着的前一块，前一块是工具段时并入它，否则新起一个工具段；名为 `kb_search`（精确匹配）的步骤例外：它 SHALL NOT 进入工具段——消息里第一个 `kb_search` 步骤在它的位置输出一个检索块，之后的 `kb_search` 步骤不论位置都并入这个检索块、不在自己的位置输出任何块。检索块与其它块一样分隔它两侧的工具段。全部项处理完后输出余下的正文段。以下两类块 SHALL 不输出，也不分隔它两侧的工具段：只含空白字符的正文段；原文为空串的思考段（达到 32768 码点上限之后才开始的段即如此，见 thinking-fold）。每块带一个在消息内稳定、且各块互不相同的键，按块的种类加前缀：正文段为 `text:<起点偏移>`，思考段为 `thinking:<thinkingOffset>`，工具段为 `tool:<第一个步骤的 id>`，检索块为 `kb:<第一个 kb_search 步骤的 id>`（不加前缀时，先思考后正文的消息里思考段与第一个正文段的键都会是 0）；流式增长与快照重新安装不改变已有块的键。

**思考段的标题数据**：思考段带该段的 `thinkingMs` 与「进行中」标记；进行中当且仅当它是末段、末段的 `thinkingLength` 为 `null`、消息 `running` 且消息的 `thinkingActive` 为 `true`。

#### Scenario: 交替切段
- **WHEN** 以 `content` 为 `先看一下。看完了。`、`thinking` 为 `想`、步骤依次为 `read`(`bodyOffset` 5) 与 `bash`(`bodyOffset` 5)、`thinkingSegments` 为 `[{bodyOffset:5,thinkingOffset:0,thinkingLength:1,stepsBefore:2,thinkingMs:800}]` 调用切段函数
- **THEN** 输出为正文段 `先看一下。`、工具段 [`read`,`bash`]、思考段 `想`（`thinkingMs` 800，不在进行中）、正文段 `看完了。`
- **WHEN** 同一输入里思考段的 `stepsBefore` 改为 1
- **THEN** 输出为正文段、工具段 [`read`]、思考段、工具段 [`bash`]、正文段

#### Scenario: 空白与空思考不分隔工具段
- **WHEN** `content` 为 `\n\n`，两个步骤的 `bodyOffset` 分别为 0 与 2；另一例两个步骤之间有一段 `thinkingLength` 为 0 的思考段
- **THEN** 两例都只输出一个含两个步骤的工具段，没有正文段与思考段

#### Scenario: 旧布局判定
- **WHEN** 分别以下列消息调用：一个步骤的 `bodyOffset` 为 `null`；`thinking` 为 `想` 而 `thinkingSegments` 为 `[]`；两段思考的第二段 `thinkingOffset` 与第一段的结尾不相接；第一段 `thinkingLength` 为 `null` 而后面还有一段；`stepsBefore` 为 3 而只有 2 个步骤；第二个步骤的 `bodyOffset` 小于第一个的
- **THEN** 每一例都输出旧布局
- **WHEN** 一条没有步骤、没有思考的消息；另一条步骤 `bodyOffset` 为 12 而 `content` 只有 8 个码元（宿主崩溃丢了尾部）
- **THEN** 前者输出唯一的正文段；后者不判旧布局，工具段排在全部 8 个码元的正文之后

#### Scenario: 实时与快照切段一致
- **WHEN** 一个回合依次收到 text.delta(`先看一下。`)、thinking.delta(`想`)、thinking.end（段 `{bodyOffset:5,thinkingOffset:0,thinkingLength:1,stepsBefore:0,thinkingMs:600}`）、approval.request、step.start(`bodyOffset` 5)、approval.resolved(allow)、step.end、text.delta(`好了`)、turn.end(done)，过程中每个事件之后各取一次视图；随后读取同一消息的快照并由 `chatStateFromSnapshot` 生成视图
- **THEN** 回合结束后由事件归约出的视图与由快照生成的视图经切段函数得到逐块相等的输出（正文段 `先看一下。`、思考段 `想`、工具段、正文段 `好了`）；过程中的每一个视图都不是旧布局
- **WHEN** 上例在思考段进行中（thinking.delta 之后、thinking.end 之前）读取快照（该段的 `thinkingLength` 与 `thinkingMs` 为 `null`），客户端以快照游标续流其余事件
- **THEN** 快照视图的切段输出在正文段之后有一个进行中的思考段；续流到回合结束后与上例的输出逐块相等

#### Scenario: kb_search 步骤合成一个检索块
- **WHEN** 一条助手消息的正文为 `先查。再查。答。`，步骤依次为 `read`（偏移 3）、`kb_search` s1（偏移 3）、`bash`（偏移 3）、`kb_search` s2（偏移 6），没有思考
- **THEN** 块依次为正文段 `先查。`、工具段 [`read`]、检索块 [s1, s2]（键 `kb:<s1 的 id>`）、工具段 [`bash`]、正文段 `再查。`、正文段 `答。`（在 s2 的位置不输出块，两段正文相邻而各自成块）

### Requirement: 纯会话视图归约
`chatStateFromSnapshot` SHALL 从完整消息快照生成有序聊天视图，不编造 SSE 缺失的时间戳或 ordinal；每条消息视图 SHALL 携带 `approvals: {id,tool,title,expiresAt,decision,stepId}[]`（由快照 `approvals` 逐项映射并保持按 `id` 升序，user 消息与无审批记录的 assistant 消息恒为 `[]`；`requestedAt` 不进视图），并携带 `thinking: string|null`（取快照原值）、`thinkingMs: number|null`（取快照原值）、思考进行中标记 `thinkingActive: boolean`（由快照生成时为「消息 status 为 `running`、`thinking` 为非空字符串且 `thinkingMs` 为 `null`」）、`error`（取快照原值：`null` 或 `{reason,message,status,detail}`）与重试中标记 `retrying: boolean`（由快照生成时恒为 `false`）；每个步骤视图携带 `changes`（取快照原值，`null` 或变更数组）与 `bodyOffset`（取快照原值）；每条消息视图携带 `thinkingSegments`（取快照原值，元素 `{bodyOffset,thinkingOffset,thinkingLength,stepsBefore,thinkingMs}`，次序不变）；视图状态 `ChatState` SHALL 携带会话级的 `todo`（取快照 `todo` 原值：归一化任务清单或 `null`）。`applyChatEvent(state,event)` SHALL 为确定性的纯函数，只复制改变的分支、不修改输入；未知事件类型 SHALL 保持原状态。
归约器 SHALL 处理服务端十四类事件：turn.start 重置对应 assistant 正文/步骤/错误并把 `approvals` 与 `thinkingSegments` 置为 `[]`、`thinking` 置为 `null`、`thinkingMs` 置为 `null`、`thinkingActive` 置为 `false`、置 running（不重置 `todo`）；thinking.delta `{messageId, delta}` 先看该 assistant 的 `thinkingSegments`：为空或末元素的 `thinkingLength` 不为 `null`（末段已结束）时，SHALL 在末尾追加一段临时段 `{bodyOffset: 当前正文长度, thinkingOffset: 当前 thinking 长度（null 视为 0）, thinkingLength: null, stepsBefore: 当前步骤数, thinkingMs: null}`（长度均按 UTF-16 码元，即 JavaScript 字符串的 `length`），末段仍开着时不加；然后把 `delta` 原样追加到 `thinking`（`null` 视为空串）并把 `thinkingActive` 置为 `true`，会话状态不变，不存在的 assistant 按消息事件补建；thinking.end `{messageId, thinkingMs, segment}` 把对应 assistant 的 `thinkingMs` 置为事件值、`thinkingActive` 置为 `false`，并以事件的 `segment` 取代 `thinkingSegments` 的末元素（末元素的 `thinkingLength` 为 `null`，即仍开着时），否则把 `segment` 追加到末尾（达到思考上限后没有 thinking.delta 的段即如此）；正文、`thinking`、步骤与会话状态不变，不存在的 assistant 按消息事件补建，指向 user 消息时保持原状态（同一引用）；files.changed `{messageId, stepId, files}` 把该消息内 `stepId` 步骤的 `changes` 整体替换为 `files`（同一步骤后到者胜），该步骤或该消息不存在时保持原状态（同一引用），不编造步骤也不补建消息，会话状态不变；todo.updated `{messageId, todo}` 把 `ChatState.todo` 整体替换为事件的 `todo`（归一化任务清单或 `null`），不补建消息，不改任何消息、步骤与会话状态（`messages` 保持同一引用），新值与当前值深相等时返回原状态（同一引用），且 `turn.start`、`turn.end`、`error` 及其它事件 SHALL NOT 重置或改动 `todo`（清单属于会话，不属于某条消息；见 session-todo `web 契约解析与归约`）；text.delta 原样追加；step.start 按 messageId 内的 stepId 新建 running 步骤（`changes` 为 `null`，`bodyOffset` 取事件值）且不重复，事件的 `approvalId` 非 `null` 且该消息 `approvals` 里有这一 id 时 SHALL 把那一项的 `stepId` 置为该 stepId（其余审批不变；没有这一 id 时忽略，不补建审批）；step.end 更新已有步骤的状态和 output，detail 与 `changes` 保持 step.start、files.changed 或快照中的值不变；error 将对应 assistant 标记 failed、把 `error` 置为事件的 `{reason,message,status,detail}` 并把 `retrying` 置为 `false`，但会话保持 running 等待 turn.end；turn.retry `{messageId}` 只把对应 assistant 的 `retrying` 置为 `true`（不存在的 assistant 按消息事件补建），正文、`thinking`、步骤、`error` 与会话状态不变；同一 assistant 随后的 turn.start、text.delta、thinking.delta、step.start、error、turn.end 都把 `retrying` 置为 `false`；kb.hits `{messageId, stepId, intent, bases}` 把该消息内 `stepId` 步骤的 `kbHits` 置为 `{intent, bases}`（同一步骤后到者胜），该步骤或该消息不存在时保持原状态（同一引用），不编造步骤也不补建消息，正文、步骤的其余字段与会话状态不变；快照生成的步骤与 step.start 新建的步骤 `kbHits` 为 `null`，step.end 不改它；turn.end 将消息、会话和仍 running 的步骤置为其 done/failed/stopped 状态并把该消息的 `thinkingActive` 置为 `false`（`stopped` 不设置 error 文案）；审批按 `approvalId` 为键增改：approval.request `{messageId, approvalId, tool, title, expiresAt, stepId}` 向对应 assistant 的 `approvals` **追加** pending 项 `{id: approvalId, tool, title, expiresAt, decision: null, stepId}`（`stepId` 取事件值：审批在 select 时已配上步骤为该步骤 id，否则 `null`，tool-approval「确认与步骤配对」） 并保持按 `id` 升序，绝不覆盖或移除同消息的其它审批项（同一消息可同时有多条 pending）；若该 `approvalId` 已存在于该消息则保持原状态（同一引用）；会话保持 running；approval.resolved `{messageId, approvalId, decision}` 仅更新该消息 `approvals` 中 `id === approvalId` 的那一项的 `decision`，其余项与其顺序不变；未知 `approvalId`（该消息无此 id、消息无审批或消息不存在）保持原状态（同一引用），不补建。不存在的 assistant 可按消息事件补建；不得重写 user 消息。未知 step.end 不得编造缺失的步骤名称。没有先前 turn.start 或 error 的终态 SHALL 有效。

#### Scenario: 流式归约与重置
- WHEN 对初始状态应用 turn.start、step.start(bash)、text.delta×3、step.end(done,output)、turn.end(done)
- THEN 得到完整正文、一条 detail 仍为 start 值且带该 output 的 done bash 步骤和 done 状态，输入及未改分支不被修改
- WHEN 再次对该 assistant 应用 turn.start
- THEN 仅该消息正文、步骤、错误清空并回到 running

#### Scenario: 无 start 的合法终态与失败
- WHEN 接收本地完成回合的单独 turn.end(done)，或 agent_start 之前的 error 然后 turn.end(failed)
- THEN 对应 assistant 视图存在并进入正确终态；错误文案原样保留，error 本身不提前结束会话生成状态
- WHEN 快照已有步骤随后收到 step.end
- THEN 更新同一 messageId/stepId 的步骤而不是重复创建

#### Scenario: 停止终态归约
- **WHEN** 对 running assistant（含一条 running `bash` 步骤）应用 turn.end(stopped)
- **THEN** 该消息与会话状态为 `stopped`、该步骤为 `stopped` 且 output 不变、error 保持 null，未改分支引用不变；没有先前 turn.start 的单独 turn.end(stopped) 同样有效

#### Scenario: 审批请求与结算归约
- **WHEN** 对 running assistant 依次应用 approval.request(approvalId 7, tool bash)、approval.resolved(approvalId 7, allow)
- **THEN** 第一步（事件 `stepId` 为 `null`）后该消息 `approvals` 为 `[{id:7, tool:"bash", title, expiresAt, decision:null, stepId:null}]` 且会话仍 running；第二步后该项 `decision` 为 `allow`，其余字段不变
- **WHEN** 对同一状态应用 approval.resolved(approvalId 8) 或对 `approvals` 为 `[]` 的消息应用 approval.resolved，或再次应用已存在的 approval.request(approvalId 7)
- **THEN** 返回的状态与输入相等（同一引用），不编造、不覆盖审批记录
- **WHEN** 再次对该 assistant 应用 turn.start
- **THEN** 该消息 `approvals` 回到 `[]`

#### Scenario: 同一消息多条并行审批归约
- **WHEN** 对 running assistant 依次应用 approval.request(approvalId 8)、approval.request(approvalId 7)、approval.resolved(approvalId 8, deny)
- **THEN** 两次 request 后该消息 `approvals` 为 id 顺序 `[7, 8]` 的两条 pending，第二次 request 未覆盖第一条；resolved 后仅 id 8 的 `decision` 为 `deny`，id 7 仍为 `decision:null`，会话仍 running

#### Scenario: 思考与文件变更归约
- **WHEN** 对 running assistant 依次应用 thinking.delta(`先`)、thinking.delta(`想`)、step.start(stepId 5, write)、files.changed(stepId 5, `[{path:"a.html",added:null,removed:null,kind:"write"}]`)、再一次 files.changed(stepId 5, `[{path:"b.html",…}]`)、step.end(stepId 5)
- **THEN** 该消息 `thinking` 为 `先想`，步骤 5 的 `changes` 最终为仅含 `b.html` 的数组且在 step.end 之后保留，正文与会话状态不变，输入与未改分支不被修改；对快照中 `thinking` 为 `null` 的消息应用 thinking.delta(`x`) 后为 `x`
- **WHEN** 应用指向不存在步骤（stepId 99）或视图中不存在的 messageId 的 files.changed，或对 user 消息的 id 应用 thinking.delta 或 files.changed
- **THEN** 都返回与输入相等的同一引用
- **WHEN** 再次对该 assistant 应用 turn.start，或对视图中不存在的 messageId 应用 thinking.delta(`y`)
- **THEN** 前者该消息 `thinking` 回到 `null`、步骤清空；后者在末尾补建一条 running assistant，其 `thinking` 为 `y`、正文为空

#### Scenario: 任务清单归约
- **WHEN** 视图由 `todo` 为 `null` 的快照生成且末条助手 M 为 running，依次应用 `todo.updated{messageId:M, todo:T1}`、与之逐值相同的第二条、`todo.updated{messageId:M, todo:T2}`、`turn.end{messageId:M, status:"done"}`、下一回合的 `turn.start{messageId:N}`、`todo.updated{messageId:N, todo:null}`；另由一份 `todo` 为 T1 的快照调用 `chatStateFromSnapshot`
- **THEN** `ChatState.todo` 依次为 T1、T1（第二条返回同一状态引用）、T2、T2、T2（`turn.start` 不重置）、`null`；每次 `todo.updated` 归约后 `messages` 与归约前是同一引用、没有补建消息，输入状态未被修改；由快照生成的视图 `todo` 为 T1

#### Scenario: 失败对象与重试标记归约
- **WHEN** 对 running assistant 依次应用 turn.retry、text.delta(`x`)；另一例依次应用 turn.retry、error `{reason:"upstream_error",message:"上游出错：模型服务内部错误",status:503,detail:"模型服务返回 HTTP 503"}`、turn.end(failed)；再由一份末条助手 `error` 为 `{reason:"auth_failed",message:"鉴权失败：模型服务拒绝了配置的 API 密钥",status:401,detail:"…"}` 的快照调用 `chatStateFromSnapshot`
- **THEN** 第一例 turn.retry 后该消息 `retrying` 为 `true`、会话仍 running，text.delta 后为 `false`；第二例最终该消息 `failed`、`retrying` 为 `false`、`error` 逐值等于事件对象，会话 `failed`；由快照生成的视图 `error` 逐值等于快照对象、`retrying` 为 `false`；输入与未改分支不被修改

#### Scenario: 思考时长与进行中标记归约
- **WHEN** 对 running assistant（`thinking` 为 `null`、`thinkingMs` 为 `null`）依次应用 thinking.delta(`先`)、thinking.end(`thinkingMs` 400)、step.start、thinking.delta(`想`)、thinking.end(`thinkingMs` 1200)、turn.end(done)
- **THEN** 各步之后 `thinkingActive` 依次为 `true`、`false`、`false`、`true`、`false`、`false`，`thinkingMs` 依次为 `null`、400、400、400、1200、1200；`thinking` 最终为 `先想`；正文与步骤不受 thinking.end 影响
- **WHEN** 以快照生成视图：一条 running assistant `thinking` 为 `先`、`thinkingMs` 为 `null`；一条 running assistant `thinking` 为 `先`、`thinkingMs` 为 400；一条 done assistant `thinking` 为 `先`、`thinkingMs` 为 `null`
- **THEN** 三者 `thinkingActive` 依次为 `true`、`false`、`false`，`thinkingMs` 取快照原值
- **WHEN** 对视图中不存在的 messageId 应用 thinking.end(`thinkingMs` 900)，或对 user 消息的 id 应用它
- **THEN** 前者在末尾补建一条 running assistant，其 `thinkingMs` 为 900、`thinkingActive` 为 `false`；后者保持原状态（同一引用）

#### Scenario: 分段位置归约
- **WHEN** 对 running assistant（正文、`thinking` 为空，无步骤与段）依次应用 text.delta(`看一下`)、thinking.delta(`先想`)、thinking.delta(`想`)、thinking.end(`thinkingMs` 900，`segment` 为 `{bodyOffset:3,thinkingOffset:0,thinkingLength:3,stepsBefore:0,thinkingMs:900}`)、approval.request(approvalId 7, bash)、step.start(stepId 5, bash, `bodyOffset` 3, `approvalId` 7)、text.delta(`好了`)、thinking.delta(`再想`)
- **THEN** 第一条 thinking.delta 后 `thinkingSegments` 为一段临时段 `{bodyOffset:3,thinkingOffset:0,thinkingLength:null,stepsBefore:0,thinkingMs:null}`，第二条不再加段；thinking.end 后该段等于事件的 `segment`；step.start 后步骤 5 的 `bodyOffset` 为 3，审批 7 的 `stepId` 为 5；最后一条 thinking.delta 追加第二段临时段 `{bodyOffset:5,thinkingOffset:3,thinkingLength:null,stepsBefore:1,thinkingMs:null}`；输入与未改分支不被修改
- **WHEN** 对 running assistant 依次应用 step.start(stepId 5, bash, `bodyOffset` 0, `approvalId` null)、approval.request(approvalId 7, bash, `stepId` 5)
- **THEN** step.start 后步骤 5 没有关联的审批；approval.request 后审批 7 的 `stepId` 为 5，与「审批在 select 时配上步骤」的快照相同
- **WHEN** 对一条 `thinkingSegments` 为 `[]` 的 running assistant 应用 thinking.end（`segment` 为 `{bodyOffset:0,thinkingOffset:0,thinkingLength:0,stepsBefore:0,thinkingMs:300}`）；另一例应用 `approvalId` 为 99（该消息没有这一审批）的 step.start；再对该 assistant 应用 turn.start
- **THEN** 前者 `thinkingSegments` 恰为该段；中者新建步骤、`approvals` 不变；turn.start 后 `thinkingSegments` 回到 `[]`

#### Scenario: 检索结果归约
- **WHEN** 对 running assistant 依次应用 step.start(stepId 5, `kb_search`)、kb.hits `{messageId, stepId:5, intent:"查规则", bases:[…]}`、同一步骤的第二条 kb.hits（`intent:null`）；另一例应用 `stepId` 为 99（该消息没有这一步骤）的 kb.hits
- **THEN** 步骤 5 的 `kbHits` 先为第一条的 `{intent, bases}`，再为第二条的（后到者胜），步骤的其余字段、正文与会话状态不变；后一例返回同一引用，不新建步骤

### Requirement: 事件流消费与续流
`connectSessionEvents` SHALL 使用注入的 EventSourceCtor 建立编码 sessionId 的同源 events URL，并设置 withCredentials:true。调用方先取得初始完整快照并传入 initialCursor；连接器 SHALL 提供 close，并通过 loadSnapshot(signal)、同步 onSnapshot/onEvent、可选 onGap 和 onError 管理恢复与错误。API 方法和页面由其他模块拥有。
连接器 SHALL 从命名 MessageEvent 的 data 解码负载、从 lastEventId 读取 canonical 安全整数 epoch:seq；十四类数据事件（含 `approval.request`、`approval.resolved`、`thinking.delta`、`thinking.end`、`files.changed`、`todo.updated`、`turn.retry`、`kb.hits`）均经过同一游标过滤。`error` 按严格键集 `{messageId,message,reason,status,detail}` 解码（`messageId` 安全整数，`message`、`reason` 非空字符串，`status` 为 `null` 或 100–599 的整数，`detail` 字符串，可为空串），`turn.retry` 按严格键集 `{messageId}`（安全整数）解码。`kb.hits` 按严格键集 `{messageId,stepId,intent,bases}` 解码：`messageId`、`stepId` 安全整数，`intent` 为 `null` 或非空字符串，`bases` 为 1–5 项、每项严格键集 `{kbId,name,status,hits}`（规则同 chat-stream「检索结果事件发布」）。`thinking.delta` 按严格键集 `{messageId,delta}`（`messageId` 安全整数、`delta` 非空字符串）解码，`thinking.end` 按严格键集 `{messageId,thinkingMs,segment}`（`messageId` 安全整数、`thinkingMs` 非负安全整数，`segment` 为严格键集 `{bodyOffset,thinkingOffset,thinkingLength,stepsBefore,thinkingMs}` 的对象、五个值都是非负安全整数——刚结束的那一段，不为 `null`）解码，`step.start` 按严格键集 `{messageId,stepId,name,detail,bodyOffset,approvalId}`（`messageId`/`stepId` 安全整数，`name`/`detail` 字符串，`bodyOffset` 非负安全整数，`approvalId` 为 `null` 或安全整数）解码，`approval.request` 按严格键集 `{messageId,approvalId,tool,title,expiresAt,stepId}`（`stepId` 为 `null` 或安全整数，其余同既有规则）解码，`files.changed` 按严格键集 `{messageId,stepId,files}`（`messageId`/`stepId` 安全整数，`files` 的规则同快照步骤的非 null `changes`：1 至 50 项，每项严格键集 `{path,added,removed,kind}`）解码，`todo.updated` 按严格键集 `{messageId,todo}`（`messageId` 安全整数，`todo` 的规则同快照的 `todo`，含 `null`，见 session-todo `web 契约解析与归约`）解码。原生传输 error 不得被当作业务 error：CONNECTING 时保留状态并交给原生自动重连，CLOSED 时关闭并报告，不推断 HTTP 状态。已知事件的非法 payload/id SHALL 触发重新同步，未知事件类型忽略。
每次 open（含首次连接和自动重连）、replay.gap 或1000条待处理数据队列溢出 SHALL 开启新的完整快照恢复；gap 额外调用 onGap。恢复期间排队，并以 generation/AbortController 使旧加载失效；只有仍有效且属于当前会话、未倒退的快照可安装。安装后丢弃旧 epoch，同 epoch 的 seq:null 覆盖整代，否则丢弃 seq≤边界，仅按到达顺序消费后继；已经成功交付的 watermark 继续去重。过滤包含 turn.start，不能清空已覆盖快照。
再次 gap/溢出 SHALL 废弃旧队列并重新同步，不以截断后继续消费替代恢复。同步回调重入时仍须保持先后次序，并在关闭/替代后停止旧 drain。loadSnapshot 失败或消费者回调违反同步合同 SHALL 关闭并报告，不能留下未处理拒绝、失效安装或继续追加；不新增自动重试策略。close SHALL 幂等关闭底层源、移除监听、abort加载并使所有迟到结果失效。切换/卸载/未登录由页面生命周期调用 close。

#### Scenario: 首次订阅窗口补齐
- WHEN 初始 REST 快照是 running/1:1，而回合在首次订阅前完成为 done/X/1:3，服务端 fresh 订阅不回放
- THEN open 后的完整快照同步仍安装 done/X/1:3，不停留在旧 running 状态

#### Scenario: 精确缺口重载
- WHEN gap 重载快照为2048字符和游标1:1002，期间排队1048字符 delta(1:1002)、旧 turn.start 以及 Z(1:1003)
- THEN 安装快照后仅追加 Z，正文恰2049字符，旧 turn.start 不清空历史
- WHEN 快照游标为 epoch1/seq:null，队列有 epoch1 尾帧及 epoch2 数据
- THEN 丢弃全部 epoch1，仅按到达顺序消费 epoch2

#### Scenario: 恢复所有权与队列边界
- WHEN 加载期间再次 gap 或队列超过1000条，然后旧加载最后才完成
- THEN 旧加载已 abort/失效，其结果不能安装；新快照及其后继负责恢复，不静默丢数据
- WHEN close、切换或未登录后加载完成，或回调重入关闭当前连接
- THEN 无迟到安装/交付，底层 EventSource 只关闭一次，队列和加载资源释放

#### Scenario: 命名错误与原生自动续连
- WHEN 先收到业务 event:error MessageEvent，再收到普通网络 error Event 和自动 reconnect/open
- THEN 仅业务帧改变 assistant 错误文案；网络错误不伪造生成失败，重连由原生 EventSource 携带 Last-Event-ID，open/必要 gap 同步恢复完整视图

#### Scenario: 审批事件经同一游标过滤
- **WHEN** 快照游标为 1:5，随后依次到达 approval.request(1:5)、approval.resolved(1:6) 与 turn.end stopped(1:7) 三个命名事件
- **THEN** 1:5 被丢弃，1:6 与 1:7 按到达顺序交付 onEvent；`approval.*` 的非法 payload/id 同样触发重新同步

#### Scenario: 思考与文件变更事件严格解码
- **WHEN** 快照游标为 1:3，随后到达 thinking.delta(1:3)、thinking.delta(1:4)、files.changed(1:5) 与一个未知类型 `event:foo.bar`(1:6)
- **THEN** 1:3 被丢弃，1:4 与 1:5 按到达顺序交付 onEvent，未知类型被忽略且不触发重新同步
- **WHEN** thinking.delta 的 `delta` 为空串、不是字符串或缺失，或 payload 多一个键，或 `messageId` 不是安全整数；或 files.changed 的 `files` 为 `[]`、超过 50 项或不是数组，元素 `kind` 未知、缺键或多键、计数与 `kind` 不符，或 `stepId` 不是安全整数
- **THEN** 触发完整快照重新同步，不交付该事件

#### Scenario: 任务清单事件经同一游标过滤并严格解码
- **WHEN** 快照游标为 1:5，随后依次到达 todo.updated(1:5)、todo.updated(1:6) 与 turn.end done(1:7) 三个命名事件
- **THEN** 1:5 被丢弃，1:6 与 1:7 按到达顺序交付 onEvent
- **WHEN** todo.updated 的 data 缺 `todo`、多一个键、`messageId` 不是安全整数，或 `todo` 为 `{phases:[]}`、含 `blocker` 键或未知 `status`
- **THEN** 触发完整快照重新同步，不交付该事件

#### Scenario: 失败与重试事件严格解码
- **WHEN** 快照游标为 1:2，随后到达 turn.retry(1:3)、error(1:4，五键齐全、`status` 为 `null`) 与 turn.end failed(1:5)
- **THEN** 三者按到达顺序交付 onEvent
- **WHEN** error 只有旧的两键 `{messageId,message}`、多一个键、`status` 为 `"401"` 或 `700`、`reason` 为空串；或 turn.retry 多一个键
- **THEN** 触发完整快照重新同步，不交付该事件

#### Scenario: 思考结束事件经同一游标过滤并严格解码
- **WHEN** 快照游标为 1:3，随后到达 thinking.end(1:3) 与 thinking.end(1:4) `{messageId:7, thinkingMs:1200, segment:{bodyOffset:5,thinkingOffset:0,thinkingLength:8,stepsBefore:0,thinkingMs:1200}}`
- **THEN** 1:3 被丢弃，1:4 按到达顺序交付 onEvent，负载逐值保留
- **WHEN** thinking.end 的 `thinkingMs` 为 `-1`、`1.5`、字符串或缺失，或 payload 多一个键，或 `messageId` 不是安全整数，或缺 `segment`、`segment` 为 `null`、`segment` 多一个键或任一值为 `null`、负数或非整数（含只有旧两键 `{messageId,thinkingMs}` 的负载）
- **THEN** 触发完整快照重新同步，不交付该事件

#### Scenario: 步骤开始事件的两个新字段严格解码
- **WHEN** 快照游标为 1:2，随后到达 step.start(1:3) `{messageId:7, stepId:5, name:"bash", detail:"{}", bodyOffset:12, approvalId:9}` 与 step.start(1:4) `{…, stepId:6, bodyOffset:12, approvalId:null}`
- **THEN** 二者按到达顺序交付 onEvent，负载逐值保留
- **WHEN** step.start 只有旧的四键 `{messageId,stepId,name,detail}`，或缺 `bodyOffset` / `approvalId`，或 `bodyOffset` 为 `null`、`-1`、`1.5`，或 `approvalId` 为字符串，或多一个键
- **THEN** 触发完整快照重新同步，不交付该事件

#### Scenario: 审批请求事件的 stepId 严格解码
- **WHEN** 快照游标为 1:2，随后到达 approval.request(1:3) `{messageId:7, approvalId:9, tool:"bash", title:"Allow tool: bash", expiresAt:1000, stepId:5}` 与 approval.request(1:4) `{…, approvalId:10, stepId:null}`
- **THEN** 两条都交付 onEvent，`stepId` 分别为 5 与 `null`
- **WHEN** approval.request 只有旧的五键，或 `stepId` 为字符串或 `1.5`，或多一个键
- **THEN** 触发重新同步，与其它已知事件的非法 payload 相同

#### Scenario: 检索结果事件严格解码
- **WHEN** 快照游标为 1:2，随后到达 kb.hits(1:3) `{messageId:7, stepId:5, intent:"查规则", bases:[…]}` 与 kb.hits(1:4) `{…, intent:null}`
- **THEN** 两条按到达顺序交付 onEvent，负载逐值保留
- **WHEN** kb.hits 缺任一键或多一个键，或 `stepId` 为字符串或 `1.5`，或 `intent` 不是字符串也不是 `null`
- **THEN** 触发完整快照重新同步，不交付该事件，与其它已知事件的非法 payload 相同

### Requirement: API 客户端扩展
`ApiClient` SHALL 提供 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，分别返回类型化的会话列表、会话、完整消息快照和接受回合的消息 ID；并 SHALL 提供 S1c 回合控制四方法 `stopSession(id)`、`regenerateSession(id)`、`forkSession(id, messageId)`、`decideApproval(id, approvalId, decision)` 与 S1c 会话元数据二方法 `patchSession(id, patch)`、`deleteSession(id)`；`createSession` 扩为 `createSession(input?, options?)`（`options` 仍为既有请求选项、携带可选 `signal`，调用方只传 signal 时 input 为 `undefined`）。十方法 SHALL 使用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制；GET SHALL 禁止缓存，路径 ID（会话 id、`approvalId`）SHALL 编码。原四方法成功状态 SHALL 分别为 200、201、200、202；`createSession()` 无 input（或 input 为 `undefined`）时不发送 body，给出 input 时 SHALL 原样发送恰含所给键的 JSON `{workspaceId?, scene?, approvalMode?, modelId?, reasoningEffort?}`（`workspaceId` 为 32 位小写十六进制、`scene ∈ {"office","code","design"}`；空对象 input 视同无 input、不发送 body），prompt SHALL 原样发送 JSON `{message}`，带附件时为 `{message, attachments}`（见本条「S1g 输入框能力」一段）。
回合控制四方法的合同：`stopSession(id)` POST `/api/sessions/:id/stop` 不发送 body，202 的 body SHALL 按 JSON 严格解析为空对象 `{}`（多字段、非对象或非 JSON 按非法响应处理）并解析为 `"stopping"`（已受理停止），204 无 body、不读取响应体并解析为 `"idle"`（会话非 running，幂等），返回 `Promise<"stopping"|"idle">`，调用方据此决定是否提示；`regenerateSession(id)` POST `/api/sessions/:id/regenerate` 不发送 body，202 返回严格解析的 `{assistantMessageId}`（安全整数）；`forkSession(id, messageId)` POST `/api/sessions/:id/fork` 原样发送 JSON `{messageId}`，201 返回严格解析的 `{session, draft, attachments}`，`session` 复用会话 DTO 解析、`draft` 为字符串（允许空串）、`attachments` 为附件数组（元素规则见「S1g 输入框能力」一段，允许空数组）；`decideApproval(id, approvalId, decision)` POST `/api/sessions/:id/approvals/:approvalId` 原样发送 JSON `{decision}`（`decision ∈ {"allow","deny"}`），200 返回严格解析的已结算审批对象（形状同消息快照 `approvals` 数组元素且 `decision` 非 null）。
会话元数据二方法的合同：`patchSession(id, patch)` PATCH `/api/sessions/:id`，原样发送 JSON `patch`，`patch` 为 `{title?: string, scene?: "office"|"code"|"design", pinned?: boolean}` 的非空子集（调用方传空对象时客户端不发请求，返回以 `TypeError` 拒绝的 Promise），200 返回按会话 DTO 严格解析的更新后会话；`deleteSession(id)` DELETE `/api/sessions/:id` 不发送 body，204 无 body、不读取响应体并解析为 `undefined`（客户端不另行等待或轮询）。命令目录方法 `listCommands(workspaceId)`（`web/src/lib/api-commands.ts`，由 `api.ts` 接线；`workspaceId` 为字符串或 null）GET `/api/commands`，`workspaceId` 非 null 时带且只带查询串 `workspaceId=<id>`，null 时不带查询串，均无 body，200 响应体 SHALL 恰为 `{commands}`，`commands` 是按 `{name,label,description,hint,source,overrides}` 严格解析的数组并作为返回值：`name`/`label`/`description` 为字符串，`hint` 为字符串或 null，`source ∈ {"builtin","skill","project"}`，`overrides` 为布尔值，项目配置方法 `listProjectConfig(workspaceId)`（同文件）以同样的查询串规则 GET `/api/project-config`，200 响应体 SHALL 恰为 `{files}`，`files` 是按 `{path,kind,depth}` 严格解析的数组：`path` 为非空字符串，`kind ∈ {"instructions","system","agent"}`，`depth` 为非负安全整数；两个方法的响应体或任一元素缺键、多键、类型不符、错误枚举时整体拒绝；同一 same-origin、no-store、401 通知机制。
返回对象 SHALL 按公开 DTO 严格校验，不接受缺字段、多字段、错误枚举或非安全整数；消息时间戳和消息/步骤 ID SHALL 允许有符号安全整数，session 时间戳、epoch、非 null seq 和 ordinal SHALL 非负。会话、消息与步骤的 `status` 枚举 SHALL 同刀扩为含 `stopped`（会话 `idle|running|done|failed|stopped`，消息/步骤 `running|done|failed|stopped`）。消息 DTO 严格键集 SHALL 为 `{id,role,content,status,createdAt,steps,approvals}`：`approvals` 在每条消息上都存在且为数组，user 消息与无审批记录的 assistant 消息恒为 `[]`，assistant 消息的每个元素为 `{id,tool,title,requestedAt,expiresAt,decision}`（`id` 安全整数、`tool`/`title` 字符串、`requestedAt`/`expiresAt` 安全整数、`decision ∈ {"allow","deny","timeout",null}`），数组按 `id` 严格升序且 `id` 不重复；缺字段、多字段、错误枚举、非数组、乱序或重复 id 整体拒绝。服务端快照的 `approvals` 键与 `approval.*` 事件 SHALL 与本 web 解析同刀落地，不设兼容窗口（同仓同部署，无第三方消费者；严格键集使任一侧先合入都会让会话页整体失效）。`stopped` 枚举不在同刀之列，而是先解析后发出（web-parse-before-server-emit）：web 解析与 `status-label.ts` 的 `stopped: "已停止"` SHALL 先于服务端真正发出 `stopped`（`turn.end stopped` 与快照中的 `stopped` 状态）合入——服务端尚未发出时多接受一个枚举值无副作用，反之严格枚举会把含 `stopped` 的整个响应判为非法。会话 DTO 严格键集 SHALL 为十一键（s1g-composer-capabilities 起另加三键、共十四键，见下文「S1g 输入框能力」） `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt,archivedAt,pendingApproval,temporaryWorkspace}`（s1c 的八键加 s1f-session-list-temp-space 的三键；逐键规则见 session-sidebar「会话 DTO 严格解析」：`archivedAt` 为非负安全整数或 `null`，`pendingApproval` 与 `temporaryWorkspace` 为布尔）：`scene ∈ {"office","code","design",null}`，`workspaceId` 为 32 位小写十六进制字符串或 `null`，`pinnedAt` 为非负安全整数或 `null`（fork 产生的 `parent_session_id` 仍不进 DTO）；列表、`createSession`、`patchSession`、`forkSession` 与 `undoMessage` 的 `session` 共用该解析。消息 DTO 严格键集 SHALL 在上述基础上增 `thinking` 与 `undo`，即 `{id,role,content,status,createdAt,steps,approvals,thinking,undo}`：`undo` 在 assistant 消息上恒为 `null`、在 user 消息上为 `available|too_large|failed|command|unbound|none` 之一（message-undo「可撤回状态」），其它取值或 assistant 消息非 null 整体拒绝；`thinking` 为字符串或 `null`，user 消息恒为 `null`（非 null 整体拒绝）。步骤 DTO 严格键集 SHALL 增 `changes`（见 `步骤 args 与输出分栏`）：`changes` 为 `null` 或 1..50 个元素的数组，元素严格键集 `{path,added,removed,kind}`，`path` 为非空字符串，`kind:"edit"` 时 `added`/`removed` 为非负安全整数，`kind:"write"` 时二者为 `null`；空数组、未知 `kind`、`kind` 与计数类型不符、元素多余或缺失字段整体拒绝。会话 DTO、消息 `thinking` / `undo` 与步骤 `changes` SHALL 与服务端同刀落地，不设兼容窗口（理由同上：严格键集使任一侧先合入都会让会话页整体失效）。`getMessages` SHALL 保留完整正文、步骤（含字符串 `output`）、顺序和 `streamCursor:{epoch:number,seq:number|null}`，不得截断、过滤、规范化文本或将 null/缺失游标默认成 0。`getMessages` 的消息快照顶层键集 SHALL 恰为 `{session, messages, streamCursor, todo}`：`todo` 为 `null` 或归一化任务清单对象，按 session-todo `web 契约解析与归约` 校验并逐值保留；缺 `todo`、多键或 `todo` 结构不合规时整个快照按非法响应拒绝，不部分安装。四键快照解析 SHALL 与服务端四键快照同刀落地，不设兼容窗口（理由同上）。400/409/502/503 SHALL 保留 `ApiError` 的 status/code/message（含 prompt/regenerate/fork 的 503 `agent_capacity`、approvals 的 409 `approval_settled`、regenerate/fork 的 409 `session_busy` 与 400 `bad_request`、createSession/patchSession 的 400 `bad_request`、patchSession/deleteSession 与绑定不可访问空间的 createSession 的 404 `not_found`、deleteSession 的 409 `session_busy`），供页面按信封文案呈现；非法响应和网络异常 SHALL 使用既有不泄露响应内容的 request_failed 错误。

s1f-session-list-temp-space 起 `ApiClient` 另 SHALL：
- `patchSession(id, patch)` 的 `patch` 接受 `archived:boolean`（与 `title`、`scene`、`pinned` 同为可选键，非空子集）；
- `prompt(id, message)` 的 202 严格解析为 `{userMessageId, assistantMessageId, undo}`（两个安全整数与一个 user 消息的 `undo` 取值），缺 `undo` 或取值不合法视为无效响应；
- 提供 `undoMessage(id, messageId, files)`：POST `/api/sessions/:id/undo`，原样发送 JSON `{messageId, files}`（`files` ∈ `"restore"|"force"|"keep"`），200 返回严格解析的 `{session, draft, files, attachments}`——`session` 复用会话 DTO 解析，`draft` 为字符串（允许空串），`attachments` 与消息 DTO 的 `attachments` 同形（数组，元素恰为 `{path, size}`；被撤回消息的附件里撤回后仍存在的那些，message-undo「撤回 REST」），`files` 严格为 `{mode, restored, removed, skipped, failed}`（`mode` ∈ `"restored"|"kept"`；`restored`、`removed` 为非负安全整数；`skipped` 为 `{count, paths}`，`paths` 元素恰为 `{path, reason}`、`reason` ∈ `too_large|excluded|unreadable|special|name_encoding|mount`；`failed` 为 `{count, paths}`，`paths` 元素恰为 `{path}`；`count` 为不小于 `paths.length` 的非负安全整数）；
- 提供 `promoteWorkspace(id, name)`：POST `/api/workspaces/:id/promote`，原样发送 JSON `{name}`，200 返回严格解析的工作空间 DTO（既有五键）。

新方法沿用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制，路径 id 编码；409 `undo_conflict`、409 `session_archived`、409 `conflict` 与其它 4xx/5xx SHALL 保留 `ApiError` 的 status/code/message，供页面按 code 区分（`undo_conflict` 打开冲突对话框）。列表事件连接不经 `ApiClient` 的请求方法，见 session-list-push「web 列表事件消费」。
**S1g 输入框能力**。会话 DTO 的严格键集 SHALL 在上文十一键之上增加恰三键 `approvalMode`、`modelId`、`reasoningEffort`，共十四键：`approvalMode ∈ {"always-ask","write","yolo"}`，`modelId` 为非空字符串，`reasoningEffort` 为 `off|minimal|low|medium|high|xhigh|max` 之一或 `null`（七个强度名，`auto` 不在其内）；缺键、多键或取值不符整体拒绝（只有十一键的会话对象同样整体拒绝）。消息 DTO 的严格键集 SHALL 增加 `attachments`：数组，元素严格键集 `{path, size}`（`path` 为非空字符串、`size` 为非负安全整数），助手消息恒为 `[]`（非空整体拒绝）。`forkSession` 的响应严格键集为 `{session, draft, attachments}`；`undoMessage` 的 200 同样带 `attachments`（见上文该方法）。本条规定的是落地完成后的最终形状：这几处键集变化不与服务端同刀落地（上文各次「同刀落地、不设兼容窗口」的做法不适用于本次，落地次序属实施安排，见 change `s1g-composer-capabilities` 的 design D16），过渡期的放宽解析 SHALL NOT 留存。
**#909 失败对象**。消息 DTO 的严格键集 SHALL 在上述最终形状之上再增加 `error`，即 `{id,role,content,status,createdAt,steps,approvals,thinking,undo,attachments,error}`：`error` 在每条消息上都存在，为 `null` 或恰含四键的对象 `{reason,message,status,detail}`（upstream-failure「失败的公开形状」）——`reason` 与 `message` 为非空字符串，`status` 为 `null` 或 100–599 的整数，`detail` 为字符串（可为空串）；user 消息恒为 `null`。缺 `error` 键、对象缺键或多键、`status` 为字符串或越界、`detail` 非字符串、user 消息 `error` 非 null 时整个快照按非法响应拒绝，不部分安装。该键与服务端快照的 `error` 键同刀落地，不设兼容窗口（理由同上：严格键集使任一侧先合入都会让会话页整体失效；#909 design D18 组 7）。
**#910 思考时长**。消息 DTO 的严格键集 SHALL 在上述最终形状之上再增加 `thinkingMs`，即 `{id,role,content,status,createdAt,steps,approvals,thinking,undo,attachments,error,thinkingMs}`：`thinkingMs` 在每条消息上都存在，为 `null` 或非负安全整数（thinking-fold「思考时长记录与下发」）；user 消息恒为 `null`。缺 `thinkingMs` 键、取值为负数、非整数、非安全整数或字符串、user 消息 `thinkingMs` 非 null 时整个快照按非法响应拒绝，不部分安装。该键与服务端快照的 `thinkingMs` 键同刀落地，不设兼容窗口（理由同 #909）。
**#915 分段位置**。在上述最终形状之上，消息、步骤与审批的严格键集 SHALL 各再增加一键：
- 消息键集增 `thinkingSegments`，即 `{id,role,content,status,createdAt,steps,approvals,thinking,undo,attachments,error,thinkingMs,thinkingSegments}`：`thinkingSegments` 在每条消息上都存在且为数组（按服务端给出的次序逐值保留，即各段开始的次序），元素严格键集 `{bodyOffset,thinkingOffset,thinkingLength,stepsBefore,thinkingMs}`——`bodyOffset`、`thinkingOffset`、`stepsBefore` 为非负安全整数，`thinkingLength` 与 `thinkingMs` 为 `null` 或非负安全整数（含义见 thinking-fold「思考时长记录与下发」）；user 消息恒为 `[]`。
- 步骤键集增 `bodyOffset`，即 `{id,ordinal,name,detail,output,changes,status,bodyOffset}`：`null` 或非负安全整数（chat-stream「分段位置的记录与下发」）。
- 审批元素键集增 `stepId`，即 `{id,tool,title,requestedAt,expiresAt,decision,stepId}`：`null` 或安全整数（tool-approval「确认与步骤配对」）。`decideApproval` 的 200 返回同一七键形状。
缺键、多键、取值类型不符、负数、非安全整数、user 消息 `thinkingSegments` 非空时整个快照（或该响应）按非法响应拒绝，不部分安装。解析只校验形状；数值之间是否自洽（偏移是否越界、段是否首尾相接）不在解析层判定，由「助手消息分段」的旧布局判定处理。这三键与服务端快照、REST 与 `step.start` / `approval.request` / `thinking.end` 的新字段（「事件流消费与续流」）同刀落地，不设兼容窗口（理由同 #909；事件一侧更严：已知事件解析失败会触发重新同步，旧解析器遇到新字段会重新同步一次、再因快照多键而关闭事件流并报告）。
`createSession(input)` 的 input 另可含 `approvalMode`、`modelId`、`reasoningEffort`（取值域同上，`reasoningEffort` 不得为 `null`），与既有两键一样只发送所给的键。`patchSession(id, patch)` 的 `patch` 另可含这三键（同样不得为 `null`）。`prompt(id, message, options?)` 的 `options` 另可带 `attachments: string[]`：非空时 body 为 `{message, attachments}`，缺席或空数组时 body 仍恰为 `{message}`。`message` 原样发送，客户端不裁剪、不因它是空串而拒绝或省略该键（只发附件时即 `{"message":"","attachments":[…]}`；能不能发由输入框的启用条件与服务端决定）。
`ApiClient` SHALL 另提供两个方法。`getComposerOptions(options?)`：GET `/api/composer/options`，禁止缓存，200 返回严格解析的 `{approvalModes, models, defaults, upload}`——`approvalModes` 为上述三个取值的非空、不重复数组；`models` 为非空数组，元素严格键集 `{id, name, reasoning, vision, efforts, defaultEffort}`（`efforts` 为强度名数组，`defaultEffort` 为强度名或 `null`；强度名即上述七个，出现 `auto` 或其它字符串按非法响应处理）；`defaults` 严格键集 `{approvalMode, modelId, reasoningEffort}`；`upload` 严格键集 `{maxBytes, maxFiles}`（正安全整数）；任何不符整体拒绝。
`uploadFile(workspaceId, file, {signal?, onProgress?})`：POST `/api/workspaces/:id/uploads?name=<编码后的 file.name>`，`Content-Type: application/octet-stream`，请求体为该 `File` 本身（不读入内存、不封装 multipart）；201 返回严格解析的 `{path, name, size}`。它 SHALL 经 `XMLHttpRequest` 发送（`fetch` 没有上传进度），实现放在 `web/src/lib/` 的单独文件里并由 `api.ts` 注入 same-origin、错误信封解析、request_failed 构造与 401 通知——与其它方法共用同一套，不另行实现；`onProgress` 以 0 到 100 的整数百分比被调用（`lengthComputable` 为假时不调用）；`signal` 中止时调用 `abort()` 并以与其它方法相同的中止语义结束；非 2xx 按信封解析为 `ApiError`（含 413 `upload_too_large`、403 `sandbox_denied`、404、409 `conflict`、400），网络错误与非法响应为既有的 request_failed。
**S2c 知识库引用**（change `s2c-kb-session`）。消息 DTO 的严格键集 SHALL 在上述最终形状之上再增加 `knowledgeBases`，即 `{id,role,content,status,createdAt,steps,approvals,thinking,undo,attachments,knowledgeBases,error,thinkingMs,thinkingSegments}`：`knowledgeBases` 为数组，每项严格键集 `{id,name}`（两者非空字符串），助手消息 SHALL 为 `[]`；违反即整份快照解析失败。`prompt(id, message, options)` 的 options 可含 `knowledgeBases: string[]`，非空时 body 带该键，为空或缺省时 SHALL 省略该键。fork 与撤回应答的解析不变。

#### Scenario: 四方法请求与响应
- WHEN 调用四方法并收到服务端对应成功响应
- THEN 路径、HTTP 方法、body、凭证、signal、状态与类型化返回值符合上述合同，原始 prompt 文本和历史正文不变

#### Scenario: 完整快照边界
- WHEN 快照包含 NUL/BOM/Unicode 正文、零 ordinal、有符号消息时间戳和 `{epoch:1,seq:null}` 或 `{epoch:1,seq:0}`
- THEN 完整历史与游标逐值保留；缺失游标、非法嵌套项或额外私有字段则整体拒绝

#### Scenario: 四键快照与任务清单
- **WHEN** `getMessages` 收到恰含 `session`、`messages`、`streamCursor`、`todo` 四键的快照，`todo` 分别为 `null` 与 `{phases:[{name:"准备", tasks:[{content:"读取需求", status:"in_progress"}]}]}`；另收到只有 `session`、`messages`、`streamCursor` 三键的快照、四键之外多一个顶层键的快照，以及 `todo` 为 `{phases:[]}` 的快照
- **THEN** 前两者整体通过且 `todo` 逐值保留；后三者以不泄露响应内容的 request_failed 错误拒绝，不部分安装

#### Scenario: 信封和未登录
- WHEN prompt 返回 409 session_busy 或 502 agent_unavailable，或任一方法返回 401
- THEN 409/502 保留 code/message；401 无论合法、畸形或非 JSON 都沿用既有未登录通知，通知回调抛错不替代请求错误

#### Scenario: 原有客户端不回归
- WHEN 原有认证、工作空间、预览、审计 API 在共享校验抽取后运行
- THEN 既有成功形状、严格拒绝规则、signed workspace 时间戳、错误保密与预览资源生命周期不变

#### Scenario: 回合控制四方法请求与响应
- **WHEN** 分别调用 `stopSession`（服务端返回 202 与 204 两种）、`regenerateSession`（202 `{assistantMessageId}`）、`forkSession`（201 `{session, draft, attachments}`）与 `decideApproval(id, approvalId, "allow")`（200 已结算审批对象）
- **THEN** 路径分别为编码后的 `/api/sessions/:id/stop`、`/regenerate`、`/fork`、`/approvals/:approvalId`，HTTP 方法均为 POST，stop/regenerate 无 body，fork body 恰为 `{messageId}`、approvals body 恰为 `{decision}`；`stopSession` 202（body `{}`）解析为 `"stopping"`、204（无 body）解析为 `"idle"`，202 body 为 `{"x":1}` 或非 JSON 时按非法响应拒绝；其余返回值按合同严格类型化，`draft` 原文不变

#### Scenario: stopped 与 approval 字段严格解析
- **WHEN** 消息快照的会话/消息/步骤 status 为 `stopped`，assistant 消息 `approvals` 分别为 `[]`、单条 pending（`decision:null`）、以及按 id 升序的两条（`[{id:7,decision:"timeout"},{id:8,decision:null}]` 形状），user 消息 `approvals` 为 `[]`
- **THEN** 快照整体通过并逐值保留（数组顺序不变）；缺 `approvals` 键、`approvals` 为 null 或非数组、元素多余字段、`decision` 为未知字符串、元素 id 乱序或重复、user 消息 `approvals` 非空，或任一 status 为未知枚举时整体拒绝

#### Scenario: 新错误码信封
- **WHEN** prompt 或 regenerate 返回 503 `agent_capacity`，`decideApproval` 返回 409 `approval_settled`，regenerate/fork 返回 409 `session_busy` 或 400 `bad_request`
- **THEN** `ApiError` 保留对应 status/code/message，不改写为 request_failed，401 仍沿用既有未登录通知

#### Scenario: 会话元数据方法请求与响应
- **WHEN** 分别调用 `createSession()`、`createSession({workspaceId:"<32hex>", scene:"code"})`、`patchSession(id, {title:"周报", pinned:true})`（200 会话 DTO）与 `deleteSession(id)`（204）
- **THEN** 第一次 POST `/api/sessions` 无 body；第二次 body 恰为 `{"workspaceId":"<32hex>","scene":"code"}`；PATCH 路径为编码后的 `/api/sessions/:id`、body 恰为 `{"title":"周报","pinned":true}`、返回值为严格解析的会话 DTO；DELETE 路径相同、无 body、解析为 `undefined` 且不读取响应体；`patchSession(id, {})` 不发出请求
- **WHEN** PATCH 返回 400 `bad_request` 或 404 `not_found`，DELETE 返回 404 `not_found` 或 409 `session_busy`
- **THEN** `ApiError` 保留对应 status/code/message

#### Scenario: 八键会话与思考、变更字段严格解析
- **WHEN** 会话列表项为 `{…, scene:"design", workspaceId:"<32hex>", pinnedAt:1700000000000, archivedAt:null, pendingApproval:false, temporaryWorkspace:false, approvalMode:"yolo", modelId:"m3", reasoningEffort:"low"}`（十四键）与 `scene`、`workspaceId`、`pinnedAt`、`reasoningEffort` 皆 `null` 的项；快照中 assistant 消息 `thinking` 为 `"先想一想"` 与 `null`，user 消息 `thinking` 为 `null`；步骤 `changes` 为 `null` 与 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"},{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 整体通过并逐值保留；缺任一新键、`scene` 为未知字符串、`workspaceId` 非 32 位小写十六进制、`pinnedAt` 为负数或非安全整数、user 消息 `thinking` 非 null、`changes` 为 `[]`、`kind:"write"` 带数字计数或 `kind:"edit"` 计数为 null、变更元素多余字段时整体拒绝；仍为五键、八键或十一键的会话对象同样整体拒绝

#### Scenario: 命令目录方法
- **WHEN** 调用 `listCommands(null)`，服务端返回两条内建与一条 skill（`{name:"skill:weekly-report",label:"weekly-report",description:"写周报",hint:"可选参数",source:"skill",overrides:false}`）；另调用 `listCommands("<32 位十六进制 id>")`，服务端多返回一条 `source:"project"`、`overrides:true` 的条目；再调用 `listProjectConfig` 的两种形式
- **THEN** 前者路径为 `/api/commands`、后者为 `/api/commands?workspaceId=<id>`，方法 GET、无 body、no-store，返回值逐值保留且顺序不变；元素缺 `hint` 或 `overrides`、`hint` 为数字、`overrides` 为字符串、`source` 为 `"extension"` 或多余键时整体拒绝；`listProjectConfig` 的路径规则相同，元素 `kind` 为未知字符串、`depth` 为负数或多余键时整体拒绝；401 沿用既有未登录通知

#### Scenario: 撤回与转正方法
- **WHEN** 调用 `undoMessage(id, 42, "restore")`（服务端返回 200 `{session, draft:"原文", files:{mode:"restored",restored:1,removed:2,skipped:{count:1,paths:[{path:"big.bin",reason:"too_large"}]},failed:{count:0,paths:[]}}, attachments:[{path:"uploads/a.pdf",size:3}]}`）与 `promoteWorkspace(wsId, "调研资料")`（200 五键工作空间）
- **THEN** 前者为 POST 编码后的 `/api/sessions/:id/undo`、body 恰为 `{"messageId":42,"files":"restore"}`，返回值逐值保留；后者为 POST `/api/workspaces/:id/promote`、body 恰为 `{"name":"调研资料"}`，返回工作空间对象
- **WHEN** undo 返回 409 `undo_conflict` 或 409 `session_archived`；promote 返回 409 `conflict`
- **THEN** `ApiError` 保留对应 status/code/message，不改写为 request_failed
- **WHEN** undo 的 200 body 缺 `files`、缺 `attachments`、`attachments` 元素多一个键、`files.mode` 为 `"done"`、`skipped.paths` 元素多一个键，或 `session` 为旧的八键对象
- **THEN** 均按无效响应处理（request_failed），不部分采用

#### Scenario: prompt 的 202 带 undo
- **WHEN** `prompt(id, "你好")` 收到 202 `{userMessageId:7, assistantMessageId:8, undo:"available"}`；另一例收到不含 `undo` 的旧形状，或 `undo:"yes"`
- **THEN** 前者返回这三个值；后两者按无效响应处理

#### Scenario: 消息 undo 键严格解析
- **WHEN** 快照里 user 消息 `undo` 为 `"available"`、`"none"`，assistant 消息 `undo` 为 `null`；另一例 assistant 消息 `undo` 为 `"available"`、user 消息 `undo` 为 `null` 或缺该键
- **THEN** 前者整体通过并逐值保留；后者整体拒绝

#### Scenario: 三键与附件的严格解析
- **WHEN** 会话列表项在十一键之外带 `approvalMode:"yolo", modelId:"m3", reasoningEffort:"low"`，以及 `reasoningEffort:null`；消息快照的用户消息 `attachments` 为 `[{path:"uploads/a.pdf", size:3}]`、助手消息为 `[]`；fork 响应为 `{session, draft:"x", attachments:[]}`；另一例会话列表项只有十一键（不带三键）
- **THEN** 前三者全部通过并逐值保留；只有十一键的会话整体拒绝；缺 `approvalMode` / `modelId` / `reasoningEffort` 任一键、`approvalMode:"auto"`、`modelId:""`、`reasoningEffort:"ultra"`、`reasoningEffort:"auto"`、消息缺 `attachments`、`attachments` 为 `null`、元素多余字段或 `size` 为负、助手消息 `attachments` 非空、fork 响应缺 `attachments` 时整体拒绝

#### Scenario: 新输入与两个新方法
- **WHEN** 调用 `createSession({workspaceId:"<32hex>", approvalMode:"always-ask", modelId:"m3", reasoningEffort:"low"})`、`patchSession(id, {approvalMode:"yolo"})`、`prompt(id, "看看", {attachments:["uploads/a.pdf"]})`、`prompt(id, "看看", {attachments:[]})`、`prompt(id, "", {attachments:["uploads/a.pdf"]})`、`getComposerOptions()`
- **THEN** body 分别恰为所给四键的 JSON、`{"approvalMode":"yolo"}`、`{"message":"看看","attachments":["uploads/a.pdf"]}`、`{"message":"看看"}`、`{"message":"","attachments":["uploads/a.pdf"]}`；`getComposerOptions` 为禁止缓存的 GET `/api/composer/options`，合法响应逐值返回，`approvalModes` 为空、`models` 元素缺 `defaultEffort`、`models` 元素的 `efforts` 含 `auto` 或 `upload.maxFiles` 为 0 时按非法响应处理

#### Scenario: 上传传输
- **WHEN** 以可控的 `XMLHttpRequest` 替身调用 `uploadFile("<32hex>", <名为 `报告 1.pdf` 的 File>, {signal, onProgress})`，替身依次报告已发送一半与全部、随后 201 `{path:"uploads/报告 1.pdf", name:"报告 1.pdf", size:10}`；另一例响应 413 信封；另一例在途中止 `signal`；另一例响应 401
- **THEN** 请求为 POST `/api/workspaces/<32hex>/uploads?name=%E6%8A%A5%E5%91%8A%201.pdf`，`Content-Type` 为 `application/octet-stream`，请求体就是该 `File` 对象；`onProgress` 依次收到 50 与 100；返回值逐值等于响应；413 的一例以 `ApiError`（status 413、code `upload_too_large`、message `文件超过大小上限`）拒绝；中止的一例替身的 `abort()` 被调用且 Promise 以中止结束、不触发 401 通知；401 的一例触发与其它方法相同的未认证通知

#### Scenario: 消息 error 键严格解析
- **WHEN** 快照里 user 消息 `error` 为 `null`；assistant 消息 `error` 分别为 `null`、`{reason:"auth_failed",message:"鉴权失败：模型服务拒绝了配置的 API 密钥",status:401,detail:"401 bad key"}` 与 `{reason:"upstream_timeout",message:"上游超时：模型服务没有及时响应",status:null,detail:""}`
- **THEN** 快照整体通过并逐值保留
- **WHEN** 另一例消息缺 `error` 键；或 assistant 消息 `error` 对象多一个键或缺 `detail`；或 `status` 为 `"401"`、`700` 或 `401.5`；或 `detail` 为 `null`；或 `reason` 为空串；或 user 消息 `error` 为上述合法对象
- **THEN** 均以不泄露响应内容的 request_failed 错误整体拒绝，不部分安装

#### Scenario: 消息 thinkingMs 键严格解析
- **WHEN** 快照里 user 消息 `thinkingMs` 为 `null`；assistant 消息 `thinkingMs` 分别为 `null`、`0` 与 `61500`
- **THEN** 快照整体通过并逐值保留
- **WHEN** 另一例消息缺 `thinkingMs` 键；或 assistant 消息 `thinkingMs` 为 `-1`、`1.5`、`"1500"` 或 `2**53`；或 user 消息 `thinkingMs` 为 `0`
- **THEN** 均以不泄露响应内容的 request_failed 错误整体拒绝，不部分安装

#### Scenario: 分段位置三键严格解析
- **WHEN** 快照里一条 assistant 消息 `thinkingSegments` 为 `[{bodyOffset:0,thinkingOffset:0,thinkingLength:4,stepsBefore:0,thinkingMs:1400},{bodyOffset:12,thinkingOffset:4,thinkingLength:null,stepsBefore:1,thinkingMs:null}]`，其步骤 `bodyOffset` 为 `12`，其审批 `stepId` 为该步骤 id；另一条 assistant 消息的 `thinkingSegments` 为 `[]`、步骤 `bodyOffset` 为 `null`、审批 `stepId` 为 `null`；user 消息 `thinkingSegments` 为 `[]`
- **THEN** 快照整体通过并逐值保留（段的次序不变）
- **WHEN** 另一例消息缺 `thinkingSegments` 键；或段元素多一个键、`bodyOffset` 为 `-1`、`thinkingLength` 为 `"4"`、`stepsBefore` 为 `null`；或步骤缺 `bodyOffset`、`bodyOffset` 为 `1.5`；或审批缺 `stepId`、`stepId` 为字符串；或 user 消息 `thinkingSegments` 非空
- **THEN** 整个快照以不泄露响应内容的 request_failed 错误拒绝，不部分安装

#### Scenario: 知识库引用的解析与发送
- **WHEN** 快照的用户消息带 `knowledgeBases:[{id:"k1",name:"产品文档"}]`；另一份快照的某条消息缺 `knowledgeBases`、元素多一个键，或助手消息带非空 `knowledgeBases`
- **THEN** 前者解析成功并保留该数组；后三者整份快照解析失败
- **WHEN** 以 `knowledgeBases:["k1"]` 与 `knowledgeBases:[]` 各调用一次 `prompt`
- **THEN** 前者 body 为 `{message, knowledgeBases:["k1"]}`，后者 body 不含 `knowledgeBases` 键

### Requirement: 工具段摘要与折叠
web SHALL 用一个纯函数（「会话页源码模块划分」的 `tool-summary.ts`）由工具段的步骤生成摘要文字。每个步骤按步骤名（精确匹配，区分大小写）归入一类：

| 类 | 步骤名 | 单位 |
|---|---|---|
| 执行命令 | `bash`、`eval` | `执行 N 条命令` |
| 读取 | `read` | `读取 N 个文件` |
| 新建 | `write` | `新建 N 个文件` |
| 修改 | `edit`、`ast_edit` | `修改 N 个文件` |
| 搜索 | `grep`、`glob`、`ast_grep`、`web_search`、`search`、`find` | `搜索 N 次` |
| 其它 | 其余任何名字 | `其它 N 步` |

N 是该类的步骤数（按步骤计，一次 `read` 读多个文件也记 1）。`kb_search` 步骤不进工具段（「助手消息分段」），所以不出现在任何摘要里。摘要 SHALL 为各非零类按上表次序以 `、` 连接；段内有 `failed` 步骤时末尾接 `，N 步失败`（N 为失败步骤数）；段内有 `running` 步骤时再接 `，进行中`。`stopped` 步骤照常计入其类，不另加后缀。摘要是工具段展开/收起控件的可见文本与可访问名；失败后缀与其余文字同色（不着色）：它与摘要其余文字在同一个文本元素里，该元素与后缀都不带任何颜色类。段内有 `running` 步骤时控件另带转圈图标与流光（`prefers-reduced-motion: reduce` 下静止），与 #910 之前的运行中样式相同。

**折叠**：每个工具段 SHALL 在首次出现时为收起态，无论其中有没有 `failed` 步骤，也无论消息是否在运行；此后只有用户点击控件才改变它的展开态：步骤的开始与结束（含新的失败步骤）、新到的正文与思考、快照的原地重新安装都 SHALL NOT 改变它。展开一个工具段不影响同一消息或其它消息的其它工具段。展开态以「助手消息分段」的块键为身份保留：同一工具段因新步骤并入而增长时保留展开态；新回合（turn.start 清空步骤）之后出现的工具段从收起态开始。

**对话内搜索（owner 2026-10-06 B8：保持现状）**：搜索的匹配范围、计数、跳转与高亮仍按 conversation-search，不因分段而变：只比对消息的 `content`，步骤的 detail/output 与深度思考不参与匹配；正文段从不收起，所以命中的文字总在可见的正文段里；跳转只滚动到消息并高亮其根元素，SHALL NOT 展开或收起任何工具段与思考折叠块。

#### Scenario: 归类计数与次序
- **WHEN** 一个工具段的步骤依次为 `read`、`bash`、`read`、`todo`、`bash`、`grep`、`bash`，全部 `done`
- **THEN** 摘要为 `执行 3 条命令、读取 2 个文件、搜索 1 次、其它 1 步`
- **WHEN** 步骤为 `edit`、`ast_edit`、`write`、`search`、`find`、`web_search`、`eval`、`task`
- **THEN** 摘要为 `执行 1 条命令、新建 1 个文件、修改 2 个文件、搜索 3 次、其它 1 步`

#### Scenario: 失败与进行中后缀
- **WHEN** 一个工具段为 `bash`(failed)、`bash`(done)、`read`(running)
- **THEN** 摘要为 `执行 2 条命令、读取 1 个文件，1 步失败，进行中`，控件带转圈图标；`read` 结束为 `done` 后摘要为 `执行 2 条命令、读取 1 个文件，1 步失败`，转圈图标消失；`，1 步失败` 与摘要其余文字在同一个文本元素里，不单独成元素，该元素不带颜色类（`text-*` 颜色工具类）

#### Scenario: 展开态只随用户点击变化
- **WHEN** 一条 running 助手消息有两个工具段，用户展开第一个；随后第二个工具段里一个步骤以 `failed` 结束、又并入一个新步骤（偏移单调，新步骤只会并入最后一个工具段）；再随后快照原地重新安装（内容不变）
- **THEN** 第一个工具段始终为展开态，第二个始终为收起态；之后用户收起第一个，它保持收起直到下次点击

#### Scenario: 对话内搜索不改变段的展开态
- **WHEN** 一条 done 助手消息切段为正文段 `先看一下。`、工具段 [`bash`]（收起，其 output 含 `needle`）、思考段（收起，原文含 `needle`）、正文段 `看完了。`；用户打开对话内搜索，先输入 `needle`，再改为 `看完`
- **THEN** 输入 `needle` 时计数器为 `0/0`，工具段与思考折叠块仍收起；输入 `看完` 时计数器为 `1/1`，该消息根元素带 `aria-current="true"` 并滚动入视，工具段与思考折叠块仍收起

## ADDED Requirements

### Requirement: 会话知识库检索卡
检索块（「助手消息分段」）SHALL 渲染为一张「知识库检索」卡，是 `web/src/features/chat/` 内的应用层组件。

**卡头**：
- 图标、标题 `知识库检索`，其后接 ` · ` 与各轮 `kbHits` 里状态为 `ok` 的库名（去重、按首次出现次序，以 `、` 连接；没有时不接）。
- 轮数 `（<n> 轮）`，n 为块内步骤数。
- 状态：任一步骤 `running` 为 `检索中`；否则全部失败为 `检索失败`；其余为 `检索完成`。

**行**：块内每个步骤一行，按块内次序。
- 行首为 `第 <k> 轮`。
- 其后是意图：`kbHits.intent` 非空时用它，否则用步骤 detail（`{"question":…}` 形式的 JSON）里的 `question`，两者都取不到时为空。
- `kbHits` 非空时，接 `命中 <m> 条`（m 为各库 `hits` 的条数之和）。
- 行状态取步骤状态。该步骤有已配对的审批时（只在 `always-ask` 档出现），行状态之前按「步骤卡的确认标记」同一规则显示 `超时自动允许` 或 `已拒绝`，卡收起时也可见；这些审批同样不渲染为兜底确认记录。
- 有 `kbHits` 的行可以展开：按库列出状态不是 `ok` 的说明（`未找到该知识库`、`正在重建，本轮未检索`、`检索失败`）与 `ok` 的命中，每条命中显示文档名、相似度（保留两位小数）与切片原文；切片原文按纯文本呈现。
- 没有 `kbHits` 的行不可展开。快照恢复的行即如此（chat-stream「检索结果事件发布」）。

**交互**：
- 卡首次出现时行全部收起，只随用户点击变化；展开态以块键为身份保留，与工具段同一规则（「工具段摘要与折叠」）。
- 卡里没有「评估证据是否充分」与「采纳切片」两步。宿主侧没有它们的来源（ADR-0017）。

#### Scenario: 实时两轮
- **WHEN** 一个回合依次收到两个 `kb_search` 步骤的 step.start、kb.hits（第一轮 `intent:"查规则"`，库 `产品文档` 命中 2 条；第二轮 `intent:null`、detail 的 `question` 为 `工单超时 详细说明`，命中 1 条）与 step.end
- **THEN** 一张卡，卡头为 `知识库检索 · 产品文档`、`（2 轮）`、`检索完成`；第一行 `第 1 轮`、`查规则`、`命中 2 条`；第二行 `第 2 轮`、`工单超时 详细说明`、`命中 1 条`；展开第一行列出两条命中的文档名、相似度与原文

#### Scenario: 刷新后只剩各轮
- **WHEN** 同一回合结束后刷新页面
- **THEN** 仍是一张卡、两行；行里显示各自 detail 的 `question` 与状态，没有命中条数，行不可展开

#### Scenario: 检索行的确认标记
- **WHEN** `always-ask` 档的一个回合有两个 `kb_search` 步骤，其审批的 `decision` 分别为 `deny` 与 `timeout`
- **THEN** 第一行行状态之前有 `已拒绝`，第二行有 `超时自动允许`；消息内没有兜底确认记录

#### Scenario: 部分失败与检索中
- **WHEN** 第一轮的 kb.hits 为一个 `failed` 的库与一个 `ok` 命中 0 条的库；第二轮的步骤仍为 `running`
- **THEN** 卡头状态为 `检索中`；第一行为 `命中 0 条`，展开后先列出 `检索失败` 的库，再列出命中 0 条的库
