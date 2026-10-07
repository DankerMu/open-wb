# Design: s1f-session-list-temp-space

## Context

现状（master `d7c575c`，逐条读过代码）：

- 会话列表是 `web/src/features/chat/` 下八个旧文件（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、
  `session-actions.ts`、`session-path.ts`、`rename-dialog.tsx`、`delete-dialog.tsx`），仍从冻结区 `web/src/ui` 取 `Button`、`Menu`、`Dialog`、`useToast`，
  样式在 `chat.css`；`web/test/ui-layering.test.ts` 用 `SESSION_LIST_FILES` 把它们排除在已迁移清单之外。
- 会话视图八键（`server/src/sessions/store.ts` 的 `SessionView`）；列表查询按 `updated_at DESC, id ASC`，不带任何审批信息。
- `workspace_id` 只在 `POST /api/sessions` 或 fork 继承时写入；`sessionCwdResolver`（`session-cwd.ts`）对 NULL 返回 `<SANDBOX_ROOT>/<ownerId>`，
  对非 NULL 走工作空间 store 的 `rootOf`，从不建目录。omp `--resume` 以会话文件头里的 cwd 为准，所以一个会话的 cwd 终身不变。
- `workspaces(id, owner_id, name, dir, created_at)`，`UNIQUE(owner_id,name)`、`UNIQUE(owner_id,dir)`，`dir` 的字符集不含 `/` 与 `.`；
  `computeSafeRoot` 只接受 `<SANDBOX_ROOT>/<ownerId>/<dir>` 这一层。没有删除、改名端点。
- 唯一的 SSE 是单会话的 `GET /api/sessions/:id/events`（`sessions/stream/sse.ts`：固定响应头、15 秒心跳、`preClose` 时销毁连接）。
- `branching.ts`：regenerate 在会话自己的进程上对**最后一个**条目 `branch`，随后把 `omp_session_file` 指到新文件；fork 先退役源进程，
  在**临时进程**上对**任意**条目 `branch`，再用一个事务拷贝历史。两者共用 `alignBranchEntries` / `branchTo`。白名单命令回合在 omp 的分支列表里没有条目，二者都拒绝。
- ADR-0010：`SANDBOX_ROOT` 整棵 `2770`，omp 用户可写；`OMP_STATE_DIR` 根 `2750`，其下 `trash` 是 app 私有 `0700`（omp 用户进不去），
  路径与权限位只有一个来源 `sessions/omp/state-layout.ts`。所有账号共用一个 omp 用户。
- `HTTP_ERROR_MESSAGES` 十三码；content-parser 归属集十二条（http-service-skeleton「统一错误信封」）。
- `store.ts` 797 行、`supervisor.ts` 800 行，已到 800 行上限。

### Grill 结论落点

| # | 结论（`.workplans/stage/grill-C.md`） | 落点 |
|---|---|---|
| 1 | 置顶区 + 按工作空间可折叠分组，可切按时间；本地记忆；取消状态 / 时间筛选 | D2；session-sidebar ADDED「分组侧栏」，REMOVED「分区侧栏」「状态与时间筛选」 |
| 2 | 不做未读 | Non-Goals |
| 3 | 每行只有标题和一个状态标记 | D3；session-sidebar「会话状态标记」 |
| 4 | 可见标记只有运行中 / 等待确认 / 失败 | D3；同上 |
| 5 | 服务端推送：按用户的轻量事件连接 | D5；`session-list-push` |
| 6 | 只搜标题，前端过滤；归档不在结果里 | D2；session-sidebar「标题搜索」 |
| 7 | 归档：隐藏可恢复、保留内容与空间、底部入口、运行中不能归档、打开只读 | D4；session-metadata「会话归档」，session-sidebar「归档视图」 |
| 8 | 更多菜单六项 | session-sidebar「会话条目菜单与重命名」 |
| 9 | 删除仍确认；临时空间的文件一并删除写进确认框 | 同上 |
| 10 | 导出 Markdown，前端生成 | D14；session-sidebar「导出记录」 |
| 11 | 另存为工作空间 = 原地转正 | D7；`temporary-workspaces`「转正」 |
| 12 | 分叉共用临时空间；最后一个会话删除时才删目录；转正后都绑定正式空间 | D6、D8；`temporary-workspaces`「共用与删除」 |
| 13 | 老的未绑定会话保持原样；列表里与临时空间同组 | D6；session-metadata「绑定不可改与工作目录」，session-sidebar「分组侧栏」 |
| 14 | 未选空间发送第一条消息时创建；文件页不列出 | D6；`temporary-workspaces`「创建」「可见性」；临时空间会话的产物卡照常显示 → D17，turn-artifacts「文件变更卡」「产物卡」「产物面板」（owner C-26） |
| 15 | 撤回语义：移除、回填并覆盖草稿、不确认；次序 复制、撤回、从此处分叉 | D11；`message-undo`，chat-web「消息线程」 |
| 16 | 任意一条用户消息 | D11；owner 补充决定 C-23、C-24 收窄了它（命令回合、分叉拷贝来的消息不能撤回），见下表 |
| 17 | 每回合前快照，撤回时还原 | D9、D10；`workspace-snapshots` |
| 18 | 单文件与总量上限；超限文件不进快照并列出；总量超限该轮不做；随会话删除清理；可配置 | D9；`workspace-snapshots`「上限」「清理」 |
| 19 | 无快照的轮次不能撤回，按钮禁用并说明原因 | D11；`message-undo`「可撤回状态」 |
| 20 | 共用空间冲突三选一 | D12；`message-undo`「共用空间冲突」 |
| 21 | 不用 `adapters.threadList` | D1；ADR-0013 增补（任务 20.2） |
| 22 | 等待确认由 `chat_approvals.decision IS NULL` 推导 | D3；session-metadata「会话视图扩展键」 |

### Owner 补充决定落点（`.workplans/stage/owner-decisions-stage3.md`，2026-10-06，与 grill 同等效力）

| # | 决定 | 落点 |
|---|---|---|
| C-23 | 白名单命令回合（`/todo`、`/skill:…`）的用户消息本 change 不支持单独撤回：按钮置灰；撤回更早的普通消息会连带退掉它。原因是 RPC 模式下这类回合在 `get_branch_messages` 里没有条目。是否有可用的回退办法另开独立 issue 用真实 omp 调研（编排方开，不属本 change） | D11「可撤回状态」；message-undo「可撤回状态」（`command`）、「撤回 REST」前置校验第 4 步、「web 撤回」的 `命令消息无法撤回`；workspace-snapshots「受理时做快照」（`outcome='command'`）；任务 10.5、10.6、18.1 |
| C-24 | 分叉拷贝来的消息不能撤回；fork 不拷贝快照行。分叉之后新发的消息可以撤回 | D11「可撤回状态」；message-undo「可撤回状态」（`none`）；turn-control「从此处分叉 REST」（不拷贝 `chat_turn_snapshots`）；session-metadata「fork 继承会话元数据」；任务 10.6、18.1 |
| C-25 | 快照默认排除名单只排除依赖目录 `node_modules,.venv,__pycache__`；`.git` 进快照，撤回时连提交一起还原。名单管理员可配 | D9「上限与跳过」；workspace-snapshots「快照上限与配置」「还原」；message-undo「文件还原与结果」；http-service-skeleton「服务启动与装配」「Shared agent module assembly」的默认值；Risks 第 10 条；任务 7.2、8.2、9.1、12.1 |
| C-26 | 临时空间会话照常显示产物卡，在本 change 里做；`查看详情` 入口随 D 的侧边栏交付 | D17；turn-artifacts「文件变更卡」「产物卡」「产物面板」（MODIFIED）；chat-harness「UI 走查临时空间、撤回与归档」第 1 步；任务 17.5 |

开放项的去向：快照机制与默认值 → D9；推送通道形态 → D5；临时空间落盘与表示 → D6；挂载存储上的快照 → Not yet specified；
「只撤回对话」与「无快照不能撤回」不矛盾 → D12 末段。

## Goals / Non-Goals

**Goals**

- 会话列表在新组件层上重建，八个旧文件离开 legacy，`web/src/features/chat` 下不再有 `.css`。
- 列表状态由服务端推送保持新鲜，不依赖用户操作触发的重取。
- 未选工作空间的新会话有自己的临时空间，可转正，随最后一个使用它的会话删除。
- 用户消息可撤回，对话与工作空间文件一起回到那条消息发出之前。

**Non-Goals**

- 未读标记（owner 取消；计划留的开放项「未读存哪」一并取消）。
- 状态筛选与时间筛选（移除，不以别的形式保留）。
- 搜索消息正文或跨会话全文搜索；搜索不发请求。
- 服务端导出端点、导出为 Markdown 之外的格式、导出思考内容与工具原始输出。
- 消息编辑后重发、点赞 / 点踩、分支切换。
- 把已有的未绑定会话迁移进临时空间；给它们补做快照。
- 临时空间的独立管理界面（文件页不列出；清理只随会话删除）。
- 工作空间的删除、改名端点（转正时的改名除外）；文件与目录的删除 / 重命名 / 移动（change D）。
- 消息操作行的悬停显隐、用户消息的 `复制`（#908）；上游拒绝的错误呈现（#909）；等待与思考呈现（#910）；
  工具调用组与已结算记录（#911）；浏览器能力（#912）。
- 权限档位、上传、模型与推理强度（S1g）；文件页与会话页右侧的工作空间侧边栏（change D）。
- 重新生成时还原文件（现状不还原，不改）。
- 快照的保留期限上限与按预算淘汰（现设计保留到消息被删为止；是否按空间设预算见 Open Questions 1，不卡任何任务）。
- 挂载的远程存储（S1b）上的快照：本 change 只覆盖本地沙箱目录里的工作空间（见 Not yet specified）。
- 代码分割与包体上限（ADR-0013：S1f 全部 change 完成后再定）。
- 每账号独立 omp uid。

