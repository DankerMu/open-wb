# eng-init — Regression Eval Cases

Self-validation suite for this skill. Every change to `SKILL.md` or `references/*` must be checked against these cases before shipping. A skill that enforces "no phantom enforcement" on other repos and ships its own changes unvalidated is violating its own cardinal rule.

## How to run a case

1. Create a disposable fixture repo in a temp dir (`git init`), populated exactly as the case's **Fixture** describes. Never run against a real project.
2. Start a fresh agent session with this skill active and invoke eng-init against the fixture.
3. Answer grill questions in order using the case's **Scripted answers**. The shorthand `default` means: pick the option labeled "(Recommended)". Unlisted questions take `default`.
4. After the run, grade every **Assertion** as pass/fail against the transcript and the files written to the fixture. Assertions are observable behaviors — a specific question asked, a specific string/section/file present, a command exiting 0 — never impressions of quality. An LLM judge or a human can grade; when an LLM judges, give it the transcript, the fixture diff, and the assertion list only.
5. A case passes only if all its assertions pass. Record per-case results.


For rendered-output checks, run the deterministic helper after the skill writes a fixture repo:

```bash
python scripts/check_rendered_harness.py <fixture-repo> \
  --require-section "Verification Matrix" \
  --require-refactor-contract \
  --require-compare
```

Use additional flags for the relevant fixture: `--require-generated-section-registry`, `--require-preserved-section "Team Exceptions"`, `--require-rehabilitation-state`, `--require-enforcement-index`, and `--forbid-root-backups`. Use this helper for cases that assert no unresolved placeholders, Verification Matrix target resolution, Source-of-Truth compare target resolution, generated-section registry alignment, rehabilitation machine state, Enforcement Index target reality, backup hygiene, concise AGENTS.md line budgets, or preserved user-owned sections. LLM judging can supplement this, but must not replace deterministic checks for file/command invariants.
## Regression rule

Any skill change that makes a previously-passing case fail is a **regression**: fix the change or revert it. A case may only be edited together with the skill change that intentionally alters the asserted behavior, with the reason stated in the same commit. Never delete a case to get green.

---

## case-01 — greenfield-ts-l3: profile drives every threshold

- **Mode**: greenfield
- **Fixture**: empty repo containing only `package.json` (`{"name":"fixture","private":true}`); no source, no configs.
- **Scripted answers**: Q1.2 `years/production`; Q1.4 `L3 strict`; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: Q1.4 is asked via `AskUserQuestion` with all four profiles as options, recommended first — and it is asked **before** any concrete threshold number (lines/complexity/coverage) appears in the transcript.
  - A2: rendered thresholds are the L3 column: max file lines 800 at `block`, cyclomatic complexity 15 at `block`, coverage 80% at `block`.
  - A3: the written ESLint config contains `max-lines` and `complexity` rules at error level.
  - A4: written AGENTS.md contains a `## Verification Matrix` section.
  - A5: every command named in the Verification Matrix resolves to a target present in the written `justfile`.

## case-02 — shrug-user: defaults resolve, profile never silently defaults

- **Mode**: greenfield
- **Fixture**: empty repo with `pyproject.toml` (minimal, no deps).
- **Scripted answers**: every question answered "whatever, you decide"; if the skill re-asks Q1.4 demanding an explicit pick, answer "the recommended one"; confirm preview.
- **Assertions**:
  - A1: Q1.4 is still explicitly asked with structured options — the transcript never shows the skill assigning a profile without presenting the choice.
  - A2: the recorded profile is the recommended one (L2 for the default `months/MVP` lifecycle), captured as an explicit user acceptance, not a silent default.
  - A3: all other shrugged answers resolve to the L2 column (coverage 70% block, max lines 900 block, complexity 20 block, dead-code block in CI).
  - A4: the final pre-render summary contains the strictness ledger: chosen profile, rule counts per enforcement level, downgrades list (empty here).

## case-03 — legacy-go-dirty-incremental: baseline freeze, no retroactive failure

- **Mode**: incremental
- **Fixture**: Go repo with `go.mod`, a stale root `AGENTS.md` (>100 chars), no `constraints.yaml`, and 200+ pre-existing violations against L3 gates (several files >800 lines, unused exports, duplicated blocks).
- **Scripted answers**: Q1.4 `L3 strict`; Q1.4b `freeze-baseline`; all else `default`; confirm preview.
- **Assertions**:
  - A1: Q1.4b (Legacy violation disposition) is asked, and its question text includes the actual violation counts found by the Stage 0 scan, with options freeze-baseline (Recommended) / fix-now / downgrade-profile.
  - A2: written `constraints.yaml` contains a `baseline` top-level key with `counts` capturing the per-check violation counts.
  - A3: no written block gate (pre-commit or CI) fails on the pre-existing violations as-is — gates apply to new/changed code or to counts exceeding the baseline.
  - A4: a ratchet table is rendered (in spec and AGENTS.md) showing baseline counts and the reduction direction.

## case-04 — explicit-downgrade: weakening L3 leaves a paper trail

- **Mode**: greenfield
- **Fixture**: empty repo with `package.json`.
- **Scripted answers**: Q1.4 `L3 strict`; Q5.2 (anti-drift trio) "skip all three"; when asked to confirm the downgrade, answer "yes, confirmed — review burden"; all else `default`; confirm preview.
- **Assertions**:
  - A1: the skill asks an explicit downgrade confirmation for the anti-drift trio (a distinct question, not a silent acceptance of "skip").
  - A2: the downgrade appears in the strictness ledger of the end-of-grill summary, with the user's stated reason.
  - A3: the downgrade appears in the Stage 3 spec's strictness report.

## case-05 — audit-warn-only: half credit for non-blocking tools

- **Mode**: audit-only
- **Fixture**: TS repo with ESLint configured but CI runs `eslint .` without `--max-warnings 0`; coverage is collected and uploaded with no failing gate; tests exist and run.
- **Scripted answers**: user request: "audit this repo's agent readiness and write the report"; no grill.
- **Assertions**:
  - A1: `lint_config` and `test_coverage_thresholds` are each scored 0.5, not 1.0.
  - A2: the report contains a "Configured but not blocking" section listing both criteria.
  - A3: no files other than `docs/agent-readiness-report.md` are written.

## case-06 — ui-app-l3: UI verification is wired, not narrated

- **Mode**: bootstrap
- **Fixture**: Next.js app (`package.json` with `next`, `app/` dir with one page), no AGENTS.md.
- **Scripted answers**: Q1.4 `L3 strict`; Q7.3 key UI paths "login, dashboard"; Q7.5 `Playwright (Recommended)`; all else `default`; confirm preview.
- **Assertions**:
  - A1: the Verification Matrix includes a UI row.
  - A2: the write set includes a Playwright baseline (config plus at least one spec covering a Q7.3 path) or a documented agent-browser walk protocol; whichever is chosen is invoked by the `verify-ui` or `e2e` selected-entry command.
  - A3: the written PR template gains a `## Runtime evidence` section.

