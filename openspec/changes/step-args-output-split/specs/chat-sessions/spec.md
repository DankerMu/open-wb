## ADDED Requirements

### Requirement: 步骤输出列迁移
Migration `033_chat_step_output.sql` SHALL add a nullable `output TEXT` column (no default) to `chat_steps` with `ALTER TABLE … ADD COLUMN` inside the existing runner-owned transaction, appended as the seventh receipt after `032` without changing ledger validation. Existing rows SHALL keep every prior column value and read `output` as NULL; no backfill. `startStep` SHALL write detail and leave output NULL; `finishStep` SHALL set only status, output and ended_at (detail is never updated after start). Store reads SHALL return output losslessly under the same complete-text rule as detail, mapping NULL to an empty string in step views. The trusted-migration count assertions SHALL grow by one.

#### Scenario: Fresh and upgraded schema
- WHEN openDb opens a new database, and separately a database holding the six prior receipts plus chat rows with steps
- THEN receipts end with `032` then `033`; `chat_steps` has `output` TEXT nullable without default after `ended_at`; prior steps keep id/detail/status/timestamps and read output as NULL; reopening leaves the catalog stable

#### Scenario: Step persistence keeps args
- WHEN a step starts with detail D and then finishes failed with output O
- THEN the stored row has detail D, output O, status failed and an ended_at; getMessages returns both; a step that is still running returns output `""`


## MODIFIED Requirements

### Requirement: 会话数据 schema
Migration032_chat_sessions.sql SHALL atomically create chat_sessions, chat_messages and chat_steps using the existing runner-owned transaction. Existing0010/002/010/030/031 receipts and business data SHALL remain unchanged;032 SHALL append as the sixth receipt without changing ledger validation.
chat_sessions SHALL have id TEXT NOTNULL PRIMARYKEY constrained to32 lowercasehex characters withoutNUL; owner_id TEXT NOTNULL referencing accounts(id) ONDELETECASCADE; nullable title/omp_session_file TEXT; status TEXT NOTNULL in(idle,running,done,failed); stream_epoch INTEGER NOTNULL DEFAULT0 and nonnegativeinteger; created_at/updated_at INTEGER NOTNULL nonnegativeepochms; and an owner_id,updated_atDESC index.
chat_messages SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; session_id TEXT NOTNULL referencing chat_sessions(id) ONDELETECASCADE; role TEXT NOTNULL in(user,assistant); content TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(done,running,failed); created_at INTEGER NOTNULL. chat_steps SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; message_id INTEGER NOTNULL referencing chat_messages(id) ONDELETECASCADE; ordinal INTEGER NOTNULL nonnegativeinteger; name TEXT NOTNULL; detail TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(running,done,failed); started_at INTEGER NOTNULL; ended_at nullableINTEGER; UNIQUE(message_id,ordinal).
chat_messages SHALL have an ascending(session_id,created_at,id) index supporting ordered history within a session; indexnames are not part of the external contract.
NoIFNOTEXISTS silentconflict acceptance or migration-ownedtransaction SHALL bypass existing runner rollback. Store/reconciliation and runtime APIs are out of this migration slice.

#### Scenario: Fresh schema and receipts
- WHEN openDb opens :memory: or a new file database
- THEN receipts begin0010,002,010,030,031,032 in order (later migrations such as033 may follow) and allthree tablecolumns/defaults/keys/indexconstraints exist and govern actualwrites

#### Scenario: Domain rejection
- WHEN writes violate sessionidshape, requirednullability, table-specificrole/status enums, nonnegativeintegerstream_epoch/ordinal or sessiontimestamps
- THEN SQLite rejects them while validboundaryvalues remain writable; generated message/step IDs are not reused afterdeletion

#### Scenario: Referential ownership and cascade isolation
- WHEN childwrites name a missingaccount/session/message, or duplicateordinal withinonemessage
- THEN they fail; equalordinal in adifferentmessage is permitted
- WHEN a message, session or parentaccount is deleted
- THEN only its descendantchat rows cascade; unrelatedowner/session/message rows remain

#### Scenario: Existing database upgrade and reopen
- WHEN openDb opens a database with thefive previous migrations and existingauth/audit/workspace data
- THEN all priorreceipts/data stayunchanged,032 appends once, and repeatopen leaves the completecatalog stable

#### Scenario: Atomic failed migration and recovery
- WHEN a preexisting laterchat table conflicts during032 execution
- THEN no earlier032table or032receipt persists, previousreceipts/data and the conflictingobject remainunchanged
- WHEN the test-owned conflictingobject is removed and openDb retries
- THEN032 completes once and thedatabase reopens normally


### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages and POST /api/sessions/:id/prompt. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. Session views SHALL contain only id,title,status,createdAt,updatedAt; Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.

#### Scenario: Create list and empty history
- WHEN an authenticated account creates a session and reads its list and history
- THEN create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- WHEN a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body
- THEN its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- WHEN no valid cookie is supplied, including malformed/oversized bodies
- THEN401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- WHEN an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- THEN list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields
