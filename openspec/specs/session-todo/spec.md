# session-todo Specification

## Purpose
会话任务清单：助手用 omp 的 `todo` 工具维护的全量清单如何被取出、校验归一、按会话持久化、经事件流与快照送到页面，以及页面在输入框上方的只读面板里如何呈现它。

## Requirements

### Requirement: 任务清单来源与归一化
会话的任务清单 SHALL 只有一个来源：omp `todo` 工具结果里的全量清单。纯归约器（chat-stream `纯协议事件归约`）SHALL 只对已知 running 调用的 `tool_execution_end` 取候选，且仅当该调用在 `tool_execution_start` 登记的工具名恰为 `todo`（结束帧自带的 `toolName` 不参与判定）、帧与结果都未标记失败（`isError` 与 `result.isError` 均不为 `true`；omp v18.0.10 在失败结果里带的是操作前的旧清单，不得采用）、`result` 与 `result.details` 都是普通对象且 `details` 有自有属性 `phases` 时；此时归约器 SHALL 在该调用的 `step.end` 之前、同一返回结果中紧邻输出一条候选 `todo.updated{messageId, todo:<details.phases 原值>}`。归约器无 IO、不校验、不归一化、不保存清单状态；读取 SHALL 只读自有属性、不访问对象原型。`details` 的其它键（`op`、`storage`、`completedTasks` 等）SHALL 不被读取。其它工具名、失败的 `todo` 调用、没有 `phases` 的 `todo` 结果 SHALL 不产生候选。`/todo …` 斜杠命令只产生 `command_output` 帧、不产生工具帧，SHALL 不产生候选（面板要到下一次 `todo` 工具结果才更新；本 change 不调用 `get_state`，不补读）。本 change 不处理 omp 的其它 todo 帧。

SessionSupervisor 的有序持久化路径 SHALL 在落库前用一个无 IO 的纯函数对候选做结构校验与归一化（归约器输出的原值 SHALL NOT 出现在 SSE、快照或 `chat_sessions.todo` 中）：

1. 结构校验（只读自有属性）：候选 SHALL 是数组；每个元素 SHALL 是普通对象，`name` 为字符串、`tasks` 为数组；`tasks` 的每个元素 SHALL 是普通对象，`content` 为字符串、`status` ∈ `pending|in_progress|completed|abandoned|blocked`。`blocker` 与其它多余键 SHALL 被忽略、不参与校验。任一处缺字段、类型不对或 `status` 不在五值之内时，SHALL 丢弃这一帧的整条候选：不落库、不发布、不占 ring 序号、已落库的清单保持不变，并记恰一条 warn 级日志（经可注入的 warn sink 输出；日志不含任务文本；该丢弃不是基础设施故障，SHALL NOT 进入 supervisor 的 owned error sink，也不影响关停结果）。丢弃 SHALL 不影响该调用的 `step.end`、其它事件与回合终态。
2. 归一化：输出 `{phases:[{name, tasks:[{content, status}]}]}`，键恰为这些且按此次序；`status` 五值原样；`blocker` SHALL NOT 下发。`name` 与 `content` 各只保留前 200 个 Unicode 码点（不拆分代理对、不追加任何截断标记）；不超过 200 码点的值原样保留。
3. 上限：按阶段次序、阶段内任务次序计数，只保留前 200 个任务，其余任务丢弃（不记录被丢弃的数量）。
4. 截掉之后没有任务的阶段（含原本 `tasks` 为空的阶段）SHALL 不输出；全部阶段都没有任务（含 `phases` 为空数组）时归一结果为 `null`。因此非 null 的清单恒有 1..200 个阶段、每个阶段至少一个任务、任务总数 1..200。

