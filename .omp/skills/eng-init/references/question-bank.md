# Question Bank — Stage 2 Grilling

This bank powers Stage 2 of the eng-init skill. Eight dimensions, ordered to minimize backtracking. Each question has: prompt, recommended default, skip condition, branches, and decision impact.

Core mapping: project operating rules and validation decisions render into `AGENTS.md`; domain language, bounded contexts, invariants, and terminology conflicts render into `CONTEXT.md`. Do not route project memory through `CLAUDE.md`.

## Rules of engagement

- **One question at a time.** Wait for the answer before asking the next.
- **Ask via the structured question tool when available.** If the harness provides `AskUserQuestion`, use it for every grill question: 2–4 concrete options, recommended option first with "(Recommended)" appended to its label, trade-offs in the option descriptions. Fall back to plain-text questions only when the tool is unavailable.
- **The strictness profile is never skipped and never defaulted.** Q1.4 must be asked explicitly in every grilling run, regardless of question budget. Every other question may be skipped or defaulted; this one may not — it sets the meaning of every subsequent default.
- **Skip aggressively.** If Stage 0 scan answered it, confirm in one line instead of asking ("I see Go 1.22 — pinning to 1.22 or take latest stable?") rather than re-asking.
- **Recommend, don't interrogate.** Every question carries a profile-keyed default (see the Strictness Profile table under Q1.4). If the user gives a one-word reply or a shrug, take the default **for the chosen profile** and move on.
- **No silent downgrades.** Once the profile is chosen, any decision weaker than the profile default — skipping a guardrail the profile requires, lowering a threshold, warn where the profile says block — must be explicitly confirmed with the user and recorded in the decision ledger as a downgrade. Never default into a downgrade.
- **Capture verbatim where it matters.** Project identity and operating constraints the user phrases themselves should be quoted in `AGENTS.md`; domain terms and invariants should be quoted in `CONTEXT.md`, not paraphrased.
- **No phantom verification.** Questions in Dimensions 7–8 map to the AGENTS.md `## Verification Matrix` and observability artifacts. A matrix row may only be rendered if its command resolves to the selected dev entry point (`justfile`, `Makefile`, or `package.json` script) in the write set — never name a verification surface without the target/script that exercises it.
- **Summarize between dimensions.** After each dimension closes, state the running tally ("Captured 6 constraints so far. Moving to test discipline.").

If the user wants to stop mid-grill, stop. Stage 3 can render whatever is captured — but if Q1.4 was not yet answered, ask it before rendering; the partial spec is meaningless without a strictness profile.

---

## Budget & prioritization

The bank holds ~52 questions. The per-run budget is **20 asked questions**. Q1.4 is exempt (always asked). Q1.4b is exempt from the budget count when triggered. Q9.2 and Q9.6 are exempt when the large-refactor overlay is active. Everything else resolves via Stage 0 scan inference and profile defaults unless a detected gap promotes a question to asked.

**Per-mode core sets** — ask these first, in order. All other questions resolve via scan inference + profile defaults unless a gap is detected that promotes them.

- **greenfield**: Q1.1, Q1.2, Q1.4, Q2.1b (language), Q2.3 (framework), Q3.1 (layering), Q4.1 (TDD), Q5.2 (anti-drift), Q7.6 (critical paths), Q1.6 (domain seed).
- **bootstrap**: Q1.1 (confirm), Q1.4, Q1.4b (when triggered), Q5.2, Q7.1 (health), Q7.2 or Q7.3 (dominant surface), Q7.6, Q6.6 (out-of-bounds).
- **incremental**: Q1.4 (confirm or set), Q1.4b (when triggered), then only questions generated from failing readiness criteria, highest impact first — Code Canonicality > Conventions/Enforcement > scoped sections. If the large-refactor overlay is active, ask Q9.2 and Q9.6 before Stage 3.
- **audit-only**: no grilling.

**Prioritization rule**: Dimension 7 core questions (Q7.1 / Q7.2 / Q7.3 / Q7.6) outrank Dimension 5 pillar fine-tuning at L2+ — runtime verification beats release polish when budget is tight.

**Budget exhaustion**: if the budget runs out before all promoted questions are asked, list the unasked questions in the Stage 3 spec as open items with their profile defaults applied.

---

## Dimension 1 — Identity & Lifecycle

These shape how strict every subsequent constraint should be.

### Q1.1 — What is this project?

> "In one sentence: what does this project do, and who is it for?"

- **Why**: A throwaway script and a public SDK need very different constraints; this single sentence biases everything downstream.
- **Skip if**: README has a clear one-liner — confirm it ("README says X. Still accurate?").
- **No branches** — capture the user's wording verbatim for the AGENTS.md `Project Identity` section.

### Q1.2 — Lifecycle expectation

> "How long is this expected to live: weeks (prototype), months (MVP), years (production), or maintained-forever (library/SDK)?"

- **Default**: `months/MVP` if unsure.
- **Decision impact**: sets the **recommended** strictness profile for Q1.4 (`weeks` → L1, `months` → L2, `years` → L3, `library/SDK` → L4). Lifecycle never decides strictness by itself — the user confirms or overrides at Q1.4.
- **Branches**:
  - `library/SDK` → additionally: strict semver, doc generation required, deploy pillar minimal, release pillar critical.

### Q1.3 — Team size

> "Solo, small team (2–5), large team (>5), or public OSS?"

- **Default**: `small team`.
- **Branches**:
  - `solo` → branch protection optional, PR review optional, single-author commit style allowed.
  - `small team` → branch protection on `main`, CODEOWNERS optional.
  - `large team` → branch protection required, CODEOWNERS required, PR template strict, issue templates required.
  - `public OSS` → all of `large team` plus CONTRIBUTING reference, security policy, code of conduct (out of scope for this skill but noted).

### Q1.4 — Constraint strictness profile (MANDATORY — never skip, never default)