## Decisions

### D1 列表仍由应用渲染，不用 `adapters.threadList`

列表经外壳侧栏插槽（`web/src/lib/sidebar-slot.tsx`）渲染，数据与动作留在 `useChatSession`。
理由：assistant-ui 的 thread list 适配器假定「线程」只有标题与归档两个属性，没有分组、置顶、状态标记、临时空间与按用户的事件连接；
接入它要把这些全做成适配器外的旁路状态，得到两套列表状态。change B 已经在不用它的前提下交付。
放弃的方案：只用 `ThreadListPrimitive` 取样式——它的条目动作绑定运行时的线程切换，与应用自己的 `?session=` 选择冲突。
ADR-0013「接入方式」里的对应一行由任务 20.2 增补为本决定。

### D2 分组、折叠、搜索都是前端纯函数

- 服务端只给一张按 `updatedAt` 降序的全量列表（含归档的，`archivedAt` 非 null）。分组、过滤、归档与否都在前端算，不加查询参数。
  理由：单账号的会话数是百量级；一个端点一种形状，推送后的重取也只有一种。
- 分组键：置顶 > 工作空间。未置顶的会话按 `workspaceId` 分组：在已读取的工作空间列表里的归该空间的组（组序同 `GET /api/workspaces`）；
  `temporaryWorkspace` 为 true 或 `workspaceId` 为 null 的归 `临时空间` 组（owner 结论 13：老的未绑定会话与临时空间的会话同组）；
  其余（空间已不在列表里）归 `未知空间`。按时间分组时，未置顶的会话按 `updatedAt` 的本地日历日归 `今天` / `近 7 天` / `更早`。
- 本地记忆：`localStorage` 键 `workbuddy-session-grouping`（`workspace` | `time`，缺省或非法按 `workspace`）与 `workbuddy-session-collapsed`
  （JSON 字符串数组，元素是组键：`pinned`、`temporary`、`unknown`、`today`、`week`、`earlier` 或 32 位十六进制的工作空间 id；解析失败按空数组）。
  读写失败静默，沿用 `workbuddy-sidebar` 的先例。
- 搜索：对显示标题做去首尾空白、大小写不敏感的子串匹配；查询非空时忽略折叠状态（匹配项所在的组展开显示），空组不渲染。
- 被取代的方案：服务端分页 + 服务端搜索——在这个量级上只增加状态同步的面。

### D3 状态标记与无障碍文本

- 可见标记只有三种，优先级 等待确认 > 运行中 > 失败：`pendingApproval` 为 true → 提示点；否则 `status="running"` → 转动的指示；否则 `status="failed"` → 错误色标记。
- 每个条目仍保留一个 `role="status"` 元素，可访问名为 `<标题> <状态文案>`（`等待确认` / `运行中` / `失败` / `已完成` / `已停止` / `未开始`），
  其中后三种没有可见标记、只有视觉隐藏的文本。理由：owner 的结论限定的是**看得见的标记**；读屏用户与既有测试 / 走查按可访问名取状态
  （chat-harness「UI 走查对话步骤」里有 `<title> 已停止`、`<title> 已完成`、`<title> 未开始` 三处断言），去掉它们既损失信息又要改一条与本 change 无关的走查规格。
- `pendingApproval` 由服务端在读会话视图时用 `EXISTS(… chat_approvals a JOIN chat_messages m … WHERE m.session_id = s.id AND a.decision IS NULL)` 推导，不落列。
  终态结算、停止与启动对账都会把残留的待决行结算为 `deny`（chat-sessions「会话持久化与回合刷盘」），所以 NULL 等价于「此刻真的在等」。

### D4 归档

- 列 `chat_sessions.archived_at`（迁移 037），经既有 `PATCH /api/sessions/:id` 的新键 `archived:boolean` 读写；不新开端点。
- 归档条件：会话非 `running` 且未被控制占用持有，否则 409 `session_busy`。归档不停进程（闲置回收照常）。
- 只读由服务端保证：对已归档会话的 prompt、regenerate、fork、undo 一律 409 `session_archived`（新错误码）。web 侧在归档会话上不渲染输入框与
  重新生成 / 撤回 / 分叉，改显示一条带 `恢复` 按钮的说明。标题、置顶的 PATCH 不受限（界面不提供，服务端不为此多一条规则）。
- 归档不改 `updated_at`、不动工作空间与快照；删除照常可用。
- 放弃的方案：单独的 `archived` 状态值——会与 `status` 的终态语义缠在一起（恢复后要记得原状态）。

### D5 列表事件连接：只发通知，不带数据，不回放

- 端点 `GET /api/sessions/events`（静态路径，与 `/api/sessions/:id/events` 段数不同，不冲突），cookie 守卫，响应头与心跳沿用 `stream/sse.ts` 的约定
  （同一组 SSE 头、15 秒心跳注释、`preClose` 销毁）。没有事件环、没有 `id:` 行、不读 `Last-Event-ID`。
- 事件两种：`sessions.changed`（data `{}`）与 `session.rewound`（data `{"sessionId":"<id>"}`）。
- 页面的对齐规则只有一条：**连接每次打开（含重连）以及每收到一条 `sessions.changed`，重取一次列表**（单飞：重取在途时再来的通知只记一个「还要再取一次」）。
  `session.rewound` 让正选中该会话的页面重读它的消息快照（另一个标签页撤回之后）。
- 为什么不在事件里带会话视图：列表读取是整表替换，带数据的事件与在途的 `GET /api/sessions` 之间没有可比的先后（不是每种变化都动 `updatedAt`），
  要么引入版本号，要么接受旧响应盖掉新事件。只发通知时，最后一次重取一定开始于最后一条通知之后，天然收敛。代价是每次变化一次列表请求；
  变化是状态级的（回合开始 / 结束、审批出现 / 结算、元数据修改），不是增量级的。
- 服务端实现为一个进程内的按账号通知器 `notify(ownerId)` / `notifyRewound(ownerId, sessionId)`，由各写入点在事务提交之后调用（清单见 `session-list-push`）。
  对同一连接，已有一条 `sessions.changed` 尚未写出时不再排第二条（背压下自然合并）。
- 连接失败不影响列表可用：页面自己发起的动作仍在成功后本地更新或重取（现有路径保留）。
- 风险见 Risks 第 4 条（HTTP/1.1 下每源 6 条连接的上限）。

### D6 临时空间是带标记的 `workspaces` 行，目录是账号根下的同级目录

- 迁移 038：`workspaces.temporary INTEGER NOT NULL DEFAULT 0 CHECK (temporary IN (0,1))`。
- 行的取值：`id` 为随机 32 位十六进制；`dir = name = "tmp-" + id`（36 个字符，落在既有 `dir` 字符集与 64 上限内；`name` 取同值只为满足 NOT NULL 与唯一约束，界面不显示）。
  目录是 `<SANDBOX_ROOT>/<ownerId>/tmp-<id>`。
- 为什么必须是账号根下的同级目录：`computeSafeRoot` 与 `dir` 的 CHECK 只允许这一层；「原地转正、目录不移动」要求转正前后的根是同一个路径，
  而 omp 的 `--resume` 钉死 cwd，目录一旦移动，已有会话就续不上。隐藏子目录（如 `.tmp/<id>`）因此不可行。
- 创建时机：`POST /api/sessions` 不带 `workspaceId` 时，在创建会话的同一个 SQLite 事务里插入临时空间行、建目录（复用工作空间创建的目录与补偿逻辑）、
  插入绑定它的会话行。理由：会话只由欢迎态首次发送创建（change B），这就是「未选空间发送第一条消息时」；放在创建里比放在 prompt 受理里少一条
  「受理被补偿时把临时空间也撤掉」的路径，`workspace_id` 仍然只在创建时写入（「绑定不可改」不变）。
  放弃的方案：首个 prompt 受理时才建——要区分「新会话」与「从没发过消息的老会话」，并让 prompt 的补偿多一个文件系统步骤。
- 不写 `session.bind` 与 `workspace.create` 审计（不是用户选择或创建的空间）；转正与删除各写一条审计（D7、D8）。
- 可见性：工作空间 store 的 `list` 与 `GET /api/workspaces` 排除 `temporary = 1`；`rootOf` 不区分，所以会话 cwd、目录树、预览、新建目录端点对临时空间的 id 照常工作
  （S1g 的上传与 D 的侧边栏靠这一点）。创建会话时显式带一个临时空间的 `workspaceId` → 与不存在的 id 相同的 404（界面选不到它；不提供「新会话加入别的会话的临时空间」）。
- 老的未绑定会话：`workspace_id` 为 NULL 的行不变，cwd 仍是账号根，不建临时空间、不迁移。本 change 之后 API 不再能创建这样的会话，
  测试里需要它时直接写库构造。
- 会话视图的 `temporaryWorkspace`：`workspace_id` 非 NULL 且该空间行 `temporary = 1` 时为 true。web 不能靠工作空间列表判断（列表里没有临时空间）。

### D7 转正

- `POST /api/workspaces/:id/promote`，body 恰为 `{name:string}`；`name` 的校验与 `POST /api/workspaces` 相同。一条所有者作用域的
  `UPDATE workspaces SET name = ?, temporary = 0 WHERE id = ? AND owner_id = ? AND temporary = 1` 与一条 `workspace.promote` 审计同事务。
- 结果：200，五键工作空间对象（`dir` 仍是 `tmp-<id>`，`root` 不变）。同名 → 409 `conflict`；不存在或属他人 → 404；自己的非临时空间 → 400 `bad_request`。
- 目录不动、会话行不动：共用它的会话的 `workspace_id` 本来就指向这一行，转正后它们的 `temporaryWorkspace` 自然读作 false，
  文件页列出它，删除会话不再删它。会话运行中也可转正（不涉及任何进程）。
