# Proposal: ci-unit-test-sharding

> Issue type: enhancement（#1959；owner 2026-11-10 批准「完整分片，走正规流程」与新增 `actions/upload-artifact@v7`、`actions/download-artifact@v8`，取代 #1554 时「仍不分片」的裁定）
> Fixture level: expanded（改 CI workflow 的两个测试 job、新增合并 job 与顶层 concurrency、CI 契约 oracle、两个 workspace 的 test 脚本、第三方 action 白名单与 verification-harness spec）
> Upstream suggested level: 无（issue 给的是 p2 / M）
> Blast radius: 写错会让单元测试门禁假绿（缺片、分片内阈值被关后泄漏到合并步骤、合并时没卡阈值），或让 `all-checks-passed` 在所有 PR 上变红，或让 master 的运行被取消而缺少完整结果。
> Selected risk packs: Config / project setup；Release / packaging / dependency compatibility；Error handling / rollback / partial outputs；Legacy compatibility；Documentation / migration notes
> Evidence floor: `make test-guardrails` 的 baseline 通过、新增变异逐条被拒；`make check` 绿；本机对两个 workspace 各跑一次「分片 → 合并」，合并后的测试文件数、测试数与覆盖率四项和同机全量 `npm test --workspace <ws>` 一致；只合并部分分片时合并脚本非零；本 PR 至少两次热缓存 CI 运行全绿，记录墙钟与各分片耗时。

## Why

最近 50 次 `ci.yml` 运行（46 次成功，截至 2026-11-10）墙钟中位数 11.8 min、p90 12.3 min。关键路径 46 次中 42 次是 `unit-tests-web`（中位 11.4 min），4 次是 `unit-tests`（7.7 min）；其余 job 都不超过 4.9 min，setup 中位约 18 s，job 间没有串行 `needs`。单元测试两条线各自只能在一个 4 vCPU runner 上跑（vitest 默认 3 个 worker），这就是全部 PR 的等待时间。

按 vitest 4.1.11 的真实分片算法（文件路径 sha1 排序后等数切片）加实测逐文件耗时模拟，单片结果与实测相差不超过 2%：web 分 4 片时最长一片约 210 s，server 分 3 片时约 157 s。墙钟下限是 `uid-isolation`（4.9 min），被 `omp-official-upstream-failure.test.ts` 的真实退避等待钉住，单个文件不可拆。

工作流没有 `concurrency`，同一 PR 连推几次时旧运行照跑到底。

## What Changes

- `.github/workflows/ci.yml`：
  - 顶层加 `concurrency`：同一 ref 的新运行取消旧运行；`cancel-in-progress` 只在非 `refs/heads/master` 时为真，master 的每次 push 都跑完。
  - `unit-tests` 改为 3 片 matrix、`unit-tests-web` 改为 4 片 matrix（job 名、runs-on、timeout 不变，`fail-fast: false`）；每片执行 `npm run test:shard --workspace <ws> -- --shard=<i>/<N>`，再以 `actions/upload-artifact@v7` 上传 vitest blob（`if-no-files-found: error`）。
  - 新 job `unit-coverage`（`needs: [unit-tests, unit-tests-web]`）：以 `actions/download-artifact@v8` 取回两个 workspace 的全部 blob，再各执行一次 `bash .github/scripts/ci-unit-merge.sh <ws>`。`all-checks-passed.needs` 加入 `unit-coverage`。
- `server/package.json`、`web/package.json`：新增 `test:shard`（覆盖率开、阈值清零、`--reporter=default --reporter=blob`）与 `test:merge`（`vitest --merge-reports --coverage`，阈值取 `vitest.shared.mjs`）。`test` 与 `test:focus` 不变。
- 新脚本 `.github/scripts/ci-unit-merge.sh`：确认 `<ws>/.vitest-reports/` 里恰为同一 N 的 `blob-1-N.json … blob-N-N.json`，无缺无多，再运行 `npm run test:merge --workspace <ws>`。
- `.gitignore` 加 `.vitest-reports/`。
- CI 契约：`scripts/test-ci-harness.sh` 的 oracle 与变异用例、`scripts/inspect-ci-workflow.js` 的 `ALLOWED`/`WANT`、`scripts/fixtures/ci-contract/ci.yml.fixture`；verification-harness spec delta；`AGENTS.md` 的 CI 排障协议加入 `unit-coverage` 层。

## Impact

- 预期 PR CI 墙钟中位数 11.8 min → 约 5–6 min，关键路径变为 `uid-isolation`。
- runner 分钟数增加：多 5 个分片 job 和 1 个合并 job，每个约 20–30 s 的 setup（公开仓库不计费，仍在 PR 中报告）。
- 本地 `make test` / `npm test --workspace <ws>` 与覆盖率阈值不变。
- 给 PR 加 label 也会触发新运行并取消在跑的那次；PR 说明里写明，免得把这种取消误当成失败。
