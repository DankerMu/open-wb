## MODIFIED Requirements

### Requirement: API 客户端扩展
`ApiClient` SHALL 提供 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，分别返回类型化的会话列表、会话、完整消息快照和接受回合的消息 ID；并 SHALL 提供 S1c 回合控制四方法 `stopSession(id)`、`regenerateSession(id)`、`forkSession(id, messageId)`、`decideApproval(id, approvalId, decision)` 与 S1c 会话元数据二方法 `patchSession(id, patch)`、`deleteSession(id)`；`createSession` 扩为 `createSession(input?, options?)`（`options` 仍为既有请求选项、携带可选 `signal`，调用方只传 signal 时 input 为 `undefined`）。十方法 SHALL 使用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制；GET SHALL 禁止缓存，路径 ID（会话 id、`approvalId`）SHALL 编码。原四方法成功状态 SHALL 分别为 200、201、200、202；`createSession()` 无 input（或 input 为 `undefined`）时不发送 body，给出 input 时 SHALL 原样发送恰含所给键的 JSON `{workspaceId?, scene?}`（`workspaceId` 为 32 位小写十六进制、`scene ∈ {"office","code","design"}`；空对象 input 视同无 input、不发送 body），prompt SHALL 原样发送 JSON `{message}`。
回合控制四方法的合同：`stopSession(id)` POST `/api/sessions/:id/stop` 不发送 body，202 的 body SHALL 按 JSON 严格解析为空对象 `{}`（多字段、非对象或非 JSON 按非法响应处理）并解析为 `"stopping"`（已受理停止），204 无 body、不读取响应体并解析为 `"idle"`（会话非 running，幂等），返回 `Promise<"stopping"|"idle">`，调用方据此决定是否提示；`regenerateSession(id)` POST `/api/sessions/:id/regenerate` 不发送 body，202 返回严格解析的 `{assistantMessageId}`（安全整数）；`forkSession(id, messageId)` POST `/api/sessions/:id/fork` 原样发送 JSON `{messageId}`，201 返回严格解析的 `{session, draft}`，`session` 复用会话 DTO 解析、`draft` 为字符串（允许空串）；`decideApproval(id, approvalId, decision)` POST `/api/sessions/:id/approvals/:approvalId` 原样发送 JSON `{decision}`（`decision ∈ {"allow","deny"}`），200 返回严格解析的已结算审批对象（形状同消息快照 `approvals` 数组元素且 `decision` 非 null）。
会话元数据二方法的合同：`patchSession(id, patch)` PATCH `/api/sessions/:id`，原样发送 JSON `patch`，`patch` 为 `{title?: string, scene?: "office"|"code"|"design", pinned?: boolean}` 的非空子集（调用方传空对象时客户端不发请求，返回以 `TypeError` 拒绝的 Promise），200 返回按会话 DTO 严格解析的更新后会话；`deleteSession(id)` DELETE `/api/sessions/:id` 不发送 body，204 无 body、不读取响应体并解析为 `undefined`（客户端不另行等待或轮询）。命令目录方法 `listCommands(workspaceId)`（`web/src/lib/api-commands.ts`，由 `api.ts` 接线；`workspaceId` 为字符串或 null）GET `/api/commands`，`workspaceId` 非 null 时带且只带查询串 `workspaceId=<id>`，null 时不带查询串，均无 body，200 响应体 SHALL 恰为 `{commands}`，`commands` 是按 `{name,label,description,hint,source,overrides}` 严格解析的数组并作为返回值：`name`/`label`/`description` 为字符串，`hint` 为字符串或 null，`source ∈ {"builtin","skill","project"}`，`overrides` 为布尔值，项目配置方法 `listProjectConfig(workspaceId)`（同文件）以同样的查询串规则 GET `/api/project-config`，200 响应体 SHALL 恰为 `{files}`，`files` 是按 `{path,kind,depth}` 严格解析的数组：`path` 为非空字符串，`kind ∈ {"instructions","system","agent"}`，`depth` 为非负安全整数；两个方法的响应体或任一元素缺键、多键、类型不符、错误枚举时整体拒绝；同一 same-origin、no-store、401 通知机制。
返回对象 SHALL 按公开 DTO 严格校验，不接受缺字段、多字段、错误枚举或非安全整数；消息时间戳和消息/步骤 ID SHALL 允许有符号安全整数，session 时间戳、epoch、非 null seq 和 ordinal SHALL 非负。会话、消息与步骤的 `status` 枚举 SHALL 同刀扩为含 `stopped`（会话 `idle|running|done|failed|stopped`，消息/步骤 `running|done|failed|stopped`）。消息 DTO 严格键集 SHALL 为 `{id,role,content,status,createdAt,steps,approvals}`：`approvals` 在每条消息上都存在且为数组，user 消息与无审批记录的 assistant 消息恒为 `[]`，assistant 消息的每个元素为 `{id,tool,title,requestedAt,expiresAt,decision}`（`id` 安全整数、`tool`/`title` 字符串、`requestedAt`/`expiresAt` 安全整数、`decision ∈ {"allow","deny","timeout",null}`），数组按 `id` 严格升序且 `id` 不重复；缺字段、多字段、错误枚举、非数组、乱序或重复 id 整体拒绝。服务端快照的 `approvals` 键与 `approval.*` 事件 SHALL 与本 web 解析同刀落地，不设兼容窗口（同仓同部署，无第三方消费者；严格键集使任一侧先合入都会让会话页整体失效）。`stopped` 枚举不在同刀之列，而是先解析后发出（web-parse-before-server-emit）：web 解析与 `status-label.ts` 的 `stopped: "已停止"` SHALL 先于服务端真正发出 `stopped`（`turn.end stopped` 与快照中的 `stopped` 状态）合入——服务端尚未发出时多接受一个枚举值无副作用，反之严格枚举会把含 `stopped` 的整个响应判为非法。会话 DTO 严格键集 SHALL 为十一键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt,archivedAt,pendingApproval,temporaryWorkspace}`（s1c 的八键加 s1f-session-list-temp-space 的三键；逐键规则见 session-sidebar「会话 DTO 严格解析」：`archivedAt` 为非负安全整数或 `null`，`pendingApproval` 与 `temporaryWorkspace` 为布尔）：`scene ∈ {"office","code","design",null}`，`workspaceId` 为 32 位小写十六进制字符串或 `null`，`pinnedAt` 为非负安全整数或 `null`（fork 产生的 `parent_session_id` 仍不进 DTO）；列表、`createSession`、`patchSession`、`forkSession` 与 `undoMessage` 的 `session` 共用该解析。消息 DTO 严格键集 SHALL 在上述基础上增 `thinking` 与 `undo`，即 `{id,role,content,status,createdAt,steps,approvals,thinking,undo}`：`undo` 在 assistant 消息上恒为 `null`、在 user 消息上为 `available|too_large|failed|command|unbound|none` 之一（message-undo「可撤回状态」），其它取值或 assistant 消息非 null 整体拒绝；`thinking` 为字符串或 `null`，user 消息恒为 `null`（非 null 整体拒绝）。步骤 DTO 严格键集 SHALL 增 `changes`（见 `步骤 args 与输出分栏`）：`changes` 为 `null` 或 1..50 个元素的数组，元素严格键集 `{path,added,removed,kind}`，`path` 为非空字符串，`kind:"edit"` 时 `added`/`removed` 为非负安全整数，`kind:"write"` 时二者为 `null`；空数组、未知 `kind`、`kind` 与计数类型不符、元素多余或缺失字段整体拒绝。会话 DTO、消息 `thinking` / `undo` 与步骤 `changes` SHALL 与服务端同刀落地，不设兼容窗口（理由同上：严格键集使任一侧先合入都会让会话页整体失效）。`getMessages` SHALL 保留完整正文、步骤（含字符串 `output`）、顺序和 `streamCursor:{epoch:number,seq:number|null}`，不得截断、过滤、规范化文本或将 null/缺失游标默认成 0。`getMessages` 的消息快照顶层键集 SHALL 恰为 `{session, messages, streamCursor, todo}`：`todo` 为 `null` 或归一化任务清单对象，按 session-todo `web 契约解析与归约` 校验并逐值保留；缺 `todo`、多键或 `todo` 结构不合规时整个快照按非法响应拒绝，不部分安装。四键快照解析 SHALL 与服务端四键快照同刀落地，不设兼容窗口（理由同上）。400/409/502/503 SHALL 保留 `ApiError` 的 status/code/message（含 prompt/regenerate/fork 的 503 `agent_capacity`、approvals 的 409 `approval_settled`、regenerate/fork 的 409 `session_busy` 与 400 `bad_request`、createSession/patchSession 的 400 `bad_request`、patchSession/deleteSession 与绑定不可访问空间的 createSession 的 404 `not_found`、deleteSession 的 409 `session_busy`），供页面按信封文案呈现；非法响应和网络异常 SHALL 使用既有不泄露响应内容的 request_failed 错误。

s1f-session-list-temp-space 起 `ApiClient` 另 SHALL：
- `patchSession(id, patch)` 的 `patch` 接受 `archived:boolean`（与 `title`、`scene`、`pinned` 同为可选键，非空子集）；
- `prompt(id, message)` 的 202 严格解析为 `{userMessageId, assistantMessageId, undo}`（两个安全整数与一个 user 消息的 `undo` 取值），缺 `undo` 或取值不合法视为无效响应；
- 提供 `undoMessage(id, messageId, files)`：POST `/api/sessions/:id/undo`，原样发送 JSON `{messageId, files}`（`files` ∈ `"restore"|"force"|"keep"`），200 返回严格解析的 `{session, draft, files}`——`session` 复用会话 DTO 解析，`draft` 为字符串（允许空串），`files` 严格为 `{mode, restored, removed, skipped, failed}`（`mode` ∈ `"restored"|"kept"`；`restored`、`removed` 为非负安全整数；`skipped` 为 `{count, paths}`，`paths` 元素恰为 `{path, reason}`、`reason` ∈ `too_large|excluded|unreadable|special`；`failed` 为 `{count, paths}`，`paths` 元素恰为 `{path}`；`count` 为不小于 `paths.length` 的非负安全整数）；
- 提供 `promoteWorkspace(id, name)`：POST `/api/workspaces/:id/promote`，原样发送 JSON `{name}`，200 返回严格解析的工作空间 DTO（既有五键）。

新方法沿用既有 same-origin 请求、可选 AbortSignal、错误信封与 401 通知机制，路径 id 编码；409 `undo_conflict`、409 `session_archived`、409 `conflict` 与其它 4xx/5xx SHALL 保留 `ApiError` 的 status/code/message，供页面按 code 区分（`undo_conflict` 打开冲突对话框）。列表事件连接不经 `ApiClient` 的请求方法，见 session-list-push「web 列表事件消费」。

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
- **WHEN** 分别调用 `stopSession`（服务端返回 202 与 204 两种）、`regenerateSession`（202 `{assistantMessageId}`）、`forkSession`（201 `{session, draft}`）与 `decideApproval(id, approvalId, "allow")`（200 已结算审批对象）
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
- **WHEN** 会话列表项为 `{…, scene:"design", workspaceId:"<32hex>", pinnedAt:1700000000000, archivedAt:null, pendingApproval:false, temporaryWorkspace:false}` 与 `scene`、`workspaceId`、`pinnedAt` 皆 `null` 的项；快照中 assistant 消息 `thinking` 为 `"先想一想"` 与 `null`，user 消息 `thinking` 为 `null`；步骤 `changes` 为 `null` 与 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"},{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 整体通过并逐值保留；缺任一新键、`scene` 为未知字符串、`workspaceId` 非 32 位小写十六进制、`pinnedAt` 为负数或非安全整数、user 消息 `thinking` 非 null、`changes` 为 `[]`、`kind:"write"` 带数字计数或 `kind:"edit"` 计数为 null、变更元素多余字段时整体拒绝；仍为五键或八键的会话对象同样整体拒绝

#### Scenario: 命令目录方法
- **WHEN** 调用 `listCommands(null)`，服务端返回两条内建与一条 skill（`{name:"skill:weekly-report",label:"weekly-report",description:"写周报",hint:"可选参数",source:"skill",overrides:false}`）；另调用 `listCommands("<32 位十六进制 id>")`，服务端多返回一条 `source:"project"`、`overrides:true` 的条目；再调用 `listProjectConfig` 的两种形式
- **THEN** 前者路径为 `/api/commands`、后者为 `/api/commands?workspaceId=<id>`，方法 GET、无 body、no-store，返回值逐值保留且顺序不变；元素缺 `hint` 或 `overrides`、`hint` 为数字、`overrides` 为字符串、`source` 为 `"extension"` 或多余键时整体拒绝；`listProjectConfig` 的路径规则相同，元素 `kind` 为未知字符串、`depth` 为负数或多余键时整体拒绝；401 沿用既有未登录通知

#### Scenario: 撤回与转正方法
- **WHEN** 调用 `undoMessage(id, 42, "restore")`（服务端返回 200 `{session, draft:"原文", files:{mode:"restored",restored:1,removed:2,skipped:{count:1,paths:[{path:"big.bin",reason:"too_large"}]},failed:{count:0,paths:[]}}}`）与 `promoteWorkspace(wsId, "调研资料")`（200 五键工作空间）
- **THEN** 前者为 POST 编码后的 `/api/sessions/:id/undo`、body 恰为 `{"messageId":42,"files":"restore"}`，返回值逐值保留；后者为 POST `/api/workspaces/:id/promote`、body 恰为 `{"name":"调研资料"}`，返回工作空间对象
- **WHEN** undo 返回 409 `undo_conflict` 或 409 `session_archived`；promote 返回 409 `conflict`
- **THEN** `ApiError` 保留对应 status/code/message，不改写为 request_failed
- **WHEN** undo 的 200 body 缺 `files`、`files.mode` 为 `"done"`、`skipped.paths` 元素多一个键，或 `session` 为旧的八键对象
- **THEN** 均按无效响应处理（request_failed），不部分采用

#### Scenario: prompt 的 202 带 undo
- **WHEN** `prompt(id, "你好")` 收到 202 `{userMessageId:7, assistantMessageId:8, undo:"available"}`；另一例收到不含 `undo` 的旧形状，或 `undo:"yes"`
- **THEN** 前者返回这三个值；后两者按无效响应处理

#### Scenario: 消息 undo 键严格解析
- **WHEN** 快照里 user 消息 `undo` 为 `"available"`、`"none"`，assistant 消息 `undo` 为 `null`；另一例 assistant 消息 `undo` 为 `"available"`、user 消息 `undo` 为 `null` 或缺该键
- **THEN** 前者整体通过并逐值保留；后者整体拒绝

### Requirement: 会话页
`/` SHALL render, as a single full-width column in `main`, the message thread (`消息线程`), the composer dock (`输入框上方停靠区`) and the labeled composer (`输入框与能力栏`), and SHALL own the account-owned session list and new-session action, which it renders into the shell sidebar's list area (spa-shell `路由 IA 与侧栏`) through the shell-provided slot and never inside `main`; the page keeps all list data, selection, creation and ownership fences, and the list behavior specified here is unchanged by its location. The page-level level-1 heading follows spa-shell: in welcome state it is the hero `WorkBuddy，我帮你` rendered by the chat page; with a selected session it is the topbar breadcrumb container (accessible name `我的工作 / <title>`), the title being reported by the chat page via `useTopbar({ breadcrumb: sessionTitle(selected), actions })` as soon as the selected session is known and cleared when none is selected or the page unmounts; with a selected session `actions` (spa-shell topbar `actions` slot) is built from the ordered slot constant `CHAT_TOPBAR_ACTIONS` and holds exactly three icon buttons in this order — `重命名` (`Icon pencil`, session-sidebar), `对话内搜索` (`Icon search`, conversation-search) and `产物面板` (`Icon package`, turn-artifacts), each with that accessible name and tooltip — and the welcome state reports no actions; the page SHALL NOT render its own page-level `<h1>` (headings inside rendered Markdown are content, not page headings). List SHALL be rendered as specified by session-sidebar — title search, the pinned section, collapsible groups by workspace or by time, entry menus and the archived view — each group retaining server updatedAt-descending order, and each entry SHALL show server title or `新会话` plus a status element (`role="status"`, accessible name `<title> 等待确认|运行中|已完成|失败|已停止|未开始`: `等待确认` when the session's `pendingApproval` is true, otherwise by status with `stopped` reading `已停止` and `idle` reading `未开始`, texts taken from `SESSION_STATUS_LABEL`); only `等待确认`, `运行中` and `失败` have a visible mark and the other three carry visually-hidden text only (session-sidebar「会话状态标记」). The list is kept fresh by one list-event connection (session-list-push「web 列表事件消费」). Selecting a session SHALL update `?session=<id>` while preserving unrelated search/hash; refresh and Back SHALL restore the selected session. Missing selection (no `?session=`) or an inaccessible target that has been replace-removed SHALL show the welcome state (hero `WorkBuddy，我帮你`) and composer, never auto-select first session; a selected session whose history is pending or failed renders neither hero nor a page-level heading of its own (the breadcrumb owns it). An inaccessible initial GET404 SHALL replace-remove the session parameter and SHALL NOT open EventSource; other errors SHALL remain visible without displaying another session's history.
**New session**: the `新建会话` action SHALL only return the page to the welcome state: it removes `?session=` by a replace navigation (preserving unrelated search/hash), issues no request at all (in particular no `POST /api/sessions`) and leaves the composer draft untouched. When the sidebar is not an overlay (`≥761px`) it also moves the focus to the composer textarea, and when the page is already in the welcome state that is all it does. When the sidebar is the narrow-viewport navigation overlay (`≤760px`) the action closes the overlay and the focus returns to `打开导航`, exactly as the shell does for any other sidebar navigation (spa-shell `路由 IA 与侧栏`, unchanged by this change); the composer is not focused in that case. A session is created only by the first send from the welcome state (below); the details of the action's entry in the list area are specified by session-sidebar.
**Welcome state** SHALL show hero `WorkBuddy，我帮你`, three scene groups `日常办公`/`代码开发`/`创意设计` (default `日常办公`) above one row of quick chips whose static list is the selected scene's list, the composer with its capability bar (`输入框与能力栏`), a `不知道做什么，试试最佳实践案例` section with five static playbook cards and a `换一批` action that rotates within the static set (`查看更多` is not rendered because its target `/center` is undelivered), and the disclaimer `内容由 AI 生成，请核实重要信息`; the static content comes from `web/src/features/chat/welcome-content.ts`. A scene is only a suggestion group of the welcome state: switching it SHALL only swap the quick-chip list and SHALL NOT show any toast or other notice, the selected scene is carried into the create body of the first send, and once a session is selected the page shows no scene (selection control, create body and persistence are specified by session-sidebar). At `≥761px` the five cards SHALL sit in one row without wrapping (cards share the row equally and may shrink below their content width, at most `220px` each); at `≤760px` the row MAY wrap; at 1440×900, 1024×768 and 390×844 the disclaimer SHALL lie inside the first viewport of the welcome state; to keep that true, at `≤760px` the quick chips SHALL stay on a single row that scrolls horizontally inside the row (no page-level horizontal overflow) instead of wrapping. Clicking a chip or card SHALL only fill the composer draft, never send. While the composer is locked (from submit through the running turn), scene groups, chips, cards and `换一批` SHALL be disabled so a pick cannot overwrite the draft that a failed create restores.
**Runtime**: the thread SHALL be driven by the assistant-ui external-store runtime (`useExternalStoreRuntime`) while the application keeps owning the state: the runtime's messages are the selected session's view messages mapped by the pure `convertMessage` (`会话页源码模块划分`); `onNew` is supplied to the runtime (the adapter type requires it) and delegates to the page's existing send path, cancel delegates to the stop path and reload to the regenerate path. The runtime's running flag (`isRunning`) SHALL be true only when the last message of the selected session is an assistant message whose status is `running`, so the runtime never injects an optimistic placeholder assistant message: an assistant block appears only once `turn.start` or an authoritative snapshot provides one. The composer's `生成中` status, its `停止` button and its lock SHALL NOT be derived from the runtime flag: they are driven by the application's own generating state (create/submit in progress, regenerate in progress, or authoritative status `running`), under the unchanged rules below. History loading, a fork in progress and a terminal connector failure SHALL NOT count as generating — they only disable the composer through the page's own lock, so no `生成中` status and no `停止` button appear for them; a terminal connector failure wins even while the last snapshot is still `running` — and so does any other stream error that carries the refresh guidance (for example a failed reconciliation read after the prompt or regenerate was accepted), even while a submit or regenerate is still in flight (the composer stays locked and shows the failure guidance, with neither `生成中` nor `停止`). The application's `draft` state is the single source of truth for the composer text: the composer is an application-layer component (`输入框与能力栏`) that calls the existing submit path, and no UI invokes the runtime's composer. The page does not use the runtime's thread-list adapter: the session list stays an application component rendered through the shell sidebar slot (ADR-0013, decided by s1f-session-list-temp-space). The page SHALL NOT use the runtime's message editing, branch switching, attachments, or the tool-call approval field and its response callback (pending approvals are specified by tool-approval).
With a selected session the conversation search box opened by `对话内搜索` renders inside `main` as the first child of the page column, directly below the topbar and above any alert and the thread (conversation-search).
Page SHALL derive its API client from the current auth session, load complete history before opening EventSource, seed the exact snapshot cursor, and use existing pure reducer/connector. All callbacks SHALL be synchronous. Account renewal, session selection, unmount and successful/current401 logout SHALL abort/fence page requests and close the old connection; late responses and ignored-abort loads SHALL NOT mutate UI, navigate or open sources. Pending/failed logout SHALL preserve canonical authenticated behavior.
A user send with no session SHALL create once, select its returned ID and prompt that session once. Empty-whitespace sends SHALL be disabled, and duplicate submits SHALL NOT create concurrent turns. User-initiated navigation SHALL invalidate stale mutation continuations; the create-send operation's own URL handoff SHALL NOT lose its prompt. After successful acceptance the page SHALL reconcile authoritative history and reconnect from that snapshot, without appending duplicate rows or demoting an already finished turn. Failed502 SHALL NOT introduce speculative messages. Session title/order SHALL refresh from server, not duplicate server truncation logic.
Business errors SHALL display inline on the message;400/409/502/503 SHALL display envelope message (a 503 `agent_capacity` on prompt or regenerate displays its envelope message `Agent 容量已满，请稍后重试` inline on the composer, introduces no speculative rows and unlocks the composer so the user can retry). When the prompt that is not accepted is the one of a welcome-state first send — the session has just been created and selected, and its history was never read — the page SHALL then read that session's history once and show its normal selected-session state (for a session without messages the zero-message empty state of `消息线程`, with the event source opened from that snapshot), while the failure message stays inline on the composer and the restored draft is kept; this applies to every outcome other than acceptance (a 400/409/502/503 envelope or a network failure; a current 401 still hands off to login), the read is issued only while that session is still selected by the same client, and a prompt that is not accepted on a session whose history is already loaded issues no such read. Composer SHALL be disabled from submit through running turn until terminal authoritative state (`done|failed|stopped`), with `生成中` status and the `停止` button in place of send. Current401 SHALL hand off to login. Terminal connector failure SHALL expose a safe error and refresh guidance, preserve last history, and not invent completion or automatically retry; a still-running authoritative status remains locked until reloaded, and in that state the composer shows neither the `生成中` status nor the `停止` button (the failure guidance wins).
The chat page SHALL NOT show toasts: none of the page's rebuilt source files imports `useToast`; success and informational notices are removed and failures are displayed inline next to the control that triggered them, as specified per control in `消息线程`, `输入框与能力栏`, turn-control and turn-artifacts. The session-list actions (rename, pin, archive, restore, delete, promote, export) show no toast either: their failures are displayed in the dialog that issued them or in the alert at the top of the list area (session-sidebar「会话条目菜单与重命名」), and no file under `web/src/features/chat` imports `useToast`.

**Project config entry** (#773): for a selected session the page SHALL call `listProjectConfig(workspaceId)` once per client and session selection (again when the selected session or its workspace id changes; not in the welcome state) and, when it returns a non-empty list, render in the header actions area, before `重命名`, a button `项目配置` whose accessible name is `项目配置 <count>`; pressing it opens a read-only modal dialog built on the copied-layer dialog component (`web/src/components/ui/dialog`; the shell renders header buttons from descriptors, so the page has no trigger element to anchor a popover to) titled `助手会读取的项目配置文件` with the note `以下位置存在配置文件；同一层有多个说明文件时只有一个生效` and the entries grouped by `depth` (`当前目录` for 0, `上 <n> 级目录` otherwise), each showing `path` as plain text and its kind (`说明` for `instructions`, `系统提示` for `system`, `智能体` for `agent`). The dialog's only control is its `关闭`; the list scrolls inside a height-capped container which, only while its content is clipped (`scrollHeight > clientHeight`), SHALL be keyboard-focusable (`tabindex="0"`) so that the clipped entries can be reached from the keyboard, and carries no `tabindex` otherwise — it is not a control, and opening the dialog still puts the focus on `关闭`; `Esc` or `关闭` returns the focus to the header button; switching sessions closes it and it stays closed on return. The button's tooltip equals its accessible name. The list has no edit affordance and reads no file content. A failed call is not retried until the selection changes. An empty list, a pending call or a failed call renders no button and no error UI; a result for a previous selection is never shown.

**Archived session**: when the selected session's `archivedAt` is non-null the page SHALL present it read-only. The thread, conversation search, the artifacts panel, message `复制` and the topbar actions render as usual, but the composer, its capability bar and the composer dock are not rendered; in their place the page shows a notice `该会话已归档，恢复后才能继续对话` with a `恢复` button, and no message shows `重新生成`, `撤回` or `从此处分叉`. `恢复` sends `PATCH {archived:false}` once (the button is busy-disabled meanwhile); on 200 the composer returns in place with an empty draft and the entry returns to the default list view; on failure the envelope message (or `请求失败，请稍后重试`) is shown next to the button with `role="alert"` and the session stays read-only. Archiving the selected session from its row menu switches the page to this presentation without navigating. A draft typed before the session was archived is kept in page state and shown again after `恢复` only if the selection never changed.

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
- **WHEN** 已登录无 `?session=` 打开 `/`，把场景从 `日常办公` 切到 `代码开发`，点击一张最佳实践卡，再点击 `换一批`
- **THEN** `≥761px` 无顶栏（`≤760px` 顶栏只含 `打开导航`），页面 level-1 heading 为 hero `WorkBuddy，我帮你`；三个场景分组（初始 `日常办公` 为选中态）、所选场景的快捷 chip 行、输入框（能力栏的工作空间选择器按钮为 `任务启动于 未选择`，无权限设置、上传、专家控件）、五张卡片（取自静态七项清单）与免责声明可见，无附件/模型/麦克风控件、无顶栏 `actions` 按钮；切换场景后快捷 chip 行换成 `代码开发` 的列表，页面上不出现任何轻提示，也未发出任何请求；点击卡片后输入框草稿等于卡片 prompt 且未发送；`换一批` 后五张卡片集合改变且仍来自静态清单；1440×900、1024×768 与 390×844 下免责声明位于首屏内，`≥761px` 五张卡片同行（`offsetTop` 相同），`main` 内无会话列表与 `新建会话`

#### Scenario: 新建会话只回欢迎态
- **WHEN** 在 `≥761px`（侧栏不是覆盖层）选中一个会话且输入框草稿为 `半句话`，URL 为 `/?session=<id>&x=1#h`，点击侧栏 `新建会话`；随后在欢迎态再点一次 `新建会话`；最后在输入框发送 `你好`
- **THEN** 第一次点击后 URL 为 `/?x=1#h`、页面为欢迎态（hero 可见）、焦点在输入框、草稿仍为 `半句话`，其间没有发出任何请求（`POST /api/sessions` 调用数为 0），会话列表条目数不变；第二次点击只把焦点放到输入框，仍无请求；发送后恰一次 `POST /api/sessions`、URL 选中返回的 id、再恰一次 prompt
- **WHEN** 在 `≤760px` 选中一个会话，打开 `导航` 覆盖层并点击其中的 `新建会话`
- **THEN** 覆盖层关闭，URL 不含 `?session=`、页面为欢迎态，没有发出任何请求，草稿不变；焦点回到 `打开导航`（与覆盖层内其它导航的关闭规则相同），不在输入框

