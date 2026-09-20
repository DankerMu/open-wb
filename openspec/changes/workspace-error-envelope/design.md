## Context

Change surface: canonical core/errors + http/errors and tests. User-approved #122 ownership split is already merged; #84 extended it to seven codes. Follow current files, not stale issue paths.
Must preserve: sole HttpError identity and no old HTTP re-exports; existing seven statuses/messages; auth-only four-code vocabulary; real constructor-backed CTP allowlist; validation-shaped/forged programmer errors generic500; guard-before-parser and matched identity rather than raw URL; fallback404; route-owned no-store/no clear-cookie leakage.
Governing invariant: only a canonical typed error or genuine allowlisted parser error at one of six exact POST matched identities becomes a semantic error; unrelated programmer errors remain generic500 without data exposure.
Sibling surfaces: core message map/type, exhaustive http status map, private owner set, routeOwnerResult, constructor discriminator, handle/sendHttpError, auth mapper tests, app fallback tests and future workspace endpoints.

## Decisions

- Extend core HTTP_ERROR_MESSAGES and http HTTP_ERROR_STATUSES together. New messages: sandbox_denied=目标路径不在你的沙箱内，操作已拒绝; conflict=同名资源已存在; preview_too_large=文件过大，无法预览; preview_unsupported=该类型不支持预览. No auth error additions.
- Add only the two matched route patterns to the private owner Set; the existing POST check remains authoritative. Do not export policy merely for tests or classify by path prefix/raw URL.
- The issue's shorthand parse/validation does not add FST_ERR_VALIDATION: inherited spec explicitly excludes it. Handwritten validators may throw canonical bad_request; only four existing genuine CTP constructors are recognized automatically.
- Reuse existing ALL_OWNERS mapper tests, error matrices and production auth no-store seam. New workspace HTTP tests may register test-only route stubs with real Fastify parser/errors and real session cookie; handlers count calls to prove parser precedes effects. Such routes are not shipped and do not claim workspace functionality.
- Existing test files are 779–785 lines. Keep <=800 without deleting behavioral coverage or squeezing formatting; a focused workspace-http-errors.test.ts for new real-HTTP cases is permitted, reusing canonical helpers. Existing matrix updates remain in place; any moved helper has one implementation.
- No cache-policy expansion: shared sendHttpError stays header-neutral; eleven codes tested through an existing no-store-owning auth route. Unowned routes must not inherit auth cache/clear-cookie. Future workspace routes own their cache hook.

## Evidence and risks

RED must expose missing four code definitions/statuses and missing parser owners, not only TypeScript compile failures. Test runner can exercise new cases before production table changes; save behavioral failure output separately from type errors.
Positive: all eleven exact status/message/envelopes; six genuine-parser POST owners; both new real registered workspace paths including parametric id matching. Negatives: nonPOST, lookalikes, concrete raw path versus matched parameter pattern, forged error/code/status, genuine schema-validation still500; unauth malformedbody401; handlers not invoked by parser failures.
Run focused app/auth/error tests, server coverage/type/build and static gates; actual compiled localhost HTTP test harness exercises new statuses and parser policy without modifying app.ts. No claim of product workspace availability.
No migrations/rollback state; revert atomic tables/owner additions/tests if needed. Parent final archive must preserve promoted #84 provenance/cache semantics and not overwrite this requirement with weaker older text.
