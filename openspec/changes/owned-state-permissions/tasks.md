## 1. Implementation and proof
- [x] 1.1 Actual-entry cold/existing0644 main/WAL/SHM and before-open observation RED(null versus0600)→GREEN; marker data/:memory: preserved, inherited0077 exercised. Main scratch late-main and missing-sidecars mutants each semanticRED1, baseline/restored0. Live three-file0600 independently observed by Main service smoke.
- [x] 1.2 Spawn and earlier model producer modeRED0755→GREEN2770, new levels/existing0755/unchanged parentumask covered. Main earlier-agent-default mutant semanticRED1; actual authenticated prompt created seven shared levels2770. Existing preparation-error tests retain failure/no-spawn assertions.
- [x] 1.3 Main/sidecar chmod denial tests pass generic exit1 and retained data. Original denial REDs timed out waiting for exit (not accepted as semantic-red proof). Main independent native openEACCES/fchmodEPERM probes exit1/no state/listener, and fchmod trace opened→denied→closed proves acquired descriptor cleanup. No host sudo.
- [ ] 1.4 Main fixpass1 eight gates exit0: scopedBiome/type/focused36/3/fullserver1165/62(lines91.56%,branches88.04%)/build/knip/dupes0/size. Repeated actual service auth/session/prompt200/201/202, three DB modes0600, seven shared modes2770, SIGTERMexit0/portrefused. Round1 three seats complete; fresh re-review and exact-head CI pending.
- [ ] 1.6 Round1 fixpass implemented: existing nonregular main/WAL fail without mode/content mutation; DB parent0755 preserved; child0777 observed at SQLite-open boundary with file0600. Main native directory RED0755→0600 now GREEN0755 retained. Exact-test scratch baseline4pass0 / forcedparent0700 RED1 / dropfchmod RED1 startupfailure / dropregular-guard RED1 in both independent paths / restored4pass0. Native hooks moved once to existing startup helper for800-line bound; common failure assertions deduplicated without reopening DB or reordering physical checks. Fresh review/CI required.
- [ ] 1.5 Publish deviations/evidence, merge, selective archive only private-state requirement and parent5.2/#131 handoff.

## 2. Risk mapping
- Selected API/entry:1.1/1.3/1.4 actual compiled entry and unchanged public APIs.
- Selected Config:1.1 :memory:/configured path, no new settings, preserved invalid-config-before-effects.
- Selected FileIO:1.1/1.2 real mode/order/data, trusted deployment paths; TOCTOU non-goal.
- Not selected Schema: no schema changes, preserve existing data1.1.
- Selected Auth/secrets:1.1/1.2 private files/models contents; real uid/proc is #131 non-goal.
- Selected Ordering:1.1 beforeopen,1.2 models-first creator,1.3 cleanup.
- Not selected Resource limits: bounded three DB files and four directory targets; no discovery or new buffering.
- Selected Legacy:1.1 memory/data,1.2 existing dirs/argv/env/umask,1.3 startup lifecycle.
- Selected Error/partial outputs:1.3 native errors/handles/port cleanup; no deletion of existing data.
- Not selected Release/dependencies: no CI/dependency or packaging changes.
- Selected Docs:1.5 promoted slice/parent coordination and proof limits.

## 3. Ownership and commands
Main owns fixture/git/acceptance. One implementer owns source/tests and vertical focused TDD only; skip formatter/linter/build/project-wide tests. Reviewers static, no execution/edits/peercontact/nesting/worktrees. Current checkout only.
Main: scoped biome check; npm run typecheck --workspace server; npm exec --workspace server -- vitest run affected-tests; npm test --workspace server; npm run build --workspace server; npm run deadcode; npm run dupes; bash scripts/size-guard.sh. CI is independent final acceptance; no protected workflow/threshold changes.