#### Scenario: 合法结果归一化
- **WHEN** 已知 `todo` 调用成功结束，`result.details` 为 `{op:"done", phases:[{name:"准备", tasks:[{content:"读取需求", status:"completed"},{content:"列出要点", status:"in_progress", note:"x"}]},{name:"交付", tasks:[{content:"输出结论", status:"blocked", blocker:"等待评审"}]}], storage:"session", completedTasks:[{phase:"准备", content:"读取需求"}]}`
- **THEN** 归约器的返回结果为 `todo.updated{messageId, todo:<该 phases 原值>}` 紧接该调用的 `step.end`（`step.end` 的 output 不含 details）；归一化结果恰为 `{phases:[{name:"准备", tasks:[{content:"读取需求", status:"completed"},{content:"列出要点", status:"in_progress"}]},{name:"交付", tasks:[{content:"输出结论", status:"blocked"}]}]}`，其中没有 `blocker`、`note`、`op`、`storage`、`completedTasks`

#### Scenario: 失败调用、其它工具与命令输出不产生候选
- **WHEN** `todo` 调用以帧 `isError:true` 结束且 `details.phases` 为合法清单；`todo` 调用以 `result.isError:true` 结束；`todo` 调用成功但 `details` 为数组、缺失或没有自有 `phases`（只存在于原型上）；以 `bash` 登记的调用成功结束且 `details.phases` 为合法清单；回合收到 `command_output{text:"…"}`（`/todo append 买菜` 的输出）
- **THEN** 以上均不产生 `todo.updated`；已知调用只输出其 `step.end`，`command_output` 只按既有规则成为正文，已落库的清单不变

#### Scenario: 结构不合规整帧丢弃
- **WHEN** 会话已落库清单 T，随后 `todo` 调用成功结束，其 `details.phases` 分别为：`[{name:"A", tasks:[{content:"a", status:"done"}]}]`（未知 status）；`{name:"A"}`（不是数组）；`[{name:"A", tasks:[{status:"pending"}]}]`（缺 `content`）；`[{name:7, tasks:[]}]`（`name` 类型不对）；`[{name:"A", tasks:[{content:"a", status:"pending"}, null]}]`（任务不是对象）
- **THEN** 每一种都不发布 `todo.updated`、不占 ring 序号、`chat_sessions.todo` 仍为 T，各记恰一条不含任务文本的 warn 日志，owned error sink 未被调用；该调用的 `step.end{status:"done"}` 照常落库与发布，回合照常以 `turn.end{status:"done"}` 结束

#### Scenario: 码点截断
- **WHEN** 合法清单里一个阶段的 `name` 为 201 个码点且第 200、201 个码点都是星平面字符（各占两个 UTF-16 码元），一个任务的 `content` 恰为 200 个码点，另一个任务的 `content` 为 5000 个 `a`
- **THEN** 归一化后该 `name` 为原值的前 200 个码点（400 个 UTF-16 码元，末尾没有孤立代理，也没有 `…` 或其它标记），200 码点的 `content` 原样保留，5000 个 `a` 的 `content` 为 200 个 `a`

#### Scenario: 201 个任务只留前 200 个
- **WHEN** 合法清单为三个阶段：`P1` 含 150 个任务 `t1..t150`，`P2` 含 51 个任务 `t151..t201`，`P3` 含 3 个任务 `t202..t204`
- **THEN** 归一化结果恰有两个阶段：`P1` 含 `t1..t150`，`P2` 含 `t151..t200`（共 200 个任务、次序与原序一致）；`t201` 与整个 `P3` 不出现

#### Scenario: 全空归一为 null
- **WHEN** 合法候选分别为 `[]`、`[{name:"A", tasks:[]}]`、`[{name:"A", tasks:[]},{name:"B", tasks:[]}]`（例如 `op:"rm"` 之后），以及 `[{name:"A", tasks:[]},{name:"B", tasks:[{content:"b", status:"pending"}]}]`
- **THEN** 前三种的归一结果为 `null`；第四种为 `{phases:[{name:"B", tasks:[{content:"b", status:"pending"}]}]}`（空阶段 `A` 不输出）

