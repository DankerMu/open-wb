## MODIFIED Requirements

### Requirement: 重新生成 REST
`POST /api/sessions/:id/regenerate` SHALL 受 cookie guard 与 owner 校验（401/404 同 stop），响应 no-store。该路由 SHALL 是无 body 路由且列入 content-parser 归属集：content-parser 错误与任何被解析出的 body SHALL 400 `bad_request`，在认证之后、任何 supervisor 调用之前，无写入。前置校验：会话 `status="running"` 或该会话持有控制占用 SHALL 409 `session_busy`；`status ∈ {done,failed,stopped}` 且末条消息 `role="assistant"` 且其前一条为 `role="user"` 方可执行，否则（含 `idle` 无消息、末条为 user）400 `bad_request`；末条 user 消息的 `content` 被 chat-sessions「Slash 命令白名单与命令目录」的 `classifyPrompt` 判为 `builtin|skill`（白名单命令回合在 omp 分支列表里没有条目）SHALL 同样 400 `bad_request`，判定在上述 409 之后；校验阶段不写任何行。校验通过即登记控制占用（见会话级控制占用），并记下预检读到的末条 assistant id。

执行序：取得该会话进程——若有存活进程则复用；若进程已被回收，SHALL 经与 prompt **相同**的懒 spawn 路径（omp-pool 准入、`--resume <omp_session_file>`、握手、token）取得一个正常 generation：`stream_epoch` 恰 +1 并新建该 generation 的 ring，后续回合事件经该 ring 发布、SSE 语义与普通 prompt 回合一致（准入可能 503 `agent_capacity`，无行变更）→ `request(get_branch_messages)` → 取列表最后一项，其 `text` SHALL 是 SQLite 中该会话末条 user 消息 `content` 的 wire 候选（chat-sessions「Slash 命令白名单与命令目录」Branch alignment：`content` 本身，或 `content` 以 `/` 开头时前置一个 U+0020 的转义形），否则（含列表为空）SHALL 502 `agent_unavailable` 且不改任何行、不发 `branch` → `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务：先以 CAS 复核会话 `status` 仍非 running 且末条 assistant id 仍等于预检读到的 id，复核失败 SHALL 409 `session_busy`、不改任何行并 retire 该进程；复核通过则删除旧 assistant 行（步骤与审批级联删除）、插入新 `running` 空 assistant 行、`omp_session_file`=新文件、会话 `status="running"`、`updated_at=now` → 以 `branch` 返回的 `text` 在同一 generation 上走既有 prompt 派发（不再 bump epoch）；该 `text` 以 `/` 开头时 SHALL 先前置恰一个 U+0020 再派发（预检已排除白名单命令锚点，所以裸 `/…` 的 branch 文本不可能是应当执行的命令；已是转义形的条目以空格开头，不会被二次转义），其余文本原样派发。SQLite 中的 user 正文不因此改变。响应 202 `{assistantMessageId}`（新行 id）。`branch` 之后、事务提交之前的任何失败 SHALL retire 该进程且不改动 `omp_session_file` 与消息行，返回 502 `agent_unavailable`。事务提交之后的派发失败 SHALL 把新 assistant 行与会话结算为 `failed` 并返回 502 `agent_unavailable`，不复活已删除的旧 assistant 行。后续回合事件、刷盘与终态 SHALL 与普通 prompt 回合完全一致。

#### Scenario: 正常重新生成
- **WHEN** 会话 `done`、历史为 user(`"second question"`) → assistant(a1)，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}`
- **THEN** 202 `{assistantMessageId:<新 id>}`；fake-omp 依次收到 `get_branch_messages`、`branch{entryId:"fake-entry-2"}`、`get_state`、`prompt{message:"second question"}`；a1 及其步骤行已删除；`omp_session_file` 等于 branch 后 `get_state` 返回的新路径；回合结束后 messages 为 user(`"second question"`) → assistant(新内容, `done`)

#### Scenario: 已回收会话的重新生成取得正常 generation
- **WHEN** 会话 `done` 且其进程已经 `OMP_IDLE_MS` 空闲回收，此时 messages 快照 `streamCursor.epoch=E`，随后调用 regenerate
- **THEN** 202；子进程以 `--resume <omp_session_file>` spawn；`stream_epoch` 恰 +1 一次（`get_branch_messages` 所用获取与随后的 prompt 派发共用这一 generation，不二次递增）；该会话 SSE 收到新 generation 的 `turn.start` … `turn.end(done)`；回合结束后 messages 快照 `streamCursor.epoch=E+1`

#### Scenario: 运行中与形态不满足
- **WHEN** 会话 running 时 regenerate
- **THEN** 409 `session_busy`，无入站帧、无行变更
- **WHEN** 会话 `idle` 无消息、或末条消息为 user、或末条 user 消息为白名单命令（如 `/todo`）
- **THEN** 400 `bad_request`，无入站帧、无行变更
- **WHEN** 已认证 owner 以任何 JSON body（含 `{}`）或 malformed JSON 调用 regenerate
- **THEN** 400 `bad_request`，无 supervisor 调用、无行变更

#### Scenario: 分支文本不一致
- **WHEN** `get_branch_messages` 最后一项 `text` 不是 SQLite 末条 user `content` 的 wire 候选，或返回空列表
- **THEN** 502 `agent_unavailable`；未发送 `branch`；assistant 行、`omp_session_file`、会话状态与 `updated_at` 完全不变；会话随后仍可正常 prompt

#### Scenario: branch 之后提交之前失败
- **WHEN** fake-omp 对 `branch` 正常应答后在 `get_state` 应答前退出（或事务写入抛错）
- **THEN** 502 `agent_unavailable`；该进程被 retire；旧 assistant 行及其步骤、`omp_session_file`、会话 `status` 与 `updated_at` 完全不变；随后对该会话的合法 prompt 以 `--resume <原 omp_session_file>` 重 spawn 并 202

#### Scenario: 最终事务复核失败
- **WHEN** regenerate 的 branch 之后的 `get_state` 已发出、应答尚未到达时，会话行被直接改写为末条 assistant id 不同于预检值（或 `status="running"`）
- **THEN** 409 `session_busy`；事务不写入任何行，旧 assistant 行与 `omp_session_file` 不变；该进程被 retire；占用已释放

#### Scenario: 池满
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 regenerate 一个已被回收进程的会话
- **THEN** 503 `agent_capacity`，无行变更

#### Scenario: 裸斜杠条目在派发前转义
- **WHEN** 末条存储 user 为白名单外的 `/help 这是什么`，`get_branch_messages` 最后一项的 `text` 是逐字相同的裸 `/help 这是什么`（转义规则落地之前留下的条目）
- **THEN** 202；fake-omp 收到的 `prompt` 帧 `message` 恰为 ` /help 这是什么`（一个前导 U+0020）；存储的 user 正文仍为 `/help 这是什么`
- **WHEN** 最后一项的 `text` 已是转义形 ` /help 这是什么`，或是不以 `/` 开头的 `second question`
- **THEN** `prompt` 帧 `message` 与该 `text` 逐字相同（不出现两个前导空格）