> "How strict should this repo's engineering constraints be? Based on lifecycle (`{{LIFECYCLE}}`) and team size (`{{TEAM_SIZE}}`) I recommend **{{RECOMMENDED_PROFILE}}**."

Ask via `AskUserQuestion` with all four profiles as options, recommended profile first. Each option's description must enumerate concretely what that profile turns on — the user is choosing a contract, not a label.

**Recommendation rule**: `weeks/prototype` → L1; `months/MVP` → L2; `years/production` → L3; `library/SDK`, regulated domain, or `large team`/`public OSS` → L4. The lifecycle answer only sets the recommendation; the user decides the profile.

**Agent-heavy adjustment**: when most code is written by AI agents (Q1.5 names agents as the primary contributors, or the scan shows agent-authored history), raise the recommendation one level. Agents comply with enforced gates far more reliably than with prose conventions, and "that's a lot of work to set up and satisfy" stops being a cost argument when agents do the labor. What stays scarce is human review attention — so mechanized gates that keep bad changes out of review pay for themselves. Say the reason aloud when recommending; the user still decides.

#### Strictness Profile table (canonical — all profile-keyed defaults below resolve here)

| Control | L1 prototype | L2 standard | L3 strict | L4 maximal |
|---|---|---|---|---|
| Max file lines | 1000 / warn | 900 / block | 800 / block | 700 / block |
| Max cyclomatic complexity | 30 / warn | 20 / block | 15 / block | 10 / block |
| Coverage gate | none | 70% / block | 80% / block | 90% / block |
| Duplicate-code threshold | 10% / warn | 5% / block | 3% / block | 2% / block |
| Dead-code detection | warn | block (CI) | block (pre-commit + CI) | block (pre-commit + CI) |
| Naming guard + scratchpad guard | block-commit | block-commit | block-commit | block-commit |
| TDD mode | none | preferred | required | required |
| Integration tests | optional | testcontainers default | required (real DB) | required (real DB) |
| E2E tests | skip | nice-to-have | required if UI/API surface | required |
| Structured logging | optional | optional | required | required |
| Distributed tracing + metrics | skip | skip | optional | required |
| Contract tests (Pillar 4/4a) | skip | optional | required | required + semver gate |
| CI strategy | minimal | risk-layered | risk-layered | risk-layered |
| Secret scanning | optional | pre-commit | pre-commit + CI block | pre-commit + CI block |
| SAST (Semgrep/CodeQL) | skip | optional | required (CI block) | required (CI block) |
| Branch protection | skip | protect `main` | + required status checks | + required review + linear history |
| Mutation testing | skip | skip | optional (scheduled) | required (scheduled) |
| Release pipeline | skip | manual tags | automated | semantic-release / changesets |
| PR diff limit (400 lines) | none | review-only (PR template) | CI-enforced (diff-size guard) | CI-enforced (diff-size guard) |

Enforcement vocabulary used above and in the Enforcement Index: `advice` (prose only) < `review-only` (human checklist) < `warn` (tool reports, does not fail) < `block` (fails pre-commit or CI) < `gate` (server-side merge requirement). A profile cell names the **minimum** level; users can ratchet up freely, but going below it is a downgrade requiring explicit confirmation.

- **Capture**: chosen profile → `constraints.yaml` `strictness_profile`, AGENTS.md `Project Identity`, and the decision ledger. All subsequent question defaults resolve against this column.
- **Branches**: none — but if the user picks a profile lower than recommended, confirm once ("L1 on a years-lifecycle repo means no coverage gate and warn-only size limits — confirm?") and record their reasoning.

### Q1.4b — Legacy violation disposition (bootstrap/incremental only)

> "Stage 0 found pre-existing violations against the {{PROFILE}} gates: {{OVERSIZED_FILE_COUNT}} oversized files, {{DUPLICATE_BLOCK_COUNT}} duplicate blocks, {{DEAD_CODE_COUNT}} dead-code findings, coverage {{CURRENT_COVERAGE}}% vs the {{COVERAGE_GATE}}% gate. How should legacy violations be handled?"

- **Ask only when**: mode is `bootstrap` or `incremental` AND the Stage 0 scan found pre-existing violations against the chosen profile's gates. Otherwise skip silently.
- **Hard rule**: without an answer to this question, block-level gates MUST NOT be enabled on a violation-laden repo — they would fail every commit from day one and train users to bypass hooks.
- **Branches**:
  - `freeze-baseline` (Recommended) → commit a baseline snapshot using the stack's tool-native mechanism: `golangci-lint` `new-from-rev`, jscpd/ESLint baseline count ceilings, ruff `per-file-ignores`. New and changed code must meet the profile's gates in full. Baseline counts are recorded in `constraints.yaml` under `baseline` and may only decrease — CI fails on any increase. Schedule a ratchet reduction per milestone (e.g., -20% per milestone).
  - `fix-now` → only sane for small counts. Warn explicitly: mass auto-fixing legacy violations is itself a drift risk — large mechanical diffs hide regressions and destroy blame history. If counts are large, steer back to `freeze-baseline`.
  - `downgrade-profile` → drop to a profile whose gates the repo currently passes. Recorded as an explicit downgrade in the strictness ledger with the user's stated reason.
- **Capture**: disposition → decision ledger; baseline counts + frozen rev → `constraints.yaml` `baseline`; readiness criterion `violation_baseline_tracked`.

### Q1.5 — Primary AI tooling

> "Which AI coding tools will agents on this repo use: Claude Code, Cursor, Aider, Factory Droid, Codex CLI, others?"

- **Default**: assume Claude Code and Cursor at minimum.
- **No branches** — answer determines which agent-rules files might co-exist. The skill always writes `AGENTS.md`; if the user mentions Cursor specifically, note in AGENTS.md that `.cursorrules` should point back to AGENTS.md, not duplicate it.

### Q1.6 — Domain language seed

> "What are the 3–5 core domain terms this repo must use consistently? If you're unsure, name the concepts that agents often confuse."

