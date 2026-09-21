# chat-sessions Specification

## Purpose
定义会话、消息与执行步骤的 schema 和追加迁移，以及账号隔离的存储视图、原子受理与补偿、正文刷盘、步骤和终态、故障恢复、关闭及显式启动对账契约。REST/runtime/SSE装配由后续变更增补。
## Requirements
### Requirement: 会话数据 schema
Migration032_chat_sessions.sql SHALL atomically create chat_sessions, chat_messages and chat_steps using the existing runner-owned transaction. Existing0010/002/010/030/031 receipts and business data SHALL remain unchanged;032 SHALL append as the sixth receipt without changing ledger validation.
chat_sessions SHALL have id TEXT NOTNULL PRIMARYKEY constrained to32 lowercasehex characters withoutNUL; owner_id TEXT NOTNULL referencing accounts(id) ONDELETECASCADE; nullable title/omp_session_file TEXT; status TEXT NOTNULL in(idle,running,done,failed); stream_epoch INTEGER NOTNULL DEFAULT0 and nonnegativeinteger; created_at/updated_at INTEGER NOTNULL nonnegativeepochms; and an owner_id,updated_atDESC index.
chat_messages SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; session_id TEXT NOTNULL referencing chat_sessions(id) ONDELETECASCADE; role TEXT NOTNULL in(user,assistant); content TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(done,running,failed); created_at INTEGER NOTNULL. chat_steps SHALL have id INTEGER PRIMARYKEY AUTOINCREMENT; message_id INTEGER NOTNULL referencing chat_messages(id) ONDELETECASCADE; ordinal INTEGER NOTNULL nonnegativeinteger; name TEXT NOTNULL; detail TEXT NOTNULL DEFAULT''; status TEXT NOTNULL in(running,done,failed); started_at INTEGER NOTNULL; ended_at nullableINTEGER; UNIQUE(message_id,ordinal).
chat_messages SHALL have an ascending(session_id,created_at,id) index supporting ordered history within a session; indexnames are not part of the external contract.
NoIFNOTEXISTS silentconflict acceptance or migration-ownedtransaction SHALL bypass existing runner rollback. Store/reconciliation and runtime APIs are out of this migration slice.

#### Scenario: Fresh schema and receipts
- WHEN openDb opens :memory: or a new file database
- THEN receipts are0010,002,010,030,031,032 in order and allthree tablecolumns/defaults/keys/indexconstraints exist and govern actualwrites

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

### Requirement: 会话持久化与回合刷盘
createSessionStore(db,{onFlushError}) SHALL provide SessionStore owner-scopedcreation/list/message-tree reads and the explicitmutation/lifecycle contract inthischange. IDs SHALL be random128-bit lowercasehex; creation SHALL persistidle/nulltitle/epoch0. Foreign/missingmessage-tree reads SHALL returnnull andownerlists SHALL excludeotherowners. Views SHALL expose only declaredsession/message/step fields, orderedupdatedAtDESC/idASC forsessionlist, createdAtASC/idASC formessages andordinalASC/idASC forsteps. Reads SHALL reflectpersistedcontent only.
acceptPrompt(sessionId,ownerId,text) SHALL atomically checkownership/busy, insertuserdone+emptyassistantrunning andupdatesessionrunning/title-ifNULL/updatedAt. Foreign/missing SHALL throwcoreHttpError not_found beforebusy disclosure; running SHALL throwsession_busy withoutwrites. Text SHALL bepreserved; title SHALL usefirst18Unicodecodepoints withoutellipsis. acceptPrompt SHALL NOT bumpstream_epoch. bumpStreamEpoch SHALL incrementonce independently; setSessionFile SHALL persistresume metadata. runtimeState is a trusted-supervisor-only accessor, not anowner-authorization endpoint.
rollbackPrompt SHALL atomically remove onlyanunprogressed acceptedpair andrestoreprevioussessionstatus/title/updatedAt, not independentlychangedepoch/sessionFile. It SHALL rejectrollbackaftertext/step progress andreturnfalse wheninactive. Transactions SHALL NOT consumeorrollback caller-ownedtransactions; DBerrors SHALL propagatewithoutpartialwrites/memorycommit.
appendDelta SHALL buffer in order byactiveassistantidentity, flushat2048cumulativeUTF8bytes or2000ms sincefirstpendingdelta (whicheverfirst), andresetdeadline/bytebudget onlyafter successfulflush. Quietpendingdata SHALL flushwithoutanotherdelta. Steps SHALL persistimmediately; finishStep SHALL settleonlyrunningsteps. finishTurn SHALL atomically flushresidual andsettleassistant/session plusremainingrunningsteps, preservingalreadyterminalsteps. Stalecalls SHALL NOT modifyterminal/newturn rows; inactive append/finish methods returnfalse.
Timerflushfailure SHALL retainpendingdata, notifyrequiredonFlushError once andstopautomaticretry. FurtherappendDelta onthefaulted-but-activebuffer SHALL throwtheretainedflushfault withoutgrowingthebuffer (false remainsinactive/stale only). Explicitfinish/close mayretryafterexternalrepair; successfulwrites SHALL notduplicatecontent. close SHALL cancelownedtimers, finalizeactiveownedturns asfailed withresidualdata, remainidempotent aftersuccess andleaveDBownership tocaller; failures SHALL notpretendcleanup/persistence succeeded.
reconcileOnStartup SHALL explicitly andatomically setallrunning session/message/step statuses tofailed whilepreserving allotherfields/rows. It SHALL runbeforelivework andreject invocation withownedactive turnstate. No constructor-side reconcile or REST/omp/SSE assembly isadded.

