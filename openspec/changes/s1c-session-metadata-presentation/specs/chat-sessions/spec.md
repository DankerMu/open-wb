# Spec delta: chat-sessions（S1c B 修改）

> 基线为 change A（`s1c-turn-control-governance`）对本能力的 delta：下列 Requirement 以 A 的重述文本为起点**整段重述**（含 A 与 promoted 的全部 Scenario，标题逐字保留），只增补 B 的会话元数据契约；B 在 A 归档之后实施，归档时以本文整段替换同名 Requirement。未在此重述的 Requirement（含 A 新增的「迁移 034 回合控制 schema」）不变。

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

### Requirement: 会话持久化与回合刷盘
createSessionStore(db,{onFlushError}) SHALL additionally receive the `core/audit` emit bound to the same DB (workspace-store precedent) and SHALL provide SessionStore owner-scopedcreation/list/message-tree reads and the explicitmutation/lifecycle contract inthischange. IDs SHALL be random128-bit lowercasehex; creation SHALL persistidle/nulltitle/epoch0. Creation SHALL additionally persist the caller-validated nullable `workspace_id` and `scene` (session-metadata「会话创建与空间绑定」) and a NULL `pinned_at`; admission, turn settlement and reconciliation SHALL NOT change `workspace_id`, `scene` or `pinned_at`. Foreign/missingmessage-tree reads SHALL returnnull andownerlists SHALL excludeotherowners. Views SHALL expose only declaredsession/message/step fields, orderedupdatedAtDESC/idASC forsessionlist, createdAtASC/idASC formessages andordinalASC/idASC forsteps. getMessages SHALL return complete current content by joining the persisted body with only the matching owned active assistant pending tail. This read SHALL NOT force persistence, change timers/budgets/progress or mutate pending state; fault-retained pending data remains visible without claiming durability.
acceptPrompt(sessionId,ownerId,text) SHALL atomically checkownership/busy, insertuserdone+emptyassistantrunning andupdatesessionrunning/title-ifNULL/updatedAt. Foreign/missing SHALL throwcoreHttpError not_found beforebusy disclosure; running SHALL throwsession_busy withoutwrites; idle, done, failed and **stopped** sessions SHALL all be eligible. Text SHALL bepreserved; title SHALL usefirst18Unicodecodepoints withoutellipsis. acceptPrompt SHALL NOT bumpstream_epoch. bumpStreamEpoch SHALL incrementonce independently; setSessionFile SHALL persistresume metadata. runtimeState is a trusted-supervisor-only accessor, not anowner-authorization endpoint.
rollbackPrompt SHALL atomically remove onlyanunprogressed acceptedpair andrestoreprevioussessionstatus/title/updatedAt (including a previous `stopped` status), not independentlychangedepoch/sessionFile. The title SHALL be restored only when that admission itself set it (the previous title was NULL) and no metadata PATCH title write (session-metadata「会话元数据修改」) committed between the admission and the rollback; otherwise rollbackPrompt SHALL keep the current title. rollbackPrompt SHALL NOT change `workspace_id`, `scene` or `pinned_at`. It SHALL rejectrollbackaftertext/step progress andreturnfalse wheninactive. Transactions SHALL NOT consumeorrollback caller-ownedtransactions; DBerrors SHALL propagatewithoutpartialwrites/memorycommit.
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

