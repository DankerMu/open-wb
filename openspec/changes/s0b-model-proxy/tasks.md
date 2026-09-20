## 1. Contract and test-first barriers
- [x] 1.1 Expanded fixture review PASS after correcting the unapproved header/TTFT timeout to connection-only10s; user-decided5xx/auth-first sync preserved. Child/parent strict validation exit0; freeze source/config/fixture baseline before StageA1.
- [x] 1.2 A1: tests landed with source absent; four missing-module suites recorded as SETUP only. A2: callable404 scaffold produced49 semantic failures before StageB authorization; parent compiledHTTP probe independently rejected400 instead of401. Frozen identities/raw logs retained in `/tmp/open-wb-issue98-evidence/`.
## 2. Proxy implementation
- [x] 2.1 Implement sole registration/TokenLookup port, auth-first configuration behavior, no-store and encapsulated raw JSON4MiB parser; root assembly/guard and canonical error ownership unchanged.
- [x] 2.2 Implement credential replacement and exact byte/status/content-type streaming,5xx/transport502 and10s DNS/TCP/TLS connection-establishment deadline; no retries/redirect following/header-TTFT/whole-stream timeout.
- [x] 2.3 Real #88 composition and recording/gated upstream tests pass:50 focused cases, including test-first repair of app close during an incomplete authenticated upload.
## 3. Independent acceptance and delivery
- [x] 3.1 Parent acceptance:891/891 server tests,90.33% statements/88.24% branches; lint/types/drift/build/strictOpenSpec exit0. Independent HTTP, upload-close and8 lifecycle scenarios pass;19 disposable semantic mutants rejected with restoredGREEN and dedicated no-change controls, including verified pooledHTTPS. Evidence: `/tmp/open-wb-issue98-evidence/qualification-attestation.json`.
- [ ] 3.2 Expanded correctness / test-evidence+spec-compliance / security-perf review, bounded fix gate, same-SHA CI and automatic sourcePR merge.
- [ ] 3.3 Update parent task2.3 and archive to canonicalmodel-proxy in docs-only follow-up; preserve existingfake requirement and user decisions.
## Risk packs
- Selected Public API/entry: one POST/v1/chat/completions plus exportedregistration/TokenLookup; 1.2/2.1/3.1.
- Selected Config: optionalupstream vs configuredbaseUrl/apiKey; auth-first missingconfig502; noenv/assembly here; 2.1/3.1.
- Not selected FileIO/path safety: no files, models.yml or sandbox access.
- Selected Schema/fields:64hex token, exactJSONbytes/media,4MiB byte units, response status/type/body; 2.1-2.3.
- Selected Auth/secrets: validlookup only, missing/malformed/unknown/revoked zero-contact, replacementAuthorization/no clientcookie, sanitized502; 2.1-2.3/3.1.
- Selected Concurrency/order: auth beforeparser, firstbyte beforeend, abort/latefailure/shutdown, no danglingcompletion; 2.2-2.3/3.1.
- Selected Resource/largeinput:4MiB exact/overflow,10s connection-establishment deadline, established delayedheaders/longstream preserved, backpressure/cancel/socket/timer cleanup; 2.1-2.3.
- Selected Compatibility: preserve #84 error identity and siblingauth/cache/parser/guard; #88 two-roundcomposition; fullserver/3.1. FutureTokenRegistry uses owned structuralport only.
- Selected Error/partialoutputs:401/400/502/no-store, passthrough non5xx, no fakeJSON/DONE afterstreamcommit; 2.2-2.3.
- Selected Release/dependencies: Node24 standardnetwork/streams, compiledruntime probe, zero newdependencies; 3.1.
- Selected Documentation: explicit user decisions synchronized beforefreeze; parentledger/canonicalpromotion; 1.1/3.3.
## Project domain risk packs
- Selected cross-service boundary/offline deployability: real loopbackupstreams only, no vendor network;2.3/3.1.
- Selected auth/session lifecycle and HTTP-envelope compatibility: TokenLookup hit/revoke semantics and no-store/error precedence;2.1/2.3. TokenRegistry/runtime lifecycle implementation belongs#90/#100.
- Selected process/child-environment isolation only atcredentialproxyboundary: upstreamkey supplied toparent-ownednetworkonly; no omp spawn/env change inthisslice. Actual childsentinelcomposition belongs#102.
- Not selected tenant/sandbox filesystem, SQLite migration/catalog or browser runtime: no touched behavior.
## Governance
One writer/currentworktree, no newworktree. StageA barriers mandatory; no retrospective stub replay. Fixtures/deps/config/CI/thresholds protected; reviewers read-only with no validation commands. User per-issuehumanwhitebox waiver retained; independentagentreview/CI/finalEpicfunctionalreview notwaived.
