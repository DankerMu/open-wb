## Risk Packs
- Concurrency / ordering — selected: `'error'` during retire vs native exit and drain → 1.1, 2.1.
- Resource limits — selected: held stdout pipe reclaimed within 8 s budget → 2.1.
- Legacy compatibility — selected: #205 pid-less retirement and held-pipe pin unchanged → 2.2.
- Public API, Config, Schema, File IO, Auth/secrets, Error handling, Release, Documentation — not selected: internal handler only.

## 1. Implementation
- [x] 1.1 `runtime.ts` `#spawnFor`: `'error'` mutates generation state only for a pid-less child.
- [x] 1.2 Fake-clock regression per proposal.

## 2. Verification
- [x] 2.1 Regression RED on the current handler, GREEN after.
- [x] 2.2 #205 tests, held-pipe pin, omp-runtime/omp-runtime-io suites green; `npm --workspace server run test`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
