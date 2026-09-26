# chat-sessions Specification

## Purpose
定义会话、消息与执行步骤的 schema 和追加迁移，以及账号隔离的存储视图、原子受理与补偿、正文刷盘、步骤和终态、故障恢复、关闭及显式启动对账契约。REST/runtime/SSE装配由后续变更增补。
## Requirements
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
createSessionStore(db,{onFlushError}) SHALL provide SessionStore owner-scopedcreation/list/message-tree reads and the explicitmutation/lifecycle contract inthischange. IDs SHALL be random128-bit lowercasehex; creation SHALL persistidle/nulltitle/epoch0. Foreign/missingmessage-tree reads SHALL returnnull andownerlists SHALL excludeotherowners. Views SHALL expose only declaredsession/message/step fields, orderedupdatedAtDESC/idASC forsessionlist, createdAtASC/idASC formessages andordinalASC/idASC forsteps. getMessages SHALL return complete current content by joining the persisted body with only the matching owned active assistant pending tail. This read SHALL NOT force persistence, change timers/budgets/progress or mutate pending state; fault-retained pending data remains visible without claiming durability.
acceptPrompt(sessionId,ownerId,text) SHALL atomically checkownership/busy, insertuserdone+emptyassistantrunning andupdatesessionrunning/title-ifNULL/updatedAt. Foreign/missing SHALL throwcoreHttpError not_found beforebusy disclosure; running SHALL throwsession_busy withoutwrites; idle, done, failed and **stopped** sessions SHALL all be eligible. Text SHALL bepreserved; title SHALL usefirst18Unicodecodepoints withoutellipsis. acceptPrompt SHALL NOT bumpstream_epoch. bumpStreamEpoch SHALL incrementonce independently; setSessionFile SHALL persistresume metadata. runtimeState is a trusted-supervisor-only accessor, not anowner-authorization endpoint.
rollbackPrompt SHALL atomically remove onlyanunprogressed acceptedpair andrestoreprevioussessionstatus/title/updatedAt (including a previous `stopped` status), not independentlychangedepoch/sessionFile. It SHALL rejectrollbackaftertext/step progress andreturnfalse wheninactive. Transactions SHALL NOT consumeorrollback caller-ownedtransactions; DBerrors SHALL propagatewithoutpartialwrites/memorycommit.
appendDelta SHALL buffer in order byactiveassistantidentity, flushat2048cumulativeUTF8bytes or2000ms sincefirstpendingdelta (whicheverfirst), andresetdeadline/bytebudget onlyafter successfulflush. Quietpendingdata SHALL flushwithoutanotherdelta. Steps SHALL persistimmediately; finishStep SHALL settleonlyrunningsteps. finishTurn(assistantMessageId,status) SHALL accept status `done`, `failed` or `stopped` and SHALL atomically flushresidual andsettleassistant/session to that status plusremainingrunningsteps, preservingalreadyterminalsteps; a `stopped` turn SHALL settle its remaining running steps to `stopped` with NULL output (read back as an empty string) and an ended_at. Stalecalls SHALL NOT modifyterminal/newturn rows; inactive append/finish methods returnfalse.
Timerflushfailure SHALL retainpendingdata, notifyrequiredonFlushError once andstopautomaticretry. FurtherappendDelta onthefaulted-but-activebuffer SHALL throwtheretainedflushfault withoutgrowingthebuffer (false remainsinactive/stale only). Explicitfinish/close mayretryafterexternalrepair; successfulwrites SHALL notduplicatecontent. close SHALL cancelownedtimers, finalizeactiveownedturns asfailed withresidualdata, remainidempotent aftersuccess andleaveDBownership tocaller; failures SHALL notpretendcleanup/persistence succeeded.
reconcileOnStartup SHALL explicitly andatomically setallrunning session/message/step statuses tofailed whilepreserving allotherfields/rows. It SHALL runbeforelivework andreject invocation withownedactive turnstate. No constructor-side reconcile or REST/omp/SSE assembly isadded.

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
- **WHEN** anunstartedstore seesrunningrows mixedwithidle/done/failedrows acrossowners
- **THEN** oneexplicitreconcile changesonlyrunningstatuses tofailed inallthreetables andleavesallotherdataunchanged
- **WHEN** a reconciliationwritefails
- **THEN** noneofthestatuschangescommit

