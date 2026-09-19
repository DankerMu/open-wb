## 1. Implement and verify
- [x] 1.1 Real temp directory tests: three new levels 2770, repeat unchanged, existing 0755 preserved, no chownSync, no umask mutation, file collision failure; semantic RED before code.
- [x] 1.2 Implement only ensureSharedDir and prove focused GREEN; exercise compiled public function as smoke.
- [x] 1.3 Parent runs server suite with unchanged coverage, typecheck, build, focused Biome and knip; independent reviews and required CI green before merge. Evidence: https://github.com/DankerMu/open-wb/pull/142#issuecomment-5741930668
## Risk packs
- Selected Public API / CLI / script entry: signature and thrown failure observed through exported helper (1.1–1.3).
- Not selected Config / project setup: no configuration changes.
- Selected File IO / path safety / overwrite: new levels vs existing ancestors and regular-file collision tested (1.1); trusted absolute inputs, no user-path validation or hostile mutation defense added.
- Not selected Schema / columns / units / field names: no schema changes.
- Selected Auth / permissions / secrets: exact mode/ownership/no-chown/no-umask evidence (1.1–1.3).
- Selected Concurrency / shared state / ordering: created-component identity must not come from preflight existence alone; independent review checks mkdir ownership and EEXIST handling, repeat-call behavior tested. Hostile concurrent rename/symlink replacement is a non-goal.
- Not selected Resource limits / large input / discovery: no unbounded directory discovery.
- Not selected Legacy compatibility / examples: no callers migrated in this issue.
- Selected Error handling / rollback / partial outputs: regular-file collision and syscall failures must propagate (1.1); transactional rollback is explicitly not promised.
- Not selected Release / packaging / dependency compatibility: no dependencies or packaging changes.
- Not selected Documentation / migration notes: no migration, parent D3 unchanged.
## Archive coordination
Promote only this added requirement. Parent Epic remains active; reconcile already-promoted requirements when eventually archiving parent.
