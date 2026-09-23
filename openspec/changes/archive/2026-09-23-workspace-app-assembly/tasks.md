## 1. Implementation and evidence
- [x] 1.1 Actual createApp tracer RED404 instead of200/201 then GREEN; configured root, lazy owner dir, foreign-admin404/no extra audit, owner403/persisted canonical audit and caller DB lifetime covered. Seed corrected from Main's mistaken u2 note: lisi=u3/admin; zhangsan=u1/member.
- [x] 1.2 Compiled startup REDfive instead ofseven then GREEN; observed call-through registration order linked to actual record; config tests unchanged and pass, #204 sinks and existing lifecycle regressions preserved.
- [x] 1.3 Duplicate accounts/workspaces registrations and synthetic owned POST routes removed, real16KiB/parser/no-store/native500/foreign404 retained. Before-ready onSend native preview-error case still passes. Two clone blocks deduplicated into existing/private test helpers, no production bypass or threshold change.
- [x] 1.4 Main eight gates exit0: scopedBiome/type/focused88/7/full1176/63(lines91.68%,branches88.12%)/build/knip/dupes0/size, OpenSpec slice+parent strict0. Native compiled smoke exact seven modules,401/200/201/foreign404/owner403, persisted sandbox.reject and lazy roots, supervisor exit0/TCPrefused. Initial smoke lacked #125 deployment base and correctly500; provisioned canonical base2770 then passed without source edits. Isolated exact-test baseline3pass0 / missingregistrationRED1 / reversedorderRED1 / wrongrootRED1 / unpersisteddenialRED1 / restored3pass0; all executable scratch/DB/snapshots removed, raw evidence retained.
- [x] 1.5 Round1 correctness/evidence+spec/security all clean, zero fixpasses; exact5ad2f29 CI35820697491 all8green (server1176/63,web278/12,pytest1). PR223 mergedb457bb6; final summary https://github.com/DankerMu/open-wb/pull/223#issuecomment-5789664183. Selective archive promotes two startup/assembly requirements only; parent3.6 complete. Historical parser/preview wording tracked separately in#225 for parent archive; no runtime finding.

## 2. Risk mapping
- Selected API/entry:1.1/1.2 real endpoints and module output,1.4 compiled smoke.
- Selected Config:1.1 injected runtime root,1.2 server-config regression unchanged unless contract changed. No extra config.
- Selected FileIO:1.1 root laziness/create/foreign404/deny paths; #126 permissions preserve, no new path policy.
- Not selected Schema: no schema changes;1.1 same real DB/audit consumer verifies identity.
- Selected Auth/secrets:1.1 owners/403 audit/401; existing token and sink tests regression; realuid#131/#132 non-goal.
- Selected Ordering:1.2 real registration vs record, reconciliation and #204 callbacks preserve;1.3 hook placement before ready.
- Not selected Resource limits: no new limits; real16KiB parser contract preserved1.3.
- Selected Legacy:1.2/1.3 all factory consumers and native lifecycle coverage, no registration shims.
- Selected Error/partial:1.1 denial persistence,1.3 parser/500/native stream behavior;1.4 full regression.
- Not selected Release/dependencies: no new CI/dependencies/package changes.
- Selected Docs:1.5 selective main-spec promotion and parent coordination; no old delta overwrite.

## 3. Ownership and commands
Main owns fixture/git/acceptance. Single implementer owns source/tests and focused vertical TDD only; skip format/lint/build/project-wide suites (compile inside existing focused entry test allowed). Reviewers static only, no execution/edits/peercontact/nesting/worktrees. Current checkout only.
Main: scoped biome; npm run typecheck --workspace server; npm exec --workspace server -- vitest run affected-tests; npm test --workspace server; npm run build --workspace server; npm run deadcode; npm run dupes; bash scripts/size-guard.sh; openspec validate workspace-app-assembly --strict --no-interactive. Protected exact-head CI final gate. No acceptance threshold or test-discovery changes.
