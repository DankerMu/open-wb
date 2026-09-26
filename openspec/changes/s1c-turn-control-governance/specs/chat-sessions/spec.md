# Spec delta: chat-sessions（S1c A 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 会话持久化与回合刷盘
createSessionStore(db,{onFlushError}) SHALL provide SessionStore owner-scopedcreation/list/message-tree reads and the explicitmutation/lifecycle contract inthischange. IDs SHALL be random128-bit lowercasehex; creation SHALL persistidle/nulltitle/epoch0. Foreign/missingmessage-tree reads SHALL returnnull andownerlists SHALL excludeotherowners. Views SHALL expose only declaredsession/message/step fields, orderedupdatedAtDESC/idASC forsessionlist, createdAtASC/idASC formessages andordinalASC/idASC forsteps. getMessages SHALL return complete current content by joining the persisted body with only the matching owned active assistant pending tail. This read SHALL NOT force persistence, change timers/budgets/progress or mutate pending state; fault-retained pending data remains visible without claiming durability.
acceptPrompt(sessionId,ownerId,text) SHALL atomically checkownership/busy, insertuserdone+emptyassistantrunning andupdatesessionrunning/title-ifNULL/updatedAt. Foreign/missing SHALL throwcoreHttpError not_found beforebusy disclosure; running SHALL throwsession_busy withoutwrites; idle, done, failed and **stopped** sessions SHALL all be eligible. Text SHALL bepreserved; title SHALL usefirst18Unicodecodepoints withoutellipsis. acceptPrompt SHALL NOT bumpstream_epoch. bumpStreamEpoch SHALL incrementonce independently; setSessionFile SHALL persistresume metadata. runtimeState is a trusted-supervisor-only accessor, not anowner-authorization endpoint.
rollbackPrompt SHALL atomically remove onlyanunprogressed acceptedpair andrestoreprevioussessionstatus/title/updatedAt (including a previous `stopped` status), not independentlychangedepoch/sessionFile. It SHALL rejectrollbackaftertext/step progress andreturnfalse wheninactive. Transactions SHALL NOT consumeorrollback caller-ownedtransactions; DBerrors SHALL propagatewithoutpartialwrites/memorycommit.
appendDelta SHALL buffer in order byactiveassistantidentity, flushat2048cumulativeUTF8bytes or2000ms sincefirstpendingdelta (whicheverfirst), andresetdeadline/bytebudget onlyafter successfulflush. Quietpendingdata SHALL flushwithoutanotherdelta. Steps SHALL persistimmediately; finishStep SHALL settleonlyrunningsteps. finishTurn(assistantMessageId,status) SHALL accept status `done`, `failed` or `stopped` and SHALL atomically flushresidual andsettleassistant/session to that status plusremainingrunningsteps, preservingalreadyterminalsteps; a `stopped` turn SHALL settle its remaining running steps to `stopped` with NULL output (read back as an empty string) and an ended_at. Stalecalls SHALL NOT modifyterminal/newturn rows; inactive append/finish methods returnfalse.
Timerflushfailure SHALL retainpendingdata, notifyrequiredonFlushError once andstopautomaticretry. FurtherappendDelta onthefaulted-but-activebuffer SHALL throwtheretainedflushfault withoutgrowingthebuffer (false remainsinactive/stale only). Explicitfinish/close mayretryafterexternalrepair; successfulwrites SHALL notduplicatecontent. close SHALL cancelownedtimers, finalizeactiveownedturns asfailed withresidualdata, remainidempotent aftersuccess andleaveDBownership tocaller; failures SHALL notpretendcleanup/persistence succeeded.
reconcileOnStartup SHALL explicitly andatomically setallrunning session/message/step statuses tofailed whilepreserving allotherfields/rows; `stopped` rows are already terminal and SHALL NOT be touched. It SHALL runbeforelivework andreject invocation withownedactive turnstate. No constructor-side reconcile or REST/omp/SSE assembly isadded.

#### Scenario: Owner-safe ordered reads
- **WHEN** twoowners createconversations andpersist message/step histories
- **THEN** eachowner seesonlytheirownorderedviews, foreignmessage-tree returnsnull, andinternalruntime/resume/buffer fields areabsentfrombrowser-facingviews

