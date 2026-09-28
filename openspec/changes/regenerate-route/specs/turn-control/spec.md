# Spec delta: turn-control（#467 regenerate 的 REST 路由与 prompt 受理前占用拒绝）

> 以当前主 spec（#465/#466 推进后）为底，只并入本 issue（父 tasks 5.1b）交付的部分：
> - 「重新生成 REST」：父 delta 同名块逐字（本刀之后整块已交付）。本刀新增路由首段（cookie guard、owner、no-store、bodyless parser 归属）、「响应 202 `{assistantMessageId}`」、「正常重新生成」「已回收会话…」两个 THEN 的 202，以及「运行中与形态不满足」的 body WHEN。
> - 「会话级控制占用」：正文取父文（「同一会话的 prompt、regenerate、fork 请求」补回 prompt）。Scenario「regenerate 各 RPC 间隙的并发请求」取父文：注入项补回 prompt，并由受理前拒绝保证「不新增或修改任何行」；「原 regenerate 照常 202」。regenerate 与 fork 注入已由 #465/#466 交付。
> - Scenario「fork 各 RPC 间隙的并发请求」保持主 spec 原样：「原 fork 照常 201」→ #469（5.2b）。其余 Scenario 与主 spec 逐字相同。

## MODIFIED Requirements

### Requirement: 重新生成 REST
`POST /api/sessions/:id/regenerate` SHALL 受 cookie guard 与 owner 校验（401/404 同 stop），响应 no-store。该路由 SHALL 是无 body 路由且列入 content-parser 归属集：content-parser 错误与任何被解析出的 body SHALL 400 `bad_request`，在认证之后、任何 supervisor 调用之前，无写入。前置校验：会话 `status="running"` 或该会话持有控制占用 SHALL 409 `session_busy`；`status ∈ {done,failed,stopped}` 且末条消息 `role="assistant"` 且其前一条为 `role="user"` 方可执行，否则（含 `idle` 无消息、末条为 user）400 `bad_request`；校验阶段不写任何行。校验通过即登记控制占用（见会话级控制占用），并记下预检读到的末条 assistant id。

执行序：取得该会话进程——若有存活进程则复用；若进程已被回收，SHALL 经与 prompt **相同**的懒 spawn 路径（omp-pool 准入、`--resume <omp_session_file>`、握手、token）取得一个正常 generation：`stream_epoch` 恰 +1 并新建该 generation 的 ring，后续回合事件经该 ring 发布、SSE 语义与普通 prompt 回合一致（准入可能 503 `agent_capacity`，无行变更）→ `request(get_branch_messages)` → 取列表最后一项，其 `text` SHALL 等于 SQLite 中该会话末条 user 消息的 `content`，不等（含列表为空）SHALL 502 `agent_unavailable` 且不改任何行、不发 `branch` → `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务：先以 CAS 复核会话 `status` 仍非 running 且末条 assistant id 仍等于预检读到的 id，复核失败 SHALL 409 `session_busy`、不改任何行并 retire 该进程；复核通过则删除旧 assistant 行（步骤与审批级联删除）、插入新 `running` 空 assistant 行、`omp_session_file`=新文件、会话 `status="running"`、`updated_at=now` → 以 `branch` 返回的 `text` 在同一 generation 上走既有 prompt 派发（不再 bump epoch）。响应 202 `{assistantMessageId}`（新行 id）。`branch` 之后、事务提交之前的任何失败 SHALL retire 该进程且不改动 `omp_session_file` 与消息行，返回 502 `agent_unavailable`。事务提交之后的派发失败 SHALL 把新 assistant 行与会话结算为 `failed` 并返回 502 `agent_unavailable`，不复活已删除的旧 assistant 行。后续回合事件、刷盘与终态 SHALL 与普通 prompt 回合完全一致。

#### Scenario: 正常重新生成
- **WHEN** 会话 `done`、历史为 user(`"second question"`) → assistant(a1)，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}`
- **THEN** 202 `{assistantMessageId:<新 id>}`；fake-omp 依次收到 `get_branch_messages`、`branch{entryId:"fake-entry-2"}`、`get_state`、`prompt{message:"second question"}`；a1 及其步骤行已删除；`omp_session_file` 等于 branch 后 `get_state` 返回的新路径；回合结束后 messages 为 user(`"second question"`) → assistant(新内容, `done`)

