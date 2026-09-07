## 1. Diagnosis and contract

- [x] 1.1 Reproduce the failure class from historical Actions metadata/logs with a red-capable classifier: five-minute job cancelled during a 295s+ `npm ci`, intended downstream step skipped.
- [x] 1.2 Record a duration/cache/result matrix across bad, neighboring and recent runs; distinguish setup-node npm cache from `node_modules` reuse.
- [x] 1.3 Conclude only the evidenced controllable cause (total timeout budget exhaustion) and leave registry/cache-reify/runner latency attribution unresolved.
- [x] 1.4 Define a complete `verification-harness` MODIFIED requirement delta that supersedes only the two frozen timeout values, folds into the canonical spec at archive time, and preserves all historical archives and gates.

## 2. Tests first

- [x] 2.1 Extend the source-derived CI oracle to require fast-checks and anti-drift exact 10-minute values and exact matching `constraints.yaml` fields.
- [x] 2.2 Require each target job's `npm ci` and all current downstream quality steps, with no job/step `if`, `continue-on-error`, custom shell or replacement bypass.
- [x] 2.3 Add batched mutation proof for timeout rollback, missing/mismatched constraints, removed/replaced quality steps and aggregate weakening; prove tests fail against pre-change source and leave no red-proof stash.
- [x] 2.4 Preserve controls showing unrelated legacy job content may evolve without weakening the protected target jobs.

## 3. Implementation

- [x] 3.1 Change only fast-checks and anti-drift `timeout-minutes` from 5 to 10 in `.github/workflows/ci.yml`.
- [x] 3.2 Set `ci.fast_checks_timeout_minutes: 10` and add `ci.anti_drift_timeout_minutes: 10` in `constraints.yaml`.
- [x] 3.3 Preserve every target quality step, clean-install behavior, the seven-job aggregate dependencies, failure/cancelled/skipped rejection and all unrelated timeout/threshold values.

## 4. Required evidence

- [x] 4.1 `make test-guardrails` exits 0 and all new timeout/mirror/step/aggregate mutations are reported PASS.
- [x] 4.2 `make check` exits 0; no product test, coverage or anti-drift threshold is weakened.
- [x] 4.3 `openspec validate ci-install-timeout-budget --strict --no-interactive` exits 0.
- [ ] 4.4 A new PR CI run executes every downstream fast-checks and anti-drift step and all eight jobs, including `all-checks-passed`, finish SUCCESS.
- [ ] 4.5 At least three post-fix independent workflow runs (covering pull_request and push:master, including the archive follow-up when needed) show both target jobs complete their downstream steps without cancellation; record run/job links and observed durations.

## 5. Non-goals

- [x] 5.1 Do not change registry/cache strategy, npm arguments, dependencies/lockfile, action major versions (#29), target checks, quality thresholds, aggregate semantics, or archived OpenSpec artifacts.