### Requirement: 任务清单持久化
迁移 `036`（chat-sessions `迁移 036 任务清单列`）SHALL 给 `chat_sessions` 增加可空的 `todo` 列，存归一化清单的 JSON 文本；SQL NULL 表示没有清单。归一结果非 null 时列值 SHALL 是 `{"phases":[{"name":…,"tasks":[{"content":…,"status":…}]}]}` 形状的紧凑 JSON 文本，键次序固定为 `phases`；`name`、`tasks`；`content`、`status`；归一结果为 `null` 时列值 SHALL 为 SQL NULL。

写入 SHALL 走与其它事件相同的有序持久化路径（chat-sessions `Supervisor ordered persistence and publication`）：候选事件按帧到达次序处理，先落库后发布，位于该调用 `step.start` 之后、`step.end` 之前。归一结果与该会话行当前已落库的值相同（同为 null，或 JSON 文本逐字相同）时 SHALL 不写库、不发布。写入 SHALL 只改 `todo` 一列：`updated_at`、`status`、`title` 及其它列不变（任务清单更新不改变会话列表次序）；写不到恰一行即为失败。落库失败 SHALL 不发布该事件、不推进 ring 序号，并沿既有 owned error-sink 路径处理。

`chat_sessions.todo` SHALL 只由两条路径写入：这条有序持久化路径，以及撤回的最终事务（message-undo「对话原地回退」第 5 步——把该列置为被撤回消息快照行里存的那份原文或 NULL，与删除消息行、改写 `omp_session_file` 同一事务；它不走事件路径、不发布 `todo.updated`，页面靠撤回之后的快照重读得到新值）。会话创建时为 NULL。prompt 受理之后、派发之前的快照步骤（workspace-snapshots「受理时做快照」）SHALL 只**读**该列一次，把原文抄进该用户消息的快照行，SHALL NOT 写它；prompt 的受理事务与补偿、回合终态结算、启动对账、关停、元数据 PATCH（含归档）均 SHALL NOT 读写它。分叉得到的新会话 SHALL 为 NULL（fork 事务的显式列插入不拷贝 `todo`）。重新生成 SHALL NOT 清空或改写它（清单是 omp 会话状态，下一次 `todo` 工具结果会覆盖）。回合以 `failed` 或 `stopped` 结束、进程被回收或重启后，已落库的值 SHALL 保持。会话行删除时随之消失。本 change SHALL NOT 为清单新增 REST 端点，也 SHALL NOT 调用 omp 的 `get_state` 来补读或对账清单。

#### Scenario: 落库后发布且只改一列
- **WHEN** 真实 fake-omp（`todo` 场景）的第一轮回合在一个 `todo` 列为 NULL 的会话上结束；另在持久化路径的单元 seam 上对一个已有行单独执行一次清单写入
- **THEN** `chat_sessions.todo` 的文本恰为 `{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}`；ring 中该回合的事件次序为 `turn.start`、`step.start`、`todo.updated`、`step.end`、`text.delta`…、`turn.end`，`todo.updated` 在该列提交之后发布；单独那次清单写入前后，该行除 `todo` 外的所有列（含 `updated_at`、`status`、`title`）逐值不变

#### Scenario: 落库失败不发布
- **WHEN** 写入 `chat_sessions.todo` 在 SQLite 中失败
- **THEN** 没有 `todo.updated` 进入 ring，ring 序号不因它推进，失败沿既有 owned error-sink 路径处理

#### Scenario: 快照步骤只读、撤回写回
- **WHEN** 会话已落库清单 T1 时受理一条 prompt u2（快照步骤执行），该回合把清单变成 T2 后结束；随后所有者撤回 u2
- **THEN** 受理之后、回合的第一条 `todo` 工具结果之前，`chat_sessions.todo` 仍逐字为 T1（快照步骤没有写它），u2 的快照行 `todo` 列与 T1 的存储文本逐字相同；撤回提交后该列逐字为 T1，撤回没有向任何事件环发布 `todo.updated`；另一例受理时清单为 NULL，撤回后该列为 SQL NULL

