## Context

master run 34201572662（push，SHA `bd07011016903c79578695c76315d6bb39a24051`）8/8 成功，但七个 direct jobs 都有 `Node.js 20 is deprecated` annotation：checkout 覆盖 fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk；setup-node 覆盖除 secret-scan/sast 外的五个 job；setup-uv 覆盖 fast-checks/unit-tests；gitleaks-action 覆盖 secret-scan。当前 major 的 `action.yml` 均声明 node20，GitHub runner 将其强制运行在 Node 24。Issue 创建时只有五个 direct jobs；smoke/ui-walk 后来加入，当前 source identity 为准，必须同批覆盖。

Fixture level: high
Repair intensity: high
Project profile: Generic（TypeScript Web 服务 + Python 知识库，多子系统）
Minimal mergeable slice: `.github/workflows/ci.yml` 的四种 action major 与 `scripts/test-ci-harness.sh` 对应 exact identities/mutations 原子同步，并以一条新 PR CI 验收七个 direct jobs、aggregate 与 annotations。

## Goals / Non-Goals

**Goals:**
- 每个 direct action 使用点解析到 metadata `runs.using: node24` 的最小兼容 major，彻底去除 Node 20 fallback 依赖与 annotation。
- 保持 checkout、setup-node npm cache、setup-uv install/cache、gitleaks full-history/token 语义及所有 job 下游行为。
- 让 source-derived oracle 拒绝旧/混合 major、遗漏使用点、关键 input 漂移、重复/旁路 action 和 Node 20 fallback env。
- 用 GitHub-hosted PR CI 的 job steps、outputs/cache logs、annotations 和 aggregate 证明兼容。

**Non-Goals:**
- 不修改 `.tool-versions`、应用 Node/Python/uv 版本、依赖/lockfile或产品代码。
- 不使用 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`、fork、SHA pin 策略迁移或自行编译 action。
- 不调整 workflow permissions、secret 值、job timeout、quality steps、coverage/guard thresholds 或 aggregate fail-closed 语义。
- 不把 action major 升到高于消除 Node 20 所需的最新 major；checkout v6/v7、setup-node v6/v7、setup-uv v8/v9 不在本变更。

## Decisions

1. 使用 `actions/checkout@v5`。v5.0.0 唯一 breaking point 是 action runtime 升至 Node 24，要求 runner ≥2.327.1；当前为 GitHub-hosted `ubuntu-latest`。v4/v5 均保留本仓使用的 `fetch-depth`，默认 checkout/credential/clean/safe-directory inputs 不变。v5 moving tag 当前解析 commit `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`，`action.yml` uses node24。
2. 使用 `actions/setup-node@v5`。v5 保留 `node-version-file`、`cache` 与 `cache-dependency-path`；新增 automatic package-manager cache，但本仓显式 `cache: npm`，继续缓存 package-manager data 而非 `node_modules`。根 package 没有 `packageManager` 字段，所以新增自动检测也不产生第二条隐式策略。v5 要求 hosted runner 满足 ≥2.327.1；moving tag 当前 commit `a0853c24544627f65ddf259abe73b1d18a591444`，uses node24。
3. 使用 `astral-sh/setup-uv@v7`。v6 曾移除本仓未使用的 `pyproject-file`/`uv-file`、改变未使用的 `python-version` activation 与扩大 default cache dependency glob；本仓不给任何 inputs，只需要安装 uv 并沿用 hosted-runner `enable-cache:auto`。v7 移除本仓未用的 `server-url` 并切到 node24，hosted runner 兼容；其扩大后的 default cache glob仍包含 `kbservice/pyproject.toml` 和 `kbservice/uv.lock`。moving v7 当前解析 annotated tag commit `37802adc94f370d6bfd71619e3f0bf239e1f3b78`，uses node24。
4. 使用 `gitleaks/gitleaks-action@v3`。上游 v3.0.0 明确只有 runtime node20→node24，无 inputs/outputs/behavior 变化；本仓继续由 `checkout@v5` 的 `fetch-depth: 0` 提供完整历史，并保留 exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`。仓库属于个人账号，不需要 organization-only `GITLEAKS_LICENSE`。moving tag当前 commit `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`。
5. 保持 major moving refs，而非改成 full SHA pin。本仓现有 policy/grammar 使用 major refs，本 issue 只迁移 runtime；同时改变供应链 pin 策略会扩大范围。审阅时记录解析 commit和 metadata作为时间点证据，workflow合同仍以四个 major identity 为权威。
6. 扩展现有 `check_wf`，不新建第二个 workflow parser。更新 fast/anti-drift/smoke/ui 既有 exact tuples 的 major；对 unit-tests、secret-scan、sast 只增加一层共享的 `uses` cardinality/关键 input/相对顺序检查，不复制三个完整 job snapshot。七个 direct jobs 共同拒绝 Node 20 fallback；保持 unrelated action内部实现不可见，不尝试在本地执行第三方 action。
7. 外部验收必须读取新 run 的 check-run annotations 和 action step names/log：8 jobs成功只是必要非充分条件；七个 direct jobs 的 Node 20 annotation必须为零。setup-node要显示 Node 24.13.1、npm cache main lookup/restore 与成功 post lifecycle；primary-key miss 时验证 save，hit 时接受明确的 `not saving cache`。setup-uv要安装 uv并有成功 cache post-step，secret-scan要在 full-history checkout 后执行gitleaks且成功。

