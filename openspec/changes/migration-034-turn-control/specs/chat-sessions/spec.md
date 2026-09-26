# Spec delta: chat-sessions（#449 迁移 034）

## MODIFIED Requirements

### Requirement: 会话数据 schema
Migration032_chat_sessions.sql SHALL atomically create chat_sessions, chat_messages and chat_steps using the existing runner-owned transaction. Existing0010/002/010/030/031 receipts and business data SHALL remain unchanged;032 SHALL append as the sixth receipt without changing ledger validation.
chat_sessions SHALL have id TEXT NOTNULL PRIMARYKEY constrained to32 lowercasehex characters withoutNUL; owner_id TEXT NOTNULL referencing accounts(id) ONDELETECASCADE; nullable title/omp_session_file TEXT; status TEXT NOTNULL in(idle,running,done,failed,stopped); stream_epoch INTEGER NOTNULL DEFAULT0 and nonnegativeinteger; created_at/updated_at INTEGER NOTNULL nonnegativeepochms; and an owner_id,updated_atDESC index.
chat_messages SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; session_id TEXT NOTNULL referencing chat_sessions(id) ONDELETECASCADE; role TEXT NOTNULL in(user,assistant); content TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(done,running,failed,stopped); created_at INTEGER NOTNULL. chat_steps SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; message_id INTEGER NOTNULL referencing chat_messages(id) ONDELETECASCADE; ordinal INTEGER NOTNULL nonnegativeinteger; name TEXT NOTNULL; detail TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(running,done,failed,stopped); started_at INTEGER NOTNULL; ended_at nullableINTEGER; UNIQUE(message_id,ordinal).
chat_messages SHALL have an ascending(session_id,created_at,id) index supporting ordered history within a session; indexnames are not part of the external contract.
NoIFNOTEXISTS silentconflict acceptance or migration-ownedtransaction SHALL bypass existing runner rollback. Store/reconciliation and runtime APIs are out of this migration slice.
Migration `034_chat_turn_control.sql` (Requirement「迁移 034 回合控制 schema」) SHALL supersede the 032 column set and CHECK set of these three tables: the `stopped` status values above are the 034 CHECKs, and after 034 the current schema is the one stated here plus `chat_steps.output` (033) and `chat_sessions.parent_session_id` (034), with every other 032 column, default, key, cascade, UNIQUE constraint and the ordered-history index unchanged. The 032 migration file itself SHALL NOT be edited: a database holding only the 032 or 033 receipt carries the narrower CHECKs until 034 applies.

#### Scenario: Fresh schema and receipts
- **WHEN** openDb opens :memory: or a new file database
- **THEN** receipts begin0010,002,010,030,031,032 in order (later migrations such as033 may follow) and allthree tablecolumns/defaults/keys/indexconstraints exist and govern actualwrites; once `034` has applied, the three status CHECKs admit `stopped`

#### Scenario: Domain rejection
- **WHEN** writes violate sessionidshape, requirednullability, table-specificrole/status enums, nonnegativeintegerstream_epoch/ordinal or sessiontimestamps
- **THEN** SQLite rejects them while validboundaryvalues remain writable; generated message/step IDs are not reused afterdeletion

#### Scenario: Referential ownership and cascade isolation
- **WHEN** childwrites name a missingaccount/session/message, or duplicateordinal withinonemessage
- **THEN** they fail; equalordinal in adifferentmessage is permitted
- **WHEN** a message, session or parentaccount is deleted
- **THEN** only its descendantchat rows cascade; unrelatedowner/session/message rows remain

#### Scenario: Existing database upgrade and reopen
- **WHEN** openDb opens a database with thefive previous migrations and existingauth/audit/workspace data
- **THEN** all priorreceipts/data stayunchanged,032 appends once, and repeatopen leaves the completecatalog stable

#### Scenario: Atomic failed migration and recovery
- **WHEN** a preexisting laterchat table conflicts during032 execution
- **THEN** no earlier032table or032receipt persists, previousreceipts/data and the conflictingobject remainunchanged
- **WHEN** the test-owned conflictingobject is removed and openDb retries
- THEN032 completes once and thedatabase reopens normally

### Requirement: 步骤输出列迁移
Migration `033_chat_step_output.sql` SHALL add a nullable `output TEXT` column (no default) to `chat_steps` with `ALTER TABLE … ADD COLUMN` inside the existing runner-owned transaction, appended as the seventh receipt after `032` without changing ledger validation. Existing rows SHALL keep every prior column value and read `output` as NULL; no backfill. `startStep` SHALL write detail and leave output NULL; `finishStep` SHALL set only status, output and ended_at (detail is never updated after start). Store reads SHALL return output losslessly under the same complete-text rule as detail, mapping NULL to an empty string in step views. The trusted-migration count assertions SHALL grow by one.

#### Scenario: Fresh and upgraded schema
- **WHEN** openDb opens a new database, and separately a database holding the six prior receipts plus chat rows with steps
- **THEN** receipts contain `032` then `033` in order (later migrations such as `034` may follow); `chat_steps` has `output` TEXT nullable without default after `ended_at`; prior steps keep id/detail/status/timestamps and read output as NULL; reopening leaves the catalog stable

#### Scenario: Step persistence keeps args
- **WHEN** a step starts with detail D and then finishes failed with output O
- **THEN** the stored row has detail D, output O, status failed and an ended_at; getMessages returns both; a step that is still running returns output `""`

## ADDED Requirements

