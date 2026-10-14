## MODIFIED Requirements

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
`createSession(input)` 的 input 另可含 `approvalMode`、`modelId`、`reasoningEffort`（取值域同上，`reasoningEffort` 不得为 `null`），与既有两键一样只发送所给的键。`patchSession(id, patch)` 的 `patch` 另可含这三键（同样不得为 `null`）。`prompt(id, message, options?)` 的 `options` 另可带 `attachments: string[]`：非空时 body 为 `{message, attachments}`，缺席或空数组时 body 仍恰为 `{message}`。`message` 原样发送，客户端不裁剪、不因它是空串而拒绝或省略该键（只发附件时即 `{"message":"","attachments":[…]}`；能不能发由输入框的启用条件与服务端决定）。
`ApiClient` SHALL 另提供两个方法。`getComposerOptions(options?)`：GET `/api/composer/options`，禁止缓存，200 返回严格解析的 `{approvalModes, models, defaults, upload}`——`approvalModes` 为上述三个取值的非空、不重复数组；`models` 为非空数组，元素严格键集 `{id, name, reasoning, vision, efforts, defaultEffort}`（`efforts` 为强度名数组，`defaultEffort` 为强度名或 `null`；强度名即上述七个，出现 `auto` 或其它字符串按非法响应处理）；`defaults` 严格键集 `{approvalMode, modelId, reasoningEffort}`；`upload` 严格键集 `{maxBytes, maxFiles}`（正安全整数）；任何不符整体拒绝。
`uploadFile(workspaceId, file, {signal?, onProgress?})`：POST `/api/workspaces/:id/uploads?name=<编码后的 file.name>`，`Content-Type: application/octet-stream`，请求体为该 `File` 本身（不读入内存、不封装 multipart）；201 返回严格解析的 `{path, name, size}`。它 SHALL 经 `XMLHttpRequest` 发送（`fetch` 没有上传进度），实现放在 `web/src/lib/` 的单独文件里并由 `api.ts` 注入 same-origin、错误信封解析、request_failed 构造与 401 通知——与其它方法共用同一套，不另行实现；`onProgress` 以 0 到 100 的整数百分比被调用（`lengthComputable` 为假时不调用）；`signal` 中止时调用 `abort()` 并以与其它方法相同的中止语义结束；非 2xx 按信封解析为 `ApiError`（含 413 `upload_too_large`、403 `sandbox_denied`、404、409 `conflict`、400），网络错误与非法响应为既有的 request_failed。

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

