## Why

`unit-tests`（`timeout-minutes: 10`）在一个 runner 上串行跑 server vitest、web vitest 与 kbservice pytest。上一批 PR 上它的实际耗时是 6:20、9:41、9:48、超时、9:09、9:57、超时：测试本身全部通过，两次撞时限靠重跑过关。一次超时运行里 `npm ci` 约 8 秒（缓存命中），server 套件约 3.5 分钟，web 套件约 6 分钟；套件还在增长。

## What Changes

- owner 裁决（2026-10-10）：拆成两个并行 job，各自保留 10 分钟时限。`unit-tests` 保留任务名，跑 server 套件与 kbservice pytest；新增 `unit-tests-web` 只跑 web 套件；`all-checks-passed.needs` 加入新 job。
- source-derived CI oracle（`scripts/test-ci-harness.sh`、`scripts/inspect-ci-workflow.js`）认识新 job，并以完整 metadata 与步骤序列钉住两个测试 job。
- verification-harness 规范里的 job 清单、action 使用矩阵与计数从八个 direct job 改为九个，并写入拆分的时限依据。
- 文档里的 job 清单（`AGENTS.md` CI 排障协议、`IMPLEMENTATION_PLAN.md`）同步。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `verification-harness`: 单元测试拆成 `unit-tests` 与 `unit-tests-web` 两个各 10 分钟的并行 job；direct job 九个，checkout/setup-node 使用点 9/7。

## Impact

影响 `.github/workflows/ci.yml`、`scripts/test-ci-harness.sh`、`scripts/inspect-ci-workflow.js`、`AGENTS.md`、`IMPLEMENTATION_PLAN.md` 与 verification-harness 规范。不改测试内容、覆盖率阈值、本地 `make test`、其它 job 的时限、`constraints.yaml`、依赖或 lockfile；不引入测试分片。
