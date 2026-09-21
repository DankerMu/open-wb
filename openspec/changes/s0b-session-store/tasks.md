## 1. Contract and test-first
- [x] 1.1 Expandedfixture reviewPASS after one bounded revision pinningfaultedappend throwing retainederror; title/reconcile provenance andDTOprimitive types clarified. Strictvalidation exit0; schema/errors/runtime/config andAPI identities frozen beforeA1.
- [ ] 1.2 A1 pairedtests beforestore source, SETUPonly; parent-authorizedA2 callablewrongDBbehavior semanticRED; freezesnapshot beforeB.
## 2. Store lifecycle
- [ ] 2.1 OwnerCRUD/orderedviews, atomicadmission/compensation, explicitruntime metadata/epoch andcanonicalnotfound/busyerrors.
- [ ] 2.2 Immediate steps,2048byte/2000ms quiettimerbuffer, terminalatomicdrain, failureownership/stalefences/close andexplicitstartupreconcile; focusedrealSQLite+fakeclockGREEN.
## 3. Acceptance and delivery
- [ ] 3.1 Parent compiledfileDB/realtimer proof, independentoracles/mutants/restoration, scoped/fullservercoverage/static/drift/build/strictOpenSpec andprotectedidentities.
- [ ] 3.2 Expandedcorrectness/test-evidence+spec/invariant-state review; boundedfixgate/sameSHA CI/sourcePRmerge.
- [ ] 3.3 Syncparentpersistencenotes/task3.2 anddocs-onlycanonicalpromotion/archive; do notmarkREST/runtimeassemblyimplemented.
## Risk mapping
- PublicAPI selected: SessionStore/factory/view/error/lifecyclesignatures→2.1/2.2/3.1.
- Config/projectsetup notselected: no env/dependency/build config; requiredflusherrorcallback islocalAPI, not operatorconfig.
- FileIO/path selected: persistedSQLitefile/reopen/DBownership→3.1; no userfilesystempaths.
- Schema/fields/units selected: existing032 DTOs,Unicodecharacters/UTF8bytes/ms/ordering→2.1/2.2; no SQLmigration.
- Auth / permissions / secrets: selected for owner-scoped queries and admission, with trusted internal metadata kept separate. Evidence: 2.1 / 3.1. Token and cookie implementation excluded.
- Concurrency/state/order selected: ownedtransactions, timer/buffer/turnidentity, atomiccompensation/finish/reconcile→2.1/2.2/3.1.
- Resource/largeinput selected: boundedpendingflushbudget, no emptytimers, closereclaimsownedtimers, no fullanswercopyperdelta→2.2/3.1.
- Compatibility selected: audit/workspaces/coreerrors/runtime unchanged, #99/#100downstreamports preserved→1.1/3.1.
- Error/rollback selected: trigger-inducedpartialwrite/commit/flushfailure, callertransaction/notification→2.1/2.2/3.1.
- Release/packaging selected: compileactualmodule/no newdependency/sameSHA CI→3.1/3.2.
- Documentation selected: fixtures/parentstorage-state notes andcanonicalstore-onlypromotion→1.1/3.3.
Projectdomain selected tenantownership, SQLitepersistentstate/catalogcompatibility, auth/sessionlifecycle atchatturnboundary, offlineNode/SQLite→2.1/2.2/3.1. Notselectedsandboxfileboundary, ompchildenv/processspawn, HTTP/SSEenvelopes, browserruntime, cross-servicenetwork: ownedbylaterissues, notthisstore.
## Governance
Onewriter/currentcheckout/no newworktree. Implementation onlystore.ts+tests; parentownsfixtures/acceptance. No schema/config/deps/CI/threshold/runtime edits. Reviewersleaf/read-only/no verificationcommands. WriterMUSTNOTreadparent probes/baseline/qualification files; suppliedcontract andownreports only. Originaltestbytes andRED evidence frozenbeforeB; no retrospectiveRED. Userhumanwhiteboxwaiver doesnotwaiveagentreview/CI/finalEpicfunctionalreview.
