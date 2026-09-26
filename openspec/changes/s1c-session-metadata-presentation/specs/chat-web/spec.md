# Spec delta: chat-web（S1c B 修改）

> 本 delta 以 change A（`s1c-turn-control-governance`）对 `API 客户端扩展`、`纯会话视图归约`、`事件流消费与续流`、`会话页` 的整段重述为基线再次**整段重述**（含 A 的全部 Scenario，另加 B 的 Scenario）；`步骤 args 与输出分栏` A 未修改，以 promoted 为基线重述。A 先于 B 归档，B 的重述替换 A 归档后的同名 Requirement；未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: API 客户端扩展
`ApiClient` SHALL 提供 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，分别返回类型化的会话列表、会话、完整消息快照和接受回合的消息 ID；并 SHALL 提供 S1c 回合控制四方法 `stopSession(id)`、`regenerateSession(id)`、`forkSession(id, messageId)`、`decideApproval(id, approvalId, decision)` 与 S1c 会话元数据二方法 `patchSession(id, patch)`、`deleteSession(id)`；`createSession` 扩为 `createSession(input?, options?)`（`options` 仍为既有请求选项、携带可选 `signal`，调用方只传 signal 时 input 为 `undefined`）。十方法 SHALL 使用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制；GET SHALL 禁止缓存，路径 ID（会话 id、`approvalId`）SHALL 编码。原四方法成功状态 SHALL 分别为 200、201、200、202；`createSession()` 无 input（或 input 为 `undefined`）时不发送 body，给出 input 时 SHALL 原样发送恰含所给键的 JSON `{workspaceId?, scene?}`（`workspaceId` 为 32 位小写十六进制、`scene ∈ {"office","code","design"}`；空对象 input 视同无 input、不发送 body），prompt SHALL 原样发送 JSON `{message}`。
回合控制四方法的合同：`stopSession(id)` POST `/api/sessions/:id/stop` 不发送 body，202 的 body SHALL 按 JSON 严格解析为空对象 `{}`（多字段、非对象或非 JSON 按非法响应处理）并解析为 `"stopping"`（已受理停止），204 无 body、不读取响应体并解析为 `"idle"`（会话非 running，幂等），返回 `Promise<"stopping"|"idle">`，调用方据此决定是否提示；`regenerateSession(id)` POST `/api/sessions/:id/regenerate` 不发送 body，202 返回严格解析的 `{assistantMessageId}`（安全整数）；`forkSession(id, messageId)` POST `/api/sessions/:id/fork` 原样发送 JSON `{messageId}`，201 返回严格解析的 `{session, draft}`，`session` 复用会话 DTO 解析、`draft` 为字符串（允许空串）；`decideApproval(id, approvalId, decision)` POST `/api/sessions/:id/approvals/:approvalId` 原样发送 JSON `{decision}`（`decision ∈ {"allow","deny"}`），200 返回严格解析的已结算审批对象（形状同消息快照 `approvals` 数组元素且 `decision` 非 null）。
会话元数据二方法的合同：`patchSession(id, patch)` PATCH `/api/sessions/:id`，原样发送 JSON `patch`，`patch` 为 `{title?: string, scene?: "office"|"code"|"design", pinned?: boolean}` 的非空子集（调用方传空对象时客户端不发请求，返回以 `TypeError` 拒绝的 Promise），200 返回按会话 DTO 严格解析的更新后会话；`deleteSession(id)` DELETE `/api/sessions/:id` 不发送 body，204 无 body、不读取响应体并解析为 `undefined`（服务端对 running 会话先停止再删除，客户端不另行等待或轮询）。工作空间列表复用既有 `listWorkspaces()`（形状与严格校验不变），供侧栏空间分区、composer footer 与逻辑路径 `<account>/<dir>` 拼接使用，不新增工作空间方法。命令目录方法 `listCommands()`（`web/src/lib/api-commands.ts`，`api.ts` 只加一行接线）GET `/api/commands`，200 返回按 `{name,label,description,hint,source}` 严格解析的数组：`name`/`label`/`description` 为字符串，`hint` 为字符串或 null，`source ∈ {"builtin","skill"}`，缺键、多键、错误枚举整体拒绝；同一 same-origin、no-store、401 通知机制。
返回对象 SHALL 按公开 DTO 严格校验，不接受缺字段、多字段、错误枚举或非安全整数；消息时间戳和消息/步骤 ID SHALL 允许有符号安全整数，session 时间戳、epoch、非 null seq 和 ordinal SHALL 非负。会话、消息与步骤的 `status` 枚举 SHALL 同刀扩为含 `stopped`（会话 `idle|running|done|failed|stopped`，消息/步骤 `running|done|failed|stopped`）。消息 DTO 严格键集 SHALL 为 `{id,role,content,status,createdAt,steps,approvals}`：`approvals` 在每条消息上都存在且为数组，user 消息与无审批记录的 assistant 消息恒为 `[]`，assistant 消息的每个元素为 `{id,tool,title,requestedAt,expiresAt,decision}`（`id` 安全整数、`tool`/`title` 字符串、`requestedAt`/`expiresAt` 安全整数、`decision ∈ {"allow","deny","timeout",null}`），数组按 `id` 严格升序且 `id` 不重复；缺字段、多字段、错误枚举、非数组、乱序或重复 id 整体拒绝。服务端快照的 `approvals` 键与 `approval.*` 事件 SHALL 与本 web 解析同刀落地，不设兼容窗口（同仓同部署，无第三方消费者；严格键集使任一侧先合入都会让会话页整体失效）。`stopped` 枚举不在同刀之列，而是先解析后发出（web-parse-before-server-emit）：web 解析与 `status-label.ts` 的 `stopped: "已停止"` SHALL 先于服务端真正发出 `stopped`（`turn.end stopped` 与快照中的 `stopped` 状态）合入——服务端尚未发出时多接受一个枚举值无副作用，反之严格枚举会把含 `stopped` 的整个响应判为非法。会话 DTO 严格键集 SHALL 由五键扩为八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`：`scene ∈ {"office","code","design",null}`，`workspaceId` 为 32 位小写十六进制字符串或 `null`，`pinnedAt` 为非负安全整数或 `null`（fork 产生的 `parent_session_id` 仍不进 DTO）；列表、`createSession`、`patchSession` 与 `forkSession` 的 `session` 共用该解析。消息 DTO 严格键集 SHALL 在上述基础上增 `thinking`，即 `{id,role,content,status,createdAt,steps,approvals,thinking}`：`thinking` 为字符串或 `null`，user 消息恒为 `null`（非 null 整体拒绝）。步骤 DTO 严格键集 SHALL 增 `changes`（见 `步骤 args 与输出分栏`）：`changes` 为 `null` 或 1..50 个元素的数组，元素严格键集 `{path,added,removed,kind}`，`path` 为非空字符串，`kind:"edit"` 时 `added`/`removed` 为非负安全整数，`kind:"write"` 时二者为 `null`；空数组、未知 `kind`、`kind` 与计数类型不符、元素多余或缺失字段整体拒绝。八键会话 DTO、消息 `thinking`、步骤 `changes` 与 `thinking.delta`/`files.changed` 事件 SHALL 与服务端同刀落地，不设兼容窗口（理由同上：严格键集使任一侧先合入都会让会话页整体失效）。`getMessages` SHALL 保留完整正文、步骤（含字符串 `output`）、顺序和 `streamCursor:{epoch:number,seq:number|null}`，不得截断、过滤、规范化文本或将 null/缺失游标默认成 0。400/409/502/503 SHALL 保留 `ApiError` 的 status/code/message（含 prompt/regenerate/fork 的 503 `agent_capacity`、approvals 的 409 `approval_settled`、regenerate/fork 的 409 `session_busy` 与 400 `bad_request`、createSession/patchSession 的 400 `bad_request`、patchSession/deleteSession 与绑定不可访问空间的 createSession 的 404 `not_found`、deleteSession 的 409 `session_busy`），供页面按信封文案呈现；非法响应和网络异常 SHALL 使用既有不泄露响应内容的 request_failed 错误。

#### Scenario: 四方法请求与响应
- WHEN 调用四方法并收到服务端对应成功响应
- THEN 路径、HTTP 方法、body、凭证、signal、状态与类型化返回值符合上述合同，原始 prompt 文本和历史正文不变

#### Scenario: 完整快照边界
- WHEN 快照包含 NUL/BOM/Unicode 正文、零 ordinal、有符号消息时间戳和 `{epoch:1,seq:null}` 或 `{epoch:1,seq:0}`
- THEN 完整历史与游标逐值保留；缺失游标、非法嵌套项或额外私有字段则整体拒绝

#### Scenario: 信封和未登录
- WHEN prompt 返回 409 session_busy 或 502 agent_unavailable，或任一方法返回 401
- THEN 409/502 保留 code/message；401 无论合法、畸形或非 JSON 都沿用既有未登录通知，通知回调抛错不替代请求错误

#### Scenario: 原有客户端不回归
- WHEN 原有认证、工作空间、预览、审计 API 在共享校验抽取后运行
- THEN 既有成功形状、严格拒绝规则、signed workspace 时间戳、错误保密与预览资源生命周期不变

#### Scenario: 回合控制四方法请求与响应
- **WHEN** 分别调用 `stopSession`（服务端返回 202 与 204 两种）、`regenerateSession`（202 `{assistantMessageId}`）、`forkSession`（201 `{session, draft}`）与 `decideApproval(id, approvalId, "allow")`（200 已结算审批对象）
- **THEN** 路径分别为编码后的 `/api/sessions/:id/stop`、`/regenerate`、`/fork`、`/approvals/:approvalId`，HTTP 方法均为 POST，stop/regenerate 无 body，fork body 恰为 `{messageId}`、approvals body 恰为 `{decision}`；`stopSession` 202（body `{}`）解析为 `"stopping"`、204（无 body）解析为 `"idle"`，202 body 为 `{"x":1}` 或非 JSON 时按非法响应拒绝；其余返回值按合同严格类型化，`draft` 原文不变

#### Scenario: stopped 与 approval 字段严格解析
- **WHEN** 消息快照的会话/消息/步骤 status 为 `stopped`，assistant 消息 `approvals` 分别为 `[]`、单条 pending（`decision:null`）、以及按 id 升序的两条（`[{id:7,decision:"timeout"},{id:8,decision:null}]` 形状），user 消息 `approvals` 为 `[]`
- **THEN** 快照整体通过并逐值保留（数组顺序不变）；缺 `approvals` 键、`approvals` 为 null 或非数组、元素多余字段、`decision` 为未知字符串、元素 id 乱序或重复、user 消息 `approvals` 非空，或任一 status 为未知枚举时整体拒绝

#### Scenario: 新错误码信封
- **WHEN** prompt 或 regenerate 返回 503 `agent_capacity`，`decideApproval` 返回 409 `approval_settled`，regenerate/fork 返回 409 `session_busy` 或 400 `bad_request`
- **THEN** `ApiError` 保留对应 status/code/message，不改写为 request_failed，401 仍沿用既有未登录通知

#### Scenario: 会话元数据方法请求与响应
- **WHEN** 分别调用 `createSession()`、`createSession({workspaceId:"<32hex>", scene:"code"})`、`patchSession(id, {title:"周报", pinned:true})`（200 八键会话）与 `deleteSession(id)`（204）
- **THEN** 第一次 POST `/api/sessions` 无 body；第二次 body 恰为 `{"workspaceId":"<32hex>","scene":"code"}`；PATCH 路径为编码后的 `/api/sessions/:id`、body 恰为 `{"title":"周报","pinned":true}`、返回值为严格解析的八键会话；DELETE 路径相同、无 body、解析为 `undefined` 且不读取响应体；`patchSession(id, {})` 不发出请求
- **WHEN** PATCH 返回 400 `bad_request` 或 404 `not_found`，DELETE 返回 404 `not_found` 或 409 `session_busy`
- **THEN** `ApiError` 保留对应 status/code/message

#### Scenario: 命令目录方法
- **WHEN** 调用 `listCommands()`，服务端返回两条内建与一条 skill（`{name:"skill:weekly-report",label:"weekly-report",description:"写周报",hint:"可选参数",source:"skill"}`）
- **THEN** 路径为 `/api/commands`、方法 GET、无 body、no-store，返回值逐值保留且顺序不变；元素缺 `hint`、`hint` 为数字、`source` 为 `"extension"` 或多余键时整体拒绝；401 沿用既有未登录通知

#### Scenario: 八键会话与思考、变更字段严格解析
- **WHEN** 会话列表项为 `{…, scene:"design", workspaceId:"<32hex>", pinnedAt:1700000000000}` 与三者皆 `null` 的项；快照中 assistant 消息 `thinking` 为 `"先想一想"` 与 `null`，user 消息 `thinking` 为 `null`；步骤 `changes` 为 `null` 与 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"},{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 整体通过并逐值保留；缺任一新键、`scene` 为未知字符串、`workspaceId` 非 32 位小写十六进制、`pinnedAt` 为负数或非安全整数、user 消息 `thinking` 非 null、`changes` 为 `[]`、`kind:"write"` 带数字计数或 `kind:"edit"` 计数为 null、变更元素多余字段时整体拒绝；仍为五键的会话对象同样整体拒绝

### Requirement: 纯会话视图归约
`chatStateFromSnapshot` SHALL 从完整消息快照生成有序聊天视图，不编造 SSE 缺失的时间戳或 ordinal；每条消息视图 SHALL 携带 `approvals: {id,tool,title,expiresAt,decision}[]`（由快照 `approvals` 逐项映射并保持按 `id` 升序，user 消息与无审批记录的 assistant 消息恒为 `[]`；`requestedAt` 不进视图），并携带 `thinking: string|null`（取快照原值）；每个步骤视图携带 `changes`（取快照原值，`null` 或变更数组）。`applyChatEvent(state,event)` SHALL 为确定性的纯函数，只复制改变的分支、不修改输入；未知事件类型 SHALL 保持原状态。
归约器 SHALL 处理服务端十类事件：turn.start 重置对应 assistant 正文/步骤/错误并把 `approvals` 置为 `[]`、`thinking` 置为 `null`、置 running；thinking.delta `{messageId, delta}` 把 `delta` 原样追加到对应 assistant 的 `thinking`（`null` 视为空串），不存在的 assistant 按消息事件补建；files.changed `{messageId, stepId, files}` 把该消息内 `stepId` 步骤的 `changes` 整体替换为 `files`（同一步骤后到者胜），该步骤不存在时保持原状态（同一引用），不编造步骤；text.delta 原样追加；step.start 按 messageId 内的 stepId 新建 running 步骤且不重复；step.end 更新已有步骤的状态和 output，detail 保持 step.start 或快照中的值不变；error 将对应 assistant 标记 failed 并保存原始文案，但会话保持 running 等待 turn.end；turn.end 将消息、会话和仍 running 的步骤置为其 done/failed/stopped 状态（`stopped` 不设置 error 文案）；审批按 `approvalId` 为键增改：approval.request `{messageId, approvalId, tool, title, expiresAt}` 向对应 assistant 的 `approvals` **追加** pending 项 `{id: approvalId, tool, title, expiresAt, decision: null}` 并保持按 `id` 升序，绝不覆盖或移除同消息的其它审批项（同一消息可同时有多条 pending）；若该 `approvalId` 已存在于该消息则保持原状态（同一引用）；会话保持 running；approval.resolved `{messageId, approvalId, decision}` 仅更新该消息 `approvals` 中 `id === approvalId` 的那一项的 `decision`，其余项与其顺序不变；未知 `approvalId`（该消息无此 id、消息无审批或消息不存在）保持原状态（同一引用），不补建。不存在的 assistant 可按消息事件补建；不得重写 user 消息。未知 step.end 不得编造缺失的步骤名称。没有先前 turn.start 或 error 的终态 SHALL 有效。

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
- **THEN** 第一步后该消息 `approvals` 为 `[{id:7, tool:"bash", title, expiresAt, decision:null}]` 且会话仍 running；第二步后该项 `decision` 为 `allow`，其余字段不变
- **WHEN** 对同一状态应用 approval.resolved(approvalId 8) 或对 `approvals` 为 `[]` 的消息应用 approval.resolved，或再次应用已存在的 approval.request(approvalId 7)
- **THEN** 返回的状态与输入相等（同一引用），不编造、不覆盖审批记录
- **WHEN** 再次对该 assistant 应用 turn.start
- **THEN** 该消息 `approvals` 回到 `[]`

#### Scenario: 同一消息多条并行审批归约
- **WHEN** 对 running assistant 依次应用 approval.request(approvalId 8)、approval.request(approvalId 7)、approval.resolved(approvalId 8, deny)
- **THEN** 两次 request 后该消息 `approvals` 为 id 顺序 `[7, 8]` 的两条 pending，第二次 request 未覆盖第一条；resolved 后仅 id 8 的 `decision` 为 `deny`，id 7 仍为 `decision:null`，会话仍 running

#### Scenario: 思考与文件变更归约
- **WHEN** 对 running assistant 依次应用 thinking.delta(`先`)、thinking.delta(`想`)、step.start(stepId 5, write)、files.changed(stepId 5, `[{path:"a.html",added:null,removed:null,kind:"write"}]`)、再一次 files.changed(stepId 5, `[{path:"b.html",…}]`)、step.end(stepId 5)
- **THEN** 该消息 `thinking` 为 `先想`，步骤 5 的 `changes` 最终为仅含 `b.html` 的数组，输入与未改分支不被修改；对快照中 `thinking` 为 `null` 的消息应用 thinking.delta(`x`) 后为 `x`
- **WHEN** 应用指向不存在步骤（stepId 99）的 files.changed，或再次对该 assistant 应用 turn.start
- **THEN** 前者返回与输入相等的同一引用；后者该消息 `thinking` 回到 `null`、步骤清空

### Requirement: 事件流消费与续流
`connectSessionEvents` SHALL 使用注入的 EventSourceCtor 建立编码 sessionId 的同源 events URL，并设置 withCredentials:true。调用方先取得初始完整快照并传入 initialCursor；连接器 SHALL 提供 close，并通过 loadSnapshot(signal)、同步 onSnapshot/onEvent、可选 onGap 和 onError 管理恢复与错误。API 方法和页面由其他模块拥有。
连接器 SHALL 从命名 MessageEvent 的 data 解码负载、从 lastEventId 读取 canonical 安全整数 epoch:seq；十类数据事件（含 `approval.request`、`approval.resolved`、`thinking.delta`、`files.changed`）均经过同一游标过滤。`thinking.delta` 按严格键集 `{messageId,delta}`（`messageId` 安全整数、`delta` 非空字符串）解码，`files.changed` 按严格键集 `{messageId,stepId,files}`（`messageId`/`stepId` 安全整数，`files` 元素规则同快照步骤 `changes`）解码。原生传输 error 不得被当作业务 error：CONNECTING 时保留状态并交给原生自动重连，CLOSED 时关闭并报告，不推断 HTTP 状态。已知事件的非法 payload/id SHALL 触发重新同步，未知事件类型忽略。
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
- **WHEN** thinking.delta 的 `delta` 为空串或多一个键，或 files.changed 的 `files` 为 `[]`、元素 `kind` 未知
- **THEN** 触发完整快照重新同步，不交付该事件

### Requirement: 会话页
`/` SHALL render the message area and labeled composer as a single full-width column in `main`, and SHALL own the account-owned session list and new-session action, which it renders into the shell sidebar's list area (spa-shell `路由 IA 与侧栏`) through the shell-provided slot and never inside `main`; the page keeps all list data, selection, creation and ownership fences, and the list behavior specified here is unchanged by its location. The page-level level-1 heading follows spa-shell: in welcome state it is the hero `WorkBuddy，我帮你` rendered by the chat page (replacing the former empty-selection copy); with a selected session it is the topbar breadcrumb container (accessible name `我的工作 / <title>`), the title being reported by the chat page via `useTopbar({ breadcrumb: sessionTitle(selected), actions })` as soon as the selected session is known and cleared when none is selected or the page unmounts; with a selected session `actions` (spa-shell topbar `actions` slot) holds exactly three icon buttons in this order — `重命名` (`Icon pencil`, session-sidebar), `对话内搜索` (`Icon search`, conversation-search) and `产物面板` (`Icon package`, turn-artifacts), each with that accessible name and tooltip — and the welcome state reports no actions; the page SHALL NOT render its own page-level `<h1>` (headings inside rendered Markdown are content, not page headings). List SHALL be rendered in the partitions (`置顶任务` / `任务` / `空间`), filters and entry menus specified by session-sidebar, each partition and workspace subgroup retaining server updatedAt-descending order, and each entry SHALL show server title or `新会话` plus a status element (`role="status"`, accessible name `<title> 运行中|已完成|失败|已停止`, visible dot with `running` pulsing via `ui-pulse`, visually-hidden text `运行中|已完成|失败|已停止` (`stopped` maps to `已停止` in `SESSION_STATUS_LABEL`); a session whose server status is `idle` uses `未开始` in the same positions). Selection/new SHALL update `?session=<id>` while preserving unrelated search/hash; refresh and Back SHALL restore the selected session. Missing selection (no `?session=`) or an inaccessible target that has been replace-removed SHALL show the welcome state (hero `WorkBuddy，我帮你`) and composer, never auto-select first session; a selected session whose history is pending or failed renders neither hero nor a page-level heading of its own (the breadcrumb owns it). An inaccessible initial GET404 SHALL replace-remove the session parameter and SHALL NOT open EventSource; other errors SHALL remain visible without displaying another session's history.
**Welcome state** (demo:2537-2567) SHALL show hero `WorkBuddy，我帮你`, a row of three scene pills `日常办公`/`代码开发`/`创意设计` (default `日常办公`; selection, the scene carried into session creation and the switch toast are specified by session-sidebar) above one row of quick chips whose static list is the selected scene's list ported from demo `SCENES`/`QUICK_PROMPTS` (demo:1221-1239), the composer card, a `不知道做什么，试试最佳实践案例` section with five static playbook cards (ported from demo `PLAYBOOKS`, demo:2553-2561) and a `换一批` action that rotates within the static set (`查看更多` is not rendered because its target `/center` is undelivered), and the disclaimer `内容由 AI 生成，请核实重要信息`. At `≥761px` the five cards SHALL sit in one row without wrapping (demo:408-409: cards share the row equally with `min-width: 0` and at most `220px` each); at `≤760px` the row MAY wrap; at 1440×900, 1024×768 and 390×844 the disclaimer SHALL lie inside the first viewport of the welcome state. Clicking a chip or card SHALL only fill the composer draft, never send. While the composer is locked (from submit through the running turn), scene pills, chips, cards and `换一批` SHALL be disabled so a pick cannot overwrite the draft that a failed create restores.
**Messages** (demo:2378-2406) SHALL render user messages as right-aligned bubbles that preserve complete text and whitespace (`white-space: pre-wrap`, safe rendering) and assistant messages as left-aligned plain blocks with an assistant avatar mark (`BrandMark`, decorative); assistant text SHALL be rendered through the shared safe Markdown renderer (`web/src/lib/md-render.ts`, relocated from the files feature with its provenance header intact; source HTML is escaped and never injected), with visible text following Markdown semantics (markup consumed, link destinations dropped), and a running assistant SHALL show a blinking caret (`ui-caret`) after the last character. An assistant message whose status is `stopped` SHALL render, after its body and before its action row, a trailing `role="status"` badge with visible text `已停止` and accessible name `助手消息 已停止` (no error text); when its content is empty the body SHALL show the placeholder text `（已停止生成）` (demo:2330-2335) instead of an empty block; this message-level presentation does not change the session list dot, step badges or composer defined below. Each assistant message that is no longer running SHALL end with an action row when it has non-empty text or is regenerate-eligible; running assistant messages render no action row. The row holds, when the text is non-empty, an icon button (`Icon copy`, decorative) whose accessible name and tooltip are `复制`: clicking it SHALL copy the raw message text (Markdown source, not the rendered text) via `navigator.clipboard.writeText` and show a `Toast` `已复制到剪贴板`; when the clipboard API is unavailable, throws or rejects, a `Toast` `复制失败` is shown instead and no exception or rejection escapes. The row additionally holds a `重新生成` icon button (`Icon refresh-cw`, accessible name and tooltip `重新生成`, demo:2396) only on the **last** message of the transcript when that message is an assistant message and the session status is `done|failed|stopped` (regenerate-eligible; shown even when its text is empty); earlier assistant messages, running sessions and `idle` sessions render no `重新生成` (a session is `idle` only when it has no history — a forked session inherits the status of the last copied assistant message, so a fork with history is `done|failed|stopped` and its last assistant is eligible). Clicking it SHALL call `regenerateSession` exactly once (the button disabled until settled), lock the composer as for a running turn, show `Toast` `正在重新生成…` on 202 (demo:2485), then reconcile authoritative history and reconnect from that snapshot: the old assistant row is gone and the new running assistant row (new id, empty text) takes its place without duplicating the user message; 409/400/502/503 envelopes display inline on the composer and unlock it. **User messages** SHALL render an action row with a single `从此处分叉` button (`Icon git-branch`, accessible name and tooltip `从此处分叉`), disabled while the composer is locked; clicking it SHALL call `forkSession(sessionId, messageId)` exactly once, and on 201 SHALL navigate to `?session=<new id>` (preserving unrelated search/hash), refresh the session list from the server, and set the composer draft to the returned `draft` without sending; a 400/409/502/503 envelope displays inline on the composer. Like/dislike are dropped.
**Assistant block order**: inside an assistant message the parts SHALL render in this order, each only when present: deep-thinking fold `深度思考过程` (thinking-fold), approval bars, body (Markdown text with caret, or the `（已停止生成）` placeholder), step cards, error text, `文件变更（N 个）` card and then artifact cards (turn-artifacts; this change deliberately places the file-change card before artifact cards, whereas demo `msgHTML` renders artifacts first), the `已停止` badge, and the action row. The thinking fold, file-change card and artifact cards SHALL NOT change the copy, regenerate, fork, approval or stopped behavior defined here. With a selected session the conversation search box opened by `对话内搜索` renders directly below the topbar and above the transcript (conversation-search).
**Approval bar** (demo:2407-2418) SHALL render inside an assistant message directly above its text, **one bar per entry of the message `approvals`**, stacked vertically in ascending `id` order (none when `approvals` is `[]`); each bar is its own `role="group"` region named by its header, and each bar is keyed and answered by its own `approval.id` independently of the others (several bars may share the same header name; tests disambiguate them by document order, which equals id order). Every bar shows a header, a tool badge and a body: the tool badge text is the approval `tool` field, i.e. the tool name the server parsed from the first line of `title` (`Allow tool: <name>`; `unknown` when unparseable — the web does not re-parse), and the body is the **full** `title` text (all lines, including the first) rendered as text with `white-space: pre-wrap`. Pending (`decision === null`): header `需要你的确认` (with `Icon shield`), below the body a single dynamic countdown sentence `（<n>s 内未操作将自动允许）` where `n = max(0, ceil((expiresAt - now)/1000))` is the remaining whole seconds (initially `60` for a fresh request), recomputed at least once per second from the injected clock — there is no separate static `60s` sentence and no second countdown element — and two buttons `允许`/`拒绝`. Clicking either SHALL call `decideApproval(sessionId, approval.id, "allow"|"deny")` exactly once and disable both buttons of that bar only; the bar SHALL NOT change its header optimistically but re-render from the `approval.resolved` event for its id or the next authoritative snapshot. Settled: `decision` `allow` or `timeout` → header `已允许执行`, `deny` → header `已拒绝执行`; no buttons, no countdown sentence, tool badge and full `title` body kept. A 409 `approval_settled` response SHALL show no error toast and no inline error: the page reconciles authoritative history so the bar renders the server decision. Other envelopes display inline on the composer. The approval bar SHALL render identically from a reloaded snapshot: a pending approval after reload remains answerable with the countdown sentence derived from the snapshot `expiresAt` (e.g. `（40s 内未操作将自动允许）` when 40s remain); a settled approval shows its final header. While any approval is pending the turn is still running, so the composer stays locked and the `停止` button is available.
**Step cards** (demo:2218-2242) SHALL show a header (`Icon terminal` for `bash`, `Icon wrench` otherwise, step name, and a status badge with `role="status"`, visible text `运行中|已完成|失败|已停止` mapped from running/done/failed/stopped and accessible name `<step name> 运行中|已完成|失败|已停止`) and a one-line summary derived from detail: for JSON object detail the non-blank `text` string, else the non-blank `content` string, or else the first key/value rendered as `<key>: <value>` (non-string values JSON-encoded); for any other detail (non-JSON, or JSON that is not an object) the first non-empty line; the summary is that value's first non-empty line, trimmed; empty detail yields an empty summary; all truncated to 120 code points; the summary SHALL come from `detail` (the tool args) only and SHALL NOT change when the step ends; the complete `detail` and, when non-empty, the step `output` (the tool result text, or the error text of a failed step) SHALL stay available behind a collapsed `<details>` `原始输出` (collapsed by default, not open) as two separate blocks, args first; a step whose detail and output are both empty renders no `原始输出`. No fabricated time or todo state. A `回到最新` floating button (`Icon chevron-down` plus the text, rendered only while a session is selected and absent otherwise, never a disabled placeholder) SHALL appear when the transcript is scrolled more than one viewport (`clientHeight`) above the bottom, including when new content grows that distance while the user is away from the bottom; once shown it SHALL stay until the transcript reaches the bottom (within 4px) or the button is clicked; clicking SHALL scroll the transcript to the bottom and hide the button. New content SHALL auto-scroll the transcript to the bottom only when the transcript was at the bottom (within 4px) before the update or the user has just clicked `回到最新`; while the user is scrolled up, new content SHALL NOT change the scroll position. Opening or switching to a session SHALL start at the bottom.
**Composer card** (demo:2576-2603) SHALL be a bordered card containing the labeled multi-line textarea (placeholder `今天帮你做些什么` in welcome state, `继续追问，或派一个新任务…` with a selected session) and a bottom toolbar whose only control is the send button (`Icon send`, aria-label `发送`) while no turn is running. While a turn is running (from submit through the running turn until terminal authoritative state) the send button SHALL be replaced in the same toolbar position by a round primary `停止` button (`Icon square`, aria-label and tooltip `停止`, demo:2595-2597) and the toolbar SHALL show a `role="status"` element with text `生成中`; the `停止` button SHALL call `stopSession` exactly once per click sequence (disabled from click until the response or terminal state) and on `"stopping"` (202) show `Toast` `已停止生成` (demo:2629), on `"idle"` (204) show no toast, and on an error envelope display it inline on the composer; the composer stays locked until the authoritative `stopped` state arrives (`turn.end stopped` or a terminal snapshot), whereupon the session list status element and the still-running step badges read `已停止`, the assistant message shows its `已停止` badge, and the composer unlocks with `发送` back. The three icon names `refresh-cw`, `git-branch` and `square` are lucide names added to the shared `Icon` registry (`web/src/ui/icon.tsx`) by this change. Attachment, model switcher, microphone and the permission part of the demo footer are NOT rendered until their owning stages. In welcome state only, the composer card SHALL end with a footer `任务启动于 <空间名|未选择>` whose workspace-selection popover (search placeholder `搜索工作空间`) is specified by session-sidebar; with a selected session no footer is rendered. The hint `Enter 发送 · Shift+Enter 换行` SHALL remain. **Slash candidates**: while the draft matches `^\/[^\s]*$` and the composer is enabled, the card SHALL show above the textarea a `role="listbox"` panel (`aria-label` `命令候选`) listing, from `listCommands()` fetched lazily once per page mount on the first time the condition holds (a failed fetch keeps the panel hidden without any error UI and is retried the next time the condition becomes true), every command whose `name` or `label` starts with the typed text after `/` (case-sensitive), each as a `role="option"` showing `label`, `description` and, when non-null, `hint` in muted text; the first option is highlighted, `↑`/`↓` move the highlight cyclically, `Enter` or `Tab` replaces the draft with `/<name> ` (one trailing space) and closes the panel, `Esc` closes it until the draft changes, clicking an option does what `Enter` does, and `Enter` with the panel open SHALL NOT submit; key events during an IME composition (`isComposing` or `keyCode` 229, the composer's existing rule) SHALL neither move the highlight nor pick an option, so confirming a Chinese candidate such as `/任务` with Enter is not a pick; with no matching command the panel is hidden and `Enter` submits as usual — an unmatched `/xxx` is sent unchanged (the server decides how omp receives it, chat-sessions「Slash 命令白名单与命令目录」), and the user bubble shows it as typed. The panel is pure page state (`features/chat/slash-menu-state.ts` + `slash-menu.tsx`) exposed to `Composer` through an optional `slashMenu` slot and an optional `interceptKeyDown(event): boolean` prop; without both props `Composer` renders and behaves exactly as before.
Page SHALL derive its API client from the current auth session, load complete history before opening EventSource, seed the exact snapshot cursor, and use existing pure reducer/connector. All callbacks SHALL be synchronous. Account renewal, session selection, unmount and successful/current401 logout SHALL abort/fence page requests and close the old connection; late responses and ignored-abort loads SHALL NOT mutate UI, navigate or open sources. Pending/failed logout SHALL preserve canonical authenticated behavior.
A user send with no session SHALL create once, select its returned ID and prompt that session once. Empty-whitespace sends SHALL be disabled, and duplicate submits SHALL NOT create concurrent turns. User-initiated navigation SHALL invalidate stale mutation continuations; the create-send operation's own URL handoff SHALL NOT lose its prompt. After successful acceptance the page SHALL reconcile authoritative history and reconnect from that snapshot, without appending duplicate rows or demoting an already finished turn. Failed502 SHALL NOT introduce speculative messages. Session title/order SHALL refresh from server, not duplicate server truncation logic.
Business errors SHALL display inline on the message;400/409/502/503 SHALL display envelope message (a 503 `agent_capacity` on prompt or regenerate displays its envelope message `Agent 容量已满，请稍后重试` inline on the composer, introduces no speculative rows and unlocks the composer so the user can retry). Composer SHALL be disabled from submit through running turn until terminal authoritative state (`done|failed|stopped`), with `生成中` status in the toolbar and the `停止` button in place of send. Current401 SHALL hand off to login. Terminal connector failure SHALL expose a safe error and refresh guidance, preserve last history, and not invent completion or automatically retry; a still-running authoritative status remains locked until reloaded.

#### Scenario: 输入框键盘发送
- WHEN 可发送的草稿在输入框收到无修饰的 Enter
- THEN 通过同一表单受理路径发送一次原始草稿；Shift+Enter 保留换行，输入法 composing 或确认键码229不发送，长按重复Enter不新增提交；空草稿及生成中仍不可发送

#### Scenario: Once-only create and streaming conversation
- WHEN an empty page user sends `你好` and the accepted turn emits start, step start/end, three deltas and done
- THEN exactly one session and prompt are created, URL selects that ID, user and assistant appear in server order without duplicates, text grows, step status/output changes, server title appears and composer unlocks at done

#### Scenario: Completed before acceptance response
- WHEN SSE turn.end arrives before prompt202 resolves and subsequent history reports the completed turn
- THEN acceptance reconciliation preserves one user/assistant pair and final content/status, never re-locks completed state or appends the user after the assistant

#### Scenario: Deep-link snapshot and covered replay
- WHEN `/?session=<id>` loads a running snapshot and EventSource opens with covered start/step/text and newer frames
- THEN snapshot GET completes before source construction, covered frames never erase/duplicate history, only successors append, and list selection matches the URL

#### Scenario: Selection and stale operation isolation
- WHEN a history/create/prompt/recovery request ignoring abort completes after user selects another session, navigates away or renews authentication
- THEN the old source is closed, owned signals are aborted and stale completion cannot install history, alter current errors, navigate, dispatch another prompt or create a source

#### Scenario: Inaccessible and empty targets
- WHEN no session is selected or initial history returns404 for an unknown/foreign ID
- THEN the page shows the welcome state (hero `WorkBuddy，我帮你`) and composer, no first-session fallback and no source for the inaccessible target; invalid query removal preserves other search/hash

#### Scenario: Error and stream ownership
- WHEN prompt rejects409/502, named business error arrives, or connector terminates while last snapshot is running
- THEN exact API/business messages are visible,502 introduces no speculative rows, connector failure gives safe refresh guidance without false terminal state, and temporary native reconnect errors do not become business failures

#### Scenario: Logout and page compatibility
- WHEN confirmed logout succeeds/current401 clears auth, or page unmounts under StrictMode
- THEN owned source/request lifecycles close without late UI writes or unhandled rejection; failed logout preserves authenticated page, and routes/main/settings-footer fixtures still exercise honest successful root loading

#### Scenario: 欢迎态与静态引导
- WHEN 已登录无 `?session=` 打开 `/`，点击一张最佳实践卡，再点击 `换一批`
- THEN `≥761px` 无顶栏（`≤760px` 顶栏只含 `打开导航`），页面 level-1 heading 为 hero `WorkBuddy，我帮你`；三个场景胶囊（`日常办公` 为选中态）、该场景的快捷 chip 行、composer 卡（末尾 footer 为 `任务启动于 未选择`，无权限控件）、五张卡片（取自静态七项清单）与免责声明可见，无附件/模型/麦克风控件、无顶栏 `actions` 按钮；点击卡片后输入框草稿等于卡片 prompt 且未发送；`换一批` 后五张卡片集合改变且仍来自静态清单；1440×900、1024×768 与 390×844 下免责声明位于首屏内，`≥761px` 五张卡片同行（`offsetTop` 相同），`main` 内无会话列表与 `新建会话`

#### Scenario: 消息呈现与流式光标
- WHEN 一次回合的快照包含多行用户消息与含 Markdown（标题 + 代码块 + 源 HTML）的助手正文，先处于 running、随后收到 `turn.end` done
- THEN 用户消息为右侧气泡且多行文本换行与前导空白保留；助手块带装饰性 `BrandMark` 头像，正文渲染出 heading 与 code 元素，源 HTML 作为文本出现、不生成对应元素；running 时正文容器末尾存在 `ui-caret`，done 后消失

#### Scenario: 步骤卡呈现
- WHEN 回合快照含 detail 为 `{"command":"echo workbuddy-smoke"}` 的 running `bash` 步骤与一条非 bash 步骤，随后 bash 步骤以 output `workbuddy-smoke` 结束为 done
- THEN bash 卡头为 `terminal` 图标、`bash` 与徽章 `运行中`（`role=status` 名 `bash 运行中`），摘要行为 `command: echo workbuddy-smoke`；结束后徽章为 `已完成`（名 `bash 已完成`）、摘要行仍为 `command: echo workbuddy-smoke`；非 bash 卡头为 `wrench` 图标；`原始输出` 的 `<details>` 未展开且内含完整 detail 块与内容为 `workbuddy-smoke` 的 output 块

#### Scenario: 回到最新
- WHEN 长历史会话打开后，用户上滚超过一屏，随后新 delta 到达；再点击 `回到最新`，之后又有新 delta 到达
- THEN 打开时位于底部且无按钮；上滚期间新 delta 不改变滚动位置且按钮可见；点击后滚到底部、按钮消失；之后的新 delta 保持自动跟随到底部；欢迎态不渲染该按钮

#### Scenario: 复制助手原文
- WHEN 一次已完成回合的助手正文为含 Markdown 标记的原文，点击该助手消息的 `复制`；再分别在剪贴板 API 缺失、`writeText` reject 时点击
- THEN 剪贴板写入恰为该条助手的原始 Markdown 文本并出现 Toast `已复制到剪贴板`；API 缺失或 reject 时出现 Toast `复制失败` 且无未捕获异常；running 助手、空正文助手与用户消息均无 `复制` 按钮

#### Scenario: 停止生成
- **WHEN** 一次回合 running 期间（含一条 running `bash` 步骤、无挂起审批）用户点击 composer 的 `停止`，服务端返回 202，随后 SSE 送达 `turn.end stopped`
- **THEN** 点击前 toolbar 无 `发送` 按钮而有 aria-label `停止` 的圆形主按钮与 `role=status` `生成中`；点击后 `stopSession` 恰调用一次、按钮禁用、出现 Toast `已停止生成`；`turn.end stopped` 到达后 composer 解锁并恢复 `发送`，助手消息末尾出现名为 `助手消息 已停止` 的 `role=status` 徽章、仍 running 的步骤徽章为 `已停止`（步骤名 `bash 已停止`），侧栏该会话状态元素名为 `<title> 已停止`，助手消息无错误文案；再次发送 prompt 走既有受理路径
- **WHEN** 点击 `停止` 时服务端返回 204
- **THEN** 不出现 Toast，composer 以下一份权威快照的状态为准

#### Scenario: 助手消息级已停止呈现
- **WHEN** 快照含两条 `stopped` 助手消息：一条正文为 `部分回答`，另一条正文为空；同时含一条 `done` 与一条 `failed` 助手消息
- **THEN** 两条 `stopped` 助手消息正文之后各有一个 `role=status`、可见文本 `已停止`、accessible name `助手消息 已停止` 的徽章且无错误文案；空正文那条正文区显示占位文本 `（已停止生成）`，非空那条正文为 `部分回答` 且无占位文本；`done`/`failed` 助手消息无该徽章与占位文本；侧栏状态元素、步骤徽章与 composer 的呈现不因此改变

#### Scenario: 重新生成末条回答
- **WHEN** 会话状态为 `done`、末条为助手消息时点击其 `重新生成`，服务端 202 返回新的 `assistantMessageId`，随后权威快照中旧助手行不存在、新助手行 running，SSE 送达 delta 与 `turn.end done`
- **THEN** `regenerateSession` 恰调用一次，出现 Toast `正在重新生成…`，composer 立即锁定；对账后转录为同一条用户消息加一条新 id 的助手消息（旧正文消失、无重复用户行），新正文按 delta 增长直至 done 解锁；`重新生成` 只在末条为助手消息且会话状态 ∈ `done`/`failed`/`stopped` 时可见——running 期间、非末条助手消息与用户消息均无该按钮；`failed`/`stopped` 会话的末条助手消息（含空正文）同样可见并可点击；分叉得到且含历史的会话状态继承末条被拷贝助手消息的状态，其末条助手消息同样可见
- **WHEN** 服务端对 regenerate 返回 409 `session_busy` 或 503 `agent_capacity`
- **THEN** 信封文案内联显示于 composer，composer 解锁，转录不变、无 Toast `正在重新生成…`

#### Scenario: 从用户消息分叉
- **WHEN** 已完成会话中点击第二条用户消息的 `从此处分叉`，服务端 201 返回 `{session:<new>, draft:"<该用户消息原文>"}`
- **THEN** `forkSession` 恰以该消息 id 调用一次；URL 变为 `?session=<new id>`（无关 search/hash 保留），页面加载新会话历史（分叉点之前的消息）并打开其 EventSource，会话列表从服务端刷新后含新会话，其状态元素反映继承自末条被拷贝助手消息的状态（此例第一条助手消息 `done` → `<title> 已完成`），末条助手消息显示 `重新生成`；composer 草稿等于 `draft` 且未发送任何 prompt；composer 锁定期间 `从此处分叉` 禁用，助手消息无该按钮
- **WHEN** 对第一条用户消息点击 `从此处分叉`，服务端 201 返回的新会话 `status` 为 `idle`
- **THEN** 新会话转录为空（无消息、无 `重新生成`），侧栏状态元素名为 `<title> 未开始`，composer 草稿等于该用户消息原文且未发送

#### Scenario: 审批条挂起、允许与拒绝
- **WHEN** running 助手消息收到 `approval.request{approvalId, tool:"bash", title:"Allow tool: bash\nReason: run ls", expiresAt: now+60s}`
- **THEN** 该消息内出现名为 `需要你的确认` 的审批条，工具名徽章为 `bash`，正文为 title 全文（两行均在，换行按 `white-space: pre-wrap` 保留），倒计时句为 `（60s 内未操作将自动允许）` 且随注入时钟推进 1s 后变为 `（59s 内未操作将自动允许）`，条内无其它倒计时元素，按钮 `允许`/`拒绝` 可用；composer 仍锁定且 `停止` 可用
- **WHEN** 点击 `允许`，服务端 200，随后收到 `approval.resolved{decision:"allow"}`
- **THEN** `decideApproval(sessionId, approvalId, "allow")` 恰调用一次，两按钮立即禁用，resolved 到达后头部为 `已允许执行`、无按钮无倒计时句，工具名徽章与 title 全文保留
- **WHEN** 另一条挂起审批点击 `拒绝` 并收到 `approval.resolved{decision:"deny"}`
- **THEN** 头部为 `已拒绝执行`
- **WHEN** 点击 `允许` 时服务端返回 409 `approval_settled`，随后权威快照中该审批 `decision:"timeout"`
- **THEN** 无错误 Toast、composer 无内联错误，审批条按快照重渲染为 `已允许执行`

#### Scenario: 同一消息两条并行审批分别作答
- **WHEN** running 助手消息先后收到 `approval.request{approvalId:7, tool:"bash"}` 与 `approval.request{approvalId:8, tool:"bash"}`（均 pending），用户先点 id 8 审批条的 `拒绝`、再点 id 7 审批条的 `允许`，服务端各返回 200，随后依次收到 `approval.resolved{approvalId:8, decision:"deny"}` 与 `approval.resolved{approvalId:7, decision:"allow"}`
- **THEN** 该消息内按文档顺序纵向排列两个名为 `需要你的确认` 的审批条（第一个为 id 7、第二个为 id 8），第二个 request 未替换第一个；点 id 8 的 `拒绝` 只以 `decideApproval(sessionId, 8, "deny")` 调用一次并只禁用 id 8 的两按钮，id 7 的按钮仍可用、倒计时句仍在；id 8 resolved 后仅第二个条为 `已拒绝执行`、第一个仍为 `需要你的确认`，composer 仍锁定；id 7 作答并 resolved 后第一个条为 `已允许执行`，两条均无按钮

#### Scenario: 刷新后审批状态保留
- **WHEN** 以 `/?session=<id>` 重新加载：快照中一条助手消息 `approvals` 含一条 pending 且 `expiresAt` 距今 40s，另一次加载中一条助手消息的审批 `decision` 为 `timeout`、另一条助手消息的为 `deny`
- **THEN** pending 加载后审批条头部 `需要你的确认`、倒计时句为 `（40s 内未操作将自动允许）`、按钮可点并能作答；`timeout` 渲染为 `已允许执行`，`deny` 渲染为 `已拒绝执行`，均无按钮与倒计时句；`approvals` 为 `[]` 的助手消息不渲染审批条

#### Scenario: 容量已满内联提示
- **WHEN** 发送 prompt 收到 503 `agent_capacity`（信封文案 `Agent 容量已满，请稍后重试`）
- **THEN** 该文案内联显示于 composer，转录不新增用户或助手行，composer 解锁且草稿保留，用户可直接重试；同一文案在 regenerate 返回 503 时同样内联显示

#### Scenario: 助手块次序
- **WHEN** 快照含一条 `stopped` 助手消息：`thinking` 为 `先想一想`，`approvals` 含一条已结算审批，正文为 `部分回答`，一个已结束 `write` 步骤的 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`，会话绑定到本账号的空间
- **THEN** 该消息内按文档顺序依次为 `深度思考过程` 折叠块（收起）、审批条、正文、步骤卡、名为 `文件变更（1 个）` 的卡片、`index.html` 的 HTML 产物卡、名为 `助手消息 已停止` 的徽章与操作行；`复制` 仍只复制 `部分回答`

