# Spec delta: chat-sessions（#474 终态事务内结算挂起审批与回报）

> - 「会话持久化与回合刷盘」「Supervisor ordered persistence and publication」「Session module registration and teardown」：本 issue 交付后三块全部交付，以父 delta 同名块整段逐字替换主 spec。
>   - 新增内容：
>     - store 注入 emit 句；
>     - finishTurn/close/reconcileOnStartup 的同事务 `deny` 结算与回报；
>     - 「Whenever a turn ends without the child answering …」句；
>     - reconcile 与 shutdown 的审批子句；
>     - Scenario「Terminal settlement denies pending approvals」「Stop bounded-retire exception」，以及「Startup reconciliation」中的审批 WHEN/THEN。
>   - 主 spec 现有 Scenario 全部保留，标题不变。父块 Scenario 的 `**WHEN**`/`**THEN**` 加粗写法与主 spec 的非加粗写法只是格式差异。
>   - reconcile 段以 #473 推进后的主 spec 为底（含「`stopped` rows … SHALL NOT be touched」），与父块逐字一致。
> - 「会话 REST」（部分交付）：以主 spec（#475 推进）为底，只在 Scenario「Stop is accepted while running and idempotent otherwise」中插入父文的审批 WHEN/THEN（#475 移交本刀；行为由 #464 `decide` 与 #473 停止路径交付，本刀补证据）。父块的以下部分不在本 delta：regenerate/fork 路由与段落（#467/#469）、控制占用子句（#465）、「八条路由」措辞（#467/#469）；`stopped` 联合句无 owner（#476 已归档而未补入），按 carry-forward 留给 #486 对账；`parent_session_id` 不暴露子句归 fork（#466/#469）。

## MODIFIED Requirements

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

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop and POST /api/sessions/:id/approvals/:approvalId. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign session ids SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,approvals,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. `approvals` SHALL be present on every message as an array of all `chat_approvals` rows of that message in ascending id order, each `{id,tool,title,requestedAt,expiresAt,decision}` with `decision` ∈ `allow|deny|timeout|null`; it SHALL be `[]` for a user message and for an assistant message without approval rows. Several pending (`decision:null`) entries MAY coexist on one message (parallel tool calls); a later approval request never replaces an earlier entry. Session views SHALL contain only id,title,status,createdAt,updatedAt; Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/stop SHALL be a bodyless content-parser owner (the logout precedent): any parsed body (including `{}`), empty-or-malformed JSON, unsupported media or an envelope above its minimal body limit SHALL return400 bad_request after authorization and before any supervisor call, frame or write. When the session is `running`, stop SHALL call supervisor.stop(sessionId) — which first settles every pending approval of that turn, if any exist (the pending set is the snapshot read on entry; it is not re-read before the `abort` frame), as `deny` (per approval: persist decision/decided_at and its `session.approval` audit row in one transaction → answer `Deny` → publish `approval.resolved`) and then writes the `abort` frame; when the turn's prompt frame is not yet written, stop instead records a stop intent and the supervisor writes `abort` right after that prompt's dispatch receipt resolves (after the stop call has returned), so stop neither cancels the dispatch nor compensates the accepted rows and the prompt request still returns its normal202 body (a failed acquisition or dispatch still follows the ordinary prompt compensation, and the intent never rewrites a terminal status another path reached first) — and return202 with body exactly `{}` without waiting for the turn to end; for any other status it SHALL return204 with no writes and no supervisor call. The stopped turn ends with `turn.end{status:"stopped"}` and session/assistant/running steps read `stopped`.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session; a non-canonical approvalId SHALL be rejected before body parsing, and an approvalId not owned by this session SHALL be rejected after body parsing but before any write, answer frame or publish. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: in one transaction persist decision/decided_at and its `session.approval` audit row → answer the child (`Approve` for allow, `Deny` for deny) and cancel its timeout timer → publish `approval.resolved` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}` (one element of the snapshot's `approvals` array).

#### Scenario: Create list and empty history
- WHEN an authenticated account creates a session and reads its list and history
- THEN create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- WHEN a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls stop/approvals on it
- THEN its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- WHEN no valid cookie is supplied, including malformed/oversized bodies
- THEN401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- **WHEN** an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- **THEN** list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields, every message carrying an `approvals` array (`[]` when it has no approval rows)

#### Scenario: Stop is accepted while running and idempotent otherwise
- **WHEN** the owner posts stop on a running session backed by the real fake (`abort-ok`), then posts stop again after the turn has ended, and posts stop on an idle session
- **THEN** the first call returns202 with body exactly `{}` and no-store before the turn ends and the session/assistant/running steps subsequently read `stopped` with `turn.end{status:"stopped"}` published; the later calls return204 without writes; a subsequent prompt on the stopped session returns202
- **WHEN** a stop is posted while an approval of that turn is pending
- **THEN** the approval row reads `deny` and its `session.approval` audit row is committed with it, the child receives `Deny` before the `abort` frame (fake probe order), `approval.resolved{decision:"deny"}` precedes `turn.end{status:"stopped"}`
- **WHEN** stop is posted by the owner with a JSON body `{}`, malformed JSON, an empty JSON body, an unsupported media type or an oversized body
- **THEN** 400 bad_request with no-store is returned with no supervisor call, no frame and no write

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner reads the snapshot, then posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the snapshot's running assistant message carries `approvals:[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]` while user messages carry `approvals:[]`; the first answer returns200 with `decision:"allow"` after the row and its audit row are committed together, and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** no answer arrives within 60s of the injected clock
- **THEN** the row reads `timeout`, the child receives `Approve`, `approval.resolved{decision:"timeout"}` is published and the snapshot shows `decision:"timeout"`
- **WHEN** the real fake (`approval-parallel`) raises two approvals in one turn and the owner answers only the second
- **THEN** the snapshot lists both in ascending id order, the second reads `allow` while the first stays `decision:null`, and answering the first later settles it independently
