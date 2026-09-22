## 1. Contract and baseline
- [x] 1.1 Compact fixture first-round review PASS, user-approved min−1 correction recorded on issue91 and all134 existing source/test/judge inputs frozen. Parent independent array reference passes five public cases; off-by-one, epoch-mixing, completed-turn and input-alias bad candidates fail semantically, restore GREEN and dedicated stability passes. Missing production module remains a SETUP absence, not fabricated prior behavior.
- [ ] 1.2 Author one public-API tracer before production implementation; retain missing-module SETUP separately and a callable deliberately wrong boundary's semantic RED before real implementation. Freeze expected retained IDs/payloads before candidate authorization.
## 2. Pure ring implementation
- [ ] 2.1 Implement the fixed-capacity epoch ring and ordered successor replay with one public behavior RED→GREEN at a time; cover1001/min−1 and1002 true-gap boundaries, grammar/epoch/empty-tail reads and instance isolation.
- [ ] 2.2 Cover current-turn refresh, evicted/missing/completed starts, cursor precedence and immutable retained snapshots; preserve canonical event payloads and bounded storage without SSE/store changes.
## 3. Acceptance and delivery
- [ ] 3.1 Parent executes actual compiled exported API, qualified off-by-one/epoch/active-turn wrong candidates and restored stability; scoped static/type/fullserver coverage/anti-drift/strict pass. No skipped discovery or threshold changes.
- [ ] 3.2 Compact correctness+test-evidence review, bounded fix gate, same-head CI and source PR merge; separately promote/archive the added requirement and parent4.1 with independent archive CI.

## Core risk mapping
Selected: entry/API→2.1 constructor/push/since; schema/units→2.1 canonical epoch/seq and numeric ChatEvent; concurrency/state→2.2 deterministic active-turn/read transitions, no actual concurrency; resources→2.1 fixed1000 O(1) insertion; compatibility→2.1 reuse event union and approved min−1; errors→2.1 malformed cursor becomes gap; test/evidence→1.2/3.1 exact ordered payloads and qualified mutants; docs/release→3.2 canonical append and same-headCI. Not selected: config/environment (no new key), filesystem/IO (pure), auth/secrets (no auth/credential surface).

## Domain risk mapping
Selected: auth/session lifecycle only for isolated in-memory epoch/turn identity (2.1/2.2); server/web HTTP-envelope compatibility only for future cursor/event payload protocol (2.1; no route mounted); offline deployability (zero dependencies,3.1). Not selected: tenant/sandbox enforcement, process/child-environment, SQLite migration/catalog, browser runtime/navigation/persistence, cross-service network boundary. No expanded trigger from project-profile is touched.

## Ownership and verification
One implementer/current checkout/no worktree/no nesting; production/test scope is ring-buffer.ts and session-ring-buffer.test.ts only. Parent owns fixture, protected examples/holdout/qualification and final acceptance. Writer skips project build/type/lint/format/fullsuite/git; may run only focused Vitest during vertical TDD. Reviewers skip all validation. Parent focused command `npm exec --workspace server -- vitest run --no-coverage test/session-ring-buffer.test.ts`; final `npm run test --workspace server`, scoped Biome, server types/build, `make anti-drift`, strict OpenSpec. Evidence root `/tmp/open-wb-issue91-evidence`. Same-user local isolation is an authority convention, not an OS enclave; independent CI remains mandatory.
