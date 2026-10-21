## ADDED Requirements

### Requirement: 进程上限断言在准入时刻采样
断言「并发 omp 进程数不超过上限」的测试 SHALL 以准入或 spawn 那一刻同步取得的样本作为证据（如 `session-supervisor-pool-helpers.ts` 的 `sampleSpawns` / `expectWithinCap`）；当被测场景里的名额在拒绝之后、采样之前可能变化时（fork 临时进程做完即退出并释放名额，`branch-temp.ts:114-118`；regenerate 进程回合结束后仍存活但变为可驱逐，会在下一次准入时被 `retire()` 驱逐），测试 SHALL NOT 在拒绝传回测试之后的回调里读取当前进程数并要求它等于上限——拒绝与采样之间名额可能已被释放。只含准入后既不退出也不可驱逐的进程（如全部 `hang-prompt`）的用例可以事后采样（#1580）。

#### Scenario: 混有短命进程的上限用例只靠 spawn 时样本判定
- **WHEN** 上限为 2，两路 prompt（`hang-prompt`）、一个 regenerate 与一个 fork 并发，其中 fork 临时进程做完即退出、regenerate 进程回合结束后可被驱逐
- **THEN** 用例断言每个结果只是成功或 `agent_capacity` 拒绝、每次 spawn 时的存活进程数都不超过 2，不读取拒绝送达后的进程数
- **AND** 把运行时上限临时改为 3 时（变异），某次 spawn 时已有 2 个存活子进程（样本只计新 spawn 之前已存活的），`expectWithinCap(…, 2)` 失败，而在它之前的被拒原因断言仍通过
