# Spec delta: chat-sessions（S1c A 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

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

### Requirement: 会话持久化与回合刷盘
createSessionStore(db,{onFlushError}) SHALL additionally receive the `core/audit` emit bound to the same DB (workspace-store precedent) and SHALL provide SessionStore owner-scopedcreation/list/message-tree reads and the explicitmutation/lifecycle contract inthischange. IDs SHALL be random128-bit lowercasehex; creation SHALL persistidle/nulltitle/epoch0. Foreign/missingmessage-tree reads SHALL returnnull andownerlists SHALL excludeotherowners. Views SHALL expose only declaredsession/message/step fields, orderedupdatedAtDESC/idASC forsessionlist, createdAtASC/idASC formessages andordinalASC/idASC forsteps. getMessages SHALL return complete current content by joining the persisted body with only the matching owned active assistant pending tail. This read SHALL NOT force persistence, change timers/budgets/progress or mutate pending state; fault-retained pending data remains visible without claiming durability.
acceptPrompt(sessionId,ownerId,text) SHALL atomically checkownership/busy, insertuserdone+emptyassistantrunning andupdatesessionrunning/title-ifNULL/updatedAt. Foreign/missing SHALL throwcoreHttpError not_found beforebusy disclosure; running SHALL throwsession_busy withoutwrites; idle, done, failed and **stopped** sessions SHALL all be eligible. Text SHALL bepreserved; title SHALL usefirst18Unicodecodepoints withoutellipsis. acceptPrompt SHALL NOT bumpstream_epoch. bumpStreamEpoch SHALL incrementonce independently; setSessionFile SHALL persistresume metadata. runtimeState is a trusted-supervisor-only accessor, not anowner-authorization endpoint.
rollbackPrompt SHALL atomically remove onlyanunprogressed acceptedpair andrestoreprevioussessionstatus/title/updatedAt (including a previous `stopped` status), not independentlychangedepoch/sessionFile. It SHALL rejectrollbackaftertext/step progress andreturnfalse wheninactive. Transactions SHALL NOT consumeorrollback caller-ownedtransactions; DBerrors SHALL propagatewithoutpartialwrites/memorycommit.
appendDelta SHALL buffer in order byactiveassistantidentity, flushat2048cumulativeUTF8bytes or2000ms sincefirstpendingdelta (whicheverfirst), andresetdeadline/bytebudget onlyafter successfulflush. Quietpendingdata SHALL flushwithoutanotherdelta. Steps SHALL persistimmediately; finishStep SHALL settleonlyrunningsteps. finishTurn(assistantMessageId,status) SHALL accept status `done`, `failed` or `stopped` and SHALL atomically flushresidual andsettleassistant/session to that status plusremainingrunningsteps, preservingalreadyterminalsteps; a `stopped` turn SHALL settle its remaining running steps to `stopped` with NULL output (read back as an empty string) and an ended_at. In the same transaction finishTurn SHALL settle every still-pending (`decision` NULL) `chat_approvals` row of that assistant message to `deny` with `decided_at`, writing one `session.approval` audit row per settled approval through the injected emit, and SHALL report the settled approvals to its caller so the supervisor can publish their `approval.resolved` before turn.end; an audit write failure SHALL roll back the whole terminal transaction. Stalecalls SHALL NOT modifyterminal/newturn rows; inactive append/finish methods returnfalse.
Timerflushfailure SHALL retainpendingdata, notifyrequiredonFlushError once andstopautomaticretry. FurtherappendDelta onthefaulted-but-activebuffer SHALL throwtheretainedflushfault withoutgrowingthebuffer (false remainsinactive/stale only). Explicitfinish/close mayretryafterexternalrepair; successfulwrites SHALL notduplicatecontent. close SHALL cancelownedtimers, finalizeactiveownedturns asfailed withresidualdata (settling their pending approvals `deny` with `decided_at` and one audit row each in the same transaction, as finishTurn does), remainidempotent aftersuccess andleaveDBownership tocaller; failures SHALL notpretendcleanup/persistence succeeded.
reconcileOnStartup SHALL explicitly andatomically setallrunning session/message/step statuses tofailed and, in the same transaction, settle every pending (`decision` NULL) `chat_approvals` row of those messages to `deny` with `decided_at` equal to the reconcile time, writing one `session.approval` audit row per settled approval (actorId = the session's owner_id) through the injected emit, whilepreserving allotherfields/rows except the approval settlement defined here; `stopped` rows are already terminal and SHALL NOT be touched. Reconcile publishes no event (no ring exists yet). It SHALL runbeforelivework andreject invocation withownedactive turnstate. No constructor-side reconcile or REST/omp/SSE assembly isadded.

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

#### Scenario: Terminal settlement denies pending approvals
- **WHEN** an active assistant message has two pending approvals and one already `allow`, and the turn is finished `failed` or `stopped`, or separately the store is closed with that turn still active
- **THEN** in the same transaction as the terminal status both pending rows read `deny` with a `decided_at`, the `allow` row is unchanged, exactly two `session.approval` audit rows with `decision:"deny"` are committed, and finishTurn reports the two settled approvals to its caller
- **WHEN** the audit write fails inside that transaction
- **THEN** neither the terminal statuses nor the approval decisions commit

#### Scenario: Startup reconciliation
- **WHEN** anunstartedstore seesrunningrows mixedwithidle/done/failed/stoppedrows acrossowners
- **THEN** oneexplicitreconcile changesonlyrunningstatuses tofailed inallthreetables andleavesallotherdata, including stopped rows, unchanged except the approval settlement defined here
- **WHEN** a running assistant message has a pending approval and a settled `allow` approval at reconcile time
- **THEN** the pending row reads `deny` with `decided_at`, the `allow` row is unchanged, exactly one `session.approval` audit row with the owner as actor and `decision:"deny"` is committed in the same transaction, and no event is published
- **WHEN** a reconciliationwritefails
- **THEN** noneofthestatuschangescommit

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop, POST /api/sessions/:id/regenerate, POST /api/sessions/:id/fork and POST /api/sessions/:id/approvals/:approvalId. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,approvals,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. `approvals` SHALL be present on every message as an array of all `chat_approvals` rows of that message in ascending id order, each `{id,tool,title,requestedAt,expiresAt,decision}` with `decision` ∈ `allow|deny|timeout|null`; it SHALL be `[]` for a user message and for an assistant message without approval rows. Several pending (`decision:null`) entries MAY coexist on one message (parallel tool calls); a later approval request never replaces an earlier entry. Session, message and step `status` unions SHALL include `stopped`. Session views SHALL contain only id,title,status,createdAt,updatedAt (`parent_session_id` and `omp_session_file` SHALL NOT be exposed); Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/stop and POST /api/sessions/:id/regenerate SHALL be bodyless content-parser owners (the logout precedent): any parsed body (including `{}`), empty-or-malformed JSON, unsupported media or an envelope above their minimal body limit SHALL return400 bad_request after authorization and before any supervisor call, frame or write. When the session is `running`, stop SHALL call supervisor.stop(sessionId) — which holds the session's control claim for the call, first settles every pending approval of that turn, if any exist (the pending set is the snapshot read on entry; it is not re-read before the `abort` frame), as `deny` (per approval: persist decision/decided_at and its `session.approval` audit row in one transaction → answer `Deny` → publish `approval.resolved`) and then writes the `abort` frame; when the turn's prompt frame is not yet written, stop instead records a stop intent and the supervisor writes `abort` right after that prompt's dispatch receipt resolves (after the stop call has returned), so stop neither cancels the dispatch nor compensates the accepted rows and the prompt request still returns its normal202 body (a failed acquisition or dispatch still follows the ordinary prompt compensation, and the intent never rewrites a terminal status another path reached first) — and return202 with body exactly `{}` without waiting for the turn to end; for any other status it SHALL return204 with no writes and no supervisor call. The stopped turn ends with `turn.end{status:"stopped"}` and session/assistant/running steps read `stopped`.
POST /api/sessions/:id/regenerate: a `running` session, or a session whose control claim is held by another regenerate, fork or stop, SHALL return409 session_busy. A session whose history does not end with an assistant message immediately preceded by a user message SHALL return400 bad_request. Otherwise it SHALL call supervisor.regenerate(sessionId), which registers the session's control claim with the last assistant message id read by the precheck and releases it once dispatch completes or the response returns: acquire the session's process — reusing a live one, or through the same lazy acquisition as prompt (a normal new generation, stream_epoch+1 with a fresh ring) when it has been reclaimed — through the process cap (`agent_capacity` → 503), `get_branch_messages`, pick the entry whose position is last and whose `text` equals the stored last user message content (any mismatch → 502 agent_unavailable with no row change), `branch{entryId}`, `get_state`, then in one SQLite transaction — which SHALL first recheck that the session status is not `running` and its last assistant message id still equals the precheck's, otherwise write nothing, retire the process and return409 session_busy — delete the old assistant row (steps and approvals cascade), insert a new empty `running` assistant row, set `omp_session_file` to the new file and session status `running`, and dispatch the branch-returned text as the prompt; it SHALL return202 {assistantMessageId} of the new row. Runtime failure before the transaction SHALL leave every row unchanged and map to502 agent_unavailable; dispatch failure after the transaction SHALL settle the new assistant row and session as `failed`, return502 agent_unavailable (rows are already terminal, nothing is compensated) and SHALL NOT resurrect the deleted row.
POST /api/sessions/:id/fork SHALL accept only application/json and an object with exactly messageId:number; any other shape, a messageId that is not a `user` message of this session, or wrong media/malformed JSON SHALL return400 bad_request. A `running` source session, or one whose control claim is held by another regenerate, fork or stop, SHALL return409 session_busy. Otherwise the supervisor SHALL register the source session's control claim (with the last assistant message id read by the precheck), create the new session row first (same owner, copied title, `parent_session_id` = source id, status idle, `omp_session_file` NULL), retire the source session's live idle process if one exists (its history is in the file, so this is lossless), then run a temporary runtime through the process cap (`agent_capacity` → 503) with `--resume <source omp_session_file>`, `get_branch_messages`, pick the entry whose ordinal position among user messages equals the stored message's and whose `text` equals its content (mismatch → 502 agent_unavailable and the new session row removed), `branch{entryId}`, `get_state`, shut the temporary process down, then in one transaction — which SHALL first recheck that the source status is not `running` and its last assistant message id still equals the precheck's, otherwise write nothing but remove the new session row and return409 session_busy — set the new session's `omp_session_file` to the new file. The temporary runtime is not a session generation: it SHALL NOT bump either session's `stream_epoch`, owns no ring, publishes no events, is bound to no slot and counts only against the process cap. The transaction SHALL also copy every chat_messages/chat_steps row of the source that precedes the fork-point user message (new ids, same order, content, status, timestamps and step detail/output), copy every `chat_approvals` row of those copied messages onto the new message ids (new approval ids; request_id, tool, title, requested_at, expires_at, decision and decided_at preserved), and set the new session's status to the status of the last copied assistant message (`done`, `failed` or `stopped`), leaving it `idle` only when nothing is copied. The source session's rows, status and file SHALL be unchanged; its live process, if any, receives no frame and is retired before the temporary process starts. It SHALL return201 {session,draft} where `session` is the new session's five-field public view and `draft` is the branch-returned user text.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: in one transaction persist decision/decided_at and its `session.approval` audit row → answer the child (`Approve` for allow, `Deny` for deny) and cancel its timeout timer → publish `approval.resolved` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}` (one element of the snapshot's `approvals` array).

