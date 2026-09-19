## 1. Implement and verify
- [x] 1.1 Write real-filesystem tests for every resolve scenario, observe semantic RED before implementation, preserve output.
- [x] 1.2 Implement synchronous resolver only; prove GREEN and unchanged filesystem snapshots.
- [x] 1.3 Run server suite with unchanged coverage scope, server typecheck, focused Biome checks; CI supplies full repository checks.
- [x] 1.4 Independent code review, human white-box review and green CI before merge. Approval: https://github.com/DankerMu/open-wb/pull/138#issuecomment-5741113182

## Risk packs
- Selected Public API / CLI / script entry: exported result union exercised directly by scenario tests.
- Not selected Config / project setup: no configuration changes.
- Selected File IO / path safety / overwrite: eight escape vectors, real symlinks, exact canonical paths and unchanged recursive tree snapshots (1.1–1.3).
- Not selected Schema / columns / units / field names: no persisted schema.
- Selected Auth / permissions / secrets: path confinement evidence (1.1–1.3); account authorization belongs to #123, not this slice.
- Not selected Concurrency / shared state / ordering: no shared mutable state; race-free later filesystem operations explicitly out of scope.
- Not selected Resource limits / large input / discovery: no recursive discovery in production resolver.
- Not selected Legacy compatibility / examples: no existing resolver consumers.
- Selected Error handling / rollback / partial outputs: rejection reasons and zero writes; metadata errors never authorize paths (1.1–1.3).
- Not selected Release / packaging / dependency compatibility: no dependencies or packaging changes.
- Not selected Documentation / migration notes: parent design unchanged; no migration.

## Archive coordination
This slice copies only the parent's resolve requirement. Do not archive the unfinished parent Epic change. Parent archival must reconcile this already-promoted requirement rather than overwrite later amendments.
