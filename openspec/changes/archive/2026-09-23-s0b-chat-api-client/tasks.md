## Risk Packs
- Selected Public API: four wire contracts + exact status tests and real HTTP smoke (1.1, 2.1).
- Selected Schema: strict nested DTO, signed field domains, complete text and nullable cursor (1.2, 2.1).
- Selected Auth: existing credentials/signal/401 policy only, no policy change (1.3, 2.1).
- Selected Legacy compatibility: predicate extraction retains old API behavior (1.4, 2.2).
- Selected Error handling: 409/502, malformed/non-JSON responses, wrong success/network errors (1.3).
- Selected Documentation: this fixture and canonical archive record consumer contract (3.1).
- Not selected Config, File IO, Release/dependencies: untouched; no new packages, artifact writer or path access.
- Not selected Concurrency/shared state: no retries, event connector, queue or state machine; signal forwarding unchanged.
- Not selected Resource limits: server owns limits; no client truncation or added large-input policy.
- Domain selected server/web HTTP-envelope and auth/session lifecycle: four adapter methods + unchanged unauthorized behavior (1.1–1.3).
- Domain not selected tenant/sandbox, process isolation, SQLite migration: server boundaries untouched; producer contracts read-only.
- Domain not selected browser navigation/persistence: no UI or storage; browser walk deferred to #106, not claimed here.
- Domain cross-service/offline: relative same-origin endpoints, no external fetch/dependencies (1.1, 2.1).

## 1. Implementation
- [x] 1.1 Red-first paired public API tests and four typed methods with exact wire contract, credentials and AbortSignal.
- [x] 1.2 Strict session/snapshot/prompt DTO parsing preserving full text, array order, signed fields and nullable cursor; named owner types.
- [x] 1.3 Error-envelope, wrong-status, malformed body, network and unauthorized callback containment coverage.
- [x] 1.4 Minimal shared-validator extraction only if needed for 800-line cap; existing consumers and tests unchanged in behavior.

## 2. Verification
- [x] 2.1 Parent-owned real HTTP client smoke plus discriminating negative cases and restored GREEN; retain baseline/evidence hashes.
- [x] 2.2 Existing API reference GREEN, complete web suite/coverage, web typecheck/build, scoped Biome and repository anti-drift pass.
- [x] 2.3 Read-only source reviews and exact-head required CI pass; no weakened gates/discovery/dependency changes.

## 3. Delivery
- [x] 3.1 Source PR #234 merged and issue #92 closed; hand off the verified change to its independent OpenSpec archive PR.

Archive delivery gate (tracked by the parent workflow, not self-certified by this commit): validate and merge the separate archive PR with its own exact-head CI before starting #93.
