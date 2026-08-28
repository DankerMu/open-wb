# Agent-Readiness Criteria

Source: distilled from the Factory.ai Agent Readiness Droid static auditor (82 criteria, derived 2026-03 cycle), extended with 7 eng-init runtime-verification criteria and the `control-plane-auditor` seven-layer / AGENTS.md constraint-dimension taxonomy. Cleaned of session noise.

This file powers two modes and stays paired with `references/readiness-registry.yaml`, the machine-readable contract for criteria that have executable repair metadata:

- **`audit-only` mode** — score the repo and emit `docs/agent-readiness-report.md`. No grilling.
- **`incremental` mode** — score the repo, then turn every failing criterion into a grill question. Gaps drive the questions.

In `greenfield` and `bootstrap` modes, this file is read as a checklist to ensure the rendered AGENTS.md covers everything it should. When editing registry-covered criteria, update `references/readiness-registry.yaml` and run `scripts/check_readiness_registry.py references/readiness-registry.yaml`; this markdown remains the human reference, not the only source of truth.

## Scoring model

| Step | Rule |
|------|------|
| Per-criterion score | `numerator / denominator` |
| Repository-scope denominator | always `1` |
| Application-scope denominator | always `N` (number of independently-deployable apps in the repo; for a single-app repo, `N = 1`) |
| Null numerator | allowed only for criteria marked **Skippable** when the criterion does not apply |
| Repo-level score | `mean(per-criterion score)` over all non-null criteria |
| **Strength adjustment** | for tool-backed criteria, full credit (`1.0`) only if the check **blocks** (fails commit/CI/merge); **half credit (`0.5`)** if the tool is configured but warn-only, advisory, or not wired into any hook/CI step; documentation-only satisfaction of a tool criterion (e.g., conventions "documented in AGENTS.md" where a lint rule exists for the stack) also caps at `0.5` |
| Level 1 | 0–20% |
| Level 2 | 20–40% |
| Level 3 | 40–60% |
| Level 4 | 60–79% |
| Level 5 | 80–100% |

All criteria are weighted equally regardless of their Level tag (the Level tag indicates organizational maturity, not scoring weight).

**How to judge "blocks" for the strength adjustment**: a check blocks when a violation makes a command exit non-zero in pre-commit or a required CI job — e.g., ESLint rules at `error` with `--max-warnings 0`, `clippy -D warnings`, a coverage gate that fails the job, `revive severity: error`. Warn-level lint rules, coverage reported to Codecov without a failing gate, and tools that run with `|| true` or only print reports do not block. Report half-credit criteria in their own subsection of the audit report ("configured but not blocking") — these are the cheapest strength wins.



## Report lifecycle contract

The readiness report is the handoff from Audit to Repair mode. It must be stable enough to compare over time and specific enough to select real fixes.

1. **Discover applications before scoring.** Build the application catalog first, then freeze `APPLICATIONS_IDENTIFIED: N` for the whole run. Do not change denominators criterion-by-criterion to make a score look better.
2. **Keep denominator stability.** Repository-scope criteria always use denominator `1`; application-scope criteria always use denominator `N`. If a later scan discovers a different app count, report the catalog change in "Changes Since Previous Report" and recompute all application-scope rows with the new `N`.
3. **Compare with the previous report when present.** Look for `.agent-readiness/latest.json`, `docs/agent-readiness-report.json`, or the last generated markdown report. Summarize score delta, application catalog delta, newly failing criteria, newly passing criteria, and criteria whose status changed between blocking / configured-but-not-blocking / missing. If no prior report exists, say so explicitly; do not invent a baseline.
4. **Treat configured-but-not-blocking as partial credit.** Tools that are installed or configured but not wired into a failing command/hook/required CI job receive half credit at most and must be listed in the "Configured but not blocking" section. This section is Repair mode input because these fixes often have high leverage.
5. **Include the control-plane layer summary.** Every report must map evidence into Memory, Invariant, Protocol, Permission, Sensorium, Evaluation / GC, and Governance so the numeric score does not hide which subsystem is absent.
6. **Audit AGENTS.md constraint dimensions.** Root and module-level `AGENTS.md` files must be checked for Glossary, Dependency Rules, Error Model, Naming Conventions, Doc Freshness Rules, State Model References, and Implicit Dependencies. Missing dimensions are readiness gaps even when individual tool criteria pass.
7. **Rank priority actions by future agent correct-change cost.** Highest priority goes to gaps that most increase the cost or risk of future correct changes by agents: missing project memory, unresolved command surface, no runnable tests, no code canonicality checks, phantom enforcement, missing runtime smoke, and absent refactor oracle. Do not rank by easiest score increase alone.
8. **Emit repair-usable output.** Each failing, partial, or gap row should include criterion ID, scope (`repo` or application path), observed evidence, fixability class, recommended recipe when known, validator command or missing prerequisite, and rescore rule. Repair mode must be able to select a criterion without reinterpreting prose.

