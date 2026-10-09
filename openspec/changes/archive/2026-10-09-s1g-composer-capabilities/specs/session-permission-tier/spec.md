## ADDED Requirements

### Requirement: 档位与 omp 审批模式
会话的工具审批档位 SHALL 取 omp 的三个审批模式字面量之一，从存储、API 到 spawn 参数不做任何映射：`always-ask`（界面名 `每次都问`：写文件与执行命令的工具都先请求确认）、`write`（界面名 `只问命令`：只有执行命令一类的工具请求确认，写文件不请求——本 change 之前唯一的行为）、`yolo`（界面名 `全部自动`：工具不因档位请求确认）。严格程度的次序为 `always-ask < write < yolo`。
会话每一次 generation spawn 与以它为源的 fork 临时进程 SHALL 以 `--approval-mode <该会话的有效档位>` 启动（有效档位见 session-composer-settings「有效值解析」；argv 的位置与其余参数见 omp-runtime「子进程 spawn 契约」）。
宿主 SHALL NOT 因档位而自行应答、丢弃或改写任何 `extension_ui_request`：是否请求确认完全由 omp 决定，凡被识别为审批请求的（tool-approval「审批请求识别」）在任何档位下都照常登记、出确认卡、可作答。宿主 overlay 的文件内容不随档位变化（omp-runtime「宿主 overlay」）。
三档在真实 omp v18.0.10 上的行为由官方二进制对照用例钉住（见下方场景）；升级 omp 时 SHALL 重跑。

#### Scenario: 每次都问（真实 omp）
- **WHEN** 官方 omp v18.0.10 以 `--approval-mode always-ask` 与原样的宿主 overlay 启动，受控上游在一个回合里发出 `write` 工具调用（`WORKBUDDY_WRITE`），另一个回合发出 bash 工具调用
- **THEN** 两个回合宿主各收到一条审批请求，`tool` 分别为 `write` 与 `bash`，`title` 首行分别为 `Allow tool: write` 与 `Allow tool: bash`；作答 `Approve` 后工具执行、回合正常结束
- **WHEN** 同一档位下会话 cwd 预置 `.omp/config.yml`，内容为 `tools.approval: {write: allow}`，再跑一个 `WORKBUDDY_WRITE` 回合
- **THEN** 宿主仍收到 `write` 的审批请求（项目层的逐工具放行被 overlay 清掉）

#### Scenario: 只问命令（真实 omp，既有行为）
- **WHEN** 官方 omp 以 `--approval-mode write` 启动，分别跑一个 `WORKBUDDY_WRITE` 回合与一个 bash 回合
- **THEN** `write` 回合没有审批请求、文件被写出；bash 回合恰一条 `tool="bash"` 的审批请求

#### Scenario: 全部自动（真实 omp）
- **WHEN** 官方 omp 以 `--approval-mode yolo` 与原样的宿主 overlay（其中仍有 `tools.approvalMode: write`）启动，分别跑一个 bash 回合与一个 `WORKBUDDY_WRITE` 回合
- **THEN** 两个回合都没有审批请求，bash 与 write 都已执行，回合正常结束；`chat_approvals` 没有新行

#### Scenario: 档位进入 argv
- **WHEN** 有效档位分别为 `always-ask`、`write`、`yolo` 的三个会话各发一条 prompt（假 omp 真子进程，测试经注入的 spawn 包装记下 argv 后照常启动）
- **THEN** 三个进程的 argv 里 `--approval-mode` 之后的取值分别为 `always-ask`、`write`、`yolo`，其余参数与同一会话在别的档位下逐字相同

### Requirement: 换档从下一条消息起生效
会话的档位被修改后（session-composer-settings「修改会话设置」），SHALL 从该会话下一次派发的回合起生效，SHALL NOT 影响正在进行的回合：在途回合继续以其进程启动时的档位运行，已出现的确认卡保持待决、可作答、按原计时超时。
生效方式是在两个回合之间重启该会话的进程（chat-sessions「派发前按会话设置对齐进程」）：下一次派发时若存活进程的启动档位与有效档位不同，宿主先退役它，再以新档位与 `--resume` 取得一个新的 generation；会话历史不丢失。档位未变的会话 SHALL NOT 因此多一次重启。

