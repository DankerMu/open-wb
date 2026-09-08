## Context

历史 run 33835991516、33849736003、33869448236 证明：同一 lockfile/cache key 下 `npm ci` 可在 3–302 秒间波动。5 分钟的 fast-checks/anti-drift 在约 300 秒安装高尾时被取消，后续 Biome/typecheck 或 knip/jscpd/guards 全部 skipped；10 分钟 unit-tests 在同一慢安装后仍完成。setup-node 缓存 npm package-manager data 而非 `node_modules`，每个独立 job 仍 clean-install。现有日志不能判定高尾来自 registry、npm cache/reify 或 runner，因此本变更只修复已证实的可控机制：job budget 与安装高尾不匹配。

Fixture level: expanded
Repair intensity: high
Project profile: Generic（TypeScript Web 服务 + Python 知识库，多子系统）

## Goals / Non-Goals

**Goals:**
- 为 fast-checks 与 anti-drift 提供能承载已观测 302 秒安装及短下游步骤的 10 分钟总预算。
- 使 workflow timeout 与 `constraints.yaml` 单一镜像一致，source-derived oracle 能机械拒绝漂移。
- 保证 `npm ci` 与每个原有质量步骤仍执行，且 `all-checks-passed` 继续拒绝 failure/cancelled/skipped。
- 以新 PR/push CI 链接证明两个目标 job 在修复配置下实际完成。

**Non-Goals:**
- 不宣称或尝试修复尚未证实的 registry、npm cache/reify 或 GitHub runner 底层延迟来源。
- 不缓存 `node_modules`、改 registry、跳过 clean install、改变依赖集合或 lockfile。
- 不放宽 lint/typecheck/coverage/knip/jscpd/guard、安全扫描或聚合器规则。
- 不回写历史 OpenSpec archive，不合并 #29 的 action runtime 升级。

## Decisions

1. 仅将 fast-checks/anti-drift 从 5 分钟改为 10 分钟。证据上限为 302 秒安装 + 2–6 秒下游检查；同工作流的 unit-tests 已以 10 分钟成功承载 302 秒安装及 19–21 秒测试。更短预算无法覆盖已观测高尾，更长预算没有数据依据。
2. 在 `constraints.yaml` 把 `fast_checks_timeout_minutes` 改为 10，并新增 `anti_drift_timeout_minutes: 10`。workflow 是执行面，constraints 是机器可读政策镜像；二者必须由测试绑定。
3. 扩展 `scripts/test-ci-harness.sh` 的 source-derived parser，使 fast-checks/anti-drift 不再是 opaque legacy body：只钉本 issue 需要保持的 metadata、步骤序列、无 `if`/`continue-on-error`/custom shell 和 timeout 镜像，不复制整个 workflow parser。
4. 为 oracle 增加 mutation：任一 timeout 回退、constraints 缺失/不一致、`npm ci` 或目标下游步骤删除/替换、job/step skip/continue 以及 aggregate predicate 弱化均必须使自证非零；无关 legacy body 变化仍可独立演进。
5. 修改 canonical verification-harness requirement 中原“既有 job timeout 不得修改”为明确例外：fast-checks/anti-drift 固定 10，其余 timeout 与所有门禁阈值保持不变。archive 记录历史，不修改。
6. 外部验收采用本 PR 的 CI run、merge 后 master run，以及后续正常交付产生的 run。当前交付至少拿到本 PR 与 merge 后两次独立运行；“连续若干次”按三次新运行下限，其中第三次可由同一 issue 的归档 follow-up PR 提供，避免无意义 rerun。

## Risk Packs Considered

