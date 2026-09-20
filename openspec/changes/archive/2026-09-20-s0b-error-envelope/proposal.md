## Why
Issue #84 unblocks session/proxy error reporting without implementing their routes. The existing five-code mapper must gain two semantic errors and two exact parser-owner identities.

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: shared public error/parser boundary; no proxy credential implementation in this slice)
Blast radius: all HTTP error callers, parser classification and no-store ownership.
Selected risk packs: public API, schema, auth/secrets, ordering, legacy compatibility, error handling, documentation.
Evidence floor: test-first semantic RED on existing callable mapper; focused real Fastify contract suite, type/lint/drift gates, independent boundary probe and same-SHA CI.

## What Changes
- Add session_busy/agent_unavailable codes/messages in canonical core/errors; exhaustive HTTP status map remains in http/errors.
- Add exact POST parser ownership for /api/sessions/:id/prompt and /v1/chat/completions. Do not implement either route.
- Extend existing behavior tests; preserve constructor identity checks, method/matched-route boundaries, generic sanitized500 and route-local no-store policy.
- Correct parent S0b ownership text per #122/PR163 issue comments; no compatibility re-export.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- http-service-skeleton: entire unified-envelope requirement updated for seven codes and four parser owners, preserving existing scenarios.

## Impact
Owned implementation: server/src/core/errors/index.ts and server/src/http/errors.ts; existing auth-lifecycle/auth-request-errors tests plus additive two-row ERROR_CASES update in server/test/app.test.ts. No dependency, config, product routes, guard, sessions, proxy or CI changes. Human per-issue review waiver applies; agent review and final Epic functional review remain.
