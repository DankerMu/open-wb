## Why
Issue #101 follows merged #98/#100: production still exposes the three-module skeleton and four environment keys, so the implemented proxy and session modules are not reachable through the real app. This slice makes configuration and assembly one verifiable startup contract without claiming #102 post-listen model-file publication.
## What Changes
- Extend the canonical pure server configuration seam with seven agent/model settings, exact defaults, entry-root path identity and named negative validation.
- Assemble real model-proxy then sessions with one shared registry after auth/http; report exactly five actual startup modules. Preserve existing auth/static/parser and DB ownership behavior.
- Migrate directly affected test consumers atomically; prove default/override/invalid/missing-upstream and secret-free startup behavior with existing modules, not mocks of the app under test.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `http-service-skeleton`: complete startup requirement restated for eleven-key configuration and five-module assembly only; retain existing startup/failure/signal scenarios, with post-listen models.yml and full runtime signal integration reserved for #102.
## Impact
server/src/app.ts, server.ts and the smallest canonical shared configuration seam if needed; server-config and affected app/module/startup tests; architecture directory/assembly docs. No dependencies, migrations, guard/threshold changes or SSE routes. Critical lifecycle already owned by registerSessions and reused, not rewritten.
## Risk triage
Issue type: feature. Fixture level: expanded (agree upstream).
Blast radius: every app caller, startup config/secret handling, shared proxy token authentication and session startup reconciliation.
Selected risk packs: API, config, filesystem identity, schema/units, auth/secrets, ordering/resources, compatibility, errors/partial-start, packaging and documentation.
Evidence floor: semantic pre-change config/route failures; actual compiled process/HTTP/SQLite acceptance; unchanged auth/static/runtime regression; full server coverage, scoped static/anti-drift, independent review and exact-head CI.
