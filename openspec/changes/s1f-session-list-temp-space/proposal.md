# Proposal: s1f-session-list-temp-space

## Why

S1f 的 A（基础）与 B（会话页）已交付，会话列表的八个文件仍是旧基元上的实现（三分区不可折叠、五色状态点、状态 × 时间筛选、
菜单三项、动作用轻提示），是会话页里最后一块 legacy。同时两条计划内的行为还没有后端：未选工作空间就发送的会话仍跑在用户根目录
（计划「已定」第 5 条要求会话专属临时空间），列表没有任何实时通道（别的标签页或后台回合改了状态，要等下一次整表重取）。
owner 于 2026-10-06 把 #907（用户消息撤回）并入本 change：撤回要连文件一起还原，否则不上线，因此需要每回合前的工作空间快照。

压测凭证：`.workplans/stage/grill-C.md`（22 条结论，owner 2026-10-06 确认）与同日的补充决定 C-23…C-26（`.workplans/stage/owner-decisions-stage3.md`，落点见 design）。本 change 是 S1f 的 change C，实施顺序 C → S1g → D。

## What Changes

**会话列表（web，重建在新组件层上）**

- 置顶区在最上；其下默认按工作空间分组，每组可折叠；可切换为按时间（今天 / 近 7 天 / 更早）。分组方式与折叠状态记在浏览器本地。
- **BREAKING（界面）**：取消原有的状态筛选与时间筛选（`筛选任务` 弹层整个移除）。
- 每行只有标题和一个状态标记；可见标记只有三种：运行中（转动的指示）、等待确认（醒目的提示点）、失败（错误色）。
  已完成 / 已停止 / 未开始不显示标记。不做未读。
- 标题搜索：在已加载的列表里前端过滤；归档的会话不在结果里，进归档视图后才搜得到。
- 更多菜单：`重命名`、`置顶任务` / `取消置顶`、`归档`、`删除`、`另存为工作空间`（只在用临时空间的会话上）、`导出记录`。
- 归档：从默认列表隐藏、可恢复；侧栏底部有 `已归档` 入口可查看、恢复、删除；运行中的会话不能归档；归档的会话打开后只读。
- 导出记录：前端用已有的消息快照生成 Markdown 文件（标题、每条用户消息与助手正文、工具调用只列名称与状态；不含思考与工具原始输出），不改服务端。
- 删除仍先确认；使用临时空间的会话，确认框写明文件会一并删除（共用时写明保留到最后一个会话被删除）。
- 会话列表动作不再弹轻提示：成功不提示（列表自身的变化即反馈），失败在触发处就地显示（ADR-0013 留给本 change 的一项）。
- 八个会话列表文件离开 legacy 层，进入已迁移清单；`chat.css` 与 `筛选` 相关文件删除。
- 不用 assistant-ui 的 `adapters.threadList`，列表仍由应用自己经外壳侧栏插槽渲染。

**列表状态刷新（server + web）**

- 新增按用户的事件连接 `GET /api/sessions/events`（SSE）：会话的存在、标题、状态、置顶、归档、是否有待决确认、所用工作空间有变化时推一条
  不带数据的通知，页面收到后重取列表；断线重连后同样重取一次，不做事件回放。
- 会话视图增加三个键：`archivedAt`、`pendingApproval`（由 `chat_approvals.decision IS NULL` 推导）、`temporaryWorkspace`。**BREAKING（契约）**：
  会话 DTO 为严格键集，服务端与 web 同刀落地。

**临时空间（server + web）**

- `POST /api/sessions` 不带 `workspaceId` 时，在同一事务里创建一个带临时标记的工作空间（目录在该账号沙箱根下）并绑定给新会话。
  **BREAKING（契约）**：此前这种请求创建的是未绑定会话。会话只由欢迎态首次发送创建（change B），所以临时空间就是在「未选空间发送第一条消息」时创建。
- 临时空间不出现在 `GET /api/workspaces`（文件页不列出），按 id 的目录树 / 预览 / 新建目录端点照常可用（从会话进入）。
- `另存为工作空间` = 原地转正：`POST /api/workspaces/:id/promote {name}` 去掉临时标记并改名，目录不移动，共用它的会话都随之绑定到这个正式空间。
- 分叉继承同一个临时空间；删除会话时，若它是最后一个使用该临时空间的会话，空间行与目录一并删除。
- 已有的未绑定会话（`workspace_id` 为 NULL）保持原样：仍跑在用户根目录，不迁移；列表里与临时空间的会话归同一组。

**撤回（#907，server + web）**

- 每个回合开始前（prompt 受理之后、派发之前）给会话的工作空间做一次快照，存放在工作空间之外、omp 用户进不去的目录里。
  单文件与空间总量有上限：超限的单个文件不进快照，总量超限则该轮不做快照；数值可配置。默认只排除依赖目录（`node_modules`、`.venv`、`__pycache__`）；`.git` 进快照，撤回时连同回合里的提交一起还原。