#### Scenario: 已回收会话的重新生成取得正常 generation
- **WHEN** 会话 `done` 且其进程已经 `OMP_IDLE_MS` 空闲回收，此时 messages 快照 `streamCursor.epoch=E`，随后调用 regenerate
- **THEN** 202；子进程以 `--resume <omp_session_file>` spawn；`stream_epoch` 恰 +1 一次（`get_branch_messages` 所用获取与随后的 prompt 派发共用这一 generation，不二次递增）；该会话 SSE 收到新 generation 的 `turn.start` … `turn.end(done)`；回合结束后 messages 快照 `streamCursor.epoch=E+1`

#### Scenario: 运行中与形态不满足
- **WHEN** 会话 running 时 regenerate
- **THEN** 409 `session_busy`，无入站帧、无行变更
- **WHEN** 会话 `idle` 无消息、或末条消息为 user
- **THEN** 400 `bad_request`，无入站帧、无行变更
- **WHEN** 已认证 owner 以任何 JSON body（含 `{}`）或 malformed JSON 调用 regenerate
- **THEN** 400 `bad_request`，无 supervisor 调用、无行变更

#### Scenario: 分支文本不一致
- **WHEN** `get_branch_messages` 最后一项 `text` 与 SQLite 末条 user `content` 不相等，或返回空列表
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

### Requirement: 会话级控制占用
supervisor SHALL 按 `sessionId` 维护"控制占用"（control claim）。regenerate、fork（占用的是**源**会话）与 stop 在前置校验通过的同一同步段内登记占用，持有至该操作的 prompt 派发完成（regenerate）或响应返回（fork、stop，以及任何失败路径），并 SHALL 在每一种结束路径（2xx、409、400、502、503、异常）上释放，使失败后会话仍可正常使用。占用 SHALL 按持有次数计数：同一会话可同时有多个持有者（如 regenerate 执行中到达的 stop），每个持有者只释放自己登记的那一次，全部释放后占用才解除；supervisor SHALL 提供同步可读的"该会话是否持有控制占用"判定，供受理前拒绝使用。持有占用期间，同一会话的 prompt、regenerate、fork 请求 SHALL 一律 409 `session_busy`，不写任何行、不向进程发帧、不 spawn。stop 不受占用阻塞、永不因占用返回 409：它按会话 `status` 判定（非 running → 204；running 而 prompt 尚未派发 → 停止意图，见停止生成 REST；regenerate 派发后即为普通 running 回合，可正常停止）。持有占用的会话，其进程与该操作的临时进程在 omp-pool 中视为"回合中"，不可被驱逐。

#### Scenario: regenerate 各 RPC 间隙的并发请求
- **WHEN** 会话 `done`，regenerate 执行中，分别在进程已准入而 `ready` 未到、`get_branch_messages` 应答未到、`branch` 应答未到、branch 之后的 `get_state` 应答未到（事务提交前）时向同一会话注入 prompt、regenerate 或 fork 请求
- **THEN** 每个注入请求均 409 `session_busy`；注入请求未新增或修改任何 `chat_messages`/`chat_steps`/`chat_sessions` 行，未改动 `omp_session_file` 与会话文件，fake-omp 未收到注入请求引起的任何帧；原 regenerate 照常 202 并完成回合

#### Scenario: fork 各 RPC 间隙的并发请求
- **WHEN** fork 执行中，分别在临时进程已准入而 `ready` 未到、`get_branch_messages` 应答未到、`branch` 应答未到、`get_state` 应答未到、临时进程关停未完成（事务提交前）时向**源**会话注入 prompt、regenerate 或 fork
- **THEN** 每个注入请求均 409 `session_busy`，源会话行、`omp_session_file` 与文件不变，无额外 spawn；原 fork 照常兑现

#### Scenario: 失败后释放占用
- **WHEN** regenerate 因分支文本不一致 502、因池满 503，或 fork 因对齐失败 502 结束
- **THEN** 响应返回时占用已释放：随后对该会话的合法 prompt 返回 202

#### Scenario: stop 持有占用且不被占用阻塞
- **WHEN** 会话 A 回合进行中调用 stop；另一次，A 的 regenerate 持有占用（`branch` 应答未到）时对 A 调用 stop
- **THEN** 前者 stop 调用期间 A 持有控制占用、调用返回后占用解除，stop 不因占用被拒；后者 stop 正常返回且不写任何帧，返回后 A 仍持有占用（stop 的释放不抵消 regenerate 的登记），regenerate 照常完成后占用解除
