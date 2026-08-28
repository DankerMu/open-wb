# swe-agent eng-init real-project validation

Target: `/Users/chenwenjie/workspaces/swe-agent`  
Validation date: 2026-07-02  
Mode: read-only mini audit/spec-preview using upgraded `eng-init` Mode Router and readiness repair concepts.

## Read-only scope

No files were written under `/Users/chenwenjie/workspaces/swe-agent`. The only file written by this validation is this report under the eng-init mission directory.

The target repository already had a dirty working tree before this report was written:

- `git status --short` in the target reported `M CONTEXT.md`.
- I treated that as pre-existing user work and did not modify it.

## Commands run

All commands below were run with `cwd=/Users/chenwenjie/workspaces/swe-agent`. No project-wide tests were run.

| Command | Exit code | Observed output / purpose |
|---|---:|---|
| `pwd` | 0 | `/Users/chenwenjie/workspaces/swe-agent` |
| `git rev-parse --show-toplevel` | 0 | `/Users/chenwenjie/workspaces/swe-agent` |
| `git status --short` | 0 | `M CONTEXT.md`; tool summary also reported `staged 0, unstaged 1, untracked 0` |
| `git ls-files AGENTS.md CONTEXT.md package.json docs/package.json .github/workflows/ci.yml` | 0 | All five paths are tracked |
| `bun --version` | 0 | `1.3.14` |
| `node --version` | 0 | `v26.0.0` |

Non-command read-only inspection used file reads, globs, and regex search over manifests, AGENTS/CONTEXT, CI, docs package metadata, config files, and local agent/QA artifacts.

## Mode decision

**Mode selected: `audit-only`.**

Reasoning under upgraded Mode Router:

- The assignment explicitly requested read-only validation and a mini audit/spec-preview report, not repository writes.
- The repository is not greenfield: it has TypeScript source under `src/`, tests, workflows, package manifests, and docs.
- The repository already has root project memory: `AGENTS.md` and `CONTEXT.md` both exist and are tracked.
- Therefore `bootstrap` is not appropriate. If the user later authorizes edits, the write path should route to **incremental** for general hardening or **repair** for a matched failing signal such as phantom enforcement / missing verification matrix.

Repository classification: **Existing with project memory**, with **multi-surface / likely two-application denominator** (root product package plus docs app). Large-refactor overlay: **not active** from the sampled evidence; ADRs and migration history exist, but no current refactor contract/source-of-truth oracle was observed.

## Application discovery and denominator

Per `agent-readiness-criteria.md`, applications are identified before scoring and the same denominator is kept for every application-scope criterion.

`APPLICATIONS_IDENTIFIED: 2`

1. `.` — root TypeScript CLI/library/daemon package `@cexll/swe-agent`; publishes `dist`, exposes `bin.sweagent`, has Bun scripts for build/typecheck/test/format and CI.
2. `docs/` — separate private Next/Fumadocs documentation app with its own `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.mjs`, app routes, and independent `dev/build/start` lifecycle.

Denominator reasoning:

- Root package is deployable/publishable and includes runtime daemon/operator flows, not just a shared library.
- `docs/` is separately buildable and runnable (`next dev`, `next build`, `next start`) and has its own lockfile/configs, so it should not be hidden inside the root denominator.
- Shared `.agents/`, `.sweagent/`, `scripts/`, `src/templates/`, and ADR/content directories are not counted as separate apps.
- For a full audit, every application-scope row should use denominator `N=2`; do not give root-only tooling full application-scope credit if docs lacks an equivalent check.

## Evidence summary

Observed stack and command surface:

- Root `package.json` has scripts: `build`, `test`, `typecheck`, `format`, `format:check`, `qa:e2e:*`, `deploy*`, `sweagent`, and sandbox smoke-ish scripts (`test-podman`, `test-vercel`, `test-interactive`).
- Root package manager is pinned as `bun@1.3.14`; observed `bun --version` matched `1.3.14`.
- Root `tsconfig.json` has `strict: true`, `noUncheckedIndexedAccess: true`, `noEmitOnError: true`.
- Root `vitest.config.ts` discovers `src/**/*.test.ts`; many `src/*.test.ts` files exist.
- Root `.prettierrc` exists and root scripts wire Prettier check/write.
- CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`, `bun run build`, and `bun run test` on pushes to `main`.
- Release workflow builds and uses Changesets publish.
- `.husky/pre-commit` runs `npx lint-staged`; `lint-staged.config.mjs` runs Prettier write on staged JS/TS/JSON/MD files.
- No root `justfile`, `Makefile`, or `constraints.yaml` was found.
- No `.pre-commit-config.yaml`, CODEOWNERS, PR template, issue template, Dependabot, or Renovate config was found by scoped glob.
- Root `.gitignore` ignores `node_modules`, `dist`, `.env.*` with `.env.example` exception, `.vercel`, `.agents/`, `.claude/settings.local.json`, `.claude/worktrees/`, `.sweagent-daemon-e2e/`, `docs/.next`, and `docs/.source`.
- Root `.env.example` was not found; `.sweagent/.env.example` exists.
- `docs/package.json` only defines `dev`, `build`, and `start`; no docs-local lint/typecheck/test/format scripts were observed.
- `docs/tsconfig.json` has `strict: true` and `noEmit: true`, but no observed selected-entry command runs docs typechecking independently unless `next build` covers it.

Project memory quality:

- `AGENTS.md` is substantial and specific: project overview, source-of-truth links, architecture/data flow, key directories, commands, conventions, important files, runtime/tooling preferences, testing/QA.
- `CONTEXT.md` is substantial and domain-specific: glossary, prohibited aliases, trust/security/platform language, state terminology.
- `AGENTS.md` does not contain formal upgraded sections named `## Verification Matrix`, `## Enforcement Index`, or `## Source of Truth & Refactor Contract`.