## Upstream Compatibility Review

- `actions/checkout` v4 commit `11d5960…` node20 → v5 commit `fbc6f399…` node24；v5.0.0 release 仅要求 runner 2.327.1+，used input `fetch-depth` retained。
- `actions/setup-node` v4 `49933ea…` node20 → v5 `a0853c2…` node24；used inputs retained；automatic cache change reviewed above；action explicitly states no `node_modules` cache。
- `astral-sh/setup-uv` v5 `d4b2f3b…` node20 → v7 tag target `37802ad…` node24；v6/v7 breaking inputs all unused; hosted-runner cache and uv PATH behavior remain applicable。
- `gitleaks/gitleaks-action` v2 `ff98106…` node20 → v3 `e0c47f4…` node24；v3 release states no input/output/behavior changes and runner 2.327.1+。
- Source links: checkout v5.0.0, setup-node v5.0.0, setup-uv v6.0.0/v7.0.0 and gitleaks v3.0.0 GitHub releases; candidate `action.yml` queried at each major tag on 2026-09-08。

## Risk Packs Considered

- Public API / CLI / script entry: selected — GitHub Actions and `make test-guardrails` are required operator entrypoints.
- Config / project setup: selected — workflow action refs and inputs are core configuration.
- Schema / field names: selected — `uses`, `with`, `env`, action matrix and `runs.using` identities are exact fields.
- Auth / permissions / secrets: selected — checkout credentials and gitleaks `GITHUB_TOKEN` must not drift or leak; permissions remain unchanged.
- Concurrency/shared state/ordering: selected — seven jobs run independently; checkout/setup/cache must precede consumers; aggregate waits for all.
- Resource/cache limits: selected — npm and uv cache behavior must remain, no `node_modules` reuse claim.
- Legacy compatibility: selected — action inputs and every downstream step/output must survive four major upgrades.
- Error handling/partial outputs: selected — action or cache failure remains nonzero; aggregate rejects failure/cancelled/skipped.
- Release/packaging/dependency compatibility: selected — third-party action major metadata, hosted-runner minimum and moving tags are central.
- Documentation/migration: selected — major-version review and annotation evidence must be recorded.
- Security/supply chain: selected — third-party majors, token boundary and ref strategy need explicit review.
- File IO/path safety: not selected — no application/user path handling; checkout workspace behavior remains upstream action contract.
- Tenant/sandbox, application auth/session, process lifecycle, SQLite, HTTP envelope, browser persistence, cross-service runtime: not selected — no product/runtime changes.

## Invariant Matrix

Governing invariant: each direct CI job SHALL use only the approved Node 24 action major matrix, with current critical inputs and ordering preserved; no Node 20 fallback/annotation remains, and all downstream jobs/aggregate retain behavior.