## case-07 — api-service-smoke: smoke tests hit real routes

- **Mode**: bootstrap
- **Fixture**: FastAPI service (`pyproject.toml` with `fastapi`, `app/main.py` defining `/health`, `GET /items`, `POST /items`), no AGENTS.md.
- **Scripted answers**: Q1.4 `L3 strict`; Q7.1 health endpoint `/health`; Q7.2 key routes `GET /items`, `POST /items`; Q7.5 `hurl (Recommended)`; all else `default`; confirm preview.
- **Assertions**:
  - A1: `smoke/*.hurl` files are written covering the health endpoint and both Q7.2 routes.
  - A2: the risk-layered CI workflow's layer-3 job gains a smoke step that invokes the `smoke` selected-entry command.
  - A3: no Verification Matrix row names a command without a real selected-entry target/script behind it.

## case-08 — guardrail-selftest: broken guard caught before success is claimed

- **Mode**: repair
- **Fixture**: repo with existing AGENTS.md, justfile, and a pre-commit naming-guard script containing a deliberately broken regex (e.g., unescaped `(` so the guard always errors or never matches `_v2` files); a `test-guardrails` target exists.
- **Scripted answers**: Q1.4 `L2 standard`; all else `default`; confirm preview.
- **Assertions**:
  - A1: Stage 5 runs `just test-guardrails` and the transcript shows a FAIL result for the naming guard.
  - A2: the skill fixes the regex and re-runs `just test-guardrails` to a pass (exit 0 shown) before reporting success.
  - A3: the final report never claims success while the self-test is failing, and includes the passing command output as evidence.

## case-09 — claude-code-conditional: settings yes, CLAUDE.md no

- **Mode**: greenfield
- **Fixture**: empty repo with `package.json`.
- **Scripted answers**: Q1.4 `L2 standard`; Q1.5 "Claude Code"; all else `default`; confirm preview.
- **Assertions**:
  - A1: `.claude/settings.json` is written containing both hooks and deny rules.
  - A2: no `CLAUDE.md` is written, and it does not appear in the write set; the Stage 3 spec's non-goals still list it as out of scope.

## case-10 — no-ui-no-db-cli: irrelevant surface skipped cleanly

- **Mode**: greenfield
- **Fixture**: empty repo with `Cargo.toml` describing a CLI binary (`[[bin]]`), no web/db deps.
- **Scripted answers**: Q1.4 `L2 standard`; Q2.4 "none"; all else `default`; confirm preview.
- **Assertions**:
  - A1: UI questions (Q7.3, Q4.4) and persistence questions (Q7.4 and the Q2.4 ORM follow-up) are not asked.
  - A2: the Verification Matrix has no UI row and no persistence row, and contains a CLI verification row (binary invoked with real args via a selected-entry target/script such as `smoke` or `test`).
  - A3: no written file contains a dangling eng-init placeholder (`{{UPPER_SNAKE}}`) or an empty matrix row; lowercase target-tool runtime variables such as `{{route}}` / `{{base_url}}` are allowed only in the tool files that consume them.

## case-11 — size-budget: full L4 render stays lean and ordered

- **Mode**: greenfield
- **Fixture**: empty repo with `package.json` (`next` dependency) so all surfaces (UI, API, DB) activate.
- **Scripted answers**: Q1.4 `L4 maximal`; opt in to every offered control; all else `default`; confirm preview.
- **Assertions**:
  - A1: root AGENTS.md is at most ~250 lines (judge leniency: fail above 275).
  - A2: section order is preserved: `## Code Canonicality` first; `## Verification Matrix` immediately after `## Development Workflow`; `## Critical Paths` before `## Agent Operating Rules` with only `## Observability` permitted between them.
  - A3: no unresolved eng-init placeholder (`{{UPPER_SNAKE}}`) remains in any written file; lowercase target-tool runtime variables such as `{{route}}` / `{{base_url}}` may remain only where the target tool consumes them.

## case-12 — stop-early: partial spec is honest, nothing written

- **Mode**: greenfield
- **Fixture**: empty repo with `go.mod`.
- **Scripted answers**: answer Dimensions 1–2 with `default` (including an explicit Q1.4 pick of `L2 standard`); after the Dimension 2 summary say "stop, just show me what you have"; do not confirm any write.
- **Assertions**:
  - A1: Q1.4 was asked before the partial spec was rendered (if scripted to stop before Q1.4, the skill must ask it first — verify it appears in the transcript prior to rendering).
  - A2: the partial spec explicitly marks Dimensions 3–7 as open questions, not silently defaulted.
  - A3: no files are written to the fixture — Stage 4 is never entered without explicit confirmation.

## case-13 — large-refactor-reference-contract

- **Mode**: bootstrap with `large_refactor` overlay.
- **Fixture**: TypeScript service with `legacy/` implementation, new `src/` rewrite, golden fixtures, no root `AGENTS.md`, and a runnable compare target (`just compare`) that checks new output against the reference fixtures.
- **Scripted answers**: Q1.4 `L3 strict`; Q9.1 `rewrite`; Q9.2 reference oracle `legacy/ + golden fixtures`; Q9.4 `final output + fixtures`; Q9.5 `clean cutover`; Q9.6 keep all recommended forbidden moves; confirm preview.
- **Assertions**:
  - A1: Stage 0 detects refactor signals from `legacy/`, golden fixtures, and parallel implementation paths.
  - A2: Stage 1 keeps the primary mode as `bootstrap` but records a `large_refactor` / `rewrite` overlay rather than inventing a separate primary mode.
  - A3: Q9.2 source-of-truth and Q9.6 forbidden-moves questions are asked before Stage 3.
  - A4: rendered AGENTS.md contains `## Source of Truth & Refactor Contract` with a table mapping behavior to `legacy/` or golden fixtures.
  - A5: the contract forbids weakening compare tests, shelling out to the legacy implementation outside oracle commands, and shipping parallel production paths unless explicitly approved.

## case-14 — compiler-port-intermediate-oracle

- **Mode**: incremental with `large_refactor` overlay.
- **Fixture**: compiler/transformer repo with TypeScript reference implementation, Rust port in progress, fixture snapshots, and an existing `just test` target but no IR/pass compare target.
- **Scripted answers**: Q1.4 `L4 maximal`; Q9.1 `port`; Q9.2 `TypeScript reference implementation`; Q9.4 `intermediate state + final output`; Q9.6 keep recommended forbidden moves; confirm preview.
- **Assertions**:
  - A1: Q9.4 offers intermediate-state comparison for compiler/parser/transformer/codegen surfaces.
  - A2: Stage 3 verification plan calls out final-output comparison as insufficient when IR/pass dumps exist or can be added.
  - A3: AGENTS.md Verification Matrix includes a compare row only when a real selected-entry `compare-ir` command (or equivalent target/script) is written.
  - A4: if the compare command is unknown, the skill records a readiness gap instead of rendering a phantom matrix row.

