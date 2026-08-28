# Readiness Fix Recipes

Use this reference in Repair mode after a report row or user phrase has been semantic-matched to a readiness criterion. Fix one signal by default unless the user explicitly asks for a batch.

## Universal repair rules

- Make a substantive fix that improves future agent correctness; do not optimize for score alone.
- No placeholder files, empty tests, empty configs, disabled rules, `|| true`, fake pass states, or broad refactors.
- No docs-only fake enforcement when a mechanical check exists for the stack.
- Every enforcement claim must resolve to config plus a selected-entry command, hook, or required CI job.
- Every fix needs a signal-specific validator and a rescore of the changed signal.
- Class C fixes may only be claimed complete with real product behavior and validator evidence.
- Class D external/governance signals may not be locally marked complete without authenticated external evidence and explicit permission.

## Fixability classes

| Class | Meaning | Completion rule |
|-------|---------|-----------------|
| A — skill-owned | Repo-control-plane artifacts `eng-init` can safely write. | Complete when artifact exists, references resolve, validator passes, and criterion rescored. |
| B — stack-owned but safe | Stack tooling `eng-init` can wire when evidence is clear. | Complete when tool config is real, command runs, violations fail, and criterion rescored. |
| C — repo/product-specific | Requires product semantics or runtime behavior. | Scaffold/support only unless real behavior exists and is validated. |
| D — external/governance | Lives in GitHub/org/cloud/product governance. | Recommend or automate only with explicit authenticated access; otherwise leave pending. |

## Recipe schema

Each recipe uses this shape:

- **Fixability:** Class A/B/C/D.
- **Good fixes:** Changes that count.
- **Bad fixes:** Metric gaming or unsafe substitutes.
- **Required scan:** Facts to read before editing.
- **Allowed files:** Files Repair mode may touch for this signal.
- **Validator:** Specific check to run; if missing, report the prerequisite.
- **Rescore evidence:** What the report must show after repair.

## Initial recipes

### `agents_md`

- **Fixability:** A — skill-owned.
- **Good fixes:** Root `AGENTS.md` with concise project identity, selected commands, verification matrix, forbidden moves, permission/escalation rules, and enforcement index; module `AGENTS.md` only when local rules differ.
- **Bad fixes:** Huge generic policy dump, copied global rules, unresolved commands, `CLAUDE.md` substitution, placeholder sections.
- **Required scan:** Existing root/module instruction files, command surface, stack markers, generated/user-owned sections.
- **Allowed files:** `AGENTS.md`, module-level `AGENTS.md`, `constraints.yaml` generated-section registry when already in scope.
- **Validator:** Resolve every command/path named in Verification Matrix and Enforcement Index through the selected entry point.
- **Rescore evidence:** `agents_md=1/1`; any unresolved command becomes `verification_matrix` or phantom-enforcement gap.

### `context_md`

- **Fixability:** A — skill-owned.
- **Good fixes:** `CONTEXT.md` with project identity, domain glossary, bounded contexts, invariants, forbidden logic, and open terminology questions.
- **Bad fixes:** Empty glossary, marketing README copy, invented domain facts, claiming no glossary needed when domain terms are present.
- **Required scan:** README/specs, source names, API routes, model/entity names, existing docs.
- **Allowed files:** `CONTEXT.md` only, unless linking from `AGENTS.md` is already part of the write set.
- **Validator:** Read-back check for identity plus either concrete terms/invariants or explicit non-applicability reason.
- **Rescore evidence:** `context_md=1/1` with cited sections; uncertain facts remain open questions, not fabricated truths.

### `verification_matrix`

- **Fixability:** A — skill-owned.
- **Good fixes:** Matrix in `AGENTS.md` listing setup/check/lint/type/test/build/smoke/refactor-oracle rows that resolve to selected-entry targets.
- **Bad fixes:** Rows for non-existent commands, direct tool invocations that bypass the selected entry point, claiming runtime verification without a command.
- **Required scan:** `justfile`, `Makefile`, package scripts, language manifests, CI commands.
- **Allowed files:** `AGENTS.md`, selected entry point only when adding a real target is necessary and in scope.
- **Validator:** For each row, confirm target/script exists; run only the signal-specific command requested by repair scope.
- **Rescore evidence:** `verification_matrix=1/1` when all rows resolve; missing runnable targets remain gaps.