#### Scenario: 生成中改档位
- **WHEN** 一个 `write` 档的会话正在进行一个带待决审批的回合（假 omp `approval`），owner 此时 PATCH `{approvalMode:"yolo"}`，随后对那条审批作答 `allow`，回合结束后再发一条 prompt
- **THEN** PATCH 之后原进程仍在、待决审批仍为待决且可作答；作答后该回合照常结束；第二条 prompt 由一个新进程处理，其 argv 含 `--approval-mode yolo` 与 `--resume <该会话的会话文件>`，`streamCursor.epoch` 比上一回合大一；第二个回合没有审批请求

#### Scenario: 未改档位不重启
- **WHEN** 一个会话连续完成两个回合，其间没有修改档位，或 PATCH 了与当前有效档位相同的值
- **THEN** 两个回合由同一个进程处理，`streamCursor.epoch` 不变

### Requirement: 超时规则各档相同
tool-approval「超时自动允许」的规则 SHALL 在三个档位下完全相同：每条待决审批自其 `requested_at` 起 60000 毫秒无人作答即结算为 `timeout` 并向 omp 应答 `Approve`。`always-ask` 下写文件类工具的审批同样适用，不因档位而延长、缩短或改为拒绝。

#### Scenario: 每次都问下的超时
- **WHEN** `always-ask` 档的会话里假 omp（`approval-write`）对 `write` 工具发起审批，注入时钟推进到请求后 59999 毫秒，再到 60000 毫秒
- **THEN** 59999 毫秒时该审批仍待决；60000 毫秒时结算为 `timeout`，假 omp 收到 `value:"Approve"`，发布 `approval.resolved{decision:"timeout"}`，写出一条 `session.approval` 审计（`detail.tool="write"`、`detail.decision="timeout"`）

### Requirement: 管理员最高档
`APPROVAL_MAX_MODE`（http-service-skeleton「服务启动与装配」）SHALL 是所有会话可用档位的上界：`GET /api/composer/options` 只列出不高于它的档位；创建与修改会话时高于它的取值被拒绝（400）；存储里高于它的原始选择（上界调低之前写入的，或继承而来的）在读取时被夹取到它。缺省 `yolo`，即三档都开放。
上界为 `always-ask` 时，缺省档 `write` 同样被夹取为 `always-ask`。上界只在服务启动时读取。

#### Scenario: 调低上界后既有会话被夹取
- **WHEN** 一个会话的 `approval_mode` 列为 `yolo`，服务以 `APPROVAL_MAX_MODE=write` 重启，owner 读取该会话并发一条 prompt
- **THEN** 会话视图 `approvalMode="write"`，进程的 argv 含 `--approval-mode write`；列值仍为 `yolo`；该次读取与派发不写审计
- **WHEN** 服务以 `APPROVAL_MAX_MODE=always-ask` 启动，一个三列均为 NULL 的会话被读取并发一条 prompt
- **THEN** 视图 `approvalMode="always-ask"`，argv 含 `--approval-mode always-ask`

### Requirement: 档位变更审计
档位的每一次实际变化 SHALL 经 `core/audit` 既有 `emit` 写恰一条审计，且与使其变化的业务写入处于同一个 SQLite 事务（业务回滚则审计不存在，审计失败则业务不生效）；`kind="session.permission"`、`actorId`=会话 `owner_id`、`title="修改权限档位"`、`workspaceId`=该会话的 `workspace_id`（未绑定为 null）、`detail={sessionId, from, to}`：