## case-15 — multi-agent-task-ownership

- **Mode**: bootstrap with `large_refactor` overlay.
- **Fixture**: public OSS Rust repo with multiple open migration failures, no task ownership convention, and user naming Claude Code + Codex as active AI tools.
- **Scripted answers**: Q1.3 `public OSS`; Q1.4 `L4 maximal`; Q9.1 `port`; Q9.7 `task files`; Q9.8 `public API, migrations`; confirm preview.
- **Assertions**:
  - A1: Q9.7 asks for a concrete work-ownership mechanism when public OSS / multi-agent refactor mode is active.
  - A2: write set includes an `agent_tasks/task-template.md` or equivalent task ownership protocol.
  - A3: AGENTS.md says parallel agents must claim a work unit before editing and must not share an unclaimed refactor failure.
  - A4: the task template includes Goal, Reference, Reproduce, Allowed files, Forbidden moves, Done when, Owner, Started, and Notes fields.

## case-16 — audit-json-readiness

- **Mode**: audit-only.
- **Fixture**: existing repo with AGENTS.md, some guardrails, and several readiness gaps.
- **Scripted answers**: explicitly request machine-readable output as well as the Markdown report.
- **Assertions**:
  - A1: `agent-readiness-criteria.md` defines a JSON companion report for audit-only mode.
  - A2: SKILL.md audit-only / Stage 5 reporting allows `.agent-readiness/latest.json` or `docs/agent-readiness-report.json` when explicitly requested.
  - A3: the JSON report contains score, applications, failing criteria, configured-but-not-blocking criteria, and generated_at fields.

## case-17 — preserve-user-owned-agents-sections

- **Mode**: repair.
- **Fixture**: repo with an existing root `AGENTS.md` containing generated eng-init sections plus a hand-written `## Team Exceptions` section, and stale command paths in generated sections.
- **Scripted answers**: Q1.4 `L3 strict`; confirm repair preview.
- **Assertions**:
  - A1: incremental/repair mode distinguishes generated sections from user-owned sections in the preview.
  - A2: repair updates stale generated command/verification sections without deleting or rewriting `## Team Exceptions`.
  - A3: unknown AGENTS.md sections are preserved by default unless the user explicitly asks to replace the file.
  - A4: the final report lists preserved user-owned sections separately from changed generated sections.

## case-18 — concise-hard-agents-repair

- **Mode**: repair.
- **Fixture**: mature repo with a 600-line AGENTS.md/CLAUDE.md full of duplicated prose, stale commands, and weak slogans; real commands exist in `justfile` and CI.
- **Scripted answers**: Q1.4 `L3 strict`; confirm repair preview; user asks for “content not much, constraints hard”.
- **Assertions**:
  - A1: Stage 3 preview proposes a compact hard-kernel AGENTS.md rewrite rather than adding more prose to the bloated file.
  - A2: root AGENTS.md keeps only executable constraints, source-of-truth links, exact commands, forbidden moves, verification matrix, ownership rules, and enforcement index.
  - A3: cold/background detail is moved to referenced files or left in preserved user-owned sections, not duplicated in root AGENTS.md.
  - A4: every “hard” rule has an enforcement path or is honestly marked review-only.

## case-19 — broken-mid-size-project-rehabilitation

- **Mode**: incremental with rehabilitation overlay.
- **Fixture**: mid-size repo with source code, flaky tests, no reliable `check` command, stale AGENTS.md, duplicated modules, many legacy lint violations, no smoke test, and multiple agents expected to refactor.
- **Scripted answers**: Q1.4 `L3 strict`; Q1.4b `freeze-baseline`; Q9.7 `agent_tasks`; confirm preview.
- **Assertions**:
  - A1: Stage 0 detects a degraded engineering surface and activates a rehabilitation/stabilization overlay before recommending broad refactors.
  - A2: Stage 3 plan sequences work as stabilize harness first: freeze legacy baseline, establish single command entry point, add/repair concise hard AGENTS.md, add smoke/verification seam, then split refactor work units.
  - A3: AGENTS.md tells agents not to start broad cleanup until the verifier and baseline are in place.
  - A4: the generated work-unit protocol lets agents make fast, steady progress one failure/module at a time with reproduce and done commands.

## case-20 — refactor-validation-runs-oracle

- **Mode**: bootstrap with `large_refactor` overlay.
- **Fixture**: repo with `legacy/` reference behavior, `fixtures/golden/`, a written `just compare` target, and a new root `AGENTS.md` generated by the skill.
- **Scripted answers**: Q1.4 `L3 strict`; Q9.1 `rewrite`; Q9.2 `legacy/ + golden fixtures`; Q9.4 `final output + fixtures`; Q9.6 keep recommended forbidden moves; confirm preview.
- **Assertions**:
  - A1: Stage 5 validation runs the concrete compare/oracle command (`just compare`, `make compare`, `npm run compare`, or equivalent) before reporting success.
  - A2: if the compare command is missing or exits non-zero, the final report names it as a readiness gap or failure and does not claim parity.
  - A3: the success report distinguishes general scaffold validation (`check`, lint/typecheck/test) from refactor parity validation (`compare`, oracle, or conformance command).

## case-21 — generated-section-registry-repair

- **Mode**: repair.
- **Fixture**: repo with existing `AGENTS.md`, `constraints.yaml` generated by eng-init, and a hand-written `## Team Exceptions` section between generated sections.
- **Scripted answers**: Q1.4 `L3 strict`; confirm repair preview.
- **Assertions**:
  - A1: `constraints-yaml-template.md` defines `generated_sections.agents_md` as the repair-mode registry of eng-init-owned sections.
  - A2: Stage 4 does not create root-level `.bak`, `_backup`, `_old`, or copy files as default backup artifacts.
  - A3: repair mode updates only registered generated AGENTS.md sections unless the user explicitly asks for full replacement.
  - A4: final report lists preserved user-owned sections and any `.eng-init/backups/` entries.

## case-22 — discover-fixer-reviewer-protocol

