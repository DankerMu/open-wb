## Why
Issue #227: `createApp` (`server/src/app.ts:92-95`) leaves Fastify 5.12.1 at `forceCloseConnections: 'idle'`. On `app.close()` Fastify runs the `preClose` hooks, then Node's `server.close()` calls `closeIdleConnections()` exactly once. A request that is still in flight at that moment is not idle; when it completes after `preClose`, its keep-alive socket (`Keep-Alive: timeout=72`) becomes idle but is never reaped again, so `server.close()` — and therefore `app.close()`, `closeOwnedApp` (`server/src/server.ts:308-318`) and the DB close behind it — waits for the keep-alive timeout (~73 s, inferred upper bound, not measured). The issue's executed probe on base `1776a8c0` showed `app.close()` missing a 2 s deadline after a held ordinary REST response completed with `200` + `Connection: keep-alive`. Under a container/systemd stop grace (docker default 10 s) this can be SIGKILLed before `closeOwnedDb`. The listener side has neither a reclaim strategy nor a budget, while the native side does (`runtime.ts` TERM 5 s + KILL 3 s).

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: process listen/shutdown, shared Fastify assembly — project-profile domain triggers)
Blast radius: every graceful shutdown of the app-server; a wrong fix either keeps the ~73 s stall or drops accepted requests (e.g. `forceCloseConnections: true`).
Selected risk packs: Concurrency / shared state / ordering; Resource limits (sockets, timers); Error handling (escalation, exit code); Legacy compatibility (shutdown order, SSE closing gate); Public API (new optional `createApp` options).
Evidence floor: real-listen permanent test RED on pre-fix source / GREEN after within 2 s; escalation test; `server-startup-order.test.ts` order contract unchanged; server test/lint/typecheck/anti-drift green.

## What Changes
- Lossless re-drain in `createApp`: once the app is closing (a `preClose` hook registered after every module, so it runs after the sessions/model-proxy/SSE `preClose` hooks), every completed response triggers `app.server.closeIdleConnections()` on the next macrotask. Node only reclaims connections without an unfinished request, so no in-flight request is cut.
- Named listener drain budget `LISTENER_CLOSE_BUDGET_MS = 2_000`, armed by that same final `preClose` hook (i.e. after native runtime shutdown has finished, so it never truncates the native TERM/KILL budget). Only if connections are still open when it expires does it escalate with `closeAllConnections()` and invoke an optional `onListenerForceClose` callback; the timer is cleared/unref'd so a normal close is never delayed by it. Default rationale: native worst case 8 s + listener 2 s = 10 s, the docker default stop grace.
- `server.ts` passes an `onListenerForceClose` that writes one generic stderr JSON line (`{"event":"listener_force_close"}`) via the existing `writeManagedLine`; escalation is not a failure (exit code stays 0 unless an earlier failure is sticky, per #102).
- `createApp` gains optional `listenerCloseBudgetMs` (tests only need a short value; production uses the default) and `onListenerForceClose`.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `http-service-skeleton`: ADDED requirement for bounded, lossless listener shutdown.

## Impact
`server/src/app.ts`, `server/src/server.ts`, new/extended server tests. No route behaviour change, no `forceCloseConnections` change, no env/config key, no native runtime timing change, DB close order unchanged.