- **Default**: if README/source reveals obvious terms, propose them and ask for confirmation.
- **Capture**: render confirmed terms into `CONTEXT.md` `## Domain Language`; render uncertain terms into `## Open Terminology Questions`.
- **Branches**:
  - User gives terms + meanings → write them verbatim.
  - User gives concepts without definitions → ask one follow-up for the highest-risk term only; mark the rest open.
  - User says "none / technical repo" → create a minimal `CONTEXT.md` with Project Identity and note that no domain glossary is required yet.

---

## Dimension 2 — Stack & Versions

Confirm Stage 0 detections, then drill into versions, lockfile policy, and framework choices.

### Q2.1 — Confirm primary language and version

> "I see `<detected>` from `<file>`. Pinning to `<version>` or take latest stable?"

- **Skip if**: no language marker detected — go to Q2.1b.
- **Default**: pin to current detected version.

### Q2.1b — No language detected, declare

> "No language markers found. Which language are you starting with?"

- **No default** — must be answered before proceeding.
- **Branches**: route to language-specific follow-ups in Q2.3+.

### Q2.2 — Lockfile policy

> "Commit lockfile (`package-lock.json` / `poetry.lock` / `Cargo.lock` / `go.sum`)?"

- **Default**: yes, always commit.
- **Branches**:
  - `yes` → AGENTS.md Stack section says "lockfile committed; agents must run `<install command>` after pulling and never bypass it".
  - `no` (library only) → AGENTS.md notes "lockfile intentionally not committed; consumers control resolution".

### Q2.3 — Framework / runtime

Language-conditional. Examples:

- **TypeScript**: "React, Next.js, Vue, raw Node, or framework-less?"
- **Python**: "FastAPI, Django, Flask, or framework-less (scripts/library)?"
- **Go**: "Gin, Echo, kratos, chi, net/http, or framework-less (CLI/library)?"
- **Rust**: "Axum, Actix, Tower, or framework-less (CLI/library)?"
- **Java**: "Spring Boot, Quarkus, Micronaut, or framework-less?"

- **Default**: detect from `package.json` / `go.mod` / `pyproject.toml` dependencies; ask only to confirm.

### Q2.4 — Persistence

> "Database/persistence: which? (Postgres, MySQL, SQLite, MongoDB, Redis, none)"

- **Default**: detect from compose files / env templates / dependencies.
- **Follow-up if database present**: "ORM choice: native driver, Prisma, TypeORM, SQLAlchemy, GORM, Diesel, sqlx, JPA, none?"

### Q2.5 — Dependency update policy

> "Renovate / Dependabot, with a minimum release age (e.g., 3 days) to avoid newly-published bad releases — yes or skip?"

- **Default**: `Renovate with 3-day minimum release age`.
- **Decision impact**: addresses readiness criteria `dependency_update_automation` + `min_release_age`.

---

## Dimension 3 — Architecture Style

These decisions decide the Directory Map and Module Boundaries sections.

### Q3.1 — Layering style

> "Layering: flat, layered (presentation/business/data), hexagonal/ports-and-adapters, clean architecture, DDD bounded contexts, or other?"

- **Default**: `layered` for small services; `DDD bounded contexts` if user mentions domain modeling.
- **Branches**:
  - `flat` → no module boundary enforcement; AGENTS.md Directory Map is short.
  - `layered` → directory naming reflects layers; one-way imports rule documented.
  - `hexagonal/clean` → `internal/` (Go) or import-linter (Py) / dependency-cruiser (TS) configured.
  - `DDD bounded contexts` → load `references/ddd-tdd-clauses.md`, ask Q3.2.

### Q3.2 — DDD strength (only if Q3.1 chose DDD)

> "DDD strength: aware (use terms in code) or strict (bounded contexts enforced by lint and reviewed in PRs)?"

- **Default (profile-keyed)**: L1–L2 → `aware`; L3–L4 → `strict`.
- **Branches**:
  - `aware` → ubiquitous-language section in AGENTS.md, no automated enforcement.
  - `strict` → import boundaries enforced by tooling; aggregate-root rules documented; anti-corruption layer required between contexts.

### Q3.3 — Monorepo confirmation

> "I see `<apps/|packages/|services/|go.work|workspace lockfile>`. Multiple deployable apps, or a single app with helper packages?"

- **Skip if**: no monorepo markers detected — answer is "single app".
- **Branches**:
  - `multiple deployable apps` → each app gets its own `AGENTS.md` (module-level); root AGENTS.md indexes them.
  - `single app + helpers` → only root AGENTS.md; helper packages mentioned in Directory Map.

### Q3.4 — Module ownership (only if monorepo or large team)

> "CODEOWNERS at file path level — yes or skip?"

- **Default**: `yes` for large team / OSS; `skip` for small team.

---

## Dimension 4 — Test Discipline

Be concrete. Coverage thresholds and integration-test reality are where projects rot fastest.

### Q4.1 — TDD strictness

> "TDD: none, preferred (recommended but not required), or required (no merge without a failing test first)?"

- **Default (profile-keyed)**: L1 → `none`; L2 → `preferred`; L3–L4 → `required`. Choosing below the profile default is a downgrade — confirm explicitly.
- **Branches**:
  - `none` → AGENTS.md Test section just states "tests required for non-trivial changes; not TDD".
  - `preferred` → AGENTS.md says "TDD is the default workflow; deviations should be justified in the PR description".
  - `required` → load TDD clause from `references/ddd-tdd-clauses.md`; pre-commit hook enforces "tests must exist for changed files".

### Q4.2 — Coverage threshold

> "Minimum line coverage: none / 50% / 70% / 80% / 90%+?"

- **Default (profile-keyed)**: L1 → `none`; L2 → `70%`; L3 → `80%`; L4 → `90%`. CI gate is `block`, not warn, at L2+.
- **Decision impact**: CI gate config; AGENTS.md Conventions section lists the threshold.
- **Strong form (L3+, optional)**: per-file 100% gate — the gate fails on any file under 100%, and an uncovered line is treated as a dead-code candidate for deletion, not a missing test to bolt on. Line coverage is necessary, never sufficient; offer this as an option when the repo's test discipline is already strong. Feeds criterion `coverage_per_file`.