#### Scenario: Atomic admission and epoch separation
- **WHEN** anidle/done/failed/stopped owned sessionaccepts text
- **THEN** onedoneuser andonerunningassistant appearwithsessionrunning/title-ifNULL; epochstaysunchanged andexplicitbumpaddsone
- **WHEN** ownershipfails, sessionisbusy, aninsert/update/commit fails orcallerownsatransaction
- **THEN** no partialadmission/memoryturn remains; correcterror surfaces and callertransactionisnotrolledback

#### Scenario: Pre-dispatch compensation
- **WHEN** runtimepreparationfails beforeanyturnprogress andcallerrollsbacktheacceptedassistant
- **THEN** acceptedpair disappears andpriorstatus/title/updatedAt return; independentepoch/resumemetadata remain
- **WHEN** theturnalreadyprogressed
- **THEN** rollbackisrejected withoutdeleting itsdata

#### Scenario: Byte and quiet-time flushing
- **WHEN** pendingbody isbelow2048UTF8bytes andbelow2000ms old
- **THEN** persistentcontent isunchanged
- **WHEN** eitherthreshold isreached, includingaquiettimerwithnolaterdelta
- **THEN** allpendingtext persistsinorder exactlyonce whileassistantremainsrunning, withanewbudget/deadline forlatertext

#### Scenario: Step and terminal persistence
- **WHEN** stepstart/end anddone/failedfinishTurn occur
- **THEN** steps persistimmediately, finalresidualbody andsession/assistant statuses commitatomically, remainingrunningstepssettle andalreadyterminalstepsremainunchanged
- **WHEN** staleevents/timers fromthatturn arriveafterterminal orafteranewadmission
- **THEN** neitherterminalcontent nornewturn statechanges

#### Scenario: Stopped turn settlement
- **WHEN** a turn with residual pending text, one done step and one running step is finished with status `stopped`
- **THEN** in one transaction the residual text is persisted, assistant and session read `stopped`, the running step reads `stopped` with output `""` and an ended_at, the done step is unchanged; a later prompt on that session is admitted from `stopped` and rollback of that unprogressed admission restores `stopped`

#### Scenario: Failure retention and shutdown
- **WHEN** SQLite rejectsaflush orfinalization
- **THEN** uncommittedbuffer isretained, no partialterminalstate appears; synchronouserrorspropagate andtimererrorsnotifyonce withoutunhandledthrow/retryloop; furtherappendDelta onthefaultedactivebuffer throwstheretainedfault withoutgrowingpendingdata
- **WHEN** callerrepairsfailure andexplicitlyfinishes/closes
- **THEN** pendingbytes persistonce; closecancelsalltimers anddoesnotcloseDB

