## 1. Baseline and upstream compatibility

- [x] 1.1 Record a current successful master run where all seven direct jobs emit `Node.js 20 is deprecated`, including the exact action list per job and the distinction from project Node 24.
- [x] 1.2 Verify old and candidate major `action.yml` metadata: checkout v4/v5, setup-node v4/v5, setup-uv v5/v7 and gitleaks-action v2/v3 declare node20/node24 respectively; record resolved commits and hosted-runner minimum.
- [x] 1.3 Review checkout v5, setup-node v5, setup-uv v6/v7 and gitleaks v3 migration notes against every used input, cache behavior, full-history/token boundary and runner environment; record why removed/changed inputs do not affect this workflow.
- [x] 1.4 Inventory the current live matrix of checkout×7, setup-node×5, setup-uv×2 and gitleaks×1 across all seven direct jobs, replacing the issue's historical five-job snapshot without expanding beyond the current workflow.

## 2. Tests first

- [x] 2.1 Extend the existing structural CI oracle with one shared action-use matrix layer: update existing exact tuples for fast-checks/anti-drift/smoke/ui-walk, and validate only uses cardinality, critical inputs and relative order for unit-tests/secret-scan/sast rather than duplicating their full job definitions; preserve every run step, timeout and aggregate check.
- [x] 2.2 Require exact setup-node node-version/cache inputs, secret-scan fetch-depth/token, setup ordering and absence of workflow/job `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` or action bypass metadata.
- [x] 2.3 Add non-vacuous mutations for every old major, partial mixed majors, omitted/duplicated/replaced/relocated action, each critical input/order drift and Node 20 fallback; bind each mutant to the scratch workflow and distinguish missing-anchor generation failure.
- [x] 2.4 Replace the now-protected gitleaks legacy-body positive control with a truly unrelated job/action-free body control, preserving intended evolution without weakening the seven-job matrix.
- [x] 2.5 Before changing the workflow refs, run the updated oracle against the old-major workflow and record a nonzero red result attributable to the exact old-major matrix; leave no red-proof stash.

## 3. Workflow implementation

- [x] 3.1 Replace all checkout v4 uses with checkout v5, all setup-node v4 uses with setup-node v5, both setup-uv v5 uses with setup-uv v7 and the gitleaks v2 use with gitleaks v3.
- [x] 3.2 Preserve the exact seven-job action cardinality, critical `with`/`env` fields, action ordering, every run step, timeout, constraints mirror, aggregate dependency/predicate and workflow trigger.
- [x] 3.3 Confirm no old/mixed action major, unsecure Node fallback, new permission, action pin-strategy change, application/tool version, dependency/lockfile or product change remains.

## 4. Local and external evidence

- [x] 4.1 `make test-guardrails` exits 0 with every new action/matrix/input/fallback mutation PASS and every pre-existing CI harness case preserved.
- [x] 4.2 `make check` exits 0; tests, coverage, static analysis, anti-drift and thresholds are unchanged.
- [x] 4.3 `openspec validate ci-actions-node24-runtime --strict --no-interactive`, workflow syntax inspection and `git diff --check` pass.
- [ ] 4.4 A new exact-head PR CI run completes all eight jobs; action setup/post steps and all existing downstream steps execute successfully.
- [ ] 4.5 The same run's seven direct-job check-run annotations contain zero `Node.js 20 is deprecated`; logs prove Node 24.13.1, successful npm cache lookup/restore and post lifecycle (save on primary-key miss or explicit no-save on hit), uv install/cache, full-history checkout/gitleaks and aggregate success without fallback.
- [x] 4.6 Record the checkout v5, setup-node v5, setup-uv v6/v7 and gitleaks v3 compatibility review conclusions in the PR body, including runner minimum, used/removed inputs, cache behavior and moving-tag boundary.

## 5. Non-goals

- [x] 5.1 Do not change `.tool-versions`, package/lockfile, product code/tests, action pin policy, workflow permissions, secret values, timeouts, quality steps, thresholds, constraints or aggregate semantics; do not upgrade beyond v5/v5/v7/v3.
