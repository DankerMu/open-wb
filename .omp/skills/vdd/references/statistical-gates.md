# Statistical and Probabilistic Gates

Single-run pass/fail is insufficient for performance, concurrency, distributed systems,
flaky dependencies, randomized algorithms, and AI/ML outputs. A statistical gate must
still be tied to an explicit claim and failure model.

## Required declaration

```yaml
metric: ""
direction: lower | higher | within_range
unit: ""
workload_identity: ""
environment_identity: ""
warmup_runs: 0
measurement_runs: 0
seed_policy: fixed | enumerated | random_recorded
no_change_control_runs: 0
summary: mean | median | p95 | p99 | rate | interval | distribution_test
noise_band: ""
minimum_meaningful_change: ""
resource_ceiling: null
flake_budget: 0
retry_policy: none | visible_bounded
stopping_rule: ""
inconclusive_rule: ""
```

Evidence must repeat the Contract's metric name, direction, run count, noise band, and
minimum meaningful change. Compare normalized numeric policy values (`5`, `5.0`, and
`"5%"` where percentages are the declared unit), retain the raw baseline/candidate
samples, and reject any undersampled or identity-mismatched result. The reference
acceptance control plane ignores proposal-supplied metric results: the Contract names a
structured result path, and the final plan step must produce that artifact inside
protected output scope. The reference linter derives the mean relative change from those
protected samples, applies direction, noise, and minimum-change gates, and rejects a
result label that contradicts that derivation. More advanced interval/distribution gates
need their own protected parser and independently recomputable result.

## Gate order

```text
semantic correctness
→ safety/security/resource hard constraints
→ environment/workload identity
→ no-change stability
→ primary statistical metric
```

Do not trade correctness or a hard constraint for a better metric.

## No-change control

Run the unchanged baseline in the same measurement system. The observed variation is the
minimum evidence needed to distinguish a real effect from harness noise. Interleave or
randomize baseline/candidate order when temporal drift is plausible.

## Inconclusive results

Return `STATISTICAL_INCONCLUSIVE` when:

- the observed effect is inside the calibrated noise band;
- the interval/distribution crosses the acceptance threshold;
- the run count or workload is below the declared stopping rule;
- retries or outlier removal were not declared;
- the environment/workload identity changed;
- semantic or resource gates failed.

Inconclusive is not failure and not success. Preserve the samples and either gather the
predeclared additional evidence or stop.

## Retry and flake visibility

Retries must be bounded, counted, and included in the result. A pass after hidden retries
is not equivalent to a first-attempt pass. Do not add sleeps or retries to hide a race or
outage. Classify the underlying failure and retain its seed/schedule when possible.

Fresh Oracle stability is one such visible bounded gate: run every Contract-declared
post-restoration trial, retain both passes and failures, derive the flake rate as
`failed_trials / declared_trials`, and accept only when it stays within the declared
budget. A failed stability trial inside that budget is evidence, not an aborted run.

## Fast-path evidence

For an optimization, prove the intended branch executed using counters, tracing,
instrumented input types, allocation/resource bounds, or a fixture that would fail if the
fast path were wrong. A benchmark that silently exercises the fallback does not verify
the optimization.