#### Scenario: Create list and empty history
- **WHEN** an authenticated account creates a session and reads its list and history
- **THEN** create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- **WHEN** a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls stop/regenerate/fork/approvals on it
- **THEN** its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- **WHEN** no valid cookie is supplied, including malformed/oversized bodies, on any of the eight routes
- **THEN** 401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- **WHEN** an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- **THEN** list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields, every message carrying an `approvals` array (`[]` when it has no approval rows)

#### Scenario: Stop is accepted while running and idempotent otherwise
- **WHEN** the owner posts stop on a running session backed by the real fake (`abort-ok`), then posts stop again after the turn has ended, and posts stop on an idle session
- **THEN** the first call returns202 with body exactly `{}` and no-store before the turn ends and the session/assistant/running steps subsequently read `stopped` with `turn.end{status:"stopped"}` published; the later calls return204 without writes; a subsequent prompt on the stopped session returns202
- **WHEN** a stop is posted while an approval of that turn is pending
- **THEN** the approval row reads `deny` and its `session.approval` audit row is committed with it, the child receives `Deny` before the `abort` frame (fake probe order), `approval.resolved{decision:"deny"}` precedes `turn.end{status:"stopped"}`
- **WHEN** stop or regenerate is posted by the owner with a JSON body `{}`, malformed JSON, an empty JSON body, an unsupported media type or an oversized body
- **THEN** 400 bad_request with no-store is returned with no supervisor call, no frame and no write