#### Scenario: 分叉为空、重新生成与终态不清空
- **WHEN** 一个已落库清单 T 的 done 会话被分叉（真实 fake `branch`）；另一个已落库清单 T 的会话执行重新生成；另一个已落库清单 T 的会话其后一轮回合以 `stopped` 或 `failed` 结束；另一个已落库清单 T 的 running 会话经历服务重启与启动对账
- **THEN** 分叉得到的新会话 `todo` 列为 NULL、其快照 `todo` 为 `null`，源会话仍为 T；重新生成的最终事务提交后该会话 `todo` 仍为 T；`stopped`/`failed` 结算与启动对账之后仍为 T

### Requirement: todo.updated 事件
会话事件联合 SHALL 包含经 supervisor 发布的 `todo.updated`，`data` 严格为 `{messageId, todo}`：`messageId` 是当前回合的助手消息数字 id（与所有既有事件一致，续流与未知回合判定不为它开特例）；`todo` 是归一化清单对象 `{phases:[{name, tasks:[{content, status}]}]}` 或 `null`（清单被清空）。它 SHALL 在 `chat_sessions.todo` 提交之后发布，且仅当归一结果与上一次落库值不同；与上一次落库值相同 SHALL 不发布、不占 ring 序号。

`todo.updated` SHALL 是普通 ring 事件：进入该回合 generation 的同一 RingBuffer、消费一个正常 `<epoch>:<seq>` id，受既有保留、`min−1` 回放、`replay.gap` 与「从活跃 turn.start 起刷新」规则约束，SSE 以 `event:todo.updated` 投递，ring 与 SSE 端点无特殊处理。它 SHALL 不改变 `turn.end` 的顺序约束：属于该回合者均在该回合 `turn.end` 之前发布。只看快照的客户端与消费全部事件的客户端 SHALL 得到相同的清单。

#### Scenario: 首次清单发布一条事件
- **WHEN** 真实 fake-omp（`todo` 场景）在 `todo` 为 NULL 的会话上跑第一轮回合，助手消息 id 为 M
- **THEN** SSE 订阅者恰收到一条 `event:todo.updated`，其 `data` 为 `{"messageId":M,"todo":{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}}`，id 为正常的 `<epoch>:<seq>`，位于该回合 `step.start` 与 `step.end` 之间

#### Scenario: 连续两次相同的清单只发一条事件
- **WHEN** 同一会话接着跑第二轮回合（`todo` 场景第二轮的工具结果 `details.phases` 与第一轮逐值相同），再跑第三轮回合（第三轮把 `读取需求` 置为 `completed`、`列出要点` 置为 `in_progress`）
- **THEN** 第二轮不发布 `todo.updated`，其 `step.start` 与 `step.end` 的 ring 序号相邻；第三轮恰发布一条 `todo.updated`，`todo.phases[0].tasks` 为 `[{content:"读取需求",status:"completed"},{content:"列出要点",status:"in_progress"}]`；三轮合计恰两条 `todo.updated`

#### Scenario: 清空发布 null
- **WHEN** 会话已落库非空清单，随后一条合法候选归一为 `null`；之后又一条合法候选归一为 `null`
- **THEN** 第一条发布 `todo.updated{messageId, todo:null}` 且 `chat_sessions.todo` 为 SQL NULL；第二条不发布

#### Scenario: 续流与刷新
- **WHEN** 客户端以 `todo.updated` 前一条事件的 id 作为 `Last-Event-ID` 重连；另一客户端在该回合仍在跑时不带游标连接
- **THEN** 前者按既有回放规则恰收到一次该 `todo.updated` 及其后继；后者从保留的活跃 `turn.start` 起回放并包含该 `todo.updated`；之后取得的快照 `todo` 与事件里的值相同

