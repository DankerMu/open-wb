## 1. Contract and baseline
- [x] 1.1 Expanded fixture review PASS on initial review with no required additions; strict validation passed. Existing proxy/runtime ports, source/tests and verification configuration identities frozen before A1.
- [ ] 1.2 A1 tests before source SETUP; separately authorized callable wrong A2 semantic RED; preserve standalone original tests before B.
## 2. Registry
- [ ] 2.1 Implement private indexed CSPRNG registry, exact lookup, isolated rotation/revocation and fail-closed entropy/collision paths; focused realcrypto1000 + controlledfault GREEN.
## 3. Acceptance and delivery
- [ ] 3.1 Parent compiled realcrypto/failure/lifecycle and localHTTP proxy probe; wrongcandidate qualification/restoration/stability; fullserver coverage/types/build/Biome/anti-drift/OpenSpec; frozen neighbors intact.
- [ ] 3.2 Expanded correctness/test-evidence+spec/security-perf review; bounded fix gate; same-SHA CI/source PR merge.
- [ ] 3.3 Separate docs-only canonical bearer requirement promotion/archive and parent3.4 update; do not claim shared-instance root assembly completed.
## Core risk mapping
- Public API selected: three methods structurally compatible with both ownedports→1.1/2.1/3.1.
- Config/projectsetup not selected: no dependency/config/env orsetup changes.
- File IO/path not selected: in-memoryregistry, no paths or persistence.
- Schema/fields/units selected:32bytes/64lowercasehex, exactopaque string andlivebinding cardinality→2.1/3.1; no DBschema.
- Auth/permissions/secrets selected: unguessable sessionbearer, exactlookup/revocation/rotation, no cross-sessionoverwrite/logging/upstreamkeys→2.1/3.1.
- Concurrency/state/order selected: atomic synchronousindex commit, failurepreservation, instance/sessionisolation, no stale reversebindings→2.1/3.1.
- Resource/largeinput selected: indexedlookup/revoke, boundedlive-stateownership/no revokedhistory retention; no timerhandles→2.1/3.1.
- Compatibility selected: TokenLookup and SessionTokens remain unchanged, proxycalls actualnewregistry in parentprobe→1.1/3.1.
- Error/rollback selected: entropythrow and livecollision preservebindings beforecommit, no fallback/retry orsecrets inerrors→2.1/3.1.
- Release/packaging selected: actualcompiled module +sameSHA CI, zero dependencies→3.1/3.2.
- Documentation selected: canonicalbeareronlypromotion andparentboundarynotes→1.1/3.3.
## Project domain mapping
Selected tenant credential isolation/auth-sessionlifecycle andoffline deployability→2.1/3.1. Existingcross-service bearerboundary is exercised throughlocalHTTP→3.1, not changed. Not selected sandboxfiles/processspawn/environment, SQLitecatalog/migration, browserrouting/persistence, newHTTPenvelopes: unchanged orlaterassembly. Stale runtime generation callbacks remain runtime-owned; registry revokes the current binding when legitimately called.
## Governance
One writer/currentcheckout/no newworktree. Source tokens.ts+paired tests only; parent owns fixture and acceptance. A1/A2/B separately authorized. Writer cannot read any parent evidence/probe/plan/qualification artifacts; only its own newly written reports/logs are readable. Parent alone compares protectedmanifest. No config/threshold/neighbor edits, no insecure fallback. Writer skips formatter/lint/types/build/fullsuite/git/nestedagents. Reviewers read-only leaf and run no tests/probes/validation. User waived perissuehumanreview, not agentreview/CI/finalEpicfunctionalreview.
