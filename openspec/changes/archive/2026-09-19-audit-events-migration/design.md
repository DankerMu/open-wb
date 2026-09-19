## Context
Issue #114 is a schema-only slice of parent design D4. Existing 010 migration and core-db test helpers are references; runner owns per-migration transaction/receipt.
## Goals / Non-Goals
Change surface: 030_audit_events.sql; core-db tests and canonical catalog/receipt helpers; auth-schema exact receipt assertions only as needed.
Must preserve: existing migrations byte-for-byte, canonical ledger guards, auth schema/seeds, exact directory inventory checks, migration failure cleanup and reopen behavior.
Must add: audit_events columns/CHECK/FK, index(actor_id,id DESC), audit_events_no_update/no_delete triggers raising the specified append-only error.
Governing invariant: ordinary INSERT can append valid events; UPDATE/DELETE cannot change a persisted audit row, and its referenced account cannot be deleted while referenced.
Sibling surfaces: migration assets order, receipts, sqlite_master triggers, sqlite_sequence, auth receipt tests, foreign_keys connection setup, rollback and reopen.
Future consumers: #122 emit/query and #124 endpoint; no callers implemented here.
## Decisions
Use CREATE statements without IF NOT EXISTS or internal BEGIN/COMMIT; runner already owns rollback and refuses unknown schema collisions.
Use existing schema's storage-class CHECK pattern where needed (notably nonnegative integer timestamp); detail permits valid JSON, not a new object-only restriction; workspace_id nullable without FK to the not-yet-created workspaces table.
Kind follows D4 snake.dot convention: at least two dot-separated ASCII identifier segments, each starts [a-z] then [a-z0-9_]*; reject empty segments, uppercase, whitespace and NUL. Existing S1a kinds sandbox.reject/workspace.create/dir.create remain valid.
Do not add audit reinsert triggers, global recursive_triggers settings, schema-tampering defenses, or privileged-SQL restrictions beyond the parent's explicit two-trigger contract.
Exact test inventory remains independent of production discovery; add the new asset/receipt and two sorted trigger names, never replace with lower-bound or production-derived expected data.
## Required evidence
openDb(':memory:') exposes exact columns, table/index/two triggers; index order actor_id then id DESC; generated ids and detail default '{}' / workspace_id NULL.
Valid event persisted; UPDATE and DELETE fail with 'audit_events is append-only', original row unchanged; deleting referenced u1 fails with FK enforcement, account and event unchanged.
Invalid kind, malformed JSON, negative/noninteger ts and null required values fail; canonical event kinds insert successfully.
A late migration-name conflict rolls back newly created audit table/index/triggers and omits 030 receipt while preserving earlier committed migrations and conflicting object.
Real temp-file reopen retains audit row and stable schema/receipts. Existing full server suite remains green after exact expectation updates.
## Risks / Migration
030 before future020 is permitted for fresh CI databases; later missing-prefix migrations in persistent dev DB require rebuild per parent tasks header. Do not delete developer data automatically.
Rollback is transactional on failed migration; no down migration or removal of persisted audit records is provided.
Review focus: CHECK NULL/type semantics, trigger/FK rejection, stable index/schema shape, complete exact-catalog updates and no runner changes.