### Requirement: 纯会话视图归约
`chatStateFromSnapshot` SHALL 从完整消息快照生成有序聊天视图，不编造 SSE 缺失的时间戳或 ordinal；每条消息视图 SHALL 携带 `approvals: {id,tool,title,expiresAt,decision}[]`（由快照 `approvals` 逐项映射并保持按 `id` 升序，user 消息与无审批记录的 assistant 消息恒为 `[]`；`requestedAt` 不进视图），并携带 `thinking: string|null`（取快照原值）、`error`（取快照原值：`null` 或 `{reason,message,status,detail}`）与重试中标记 `retrying: boolean`（由快照生成时恒为 `false`）；每个步骤视图携带 `changes`（取快照原值，`null` 或变更数组）；视图状态 `ChatState` SHALL 携带会话级的 `todo`（取快照 `todo` 原值：归一化任务清单或 `null`）。`applyChatEvent(state,event)` SHALL 为确定性的纯函数，只复制改变的分支、不修改输入；未知事件类型 SHALL 保持原状态。
归约器 SHALL 处理服务端十二类事件：turn.start 重置对应 assistant 正文/步骤/错误并把 `approvals` 置为 `[]`、`thinking` 置为 `null`、置 running（不重置 `todo`）；thinking.delta `{messageId, delta}` 把 `delta` 原样追加到对应 assistant 的 `thinking`（`null` 视为空串），会话状态不变，不存在的 assistant 按消息事件补建；files.changed `{messageId, stepId, files}` 把该消息内 `stepId` 步骤的 `changes` 整体替换为 `files`（同一步骤后到者胜），该步骤或该消息不存在时保持原状态（同一引用），不编造步骤也不补建消息，会话状态不变；todo.updated `{messageId, todo}` 把 `ChatState.todo` 整体替换为事件的 `todo`（归一化任务清单或 `null`），不补建消息，不改任何消息、步骤与会话状态（`messages` 保持同一引用），新值与当前值深相等时返回原状态（同一引用），且 `turn.start`、`turn.end`、`error` 及其它事件 SHALL NOT 重置或改动 `todo`（清单属于会话，不属于某条消息；见 session-todo `web 契约解析与归约`）；text.delta 原样追加；step.start 按 messageId 内的 stepId 新建 running 步骤（`changes` 为 `null`）且不重复；step.end 更新已有步骤的状态和 output，detail 与 `changes` 保持 step.start、files.changed 或快照中的值不变；error 将对应 assistant 标记 failed、把 `error` 置为事件的 `{reason,message,status,detail}` 并把 `retrying` 置为 `false`，但会话保持 running 等待 turn.end；turn.retry `{messageId}` 只把对应 assistant 的 `retrying` 置为 `true`（不存在的 assistant 按消息事件补建），正文、`thinking`、步骤、`error` 与会话状态不变；同一 assistant 随后的 turn.start、text.delta、thinking.delta、step.start、error、turn.end 都把 `retrying` 置为 `false`；turn.end 将消息、会话和仍 running 的步骤置为其 done/failed/stopped 状态（`stopped` 不设置 error 文案）；审批按 `approvalId` 为键增改：approval.request `{messageId, approvalId, tool, title, expiresAt}` 向对应 assistant 的 `approvals` **追加** pending 项 `{id: approvalId, tool, title, expiresAt, decision: null}` 并保持按 `id` 升序，绝不覆盖或移除同消息的其它审批项（同一消息可同时有多条 pending）；若该 `approvalId` 已存在于该消息则保持原状态（同一引用）；会话保持 running；approval.resolved `{messageId, approvalId, decision}` 仅更新该消息 `approvals` 中 `id === approvalId` 的那一项的 `decision`，其余项与其顺序不变；未知 `approvalId`（该消息无此 id、消息无审批或消息不存在）保持原状态（同一引用），不补建。不存在的 assistant 可按消息事件补建；不得重写 user 消息。未知 step.end 不得编造缺失的步骤名称。没有先前 turn.start 或 error 的终态 SHALL 有效。

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

### Requirement: 事件流消费与续流
`connectSessionEvents` SHALL 使用注入的 EventSourceCtor 建立编码 sessionId 的同源 events URL，并设置 withCredentials:true。调用方先取得初始完整快照并传入 initialCursor；连接器 SHALL 提供 close，并通过 loadSnapshot(signal)、同步 onSnapshot/onEvent、可选 onGap 和 onError 管理恢复与错误。API 方法和页面由其他模块拥有。
连接器 SHALL 从命名 MessageEvent 的 data 解码负载、从 lastEventId 读取 canonical 安全整数 epoch:seq；十二类数据事件（含 `approval.request`、`approval.resolved`、`thinking.delta`、`files.changed`、`todo.updated`、`turn.retry`）均经过同一游标过滤。`error` 按严格键集 `{messageId,message,reason,status,detail}` 解码（`messageId` 安全整数，`message`、`reason` 非空字符串，`status` 为 `null` 或 100–599 的整数，`detail` 字符串，可为空串），`turn.retry` 按严格键集 `{messageId}`（安全整数）解码。`thinking.delta` 按严格键集 `{messageId,delta}`（`messageId` 安全整数、`delta` 非空字符串）解码，`files.changed` 按严格键集 `{messageId,stepId,files}`（`messageId`/`stepId` 安全整数，`files` 的规则同快照步骤的非 null `changes`：1 至 50 项，每项严格键集 `{path,added,removed,kind}`）解码，`todo.updated` 按严格键集 `{messageId,todo}`（`messageId` 安全整数，`todo` 的规则同快照的 `todo`，含 `null`，见 session-todo `web 契约解析与归约`）解码。原生传输 error 不得被当作业务 error：CONNECTING 时保留状态并交给原生自动重连，CLOSED 时关闭并报告，不推断 HTTP 状态。已知事件的非法 payload/id SHALL 触发重新同步，未知事件类型忽略。
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