Previous readiness report:

- No `.agent-readiness/*` or `docs/agent-readiness-report*` was found in scoped lookup.
- A full audit should state “no previous report found” rather than inventing score deltas.

## Mini control-plane audit

| Layer | Status | Evidence / gap |
|---|---|---|
| Memory | Covered | Root `AGENTS.md` and `CONTEXT.md` exist, are tracked, and contain project-specific architecture, command, glossary, and invariant information. |
| Invariant | Partial | TypeScript strictness and Prettier are configured; build has public type leak guard. No ESLint/Biome lint, no dead-code/duplicate-code gate, no `constraints.yaml` baseline/ratchet. |
| Protocol | Partial | README/AGENTS list workflows; `.agents/commands` and `.agents/skills` exist locally; agent GitHub workflows exist. No PR/issue templates or formal task ownership protocol for broad multi-agent work found. |
| Permission | Partial | AGENTS and CONTEXT document trusted-automation boundaries, protected merge target concept, Docker/OMP boundary, no global CLAUDE.md. External enforcement such as branch protection/rulesets cannot be verified locally. |
| Sensorium | Partial | Root has many Vitest tests and QA evidence harness commands. Docs app lacks observed test/typecheck/format selected-entry coverage; runtime smoke is represented by QA/e2e harness but not as a formal Verification Matrix. |
| Evaluation / GC | Partial | Build guard checks public `.d.ts` effect-free; QA evidence bundles exist. Missing observed dead-code, duplicate-code, stale-doc, guardrail self-test, and violation baseline mechanisms. |
| Governance | Informational / Partial | Agent workflows and local skills show agentic development. Governance controls like branch protection, label taxonomy state, issue health, required CI, and external access policies require authenticated GitHub evidence; local text alone must not mark them complete. |

## AGENTS.md constraint-dimension audit

| Dimension | Present? | Quality | Location / note |
|---|---|---|---|
| Glossary | Yes | Strong, domain-specific, with avoid-aliases | `CONTEXT.md` |
| Dependency rules | Partial | Layer split and template-import rule are documented; no mechanical import-boundary config observed | `AGENTS.md`, `docs/adr/0009-*` |
| Error model | Partial | Domain states and blocked/unsafe/canceled language are defined; no universal error envelope/check observed | `CONTEXT.md`, source likely contains error types |
| Naming conventions | Partial | Domain terms and import suffix conventions are documented; no lint rule enforcement observed | `AGENTS.md`, `CONTEXT.md` |
| Doc freshness rules | Partial | AGENTS says update README/changesets for public behavior; no stale-doc check observed | `AGENTS.md`, README |
| State model references | Yes | SWEAgent run/attempt/status/ledger concepts are well-defined | `CONTEXT.md` |
| Implicit dependencies | Partial | Env vars, credentials, Docker/OMP/GitHub boundaries are documented; no machine-readable dependency registry observed | README, `CONTEXT.md`, `.sweagent/.env.example` |

## No-phantom-enforcement observations

The upgraded no-phantom-enforcement checks would be useful here because the repo has many real commands but lacks the formal resolver sections that eng-init now expects.

Positive observations:

- Most commands named in `AGENTS.md` root Development Commands resolve to root `package.json` scripts or existing files: `bun run build`, `typecheck`, `test`, `format:check`, `format`, `qa:e2e:check`, `qa:e2e:validate`, `sweagent`, `test-podman`, `test-vercel`, `test-interactive`, `.sweagent/sweagent.ts`, and `.sweagent/docker-controller.sh`.
- `AGENTS.md` explicitly says no root ESLint/Biome config exists, so it is not falsely claiming ESLint/Biome enforcement.
- CI really invokes build and test.
- Husky/lint-staged really exists and formats staged files.

Phantom/partial-risk observations:

