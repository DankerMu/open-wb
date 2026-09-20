## 1. Fixture and RED barrier
- [x] 1.1 Review expanded fixture and pass strict validation; ErrorFixtureReview PASS after explicit app.test.ts sibling inclusion; strict validation exit0. Freeze source/config/fixture hashes before tests-only writer.
- [ ] 1.2 Writer changes existing tests only: additive two-row ERROR_CASES in server/test/app.test.ts, seven-code auth-lifecycle map and auth-request-errors boundaries. Run those three files and record semantic RED against frozen mapper/core; STOP for parent authorization. Preserve caller behavior and remove only the self-asserting table-length/type-echo test, not observable guarantees.

## 2. Atomic implementation
- [ ] 2.1 Extend canonical core messages + HTTP statuses and private four-owner set; update directly affected comments, never add product routes or cache policy.
- [ ] 2.2 All three focused files GREEN for seven envelopes (including existing app.test.ts /api/test-errors/* routes), no-store on policy-owning real route, exact owner classification and sanitized negative cases; no source-text/set-export assertion.

## 3. Acceptance and delivery
- [ ] 3.1 Parent runs test/app.test.ts, test/auth-lifecycle.test.ts and test/auth-request-errors.test.ts, fullserver coverage, make lint/typecheck/anti-drift and strictOpenSpec; independent HTTP mapper probe and disposable wrong-candidate rejection/restoration.
- [ ] 3.2 Expanded correctness / test-evidence+spec-compliance / integration review, bounded fix gate, same-SHA CI, automatic sourcePR merge.
- [ ] 3.3 Correct parent ownership references/task2.2 and archive through docs-only follow-up; preserve canonical sibling requirements.

## Risk packs
- Selected Public API: exact seven envelope statuses/messages/body shape and route policy; 1.2/2.2/3.1.
- Not selected Config, File IO/path safety, Release/dependencies: no changes to those mechanisms.
- Selected Schema/field names: additive error vocabulary, private exact owner identities, exhaustive typed map; 2.1/2.2.
- Selected Auth/permissions/secrets: preserve guard precedence, forged-error rejection, generic body redaction and existing route-local no-store/cookie boundaries; 2.2/3.1. No credential injection/proxy authorization implemented.
- Selected Concurrency/shared-state/ordering: only existing guard-before-parser/error ordering is preserved; 2.2 existing suite. No new async state.
- Selected Resource limits: existing genuine Fastify body-too-large classification stays400 only on owned routes; 2.2. New route limits are #98/#99 non-goals.
- Selected Legacy compatibility: all existing five codes and old auth/fallback/unowned behavior unchanged; 2.2/fullserver.
- Selected Error handling/partial outputs: unknown and forged errors staygeneric500 without originalmessage, typed envelopes do not gain extra fields; 2.2/3.1.
- Selected Documentation: #122 ownership correction, canonical delta and parent ledger; 3.3.

## Project domain risk packs
- Selected authentication/session and public HTTP envelope: existing guard/cache/cookie regressions retained; 2.2/fullserver.
- Not selected sandbox/process/childenvironment, cross-service network, offline deployment, SQLite schema, browser runtime: no implementation change; future route/proxy tests belong owning issues.

## Governance
Currentworktree only, one writer, no newworktree. Leaf reviewers run no commands/tests/probes; writer onlyfocusedRED/GREEN. Fixtures/config/thresholds/CI protected. User Epic81 per-issue humanreview waiver remains; final functionalreview notwaived.
