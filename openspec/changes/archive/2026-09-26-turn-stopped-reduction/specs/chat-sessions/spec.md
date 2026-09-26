# Spec delta: chat-sessions（#455 finishTurn stopped 结算）

> 父 delta「会话持久化与回合刷盘」由多个 issue 分担。本 delta 以当前主 spec 原文为底，只并入本 issue 交付的父 delta 原文：acceptPrompt 受理 `stopped`、rollbackPrompt 恢复先前 `stopped`、`finishTurn(assistantMessageId,status)` 接受 `stopped` 及其步骤结算句、Scenario「Atomic admission and epoch separation」的 `/stopped`、新 Scenario「Stopped turn settlement」。未并入、留待后续 issue：注入 `core/audit` emit、finishTurn/close/reconcileOnStartup 对 pending 审批的 `deny` 结算与审计、Scenario「Terminal settlement denies pending approvals」及「Startup reconciliation」的审批子句归 4.6 #474；reconcileOnStartup「`stopped` rows are already terminal and SHALL NOT be touched」句与「Startup reconciliation」的 `stopped` 子句（WHEN 的 `/stopped`、THEN 的 including stopped rows）归 4.2a #473（#474 同样重写该段）。

## MODIFIED Requirements

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