- `PATCH /api/sessions/:id` 使有效档位由 `from` 变为不同的 `to` 时写一条；有效档位未变（重复选择当前档、或 body 不含 `approvalMode`）SHALL NOT 写。
- `POST /api/sessions` 创建时，写入会话行的原始档位（请求显式给出或由最近选择继承）非 NULL，且它的有效档位不同于「原始值为 NULL 时的有效档位」（即当前配置下的缺省档：通常是 `write`，上界为 `always-ask` 时是 `always-ask`）时写一条，`from` 为 `null`、`to` 为该有效档位；原始档位为 NULL、或其有效档位就是缺省档的创建 SHALL NOT 写（没有偏离缺省的用户选择）。
- fork 继承档位 SHALL NOT 写；配置变化导致的夹取 SHALL NOT 写（没有用户动作）。

模型与推理强度的变化 SHALL NOT 写审计。`GET /api/audit` SHALL 以既有形状返回该事件，沿用按 actor 过滤与管理员可见的既有规则。

#### Scenario: 修改与重复选择
- **WHEN** owner 对一个 `write` 档、绑定工作空间 W 的会话依次 PATCH `{approvalMode:"yolo"}`、`{approvalMode:"yolo"}`、`{modelId:"m3"}`、`{approvalMode:"always-ask", title:"新名"}`
- **THEN** `GET /api/audit` 恰新增两条 `session.permission`：`detail={sessionId, from:"write", to:"yolo"}` 与 `detail={sessionId, from:"yolo", to:"always-ask"}`，`title` 均为 `修改权限档位`，`workspaceId=W.id`，`actorId` 为该 owner；第二个非管理员账号的 `GET /api/audit` 不含它们

#### Scenario: 创建时的审计
- **WHEN** 一个从未做过选择的账号以无 body 创建会话；以 `{approvalMode:"yolo"}` 创建第二个；再以无 body 创建第三个（继承 `yolo`）；最后对第三个会话调用 fork
- **THEN** 第一次创建没有 `session.permission`；第二、三次各新增一条 `detail={sessionId:<各自的 id>, from:null, to:"yolo"}`；fork 没有新增
- **WHEN** 服务以 `APPROVAL_MAX_MODE=always-ask` 启动，一个从未做过选择的账号以无 body 创建会话；另一个最近选择为 `yolo` 的账号以无 body 创建会话；`APPROVAL_MAX_MODE` 未设置时一个账号以 `{approvalMode:"write"}` 创建会话
- **THEN** 三次创建都没有 `session.permission`（第一例没有用户选择；第二例继承的 `yolo` 被夹取为缺省档 `always-ask`；第三例显式选择的就是缺省档），视图的 `approvalMode` 分别为 `always-ask`、`always-ask`、`write`

#### Scenario: 审计失败则修改不生效
- **WHEN** PATCH `{approvalMode:"yolo"}` 的事务里审计插入失败（测试注入）
- **THEN** 响应为 generic 5xx；会话行的 `approval_mode` 与账号最近选择均未改变

### Requirement: 权限档位控件
输入框能力行左组的第三项（chat-web「输入框与能力栏」）SHALL 是权限档位控件，位于 `web/src/features/chat/` 的应用层文件内，由拷入层的 dropdown-menu 与 alert-dialog 组合而成，不修改拷入文件。

