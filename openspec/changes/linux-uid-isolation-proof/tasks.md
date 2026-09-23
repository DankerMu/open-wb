## 1. Fixture and oracle qualification

- [x] 1.1 Independent expanded fixture review and strict validation; confirm single-test-file boundary, canonical executable and no GitHub-job/downgrade closure claim.
- [x] 1.2 Declare pre-merge Linux container identity/provisioning and negative-oracle failure classes; preserve original/snapshot evidence outside repo.

## 2. Linux-only test

- [x] 2.1 Add one opt-in Linux test using real SessionRuntime, native sudo, canonical fake probe/TokenRegistry/collectPrompt; all effects inside selected test; malformed/missing prerequisites fail.
- [x] 2.2 Assert uid separation, open-set whitelist subset/four sentinel absence, exact home/agent with space/colon paths, EACCES, wrote, canonical parent tree listing and file contents; never PATH/closed-set env assertion.
- [x] 2.3 Own shared temporary-root permissions, env restoration, real shutdown and cleanup on failure; no host provisioning/src/config changes.

## 3. Independent verification and delivery

- [x] 3.1 Main runs actual Ubuntu container as nonroot runner via sg workbuddy with native sudoers and secure-path Node; preflight HOME/capability/identity, then selected Linux test non skipped GREEN and no omp-owned residual process before container teardown.
- [x] 3.2 In disposable copies qualify direct-uid, credential-leak, HOME/agent and write/list failure classes as semantic RED, restore original GREEN. No product source edits or oracle weakening.
- [x] 3.3 Verify macOS and Linux without opt-in report skipped, macOS opt-in still skipped, and opt-in misconfiguration fails; run unchanged full server coverage, typecheck, scoped Biome/knip/jscpd/guards.
- [ ] 3.4 Freeze head, expanded correctness / test-evidence+spec-compliance / invariant-state static review, bounded fix gate and exact-head CI; ordinary CI skipped explicitly not treated as Linux-isolation proof.
- [ ] 3.5 Merge and selectively archive this child; hand off executable path, sharedgroup/Node/sudo prerequisites and real Linux evidence to #132, keep #134/downgrade gate open and parent changes active.

## Risk pack mapping

- Selected — Public API / CLI / script entry: 2.1/3.1 real runtime→sudo→canonical probe; production argv contract reused, not reimplemented.
- Selected — Config / project setup: 1.2/3.1 provisioned opt-in prerequisites in disposable container; no repo CI/config edits or host sudo.
- Selected — File IO / path safety / overwrite: 2.2/2.3/3.1 test-owned root2770, same sharedgroup, child write + parent list/content; no existing-path chmod/chown.
- Not selected — Schema / columns / units / field names: no persisted schema/API format change; existing probe labels consumed unchanged.
- Selected — Auth / permissions / secrets: 2.2/3.1/3.2 real uid/proc/sentinel and open-set oracle, no secret-value logging.
- Selected — Concurrency / shared state / ordering: 2.3/3.1 real terminal drain/shutdown before delete, env restored, no orphan child hidden by container exit.
- Selected — Resource limits / large input / discovery: 2.1/2.3/3.3 default discovery with explicit skip and bounded real-child lifetime; no config filtering.
- Selected — Legacy compatibility / examples: 3.3 unchanged full server suite, non-Linux/unset skip no module-scope effects; existing helpers reused.
- Selected — Error handling / rollback / partial outputs: 2.3/3.2/3.3 invalid opt-in fails, failed isolation reds and cleanup runs; no pass-with-no-tests or swallowed failure.
- Not selected — Release / packaging / dependency compatibility: no repository dependency/packaging changes; external Ubuntu/Node digests recorded for evidence only.
- Selected — Documentation / migration notes: 3.5 child-only archive, #132/#134 ownership and CI-versus-container evidence boundaries remain explicit.

## Qualification evidence
- First real run exposed setuid TMPDIR loss; user approved independent #239 correction, merged PR240 and archive241. This child resumes on933a482 without dropping any assertion or adding production changes.
- Final oracle SHA256: `c3f9667053c76521276d5205cd85e18deae515109727901954a0ca280bf393d6`.
- Ubuntu24.04 aarch64 / Node24.13.1, nonroot runner2201→sudo→omp2202, sharedgroup2200, umask022: baseline1pass0skip; seven semantic faults all RED then restored GREEN (same uid, canary leak, HOME substitution, agent substitution, shared write denial, false write report/missing file, readable proc). All runs report zero omp processes before container teardown; two separate stability trials pass.
- Final macOS unset/opt-in and Linux unset/zero flag each skip; Linux opt-in without OMP_USER fails. Default server discovery1213pass+1skip (69files), lines91.49%/branches87.52%; typecheck/lint/anti-drift exit0, zero clones. Skips are not isolation proof.
- Pre-review test repairs: optional getuid narrowing for Node types; coherent helpers keep complexity≤15; canonical single-update probe assertion replaces a duplicated generic collector. A refactor chmod-failure ownership leak was reproduced and fixed by recording ownedRoot before helper work; injected failure now leaves zero owned roots and still propagates the error. No guard/config threshold was weakened.