### Requirement: 任务清单快照
`GET /api/sessions/:id/messages` 的响应 SHALL 恰有四个顶层键 `session`、`messages`、`streamCursor`、`todo`。`todo` SHALL 为该会话 `chat_sessions.todo` 列解析后的归一化清单对象（`{phases:[{name, tasks:[{content, status}]}]}`），列为 NULL 时为 `null`；列里的文本解析不出来、或解析结果不符合归一化清单的结构时（带内唯一的写者只写归一化结果，这种值只可能来自带外改库）同样 SHALL 为 `null`，快照照常返回、不因此失败，读取不改写该列；它与消息树、`streamCursor` 在同一次 owner-scoped 读取与同一 preParsing 栈内取得（chat-sessions `会话 REST`），使快照里的清单与游标边界一致。会话视图的键集由 session-metadata「会话视图扩展键」规定（本条不复述键数）：`todo` SHALL NOT 进入任何会话视图——会话列表、创建、PATCH、fork 与 undo 响应的 `session`，以及快照自己的 `session`。服务端的四键快照与 web 的四键解析（本能力 `web 契约解析与归约` 的快照部分）SHALL 同刀落地，不设兼容窗口（严格键集使任一侧先合入都会让会话页整体失效）。

#### Scenario: 无清单的会话
- **WHEN** 账号新建会话后读取其消息快照；另一个账号读取该会话
- **THEN** 前者返回 200，响应体恰有 `session`、`messages`、`streamCursor`、`todo` 四键且 `todo` 为 `null`；后者返回与未知 id 相同的 404，不暴露清单

#### Scenario: 清单随快照返回
- **WHEN** 真实 fake-omp（`todo` 场景）的第一轮回合结束后读取快照，随后重启服务再读取一次
- **THEN** 两次的 `todo` 都恰为 `{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}`；`GET /api/sessions` 的列表项与快照的 `session` 键集恰为 session-metadata「会话视图扩展键」规定的会话视图键集、不含 `todo`

#### Scenario: 存量坏值降级为 null
- **WHEN** 某会话的 `chat_sessions.todo` 被带外改成 `{not json`；另一例改成合法 JSON 但结构不合规（`{"phases":"x"}`）；其属主分别读取消息快照
- **THEN** 两例都返回 200，四键齐全且 `todo` 为 `null`，`messages` 与 `streamCursor` 与该列为 NULL 时相同；读取之后该列的值没有被改写

### Requirement: web 契约解析与归约
`web/src/lib/session-contract.ts` 的 `parseMessageSnapshot` SHALL 改为四键严格：响应体的键集恰为 `{session, messages, streamCursor, todo}`，缺 `todo`、多键或其它三键不合规时返回 `null`。`todo` SHALL 为 `null` 或严格键集 `{phases}` 的对象：`phases` 为 1..200 项的数组，每项严格键集 `{name, tasks}`，`name` 为不超过 200 个码点的字符串，`tasks` 为至少一项的数组，每项严格键集 `{content, status}`，`content` 为不超过 200 个码点的字符串，`status` ∈ `pending|in_progress|completed|abandoned|blocked`；全部阶段的任务总数不超过 200。缺字段、多字段（含 `blocker`）、错误枚举、空 `phases`、空 `tasks`、超长字符串、任务总数超限或非对象 SHALL 使整个快照解析为 `null`，即沿用契约对非法快照的既有失败方式：`getMessages` 以不泄露响应内容的 `request_failed` 错误拒绝，页面按既有的历史加载失败呈现，不部分安装。

