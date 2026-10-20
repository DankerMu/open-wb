# Proposal: ci-web-test-timeout

## Why

#1554：`unit-tests-web` 的 `timeout-minutes: 10` 在慢 runner 上只剩约 30 秒余量。
- 近 60 次 `ci` run 里，`npm test --workspace web` 步骤耗时：快 runner 303–430 秒，慢 runner 517–572 秒。
- 同一套件的 vitest 累计 tests 时间分别为 660 秒与 1199 秒，相差约 1.8 倍，差异来自 runner 硬件，而非个别用例。最慢的单个文件约 30 秒，分布平坦。
- PR #1550 的 run 39281201550 中，测试 3878/3878 通过，步骤用时 9m23s，但 job 在 10m09s 被取消，`all-checks-passed` 因此失败，靠重跑才过。

## What Changes

- owner 2026-10-19 裁决：只把 `unit-tests-web` 的 `timeout-minutes` 调到 20。`unit-tests` 保持 10，仍不分片。单条用例的挂起由 vitest 默认 `testTimeout`（5 秒，`vitest.shared.mjs` 未改）兜住；worker teardown 或句柄泄漏一类的挂起仍由 20 分钟的 job 上限兜住。
- verification-harness「CI 接线与控制面同步」相应修改：两个测试 job 各用各的 exact 时限，并写明依据；oracle 拒绝的变异补上「`unit-tests-web` 改回 10」与「`unit-tests` 改成 20」。
- source-derived CI oracle（`scripts/test-ci-harness.sh`）对 `unit-tests-web` 改钉 20，`unit-tests` 仍钉 10；`scripts/inspect-ci-workflow.js` 不读时限，不动。
- 同步未归档 change `omp-browser-integration` 对同一条 requirement 的 MODIFIED 副本（三处），避免它晚归档时把规格退回 10。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `verification-harness`：`unit-tests-web` 的预算由 10 分钟改为 20 分钟。

## Impact

影响 `.github/workflows/ci.yml`（一行）、`scripts/test-ci-harness.sh`、verification-harness 规格，以及 `openspec/changes/omp-browser-integration/specs/verification-harness/spec.md` 的三处文本。归档顺序：本 change 合入后即归档；`omp-browser-integration` 的第 6 组任务尚未完成，必然更晚归档，届时它的 MODIFIED 块已含本次修改。不改测试内容、覆盖率阈值、本地 `make test`、其它 job 的时限、`constraints.yaml`、依赖或 lockfile；不引入分片。只有一项决策，不需要 `design.md`。

## Triage

```text
Issue type: bugfix (CI budget)
Fixture level: compact
Upstream suggested level: absent (issue: S)
Blast radius: CI 工作流一个 job 的时限，以及钉住它的 source-derived oracle
Selected risk packs: Config / project setup; Resource limits; Legacy compatibility / examples (oracle regression); Documentation / spec ownership
Evidence floor: make test-guardrails 接受新配置，并拒绝 unit-tests-web≠20、unit-tests≠10 及既有变异；make check 绿；PR CI 中 unit-tests-web 成功
```