### Requirement: 会话文本无损读取与标题复用
SessionStore SHALL preserve complete text values, including embedded U+0000, leading U+FEFF, non-ASCII and astral characters, across list/getMessages titles, user and assistant content, step name/detail/output, and trusted runtimeState ompSessionFile. Public outputs SHALL remain strings or the existing nullable values. Empty string and SQL NULL SHALL remain distinct, except that a NULL step output (pre-033 rows and unfinished steps) is read as an empty string in step views. Appended content and finish/close flushes SHALL retain the complete concatenated value.
Admission SHALL reuse an existing title without truncating its suffix, retain the complete previousTitle for rollbackPrompt, and keep the persisted title storage class TEXT. The first-title Unicode-prefix rule SHALL remain unchanged. The fix SHALL NOT claim recovery of suffixes already overwritten by older admissions.
Lossless reading SHALL respect the actual database text encoding. Existing UTF-8, UTF-16le and UTF-16be databases SHALL remain readable without changing encoding, schema, unrelated data or migration receipts. Per-connection encoding selection SHALL NOT leak between databases. Leading U+FEFF SHALL be preserved; no new fatal invalid-byte policy, character stripping or input rejection SHALL be introduced. Failed encoding/SQL reads SHALL propagate rather than silently selecting a guessed encoding.
Owner isolation, order, status transitions, epoch/resume independence, transaction boundaries and compensation/flush errors SHALL remain as already specified. The shared text-read implementation SHALL have one canonical owner in core/db and no per-consumer alternate decoding implementation.

#### Scenario: All free-text read surfaces
- WHEN a real store accepts text containing U+0000, persists assistant deltas and steps, and records trusted resume metadata containing that character
- THEN getMessages/list/runtimeState return complete values for content/title/name/detail/output/resume, including text after the NUL, without leaking internal fields into public views

#### Scenario: Title reuse and compensation retain physical bytes
- WHEN a completed session title is a + U+0000 + b, a second prompt is admitted and then rolled back before progress
- THEN title reads remain exact, its physical hex remains610062 in UTF-8 before/after admission and rollback, and typeof(title) remains text

#### Scenario: Null empty and BOM compatibility
- WHEN idle/null metadata and stored empty strings, leading U+FEFF and mixed Unicode values are read
- THEN null remains null, empty remains empty and every valid text code point is preserved without BOM stripping or normalization

#### Scenario: Database encoding and reopen
- WHEN UTF-8/UTF-16le/UTF-16be file databases with prior unrelated data are opened, used and reopened, including interleaved reads across connections
- THEN ordinary and NUL-containing values round-trip, encoding/unrelated data/receipts remain unchanged, and no connection uses another database's encoding
- WHEN a caller closes a DatabaseSync handle and later reopens that same JavaScript object against a valid replacement database using a different supported encoding
- THEN subsequent text reads use the current native connection encoding rather than a stale object-identity cache

#### Scenario: Frozen REST consumer replay
- WHEN the paused #99 REST consumer is composed only in a disposable compiled harness with the corrected store and receives a valid 32768-NUL prompt
- THEN202 identifies the admitted pair, the supervisor receives the original text and subsequent store/history reads preserve it; this SHALL NOT register or ship REST in the #198 production change

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

### Requirement: REST prompt 受理与补偿
The prompt route SHALL accept only application/json and an object with exactly message:string. It SHALL trim the string once and require nonempty text of at most32768 UTF-8 bytes. Invalid shape, media, malformed JSON or oversized parser envelope SHALL return400 bad_request; decoded valid escape-heavy text SHALL NOT be rejected merely because its wire JSON exceeds32768 bytes. The existing bounded parser envelope remains distinct from the semantic message limit.
The route SHALL use store.acceptPrompt(sessionId,principal.id,text) for the atomic admission and then await supervisor.prompt(sessionId,text). The owned SessionSupervisorPort SHALL expose prompt(sessionId:string,text:string):Promise<void>; resolution means dispatch accepted, not turn finished. Successful admission SHALL return202 {userMessageId,assistantMessageId} from that exact store admission. Running sessions SHALL return409 session_busy without added rows or dispatch; idle/done/failed SHALL be eligible.
Supervisor rejection SHALL compensate the unprogressed accepted pair through store.rollbackPrompt before returning the canonical error. HttpError agent_unavailable SHALL produce502, HttpError session_busy SHALL produce409; unknown failures SHALL remain generic5xx. Compensation failure SHALL propagate as generic5xx, not be masked as502/409. The supervisor SHALL NOT reject after publishing/persisting progress; post-dispatch failures belong to supervisor lifecycle. No retries or real runtime/SSE implementation are part of this boundary.

