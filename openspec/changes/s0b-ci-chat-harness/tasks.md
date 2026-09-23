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
- [ ] 1.1 Test-only handoff: add exact workflow/Make/script expectations and meaningful runtime/oracle cases before implementation; parent records failing assertions against current behavior, not missing-file-only RED.
- [ ] 1.2 Single implementer atomically wires pinned fetch, owned upstream, explicit runtime env, chat.hurl and three-file Make smoke; preserve existing contracts and no product changes.

## 2. Parent verification
- [ ] 2.1 Build both apps; record actual omp18.0.10 identity and Hurl8.0.1; run real three-file make smoke twice plus independent chat-only and existing make ui-walk, with exact text/bash/isolation and authentication cleanup observations.
- [ ] 2.2 Qualify Hurl semantic faults and lifecycle failure/cancel/cleanup oracles in disposable candidates; each required wrong result fails for its intended reason, restoration passes, dedicated stable repeat passes, owned processes gone and unrelated sentinel alive.
- [ ] 2.3 Run complete make test-guardrails, focused shell/static checks, strict OpenSpec and unchanged four-action inspection; bind oracle/source/toolchain identities and no skipped/relaxed cases.
- [ ] 2.4 Expanded independent source review and exact-head required CI pass; source CI must run real fetch/upstream for both jobs.

## 3. Delivery
- [ ] 3.1 Merge source, close #105, sync parent6.2 receipt and prepare canonical archive without publishing #106/#107; independent archive PR/CI/merge gates next issue.

User decision: the secrets ban applies to smoke/ui-walk, not existing secret-scan GITHUB_TOKEN. Evidence resides outside the candidate checkout at /tmp/open-wb-issue105-evidence; this is parent-owned evidence plus independent CI, not an OS-enforced enclave claim. Candidate writers run no validation or formatter and cannot edit fixtures/evidence. Parent owns acceptance.
