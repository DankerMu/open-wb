## Why
Issue #205: when `spawn` fails before a pid exists (ENOENT/EACCES class), `SessionRuntime` keeps no native-exit channel for that generation (`server/src/sessions/omp/runtime.ts:343-347` returns before the `exit` listener at :350-352). Retirement then judges the failed child only through `liveChild()` (`:670-676`, `exitCode`/`signalCode`). Node writes `exitCode` one tick later, right before emitting `'error'`. If retire starts inside that window (shutdown or cancel racing the spawn), `#runRetire` (`:497-531`) cannot take its early exit at `:506` and burns the full `TERM_GRACE_MS` (5 s real time in production) for a process that never existed. The unbounded `await gen.nativeWait.promise` at `:527-529` is only kept unreachable by that undocumented Node side effect.

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: process spawn/shutdown lifecycle, a project-profile domain trigger and AGENTS.md Critical Path "omp 子进程治理 spawn/回收"; user waived human white-box review for this batch, all other gates kept)
Blast radius: every omp generation retire/shutdown. A wrong fix either keeps the 5 s stall or, worse, treats a still-running child as dead and skips TERM/KILL (process leak holding a live model token).
Selected risk packs: Concurrency / shared state / ordering; Resource limits (child-process leak, timers); Error handling / rollback; Legacy compatibility.
Evidence floor: new fake-clock race test RED before / GREEN after; boundary test with a pid-less child that never emits `'error'`; guard test that a live child emitting `'error'` still receives TERM/KILL; existing `omp-runtime*.test.ts` pins unchanged; `npm --workspace server run test`, lint, typecheck green.

## What Changes
- Make a pid-less spawn a first-class "no live child" condition for the generation, so retire takes the early exit immediately and never reaches the TERM grace or the unbounded native-exit await. The condition is keyed on "pid never existed", not on any `'error'` event.
- Extend the `omp-runtime.test.ts` harness so `shutdownInSpawn` can fire on the failure branch (today it returns early at the `spawnFailure !== undefined` branch), plus the boundary and guard tests above.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-runtime`: ADDED requirement on pid-less spawn failure retirement.

## Impact
`server/src/sessions/omp/runtime.ts` (generation liveness/retire only) and `server/test/omp-runtime.test.ts`. No change to `process.ts` spawn/handshake, token issuance, TERM/KILL timings for live children, supervisor, or public API.