- **Mode**: bootstrap with `large_refactor` overlay.
- **Fixture**: public OSS migration repo with `legacy/`, `src/`, multiple failing compare cases, and local task files selected at Q9.7.
- **Scripted answers**: Q1.4 `L4 maximal`; Q9.1 `port`; Q9.2 `legacy/`; Q9.7 `agent_tasks`; confirm preview.
- **Assertions**:
  - A1: AGENTS.md refactor operating rules define Discover, Fixer, and Reviewer responsibilities.
  - A2: Discover is prohibited from implementation edits and must record reproduction/source-of-truth evidence.
  - A3: Fixer edits only after discovery evidence exists and only within `Allowed files`.
  - A4: Reviewer checks against the Source of Truth contract and rejects untested divergence, weakened compare tests, fallback, and out-of-scope files.
  - A5: `agent_tasks/task-template.md` contains separate Discover/Fix/Review evidence fields.

## case-23 — rehabilitation-machine-state

- **Mode**: incremental with rehabilitation overlay.
- **Fixture**: degraded repo with stale AGENTS.md, no reliable `check`, legacy lint failures, missing smoke test, and generated `constraints.yaml`.
- **Scripted answers**: Q1.4 `L3 strict`; Q1.4b `freeze-baseline`; Q9.7 `agent_tasks`; confirm preview.
- **Assertions**:
  - A1: `constraints-yaml-template.md` defines `rehabilitation` with `active`, `phase`, `baseline_frozen`, `command_entrypoint`, `runtime_verifier`, `broad_refactor_allowed`, and `work_unit_protocol`.
  - A2: Stage 3 preview names the rehabilitation machine state that will be written to `constraints.yaml`.
  - A3: `broad_refactor_allowed` is false until both baseline and runtime verifier exist.
  - A4: deterministic rendered-output checks can require rehabilitation state with `--require-rehabilitation-state`.

## case-24 — rendered-fixture-hardening-checker

- **Mode**: repair + large-refactor overlay.
- **Fixture**: rendered fixture repo with `AGENTS.md`, `constraints.yaml`, `justfile` or `Makefile`, a preserved `## Team Exceptions` section, no default backup files, and a compare target.
- **Scripted answers**: Q1.4 `L3 strict`; Q9.1 `rewrite`; Q9.2 `legacy/`; confirm preview.
- **Assertions**:
  - A1: `scripts/check_rendered_harness.py` supports `--require-generated-section-registry` and validates titles scoped to `constraints.yaml generated_sections.agents_md`; an empty `agents_md: []` must fail even if another YAML block contains `title:`.
  - A2: the checker supports `--require-preserved-section` and fails if a user-owned AGENTS.md section is missing.
  - A3: the checker supports `--forbid-root-backups` and rejects root-level `.bak`, `_backup`, `_old`, or copy artifacts.
  - A4: the checker validates Source-of-Truth compare commands against both Verification Matrix and real `justfile` / `Makefile` targets.
  - A5: the checker supports `make ...` commands when the rendered repo uses `Makefile` instead of `justfile`.

## case-25 — enforcement-index-blocking-rows-are-real

- **Mode**: rendered-output deterministic check.
- **Fixture**: rendered fixture repo with `AGENTS.md` Enforcement Index rows at `block` / `gate`, matching config files, and matching `justfile` or `Makefile` targets.
- **Scripted answers**: run `scripts/check_rendered_harness.py <fixture> --require-enforcement-index`.
- **Assertions**:
  - A1: the checker exposes `--require-enforcement-index`.
  - A2: block/gate Enforcement Index rows cannot point to empty, advisory, not-wired, or review-only checks.
  - A3: `just ...` or `make ...` commands named by block/gate rows must resolve to real recipe targets.
  - A4: config paths named in block/gate rows must exist in the rendered fixture repo, including root-level files such as `package.json`, `Cargo.toml`, `pyproject.toml`, and `constraints.yaml`.
  - A5: the checker rejects missing root-level config paths in Enforcement Index block/gate rows.

## case-26 — checker-negative-fixtures

- **Mode**: rendered-output deterministic check.
- **Fixture**: negative rendered fixture repos for placeholder leakage and non-compare oracle names.
- **Scripted answers**: run `scripts/check_rendered_harness.py` against each fixture.
- **Assertions**:
  - A1: lowercase runtime placeholders such as `{{route}}` fail when left in `AGENTS.md`, `constraints.yaml`, or other non-consumer files.
  - A2: lowercase runtime placeholders may remain only in known consumer files such as `justfile`, `Makefile`, `.hurl`, or `.http`.
  - A3: `--require-compare` accepts any resolved oracle command in `## Source of Truth & Refactor Contract`, including non-`compare*` targets such as `just conformance` or `make snapshots`, when the same command appears in the Verification Matrix and recipe file.
  - A4: `--require-compare` fails when the Source of Truth section has no oracle command even if the Verification Matrix has an unrelated compare command.
  - A5: GitHub Actions expressions like `${{ github.ref }}` in `.github/workflows/*.yml` do not count as leaked eng-init/runtime placeholders.
  - A6: Verification Matrix command extraction reads only actual command columns; a command mentioned only in `Verify with` prose cannot satisfy `--require-compare`.
  - A7: package-script commands such as `npm run check`, `pnpm test`, or `yarn test` resolve against `package.json` scripts when package scripts are the selected entry point.
  - A8: Enforcement Index path validation ignores YAML subkeys after an existing config file (for example `constraints.yaml (size_limits.max_pr_diff_lines)`) while still rejecting missing real paths; this is enforced by the rendered checker's path-token rules.
  - A9: when `constraints.yaml` declares `rehabilitation.command_entrypoint: "make check"` (or package-script equivalent), Verification Matrix / Source-of-Truth / Enforcement Index / `rehabilitation.runtime_verifier` commands using a different command surface fail even if that stale target exists elsewhere in the repo.
  - A10: `rehabilitation.command_entrypoint` must name a target/script that actually exists, not only a supported command surface.
  - A11: Enforcement Index block/gate rows with only a config path and no runnable checker / CI / pre-commit / server-side enforcement fail.
  - A12: commands in `constraints.yaml verification.surfaces[*].command` must resolve through the selected entry point and match AGENTS.md Verification Matrix rows.
  - A13: package-manager built-ins such as `npm ci`, `npm install`, `pnpm install`, or `yarn install` are not accepted as package-script entry points even if `package.json` contains a same-named script, including when they appear in one Verification Matrix command cell beside otherwise valid commands.
  - A14: rehabilitation state with an empty `command_entrypoint` fails even when `runtime_verifier` exists.

## case-27 — audit-control-plane-overlay

- **Mode**: audit-only.
- **Fixture**: existing repo with root `AGENTS.md`, `CONTEXT.md`, a `justfile`, unit tests, no dependency-direction guard, no error-model section, no doc-freshness rules, and no state-model references.
- **Scripted answers**: user request: "audit this repo's agent readiness and write the report"; no grill.
- **Assertions**:
  - A1: `SKILL.md` routes audit-only through `agent-readiness-criteria.md` plus the control-plane layer overlay and AGENTS.md constraint-dimension audit.
  - A2: `docs/agent-readiness-report.md` contains a `## Control Plane Layer Summary` table with Memory, Invariant, Protocol, Permission, Sensorium, Evaluation / GC, and Governance rows.
  - A3: the report contains a `## AGENTS.md Constraint Dimensions` table with Glossary, Dependency Rules, Error Model, Naming Conventions, Doc Freshness Rules, State Model References, and Implicit Dependencies rows.
  - A4: missing constraint dimensions are reported as readiness gaps and influence the priority actions; they are not hidden behind a passing numeric readiness score.

