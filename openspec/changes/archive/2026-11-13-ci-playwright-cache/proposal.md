# Proposal: ci-playwright-cache

> Issue type: bug（#1981；owner 2026-11-12 在三个方案中选定「缓存字体包和浏览器」）
> Fixture level: standard（改 CI workflow 的 ui-walk 一个 job、新增一个 CI 脚本、CI 契约 oracle 与 verification-harness spec）
> Upstream suggested level: 无（issue 给的是 p2）
> Blast radius: 写错会让 ui-walk 在所有 PR 和 master 上变红（装不上浏览器），或让缓存静默不保存、故障时照样失败；不会让 ui-walk 假绿：走查本身与 error oracle 不变。
> Selected risk packs: Config / project setup；Error handling / rollback / partial outputs；Legacy compatibility；Documentation / migration notes
> Evidence floor: `make test-guardrails` 通过且新增变异逐条被拒；安装脚本桩测试在 brew bash 与系统 bash 3.2 下全过；CI 上依次看到冷缓存保存、热缓存命中，以及屏蔽 Ubuntu 软件源后安装仍成功。

## Why

ui-walk 每次运行都执行 `npx playwright install --with-deps chromium`，从 Ubuntu 软件源 apt 下载 9 个字体包（约 21 MB；共享库 runner 镜像已自带）。2026-11-11 runner 解析不了 `azure.archive.ubuntu.com`，apt 重试约 7 分钟后报 `Failed to install browsers`，ui-walk 失败，`all-checks-passed` 随之失败。master 运行 43035807287、PR 运行 43037221149（两次）与 43041543082 都因此变红，持续到次日。

## What Changes

- `.github/workflows/ci.yml` 的 ui-walk：`npx playwright install --with-deps chromium` 换成一步 `actions/cache@v6`（`path: ~/.cache/ms-playwright`，key 随 Playwright 版本，带前缀 `restore-keys`）加 `bash .github/scripts/ci-playwright-install.sh`。
- 新脚本 `.github/scripts/ci-playwright-install.sh`：安装期间让 apt 把 `.deb` 下载并保留在 `~/.cache/ms-playwright/apt-archives/`，随浏览器一起进缓存；命中时 apt 直接用本地 `.deb`，不连软件源。
- CI 契约：`scripts/test-ci-harness.sh` 的 `check_wf`（ui-walk 步骤、`harness_clean` 允许 ui-walk 多一步钉死的 Playwright 缓存）、变异用例与安装脚本桩测试，`scripts/inspect-ci-workflow.js` 的 `actions/cache@v6` 计数 4 → 5，`scripts/fixtures/ci-contract/ci.yml.fixture`。
- verification-harness spec：新增「CI Playwright 浏览器与字体包缓存」，修改「CI 接线与控制面同步」「第三方 CI action 使用 Node 24 runtime」「CI omp 二进制缓存」里的缓存计数。

## Impact

- 缓存命中时 ui-walk 不再依赖 Ubuntu 软件源与 Playwright CDN；未命中（首次、Playwright 升级后旧 key 也被淘汰）时与现在一样走网络。
- 合并后 master 第一次运行是冷的；PR 只能从 master 已保存的缓存恢复，所以 master 第一次成功运行之前，PR 仍依赖软件源。
- 每个 Playwright 版本一份约 200 MB 的缓存（浏览器加 `.deb`），计入仓库 10 GB 配额。
- 走查内容、Playwright 版本、浏览器与 `make ui-walk` 不变。
