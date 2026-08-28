# Gate Quality Contract

<!-- eng-init template version: 2026-08-08 -->

The qualification contract for every gate eng-init writes, repairs, or audits: naming guards, hooks, CI checks, `verify-*` scripts, generator `--check` modes, and the guardrail self-test itself. "A gate exists" is the weakest possible claim — this file defines what makes a gate trustworthy. Distilled from a production agent-maintained monorepo (see `_archived/ds-harness-mining/01-gates.md` for the source evidence); orchestration (dependency graphs, lane grouping) stays in `agent-harness-templates.md` § Gate runner in code.

## The qualification contract

A qualified gate satisfies all of:

1. **One invariant per gate.** A gate that checks two things gives misleading locations when one fails and cannot be exempted or self-proven independently.
2. **Non-zero exit on violation.** Success is exit 0; failure is non-zero. Never signal failure through output keywords while exiting 0 — a warning that exits 0 is not a gate.
3. **Actionable error message** (protocol below): the reader knows what file, what content, what was expected, and how to fix it without opening the gate's source.
4. **Read-only by default.** Side effects only behind an explicit `--fix` / `--write` mode; CI always runs the read-only mode. Write modes name their target explicitly (`--write <target>` or `--write --all`) — never write implicitly.
5. **Deterministic.** Same input, same result: no clock, network, filesystem-ordering, or optional-tool dependence. When an optional external tool is missing, skip loudly with a reason — never pretend to pass (`misconfiguration fails loud`, `lang-constraints.md`).
6. **Declares its input plane.** A gate consumes either source or build artifacts, never an undeclared mix. Artifact-consuming gates declare the build dependency (gate-runner `needs: [build]`); source gates must pass on a clean un-built checkout.
7. **Self-proof** (next section).

## Self-proof: the dual assertion

"It ran on the real repo and passed" is not self-proof — that only proves the current repo is legal. A gate with a typo'd regex that matches nothing is green forever and more dangerous than no gate. Every non-trivial gate gets a test that asserts **both directions**:

1. **Clean input passes first.** The opening assertion runs the gate against a known-legal input and expects zero violations / exit 0. Without it, an always-failing gate — or one whose setup crashes before checking anything — passes a rejection-only self-test.
2. **Each rule rejects its synthetic violation.** Per accept/reject rule, construct one minimal illegal input, run the gate, assert non-zero exit **and** that the error message contains the location and reason. Assert message substrings, not exact output or line numbers.

Fixture-construction boundary: gates that read the filesystem get a temp-dir fixture (`mktemp -d`, minimal fake structure, removed in cleanup); gates that are pure functions get in-memory strings. Never assert against live-repo state — such a test breaks on unrelated changes and proves no rejection capability.

Discipline:

- **Every new or changed accept/reject rule ships its paired rejection sample in the same change.** A rule without a proven-rejected sample has no evidence it is live.
- The self-test asserts gate *logic*, not repo state.
- Complex gates (parsing, graph analysis, composed rules) prefer property-based tests: generate an input family, assert the invariant.
- `scripts/test-guardrails.sh` (`agent-harness-templates.md` § Guardrail self-test) is the repo-level composite form: clean-state acceptance first, then one staged violation per wired guard.

## Error message protocol

Uniform output makes every gate parseable by CI, agents, and humans alike:

- **Title line**: `<gate-name>: <one-line summary of what was found>:` on stderr.
- **One violation per line**, indented two spaces: `  <file>:<line>  <detail>`.
- **Expected vs. actual as quoted literals** — `expected "check", got "chek"` — never paraphrased.
- **Fix hint embedded in the message**: the exact regeneration command, the manifest to update, or the doc that owns the rule (`run 'just gen-docs' and commit the output`, `update constraints.yaml exemptions in the same change`).
- **Success prints a summary line**: `<gate-name>: N files checked, all conform.` Silent green is forbidden — a CI log must show the gate actually ran, or a gate that silently stopped running is indistinguishable from a gate that passed.
- **Exit codes**: 1 = violation, 2 = usage error. A usage error must never read as "checked and passed".

## Fail-closed on unknown surfaces

A scanning gate that meets an input shape it does not recognize (new syntax, new directory layout, new export form) **errors with "extend the gate"** — it never silently skips. The gate's promise is "unchecked surface does not exist"; a silent skip converts that promise into a lie that grows with the codebase. Corollary: when a bypass path is retired (an old marker, a legacy directory, a grandfathered format), ban it explicitly in the gate so it cannot quietly return.

## Exemption and allowlist hygiene

Every exemption mechanism — lint suppression registries, coverage exemptions, budget overrides, `constraints.yaml` `exemptions`, no-limitations allowlists — is itself gated:

- **Every entry names an existing target.** An entry whose target was renamed or deleted fails with "renamed or removed? update the list in the same change" — stale entries are how allowlists rot into fiction.
- **Every entry carries a non-empty reason.** "Because it fails" is not a reason; the reason states why the exemption is correct, and time-boxed exemptions carry their `exit_condition` (`constraints-yaml-template.md`).
- **Mutually exclusive lists share no entries.** One object on two contradictory allowlists means at least one list is wrong.
- **Exemption is not non-execution.** A suite exempted from an expensive measurement (coverage instrumentation, snapshot recording) still runs in a plain lane where its correctness signal matters — the exemption drops the measurement tax, never the signal.

Readiness: `exemption_registry_hygiene`.

## When to replace a verifier with a generator

Decision rule for hand-maintained lists guarded by a verify gate (tool inventories, event catalogs, dependency tables):

- **Mechanically enumerable from one source** (the AST, the manifest, the directory tree is the whole truth): replace list + verifier with generator + `--check`. Generation is strictly stronger — a verifier checks only names already on the list; a generator enumerates the source, so a never-listed item cannot hide.
- **Not enumerable** (runtime composition, dynamic registration, config-selected names): read the inventory from the real runtime (boot it, query it), and add a completeness guard (disk glob vs. captured inventory) to restore the "nothing new goes missing" property the generator lost.

Mechanics live in `agent-harness-templates.md` § Generated docs — derivation gate. Readiness: `generated_docs_check_mode`.

## Meta-gates: guarding the guards

Highest-leverage checks on the enforcement layer itself, in priority order:

1. **Effective-config fingerprint** (`agent-harness-templates.md` § Gate runner): hash the resolved rule set; changing rules becomes an explicit reviewed act.
2. **Behavioral probe**: plant a temp file containing a known violation (unique suffix, cleaned in `finally`), run the real linter/hook binary, assert non-zero exit and the expected diagnostic — proves the config *intercepts*, not merely *exists*.
3. **CI workflow assertions**: parse the workflow YAML in a test and assert its invariants (the aggregator's `if: always()`, secret-preflight placement, cache-key shape). CI hosts every other gate; host drift silently weakens all of them.

## Readiness mapping

| Concern | Criterion |
|---|---|
| Guards proven to reject | `guardrail_self_test` |
| Allowlists stay live | `exemption_registry_hygiene` |
| Generated outputs cannot drift | `generated_docs_check_mode` |
| Aggregated CI verdict cannot be skipped past | `ci_aggregator_gate` |