### Requirement: 消息线程
会话页 SHALL 以 `web/src/features/chat/` 内的应用层组件渲染选中会话的消息线程：线程、消息、步骤卡与操作行直接由 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合而成；拷入层（`web/src/components/assistant-ui/`）只提供 `markdown-text`、`reasoning`、`tool-group` 三个组件及其 registry 依赖（ui-foundation `组件分层`），不拷入 registry 的 `thread` 与 `tool-fallback`。链接惰性、图片不加载、块次序、失败自动展开、不提供编辑/分支、不使用 runtime 的附件适配器等行为定制 SHALL 都在应用层实现（例如经 `markdown-text` 的 `components` 覆盖，以及组合 `tool-group` / `reasoning` 的 Root/Trigger/Content），不为此修改拷入文件。每条消息的根元素（用户与助手）SHALL 是 `article`，可访问名分别为 `用户` 与 `助手`，并带 `data-message-id="<message id>"`；对话内搜索的当前匹配标记 `aria-current="true"` 落在同一个根元素上（conversation-search）。

**用户消息** SHALL 渲染为右侧气泡，完整保留文本与空白（换行与前导空白不折叠），内容按纯文本呈现；消息带附件时气泡在文本下方列出它们（message-attachments「用户气泡中的附件」）。文本为空的用户消息（只发附件的消息；「空」的判定见 message-attachments「用户气泡中的附件」：快照里 `content` 为空串，页面自己呈现的那条按发送时的草稿去掉首尾空白后判定）SHALL 只渲染附件列表，不渲染空的文本块；根元素、可访问名与操作行照旧。用户消息 SHALL 带一个操作行，含 `撤回` 与 `从此处分叉` 两个按钮，依此次序（可访问名与 tooltip 分别为 `撤回`、`从此处分叉`；#908 另在二者之前加 `复制` 并规定操作行的显隐，不属于本条）。`撤回` 的行为、不可用时的原因说明与冲突对话框见 message-undo「web 撤回」：点击不弹确认，成功后这条及其后的消息从线程移除、其原文（只发附件的消息为空串）覆盖输入框草稿、其撤回后仍存在的附件恢复为输入框的附件标签（message-attachments「输入框附件标签」）。二者在输入框锁定期间都禁用；已归档的会话 SHALL NOT 渲染这两个按钮，也不渲染助手消息的 `重新生成`（「会话页」Archived session）。点击 `从此处分叉` SHALL 恰调用一次 `forkSession(sessionId, messageId)`，201 时导航到 `?session=<new id>`（保留无关的 search/hash）、从服务端刷新会话列表，并把输入框草稿设为返回的 `draft`（分叉点是只发附件的消息时为空串）、把输入框的附件标签设为返回的 `attachments`（message-attachments「输入框附件标签」）而不发送；400/409/502/503 信封文案就地显示在输入框上。

**错误文本**（#909）SHALL 在消息有 `error` 对象时渲染：第一行为 `error.message`，`error.status` 非 `null` 时其后接 `（HTTP <status>）`；`error.detail` 非空时其下有一个 `查看原文` 按钮（带 `aria-expanded`，缺省收起），展开后以纯文本显示 `detail`——保留换行与空白、自动折行、超出一定高度时块内滚动，SHALL NOT 按 Markdown 或 HTML 渲染。消息为 running 且 `retrying` 为 `true` 时，同一位置渲染一行 `role="status"` 的 `上游出错，正在重试…`。`error` 为 `null` 的失败消息不渲染错误文本。

**助手消息** SHALL 渲染为左侧的无气泡块，带装饰性的助手头像标记（不进入可访问名）。块内各部分 SHALL 按以下次序渲染，每项仅在存在时渲染：深度思考折叠块 `深度思考过程`（thinking-fold）→ 正文（Markdown，或 `（已停止生成）` 占位）→ 工具调用组 → 已结算审批记录（tool-approval）→ 错误文本（含重试提示）→ `文件变更（N 个）` 卡 → 产物卡（turn-artifacts）→ `已停止` 徽章 → 操作行。待决审批 SHALL NOT 渲染在消息内（见 `输入框上方停靠区` 与 tool-approval）。思考折叠块、已结算审批记录、文件变更卡与产物卡 SHALL NOT 改变本条规定的复制、重新生成、分叉与已停止行为。