#### Scenario: 斜杠命令候选
- **WHEN** 在欢迎态与已选会话的 composer 中分别输入 `/`（`listCommands()` 返回两条内建与 `skill:weekly-report`），再输入 `/t`，按 `↓` `↑` `Enter`；再输入 `/help` 后 `Enter`；再输入 `/` 后 `Esc`；输入法组合态下（`isComposing`）输入 `/任` 并按 Enter；以及 `listCommands()` 失败时输入 `/`
- **THEN** 输入 `/` 时出现 `命令候选` listbox 恰三项、第一项 `整理上下文` 高亮，`/t` 过滤为 `任务清单` 一项（`todo` 前缀命中），`↓`/`↑` 循环回到该项，`Enter` 使 draft 变为 `/todo ` 且面板关闭、不发送；`/help` 无候选、面板隐藏，`Enter` 照常发送且用户气泡显示 `/help`；`Esc` 关闭面板、再输入字符后重新出现；组合态的 Enter 既不选中也不发送，draft 保持输入法上屏结果；拉取失败时无面板、无错误提示，下次满足条件时重新拉取

#### Scenario: 顶栏入口
- **WHEN** 选中一个会话，随后回到欢迎态
- **THEN** 选中时顶栏 banner 内在面包屑之外恰有按序排列的 `重命名`、`对话内搜索`、`产物面板` 三个按钮；欢迎态顶栏不渲染这些按钮（`≥761px` 仍无顶栏）

