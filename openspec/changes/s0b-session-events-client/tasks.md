## Risk Packs
- Selected Public API / Schema: injected connector, exact wire payload/id decoding and named view/DTO contracts (1.1–1.3,2.1).
- Selected Auth: account-bound loader, close invalidation and session identity; no cookie/provider-policy change (1.3,2.1).
- Selected Concurrency: token/abort/queue/callback fences, repeated gap, stale result, open-time race (1.3,2.1–2.2).
- Selected Resource limits:1000-event pending cap, source/listener/load cleanup, no byte-budget claim (1.3,2.1).
- Selected Legacy compatibility: REST parser/API byte behavior unchanged; native reconnect and current snapshot semantics retained (1.1,2.2–2.3).
- Selected Error handling: business-vs-transport error, decode/reload/callback failure, no hidden rejection (1.2–1.3,2.1–2.2).
- Selected Documentation: parent D5/D10 and canonical archive reflect real producer and recovery boundary (3.1).
- Not selected Config/File IO/Release: no config/path writes/dependencies/package changes.
- Domain selected server/web HTTP-envelope and browser runtime: real EventSource/HTTP/401-owner seam, no page rendering (2.2).
- Domain selected auth/session lifecycle + cross-service/offline: close on caller lifecycle, relativeURL/cookies/no external network (1.3,2.2).
- Domain not selected tenant sandbox/process credential isolation/SQLite migration: unchanged producer boundaries, read-only oracles.

## 1. Implementation
- [x] 1.1 Write paired failing tests first; expose only consumed existing named DTO types, define projected pure chat state without fabricated metadata.
- [x] 1.2 Implement reducer and payload decoder: complete text, steps/detail/status, required messageId, unknown types, snapshot continuation, lone terminal and error-before-start.
- [x] 1.3 Implement injected named-event connection, every-open/gap/overflow recovery,1000-event FIFO, cursor/watermark filtering, generation/abort/callback fences and close/error cleanup.

## 2. Verification
- [x] 2.1 Qualify controlled tests for exact2049chars, sealed/higher epoch, duplicate frames, stale/closed/ignored-abort loads, repeated gap/overflow, reentrancy and failure ownership; preserve failing-before/green-after evidence honestly.
- [x] 2.2 Parent Chromium native EventSource with real HTTP/server/native producer verifies initial-completion window, exact text, error-interface distinction, automatic reconnect/Last-Event-ID and gap/open resync; capture browser console/error evidence without claiming product-page completion.
- [x] 2.3 Complete web coverage suite, scoped static/type/build/drift and strict OpenSpec pass; protected source/oracle/dependency/discovery identities intact.
- [ ] 2.4 Read-only independent source reviews and exact-head required CI pass with bounded fix gate.

## 3. Delivery
- [ ] 3.1 Synchronize parent plan, merge source PR/close issue, then prepare canonical archive with recorded evidence.

Archive delivery remains an external parent-workflow gate: independently validate and merge its PR/CI before #104.

Local evidence: `/tmp/open-wb-issue93-evidence/`. Twenty-six new tests pass; final historical connector rejects five regressions. Six disposable cursor/recovery mutants are rejected; one initially survived incomplete stale-load assertions, then was rejected after adding no-error/no-close assertions and restoring GREEN. Four earlier public counterexamples and the captured-then getter counterexample retain semantic RED logs. Chromium native and foreign-realm lanes both pass restoration and one dedicated no-change stability trial (zero browser errors); screenshots are protocol harnesses, not the future #104 product page. Missing-module/function tracers are setup RED only. Source review, exact-head CI and independent archive delivery remain pending.