**正文** SHALL 经 `@assistant-ui/react-markdown`（加 `remark-gfm`，不启用任何把源 HTML 转成元素的插件）渲染，不经 `web/src/lib/md-render.ts`（该模块留给文件页）：
- 源文本中的 HTML SHALL 作为文本出现，不生成对应元素；
- 链接 SHALL 保持惰性，与现状一致：任何目标（含 `http:`、`https:`、`javascript:`、`data:`、相对路径）都只渲染链接的可见文字，目标地址被丢弃，不生成链接（`a`）元素；
- 图片 SHALL 不加载：不生成 `img` 元素、不向图片地址发请求，在原位渲染其 alt 文本，无 alt 时渲染其 URL 文本；
- 代码块 SHALL 带复制按钮，复制该代码块的原文——写入剪贴板的文本 SHALL 去掉末尾恰一个换行（代码内部的换行与原文末尾多出的空行都保留），使粘贴到终端时末行不会被直接执行；成功只把按钮图标换成对勾、不弹提示；复制失败（剪贴板 API 不存在、抛错或 reject）时 SHALL 在该按钮旁渲染 `role="alert"` 的一行文字 `复制失败`（与消息级 `复制` 同一规则：下一次复制成功或再次点击时清除），异常与 rejection 不外泄；不做语法高亮。

运行中的助手消息 SHALL 在正文最后一个字符之后显示闪烁光标，进入终态后光标消失；`prefers-reduced-motion: reduce` 下光标 SHALL 不闪烁（可观察量：光标元素计算样式的 `animation-name` 为 `none`，由 ui-walk 在真实浏览器里断言）。

状态为 `stopped` 的助手消息 SHALL 在正文之后、操作行之前渲染一个 `role="status"` 徽章，可见文本 `已停止`、可访问名 `助手消息 已停止`（不带错误文本）；其正文为空时 SHALL 以占位文本 `（已停止生成）` 代替空块。这一消息级呈现不改变会话列表状态点、步骤徽章与输入框的呈现。

**操作行**：不再运行的助手消息在正文非空或符合重新生成条件时 SHALL 以操作行结尾；运行中的助手消息不渲染操作行。
- 正文非空时操作行含 `复制` 图标按钮（可访问名与 tooltip 均为 `复制`）：点击 SHALL 经 `navigator.clipboard.writeText` 复制消息的原始文本（Markdown 源文本，不是渲染后的文本）。成功时按钮图标换成对勾约 2 秒，并出现一个视觉隐藏的 `role="status"` 文本 `已复制`；不弹轻提示。剪贴板 API 不存在、抛错或 reject 时，SHALL 在该按钮旁渲染 `role="alert"` 的一行文字 `复制失败`，下一次复制成功或再次点击时清除；异常与 rejection 不外泄。
- `重新生成` 图标按钮（可访问名与 tooltip 均为 `重新生成`）SHALL 只出现在转录**末条**消息上，且该消息是助手消息、会话状态为 `done|failed|stopped`（正文为空也显示）；更早的助手消息、运行中的会话与 `idle` 会话不渲染它（会话只有在没有历史时才是 `idle`——分叉得到的会话继承末条被拷贝助手消息的状态，所以带历史的分叉会话是 `done|failed|stopped`，其末条助手消息符合条件）。这一可见条件由应用层组件判定，不依赖运行时的默认可见性。点击 SHALL 恰调用一次 `regenerateSession`（结算前按钮禁用），像运行中回合一样锁定输入框，202 时不弹任何提示，随后对账权威历史并从该快照重连：旧助手行消失，新的运行中助手行（新 id、正文为空）取代其位置，用户消息不重复；409/400/502/503 信封文案就地显示在输入框上并解锁输入框。
- 不提供点赞/点踩、消息编辑与分支切换。

