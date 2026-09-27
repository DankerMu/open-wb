# Spec delta: turn-control（#490 停止意图：派发前登记、派发回执后兑现、获取失败丢弃）

> 「停止生成 REST」以当前主 spec（#473 推进）原文为底，只并入本 issue（父 tasks 4.2b）交付的父 delta 部分：
> - 并入：父文「中断 SHALL 分两种：」及其两条列表项（第一条即主 spec 已有的已派发路径句，按父文改为列表项，只去掉句中「时」；第二条为「prompt 尚未派发 → 停止意图」全段），「supervisor SHALL 记录该回合的停止已在途 …」句移到列表之后另起一段（文字不变）；Scenario「派发前停止」「abort 返回 false 走停止意图」。
> - 从并入的父文中剪掉（保留给后续 issue 原位替换）：
>   - 「stop 随即返回 202 `{}`」「stop 在握手完成前返回 202 `{}`」「stop 仍返回 202 `{}`」中的 `202 {}` 响应形状 → 5.1a #475（这里写成「stop 随即返回」「stop 在握手完成前返回」「stop 仍正常返回」）；首段路由/鉴权/parser 归属、204、Scenario「非运行中停止幂等」「body 与鉴权」同样归 #475。
>   - 「仍在等待派发回执的 prompt（或 regenerate）请求」中的「（或 regenerate）」与失败路径括注中的「；regenerate → 其自身规则」→ 4.4 #465；「stop 在其调用期间持有该会话的控制占用（…）」括注 → #465（#473 已移交，见 #465 issue 正文「In Scope 补充（自 #473 移交，2026-09-27）」）。
> - 自写 Scenario（父 delta 没有，归档时父 delta 须逐字采纳）：「获取失败丢弃停止意图」（issue 验收第二条的 `no-ready-hang` 分支）、「准入与前代退役等待期间停止」（#603 评审发现：stop 在进程池准入、等待该会话上一进程退役期间原本为空操作；并锁定获取期间登记的意图在重新准入换进程后仍兑现）。
>
> omp-runtime「相关命令 API 与回合中断」（Scenario「abort right after the dispatch receipt」与回执前/后 `false` 的 owner 语义）与 omp-test-harness「假 omp 入站帧记录」（Scenario「延迟握手期间停止 → 帧序 prompt,abort」）已在主 spec 中逐字就位（#488、#459/#461 推进），本 issue 只在 supervisor 侧用它们，不改这两份 spec。

## MODIFIED Requirements

### Requirement: 停止生成 REST
supervisor 的 stop（对 `status="running"` 的会话）SHALL 先按 tool-approval 规范以 `deny` 结算该会话全部挂起审批（以进入 stop 时读取的快照为准，写 `abort` 前不重读）（每条结算落库与审计同一事务 → 发 `Deny` → 发布 `approval.resolved`），再处理中断；不等待 `agent_end`。中断 SHALL 分两种：
- prompt 已派发（runtime 存在活跃回合）：对该会话进程调用 `abort()` 写出 `{type:"abort"}`，写入成功后 stop 返回。
- prompt 尚未派发（runtime 仍在获取/握手，`abort()` 返回 `false`，即尚无已派发的回合）：supervisor SHALL 为该回合登记"停止意图"，此刻不写任何帧，stop 随即返回；该次派发 SHALL 照常进行——握手完成后 `prompt` 帧照常写出，用户消息照常进入 omp 会话历史，仍在等待派发回执的 prompt 请求 SHALL 以 202 返回其原本的受理 body。supervisor 本就等待的该 `prompt` 派发回执兑现后，SHALL 立即对同一 generation 再次调用 `abort()` 写出 `{type:"abort"}`；此后与上一条完全相同：回合经归约器的普通中断路径（`message_end{stopReason:"aborted"}` → `agent_end` → 恰一个 `turn.end{messageId,status:"stopped"}`）收尾，`agent_end` 未在 `OMP_ABORT_GRACE_MS` 内到达则走有界退回（见中断帧归约与有界退回）。停止意图路径本身 SHALL 不调用 `applyStop`、不直接 `finishTurn(stopped)`：一个回合的 `turn.end` 恰由一条路径发出。被停止的 assistant 正文为 abort 生效前已到达的 text.delta（可能为空）。停止意图登记期间 runtime 获取或派发失败（派发回执拒绝）时，SHALL 走该请求在无停止意图时完全相同的失败路径（prompt → 既有受理对补偿与既有错误响应），停止意图随之丢弃、不写 `abort`。若该回合已先被其它路径终态结算（如崩溃 `failed`），停止意图 SHALL 不改写其终态。

