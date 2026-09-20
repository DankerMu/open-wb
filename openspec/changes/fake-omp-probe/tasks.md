## 1. Implementation and evidence

- [x] 1.1 Add real-child contract tests and capture semantic RED against unchanged fake omp; include success, colon/space path, independent errno and non-probe regression.
- [x] 1.2 Extend canonical prompt dispatch and completion with truthful write-before-read probe reporting; no production changes.
- [ ] 1.3 Run focused fake-omp Vitest, server regression coverage, server typecheck, scoped Biome, knip/jscpd/size guards, and actual child smoke; capture Linux same-uid readable in ordinary Ubuntu CI.
- [ ] 1.4 Complete static expanded cross-review, exact-head protected CI and automatic merge; update parent 5.3 and archive only this probe requirement.

## 2. Risk mapping

- Selected Public API / CLI / script entry: real JSONL child frames and parsing assertions, existing protocol regression.
- Not selected Config / project setup: no configuration or toolchain changes.
- Selected File IO / path safety / overwrite: exact destination/content including colon and spaces; test-owned paths; independent ENOENT. Arbitrary writing is deliberate trusted support, not containment.
- Selected Schema / columns / units / field names: exact ordered labels, sorted comma-separated keys, actual identity and HOME/agent checks.
- Selected Auth / permissions / secrets: child-derived identity, key-only environment reporting; Linux same-uid proc read. Cross-uid denial/secret isolation explicit non-goals owned by #131/#132.
- Selected Concurrency / shared state / ordering: reuse serialized prompt queue; write before read, ack before single delta and stop/end; real child cleanup.
- Not selected Resource limits / large input / discovery: no new limits; existing frame and chunk regression retained.
- Selected Legacy compatibility / examples: entire existing fake-omp suite plus server regression; non-probe behavior unchanged.
- Selected Error handling / rollback / partial outputs: both IO failure directions complete normally with actual errno and independent other operation.
- Not selected Release / packaging / dependency compatibility: zero new dependencies or production packaging.
- Selected Documentation / migration notes: parent task5.3 and standalone spec promotion only; retain parent Linux integration obligation and deduplicate probe description at final Epic archive.

## 3. Commands and proof boundary

Focused: `npm exec --workspace server -- vitest run test/fake-omp.test.ts`.
Regression: `npm test --workspace server`; typecheck: `npm run typecheck --workspace server`.
Static: repository Biome/knip/jscpd/size commands scoped where supported, no threshold weakening.
Actual process smoke is separate from Vitest; logs persisted outside repository. CI existing Ubuntu unit-tests must exercise Linux readable assertion without WORKBUDDY_UID_TEST.
Only Main coordinates leaf phases; no leaf peer messaging. Human review waived for this Epic until final complete functional acceptance per issue111 comment5741112841.
