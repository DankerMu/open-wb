# Tasks: ci-omp-fetch-resilience

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Config / project setup | 否 | 不改 CI 文件与 Makefile（缓存与现行 CI 契约冲突，见 proposal） |
| Release / packaging / dependency compatibility | 是 | 1.2 固定资产 id，同一 SHA256 校验 |
| Error handling / rollback / partial outputs | 是 | 1.1 两条都失败、摘要不符时不留文件 |
| Auth / permissions / secrets | 是 | 1.1 两条请求都不带凭证（argv 不含 `Authorization`） |
| Legacy compatibility | 是 | 1.1 主地址成功与跳过分支不变；1.3 CI 契约 harness 原样全绿 |
| File IO / path safety | 否 | 目标路径与临时文件写法不变 |
| Public API / CLI | 否 | `make omp-fetch` 接口不变 |
| Documentation / migration notes | 是 | 1.4 omp-runtime spec delta |

## 1. 下载回退

- [x] 1.1 测试先行：新 `scripts/test-omp-fetch.sh`（design D4 的 seam），覆盖 design「Required evidence」的脚本场景；`scripts/test-guardrails.sh` 加一行调用它并计入 pass/fail。先在未改的脚本上看到回退相关用例红。
- [x] 1.2 实现 `scripts/omp-fetch.sh` 的回退（design D1、D2）：固定资产 id 常量，主地址 curl 包进 `if !`，失败后删临时文件、改走 API 资产地址一次，同一校验，不带凭证，不加任何环境旁路。验证：1.1 全绿；本机已有 `var/omp/omp` 时 `make omp-fetch` 仍打印 `omp-fetch: skip download`。
- [x] 1.3 CI 文件零改动：`git diff --stat origin/master -- .github scripts/test-ci-harness.sh scripts/inspect-ci-workflow.js scripts/fixtures Makefile deploy` 为空。验证：`make test-guardrails`、`make anti-drift` 退出 0。
- [x] 1.4 spec delta 与实现一致。验证：`openspec validate ci-omp-fetch-resilience --strict --no-interactive` 退出 0。