#### Scenario: Accepted prompt and concurrent busy
- WHEN a valid prompt is admitted while the stub supervisor is held pending
- THEN the real store has one user-done and one empty assistant-running message, with trimmed text and title; a concurrent second prompt returns409 without changing rows
- WHEN the pending supervisor resolves
- THEN the first request returns202 with precisely those two IDs, without waiting for terminal turn completion

#### Scenario: Input boundaries
- WHEN message is empty after trim, has a wrong type, is in an array/null/extra-key object, or exceeds32768 decoded UTF-8 bytes, or the request has wrong media/malformed JSON/oversized envelope
- THEN400 bad_request/no-store occurs without admission or dispatch
- WHEN trimmed text is exactly32768 UTF-8 bytes, including multibyte and JSON-escaped content
- THEN202 is possible and the same trimmed text reaches storage and supervisor

#### Scenario: Failed dispatch restores prior state
- WHEN the stub supervisor rejects with canonical agent_unavailable or session_busy after a new admission from idle/done/failed
- THEN502 or409 respectively is returned, prior title/status/updatedAt/history is preserved and the admitted pair removed; a later prompt can succeed
- WHEN admission itself rejects
- THEN the supervisor is not called and another active turn is not rolled back

#### Scenario: Unknown and compensation failures
- WHEN the supervisor throws an untyped error, including a forged status/code shape
- THEN its unprogressed admission is compensated and the response is generic5xx without leaking raw error data
- WHEN rollback itself fails
- THEN generic5xx is returned without falsely reporting restored state or masking the storage failure as agent_unavailable

#### Scenario: Terminal sessions can prompt again
- WHEN the real store completes an accepted turn as done or failed, and the owner sends another valid prompt
- THEN the next prompt returns202 with new IDs, retaining previous history and the established title

### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner and resume metadata. It SHALL neither admit nor compensate a pair itself. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error.
The supervisor SHALL await the exact runtime dispatch receipt and persist the validated sessionFile before resolving the REST port, without consuming business frames first. Pre-progress failure SHALL retire/discard that runtime before rejecting so REST can compensate. No post-progress error SHALL reject the already-accepted REST operation.
Every runtime generation acquisition, including idle re-spawn and crash recovery, SHALL increment stream_epoch exactly once via the existing store method before shared-token issuance; reuse of a live generation SHALL not increment it. Failed acquisition may advance epoch independently of REST compensation. Runtime SHALL retain token-revocation ownership; native exit SHALL make that generation token invalid, without stale callbacks revoking a newer token. No requestId SHALL be guessed from an ACK.
#### Scenario: Cold start and reuse
- WHEN an owner prompts a new session and later prompts the same healthy runtime again
- THEN both requests return202 after dispatch, sessionFile is stored, one generation/epoch/token is used and no duplicate native child is spawned
#### Scenario: Failed acquisition compensation
- WHEN binary acquisition or nonempty-sessionFile handshake fails
- THEN prompt returns502, no business frames are persisted/published, the child/token is retired and REST restores prior pair/title/status/history while independent generation metadata may advance
#### Scenario: Idle and crash re-spawn
- WHEN a runtime is retired by idle or by a mid-turn crash and another prompt arrives
- THEN the next generation uses the persisted resume path, epoch increases once, the old token is invalid and its late callbacks cannot revoke the new token
#### Scenario: Retiring instance cannot revoke replacement
- WHEN a transport-failed runtime's native exit is delayed and a new prompt is admitted for that session
- THEN replacement acquisition waits for prior retirement/pump settlement, no replacement token is issued while the old instance can revoke, and later stale callbacks cannot invalidate the replacement; other sessions remain usable
#### Scenario: Generation adapter failure provenance
- WHEN epoch persistence or shared-registry issuance throws during runtime acquisition
- THEN the original generic failure is retained despite runtime sanitization, REST does not report502, its unprogressed admission is compensated, and no token/child remains leaked
#### Scenario: Dispatch metadata storage fault
- WHEN the prompt write succeeds but persisting validated sessionFile fails before any business frame is consumed
- THEN the runtime is retired, REST receives a generic failure and compensates its unprogressed admission; no background work continues against removed rows

