## Why
Issue#82 supplies the persistent chat schema required by the later store/runtime slices. Existing metadata and migration receipts must survive upgrading real databases.
## What Changes
- Add032_chat_sessions.sql only: chat_sessions/messages/steps, domain constraints, owner/list ordering index and cascading foreign keys.
- Update shared core-db receipt expectations fromfive to six and add focused realSQLite schema/upgrade/rollback tests. No sessions store/REST/SSE/omp or migration-runner changes.
- User-approved correction: issue originally named020 before030/031 existed. Actual020 insertion rejects a current database under the immutable-prefix ledger; user selected append032. Parent/issue references synchronized, no ledger weakening or data deletion.
## Capabilities
### New Capabilities
- chat-sessions: add only会话数据 schema requirement; store/routes remain future deltas.
### Modified Capabilities
None.
## Impact
One SQL migration plus core-db tests/helpers and fixture/parent docs. Expanded fixture retained for persistent schema/upgrade boundary, not inherited process-spawn work. No new dependency/config/CI changes.
## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: persistent schema and upgrade/rollback, not spawn inheritance)
Blast radius: invalid chat data/cascades, existing database refusal or partial migration, shared receipt/catalog regressions
Selected risk packs: File IO/path safety/overwrite; Schema/columns/units; Auth/permissions/secrets; Concurrency/ordering; Legacy compatibility; Error/rollback; Release/packaging; Documentation/migration notes
Evidence floor: realSQLite cold/upgrade/reopen/constraint/cascade/rollback tests, compiledDB probe and fault qualification, fullserver/static/drift/build, strictOpenSpec and sameSHA CI
