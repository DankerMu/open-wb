## 1. Contract and baseline
- [x] 1.1 User approved032append, issue/parent synchronized. Expandedfixture reviewPASS after one bounded revision (triage/risk mapping and requiredmessageindex); child/parent strictvalidation exit0. Genuine pre032DB with five receipts and auth/audit/workspace rows captured beforeSQLcreation; protected identities frozen beforeStageA.
- [ ] 1.2 StageA: paired realopenDb tests and sharedsix-receiptexpectations before032 exists; semanticRED on publicdatabase behavior; freeze standaloneoriginaltests beforeStageB.
## 2. Schema
- [ ] 2.1 Add only032_chat_sessions.sql with exacttables/domains/defaults/keys/cascades/indices; no runner/oldmigration/sessioncode edits.
- [ ] 2.2 Focused testsGREEN: freshschema/negativewrites/cascadeisolation/oldDBupgrade/stablereopen/atomiclatefailureandrecovery; sharedcatalogconsumers remaincorrect.
## 3. Acceptance and delivery
- [ ] 3.1 Parent compiledrealDBprobe and disposableSQLfaultqualification/reference/restoration; scopedchecks/fullservercoverage/build/strictOpenSpec and oldassetidentityproof.
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