#### Scenario: 锁定不等于生成中
- **WHEN** 以 `/?session=<id>` 打开一个 `done` 会话而历史请求尚未返回；另一例在已完成会话中点击 `从此处分叉` 而 fork 请求尚未返回；再一例最近一份快照为 `running` 时事件连接器终态失败
- **THEN** 三例中输入框都处于禁用，但没有 `生成中` 状态元素、没有 `停止` 按钮；前两例在历史返回或 fork 结束后输入框恢复可用；第三例显示安全的错误文案与刷新指引，输入框保持锁定直到重新加载

#### Scenario: 首次发送前不出现占位助手块
- **WHEN** 在欢迎态发送 `你好`，`POST /api/sessions` 与 prompt 请求先后挂起；随后 prompt 被受理，`turn.start` 或权威快照带来该回合的助手消息
- **THEN** 请求挂起期间输入框锁定并显示 `生成中` 与 `停止`，线程里没有任何助手消息（没有可访问名为 `助手` 的 `article`，运行时不注入占位助手块）；`turn.start` 或快照到达之后才出现一条助手消息

#### Scenario: 容量已满内联提示
- **WHEN** 发送 prompt 收到 503 `agent_capacity`（信封文案 `Agent 容量已满，请稍后重试`）
- **THEN** 该文案内联显示于 composer，转录不新增用户或助手行，composer 解锁且草稿保留，用户可直接重试；同一文案在 regenerate 返回 503 时同样内联显示

