# Verification Tiers — distilled from the DeepSeek Harness SDK

The verification culture of a production agent harness, distilled into tier definitions and the rules that keep each tier honest. Use this with `gate-quality-contract.md`: that file owns *how a gate proves itself*; this file owns *which tiers a repo needs and what each tier may claim*.

## The tier pyramid

| Tier | What it proves | When it is required |
|---|---|---|
| Unit | Local behavior of one module | Always, for every change touching the module |
| Coverage gate | Lines ran, not that the feature works | CI gate; `test_coverage_thresholds` criterion |
| Real-API e2e | The agent works against a real model/service | For agent/product-visible behavior; suites self-skip without keys |
| Keyless snapshot replay | Assembled behavior pins: transport contracts, presentation, persisted logs | Every non-trivial model-, protocol-, or human-visible change |
| Built-artifact smokes | The *published artifact* boots (settle races, module resolution, swallowed load failures) | For any package with a `bin` or non-index runtime entry |
| Browser snapshot | Rendered GUI journeys | For web surfaces (Chromium compares replayed output) |

## Rules that keep the tiers honest

1. **A keyless scenario ships with the change.** Every non-trivial model-, protocol-, or human-visible change adds or updates a keyless scenario in the same PR, through a runnable example's owning snapshot suite — not a package test, not a mock-only fixture. The assembled transcript is the oracle; unit tests prove plumbing, snapshots prove the assembled product. When the harness cannot express the scenario, extending the harness is part of the change.
2. **Real entry path, not hand-built harnesses.** Product-visible plugins require a non-unit REAL-composition test: boot the real `cordis.yml`-style composition through the Loader and app/process; mock only external services or nondeterministic inputs; assert model-visible request/log, durable state, or user-visible output. A hand-rolled `ctx.plugin(...)` proves the bridge moves bytes, not that the shipping tool behaves.
3. **Verify the world, not the self-report.** An e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own output lets a cheating agent pass. Assert untouched files are byte-identical.
4. **Source plane only in tests; built plane only in smokes.** Test resolution points at `src`, never through package `exports` to built `lib/` — stale artifacts load a second copy of module singletons and mask regressions. Built artifacts are consumed only by explicit lib-mode subprocesses and the built-artifact smokes (a package `bin` runs built `lib/` under plain node, exposing what a source-transpiling hook masks).
5. **CI never writes snapshots.** CI replays in read-only mode; record/refresh stay local and every diff is human-reviewed; never grow normalizers to absorb real behavior differences — fix the fixture or the product. (SKILL.md anti-patterns own the rule; this reference keeps the working statement so the tier list reads standalone.)
6. **Capability-proving suites assert zero skipped tests.** A suite that exists to prove a capability must not self-skip into green. (SKILL.md anti-patterns own the rule — this reference adds only the why: a green-but-skipped suite is a fake gate.)
7. **With-key policy is not rationing.** A no-key test proves plumbing; only a with-key run proves the agent works against a real model. Highest-value are smoke tests that boot the real example, send one prompt, and check the world — they catch the "green unit tests, broken product" class that mocks cannot.
8. **Coverage as a gate, with the dead-code reading.** Strong form (per-file 100%): an uncovered line is a dead-code candidate the gate is correctly flagging for deletion, not a missing test to bolt on. (The interpretation, thresholds, and enforcement live in criterion `coverage_per_file`, question-bank Q4.2, and SKILL.md's never-relax-a-gate anti-pattern; `gate-quality-contract.md` owns gate qualification.)
9. **Recovery and failure paths are first-class.** Cover exhaustion, cancellation, policy composition, persistence, status, wire counts, transport-closing idle timeouts, and shipping Loader composition. Recovery tests separate pre/post-chunk failures by step and prove failed chunks derive no message or tool side effect.

## Mapping to eng-init artifacts

- Verification Matrix rows resolve through the selected dev entry point; each tier above that applies becomes a row (or an explicit readiness gap).
- `gate-quality-contract.md` supplies the per-gate proof discipline; a tier without a failing mechanism scores as "configured but not blocking".
- Criteria that operationalize this file: `verification_snapshot_tiers`, `built_artifact_smokes`, `coverage_per_file`, `guardrail_self_test`.
