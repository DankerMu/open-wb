# Failure Taxonomy and Repair

Classify from concrete evidence before changing code. A stable failure signature includes
input, boundary, mismatch class, environment/seed, and observed delta—not merely “tests
failed.”

| Class | Typical evidence | First action |
|---|---|---|
| INTENT_AMBIGUITY / SPEC_DISPUTE | sources/examples conflict or contract cannot decide behavior | stop candidate edits; obtain Contract Owner decision |
| COMPILE_LINK | diagnostics, missing symbols, layout errors | fix the narrow structural contract; do not call it semantic acceptance |
| STARTUP | crash, initialization/config/load failure | compare environment and initialization path |
| CONTRACT | status/schema/exit/error protocol mismatch | reduce to one public-boundary fixture |
| BEHAVIOR_DIFF | same semantic input, output/state/effect differs | minimize input and trace first divergence |
| DATA | count/key/null/aggregate/integrity mismatch | compare stage-by-stage invariants |
| PERFORMANCE | calibrated metric regression | profile; preserve correctness gate; do not guess from source shape |
| STATISTICAL_INCONCLUSIVE | result inside noise/interval or sampling incomplete | preserve samples; follow declared stopping rule |
| MEMORY_RESOURCE | leak, allocation, FD/thread/resource growth | reproduce with sanitizer/profiler/counters |
| RACE_ORDER | nondeterministic state, ordering, schedule, replay failure | capture seed/schedule; inspect ownership and idempotency |
| PLATFORM | OS/arch/runtime/toolchain-only failure | reproduce in that matrix cell |
| SEMANTIC_TRANSLATION | source/target constructs differ at runtime | add a differential fixture at the semantic boundary |
| HARNESS | oracle crash, invalid fixture, broken setup | repair and requalify harness before candidate work |
| ORACLE_FALSE_ACCEPT | known-bad candidate passes | invalidate evidence; strengthen/rebuild and requalify oracle |
| ORACLE_FALSE_REJECT | known-good candidate fails | freeze candidate edits; diagnose judge/contract/environment |
| ORACLE_CONFLICT | qualified judges disagree | compare scope/assumptions; resolve contract or judge conflict |
| ENVIRONMENT_DRIFT | dependency/toolchain/config/data/platform identity changed | restore or approve new identity, then requalify/rerun |
| TEST_DISCOVERY_DRIFT | fewer tests/shards or new skips despite green result | restore discovery; reject acceptance |
| SPEC_DRIFT | contract/reference/fixture identity differs from qualified evidence | approve/revise, invalidate, requalify, rerun |
| PROVENANCE_MISMATCH | candidate/artifact/attestation digest does not match execution | reject evidence and rerun in clean control plane |
| CAPABILITY_VIOLATION | unauthorized file/network/secret/destructive operation | stop agent, preserve audit log, restore protected state |
| DEPENDENCY_TAMPERING | lockfile/build/cache/dependency changes alter judge or behavior | restore/review separately; invalidate affected evidence |
| CHEATING | legacy fallback, hardcoded fixture, skipped checks, relaxed threshold | reject candidate and restore judge |
| AUDIT_COVERAGE | systemic fix landed but instances lack disposition | rescan frozen inventory; do not infer closure |
| REPAIR_REGRESSION | counterexample fixed but new fault appears | revert or isolate; independently diagnose and reverify |
| UNKNOWN | evidence fits no class | stop speculative edits; gather a smaller trace |

## Repair record

```yaml
failure_signature: ""
class: ""
claim_ids: []
defeater_ids: []
failing_input: ""
reference_or_expected_result: ""
candidate_result: ""
first_divergence: ""
environment_digest: ""
seed_or_schedule: null
hypothesis: ""
repair_scope: []
cheap_reproducer: ""
focused_gate: ""
affected_broad_gates: []
attempt: 1
result: pass | same_failure | new_failure | blocked
oracle_revisions: []
reference_revision: null
finding_ids: []
inventory_disposition: confirmed_fixed | not_applicable | unresolved | unknown | null
```

## Escalation

- Attempt 1: inspect direct delta and rightful owner.
- Attempt 2: add tracing or compare the preceding stage.
- Attempt 3: minimize fixture, use delta debugging, or isolate environment/schedule.
- Same signature after the configured budget: stop implementation edits. Re-check intent,
  judge, seam, unit size, environment, and missing domain decisions.
- Systemic fix: rerun original per-instance inventory and class-wide check.
- Critical repair: independent acceptor reruns original counterexample, class-wide check,
  and broader regression.

Never churn through speculative edits. Never broaden exception handling, add hidden
retries, or weaken the judge to turn an unknown failure into apparent success.
