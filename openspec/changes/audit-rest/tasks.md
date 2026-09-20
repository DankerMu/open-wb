## 1. Implementation and verification

- [x] 1.1 Write real createApp+openDb+cookie inject tests first; capture setup/semantic RED honestly for new route; cover member/admin pages, body/header shape, named errors, repeats/empties, unauthorized precedence, precision and generic DB failure.
- [x] 1.2 Add only accounts/index.ts registerAccounts, reuse core query/errors and existing guard; route-local no-store before preParsing, scalar parsing, no app.ts wiring.
- [x] 1.3 Run focused route/HTTP regressions, server coverage/type/build, scoped Biome, knip/jscpd/size and compiled actual HTTP smoke with explicit registration.
- [ ] 1.4 Complete expanded static cross-review and exact-head CI, merge, parent2.3 completion and archive only this endpoint requirement; #128 remains assembly owner.

## 2. Risk mapping

- Selected Public API / CLI / script entry: real GET /api/audit inject and compiledHTTP smoke; exact envelope and query parameters.
- Not selected Config / project setup: no config/toolchain/assembly changes.
- Not selected File IO / path safety / overwrite: no filesystem operation; database read-only assertion below.
- Selected Schema / columns / units / field names: events shape from core, scalar limit conversion, exact before string, repeats/empty invalid; no new schema.
- Selected Auth / permissions / secrets: real login cookies/guard, exact admin versus member, query actor/role cannot override principal, no-store401/400/200/500 and no error detail leakage.
- Selected Concurrency / shared state / ordering: guard precedes handler/query validation; id-page order; no audit mutations, reuse caller-owned db lifecycle.
- Selected Resource limits / large input / discovery: core limit bounds retained, before precision checked through actual HTTP mapping; no new arbitrary cursor length policy.
- Selected Legacy compatibility / examples: existing HTTP/auth tests and app bootstrap untouched; no global hooks/mapper changes.
- Selected Error handling / rollback / partial outputs: four named400cases, other malformed scalar boundaries, actual SQL failure500, audit rows unchanged.
- Not selected Release / packaging / dependency compatibility: no dependency/config change; standard build/smoke verifies new module can be imported.
- Selected Documentation / migration notes: parent2.3 and archive; explicit caller assembly handoff #128, no production availability claim.

## 3. Commands and workflow

Focused `npm exec --workspace server -- vitest run test/accounts.test.ts` plus existing relevant HTTP tests; `npm test --workspace server`; `npm run typecheck --workspace server`; `npm run build --workspace server`; scoped Biome; `npm run deadcode`; `npm run dupes`; `bash scripts/size-guard.sh`.
Real HTTP smoke is a temporary compiled registration harness, not app.inject relabeled. Save source/log outside repo and remove executable after proof.
Expanded fixture required despite suggested compact. Main coordinates phases; leaves never message/wake peers. No human per-issue gate for this Epic; final complete functional acceptance only.