### Requirement: Supervisor ordered persistence and publication
The supervisor SHALL initialize the canonical pure mapper with the exact admitted assistant id and dispatch requestId. It SHALL consume the full runtime iterator, preserving arrival order including frames before ACK. toolCallId SHALL map to numeric startStep results using zero-based per-turn ordinals; public events SHALL carry numeric stepId only. Steps SHALL be persisted before publication; text SHALL enter the existing store buffer unchanged. A terminal transaction SHALL complete before turn.end publication.
Post-dispatch transport/native failure SHALL flush residual content and settle running steps/message/session failed, emit error before one failed turn.end, then discard/retire the runtime. Queued deltas SHALL be drained before failure settlement. Mapper terminal fencing SHALL prevent duplicate/late settlement; upstream stopReason:error SHALL become failed without requiring child death. Runtime-validated clean local-only completion without mapper terminal SHALL finish done and publish one done turn.end without waiting for agent_end.
All background tasks SHALL contain infrastructure/store/observer/cleanup failures and report them through the owned error sink, including synchronous persistence failures and store background flush notifications. Successfully settled modeled crash/upstream/protocol failures SHALL use only public error+turn.end and SHALL NOT also poison infrastructure error retention or shutdown. Persistence failure SHALL NOT publish a terminal commit that did not occur, silently lose pending content or cause automatic retry loops. Runtime retirement and error-sink exceptions SHALL not produce unhandled detached rejections. Shutdown SHALL await all tasks/native children even if one fails, and surface collected infrastructure errors without claiming successful cleanup.
#### Scenario: Normal actual-child turn
- WHEN real fake-omp produces at least three text deltas, one bash tool start/end and terminal success
- THEN messages returns the exact concatenated assistant body, exactly one numeric-ID done bash step and done session, while observer events preserve order and terminal observers can read the committed terminal state
#### Scenario: Crash with unflushed residual
- WHEN real fake-omp emits two sub-threshold deltas and exits before the timer flush
- THEN both deltas survive in failed assistant content, running steps are settled, error precedes one failed turn.end, runtime is discarded, and a subsequent prompt resumes at epoch+1; successful modeled-failure settlement alone does not notify onError or fail shutdown
#### Scenario: Local-only and exact-id error
- WHEN runtime confirms a local-only prompt with no agent_end, or reports a matching prompt failure after accepted dispatch
- THEN local-only completes once as done, matching failure completes once as failed with error first, and unrelated response ids cannot fail the turn
#### Scenario: Flush or terminal database failure
- WHEN a real SQLite fault prevents a background/threshold/step/terminal write after dispatch
- THEN the task is contained, the runtime is retired, owner receives the error, no uncommitted turn.end is published, pending data remains recoverable through the existing explicit store repair/finish/close path, and no automatic retry loop or unhandled rejection occurs

### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens and runtime options, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly.
#### Scenario: Reconcile before route acceptance
- WHEN the module is registered on a real app with stale running rows
- THEN all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged and a new prompt can be accepted
#### Scenario: Shutdown ordering and isolation
- WHEN app.close runs with active sessions or a task/storage failure
- THEN new supervisor prompts are rejected, all children/tokens and pumps settle before store close, failures are propagated honestly and the caller DB remains usable

### Requirement: Synchronous supervisor observation sinks
SessionSupervisor onEvent and onError sinks, including sinks passed through registerSessions and createApp assembly, SHALL complete synchronously. Ordinary non-thenable return values SHALL remain ignored, preserving existing void-callback compatibility. Each sink SHALL be invoked once per notification. The options interfaces SHALL document the synchronous contract; an undefined optional onEvent SHALL retain its existing no-observer behavior.

