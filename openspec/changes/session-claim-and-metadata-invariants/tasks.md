## Risk Packs
- Concurrency / shared state / ordering — selected: same-slot pump handover independent of scheduling → 1.1, 2.1 (unit RED/GREEN), 2.3 (integration).
- Resource limits — selected: unbounded `#claims` retention pinning old runtimes → 2.1 (unit proves the old claim is removed).
- Error handling / rollback — selected: store missing-session receipt errors, rollback and caller-owned transactions → 1.3, 2.2, 2.4.
- Legacy compatibility — selected: duplicate-busy, retire, shutdown, sink contracts and store receipt/fault-injection semantics → 2.4.
- Public API / CLI — not selected: no new public `SessionSupervisor` or `SessionStore` method; the extracted helper is internal (test-only export or sibling module).
- Config, Schema/migrations, File IO, Auth/secrets, Release, Documentation — not selected: no config, schema, path, credential, dependency or doc surface (spec delta only).

## 1. Implementation
- [x] 1.1 `supervisor.ts` pump finally: always `#releaseClaim(slot, assistantMessageId)`; keep `slot.pump = undefined` gated on identity.
- [x] 1.2 Extract the pump-exit bookkeeping into a small unit-testable function that the pump `finally` calls; no new public supervisor method.
- [x] 1.3 `store.ts`: remove the unreachable `not_found` branch in `bumpStreamEpoch`; comment trusted-caller existence ownership on both methods.

## 2. Verification
- [x] 2.1 Unit test of the extracted pump-exit function per design (handover and own-pump cases; asserts claims map, `claimedAssistantId`, `slot.pump`) — RED against pre-fix semantics, GREEN after.
- [x] 2.2 Store tests: missing session → non-HttpError receipt Error, no row changes, for both methods.
- [x] 2.3 Same-slot sink re-entry integration regression per design (sink returns undefined, re-enters once).
- [x] 2.4 Existing `session-supervisor*.test.ts` and `session-store*.test.ts` unchanged and green; `npm --workspace server run test`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
