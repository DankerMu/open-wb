## Context
#84 originally named a combined http error table. #122/PR163 atomically moved HttpError/HttpErrorCode/messages to core/errors; latest issue comments explicitly require that ownership. LSP references confirm the canonical core map feeds the HTTP mapper and constructor.

## Goals / Non-Goals
Add exactly session_busy(409,会话正在生成，请稍候) and agent_unavailable(502,Agent 运行时不可用); expand parser owners from two to four.
No new product routes, schema validators, proxy bearer logic, body limits, global cache hooks, dependencies or config.

## Decisions
T1 ownership: extend core messages and exhaustive HTTP statuses; never recreate a combined table or shim in http.
T1 cache boundary: issue mentions no-store but existing auth-request-errors test654-675 requires non-auth401/204 NOT inherit auth no-store. #122 says preserve no-store behavior. Keep cache policy route-owned; exercise all seven envelopes through an existing real auth route/error-injection seam with its actual no-store hook, not a fabricated header or global mapper policy.
T1 parser boundary: use matched routeOptions.url, POST and genuine Fastify constructor identity. Extend the private owner set only. Do not export mutable/private state merely for testing.
Tests drive existing handleHttpError seam for future route identities; use real Fastify CTP constructor/captured parser errors. Production future routes remain absent.
The owner set's exact four literals is review evidence; behavior checks all four and rejects nonPOST, concrete/raw session IDs, trailing-slash/prefix lookalikes and unowned registered identities. No source-text assertions.
Remove the existing test that only asserts its own test-table length/type-boolean echoes; retain real seven-code envelope coverage and compile-time exhaustiveness without re-pinning the tautology.

## Governing invariant
Only explicit canonical typed errors or genuine allowlisted parser errors owned by the exact POST matched identity acquire semantic codes; unknown/forged errors remain sanitized generic5xx, and cache/auth side effects remain owned by existing routes.

## Sibling surfaces
core/audit and auth/guard callers use the same canonical HttpError identity; HTTP mapper owns status, parser classification and generic fallback. Existing login/logout parser/no-store/cookie behavior, API catch-all/unmatched misses and registered unowned errors must remain unchanged.
Existing server/test/app.test.ts ERROR_CASES drives real createApp envelope/redaction routes. Add session_busy409会话正在生成，请稍候 and agent_unavailable502Agent 运行时不可用 there as well as auth-lifecycle's map; include all three existing test files in RED/GREEN. ReadonlyArray<HttpErrorCode> is not exhaustive by itself.
Future #98/#99 routes consume the new identities; their auth/bodylimit/sideeffects remain their own evidence obligation, not claimed here.

## Required evidence
Before source edits, updated tests must fail semantically for missing409/502 and future-route parser500 instead of400. Existing callable mapper needs no scaffold.
After implementation, seven exact envelopes including no-store on an existing policy-owning route, allfour parserowners400, wrongmethod/lookalike/forged/unowned500, fallback404 and guard401 staygreen.
Parent focused suite (test/app.test.ts, test/auth-lifecycle.test.ts, test/auth-request-errors.test.ts) + fullserver coverage + lint/types/drift + strictOpenSpec; independent realHTTP mapper probe; disposable wrong candidates remove a code/status/owner or broaden trust and must be rejected.

## Risks / Trade-offs
No-store issue shorthand could be misread as a global policy: preserve explicit existing negative contract and use real route-owned hook for evidence.
Future endpoints are not yet mounted: mapper seam plus no unintended route registration, not fake end-to-end bearer claims.
Rollback is ordinary revert before dependent routes merge; no persistent data migration.
