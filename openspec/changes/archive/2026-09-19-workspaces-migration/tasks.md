## 1. Implement and verify
- [x] 1.1 Write real openDb SQLite tests for metadata, independent uniqueness collisions/cross-owner acceptance/cascade, id/name/dir boundaries and required fields; capture semantic RED before SQL implementation.
- [x] 1.2 Add031 only, update exact canonical receipts/global business tables including audit successful-reopen expectations without changing audit failure-prefix expectations; preserve old SQL/runner.
- [x] 1.3 Prove same-name table conflict rollback and temp-file reopen; parent server suite/typecheck/build/Biome/knip/jscpd/sizeguard and compiled openDb smoke pass.
- [x] 1.4 Independent expanded review and required CI green before merge; archive slice and keep parent Epic active. PR #151 merged; three static seats clean and exact-head CI 35453243586 green.
## Risk packs
- Not selected Public API / CLI / script entry: no new runtime application API.
- Not selected Config / project setup: no configuration/toolchain changes.
- Selected File IO / path safety / overwrite: temp-file rollback/reopen and directory-segment storage validation (1.1,1.3); no directory creation.
- Selected Schema / columns / units / field names: exact live metadata and constraint matrix (1.1–1.2).
- Selected Auth / permissions / secrets: owner-scoped uniqueness, FK/CASCADE isolation (1.1); no credential changes.
- Selected Concurrency / shared state / ordering: atomic runner-owned migration and unique indexes enforce shared identity (1.1–1.3); no new concurrency framework.
- Not selected Resource limits / large input / discovery: only declared string bounds, no discovery/query API.
- Selected Legacy compatibility / examples: existing auth/audit/ledger tests retained with exact added031 expectation (1.2–1.3).
- Selected Error handling / rollback / partial outputs: conflicting existing table retained,031 absent on failure, no partial writes (1.3).
- Not selected Release / packaging / dependency compatibility: reuse SQL asset-copy path, no dependencies.
- Selected Documentation / migration notes: existing parent dev-DB prefix warning retained; no automatic destructive remedy (design).
## Archive coordination
Promote schema requirement only; filesystem root behavior remains owned by #125 and unfinished parent Epic. Reconcile promoted slices at parent archive.
