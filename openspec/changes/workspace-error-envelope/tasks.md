## 1. Implementation and evidence

- [x] 1.1 Update existing seven-code matrices to eleven and six-owner behavioral tests; add focused real HTTP workspace parser boundary tests as needed; run and preserve behavioral RED before source changes.
- [x] 1.2 Add four canonical messages/statuses and two exact POST owner identities, keep current classification/guard/cache behavior and auth vocabulary unchanged; update all affected exhaustive consumers.
- [x] 1.3 Verify targeted tests, server coverage/type/build, scoped Biome, knip/jscpd/size, compiled realHTTP smoke; no production workspace route registration.
- [ ] 1.4 Expanded static cross-review, bounded gate and exact-head CI; automatic merge, parent3.1 update and slice archive; unblock #117/#123/#125 afterward.

## 2. Risk mapping

- Selected Public API / CLI / script entry: eleven exact envelopes and six-owner observable mapping; actual HTTP test routes/smoke.
- Not selected Config / project setup: no config or tooling changes.
- Not selected File IO / path safety / overwrite: no user filesystem operations; future sandbox/workspace code out of scope.
- Selected Schema / columns / units / field names: eleven typed code/status/message pairs and AuthErrorCode remains four; exhaustive typecheck + behavior.
- Selected Auth / permissions / secrets: genuine constructor versus forgery/schema errors, generic500 non-disclosure, guard-before-parser401, no cache/cookie spillover.
- Selected Concurrency / shared state / ordering: parser rejection before handler side effects and authentication before body parser; existing runtime unchanged.
- Selected Resource limits / large input / discovery: real oversized body error normalized only for owner routes; no change to existing limits.
- Selected Legacy compatibility / examples: existing seven codes/four owners/fallback404 and auth no-store behavior retained in regression suites.
- Selected Error handling / rollback / partial outputs: missing owners RED; wrong methods/lookalikes/forged errors500; all new status mappings exact; no catch-all semantic coercion.
- Not selected Release / packaging / dependency compatibility: no dependency change; normal build + compiled smoke exercise module packaging.
- Selected Documentation / migration notes: current ownership split + #84 promoted baseline; parent3.1 bookkeeping and final-archive dedup, no product route availability claim.

## 3. Verification and workflow

Targeted server Vitest app/auth-lifecycle/auth-request-errors plus any new focused workspace-http-errors test. `npm test --workspace server`; `npm run typecheck --workspace server`; `npm run build --workspace server`; scoped Biome; `npm run deadcode`; `npm run dupes`; `bash scripts/size-guard.sh`.
Private policy tested by behavior, never exporting Set or grepping production source. Keep all files <=800 formatted lines. TDD test scaffolds are temporary only; compiled HTTP harness outside repo removed after proof.
Main owns OpenSpec/git; leaves never message or wake peers. Epic111 human review waiver remains in force; only final complete functional acceptance is human-gated.
