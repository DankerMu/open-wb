# Spec delta: chat-sessions（#510 迁移 035）

> 整段取父 change `s1c-session-metadata-presentation` delta 的「会话数据 schema」（以当前主 spec 即 A 的 promoted 文本为底，差异恰为 035 说明段与三个 Migration 035 Scenario）。本 issue 交付该 requirement 父 delta 的全部内容。

## MODIFIED Requirements

### Requirement: 会话数据 schema
Migration032_chat_sessions.sql SHALL atomically create chat_sessions, chat_messages and chat_steps using the existing runner-owned transaction. Existing0010/002/010/030/031 receipts and business data SHALL remain unchanged;032 SHALL append as the sixth receipt without changing ledger validation.
chat_sessions SHALL have id TEXT NOTNULL PRIMARYKEY constrained to32 lowercasehex characters withoutNUL; owner_id TEXT NOTNULL referencing accounts(id) ONDELETECASCADE; nullable title/omp_session_file TEXT; status TEXT NOTNULL in(idle,running,done,failed,stopped); stream_epoch INTEGER NOTNULL DEFAULT0 and nonnegativeinteger; created_at/updated_at INTEGER NOTNULL nonnegativeepochms; and an owner_id,updated_atDESC index.
chat_messages SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; session_id TEXT NOTNULL referencing chat_sessions(id) ONDELETECASCADE; role TEXT NOTNULL in(user,assistant); content TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(done,running,failed,stopped); created_at INTEGER NOTNULL. chat_steps SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; message_id INTEGER NOTNULL referencing chat_messages(id) ONDELETECASCADE; ordinal INTEGER NOTNULL nonnegativeinteger; name TEXT NOTNULL; detail TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(running,done,failed,stopped); started_at INTEGER NOTNULL; ended_at nullableINTEGER; UNIQUE(message_id,ordinal).
chat_messages SHALL have an ascending(session_id,created_at,id) index supporting ordered history within a session; indexnames are not part of the external contract.
NoIFNOTEXISTS silentconflict acceptance or migration-ownedtransaction SHALL bypass existing runner rollback. Store/reconciliation and runtime APIs are out of this migration slice.
Migration `034_chat_turn_control.sql` (Requirement「迁移 034 回合控制 schema」) SHALL supersede the 032 column set and CHECK set of these three tables: the `stopped` status values above are the 034 CHECKs, and after 034 the current schema is the one stated here plus `chat_steps.output` (033) and `chat_sessions.parent_session_id` (034), with every other 032 column, default, key, cascade, UNIQUE constraint and the ordered-history index unchanged. The 032 migration file itself SHALL NOT be edited: a database holding only the 032 or 033 receipt carries the narrower CHECKs until 034 applies.
Migration `035_chat_session_metadata.sql` SHALL run inside the existing runner-owned transaction and append as the **ninth** receipt after `034` without changing ledger validation or any earlier receipt. It SHALL NOT rebuild any table: it uses only `ALTER TABLE … ADD COLUMN` to add exactly five nullable columns without defaults — `chat_sessions.workspace_id TEXT NULL REFERENCES workspaces(id) ON DELETE SET NULL`; `chat_sessions.scene TEXT NULL CHECK (scene IN ('office','code','design'))`; `chat_sessions.pinned_at INTEGER NULL CHECK (pinned_at IS NULL OR (typeof(pinned_at)='integer' AND pinned_at >= 0))` (epoch milliseconds); `chat_messages.thinking TEXT NULL`; and `chat_steps.changes TEXT NULL` — the last two carrying no CHECK (the 033 `output` precedent; their content rules belong to thinking-fold and turn-artifacts). Every existing row SHALL keep every prior column value, foreign key, cascade, index and `sqlite_sequence` value and read the five new columns as NULL; there is no backfill. Because receipts must stay a contiguous prefix of the discovered migration files, `034` SHALL have applied before `035` applies: on a database whose receipts end at `032` or `033` one openDb run applies `034` then `035` in that order, each in its own runner-owned transaction. After `035` the current schema is the one stated above plus `chat_steps.output` (033), `chat_sessions.parent_session_id` (034) and these five columns. The 032, 033 and 034 files SHALL NOT be edited. The trusted-migration count assertions SHALL grow by one.

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

#### Scenario: Migration 035 on fresh and populated databases
- **WHEN** openDb opens a new database, and separately a file database holding the eight receipts through `034` with sessions (one of them a fork child with `parent_session_id`), messages with approvals and steps with detail/output across two owners
- **THEN** receipts end `033,034,035` in order; `chat_sessions` has `workspace_id`, `scene`, `pinned_at`, `chat_messages` has `thinking` and `chat_steps` has `changes`, all nullable without default; every pre-existing column value, row count, foreign key, cascade, unique constraint, index and `sqlite_sequence` value is unchanged and the five new columns read NULL; `PRAGMA foreign_key_check` is empty and reopening leaves the catalog stable

#### Scenario: Migration 035 column constraints
- **WHEN** writes set `scene` to `office`, `code`, `design` or NULL and separately to `chat`, `Office` or `''`; set `pinned_at` to `0`, a current epoch-ms value or NULL and separately to `-1`, `1.5` or `'x'`; set `workspace_id` to an existing workspace id and separately to an id with no workspace row
- **THEN** every valid value is written while each invalid value is rejected by SQLite (the missing workspace by its foreign key); deleting a workspace row in a test sets `workspace_id` of its sessions to NULL without deleting the sessions or their messages; deleting the account still cascades through its workspaces, sessions, messages, steps and approvals

#### Scenario: Migration 035 follows 034 atomically
- **WHEN** openDb opens a file database whose receipts end at `033`
- **THEN** `034` applies before `035` in the same run and both receipts append once in order
- **WHEN** `035` fails part-way (a test-owned conflicting object such as an existing `chat_sessions.scene` column in a disposable copy)
- **THEN** no `035` column or receipt persists, `034` and every earlier receipt and row remain, and after the conflicting object is removed a retry applies `035` once