#### Scenario: Startup reconciliation
- **WHEN** anunstartedstore seesrunningrows mixedwithidle/done/failed/stoppedrows acrossowners
- **THEN** oneexplicitreconcile changesonlyrunningstatuses tofailed inallthreetables andleavesallotherdata, including stopped rows, unchanged
- **WHEN** a reconciliationwritefails
- **THEN** noneofthestatuschangescommit

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop, POST /api/sessions/:id/regenerate, POST /api/sessions/:id/fork and POST /api/sessions/:id/approvals/:approvalId. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,approval,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. `approval` SHALL be present on every message: for an assistant message it is the latest `chat_approvals` row of that message as `{id,tool,title,requestedAt,expiresAt,decision}` with `decision` ∈ `allow|deny|timeout|null`, or `null` when the message has no approval; for a user message it is always `null`. Session, message and step `status` unions SHALL include `stopped`. Session views SHALL contain only id,title,status,createdAt,updatedAt (`parent_session_id` and `omp_session_file` SHALL NOT be exposed); Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/stop SHALL be bodyless (any body ignored, not a content-parser owner): when the session is `running` it SHALL call supervisor.stop(sessionId) — which settles every pending approval of that turn as `deny` and answers `Deny` before writing the `abort` frame — and return202 with an empty body without waiting for the turn to end; for any other status it SHALL return204 with no writes and no supervisor call. The stopped turn ends with `turn.end{status:"stopped"}` and session/assistant/running steps read `stopped`.
POST /api/sessions/:id/regenerate SHALL be bodyless. A `running` session SHALL return409 session_busy. A session whose history does not end with an assistant message immediately preceded by a user message SHALL return400 bad_request. Otherwise it SHALL call supervisor.regenerate(sessionId): acquire the session's slot through the process cap (`agent_capacity` → 503), `get_branch_messages`, pick the entry whose position is last and whose `text` equals the stored last user message content (any mismatch → 502 agent_unavailable with no row change), `branch{entryId}`, `get_state`, then in one SQLite transaction delete the old assistant row (steps cascade), insert a new empty `running` assistant row, set `omp_session_file` to the new file and session status `running`, and dispatch the branch-returned text as the prompt; it SHALL return202 {assistantMessageId} of the new row. Runtime failure before the transaction SHALL leave every row unchanged and map to502 agent_unavailable; dispatch failure after the transaction SHALL settle the new assistant row and session as `failed`, return502 agent_unavailable (rows are already terminal, nothing is compensated) and SHALL NOT resurrect the deleted row.
POST /api/sessions/:id/fork SHALL accept only application/json and an object with exactly messageId:number; any other shape, a messageId that is not a `user` message of this session, or wrong media/malformed JSON SHALL return400 bad_request. A `running` source session SHALL return409 session_busy. Otherwise it SHALL create the new session row first (same owner, copied title, `parent_session_id` = source id, status idle, `omp_session_file` NULL), run a temporary runtime through the process cap (`agent_capacity` → 503) with `--resume <source omp_session_file>`, `get_branch_messages`, pick the entry whose ordinal position among user messages equals the stored message's and whose `text` equals its content (mismatch → 502 agent_unavailable and the new session row removed), `branch{entryId}`, `get_state`, shut the temporary process down, then in one transaction set the new session's `omp_session_file` to the new file. The temporary runtime is not a session generation: it SHALL NOT bump either session's `stream_epoch`, owns no ring, publishes no events, is bound to no slot and counts only against the process cap. The transaction SHALL also copy every chat_messages/chat_steps row of the source that precedes the fork-point user message (new ids, same order, content, status, timestamps and step detail/output). The source session's rows, status, process and file SHALL be unchanged. It SHALL return201 {session,draft} where `session` is the new session's five-field public view and `draft` is the branch-returned user text.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: persist decision/decided_at → answer the child (`Approve` for allow, `Deny` for deny) → publish `approval.resolved` → emit audit `session.approval` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}`.

#### Scenario: Create list and empty history
- **WHEN** an authenticated account creates a session and reads its list and history
- **THEN** create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- **WHEN** a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls stop/regenerate/fork/approvals on it
- **THEN** its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- **WHEN** no valid cookie is supplied, including malformed/oversized bodies, on any of the seven routes
- **THEN** 401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- **WHEN** an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- **THEN** list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields, every message carrying an `approval` key

#### Scenario: Stop is accepted while running and idempotent otherwise
- **WHEN** the owner posts stop on a running session backed by the real fake (`abort-ok`), then posts stop again after the turn has ended, and posts stop on an idle session
- **THEN** the first call returns202 with no-store before the turn ends and the session/assistant/running steps subsequently read `stopped` with `turn.end{status:"stopped"}` published; the later calls return204 without writes; a subsequent prompt on the stopped session returns202
- **WHEN** a stop is posted while an approval of that turn is pending
- **THEN** the approval row reads `deny`, the child receives `Deny` before the `abort` frame (fake probe order), `approval.resolved{decision:"deny"}` precedes `turn.end{status:"stopped"}`

#### Scenario: Regenerate replaces only the last assistant message
- **WHEN** the owner posts regenerate on a done/failed/stopped session whose last two messages are user U then assistant A, backed by the real fake (`branch`)
- **THEN** 202 {assistantMessageId} names a new running assistant row, A and its steps are gone, U and earlier rows are unchanged, `omp_session_file` equals the branch-created file, and the new turn runs with U's text
- **WHEN** the session is running, or its history is empty/ends with a user message, or `get_branch_messages` yields no entry whose text equals U
- **THEN** 409 session_busy, 400 bad_request or 502 agent_unavailable respectively, with no row change