**工具调用组**：一条助手消息的全部步骤 SHALL 收进一个工具调用组，位于正文之后；没有步骤的消息不渲染该组。组 SHALL 默认收起，展开/收起控件带 `aria-expanded`；收起时只显示一行摘要，内容为步骤数与最近一步（末位步骤）的名称及其状态文字。组内任一步骤状态为 `failed` 时组 SHALL 自动展开（从快照打开时即为展开；流式中某步骤变为 `failed` 时展开）。因失败自动展开后用户仍可手动收起；手动收起后组 SHALL NOT 再自动展开，直到该消息出现新的失败步骤。文件变更卡与产物卡在组之外，不受组的展开状态影响。
展开后每个步骤一张卡，卡的内容不变：SHALL show a header (terminal icon for `bash`, wrench icon otherwise, step name, and a status badge with `role="status"`, visible text `运行中|已完成|失败|已停止` mapped from running/done/failed/stopped and accessible name `<step name> 运行中|已完成|失败|已停止`) and a one-line summary derived from detail: for JSON object detail the non-blank `text` string, else the non-blank `content` string, or else the first key/value rendered as `<key>: <value>` (non-string values JSON-encoded); for any other detail (non-JSON, or JSON that is not an object) the first non-empty line; the summary is that value's first non-empty line, trimmed; empty detail yields an empty summary; all truncated to 120 code points; the summary SHALL come from `detail` (the tool args) only and SHALL NOT change when the step ends; the complete `detail` and, when non-empty, the step `output` (the tool result text, or the error text of a failed step) SHALL stay available behind a `原始输出` fold (collapsed by default) as two separate blocks, args first; a step whose detail and output are both empty renders no `原始输出`. No fabricated time or todo state.

**滚动**：线程的滚动容器 SHALL 是 assistant-ui 的线程视口（`ThreadPrimitive.Viewport`）；其自带的跟随 SHALL 关闭，贴底跟随与 `回到最新` 由应用层实现，行为以下列条文与「转录区尺寸变化触发贴底重算」的场景为准；运行环境没有 `ResizeObserver` 时滚动容器可退回普通元素。A `回到最新` floating button (a chevron-down icon plus the text, rendered only while a session is selected and absent otherwise, never a disabled placeholder) SHALL appear when the transcript is scrolled more than one viewport (`clientHeight`) above the bottom, including when new content grows that distance while the user is away from the bottom; once shown it SHALL stay until the transcript reaches the bottom (within 4px) or the button is clicked; clicking SHALL scroll the transcript to the bottom and hide the button. New content SHALL auto-scroll the transcript to the bottom only when the transcript was at the bottom (within 4px) before the update or the user has just clicked `回到最新`; while the user is scrolled up, new content SHALL NOT change the scroll position. Opening or switching to a session SHALL start at the bottom. 线程的滚动层 SHALL 暴露对话内搜索使用的 `scrollToMessage(id)` 句柄（行为见 conversation-search `跳转与消息级高亮`）。

**零消息空态**：选中会话、历史已加载、消息为空且没有回合在跑时，线程区 SHALL 显示一个装饰性图标、一行 `还没有消息，发一条开始吧`，以及该会话绑定的工作空间名（只读，前缀 `工作空间`；会话未绑定时不显示这一行；已绑定但空间名解析不出来时——工作空间列表读取中、读取失败或该空间已删除——同样不显示这一行）。空态 SHALL NOT 显示场景分组、快捷任务或最佳实践卡，SHALL NOT 改动输入框草稿；页面一级标题仍是顶栏面包屑。历史尚在加载或加载失败时 SHALL NOT 显示空态。输入框处于锁定时（回合进行中，或流错误带着刷新指引——例如 prompt 已被受理但随后的快照读取失败）同样 SHALL NOT 显示空态：提示语指向的「发一条」此时做不了。

#### Scenario: 消息呈现与流式光标
- **WHEN** 一次回合的快照包含多行用户消息与含 Markdown（标题 + 代码块 + 源 HTML）的助手正文，先处于 running、随后收到 `turn.end` done；另一例在 `prefers-reduced-motion: reduce` 下渲染同一条 running 助手消息
- **THEN** 用户消息为右侧气泡且多行文本换行与前导空白保留；助手块带装饰性头像标记，正文渲染出 heading 与 code 元素，源 HTML 作为文本出现、不生成对应元素；代码块带复制按钮；running 时正文末尾有光标，done 后消失；减少动态效果的一例中光标存在但不闪烁（计算样式 `animation-name` 为 `none`）；两条消息的根元素都是 `article`，可访问名分别为 `用户` 与 `助手`，各带自己的 `data-message-id`

