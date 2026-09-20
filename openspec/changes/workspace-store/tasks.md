## 1. Implementation and proof
- [x] 1.1 Owner list/rootOf and create have captured semantic RED/GREEN; validation/conflict/compensation mostly first-GREEN after creation implementation, explicitly not claimed as fully vertical TDD. Main retrospective exact-test-clone qualification killed seven meaningful mutants after closing two surviving oracle gaps.
- [x] 1.2 Implement synchronous same-db create transaction with canonical helpers/audit, safe root policy, exact INSERT conflict classification and adopted-directory preservation. Source/type/static gates pass with no dependency or policy changes.
- [x] 1.3 Real DB/FS failure matrix covers partial creation, audit, COMMIT, ROLLBACK, caller transaction and nonempty compensation refusal. Main discovered and reproduced lost `undefined` ROLLBACK failure; permanent regression RED/GREEN plus identical compiled reproduction now GREEN. Failure presence is independent of value; aggregation retains original cause and rollback/cleanup ordering while allowing active/uncommitted residual DB state on failed rollback. Main focused80/4, server964/44, type/build/Biome/knip/dupes0/size all pass; compiled store/facade smoke passes. No crash/TOCTOU or universal fault-coverage claim.
- [ ] 1.4 Main focused/fullserver/type/build/static checks and compiled real-store smoke; independent expanded review, exacthead CI, merge and store-only archive/downstream handoff.

## 2. Risk mapping
- Selected Public API / CLI / script entry: three methods/fivefieldoutput/syncports; real consumer-seam tests, type/build, compiledsmoke.
- Not selected Config / project setup: no new configuration/thresholds; trusted existing sandboxRoot precondition fromD3.
- Selected File IO / path safety / overwrite: safeownersegments, canonicalresolver symlink rejection, lazy new2770, existingdata adoption, partialcreate cleanup rmdir-only; test realpaths andsymlinks.
- Selected Schema / columns / units / field names: 031constraints, exactnameUnicode/diralphabet, random32hexid, signedcreatedAt ordering, exactauditfields; realSQLite notschemachanges.
- Selected Auth / permissions / secrets: SQLownerfilter onbothlist/rootOf, foreignnullbeforeFS, no outsidepath; seededtwoowners andunsafeid tests. HTTPauthoutofscope127.
- Selected Concurrency / shared state / ordering: ownedBEGIN, INSERT→owner→workspace→audit→COMMIT, sameDBauditrollback, callertransactionpreserved; no externalwriter/crashatomicity claim.
- Not selected Resource limits / large input / discovery: no recursive discovery/fullfilebody; only boundednamevalidation andtwo-levelroot creation; quotas/paginationoutofscope.
- Selected Legacy compatibility / examples: exactdemoderivation(non-u), schemaacceptedUnicode/signedtime, fivefieldwebcontract, existingdirsfiles/modes retained.
- Selected Error handling / rollback / partial outputs: bothuniquesconflict onlyatINSERT; othererrorsnative; realauthorizercommit/rollback anddependencyfaults; failedcleanupAggregateErrorcause, preserve nonempty/adoptedpaths.
- Not selected Release / packaging / dependency compatibility: nodeSQLite/buildexisting, no dependencies/migrations/deploymentchanges.
- Selected Documentation / migration notes: store-onlyspecpromotion,parent3.3,#127/#128handoff; currentbasepreprovision/stableFS/compensationlimits explicit.

## 3. Commands and boundaries
`npm exec --workspace server -- vitest run test/workspace-store.test.ts test/workspaces-schema.test.ts test/sandbox-facade.test.ts test/sandbox-dirs.test.ts`; `npm run typecheck --workspace server`; `npm test --workspace server`; `npm run build --workspace server`; scopedBiome; `npm run deadcode`; `npm run dupes`; `bash scripts/size-guard.sh`.
Main owns fixture/git/acceptance; singleimplementer focusedverticalRED/GREEN only, noformat/lint/fullsuite. Staticreviewers no execution/edits/peercontact. Currentworktreeonly, no nestedagents. Userwaived perissuehumanreview; finalEpicfunctionalacceptance remains human.
No permanent tests for source strings, incidental wiring or mock echoes. Main staticboundaryaudit and independent review complement runtimeproof; rawlogs distinguish setup vssemantic RED, no transcribed log substitution.
