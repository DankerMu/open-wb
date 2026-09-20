## 1. Implementation

- [x] 1.1 Add semantic RED real migrated SQLite audit tests covering role-scoped pages, JSON/clock/defaults, invalid parameters and cursor precision, failed emits; preserve existing error behavior tests. Require ≥51 visible member rows interleaved with others for default50/pagination. Precision oracle MUST call exported query() on audit_events in isolated openDb(':memory:') with explicit ids9007199254740991 and9007199254740992: exact before='9007199254740993' propagates native ERR_OUT_OF_RANGE, not bad_request or a rounded safe-only page. Separate ordinary-row before='9223372036854775808' returns eligible rows. Scratch SQL is platform documentation only; no bigint public-ID expansion.
- [x] 1.2 Implement canonical core/audit emit/query; no new routes/callers/migration.
- [x] 1.3 Atomically relocate HttpError/codes/messages into core/errors, migrate all references with LSP assistance, remove old exports; HTTP statuses/mapping stay http. Update architecture and parent error ownership notes; do not add #84/#115 codes.
- [x] 1.4 Run focused tests, server coverage/type/build, scoped Biome, knip/jscpd/guards and actual compiled smoke; expanded static cross-review and exact-head CI. Three seats clean; CI35504605570 success on 57d448e2ae49c4883ed0027f2f16d168ae4b4240.
- [x] 1.5 Merge automatically, update parent2.2 and archive only implemented audit/error ownership requirements; hand off #84/#115/#124. PR #163 merged; parent Epic remains active.

## 2. Risk mapping

- Selected Public API / CLI / script entry: emit/query contract and every shared-error consumer; focused tests + existing HTTP suites and typecheck.
- Not selected Config / project setup: no runtime config changes.
- Selected File IO / path safety / overwrite: persisted SQLite single INSERT failure atomicity; real migrated :memory: oracle; filesystem path operations are not in scope.
- Selected Schema / columns / units / field names: camelCase output, epochms, JSON round-trip, nullable workspace, id cursor; no schema changes.
- Selected Auth / permissions / secrets: exact admin role, tenant predicate on every page, forged HTTP errors remain generic; real DB and HTTP suites.
- Selected Concurrency / shared state / ordering: synchronous single insert, id-order not timestamps, interleaved actors and before paging; no async transaction layer.
- Selected Resource limits / large input / discovery: limit1..200/default50; canonical decimal cursor precision beyond JS-safe and SQLite64 boundaries, no lossy conversion.
- Selected Legacy compatibility / examples: exact five-code error messages/statuses/envelopes and all class/type callers preserved by LSP cutover + regression suites.
- Selected Error handling / rollback / partial outputs: bad_request canonical identity; JSON/FK failure no extra rows; existing mapper unknown/forged errors unchanged.
- Not selected Release / packaging / dependency compatibility: no dependencies; standard server build/smoke verifies existing compiler packaging.
- Selected Documentation / migration notes: user-approved error ownership change recorded in architecture and parent; #84/#115 issue comments already notified, finalize paths after merge.

## 3. Verification commands and authority

Focused new audit/error tests plus existing app/auth HTTP suites via server Vitest. `npm test --workspace server`; `npm run typecheck --workspace server`; `npm run build --workspace server`; scoped Biome; `npm run deadcode`; `npm run dupes`; `bash scripts/size-guard.sh`.
Actual compiled audit smoke uses real migrated in-memory DB, emits interleaved accounts and observes visibility/pagination/error identity. Do not count that as production HTTP audit endpoint proof (#124).
Source changes only by implementer; Main owns fixture and git. Static reviewers run no commands/probes. Human per-issue review waived for Epic111; user explicitly approved this widened error migration at issue122 comment5748746011.