### `guardrail_self_test`

- **Fixability:** A — skill-owned.
- **Good fixes:** `scripts/test-guardrails.sh` or equivalent selected-entry target that injects known violations and proves guards reject them; CI/cron/entry command runs it.
- **Bad fixes:** Script that only echoes PASS, tests the happy path only, ignores failures, or is not wired to any command.
- **Required scan:** Existing guardrails, selected entry point, CI workflow, constraints/baseline files.
- **Allowed files:** `scripts/test-guardrails.sh`, selected entry point, CI workflow, `constraints.yaml` for baseline/ratchet state.
- **Validator:** Run the guardrail self-test target; it must fail on injected violation and exit 0 only when guards reject it.
- **Rescore evidence:** `guardrail_self_test=1/1` with command, exit code, and per-guard PASS/FAIL output.

### `lint_config`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Stack-appropriate lint config with meaningful rules and selected-entry lint target; blocking mode for strict profiles (`--max-warnings 0`, error severity, or equivalent).
- **Bad fixes:** Empty config, all rules disabled, warn-only full credit, `eslint --init` leftovers not wired, `|| true`.
- **Required scan:** Stack markers, existing lint configs, package/tool versions, selected entry point, CI.
- **Allowed files:** Lint config, package/tool manifest scripts, selected entry point, CI/pre-commit only if needed to make blocking status true.
- **Validator:** Run lint on the narrow app/package or a lint config validation command; verify violations would fail when claiming blocking.
- **Rescore evidence:** `1/N` for apps with blocking lint, `0.5/N` when configured but not blocking, `0/N` for missing apps.

### `formatter`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Stack formatter config plus selected-entry format/check target using check mode in CI or pre-commit.
- **Bad fixes:** Formatting docs only, formatter installed but never invoked, write-mode-only target as the sole validator.
- **Required scan:** Language/tooling markers, existing style config, generated/vendor paths to exclude.
- **Allowed files:** Formatter config, ignore file, package/tool manifest scripts, selected entry point, pre-commit/CI when in scope.
- **Validator:** Run formatter check mode on relevant paths; missing tool is a prerequisite, not success.
- **Rescore evidence:** `1/N` for apps with runnable formatter check; `0.5/N` if configured but advisory only.

### `type_check`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** TS `strict`/`noEmit` target, Python pyright/mypy config, Go/Rust/Java compiler check, selected-entry typecheck command.
- **Bad fixes:** Setting `skipLibCheck`/`ignore_errors` to hide local errors, excluding source wholesale, docs-only type policy.
- **Required scan:** Language manifests, existing compiler configs, source roots, generated paths, current typecheck command.
- **Allowed files:** Type config, selected entry point, package/tool manifest scripts, CI/pre-commit when needed.
- **Validator:** Run the narrow typecheck target or compiler check for the affected app.
- **Rescore evidence:** `1/N` for apps with passing configured typecheck; record baseline/ratchet instead of weakening checks for legacy errors.

### `unit_tests_exist`

- **Fixability:** B when existing source behavior is clear enough for a meaningful minimal test; C when product semantics are required.
- **Good fixes:** Add a real test tied to existing source behavior, public API, CLI output, or documented contract; wire it through the selected-entry test target if no target exists.
- **Bad fixes:** Empty test files, skipped-only suites, tests with no assertions, tautologies such as `true` / `1 === 1`, snapshots of placeholder output, or marking the signal passing when no behavior seam is known.
- **Required scan:** Existing source entry points, exported functions/CLI/API routes, prior tests, fixtures, package/tool scripts, and whether the user supplied enough behavior facts.
- **Allowed files:** Test files for the observed behavior, test runner config, selected entry point, package/tool manifest scripts.
- **Validator:** Run the narrow added test or collect/list tests plus the selected-entry test command when available.
- **Rescore evidence:** `unit_tests_exist=1/N` only when a real, non-skipped test exists for the app; otherwise leave the signal failing or product-specific pending with the missing behavior seam named.

