# Spec: chat-web

## ADDED Requirements

### Requirement: API 客户端扩展
`ApiClient` SHALL 新增 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，沿用既有错误信封解析与 401 → 未登录态处理；`prompt` 的 409 SHALL 解析为 `ApiError{code:"session_busy"}`，502 为 `ApiError{code:"agent_unavailable"}`。

#### Scenario: 信封解析
- WHEN mock fetch 返回 409 `session_busy` 信封
- THEN `prompt()` 以 `ApiError` 拒绝且 `code==="session_busy"`、`message` 为信封 message

### Requirement: 会话页
`/` 路由 SHALL 渲染会话页，当前会话由查询参数 `?session=<id>` 表示（选择/新建即更新该参数，刷新后据此恢复；无参数或参数指向不可访问会话时显示空态）：左侧本账号会话列表（`updated_at` 降序，显示标题或"新会话"、状态徽章）与"新建会话"按钮；右侧消息列表与输入框。进入无选中会话时 SHALL 显示空态与输入框；发送时若无当前会话 SHALL 先 `createSession` 再 `prompt`。assistant 消息 SHALL 按事件渲染：`turn.start{messageId}` → 将该消息正文与步骤重置为空（回放与 REST 已加载部分不重复），`step.start/end` → 步骤卡三态（`running/done/failed`，与服务端步骤状态同名；对应 demo `exec.steps` 的 `run/done` 视觉，demo 的 `todo` 态不出现——S0b 无预告步骤），`text.delta` → 正文追加，`turn.end` → 状态 `done/failed`，`error` → 内联错误文案。发送后到 `turn.end` 前输入框 SHALL 禁用并显示"生成中"；`session_busy`/`agent_unavailable` SHALL 以信封 message 内联提示。

#### Scenario: 一次流式对话
- WHEN 用户发送"你好"，假 `EventSource` 依次投递 turn.start、step.start、step.end、text.delta×3、turn.end(done)
- THEN 页面依次出现步骤卡（run→done）、逐段增长的正文、最终状态 done，输入框恢复可用；列表中该会话标题为"你好"

#### Scenario: 刷新恢复
- WHEN 页面以 `/?session=<id>` 加载，`getMessages` 返回一条 `running` assistant 消息含部分正文，随后假 `EventSource` 回放 `turn.start(该 messageId)`、`text.delta×3`
- THEN 该消息正文被重置后恰为三段拼接（不含重复的部分正文），列表选中该会话

#### Scenario: 错误提示
- WHEN `prompt()` 返回 502 `agent_unavailable`
- THEN 内联显示"Agent 运行时不可用"，消息列表不新增 assistant 消息

### Requirement: 事件流消费与续流
`connectSessionEvents(id, {EventSourceCtor})` SHALL 用注入的 `EventSource` 打开 `/api/sessions/:id/events`（`withCredentials`），把帧交给纯归约器 `applyChatEvent(state, event)`；页面加载顺序 SHALL 为先 `getMessages` 再打开连接；收到 `replay.gap` SHALL 触发 `getMessages(id)` 重载后继续消费实时事件；切换会话、组件卸载、认证态变为未登录 SHALL 关闭连接。浏览器自动重连（携带 `Last-Event-ID`）SHALL 无需应用代码参与。

#### Scenario: 缺口重载
- WHEN 假 `EventSource` 先投递 `replay.gap`
- THEN 发生一次 `getMessages` 调用，其结果替换消息列表，随后的 `text.delta` 继续追加到对应消息

#### Scenario: 归约器纯度
- WHEN 对同一初始状态重复应用同一事件序列
- THEN 得到结构相等的状态；未知事件类型被忽略且不抛错