#### Scenario: Regenerate replaces only the last assistant message
- **WHEN** the owner posts regenerate on a done/failed/stopped session whose last two messages are user U then assistant A, backed by the real fake (`branch`)
- **THEN** 202 {assistantMessageId} names a new running assistant row, A and its steps are gone, U and earlier rows are unchanged, `omp_session_file` equals the branch-created file, and the new turn runs with U's text
- **WHEN** the session is running, or its history is empty/ends with a user message, or `get_branch_messages` yields no entry whose text equals U
- **THEN** 409 session_busy, 400 bad_request or 502 agent_unavailable respectively, with no row change
- **WHEN** the session's process was reclaimed by idle before regenerate
- **THEN** 202 is returned, `streamCursor.epoch` is the previous value plus one and the new generation's SSE delivers turn.start then turn.end for the new assistant row
- **WHEN** a prompt, regenerate or fork for the same session arrives between regenerate's RPCs, or a test-injected write changes the session status or last assistant id before the final transaction
- **THEN** the concurrent request returns409 session_busy with no row change; a failed final recheck returns409 session_busy, writes nothing and retires the process

#### Scenario: Fork copies history before the chosen user message
- **WHEN** the owner posts fork {messageId} naming the second user message of a four-message done session whose first assistant message is `done` and carries one `allow` approval, backed by the real fake (`branch`) with the source's idle process still live
- **THEN** 201 {session,draft} returns a new session with status `done` (the last copied assistant's status), the copied title and the five public fields only, `draft` equals that user message's text, the new session's messages contain copies of the first user/assistant pair (with steps and the `allow` approval) and nothing else, the new row has `parent_session_id` = source id, and the source session's rows/status/`omp_session_file` are unchanged; the source's live process exited before the temporary process started and the temporary process has exited
- **WHEN** the owner forks at the session's first user message
- **THEN** 201 returns a new `idle` session with empty messages and `draft` equal to that message's text
- **WHEN** messageId names an assistant message, a message of another session, or the body is malformed; or the source is running; or the branch entry does not align
- **THEN** 400, 409 session_busy or 502 respectively; on 502 the pre-created session row is removed and no messages were copied

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner reads the snapshot, then posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the snapshot's running assistant message carries `approvals:[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]` while user messages carry `approvals:[]`; the first answer returns200 with `decision:"allow"` after the row and its audit row are committed together, and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** no answer arrives within 60s of the injected clock
- **THEN** the row reads `timeout`, the child receives `Approve`, `approval.resolved{decision:"timeout"}` is published and the snapshot shows `decision:"timeout"`
- **WHEN** the real fake (`approval-parallel`) raises two approvals in one turn and the owner answers only the second
- **THEN** the snapshot lists both in ascending id order, the second reads `allow` while the first stays `decision:null`, and answering the first later settles it independently

### Requirement: REST prompt 受理与补偿
The prompt route SHALL accept only application/json and an object with exactly message:string. It SHALL trim the string once and require nonempty text of at most32768 UTF-8 bytes. Invalid shape, media, malformed JSON or oversized parser envelope SHALL return400 bad_request; decoded valid escape-heavy text SHALL NOT be rejected merely because its wire JSON exceeds32768 bytes. The existing bounded parser envelope remains distinct from the semantic message limit.
The route SHALL use store.acceptPrompt(sessionId,principal.id,text) for the atomic admission and then await supervisor.prompt(sessionId,text). The owned SessionSupervisorPort SHALL expose prompt(sessionId:string,text:string):Promise<void>; resolution means dispatch accepted, not turn finished. Successful admission SHALL return202 {userMessageId,assistantMessageId} from that exact store admission. Running sessions SHALL return409 session_busy without added rows or dispatch; so SHALL a session whose supervisor control claim is held by an in-progress regenerate, fork or stop — the claim check and admission SHALL run without an intervening await; idle/done/failed/stopped SHALL be eligible.
Supervisor rejection SHALL compensate the unprogressed accepted pair through store.rollbackPrompt before returning the canonical error. HttpError agent_unavailable SHALL produce502, HttpError session_busy SHALL produce409, HttpError agent_capacity SHALL produce503; unknown failures SHALL remain generic5xx. Compensation failure SHALL propagate as generic5xx, not be masked as502/409/503. The supervisor SHALL NOT reject after publishing/persisting progress; post-dispatch failures belong to supervisor lifecycle. No retries or real runtime/SSE implementation are part of this boundary.

#### Scenario: Accepted prompt and concurrent busy
- **WHEN** a valid prompt is admitted while the stub supervisor is held pending
- **THEN** the real store has one user-done and one empty assistant-running message, with trimmed text and title; a concurrent second prompt returns409 without changing rows
- **WHEN** the pending supervisor resolves
- **THEN** the first request returns202 with precisely those two IDs, without waiting for terminal turn completion
- **WHEN** a valid prompt arrives while a regenerate, fork or stop holds that session's control claim
- **THEN** 409 session_busy is returned with no added rows and no dispatch

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

### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner and resume metadata. On the prompt path it SHALL neither admit nor compensate a pair itself. Regenerate and fork (Requirement「会话 REST」) are supervisor-owned admission and compensation paths: the supervisor SHALL perform their single final SQLite transaction (including the control-claim recheck) and their failure compensation (retiring the process, removing a pre-created fork session row, or settling a dispatched regenerate assistant row `failed`). The supervisor SHALL hold a per-session control claim for regenerate, fork and stop from a passed precheck until dispatch completes or the response is returned; while it is held, prompt, regenerate and fork on that session SHALL be rejected with session_busy (a stop after regenerate has dispatched proceeds normally because the session is then `running`), and the claimed session's process counts as in-turn for the process cap. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error.
The supervisor SHALL await the exact runtime dispatch receipt and persist the validated sessionFile before resolving the REST port, without consuming business frames first. Pre-progress failure SHALL retire/discard that runtime before rejecting so REST can compensate. No post-progress error SHALL reject the already-accepted REST operation.
Every runtime generation acquisition, including idle re-spawn, crash recovery and a regenerate on a session whose process has been reclaimed or evicted, SHALL increment stream_epoch exactly once via the existing store method before shared-token issuance; reuse of a live generation SHALL not increment it. Regenerate SHALL acquire that normal generation (epoch+1, a fresh ring) through the same lazy acquisition path as prompt. A fork's temporary runtime is not a generation: it SHALL NOT bump either session's stream_epoch, own a ring, publish events or bind a session slot, and counts only against the process cap. Failed acquisition may advance epoch independently of REST compensation. Runtime SHALL retain token-revocation ownership; native exit SHALL make that generation token invalid, without stale callbacks revoking a newer token. No requestId SHALL be guessed from an ACK.

#### Scenario: Cold start and reuse
- **WHEN** an owner prompts a new session and later prompts the same healthy runtime again
- **THEN** both requests return202 after dispatch, sessionFile is stored, one generation/epoch/token is used and no duplicate native child is spawned

#### Scenario: Failed acquisition compensation
- **WHEN** binary acquisition or nonempty-sessionFile handshake fails
- **THEN** prompt returns502, no business frames are persisted/published, the child/token is retired and REST restores prior pair/title/status/history while independent generation metadata may advance

#### Scenario: Idle and crash re-spawn
- **WHEN** a runtime is retired by idle or by a mid-turn crash and another prompt arrives
- **THEN** the next generation uses the persisted resume path, epoch increases once, the old token is invalid and its late callbacks cannot revoke the new token

#### Scenario: Retiring instance cannot revoke replacement
- **WHEN** a transport-failed runtime's native exit is delayed and a new prompt is admitted for that session
- **THEN** replacement acquisition waits for prior retirement/pump settlement, no replacement token is issued while the old instance can revoke, and later stale callbacks cannot invalidate the replacement; other sessions remain usable

#### Scenario: Generation adapter failure provenance
- **WHEN** epoch persistence or shared-registry issuance throws during runtime acquisition
- **THEN** the original generic failure is retained despite runtime sanitization, REST does not report502, its unprogressed admission is compensated, and no token/child remains leaked

#### Scenario: Dispatch metadata storage fault
- **WHEN** the prompt write succeeds but persisting validated sessionFile fails before any business frame is consumed
- **THEN** the runtime is retired, REST receives a generic failure and compensates its unprogressed admission; no background work continues against removed rows

#### Scenario: Regenerate on a reclaimed session
- **WHEN** a done session's process has been retired by idle or eviction and the owner posts regenerate
- **THEN** the process is re-acquired through the prompt path with `--resume`, `streamCursor.epoch` is the previous value plus one, and an SSE subscriber of the new generation receives turn.start followed by turn.end for the new assistant message

#### Scenario: Fork temporary runtime is not a generation
- **WHEN** the owner forks a session with a live idle process and the fork succeeds
- **THEN** the source's live idle process was retired before the temporary process started, neither the source nor the new session's `stream_epoch` changed, no event was published to any ring and the temporary process has exited before the response

#### Scenario: Control claim excludes concurrent turn operations
- **WHEN** a regenerate or fork holds the control claim (the fake held between `get_branch_messages` and `branch`, and between `branch` and `get_state`) and a prompt, regenerate or fork arrives for the same session
- **THEN** each concurrent request returns409 session_busy with no row, file or process change; after the claimed operation finishes the claim is released and a later prompt is admitted

### Requirement: Supervisor ordered persistence and publication
The supervisor SHALL initialize the canonical pure mapper with the exact admitted assistant id and dispatch requestId. It SHALL consume the full runtime iterator, preserving arrival order including frames before ACK. toolCallId SHALL map to numeric startStep results using zero-based per-turn ordinals; public events SHALL carry numeric stepId only. Steps SHALL be persisted before publication; text SHALL enter the existing store buffer unchanged. A terminal transaction SHALL complete before turn.end publication.
Post-dispatch transport/native failure SHALL flush residual content and settle running steps/message/session failed, emit error before one failed turn.end, then discard/retire the runtime. Stop is the one exception: when a stopped turn's `agent_end` does not arrive within the bounded grace and the supervisor retires the runtime (turn-control), the supervisor SHALL settle the turn `stopped` and synthesize exactly one `turn.end{status:"stopped"}` through applyStop without any error event; late frames or the native exit of that retired runtime SHALL NOT produce error or a failed turn.end. Whenever a turn ends without the child answering its pending approvals (failure, stop retire), the terminal transaction SHALL settle them `deny` (Requirement「会话持久化与回合刷盘」) and the supervisor SHALL publish each `approval.resolved` after that commit and before turn.end, writing no frame to the dead or retiring child. Queued deltas SHALL be drained before failure settlement. Mapper terminal fencing SHALL prevent duplicate/late settlement; upstream stopReason:error SHALL become failed without requiring child death. Runtime-validated clean local-only completion without mapper terminal SHALL finish done and publish one done turn.end without waiting for agent_end.
All background tasks SHALL contain infrastructure/store/observer/cleanup failures and report them through the owned error sink, including synchronous persistence failures and store background flush notifications. Successfully settled modeled crash/upstream/protocol failures SHALL use only public error+turn.end and SHALL NOT also poison infrastructure error retention or shutdown. Persistence failure SHALL NOT publish a terminal commit that did not occur, silently lose pending content or cause automatic retry loops. Runtime retirement and error-sink exceptions SHALL not produce unhandled detached rejections. Shutdown SHALL await all tasks/native children even if one fails, and surface collected infrastructure errors without claiming successful cleanup.

#### Scenario: Normal actual-child turn
- **WHEN** real fake-omp produces at least three text deltas, one bash tool start/end and terminal success
- **THEN** messages returns the exact concatenated assistant body, exactly one numeric-ID done bash step and done session, while observer events preserve order and terminal observers can read the committed terminal state

#### Scenario: Crash with unflushed residual
- **WHEN** real fake-omp emits two sub-threshold deltas and exits before the timer flush
- **THEN** both deltas survive in failed assistant content, running steps are settled, error precedes one failed turn.end, runtime is discarded, and a subsequent prompt resumes at epoch+1; successful modeled-failure settlement alone does not notify onError or fail shutdown

#### Scenario: Local-only and exact-id error
- **WHEN** runtime confirms a local-only prompt with no agent_end, or reports a matching prompt failure after accepted dispatch
- **THEN** local-only completes once as done, matching failure completes once as failed with error first, and unrelated response ids cannot fail the turn

#### Scenario: Flush or terminal database failure
- **WHEN** a real SQLite fault prevents a background/threshold/step/terminal write after dispatch
- **THEN** the task is contained, the runtime is retired, owner receives the error, no uncommitted turn.end is published, pending data remains recoverable through the existing explicit store repair/finish/close path, and no automatic retry loop or unhandled rejection occurs

#### Scenario: Stop bounded-retire exception
- **WHEN** real fake-omp (`approval-chain-abort-ignored`) holds a turn whose first approval `r1` is pending and the owner posts stop — stop denies `r1`, the fake then raises a second approval `r2` and ignores the `abort` — and an approval of the turn (`r2`) is still pending when the injected clock passes the grace
- **THEN** the runtime is retired; `r1` reads `deny` from stop's settlement and `r2` reads `deny` with `decided_at` and its audit row committed in the terminal transaction, with no frame written to the retiring child for `r2`; each approval's `approval.resolved{decision:"deny"}` precedes exactly one `turn.end{status:"stopped"}`, no error event is published, session/assistant/running steps read `stopped`, and the retired child's exit adds no further event; no order between `r2`'s arrival and the `abort` frame is asserted

### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens and runtime options, pass the store the `core/audit` emit bound to that same DB (the workspace-store precedent) for approval-settlement audit rows, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps (settling their pending approvals as reconcileOnStartup defines) before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly.

#### Scenario: Reconcile before route acceptance
- **WHEN** the module is registered on a real app with stale running rows
- **THEN** all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged except the approval settlement defined by reconcileOnStartup (each pending approval of a failed message reads `deny` with `decided_at` and one `session.approval` audit row), and a new prompt can be accepted

#### Scenario: Shutdown ordering and isolation
- **WHEN** app.close runs with active sessions or a task/storage failure
- **THEN** new supervisor prompts are rejected, all children/tokens and pumps settle before store close, every approval still pending on a turn finalized by shutdown reads `deny` with one audit row, failures are propagated honestly and the caller DB remains usable

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
