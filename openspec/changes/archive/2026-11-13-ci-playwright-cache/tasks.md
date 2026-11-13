# Tasks: ci-playwright-cache

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Config / project setup | 是 | 1.2 ci.yml 与 fixture；1.3 oracle |
| Release / packaging / dependency compatibility | 否 | 不新增 action（`actions/cache@v6` 已在白名单），无 npm 依赖变化 |
| Legacy compatibility | 是 | design Must preserve：走查内容、Playwright 版本、`make ui-walk`、omp 二进制缓存不变 |
| Auth / permissions / secrets | 否 | 新步骤不引用 secrets；workflow permissions 不变 |
| Error handling / rollback / partial outputs | 是 | 安装失败时照样撤掉 apt 配置并传出退出码；缓存未命中时走网络；单提交 revert |
| Documentation / migration notes | 是 | 1.4 spec delta |

## 1. ui-walk 的 Playwright 缓存

- [x] 1.1 `ci-playwright-install.sh` 与它的桩测试（design D3；脚本先于测试写成，以对脚本的变异代替先红）：桩测试在 brew bash 5 与系统 bash 3.2 下全过，并对脚本做变异（删撤配置、删清 lock、吞退出码、关 Keep-Downloaded-Packages、去掉 `--with-deps`），每个变异都至少一条 FAIL。
- [x] 1.2 按 D1 改 `.github/workflows/ci.yml` 的 ui-walk，刷新 `ci.yml.fixture`。验证：`diff -u .github/workflows/ci.yml scripts/fixtures/ci-contract/ci.yml.fixture` 退出 0。
- [x] 1.3 按 D4 改 oracle：`check_wf` 的 ui-walk 步骤与 `harness_clean`、`inspect-ci-workflow.js` 的计数、受影响的现有变异重新锚定（不删除），加入新变异。验证：`make test-guardrails` 退出 0，新增变异逐条 PASS（即被拒）。
- [x] 1.4 spec delta 与实现一致，验证：`npx openspec validate ci-playwright-cache --strict --no-interactive` 退出 0。
- [x] 1.5 CI 证据（design Required evidence），PR #1984：冷缓存 run 43368512819 下载 21.1 MB 字体包与浏览器，post 步骤 `Cache saved with key: playwright-Linux-X64-cb9dcd7c…`；热缓存 run 43369727997 `Cache hit`、`Need to get 0 B/21.1 MB of archives`、未下载浏览器、ui-walk `15 passed`；屏蔽 run 43370203452 把 `/etc/apt/apt-mirrors.txt` 的三个软件源都解析到 0.0.0.0，`apt-get update` 只报 `W:`，仍 `Need to get 0 B/21.1 MB`、`15 passed`。探针提交 8eb46294 已由下一提交撤销。

Suggested fixture level: standard：只改一个 job 的一步安装，新增一个脚本。
Minimal mergeable slice: atomic：oracle、fixture 与 ci.yml 必须同一提交，否则 guardrails 会红。
