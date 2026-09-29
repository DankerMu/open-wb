# Design: approval-frame-order（#620）

Change surface:
- fake-omp 审批场景：`openSelects`、`handleSelect` 的 chain 分支、`toolEnd` 之后的发帧、`settleSelects`/`handleAbort` 走到的 aborted 收尾（`server/test/support/fake-omp.mjs`）。
- 测试缺省 argv `OMP_FLAGS`（`server/test/fake-omp-helpers.ts:11-22`）与 yolo→write 空操作替换：
  - `omp-runtime-exit-pending.test.ts:77,94`；
  - `omp-approval-requests.test.ts:3-4,66-68`；
  - `session-supervisor-pool-helpers.ts:70-74` 的 `gateApprovals`。
- 钉住旧次序的测试：
  - `session-approvals-parallel.test.ts` R13（`:206-230`）与其余按帧序断言的审批测试；
  - fake 契约测试 `fake-omp-approval.test.ts`、`fake-omp-approval-chain.test.ts`、`fake-omp-frames.test.ts`。

Must preserve:
- 服务端生产代码零 diff；识别规则（select + `["Approve","Deny"]` + `Allow tool: `）、审批持久化、作答/超时/停止的结算语义、`Deny` 先于 `abort` 的停止次序全部不变。
- select 挂起期间 abort 延后到全部 select 应答后兑现（#495 (a) 已验证）。
- `approval-parallel` 两条 select 各自独立应答、只结束自己的调用；至少一条 Approve → 正常完成；全部拒绝 → 挂起等 abort。
- `approval-chain-abort-ignored`：abort 永不产生帧、进程不自行退出。
- 非 write 模式（yolo 或缺省 argv）下四个审批场景仍等同 `normal`，零 select。
- `normal`、`abort-ok`、`slow-ready`、`thinking`、`edit-write`、`slash` 等非审批场景的出站帧逐字不变。
- probe `frames=` 入站记录格式不变（`…,prompt,extension_ui_response,abort,prompt`）。

Must add/change（fake，仅 `--approval-mode write` 下的四个审批场景）:
- 次序：
  - 单调用：`message_end(toolUse)` → select → `tool_execution_start`；
  - 并行：`message_end(toolUse)` → select(r1) → select(r2) → start(c1) → start(c2)。
  - select 与 start 在同一串行步里发出，start 不等作答；select 发完仍不等应答（保持串行队列可读 stdin）。
- chain：r1 应答后依次发 `tool_execution_end(C1)`、`message_end(toolResult C1)`、select r2、`tool_execution_start(C2)`。
- 每个 `tool_execution_end` 之后紧跟 `message_end{message:{role:"toolResult", toolCallId, toolName, content:<与 end 的 result.content 相同>, isError:<布尔值，拒绝为 true、其余为 false，与实测一致>}}`。
- 审批回合经 abort 收尾（approval-then-abort 的延后 abort 或全拒后到达的 abort；approval-parallel 同理）时，依次发：
  1. `turn_end`
  2. `turn_start`
  3. `message_end{role:"assistant", content:[], stopReason:"aborted", errorMessage:"Interrupted by user"}`
  4. `turn_end`
  5. terminal `agent_end`
  6. 回显 id 的 `response{command:"abort",success:true}`
- `abort-ok`/`slow-ready`/thinking hold 的 `emitAbortedEnd` 不变。

Governing invariant: fake-omp 在 write 模式下发出的审批相关帧序，与真 omp v18.0.10 实测序一致（select 先于 start；Deny→abort 以空 aborted 回合收尾）；服务端测试断言的事件次序是生产上真实会发生的次序。

Sibling surfaces:
- 服务端事件映射（`events.ts` `applyFrame`）：
  - `message_end` 只处理 assistant 的 `error`/`aborted`（`:211-231`），toolResult 被忽略；
  - `turn_start`/`turn_end` 走 default 分支，无事件；
  - 空 aborted 回合只产生恰一个 `turn.end(stopped)`。须由服务端测试证明。
- `approvals.publishRequest`（pump 按帧序处理）：新次序下 `approval.request` 先于该调用的 `step.start`。
- 停止（`TurnStops.#run` Deny 快照）与结算（#474 `settlePendingForMessage`）：只依赖 pending 集合，不依赖 start 是否已到。
- 空闲计时（`markPending`/`clearPending`）、快照 `approvals` 投影、web 审批条：与帧序无关，零 diff。
- change B：thinking-fold（`tool_execution_start` 冲刷 thinking 缓冲，#519）、turn-artifacts（`tool_execution_end` details 取文件变更，#515/#522）只挂在 start/end 帧上，与 select 次序无关；`edit-write` 场景不门控。
- smoke/ui-walk：跑真 omp，不经 fake，不受影响。

Seams under test:
- fake-omp 真实子进程契约（`fake-omp-helpers.ts`）。
- `SessionSupervisor` + 真实 fake-omp + 真实 SQLite + 注入时钟（既有 `session-approval-helpers.ts`、`session-stop-helpers.ts` 世界）。

