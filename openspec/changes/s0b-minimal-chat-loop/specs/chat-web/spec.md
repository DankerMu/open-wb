# Spec: chat-web

## ADDED Requirements

### Requirement: API 客户端扩展
`ApiClient` SHALL 新增 `listSessions()`、`createSession()`、`getMessages(id)`、`prompt(id, message)`，沿用既有错误信封解析与 401 → 未登录态处理；`getMessages` SHALL 保留完整历史和 `streamCursor:{epoch:number,seq:number|null}` 的类型化响应，不丢弃、猜测或默认化游标；`prompt` 的 409 SHALL 解析为 `ApiError{code:"session_busy"}`，502 为 `ApiError{code:"agent_unavailable"}`。

#### Scenario: 信封解析
- WHEN mock fetch 返回 409 `session_busy` 信封
- THEN `prompt()` 以 `ApiError` 拒绝且 `code==="session_busy"`、`message` 为信封 message

### Requirement: 会话页
`/` 路由 SHALL 渲染会话页，当前会话由查询参数 `?session=<id>` 表示（选择/新建即更新该参数，刷新后据此恢复；无参数或参数指向不可访问会话时显示空态）：左侧本账号会话列表（`updated_at` 降序，显示标题或"新会话"、状态徽章）与"新建会话"按钮；右侧消息列表与输入框。进入无选中会话时 SHALL 显示空态与输入框；发送时若无当前会话 SHALL 先 `createSession` 再 `prompt`。assistant 消息 SHALL 按事件渲染：`turn.start{messageId}` → 将该消息正文与步骤重置为空（回放与 REST 已加载部分不重复），`step.start/end` → 步骤卡三态（`running/done/failed`，与服务端步骤状态同名；对应 demo `exec.steps` 的 `run/done` 视觉，demo 的 `todo` 态不出现——S0b 无预告步骤），`text.delta` → 正文追加，`turn.end` → 状态 `done/failed`，`error` → 内联错误文案。发送后到 `turn.end` 前输入框 SHALL 禁用并显示"生成中"；`session_busy`/`agent_unavailable` SHALL 以信封 message 内联提示。
连接器 SHALL 先按完整快照的 streamCursor 过滤已覆盖事件；上述 turn.start 重置仅应用于过滤后交给归约器的事件，不重置已被快照覆盖的历史。

#### Scenario: 一次流式对话
- WHEN 用户发送"你好"，假 `EventSource` 依次投递 turn.start、step.start、step.end、text.delta×3、turn.end(done)
- THEN 页面依次出现步骤卡（run→done）、逐段增长的正文、最终状态 done，输入框恢复可用；列表中该会话标题为"你好"

#### Scenario: 刷新恢复
- WHEN 页面以 `/?session=<id>` 加载，`getMessages` 返回完整 running assistant 历史和对应游标，随后假 `EventSource` 回放已被快照覆盖的 turn.start/step/text 及更晚事件
- THEN 已覆盖事件被丢弃，不重置快照正文或步骤；仅应用游标后的事件，最终正文不重不漏，列表选中该会话

#### Scenario: 错误提示
- WHEN `prompt()` 返回 502 `agent_unavailable`
- THEN 内联显示"Agent 运行时不可用"，消息列表不新增 assistant 消息

### Requirement: 事件流消费与续流
`connectSessionEvents(id, {EventSourceCtor})` SHALL 用注入的 `EventSource` 打开 `/api/sessions/:id/events`（`withCredentials`），把未被快照覆盖的帧交给纯归约器 `applyChatEvent(state, event)`；页面加载顺序 SHALL 为先 `getMessages` 再打开连接，并传入初始快照边界。收到 `replay.gap` SHALL 缓冲到达事件并重新加载完整快照；只在当前未关闭、未被更新请求替代的恢复任务中安装快照，再按到达顺序过滤/应用队列。epoch 小于快照 epoch 的事件 SHALL 丢弃；同 epoch 且快照 seq 为 null 时全部丢弃，否则丢弃 seq≤快照 seq；更高 epoch 与同 epoch 的后继事件 SHALL 继续消费。该规则适用于全部数据事件，避免旧 turn.start 清空快照。加载期间再次出现 gap 或队列溢出 SHALL 重新同步，不静默丢失后继续追加。切换会话、卸载、未登录 SHALL 关闭连接并使在途恢复结果失效。gap 控制帧的空 id 重置浏览器续流游标；数据帧自动重连仍由 EventSource 携带 Last-Event-ID。

#### Scenario: 缺口重载
- WHEN 快照为2048字符、游标1:1002，重载期间排队的1048字符 delta 为1:1002、后续 Z 为1:1003
- THEN 安装快照后丢弃1:1002、只追加 Z，最终精确2049字符而非3096或2048；旧 turn.start 同样丢弃
- WHEN 快照游标为 `{epoch:1,seq:null}`，队列含 epoch1 尾帧及 epoch2 新回合
- THEN 丢弃全部 epoch1 帧，仅按顺序应用 epoch2；关闭或切换后完成的旧重载不能覆盖当前会话

#### Scenario: 归约器纯度
- WHEN 对同一初始状态重复应用同一事件序列
- THEN 得到结构相等的状态；未知事件类型被忽略且不抛错