#### Scenario: 首次发送被拒后显示新会话
- **WHEN** 在欢迎态选中工作空间 `项目A`、输入 `你好` 并发送，`POST /api/sessions` 返回新会话，随后对它的 prompt 收到 503 `agent_capacity`；另一例 prompt 收到 409；再一例 prompt 被拒之前用户已切到别的会话；随后在第一例中直接再次发送
- **THEN** 第一例 URL 选中新会话；prompt 被拒之后恰发出一次对该会话的历史读取，线程区显示零消息空态（`还没有消息，发一条开始吧` 与 `工作空间 项目A`），不是空白；`Agent 容量已满，请稍后重试` 内联显示于 composer，草稿恢复为 `你好`，历史返回后输入框可用，没有 `生成中` 与 `停止`，没有第二次 `POST /api/sessions`；409 一例相同（文案为其信封文案）；已切走的一例不为该会话发出历史读取，当前会话的界面不变；再次发送恰发出一次 prompt、不再创建会话，受理后空态消失、出现用户消息
- **WHEN** 在一个历史已加载的既有会话里发送，prompt 收到 503
- **THEN** 文案内联显示、草稿恢复，prompt 被拒之后没有新的历史读取

#### Scenario: 顶栏入口
- **WHEN** 选中一个会话，随后回到欢迎态
- **THEN** 选中时顶栏的 actions 区（面包屑之后；`≤760px` 时 banner 里另有 `打开导航`）恰有按序排列的 `重命名`、`对话内搜索`、`产物面板` 三个按钮（该会话的项目配置列表为空时；非空时其前另有 `项目配置` 按钮，见「项目配置入口」场景）；欢迎态顶栏不渲染这些按钮（`≥761px` 仍无顶栏）

