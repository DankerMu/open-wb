## Why
Issue #99 exposes the accepted session store through four authenticated REST endpoints. Dependencies #97/#90/#84 are merged; real runtime and SSE assembly stay later slices.
## What Changes
- Add registerSessionRoutes(app,{store,supervisor}) and owned SessionSupervisorPort in sessions/rest.ts.
- Reuse cookie guard, canonical HttpError envelopes and real SessionStore; prove admission, owner isolation and compensation through HTTP with a stub supervisor.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- chat-sessions: add the REST boundary contract, without promoting unimplemented runtime/SSE requirements.
## Impact
Source sessions/rest.ts and paired tests only. No migration, dependency, app startup, runtime, proxy or global HTTP policy change.
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree; authenticated public API and persisted admission state)
Blast radius: cross-owner history disclosure, invalid prompt admission or stranded running state.
Selected risk packs: public-api, schema, auth-permissions-secrets, concurrency-state-order, compatibility, error-rollback, release-packaging, documentation.
Evidence floor: semantic RED before source implementation; real SQLite + authentic cookie guard + stub supervisor inject tests; parent compiled real HTTP checks; server suite/coverage, types/build/Biome/anti-drift/strict OpenSpec and same-SHA CI.