#### Scenario: 代码块复制失败就地提示
- **WHEN** 助手正文含一个代码块，点击其复制按钮：先在剪贴板可用时点击，再在 `writeText` reject 时点击，最后在剪贴板恢复可用后再点击一次
- **THEN** 第一次剪贴板写入恰为该代码块原文去掉末尾一个换行（代码块内容为两行 `a`、`b` 时写入 `a\nb`，不以换行结尾；代码块以一个空行结尾时写入的文本仍以恰一个换行结尾）、按钮图标换成对勾、页面没有轻提示；reject 时该按钮旁出现 `role="alert"` 的 `复制失败` 且无未捕获异常；再次点击成功后 `复制失败` 消失

#### Scenario: Markdown 链接惰性与图片不加载
- **WHEN** 助手正文为 `[官网](https://example.com/a) [脚本](javascript:alert(1)) [数据](data:text/html,x) [相对](docs/a.md) ![示意图](https://img.example.com/a.png) ![](https://img.example.com/b.png) <a href="https://evil.example">x</a>`
- **THEN** `官网`、`脚本`、`数据`、`相对` 都只作为文字出现，正文内没有任何链接（`a`）元素，页面文本与属性中不出现这些链接的目标地址；正文内没有任何 `img` 元素，也没有向 `img.example.com` 发出请求，两张图片的位置分别显示文本 `示意图` 与 `https://img.example.com/b.png`；源 HTML 的 `<a …>` 作为文本出现，不生成链接元素

#### Scenario: 步骤卡呈现
- **WHEN** 回合快照含 detail 为 `{"command":"echo workbuddy-smoke"}` 的 running `bash` 步骤与一条非 bash 步骤，展开该消息的工具调用组，随后 bash 步骤以 output `workbuddy-smoke` 结束为 done
- **THEN** bash 卡头为终端图标、`bash` 与徽章 `运行中`（`role=status` 名 `bash 运行中`），摘要行为 `command: echo workbuddy-smoke`；结束后徽章为 `已完成`（名 `bash 已完成`）、摘要行仍为 `command: echo workbuddy-smoke`；非 bash 卡头为扳手图标；`原始输出` 折叠未展开，展开后内含完整 detail 块与内容为 `workbuddy-smoke` 的 output 块

#### Scenario: 工具调用组默认收起与失败自动展开
- **WHEN** 快照含一条 done 助手消息，其三个步骤（`read`、`bash`、`write`）均为 `done`；另一条 done 助手消息的两个步骤中 `bash` 为 `failed`；还有一条助手消息没有步骤；另一例中一条 running 助手消息的组处于收起，随后 `step.end` 把其中一个步骤置为 `failed`，用户手动收起该组，之后到达 `text.delta` 与另一个步骤的 `step.end{status:"done"}`，最后又一个步骤以 `failed` 结束
- **THEN** 第一条的工具调用组为收起态（`aria-expanded="false"`），只见一行摘要，含步骤数 3 与末位步骤的名称 `write` 及状态 `已完成`，各步骤卡不可见；展开后按步骤原序出现三张卡。第二条的组打开即为展开态，失败卡徽章为 `失败`。第三条不渲染工具调用组。流式的一例在第一个失败的 `step.end` 之后组变为展开态；手动收起后 `text.delta` 与 `done` 的 `step.end` 不使它重新展开；新的失败步骤到达后组再次展开

#### Scenario: 回到最新
- WHEN 长历史会话打开后，用户上滚超过一屏，随后新 delta 到达；再点击 `回到最新`，之后又有新 delta 到达
- THEN 打开时位于底部且无按钮；上滚期间新 delta 不改变滚动位置且按钮可见；点击后滚到底部、按钮消失；之后的新 delta 保持自动跟随到底部；欢迎态不渲染该按钮

