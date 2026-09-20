## 1. Implementation and proof
- [x] 1.1 Add facade scenarios using stub ports and real resolver/filesystem. Implementer reports incremental semantic RED/GREEN after initial bulk drafting; logs01–09 are transcribed observed output, not raw captures. Main independently captured focused GREEN and smoke mutant rejection, not claimed as historical TDD.
- [x] 1.2 Implement only synchronous core-owned facade and canonical audit/error composition; no feature imports, duplicated resolver/permission code or async void port.
- [x] 1.3 Focused22 tests and fullserver887/39 pass; server type/build/Biome/knip/dupes/size gates exit0. Main compiled real-filesystem smoke, swallowed-root/audit/unaudited-denial scratch mutants, async-port negative typecheck and explicit import-boundary inspection completed.
- [ ] 1.4 Expanded independent static review, exact-head CI, automatic merge and facade-only archive with parent1.3/downstream handoff.

## 2. Risk mapping
- Selected Public API / CLI / script entry: synchronous resolve string result, root/audit port shape; focused tests + tsc + compiled smoke.
- Not selected Config / project setup: no config/threshold/tooling changes.
- Selected File IO / path safety / overwrite: real root and symlink, null precedence, unchanged filesystem on rejection; facade mkdir mode behavior. Existing vector tests remain canonical.
- Selected Schema / columns / units / field names: exact rejection event actor/workspace/kind/title/rawdetail; derive event type from core/audit, no DB migration.
- Selected Auth / permissions / secrets: foreign/missing root indistinguishable not_found before path validation; no feature import, no unaudited sandbox_denied.
- Selected Concurrency / shared state / ordering: synchronous emit completes before denial; thrown audit error identity; no async/void acceptance. No TOCTOU claim.
- Not selected Resource limits / large input / discovery: no new enumeration/body IO; inherited resolver unchanged.
- Not selected Legacy compatibility / examples: new facade has no callers; existing resolve/dirs preserved by their tests.
- Selected Error handling / rollback / partial outputs: rootOf/audit throws propagate, no success/event on null, no filesystem effects on rejection.
- Not selected Release / packaging / dependency compatibility: no dependencies or package changes; normal build sufficient.
- Selected Documentation / migration notes: facade-only spec delta, parent1.3 after merge; #125/#127/#128 retain production integration.

## 3. Commands and phase discipline
`npm exec --workspace server -- vitest run test/sandbox-facade.test.ts test/sandbox-resolve.test.ts test/sandbox-dirs.test.ts`; `npm run typecheck --workspace server`; `npm test --workspace server`; `npm run build --workspace server`; scoped Biome; `npm run deadcode`; `npm run dupes`; `bash scripts/size-guard.sh`.
Main performs explicit static import-boundary inspection instead of permanent grep-source unit test and records deviation; no feature dependency allowed. Main compiled smoke is an actual helper invocation on temp files, not the test suite relabeled.
Main owns fixture/git and acceptance commands; implementer owns source/tests with focused RED/GREEN only. Frozen static reviewers never execute commands or contact peers. User waived perissuehumanreview for Epic111; final functional acceptance remains human.