#### Scenario: 项目配置入口
- **WHEN** 选中绑定工作空间 A 的会话，`listProjectConfig("A")` 返回 depth 0 的 `.omp/RULES.md`、`AGENTS.md` 与 depth 1 的 `AGENTS.md`；另一例返回 `{files:[]}`；再一例调用失败；随后切到另一个会话
- **THEN** 第一例顶栏 actions 区在 `重命名` 之前出现按钮 `项目配置`（可访问名 `项目配置 3`），点击后打开只读列表：标题 `助手会读取的项目配置文件`，说明 `以下位置存在配置文件；同一层有多个说明文件时只有一个生效`，条目按 depth 分组（`当前目录`、`上 1 级目录`）逐条显示 `path` 与类型（`说明`/`系统提示`/`智能体`），没有编辑入口；后两例不渲染该按钮也不显示错误；切换会话时按新会话的工作空间 id 重新拉取，返回前不显示上一个会话的按钮
- **WHEN** 打开的只读列表内容高度超过其滚动容器的可见高度（测试里按该容器的 `scrollHeight` 大于 `clientHeight` 给出）；另一例未超过
- **THEN** 超过时该滚动容器带 `tabindex="0"`，打开时焦点仍在 `关闭`，对话框内的按钮仍只有 `关闭`；未超过时该容器没有 `tabindex`

