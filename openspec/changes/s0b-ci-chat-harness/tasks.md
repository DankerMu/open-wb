## Risk Packs
- Public API/CLI selected: Hurl and shell/Make entry boundaries →1.1–2.3.
- Config selected: exact job env/order and raw clean argv →1.1,1.2,2.3.
- File IO/path safety selected: quoted job-local paths and no sibling cleanup →1.2,2.2; product sandbox logic unchanged.
- Schema not selected: consume existing REST snapshot DTO; no schema migration or API change.
- Auth/secrets selected: independent cookies/logout, foreign404, bearer401, no harness secrets/token diagnostics →2.1–2.3.
- Concurrency/shared state selected: two job identities, startup ordering, signal races →2.2.
- Resource limits selected: bounded poll/readiness/teardown and no child residue →2.1,2.2.
- Legacy compatibility selected: preserve public/auth, existing UI journey, Make smoke-live, action matrix and all old guard cases →2.1–2.3.
- Errors/rollback selected: prerequisite/harness/early exit/cancellation/cleanup nonzero →2.2; atomic revert boundary.
- Packaging selected: real official18.0.10 digest/version, no new deps/action/cache →2.1,2.3.
- Documentation selected: source receipt/canonical promotion without #106/#107 claims →3.1.
- Domain process/child-env, cross-service, offline selected: actual pinned executable→proxy→local fixture and cleanup/no real upstream →2.1,2.2.
- Domain tenant/auth selected: foreign404/cookie isolation →2.1. Product sandbox/uid permissions unchanged; real same-uid S0b limitation remains.
- Domain SQLite selected only fresh isolated DB/auth-session cleanup →2.1,2.2; migration/catalog not selected.
- Domain browser selected only regression of existing journey/error oracle →2.1; new dialogue navigation/reload belongs #106.

## 1. Atomic implementation
- [x] 1.1 Test-only handoff preceded production: parent observed missing three-file/workflow/ownership contract; initial malformed Python embedding was setup failure, repaired before accepting semantic RED. Missing launcher was separately classified setup RED.
- [x] 1.2 Single implementer atomically wired verified fetch, owned upstream, explicit runtime env, chat.hurl and three-file Make smoke; product hashes and smoke-live bytes unchanged.

## 2. Parent verification
- [x] 2.1 Both builds passed; omp/18.0.10 and Hurl8.0.1 recorded. Final real smoke twice passed3/3 files,22 requests each; independent chat-only passed10 requests; existing UI journey passed1/1. SQLite confirms zero auth sessions, done chat and done bash.
- [x] 2.2 Six semantically bad HTTP fixtures rejected by unchanged chat.hurl; control/multiple steps/shape-empty/restored/stability passed, each prompt POST occurred once. Independent upstream-death counterexample initially returned0, corrected to nonzero; both-mode permanent lifecycle tests and existing cancellation/sentinel cases passed. Post-teardown pinned omp process snapshot empty.
- [x] 2.3 Complete make test-guardrails passed, CI harness542PASS/0FAIL; shell syntax, four-action inspector, naming/size guards and strict OpenSpec passed. Source/oracle/toolchain identity records retained outside checkout.
- [ ] 2.4 Expanded independent source review and exact-head required CI pass; source CI must run real fetch/upstream for both jobs.

## 3. Delivery
- [ ] 3.1 Merge source, close #105, sync parent6.2 receipt and prepare canonical archive without publishing #106/#107; independent archive PR/CI/merge gates next issue.

User decision: the secrets ban applies to smoke/ui-walk, not existing secret-scan GITHUB_TOKEN. Evidence resides outside the candidate checkout at /tmp/open-wb-issue105-evidence; this is parent-owned evidence plus independent CI, not an OS-enforced enclave claim. Candidate writers run no validation or formatter and cannot edit fixtures/evidence. Parent owns acceptance.

Local evidence: /tmp/open-wb-issue105-evidence. Initial real Hurl run exposed singleton/empty JSONPath count coercion; replaced filter-count with typed JSONPath count predicate plus absence assertion, independently qualified zero/one/many and failed-step cases. Initial parent PATH omitted pinned Node; that startup failure is environment setup evidence, not product failure. Guard quoting/stub regressions took two postimplementation repairs to542PASS. A separate subsequently discovered upstream premature-exit false-green was fixed with a permanent both-mode regression. Writer disclosed extracted Python compile/exec validation contrary to its no-validation brief; those results are not acceptance evidence, parent reran independently. UI dialogue/reload remains #106, control-plane mirrors #107.

Review round1 I1 (resource) confirmed: SIGSTOP an actual running omp, cancel wrapper → exit143 after5.93s while omp survived and app died. Fix pass1 gives app an owned process group and increases normal grace; group escalation reaps descendants. Real stopped omp in both modes now exits143 with app/omp gone (~8.8s); stopped app+omp forces group escalation with both gone (~21.3s), unrelated sentinel survives; early-dead-app probe also passes. Final full guardrails554PASS/0FAIL; both real smoke runs and existing UI remain GREEN. Initial added ownership mutants survived the static oracle; corrected meaningful pre-launch group mutation and exact protection, then repaired nested Python quoting. Parent accepted only fresh parsed/full-suite GREEN, not writer syntax checks. Re-review and new-head CI still pending.

Review round2 E1 (test-evidence) confirmed: the old command-substitution fixture wrote parent $$ into child.pid and never reached parent setup. Fix pass2 directly spawns and records $!, proves distinct live parent/child identities and installed trap readiness before release, observes leader death while child remains live, and checks separate deaths/sentinels. Parent rejected an intermediate exit0/553-case run because missing shell quotes swallowed two cases; no acceptance was issued. Final full guards563PASS/0FAIL with all four setup observations and intended transitions executed. An external kill-function fault preserves static source anchors but makes all three descendant-death assertions fail (13PASS/3FAIL); unchanged wrapper restoration16PASS/0FAIL and dedicated stability16PASS/0FAIL pass. Source wrapper is byte-identical to the real-native both-mode accepted I1 repair; final re-review and exact-head CI remain pending.