- 转正后逻辑路径显示为 `<account>/tmp-<id>`：目录名不好看是「不移动」的直接代价，已随 owner 结论 11 接受。

### D8 临时空间随最后一个会话删除

- 引用计数不落列：就是 `chat_sessions` 里 `workspace_id` 等于它的行数（含归档的会话）。
- 在会话删除的那个事务里：若被删会话的空间 `temporary = 1` 且删除后没有别的会话引用它，删除空间行并写一条 `workspace.delete` 审计
  （快照行随空间行的外键级联删除）。事务提交之后删除目录与它的快照目录。
- 目录删除沿用会话产物目录的做法（session-metadata「会话删除」第 5 步）：先校验它是账号根 realpath 之下的真实目录（`lstat`，不跟随符号链接），
  `rename` 进 app 私有的 `<OMP_STATE_DIR>/trash/<随机名>` 再递归删除——移进去之后 omp 用户不能再按路径替换其下的任何一级。
  `rename` 以 `EXDEV` 失败（沙箱根与状态目录不在同一文件系统）时退为原地递归删除：删除前同样做 `lstat` 校验。
  原地删除期间，另一个正在运行的 omp 进程理论上可以把子目录换成符号链接把删除引向别处（Node 的递归删除按路径逐项进行）；
  这与 ADR-0010 已登记的同类残余一致，随任务 20.3 登记。其它失败（含权限）只经服务错误通道报告，不改变 204。
- 首次验证（任务 5.4）：在真实的两文件系统布局上确认 `EXDEV` 分支；仓库默认布局（两者都在 `var/` 下）走 trash 分支。

### D9 快照：app 私有目录里的逐回合目录树，未变文件用硬链接去重

**位置**：`<OMP_STATE_DIR>/snapshots/<workspaceId>/<userMessageId>/`，`snapshots` 加进托管布局（`0700`，与 `trash` 同档，omp 用户进不去），
路径函数 `ompSnapshotsDir(stateDir)` 与其它布局路径同源。目录里是 `manifest.json` 与 `tree/`（工作空间内容的副本）。
放在工作空间之外是 owner 要求的前提（agent 不能改写快照）；放在沙箱根之下的任何位置都对 omp 用户可写。

**机制**：受理 prompt 后、派发前，遍历工作空间根（不跟随符号链接），对每个条目：
目录 → 记入清单并在 `tree/` 下建目录；普通文件 → 若上一份同空间的成功快照里同一相对路径的文件 `size`、`mtimeMs`、`ctimeMs` 都相同，
从那份快照硬链接过来，否则复制（`copyFile` 带 `COPYFILE_FICLONE`，同一文件系统且支持时是写时复制）；符号链接 → 只记目标字符串；其它类型（FIFO、socket、设备）→ 跳过并记入 `skipped`，`reason` 为 `special`。

**快照期间可能有写入者**：`beforeDispatch` 在等旧进程退出之前执行（见下「接入点」），同空间的另一个会话也可能正在运行（D12），所有账号又共用一个 omp 用户（ADR-0010）——遍历时不能假设工作空间静止。
所以普通文件不按路径复制：以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开，对句柄 `fstat`，确认是普通文件后清单的 `size` / `mtimeMs` / `ctimeMs` / `mode` 取自这次 `fstat`，内容从句柄读出；
打开后发现不是普通文件（分类之后被换成 FIFO、设备等）按 `special` 跳过，被换成符号链接时 `O_NOFOLLOW` 使打开失败（`ELOOP`），按「其它错误」整份快照 `failed`。`O_NONBLOCK` 使被换成 FIFO 的条目不会把打开挂住。
残余：路径的**中间分量**在列举之后被换成指向工作空间外的符号链接时，`lstat` 与打开都会穿过它（Node 没有 `openat`，任何按路径的复核都同样可被再次替换）——
与 D8、D10 同一类残余（需要另一个正在运行且被注入的 omp 进程），随任务 20.3 登记进 ADR-0010。
按句柄复制与上面写的 `copyFile(COPYFILE_FICLONE)`（只收路径）不能同时成立：任务 8.1 用句柄复制；写时复制是否还能保住由任务 8.3 定（保不住就放弃它，未变文件的硬链接去重不受影响）。

**接入点**：快照不是在路由里 `acceptPrompt` 与 `supervisor.prompt` 之间 await 的。现状这两步之间没有 await，`supervisor.prompt` 一进来就同步把回合标成「派发前」
（`TurnStops.open`），stop 只有在这个阶段才登记停止意图，否则直接丢弃（`server/src/sessions/turn-control.ts` 的 `#run`）。
在两步之间插一个 await 会开出一个 stop 被吞掉的窗口，窗口长度就是快照耗时。所以快照作为 `supervisor.prompt` 的第三个参数
`beforeDispatch` 传入，supervisor 在 `open` 之后、等旧进程退出 / 准入 / spawn 之前执行它：其间的 stop 走既有的停止意图路径，
DELETE 走既有的「先 stop 再等回合释放」。`supervisor.ts` 已到 800 行，这一处与撤回的接线（D11）都要先腾行：任务 10.3 是一条行为不变的独立重构，按「`beforeDispatch` 至多 10 行 + 撤回接线至多 12 行」定量，腾出不少于 30 行（挪走的段见 D15）。

**为什么是它**（宿主上已有的能力，零新依赖）：

| 方案 | 结论 |
|---|---|
| 每回合整树复制 | 每轮成本是整棵树的字节数；500 MiB 的空间聊 20 轮就是 10 GiB。否决 |
| 工作空间内硬链接（`cp -al` 式） | 硬链接共享 inode，agent 原地写文件会连快照一起改。否决 |
| git（独立 `GIT_DIR`） | 宿主要多一个二进制前提；工作空间内的 `.gitignore` 由 agent 控制，可以把文件藏出快照；嵌套仓库被当成 gitlink 不收内容；单文件上限要另写。否决 |
| 文件系统快照（btrfs / zfs / APFS） | 绑定宿主文件系统。否决 |
| 内容寻址的 blob 仓 | 去重更彻底，但清理要做标记—清扫；逐回合目录 + 硬链接用 `rm -r` 一个目录就能清，链接计数自己管共享。否决 |

硬链接只发生在 app 私有目录的两份快照之间，两端 omp 用户都碰不到，所以共享 inode 是安全的。`ctime` 不能被非 root 伪造，
所以「大小与两个时间都没变」可以当作内容没变（`mtime` 单独不行：`touch -d` 可以改回去）。

**每回合成本**：每个条目一次 `lstat`，每个未变文件一次 `link`，变过的文件一次复制。首个回合（或上一份快照不存在时）是整树复制，由总量上限封顶。
这段时间加在 prompt 的 202 之前（见 Risks 第 1 条）。

**上限与跳过**（默认值是设计定的，可配置）：

| 配置项 | 默认 | 含义 |
|---|---|---|
| `SNAPSHOT_MAX_FILE_BYTES` | `20971520`（20 MiB） | 更大的单个文件不进快照，记入 `skipped`（`too_large`） |
| `SNAPSHOT_MAX_TOTAL_BYTES` | `524288000`（500 MiB） | 进快照的文件大小之和超过它，这一轮不做快照 |
| `SNAPSHOT_MAX_ENTRIES` | `50000` | 进快照的条目数超过它，这一轮不做快照（封住遍历成本） |
| `SNAPSHOT_EXCLUDE_NAMES` | `node_modules,.venv,__pycache__` | 任何层级上叫这些名字的目录整棵不进快照，记入 `skipped`（`excluded`）。只排除依赖目录；`.git` 不在名单里（owner C-25） |

读不了的条目（omp 用户以 `0700` 之类权限建的）记入 `skipped`（`unreadable`）。`skipped` 里的路径在还原时不动并列给用户（owner 结论 18）。
排除目录名是本设计加的（#907 的开放项「被忽略文件的处理」），默认名单由 owner 定（C-25）：只排除依赖目录。不排除的话，带 `node_modules` 的代码空间每一轮都会撞总量或条目上限，撤回永远不可用；代价是撤回后这些依赖目录保持 agent 留下的样子（回合里装的包不会被卸掉）。
**`.git` 进快照**：版本库目录与普通目录同样遍历、同样受三个上限约束，撤回时连同回合里产生的提交、引用、暂存区一起还原——回合里做的 `git commit` 会被撤销，工作树与仓库状态一起回到那条消息发出之前。代价见 Risks 第 10 条（大仓库更容易触发上限；超过单文件上限的 pack 文件不进快照）。
三个数值上限（20 MiB / 500 MiB / 50000 条）与上限的维度是起草者定的（结论 18 授权设计定默认值），见 D16。

**登记**：迁移 039 的表 `chat_turn_snapshots(message_id PK → chat_messages ON DELETE CASCADE, workspace_id → workspaces ON DELETE CASCADE, outcome, skipped, todo, created_at)`，
每条被受理的用户消息一行（会话未绑定工作空间时不写行）。`outcome`：`ok` / `too_large`（总量或条目超限）/ `failed`（快照过程出错）/ `command`（白名单命令回合，不做快照）。
`todo` 存受理那一刻会话的任务清单原文，撤回时写回（比 fork 的「置 NULL」多保住一份状态，成本是一列）。这给 `chat_sessions.todo` 增加了一个读者（快照步骤，只读）与第二个写者（撤回事务），主规格 session-todo「任务清单持久化」的「只由这条路径写入」随之 MODIFIED；该条是否保留取决于任务 0.1 的 (c)（D11）。

**regenerate 不另做快照**：被重新生成的那一轮沿用它的用户消息原有的快照（那条消息发出之前的状态），撤回它正好还原到那里。