- 用户消息的操作行增加 `撤回`（次序：复制、撤回、从此处分叉；复制与悬停显隐属 #908）。点击后不弹确认：这条及之后的全部消息从当前会话移除，
  工作空间还原到这条消息发出之前，这条的文字放回输入框并覆盖草稿。可一次退回多轮。
- 没有快照的轮次不能撤回（按钮禁用并说明原因）：超限、快照失败、跑在用户根目录的老会话；另有两种由 owner 补充决定：白名单命令回合（`/todo`、`/skill:…`）的消息不能单独撤回，分叉拷贝来的消息不能撤回（分叉后新发的可以）。
- 共用工作空间而别的会话在那条消息发出之后还运行过回合时（含在它之前开始、之后才结束的回合），弹出三选一：只撤回对话不动文件 / 连文件一起还原 / 取消。
- 用临时空间的会话照常显示产物卡与产物面板的预览 / 下载 / 复制；跳到文件页的 `查看详情` 在这类会话上不渲染（文件页不列临时空间，入口随 change D 的侧边栏交付）。
- 新增 `POST /api/sessions/:id/undo`；新增错误码 `session_archived`、`undo_conflict`。

**不在本 change**：见 design.md Non-Goals（未读、列表全文搜索、消息编辑重发、挂载存储上的快照、#908–#912 等）。

## Capabilities

### New Capabilities

- `session-list-push`：按用户的会话列表事件连接（端点、事件种类、触发点、断线对齐、web 侧消费）。
- `temporary-workspaces`：临时工作空间的数据表示、创建、可见性、转正、与会话的共用及随最后一个会话删除。
- `workspace-snapshots`：每回合前的工作空间快照（存放位置、内容规则、上限、去重、还原、清理）。
- `message-undo`：用户消息撤回（REST、对话原地回退、文件还原、冲突判定、web 呈现）。

### Modified Capabilities

- `session-sidebar`：「分区侧栏」移除，由新增的「分组侧栏」取代（置顶区 + 可折叠分组，按工作空间 / 按时间）；「会话条目菜单与重命名」改为六项菜单且不再弹提示；
  「composer footer 工作空间选择」增加临时空间的只读标签；另移除「状态与时间筛选」与「会话 DTO 八键严格解析」（后者由「会话 DTO 严格解析」取代）；
  新增状态标记、标题搜索、归档视图、导出记录、另存为工作空间对话框。
- `session-metadata`：「会话创建与空间绑定」（不带空间时建临时空间）、「会话元数据修改」（`archived`）、「会话删除」（临时空间与快照的清理）、
  「绑定不可改与工作目录」、「fork 继承会话元数据」；新增「会话视图扩展键」「会话归档」。
- `chat-sessions`：「会话数据 schema」（迁移 037–039）、「会话 REST」（路由数、视图键集、消息 `undo` 键）、「REST prompt 受理与补偿」（快照步骤、202 的 `undo`、归档拒绝）、
  「Supervisor dispatch and generation binding」（`prompt` 端口增加派发前步骤，快照在其中执行，其间的 stop 仍登记停止意图）。
- `workspaces`：「列表与创建」与「工作空间 store 与惰性目录事务」（列表不含临时空间）。
- `chat-web`：「API 客户端扩展」（DTO 键集、新方法）、「会话页」（列表呈现、归档只读、列表事件）、「消息线程」（`撤回`）、「输入框与能力栏」（临时空间标签）。
- `turn-control`：「从此处分叉 REST」（视图键集、归档拒绝、快照不拷贝、共用临时空间）、「会话级控制占用」（撤回也持有占用；占用期间归档被拒）、停止的那条 Requirement（「prompt 尚未派发」包含快照步骤进行中；202 受理 body 为三键）、「stopped 终态」（受理 body 三键；启动对账不改 `updated_at`）。
- `turn-artifacts`：「文件变更卡」「产物卡」「产物面板」（用临时空间的会话视为空间可解析：产物卡与面板操作照常渲染，行只显示相对路径、不渲染 `查看详情`）。
- `session-todo`：「任务清单持久化」（快照步骤只读 `chat_sessions.todo`，撤回事务是它的第二个写者）、「任务清单快照」（会话视图键集改为引用 session-metadata，不再写死八键）。
- `omp-pool`：「活进程集合与上限不变量」「串行化准入与最久空闲驱逐」（撤回的临时进程与 fork 的同样计入上限、经同一准入点）。
- `spa-shell`：「路由 IA 与侧栏」（列表区的分组描述）。
- `ui-foundation`：「组件分层」（会话列表文件进入已迁移清单，`web/src/features/chat` 下不再有 `.css`）。
- `omp-runtime`：「OMP_STATE_DIR 托管布局」（新增 app 私有的 `snapshots` 目录）。
- `http-service-skeleton`：「统一错误信封」（两个新错误码、两条新的 content-parser 归属路由）、「服务启动与装配」与「Shared agent module assembly」（四个 `SNAPSHOT_*` 配置项，应用配置由十五项变为十九项）。
- `chat-harness`：「会话元数据 HTTP 冒烟」「UI 走查会话元数据」（随契约与呈现改写）；新增「UI 走查临时空间、撤回与归档」与「冒烟与走查不留会话与临时空间」（`smoke/chat.hurl` 与 `ui-walk.spec.ts` 删除自己创建的会话）。

