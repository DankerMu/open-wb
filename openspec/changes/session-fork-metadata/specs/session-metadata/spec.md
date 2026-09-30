## ADDED Requirements

### Requirement: fork 继承会话元数据
`POST /api/sessions/:id/fork`（chat-sessions「会话 REST」fork 段）在其最终事务中插入的新会话行 SHALL 复制源会话的 `workspace_id` 与 `scene`，`pinned_at` SHALL 为 NULL；其余列与该段规则一致。该事务拷贝的消息与步骤 SHALL 同时拷贝 `chat_messages.thinking` 与 `chat_steps.changes`（原值，含 NULL），使新会话的快照与源会话被拷贝部分的思考与文件变更一致。fork 响应中的 `session` 与其它会话视图相同，为八键视图。fork 会话后续 generation 的 `--cwd` 由其继承的 `workspace_id` 按「绑定不可改与工作目录」计算，与源会话一致（均为源空间根或所有者根）。fork 不写 `session.bind` 审计。

#### Scenario: 继承空间与场景、不继承置顶
- **WHEN** owner 对绑定 W、`scene="code"`、已置顶的源会话调用 fork（fake-omp `branch`），随后在新会话发 prompt
- **THEN** 201 的 `session` 为八键，`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；源会话 `pinnedAt` 不变；被拷贝助手消息的 `thinking` 与其步骤的 `changes` 在新会话快照中与源会话逐值相同（NULL 仍为 null）；新会话进程 probe 报告的 `cwd` 为 W 的根；审计无 `session.bind` 新增

#### Scenario: fork 响应的会话视图与列表一致
- **WHEN** owner 对绑定 W、`scene="design"`、已置顶的源会话调用 fork 成功，随后 `GET /api/sessions`
- **THEN** 201 响应的 `session` 恰为八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`，`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`，且与 `GET /api/sessions` 中同 id 条目逐键相等