#### Scenario: Fork copies history before the chosen user message
- **WHEN** the owner posts fork {messageId} naming the second user message of a four-message idle session, backed by the real fake (`branch`)
- **THEN** 201 {session,draft} returns a new idle session with the copied title and the five public fields only, `draft` equals that user message's text, the new session's messages contain copies of the first user/assistant pair (with steps) and nothing else, the new row has `parent_session_id` = source id, and the source session's rows/status/`omp_session_file` are unchanged; the temporary process has exited
- **WHEN** messageId names an assistant message, a message of another session, or the body is malformed; or the source is running; or the branch entry does not align
- **THEN** 400, 409 session_busy or 502 respectively; on 502 the pre-created session row is removed and no messages were copied

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner reads the snapshot, then posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the snapshot's running assistant message carries `approval:{id,tool:"bash",title,requestedAt,expiresAt,decision:null}` while user messages carry `approval:null`; the first answer returns200 with `decision:"allow"` after the row is written and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** no answer arrives within 60s of the injected clock
- **THEN** the row reads `timeout`, the child receives `Approve`, `approval.resolved{decision:"timeout"}` is published and the snapshot shows `decision:"timeout"`

### Requirement: REST prompt 受理与补偿
The prompt route SHALL accept only application/json and an object with exactly message:string. It SHALL trim the string once and require nonempty text of at most32768 UTF-8 bytes. Invalid shape, media, malformed JSON or oversized parser envelope SHALL return400 bad_request; decoded valid escape-heavy text SHALL NOT be rejected merely because its wire JSON exceeds32768 bytes. The existing bounded parser envelope remains distinct from the semantic message limit.
The route SHALL use store.acceptPrompt(sessionId,principal.id,text) for the atomic admission and then await supervisor.prompt(sessionId,text). The owned SessionSupervisorPort SHALL expose prompt(sessionId:string,text:string):Promise<void>; resolution means dispatch accepted, not turn finished. Successful admission SHALL return202 {userMessageId,assistantMessageId} from that exact store admission. Running sessions SHALL return409 session_busy without added rows or dispatch; idle/done/failed/stopped SHALL be eligible.
Supervisor rejection SHALL compensate the unprogressed accepted pair through store.rollbackPrompt before returning the canonical error. HttpError agent_unavailable SHALL produce502, HttpError session_busy SHALL produce409, HttpError agent_capacity SHALL produce503; unknown failures SHALL remain generic5xx. Compensation failure SHALL propagate as generic5xx, not be masked as502/409/503. The supervisor SHALL NOT reject after publishing/persisting progress; post-dispatch failures belong to supervisor lifecycle. No retries or real runtime/SSE implementation are part of this boundary.

#### Scenario: Accepted prompt and concurrent busy
- **WHEN** a valid prompt is admitted while the stub supervisor is held pending
- **THEN** the real store has one user-done and one empty assistant-running message, with trimmed text and title; a concurrent second prompt returns409 without changing rows
- **WHEN** the pending supervisor resolves
- **THEN** the first request returns202 with precisely those two IDs, without waiting for terminal turn completion

#### Scenario: Input boundaries
- **WHEN** message is empty after trim, has a wrong type, is in an array/null/extra-key object, or exceeds32768 decoded UTF-8 bytes, or the request has wrong media/malformed JSON/oversized envelope
- **THEN** 400 bad_request/no-store occurs without admission or dispatch
- **WHEN** trimmed text is exactly32768 UTF-8 bytes, including multibyte and JSON-escaped content
- **THEN** 202 is possible and the same trimmed text reaches storage and supervisor

#### Scenario: Failed dispatch restores prior state
- **WHEN** the stub supervisor rejects with canonical agent_unavailable, session_busy or agent_capacity after a new admission from idle/done/failed/stopped
- **THEN** 502, 409 or 503 respectively is returned, prior title/status/updatedAt/history is preserved and the admitted pair removed; a later prompt can succeed
- **WHEN** admission itself rejects
- **THEN** the supervisor is not called and another active turn is not rolled back

