## 1. Contract and baseline
- [x] 1.1 User approved032append, issue/parent synchronized. Expandedfixture reviewPASS after one bounded revision (triage/risk mapping and requiredmessageindex); child/parent strictvalidation exit0. Genuine pre032DB with five receipts and auth/audit/workspace rows captured beforeSQLcreation; protected identities frozen beforeStageA.
- [x] 1.2 Before032 existed, affected215 tests yielded49 semanticRED/166GREEN (five-vs-six receipts/missingchat tables); parent compiledprobe independently rejected missing032receipt. Initial and corrected standalonetest snapshots retained; SQLite numeric-string affinity oracle corrected beforeSQLcreation.
## 2. Schema
- [x] 2.1 Added only61-line032_chat_sessions.sql production asset with exactdomains/defaults/FKs/cascades/twoindices; oldmigration/runner/ledger bytes unchanged.
- [x] 2.2 Focused215testsGREEN, including30new schema cases. Fresh/upgrade/reopen/lateconflictrollback/recovery/cascadeisolation pass; stale auth-schema globaltableinventory updated, incidentalglobalindexname assertion removed while semanticindexchecks remain.
## 3. Acceptance and delivery
- [x] 3.1 Parent compiledrealSQLite probesGREEN,21 semanticSQLmutants rejected with restoredGREEN and dedicatednochange controls; actualpre032DB immutable.973server tests/45files,90.65% statements/88.55% branches; types/build/scopedlint/drift0clones/child+parentstrictOpenSpec exit0.
- [ ] 3.2 Expandedcorrectness/test-evidence+spec/invariant-state review, boundedfixgate andsameSHA CI/sourcePRmerge.
- [ ] 3.3 Parenttask3.1 update, canonicalchat-sessions promotion anddocs-onlyarchive; no prematurestore/routes requirements.
## Risk pack mapping
- Public API/CLI/script entry: not selected; no new exported API or entrypoint, existingopenDb used as verification boundary3.1.
- Config/project setup: not selected; no config/env/dependency setup change.
- File IO/path safety/overwrite: selected; immutable SQL assets and real fileDB baseline/upgrade→1.1/2.2/3.1; userpath sandbox is a non-goal.
- Schema/columns/units/fields: selected; exact domains/defaults/keys, ownerordered andmessagehistory indices→2.1/2.2.
- Auth/permissions/secrets: selected; ownerFK/cascade isolation and siblingauditRESTRICT preservation→2.2/3.1; no newcredentialhandling.
- Concurrency/shared state/ordering: selected; immutable receiptprefix and runner-owned atomicDDL+receipt→1.1/2.2.
- Resource limits/large input/discovery: not selected; no new runtime resourcepolicy/discovery; query indices belong toschema pack.
- Legacy compatibility/examples: selected; pre032businessdata/receipts, upgrade/reopen and sharedcatalogconsumers→2.2/3.1.
- Error handling/rollback/partial outputs: selected; realnegativewrites, lateDDLfailure and recovery→2.2/3.1.
- Release/packaging/dependency compatibility: selected; compiledSQLassetcopy, no deps, sameSHA CI→3.1/3.2.
- Documentation/migration notes: selected; approved032decision, parentledger andcanonicalpromotion→1.1/3.3.
Projectdomain selectedSQLitecatalogcompatibility, tenantownershipFK/cascadeisolation, offlinecompiledassets→2.2/3.1. Not selectedsandboxuserpath, process/childenv, authcookie/sessionTTL, HTTPenvelope, browserruntime, networkservice: unchanged/non-goals. Expandedreason is persistentupgrade, not inheritanceofspawnwork.
## Governance
One writer/currentcheckout/no newworktree. Parentownsfixture/acceptance; implementerwritesSQL/tests only. No oldmigration, ledger, thresholds, config/dependencies/CI changes. Reviewers leaf/read-only/no validation commands. Userhumanreviewwaiver untilfinalEpicfunctionalreview preserved; agentreview/CI/fixgate notwaived. Parentprobe paths notreadable bywriter; aftersourcefreezeholdouts generated independently.