### `unit_tests_runnable`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Selected-entry `test` target that discovers and runs existing tests; add test dependency/config only when stack evidence is clear.
- **Bad fixes:** Empty test file, skipped-only suite, target that exits 0 without discovery, deleting failing tests, mocks that replace behavior under test.
- **Required scan:** Existing tests, test framework markers, package/tool scripts, lockfile, app boundaries.
- **Allowed files:** Test runner config, selected entry point, package/tool manifest scripts; source tests only when adding a meaningful minimal behavior test is explicitly in scope.
- **Validator:** Run collect/list tests (`--listTests`, `--collect-only`, `go test -list`, etc.) or a narrow test command.
- **Rescore evidence:** `unit_tests_runnable=1/N` for apps with a runnable command that finds real tests; if no meaningful test seam exists, keep failing and report gap.

### `smoke_tests_exist`

- **Fixability:** A for harness wiring; C when product routes/fixtures must be invented.
- **Good fixes:** Selected-entry smoke command exercising real API/CLI/UI critical path with status/body assertions and documented dev-server lifecycle.
- **Bad fixes:** Curling a non-existent route, asserting only process start, skipped smoke file, fake local server, broad product refactor.
- **Required scan:** Runtime entry points, routes/CLI commands, dev server commands, seed data, existing smoke/e2e tests.
- **Allowed files:** `smoke/` scripts, selected entry point, `AGENTS.md` Verification Matrix, dev-server lifecycle helper scripts when already in scope.
- **Validator:** Run smoke command against a real local app when prerequisites exist; otherwise report missing runtime prerequisite.
- **Rescore evidence:** `1/N` only for apps with runnable smoke assertions; pure libraries may be explicitly skippable with reason.

### `pr_templates`

- **Fixability:** A — skill-owned.
- **Good fixes:** PR template with description, risk, validation, runtime evidence, readiness impact, and review notes.
- **Bad fixes:** Template with no testing/evidence section, generic checklist that allows blank validation, duplicating issue template only.
- **Required scan:** Existing `.github`/`.gitlab` templates, contribution docs, repo host.
- **Allowed files:** `.github/pull_request_template.md`, `.gitlab/merge_request_templates/*`, `AGENTS.md` link only when already in scope.
- **Validator:** Read-back check that required sections exist and runtime evidence allows `None — review-only change` only with reason.
- **Rescore evidence:** `pr_templates=1/1`; `runtime_evidence_in_pr_template` rescored separately if applicable.

### `gitignore_comprehensive`

- **Fixability:** A — skill-owned.
- **Good fixes:** `.gitignore` excludes secrets (`.env*` with safe `.env.example` exception), dependencies, build outputs, coverage, caches, logs, IDE/OS files for detected stack.
- **Bad fixes:** Ignoring source/config wholesale, ignoring lockfiles by default, adding comments without patterns, removing existing project-specific exceptions.
- **Required scan:** Stack markers, existing `.gitignore`, committed generated artifacts, env template presence.
- **Allowed files:** `.gitignore` only; `.env.example` only if explicitly part of secrets-management repair.
- **Validator:** Read-back pattern check; optionally `git check-ignore` for representative ignored paths when available.
- **Rescore evidence:** `gitignore_comprehensive=1/1` with stack-specific categories present and no unsafe broad ignores.

### `dead_code_detection`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Stack dead-code tool (`knip`, `vulture`, `golangci-lint` unused, `cargo-udeps`/`cargo-machete`, Maven/Gradle analyze, SonarQube) wired to selected-entry target with documented baseline when legacy violations exist.
- **Bad fixes:** Deleting code during readiness repair, ignore-all config, advisory report claimed as blocking, broad refactor to silence findings.
- **Required scan:** Stack markers, package graph, existing analyzers, generated/vendor paths, current dead-code findings if cheap to collect.
- **Allowed files:** Analyzer config, selected entry point, package/tool manifest scripts, `constraints.yaml` baseline/ratchet, CI/pre-commit when in scope.
- **Validator:** Run analyzer in check/list mode for affected app or validate config if tool install is missing; missing tool is a prerequisite.
- **Rescore evidence:** `1/N` when analyzer runs and blocks or baseline-ratchets; `0.5/N` for configured but not blocking.