### Q4.3 — Integration test reality

> "Integration tests run against: real DB (test instance / testcontainers), in-memory replacement, mocks, or no integration tests yet?"

- **Default (profile-keyed)**: `testcontainers` if DB present (L2+; at L3–L4 `mocks` and `none yet` are downgrades requiring confirmation); L1 → `no integration tests yet` is acceptable.
- **Branches**:
  - `real DB` / `testcontainers` → AGENTS.md says "integration tests use a real DB via testcontainers / docker-compose; mocking the DB is a CI failure".
  - `in-memory` → note the trade-off explicitly: "in-memory DB is intentional; specific incompatibilities with prod listed in `docs/known-divergences.md`".
  - `mocks` → flag this as risky; AGENTS.md should say "DB is mocked — mock contracts must be reviewed monthly to catch drift".
  - `none yet` → AGENTS.md says "no integration tests at the time of writing; this is a gap to close before <milestone>".

### Q4.4 — End-to-end tests

> "E2E required, nice-to-have, or skipped?"

- **Default (profile-keyed)**: L1 → `skipped`; L2 → `nice-to-have`; L3–L4 → `required`.
- **Skip if**: backend-only library/CLI (no UI surface).

---

## Dimension 5 — Engineering Pillars

Walk through the six pillars from `references/eng-pillars.md`. For each, ask one question.

### Q5.1 — Pillar 2: Dev entry point

> "Unified dev entry: `just` (recommended), `make`, npm scripts only, or skip?"

- **Default**: `just` if not already present; `make` if `Makefile` exists; npm/pnpm/yarn package scripts if the repo already uses package scripts as its command surface; respect existing convention.
- **Decision impact**: selected entry-point templates/patches loaded from `references/aux-file-templates.md`; all later command placeholders (`{{CHECK_CMD}}`, `{{SMOKE_CMD}}`, `{{DEV_STATUS_CMD}}`, `{{VERIFY_UI_CMD}}`, etc.) resolve against this entry point.

### Q5.2 — Pillar 3: Custom lints

> "Beyond default lint rules, do you want anti-drift lints: stack-specific duplicate-code detection, stack-specific dead-code/unused-export detection, and naming-pattern guards (reject `_v1`/`_v2`/`_new`)?"

- **Default**: `yes — all three`, at every profile. This is the central anti-drift toolchain.
- **Why mandatory-feeling default**: this directly defends against the v1/v2/v3 problem.
- **Branches**:
  - `yes` → wire into pre-commit + CI at the profile's enforcement level (warn at L1, block at L2+); AGENTS.md Enforcement Index lists each.
  - `subset` → ask which; at L3–L4 each dropped tool is a downgrade — confirm explicitly.
  - `skip` → at L1–L2 flag clearly: "Skipping anti-drift lints means relying on review discipline alone." At L3–L4 this is a downgrade — confirm explicitly and record in the strictness ledger.

### Q5.2b — Generated-file exemptions (follow-up to Q5.2)

> "Stage 0 flagged these candidate paths for exemption from size/complexity gates: {{CANDIDATE_EXEMPTIONS}}. These look like generated code (protobuf stubs, GraphQL types, vendored libs). Exempt them from the relevant checks, or keep them under the same gates?"

- **Ask only when**: Stage 0 scan found paths matching common generated-code patterns (`*.pb.go`, `*.gen.ts`, `vendor/`, `generated/`, `__generated__/`).
- **Default**: exempt generated paths from `size_limits` and `duplicate_code_detection` — these are not human-authored and cannot be practically refactored. Keep `naming_guard` and `dead_code_detection` active (a generated file with `_v2` suffix or an unused generated import still signals drift).
- **Branches**:
  - `exempt-all-candidates` (Recommended) → write the candidate list into `constraints.yaml` `exemptions` with `reason: "Generated code — not human-authored"`, `expires: never`, and `exit_condition: "none"` (structural exemption; non-structural exemptions must name a real exit condition).
  - `review-subset` → confirm each path individually.
  - `no-exemptions` (L3–L4) → flag: generated files that exceed size gates will fail CI on every commit. This is a deliberate choice — the overhead of constant CI failure may train the team to ignore CI failures.
- **Capture**: final exemptions list → `constraints.yaml` `exemptions`.

### Q5.3 — Pillar 4: Contract testing

> "API/protocol schemas committed (OpenAPI, GraphQL schema, Protobuf) — yes, no, or N/A (no API)?"

- **Skip if**: CLI tool, library, or no external interface.
- **Default (profile-keyed)**: `yes` if HTTP/RPC service at L2+; at L3–L4 `no` is a downgrade — confirm explicitly.
- **Follow-up if yes**: "Schema snapshot tests in CI (so unintended changes show as diffs in PRs)?"

### Q5.3 follow-up — Non-API contracts (only if Q5.3 answered "N/A" or "no API")

> "This project has no HTTP API, but its public interface (exported types, CLI args, component props) is still a contract other consumers depend on. Snapshot-test the public surface so unintended changes fail CI — yes or skip?"

- **Default**: `yes` for libraries and shared components; `skip` for standalone apps with no external consumers.

### Q5.4 — Pillar 5: CI strategy

> "CI strategy: minimal (lint + test on push), risk-layered (fast checks first, slow tests gated by path filters), or skip CI?"

- **Default (profile-keyed)**: L1 → `minimal`; L2–L4 → `risk-layered`; never `skip`.
- **Decision impact**: `.github/workflows/ci.yml` template selected. At L3–L4 the PR diff-size guard step is included (see Q1.4 table).

### Q5.5 — Pillar 6: Release pipeline

> "Releases: manual tags, semantic-release (auto from conventional commits), changesets, or no formal release process?"

- **Default (profile-keyed)**: L1 → `no formal release`; L2 → `manual tags`; L3 → automated (tag-triggered + release-please); L4 → `semantic-release`/`changesets`.
- **Skip if**: prototype or internal tool with no consumers.

