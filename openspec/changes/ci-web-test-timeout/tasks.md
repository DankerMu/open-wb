# Tasks: ci-web-test-timeout

> 跟踪 #1554。只改 `.github/workflows/ci.yml` 中 `unit-tests-web` 的 `timeout-minutes`，以及钉住它的 CI contract oracle `scripts/test-ci-harness.sh`（`scripts/inspect-ci-workflow.js` 不读时限，不动）。不改其它 job、测试内容、覆盖率阈值、`constraints.yaml`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Config / project setup | 选中：CI 工作流时限变化，必须由 oracle 精确钉住新值 | 1.1、2.1 |
| Resource limits | 选中：job 时限就是资源上限；`unit-tests-web` 钉 20，fast-checks / anti-drift / unit-tests 仍钉 10 | 1.1、1.2 |
| Legacy compatibility / examples | 选中，指 oracle 既有变异的回归保持（不是旧调用方兼容）：删 job、移出聚合、改成 15、互换 workspace、加 setup-uv、skip/continue 绕过等仍须被拒绝 | 1.2、2.2 |
| Documentation / spec ownership | 选中：未归档 change `omp-browser-integration` 也 MODIFIED 同一条 requirement，须同步其三处旧文本，否则它晚归档时整块覆盖、把规格悄悄退回 10（oracle 只读 ci.yml，抓不到） | 3.1 |
| Public API、File IO、Schema、Auth、Concurrency / shared state、Release | 未选：只改 CI 工作流一个 job 的时限与校验它的 shell oracle，没有接口、文件格式、权限或共享运行时状态；AGENTS.md:133 与 IMPLEMENTATION_PLAN.md:30 只列 job 名，`constraints.yaml:104-105` 只镜像 fast-checks / anti-drift，均无需同步 | — |

## 1. Oracle 先行

- [x] 1.1 修改 CI contract oracle：`scripts/test-ci-harness.sh:118` 的 `check_wf` 里 fast / drift / unit / web 四个 job 共用 `meta = (…("timeout-minutes", "10")…)`，给 web 单独建一个 `"20"` 的 metadata 元组，其余三个仍用 10。先在未改 ci.yml 的工作区运行 `make test-guardrails`：应为红，第一个失败项预期是 `FAIL workflow helper wiring`（`check_wf` 读真实 ci.yml），记录报文。
- [x] 1.2 变异：`:206` 的 `target_mut "target unit-tests-web timeout" unit-tests-web 'timeout-minutes: 10' 'timeout-minutes: 15'` 重锚为 `20 → 15`（否则 ci.yml 改后是 missing anchor，不算拒绝）；新增 `unit-tests-web` 20 → 10 与 `unit-tests` 10 → 20 两条变异，均须被拒绝；`unit-tests` 10 → 15 等既有变异仍被拒绝。

## 2. 实现与证据

- [x] 2.1 `.github/workflows/ci.yml` 中 `unit-tests-web` 的 `timeout-minutes: 10` 改为 20，其它行不动；`make test-guardrails` 绿。
- [x] 2.2 `make check` 0。
- [ ] 2.3 PR CI 中 `unit-tests-web` 成功（合并前由 orchestrator 确认）。

## 3. 规格归属

- [x] 3.1 同步 `openspec/changes/omp-browser-integration/specs/verification-harness/spec.md` 中同一条 requirement 的三处旧文本（:12 时限与「偏离」、:37 预算、:41 变异），与本 change 的 delta 逐字一致（orchestrator 已改，先例 49933b9f）