**清理**：消息行被删（会话删除、撤回、受理被补偿）→ 快照行级联删除 → 提交后删除对应的 `<userMessageId>` 目录；临时空间被删 → 删除整个 `<workspaceId>` 目录。
清理失败只经服务错误通道报告。

### D10 还原

- 先读清单并校验工作空间根是真实目录，任何一项不成立都在动任何文件之前失败。
- 然后：清单里没有、且不在任何 `skipped` 路径之下的现存条目 → 删除；清单里的目录 → 确保存在（新建的 `2770`）；清单里的符号链接 → 目标不同则重建。`skipped` 路径之下一概不碰。
- 清单里的文件分三步判定：大小与两个时间都与清单一致 → 不动（不读内容）；否则大小相同且内容与快照逐字节相同 → 不动；否则从快照写回（同目录临时文件 + `rename`，随后把 `mtime` 设回清单值）。`restored` 只计第三步的文件（与重建的符号链接）。
  为什么要有第二步：写回走 `rename` 与 `utimes`，文件的 `ctime` 必然变成当前时刻，非 root 设不回去，清单又不允许改；只凭三元组的话，被写回过一次的文件此后每次还原都会被再写一遍，`restored` 也不再反映「这次真的变了什么」。加一次内容比较后还原是真正幂等的（第二次 `restored=0`），失败重试与多轮连续撤回不重写没变的文件。成本是「时间变了而内容没变」的文件要读一遍，由总量上限封顶。
  连带后果：被写回过的文件 `ctime` 是新的，下一次 `take` 对它走复制而不是硬链接——多占一份空间，不影响正确性。
- **写回文件的权限位**：`(清单 mode & 0o777) | 0o660`，用显式 `chmod` 设，不靠 umask。写回的文件由 app 用户持有、靠父目录的 setgid 继承共享组；清单里是 `0644` / `0755` 的文件（解包、`cp -p`、git 检出产生的）如果原样还原，omp 用户（只在共享组里）就再也改不了它。所以属主与属组的读写位一律补上，其它用户位与执行位照清单，setuid / setgid / sticky 不带。两种「不动」的文件权限位不改。
- 每次写或删之前对该路径的各级父目录做 `lstat`：任何一级是符号链接就跳过该条目并记入 `failed`（不把还原引到工作空间之外）。
  单个条目因权限失败同样记入 `failed`、继续其余条目。失败后可以重来。
- 还原时本会话没有存活进程（D11 先退役）；同一空间的其它会话在运行时拒绝还原（D12）。别的空间的 omp 进程与本空间不相干，
  但所有账号共用一个 omp 用户，它们理论上能在检查与操作之间替换路径——与 D8 同一类残余，随任务 20.3 登记。

### D11 撤回 = fork 的进程策略 + 原地改写当前会话

`POST /api/sessions/:id/undo`，body 恰为 `{messageId:number, files:"restore"|"force"|"keep"}`。

**执行序**（持有该会话的控制占用，全程）：

1. 前置校验（不写任何行）：已归档 → 409 `session_archived`；`running` 或占用被持有 → 409 `session_busy`；`messageId` 不是该会话的用户消息 → 400；
   该消息的可撤回状态不是 `available` → 400；`omp_session_file` 为 NULL → 502；`files` 不是 `keep` 而同一空间有别的会话在运行 → 409 `session_busy`；
   `files` 为 `restore` 而存在冲突（D12）→ 409 `undo_conflict`。
2. 退役本会话的存活进程（既有有界 retire）→ 准入一个临时进程（`--resume <omp_session_file>`，不是 generation、不动 `stream_epoch`）→
   `get_branch_messages` → 按既有的首次匹配对位取该消息的条目 → `branch` → `get_state` 取新文件 → 关停临时进程。任何失败 → 502，什么都没改。
3. `files` 不是 `keep`：按该消息的快照还原工作空间（D10）。结构性失败 → 通用 5xx，对话未动，可重试。
4. 一个 SQLite 事务：CAS 复核（非 `running`、末条助手 id 未变、该消息仍在）→ 删除该消息及其后的全部消息行（步骤、审批、快照行级联；
   文件变更卡与产物卡都从步骤行派生，随之消失）→ `omp_session_file` 指向新文件、`status` 取剩余历史里末条助手消息的状态（没有则 `idle`）、
   `updated_at = now`、`todo` 取该消息快照行里存的值 → 写一条 `session.undo` 审计。标题不动（起草者定，D16）。
5. 提交后：删除被移除消息的快照目录；发 `sessions.changed` 与 `session.rewound`；返回 200 `{session, draft, files}`，`draft` 是那条消息存的原文。

**为什么用 fork 的进程策略而不是 regenerate 的**：fork 的「先退役、临时进程上对任意条目 `branch`、关停后再提交」是已经在真实 omp 上跑通的组合；
regenerate 在存活进程上只对最后一个条目 `branch` 且马上派发。在存活进程上对非末条目 `branch` 之后不派发、进程继续留着等下一条 prompt，是没验证过的状态。
先退役还顺带保证了还原文件时本会话没有进程在写。代价是下一条 prompt 要重新 spawn 一次。旧的会话文件留在磁盘上，与 regenerate 的做法相同。

**前置核对（任务组 0，排在快照与撤回各组之前）**：上面这条路径有三点在真实 omp（v18.0.10）上没有被 fork 的既有用法覆盖，任务 0.1 用脚本在真实二进制与受控上游上核对，结论决定规格是否要先修订再开工：

| 核对点 | 判定规则 | 成立 | 不成立时的处置（任务 0.2 以一个只改本 change 规格的 PR 落定，其后各组才开工） |
|---|---|---|---|
| (a) 对**中间**的用户条目 `branch` 后，`get_state` 给出的新文件可被下一次 `--resume` 使用，且新进程的 `get_branch_messages` 恰为该条目之前的条目 | 两轮会话，临时进程 `--resume` 后对第二条用户条目 `branch`；新进程 `--resume <新文件>` 握手成功、列表恰含第一条用户条目、再发一条 prompt 能完成 | 规格不变 | 撤回的整条路径不成立：组 7–12、13.1 的 `undoMessage`、组 18 与 19.2 的撤回步骤**不开工**，change 停在组 6 之后并回到设计阶段（退回 owner；「不还原文件就不上线」的口径下不存在只做对话回退的退路） |
| (b) 对**第一个**用户条目 `branch` 得到的文件存在并可 `--resume`，新进程的 `get_branch_messages` 为空，随后的 prompt 能完成 | 同一脚本对第一条用户条目 `branch` | 规格不变（「撤回第一条」：其后的进程以 `--resume <新文件>` 启动） | 撤回到首条用户消息时不带文件冷启动：message-undo「对话原地回退」第 3 步增加「被撤回的是该会话的首条用户消息时不发 `branch`」、第 5 步改为「此时 `omp_session_file` 置 NULL」；场景「撤回第一条」的 THEN 改为「其后的 prompt 不带 `--resume` 启动（cwd 仍由绑定决定）并 202」；chat-harness 走查第 4 步不变（新文件里同样只有一条用户条目）；任务 11.5 与其变异证据「不改 `omp_session_file`」同步 |
| (c) `branch` 之后 omp 自己的任务清单回到被分支条目当时的状态 | 第一轮不建清单、第二轮用 `WORKBUDDY_TODO` 建清单；对第二条用户条目 `branch` 后 `--resume <新文件>`，发 `/todo`：输出为 `No todos. Use /todo append <task> to start one.` 即成立，仍列出第二轮的任务即不成立 | 规格不变（撤回事务把 `chat_sessions.todo` 写回快照行里存的值，与 omp 一致） | 宿主清单是 omp 清单的镜像，omp 不回退则宿主也不回退：`chat_turn_snapshots` 不建 `todo` 列（workspace-snapshots「迁移 039 回合快照登记表」与「受理时做快照」删去 `todo`，删场景「记录当时的任务清单」）；message-undo「对话原地回退」第 5 步删去 `todo` 的写回，场景「任务清单回到当时」改为「撤回后 `todo` 与撤回前相同」；本 change 的 session-todo delta 撤掉「任务清单持久化」的 MODIFIED（主规格原文继续成立），只留「任务清单快照」；D9、D11 的对应句与任务 10.1、10.2、10.5、11.2 里的 `todo` 一并删去 |

三行互相独立，各按自己的结论处置；任务 0.2 把结论（命令与输出，不含主机信息）记在本节末尾的「核对结论」一段并抄进 Epic——三行都成立时这个 PR 只加这一段，否则同时带上表里对应的规格修订。

**核对结论**（#918，任务 0.1 / 0.2；官方 release v18.0.10 的 `var/omp/omp`，`omp --version` 输出 `omp/18.0.10`；模型端点是仓库的受控上游 `server/test/support/fake-upstream.mjs`；一次性脚本不入库，连跑三遍逐条结果相同）：**三点都成立，规格与任务不改。**

每个进程的启动参数相同，只差末尾的 `--resume`（`<tmp>` 是脚本的临时目录，`<repo>` 是仓库根）：

```
<repo>/var/omp/omp --mode rpc --cwd <tmp>/sandbox/u1/proj --session-dir <tmp>/state/sessions/u1
  --model workbuddy/deepseek-v4.1-flash --approval-mode write --no-extensions --no-lsp --no-pty --no-title
  --config <tmp>/state/home/.omp/agent/host-overlay.yml [--resume <会话文件>]
```

握手：`ready` → `negotiate_protocol(protocolVersion:2)` 成功 → `get_state` 成功并给出 `sessionFile`。受控上游每轮先发一个 bash 工具调用，审批一律 Deny，回合以 `agent_end` 结束。