Required evidence:
- C1 `approval` write：prompt 之后，出站帧序在 `message_end(toolUse)` 之后恰为 `extension_ui_request{select}`、`tool_execution_start(bash)`，其后无帧直到作答。
  - Approve → `tool_execution_end`、`message_end(toolResult)`、正常完成；
  - Deny → `tool_execution_end{isError:true}`、`message_end(toolResult,isError:true)`、正常完成。
- C2 `approval-parallel` write：`message_end(toolUse)` 之后恰为 select r1、select r2、start c1、start c2（两 start 的 `toolCallId` 不同），之后无帧直到作答。
  - 先 Deny r2 再 Approve r1：各自只发自己的 end + toolResult，其后正常完成；
  - 两 select 挂起时到达 abort X，再依次 Deny：各自 end + toolResult，然后恰为 `turn_end`、`turn_start`、空 aborted `message_end`（`errorMessage:"Interrupted by user"`）、`turn_end`、terminal `agent_end`、`response{id:X}`。
- C3 `approval-then-abort` write：select 挂起时 abort，或 Deny 之后再 abort，两种情况都以 C2 所列的空 aborted 回合收尾；probe `frames=` 仍以 `…,prompt,extension_ui_response,abort,prompt` 结尾。
- C4 `approval-chain-abort-ignored` write：r1 Deny 后依次为 end(C1)、toolResult(C1)、select r2、start(C2)；abort 永不产生帧，进程不自行退出；stdin 关闭或收到 SIGTERM 时退出。
- C5 四个场景在显式 `--approval-mode yolo`（以及最后一个 flag 为 yolo）下与 `normal` 逐字节相同、零 select。原「缺省 argv 即 yolo」的用例改为显式传 yolo。
- S1 服务端 R13（改写）：
  - 次序：`approval.request` 先于对应 bash 的 `step.start`；`approval.resolved` 先于该步骤的 `step.end`。
  - 作答时机：测试须等到 `step.start(bash)` 送达后才 `decide`。`approvals.decide` 在 pump 之外发布 resolved，不等会有竞态。
  - 回放：request、step.start、resolved 三者 seq 连续；从 request 的 id 回放，首帧为 step.start；从 step.start 的 id 回放，首帧为 resolved。这是 `session-approvals-parallel.test.ts:258-271` 的替代断言。
  - 并行用例的序列断言同步改写。
- S1b R13 与 R19（`session-approvals-parallel.test.ts:209,292`，R19 即 issue 点名的 `:306` 数组）用 `hold: isToolStart` + `releaseMerged`（`:87-94`，等被扣住的帧里出现 select）构造「pump 尚未处理 select 时已结算」的窗口。新次序下 select 先于 start，会先穿过闸门，旧写法会卡死。
  - 改写：R13 的扣帧触发点可移到 select 帧本身；R19 必须从 text_delta 行开始扣、在 `text.delta` 上 `decide`（从 select 开始扣时，pump 先处理 select 就发布了 request，补发路径走不到）。两者都要保住原意图——审批已由进程层登记，而 pump 尚未处理该 select 时就已结算，此时恰补发一条 `approval.request`、且 resolved 恰一条；
  - 期望数组按新次序重写；
  - 同步更新 `isToolStart`（`session-approval-helpers.ts:374`）的用法或新增谓词，以及文件头注释（`:1-5`）；
  - 报告里逐条写明每个用例保住的意图。
- S2 服务端停止：select 挂起（`tool_execution_start` 已到达）时调用 stop。
  - fake 入站帧 `extension_ui_response{value:"Deny"}` 先于 `abort`；
  - 回合经空 aborted 回合的归约恰一个 `turn.end(stopped)`，无 `error`；
  - 审批 `deny`、bash 步骤 `failed`。
  - 若既有用例（如 `session-stop.test.ts:179` 的审批停止用例）在新 fake 下已构成该证据，实现报告须点名；它目前只经 `pendingApproval` 等待 `approval.request`，须补上等待 `step.start(bash)` 送达后再 stop。否则新增。
- S3 全部既有审批/停止/结算/快照测试在新 fake 下全绿。改了期望的用例只允许三类改动：改帧序或次序；补上新增的 toolResult/turn 帧；S1/S1b 列明的触发点与回放断言替换。不删除断言、不放宽断言，逐条列在报告里。
- 红：C1–C4、S1 在旧 fake 上为红（旧次序或缺帧）。

Non-goals: 见 proposal。

Review focus:
1. fake 的新帧序与 proposal「Why」中的实测逐帧一致（尤其并行时两 select 都先于两 start），且 start 不等作答。
2. toolResult 与空 aborted 回合只出现在四个审批场景，非审批场景出站帧逐字不变。
3. 服务端映射对新增帧不产生额外事件（无多余 `turn.end`、无 `error`），stop 结算结果与旧 fake 下相同。
4. 既有测试的期望改动没有弱化断言；显式 yolo 用例确实仍测「非门控」。
5. `OMP_FLAGS` 与生产 argv（`server/src/sessions/omp/process.ts` spawn 参数）一致。
