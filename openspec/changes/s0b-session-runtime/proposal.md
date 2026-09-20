## Why
Issue #96 completes the per-session lifecycle above the merged #95 transport. A session needs lazy startup, bounded process shutdown and generation-owned credentials before #100 can safely orchestrate turns.

## What Changes
- Add SessionRuntime over the existing OmpProcess/spawnOmp boundary, with injected clock, token callbacks and spawn seam.
- Stream raw prompt frames through AsyncIterable, preserve true completion semantics, report interrupted turns, retain successful sessionFile for resume.
- Reset idle on every child frame/new prompt; reclaim via stdin close, 5s grace, TERM, 3s grace, KILL.
- Fence stale generation callbacks and revoke credentials on native process death even when stdout is still draining.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-runtime`: add 每会话生命周期 and its race/ownership scenarios; preserve existing binary, spawn and transport contracts.

## Impact
New `server/src/sessions/omp/runtime.ts` and paired tests, with minimal extensions to existing fake-omp support. An executed shutdown-during-handshake counterexample required a small `process.ts` ownership extension: startup failure avoids an automatic duplicate after a successfully requested SIGKILL, while public kill forwarding and prior-TERM/failed-KILL behavior remain intact. No supervisor, DB, network route, config, dependency or CI changes.

## Triage
Issue type: feature.
Fixture level: expanded; agrees with upstream suggested level.
Blast radius: orphan child, stale bearer, stuck or truncated turn, wrong resume generation.
Selected risk packs: public API, schema, auth/secrets, concurrency, resources, compatibility, errors, documentation; domain child isolation and cross-service credential boundary.
Evidence floor: callable semantic RED/GREEN; real subprocess plus injected clock lifecycle tests; independent runtime smoke and failure-class qualification; server suite/coverage, lint, types, anti-drift; expanded agent review and same-SHA CI.
User waiver: Epic #81 per-issue human white-box review is waived; final functional review after epic completion remains. Agent gates are unchanged.
