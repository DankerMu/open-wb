## Why

#122 now provides canonical account-scoped audit queries. #124 exposes that seam through the accounts module so later app assembly and filesystem smoke can observe audit events without creating a second authorization or pagination implementation.

## What Changes

- Add registerAccounts(app,{db}) with GET /api/audit, protected by the existing root cookie guard, canonical errors and route-local no-store.
- Add real createApp + migrated SQLite + cookie/inject contract tests.
- Do not wire production app.ts; #128 owns assembly. No additional account routes.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `audit-core`: add the guarded read-only REST endpoint contract.

## Impact

Only server/src/accounts/index.ts and paired server/test/accounts.test.ts; OpenSpec fixture/parent task bookkeeping. No new dependencies, migrations, auth paths, global hooks or mapper changes.

Issue type: feature
Fixture level: expanded
Upstream suggested level: compact (override: public HTTP API, authorization and query parser boundary)
Blast radius: exposure/caching of audit records or accidental client-error masking.
Selected risk packs: public API; field/parameter representation; auth; read-only ordering; bounds/precision; compatibility; error handling; documentation.
Evidence floor: real migrated SQLite + existing createApp/guard/login cookies via inject, server regression/type/build/static, compiled actual HTTP smoke with explicit module registration, exact-head CI.
