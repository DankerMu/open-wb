# Tasks: omp-fetch-signal-abort

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Error handling / rollback / partial outputs | 是 | 1.1 信号中断后非零、不回退、不留文件 |
| Legacy compatibility | 是 | 1.1 既有八条原样全绿；1.3 CI 文件零改动 |
| Config / project setup | 否 | 不改 CI 文件与 Makefile |
| Release / packaging / dependency compatibility | 否 | 版本、资产、SHA256 不变 |
| Auth / permissions / secrets | 否 | 请求参数不变（既有「不带凭证」用例照旧） |
| Documentation / migration notes | 是 | 1.4 omp-runtime spec delta |

## 1. 信号中断不回退

- [x] 1.1 测试先行：在 `scripts/test-omp-fetch.sh` 里按 design「Seams under test」新增三条用例：假 curl 返回 130、返回 143、真实 INT 送达进程组、真实 TERM 送达进程组，以及 curl 吞掉信号时 INT、HUP 送达进程组（design Required evidence）。先在未改的脚本上跑，看到新用例红。验证：`bash scripts/test-omp-fetch.sh` 的输出中，新用例为 FAIL、既有用例为 PASS。
- [x] 1.2 实现 `scripts/omp-fetch.sh` 的 D1（拆 trap）和 D2（只有 `rc < 128` 才回退，`rc >= 128` 以原退出码退出）。验证：`bash scripts/test-omp-fetch.sh` 全部 PASS；本机已有 `var/omp/omp` 时 `make omp-fetch` 仍打印 `omp-fetch: skip download`。
- [x] 1.3 CI 文件零改动。验证：`git diff --stat origin/master -- .github scripts/test-ci-harness.sh scripts/inspect-ci-workflow.js scripts/fixtures Makefile deploy` 为空；`make test-guardrails`、`make anti-drift`、`make lint` 退出 0。
- [x] 1.4 spec delta 与实现一致。验证：`npx openspec validate omp-fetch-signal-abort --strict --no-interactive` 退出 0。

Suggested fixture level: expanded - 同一脚本是 CI 与镜像构建的共同前置。
Minimal mergeable slice: atomic - 一个脚本加它的用例。