### Q5.6 — Security & merge gates (confirm profile defaults)

> "Your profile ({{PROFILE}}) sets: secret scanning {{SECRET_SCAN_LEVEL}}, SAST {{SAST_LEVEL}}, branch protection {{BRANCH_PROTECTION_LEVEL}}, mutation testing {{MUTATION_LEVEL}}. Keep all, or adjust?"

- **Default**: keep all profile defaults (see Q1.4 table). This is a confirmation question, not an open menu — one answer covers all four.
- **Branches**:
  - `keep` → wire gitleaks/Semgrep/branch-protection per profile; branch protection that cannot be set by file (server-side) is recorded in the Enforcement Index as `gate — documented external setting` with the exact `gh` command to apply it.
  - `adjust` → ask which control; any reduction below profile level is a downgrade — confirm explicitly and record.

---

## Dimension 6 — Agent Operating Boundaries

The final dimension. Tightens the agent-facing rules in AGENTS.md.

### Q6.1 — Conventional commits

> "Enforce conventional commits (`feat(scope): ...`, `fix(scope): ...`)?"

- **Default**: `yes`. This pairs with semantic-release and gives `git log` semantic structure that agents can read back.

### Q6.2 — Commit signing / co-authorship

> "Agent commits should be tagged with `Co-authored-by` and identify the agent?"

- **Default**: `yes`. Improves provenance.

### Q6.3 — Agent permissions

> "Agents may: (a) commit directly to feature branches, (b) only open PRs, (c) only suggest changes without committing?"

- **Default**: `(a) commit to feature branches; never to main`.
- **Branches**: route to Agent Operating Rules section content.

### Q6.4 — Scratchpad rule reinforcement

> "Explicitly forbid scratchpad directories (`tmp/`, `scratch/`, `_old/`, etc.) in commits via pre-commit hook?"

- **Default**: `yes`. The global Code Canonicality already says this, but the project hook makes it machine-enforced.

### Q6.5 — Memory boundary

> "Anything in this project that agents must NOT memorize or persist across sessions (e.g., specific customer data structures, internal-only APIs, secrets-adjacent patterns)?"

- **Default**: ask once; if user is unsure, capture "no special memory boundary" and move on. Avoid making this a deep philosophical conversation.

### Q6.6 — Out-of-bounds operations

> "Are there operations agents may never perform (DB destructive ops, prod deploys, force-push, dependency upgrades without review)?"

- **Default**: forbid prod deploys, force-push, and any `--no-verify` flag use. User can add to the list.

### Q6.7 — Common AI failure modes (feeds "Important Development Notes")

> "List 3 things AI-generated code commonly gets wrong in this codebase. Short, concrete rules please (preferred form: 'Do X, not Y (because Z)')."

- **Default**: if user is unsure, propose examples to validate (not to invent): dependency injection vs globals, correct wrapper libraries, test setup conventions, environment-variable handling, module boundaries, migration patterns, data validation, concurrency/async pitfalls, silent config degradation (env toggles that no-op on unexpected values; warn-and-continue on missing files), and self-report test evidence (transcript keyword probes instead of external state checks).
- **Capture**: save answers as `NOTE_1`, `NOTE_2`, `NOTE_3` (optionally `NOTE_4`, `NOTE_5`). These render into AGENTS.md `## Important Development Notes`.

### Q6.8 — Decision records (ask only at L3+ or when multiple AI tools / agents are named)

> "Should non-trivial decisions get a decision-record system — a four-zone tree (`proposed/` → `implemented/` → `rejected/` → `archived/`) classified by kind, with the rule that a non-trivial change ships its record in the same PR? For agent-heavy repos this is the main defense against re-debating settled questions and re-deriving lost rationale, and against notes that rot because nobody owns their lifecycle."

- **Options**: yes, full four-zone lifecycle (Recommended at L3+ multi-agent) / yes, minimal `decisions/` module / no, git history and PRs are enough.
- **Default**: skip entirely below L3 with a single tool — do not grill about it.
- **Capture**: on full lifecycle, add the scaffold from `decision-record-operations.md` to the write set (zones, kinds, README, archive-freeze rule, note-required rule, manifest/verify script once the tree has entries) and an AGENTS.md Agent Operating Rules line. On minimal, add `decisions/` scaffold from `aux-file-templates.md` § Decision records with the same-PR rule. Feeds criterion `decision_record_lifecycle`.


### Q6.9 — Incident pipeline (ask only at L2+ when the user mentions incidents/postmortems, or at L3+ with production users)

> "Should escaped defects get a postmortem contract? A small `docs/postmortem/README.md` fixes the rules before the first incident: when to write one (subtle + systemic + costly to rediscover), the section skeleton, and the requirement that every lesson lands as a named test/gate/rule — not just prose."

- **Options**: yes, install the contract skeleton (Recommended at L3+ with production users) / no, incidents stay in issue threads.
- **Default**: skip below L2; never install without an explicit yes — the skeleton is cheap but it is a standing promise.
- **Capture**: on yes, add the `docs/postmortem/README.md` skeleton from `incident-pipeline-templates.md` to the write set. Do not create a danger-patterns doc or an AGENTS.md read-before hook at install time — those are earned by ≥2 converging incidents. Feeds criterion `incident_pipeline`.

### Q6.10 — Repo-local skills (ask only at L2+ when an agent skills directory exists or the named agent tooling supports one)

> "Should procedural workflows that outgrow AGENTS.md — pre-push evidence selection, prose trimming, decision-record lifecycle — live as repo-local skills (`.claude/skills/`, `.agents/skills/`) that AGENTS.md points to in one line each?"