#### Scenario: 归档会话只读呈现与恢复
- **WHEN** 打开 `/?session=<id>`，其会话视图 `archivedAt` 非 null、历史含一轮对话
- **THEN** 线程显示这一轮；页面有文本 `该会话已归档，恢复后才能继续对话` 与按钮 `恢复`；没有输入框（没有 composer 文本框、`发送`、能力栏与停靠区）；用户消息没有 `撤回` 与 `从此处分叉`，助手消息没有 `重新生成`、仍有 `复制`
- **WHEN** 点击 `恢复`，PATCH 返回 200（`archivedAt:null`）
- **THEN** 恰发出一次 `PATCH` body `{"archived":false}`；说明消失，输入框出现且可输入；该会话回到侧栏默认视图
- **WHEN** PATCH 返回 502
- **THEN** 按钮旁 `role="alert"` 显示信封文案，页面仍为只读呈现

#### Scenario: 列表条目的状态元素
- **WHEN** 侧栏列出 `pendingApproval` 为 true 的运行中会话 `甲` 与 `done` 的会话 `乙`
- **THEN** 存在可访问名为 `甲 等待确认` 与 `乙 已完成` 的状态元素；前者有可见标记，后者没有

### Requirement: 消息线程
会话页 SHALL 以 `web/src/features/chat/` 内的应用层组件渲染选中会话的消息线程：线程、消息、步骤卡与操作行直接由 `@assistant-ui/react` 的基元（`ThreadPrimitive`、`MessagePrimitive`、`ActionBarPrimitive`）组合而成；拷入层（`web/src/components/assistant-ui/`）只提供 `markdown-text`、`reasoning`、`tool-group` 三个组件及其 registry 依赖（ui-foundation `组件分层`），不拷入 registry 的 `thread` 与 `tool-fallback`。链接惰性、图片不加载、块次序、失败自动展开、不提供编辑/分支/附件等行为定制 SHALL 都在应用层实现（例如经 `markdown-text` 的 `components` 覆盖，以及组合 `tool-group` / `reasoning` 的 Root/Trigger/Content），不为此修改拷入文件。每条消息的根元素（用户与助手）SHALL 是 `article`，可访问名分别为 `用户` 与 `助手`，并带 `data-message-id="<message id>"`；对话内搜索的当前匹配标记 `aria-current="true"` 落在同一个根元素上（conversation-search）。

