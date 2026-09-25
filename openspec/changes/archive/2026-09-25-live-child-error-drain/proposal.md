## Why
#327 — `server/src/sessions/omp/runtime.ts:338-342` (`#spawnFor`) handles **every** child `'error'` as a spawn failure: `spawnFailed = true`, `gen.child = undefined`, `spawnWait.resolve(undefined)`. The listener is attached before the pid guard, so it also fires for a live child with a pid. Node emits `'error'` on a live child when `kill()` fails (issue probe: `EPERM kill`, then a normal `'exit'`). `#drainHeld` (~:564-578) reads only `gen.child`; with it cleared it returns immediately and skips the bounded `destroyStdio`, so a held stdout pipe (a grandchild holding it — the #351 sudo orphan is exactly this shape) leaks the parent-side fds and listeners. `liveChild()` falls back to `gen.proc.child`, so TERM/KILL timing is unaffected; only the reclaim is lost.

VPS measurement (#351): kill of the sudo parent does not EPERM on Ubuntu 24.04, so production triggering is rare; the semantic defect remains and the fix is small.

## Triage
Issue type: bug
Fixture level: standard
Upstream suggested level: absent (standard: one handler, fake-clock regression; lifecycle already pinned by existing tests)
Blast radius: SessionRuntime retirement; a wrong fix could break the #205 pid-less spawn retirement or the grace timing.
Selected risk packs: Concurrency / ordering (error during retire vs native exit); Resource limits (held pipe reclaim); Legacy compatibility (#205 pid-less paths, existing held-pipe pin).
Evidence floor: fake-clock regression RED before / GREEN after; #205 race/boundary tests and held-pipe pin unchanged; full server suite, lint, typecheck.

## What Changes
- `#spawnFor`: the `'error'` handler changes generation state only when the child has no pid (`typeof child.pid !== "number"`); a live child's `'error'` leaves `spawnFailed`, `gen.child` and `spawnWait` untouched (the transport failure is already handled by `OmpProcess`'s own `'error'` listener).
- Regression in `server/test/omp-runtime-io.test.ts` using `openWired` + `FakeChild` (`server/test/support/omp-rpc.ts`), same shape as the held-pipe pin (:195). A real fake-omp child cannot hold stdout after death, and `omp-runtime.test.ts` is at the size limit. Precondition: `prompt()` (caught with `collectUntilError`, it rejects on shutdown) then `await world.waitPrompt()`, as in :195. Timeline: clock 0 `shutdown()` (retire `started = 0`); at clock 0 `child.emit("error", <EPERM-like error>)`, then `child.nativeExit(7)` (sets exitCode + `'exit'`, stdout PassThrough stays open; do not use `exit()`/`kill()`, which emit `'close'`); `await waitImmediate()`. Expected: no signal sent (spy `kill`); at +7999 `stdout.destroyed === false` and shutdown pending; at +8000 destroyed true and shutdown resolved; token revoked exactly once. RED on the current handler: shutdown resolves at clock 0 and stdout is never destroyed.

Must preserve: #205 scenarios (shutdown races missing-binary spawn; pid-less child that never reports failure; live child emitting error keeps the grace contract); held-pipe pin `omp-runtime-io.test.ts:195`; `liveChild` semantics; no change to `process.ts`.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-runtime`: MODIFIED Pid-less spawn failure retirement — a live child's `'error'` does not drop its handle; held stdio still reclaimed within budget.

## Impact
`server/src/sessions/omp/runtime.ts` (handler), one test file. No API/config change.