#### Scenario: Unknown and compensation failures
- **WHEN** the supervisor throws an untyped error, including a forged status/code shape
- **THEN** its unprogressed admission is compensated and the response is generic5xx without leaking raw error data
- **WHEN** rollback itself fails
- **THEN** generic5xx is returned without falsely reporting restored state or masking the storage failure as agent_unavailable

#### Scenario: Terminal sessions can prompt again
- **WHEN** the real store completes an accepted turn as done, failed or stopped, and the owner sends another valid prompt
- **THEN** the next prompt returns202 with new IDs, retaining previous history and the established title

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
Migration `034_chat_turn_control.sql` SHALL run inside the existing runner-owned transaction and append as the **eighth** receipt after `033` without changing ledger validation or any earlier receipt. Because SQLite cannot alter a CHECK constraint, it SHALL rebuild `chat_sessions`, `chat_messages` and `chat_steps` (create `<table>_next` with the full explicit column list → `INSERT … SELECT` naming every column, never `SELECT *` → `DROP` the old table → `ALTER TABLE … RENAME`), preserving every existing column, default, NOT NULL, primary key, AUTOINCREMENT, foreign key with its `ON DELETE CASCADE`, UNIQUE constraint and index (index names are not part of the external contract) while widening the three status CHECKs to `chat_sessions.status IN (idle,running,done,failed,stopped)`, `chat_messages.status IN (done,running,failed,stopped)` and `chat_steps.status IN (running,done,failed,stopped)`. The rebuild SHALL carry forward the `sqlite_sequence` high-water marks of `chat_messages` and `chat_steps` so ids deleted before the upgrade are never reissued. The same migration SHALL add `chat_sessions.parent_session_id TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL` (NULL for every existing row) and create `chat_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK (decision IN ('allow','deny','timeout')), decided_at INTEGER NULL, UNIQUE(message_id, request_id))` plus an index on `message_id`. Any failure during the migration SHALL leave the original three tables, all their rows and every earlier receipt intact, with no `_next` table, no `chat_approvals` and no `034` receipt persisted. Foreign-key enforcement during the rebuild SHALL follow the runner's existing `PRAGMA foreign_keys` handling; if the migration needs to relax enforcement it SHALL restore it before the transaction commits. The trusted-migration count assertions SHALL grow by one.

#### Scenario: Fresh schema and receipts
- **WHEN** openDb opens :memory: or a new file database
- **THEN** receipts are `0010,002,010,030,031,032,033,034` in order; the three chat tables carry the widened CHECKs, `chat_sessions.parent_session_id` exists nullable with `ON DELETE SET NULL`, `chat_approvals` exists with the declared columns/constraints, and all 032/033 columns, defaults, keys, cascades and unique constraints govern actual writes

#### Scenario: Populated 033 database upgrades losslessly
- **WHEN** openDb opens a file database holding the seven prior receipts with sessions, messages (including deleted-then-gapped ids) and steps with detail/output across two owners
- **THEN** `034` appends once; every row of the three tables is byte-identical in all pre-existing columns, `parent_session_id` reads NULL, row counts match, the next generated message/step id is greater than any id ever issued, foreign keys still cascade from account → session → message → step, `UNIQUE(message_id,ordinal)` and the ordered history index still hold, `PRAGMA foreign_key_check` is empty, and reopening leaves the catalog stable

#### Scenario: Mid-rebuild failure is atomic
- **WHEN** the migration fails part-way (for example a test-owned conflicting `chat_messages_next` or `chat_approvals` object exists)
- **THEN** no `_next` table, no `chat_approvals` and no `034` receipt persist, the original three tables and all rows/receipts are unchanged, and after the conflicting object is removed a retry completes `034` once

#### Scenario: Stopped accepted, other values rejected
- **WHEN** writes set status `stopped` on a session, a message and a step, and separately attempt an unknown status such as `cancelled` on each table or a `decision` outside allow/deny/timeout on `chat_approvals`
- **THEN** the three `stopped` writes succeed while every unknown value is rejected by SQLite; deleting a message cascades its approvals; deleting a parent session sets `parent_session_id` of its forks to NULL without deleting them; a duplicate `(message_id,request_id)` approval is rejected
