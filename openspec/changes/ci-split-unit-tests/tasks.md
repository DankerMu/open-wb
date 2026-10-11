## 1. Contract

- [ ] 1.1 Confirm root `package.json` workspaces are exactly `server` and `web`, both `test` scripts are `vitest run --coverage`, and the web suite needs neither uv nor kbservice.
- [ ] 1.2 Write the `verification-harness` MODIFIED delta for「CI 接线与控制面同步」and「第三方 CI action 使用 Node 24 runtime」: nine direct jobs, checkout/setup-node 9/7, the split paragraph and its two scenarios with the timing evidence.

## 2. Oracle first

- [ ] 2.1 Teach `scripts/test-ci-harness.sh` the new job: required job names, direct/node job matrices, aggregate `needs`, and exact metadata + step pins for `unit-tests` and `unit-tests-web`.
- [ ] 2.2 Update `scripts/inspect-ci-workflow.js` protected-action counts to checkout 9 / setup-node 7.
- [ ] 2.3 Add negative cases: job missing, job absent from `needs`, timeout 15 on either test job, action major drift, setup-node omitted/duplicated/replaced/relocated, checkout omitted, extra setup-uv, `npm ci` or test step deleted/replaced, workspace swapped, job/step `if`/`continue-on-error`.
- [ ] 2.4 Show the updated oracle is red against the pre-change workflow.

## 3. Implementation

- [ ] 3.1 `.github/workflows/ci.yml`: `unit-tests` runs `npm test --workspace server` then pytest; add `unit-tests-web`; add it to `all-checks-passed.needs`. Nothing else in the workflow changes.
- [ ] 3.2 Sync the job lists in `AGENTS.md` (CI 排障协议) and `IMPLEMENTATION_PLAN.md`.

## 4. Evidence

- [ ] 4.1 `bash scripts/test-ci-harness.sh` exits 0 before and after; manual mutations of the final workflow (drop from `needs`, timeout 15, delete job) each exit non-zero.
- [ ] 4.2 `make check` exits 0; `openspec validate ci-split-unit-tests --strict --no-interactive` exits 0; `actionlint` clean.
- [ ] 4.3 The PR's own CI run shows all ten checks green; record the durations of `unit-tests` and `unit-tests-web` in the PR.

## 5. Non-goals

- [ ] 5.1 No change to test content, coverage thresholds, local `make test`, other job timeouts, `constraints.yaml`, dependencies or lockfile; no test sharding.