- **(a) 成立**（7 条子断言全过）。两轮 `第一轮：普通问题`、`第二轮：普通问题` 都完成后关停。临时进程 `--resume <原文件>`：
  ```
  >> {"type":"get_branch_messages"}
  << {"success":true,"data":{"messages":[{"entryId":"688b88a8","text":"第一轮：普通问题"},{"entryId":"db528dae","text":"第二轮：普通问题"}]}}
  >> {"type":"branch","entryId":"db528dae"}
  << {"success":true,"data":{"text":"第二轮：普通问题","cancelled":false}}
  >> {"type":"get_state"}
  << sessionFile = <tmp>/state/sessions/u1/<新文件>.jsonl（不同于原文件；进程以退出码 0 关停后文件在磁盘上）
  ```
  新进程 `--resume <新文件>`：握手成功，`get_state.sessionFile` 就是该新文件；
  ```
  >> {"type":"get_branch_messages"}
  << {"success":true,"data":{"messages":[{"entryId":"688b88a8","text":"第一轮：普通问题"}]}}
  >> {"type":"prompt","message":"分支之后的新问题"}
  << {"command":"prompt","success":true} … agent_end（带最终回复）
  ```
  `get_branch_messages` 只列用户条目（`{entryId,text}`）；新文件里是第一轮的整条链，条目 id 与原文件相同。
- **(b) 成立**（7 条子断言全过）。同样的两轮会话，临时进程上对第一条用户条目 `branch`：
  ```
  >> {"type":"branch","entryId":"56137738"}
  << {"success":true,"data":{"text":"第一轮：普通问题","cancelled":false}}
  >> {"type":"get_state"}
  << sessionFile = <tmp>/state/sessions/u1/<新文件>.jsonl（关停后文件在磁盘上，只有会话头的元数据行，没有消息条目）
  ```
  新进程 `--resume <新文件>`：握手成功；
  ```
  >> {"type":"get_branch_messages"}
  << {"success":true,"data":{"messages":[]}}
  >> {"type":"prompt","message":"分支之后的新问题"}
  << {"command":"prompt","success":true} … agent_end（带最终回复）
  ```
- **(c) 成立**（6 条子断言全过，含一条对照）。第一轮普通 prompt，`/todo` 输出 `No todos. Use /todo append <task> to start one.`；第二轮 `WORKBUDDY_TODO 第二轮：建任务清单` 执行了 `todo` 工具，分支之前：
  ```
  >> {"type":"prompt","message":"/todo"}
  << {"type":"command_output","text":"# 走查\n- [/] 整理需求\n- [ ] 输出结论"}
  ```
  对照（不分支，只 `--resume <原文件>` 后发 `/todo`）：输出仍是上面这份清单——清单能跨进程重启存活，所以下面的空清单是 `branch` 造成的。临时进程上对第二条用户条目 `branch`（`success:true`，`cancelled:false`）取得新文件，新进程 `--resume <新文件>`：
  ```
  >> {"type":"prompt","message":"/todo"}
  << {"type":"command_output","text":"No todos. Use /todo append <task> to start one."}
  << {"command":"prompt","success":true,"data":{"agentInvoked":false}}
  ```
  夹具说明：受控上游只在请求里完全没有 `tool` 消息时才发工具调用，同一会话第二轮起的 `WORKBUDDY_TODO` 直连时不会建清单（直连跑出来分支前 `/todo` 就是 `No todos. …`，无法判定）。所以这一点的脚本在 omp 与受控上游之间加了一层本地转发，只把请求的 `messages` 裁成「从最后一条 user 消息起」再原样交给受控上游；omp 一侧（二进制、参数、会话文件、RPC 帧）没有任何改动。给撤回后任务清单回退写自动化测试的任务（10.5、11.2、11.7）会遇到同一个夹具限制。

核对中顺带确认的两点，与本 change 既有的前提一致、不引起修订：`/todo` 这类命令回合在会话文件与 `get_branch_messages` 里都不留条目（C-23 的前提）；`branch` 之后 `get_state.sessionFile` 立即换成新文件，其后在新文件上继续发 prompt 路径不再变。

**与事件流的关系**：退役会丢弃该会话的 slot 与事件环并结束已连接的订阅；它们重连后拿到的是既有的 gap → 重读快照。为避免「重连发生在事务提交之前、读到旧历史」，
提交后的 `session.rewound` 让选中该会话的页面再读一次。发起撤回的标签页直接用 200 之后的重读结果。

**可撤回状态**（消息视图的新键 `undo`，助手消息恒为 null）：有快照行 → `ok` 读作 `available`，其余 `outcome` 原样；没有快照行 → 会话未绑定工作空间读作 `unbound`，否则 `none`
（本 change 之前的消息、分叉拷贝来的消息）。prompt 的 202 同样带这个值，页面本地加进视图的新用户消息才有正确的按钮状态。
两条对结论 16「任意一条用户消息」的收窄已由 owner 拍板，不是待定项：
- **白名单命令回合不能单独撤回**（C-23）：`/todo`、`/skill:…` 这类回合在 omp 的分支列表里没有条目，fork 与 regenerate 已经拒绝它们；`outcome = command`，按钮置灰（`命令消息无法撤回`）。撤回它之前的一条普通消息仍会把它一并移除。是否有可用的回退办法由编排方另开 issue 调研，不属本 change。
- **分叉拷贝来的消息不能撤回，分叉不拷贝快照行**（C-24）：拷贝后的消息在新会话里读作 `none`；分叉之后在新会话里新发的消息有自己的快照行，可以撤回。让分叉会话能把共用空间退回到源会话更早的状态，是比「撤回当前会话」大得多的能力，不属于本 change。
本 change 之前就存在的消息同样没有快照行、读作 `none`，这是结论 19「无快照的轮次不能撤回」的直接推论。

**web**：`撤回` 在用户消息操作行里位于 `从此处分叉` 之前（`复制` 由 #908 加在它之前）；输入框锁定期间禁用；状态不是 `available` 时禁用并以可访问描述给出原因；
点击不确认，成功后重读历史、草稿设为返回的 `draft`（覆盖已有草稿）、焦点到输入框；`files.skipped` / `files.failed` 非空时在输入框上方就地列出未还原的路径。

### D12 共用空间的冲突判定

记被撤回的消息为 M、`T = M.created_at`。冲突 = 存在另一个会话 B（同一所有者、同一 `workspace_id`、不是本会话），它**自己活动过**（有自己的快照登记行，或 `B.updated_at > B.created_at`），且下面任一条成立：

| 条件 | 含义 | 为什么需要 |
|---|---|---|
| (a) B 有一行登记 `created_at >= T` | B 在 M 之后受理过回合 | 最直接的一种 |
| (b) `B.updated_at >= T` | B 有回合在 M 之后才结算，或 B 在 M 之后重新生成 / 撤回过 | **重叠回合**：B 在 M 之前受理、M 之后才写文件并结束。B 的消息行时间戳全是受理时刻（`acceptPrompt` 用同一个 `now` 写用户行、助手行与 `updated_at`），只看消息时间会漏掉它；终态结算把 `updated_at` 写成结算时刻（`finishTurn`），这是库里唯一的「回合结束时刻」 |
| (c) `B.status = 'failed'` 且 `B.updated_at` 等于 B 末条助手消息的 `created_at` | 该回合是被启动对账置为 `failed` 的，没有结束时刻 | 启动对账只翻状态、不写 `updated_at`（`reconcileStatuses`）。回合在 M 之前受理、M 之后还在写文件时进程崩了，重启后 `updated_at` 仍是受理时刻，(b) 抓不到；这种行的特征是「`failed` 且 `updated_at` 还等于受理时写下的那个时刻」，按「可能在 M 之后」处理 |

只查库（`chat_sessions`、`chat_messages`、`chat_turn_snapshots` 的列），不比文件；`chat_steps.changes` 不能用（只有计数、不记 bash 的改动）。库里没有逐回合的结束时刻列，也不为此加列。

**「自己活动过」为什么是两支**。只看登记行会漏掉不写登记行的回合：regenerate 不做快照、不写行（workspace-snapshots「受理时做快照」），其预检只要求末两条是 user + assistant、非命令、会话为终态（`server/src/sessions/branching.ts`），而 fork 拷贝到分叉点之前、末条正是助手消息——所以一个只有拷贝历史的分叉会话可以直接重新生成拷贝来的末轮并写文件，迁移 039 之前就存在的绑定会话升级后重新生成末轮同理。`B.updated_at > B.created_at` 补上这一支，依据是代码事实：`createSession` 与 fork（`FORK_SESSION`、`FORK_STATUS`，`store-branch.ts`）把 `created_at` 与 `updated_at` 写成同一个 `now`；`acceptPrompt`（`store.ts`）、终态结算（`store-approvals.ts`）、regenerate 提交（`CAS_MOVE`，`store-branch.ts`）与本 change 的撤回事务都把 `updated_at` 写成当时的时刻；PATCH（`store-metadata.ts`）、任务清单写入（`store-todo.ts`）与启动对账不动它；`rollbackPrompt` 把它还原成受理前的值。于是从未活动过的分叉会话两列相等、不误报，任何派发过的回合都使后者更大。登记行一支保留，它在两列落在同一毫秒时仍然成立。

