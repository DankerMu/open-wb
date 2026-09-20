## Why

#122 exposes the append-only audit table from merged #114 through one account-filtered write/query seam. Its canonical HttpError requirement conflicts with the current http-owned error class and the architecture's dependency direction; the user approved moving shared errors into core (issue122 comment5748746011).

## What Changes

- Add core/audit emit/query with real migrated in-memory SQLite tests.
- Move canonical HttpError, codes and messages to core; HTTP statuses and response mapping remain http-owned. Atomically migrate all consumers, remove old re-exports; no compatibility shim.
- Update error ownership documentation and #84/#115 handoff; do not implement those pending error additions or route sets.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `audit-core`: add emit/query with tenant-scoped id pagination.
- `http-service-skeleton`: clarify shared-error ownership while preserving current envelope behavior.

## Impact

core/audit/index.ts and tests; new core/errors/index.ts; http/errors.ts, http/index.ts, guard, app and all existing class/type consumers. Architecture directory/dependency docs and parent delta ownership notes are in scope under the user decision. No HTTP audit route or other caller implementation.

Issue type: feature/refactor
Fixture level: expanded
Upstream suggested level: compact (override: persisted writes, role-based isolation, shared error API relocation)
Blast radius: tenant audit visibility and all existing typed HTTP errors.
Selected risk packs: public API; file/schema representation; permissions; ordering; large cursor precision; compatibility; errors; documentation.
Evidence floor: real migrated :memory: TDD, complete server regression, existing HTTP error/security suites unchanged in behavior, actual compiled API smoke, type/static checks and exact-head CI.
