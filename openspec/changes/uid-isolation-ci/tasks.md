# Tasks

## 1. Contract and fixture
- [x] 1.1 Independent expanded fixture review PASS and strictvalidation0; map current helper/env/PGID, actioncounts and #131 realtest prerequisites before edits.

## 2. Atomic CI integration
- [x] 2.1 Add uid provisioning script with exact identities/rules, visudo, sharedjob-ownedpaths, safe Node resolution, minimalenv HOMEpreflight and sg-selectedtest+realomp smoke; source/runtime controls prove forwarding/failure/prelaunchownership without localhostsudo.
- [x] 2.2 Add mandatory timeout15workflowjob and eightdirect aggregate; update inspect-ci-workflow8/6 and sourceoracle exactsteps/env/helperforwarding atomically; existingjobsshapes preserved.
- [x] 2.3 Add negative controls for missingjob/aggregate, droppedoptin/user/group, failedHOME orprovisioning, secret/upstreamleak andcleanupfailure; all positives remainGREEN and mutants failfor intendedreason.

## 3. Verification and delivery
- [x] 3.1 Main runs decodedoracleparse, make test-guardrails, affectedstatic/type/drift; no realhostuser/group/sudo modifications. Record eachcommandexit.
- [x] 3.2 Hosted PRCI uidjob actuallypasses HOMEpreflight, #131 test1passed0skip and realpinnedomp fourfilesmoke, cleanup noresidue; exactheadall9jobsaggregategreen withtoken-safe logs.
- [ ] 3.3 Frozen expanded3seatreview, boundedfixloop, automaticmerge; observe mergedmasteruidjobgreen, handoff#134andselectivearchivechild whiledowngradeandparentsremainactive.

Evidence: diagnostic-free `bb7bde43adbe7f64ffa9132bef89728a83360e67`, hosted run `35969045863` / uid job `107534187444`: exact HOME with space/colon, 1 test passed (none skipped), 4 Hurl files / 38 requests passed, all 9 jobs succeeded. Local `make test-guardrails`: 647 PASS / 0 FAIL (exit 0); lint/typecheck/anti-drift exit 0. Hosted-image repairs retained global visudo while normalizing only runner sudoers mode, granted omp execute-only ACL on runner-home ancestor, and preferred selected Node in secure_path. Temporary startup probes and their oracle exceptions removed. Master evidence/review/archive remain task 3.3.

## Risk pack mapping
- Selected Public API / CLI / script entry:2.1/2.2/3.2 shell/sg/sudo/jobentry.
- Selected Config / project setup:2.1/2.2 identity/path/env/Node.
- Selected File IO / path safety / overwrite:2.1/2.3 ownedsharedroots/copy/sudoers, no unrelatedpathmutation.
- Not selected Schema / columns / units / field names: no persisted schema/migration change.
- Selected Auth / permissions / secrets:2.1/2.3/3.2 realuid/proc/minimalpreflight/nosecretlogs.
- Selected Concurrency / shared state / ordering:2.1/2.3 sgforbothphases, preflightbeforetest, cleanup/failureprecedence.
- Selected Resource limits / large input / discovery:2.2/2.3 timeout15,boundedreadiness/reap, no skippedproof.
- Selected Legacy compatibility / examples:2.2/3.1 existingjobs/optionalOMP_USER/smoke-live unchanged.
- Selected Error handling / rollback / partial outputs:2.3 failclosedprovision/preflight/harness andownedresidue.
- Selected Release / packaging / dependency compatibility:2.1/3.2 pinnedHurl/realomp/Nodeinterpreter onhostedrunner, no newdeps/actions.
- Selected Documentation / migration notes:3.3 masterevidencehandoff, selectivearchive, downgradeclosureoutofscope.