- **Options**: yes, install the applicable skill templates (Recommended for agent-heavy repos at L2+) / no, keep AGENTS.md prose only.
- **Default**: skip when no agent tooling with skill support is named; never install a skill whose trigger moment does not exist in this repo (empty-shell rule).
- **Capture**: on yes, select from `repo-skill-templates.md`: `pre-push-checks` and `prose-contract` at L2+; `decision-record-lifecycle` only when Q6.8 also selected decision records. Each installed skill gets its one-line AGENTS.md pointer in the section that owns the moment; every command a skill names must resolve to a real dev-entry target (no-phantom-enforcement applies to skill bodies).

### Q6.11 — Documentation discipline (ask only at L3+ when doc drift is observed or the user asks for docs governance)

> "Should documentation get mechanical discipline: a scripted doc gate in CI that fails on drift, the rule that docs change with code in the same change, mandatory Known Limitations sections on public surfaces, and generated catalogs that are regenerated never hand-patched?"

- **Options**: yes, install the documentation-discipline module (Recommended at L3+ with public surfaces or generated docs) / no, docs stay review-only.
- **Default**: skip below L3; never install without an explicit yes — the empty-shell rule applies (a doc gate with nothing to gate trains agents to ignore the layer).
- **Capture**: on yes, add the module from `documentation-discipline.md` to the write set: the doc-gate script wired into CI, the AGENTS.md clause, the Known Limitations allowlist. Docs themselves are never fabricated. Feeds criterion `documentation_gates`.

### Q6.12 — Agent-harness architecture clauses (ask only at L3+ when the repo is agent-facing — builds agent tooling, or its primary consumers are AI agents)

> "Should agent-facing architecture invariants — model-visible ⟺ logged, capability seams, registrations-as-effects, runtime invariant companions, branded cross-boundary ids — be added as Convention-level clauses in the Architecture Discipline section? For agent products these are the auditability and ownership rules static lint cannot see."

- **Options**: yes, install the clause set (Recommended at L3+ for agent-facing codebases) / no, keep architecture conventions review-only.
- **Default**: skip when the repo has no agent-facing surface; never install the clause set without an explicit yes — clauses without a codebase that exercises them are dead text.
- **Capture**: on yes, add the clauses from `agent-harness-architecture.md` to the AGENTS.md Architecture Discipline section; the runtime-invariant-companion pattern is scaffoldable (Class A/B) when the repo has a service/plugin architecture; the model-visible ⟺ logged clause is audited first (highest leverage). Feeds criterion `runtime_invariants`.

---

## Dimension 7 — Runtime Verification

Static gates prove code shape; runtime verification proves behavior. This dimension renders the AGENTS.md `## Verification Matrix` section and runtime command targets/scripts (`dev-bg`, `dev-stop`, `dev-status`, `logs`, `smoke`, `e2e`, `verify-ui`, `db-reset`, `seed`) through the selected dev entry point (`justfile`, `Makefile`, or `package.json` scripts). Largely skippable at L1 — offer the dimension once and accept a one-word decline; required at L2+, where the `## Verification Matrix` section is mandatory.

### Q7.1 — Health endpoint

> "Does the app expose a health endpoint (e.g., `GET /healthz`) that confirms the process is up and its dependencies are reachable?"

- **Default (profile-keyed)**: confirm the existing endpoint if Stage 0 detected one; L1–L2 → optional; L3–L4 → required.
- **Skip if**: no long-running process (library, CLI, batch script).
- **Branches**:
  - `exists` → Verification Matrix row: health → `{{DEV_STATUS_CMD}}`.
  - `none` at L3+ → recommend adding one as part of the write set (minimal `/healthz` handler + smoke check); declining is a downgrade — confirm and record.
  - `none` at L1–L2 → record the gap; `{{DEV_STATUS_CMD}}` falls back to a process-liveness check.
- **Decision impact**: `{{DEV_BG_CMD}}` / `{{DEV_STOP_CMD}}` / `{{DEV_STATUS_CMD}}` targets or scripts; `constraints.yaml` `verification` key; readiness criterion `dev_server_lifecycle_documented`.

### Q7.2 — Critical API routes for smoke tests

> "Name the 3–7 API routes whose failure means the app is broken (login, checkout, the main list endpoint). These become the smoke test set."

- **Default (profile-keyed)**: L1 → skip; L2 → recommended; L3–L4 → required.
- **Skip if**: no API surface.
- **Branches**:
  - routes named → render into smoke tests invoked by `{{SMOKE_CMD}}`, using the tooling chosen at Q7.5; routes recorded under `constraints.yaml` `verification`.
  - `can't name any` → propose candidates from detected route definitions; if still none, record the gap and skip the matrix row.
- **Decision impact**: readiness criterion `smoke_tests_exist`; Verification Matrix row: API → `{{SMOKE_CMD}}`.

### Q7.3 — Key UI routes to walk

> "Which UI routes must an agent walk after any UI change (e.g., `/login`, `/dashboard`, the primary flow)?"

- **Default (profile-keyed)**: L1–L2 → optional; L3–L4 → required when a UI exists.
- **Skip if**: no UI.
- **Branches**:
  - routes named → render into `{{VERIFY_UI_CMD}}` via the UI tooling chosen at Q7.5; UI success claims require screenshot + zero new console errors (evidence protocol).
  - declined at L3+ → downgrade — confirm explicitly and record in the strictness ledger.
- **Decision impact**: Verification Matrix row: UI → `{{VERIFY_UI_CMD}}`.

### Q7.4 — Deterministic seed data + db-reset

> "Ship deterministic seed data and a reset command (`{{DB_RESET_CMD}}`) that restores a known-good database state — yes or skip?"

- **Default (profile-keyed)**: L1 → optional; L2–L4 → yes.
- **Skip if**: no persistence layer (Q2.4 answered `none`).
- **Branches**:
  - `yes` → seed + db-reset targets/scripts in the write set; smoke/e2e runs start from `{{DB_RESET_CMD}} && {{SEED_CMD}}`; readiness criterion `seed_data_available`.
  - `skip` → smoke tests must be read-only or self-cleaning; record the gap. At L2+ this is a downgrade — confirm explicitly.
- **Decision impact**: `constraints.yaml` `environments` key (which tiers may be reset).