**用户消息** SHALL 渲染为右侧气泡，完整保留文本与空白（换行与前导空白不折叠），内容按纯文本呈现。用户消息 SHALL 带一个操作行，含 `撤回` 与 `从此处分叉` 两个按钮，依此次序（可访问名与 tooltip 分别为 `撤回`、`从此处分叉`；#908 另在二者之前加 `复制` 并规定操作行的显隐，不属于本条）。`撤回` 的行为、不可用时的原因说明与冲突对话框见 message-undo「web 撤回」：点击不弹确认，成功后这条及其后的消息从线程移除、其原文覆盖输入框草稿。二者在输入框锁定期间都禁用；已归档的会话 SHALL NOT 渲染这两个按钮，也不渲染助手消息的 `重新生成`（「会话页」Archived session）。点击 `从此处分叉` SHALL 恰调用一次 `forkSession(sessionId, messageId)`，201 时导航到 `?session=<new id>`（保留无关的 search/hash）、从服务端刷新会话列表，并把输入框草稿设为返回的 `draft` 而不发送；400/409/502/503 信封文案就地显示在输入框上。

**助手消息** SHALL 渲染为左侧的无气泡块，带装饰性的助手头像标记（不进入可访问名）。块内各部分 SHALL 按以下次序渲染，每项仅在存在时渲染：深度思考折叠块 `深度思考过程`（thinking-fold）→ 正文（Markdown，或 `（已停止生成）` 占位）→ 工具调用组 → 已结算审批记录（tool-approval）→ 错误文本 → `文件变更（N 个）` 卡 → 产物卡（turn-artifacts）→ `已停止` 徽章 → 操作行。待决审批 SHALL NOT 渲染在消息内（见 `输入框上方停靠区` 与 tool-approval）。思考折叠块、已结算审批记录、文件变更卡与产物卡 SHALL NOT 改变本条规定的复制、重新生成、分叉与已停止行为。

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
- **WHEN** 已完成会话中点击第二条用户消息的 `从此处分叉`，服务端 201 返回 `{session:<new>, draft:"<该用户消息原文>"}`
- **THEN** `forkSession` 恰以该消息 id 调用一次；URL 变为 `?session=<new id>`（无关 search/hash 保留），页面加载新会话历史（分叉点之前的消息）并打开其 EventSource，会话列表从服务端刷新后含新会话，其状态元素反映继承自末条被拷贝助手消息的状态（此例第一条助手消息 `done` → `<title> 已完成`），末条助手消息显示 `重新生成`；composer 草稿等于 `draft` 且未发送任何 prompt；composer 锁定期间 `从此处分叉` 禁用，助手消息无该按钮
- **WHEN** 对第一条用户消息点击 `从此处分叉`，服务端 201 返回的新会话 `status` 为 `idle`
- **THEN** 新会话线程区显示零消息空态（无消息、无 `重新生成`），侧栏状态元素名为 `<title> 未开始`，composer 草稿等于该用户消息原文且未发送

#### Scenario: 零消息会话空态
- **WHEN** 以 `/?session=<id>` 打开一个绑定工作空间 `项目A`、快照 `messages` 为 `[]` 的 `idle` 会话，打开前输入框草稿为 `草稿`；另一例会话未绑定工作空间；另一例会话已绑定工作空间但工作空间列表读取中、读取失败或该空间已不在列表里；再一例历史请求尚未返回；随后在第一例中发送一条消息
- **THEN** 第一例线程区显示一个图标、`还没有消息，发一条开始吧` 与 `工作空间 项目A`，没有场景分组、快捷任务与最佳实践卡，没有 hero，页面 level-1 heading 仍是顶栏面包屑 `我的工作 / <title>`，输入框草稿仍为 `草稿`、可发送；未绑定与空间名解析不出来的两例都有图标与 `还没有消息，发一条开始吧`，但没有以 `工作空间` 开头的那一行；历史请求尚未返回的一例在历史返回之前不显示空态；发送被受理后空态消失、出现用户消息