**不漏报的论证**。设 B 的某个回合 R 在 T 之后改过文件，且 B 的会话行还在。R 的受理（普通 prompt、命令或 regenerate）把 `B.updated_at` 写成受理时刻，晚于 `B.created_at`，第 2 条成立——不依赖 R 有没有登记行。R 的去向只有四种：仍在运行 → 前置校验第 6 步已经以 `session_busy` 拒绝 `restore` / `force`，到不了冲突判定；正常结算 → 结算时刻不早于它最后一次写文件，`updated_at >= T`，且此后只会被写得更大（受理、结算、regenerate 提交、撤回提交都写当前时刻），(b) 成立；被启动对账置为 `failed` → 之后没有别的写入则 (c) 成立（regenerate 以同一个 `now` 插入新助手行并写 `updated_at`，所以崩溃的 regenerate 同样满足 (c)），之后有过别的写入则那次写入发生在重启之后、晚于 T，(b) 成立；受理被补偿（`rollbackPrompt` 把 `updated_at` 还原）→ 该回合从未派发，没有改过文件，与前提矛盾。B 在 T 之后跑过回合又自己撤回掉的，撤回提交把 `updated_at` 写成当时的时刻，(b) 成立，同样报冲突（比上一版判据更保守：B 选「只撤回对话」留下的文件不会被 S 的还原静默冲掉）。前提有两条：宿主时钟不回拨；fork 与其后的第一次 regenerate 受理不落在同一毫秒（regenerate 受理前要先完成一次 omp 往返，实际不会发生）。

**多报**：B 那段时间可能没动文件；一个在 M 之后只发过 `/todo` 的会话也算。代价是多弹一次对话框。本 change 之前就存在、之后没再活动的老会话若当年是被启动对账置为 `failed` 的，也会因 (c) 被算入（它没有结束时刻可查）。原先的判据（B 有一条 `created_at >= T` 的消息）被换掉，因为它既漏报重叠回合，又把 fork 拷贝来的消息（`created_at` 原值保留，与源消息相等）当成 B 的活动而误报。

**判据之外、不算冲突的情形**（都写进 message-undo「共用空间冲突」）：用户自己在文件页做的改动（起草者定，D16）；B 在 T 之后跑过回合、随后被整个删除（会话行、消息行、登记行都已不在，库里没有可供判定的记录；不为此保留已删会话的墓碑行，它留下的文件与手工改动同类——起草者定，D16）。判据依赖宿主时钟不回拨；回拨时可能少报，与其它按 `updated_at` 排序的行为同一前提。

- 协议：`files:"restore"` 遇冲突 → 409 `undo_conflict`，什么都不改；页面弹三选一，`只撤回对话` 重发 `files:"keep"`，`连文件一起还原` 重发 `files:"force"`，`取消` 不发请求。无冲突不弹。
- 别的会话此刻正在同一空间里运行时，`restore` 与 `force` 都拒绝（409 `session_busy`）：不在一个 agent 正在写的目录上做还原。`keep` 不受限。`force` 也被拒是起草者定的（D16）。
- 「只撤回对话」与「无快照不能撤回」不矛盾：前者是有快照而用户放弃还原；没有快照的消息无论 `files` 取什么都是 400。

### D13 列表动作的反馈：不弹提示

成功不提示（条目自身的移动 / 改名 / 消失就是反馈）；对话框内的失败在对话框里以 `role="alert"` 显示；没有对话框的动作（置顶、归档、恢复、导出）失败时，
在列表区顶部以一条可关闭的 `role="alert"` 显示信封文案，下一次列表动作发起时清除。理由：已迁移文件的导入白名单不含 `useToast`（守卫机械保证），
与 change B「失败就地显示」一致。ADR-0013 把这项留给了本 change。

### D14 导出记录在前端生成

用 `GET /api/sessions/:id/messages` 的快照（已选会话用页面持有的视图，其它会话现读一次）拼 Markdown：一级标题为会话标题；每条消息一个二级标题 `用户` / `助手` 加正文；
助手消息有步骤时在正文后列 `- <步骤名>（<状态文案>）`。不含思考、步骤的 detail 与 output、审批、文件变更。以 `Blob` + 临时链接下载，文件名为标题去掉路径分隔与控制字符后加 `.md`。
导出纯函数放 `web/src/features/chat/` 的独立模块，便于单测逐字节断言。

### D15 契约的落刀次序、模块落点与跨 change 约定

- 会话 DTO 是严格键集：服务端加三键与 web 解析必须在同一个 PR 合入（组 1），其后的组才各自用这些键。消息 `undo` 键与 prompt 202 的 `undo` 同理（组 10）。
- 新服务端模块（`store.ts` 不再加行）：`sessions/list-events.ts`（通知器与 SSE 路由）、`sessions/turn-snapshot.ts`（受理后的快照步骤：判定命令回合、调用 `take`、写登记行、补偿后清目录）、`sessions/undo.ts`（撤回编排，只供 `sessions/` 内使用）、
  `sessions/store-undo.ts`（快照登记行读写、冲突判定查询、撤回事务）、`workspaces/snapshots.ts`（落盘、还原、删除；根目录由 `createApp` 注入，不反向导入 `sessions/`）、`workspaces/temp-dir-remove.ts`（临时空间目录经 trash 删除）。
- **`supervisor.ts`（800 行）的改动面**，全部列在这里，别处不再碰它：
  1. 任务 10.3（先做，行为不变）：把 `#pushNow` 里调用 `onEvent` 观察口并检查同步返回值的那一段挪进 `supervisor-faults.ts`（一个返回「违规错误或 undefined」的函数），把 `#readReplay` 挪进 `supervisor-subscribers.ts`（入参为 generation 与「回合是否在跑」）；仍不足 30 行时依次再挪 `streamCursor` 的取值（进后者）与 `#retain`（只依赖故障列表与 `onError` 的纯辅助，进 `supervisor-faults.ts`），够 30 行即止。合入后 `supervisor.ts` 不超过 770 行。
  2. 任务 10.4：`prompt` / `#prompt` 增加可选的 `beforeDispatch`（`#stops.open` 之后 await，其后沿用既有的 closed / claim 复核与失败路径），至多 10 行。
  3. 任务 11.5：撤回的临时进程要计入上限、持有控制占用、关停时被收掉，这些依赖（`#pool`、`#tokens`、`#spawn`、`#controls`、`retireSource`）是 supervisor 的私有字段，与 `Forks` 的接入方式相同——把传给 `new Forks(…)` 的那组端口提成一个局部常量同时传给 `new Undos(…)`，加一个公开方法 `undo(…)`（经既有的 `#control` 包装）与 `shutdown()` 里的一处 `close()`，至多 12 行。
  列表事件的通知不改 `supervisor.ts`：回合终态与审批的出现 / 结算经 supervisor 既有的同步观察口 `onEvent`（`SessionSupervisorOptions.onEvent`，在 `sessions/index.ts` 里与装配传入的观察者串接）得到：串接函数先调通知器的观察函数（包在 try/catch 里、丢弃其结果，它自己不抛、不返回 thenable），再调装配传入的 `onEvent` 并把它的返回值**原样返回**——该观察口对返回 thenable 与抛错有既有的故障语义（http-service-skeleton「Shared agent module assembly」：return-value ownership 不变），通知器既不得触发它，也不得把装配方观察者的违规吞掉。
  S1g 也要改这个文件（按会话档位重启进程），它在 C 之后合入，用的是 C 结束时剩下的余量加它自己的腾行；C 结束时 `supervisor.ts` 不超过 792 行。
- 键集、错误码数、归属路由数与配置项数在本 change 的规格里写的是「主规格现值加本 change 的增量」。本 change 的增量恰为：会话视图 `archivedAt`、`pendingApproval`、`temporaryWorkspace`（8 → 11 键）；消息视图 `undo`；prompt 202 的 `undo`；错误码 `session_archived`、`undo_conflict`（13 → 15 码）；
  归属路由 `POST /api/sessions/:id/undo`、`POST /api/workspaces/:id/promote`（12 → 14 条）；会话路由 `POST /api/sessions/:id/undo`（10 → 11 条）；配置项四个 `SNAPSHOT_*`（15 → 19 项）；迁移 037–039（回执第 11–13 个）。

**与其它 change 重叠的 MODIFIED**。归档顺序固定为 C → S1g（`s1g-composer-capabilities`）→ D（`s1f-files-page`）。OpenSpec 的 MODIFIED 是整条替换，所以本 change 每条 MODIFIED 的底本是 `openspec/specs/**` 的现文本；S1g 与 D 的同名 MODIFIED 必须以本 change 的 delta 文本为底再加自己的增量。下表列出 S1g / D 也整条替换的条文，以及归档 C 之后必须在后续 change 的文本里**原样存活**的 C 增量（新增句、新增 / 改写的场景、计数）。后两个 change 对底时逐行核对；任务 20.7 在本 change 归档前用当时的主规格重新 diff 一遍。