#### Scenario: 复制助手原文
- **WHEN** 一次已完成回合的助手正文为含 Markdown 标记的原文，点击该助手消息的 `复制`；再分别在剪贴板 API 缺失、`writeText` reject 时点击；随后在剪贴板恢复可用后再点击一次
- **THEN** 第一次点击后剪贴板写入恰为该条助手的原始 Markdown 文本，按钮图标换成对勾并在约 2 秒后恢复，出现视觉隐藏的 `role="status"` 文本 `已复制`，页面上没有任何轻提示；API 缺失或 reject 时按钮旁出现 `role="alert"` 的 `复制失败` 且无未捕获异常，同样没有轻提示；恢复后再点击，`复制失败` 消失；running 助手、空正文助手与用户消息均无 `复制` 按钮

#### Scenario: 助手消息级已停止呈现
- **WHEN** 快照含两条 `stopped` 助手消息：一条正文为 `部分回答`，另一条正文为空；同时含一条 `done` 与一条 `failed` 助手消息
- **THEN** 两条 `stopped` 助手消息正文之后各有一个 `role=status`、可见文本 `已停止`、accessible name `助手消息 已停止` 的徽章且无错误文案；空正文那条正文区显示占位文本 `（已停止生成）`，非空那条正文为 `部分回答` 且无占位文本；`done`/`failed` 助手消息无该徽章与占位文本；侧栏状态元素、步骤徽章与 composer 的呈现不因此改变

#### Scenario: 重新生成末条回答
- **WHEN** 会话状态为 `done`、末条为助手消息时点击其 `重新生成`，服务端 202 返回新的 `assistantMessageId`，随后权威快照中旧助手行不存在、新助手行 running，SSE 送达 delta 与 `turn.end done`
- **THEN** `regenerateSession` 恰调用一次，页面上不出现任何轻提示（含 `正在重新生成…`），composer 立即锁定；对账后转录为同一条用户消息加一条新 id 的助手消息（旧正文消失、无重复用户行），新正文按 delta 增长直至 done 解锁；`重新生成` 只在末条为助手消息且会话状态 ∈ `done`/`failed`/`stopped` 时可见——running 期间、非末条助手消息与用户消息均无该按钮；`failed`/`stopped` 会话的末条助手消息（含空正文）同样可见并可点击；分叉得到且含历史的会话状态继承末条被拷贝助手消息的状态，其末条助手消息同样可见
- **WHEN** 服务端对 regenerate 返回 409 `session_busy` 或 503 `agent_capacity`
- **THEN** 信封文案内联显示于 composer，composer 解锁，转录不变，页面上没有轻提示

#### Scenario: 从用户消息分叉
- **WHEN** 已完成会话中点击第二条用户消息的 `从此处分叉`，服务端 201 返回 `{session:<new>, draft:"<该用户消息原文>", attachments:[{path:"uploads/a.pdf", size:3}]}`
- **THEN** `forkSession` 恰以该消息 id 调用一次；URL 变为 `?session=<new id>`（无关 search/hash 保留），页面加载新会话历史（分叉点之前的消息）并打开其 EventSource，会话列表从服务端刷新后含新会话，其状态元素反映继承自末条被拷贝助手消息的状态（此例第一条助手消息 `done` → `<title> 已完成`），末条助手消息显示 `重新生成`；composer 草稿等于 `draft`，附件区恰有一个已上传状态的 `a.pdf` 标签，未发送任何 prompt、未发出上传请求；composer 锁定期间 `从此处分叉` 禁用，助手消息无该按钮
- **WHEN** 对第一条用户消息点击 `从此处分叉`，服务端 201 返回的新会话 `status` 为 `idle`
- **THEN** 新会话线程区显示零消息空态（无消息、无 `重新生成`），侧栏状态元素名为 `<title> 未开始`，composer 草稿等于该用户消息原文且未发送
- **WHEN** 点击一条只有附件的用户消息的 `从此处分叉`，服务端 201 返回 `{session:<new>, draft:"", attachments:[{path:"uploads/a.pdf", size:3}]}`
- **THEN** 新会话里 composer 草稿为空，附件区恰有一个已上传状态的 `a.pdf` 标签，`发送` 可用；未发送任何 prompt、未发出上传请求