**触发按钮**：文字为当前档位的界面名（`每次都问` / `只问命令` / `全部自动`），可访问名为 `权限：<界面名>`。当前档位为 `yolo` 时按钮 SHALL 以警示色呈现（使用 `--wb-status-warning` 一组 token）并带 `data-tier="yolo"`；其它档位不带警示色。
**菜单**：一个单选组，按 `options.approvalModes` 的次序只列出可用档位，每项为 `menuitemradio`，当前档位 `aria-checked="true"`；每项显示界面名与一行说明——`每次都问`：`写文件与执行命令前都要你确认`；`只问命令`：`执行命令前要你确认，写文件不用`；`全部自动`：`不经确认执行命令与修改文件`。菜单底部 SHALL 有一行文字 `更改从下一条消息起生效`。只有一个可用档位时控件仍渲染，菜单只含该项。
**选择**：选中当前档位只关闭菜单，不发请求。选中 `全部自动`（且当前不是它）SHALL 先打开确认框：标题 `切换到全部自动？`，正文 `助手将不经确认直接执行命令与修改文件。`，按钮 `取消` 与 `确认切换`；`取消` 或 Esc 关闭确认框且不改变档位、不发请求；点击遮罩不关闭（拷入层 alert-dialog 的既有行为，与 `删除任务`、`退出登录` 的确认框一致）；`确认切换` 才提交。选中其它档位直接提交，不弹确认框。
**提交**：已选会话时恰调用一次 `patchSession(sessionId, {approvalMode})`，在途期间本控件禁用，成功后以响应的会话视图为准；失败时在输入框上就地显示 `ApiError` 的 message，控件显示值保持服务端原值。欢迎态没有会话：选择只更新页面内存里的值（初值为 `options.defaults.approvalMode`）；只有用户在欢迎态实际选过档位时，首次发送的创建请求才带上 `approvalMode`（chat-web「API 客户端扩展」），没选过则不带该键、由服务端按最近选择继承——`defaults` 是夹取后的有效值，把它原样发回去会覆盖账号存着的原始选择。欢迎态下选 `全部自动` 同样先确认。
**可用性**：控件 SHALL NOT 因输入框锁定（回合进行中、历史加载、分叉在途）而禁用——生成中可以改档位；只在自己的提交在途时禁用。`options` 未取得（拉取中或失败）时控件不渲染、不摆占位。
由继承或刷新而处于 `全部自动` 的会话 SHALL 直接以警示色显示，不弹确认框（确认只发生在用户做出选择的那一刻）。

#### Scenario: 切换到全部自动要确认
- **WHEN** 已选会话的档位为 `只问命令`，打开权限菜单选 `全部自动`；先在确认框里点 `取消`；再次选 `全部自动` 并点 `确认切换`，服务端返回的视图 `approvalMode="yolo"`
- **THEN** 菜单恰列三项，每项带各自的说明，底部有 `更改从下一条消息起生效`；第一次没有发出任何 PATCH，按钮仍为 `权限：只问命令`、不带 `data-tier="yolo"`；第二次恰一次 `patchSession(id,{approvalMode:"yolo"})`，成功后按钮可访问名为 `权限：全部自动`，带 `data-tier="yolo"` 与警示色的样式声明

#### Scenario: 其它档位直接生效与失败回退
- **WHEN** 档位为 `全部自动` 时选 `每次都问`，服务端 200；随后选 `只问命令` 时服务端返回 400 信封
- **THEN** 第一次没有确认框，恰一次 PATCH，按钮变为 `权限：每次都问` 且不再带警示色；第二次失败后输入框上显示信封文案，按钮仍为 `权限：每次都问`

#### Scenario: 生成中可改
- **WHEN** 回合进行中（输入框锁定、`停止` 可用）打开权限菜单并选 `每次都问`
- **THEN** 控件可操作，发出一次 PATCH；`停止` 与 `生成中` 不受影响，没有发出 prompt、stop 或其它请求

#### Scenario: 欢迎态的选择进入创建请求
- **WHEN** 欢迎态 `options.defaults.approvalMode="write"`，用户选 `每次都问` 后输入文字并发送
- **THEN** 选择时没有任何请求；`createSession` 的 input 含 `approvalMode:"always-ask"`；建出的会话选中后按钮为 `权限：每次都问`
- **WHEN** 另一例欢迎态不碰权限控件直接输入文字并发送
- **THEN** `createSession` 的 input 不含 `approvalMode` 键

#### Scenario: 封顶与继承的呈现
- **WHEN** `options.approvalModes` 为 `["always-ask","write"]`；另一例打开一个视图 `approvalMode="yolo"` 的会话（继承而来）；再一例 `getComposerOptions` 失败
- **THEN** 第一例菜单恰两项，没有 `全部自动`；第二例按钮直接为警示色的 `权限：全部自动`，没有出现确认框；第三例能力行里没有权限控件，其余控件照常