### Q7.5 — Verification tooling

> "Tooling — API smoke: hurl (Recommended) or curl scripts? UI: Playwright (Recommended) and/or agent-browser walk?"

- **Default (profile-keyed)**: `hurl` for API, `Playwright` for UI; L3+ may add an agent-browser walk as a complement, never as the only UI check.
- **Skip if**: Q7.2 and Q7.3 both skipped.
- **Decision impact**: selects templates from `references/agent-harness-templates.md`. Every chosen tool must be invoked by the selected entry point (`{{SMOKE_CMD}}` / `{{VERIFY_UI_CMD}}`) — a named tool with no target/script is phantom verification.

### Q7.6 — Critical paths enumeration

> "Which concrete directories or files are critical paths requiring human white-box review (auth, payments, permissions, data deletion, migrations, concurrency)? Name actual paths, not categories."

- **Default**: propose candidates from the Stage 0 scan (e.g., `src/auth/`, `migrations/`); the user confirms, edits, or extends.
- **Skip if**: never — at L1 a one-line "none yet" answer is acceptable and recorded as such.
- **Capture**: concrete paths verbatim — render into AGENTS.md `## Critical Paths` and into `CODEOWNERS` when Q3.4 enabled it.
- **Decision impact**: gray-box review policy gets explicit white-box boundaries; agents must flag any diff touching a critical path for human review.
---

## Dimension 8 — Observability

Production services need structured logs, traces, and metrics so agents and operators can diagnose failures without guessing. This dimension is largely skippable at L1–L2; at L3+ it becomes required, with L4 adding distributed tracing.

### Q8.1 — Structured logging

> "Structured logging: JSON-structured logs for production (pino, winston, structlog, loguru, zap, zerolog), or plain-text for now?"

- **Default (profile-keyed)**: L1–L2 → `plain-text`; L3–L4 → `structured`.
- **Skip if**: prototype or CLI tool with no server process.
- **Branches**:
  - `structured` → AGENTS.md Conventions section lists the chosen logger. Log scrubbing (PII redaction) is wired into the logger config. For enforcement of the no-console.log/print rule: if the stack has a logger-lint rule snippet in `references/agent-harness-templates § Observability snippets` (ESLint `no-console` for Node/TS, ruff T201/T203 for Python, golangci `forbidigo` for Go, clippy `print_stdout` for Rust, Checkstyle Regexp for Java), that rule enters the lint config in the write set and is enforced in CI. For any stack not covered by a snippet in that section, the no-console/print rule is **review-only** — never claim lint enforcement in the write set without a config snippet that exists in the template file.
  - `plain-text` → at L3+ this is a downgrade — confirm explicitly and record in the ledger. AGENTS.md notes "plain-text logging is intentional; structured logging deferred to <milestone>."
- **Decision impact**: log scrubbing readiness criterion moves from advisory to wired.

### Q8.2 — Distributed tracing and metrics

> "OpenTelemetry tracing and metrics (Prometheus/Datadog/CloudWatch) — wire now, or defer?"

- **Default (profile-keyed)**: L1–L2 → `defer`; L3 → `defer`; L4 → `wire`.
- **Skip if**: no server process.
- **Branches**:
  - `wire` → AGENTS.md Architecture Discipline section notes "OpenTelemetry SDK initialized; trace context propagated across service boundaries." A minimal OTel init snippet from `references/agent-harness-templates § Observability snippets` is included in the write set **only for Node/TS and Python** — those are the two stacks with a confirmed snippet in that section. For all other stacks (Go, Rust, Java, etc.) the `wire` branch downgrades honestly: AGENTS.md Section 9c records "OTel wiring is documented as review-only — OTel init is manual until a snippet exists for this stack in agent-harness-templates § Observability snippets", and readiness criteria `distributed_tracing` and `metrics_collection` remain advisory rather than wired. For Node/TS and Python where a snippet exists, those criteria move from advisory to wired.
  - `defer` → AGENTS.md notes the deferral with a target milestone.
- **Decision impact**: at L4, choosing `defer` is a downgrade — confirm explicitly.

---

## Dimension 9 — Refactor / Migration Contract

Ask this dimension only when Stage 0 detects large-refactor signals, degraded-project rehabilitation signals with expected agent refactoring, or the user names a rewrite, port, framework migration, clean cutover, compiler/parser/transformer migration, public API compatibility refactor, or multi-agent refactor. Otherwise skip the entire dimension.

Large-refactor signals include `legacy/`, `old/`, `reference/`, `fixtures/golden/`, `conformance/`, `compat/`, `ir/`, `dump/`, parallel old/new implementation paths, sibling source files in different languages that appear to be ports, public contract artifacts (OpenAPI, GraphQL schema, protobuf, CLI docs), or existing task/status files for a migration. Degraded-project rehabilitation signals include stale/bloated AGENTS.md, unreliable commands, many legacy violations, duplicated modules, missing smoke seams, flaky tests, and multiple agents expected to refactor.

When rehabilitation signals are active, the default stance is stabilization before cleanup: freeze legacy violations, establish one command entry point, render a concise hard AGENTS.md, add the cheapest runtime verifier, then split work into claimed units.

### Q9.1 — Refactor kind

> "This looks like a larger refactor or migration. Which kind: port, rewrite, framework migration, compatibility-preserving refactor, or not a refactor?"

- **Ask only when**: Stage 0 detects refactor signals or the user explicitly names rewrite/port/migration.
- **Default**: infer and confirm the most specific kind from scan evidence; if uncertain, recommend `compatibility-preserving refactor`.
- **Branches**:
  - `not a refactor` → deactivate the overlay; skip Q9.2–Q9.8 unless a later answer reactivates it.
  - any active kind → record `large_refactor.active: true` and `kind`.

### Q9.2 — Source-of-truth oracle (MANDATORY when overlay active)

> "What is the canonical source of truth agents must match: legacy code in this repo, upstream repo, old binary/CLI, formal spec, golden fixtures/conformance suite, or none yet?"

