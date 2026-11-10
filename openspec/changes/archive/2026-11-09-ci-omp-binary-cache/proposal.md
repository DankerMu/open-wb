# Proposal: ci-omp-binary-cache

> Issue type: enhancement（#1932；owner 2026-11-09 裁定「加缓存」，取代现行规格「不添加 action/cache」）
> Fixture level: expanded（改 CI workflow、CI 契约 oracle、参考镜像 Dockerfile 与四份 spec，跨 smoke / ui-walk / uid-isolation / browser-image 四个门禁 job）
> Upstream suggested level: 无（issue 只给了 p2 / S）
> Blast radius: 写错会让四个 job 在冷缓存或命中时变红而阻塞全部 PR，或让 CI 用上未校验的二进制，或改坏部署方 `docker build -f deploy/app/Dockerfile .` 的默认行为。
> Selected risk packs: Config / project setup；Release / packaging / dependency compatibility；Legacy compatibility；Documentation / migration notes
> Evidence floor: `make test-guardrails` 的 baseline 通过、新增变异逐条被拒；本 PR 的 CI 先冷后热两次运行，热运行时 smoke、ui-walk、uid-isolation 的 `make omp-fetch` 与 browser-image 主构建都打印 `omp-fetch: skip download`，哨兵构建带同一种子并成功，全绿。

## Why

pin 且经过校验的 omp v18.12.3 二进制，在 CI 里每个 job 都从 GitHub release 现拉。2026-11-08 该 asset 连续 504 超过一小时，smoke、ui-walk、uid-isolation、browser-image 四个 job 在所有 PR 上全红，与代码无关；`all-checks-passed` 聚合把全部合并都堵住了。PR #1934 的 API 回退只覆盖下载主机故障，覆盖不了资产本身不可用的情况。现行规格明文写着「不添加 action/cache」，CI 契约 oracle 也会拒绝 `actions/cache`。owner 2026-11-09 裁定加缓存。

## What Changes

- `.github/workflows/ci.yml`：smoke、ui-walk、uid-isolation 三个 job 在 `make omp-fetch` 之前紧邻一步 `actions/cache@v6`（`path: var/omp/omp`，key 由 `runner.os`、`runner.arch` 与 `hashFiles('scripts/omp-fetch.sh')` 组成，不设 `restore-keys`）。browser-image 加同一缓存步骤和 `make omp-fetch`，`docker build` 带上 `--build-context omp-seed=var/omp`。
- `deploy/app/Dockerfile`：新增缺省为空的 `FROM scratch AS omp-seed` 阶段，构建阶段在 `COPY . .` 之后 `COPY --from=omp-seed / var/omp/`。不带额外参数时行为与现在相同。
- `.github/scripts/ci-browser-image.sh`：哨兵构建同样带 `--build-context omp-seed=…`，前提注释同步。
- `scripts/test-ci-harness.sh`、`scripts/inspect-ci-workflow.js` 与 `scripts/fixtures/ci-contract/ci.yml.fixture`：oracle 钉住新步骤与 Dockerfile 种子两行，删掉「拒绝 cache」规则，改为钉死缓存步骤的逐字内容；inspect 把 `actions/cache@v6` 计为第四种允许 action（恰 4 次），并补齐漂移变异。
- 四份 spec 的 delta（verification-harness、chat-harness、omp-uid-isolation、browser-runtime），以及 `docs/architecture/system.md`、`IMPLEMENTATION_PLAN.md` 的同步。
- 不改 `scripts/omp-fetch.sh`、Makefile、pin 的版本、SHA256 与校验逻辑。

design.md 见同目录。