### `test_coverage_thresholds`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Real coverage threshold in test runner/coverage service that fails below threshold, with baseline/ratchet for legacy repos.
- **Bad fixes:** Threshold `0`, report-only Codecov claimed as blocking, excluding source wholesale, adding empty tests to raise coverage.
- **Required scan:** Test runner, current coverage config/output, source/test layout, strictness profile, legacy baseline state.
- **Allowed files:** Test/coverage config, selected entry point, package/tool manifest scripts, `constraints.yaml` baseline/ratchet, CI when needed.
- **Validator:** Run coverage check or the narrow coverage threshold command; if too expensive, run config validation and report missing full-run evidence.
- **Rescore evidence:** `1/N` for blocking threshold or approved ratchet, `0.5/N` for configured-but-not-blocking coverage reporting.

### `ci_aggregator_gate`

- **Fixability:** A — skill-owned.
- **Good fixes:** Add an `all-checks-passed` job guarded by `if: always()` whose `needs` lists every blocking job, failing when any dependency result is `failure`, `cancelled`, or `skipped`; point branch protection at that single check and drop the per-job required checks.
- **Bad fixes:** Listing individual jobs as required checks; omitting `if: always()` (a dependency failure then skips the aggregator, and GitHub counts a skipped required check as passing); whitelisting `skipped` inside the aggregator; leaving a job-level `if:` skip on an aggregated job without recording the documented exception.
- **Required scan:** Workflow files, the blocking-job set, existing branch-protection configuration, any job-level `if:` on those jobs, secret-gated jobs (which stay out of `needs`).
- **Allowed files:** `.github/workflows/*.yml`, AGENTS.md Enforcement Index and branch-model rows.
- **Validator:** The aggregator exists with `if: always()`, `needs` equals the blocking-job set, and the step exits non-zero on any failed/cancelled/skipped dependency; branch protection requires only that check (external setting — report as manual when unauthenticated).
- **Rescore evidence:** `ci_aggregator_gate=1/1` when the aggregator exists and branch protection requires it; `0.5/1` when the aggregator exists but protection still lists individual jobs; `0/1` when absent; null only when the repo has no CI.

### `generated_docs_check_mode`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Give every generated doc a generator with `--write` and `--check` modes, wire `--check` into CI so drift fails the build, mark the outputs as generated, and add a coverage-completeness check so a new input cannot stay out of the projection.
- **Bad fixes:** Hand-editing generated output; a `--check` that only warns; freshness measured by file mtime alone (`documentation_freshness` is the weak form); a generator with no test.
- **Required scan:** Committed docs that are projections of code (API/CLI/config catalogs, dependency graphs, license notices), existing generator scripts and their modes, CI wiring, source-annotation enforcement (docstring/JSDoc lint) that sets the projection's quality ceiling.
- **Allowed files:** Generator scripts, CI workflow, the generated docs themselves (regenerated, never hand-patched), AGENTS.md Enforcement Index.
- **Validator:** Run each generator's `--check` on a clean tree — exit 0; then modify a source annotation without regenerating and confirm `--check` exits non-zero.
- **Rescore evidence:** `generated_docs_check_mode=1/1` when every generated doc has a CI-wired `--check`; `0.5/1` when generators exist but `--check` is missing or non-blocking; `0/1` when generated docs are hand-maintained; null only when no doc is a code projection.

### `exemption_registry_hygiene`