The report must reject metric gaming: empty tests, disabled lint configs, placeholder configs, broad refactors, docs-only fake enforcement where mechanical enforcement is possible, and fake pass states do not count as substantive fixes.

## Control-plane overlay

Audit-only and incremental scans also classify the same raw evidence into seven control-plane layers. This is a diagnostic overlay, not a second scoring system: readiness criteria provide the numeric score; layer status explains which control subsystem is missing and what to fix first.

| Layer | Problem answered | Standing evidence | Typical readiness criteria |
|-------|------------------|-------------------|----------------------------|
| Memory | Where do authoritative facts live? | Concise root `AGENTS.md`, `CONTEXT.md`, module instructions when needed, architecture docs, plans, runbooks | `agents_md`, `context_md`, `service_flow_documented`, `runbooks_documented` |
| Invariant | What must not drift? | Dependency guards, schema validation, meaningful typing, unified error model, naming and doc-freshness rules | `code_modularization`, `type_check`, `strict_typing`, `naming_consistency`, `documentation_freshness`, `agents_md_validation` |
| Protocol | How does work flow? | Plan templates, reusable runbooks/skills, isolated work, status/work-unit artifacts | `skills`, `issue_templates`, `pr_templates`, `task_ownership_protocol`, `runtime_evidence_in_pr_template` |
| Permission | What is readonly or high risk? | Generated/secret path guards, migration/deploy gates, explicit trust boundaries, scoped agent permissions | `secret_scanning`, `secrets_management`, `branch_protection`, `guardrail_self_test`, `anti_cheat_rules_concrete` |
| Sensorium | How does the agent know it is correct? | Unit/integration/e2e/contract tests, dev server lifecycle, smoke tests, structured logs, executable done definitions | `unit_tests_exist`, `integration_tests_exist`, `smoke_tests_exist`, `dev_server_lifecycle_documented`, `structured_logging`, `health_checks` |
| Evaluation / GC | How are bad patterns found and retired? | Doctor/health scripts, drift detectors, cleanup backlog, review learnings made durable, stale-doc detection | `dead_code_detection`, `duplicate_code_detection`, `tech_debt_tracking`, `violation_baseline_tracked`, `guardrail_self_test` |
| Governance | What autonomy is warranted? | Explicit autonomy/escalation rules based on layer coverage; need autonomy separated from execution autonomy | `agentic_development`, `automated_pr_review`, `task_ownership_protocol`, `runtime_evidence_in_pr_template` |

Layer status:

- **Covered**: most standing evidence exists and blocking checks are active where applicable.
- **Partial**: some evidence exists, but important checks are missing, advisory only, stale, or not wired into the command surface.
- **Missing**: the layer is not meaningfully established.
- **Informational**: use for Governance observations when autonomy posture needs human judgment.

## AGENTS.md constraint dimensions

Audit root and module-level instruction files for entropy-reducing constraints. Report each dimension as `Yes`, `Partial`, or `No`, with the file path that proves it. Breadth matters: a partial entry across all dimensions is usually more useful to agents than one detailed section and six missing sections.

| Dimension | Minimum viable evidence | Primary artifact |
|-----------|-------------------------|------------------|
| Glossary | Canonical terms for core concepts plus prohibited aliases | `CONTEXT.md` and/or `AGENTS.md` |
| Dependency Rules | Allowed import directions plus explicit prohibited imports | `AGENTS.md`, module `AGENTS.md`, architecture guard config |
| Error Model | Standard error envelope, code taxonomy, and boundary conventions | `AGENTS.md`, API docs, shared error module |
| Naming Conventions | Case, verb, file, API/event naming rules by layer | `AGENTS.md`, lint config, `constraints.yaml` |
| Doc Freshness Rules | Specific "if X changes, update Y" rules and freshness check path | `AGENTS.md`, docs governance, CI/guard script |
| State Model References | Canonical lifecycle/state definitions for key entities | `CONTEXT.md`, domain files, state-machine docs |
| Implicit Dependencies | Global mutable state, env vars, import side effects, hidden service dependencies | `CONTEXT.md`, module `AGENTS.md`, runbooks |


## Fixability classes

Every failing or partial criterion should be labeled with one fixability class. The class controls what Repair mode may claim as complete.

