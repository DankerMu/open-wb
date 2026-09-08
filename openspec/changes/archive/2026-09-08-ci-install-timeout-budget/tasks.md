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
- [x] 4.4 A new PR CI run executes every downstream fast-checks and anti-drift step and all eight jobs, including `all-checks-passed`, finish SUCCESS.
  - PR run [34185659896](https://github.com/DankerMu/open-wb/actions/runs/34185659896) (`pull_request`, SHA `7e6ba5356c62f7711c24d5a43239bdd4d9e5322f`) completed all eight jobs successfully. [fast-checks](https://github.com/DankerMu/open-wb/actions/runs/34185659896/job/101933376897) ran for 26s with `npm ci` for 4s and all five protected steps successful; [anti-drift](https://github.com/DankerMu/open-wb/actions/runs/34185659896/job/101933376967) ran for 16s with `npm ci` for 4s and all five protected steps successful.
- [x] 4.5 At least three post-fix independent workflow runs (covering pull_request and push:master, including the archive follow-up when needed) show both target jobs complete their downstream steps without cancellation; record run/job links and observed durations.
  - Evidence 1/3: PR run [34185659896](https://github.com/DankerMu/open-wb/actions/runs/34185659896) above.
  - Evidence 2/3: merge run [34190553440](https://github.com/DankerMu/open-wb/actions/runs/34190553440) (`push:master`, SHA `37465389a1bbec8164ae744baa417b1203d74a7b`) completed all eight jobs successfully. [fast-checks](https://github.com/DankerMu/open-wb/actions/runs/34190553440/job/101947555985) ran for 26s with `npm ci` for 4s and all protected downstream steps successful; [anti-drift](https://github.com/DankerMu/open-wb/actions/runs/34190553440/job/101947556217) ran for 21s with `npm ci` for 5s and all protected downstream steps successful.
  - Evidence 3/3: archive follow-up run [34191118921](https://github.com/DankerMu/open-wb/actions/runs/34191118921) (`pull_request`, SHA `d1d273ea07780df3f9432030ef66d4a136ea71a4`) completed all eight jobs successfully. [fast-checks](https://github.com/DankerMu/open-wb/actions/runs/34191118921/job/101949217179) ran for 24s with `npm ci` for 4s and all protected downstream steps successful; [anti-drift](https://github.com/DankerMu/open-wb/actions/runs/34191118921/job/101949217202) ran for 16s with `npm ci` for 3s and all protected downstream steps successful.
  - These short install durations prove wiring and downstream execution for those runs, not that the unresolved external high-tail source disappeared.

## 5. Non-goals

- [x] 5.1 Do not change registry/cache strategy, npm arguments, dependencies/lockfile, action major versions (#29), target checks, quality thresholds, aggregate semantics, or archived OpenSpec artifacts.