- There is no formal `## Verification Matrix`; future repair should not render matrix rows unless each row resolves to an actual package script/entrypoint.
- There is no formal `## Enforcement Index`; future repair should not claim enforcement for rules that are currently prose-only.
- `bun run typecheck`, `bun run format:check`, and `bun run qa:e2e:*` exist, but CI sample only runs build and test. Unless another workflow covers them, they are configured/runnable but not blocking in CI.
- `prepare: husky` and `.husky/pre-commit` exist, but pre-commit only runs Prettier write via lint-staged; it does not block typecheck/tests/dead-code/security.
- Docs app has its own build command but no observed docs typecheck/test/format selected-entry rows. A full audit should not award docs app root-equivalent credit without a command that covers it.
- `sweagent init` / `sweagent docker build-image` / `sweagent docker remove-image` are named as operator commands; these depend on the built/installed CLI path. They should be listed as operator commands or prerequisites, not matrix validation rows, unless resolved through a real selected-entry target.
- External controls such as branch protection, required checks, repository secrets, issue labels, and backlog health cannot be proven from local files.

Repair-preview guidance for phantom enforcement:

1. Prefer adding/repairing one selected command surface first, e.g. root package scripts such as `check`, `check:docs`, `smoke`, and `test-guardrails`, rather than inventing a justfile beside existing Bun conventions.
2. Then rewrite/repair only the generated/hot sections of `AGENTS.md`: Verification Matrix, Enforcement Index, Readiness Gaps.
3. Mark configured-but-not-blocking tools as partial credit until CI/pre-commit/required checks prove they block.
4. Do not claim lint, dead-code, duplicate-code, coverage, branch protection, or docs-app test coverage until real configs and commands exist.

## External/governance non-fake-fix statement

The upgraded repair concepts correctly prevent fake fixes for this repo. The following signals are Class D or product/governance-adjacent and must not be marked complete by local docs alone:

- GitHub branch protection / rulesets and required status checks.
- Repository secrets / secret scanning settings beyond local config.
- Issue label system and backlog health.
- Deployment frequency, rollout, rollback, and production governance.
- Privacy/compliance/product analytics/ops dashboards.
- Whether agent GitHub workflows are approved, safe, and required/non-required in the actual repository settings.

A repair report should state the exact external prerequisite, e.g. authenticated `gh api` evidence for rulesets/branch protection or repository settings access. Without that evidence and explicit permission, these remain pending/manual, not locally fixed.

## Actionable spec-preview if edits were later authorized

This is not a write plan executed in this validation. It is a concise preview of likely incremental/repair work:

1. **Mode:** `incremental` if hardening broadly; `repair` if the user asks for one signal such as verification matrix or phantom enforcement.
2. **Application catalog:** Freeze `APPLICATIONS_IDENTIFIED: 2` (`.`, `docs/`) before scoring.
3. **Selected entrypoint:** Keep Bun/package scripts as the selected command surface unless the user wants a justfile; avoid adding a second convention unnecessarily.
4. **First repair target:** Add a real `check` script only if it runs existing meaningful commands and includes docs coverage intentionally. Do not create a command that silently skips docs or weakens root checks.
5. **AGENTS repair:** Add a compact Verification Matrix and Enforcement Index with only rows that resolve to scripts/config/files. Preserve existing project-specific architecture and domain sections.
6. **Guardrail repair:** Add a guardrail self-test only when it can inject a real violation and prove the configured guard rejects it. Do not add an echo-PASS script.
7. **Docs app:** Decide whether docs is in the default `check` path. If yes, wire `docs` build/type validation through a root script. If no, record docs as a separate app with explicit readiness gaps.
8. **External controls:** Leave GitHub governance settings as manual/API prerequisites unless authenticated access is explicitly authorized.

## Skill feedback

Positive feedback from this real-project validation:

- Mode Router correctly prevents bootstrap writes when `AGENTS.md` and `CONTEXT.md` already exist and the user requested read-only validation.
- The application-discovery-first rule is important; without it, root tooling would hide the docs app denominator.
- The no-phantom-enforcement rule catches the exact ambiguity this repo has: many useful commands and prose rules exist, but no formal matrix/index ties each claim to blocking enforcement.
- Fixability classes are helpful: local AGENTS/command repairs are safe candidates, while branch protection and governance must remain pending without external evidence.

Potential skill improvement:

- The audit criteria could explicitly call out documentation sites nested under `docs/` with their own package/lockfile as likely separate applications unless they are static content only. That would reduce denominator ambiguity in common TypeScript repos.
- The report format could include a short “configured/runnable/blocking” three-state command table for each app. It would make configured-but-not-blocking partial credit more transparent than a binary pass/fail checklist.

## Verdict

The upgraded eng-init behavior is directionally sound on `swe-agent` in read-only mode. It routes to audit-only, discovers a stable application denominator before scoring, avoids fake external/governance fixes, and would produce actionable repair slices instead of a monolithic checklist. The highest-value future repair slice is a real selected-entry Verification Matrix / Enforcement Index pass that resolves existing commands and marks CI/pre-commit/governance gaps honestly.
