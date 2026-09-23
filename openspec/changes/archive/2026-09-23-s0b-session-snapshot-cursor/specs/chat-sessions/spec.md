## MODIFIED Requirements

### Requirement: 会话持久化与回合刷盘
createSessionStore(db,{onFlushError}) SHALL provide SessionStore owner-scopedcreation/list/message-tree reads and the explicitmutation/lifecycle contract inthischange. IDs SHALL be random128-bit lowercasehex; creation SHALL persistidle/nulltitle/epoch0. Foreign/missingmessage-tree reads SHALL returnnull andownerlists SHALL excludeotherowners. Views SHALL expose only declaredsession/message/step fields, orderedupdatedAtDESC/idASC forsessionlist, createdAtASC/idASC formessages andordinalASC/idASC forsteps. getMessages SHALL return complete current content by joining the persisted body with only the matching owned active assistant pending tail. This read SHALL NOT force persistence, change timers/budgets/progress or mutate pending state; fault-retained pending data remains visible without claiming durability.
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

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages and POST /api/sessions/:id/prompt. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal. Session views SHALL contain only id,title,status,createdAt,updatedAt; Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.

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

## ADDED Requirements

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