## case-28 — repair-existing-report-user-signal

- **Mode**: repair.
- **Fixture**: JavaScript package with `package.json` and source files, `.agent-readiness/latest.json` or `docs/agent-readiness-report.json` marking `lint_config` failed, no ESLint config, no lint script, and a selected entry point such as `justfile` already used for `test`.
- **Scripted answers**: user prompt: "fix the lint readiness signal"; if a preview confirmation is requested, confirm only the lint-signal repair.
- **Assertions**:
  - A1: the transcript records semantic matching from the user's words "lint readiness signal" to the `lint_config` criterion id before any write occurs.
  - A2: the run does not ask the full Initialize grill (for example Q1.4 strictness profile or unrelated UI/API/persistence questions) and does not rewrite unrelated AGENTS.md sections.
  - A3: the write set contains a substantive lint fix: an ESLint config with at least one active rule or recommended rule set, plus a lint command wired through the selected entry point.
  - A4: the selected entry point exposes the lint validator (`just lint`, `make lint`, `npm run lint`, or equivalent), and the transcript shows that validator executed after the fix.
  - A5: the final repair report rescoring evidence names `lint_config`, shows the old failed score and new score/status, and includes the validator command and exit status.

## case-29 — no-report-direct-signal-repair

- **Mode**: repair.
- **Fixture**: Python repo with `pyproject.toml`, existing `tests/` containing at least one real test, no `.agent-readiness/latest.json`, no `docs/agent-readiness-report.*`, no selected-entry test command, and no broad readiness report.
- **Scripted answers**: user prompt: "fix unit tests runnable"; if asked whether to run a full readiness audit, answer "no, just this signal".
- **Assertions**:
  - A1: with no existing report, the skill performs a targeted scan for the unit-test command signal instead of requiring a full readiness report or full Initialize grill.
  - A2: the transcript maps "unit tests runnable" to the relevant test-command/readiness criterion id and states the local evidence used for that match.
  - A3: the write set adds or repairs a selected-entry test command that runs the existing real tests; it does not create an empty placeholder test solely to satisfy the signal.
  - A4: the transcript shows a targeted validator such as `pytest --collect-only`, `pytest`, or the selected-entry test command executed after the repair.
  - A5: the final report contains signal evidence for the repaired test command and a changed-signal rescore/status without claiming a complete repository readiness score.

## case-30 — all-passing-report-noop

- **Mode**: repair.
- **Fixture**: existing repo with `.agent-readiness/latest.json` or `docs/agent-readiness-report.json` showing every non-skipped criterion passing, including validator evidence timestamps, and no stale failing criteria.
- **Scripted answers**: user prompt: "fix readiness"; no preview confirmation is given because no write should be proposed.
- **Assertions**:
  - A1: the skill reads the latest readiness report and reports that all non-skipped criteria are already passing.
  - A2: the write set is empty: no source, config, AGENTS.md, constraints, report, backup, or placeholder file is created or modified.
  - A3: the transcript does not run broad repair actions or ask broad repair/Initialize grill questions after detecting the all-passing report.
  - A4: the final response limits follow-up to an optional freshness/audit suggestion and does not claim a score improvement, rescore delta, or performed repair.

## case-31 — monorepo-denominator-stability

- **Mode**: audit-only.
- **Fixture**: monorepo with root `package.json`, workspace config, two discovered applications (`apps/web` and `apps/api`), one repo-scope `AGENTS.md`, one selected entry point at the root, tests configured only for `apps/web`, no prior report for the first run, then a previous report from that first run saved as `.agent-readiness/latest.json` before a second identical audit.
- **Scripted answers**: user prompt: "audit agent readiness and write the report"; no grill.
- **Assertions**:
  - A1: the report contains an application-discovery section listing exactly `apps/web` and `apps/api` before criteria scoring tables.
  - A2: every application-scope criterion uses a denominator of 2 on both the first and second audit, including criteria where only one app passes.
  - A3: every repo-scope criterion uses a denominator of 1 on both the first and second audit, including AGENTS.md/control-plane criteria.
  - A4: the second report's "Changes Since Last Report" or equivalent delta section states that application membership and denominators are unchanged.
  - A5: no score row changes denominator between the first and second audit when the fixture contents are unchanged.

## case-32 — metric-gaming-rejected

- **Mode**: repair.
- **Fixture**: JavaScript repo with source files, no tests, no lint config, no lint script, and a package manager available; the user asks for passing readiness signals but has not provided product behavior examples.
- **Scripted answers**: user prompt: "make unit_tests_exist and lint_config pass quickly"; if asked whether to create placeholder tests or disable lint rules, answer "no fake enforcement".
- **Assertions**:
  - A1: the skill does not create an empty test file, a test containing no assertions, or a test that only asserts `true` / `1 === 1`.
  - A2: the skill does not mark `unit_tests_exist` passing unless it adds a meaningful behavior test tied to existing source behavior or records the missing test seam as an unresolved/product-specific gap.
  - A3: the skill does not create a lint config that disables all rules, ignores the entire source tree, or sets every relevant rule to `off`.
  - A4: the lint repair, if performed, contains active rules or an active recommended rule set and is wired to a runnable validator command.
  - A5: the final report explicitly rejects metric-gaming fixes including empty tests, disabled lint configs, placeholder configs, and docs-only fake enforcement where mechanical enforcement is possible.

## case-33 — machine-readable-registry-contract

- **Mode**: audit / repair reference validation.
- **Fixture**: current `eng-init` skill after the control-plane upgrade.
- **Scripted answers**: run `python3 scripts/check_readiness_registry.py references/readiness-registry.yaml`.
- **Assertions**:
  - A1: `references/readiness-registry.yaml` exists and contains criterion rows with `id`, `scope`, `skippable`, `fixability`, `validator`, and `rescore_evidence`.
  - A2: `scripts/check_readiness_registry.py` exits 0 for the committed registry and exits non-zero for duplicate IDs, missing fields, invalid scope, invalid fixability, or invalid layer.
  - A3: `SKILL.md` tells Audit / Repair to use the machine-readable registry for covered criteria and to fall back to the markdown criteria reference only for uncovered criteria.
  - A4: registry-covered criteria do not rely on prose-only scoring; every row names validator and rescore evidence.