### Requirement: 迁移 034 回合控制 schema
Migration `034_chat_turn_control.sql` SHALL run inside the existing runner-owned transaction and append as the **eighth** receipt after `033` without changing ledger validation or any earlier receipt. Because SQLite cannot alter a CHECK constraint, it SHALL rebuild `chat_sessions`, `chat_messages` and `chat_steps`, preserving every existing column, default, NOT NULL, primary key, AUTOINCREMENT, foreign key with its `ON DELETE CASCADE`, UNIQUE constraint and index (index names are not part of the external contract) while widening the three status CHECKs to `chat_sessions.status IN (idle,running,done,failed,stopped)`, `chat_messages.status IN (done,running,failed,stopped)` and `chat_steps.status IN (running,done,failed,stopped)`, and adding `chat_sessions.parent_session_id TEXT NULL` with `ON DELETE SET NULL` (NULL for every existing row). The recipe SHALL be exactly: (1) create `chat_sessions_next`, `chat_messages_next` and `chat_steps_next` with full explicit column lists whose foreign keys point at the `_next` parents — `chat_messages_next.session_id → chat_sessions_next(id)`, `chat_steps_next.message_id → chat_messages_next(id)` and the self-reference `chat_sessions_next.parent_session_id → chat_sessions_next(id)`, while `owner_id` keeps referencing `accounts(id)`, with no indexes yet; (2) copy all rows with `INSERT … SELECT` naming every column (never `SELECT *`), parents first, and before any `DROP` read and keep, for `chat_messages` and `chat_steps`, the high-water value `max(old sqlite_sequence.seq, max(id))` (a `DROP TABLE` deletes that table's `sqlite_sequence` row, so it cannot be read later); (3) after every copy, `DROP` the old tables children first: `chat_steps` → `chat_messages` → `chat_sessions`; (4) `ALTER TABLE … RENAME` the `_next` tables parents first: sessions → messages → steps (with `legacy_alter_table=OFF`, each rename rewrites the foreign-key targets of the already-created child tables, so the final FKs name `chat_sessions`/`chat_messages`); (5) explicitly write the `sqlite_sequence` rows of the AUTOINCREMENT tables `chat_messages` and `chat_steps` to the two high-water values kept at step (2) (`chat_sessions` has a TEXT key and no sequence row), so ids issued before the upgrade — including deleted ones — are never reissued; (6) only after the renames create `chat_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK (decision IN ('allow','deny','timeout')), decided_at INTEGER NULL, UNIQUE(message_id, request_id))` plus an index on `message_id`, and recreate the rebuilt tables' indexes. The migration SHALL NOT issue `PRAGMA foreign_keys` (it is a no-op inside a transaction); correctness relies only on the drop/rename order above, and after commit `PRAGMA foreign_key_check` SHALL be empty. Any failure during the migration SHALL leave the original three tables, all their rows, their `sqlite_sequence` rows and every earlier receipt intact, with no `_next` table, no `chat_approvals` and no `034` receipt persisted. The trusted-migration count assertions SHALL grow by one.

#### Scenario: Fresh schema and receipts
- **WHEN** openDb opens :memory: or a new file database
- **THEN** receipts are `0010,002,010,030,031,032,033,034` in order; the three chat tables carry the widened CHECKs, their foreign keys name `chat_sessions`/`chat_messages` (no `_next` target remains), `chat_sessions.parent_session_id` exists nullable with `ON DELETE SET NULL`, `chat_approvals` exists with the declared columns/constraints, and all 032/033 columns, defaults, keys, cascades and unique constraints govern actual writes

#### Scenario: Populated 033 database upgrades losslessly
- **WHEN** openDb opens a file database holding the seven prior receipts with sessions, messages (including deleted-then-gapped ids) and steps with detail/output across two owners
- **THEN** `034` appends once; every row of the three tables is byte-identical in all pre-existing columns, `parent_session_id` reads NULL, row counts match, the next generated message/step id is greater than any id ever issued, foreign keys still cascade from account → session → message → step, `UNIQUE(message_id,ordinal)` and the ordered history index still hold, `PRAGMA foreign_key_check` is empty, and reopening leaves the catalog stable

#### Scenario: Foreign keys survive the rebuild
- **WHEN** openDb upgrades a populated 033 database with foreign-key enforcement on as the runner leaves it
- **THEN** no row is deleted by a cascade during the rebuild, `PRAGMA foreign_key_check` is empty after commit, every foreign key in `sqlite_master` names a final table, and deleting an account afterwards still cascades through its sessions, messages, steps and approvals

#### Scenario: Sequence high-water mark preserved
- **WHEN** the pre-upgrade database's `sqlite_sequence.seq` for `chat_messages` and `chat_steps` is greater than their current `max(id)` because the newest rows were deleted, and openDb applies `034`
- **THEN** `sqlite_sequence` holds the same two high-water marks after the upgrade, and the next inserted message and step each receive an id greater than the old high-water mark

#### Scenario: Mid-rebuild failure is atomic
- **WHEN** the migration fails part-way (for example a test-owned conflicting `chat_messages_next` or `chat_approvals` object exists)
- **THEN** no `_next` table, no `chat_approvals` and no `034` receipt persist, the original three tables and all rows/receipts are unchanged, and after the conflicting object is removed a retry completes `034` once

#### Scenario: Stopped accepted, other values rejected
- **WHEN** writes set status `stopped` on a session, a message and a step, and separately attempt an unknown status such as `cancelled` on each table or a `decision` outside allow/deny/timeout on `chat_approvals`
- **THEN** the three `stopped` writes succeed while every unknown value is rejected by SQLite; deleting a message cascades its approvals; deleting a parent session sets `parent_session_id` of its forks to NULL without deleting them; a duplicate `(message_id,request_id)` approval is rejected
