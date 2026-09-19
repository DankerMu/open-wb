## 1. Implement and verify
- [x] 1.1 Write real SQLite tests through openDb for schema/index/triggers, legal insert/defaults/generated id, immutable rows/FK restrictions, kind/JSON/ts/null constraints; record semantic RED before migration.
- [x] 1.2 Add only 030 SQL, update exact tracked migration/receipt/global-trigger catalog expectations including auth-schema receipt row; prove GREEN without old migration/runner edits.
- [x] 1.3 Exercise late-conflict atomic rollback and file reopen; parent runs server suite with unchanged coverage, typecheck/build, Biome/knip/jscpd and compiled openDb smoke.
- [x] 1.4 Independent expanded review and required CI green, then merge/archive slice; keep parent Epic active. Evidence: https://github.com/DankerMu/open-wb/pull/146#issuecomment-5742591426
## Risk packs
- Not selected Public API / CLI / script entry: no new application API; existing openDb contract preserved.
- Not selected Config / project setup: no settings or toolchain changes.
- Selected File IO / path safety / overwrite: real temp DB reopen and preserved prior state; no developer DB deletion (1.3).
- Selected Schema / columns / units / field names: exact SQLite schema/index/default/constraint observations (1.1–1.2).
- Selected Auth / permissions / secrets: FK RESTRICT and immutable audit row tests, no credential changes (1.1).
- Selected Concurrency / shared state / ordering: runner-owned transaction, lexical receipts and id-desc index; no new concurrency mechanism (1.2–1.3).
- Not selected Resource limits / large input / discovery: no query/retention API, no recursive discovery.
- Selected Legacy compatibility / examples: foundation/auth upgrade and exact unchanged auth seed/schema tests (1.2–1.3).
- Selected Error handling / rollback / partial outputs: late-conflict rollback and unchanged-row negative cases (1.1,1.3).
- Not selected Release / packaging / dependency compatibility: no dependencies or packaging changes; existing SQL asset-copy mechanism reused.
- Selected Documentation / migration notes: parent persistent-dev-DB migration-order note retained; no automatic destructive migration remedy (design and1.3).
## Archive coordination
Promote only the schema requirement; parent Epic remains active and will reconcile already-promoted slices when archived.