- **Fixability:** A — skill-owned.
- **Good fixes:** For each exemption mechanism found (lint suppression registry, coverage exemptions, budget overrides, `constraints.yaml` `exemptions`, no-limitations allowlists): add or repair a check that every entry resolves to an existing target and carries a non-empty reason; fail with "renamed or removed? update the list in the same change" on stale targets; assert mutually exclusive lists share no entries; add missing `exit_condition` fields to time-boxed exemptions (`references/gate-quality-contract.md` § Exemption and allowlist hygiene).
- **Bad fixes:** Deleting stale entries without checking whether the exemption should follow its renamed target; adding placeholder reasons ("temporary", "because it fails"); a hygiene check that only warns; removing an exemption's *execution* along with its measurement (exemption is not non-execution — the exempted suite still runs where its signal matters).
- **Required scan:** Lint configs and suppression files, coverage config excludes, `constraints.yaml` `exemptions`, any allowlist consumed by a gate, plus the targets those entries name.
- **Allowed files:** The exemption registries themselves, the hygiene check script, CI wiring, `constraints.yaml`, AGENTS.md Enforcement Index.
- **Validator:** Dual assertion with one rejection sample per rule (`gate-quality-contract.md` § Self-proof — "every new or changed accept/reject rule ships its paired rejection sample in the same change"). Clean tree first: the hygiene check exits 0 and prints its summary line. Then, on a throwaway copy, stage one violation at a time and confirm each exits non-zero naming the offending entry: **(a) stale target** — rename an exempted target without updating the list; **(b) empty reason** — blank one entry's reason field (and, for a time-boxed entry, drop its `exit_condition`); **(c) contradictory lists** — add one object to two mutually exclusive lists. Three rules, three samples: a rule whose violation you cannot make the check reject is a rule the check does not implement, however plainly the config names it.
- **Rescore evidence:** `exemption_registry_hygiene=1/1` when all registries pass a wired check; `0.5/1` when entries carry targets and reasons but nothing verifies them; `0/1` when stale or reason-less entries exist unchecked; null only when no exemption mechanism exists.

### `incident_pipeline`

- **Fixability:** A — skill-owned (the contract skeleton; postmortem content itself is repo work, never fabricated).
- **Good fixes:** Install `docs/postmortem/README.md` from `references/incident-pipeline-templates.md` (trigger criteria: subtle ∧ systemic ∧ costly-to-rediscover; the section skeleton with mandatory Executive summary, "why existing defenses missed it" under Root cause, and named-mechanism Guardrails); for existing incident write-ups, classify each guardrail entry per landing layer (prose / policy / mechanical) as named-mechanism or explicit `not applicable` + reason; propose a danger-patterns doc only when ≥2 incidents converge on one defect class.
- **Bad fixes:** Writing fictional postmortems to satisfy the criterion; a danger-patterns doc seeded from generic best practices instead of real incidents; guardrail entries that name no verifiable mechanism ("we will be more careful"); promoting a single incident's lesson to a danger-patterns doc.
- **Required scan:** Existing incident write-ups anywhere (docs/, wiki links, issue labels like `postmortem`/`incident`), decision records of class bug-fix, the AGENTS.md constraint list's incident-sourced entries.
- **Allowed files:** `docs/postmortem/README.md`, AGENTS.md (danger-domains read-before hook only when the doc exists and covers ≥2 domains), existing postmortem files (guardrail-layer classification only — never rewrite the narrative).
- **Validator:** Dual assertion, not an existence check. Clean tree first: the check exits 0 on the repo's real postmortem set. Then, on a throwaway copy, one violation at a time, each exiting non-zero and naming the file: **(a)** delete the README's trigger criteria — the contract no longer says when to write one; **(b)** point one "Guardrails added" entry at a mechanism that does not exist (rename the test or script it credits) — this is the entry that matters, since a guardrail naming nothing is how a postmortem closes without landing; **(c)** strip a landing layer's line entirely, leaving neither a named mechanism nor `not applicable` + reason. **Promotion to a danger-patterns doc is deliberately not gated in that direction**: whether two incidents "converge on one defect class" is a judgement no check can make, and a gate that guesses it would either nag on every second incident or stay silent forever — contract rule 5 (Deterministic) rules it out. What *is* mechanical is the cheap half: if `docs/danger-patterns.md` exists, it must link at least two distinct postmortem files, so a doc seeded from generic best practice or from a single incident fails. The "should have been promoted but was not" direction stays a human call, and the README says so rather than implying a check covers it.
- **Rescore evidence:** `incident_pipeline=1/1` when the contract exists and written postmortems' guardrails resolve; `0.5/1` when write-ups exist without the contract or with unresolvable guardrails; `0/1` when incidents are documented nowhere despite evidence they occurred; null only when the repo has no recorded incidents and declined the skeleton.