`web/src/features/chat/stream.ts` 的事件联合、解码与归约 SHALL 加入 `todo.updated`：按严格键集 `{messageId, todo}` 解码，`messageId` 为安全整数，`todo` 的规则同快照的 `todo`（含 `null`）；它与其它数据事件经同一游标过滤，已知事件的非法 payload/id 照既有规则触发重新同步。`ChatState` SHALL 增 `todo`（归一化清单或 `null`）：`chatStateFromSnapshot` 取快照原值；`applyChatEvent` 对 `todo.updated` 把 `ChatState.todo` 整体替换为事件的 `todo`，不补建消息、不改任何消息、步骤与会话状态（`messages` 保持同一引用）；新值与当前值深相等时 SHALL 返回原状态（同一引用）。`turn.start`、`turn.end`、`error` 及其它事件 SHALL NOT 重置或改动 `todo`（清单属于会话，不属于某条消息）。`todo.updated` 的 `messageId` 不在当前视图里时，其处理 SHALL 与其它事件相同：由 chat-web `未知回合触发重新同步` 的既有判定决定是请求 `resync()` 还是交给归约器，不为它开特例。

快照四键解析 SHALL 与服务端四键快照同刀落地（本 change 的任务清单后端分片）；事件解码、归约、`ChatState.todo` 与面板在其后的 web 分片落地，其间 web 按「未知事件类型忽略」的既有规则忽略 `todo.updated`，快照里的 `todo` 被解析与校验但尚不呈现。

#### Scenario: 四键严格解析
- **WHEN** `parseMessageSnapshot` 分别收到：合法的四键对象且 `todo` 为 `null`；合法的四键对象且 `todo` 为 `{phases:[{name:"准备", tasks:[{content:"读取需求", status:"in_progress"}]}]}`；只有 `session`、`messages`、`streamCursor` 三键的对象；四键之外多一个 `extra` 键的对象
- **THEN** 前两者返回带对应 `todo` 的快照；后两者返回 `null`，`getMessages` 以 `request_failed` 拒绝

#### Scenario: 非法 todo 结构整体拒绝
- **WHEN** 其它三键合法而 `todo` 分别为：`{}`；`{phases:[]}`；`{phases:[{name:"A", tasks:[]}]}`；`{phases:[{name:"A", tasks:[{content:"a", status:"done"}]}]}`；`{phases:[{name:"A", tasks:[{content:"a", status:"blocked", blocker:"x"}]}]}`；`{phases:[{name:"A", tasks:[{content:"a", status:"pending"}], extra:1}]}`；`name` 为 201 个码点；一个阶段含 201 个合法任务；`"x"`；`[]`
- **THEN** 每一种 `parseMessageSnapshot` 都返回 `null`，`getMessages` 以 `request_failed` 拒绝，不安装部分快照

#### Scenario: 事件解码与归约
- **WHEN** 视图由 `todo` 为 `null` 的快照生成且末条助手 M 为 running，随后到达 `todo.updated{messageId:M, todo:T1}`、与之逐值相同的第二条、`todo.updated{messageId:M, todo:T2}`、`turn.end{messageId:M, status:"done"}`，下一回合的 `turn.start{messageId:N}`，最后 `todo.updated{messageId:N, todo:null}`
- **THEN** `ChatState.todo` 依次为 T1、T1（第二条返回同一状态引用）、T2、T2、T2（`turn.start` 不重置）、`null`；每次 `todo.updated` 归约后 `messages` 与归约前是同一引用，输入状态未被修改

#### Scenario: 非法事件负载与未知回合
- **WHEN** 连接收到 `event:todo.updated`，其 data 为 `{"messageId":1}`（缺 `todo`）、`{"messageId":1,"todo":{"phases":[]}}` 或多一个键；另一情形下视图末条助手为 `done`，到达一条 `messageId` 不在视图里的合法 `todo.updated`
- **THEN** 前者按已知事件非法 payload 的既有规则触发重新同步，不改 `ChatState.todo`；后者不交给归约器，页面按 `未知回合触发重新同步` 请求该连接 `resync()`，恢复快照的 `todo` 经 `onSnapshot` 整体安装

### Requirement: 任务清单面板
会话页 SHALL 在输入框上方的停靠区显示只读的任务清单面板。停靠区自上而下为：任务清单面板、待决审批提问卡、输入框；面板 SHALL 位于停靠区最上方，不在消息线程内、不随线程滚动。