- Producers: four upstream major tags and their `action.yml runs.using: node24` metadata.
- Consumers: workflow job steps — checkout×7, setup-node×5, setup-uv×2, gitleaks×1 (15 uses total).
- Critical inputs: setup-node `{ node-version-file: .tool-versions, cache: npm }`; secret checkout `{ fetch-depth: 0 }`; gitleaks env exact `GITHUB_TOKEN` expression.
- Order: checkout before every repository consumer; setup-node before npm; setup-uv before uv; full-history checkout immediately precedes gitleaks within secret-scan.
- Cache/state: setup-node performs npm package-manager cache lookup/restore and a successful post lifecycle but never caches node_modules; primary-key miss saves while hit may explicitly skip save. setup-uv hosted cache post-step remains successful; jobs share no workspace/cache state beyond upstream cache service.
- Security: no `pull_request_target`, global token env, added permissions, unsecure Node fallback, ignored annotation or secret output.
- Failure: action step failure propagates; no if/continue/custom shell bypass; aggregate needs/severity unchanged.
- Oracle/source: actual workflow path passed to mutation oracle, exact matrices updated together, old/partial mixed majors fail.
- External evidence: PR head SHA, action step names/conclusions, Node/uv/cache/gitleaks logs and annotations.
- Unchanged consumers: all run commands, service harnesses, timeouts, constraints mirrors, application/test/dependency files, branch protection.

Regression rows:
- all 15 uses at approved majors + exact critical inputs -> source oracle accepts and new PR CI 8/8 succeeds with zero Node 20 annotations.
- any approved use reverted to old major, omitted, duplicated, replaced, relocated or mixed -> source oracle rejects.
- setup-node version/cache input, secret fetch-depth/token or setup-uv/gitleaks ordering drift -> source oracle rejects.
- workflow/job env adds `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` or bypass metadata -> source oracle rejects.
- existing timeout/steps/aggregate mutation cases -> remain green as self-tests and red against injected drift.

## Boundary-Surface Checklist

- Shared parser root: one `check_wf` structural parser, extended rather than forked.
- Public entry: PR/push `ci`, branch-protected `all-checks-passed`, `make test-guardrails`.
- Producer/consumer: moving major ref → resolved action metadata/runtime → setup output/cache → downstream commands → aggregate.
- Read/input: `.tool-versions`, package-lock, uv project files, full git history, GitHub token.
- Write/state: workspace checkout, npm/uv cache service; no node_modules cache or cross-job filesystem sharing.
- Credential boundary: token remains action env only; no value logged or committed.
- Stale/idempotency: every mutation starts from current workflow and executes against scratch path; missing anchor is not successful rejection.
- Publish/rollback: workflow-only rollout; revert one atomic commit if any action behavior regresses.
- Unchanged downstream: all tests/build/harness/quality steps, timeouts, constraints, products and thresholds.

## Risks / Trade-offs

- [moving tags can advance] → stay consistent with repository policy; record current resolved commits/metadata and mechanically enforce approved majors/input matrix.
- [setup-node automatic cache changes behavior] → explicit `cache: npm`, no root packageManager; inspect Node 24、cache lookup/restore 与成功 post 日志，按 primary-key hit/miss 接受 no-save/save 分支。
- [setup-uv v6/v7 cache defaults change] → used inputs are empty and new glob remains a superset for uv project files; verify install and cache post-step in real CI.
- [gitleaks v3 licensing/token behavior] → v3 states behavior unchanged; repo personal account; preserve full-history checkout and token env exactly; secret-scan must succeed.
- [local tests cannot execute hosted actions] → source-derived mutation oracle catches wiring drift; PR CI and annotations are mandatory external evidence.
- [seven-job scope exceeds issue snapshot] → repository gained smoke/ui after issue creation; current direct consumers must be upgraded atomically or warnings persist.

## Migration Plan

One workflow+oracle commit, PR CI validation, then merge. No product/data deployment. If any action/cache/secret-scan behavior fails, revert the commit; never add Node 20 fallback. Archive OpenSpec after merge.

## Open Questions

无。Candidate majors, runtime metadata, used inputs, runner boundary and observable CI evidence are known.