A returned thenable, whether a native Promise or a structural thenable object/function, SHALL be an owned programming error regardless of fulfilled, rejected or pending settlement. The returned value's rejection SHALL be contained without a process-global rejection handler, without invoking the sink again and without later reporting the same violation a second time. Reading a throwing then getter or invoking a synchronous sink that throws SHALL enter the existing synchronous error ownership path. Invalid never-settling sink work SHALL NOT be awaited by publication, runtime retirement or shutdown; arbitrary asynchronous side effects created by an invalid callback are not supported app-owned work.

For an onEvent violation, the supervisor SHALL retain/report one infrastructure fault, stop further publication for that pump and retire its native runtime/token through existing ownership. For an onError violation, the supervisor SHALL retain the violation alongside the source fault without recursive onError calls. Shutdown SHALL surface retained faults while still awaiting existing native/pump cleanup and allowing registerSessions to close its store before returning control of the still-usable caller DB. Existing synchronous throw semantics, modeled public-error behavior, session isolation and runtime→listener→DB ordering SHALL remain unchanged. App/module composition SHALL not discard an external sink result before the guard sees it.

#### Scenario: Supported synchronous controls
- WHEN an event recorder or error observer returns an ordinary synchronous value such as an array-push count
- THEN event publication and successful turns continue normally, or the original source failure alone is retained; no spurious programming fault is introduced
- WHEN an existing observer/error sink throws synchronously
- THEN its original fault ownership, runtime/token retirement and shutdown report remain unchanged

#### Scenario: Unsupported event-sink return
- WHEN an event observer returns a rejected, fulfilled or never-settling Promise, or a non-native thenable
- THEN one programming fault is reported, later events from that pump are not published, its native child/token are retired, shutdown reports the owned fault, and neither detached rejection nor waiting for the invalid sink occurs

#### Scenario: Unsupported error-sink return
- WHEN a real source failure reaches onError and that sink returns a rejected native Promise or a non-native thenable
- THEN the source error and one sink-contract fault remain observable at shutdown, onError was called only once, and no detached rejection or recursive notification escapes

#### Scenario: Structural thenable and assembly fidelity
- WHEN a callable value with a callable then property, or a value whose then getter throws, is returned through the real app/module sink seam
- THEN structural thenable rejection is consumed or the getter's synchronous failure is retained through the same ownership path; wrapping or composing the sink never hides its return value

### Requirement: Complete snapshot overlap boundary
A messages snapshot SHALL contain the current owned text/steps/status and a matching streamCursor {epoch:number,seq:number|null}. Numeric seq covers all recorded data events of that epoch through that sequence, including0 before its first event. Null seals the entire epoch: no later event of that epoch can publish. Snapshot reads SHALL preserve the2048UTF8-byte/2000ms durability policy, owner isolation, current field projections, and independent returned values. Complete process-owned content SHALL NOT be represented as necessarily durable.

#### Scenario: Pending and failed-flush tails
- WHEN1000characters are pending below both flush thresholds
- THEN GET returns all1000characters while SQLite content stays empty and the timer/budget remain unchanged
- WHEN a flush fails and its owned pending tail is retained, then the external storage failure is repaired and an explicit finish succeeds
- THEN snapshots before and after persistence contain the same exact text once, including NUL/BOM/Unicode, with no forced retry or duplicate tail

#### Scenario: Snapshot overlaps queued live events
- WHEN turn.start and1000one-character deltas are followed by a1048character delta, a snapshot is captured, and another delta Z publishes before that response is delivered
- THEN snapshot body is exactly2048characters with cursor {epoch:1,seq:1002}; appending only queued successors produces exactly2049characters, not3096 or2048
- WHEN an equal-epoch queued turn.start/step/text/end event is at or below numeric snapshot seq, or any event belongs to a sealed/earlier epoch
- THEN downstream recovery discards it rather than resetting or duplicating authoritative snapshot state; higher-epoch events remain eligible in arrival order

