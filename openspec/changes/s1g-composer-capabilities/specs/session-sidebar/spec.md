## MODIFIED Requirements

### Requirement: 会话 DTO 严格解析
web 的会话解析 SHALL 要求会话对象恰含十四键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt,archivedAt,pendingApproval,temporaryWorkspace,approvalMode,modelId,reasoningEffort}`（`hasExactlyKeys`），并逐键校验：`status` ∈ `idle|running|done|failed|stopped`；`scene` ∈ `office|code|design|null`；`workspaceId` 为 32 位小写十六进制字符串或 null；`pinnedAt` 与 `archivedAt` 为非负安全整数或 null；`pendingApproval` 与 `temporaryWorkspace` 为布尔；`approvalMode` ∈ `always-ask|write|yolo`；`modelId` 为非空字符串；`reasoningEffort` ∈ `off|minimal|low|medium|high|xhigh|max|auto|null`；`workspaceId` 为 null 而 `temporaryWorkspace` 为 true 的对象不合法。缺键、多余键或任一值不合法 SHALL 使该响应按既有规则视为无效成功响应（不部分采用）。该规则 SHALL 统一作用于 `GET /api/sessions` 列表项、`POST /api/sessions` 与 `PATCH /api/sessions/:id` 响应、消息快照的 `session`、fork 与 undo 响应的 `session`。API 客户端的 `patchSession(id, patch)`（`PATCH`，JSON body，成功 200 返回解析后的会话；`patch` 的键为 `title`、`scene`、`pinned`、`archived`、`approvalMode`、`modelId`、`reasoningEffort` 的非空子集）、`deleteSession(id)`（`DELETE`，无 body，成功恰为 204）与 `createSession(input?, options?)`（可选 input `{workspaceId?, scene?, approvalMode?, modelId?, reasoningEffort?}`）沿用既有 same-origin、AbortSignal、错误信封与 401 通知机制，路径 id 编码。键集的服务端一侧见 session-metadata「会话视图扩展键」与 chat-sessions「会话 REST」；`archivedAt`、`pendingApproval`、`temporaryWorkspace` 三键的两侧 SHALL 同一个改动落地，`approvalMode`、`modelId`、`reasoningEffort` 三键的最终形状见 chat-web「API 客户端扩展」的「S1g 输入框能力」一段。

#### Scenario: 十一键接受与其它键集拒绝
- **WHEN** `GET /api/sessions` 分别返回：合法十四键会话；缺 `archivedAt` 的十三键会话；旧的八键会话；不带 `approvalMode`、`modelId`、`reasoningEffort` 的十一键会话；多一个 `parentSessionId` 的十五键会话；`pendingApproval:"yes"` 的会话；`approvalMode:"auto"` 的会话；`workspaceId:null` 且 `temporaryWorkspace:true` 的会话
- **THEN** 第一种被接受并渲染；其余七种都使列表读取呈现既有的无效响应失败，不渲染任何部分列表

#### Scenario: 客户端方法
- **WHEN** 调用 `patchSession(id,{archived:true})`、`patchSession(id,{pinned:true})`、`deleteSession(id)`、`createSession({scene:"code"})` 与无参 `createSession()`
- **THEN** 请求分别为 `PATCH /api/sessions/<id>` body `{"archived":true}`、同路径 body `{"pinned":true}`、`DELETE /api/sessions/<id>` 无 body、`POST /api/sessions` body `{"scene":"code"}` 且 `Content-Type: application/json`、`POST /api/sessions` 无 body；`deleteSession` 对 200 视为无效响应

### Requirement: composer footer 工作空间选择
工作空间选择 SHALL 位于 composer 能力行左组的第二项：在「+」菜单之后、权限档位控件之前（能力行的分组、次序与其余控件见 chat-web「输入框与能力栏」；专家与麦克风控件 SHALL NOT 渲染，也不摆禁用占位）。

欢迎态下它是一个选择器：触发按钮的可见文本与 accessible name 为 `任务启动于 <空间名>`，未选择时为 `任务启动于 未选择`（默认）。点击按钮 SHALL 打开弹层，内含：accessible name 与 placeholder 为 `搜索工作空间` 的搜索输入框；选项 `未选择`；以及会话页已读取的该账号工作空间列表中的每个空间（按 `GET /api/workspaces` 的返回顺序；打开弹层不另发请求），显示空间名与 ADR-0011 逻辑路径 `<account>/<dir>`（`account` 取当前 Principal；不渲染空间根路径）。输入框按空间名做大小写不敏感子串过滤（查询先去掉首尾空白；`未选择` 始终保留），无匹配时显示 `没有匹配的工作空间`；每次打开弹层查询为空。当前选中项 SHALL 以 `aria-pressed="true"` 标示。选择任一项 SHALL 关闭弹层、更新按钮文本并把焦点还给按钮；`新建工作空间` 与 `挂载目录到当前空间` SHALL NOT 渲染。没有可用的空间列表时弹层按最近一次读取的状态呈现：读取在途（首次读取，或失败后的重新读取）显示 `正在读取工作空间`；读取失败显示 `role="alert"` 的信封 message 或 `请求失败，请稍后重试`；两种情况下仍可选 `未选择`。选中空间为会话页内存状态（选中会话后再回到欢迎态保留；刷新或离开会话页复位为未选择），作用于其后由欢迎态首次发送发起的创建请求（`workspaceId`）；侧栏 `新建会话` 不发创建请求（见「欢迎页场景胶囊与场景化快捷任务」），也不改变已选空间。选中的空间不在当前已读取的列表中时（列表被重新读取后它已不存在、读取失败或换了账号）按钮显示 `任务启动于 未选择` 且创建请求不带 `workspaceId`——按钮文本与请求体始终一致。按钮显示 `任务启动于 未选择` 时发出的创建请求不带 `workspaceId`，服务端为这个新会话创建临时空间（temporary-workspaces「临时空间的创建」）；临时空间 SHALL NOT 出现在选择器的选项里。composer 锁定期间按钮禁用，已打开的弹层随之关闭且解锁后不自动重开。

选中会话后（会话开始后工作空间即锁定）同一位置 SHALL 是只读标签而不是按钮，文本同样以 `任务启动于` 开头：会话 `temporaryWorkspace` 为 true 时为 `任务启动于 临时空间`；`workspaceId` 为 null（存量的未绑定会话）时为 `任务启动于 未绑定`；`workspaceId` 对应的空间在已读取的空间列表里时为 `任务启动于 <空间名>`；`workspaceId` 非空、`temporaryWorkspace` 为 false 但在已读取的列表里找不到（列表读取中、读取失败或空间已删除）时为 `任务启动于 已绑定空间`。它不可点击、不打开弹层、不发请求，页面不提供更换已有会话工作空间的入口。

#### Scenario: 选择空间后创建绑定会话
- **WHEN** 账号 `zhangsan` 有空间 `项目A`（dir `项目A`）与 `客服`，欢迎态打开 `任务启动于 未选择`，在 `搜索工作空间` 输入 `项目`，选择 `项目A`，再输入并发送
- **THEN** 弹层只列 `未选择` 与 `项目A`（副文本 `zhangsan/项目A`）；选择后按钮文本为 `任务启动于 项目A`、焦点在该按钮；`POST /api/sessions` body 为 `{"scene":"office","workspaceId":"<项目A 的 id>"}`；新会话出现在侧栏名为 `项目A` 的分组内；会话被选中后能力栏不再有工作空间选择按钮，同一位置为只读文本 `任务启动于 项目A`

#### Scenario: 无权限元素与无匹配
- **WHEN** 欢迎态查看 composer 能力栏并在弹层中搜索 `不存在`
- **THEN** 能力行没有专家与麦克风控件，也没有 `完全访问` 或 `默认权限` 文本（权限档位控件与「+」菜单里的 `上传文件` 分别由 session-permission-tier「权限档位控件」与 message-attachments「输入框附件标签」规定，不属于本条）；弹层显示 `未选择` 与 `没有匹配的工作空间`，无 `新建工作空间` 与 `挂载目录到当前空间`

#### Scenario: 会话开始后只读
- **WHEN** 打开一个绑定空间 `项目A` 的会话；另一次打开一个 `workspaceId` 为 null 的会话；再一次打开一个 `workspaceId` 非空、`temporaryWorkspace` 为 false、但空间列表读取失败或该空间已不在列表里的会话；再一次打开一个 `temporaryWorkspace` 为 true 的会话
- **THEN** 四者的能力栏分别显示只读文本 `任务启动于 项目A`、`任务启动于 未绑定`、`任务启动于 已绑定空间`、`任务启动于 临时空间`；都没有工作空间选择按钮，点击该文本不打开弹层、不发请求

#### Scenario: 未选择空间发送得到临时空间会话
- **WHEN** 欢迎态按钮显示 `任务启动于 未选择` 时输入并发送，`POST /api/sessions` 返回 `temporaryWorkspace` 为 true 的会话
- **THEN** 创建请求的 body 为 `{"scene":"office"}`（不含 `workspaceId`）；会话被选中后能力栏同一位置为只读文本 `任务启动于 临时空间`；新会话出现在侧栏的 `临时空间` 分组内；选择器的选项里没有任何临时空间