可见条件：选中会话的 `ChatState.todo` 非 `null` 且至少有一个任务的 `status` 不是 `completed` / `abandoned` 时显示；`todo` 为 `null`、或全部任务都是 `completed` / `abandoned` 时 SHALL 不渲染面板（DOM 中没有其头部按钮）。欢迎态（未选中会话）SHALL 不显示面板。

头部 SHALL 是一个按钮，可访问名为 `任务清单 <完成数>/<总数>`：`<完成数>` 是 `status` 为 `completed` 的任务数，`<总数>` 是清单里全部任务数（含 `abandoned`、`blocked`）；按钮带 `aria-expanded`，默认 `true`（展开）。点击在展开与收起之间切换；收起时任务列表不渲染，只留头部按钮。

展开后 SHALL 按阶段次序、阶段内任务次序列出全部任务，每个任务一项列表项（`listitem`；承载它们的列表元素 SHALL 带显式的 `role="list"`，去掉列表符号的样式不致让浏览器丢掉列表语义），显示状态标记与 `content` 全文；清单多于一个阶段时每个阶段显示其 `name`，只有一个阶段时 SHALL 不显示阶段名。状态标记 SHALL 带可访问文本：`pending` → `待办`、`in_progress` → `进行中`、`completed` → `已完成`、`abandoned` → `已放弃`、`blocked` → `受阻`（状态不只靠颜色或图标表达）。`name` 与 `content` 按文本渲染，不解释为 Markdown 或 HTML。

面板 SHALL 只读：除头部按钮外没有任何可交互控件（任务列表被限高裁掉时可由键盘聚焦以便滚动，见下；它不是控件，不响应点击与除滚动之外的按键），不提供新增、勾选、编辑、删除或排序，也不发起任何请求。展开/收起状态 SHALL 按会话保存在内存里：切换到另一会话再切回时保持该会话上次的状态，一个会话的收起不影响另一会话；它不写入 `localStorage`、URL 或服务端，页面重新加载后恢复为默认展开。

面板高度 SHALL 有上限，任务超出时在面板内部滚动；列表的内容高度超过其可见高度时（两种上限下都一样），列表的滚动容器 SHALL 可由键盘聚焦（`tabindex="0"`），未超出时 SHALL NOT 带 `tabindex`——与提问卡 `title` 正文同一做法（tool-approval `web 审批条`），随清单内容、上限档位与元素尺寸变化重新判定；这个上限 SHALL 使展开的面板与第一张待决提问卡（含其 `允许` / `拒绝` 按钮）同时落在停靠区的最大高度之内——有待决提问卡时列表用较小的上限以满足这一条，没有待决提问卡时列表 MAY 用较大的上限（多显示几项任务），两种上限下任务超出时都在面板内部滚动（停靠区整体不超过会话页列高度的一半并在内部滚动，见 chat-web `输入框上方停靠区`）；面板展开时无论任务多少，输入框与其发送按钮 SHALL 仍完整位于视口内，页面不出现横向滚动。这条规则的证据按 seam 分工：200 个任务的清单由整页挂载测试断言结构（下方 `长清单在面板内滚动的结构`，不作视口或像素断言）；真实浏览器里的布局只对 ui-walk 栈能产生的清单（`WORKBUDDY_TODO` 的两项任务，面板展开）断言（chat-harness `UI 走查会话元数据` 第 13 步）。清单经 `todo.updated` 更新时面板 SHALL 就地更新，不改变展开/收起状态，不移动输入框焦点、不改草稿。

