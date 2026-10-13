## MODIFIED Requirements

### Requirement: fork 继承会话元数据
`POST /api/sessions/:id/fork`（chat-sessions「会话 REST」fork 段）在其最终事务中插入的新会话行 SHALL 复制源会话的 `workspace_id` 与 `scene`，并复制 `approval_mode`、`model_id`、`reasoning_effort` 三列的原始值（含 NULL）——`approval_mode` 高于当前 `APPROVAL_MAX_MODE` 时写入上界本身（session-permission-tier「管理员最高档」，owner 2026-10-12，#1282），其余原样；新会话的有效值由 session-composer-settings「有效值解析」读出，与源会话当前的有效值相同，`pinned_at` 与 `archived_at` SHALL 为 NULL；其余列与该段规则一致。该事务拷贝的消息与步骤 SHALL 同时拷贝 `chat_messages.thinking` 与 `chat_steps.changes`（原值，含 NULL），使新会话的快照与源会话被拷贝部分的思考与文件变更一致。fork 响应中的 `session` 与其它会话视图键集相同（「会话视图扩展键」）。源会话用临时空间时，新会话继承同一个 `workspace_id`、与源会话共用该临时空间（temporary-workspaces「共用与随最后一个会话删除」），fork 不复制目录、不新建空间行；fork SHALL NOT 拷贝 `chat_turn_snapshots` 行。fork 临时进程以源会话的有效审批档位与有效模型启动（omp-runtime「子进程 spawn 契约」）；fork SHALL NOT 改动该账号的最近选择。fork 会话后续 generation 的 `--cwd` 由其继承的 `workspace_id` 按「绑定不可改与工作目录」计算，与源会话一致（均为源空间根或所有者根）。fork 不写 `session.bind` 审计，也不写 `session.permission` 审计。

#### Scenario: 继承空间与场景、不继承置顶
- **WHEN** owner 对绑定 W、`scene="code"`、已置顶的源会话调用 fork（fake-omp `branch`），随后在新会话发 prompt
- **THEN** 201 的 `session` 为会话视图，`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；源会话 `pinnedAt` 不变；被拷贝助手消息的 `thinking` 与其步骤的 `changes` 在新会话快照中与源会话逐值相同（NULL 仍为 null）；新会话进程 probe 报告的 `cwd` 为 W 的根；审计无 `session.bind` 新增

#### Scenario: fork 响应的会话视图与列表一致
- **WHEN** owner 对绑定 W、`scene="design"`、已置顶的源会话调用 fork 成功，随后 `GET /api/sessions`
- **THEN** 201 响应的 `session` 恰为十四键，`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`、`archivedAt=null`、`pendingApproval=false`、`temporaryWorkspace=false`、三项设置的有效值与源会话相同，且与 `GET /api/sessions` 中同 id 条目逐键相等

#### Scenario: 继承临时空间
- **WHEN** owner 对一个用临时空间 T 的源会话调用 fork
- **THEN** 新会话 `workspaceId=<T>`、`temporaryWorkspace=true`、`archivedAt=null`；`workspaces` 行数不变；账号根下的 `tmp-…` 目录数不变

#### Scenario: 继承三项设置
- **WHEN** owner 把源会话设为 `{approvalMode:"yolo", modelId:"m3", reasoningEffort:"low"}` 后调用 fork（fake-omp `branch`，测试记下临时进程的 argv），随后在新会话发 prompt；另一例源会话三列均为 NULL
- **THEN** 临时进程的 argv 含 `--approval-mode yolo` 与 `--model workbuddy/m3`；201 的 `session` 三键为 `yolo`、`m3`、`low`，新会话行三列与源会话逐值相同；新会话进程的 argv 含 `--approval-mode yolo`，其第一条 prompt 之前收到 `set_model` 与 `set_thinking_level`；审计没有新增 `session.permission`；该账号的最近选择行与 fork 前相同。另一例新会话三列为 NULL、视图为有效缺省值

#### Scenario: 封顶时 fork 不带走超界档位
- **WHEN** `APPROVAL_MAX_MODE=write`，源会话的 `approval_mode` 列为 `yolo`（上界调低之前写入）、另两列为 `m3`、`low`，owner 对其调用 fork（测试记下临时进程的 argv）
- **THEN** 临时进程的 argv 含 `--approval-mode write`；新会话行三列为 `write`、`m3`、`low`，源会话行仍为 `yolo`、`m3`、`low`；201 的 `session.approvalMode` 为 `write`；审计没有新增 `session.permission`；该账号的最近选择行与 fork 前相同
