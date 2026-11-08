# Proposal: ci-omp-fetch-resilience

> Issue type: bugfix（CI 供给单点）
> Fixture level: expanded（CI / production config、Dockerfile 构建路径）
> Upstream suggested level: 无（issue-scribe 建的 issue 未给级别）
> Blast radius: `make omp-fetch` 是 CI smoke / ui-walk / uid-isolation 与参考镜像构建的共同前置；写错即全部 PR 的 CI 变红或装进错误的二进制。
> Selected risk packs: Release / packaging / dependency compatibility；Error handling / rollback / partial outputs；Legacy compatibility（本机 `make omp-fetch` 与跳过分支不变；CI 契约「不添加 action/cache」不变）
> Evidence floor: 新 `scripts/test-omp-fetch.sh` 全过（经 `make test-guardrails`）、`make anti-drift`、CI 上 smoke / ui-walk / uid-isolation / browser-image 在主地址 504 期间经回退变绿。
> Scope：issue #1932 推荐的 `actions/cache` 与现行规格冲突——verification-harness「smoke / ui-walk 跑 `make omp-fetch`（不添加 action/cache）」、「第三方 CI action」白名单只允许 checkout / setup-node / gitleaks，chat-harness 同样写明 "without a new cache action"，`scripts/test-ci-harness.sh` 对三个 job 显式拒绝 `actions/cache`。改这些是 owner 层的 CI 契约决定，本 change 不做，留在 #1932 待裁定（PR 只 Refs，不关闭）。2026-11-08 的实测是主地址 `github.com/.../releases/download/...` 持续 504，而同一资产经 API 资产地址（`Accept: application/octet-stream`）可下载且 SHA256 一致；冷缓存时缓存本来也救不了首拉。所以本 change 只交付回退（issue 边界里的「重试更耐久」一项），不改任何 CI 文件。

## Why

2026-11-08 omp v18.12.3 的 release 下载地址对 `omp-linux-x64` 持续 504 超过一小时，四个 open PR 的 smoke / ui-walk / uid-isolation / browser-image 全红，与代码无关。CI 每个 job 现拉、无缓存，脚本的 curl 重试窗口只有约 60 s。

## What Changes

- `scripts/omp-fetch.sh`：主地址下载失败（curl 非零）时，改从同一 release 资产的 API 地址匿名下载一次；两条路径下载的内容都经同一 SHA256 校验。资产 id 与 SHA256 一样作为仓内固定常量。
- 新 `scripts/test-omp-fetch.sh`：脚本行为用例，由 `scripts/test-guardrails.sh` 调用（`make test-guardrails`、CI `guardrails` job）。
- 不改 `.github/workflows/ci.yml`、CI 契约 harness 与镜像、Makefile、`deploy/app/Dockerfile`。CI 的三个 job 与 browser-image 都调同一脚本，自动获得回退。

design.md 见同目录。