#### Scenario: 零消息会话空态
- **WHEN** 以 `/?session=<id>` 打开一个绑定工作空间 `项目A`、快照 `messages` 为 `[]` 的 `idle` 会话，打开前输入框草稿为 `草稿`；另一例会话未绑定工作空间；另一例会话已绑定工作空间但工作空间列表读取中、读取失败或该空间已不在列表里；再一例历史请求尚未返回；随后在第一例中发送一条消息
- **THEN** 第一例线程区显示一个图标、`还没有消息，发一条开始吧` 与 `工作空间 项目A`，没有场景分组、快捷任务与最佳实践卡，没有 hero，页面 level-1 heading 仍是顶栏面包屑 `我的工作 / <title>`，输入框草稿仍为 `草稿`、可发送；未绑定与空间名解析不出来的两例都有图标与 `还没有消息，发一条开始吧`，但没有以 `工作空间` 开头的那一行；历史请求尚未返回的一例在历史返回之前不显示空态；发送被受理后空态消失、出现用户消息

#### Scenario: 助手块次序
- **WHEN** 快照含一条 `stopped` 助手消息：`thinking` 为 `先想一想`，`approvals` 含一条已结算审批，正文为 `部分回答`，一个已结束 `write` 步骤的 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`，会话绑定到本账号的空间
- **THEN** 该消息内按文档顺序依次为 `深度思考过程` 折叠块（收起）、正文、工具调用组（收起）、已结算审批记录、名为 `文件变更（1 个）` 的卡片、`index.html` 的 HTML 产物卡、名为 `助手消息 已停止` 的徽章与操作行；消息内没有名为 `需要你的确认` 的区域；`复制` 仍只复制 `部分回答`

#### Scenario: 用户消息操作行的按钮与次序
- **WHEN** 渲染一个 `done` 会话里 `undo` 为 `available` 的用户消息；另一例回合进行中；再一例会话已归档
- **THEN** 第一例操作行里 `撤回` 在 `从此处分叉` 之前，二者可用；第二例二者都禁用；第三例操作行里没有这两个按钮

#### Scenario: 只有附件的用户消息
- **WHEN** 渲染一个 `done` 会话，其第一条用户消息 `content` 为 `""`、`attachments` 为 `[{path:"uploads/a.pdf", size:3}]`、`undo` 为 `available`
- **THEN** 该消息的根元素是可访问名为 `用户` 的 `article` 并带 `data-message-id`；气泡内只有名为 `附件` 的列表，没有文本块；操作行里 `撤回` 在 `从此处分叉` 之前，二者可用

#### Scenario: 失败消息的分类说明与原文
- **WHEN** 快照含一条 `failed` 助手消息，`error` 为 `{reason:"auth_failed",message:"鉴权失败：模型服务拒绝了配置的 API 密钥",status:401,detail:"401 Incorrect API key provided\n<b>x</b>"}`；另一条 `failed` 助手消息 `error` 为 `{reason:"upstream_timeout",message:"上游超时：模型服务没有及时响应",status:null,detail:""}`；另一条 `failed` 助手消息 `error` 为 `null`
- **THEN** 第一条在错误文本位置显示 `鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）` 与一个 `aria-expanded="false"` 的 `查看原文` 按钮，原文不可见；点击后按钮为 `aria-expanded="true"`，原文按纯文本显示两行 `401 Incorrect API key provided` 与字面的 `<b>x</b>`（没有 `b` 元素）；第二条只显示 `上游超时：模型服务没有及时响应`，没有 `（HTTP` 字样，也没有 `查看原文`；第三条不渲染错误文本；三条末条位置上的 `重新生成` 规则不变，输入框不因此锁定

#### Scenario: 重试提示
- **WHEN** running 助手消息收到 turn.retry，随后收到 text.delta；另一例收到 turn.retry 后收到 error 与 turn.end(failed)
- **THEN** turn.retry 后错误文本位置出现一行 `role="status"` 的 `上游出错，正在重试…`；text.delta 后它消失；另一例中它被分类说明取代