| 条文（capability / Requirement） | 也被谁 MODIFIED | 底本 | C 的增量（必须存活） |
|---|---|---|---|
| chat-sessions / 会话 REST | S1g | 主规格 | 路由数 ten → eleven（增 `POST /api/sessions/:id/undo`；`GET /api/sessions/events` 另注册、不计入）；创建响应与会话视图为十一键（含三键的取值句、「bodyless 得到 null `scene` 与非 null `workspaceId`」）；`GET /api/sessions` 含已归档会话；消息对象增 `undo`（取值句）；新增场景「Session views carry the three extension keys」「User messages carry an undo state」；改写场景「Create list and empty history」「Owner and authentication isolation」（eleven routes、undo）「Stable public history and recent order」「Fork copies history before the chosen user message」「Snapshot carries the stored task list」（eleven keys） |
| chat-sessions / REST prompt 受理与补偿 | S1g | 主规格 | `supervisor.prompt(sessionId, wireText, snapshotStep)` 与「受理与该调用之间无 await」；端口签名的第三个参数 `beforeDispatch`；202 为三键 `{userMessageId,assistantMessageId,undo}`；归档会话 409 `session_archived`；补偿后删快照目录；新增场景「Archived session refuses prompts」「Snapshot precedes dispatch and never blocks it」；改写场景「Accepted prompt and concurrent busy」（`undo` 值） |
| chat-web / API 客户端扩展 | S1g | 主规格 | 会话 DTO 十一键及三键的逐键规则；消息 DTO 增 `undo`；`patchSession` 接受 `archived`；prompt 202 三键；`undoMessage`、`promoteWorkspace` 两个方法；新增场景「撤回与转正方法」「prompt 的 202 带 undo」「消息 undo 键严格解析」；改写场景「八键会话与思考、变更字段严格解析」（标题沿用主规格原名，正文为十一键）「会话元数据方法请求与响应」 |
| chat-web / 消息线程 | S1g | 主规格 | 用户消息操作行为 `撤回`、`从此处分叉`（依此次序）；锁定期间禁用；已归档会话不渲染这两个按钮与 `重新生成`；新增场景「用户消息操作行的按钮与次序」 |
| chat-web / 输入框与能力栏 | S1g | 主规格 | 只读标签的四种取值（`任务启动于 临时空间` 在最前判定）；临时空间会话以其 `workspaceId` 取命令目录与项目配置；草稿可被 `撤回` 覆盖；改写场景「已选会话工作空间只读」 |
| chat-web / 会话页 | D | 主规格 | 列表呈现改引 session-sidebar 的搜索 / 置顶 / 可折叠分组 / 归档视图；状态元素六种文案三种可见标记；列表事件连接；不用 thread-list adapter；列表动作无提示；**Archived session** 一段；新增场景「归档会话只读呈现与恢复」「列表条目的状态元素」 |
| http-service-skeleton / 统一错误信封 | S1g、D | 主规格 | 十三码 → 十五码（`session_archived`、`undo_conflict` 及其 message）；共享 409 的码增这两个；归属身份十二 → 十四（`POST /api/sessions/:id/undo`、`POST /api/workspaces/:id/promote`；「其余十三条以 POST 归属」）；新增场景「归档与撤回冲突的错误码」「撤回与转正路由属于归属集」；改写场景六个：「auth POST 请求 parse/validation 错误稳定映射」（十四条归属身份）、「意外错误不伪装」（十五个 typed code）、「产品路由身份在共享映射器中的归属」（WHEN 的路由清单增 undo 与 promote；fourteen-identity）、「Cache policy remains route-owned」（fifteen typed errors）、「工作空间 parser owner 的真实 HTTP 边界」（fourteen-owner、「twelve other owners」）、「会话元数据 parser owner 的真实 HTTP 边界」（无 body 创建得到临时空间的 THEN） |
| http-service-skeleton / 服务启动与装配 | S1g、D | 主规格 | 配置项十五 → 十九（四个 `SNAPSHOT_*` 的键名、默认值 `20971520`、`524288000`、`50000`、`node_modules,.venv,__pycache__`、解析规则）；改写场景「干净启动与一致命令面」（十九项）「override、非法配置与部分启动失败」（四键的非法值） |
| session-metadata / 会话创建与空间绑定 | S1g | 主规格 | 未给 `workspaceId` 时同事务创建临时空间；临时空间 id 显式绑定 → 404；201 为十一键视图；「REST 不再能创建 `workspace_id` 为 NULL 的会话」；新增场景「只选场景不选空间」「临时空间创建失败不留会话」；改写场景「无 body 与空对象按默认创建」（默认即创建临时空间会话）「他人与不存在的空间一致 404」（增临时空间 id 一支，四次均 404）「绑定自有工作空间并选择场景」「非法 body 形状」（四个标题都沿用主规格原名） |
| session-metadata / 会话元数据修改 | S1g | 主规格 | body 键集增 `archived`；`archived` 的字段规则与 409 `session_busy`；「`archived:true` 除外」；返回十一键视图；新增场景「归档键与其它键一起修改」；改写场景「重命名、改场景与置顶」「非法 body 与鉴权」 |
| session-metadata / fork 继承会话元数据 | S1g | 主规格 | `archived_at` 为 NULL；共用临时空间、不复制目录、不新建空间行；不拷贝 `chat_turn_snapshots`；新增场景「继承临时空间」；改写场景「继承空间与场景、不继承置顶」「fork 响应的会话视图与列表一致」（十一键） |
| chat-harness / UI 走查会话元数据 | D | 主规格 | 第 6 步（分组、折叠、搜索、`分组方式`、无 `筛选任务`）；第 7 步（从 `ui-walk-sessions` 分组移到 `置顶任务`）；第 11 步（删除无提示）；改写场景「会话元数据走查」「假进度不能满足走查」 |
| session-sidebar / 会话条目菜单与重命名 | D | 主规格 | 菜单六项与次序、`归档` 在运行中禁用、`另存为工作空间` 只在临时空间会话上；列表动作无提示与失败的两处呈现；删除确认的三种文案；新增场景「菜单项」「归档当前会话」「删除确认文案」；改写场景八个：「从条目菜单重命名」「重命名失败保留对话框」「重命名请求中」「顶栏重命名入口」「置顶菜单文案与提示」「迟到的元数据响应」「删除当前会话」「删除请求中」（标题都沿用主规格原名；都去掉了轻提示断言，失败改为就地显示） |
| spa-shell / 路由 IA 与侧栏 | D | 主规格 | 列表区内容改为搜索框、置顶区、可折叠分组与 `已归档` 入口的一句；新增场景「列表区承载重建后的会话列表」 |
| ui-foundation / 组件分层 | D | 主规格 | 会话列表文件不再豁免、逐个登记；终态一段（`web/src/features/chat` 下无 `.css`、`session-filter.tsx` 不存在、只用已拷入的七个组件）；改写场景「会话页迁移终态」 |
| turn-artifacts / 文件变更卡 | D | 主规格 | 「空间可解析」的定义（含 `temporaryWorkspace` 为 true）；临时空间会话的行只显示相对路径、不渲染 `查看详情`；改写场景「空间不可解析」；新增场景「临时空间会话的文件变更卡」。D 给临时空间加 `查看详情`（侧边栏入口）时在此基础上改（owner D-22） |
| turn-artifacts / 产物卡 | D | 主规格 | 临时空间会话照常渲染产物卡、以其 `workspaceId` 调预览 API 的一句；新增场景「临时空间会话照常渲染产物卡」 |
| turn-artifacts / 产物面板 | D（REMOVED） | 主规格 | 临时空间会话的面板行（相对路径、无 `查看详情`、有操作按钮）；新增场景「临时空间会话的面板行」。D 移除该条时，其替代物（工作空间侧边栏）要接住「临时空间会话的产物可预览」这一行为 |

只被本 change 修改、S1g 与 D 都不碰的 MODIFIED（chat-sessions「会话数据 schema」「Supervisor dispatch and generation binding」、chat-harness「会话元数据 HTTP 冒烟」、http-service-skeleton「Shared agent module assembly」、session-metadata「绑定不可改与工作目录」「会话删除」、session-sidebar 其余条文、turn-control 四条、omp-pool 两条、omp-runtime、workspaces 两条、session-todo 两条）不在表里；后两个 change 若在修订中新增了对它们的 MODIFIED，同样以本 change 的文本为底。本 change 新增的能力（message-undo 等）被 S1g 以 MODIFIED 修改时（owner S-24：撤回响应加 `attachments`），底本是本 change 的 ADDED 文本。

### D16 起草者自定的呈现细节（Epic 中列给 owner 知悉，不卡任何任务）

下列各项 owner 没有逐条确认，按 `.workplans/stage/owner-decisions-stage3.md` 末节的口径由起草者定、已写进规格并有任务实现；Epic 描述里原样列出，owner 有异议时按普通变更处理：

1. `临时空间` 这个组名同时装老的未绑定会话（`workspaceId` 为 null）与用临时空间的会话（结论 13 要求同组，组名是起草者取的）。存量未绑定会话的能力栏仍显示 `任务启动于 未绑定`（chat-web「输入框与能力栏」），与它所在的分组名 `临时空间` 不一致；本 change 不改这个标签。
2. 组序：置顶区之后，工作空间分组按 `GET /api/workspaces` 的次序，其后 `临时空间`、`未知空间`。
3. 归档视图在列表区内切换，不是弹层。
4. 撤回后只列未还原的文件（`skipped` / `failed`），不列已还原的。
5. 撤回首条消息后会话标题不变（仍是那条消息的前 18 个码点）。
6. 同一空间有别的会话在运行时，`files:"force"` 也被拒（409 `session_busy`）；结论 20 的三选一没有这条限制。
7. 用户在文件页做的手工改动不算冲突（冲突判定只看会话回合，D12）；D 落地后文件页的删、改、移会被还原覆盖而不提示。同理，另一个同空间会话在被撤回消息之后跑过回合、随后被整个删除的，也不报冲突（库里已没有它的记录），它留下的文件会被还原覆盖而不提示。
8. 已归档的会话在服务端仍可改名、置顶（界面不提供入口）。
9. 快照上限的维度与默认值：单文件 20 MiB、总量 500 MiB、条目 50000 条（结论 18 只要求「单文件与总量」，条目上限是为封住遍历成本加的）。

### D17 临时空间会话的产物卡（owner C-26）

临时空间不在 `GET /api/workspaces` 里，而主规格 turn-artifacts 把「`workspaceId` 不在空间列表中」当作空间不可解析——不改的话，未选空间的新会话（本 change 之后的默认路径）里助手写出的 HTML、图片、代码文件都没有产物卡，直到 D 交付。owner 定：C 里就让它们照常显示。
- 「空间可解析」改为：`workspaceId` 非 null 且（在已读取的空间列表里，或会话 `temporaryWorkspace` 为 true）。后一半只看会话视图，不依赖空间列表的读取状态。
- 临时空间会话：产物卡与产物面板的操作按钮照常渲染，用会话的 `workspaceId` 调既有预览 API（D6：按 id 的端点对临时空间照常工作）。
- 文件变更卡与面板的行只显示空间内相对路径、不渲染 `查看详情`：它的目标是 `/files?ws=<id>`，而文件页不列临时空间；从会话进入临时空间文件的入口随 D 的工作空间侧边栏交付（C-26、D-22）。逻辑路径 `<account>/tmp-<id>/…` 也不显示（目录名只是实现细节，转正之前不给用户看）。
- 服务端不变：`chat_steps.changes` 的归属判定按 `workspace_id` 是否为 NULL 走，临时空间会话本来就有 `changes`。

