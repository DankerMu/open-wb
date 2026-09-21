## 1. Contract and red baseline
- [x] 1.1 Expanded fixture review PASS with no required additions; strict validation passed. Payload fields inlined before implementation to keep canonical promotion self-contained. 118 reference/frame/store/runtime/config/test identities frozen; internal-tool/public-DB ID boundary explicit.
- [ ] 1.2 A1 paired tests before source (SETUP only), separately authorized A2 callable wrong mapper output semantic RED; preserve standalone original tests before B.
## 2. Pure mapping
- [ ] 2.1 Implement immutable message/request-bound mapping, tool correlation/summaries, noise filtering, first-failure memory, terminal-once and explicit abnormal-failure input; focused GREEN without store/runtime changes.
## 3. Independent acceptance and delivery
- [ ] 3.1 Parent compiled sequence/immutability probes, semantic mutants/restoration/stability, fullserver coverage/types/build/Biome/anti-drift/OpenSpec; source/reference identities intact.
- [ ] 3.2 Expanded correctness/test-evidence+spec/invariant-state review, bounded fix gate, exact-head CI and source PR merge.
- [ ] 3.3 Separate docs-only canonical pure-mapping promotion/archive; parent task3.3 checked without claiming Supervisor/SSE/local-only assembly complete.
## Core risk packs
- Public API selected: pure state/result and ChatEvent identity-phase types→1.1/2.1/3.1.
- Config/project setup not selected: no environment, build or dependency change.
- File IO/path not selected: mapper performs no IO; upstream read-only references frozen.
- Schema/fields/units selected: message numeric ID, string toolCallId,120 Unicode codepoints and normalized envelope→2.1/3.1; no migration.
- Auth/permissions/secrets not selected: trusted bound inputs, no credentials/auth endpoint; unrelated request identities still covered under state/order.
- Concurrency/state/order selected: immutable isolated prompts, interleaved steps, failure retention/terminal fencing/exact prompt correlation→2.1/3.1.
- Resource/large input selected: bounded summary output/no accumulated answer; no timers/handles; logical-frame bound belongs decoder→2.1/3.1.
- Compatibility selected: frozen RPC optional terminal marker, no runtime/store API edits, #100 explicit binding/local-completion responsibilities→1.1/3.1.
- Error/rollback selected: assistant error/aborted, matching async failure, explicit abnormal exit and fallback, error-before-terminal exactly once→2.1/3.1; no storage rollback here.
- Release/packaging selected: actual compiled module, no dependency, same-SHA CI→3.1/3.2.
- Documentation selected: pure slice promotion and downstream boundary synchronization→1.1/3.3.
## Project domain packs
Selected session lifecycle/identity, server-web event compatibility and offline pure module→2.1/3.1. Not selected tenant/sandbox, process environment/spawn, SQLite migration/catalog, HTTP authentication/envelopes, browser navigation/storage, cross-service network: unchanged or owned by subsequent assembly, no runtime behavior claim.
## Governance
Current checkout only, one writer, no new worktree. Writer owns events.ts+paired tests, parent owns fixture/probes/acceptance. Upstream source read-only and not copied. Writer must not read parent probes/qualification/baseline evidence; no config/oracle weakening. A1/A2/B separately authorized; tests frozen before B, source-only implementation. Skip writer formatter/lint/types/build/fullsuite/git/nested agents; parent validates. Reviewers read-only leaf, no tests/probes/validation/nested delegation. User waived per-issue human review, not agent review/CI or final Epic functional review.