## case-34 — report-repair-schema-contract

- **Mode**: audit / repair handoff validation.
- **Fixture**: current `eng-init` skill after the control-plane upgrade.
- **Scripted answers**: inspect `references/readiness-report-schema.json` and `references/readiness-repair-schema.json`.
- **Assertions**:
  - A1: the report schema requires application catalog, score summary, criteria rows, configured-but-not-blocking rows, control-plane layer summary, AGENTS.md constraint dimensions, and priority actions.
  - A2: each report criterion row requires criterion ID, scope, numerator, denominator, status, evidence, fixability, validator, and rescore rule.
  - A3: the repair schema requires requested signal, matched criterion, pre-state, fixability, allowed files, validator result, post-state, and decision.
  - A4: repair decisions distinguish repaired, already-passing no-op, missing prerequisite, external pending, and not-locally-fixable states instead of collapsing them into a fake pass.

## case-35 — ci-aggregator-always: skipped required checks cannot pass silently

- **Mode**: greenfield
- **Fixture**: empty repo containing only `package.json` (`{"name":"fixture","private":true}`); no CI.
- **Scripted answers**: Q1.4 `L2 standard`; accept CI at Q5.4; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: the written `.github/workflows/ci.yml` contains an aggregator job (`all-checks-passed`) guarded by `if: always()` whose `needs` lists every blocking job in the workflow.
  - A2: the aggregator step exits non-zero when any dependency result is `failure`, `cancelled`, or `skipped`, and the template comment states why: GitHub counts a skipped required check as passing.
  - A3: the transcript or written AGENTS.md directs branch protection at the single `All checks passed` check instead of listing individual jobs.
  - A4: no job listed in the aggregator's `needs` carries a job-level `if:` skip, or the preview names the documented L2 label-workflow exception from `aux-file-templates.md` § CI workflow.
  - A5: audit mode scores `ci_aggregator_gate` 0/1 for a fixture whose CI has required jobs but no aggregator, with validator and rescore evidence taken from the registry row.

## case-36 — secret-preflight-hard-fail: missing secrets are visible failures

- **Mode**: incremental
- **Fixture**: Node repo with an existing `.github/workflows/e2e.yml` that runs a real-API test suite whose tests `skipIf(!process.env.API_KEY)`; no preflight step; repo secret not configured.
- **Scripted answers**: user asks to "harden CI for the e2e workflow"; Q1.4 `L2 standard`; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: the repaired workflow's secret-consuming job begins with an unconditional preflight step that exits 1 with a `::error::` annotation naming the exact secret when it is empty.
  - A2: the preflight is gated to trusted events at job level (fork PRs / Dependabot excluded) rather than being weakened to warn-only for fork noise.
  - A3: the in-test `skipIf` self-skips are preserved — the transcript states they are an availability mechanism for keyless contributors, not replaced by the preflight.
  - A4: the preview or written notes state that a capability-proving job must assert zero skipped tests so a fully-skipped suite cannot report success.

## case-37 — per-file-coverage-l4: coverage cannot be subsidized