#### Scenario: Authorized atomic capture
- WHEN publication advances during a later asynchronous request hook after preParsing captured history
- THEN the response retains the original matching cursor, not the newer head; unauthorized or foreign requests still return401/404 before any snapshot boundary exposure

### Requirement: Per-turn supervisor claim release
SessionSupervisor SHALL release each turn's claim when that turn's pump finishes, even if a newer turn on the same slot has already registered its own pump; only clearing the slot's current-pump registration SHALL depend on pump identity. Releasing an older turn SHALL NOT release or alter a newer turn's claim, and correctness SHALL NOT depend on the relative scheduling of the old pump's exit and the new turn's dispatch acknowledgement.

#### Scenario: Old pump exits after a newer pump took the slot
- **WHEN** turn A's pump exits while the slot's current pump and claimed turn are already turn B's
- **THEN** A's claim is released, B's claim and the slot's current-pump registration stay B's

#### Scenario: Sink re-admits the next turn on the same slot
- **WHEN** an event sink, on turn A's turn.end, synchronously accepts and dispatches turn B for the same session
- **THEN** B is admitted and completes, and a later prompt on the session is admitted normally

### Requirement: Trusted metadata writes on missing sessions
`bumpStreamEpoch` and `setSessionFile` are trusted-supervisor-only writes whose callers SHALL own session existence; a row disappearing under a live supervisor slot is an invariant violation, not a client-facing condition. For a missing session both SHALL throw the generic receipt Error (not a typed HttpError), write nothing, and leave caller-owned transaction semantics unchanged. They SHALL NOT contain unreachable typed-error branches.

#### Scenario: Metadata write for an absent session
- **WHEN** bumpStreamEpoch or setSessionFile is called with a session id that has no row
- **THEN** it throws a non-HttpError receipt Error and no row changes

### Requirement: 步骤输出列迁移
Migration `033_chat_step_output.sql` SHALL add a nullable `output TEXT` column (no default) to `chat_steps` with `ALTER TABLE … ADD COLUMN` inside the existing runner-owned transaction, appended as the seventh receipt after `032` without changing ledger validation. Existing rows SHALL keep every prior column value and read `output` as NULL; no backfill. `startStep` SHALL write detail and leave output NULL; `finishStep` SHALL set only status, output and ended_at (detail is never updated after start). Store reads SHALL return output losslessly under the same complete-text rule as detail, mapping NULL to an empty string in step views. The trusted-migration count assertions SHALL grow by one.

#### Scenario: Fresh and upgraded schema
- **WHEN** openDb opens a new database, and separately a database holding the six prior receipts plus chat rows with steps
- **THEN** receipts contain `032` then `033` in order (later migrations such as `034` may follow); `chat_steps` has `output` TEXT nullable without default after `ended_at`; prior steps keep id/detail/status/timestamps and read output as NULL; reopening leaves the catalog stable

#### Scenario: Step persistence keeps args
- **WHEN** a step starts with detail D and then finishes failed with output O
- **THEN** the stored row has detail D, output O, status failed and an ended_at; getMessages returns both; a step that is still running returns output `""`

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

### Requirement: 会话 store 源码模块划分
`server/src/sessions/` 下的会话 store 实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`createSessionStore` 与 `SessionStore` 类型 SHALL 保持从 `store.ts` 导出，是会话持久化的唯一公共入口；`store-branch.ts`/`store-approvals.ts` 的导出 SHALL 只供 `sessions/` 内的 store 模块使用，不经 `sessions/index.ts` 对外暴露。`store-branch.ts` SHALL 承载消息/步骤行的列集、行形状与视图映射、owned 事务与变更计数原语，以及 regenerate/fork 的事务与行拷贝；`store-approvals.ts` SHALL 承载回合终态结算（完成/失败/释放、启动对账）以及审批行读写、非作答结算与快照投影。值导入 SHALL 只沿 `store.ts → store-approvals.ts`、`store.ts → store-branch.ts`、`store-approvals.ts → store-branch.ts` 三个方向（有向无环），反方向只允许类型导入；新模块 SHALL 不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`store-approvals.ts`/`store-branch.ts` 对 `store.ts` 只有 `import type`，store 相关测试全绿

