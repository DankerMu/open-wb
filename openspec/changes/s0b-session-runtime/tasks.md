## 1. Contract and implementation
- [x] 1.1 Obtain expanded fixture review and strict validation before source changes. RuntimeFixtureReview pass after persisted-resume clarification; strict validation exit0.
- [ ] 1.2 Build callable semantic RED at SessionRuntime public boundary before production implementation; retain exact command exit/output outside repo, not import/setup failure alone. **Historically unmet:** initial implementation preceded tests and stub RED followed GREEN; no retrospective TDD compliance claim. See deviation below.
- [x] 1.3 Implement runtime.ts using OmpProcess with injected clock/tokens/spawn and tests for lazy reuse, idle event/prompt reset, token generation, crash callback, resume and failed-start retry. Cover persisted resumePath on a new runtime, preservation across failed startup, and omitted/null cold start.
- [x] 1.4 Prove real EOF/TERM/KILL shutdown with fake child and clock boundary assertions, plus startup/shutdown, native/logical drain, stale generation, overlap/cancellation and prompt completion races.

## 2. Independent acceptance and delivery
- [x] 2.1 Parent runs focused runtime+transport+spawn tests (122/122), server suite/coverage (767/767), make lint, make typecheck, make anti-drift (zero clones), server build and eight independent real-child probe cases; commands exit0.
- [x] 2.2 Qualify lifecycle failure-class oracles against plausible wrong candidates in disposable copies; 15 guard mutants and two historical wrong candidates rejected, reference/restoration37/37 GREEN, source/test identities bound. No tests that only check mock forwarding or implementation fields.
- [ ] 2.3 Expanded correctness / test-evidence+spec-compliance / invariant-state reviews, bounded fix gate and same-SHA CI green.
- [ ] 2.4 Merge #96, update parent task1.5 and archive fixture through a docs-only follow-up PR.

## Risk pack disposition
- Selected Public API / CLI / script entry: prompt iterable/shutdown/callback semantics; 1.3-1.4.
- Not selected Config / project setup: #101 owns parsing/default wiring; runtime consumes idle duration, no config change.
- Not selected File IO / path safety / overwrite: preserve #85 directory/argv contract, regression in 2.1; no new storage operations.
- Selected Schema / columns / units / field names: milliseconds, frozen raw wire terminal/id fields and sessionFile; 1.3-1.4.
- Selected Auth / permissions / secrets: issue/revoke port, no token logging, old-generation revocation race; 1.3-1.4 and 2.2.
- Selected Concurrency / shared state / ordering: one child/turn, startup/shutdown, late callbacks, native/logical exit; 1.4 and 2.2.
- Selected Resource limits / large input / discovery: bounded idle/escalation/drain ownership and cancellation cleanup; 1.4; #95 retains frame limits.
- Selected Legacy compatibility / examples: preserve #85/#95; v18.0.10 ACK/local-only/terminal semantics; 1.4 and 2.1.
- Selected Error handling / rollback / partial outputs: failed startup, crash and protocol error settle without false success; 1.3-1.4; no data migration, revert slice.
- Not selected Release / packaging / dependency compatibility: no dependency, binary or packaging change.
- Selected Documentation / migration notes: current child and parent evidence/ledger; 2.4.

## Project domain risk disposition
- Selected process/child-environment isolation: unchanged allowlisted spawn boundary and real subprocess retirement; 1.3-1.4/2.1.
- Selected cross-service credential boundary: callbacks compatible with #90 and no credentials in observable diagnostics; 1.3-1.4/2.2; real proxy network belongs #98/#102, not this slice.
- Selected offline deployability: use existing local Node fake and no new network/dependencies; 2.1.
- Not selected tenant/sandbox isolation, browser runtime, SQLite catalog, HTTP envelopes, authentication cookies: no changes to these surfaces; preserve existing suite in 2.1.

## Review deviation
Epic #81 user waiver removes only the per-issue human white-box hold. Agent review, CI and final epic functional review remain. Candidate scope is runtime/tests/minimal fake support plus the explicitly authorized process.ts termination-ownership guard; fixture, thresholds, dependencies, CI and parent-owned oracle expectations remain protected.

Initial writer violated test-first order and temporarily replaced production with a stub after GREEN. Authentic replay output is retrospective qualification, not fulfillment of 1.2. This history remains unmet and visible; no user TDD waiver is claimed. The repair used a parent-enforced test-only barrier with unchanged production hashes, genuine semantic RED before source fixes, independent real-child counterexamples and disposable mutation/restoration evidence. This establishes current behavior, not retrospective chronology compliance. Record: https://github.com/DankerMu/open-wb/pull/160#issuecomment-5748415194.

Parent rejected a repair that monkeypatched native kill, released before observed native exit, retained a timer and published a canceled prompt. Those defects were repaired only after new RED regressions. Two initially invalid test observations were corrected against the unchanged contract (captured-error helper resolves; completed idle child remains reusable), and the kill-order oracle records event order rather than assuming minimum OS latency. No acceptance behavior or threshold was relaxed.