- Public API / CLI / script entry: selected - GitHub Actions workflow 与 guardrail test 是交付命令面。
- Config / project setup: selected - workflow timeout 与 constraints 镜像是核心变更。
- File IO / path safety / overwrite: not selected - 不新增运行时文件路径或输出写入。
- Schema / columns / units / field names: selected - YAML job metadata及 constraints 字段新增/变更。
- Auth / permissions / secrets: not selected - 不改权限、token 或 secret 使用。
- Concurrency / shared state / ordering: selected - 并行 job 独立 clean-install，步骤顺序与聚合依赖必须保持。
- Resource limits / large input / discovery: selected - job timeout 是显式资源上界；仅按实测调整。
- Legacy compatibility / examples: selected - 现有七个 required jobs、步骤和聚合语义必须兼容。
- Error handling / rollback / partial outputs: selected - cancel/skipped/failure 必须继续 fail-closed，不得假绿。
- Release / packaging / dependency compatibility: selected - npm clean-install 与 lockfile/缓存行为保持不变。
- Documentation / migration notes: selected - canonical spec 与诊断结论需同步；无部署迁移。
- Tenant/sandbox isolation: not selected - 不触及租户或 workspace。
- Auth/session lifecycle: not selected - 不触及认证运行时。
- Process/child-environment isolation: not selected - 不改应用子进程或凭证环境。
- SQLite migration/catalog compatibility: not selected - 不触及数据库。
- Server/web HTTP-envelope compatibility: not selected - 不触及 HTTP 合同。
- Offline deployability: not selected - CI 仍依赖现有 npm/uv 下载面，不改变产品离线部署。
- Browser runtime/navigation/persistence: not selected - ui-walk job 保持不变。
- Cross-service boundary: not selected - 不触及服务间网络契约。

## Invariant Matrix

Governing invariant: fast-checks 与 anti-drift 必须各在 10 分钟总预算内先完成 clean install，再实际执行全部原质量步骤；任一失败、取消或跳过仍使 aggregate 失败，workflow 与 constraints 数值不可漂移。
Source-of-truth identity/contract: `.github/workflows/ci.yml` 中 exact job identity/steps/timeout，及 `constraints.yaml` 的两个 exact numeric mirror fields。

Surfaces:
- Producers: `.github/workflows/ci.yml` fast-checks/anti-drift metadata 与 steps。
- Validators/preflight: `scripts/test-ci-harness.sh` source-derived workflow/constraints oracle 与 mutation suite。
- Storage/cache/query: setup-node npm cache only；`node_modules` 不复用，`npm ci` 保持 clean install。
- Public routes/entrypoints: `make test-guardrails`、GitHub PR/push `ci` workflow。
- Frontend/downstream consumers: `all-checks-passed` 与 branch protection；产品 server/web 不变。
- Failure paths/rollback/stale state: timeout cancellation、downstream skipped、quality-step failure、constraints drift；全部 fail-closed。
- Evidence/audit/readiness: historical run/job logs、guardrail self-test、new PR/push run URLs and step conclusions。

Regression rows:
- target job + 302-second-equivalent observed install budget -> 10-minute configuration retains room for all downstream checks; new real runs complete them.
- timeout=5/mirror mismatch/missing downstream step/continue-on-error/aggregate weakening -> source-derived oracle rejects.
- unit-tests/smoke/ui-walk/secret-scan/sast and every threshold -> unchanged behavior and successful CI.

## Boundary-Surface Checklist

- Shared helper roots: `check_wf`/`contract` source parser in `scripts/test-ci-harness.sh`.
- Public entrypoints: `make test-guardrails`, GitHub `ci` workflow, required `all-checks-passed`.
- Producer/consumer evidence boundary: workflow job metadata → Actions step results → aggregate → branch protection.
- Resource/stale-state boundary: boundary: setup-node cache hit/miss must not be conflated with node_modules reuse or success.
- Unchanged downstream consumers: all seven required jobs and branch protection.

## Risks / Trade-offs

- [10 分钟掩盖无限挂起] → timeout 仍是有限上界，且是最小现有成功对照；底层高尾另由相位证据继续观察。
- [oracle 过度钉死 workflow] → 只解析两个目标 job 的必要 metadata/步骤和共享 aggregate，不锁无关 job 实现细节。
- [只靠快速 PR run 假称根因消失] → 区分“预算修复有效”与“底层高尾来源已消失”；至少三次新运行，每次确认 downstream steps 实际执行。
- [constraints 漂移] → exact numeric mirror 与双向 mutation 测试。

## Migration Plan

纯 CI 配置变更，无产品迁移。若新配置异常，可回滚本 commit；aggregate 和质量步骤从未放宽。底层延迟再次出现时先收集相位证据，不继续无依据抬高预算。