## Sketch seams under test

- **REST（`createApp` + inject，fake omp）**：`POST /api/sessions`、`PATCH`、`DELETE`、`POST …/undo`、`POST /api/workspaces/:id/promote`、`GET /api/workspaces`、
  `GET /api/sessions` 与消息快照。临时空间、归档、撤回、冲突、鉴权与审计都从这一层断言，磁盘状态直接读临时沙箱目录。最高的服务端 seam，覆盖装配。
- **列表事件连接（真实 HTTP 监听 + 原生 SSE 读取）**：`GET /api/sessions/events`。SSE 的逐字节输出、心跳与关停只能在真实连接上观察。
- **`workspaces/snapshots.ts` 的 `take` / `restore`（真实临时目录）**：硬链接去重、上限、跳过、符号链接与还原的路径安全是文件系统语义，
  经 REST 断言不到 inode 与权限位；这是唯一一个模块级 seam。
- **`ChatPage` 整页测试（假路由 + 假 EventSource）**：列表分组、搜索、归档视图、菜单动作、撤回与冲突对话框、列表事件驱动的重取。沿用 change B 的整页测试做法。
- **纯函数**：分组 / 过滤（`session-groups.ts`）与导出 Markdown——输入输出可逐值断言，不需要渲染。
- **`SessionSupervisor.prompt` 的 `beforeDispatch`（supervisor 单元 seam，挂起的 Promise）**：派发前步骤期间的 stop 语义与拒绝路径和快照模块无关，在这一层用一个可控的 Promise 就能钉住，不必经 REST。
- **真实栈**：`smoke/session-meta.hurl`、`smoke/chat.hurl`（契约与清理）与 `web/e2e/ui-walk-sessions.spec.ts`（真实 omp 下的临时空间、产物卡、撤回还原文件、归档）；任务组 0 的一次性脚本核对真实 omp 的 `branch` / `--resume` 行为。

## Risks / Trade-offs

1. **快照加在首包之前** → 首个回合或大改动之后的回合，202 会晚「复制变更文件」的时间；条目上限与总量上限封顶，排除依赖目录去掉最常见的大目录。
   不设单独的时间预算（多一个配置与一条竞态路径）；若实测不可接受，再加。
2. **快照占用随历史增长，没有上限** → 硬链接使占用约等于「各回合之间变过的内容之和」；随会话删除清理。部署文档写明要把 `snapshots` 纳入磁盘规划（Open Questions 1）；`take` 中途进程被杀留下的半份目录没有登记行、不被自动回收（workspace-snapshots「快照清理」），同样写进运维说明。
3. **还原、目录删除与快照遍历的路径替换残余**（D8、D9、D10）→ 逐级 `lstat`、不跟随符号链接、trash 中转；快照的普通文件按句柄（`O_NOFOLLOW`）读取，只剩中间分量被替换这一种；剩余窗口需要另一个正在运行且被注入的 omp 进程卡准时机，登记进 ADR-0010。
4. **每个标签页多一条 SSE** → HTTP/1.1 下浏览器对同源约 6 条连接；一个选中会话的标签页占 2 条，第 4 个这样的标签页起请求会排队。
   列表连接只在会话页挂载时打开。见 Open Questions 2。
5. **冲突判定偏保守**（D12）→ 多弹对话框（别的会话在那之后只发过 `/todo`、或回合其实没动文件，也算）；经别的会话的回合发生的改动不会被静默冲掉。判据之外不提示的情形恰两种（文件页手工改动；B 跑过回合后被整个删除），B 自己撤回、登记行写入失败现在都报冲突；不漏报另有两个前提——宿主时钟不回拨，fork 与其后首次 regenerate 的受理不落在同一毫秒，见 D12。已知残余（不纳入例外清单、不改判据）：B 自己的 `restore` 在文件还原之后、提交事务失败（触发面仅限审计等库写入失败）时，文件已被 B 改动而 `B.updated_at` 没写，S 随后的还原不会提示。
6. **`POST /api/sessions` 的语义变化波及大量既有测试**（断言 `workspaceId:null` 与 cwd 为账号根的用例）→ 组 5 的任务 5.7 集中改写（与创建语义的切换同一个 PR）；需要未绑定会话的用例改为直接写库。
7. **转正后的目录名是 `tmp-<id>`** → 文件页显示的逻辑路径不好看；owner 已接受「目录不移动」。
8. **撤回后下一条消息要重新 spawn** → 多一次进程启动的延迟，换来已验证的进程路径（D11）。
9. **撤回 CAS 失败时文件已还原** → 只有绕过控制占用的直接改库才会触发；还原幂等，重试即可。已知残余（不改判据）：前置校验第 6、7 步（同空间另一会话在跑、冲突判定）只在开头查一次，提交时的 CAS 只复核 S 自己；从前置校验通过到文件还原之间（退役进程与临时进程往返期间），同空间的另一会话 B 没被占用，可以受理新 prompt 并开始写文件，S 的还原可能与 B 这一回合的写入交错而不报冲突。窗口只有一次撤回的时长，不为此加空间级的锁。
10. **`.git` 进快照，大仓库更容易触发上限**（owner C-25）→ 版本库里的松散对象每个算一个条目，历史长的仓库很容易超过 `SNAPSHOT_MAX_ENTRIES`（50000）或总量上限，那一轮就没有快照、那条消息不能撤回（`too_large`，按钮说明原因）；超过单文件上限的 pack 文件不进快照，撤回时保持现状并列在未还原文件里——引用回到旧提交后仓库仍然自洽（对象只增不减），但回合里若发生过 `git gc` / repack 把旧对象并进了一个超限的新 pack，还原出的引用指向的对象可能只存在于被跳过的文件里，仓库状态与那条消息发出时不完全相同。
    缓解：三个上限与排除名单都可配，管理员可以调大上限，或把 `.git` 加回 `SNAPSHOT_EXCLUDE_NAMES`（回到「提交不随撤回还原」）；部署文档写明这一取舍（任务 20.4）。
11. **写回的文件权限位被放宽到属组可读写**（D10）→ 快照时是 `0600` / `0644` 的文件还原后为 `0660` / `0664`。沙箱目录本来就对共享组（omp 用户）开放，这不扩大可达范围；不这样做的话还原出的文件 agent 改不了。

## Migration Plan

- 迁移（各自一个 runner 事务，只增不改，无回填）：
  - `037_chat_session_archive.sql`：`chat_sessions.archived_at INTEGER NULL`（非负整数 CHECK）。
  - `038_workspace_temporary.sql`：`workspaces.temporary INTEGER NOT NULL DEFAULT 0`（0/1 CHECK）。
  - `039_chat_turn_snapshots.sql`：新表与 `workspace_id` 索引。
- 合入次序（每个 PR 合入后主干可运行；组号与 tasks.md 一致）：组 0（真实 omp 核对，只有结论，可与组 1–6 并行，但必须先于组 7）→ 组 1（契约三键与迁移 037、038，server + web 同 PR）→ 组 2（归档）→ 组 3（临时空间的 store 与可见性：此时还没有任何路径创建临时空间）→
  组 4（转正）→ 组 5（随最后一个会话删除，然后才切换 `POST /api/sessions` 的创建语义——先有清理再有创建，中间没有「能建不能删」的状态）→ 组 6（列表事件）→
  组 7–9（布局、配置、快照的落盘与还原）→ 组 10（迁移 039、`supervisor.ts` 腾行、派发前步骤、受理时做快照、消息 `undo` 键 server + web 同 PR）→ 组 11–12（撤回的服务端）→
  组 13–18（web：客户端与连接器、列表、菜单、归档视图、临时空间 / 产物卡 / 导出、撤回；被改写的既有走查步骤随组 14、15 的 PR 一起改）→ 组 19（追加的冒烟与走查）→ 组 20（文档）。
- 部署：升级后首次启动由 `ensureOmpStateLayout` 建出 `snapshots`（`0700`）；无需手工步骤。已有会话的消息没有快照行，读作不可撤回。
- 回滚：迁移只增列与表，旧版本二进制忽略它们；但旧版本会把临时空间列在 `GET /api/workspaces` 里、不清理临时目录与快照目录。
  回滚后残留的 `snapshots` 目录可由运维在停服务后删除。迁移文件本身不回退（runner 不支持降级）。

## Open Questions

下列两项都不卡任何任务或 requirement（规格已按「不提供」/「不改代码」写定），留给 owner 以后决定：

1. **快照保留预算**：现设计保留到消息被删为止（Non-Goals）。是否要按空间设预算（超出时淘汰最旧的快照，被淘汰的轮次变为不可撤回）——这会进一步收窄结论 16，要做就另开 change。
2. **连接数**：是否接受 HTTP/1.1 下约 3 个带会话的标签页的上限，还是在反向代理上启用 HTTP/2。这是部署事项，不改代码；任务 20.4 只在部署文档里写明。

（原 Open Questions 1–3、6 已关闭：命令回合与分叉拷贝消息不能撤回 → owner C-23、C-24，D11；默认排除名单 → owner C-25，D9；默认数值上限与呈现细节 → 起草者定，D16。）

## Not yet specified

- **挂载的远程存储上的快照**（S1b 未交付）：挂载点会出现在工作空间树里，遍历是否进入、网络存储上的 `ctime` 语义、容量如何计入上限都还说不清。
  等 S1b 的挂载形态定了再定；在那之前工作空间里没有挂载点。
