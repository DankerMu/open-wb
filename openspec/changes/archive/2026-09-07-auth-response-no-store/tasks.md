## 1. Contract and tests

- [x] 1.1 Add the `dev-stub-auth` delta requiring exact `Cache-Control: no-store` for every terminal response owned by login, me, and logout, while excluding non-auth routes.
- [x] 1.2 Add `app.inject()` regression coverage for login 200, exact-body/native-parser 400, 401, 403, and a representative internal 5xx; each input must preserve its existing body, cookie, and database result while returning exact `no-store`.
- [x] 1.3 Preserve and audit me/logout success, auth failure, parser failure, expiry/cleanup, and storage-fault assertions for exact `no-store`, cookie behavior, and database state.
- [x] 1.4 Add negative controls proving healthz, info, a static asset, a non-auth API response, and auth method/path lookalikes do not inherit auth-scoped `no-store`.
- [x] 1.5 Prove new behavior tests bite in one batched red run against pre-change source and leave no `red-proof` stash entry.

## 2. Implementation

- [x] 2.1 Move login's `no-store` policy to a route-local pre-parser hook shared in shape with me/logout, without adding a global hook.
- [x] 2.2 Preserve login Principal/error-envelope/Set-Cookie/session-write behavior and all me/logout TTL, cleanup, delete, clear-cookie, and rollback behavior.
- [x] 2.3 Audit the Invariant Matrix surfaces and exact-route boundaries; record each unchanged sibling surface inspected.

## 3. Required evidence

- [x] 3.1 Public API + Auth/session lifecycle: `npm test --workspace server` exits 0 with the full auth terminal-state matrix and coverage thresholds at or above 80%.
- [x] 3.2 Error handling + compatibility: malformed/empty/unsupported/oversized login inputs and representative storage failures retain their exact prior status/body/cookie/DB result plus `no-store`.
- [x] 3.3 Scope isolation: healthz/info/static/non-auth API/lookalike inputs produce their existing response and no auth-scoped `no-store`.
- [x] 3.4 Documentation: `openspec validate auth-response-no-store --strict --no-interactive` exits 0.
- [x] 3.5 Repository default pipeline: `make check` exits 0 without weakened tests, coverage, guardrails, or CI contracts.

## 4. Non-goals

- [x] 4.1 Do not change web fetch caching, global API/static caching, OIDC/CSRF, response body schemas, session schema/TTL, proxy configuration, or unrelated security headers.
