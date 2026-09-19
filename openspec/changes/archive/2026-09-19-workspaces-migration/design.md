## Context
Schema-only #116, parent D5 and workspaces spec. #114 has merged: current source has four migrations; 031 adds one after030. Existing 010 and030 plus audit-schema tests are references.
## Goals / Non-Goals
Change surface: 031_workspaces.sql, workspace schema tests, exact receipt/global-table expectation updates in core-db/auth/audit tests.
Must preserve: old migration bytes, runner transactions, auth seeds/schema, audit triggers and conflict tests, strict exact inventory assertions.
Must add: workspaces(id TEXT PK 32 lowercase hex, owner_id FK accounts(id) CASCADE NOT NULL, name TEXT NOT NULL length1..64 without U+0000..001F/U+007F, dir TEXT NOT NULL D5 character set length1..64 excluding dot/dotdot, created_at INTEGER NOT NULL), unique(owner_id,name) and unique(owner_id,dir).
Governing invariant: workspace IDs are valid and unique; only the same owner's duplicate name or dir conflicts; deleting an account cascades to its workspaces under FK enforcement.
Sibling surfaces: owner FK vs existing audit RESTRICT, PK NULL semantics, string length/control/GLOB checks, unique-index scope, migration receipts and audit/auth catalog expectations.
Future consumer #125 owns roots/store; filesystem-root and lazy-creation SHALLs remain only in the unfinished parent change, outside this schema-only delta. Parent archival must reconcile its combined requirement with this promoted schema requirement.
## Decisions
Follow existing non-STRICT table + CHECK convention. Explicit id NOT NULL: SQLite TEXT PRIMARY KEY alone does not enforce it.
Use D5 exact dir alphabet [A-Za-z0-9_一-龥-], not broader Unicode letters. Bound parameters in tests; reject embedded NUL explicitly because SQLite length/GLOB stop at NUL.
Name allows ordinary Unicode/spaces/slashes but rejects exactly the stated C0/DEL range; do not apply the dir alphabet or API trim policy to stored names.
Do not invent a nonnegative/default created_at rule absent from the spec; enforce integer storage/NOT NULL, preserving signed integers.
No IF NOT EXISTS, own transaction statements, filesystem operations, or global PRAGMA changes in migration.
## Required evidence
Exact live table metadata, PK, both owner-scoped unique index key lists, and FK CASCADE; canonical ASCII/CJK names/dirs at1/64 lengths accepted.
Same-owner duplicate name with different id+dir and duplicate dir with different id+name each fail; different-owner same name+dir succeeds. Account delete removes only that owner's workspaces (with audit table empty so RESTRICT does not confound the test).
Reject null/invalid id (length, interior nonhex/uppercase, NUL tail), name empty/65/control boundaries, dir empty/65/dot/dotdot/slash/backslash/NUL/forbidden character. Keep valid display name such as 智能 客服/重构 and canonical dir 智能-客服-重构.
Compatible-shaped pre-existing workspaces table collision fails, preserving original schema/data and earlier four receipts, omitting031; real temp-file reopen preserves rows/schema.
Exact successful receipt lists become five; audit030 failure cases still expect only the three migrations before030, not all five.
## Risks / Migration
Owner CASCADE does not override audit actor RESTRICT; each is a distinct contract. No account-deletion API changes here.
Persistent developer DB migration-prefix issue when later020 lands is already recorded in parent; never delete developer data automatically.
