## Why
Implement issue #116 / Epic #111 task3.2: persist workspace identities and owner-scoped name/directory uniqueness before store/REST integration.
## What Changes
Add 031_workspaces.sql and real SQLite schema/constraint tests. Update exact migration and global business-table expectations. No store, REST, directory creation, or prior migration edits.
## Capabilities
### New Capabilities
- workspaces: schema portion of the parent workspace-schema requirement.
### Modified Capabilities
None.
## Impact
One new SQL migration, dedicated workspace schema tests, and existing core-db/auth/audit exact receipt/catalog expectations. Future #125 owns lazy filesystem roots and store behavior.
## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: persisted schema and owner boundary).
Blast radius: workspace identity, per-owner isolation, account cascade and migration compatibility.
Selected risk packs: Schema; Auth/permissions; Concurrency/shared state; Error handling; Legacy compatibility; File IO; Documentation/migration notes.
Evidence floor: real SQLite openDb; independent owner/name and owner/dir collisions, cross-owner allowance, cascade, id/name/dir checks, exact receipts, conflict rollback/reopen; semantic RED/GREEN and server/CI gates.
Human per-PR review deferred to Epic final functional acceptance per https://github.com/DankerMu/open-wb/issues/111#issuecomment-5741112841; independent agent/CI gates unchanged.
