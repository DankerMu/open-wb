# Spec delta: chat-sessions（#473 stop 已派发路径：有界退回例外与对账不触碰 stopped）

> 两个 requirement 均以当前主 spec 原文为底（程序化拷贝，保留主 spec 的压缩空白写法），只并入本 issue 交付的父 delta 原文片段：
> - 「会话持久化与回合刷盘」：reconcileOnStartup 段并入父文「; `stopped` rows are already terminal and SHALL NOT be touched」；Scenario「Startup reconciliation」首组 WHEN 的 `/stopped` 与 THEN 的「, including stopped rows,」（#455 fixture 指派给 #473）。父 delta 中 finishTurn/close/reconcileOnStartup 对 pending 审批的 `deny` 结算与审计、注入 emit 句、「except the approval settlement defined here」、Scenario「Startup reconciliation」的审批 WHEN/THEN 组与「Terminal settlement denies pending approvals」归 4.6 #474。#474 重写同一段：后归档者须以已推进的主 spec 为底。
> - 「Supervisor ordered persistence and publication」：并入父文「Stop is the one exception: …」整句。其后「Whenever a turn ends without the child answering its pending approvals …」一句与 Scenario「Stop bounded-retire exception」（`approval-chain-abort-ignored`，`r2` 在 grace 时仍 pending）归 4.6 #474。

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

### Requirement: Supervisor ordered persistence and publication
The supervisor SHALL initialize the canonical pure mapper with the exact admitted assistant id and dispatch requestId. It SHALL consume the full runtime iterator, preserving arrival order including frames before ACK. toolCallId SHALL map to numeric startStep results using zero-based per-turn ordinals; public events SHALL carry numeric stepId only. Steps SHALL be persisted before publication; text SHALL enter the existing store buffer unchanged. A terminal transaction SHALL complete before turn.end publication.
Post-dispatch transport/native failure SHALL flush residual content and settle running steps/message/session failed, emit error before one failed turn.end, then discard/retire the runtime. Stop is the one exception: when a stopped turn's `agent_end` does not arrive within the bounded grace and the supervisor retires the runtime (turn-control), the supervisor SHALL settle the turn `stopped` and synthesize exactly one `turn.end{status:"stopped"}` through applyStop without any error event; late frames or the native exit of that retired runtime SHALL NOT produce error or a failed turn.end. Queued deltas SHALL be drained before failure settlement. Mapper terminal fencing SHALL prevent duplicate/late settlement; upstream stopReason:error SHALL become failed without requiring child death. Runtime-validated clean local-only completion without mapper terminal SHALL finish done and publish one done turn.end without waiting for agent_end.
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