## Impact

- **服务端代码**：`server/src/sessions/`（`store-metadata.ts`、`rest-metadata.ts`、`rest.ts`、`session-delete.ts`、`store.ts` 的列集与视图，
  新模块：列表事件、撤回编排与撤回事务、快照登记）、`server/src/workspaces/`（`store.ts`、`rest.ts`，新模块：快照的落盘与还原）、
  `server/src/sessions/omp/state-layout.ts`、`server/src/core/errors`、`server/src/http`（错误映射与归属集）、`server/src/agent-config.ts`（四个新配置项）、`server/src/app.ts`（装配）。
  `store.ts`（797 行）与 `supervisor.ts`（800 行）已到行数上限，新逻辑一律进新模块。`supervisor.ts` 有两处必须改：`prompt` 的派发前步骤，以及撤回的接线（临时进程要用 supervisor 私有的进程池、token、控制占用与关停，接入方式与 fork 相同：构造接线、一个公开方法、关停时收掉）；二者之前先做一条行为不变的腾行重构（design D15 列出挪走的段与行数预算）。列表事件的通知经既有的 `onEvent` 观察口取得，不改 `supervisor.ts`。
- **冒烟与走查**：`smoke/session-meta.hurl`、`smoke/chat.hurl`、`web/e2e/ui-walk.spec.ts`、`web/e2e/ui-walk-sessions.spec.ts` 与新 helper `web/e2e/ui-walk-session-list.ts`。
- **API**：新增 `GET /api/sessions/events`、`POST /api/sessions/:id/undo`、`POST /api/workspaces/:id/promote`；`PATCH /api/sessions/:id` 接受 `archived`；
  会话视图 8 键 → 11 键；消息视图增 `undo`；prompt 的 202 增 `undo`；`POST /api/sessions` 无 `workspaceId` 时的语义改变；`GET /api/workspaces` 不含临时空间。
- **迁移**：037 `chat_sessions.archived_at`；038 `workspaces.temporary`；039 `chat_turn_snapshots` 表。均为新增，不重建表、不回填。
- **web 代码**：`web/src/features/chat/` 的会话列表文件重写（旧八个文件改写或删除，新增分组、搜索、归档视图、导出、另存对话框、列表事件连接器、撤回动作等文件），文件变更卡 / 产物卡 / 产物面板的空间解析判定，
  `message-action-row.tsx`、`message-thread.tsx`、`use-chat-session.ts`、`turn-actions.ts`、`capability-bar.tsx`、`web/src/lib/api-sessions.ts`、`session-contract.ts`、`api.ts`。
- **依赖**：无新增 npm 包；宿主不需要新二进制（快照用 Node `fs`，不依赖 git / tar / rsync）。
- **部署**：`OMP_STATE_DIR` 下多一个 `snapshots` 目录（app 私有 `0700`），占用随会话历史增长，需纳入磁盘规划（`.git` 进快照，带大仓库的空间占用更多、也更容易触发上限）；四个可选环境变量
  `SNAPSHOT_MAX_FILE_BYTES`、`SNAPSHOT_MAX_TOTAL_BYTES`、`SNAPSHOT_MAX_ENTRIES`、`SNAPSHOT_EXCLUDE_NAMES`；每个打开会话页的标签页多占一条 SSE 连接。
- **文档**：`CONTEXT.md`（「任务」词条改写、新增「临时空间」「快照」「撤回」「归档」）、ADR-0013 增补（threadList 决定、列表提示退场）、
  ADR-0010 增补（快照目录、临时空间目录删除与文件还原的残余）、`docs/acceptance/functional-checklist.md`（新增行，结论 `待签`）、`IMPLEMENTATION_PLAN.md` 状态行。
- **跨 change 约定**：S1g（上传目标 = 会话的工作空间，可能是临时空间）与 D（会话页侧边栏打开会话的工作空间；文件页不列临时空间）引用本 change 的
  `temporary-workspaces`。归档顺序 C → S1g → D：本 change 的 MODIFIED 以主规格现文本为底，计数写「主规格现值加本 change 的增量」；S1g 与 D 的同名 MODIFIED 以本 change 的文本为底再加自己的增量（design D15 的重叠表逐条列出必须存活的句子、场景与计数）。
  本 change 不新增沙箱 resolve 的 op：临时空间目录的删除与快照还原是服务端内部操作，不是用户路径操作。
