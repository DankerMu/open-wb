# Proposal: approval-frame-order（#620）

## Why
epic #448 收尾核查分流出的 #620。fake-omp 是服务端审批链路唯一的确定性测试载体，但它的审批帧次序与生产用的真 omp v18.0.10 相反：
- fake 在 `openSelects` 里先发 `tool_execution_start` 再发审批 select（`server/test/support/fake-omp.mjs` `openSelects`、chain 分支）；
- 主 spec 也写的是这个反序：`omp-test-harness`「假 omp 进程契约」的 approval 场景句与 Scenario、`tool-approval`「审批请求识别」Scenario 与「审批事件」的次序句、Scenario「事件序与回放」；
- `server/test/session-approvals-parallel.test.ts` R13 把 `step.start` 先于 `approval.request` 钉成了断言。

编排者 2026-09-29 用真 omp v18.0.10 实测（编译产物服务端 + `OMP_BIN` tee 包装 + scratch 上游，单 bash 与双 bash 回合，含 Deny→abort；原始帧只留在本地）：
- 单 bash：`message_end(toolUse)` → select → `tool_execution_start`，start 不等作答（与 #481 E0-2 的 13/13 一致）。
- 双 bash（approval-parallel 此前未实测）：`message_end(toolUse)` → select(c1) → select(c2) → start(c1) → start(c2)，两个 select 都在任一 start 之前，且都不等作答。
- Deny 后紧接 abort：`tool_execution_end{isError:true, "Tool call denied by user: bash"}` → `message_end(toolResult,isError)` → `turn_end` → `turn_start` → `message_end(assistant, content:[], stopReason:"aborted", errorMessage:"Interrupted by user")` → `turn_end` → `agent_end` → `response(abort)`。双 bash 时两个 tool end 各自后接其 toolResult。

本刀让 fake 与主 spec 对齐实测次序，补上 #495 评论指出的 Deny→abort 空 aborted 回合，并清理 #448 收尾核查列出的 `yolo` 残留。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: absent（expanded 触发：fake-omp 协议契约是全部服务端测试的真实边界；AGENTS.md Critical Path「omp 子进程治理」的审批链路；多个 spec 同改）
Blast radius: 次序改错 → 服务端审批/停止测试钉住的次序与生产不一致，真实路径失去覆盖；OMP_FLAGS 改 write 后漏掉显式 yolo → 若干「非门控基线」测试悄悄变成门控运行而误绿或误红；Deny→abort 新帧若被服务端误映射 → stop 结算错误
Selected risk packs: Legacy compatibility / examples；Concurrency / shared state / ordering；Public API / CLI / script entry；Documentation / migration notes
Evidence floor: fake 契约用例（真实子进程）断言新帧序；服务端审批/停止测试在新次序下全绿，R13 改为 `approval.request` 先于 `step.start`；至少一条服务端用例在 select 挂起时 stop，断言 `Deny` 先于 `abort`、回合 `stopped`；`make check`

## What Changes
- `server/test/support/fake-omp.mjs`：
  - `approval`、`approval-parallel`、`approval-then-abort`、`approval-chain-abort-ignored` 在 write 模式下改为先发全部 select，再发全部 `tool_execution_start`；
  - 这四个场景的每个 `tool_execution_end` 之后紧跟该调用的 `message_end{role:"toolResult"}`；
  - 审批回合经 abort 收尾时，改发实测的空 aborted 回合（见 Why）。
- 测试：
  - fake 契约测试与服务端测试按新次序修正期望；
  - `fake-omp-helpers.ts` 的 `OMP_FLAGS` 改为 `write`，依赖「缺省即 yolo」的基线用例改为显式传 `--approval-mode yolo`；
  - 删除已成空操作的 yolo→write 替换。
- spec：MODIFIED `omp-test-harness`「假 omp 进程契约」、`tool-approval`「审批请求识别」「审批事件」。

## Capabilities
- MODIFIED omp-test-harness「假 omp 进程契约」：四个审批场景的帧次序、toolResult 与审批回合的 aborted 收尾。
- MODIFIED tool-approval「审批请求识别」：Scenario 的 WHEN 次序。
- MODIFIED tool-approval「审批事件」：`approval.request` 位于对应 `step.start` 之前；Scenario「事件序与回放」次序约束。

## Impact
- 生产代码零 diff（`server/src/**`）。如果服务端测试在新次序下暴露真 bug，停下上报，另开 issue，不在本刀修。
- 父 change `s1c-turn-control-governance`（design D5 事件次序句、D7 fake 描述、tasks 6.3/6.6 措辞，以及 omp-test-harness / tool-approval delta 块）与 change B `s1c-session-metadata-presentation`（omp-test-harness delta 块）中的同名文字，在本 change 的归档 PR 里同步，避免这两个 change 归档时把旧次序写回主 spec。

## Non-goals
- fake 的 yolo 分支本身：保留「非 write 即 normal」的 fake 契约，只把测试缺省改成与生产一致的 `write`。
- `abort-ok`/`slow-ready` 的非审批 aborted 收尾：没有 Deny 路径的实测数据，保持现状。
- 审批通过后的正常续轮不补 `turn_end`/`turn_start`/`message_start`：服务端不消费这些帧，而且没有对应的实测断言需求。
- select 挂起时 abort 延后的规则：#495 (a) 已验证正确，不动。