### `verification_snapshot_tiers`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Add a keyless snapshot/replay tier for model-, protocol-, or human-visible output: a runnable example composition whose recorded transcript is replayed and diffed in CI (read-only replay mode; record/refresh stay local and human-reviewed); assert zero skipped tests on capability-proving suites; wire the tier through the selected dev entry point.
- **Bad fixes:** Snapshots that CI can silently rewrite; normalizers grown to absorb real behavior differences; recording the transcript and never replaying it; unit tests substituted for the assembled transcript.
- **Required scan:** Existing test layout, example compositions, CI snapshot/record modes, `verification_matrix` rows.
- **Allowed files:** Snapshot fixtures, replay script, CI wiring, dev entry point target, `verification_matrix` rows.
- **Validator:** Replay run exits 0 on the clean tree; corrupt one expected output on a throwaway copy and confirm the replay exits non-zero naming the file. A suite that cannot fail on a diff is decoration.
- **Rescore evidence:** `verification_snapshot_tiers=1/1` when a replay tier runs in CI and rejects diffs; `0.5/1` when snapshots exist but replay is manual; `0/1` when none exist; null only when no model-/protocol-/human-visible surface exists and the tier was declined.

### `decision_record_lifecycle`

- **Fixability:** A — skill-owned.
- **Good fixes:** Scaffold the four-zone tree (`.agents/notes/` or the repo's existing notes home: `proposed/`, `implemented/`, `rejected/`, `archived/`, each with the kind set), a README stating lifecycle + kinds + the note-required rule, and — once the tree has entries — a manifest/verify script that fails on duplicate ids, edited archived records, and unknown kinds. Cross-link from AGENTS.md with one pointer line.
- **Bad fixes:** Writing decision records to satisfy the criterion; a records tree without the note-required rule; treating archived records as editable; deleting records toward a quota.
- **Required scan:** Existing decisions dirs (`decisions/`, `notes/`, `.agents/notes/`, ADRs), AGENTS.md conventions, whether the repo ships bilingual docs (i18n pairs).
- **Allowed files:** The notes tree, its README, the manifest/verify script, AGENTS.md pointer line.
- **Validator:** Verify script exits 0 on the clean tree; on a throwaway copy, edit an archived record and confirm the script exits non-zero naming the file. The note-required rule itself is Convention-level (same-PR rule) — state it, do not fake a gate for it.
- **Rescore evidence:** `decision_record_lifecycle=1/1` when the tree + lifecycle README + verify script exist and pass; `0.5/1` when records exist without the lifecycle or check; `0/1` when no records and no scaffold; null only when declined (Q6.8 no) with no existing records.

### `documentation_gates`

- **Fixability:** A — skill-owned.
- **Good fixes:** Install the doc-discipline module (`references/documentation-discipline.md`, Q6.11): a scripted doc-validation gate wired into CI that fails on drift (stale references, missing required sections, budget overflow), the docs-change-with-code rule in AGENTS.md, the Known Limitations section requirement with a justified allowlist.
- **Bad fixes:** Fabricating docs to make the gate green; a gate that warns but never fails CI; hand-editing a generated catalog; copying the same fact into two homes.
- **Required scan:** Existing doc tooling (doc-sync-style scripts, generators with `--check` modes), public surfaces that need Known Limitations sections, generated catalogs and their authorities.
- **Allowed files:** The doc-gate script + CI wiring, AGENTS.md clause, Known Limitations allowlist, dev entry point target.
- **Validator:** Gate exits 0 on the clean tree; on a throwaway copy, break one documented fact (rename a referenced file, drop a required section) and confirm non-zero. Reuse `generated_docs_check_mode` evidence where it overlaps.
- **Rescore evidence:** `documentation_gates=1/1` when the gate runs in CI and rejects drift; `0.5/1` when docs change discipline exists but nothing mechanical checks it; `0/1` when docs drift unchecked; null only when declined (Q6.11 no) with no docs surface.

### `runtime_invariants`

- **Fixability:** B — stack-owned but safe (needs a service/plugin architecture).
- **Good fixes:** Add per-package invariant companions: registrations asserting owned relationships over authoritative event streams or mutable data; empty companions carry an explained reason ("no runtime invariant: this adapter has no independent lifecycle stream"); a verify script enforces the registry in CI.
- **Bad fixes:** Assertions over service presence or plugin metadata instead of authoritative data; unexplained empty companions; a companion registry nothing runs.
- **Required scan:** Package/service layout, event or data streams that express ownership relationships, existing invariant/test infrastructure.
- **Allowed files:** Invariant companion files, the verify script, CI wiring, AGENTS.md Enforcement Index.
- **Validator:** Verify script exits 0 on the clean tree; on a throwaway copy, break one asserted relationship (stub a stream that should be owned) and confirm non-zero.
- **Rescore evidence:** `runtime_invariants=1/1` when companions + verify script exist and pass; `0.5/1` when companions exist without enforcement; `0/1` when none exist in a service-architecture repo; null only when the repo has no plugin/service architecture and declined the clause set.

### `coverage_per_file`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** Add a per-file coverage gate (strong form of `test_coverage_thresholds`): the gate fails when any file drops under 100% (vitest `coverage.100`/`perFile: true`, jest `coverageThreshold` per-glob with `"**/*": {100}` semantics, or the stack's equivalent); treat an uncovered line as a dead-code candidate for deletion, not a missing test to bolt on; keep the aggregate threshold as the weaker baseline for repos not ready for per-file.
- **Bad fixes:** A per-file config that is never wired into CI; exemptions without an exit condition; lowering the per-file bar to fit existing files instead of deleting dead code; reporting per-file coverage without a failing gate.
- **Required scan:** Existing coverage config and CI gate, files with zero or low coverage, `exemption_registry_hygiene` state.
- **Allowed files:** Coverage config, CI wiring, deletion of dead code found by the gate (only when the user authorizes cleanup), AGENTS.md Conventions section.
- **Validator:** Gate exits non-zero when one file drops below 100% (on a throwaway copy, stub a line in a covered file and confirm the gate fails naming the file); exits 0 on the clean tree.
- **Rescore evidence:** `coverage_per_file=1/1` when the per-file gate runs in CI and rejects a dropped file; `0.5/1` when per-file thresholds exist but nothing fails on violation; `0/1` when only aggregate coverage exists; null only when declined (Q4.2 strong form not selected) with no per-file mechanism.

### `built_artifact_smokes`

- **Fixability:** B — stack-owned but safe.
- **Good fixes:** For every package with a `bin` or non-index runtime entry, add a smoke that runs the BUILT output under the plain runtime (no source-transpiling hook) and asserts the shipping artifact boots — a genuinely missing config exits non-zero. Wire through the selected dev entry point so the smoke is one command.
- **Bad fixes:** Running the smoke through the source-transpiling path (it masks settle races, module resolution, swallowed load failures); asserting only that the source compiles; a smoke that skips into green when the artifact is absent.
- **Required scan:** Package manifests with `bin`/runtime entries, existing built-artifact or e2e smokes, `verification_matrix` rows.
- **Allowed files:** The smoke script + CI wiring, dev entry point target, `verification_matrix` rows.
- **Validator:** Smoke exits 0 on the clean built artifact; on a throwaway copy, break the artifact (rename a required config, delete the built entry) and confirm non-zero.
- **Rescore evidence:** `built_artifact_smokes=1/1` when built-output smokes run in CI for every bin/runtime entry; `0.5/1` when they exist but run through the source path or manually; `0/1` when none exist for packages that ship bins; null only when the repo ships no executable runtime entries and declined the tier.
