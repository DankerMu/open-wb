## Why
Implement Epic #111 task2.1 / issue #114: persisted audit rows must reject UPDATE/DELETE and retain their referenced account identity.
## What Changes
Add 030_audit_events.sql with table, constraints, actor/id-desc index and two append-only triggers. Add real SQLite tests and update exact migration/catalog expectations. No emit/query, endpoint, workspace migration or runner changes.
## Capabilities
### New Capabilities
- audit-core: append-only audit_events schema only.
### Modified Capabilities
None.
## Impact
One SQL migration; existing core-db tests/helpers and auth-schema receipt expectation affected by the new migration. No dependencies or runtime API changes.
## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: compact (override: persisted schema/migration is a mandatory expanded trigger).
Blast radius: database migration atomicity, audit retention and referenced accounts.
Selected risk packs: Schema/field names; Auth/permissions; Concurrency/shared state; Error handling/partial outputs; Legacy compatibility; File IO; Documentation/migration notes.
Evidence floor: real :memory: and temp-file SQLite via openDb; negative mutations/CHECK/FK; exact receipt+catalog updates; conflict rollback/reopen; server suite/typecheck/build/lint/drift/CI.
Human review: Epic #111 final functional acceptance per https://github.com/DankerMu/open-wb/issues/111#issuecomment-5741112841; independent agent reviews and CI retained.