### Requirement: 步骤 args 与输出分栏
客户端 SHALL 把步骤 `output` 作为与 `detail` 并列的字符串字段贯穿快照解析（`steps[]` 严格键集 `{id,ordinal,name,detail,output,status,changes}`，`changes` 规则见 `API 客户端扩展`）、SSE `step.end` 解码（严格键集 `{messageId,stepId,status,output}`，不含 `changes`；步骤变更只经 `files.changed` 事件与快照送达）、归约与呈现；缺 `output`、缺 `changes` 或多余字段仍整体拒绝。运行中步骤的 output 为空串；迁移前旧行与非 edit/write 步骤的 `changes` 为 `null`。

#### Scenario: 旧行与失败步骤
- WHEN 快照含一条 output 为空串的 done 步骤（迁移前旧行），以及一条 detail 为 `{"command":"false"}`、output 为 `boom` 的 failed bash 步骤
- THEN 旧行只渲染 detail 块、无 output 块且不报错；失败卡徽章 `失败`、摘要行 `command: false`，`原始输出` 含 detail 块与内容为 `boom` 的 output 块

#### Scenario: 长输出不影响摘要
- WHEN step.end 带回一条超过 120 码点的多行 output
- THEN 摘要行仍由 detail 派生不变，output 块完整保留换行

#### Scenario: 步骤变更字段贯穿
- **WHEN** 快照含一条 `changes` 为 `null` 的 done bash 步骤与一条 `changes` 为一项 edit 变更的 done edit 步骤，SSE 另送达一条带 `changes` 键的 step.end
- **THEN** 快照两步骤逐值保留（步骤卡呈现不变，变更只出现在文件变更卡）；带 `changes` 键的 step.end 视为非法 payload 触发重新同步