| Class | Name | Repair authority | Examples |
|-------|------|------------------|----------|
| A | Skill-owned | `eng-init` may directly create or repair the artifact when the target repo facts are sufficient. | `agents_md`, `context_md`, `verification_matrix`, `guardrail_self_test`, `runtime_evidence_in_pr_template`, `pr_templates`, `gitignore_comprehensive`, `smoke_tests_exist`, `dev_server_lifecycle_documented` |
| B | Stack-owned but safe | `eng-init` may repair when stack evidence is clear and the selected entry point can run a validator; otherwise report the missing prerequisite. | `lint_config`, `formatter`, `type_check`, `test_naming_conventions`, `unit_tests_runnable`, `test_coverage_thresholds`, `dead_code_detection`, `duplicate_code_detection` |
| C | Repo/product-specific | `eng-init` may scaffold local support or document the gap, but cannot claim full completion without real product implementation and validator evidence. | `structured_logging`, `health_checks`, `secrets_management`, `database_schema`, `api_schema_docs`, `feature_flag_infrastructure` |
| D | External/governance | Audit and recommend only unless authenticated external access plus explicit user permission are available. Local docs or placeholders do not complete the criterion. | `branch_protection`, `deployment_frequency`, `backlog_health`, `privacy_compliance`, `progressive_rollout`, `product_analytics_instrumentation` |

Class D criteria must never be marked fixed by adding local text that says the external control exists. Report the exact external action, API/tool prerequisite, and any local supporting file that was added, then leave the readiness signal failing or manually pending until external evidence exists.

## Profile interaction — criteria that lose Skippable status

Some criteria are Skippable by default but become mandatory once the repo's `constraints.yaml` `strictness_profile` reaches a threshold level. At that point a null numerator is no longer allowed — they score `0` until satisfied.

| Threshold | Criteria that lose Skippable status |
|-----------|-------------------------------------|
| L2+ | `verification_matrix`, `guardrail_self_test`, `dev_server_lifecycle_documented` |
| L3+ | `health_checks`, `secret_scanning`, `automated_security_review`, `branch_protection`, `integration_tests_exist`, `smoke_tests_exist` |


## Refactor overlay interaction

When `constraints.yaml` has `refactor_contract.active: true` or Stage 0 detects a rewrite/port/migration in progress, the following criteria are mandatory even if they would otherwise be skippable:

| Condition | Criteria that become required |
|-----------|-------------------------------|
| Large-refactor overlay active | `source_of_truth_declared`, `anti_cheat_rules_concrete` |
| Large-refactor overlay active and a source/reference oracle is declared | `compare_oracle_exists` |
| Large-refactor overlay active and team size is large/public OSS or multiple AI tools are named | `task_ownership_protocol` |

Do not score a missing compare command as passing. If the reference oracle exists but no runnable compare target exists yet, `source_of_truth_declared` may pass while `compare_oracle_exists` fails with a concrete readiness gap.

## Application discovery (do this first)

An **application** is a directory that can be deployed independently (own deploy lifecycle, own build, serves end users or other systems). Shared libraries are not applications. Examples/demos that share infrastructure are not separate applications. If nothing qualifies, count the repo root as one application.