#### Scenario: 助手块次序
- **WHEN** 快照含一条 `stopped` 助手消息：`thinking` 为 `先想一想`，`approvals` 含一条已结算审批，正文为 `部分回答`，一个已结束 `write` 步骤的 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`，会话绑定到本账号的空间
- **THEN** 该消息内按文档顺序依次为 `深度思考过程` 折叠块（收起）、正文、工具调用组（收起）、已结算审批记录、名为 `文件变更（1 个）` 的卡片、`index.html` 的 HTML 产物卡、名为 `助手消息 已停止` 的徽章与操作行；消息内没有名为 `需要你的确认` 的区域；`复制` 仍只复制 `部分回答`

#### Scenario: 用户消息操作行的按钮与次序
- **WHEN** 渲染一个 `done` 会话里 `undo` 为 `available` 的用户消息；另一例回合进行中；再一例会话已归档
- **THEN** 第一例操作行里 `撤回` 在 `从此处分叉` 之前，二者可用；第二例二者都禁用；第三例操作行里没有这两个按钮

### Requirement: 输入框与能力栏
会话页的输入框 SHALL 是 `web/src/features/chat/` 内的应用层组件：由拷入层的普通受控多行文本框与按钮组成，文本框的值即应用自有的 `draft` 状态（唯一事实来源），提交走页面既有的发送路径；SHALL NOT 使用 assistant-ui 的 `ComposerPrimitive`。它含带标签的多行文本框（可访问名 `给助手发消息`；欢迎态占位 `今天帮你做些什么`，已选会话占位 `继续追问，或派一个新任务…`）、底部能力栏与发送按钮（可访问名 `发送`）。提示 `Enter 发送 · Shift+Enter 换行` SHALL 保留。键盘规则不变：无修饰的 Enter 经同一表单受理路径发送一次原始草稿，Shift+Enter 换行，输入法组合态（`isComposing`）与键码 229 不发送，长按重复的 Enter 不新增提交，空白草稿与锁定期间不可发送。

**回合进行中**（从提交、经运行中回合、直到权威终态）发送按钮 SHALL 原位换成 `停止` 按钮（可访问名与 tooltip 均为 `停止`），并显示 `role="status"` 的 `生成中`。`停止` 每个点击序列 SHALL 恰调用一次 `stopSession`（点击后到响应或终态之间禁用）；`"stopping"`（202）与 `"idle"`（204）都 SHALL NOT 弹任何提示；错误信封就地显示在输入框上。输入框保持锁定直到权威 `stopped` 状态到达（`turn.end stopped` 或终态快照），届时会话列表状态元素与仍在运行的步骤徽章读作 `已停止`，助手消息显示 `已停止` 徽章，输入框解锁并恢复 `发送`。

**能力栏**自左向右 SHALL 为：
1. 工作空间：欢迎态是选择器，触发按钮文本为 `任务启动于 <空间名>`，未选择时为 `任务启动于 未选择`（默认），选项为本账号的工作空间（选择器的呈现、搜索、数据来源与所选值进入创建请求的规则见 session-sidebar「composer footer 工作空间选择」）；已选会话时同一位置是只读标签，同样以 `任务启动于` 开头：会话用临时空间（`temporaryWorkspace` 为 true）时为 `任务启动于 临时空间`，`workspaceId` 为 null（存量的未绑定会话）时为 `任务启动于 未绑定`，绑定的工作空间在已读取的列表里时为 `任务启动于 <空间名>`，`workspaceId` 非空、`temporaryWorkspace` 为 false 但在已读取的列表里找不到（读取中、读取失败或空间已删除）时为 `任务启动于 已绑定空间`；标签不可操作、不发出任何修改请求（会话开始后工作空间锁定）。
2. 「+」菜单：触发按钮的可访问名为 `技能与命令`，输入框锁定时、以及草稿不是空白（去掉首尾空白后非空）时按钮禁用——后者与「此时输入 `/` 不会打开斜杠候选」是同一条件；打开后列出当前工作空间命令目录（`listCommands(workspaceId)`）的全部条目（内建命令与技能），按目录顺序，每项显示 `label` 与 `description`，`source` 为 `project` 的条目带与斜杠候选相同的标记（`项目`，`overrides` 为真时 `项目 · 覆盖平台技能`），目录字符串一律按纯文本呈现。点选一项 SHALL 把草稿设为 `/<name> `（末尾一个空格；只有草稿为空白时才可能点选，所以不会覆盖已有文字）、关闭菜单并聚焦文本框（以 Esc 或点击菜单外关闭时草稿不变，焦点回到 `技能与命令` 按钮），SHALL NOT 发送。「+」菜单与斜杠候选共用同一份按工作空间 id 缓存的目录与同一套拉取时机规则：打开菜单时若当前 client 与工作空间 id 尚无目录且无在途调用，则发出一次 `listCommands(workspaceId)`；目录未持有（拉取中或失败）或目录为空时菜单不列出条目，只显示 `暂无可用项`；已持有的目录在菜单关闭的过程中仍照常列出，不显示错误；菜单打开期间目录到达时，条目列表 SHALL 就地替换 `暂无可用项`，不需要重新打开菜单。

权限设置、上传文件、专家、附件、模型切换与麦克风 SHALL NOT 渲染，既不出现在能力栏，也不出现在「+」菜单里，不摆禁用占位。

**Slash candidates**: while the draft matches `^\/[^\s]*$` and the composer is enabled, the composer SHALL show above the textarea a `role="listbox"` panel (`aria-label` `命令候选`) listing, from `listCommands(workspaceId)`, every command whose `name` or `label` starts with the typed text after `/` (case-sensitive), in catalogue order, each as a `role="option"` showing `label`, `description` and, when non-null, `hint` in muted text; an option whose `source` is `project` additionally shows the tag `项目`, or `项目 · 覆盖平台技能` when `overrides` is true, and every catalogue string is rendered as plain text. `workspaceId` is the selected session's workspace id (null when unbound) and, in the welcome state, the workspace currently chosen in the capability bar's workspace selector (null for none). The catalogue is fetched lazily and kept in a map keyed by workspace id (null included) for the lifetime of the client — a catalogue is never dropped when the workspace id changes, and a new client starts with an empty map: one `listCommands(workspaceId)` call is issued when the condition becomes true — or the client or the workspace id changes while it is true — while no catalogue is held for the current client and workspace id and no call is in flight for them; a catalogue held for another workspace id is never shown; while that call is pending the panel stays hidden and appears on its success if the condition still holds; a failed call keeps the panel hidden without any error UI, and a new call is issued only at the next such trigger (not on further keystrokes while the condition stays true). The first option is highlighted: the listbox's `aria-activedescendant` names it and it alone carries `aria-selected="true"`; `↑`/`↓` move the highlight cyclically and keep the highlighted option scrolled into view inside the panel, which has a bounded height; `Enter` or `Tab` replaces the draft with `/<name> ` (one trailing space) and closes the panel, `Esc` closes it until the draft changes (returning later to the same text shows it again), clicking an option does what `Enter` does for that option and does not move the focus (the panel and its options are not tab stops and a press on the panel does not take the focus from the textarea), and `Enter` with the panel open SHALL NOT submit; `Shift+Enter`, `Shift+Tab` and keys with `Ctrl`/`Alt`/`Meta` are not intercepted. Any change of the draft, and any change of the workspace id whose catalogue the panel shows, resets the highlight to the first option; a dismissal by `Esc` still lasts until the draft changes, whatever the workspace id does. Key events during an IME composition (`isComposing` or `keyCode` 229, the composer's existing rule) SHALL neither move the highlight nor pick an option, so confirming a Chinese candidate such as `/任务` with Enter is not a pick; with no matching command the panel is hidden and `Enter` submits as usual — an unmatched `/xxx` is sent unchanged (the server decides how omp receives it, chat-sessions「Slash 命令白名单与命令目录」), and the user bubble shows it as typed. The panel's state SHALL stay outside `page.tsx`, in `features/chat/slash-menu-state.ts`.

用临时空间的会话，其命令目录、斜杠候选与项目配置 SHALL 以该会话的 `workspaceId`（临时空间的 id）取用，与绑定正式空间的会话同一路径（`listCommands(workspaceId)`）；只有 `workspaceId` 为 null 的存量会话与欢迎态未选择空间时才以 `null` 取用。输入框草稿可被 `撤回` 覆盖（message-undo「web 撤回」），规则与 `从此处分叉` 写入草稿相同：不发送、焦点到文本框。

#### Scenario: 输入框键盘发送
- WHEN 可发送的草稿在输入框收到无修饰的 Enter
- THEN 通过同一表单受理路径发送一次原始草稿；Shift+Enter 保留换行，输入法 composing 或确认键码229不发送，长按重复Enter不新增提交；空草稿及生成中仍不可发送

#### Scenario: 停止生成
- **WHEN** 一次回合 running 期间（含一条 running `bash` 步骤、无挂起审批）用户点击 composer 的 `停止`，服务端返回 202，随后 SSE 送达 `turn.end stopped`
- **THEN** 点击前输入框无 `发送` 按钮而有可访问名 `停止` 的按钮与 `role=status` `生成中`；点击后 `stopSession` 恰调用一次、按钮禁用，页面上不出现任何轻提示（含 `已停止生成`）；`turn.end stopped` 到达后 composer 解锁并恢复 `发送`，助手消息末尾出现名为 `助手消息 已停止` 的 `role=status` 徽章，展开工具调用组后仍 running 的步骤徽章为 `已停止`（步骤名 `bash 已停止`），侧栏该会话状态元素名为 `<title> 已停止`，助手消息无错误文案；再次发送 prompt 走既有受理路径
- **WHEN** 点击 `停止` 时服务端返回 204
- **THEN** 不出现任何轻提示，composer 以下一份权威快照的状态为准

#### Scenario: 「+」菜单写入草稿
- **WHEN** 已选会话绑定工作空间 A、草稿为 `半句`；清空草稿后点击可访问名为 `技能与命令` 的「+」按钮打开菜单（`listCommands("A")` 返回两条内建、`skill:weekly-report`（`source:"skill"`）与 `skill:deploy`（`source:"project"`、`overrides:false`）），点选 `deploy`；随后清空草稿再输入 `/`；另一例 `listCommands` 尚未返回时打开菜单，菜单仍开着时它成功返回；再一例它失败后打开菜单；还有一例回合进行中（输入框锁定）
- **THEN** 草稿为 `半句` 时 `技能与命令` 按钮处于禁用，清空后可用；菜单按目录顺序恰列四项，`deploy` 带 `项目` 标记；菜单里没有权限设置、上传文件、专家；点选后草稿为 `/skill:deploy `、菜单关闭、焦点在文本框，没有发出 prompt；清空草稿再输入 `/` 时斜杠候选直接显示同一份目录、不再发新的 `listCommands` 调用；拉取中的一例菜单先只显示 `暂无可用项`，目录到达后在仍打开的菜单里就地换成条目列表、`暂无可用项` 消失；失败的一例菜单不列条目、只显示 `暂无可用项`，不显示错误；输入框锁定的一例 `技能与命令` 按钮处于禁用

#### Scenario: 已选会话工作空间只读
- **WHEN** 选中一个绑定工作空间 `项目A` 的会话；再选中一个未绑定工作空间的会话；再选中一个 `workspaceId` 非空、`temporaryWorkspace` 为 false、但该空间不在已读取列表里（已删除，或工作空间列表读取失败）的会话；再选中一个 `temporaryWorkspace` 为 true 的会话；随后回到欢迎态
- **THEN** 四者的能力栏分别显示只读的 `任务启动于 项目A`、`任务启动于 未绑定`、`任务启动于 已绑定空间`、`任务启动于 临时空间`，都没有可打开的工作空间选择器，切换前后没有发出修改会话的请求；回到欢迎态后能力栏是可操作的选择器，按钮为 `任务启动于 未选择`

#### Scenario: 斜杠命令候选
- **WHEN** 在欢迎态与已选会话（均未绑定工作空间）的 composer 中分别输入 `/`（`listCommands(null)` 返回两条内建与 `skill:weekly-report`），再输入 `/t`，按 `↓` `↑` `Enter`；再输入 `/help` 后 `Enter`；再输入 `/` 后 `Esc`；输入法组合态下（`isComposing`）输入 `/任` 并按 Enter；以及 `listCommands(null)` 失败时输入 `/`
- **THEN** 输入 `/` 时出现 `命令候选` listbox 恰三项、第一项 `整理上下文` 高亮，`/t` 过滤为 `任务清单` 一项（`todo` 前缀命中），`↓`/`↑` 循环回到该项，`Enter` 使 draft 变为 `/todo ` 且面板关闭、不发送；`/help` 无候选、面板隐藏，`Enter` 照常发送且用户气泡显示 `/help`；`Esc` 关闭面板、再输入字符后重新出现；组合态的 Enter 既不选中也不发送，draft 保持输入法上屏结果；拉取失败时无面板、无错误提示，下次满足条件时重新拉取

#### Scenario: 候选目录的拉取时机
- **WHEN** 首次输入 `/` 而 `listCommands(null)` 尚未返回，其间清空并再次输入 `/`，随后它成功；另一例它失败后继续输入 `/t`，再清空并重新输入 `/`
- **THEN** 返回之前没有面板，成功后（draft 仍满足条件）面板出现，整个过程恰一次调用；失败的一例里 `/t` 不触发新的调用，重新输入 `/` 时发出第二次调用（共恰两次）

#### Scenario: 点击与 Tab 选中
- **WHEN** 面板打开时点击 `任务清单`，另一例按 `Tab`，再一例按 `Shift+Tab`
- **THEN** 点击与 `Tab` 都使 draft 变为对应的 `/<name> ` 并关闭面板，输入框的焦点不被移走，不发送；`Shift+Tab` 不选中

#### Scenario: 候选面板按工作空间取目录
- **WHEN** 已选会话绑定工作空间 A，输入 `/`（`listCommands("A")` 返回两条内建、一条平台 skill、`skill:deploy`（`source:"project"`、`overrides:false`）与 `skill:weekly-report`（`source:"project"`、`overrides:true`））；随后切到未绑定工作空间的会话并输入 `/`；再回到欢迎态、在能力栏的工作空间选择器选中工作空间 A 后输入 `/`
- **THEN** 第一次面板恰五项，`deploy` 一项带 `项目` 标记，`weekly-report` 一项带 `项目 · 覆盖平台技能` 标记，其余无标记；切到未绑定会话时发出 `listCommands(null)`，其返回前不显示 A 的目录；欢迎态选中 A 后显示的是 A 的目录且不再发新调用（同一 client 与工作空间 id 已持有）

#### Scenario: 切换工作空间后高亮回到首项
- **WHEN** 欢迎态草稿为 `/`、未选工作空间的目录有三项，按两次 `↓`（第三项高亮），随后在能力栏的工作空间选择器选中工作空间 A（其目录有五项），再按 `Enter`；另一例在第三项高亮时按 `Esc` 后切到工作空间 A
- **THEN** 切换后面板显示 A 的目录且第一项高亮（`aria-activedescendant` 指向它，仅它 `aria-selected="true"`），`Enter` 选中的是 A 的第一项；另一例切换后面板保持关闭，草稿变化后重新出现且第一项高亮
