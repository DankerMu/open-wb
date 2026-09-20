## Why

User reports #84 completed; the integrated baseline now contains seven canonical errors and four parser owners. #115 supplies the four workspace/sandbox errors required by blocked #117/#123/#125 without implementing their product routes.

## What Changes

- Add sandbox_denied403, conflict409, preview_too_large413 and preview_unsupported415 with exact parent-spec Chinese messages.
- Extend matched POST parser owners with /api/workspaces and /api/workspaces/:id/dirs, preserving the four existing identities and constructor-backed error boundary.
- Update all seven-code exhaustive regression oracles to eleven and exercise new owner behavior; no private Set export/source-text assertion.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `http-service-skeleton`: full restatement of current promoted 统一错误信封, preserving #84 and #122 semantics while adding four codes/two owners.

## Impact

core/errors messages/type, http/errors statuses/private owner set, existing app/auth/error tests and a focused test-only workspace parser integration file if needed to stay <=800 lines. No new production endpoint, schema, dependency, feature implementation, auth vocabulary, global cache policy or compatibility alias.

Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: shared public error/parser policy and authorization-order boundary)
Blast radius: all typed errors and parser failure classification.
Selected risk packs: public API; field vocabulary; auth/error trust; ordering; body limits; compatibility; errors; documentation.
Evidence floor: targeted TDD, eleven exact code/status/message envelopes with route-owned no-store, six-owner behavioral oracle with negatives, existing HTTP/auth regressions, typecheck/static/build, compiled real HTTP smoke and exact-head CI.