- **Default**: use detected reference paths (`legacy/`, `reference/`, `fixtures/golden/`, schema files) and ask the user to confirm.
- **Hard rule**: active refactor mode without a source of truth is a readiness gap. Do not invent an oracle; render the gap and keep compare rows out of the Verification Matrix until a real command exists.
- **Capture**: render into AGENTS.md `## Source of Truth & Refactor Contract`, `constraints.yaml` `refactor_contract.source_of_truth`, and Stage 3 Verification plan. Each confirmed source becomes a table row; detected `legacy/` or `old/` maps to behavior/reference behavior, `fixtures/golden/` maps to golden output or conformance fixtures, and schema/spec files map to their public contract surface.

### Q9.3 — Public compatibility surfaces

> "Which surfaces must stay compatible: API, CLI, DB schema/migrations, file formats, exported types, UI routes, generated artifacts, or none?"

- **Default**: infer from detected schemas, CLIs, migrations, exports, and routes.
- **Decision impact**: surfaces become rows in the Source-of-Truth table and candidates for contract/snapshot/compare checks.

### Q9.4 — Compare depth

> "How deep should parity checks go: final output only, errors/diagnostics, intermediate state/IR/pass dumps, or real-project conformance?"

- **Default**:
  - compilers/parsers/transformers/codegen/query engines/sync engines/importers → `intermediate state + final output`;
  - API/CLI replacements → `contract/golden output + errors`;
  - ordinary framework migrations → `public behavior + smoke/e2e`.
- **Branches**:
  - `intermediate state` → Verification Matrix may include the selected-entry command for `compare-ir` (`just compare-ir`, `make compare-ir`, or package script equivalent) only if the target/script exists or is written; otherwise record readiness gap.
  - `final output only` on compiler/transformer surfaces at L3–L4 → downgrade; confirm explicitly because later passes can hide internal divergence.

### Q9.5 — Cutover policy

> "Cutover policy: clean cutover, staged dual-run, compatibility bridge, or human-approved exception?"

- **Default (profile-keyed)**: L1–L2 → `compatibility bridge` if needed; L3–L4 → `clean cutover`.
- **Branches**:
  - `clean cutover` → AGENTS.md forbids keeping old and new production paths live.
  - `staged dual-run` / `compatibility bridge` → require a sunset condition, owner, and verification command; without those it is review-only debt.
  - `human-approved exception` → record as downgrade with reason and expiry.

### Q9.6 — Forbidden moves (MANDATORY when overlay active)

> "Keep the recommended anti-cheat rules: no weakening compare tests, no shelling out to the legacy implementation outside oracle commands, no silent fallback to old code, no unapproved dual production path, and no final-output-only parity when an intermediate oracle exists?"

- **Default**: keep all recommended rules.
- **Hard rule**: dropping any recommended forbidden move at L3–L4 is a downgrade requiring explicit confirmation and a ledger entry.
- **Capture**: `constraints.yaml` `refactor_contract.forbidden_moves`, AGENTS.md Source-of-Truth section, and task template `Forbidden moves`.

### Q9.7 — Work ownership

> "How will parallel agents claim refactor work: issue tracker, `agent_tasks/` files, GitHub labels, external tracker, or no parallel agents?"

- **Default**: public OSS / large team / multiple AI tools → `agent_tasks/` files; solo/small team → `no parallel agents` unless requested.
- **Branches**:
  - `agent_tasks/` → write `agent_tasks/task-template.md` and optional `refactor-status.toml`.
  - external tracker / labels → AGENTS.md names the tracker and claim rule; do not render local task files.
  - no parallel agents → AGENTS.md says one agent/person owns the refactor at a time.

### Q9.8 — Human gates

> "Which refactor paths require human white-box review: public API/schema, migrations/data deletion, auth/permissions, security, concurrency, payments, generated code, or other?"

- **Default**: public API/schema, migrations/data deletion, auth/permissions, security, concurrency.
- **Decision impact**: merge with Q7.6 Critical Paths and CODEOWNERS when enabled.

---

## After all active dimensions
---


Summarize the decision ledger to the user, then move to Stage 3 rendering. Do not write any files until Stage 3 confirmation.

The summary must end with a **strictness ledger**: chosen profile, count of rules at each enforcement level (`block` / `warn` / `review-only` / `gate`), and every downgrade from the profile default with the user's stated reason. A summary without the ledger is incomplete — the ledger is what makes the chosen strength visible before anything is written.

If the refactor overlay was active, include one summary bullet naming the source-of-truth oracle, compare depth, forbidden moves, cutover policy, and work-ownership mechanism. If no oracle or compare command exists yet, list it as a readiness gap rather than pretending it is verified.

Final summary example:

> Captured 28 constraints across active dimensions:
> - Stack: TypeScript / Next.js 14 / Prisma / Postgres
> - Architecture: DDD-strict, monorepo with 3 apps
> - Tests: TDD required, 80% coverage gate, testcontainers for integration
> - Pillars 2/3/4/5 enabled; pillar 6 (release) deferred
> - Observability: structured logging enabled, tracing deferred to post-MVP
> - Agents: commit to feature branches, conventional commits, no force-push
> - Verification matrix: 4 surfaces covered — health (`{{DEV_STATUS_CMD}}`), API smoke (`{{SMOKE_CMD}}`), UI walk (`{{VERIFY_UI_CMD}}`), integration (`{{INTEGRATION_TEST_CMD}}`)
> - Baseline (when Q1.4b ran): 212 legacy violations frozen at rev abc123; ratchet -20% per milestone
>
> Strictness ledger — profile **L3 strict**:
> - 14 rules block (pre-commit/CI), 1 warn, 2 review-only, 1 gate (branch protection, applied via `gh`)
> - Downgrades from L3: E2E deferred to next milestone (no UI yet — re-ask at first UI PR); release pillar deferred (no consumers yet)
>
> Proceed to render the AGENTS.md + CONTEXT.md draft and selected guardrail files? (yes / change-something)
