## Why
Issue #198 blocks #99: Node24.13.1 SQLite TEXT reads truncate at U+0000. Initial stored content bytes are intact, but reusing a truncated session title during a later admission permanently overwrites its suffix. The user approved this standalone prerequisite, then resuming the serial Epic81 queue in this same checkout.
## What Changes
- Add one shared encoding-aware lossless text reader in existing core/db, consuming explicit BLOB query projections.
- Migrate every affected SessionStore free-text read, including admission/rollback title snapshots and trusted resume metadata; migrate audit title reads.
- Preserve audit detail's already-correct JSON serialization path and all existing public APIs, schema, runtime pins and write transactions.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- chat-sessions: explicit lossless text reads and title read-modify-write preservation.
- audit-core: title text fidelity without changing detail JSON or authorization.
## Impact
Production scope: server/src/core/db/index.ts, server/src/sessions/store.ts, server/src/core/audit/index.ts. Regression tests may be new focused files; no REST source, migrations, Node version, dependencies, configs, thresholds or startup changes.
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for shared DB seam and persisted read-modify-write state.
Blast radius: silent text truncation, title suffix loss, encoding regressions, owner/audit filtering drift.
Selected risk packs: public-api, schema/units, auth, state/order, compatibility, error/rollback, resources, release, documentation.
Evidence floor: real pre-fix semantic RED, focused regression GREEN, file/reopen and UTF8/UTF16 matrix, physical-byte/title-compensation assertions, parent replay of frozen #99 HTTP consumer, server coverage/static gates, three-seat review and exact-head CI.
