# Tasks: ci-omp-binary-cache

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Config / project setup | 是 | 1.2 ci.yml 与 fixture；1.1 oracle |
| Release / packaging / dependency compatibility | 是 | 1.3 Dockerfile 种子阶段；新增第三方 action `actions/cache@v6`（Node 24） |
| Legacy compatibility | 是 | design Must preserve：默认构建路径、omp-fetch.sh、其余 job 不变 |
| Auth / permissions / secrets | 否 | 缓存步骤不引用 secrets；workflow permissions 不变 |
| Error handling / rollback / partial outputs | 是 | 缓存内容不受信任，经 SHA256 校验；不设 restore-keys；只在 job 成功后保存 |
| Documentation / migration notes | 是 | 1.4 spec delta、system.md、IMPLEMENTATION_PLAN.md |

## 1. CI omp 二进制缓存

- [x] 1.1 先改 oracle：按 design D4 改 `scripts/test-ci-harness.sh` 和 `scripts/inspect-ci-workflow.js`，并刷新 `scripts/fixtures/ci-contract/ci.yml.fixture`。不动 ci.yml、Dockerfile、`ci-browser-image.sh`，跑 `make test-guardrails`，应当看到 design Required evidence「先红」里列出的那些 FAIL；记下失败行。
- [x] 1.2 按 design D1、D2 改 `.github/workflows/ci.yml`，使 fixture 与它逐字一致。验证：`diff -u .github/workflows/ci.yml scripts/fixtures/ci-contract/ci.yml.fixture` 退出 0；`make test-guardrails` 退出 0，新增变异逐条 PASS（即被拒）。
- [x] 1.3 按 design D3 改 `deploy/app/Dockerfile`，并改 `.github/scripts/ci-browser-image.sh` 的哨兵构建行与第 4 行的前提注释。验证：`git diff --exit-code origin/master -- scripts/omp-fetch.sh Makefile constraints.yaml AGENTS.md deploy/app/Dockerfile.dockerignore` 退出 0。
- [x] 1.4 文档同步（design D5）。spec delta 与实现一致，验证：`npx openspec validate ci-omp-binary-cache --strict --no-interactive` 退出 0。
- [ ] 1.5 `make check` 退出 0。CI 先冷后热两次运行的证据由编排方取得（design Required evidence）。

Suggested fixture level: expanded —— 改的是四个门禁 job 与参考镜像。
Minimal mergeable slice: atomic —— oracle、fixture 与 ci.yml 必须在同一提交里一起改，否则 guardrails 会红。
