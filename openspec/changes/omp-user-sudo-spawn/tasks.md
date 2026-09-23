## 1. Implementation and proof
- [x] 1.1 Config/spawn semantic RED01 then GREEN; four invalid real-entry cases RED03 then GREEN; finalnewline and32/33 boundaries covered. Node warning is separate from the exact one-line generic application record. Initial regex rationale corrected in design, behavior unchanged.
- [x] 1.2 Complete cold/resume direct/sudo argv/env/cwd/stdio/shell captures pass under contaminated parent, optionalenv absent retained. Tests pair missing/explicitundefined and full sudo prefix; token values never argv.
- [x] 1.3 Config/server/supervisor/runtime/process propagation and idle reopen covered; real authenticated prompt captures sudo/direct, immediate exit yields agent_unavailable and token revocation without fallback. Main corrected unintended generic user option to contractual ompUser using delegated LSP rename; no alias.
- [x] 1.4 Main final eight gates exit0: scopedBiome/type/focused94/8/fullserver1150/62(lines92.16%,branches88.24%)/build/knip/dupes0/size. Actual compiled production entry: four invalid values exit1/no stdout/no dirs/listener, one generic app record plus NodeSQLite warning; actual HTTP auth/session/prompt intercepted native spawn in sudo/direct modes, exactprefix/env checks and harmless childexit7→502, one spawn only; both server shutdowns0. No host sudo/uid proof. Readiness fixed type/clone/size issues, not thresholds. Executable probes/tempDB removed, raw logs/recipes retained.
- [ ] 1.5 Independent expanded review, bounded fixes, exacthead CI, public evidence/deviations, merge/selectivearchive and parent/#126/#131 handoff.
## 2. Risk mapping
- Selected API/process: spawn options/capture and realprompt boundary1.2/1.3.
- Selected Config: canonical parser/entry effects/propagation1.1/1.3/1.4.
- Selected FileIO: invalid before mkdir/DB/models1.1/1.4; permissions explicitly#126 non-goal.
- Not selected Schema: no persistence/schema/unit changes.
- Selected Auth/secrets: allowlist/no argv values1.2/1.3; realuid/proc/PAM#131/#132 non-goal.
- Selected Concurrency/lifecycle: generations/reopen/immediateexit/cleanup1.3.
- Not selected Resource limits: no new discovery/buffering limits beyond username bound.
- Selected Legacy: exact unset S0b call/cold-resume1.2/1.4.
- Selected Error: four generic stderr records and nofallback1.1/1.3/1.4.
- Not selected Release/dependencies: no binaries/dependencies/CI/sudoers changes.
- Selected Docs: explicit propagation scope, permission deferral and selective archive1.5.
## 3. Ownership and commands
Main owns fixture/git/acceptance. Single implementer runs focused vertical RED/GREEN only; skip formatter/linter/build/project-wide tests. Reviewers static only, no execution/edits/agents/worktrees/peercontact. Current worktree only; user waived per-issue human approval, finalEpic acceptance human.
Main commands: npm exec --workspace server -- vitest run test/server-config.test.ts test/omp-process.test.ts plus affected entry/runtime/assembly tests; npm test --workspace server; npm run typecheck --workspace server; npm run build --workspace server; scoped npx biome check; npm run deadcode; npm run dupes; bash scripts/size-guard.sh. Real compiled entry/process capture is independent acceptance, never invoke host sudo.