#### Scenario: Owner-safe ordered reads
- WHEN twoowners createconversations andpersist message/step histories
- THEN eachowner seesonlytheirownorderedviews, foreignmessage-tree returnsnull, andinternalruntime/resume/buffer fields areabsentfrombrowser-facingviews

#### Scenario: Atomic admission and epoch separation
- WHEN anidle/done/failed owned sessionaccepts text
- THEN onedoneuser andonerunningassistant appearwithsessionrunning/title-ifNULL; epochstaysunchanged andexplicitbumpaddsone
- WHEN ownershipfails, sessionisbusy, aninsert/update/commit fails orcallerownsatransaction
- THEN no partialadmission/memoryturn remains; correcterror surfaces and callertransactionisnotrolledback

#### Scenario: Pre-dispatch compensation
- WHEN runtimepreparationfails beforeanyturnprogress andcallerrollsbacktheacceptedassistant
- THEN acceptedpair disappears andpriorstatus/title/updatedAt return; independentepoch/resumemetadata remain
- WHEN theturnalreadyprogressed
- THEN rollbackisrejected withoutdeleting itsdata

#### Scenario: Byte and quiet-time flushing
- WHEN pendingbody isbelow2048UTF8bytes andbelow2000ms old
- THEN persistentcontent isunchanged
- WHEN eitherthreshold isreached, includingaquiettimerwithnolaterdelta
- THEN allpendingtext persistsinorder exactlyonce whileassistantremainsrunning, withanewbudget/deadline forlatertext

#### Scenario: Step and terminal persistence
- WHEN stepstart/end anddone/failedfinishTurn occur
- THEN steps persistimmediately, finalresidualbody andsession/assistant statuses commitatomically, remainingrunningstepssettle andalreadyterminalstepsremainunchanged
- WHEN staleevents/timers fromthatturn arriveafterterminal orafteranewadmission
- THEN neitherterminalcontent nornewturn statechanges

#### Scenario: Failure retention and shutdown
- WHEN SQLite rejectsaflush orfinalization
- THEN uncommittedbuffer isretained, no partialterminalstate appears; synchronouserrorspropagate andtimererrorsnotifyonce withoutunhandledthrow/retryloop; furtherappendDelta onthefaultedactivebuffer throwstheretainedfault withoutgrowingpendingdata
- WHEN callerrepairsfailure andexplicitlyfinishes/closes
- THEN pendingbytes persistonce; closecancelsalltimers anddoesnotcloseDB

#### Scenario: Startup reconciliation
- WHEN anunstartedstore seesrunningrows mixedwithidle/done/failedrows acrossowners
- THEN oneexplicitreconcile changesonlyrunningstatuses tofailed inallthreetables andleavesallotherdataunchanged
- WHEN a reconciliationwritefails
- THEN noneofthestatuschangescommit

### Requirement: 会话文本无损读取与标题复用
SessionStore SHALL preserve complete text values, including embedded U+0000, leading U+FEFF, non-ASCII and astral characters, across list/getMessages titles, user and assistant content, step name/detail, and trusted runtimeState ompSessionFile. Public outputs SHALL remain strings or the existing nullable values. Empty string and SQL NULL SHALL remain distinct. Appended content and finish/close flushes SHALL retain the complete concatenated value.
Admission SHALL reuse an existing title without truncating its suffix, retain the complete previousTitle for rollbackPrompt, and keep the persisted title storage class TEXT. The first-title Unicode-prefix rule SHALL remain unchanged. The fix SHALL NOT claim recovery of suffixes already overwritten by older admissions.
Lossless reading SHALL respect the actual database text encoding. Existing UTF-8, UTF-16le and UTF-16be databases SHALL remain readable without changing encoding, schema, unrelated data or migration receipts. Per-connection encoding selection SHALL NOT leak between databases. Leading U+FEFF SHALL be preserved; no new fatal invalid-byte policy, character stripping or input rejection SHALL be introduced. Failed encoding/SQL reads SHALL propagate rather than silently selecting a guessed encoding.
Owner isolation, order, status transitions, epoch/resume independence, transaction boundaries and compensation/flush errors SHALL remain as already specified. The shared text-read implementation SHALL have one canonical owner in core/db and no per-consumer alternate decoding implementation.

#### Scenario: All free-text read surfaces
- WHEN a real store accepts text containing U+0000, persists assistant deltas and steps, and records trusted resume metadata containing that character
- THEN getMessages/list/runtimeState return complete values for content/title/name/detail/resume, including text after the NUL, without leaking internal fields into public views

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