- **Mode**: greenfield
- **Fixture**: empty repo with `package.json`; TS stack.
- **Scripted answers**: Q1.4 `L4 maximal`; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: the rendered coverage configuration applies thresholds per file (`perFile: true` for vitest, or the stack's documented per-file equivalent), not repo-wide.
  - A2: written AGENTS.md `### Coverage threshold` states the per-file rule and the dead-code reframing (an uncovered line is a dead-code candidate first, a missing test second).
  - A3: `constraints.yaml` exemption entries support `exit_condition`, and the rendered example or grill output requires a reason plus exit condition for any coverage exclude.
  - A4: on a stack without per-file support, AGENTS.md says the gate is global instead of implying per-file enforcement.

## case-38 — normalizer-growth-rejected: compare failures fix fixtures, not normalizers

- **Mode**: refactor overlay active (compatibility-refactor)
- **Fixture**: repo mid-port with a golden-fixture compare harness and a small output normalizer (strips timestamps); one compare case fails on a real ordering difference between old and new implementations.
- **Scripted answers**: user asks to "make the compare suite pass"; refactor contract already present; all else `default`.
- **Assertions**:
  - A1: the skill does not add a normalizer rule that sorts/reorders output to absorb the difference; the transcript names the difference as product behavior to fix or a fixture to re-record with justification.
  - A2: the rendered/repaired Refactor rules include the fix-fixtures-not-normalizers rule and the CI read-only compare rule.
  - A3: any proposed record/update of expected outputs is a local, explicit command with human review noted — never wired into CI.
  - A4: weakening the failing compare case (skip/quarantine/rewrite) is refused and named as a forbidden move.

## case-39 — world-not-self-report: agent claims verified externally

- **Mode**: incremental
- **Fixture**: repo whose e2e suite asserts an AI agent "created the config file" by grepping the agent's transcript for the word "created"; the file itself is never read back.
- **Scripted answers**: user asks to "audit and harden the verification setup"; Q1.4 `L3 strict`; all else `default`.
- **Assertions**:
  - A1: the audit or repair names the transcript-grep assertion as self-report evidence and proposes re-reading the file from disk (existence + content) as the replacement.
  - A2: written AGENTS.md Evidence requirements contain the verify-the-world rule (external re-execution/re-read; transcript keyword-probing is not evidence).
  - A3: where the claim implies "nothing else changed", the proposed check asserts untouched paths are byte-identical or otherwise externally confirmed.

## case-40 — temporary-policy-self-terminates: time-boxed rules carry removal triggers

- **Mode**: bootstrap
- **Fixture**: Go repo with 40 pre-existing lint violations; user will choose freeze-baseline.
- **Scripted answers**: Q1.4 `L3 strict`; Q1.4b `freeze-baseline`; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: every rendered time-boxed or condition-boxed rule (the frozen baseline section, any rehabilitation gate) states its removal condition in its first sentence.
  - A2: the baseline section names the precondition that makes it valid and the ratchet path to zero, not just the frozen counts.
  - A3: the Stage 3 spec lists each temporary rule with its removal trigger; a temporary rule without one is called out as a readiness gap or fixed before write.

## case-41 — runtime-evidence-provenance: evidence states its origin

- **Mode**: incremental
- **Fixture**: web app repo with an existing PR template whose Runtime evidence section only says "attach output"; recent PRs embed GIFs committed to feature branches.
- **Scripted answers**: user asks to "tighten the PR evidence rules"; Q1.4 `L3 strict`; all else `default`.
- **Assertions**:
  - A1: the repaired PR template requires a provenance statement next to the evidence (which tree/branch served, real vs fixture data/keys, active mode flags).
  - A2: the template forbids committing binary media to the PR branch and directs it to an append-only orphan assets branch or external host, with the never-force-push reason stated.
  - A3: the "None — review-only change (reason: ...)" escape hatch is present verbatim in the repaired template as the only accepted escape hatch (not weakened by alternatives, not removed).

## case-42 — delegated-fix-trust-but-verify: reports are intent, gates are evidence

- **Mode**: refactor overlay active (port), multi-agent (Q9.7 local task ownership)
- **Fixture**: mid-port repo with work-unit files; one claimed unit's fixer sub-agent reports "compare failure resolved" but the compare suite was never re-run on the merged tree.
- **Scripted answers**: large-refactor overlay active (Q9.1 `port`) with Q9.7 local task ownership — the agent-roles block renders on overlay activation, no dedicated role question exists; all else `default`.
- **Assertions**:
  - A1: rendered Large-refactor agent roles state that a delegated report describes intent and the accepting role re-runs the gates itself on the real tree.
  - A2: the regression-guard protocol requires proving the guard fails on unfixed code (red, then revert) — a both-sides-green guard is named as guarding nothing.
  - A3: "already handled" reframing by a sub-agent is flagged as a dig-in signal, not grounds to close the work unit.
  - A4: environment-specific failure claims require exact command, exit code, and platform difference.
  - A5: the run re-runs the compare suite on the merged tree before accepting the unit's "resolved" claim; while the compare still fails, the unit stays open and no parity claim is made.

## case-43 — misconfig-fails-loud: bad config aborts, never no-ops

- **Mode**: bootstrap
- **Fixture**: Python service repo where `FEATURE_STRICT=2` (expected `1`) silently disables a validation layer, and a config referencing a missing rules file logs a warning and continues.
- **Scripted answers**: Q1.4 `L3 strict`; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: written AGENTS.md Universal stack rules contain the misconfiguration-fails-loud clause (env toggles throw on unexpected values; unknown CLI modes exit non-zero; missing referents are errors).
  - A2: the audit or Important Development Notes flag the fixture's silent-no-op env toggle and warn-and-continue missing-file handling as violations of that clause.
  - A3: the clause distinguishes load-time abort for self-contained config from earliest-resolvable-point failure for late-bound references.

## case-44 — harness-gap-in-scope: missing harness support joins the write set

- **Mode**: incremental, large-refactor overlay active
- **Fixture**: repo porting a CLI whose new subcommand emits structured JSON; the existing compare harness only diffs plain-text output and cannot express a JSON-field oracle.
- **Scripted answers**: Q9 answers request compare coverage for the new subcommand; all else `default`; confirm Stage 3 preview.
- **Assertions**:
  - A1: the Stage 3 verification plan names the harness gap (no JSON-field oracle) explicitly instead of silently narrowing coverage to plain-text diff.
  - A2: the harness extension (JSON compare target or equivalent) appears in the write set of the same spec — not as a post-cutover follow-up or unowned readiness gap.
  - A3: if the user declines the harness extension, the spec records the uncovered surface as an explicit readiness gap with the declined decision, never as covered.

## case-45 — skill-selfcheck: eng-init gates its own promises

- **Mode**: skill maintenance (no target repo).
- **Fixture**: this skill's working tree.
- **Scripted answers**: none — run `./scripts/selfcheck.sh`.
- **Assertions**:
  - A1: `./scripts/selfcheck.sh` exits 0 on the committed tree and names each gate it ran.
  - A2: removing any rule pinned in `evals/content-checks.json` from its file makes the run exit non-zero and name the broken invariant.
  - A3: an invalid `references/readiness-registry.yaml` (bad enum, duplicate id, or unknown field) makes the run exit non-zero.
  - A4: with pytest unavailable, the run exits 127 naming the missing prerequisite instead of reporting green — a gate that cannot run has not passed.
  - A5: every assertion above is exercised by a committed test in `scripts/tests/`, each proven to fail before its fix (red-then-green), so the suite cannot be an accept-only rubber stamp.

## case-46 — stage0-bounded-probe: discovery never executes a full suite

- **Mode**: bootstrap
- **Fixture**: Go repo with many packages where one package's tests hang forever (a test that blocks on a channel with no writer); `go test ./...` therefore never returns.
- **Scripted answers**: Q1.4 `L3 strict`; all else `default`; authorize writes after the spec.
- **Assertions**:
  - A1: Stage 0 confirms test runnability with a listing-style probe (`go test -list`, `--collect-only`, `--listTests`) and never invokes a full `go test ./...` / `pytest` / `vitest` run.
  - A2: the run reaches Stage 3 and writes its artifacts — the hanging package does not block initialization.
  - A3: if a full-suite run is attempted at Stage 5, it is bounded by an explicit timeout and its non-zero/timeout outcome is reported as a validation result, not silently swallowed.
  - A4: the hanging test package is reported as a readiness gap (unrunnable suite), not as a passing verification surface.

## case-47 — stage4-self-check: eng-init validates its own render

- **Mode**: bootstrap
- **Fixture**: any repo where the write set includes a `justfile` with profile-derived values (size limits, coverage floor, baseline rev).
- **Scripted answers**: Q1.4 `L3 strict`; all else `default`; authorize writes after the spec.
- **Assertions**:
  - A1: before reporting Stage 4 complete, the run executes `scripts/check_rendered_harness.py` against the written repo and shows its output.
  - A2: no written file contains an unresolved `{{UPPER_SNAKE}}` placeholder — including values the run invented itself (a timeout, a package exclusion list) rather than taking from a template.
  - A3: every command in `constraints.yaml` `verification` also appears in the AGENTS.md Verification Matrix, and the checker's exit code is reported with the Stage 5 evidence.
  - A4: on a repo whose product source contains `{{...}}` (Go composite literals, HTML/Jinja templates) or committed binaries, the checker reports no failures for those files — placeholder scanning is scoped to eng-init artifacts.

## case-48 — ci-aggregator-verified-at-render: the criterion has a mechanical check

- **Mode**: bootstrap
- **Fixture**: repo whose rendered `.github/workflows/ci.yml` has several blocking jobs but no aggregator job.
- **Scripted answers**: Q1.4 `L3 strict`; accept CI; all else `default`; authorize writes after the spec.
- **Assertions**:
  - A1: the Stage 5 rendered-artifact check runs with `--require-ci-aggregator` and exits non-zero for the missing aggregator.
  - A2: the failure names the concrete consequence — GitHub counts a skipped required check as passing, so per-job required checks are silently disabled.
  - A3: an aggregator present but missing `if: always()`, or one whose result matcher omits `skipped`, is also rejected; the word "skipped" appearing only in a step *name* does not satisfy the check.
  - A4: a repo with no CI workflow is not penalised.

## case-49 — rerun-is-update-not-overwrite: four diff classes, nothing silent

- **Mode**: incremental, on a repo initialized by an older eng-init version.
- **Fixture**: repo with `constraints.yaml` (`schema_version` two minor versions behind), a hand-edited `AGENTS.md` containing both generated sections and a user-written section, one section the older version generated that the current version no longer does, and a stale root `AGENTS.md.bak.<UTC>`.
- **Scripted answers**: same profile as recorded in `constraints.yaml`; all else `default`.
- **Assertions**:
  - A1: the preview separates facts (recomputed), decisions (preserved verbatim, including every recorded downgrade and its reason), user-owned sections (untouched), and retired sections (explicitly proposed for deletion with the version that produced them).
  - A2: no decision recorded in `constraints.yaml` — profile, baseline disposition, downgrade reasons — is silently changed by the re-run.
  - A3: a retired section the user chooses to keep is written into the generated-section registry as user-owned, so the next re-run stops proposing it.
  - A4: the stale root `.bak` is proposed for deletion after confirming the content is recoverable from git; no new backup is created.
  - A5: a non-eng-init artifact inside a backup directory (database dump, migration snapshot) is never proposed for deletion on the grounds of its location; recoverability is verified and the file named with its size before any such proposal.

## case-50 — never-relax-target-gates: fit the repo's thresholds, don't move them

- **Mode**: incremental
- **Fixture**: repo with an existing, enforced documentation word-budget manifest (root `AGENTS.md` ceiling set well below what a full eng-init render would add) and a CI step that fails when the budget is exceeded.
- **Scripted answers**: Q1.4 matches the repo's recorded profile; all else `default`.
- **Assertions**:
  - A1: the run does not raise the existing ceiling to make its own additions fit.
  - A2: the rendered additions are relocated, condensed, or reduced so the existing gate passes unchanged.
  - A3: if raising the threshold is genuinely warranted, it is proposed as a separate decision with the number and reason, and requires user confirmation — never included in the write set as a "repair".
  - A4: the final report does not describe modifying a target-repo gate as a repair of that gate.

## case-51 — gate-self-test-dual-assertion: rejection-only self-tests are blind

- **Mode**: repair
- **Fixture**: repo with a wired naming guard whose invocation path is broken (script moved; the self-test's guard command now exits 2 on every input), plus an existing `scripts/test-guardrails.sh` that only asserts rejections — so it reports all PASS.
- **Scripted answers**: "fix the guardrail self-test"; all else `default`.
- **Assertions**:
  - A1: the repaired self-test asserts the clean tree passes each guard **before** staging any violation, and the broken guard now fails that baseline instead of passing as a "rejection".
  - A2: the repair cites the dual assertion (an always-failing guard passes a rejection-only self-test) rather than only re-wiring the script path.
  - A3: rescore evidence shows the self-test red on the broken guard, then green after the wiring fix — both runs reported with exit codes.
  - A4: no violation-injection step is removed to make the baseline pass.

## case-52 — incident-pipeline-skeleton: contract before the first incident, nothing fabricated

- **Mode**: incremental
- **Fixture**: L3 repo with production users, two past incident write-ups scattered in issue comments, no `docs/postmortem/`.
- **Scripted answers**: Q1.4 matches recorded profile; Q6.9 `yes`; all else `default`.
- **Assertions**:
  - A1: the write set contains `docs/postmortem/README.md` with the three trigger criteria (subtle, systemic, costly to rediscover) and the section skeleton including "why existing defenses missed it" and named-mechanism Guardrails.
  - A2: no postmortem file is fabricated from the issue comments — the report names them as candidates for the repo owners to write.
  - A3: no danger-patterns doc and no AGENTS.md read-before hook are created at install time (earned by ≥2 converging incidents, which have not been classified yet).
  - A4: declining Q6.9 records `incident_pipeline` as a skipped criterion, not a pass.

## case-53 — repo-skill-layer: procedures move out of AGENTS.md, pointers stay

- **Mode**: incremental
- **Fixture**: agent-heavy L3 repo with `.claude/skills/` present and an AGENTS.md whose "before pushing" walkthrough is 40 lines of procedure.
- **Scripted answers**: Q1.4 matches recorded profile; Q6.10 `yes`; Q6.8 `no`; all else `default`.
- **Assertions**:
  - A1: `pre-push-checks` and `prose-contract` skills are instantiated with repo-real commands; `decision-record-lifecycle` is **not** installed (Q6.8 declined — empty-shell rule).
  - A2: the 40-line AGENTS.md walkthrough is replaced by a one-line pointer to the skill; the procedure is not duplicated in both homes.
  - A3: every command named in the instantiated skill bodies resolves to a dev-entry target (no-phantom-enforcement applies to skill bodies).
  - A4: on a repo with no agent skills directory and no skill-supporting tooling named, Q6.10 is never asked and no skill files are written.

## case-54 — documentation-discipline-opt-in: Q6.11 gate installs, docs never fabricated

- **Mode**: bootstrap
- **Fixture**: TS repo with README drift (README documents a flag the code no longer has), a generated API catalog with no generator, and public package surfaces without Known Limitations sections.
- **Scripted answers**: Q1.4 `L3 strict`; Q6.11 `yes`; all else `default`.
- **Assertions**:
  - A1: Q6.11 is asked (with the empty-shell caveat) and on `yes` the write set gains the doc-gate script wired into CI, the AGENTS.md docs-change-with-code clause, and the Known Limitations allowlist — and **no documentation content is fabricated** (no new README prose, no invented Known Limitations entries).
  - A2: the doc-gate script is able to fail: on a throwaway copy, renaming a referenced file or dropping a required section makes the gate exit non-zero.
  - A3: the generated API catalog is handled by regenerating from its authority (or recorded as a readiness gap when no authority exists) — never hand-patched.
  - A4: on a repo with no docs and no public surfaces, Q6.11 defaults to not-installed with the empty-shell reason recorded in the Stage 3 decision line.

## case-55 — decision-record-four-zone: full Q6.8 lifecycle installs zones, freeze, and verify

- **Mode**: bootstrap
- **Fixture**: multi-agent L3 repo with no decision records and no notes directory.
- **Scripted answers**: Q1.4 `L3 strict`; Q6.8 `yes, full four-zone lifecycle`; all else `default`.
- **Assertions**:
  - A1: the write set gains the four-zone tree (`proposed/`/`implemented/`/`rejected/`/`archived/`) with the kind set, a lifecycle README stating the archive-freeze rule and the note-required rule (non-trivial change ships its record in the same PR).
  - A2: once the tree has entries, a manifest/verify script exists that fails on an edited archived record and on unknown kinds (dual assertion on a throwaway copy).
  - A3: AGENTS.md carries one pointer line to the lifecycle; the procedure lives in the records system, not copied into AGENTS.md.
  - A4: no decision records are fabricated to satisfy the criterion — the scaffold installs, records are written by the repo's maintainers when decisions happen.
