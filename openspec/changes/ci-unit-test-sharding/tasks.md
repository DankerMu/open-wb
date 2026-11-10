# Tasks: ci-unit-test-sharding

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Config / project setup | 是 | 1.3 ci.yml 与 fixture；1.2 oracle |
| Release / packaging / dependency compatibility | 是 | 新增第三方 action `actions/upload-artifact@v7`、`actions/download-artifact@v8`（Node 24，owner 批准）；无 npm 依赖变化 |
| Legacy compatibility | 是 | design Must preserve：本地 `make test`、阈值、其余十个 job 不变 |
| Auth / permissions / secrets | 否 | 新步骤不引用 secrets；workflow permissions 不变 |
| Error handling / rollback / partial outputs | 是 | 缺片 / 多片 / 杂项在合并前拒绝；`if-no-files-found: error`；`fail-fast: false`；单提交 revert |
| Documentation / migration notes | 是 | 1.4 spec delta、AGENTS.md CI 排障协议、IMPLEMENTATION_PLAN.md |

## 1. 单元测试分片、合并门禁与并发取消

- [x] 1.1 先写合并脚本用例（design D6「合并脚本用例」），脚本不存在时跑该段，应当看到 22 条 FAIL；再按 D4 写 `.github/scripts/ci-unit-merge.sh`，该段全绿（brew bash 5 与系统 bash 3.2 各跑一次）。
- [x] 1.2 按 D6 改 oracle：`check_wf` 与 `contract()` 两个内嵌 Python、`ccopy`、`scripts/inspect-ci-workflow.js`、现有锚点与诱饵，并加入新增变异。先红：旧 ci.yml 被 `check_wf` 拒绝，`inspect-ci-workflow.js` 报 `protected cardinality`。
- [x] 1.3 按 D1、D2、D5 改 `.github/workflows/ci.yml`，按 D3 加两个 workspace 的 `test:shard` / `test:merge`，`.gitignore` 加 `.vitest-reports/`；刷新 `ci.yml.fixture`。验证：`diff -u .github/workflows/ci.yml scripts/fixtures/ci-contract/ci.yml.fixture` 退出 0；`make test-guardrails` 退出 0，新增变异逐条 PASS（即被拒）。
- [x] 1.4 本机等价性：两个 workspace 各跑一次「逐片 `test:shard` → `ci-unit-merge.sh`」与同机全量，测试文件数、测试数一致，覆盖率相差不超过 0.1 个百分点；只放部分 blob 时合并脚本退出 1、不调用 npm（design Required evidence）。
- [x] 1.5 文档同步（D7）。spec delta 与实现一致，验证：`npx openspec validate ci-unit-test-sharding --strict --no-interactive` 退出 0。
- [ ] 1.6 `make check` 退出 0；CI 至少两次热缓存运行全绿，记录墙钟、关键路径、各分片与合并 job 耗时，与 design D2 的模拟对照（由编排方取得）。

Suggested fixture level: expanded：改的是两个门禁 job 与聚合依赖，新增一个门禁 job。
Minimal mergeable slice: atomic：oracle、fixture、ci.yml 与 package 脚本必须在同一提交里一起改，否则 guardrails 会红。