Monorepo precedents (apply these, don't re-derive each time):

| Repo shape | N | Reasoning |
|---|---|---|
| Monorepo with a CLI app and a web app (e.g. `apps/cli` + `apps/web` with separate dist/bin outputs) | 2 | Both have own build and deploy lifecycle; all other packages are shared libraries |
| Pure-library monorepo (all packages published to a registry, nothing deployed) | 1 | The repo root is the application for readiness purposes — no package has its own deploy lifecycle |
| Library monorepo with one demo/example app that shares CI infrastructure | 1 | The demo shares infrastructure; it is not an independently deployable product |
| Microservices monorepo (each service deploys independently with its own health checks) | N services | Each service has its own deploy lifecycle |

A wrong denominator is the audit's biggest silent error: counting shared libraries as applications dilutes every application-scope criterion to near-zero.

Output:

```
APPLICATIONS_IDENTIFIED: N

Applications:
1. <path> — <one-line description>
2. <path> — <one-line description>
...
```

`N` is fixed for the whole audit. All application-scope denominators are `N`.

---

## Repository-scope criteria (62, denominator = 1)

| ID | Lvl | Skip | Check | Maps to artifact / section |
|----|-----|------|-------|----------------------------|
| `large_file_detection` | 3 | no | Hook/CI/LFS/lint flags files over threshold | Conventions / Enforcement |
| `tech_debt_tracking` | 3 | no | TODO scanner, TODO→issue enforcement, SonarQube SQALE | Conventions |
| `build_cmd_doc` | 2 | no | Build command documented in README/AGENTS.md | Development Workflow |
| `deps_pinned` | 2 | no | Lockfile committed (package-lock, poetry.lock, Cargo.lock, go.sum) | Stack & Versions |
| `vcs_cli_tools` | 2 | no | `gh` or `glab` installed and authenticated | Enforcement Index |
| `automated_pr_review` | 2 | yes | Bot/Action posts review content on PRs | Agent Operating Rules |
| `agentic_development` | 3 | no | Evidence of AI agents in git history, CI, `.factory`, `.agents`, or equivalent agent directories | Agent Operating Rules |
| `fast_ci_feedback` | 4 | yes | CI completes in under 10 minutes for typical PRs | Development Workflow |
| `build_performance_tracking` | 4 | yes | Build duration measured; caching/optimization evidence | Enforcement Index |
| `deployment_frequency` | 4 | yes | Multiple deploys per week with automation | Enforcement Index |
| `single_command_setup` | 3 | no | One command from fresh clone to running dev server | Development Workflow |
| `feature_flag_infrastructure` | 4 | no | LaunchDarkly/Statsig/Unleash/GrowthBook/custom flags configured | Architecture Discipline |
| `release_notes_automation` | 3 | no | semantic-release/changesets/equivalent generates changelog | Enforcement Index |
| `progressive_rollout` | 4 | yes | Canary/percentage/ring deploys configured | Enforcement Index |
| `rollback_automation` | 4 | yes | One-click or auto rollback exists, is documented, and carries exercise evidence (a drill or real use within the last release cycle) — a configured-but-never-exercised standby path caps at half credit; an unexercised backup is a hope, not a capability | Enforcement Index |
| `monorepo_tooling` | 2 | yes | Workspace tool configured (turbo/nx/pnpm-workspaces/go.work/cargo workspaces/bazel) | Stack & Versions |
| `version_drift_detection` | 3 | yes | syncpack/manypkg/Renovate-group/Nx-constraints prevents version drift across packages | Stack & Versions |
| `release_automation` | 3 | no | Automated release/deploy pipeline (CD on merge, release-please, ArgoCD, etc.) | Enforcement Index |
| `dead_feature_flag_detection` | 3 | yes | Stale-flag detector (depends on `feature_flag_infrastructure`) | Architecture Discipline |
| `agents_md` | 2 | no | AGENTS.md exists at repo root, ≥100 characters, documents scripts/commands | (this skill's primary output) |
| `context_md` | 2 | no | CONTEXT.md exists at repo root, defines project identity and either domain terms or explicitly says no domain glossary is needed yet | CONTEXT.md |
| `readme` | 1 | no | README.md exists at repo root with setup/usage | out of scope |
| `automated_doc_generation` | 2 | no | Swagger/JSDoc/Sphinx/agent-driven doc updates | Enforcement Index |
| `generated_docs_check_mode` | 3 | yes | Every generated doc has a generator with a `--check` mode wired into CI that fails on drift (derivation-equality strong form; `documentation_freshness` mtime is the weak form); generated outputs are never hand-edited; skippable when no doc is a code projection | Enforcement Index |
| `skills` | 3 | no | `.factory/skills/`, `.claude/skills/`, or `.skills/` with at least one valid `SKILL.md` | Agent Operating Rules |
| `documentation_freshness` | 3 | no | README/AGENTS.md/CONTRIBUTING.md touched within last 180 days | Conventions |
| `service_flow_documented` | 3 | no | Architecture diagrams (mermaid/plantuml) or service-dependency docs | Directory Map |
| `agents_md_validation` | 4 | no | CI/hook validates AGENTS.md commands still work (depends on `agents_md`) | Enforcement Index |
| `devcontainer` | 2 | no | `.devcontainer/devcontainer.json` with toolchain | Development Workflow |
| `env_template` | 1 | no | `.env.example` exists or env vars documented | Development Workflow |
| `local_services_setup` | 2 | yes | `docker-compose.yml` or clear local-service setup | Development Workflow |
| `devcontainer_runnable` | 3 | yes | Devcontainer actually builds and runs | Development Workflow |
| `runbooks_documented` | 2 | no | Runbooks/playbooks linked (Notion, Confluence, `runbooks/` dir) | Enforcement Index |
| `branch_protection` | 2 | yes | Modern rulesets or legacy protection on main/dev | Enforcement Index |
| `ci_aggregator_gate` | 2 | yes | CI defines an `if: always()` aggregator job that fails on any failed/cancelled/skipped required dependency; branch protection requires that single check (GitHub counts a skipped required check as passing, so per-job required checks are silently disabled by dependency failures); skippable only when no CI exists | Enforcement Index |
| `secret_scanning` | 3 | yes | gitleaks/trufflehog/native scanning configured | Enforcement Index |
| `codeowners` | 2 | no | CODEOWNERS file with valid team assignments | Conventions |
| `automated_security_review` | 2 | yes | Semgrep/CodeQL/Snyk SAST or equivalent in CI | Enforcement Index |
| `dependency_update_automation` | 2 | no | Dependabot/Renovate creating PRs | Stack & Versions |
| `gitignore_comprehensive` | 1 | no | `.gitignore` excludes `.env`, `node_modules`, build artifacts, IDE/OS files | Conventions |
| `privacy_compliance` | 4 | yes | Consent SDK / retention docs / GDPR-CCPA endpoints | Architecture Discipline |
| `secrets_management` | 2 | no | Secrets manager integration or properly gitignored `.env` with template | Development Workflow |
| `min_release_age` | 3 | no | Renovate `minimumReleaseAge`/`stabilityDays` or documented wait policy | Stack & Versions |
| `issue_templates` | 2 | no | `.github/ISSUE_TEMPLATE/` or `.gitlab/issue_templates/` | Agent Operating Rules |
| `issue_labeling_system` | 2 | no | Consistent priority/type/area labels exist | Agent Operating Rules |
| `backlog_health` | 4 | yes | >70% open issues have descriptive title + label; not 50%+ ancient | Agent Operating Rules |
| `pr_templates` | 2 | no | `.github/pull_request_template.md` with description/testing/context sections | Conventions |
| `verification_matrix` | 2 | yes | AGENTS.md contains a Verification Matrix whose commands resolve through the selected dev entry point (`justfile`, `Makefile`, or package scripts) | Verification Matrix |
| `dev_server_lifecycle_documented` | 2 | yes | `dev-bg` / `dev-stop` / `dev-status` / `logs` commands exist through the selected dev entry point and AGENTS.md documents the start/stop/status/logs lifecycle; skippable when nothing long-running exists | Development Workflow |
| `runtime_evidence_in_pr_template` | 2 | no | PR template contains a "## Runtime evidence" section ("None — review-only change" allowed with stated reason) | Agent Operating Rules |
| `guardrail_self_test` | 3 | yes | `scripts/test-guardrails.sh` exists and a CI/cron job runs it; the self-test asserts both directions — guards accept the clean tree and reject one staged violation each (a rejection-only self-test is blind to always-failing guards) | Enforcement Index |
| `exemption_registry_hygiene` | 3 | yes | Every exemption/allowlist entry (lint suppression registries, coverage exemptions, budget overrides, `constraints.yaml` `exemptions`) names an existing target and carries a non-empty reason; entries whose target was renamed or removed fail a check or are flagged; mutually exclusive lists share no entries; skippable when no exemption mechanism exists | Enforcement Index |
| `incident_pipeline` | 3 | yes | A postmortem contract exists (`docs/postmortem/README.md` or equivalent: trigger criteria + section skeleton); each written postmortem's "Guardrails added" entries name mechanisms that exist (test/gate/rule) or state `not applicable` with a reason per landing layer; a danger-patterns doc, *if one exists*, links ≥2 distinct postmortems (whether a second incident warrants promoting one is a human call, not a gated rule — see the recipe's Validator); skippable when the repo has no recorded incidents and declined the skeleton | Enforcement Index |
| `violation_baseline_tracked` | 3 | yes | `constraints.yaml` `baseline.counts` present when legacy violations exist, with a CI comparison step that fails on increase; skippable when Stage 0 found no violations | Enforcement Index |
| `source_of_truth_declared` | 3 | yes | Active refactor contract names the canonical source for each behavior surface (`legacy/`, upstream repo, old binary, formal spec, golden fixtures, or schema) | Source of Truth & Refactor Contract |
| `compare_oracle_exists` | 4 | yes | Active refactor contract has at least one real compare/oracle command and the command resolves to a dev-entry target | Verification Matrix |
| `anti_cheat_rules_concrete` | 3 | yes | Active refactor contract explicitly forbids weakening compare tests, shelling out to legacy outside oracle commands, silent fallback, and unapproved dual production paths | Source of Truth & Refactor Contract |
| `task_ownership_protocol` | 3 | yes | Public OSS / multi-agent refactor has issue labels, task files, or external tracker rules for claiming exactly one work unit | Agent Operating Rules |
| `verification_snapshot_tiers` | 3 | yes | Keyless snapshot/replay tiers pin model-, protocol-, or human-visible output through runnable examples; CI replays in read-only mode; capability-proving suites assert zero skipped tests. Evidence: a snapshot/replay script (e.g. `test:snapshot`) and/or a CI read-only replay env (e.g. `DSH_SNAPSHOT=replay`) | Verification Matrix / testing policy |
| `decision_record_lifecycle` | 3 | yes | Decision records follow a four-zone lifecycle (proposed/implemented/rejected/archived) with classification by kind, archive freeze, supersession check at write, and the rule that non-trivial changes ship their record in the same PR; a manifest/verify script checks the tree when one exists. Evidence: a notes/decisions tree with zone and kind subdirectories | Agent Operating Rules |
| `documentation_gates` | 3 | yes | Docs change with code (README/JSDoc updated for altered behavior in the same change); a scripted doc-validation gate wired into CI fails on drift; Known Limitations sections mandatory with a justified allowlist. Evidence: a doc-validation script (e.g. `doc-sync`) and/or a known-limitations verifier | Enforcement Index |
| `runtime_invariants` | 3 | yes | Packages/modules register ownership assertions over authoritative event streams or mutable data (invariant companions); empty companions carry an explained reason; a verify script enforces them. Evidence: per-package invariant companions plus a verify script (e.g. `verify-package-invariants`) | Enforcement Index |

---

## Application-scope criteria (42, denominator = N apps)

| ID | Lvl | Skip | Check | Maps to AGENTS.md section |
|----|-----|------|-------|---------------------------|
| `lint_config` | 1 | no | ESLint / ruff / golangci-lint / clippy / equivalent configured | Stack & Versions / Enforcement |
| `type_check` | 1 | no | tsconfig `strict:true` for TS, mypy/pyright for Py, etc. | Stack & Versions |
| `formatter` | 1 | no | Prettier/Black/gofmt/rustfmt/equivalent configured | Conventions / Enforcement |
| `pre_commit_hooks` | 2 | no | Husky/lint-staged or `.pre-commit-config.yaml` runs lint/format on commit | Enforcement Index |
| `strict_typing` | 2 | yes | TS `strict:true`, mypy strict, or compiler-enforced typing | Stack & Versions |
| `naming_consistency` | 3 | no | Linter rule (`@typescript-eslint/naming-convention`, pylint), or documented conventions in AGENTS.md | Conventions |
| `cyclomatic_complexity` | 5 | no | ESLint complexity / lizard / radon / gocyclo / SonarQube cognitive complexity | Enforcement Index |
| `dead_code_detection` | 3 | no | knip / vulture / golangci-lint unused / cargo-machete / cargo-udeps / Maven or Gradle dependency analysis / SonarQube | Code Canonicality (CRITICAL) |
| `duplicate_code_detection` | 3 | no | jscpd / dupl / Pylint duplicate-code / PMD CPD / SonarQube duplicate detection | Code Canonicality (CRITICAL) |
| `code_modularization` | 4 | yes | eslint-plugin-boundaries / dependency-cruiser / ArchUnit / import-linter / Go `internal/` | Directory Map & Module Boundaries |
| `n_plus_one_detection` | 4 | yes | bullet / nplusone / DataLoader / ORM query analysis | Architecture Discipline |
| `heavy_dependency_detection` | 4 | yes | Bundle analyzer, size-limit, Lighthouse CI budgets | Stack & Versions |
| `unused_dependencies_detection` | 3 | no | depcheck / knip / deptry / `go mod tidy` in CI / `cargo-udeps` / Maven analyze | Code Canonicality |
| `unit_tests_exist` | 1 | no | `*.test.ts` / `__tests__/` / `tests/test_*.py` / `*_test.go` / `*_test.rs` present | Development Workflow |
| `integration_tests_exist` | 3 | no | cypress/playwright config / `tests/integration/` / Behave features | Development Workflow |
| `unit_tests_runnable` | 2 | no | `test` script runs (verified with `--listTests` / `--collect-only` style flags) | Development Workflow |
| `test_performance_tracking` | 4 | no | Test timing surfaced (`--durations`, `--verbose`, BuildPulse, Datadog CI) | Enforcement Index |
| `flaky_test_detection` | 4 | yes | Retry config, BuildPulse, quarantine mechanism | Enforcement Index |
| `test_coverage_thresholds` | 2 | no | `coverageThreshold`, `--cov-fail-under`, Codecov gate, SonarQube quality gate | Conventions |
| `test_naming_conventions` | 3 | no | Test framework patterns enforced or documented in AGENTS.md | Conventions |
| `test_isolation` | 4 | no | Parallel execution config / `t.Parallel()` / pytest-xdist / DB isolation / randomization | Architecture Discipline |
| `api_schema_docs` | 3 | yes | OpenAPI/Swagger/GraphQL schema files committed | Directory Map |
| `database_schema` | 2 | yes | Prisma schema / TypeORM entities / SQLAlchemy models / SQL migrations | Directory Map |
| `structured_logging` | 2 | no | winston/pino/bunyan/structlog/loguru or dedicated logger module | Stack & Versions |
| `distributed_tracing` | 3 | no | OpenTelemetry / X-Request-ID propagation / trace correlation | Architecture Discipline |
| `metrics_collection` | 3 | no | Datadog/Prometheus/New Relic/CloudWatch instrumentation | Architecture Discipline |
| `code_quality_metrics` | 4 | yes | Coverage/complexity/maintainability tracked (SonarQube, Codecov bot, etc.) | Enforcement Index |
| `error_tracking_contextualized` | 2 | no | Sentry/Bugsnag/Rollbar with source maps + breadcrumbs + user context | Architecture Discipline |
| `alerting_configured` | 3 | no | PagerDuty/OpsGenie/custom alert rules defined | out of scope (ops) |
| `deployment_observability` | 4 | no | Dashboards linked (Datadog/Grafana/New Relic) and deploy annotations | Enforcement Index |
| `health_checks` | 3 | yes | `/health`/`/healthz`/`/ready`/`/live` endpoints; K8s probes; Docker HEALTHCHECK | Architecture Discipline |
| `circuit_breakers` | 4 | yes | opossum/cockatiel/resilience4j/polly/tenacity or service-mesh equivalents | Architecture Discipline |
| `profiling_instrumentation` | 4 | yes | APM (Datadog/New Relic) or continuous profiling (Pyroscope, Parca) | out of scope (ops) |
| `dast_scanning` | 4 | yes | OWASP ZAP / Burp / Nuclei in CI against staging | out of scope (security) |
| `pii_handling` | 3 | yes | Presidio/Macie/DLP, masking utilities, or PII handling docs | Architecture Discipline |
| `log_scrubbing` | 3 | no | Redaction in logger config (pino redact, winston format, structlog processors) | Architecture Discipline |
| `product_analytics_instrumentation` | 3 | no | Mixpanel/Amplitude/PostHog/GA4 instrumented | out of scope |
| `error_to_insight_pipeline` | 5 | no | Sentry-GitHub integration, error-to-issue automation | Enforcement Index |
| `smoke_tests_exist` | 2 | yes | Selected-entry `smoke` command exercises key API/CLI routes against a running app (hurl/curl scripts) asserting status + body; skippable only for pure libraries | Verification Matrix |
| `seed_data_available` | 2 | yes | Selected-entry `seed` command (with `db-reset` command when persistence is resettable) produces a deterministic local dataset for runtime verification; skippable when no persistence | Development Workflow |
| `coverage_per_file` | 3 | yes | Per-file 100% coverage gate (strong form of `test_coverage_thresholds`): the gate fails on any file under 100%; an uncovered line is treated as a dead-code candidate, not a missing test to bolt on. Evidence: per-file coverage config (e.g. vitest per-file 100%) in a failing CI gate | Conventions / Enforcement |
| `built_artifact_smokes` | 3 | yes | Published-artifact smokes: packages with a `bin` or non-index runtime entry run the built output under plain runtime (not source-transpiled), asserting the shipping artifact boots; a genuinely missing config exits non-zero; skippable when no `bin` or non-index runtime entry exists. Evidence: built-output e2e smokes (e.g. `built-bin.e2e.ts`/`built-lib.e2e.ts`) | Verification Matrix |

---

## How this feeds Stage 2 grilling

When in `incremental` mode, the audit runs first. If `constraints.yaml` is missing or has no `strictness_profile` (repos initialized before profiles existed), ask question-bank Q1.4 before anything else — failing criteria cannot be prioritized without knowing the target strictness. For each criterion that **fails**, generate a grill question based on its "Maps to AGENTS.md section" column:

- Missing `agents_md` or `context_md` becomes P0: without project memory and domain language, agents will guess.
- All failing criteria in **Code Canonicality** become P0 questions ("This repo lacks dead-code detection — do you want `knip` / `cargo-udeps` / equivalent wired up?"). These are not optional.
- All failing criteria in **Conventions** / **Enforcement Index** become P1 questions.
- All failing criteria in scope sections (Architecture Discipline, etc.) become P2 questions ("Want me to add a section requiring `structured_logging` with `pino redact`?").
- Criteria marked **out of scope** are reported in the audit but never grilled — they belong to ops/security/product workflows beyond this skill.


Missing AGENTS.md constraint dimensions are readiness gaps even when individual tool criteria pass. Treat missing Glossary / Dependency Rules / Error Model / Naming Conventions / Doc Freshness Rules / State Model References / Implicit Dependencies as P1 grill inputs unless the repo has no matching domain surface; if no matching surface exists, record the explicit non-applicability reason.

In `greenfield` / `bootstrap` mode, treat the audit as a coverage checklist: after grilling the required question-bank dimensions, walk the failing-criteria and constraint-dimension gap lists and confirm each has either been addressed or consciously deferred.

## Output format for `audit-only` mode

Write `docs/agent-readiness-report.md`. If the user explicitly requests machine-readable output, also write `.agent-readiness/latest.json` (or `docs/agent-readiness-report.json` when the repo forbids dot-directories).

Honesty rules for the report body:

- **Every failing or unverified criterion names what was checked — with the check's depth.** A `0` without a looked-for location is an assertion, not evidence; write `0 — checked package.json scripts, .github/workflows, no coverage config found`. A checked line names the file AND what it contained or the command's decisive output: `strict_typing 1 — checked: tsconfig.json contains "strict": true`. A line that lists only a path without stating what the check found is a false alibi — it proves the file exists, not that the criterion was evaluated. A criterion you could not verify in the time budget reads `no evidence found — checked: <exact paths/commands>`; never write `0` for something you did not look at.
- **Small repos collapse the table by control-plane layer.** When most criteria are `null`/`0` (e.g. a plugin repo with no CI), group the per-criterion table by layer and collapse empty layers to one line each (`Invariant — all 0, no lint/invariant/coverage machinery`). Keep the six most decision-relevant criteria as individual rows. A wall of 100 zero-rows is itself a readiness failure of the report.
- **Application-scope denominators stay visible.** A reader must be able to recompute every `k/N` from the report alone (the discovery section owns the `APPLICATIONS_IDENTIFIED` list).
- **Machine-readable reports carry the checked locations.** The JSON report (per `readiness-report-schema.json`) sets `criteria[].evidence_locations` for every failing or unverified criterion — the schema field is not optional decoration; it is the machine form of the checked-locations rule.

```markdown
# Agent Readiness Report

**Level:** Level X (XX% pass rate)
**Applications:** N
- `<path>` — <description>

## Score by Level

| Level | Passing / Applicable |
|-------|---------------------|
| L1 | x/y |
| L2 | x/y |
| L3 | x/y |
| L4 | x/y |
| L5 | x/y |

## Control Plane Layer Summary

| Layer | Status | Key finding |
|-------|--------|-------------|
| Memory | Covered / Partial / Missing | <one-line evidence or gap> |
| Invariant | Covered / Partial / Missing | <one-line evidence or gap> |
| Protocol | Covered / Partial / Missing | <one-line evidence or gap> |
| Permission | Covered / Partial / Missing | <one-line evidence or gap> |
| Sensorium | Covered / Partial / Missing | <one-line evidence or gap> |
| Evaluation / GC | Covered / Partial / Missing | <one-line evidence or gap> |
| Governance | Informational | <autonomy / escalation observation> |

## AGENTS.md Constraint Dimensions

| Dimension | Present? | Quality | Location |
|-----------|----------|---------|----------|
| Glossary | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |
| Dependency Rules | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |
| Error Model | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |
| Naming Conventions | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |
| Doc Freshness Rules | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |
| State Model References | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |
| Implicit Dependencies | Yes / Partial / No / N/A | <notes> | <file path or "missing"> |

## Failing criteria (sorted by impact)

### Code Canonicality (highest impact)
- `dead_code_detection` — 0/N — no stack-specific dead-code tool configured.
- ...

## Configured but not blocking (half credit — cheapest strength wins)

- `lint_config` — 0.5/N — ESLint configured but CI runs without `--max-warnings 0`.
- `test_coverage_thresholds` — 0.5/N — coverage reported, no failing gate.
- ...

### Conventions
- ...

### Enforcement Index
- ...

## Priority actions

1. <concrete, executable step>
2. <concrete, executable step>
3. <concrete, executable step>
```

JSON companion shape:

```json
{
  "generated_at": "{{ISO_TIMESTAMP}}",
  "level": "Level X",
  "score": 0.0,
  "applications": [{"path": ".", "description": ""}],
  "control_plane_layers": [{"layer": "Memory", "status": "partial", "finding": ""}],
  "constraint_dimensions": [{"dimension": "Glossary", "present": "partial", "quality": "", "location": ""}],
  "failing_criteria": [{"id": "dead_code_detection", "score": 0, "reason": ""}],
  "configured_but_not_blocking": [{"id": "lint_config", "score": 0.5, "reason": ""}],
  "readiness_gaps": [{"id": "compare_oracle_exists", "reason": ""}],
  "priority_actions": [{"rank": 1, "action": "", "why": ""}]
}
```


Action items should be specific and executable, not abstract advice.
