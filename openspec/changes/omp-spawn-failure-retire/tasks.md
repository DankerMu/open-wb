## Risk Packs
- Concurrency / shared state / ordering — selected: retire racing an in-flight spawn and the failure tick → 1.1, 2.1 (race test).
- Resource limits / discovery — selected: must not leak a live pid-bearing child or timers → 2.3 (guard test), 2.1/2.2 `clock.pending() === 0`.
- Error handling / rollback / partial outputs — selected: failed acquisition keeps AgentUnavailableError, token revoke-once, resume path → 2.4 existing pins.
- Legacy compatibility — selected: live-child TERM@5000/KILL@8000 and failed-acquisition pins unchanged → 2.4.
- Public API / CLI — not selected: `SessionRuntime` public surface unchanged.
- Config, Schema, File IO/path safety, Auth/secrets (beyond revoke-once covered above), Release/packaging, Documentation — not selected: no config, data, path, credential-flow, dependency or doc change.

## 1. Implementation
- [ ] 1.1 In `server/src/sessions/omp/runtime.ts`, record "child never obtained a pid" on the generation and make every liveness check (`liveChild` and its callers) return no live child for it; do not turn `'error'` on a pid-bearing child into a dead verdict. Keep revoke-once / dropGeneration ordering on the early path.
- [ ] 1.2 Extend `server/test/omp-runtime.test.ts` harness so `shutdownInSpawn` fires on the failure branch too (without changing existing failure-branch assertions), and allow a custom pid-less child that never emits `'error'`.

## 2. Verification
- [ ] 2.1 Race test (design Required evidence) — RED on pre-fix source (show that shutdown settles only after `advance(5_000)`), GREEN after.
- [ ] 2.2 Boundary test per design: pid-less fake never emitting `'error'`; settle boot deterministically (end stdout or short `handshakeTimeoutMs`), assert `kills` explicitly; shutdown settles at clock 0, no pending timers; bounded real-time wait so pre-fix RED is a failure, not a hang.
- [ ] 2.3 Guard test per design: post-handshake `openHangTerm()` child emits `'error'` while running, then `shutdown()` → SIGTERM@5000, SIGKILL@8000 (not during handshake).
- [ ] 2.4 Existing `omp-runtime.test.ts` / `omp-runtime-io.test.ts` unchanged and green; `npm --workspace server run test`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