supervisor SHALL 记录该回合的停止已在途：同一回合再次 stop SHALL 不写第二帧 `abort`、不重复结算审批。

#### Scenario: 运行中停止
- **WHEN** 回合进行中调用 stop，fake-omp 以 `abort-ok` 脚本应答
- **THEN** fake-omp stdin 收到恰一帧 `{type:"abort"}`；随后浏览器事件序列以 `turn.end{messageId,status:"stopped"}` 结束且不含 `error`；`GET /api/sessions` 中该会话 `status="stopped"`

#### Scenario: 同一回合二次停止
- **WHEN** fake-omp 以 `abort-ignored` 脚本运行，回合中调用 stop，在 `abort` 已发出而 `agent_end` 未到、有界退回尚未触发时再次调用 stop
- **THEN** 两次 stop 均正常返回；fake-omp stdin 记录恰一帧 `abort`；无第二次审批结算；最终恰一个 `turn.end(stopped)`

#### Scenario: 派发前停止
- **WHEN** fake-omp 以 `slow-ready` 脚本运行（`--ready-delay-ms` 使获取/握手窗口可观察），会话发出 prompt（REST 仍在等待派发回执、会话已为 running）时调用 stop，随后握手完成；该回合结束后对同一会话发一个 probe prompt
- **THEN** stop 在握手完成前返回；该 prompt 请求返回 202 `{userMessageId,assistantMessageId}`；该回合的 assistant 与会话为 `stopped`，SSE 该回合恰一个 `turn.end(stopped)`、无 `error`、无 `turn.end(failed)`；probe prompt 在同一进程上 202 且正常完成，其报告的 `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`（`abort` 紧随被停止回合的 `prompt`，末个 `prompt` 为 probe）

#### Scenario: abort 返回 false 走停止意图
- **WHEN** supervisor 对 running 会话调用 runtime `abort()` 而它因 prompt 尚未派发返回 `false`
- **THEN** 此刻不写 `abort` 帧，stop 仍正常返回；该回合派发回执兑现后 supervisor 对同一 generation 再次调用 `abort()`，入站帧序为该回合的 `prompt` 后恰一帧 `abort`；回合经 `message_end aborted` → `agent_end` 以恰一个 `turn.end(stopped)` 收尾（不经 `applyStop` 合成）；不产生 `error` 或 `turn.end(failed)`

#### Scenario: 获取失败丢弃停止意图
- **WHEN** fake-omp 以 `no-ready-hang` 脚本运行，会话发出 prompt 后、握手超时之前调用 stop，随后握手超时、该进程经既有获取失败路径关停；另一会话以同一脚本发出 prompt 但不调用 stop，作为对照
- **THEN** 两个 prompt 以同一既有错误结束（响应状态码、错误信封、受理对补偿后的消息与会话状态均与对照相同）；两个子进程收到的入站帧相同，且都不含 `abort`；两个会话都没有 `turn.end` 或 `error` 事件

#### Scenario: 准入与前代退役等待期间停止
- **WHEN** 会话的 prompt 已受理但尚未取得可派发的进程时调用 stop：该 prompt 仍在进程池准入中，或在等待该会话上一进程退役完成；或 stop 在该 prompt 的获取/握手期间登记了停止意图，随后该 prompt 因上一进程已退出而改在新进程上重新准入
- **THEN** stop 正常返回，此刻不写任何帧；该 prompt 在其最终取得的进程上照常派发，派发回执兑现后该进程恰收到一帧 `abort`，回合以恰一个 `turn.end(stopped)` 收尾，不产生 `error`；已退役的上一进程没有收到 `abort`