#### Scenario: Rename survives prompt compensation
- **WHEN** a NULL-title session admits a prompt (title becomes its 18-code-point prefix), the owner then PATCHes `title` to `季度汇报`, and the unprogressed admission is rolled back
- **THEN** the accepted pair is removed and prior status/updatedAt return, while the title reads `季度汇报`
- **WHEN** a NULL-title session admits a prompt and it is rolled back with no PATCH in between, or a session already titled `季度汇报` admits and rolls back
- **THEN** the title reads NULL respectively `季度汇报`; `scene` and `pinned_at` are unchanged in every case

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
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop, POST /api/sessions/:id/regenerate, POST /api/sessions/:id/fork, POST /api/sessions/:id/approvals/:approvalId, PATCH /api/sessions/:id and DELETE /api/sessions/:id (ten routes). All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL accept an optional body `{workspaceId?,scene?}` whose validation, binding and audit rules are session-metadata「会话创建与空间绑定」, and SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt,scene,workspaceId,pinnedAt:null} with `scene`/`workspaceId` equal to the accepted values or null when absent (a bodyless request yields both null). PATCH /api/sessions/:id and DELETE /api/sessions/:id follow session-metadata「会话元数据修改」 and「会话删除」. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,thinking,status,createdAt,approvals,steps:[{id,ordinal,name,detail,output,changes,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. `thinking` SHALL be present on every message as `string | null` (a stored NULL, including every user message, reads null; content rules belong to thinking-fold). `changes` SHALL be present on every step as `Change[] | null`, a stored NULL reading null and a stored value reading the array of `{path,added,removed,kind}` whose element rules belong to turn-artifacts. `approvals` SHALL be present on every message as an array of all `chat_approvals` rows of that message in ascending id order, each `{id,tool,title,requestedAt,expiresAt,decision}` with `decision` ∈ `allow|deny|timeout|null`; it SHALL be `[]` for a user message and for an assistant message without approval rows. Several pending (`decision:null`) entries MAY coexist on one message (parallel tool calls); a later approval request never replaces an earlier entry. Session, message and step `status` unions SHALL include `stopped`. Session views (list entries, create/PATCH responses, the snapshot `session`, the fork response `session`) SHALL contain exactly the eight keys id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt, where `scene` ∈ `office|code|design|null`, `workspaceId` is the bound workspace id or null and `pinnedAt` is epoch milliseconds or null (`parent_session_id` and `omp_session_file` SHALL NOT be exposed); Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/stop and POST /api/sessions/:id/regenerate SHALL be bodyless content-parser owners (the logout precedent): any parsed body (including `{}`), empty-or-malformed JSON, unsupported media or an envelope above their minimal body limit SHALL return400 bad_request after authorization and before any supervisor call, frame or write. When the session is `running`, stop SHALL call supervisor.stop(sessionId) — which holds the session's control claim for the call, first settles every pending approval of that turn, if any exist (the pending set is the snapshot read on entry; it is not re-read before the `abort` frame), as `deny` (per approval: persist decision/decided_at and its `session.approval` audit row in one transaction → answer `Deny` → publish `approval.resolved`) and then writes the `abort` frame; when the turn's prompt frame is not yet written, stop instead records a stop intent and the supervisor writes `abort` right after that prompt's dispatch receipt resolves (after the stop call has returned), so stop neither cancels the dispatch nor compensates the accepted rows and the prompt request still returns its normal202 body (a failed acquisition or dispatch still follows the ordinary prompt compensation, and the intent never rewrites a terminal status another path reached first) — and return202 with body exactly `{}` without waiting for the turn to end; for any other status it SHALL return204 with no writes and no supervisor call. The stopped turn ends with `turn.end{status:"stopped"}` and session/assistant/running steps read `stopped`.
POST /api/sessions/:id/regenerate: a `running` session, or a session whose control claim is held by another regenerate, fork or stop, SHALL return409 session_busy. A session whose history does not end with an assistant message immediately preceded by a user message SHALL return400 bad_request. Otherwise it SHALL call supervisor.regenerate(sessionId), which registers the session's control claim with the last assistant message id read by the precheck and releases it once dispatch completes or the response returns: acquire the session's process — reusing a live one, or through the same lazy acquisition as prompt (a normal new generation, stream_epoch+1 with a fresh ring) when it has been reclaimed — through the process cap (`agent_capacity` → 503), `get_branch_messages`, pick the entry whose position is last and whose `text` equals the stored last user message content (any mismatch → 502 agent_unavailable with no row change), `branch{entryId}`, `get_state`, then in one SQLite transaction — which SHALL first recheck that the session status is not `running` and its last assistant message id still equals the precheck's, otherwise write nothing, retire the process and return409 session_busy — delete the old assistant row (steps and approvals cascade), insert a new empty `running` assistant row, set `omp_session_file` to the new file and session status `running`, and dispatch the branch-returned text as the prompt; it SHALL return202 {assistantMessageId} of the new row. Runtime failure before the transaction SHALL leave every row unchanged and map to502 agent_unavailable; dispatch failure after the transaction SHALL settle the new assistant row and session as `failed`, return502 agent_unavailable (rows are already terminal, nothing is compensated) and SHALL NOT resurrect the deleted row.
POST /api/sessions/:id/fork SHALL accept only application/json and an object with exactly messageId:number; any other shape, a messageId that is not a `user` message of this session, or wrong media/malformed JSON SHALL return400 bad_request. A `running` source session, or one whose control claim is held by another regenerate, fork or stop, SHALL return409 session_busy. Otherwise the supervisor SHALL register the source session's control claim (with the last assistant message id read by the precheck), create the new session row first (same owner, copied title, copied `workspace_id` and `scene`, `pinned_at` NULL, `parent_session_id` = source id, status idle, `omp_session_file` NULL), retire the source session's live idle process if one exists (its history is in the file, so this is lossless), then run a temporary runtime through the process cap (`agent_capacity` → 503) with `--resume <source omp_session_file>`, `get_branch_messages`, pick the entry whose ordinal position among user messages equals the stored message's and whose `text` equals its content (mismatch → 502 agent_unavailable and the new session row removed), `branch{entryId}`, `get_state`, shut the temporary process down, then in one transaction — which SHALL first recheck that the source status is not `running` and its last assistant message id still equals the precheck's, otherwise write nothing but remove the new session row and return409 session_busy — set the new session's `omp_session_file` to the new file. The temporary runtime is not a session generation: it SHALL NOT bump either session's `stream_epoch`, owns no ring, publishes no events, is bound to no slot and counts only against the process cap. The transaction SHALL also copy every chat_messages/chat_steps row of the source that precedes the fork-point user message (new ids, same order, content, thinking, status, timestamps and step detail/output/changes), copy every `chat_approvals` row of those copied messages onto the new message ids (new approval ids; request_id, tool, title, requested_at, expires_at, decision and decided_at preserved), and set the new session's status to the status of the last copied assistant message (`done`, `failed` or `stopped`), leaving it `idle` only when nothing is copied. The source session's rows, status and file SHALL be unchanged; its live process, if any, receives no frame and is retired before the temporary process starts. The temporary runtime SHALL be spawned with the source session's cwd (its bound workspace root, or the owner root when unbound; Requirement「Supervisor dispatch and generation binding」). It SHALL return201 {session,draft} where `session` is the new session's eight-key public view and `draft` is the branch-returned user text.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: in one transaction persist decision/decided_at and its `session.approval` audit row → answer the child (`Approve` for allow, `Deny` for deny) and cancel its timeout timer → publish `approval.resolved` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}` (one element of the snapshot's `approvals` array).

#### Scenario: Create list and empty history
- **WHEN** an authenticated account creates a session and reads its list and history
- **THEN** create returns201 idle/null-title with `scene`, `workspaceId` and `pinnedAt` null, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- **WHEN** a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls stop/regenerate/fork/approvals/PATCH/DELETE on it, including an invalid PATCH body
- **THEN** its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- **WHEN** no valid cookie is supplied, including malformed/oversized bodies, on any of the ten routes
- **THEN** 401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- **WHEN** an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- **THEN** list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields, every message carrying an `approvals` array (`[]` when it has no approval rows) and a `thinking` value, every step carrying a `changes` value (`null` when none was recorded), and every session view exactly the eight declared keys

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
- **THEN** 201 {session,draft} returns a new session with status `done` (the last copied assistant's status), the copied title and the eight public fields only, `draft` equals that user message's text, the new session's messages contain copies of the first user/assistant pair (with steps and the `allow` approval) and nothing else, the new row has `parent_session_id` = source id, and the source session's rows/status/`omp_session_file` are unchanged; the source's live process exited before the temporary process started and the temporary process has exited
- **WHEN** the owner forks at the session's first user message
- **THEN** 201 returns a new `idle` session with empty messages and `draft` equal to that message's text
- **WHEN** messageId names an assistant message, a message of another session, or the body is malformed; or the source is running; or the branch entry does not align
- **THEN** 400, 409 session_busy or 502 respectively; on 502 the pre-created session row is removed and no messages were copied

#### Scenario: Fork inherits workspace and scene but not pin
- **WHEN** the owner forks a source session bound to workspace W with scene `code` and `pinnedAt` set, backed by the real fake (`branch`)
- **THEN** the new session view reads `workspaceId` W, `scene` `code` and `pinnedAt` null; the source keeps its pin; a later prompt on the new session runs a child whose probe reports `cwd=` equal to W's root

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner reads the snapshot, then posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the snapshot's running assistant message carries `approvals:[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]` while user messages carry `approvals:[]`; the first answer returns200 with `decision:"allow"` after the row and its audit row are committed together, and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** no answer arrives within 60s of the injected clock
- **THEN** the row reads `timeout`, the child receives `Approve`, `approval.resolved{decision:"timeout"}` is published and the snapshot shows `decision:"timeout"`
- **WHEN** the real fake (`approval-parallel`) raises two approvals in one turn and the owner answers only the second
- **THEN** the snapshot lists both in ascending id order, the second reads `allow` while the first stays `decision:null`, and answering the first later settles it independently

### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner, resume metadata and workspace binding. runtimeState SHALL report the session's `workspaceId` (the `workspace_id` column) and the supervisor SHALL resolve the cwd from it: when `workspace_id` is non-NULL, the root returned by the workspace store's owner-scoped `rootOf` called with the session's `owner_id` as principal id; otherwise the owner root `<SANDBOX_ROOT>/<ownerId>` used before this change. Every spawn of a session generation and every fork temporary runtime SHALL pass that cwd as omp `--cwd`; a non-NULL `workspace_id` for which `rootOf` returns null SHALL fail the acquisition as a generic failure (compensated like other acquisition failures) and SHALL NOT fall back to the owner root; when `rootOf` returns a root that does not exist as a directory at acquisition time, the supervisor SHALL NOT create it (no mkdir of a workspace root) and SHALL NOT spawn or fall back, and the acquisition SHALL fail as agent_unavailable (REST 502 with the ordinary prompt compensation). The binding is immutable, so a resumed generation's cwd equals the one recorded when the session file was created. On the prompt path it SHALL neither admit nor compensate a pair itself. Regenerate and fork (Requirement「会话 REST」) are supervisor-owned admission and compensation paths: the supervisor SHALL perform their single final SQLite transaction (including the control-claim recheck) and their failure compensation (retiring the process, removing a pre-created fork session row, or settling a dispatched regenerate assistant row `failed`). The supervisor SHALL hold a per-session control claim for regenerate, fork, stop and delete (session-metadata「会话删除」) from a passed precheck until dispatch completes or the response is returned; while it is held, prompt, regenerate, fork and delete on that session SHALL be rejected with session_busy (a stop after regenerate has dispatched proceeds normally because the session is then `running`), and the claimed session's process counts as in-turn for the process cap. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error.
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

#### Scenario: Spawn cwd follows the workspace binding
- **WHEN** the owner prompts a session bound to workspace W and, separately, an unbound session, each backed by the real fake whose probe reports `cwd=`
- **THEN** the bound session's child reports W's root (below `<SANDBOX_ROOT>/<ownerId>/`) and the unbound one reports `<SANDBOX_ROOT>/<ownerId>`; after an idle retire the next prompt's resumed child reports the same cwd as before
- **WHEN** a test makes `rootOf` return null for a bound session before its first prompt
- **THEN** the prompt fails with a generic5xx, its admission is compensated and no child was spawned with the owner root
- **WHEN** a bound session's workspace root directory has been removed outside the application before its next prompt
- **THEN** the prompt returns502 agent_unavailable, its admission is compensated, no child is spawned and the workspace root still does not exist

#### Scenario: Control claim excludes concurrent turn operations
- **WHEN** a regenerate or fork holds the control claim (the fake held between `get_branch_messages` and `branch`, and between `branch` and `get_state`) and a prompt, regenerate or fork arrives for the same session
- **THEN** each concurrent request returns409 session_busy with no row, file or process change; after the claimed operation finishes the claim is released and a later prompt is admitted

### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens, runtime options and the workspace store's owner-scoped `rootOf` (the same workspace store createApp builds; sessions SHALL NOT construct a second workspace store or compute workspace roots itself), pass the store the `core/audit` emit bound to that same DB (the workspace-store precedent) for approval-settlement audit rows, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps (settling their pending approvals as reconcileOnStartup defines) before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly. The supervisor SHALL expose a public `retire(sessionId)` used by session deletion: it SHALL run the existing bounded retire sequence of that session's live generation (stdin close and signal escalation, token revocation, process-cap release, generation sealing), await native exit, drop the session's slot and event ring, and end every SSE subscriber of that session without publishing a further event; for a session without a live generation it SHALL only drop ring/subscriber state and resolve. retire SHALL NOT write any SQLite row.

#### Scenario: Reconcile before route acceptance
- **WHEN** the module is registered on a real app with stale running rows
- **THEN** all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged except the approval settlement defined by reconcileOnStartup (each pending approval of a failed message reads `deny` with `decided_at` and one `session.approval` audit row), and a new prompt can be accepted

#### Scenario: Shutdown ordering and isolation
- **WHEN** app.close runs with active sessions or a task/storage failure
- **THEN** new supervisor prompts are rejected, all children/tokens and pumps settle before store close, every approval still pending on a turn finalized by shutdown reads `deny` with one audit row, failures are propagated honestly and the caller DB remains usable

#### Scenario: Public retire for deletion
- **WHEN** retire(sessionId) is called for an idle session with a live real-fake child and two open SSE subscribers, and separately for a session with no live generation
- **THEN** the child exits, its token no longer authenticates at the model proxy, the process cap is released, both subscriber responses end without another event, no SQLite row changes, and a later prompt on that still-existing session acquires a new generation with `stream_epoch` plus one; the second call resolves without spawning, writing or bumping the epoch
