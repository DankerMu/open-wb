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
- [x] 3.3 Confirm no old/mixed action major, unsecure Node fallback, new permission, action pin-strategy change, application/tool version or product change remains; dependency changes are limited to the explicitly authorized section 6 corrective action.

## 4. Local and external evidence

- [x] 4.1 `make test-guardrails` exits 0 with every new action/matrix/input/fallback mutation PASS and every pre-existing CI harness case preserved.
- [x] 4.2 `make check` exits 0; tests, coverage, static analysis, anti-drift and thresholds are unchanged.
- [x] 4.3 `openspec validate ci-actions-node24-runtime --strict --no-interactive`, workflow syntax inspection and `git diff --check` pass.
- [x] 4.4 A new exact-head PR CI run completes all eight jobs; action setup/post steps and all existing downstream steps execute successfully.
  - PR run [34215476511](https://github.com/DankerMu/open-wb/actions/runs/34215476511) (`pull_request`, SHA `0d7f8c55d7d26e62f20e50979716843f6c56d34e`) completed all eight jobs successfully. The seven direct jobs used checkout v5 ×7, setup-node v5 ×5, setup-uv v7 ×2 and gitleaks-action v3 ×1; every action main/post step and existing downstream step completed successfully.
- [x] 4.5 The same run's seven direct-job check-run annotations contain zero `Node.js 20 is deprecated`; logs prove Node 24.13.1, successful npm cache lookup/restore and post lifecycle (save on primary-key miss or explicit no-save on hit), uv install/cache, full-history checkout/gitleaks and aggregate success without fallback.
  - All seven direct-job annotation endpoints contained zero `Node.js 20 is deprecated`. All five setup-node jobs resolved `.tool-versions` to Node 24.13.1, restored a primary-key npm cache hit and completed their no-save post branch successfully. Both setup-uv jobs installed uv 0.12.10 after a new-key miss; fast-checks saved the shared cache, while unit-tests lost the concurrent same-key reservation and emitted one nonfatal warning with a successful post/job. This is the documented shared-cache producer/no-save race, not a Node 24 incompatibility; adding per-job cache suffixes would duplicate cache state outside this issue. Secret-scan preserved `fetch-depth: 0`, ran gitleaks v3 successfully and finalized its SARIF artifact without exposing token values. `all-checks-passed` succeeded and no unsecure Node fallback was present.
- [x] 4.6 Record the checkout v5, setup-node v5, setup-uv v6/v7 and gitleaks v3 compatibility review conclusions in the PR body, including runner minimum, used/removed inputs, cache behavior and moving-tag boundary.

## 5. Non-goals

- [x] 5.1 Preserve `.tool-versions`, product code/tests, action pin policy, workflow permissions, secret values, timeouts, quality steps, thresholds, constraints and aggregate semantics; do not upgrade beyond v5/v5/v7/v3. Package/lockfile changes are limited to the user-authorized root development dependency `yaml@^2.9.0` and necessary lock metadata.

## 6. User-authorized AST corrective action (2026-09-08)

- [x] 6.1 Declare `yaml@^2.9.0` directly, consume the actual scratch workflow through its AST and remove hand-written global YAML discovery. Retain existing direct-job/aggregate/constraints checks and one `check_wf` entrypoint.
- [x] 6.2 Cover all eleven verified candidates using AST-semantic positive and negative pairs: quoted/flow/block/hanging/tagged values, exact protected/local/docker identities, actual env keys and scalar/comment/container decoys. Invalid YAML, duplicate keys and unsafe alias expansion must fail closed; unsupported syntax cannot silently hide protected uses.
- [x] 6.3 Run fresh `make test-guardrails`, `make check`, strict OpenSpec and source/lockfile integrity checks.
- [x] 6.4 Run an independent invariant audit, comprehensive Round 2 and Phase 7 on the final head without resetting the PR counter.
- [x] 6.5 Record the authorized dependency/architecture deviation and exact-head CI evidence in the PR; preserve the original Node24 action and cache/annotation acceptance criteria.
  - Phase 6.2 and comprehensive Round 2 were clean at `4a0a3b0c613e720287726b66e77ee85b1a3452bb`; Phase 7 found no candidates. PR run [34298761001](https://github.com/DankerMu/open-wb/actions/runs/34298761001) completed 8/8 at the same SHA, with zero annotations across all seven direct jobs. The PR body records the AST dependency exception and keeps the local 460-case evidence separate from CI.
