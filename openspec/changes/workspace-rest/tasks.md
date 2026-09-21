## 1. Vertical implementation and evidence
- [ ] 1.1 Encode collection HTTP creation/list/owner/validation/cache contracts at real createApp+store+facade+audit boundary; capture semanticRED before minimal production implementation, thenGREEN. Preserve accepted Unicode/dir policies and exact parser16KiB behavior.
- [ ] 1.2 Encode tree/dirs owner404, traversal403+persisted audit and dirs201/409/404/403; prove ENOTDIR counterexample RED against originalresolver then canonical correctionGREEN, preserve all escape vectors/unexpected-error rejection and original path strings.
- [ ] 1.3 Encode preview real rawbytes/text/html/image/zero/truncation/413/415/404 plus productionheaders, no bodyopening on rejection; captureRED→GREEN without deep largeBuffer comparisons.
- [ ] 1.4 Exercise genuine audit/storage failures, failedROLLBACK residualstate and no-store/sanitization; finish all five routes and registration seam without bootstrap edits.
- [ ] 1.5 Main run scopedBiome, server typecheck/build, focused/full server coverage, knip/jscpd/size; run compiled real localhost HTTP workflow with real auth/DB/FS/audit and real client abort/descriptor closure; retain raw outputs and counterexamples.
- [ ] 1.6 Independent expanded static review, bounded fixes, exactheadCI, publicreports/deviations/summary, merge; archive onlythisslice and updateparent/#128handoff.
## 2. Risk mapping
- Selected Public API/CLI: five endpoints, exactbody/query/status/cache/envelope;1.1–1.4.
- Not selected Config/projectsetup: no app/server/env/STARTUP_MODULES; composition in test/runtime smoke only.
- Selected FileIO/path: owner-firstmetadata, core resolver, ENOTDIR taxonomy, symlink/FIFO, no recursiveparentcreation/adopteddatadeletion;1.2–1.5.
- Selected Schema/units: existingownerDB, auditdetail, byte-size/epochms/noUnicodeidentitydrift; realDB tests1.1–1.4; no migration.
- Selected Auth/permissions/secrets: realcookies/twoaccounts/foreign404/noaudit/pathsanitized500;1.1–1.4.
- Selected Concurrency/sharedstate: syncmkdir/auditordering, storeownedtransaction failure, streamnativeabort;1.2/1.4/1.5. ExternalFSwriters excluded.
- Selected Resource limits:16KiBparser,1MiBtextprefix,10MiBimage,zero,backpressure/abort;1.1/1.3/1.5.
- Selected Legacy compatibility: canonicalstore/facade/headers/non-uderivation/rootcachepatterns preserved;1.1–1.5.
- Selected Error/rollback/partialoutputs: directoryauditfailuremayretaindir; failedDBrollbackmayretaintransaction; preheader500 vs postheaderabort;1.4/1.5.
- Not selected Release/dependencies: additiveunwiredmodule, no new dependencies.
- Selected Documentation: fixture signature+resolver correctionexplicit, parent/#128handoff and selectivearchive;1.6.
## 3. Verification ownership
Implementer focusedsemanticRED/GREEN only, noformatter/linter/fullsuite/build; rawstdout/stderr/exit artifacts (no transcribedlogs). Main ownsfixture/git/allacceptance. Staticreviewers runNOtests/probes/scripts/build/lint/format and noedits. Allleaves noagents/worktrees/peercontact. Currentworktreeonly; userwaived perissuehumanreview.
Commands: npm exec --workspace server -- vitest run <workspaceHTTPtests> test/sandbox-resolve.test.ts test/sandbox-facade.test.ts test/workspace-store.test.ts; npm test --workspace server; npm run typecheck --workspace server; npm run build --workspace server; scopednpxbiomecheck; npm run deadcode; npm run dupes; bash scripts/size-guard.sh. Main final actual localhost HTTP probe uses compiled modules; testsuitegreen is not socketabortproof.