#### Scenario: 面板显示在停靠区最上方
- **WHEN** 选中会话的 `todo` 为 `{phases:[{name:"准备", tasks:[{content:"读取需求", status:"completed"},{content:"列出要点", status:"in_progress"}]},{name:"交付", tasks:[{content:"输出结论", status:"pending"},{content:"写周报", status:"abandoned"},{content:"等评审", status:"blocked"}]}]}`，且该会话同时有一条待决审批
- **THEN** 输入框上方自上而下依次是头部按钮 `任务清单 1/5`（`aria-expanded="true"`）及其任务列表、可访问名为 `需要你的确认` 的提问卡、输入框；面板不在任何消息 article 之内；列表显示阶段名 `准备`、`交付` 与五个列表项，其状态可访问文本依次为 `已完成`、`进行中`、`待办`、`已放弃`、`受阻`；面板内除头部按钮外没有按钮、链接或输入控件

#### Scenario: 单阶段不显示阶段名
- **WHEN** 选中会话的 `todo` 为 `{phases:[{name:"走查", tasks:[{content:"整理需求", status:"in_progress"},{content:"输出结论", status:"pending"}]}]}`
- **THEN** 头部按钮为 `任务清单 0/2`，列表有两个列表项（`进行中` `整理需求`、`待办` `输出结论`），页面上不出现文本 `走查`

#### Scenario: 全部完成或放弃时隐藏
- **WHEN** 面板可见时到达 `todo.updated`，其清单的任务状态全部为 `completed` 或 `abandoned`；随后到达一条含 `pending` 任务的 `todo.updated`；随后到达 `todo.updated{todo:null}`
- **THEN** 第一条之后面板不在 DOM 中（没有名称以 `任务清单` 开头的按钮），输入框与提问卡不受影响；第二条之后面板重新出现；第三条之后面板再次消失

#### Scenario: 展开状态按会话保存
- **WHEN** 用户在会话 A 点击头部按钮收起面板，切换到同样有未完成清单的会话 B，再切回 A；之后 A 收到一条新的 `todo.updated`；之后重新加载页面
- **THEN** A 收起后 `aria-expanded="false"` 且没有任务列表项；B 的面板为展开（`aria-expanded="true"`）；切回 A 仍为收起；新的 `todo.updated` 只改变头部计数、不展开面板；重新加载后 A 的面板为展开

#### Scenario: 刷新后由快照恢复
- **WHEN** 一轮带 `todo` 工具结果的回合结束、面板显示 `任务清单 0/2`，用户重新加载页面
- **THEN** 页面的消息快照请求返回同一份 `todo`，面板以相同的计数与任务出现在输入框上方，期间不依赖任何 `todo.updated` 事件

#### Scenario: 长清单在面板内滚动的结构
- **WHEN** 整页挂载（假 API 与假 EventSource）选中会话的清单有 200 个未完成任务且面板展开；另一例同一清单再加一条待决审批
- **THEN** 200 个列表项都渲染在面板的列表元素内（经实现暴露的稳定钩子如 `data-slot` 属性定位），该列表带有限高与内部滚动的样式声明；面板位于停靠区容器内，停靠区容器不在消息线程的滚动容器内、按文档顺序位于输入框之前；头部按钮不在列表的滚动容器之内；另一例里提问卡与面板在同一个停靠区容器内、提问卡在面板之后，其 `允许` / `拒绝` 不在面板列表的滚动容器之内。列表元素带 `role="list"`；列表的内容高度超过其可见高度时（测试里按该元素的 `scrollHeight` 大于 `clientHeight` 给出）它带 `tabindex="0"`，未超过的清单其列表没有 `tabindex`。本场景不对视口或像素尺寸作断言

#### Scenario: 面板展开时输入框仍在视口内
- **WHEN** ui-walk 在 `desktop-light`（1440×900）与 `mobile-dark`（390×844）下对真实栈发送 `WORKBUDDY_TODO` 回合并等到完成，面板展开（两项任务）
- **THEN** 输入框与发送按钮的包围盒完整位于视口内，消息线程的可见高度大于 0，文档没有横向滚动

#### Scenario: 欢迎态不显示
- **WHEN** 用户从一个面板可见的会话点「新建会话」回到欢迎态
- **THEN** 欢迎态没有任务清单面板；重新选中该会话后面板按其清单与该会话保存的展开状态出现
